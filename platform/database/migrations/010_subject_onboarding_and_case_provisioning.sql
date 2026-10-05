BEGIN;

-- A package is a reusable, versioned starting point for onboarding a Subject.
-- Accounting is only the first DEV package; no industry-specific field is
-- required by the onboarding or future-Case creation functions.
CREATE TABLE work_configuration_packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    package_key text NOT NULL CHECK (package_key = lower(btrim(package_key)) AND char_length(package_key) BETWEEN 3 AND 120),
    display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 160),
    description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 12 AND 1000),
    industry_package text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, package_key)
);

CREATE TABLE work_configuration_package_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    package_id uuid NOT NULL REFERENCES work_configuration_packages(id),
    workflow_template_id uuid NOT NULL REFERENCES workflow_templates(id),
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
    blueprint jsonb NOT NULL CHECK (jsonb_typeof(blueprint) = 'object'),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    created_by_actor_id uuid REFERENCES actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    published_at timestamptz,
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (package_id, version),
    UNIQUE (package_id, definition_hash),
    CHECK ((status = 'published' AND published_at IS NOT NULL) OR status <> 'published')
);

CREATE TABLE subject_onboardings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    subject_id uuid NOT NULL REFERENCES subjects(id),
    package_version_id uuid NOT NULL REFERENCES work_configuration_package_versions(id),
    configuration_release_id uuid NOT NULL REFERENCES work_configuration_releases(id),
    created_by_actor_id uuid NOT NULL REFERENCES actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    UNIQUE (organization_id, subject_id)
);

ALTER TABLE work_configuration_package_versions
    ADD CONSTRAINT work_package_version_package_same_org_fk
        FOREIGN KEY (organization_id, package_id) REFERENCES work_configuration_packages(organization_id, id),
    ADD CONSTRAINT work_package_version_workflow_same_org_fk
        FOREIGN KEY (organization_id, workflow_template_id) REFERENCES workflow_templates(organization_id, id),
    ADD CONSTRAINT work_package_version_actor_same_org_fk
        FOREIGN KEY (organization_id, created_by_actor_id) REFERENCES actors(organization_id, id);

ALTER TABLE subject_onboardings
    ADD CONSTRAINT subject_onboarding_subject_same_org_fk
        FOREIGN KEY (organization_id, subject_id) REFERENCES subjects(organization_id, id),
    ADD CONSTRAINT subject_onboarding_package_version_same_org_fk
        FOREIGN KEY (organization_id, package_version_id) REFERENCES work_configuration_package_versions(organization_id, id),
    ADD CONSTRAINT subject_onboarding_release_same_org_fk
        FOREIGN KEY (organization_id, configuration_release_id) REFERENCES work_configuration_releases(organization_id, id),
    ADD CONSTRAINT subject_onboarding_actor_same_org_fk
        FOREIGN KEY (organization_id, created_by_actor_id) REFERENCES actors(organization_id, id),
    ADD CONSTRAINT subject_onboarding_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES workflow_events(organization_id, id);

CREATE INDEX work_package_versions_catalog_idx
    ON work_configuration_package_versions (organization_id, package_id, version DESC);
CREATE INDEX subject_onboardings_created_idx
    ON subject_onboardings (organization_id, created_at DESC);

ALTER TABLE work_configuration_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_configuration_package_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_onboardings ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE work_configuration_packages, work_configuration_package_versions, subject_onboardings TO dop_app;

CREATE POLICY dop_tenant_isolation ON work_configuration_packages
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON work_configuration_package_versions
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON subject_onboardings
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_require_active_manager(p_actor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_current_organization_id();
BEGIN
    IF v_organization_id IS NULL THEN
        RAISE EXCEPTION 'organization_context_required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.actors
         WHERE id = p_actor_id AND organization_id = v_organization_id
           AND actor_type IN ('manager', 'admin') AND status = 'active'
    ) THEN
        RAISE EXCEPTION 'manager_required' USING ERRCODE = '42501';
    END IF;
    RETURN v_organization_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_onboard_subject_from_package(
    p_actor_id uuid, p_package_version_id uuid, p_subject_key text,
    p_display_name text, p_subject_type text, p_primary_contact_actor_id uuid,
    p_attributes jsonb, p_reason text, p_idempotency_key text,
    p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    normalized_key text := lower(btrim(p_subject_key));
    normalized_name text := btrim(p_display_name);
    normalized_type text := btrim(p_subject_type);
    package_version public.work_configuration_package_versions%ROWTYPE;
    package public.work_configuration_packages%ROWTYPE;
    existing public.subject_onboardings%ROWTYPE;
    subject_id uuid := gen_random_uuid();
    requirement_set_id uuid := gen_random_uuid();
    release_id uuid := gen_random_uuid();
    series_id uuid := gen_random_uuid();
    onboarding_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    subject_attributes jsonb;
    manifest jsonb;
    validation_error text;
    definition_hash text;
    fingerprint text;
BEGIN
    IF normalized_key !~ '^[a-z0-9][a-z0-9-]{2,79}$'
       OR char_length(normalized_name) NOT BETWEEN 2 AND 160
       OR char_length(normalized_type) NOT BETWEEN 2 AND 80
       OR jsonb_typeof(p_attributes) <> 'object'
       OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;

    fingerprint := encode(digest(concat_ws('|', p_package_version_id::text, normalized_key,
        normalized_name, normalized_type, coalesce(p_primary_contact_actor_id::text, ''),
        p_attributes::text, p_reason), 'sha256'), 'hex');
    PERFORM 1 FROM public.organizations WHERE id = v_organization_id FOR UPDATE;
    SELECT * INTO existing FROM public.subject_onboardings
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'onboardingId', existing.id,
                'subjectId', existing.subject_id, 'releaseId', existing.configuration_release_id);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;

    SELECT version.* INTO package_version
      FROM public.work_configuration_package_versions version
     WHERE version.id = p_package_version_id AND version.organization_id = v_organization_id
       AND version.status = 'published';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found', 'reason', 'package_version_not_found'); END IF;
    SELECT * INTO package FROM public.work_configuration_packages
     WHERE id = package_version.package_id AND organization_id = v_organization_id AND status = 'active';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'package_not_active'); END IF;
    IF EXISTS (SELECT 1 FROM public.subjects WHERE organization_id = v_organization_id AND subject_key = normalized_key) THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'subject_key_exists');
    END IF;
    IF p_primary_contact_actor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.actors WHERE id = p_primary_contact_actor_id
          AND organization_id = v_organization_id AND actor_type = 'customer' AND status = 'active'
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'primary_contact_invalid'); END IF;
    IF jsonb_typeof(package_version.blueprint->'subjectDefaults') <> 'object'
       OR jsonb_typeof(package_version.blueprint->'workflow') <> 'object'
       OR jsonb_typeof(package_version.blueprint->'requirements') <> 'array' THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'package_blueprint_invalid');
    END IF;

    subject_attributes := coalesce(package_version.blueprint#>'{subjectDefaults,attributes}', '{}'::jsonb)
        || p_attributes
        || jsonb_build_object('onboarding_package_key', package.package_key,
            'onboarding_package_version', package_version.version);
    -- A package may lock the synthetic boundary. User-supplied attributes
    -- cannot turn a synthetic-only DEV package into a real-data Subject.
    IF package_version.blueprint#>>'{subjectDefaults,attributes,synthetic}' = 'true' THEN
        subject_attributes := jsonb_set(subject_attributes, '{synthetic}', 'true'::jsonb, true);
    END IF;
    manifest := jsonb_build_object(
        'subject', jsonb_build_object('displayName', normalized_name, 'subjectType', normalized_type,
            'status', coalesce(package_version.blueprint#>>'{subjectDefaults,status}', 'active'),
            'primaryContactActorId', p_primary_contact_actor_id, 'attributes', subject_attributes),
        'workflow', package_version.blueprint->'workflow',
        'requirements', package_version.blueprint->'requirements'
    );
    validation_error := public.dop_configuration_manifest_error(v_organization_id, manifest);
    IF validation_error IS NOT NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', validation_error);
    END IF;
    definition_hash := encode(digest(manifest::text, 'sha256'), 'hex');

    INSERT INTO public.subjects (
        id, organization_id, subject_key, subject_type, display_name, status,
        primary_contact_actor_id, attributes, created_at, updated_at
    ) VALUES (subject_id, v_organization_id, normalized_key, normalized_type, normalized_name,
        manifest#>>'{subject,status}', p_primary_contact_actor_id, subject_attributes, p_now, p_now);
    INSERT INTO public.requirement_sets (
        id, organization_id, set_key, display_name, created_at, updated_at
    ) VALUES (requirement_set_id, v_organization_id,
        'subject.' || normalized_key || '.requirements', normalized_name || ' requirements', p_now, p_now);
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', 'Subject.Onboarded', 1,
        'subject', subject_id, p_correlation_id, p_actor_id, 'ops-onboarding',
        jsonb_build_object('subject_key', normalized_key, 'package_key', package.package_key,
            'package_version', package_version.version, 'configuration_release_id', release_id,
            'configuration_status', 'draft', 'external_delivery', 'not_sent'), p_now);
    INSERT INTO public.work_configuration_releases (
        id, organization_id, series_id, release_number, revision, subject_id,
        workflow_template_id, requirement_set_id, status, manifest, definition_hash,
        created_by_actor_id, reason, idempotency_key, request_fingerprint, event_id, created_at
    ) VALUES (release_id, v_organization_id, series_id, 1, 1, subject_id,
        package_version.workflow_template_id, requirement_set_id, 'draft', manifest, definition_hash,
        p_actor_id, p_reason, p_idempotency_key || ':configuration',
        encode(digest('initial-configuration|' || fingerprint, 'sha256'), 'hex'), event_id, p_now);
    INSERT INTO public.subject_onboardings (
        id, organization_id, subject_id, package_version_id, configuration_release_id,
        created_by_actor_id, reason, idempotency_key, request_fingerprint, event_id, created_at
    ) VALUES (onboarding_id, v_organization_id, subject_id, p_package_version_id, release_id,
        p_actor_id, p_reason, p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'onboardingId', onboarding_id,
        'subjectId', subject_id, 'releaseId', release_id, 'releaseNumber', 1,
        'revision', 1, 'status', 'draft', 'eventId', event_id);
END;
$$;

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
    case_key text;
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
    case_key := organization_key || '|' || workflow_template.template_key || '|' || subject.subject_key || '|' || normalized_period_key;
    IF EXISTS (SELECT 1 FROM public.cases WHERE organization_id = v_organization_id AND cases.case_key = case_key) THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'case_already_exists');
    END IF;
    INSERT INTO public.cases (
        id, organization_id, case_key, subject_id, workflow_template_version_id,
        requirement_set_version_id, prompt_version_id, external_reference,
        period_start, period_end, timezone, status, risk_status, due_at,
        config_snapshot, version, created_at, updated_at
    ) VALUES (case_id, v_organization_id, case_key, current_release.subject_id,
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
        'caseKey', case_key, 'releaseId', current_release.id,
        'workflowTemplateVersionId', current_release.produced_workflow_template_version_id,
        'requirementSetVersionId', current_release.produced_requirement_set_version_id,
        'eventId', event_id, 'status', 'not_started');
END;
$$;

REVOKE ALL ON FUNCTION public.dop_require_active_manager(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_onboard_subject_from_package(uuid,uuid,text,text,text,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_case_from_configuration(uuid,uuid,text,date,date,timestamptz,text,text,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_require_active_manager(uuid) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_onboard_subject_from_package(uuid,uuid,text,text,text,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_create_case_from_configuration(uuid,uuid,text,date,date,timestamptz,text,text,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
