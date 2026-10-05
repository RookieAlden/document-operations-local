BEGIN;

-- One-time, idempotent UAT repair for the user-created ABC Xinghe 2026-Q4
-- Case. The marker is added only after exact Subject, period, provenance and
-- empty-Case checks pass, and an independent immutable workflow event is added.
DO $$
DECLARE
    org_id uuid;
    subject_row public.subjects%ROWTYPE;
    case_row public.cases%ROWTYPE;
    matching_subjects integer;
    matching_cases integer;
    related_submissions integer;
    related_documents integer;
    related_invitations integer;
    audit_event public.workflow_events%ROWTYPE;
    audit_event_id uuid := gen_random_uuid();
    audit_key constant text := 'uat-synthetic-marker-backfill|abc-xinghe-demo-001|2026-Q4';
    operation_time timestamptz := clock_timestamp();
BEGIN
    org_id := public.dop_set_organization_context('uat-accounting-firm');
    IF org_id IS NULL THEN
        RAISE EXCEPTION 'exact UAT organization not found';
    END IF;

    SELECT count(*) INTO matching_subjects
      FROM public.subjects
     WHERE organization_id = org_id
       AND subject_key = 'abc-xinghe-demo-001';
    IF matching_subjects <> 1 THEN
        RAISE EXCEPTION 'expected exactly one ABC Xinghe Subject, found %', matching_subjects;
    END IF;

    SELECT * INTO subject_row
      FROM public.subjects
     WHERE organization_id = org_id
       AND subject_key = 'abc-xinghe-demo-001'
     FOR UPDATE;
    IF subject_row.display_name <> 'ABC 星河咨询有限公司'
       OR subject_row.status <> 'active'
       OR NOT subject_row.attributes @> '{"synthetic":true}'::jsonb THEN
        RAISE EXCEPTION 'ABC Xinghe Subject failed the explicit synthetic boundary';
    END IF;

    SELECT count(*) INTO matching_cases
      FROM public.cases c
     WHERE c.organization_id = org_id
       AND c.subject_id = subject_row.id
       AND c.case_key LIKE '%|2026-Q4'
       AND c.period_start = DATE '2026-10-01'
       AND c.period_end = DATE '2026-12-31';
    IF matching_cases <> 1 THEN
        RAISE EXCEPTION 'expected exactly one ABC Xinghe 2026-Q4 Case, found %', matching_cases;
    END IF;

    SELECT * INTO case_row
      FROM public.cases c
     WHERE c.organization_id = org_id
       AND c.subject_id = subject_row.id
       AND c.case_key LIKE '%|2026-Q4'
       AND c.period_start = DATE '2026-10-01'
       AND c.period_end = DATE '2026-12-31'
     FOR UPDATE;
    IF case_row.status NOT IN ('not_started','waiting_for_documents','review_required','ready','in_progress')
       OR case_row.config_snapshot->>'source' <> 'work_configuration_release'
       OR NULLIF(case_row.config_snapshot->>'configuration_release_id','') IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM public.work_configuration_releases release
             WHERE release.organization_id = org_id
               AND release.id = (case_row.config_snapshot->>'configuration_release_id')::uuid
               AND release.subject_id = subject_row.id
               AND release.status = 'published'
       ) THEN
        RAISE EXCEPTION 'ABC Xinghe Case failed status or configuration provenance checks';
    END IF;

    SELECT count(*) INTO related_submissions FROM public.submissions
     WHERE organization_id = org_id AND case_id = case_row.id;
    SELECT count(*) INTO related_documents FROM public.documents
     WHERE organization_id = org_id AND case_id = case_row.id;
    SELECT count(*) INTO related_invitations FROM public.demo_case_invitations
     WHERE organization_id = org_id AND case_id = case_row.id;
    IF related_submissions <> 0 OR related_documents <> 0 OR related_invitations <> 0 THEN
        RAISE EXCEPTION 'ABC Xinghe Case is no longer empty: submissions %, documents %, invitations %',
            related_submissions, related_documents, related_invitations;
    END IF;

    SELECT * INTO audit_event FROM public.workflow_events
     WHERE organization_id = org_id AND idempotency_key = audit_key;
    IF FOUND THEN
        IF audit_event.event_type <> 'Case.SyntheticMarkerBackfilled'
           OR audit_event.aggregate_id <> case_row.id
           OR NOT case_row.config_snapshot @> '{"synthetic_only":true}'::jsonb THEN
            RAISE EXCEPTION 'existing ABC Xinghe backfill audit evidence is inconsistent';
        END IF;
        RETURN;
    END IF;

    IF case_row.config_snapshot ? 'synthetic_only' THEN
        RAISE EXCEPTION 'ABC Xinghe Case already has an unaudited or conflicting synthetic_only marker';
    END IF;

    UPDATE public.cases
       SET config_snapshot = jsonb_set(config_snapshot, '{synthetic_only}', 'true'::jsonb, true),
           version = version + 1,
           updated_at = operation_time
     WHERE organization_id = org_id AND id = case_row.id;

    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer,
        payload, occurred_at
    ) VALUES (
        audit_event_id, org_id, audit_key, 'Case.SyntheticMarkerBackfilled', 1,
        'case', case_row.id, gen_random_uuid(), NULL,
        'dop.operation.uat-synthetic-case-backfill.v1',
        jsonb_build_object(
            'subjectKey', subject_row.subject_key,
            'subjectDisplayName', subject_row.display_name,
            'periodKey', '2026-Q4',
            'previousMarker', NULL,
            'newMarker', true,
            'validation', jsonb_build_object(
                'subjectSyntheticJsonBoolean', true,
                'configurationReleasePublished', true,
                'submissionCount', related_submissions,
                'documentCount', related_documents,
                'invitationCount', related_invitations
            ),
            'authorization', 'product-owner-request-2026-09-02'
        ),
        operation_time
    );

    IF NOT EXISTS (
        SELECT 1 FROM public.cases c
         WHERE c.organization_id = org_id AND c.id = case_row.id
           AND c.config_snapshot @> '{"synthetic_only":true}'::jsonb
    ) OR NOT EXISTS (
        SELECT 1 FROM public.workflow_events e
         WHERE e.organization_id = org_id AND e.id = audit_event_id
           AND e.event_type = 'Case.SyntheticMarkerBackfilled'
    ) THEN
        RAISE EXCEPTION 'ABC Xinghe marker or audit event verification failed';
    END IF;
END;
$$;

SELECT jsonb_build_object(
    'operation', 'abc_xinghe_2026_q4_synthetic_marker_backfill',
    'status', 'verified',
    'invitationCreated', false,
    'fileUploaded', false
) AS result;

COMMIT;
