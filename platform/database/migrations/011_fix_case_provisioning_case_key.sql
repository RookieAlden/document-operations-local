BEGIN;

-- M15 hotfix: qualify the generated Case key variable so PL/pgSQL does not
-- treat it as ambiguous with cases.case_key during the duplicate guard.
CREATE OR REPLACE FUNCTION public.dop_create_case_from_configuration(
    p_actor_id uuid, p_release_id uuid, p_period_key text,
    p_period_start date, p_period_end date, p_due_at timestamptz,
    p_timezone text, p_external_reference text, p_reason text,
    p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_manager(p_actor_id);
    normalized_period_key text := btrim(p_period_key);
    normalized_timezone text := btrim(p_timezone);
    current_release public.work_configuration_releases%ROWTYPE;
    subject public.subjects%ROWTYPE;
    workflow_template public.workflow_templates%ROWTYPE;
    organization_key text;
    existing_event public.workflow_events%ROWTYPE;
    prompt_version_id uuid;
    fingerprint text;
    case_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    generated_case_key text;
BEGIN
    IF normalized_period_key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
       OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start
       OR p_due_at IS NULL OR char_length(normalized_timezone) NOT BETWEEN 3 AND 80
       OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = normalized_timezone)
       OR char_length(coalesce(p_external_reference, '')) > 200
       OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', p_release_id::text, normalized_period_key,
        p_period_start::text, p_period_end::text, p_due_at::text, normalized_timezone,
        coalesce(p_external_reference, ''), p_reason), 'sha256'), 'hex');
    SELECT * INTO existing_event FROM public.workflow_events
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key || ':event';
    IF FOUND THEN
        IF existing_event.event_type = 'Case.CreatedFromConfiguration'
           AND existing_event.payload->>'request_fingerprint' = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'caseId', existing_event.aggregate_id,
                'eventId', existing_event.id);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO current_release FROM public.work_configuration_releases release
     WHERE release.id = p_release_id AND release.organization_id = v_organization_id
       AND release.status = 'published'
       AND release.release_number = (
           SELECT max(candidate.release_number) FROM public.work_configuration_releases candidate
            WHERE candidate.organization_id = v_organization_id
              AND candidate.subject_id = release.subject_id AND candidate.status = 'published'
       );
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'release_not_current_published'); END IF;
    SELECT * INTO subject FROM public.subjects
     WHERE id = current_release.subject_id AND organization_id = v_organization_id FOR UPDATE;
    IF subject.status <> 'active' THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'subject_not_active'); END IF;
    SELECT * INTO existing_event FROM public.workflow_events
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key || ':event';
    IF FOUND THEN
        IF existing_event.event_type = 'Case.CreatedFromConfiguration'
           AND existing_event.payload->>'request_fingerprint' = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'caseId', existing_event.aggregate_id,
                'eventId', existing_event.id);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO workflow_template FROM public.workflow_templates
     WHERE id = current_release.workflow_template_id AND organization_id = v_organization_id;
    IF current_release.produced_workflow_template_version_id IS NULL
       OR current_release.produced_requirement_set_version_id IS NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'published_configuration_incomplete');
    END IF;
    SELECT organization.organization_key INTO organization_key
      FROM public.organizations organization WHERE organization.id = v_organization_id;
    SELECT id INTO prompt_version_id FROM public.prompt_versions
     WHERE organization_id = v_organization_id AND prompt_key = 'document-classifier' AND status = 'published'
     ORDER BY version DESC LIMIT 1;
    IF prompt_version_id IS NULL THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'published_prompt_not_found'); END IF;
    generated_case_key := organization_key || '|' || workflow_template.template_key || '|' || subject.subject_key || '|' || normalized_period_key;
    IF EXISTS (SELECT 1 FROM public.cases case_record
                WHERE case_record.organization_id = v_organization_id
                  AND case_record.case_key = generated_case_key) THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'case_already_exists');
    END IF;
    INSERT INTO public.cases (
        id, organization_id, case_key, subject_id, workflow_template_version_id,
        requirement_set_version_id, prompt_version_id, external_reference,
        period_start, period_end, timezone, status, risk_status, due_at,
        config_snapshot, version, created_at, updated_at
    ) VALUES (case_id, v_organization_id, generated_case_key, current_release.subject_id,
        current_release.produced_workflow_template_version_id,
        current_release.produced_requirement_set_version_id, prompt_version_id,
        nullif(btrim(coalesce(p_external_reference, '')), ''), p_period_start, p_period_end,
        normalized_timezone, 'not_started', 'normal', p_due_at,
        jsonb_build_object('source', 'work_configuration_release',
            'configuration_release_id', current_release.id,
            'configuration_release_number', current_release.release_number,
            'configuration_definition_hash', current_release.definition_hash,
            'manifest', current_release.manifest,
            'external_messages_require_approval',
                coalesce(current_release.manifest#>'{workflow,external_messages_require_approval}', 'true'::jsonb)),
        1, p_now, p_now);
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event',
        'Case.CreatedFromConfiguration', 1, 'case', case_id, p_correlation_id,
        p_actor_id, 'ops-onboarding', jsonb_build_object(
            'configuration_release_id', current_release.id,
            'configuration_release_number', current_release.release_number,
            'request_fingerprint', fingerprint,
            'period_key', normalized_period_key, 'period_start', p_period_start,
            'period_end', p_period_end, 'due_at', p_due_at, 'reason', p_reason), p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'caseId', case_id,
        'caseKey', generated_case_key, 'releaseId', current_release.id,
        'workflowTemplateVersionId', current_release.produced_workflow_template_version_id,
        'requirementSetVersionId', current_release.produced_requirement_set_version_id,
        'eventId', event_id, 'status', 'not_started');
END;
$$;

REVOKE ALL ON FUNCTION public.dop_create_case_from_configuration(uuid,uuid,text,date,date,timestamptz,text,text,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_create_case_from_configuration(uuid,uuid,text,date,date,timestamptz,text,text,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
