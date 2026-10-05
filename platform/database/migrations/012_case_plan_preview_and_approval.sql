BEGIN;

-- M16 turns recurring future work into a generic, versioned Case Plan.
-- Plans, revisions, previews and approvals are tenant-isolated. The application
-- role can only read the tables; every write passes through an actor-aware
-- SECURITY DEFINER transaction.
CREATE TABLE case_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    plan_key text NOT NULL CHECK (plan_key = lower(btrim(plan_key)) AND plan_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
    subject_id uuid NOT NULL REFERENCES subjects(id),
    display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 160),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
    created_by_actor_id uuid NOT NULL REFERENCES actors(id),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, plan_key)
);

CREATE TABLE case_plan_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    case_plan_id uuid NOT NULL REFERENCES case_plans(id),
    version integer NOT NULL CHECK (version > 0),
    revision integer NOT NULL CHECK (revision > 0),
    status text NOT NULL CHECK (status IN ('draft', 'in_review', 'published')),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    base_version_id uuid REFERENCES case_plan_versions(id),
    created_by_actor_id uuid NOT NULL REFERENCES actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    UNIQUE (organization_id, case_plan_id, version, revision)
);

CREATE TABLE case_plan_preview_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    case_plan_version_id uuid NOT NULL REFERENCES case_plan_versions(id),
    configuration_release_id uuid NOT NULL REFERENCES work_configuration_releases(id),
    subject_id uuid NOT NULL REFERENCES subjects(id),
    candidates jsonb NOT NULL CHECK (
        jsonb_typeof(candidates) = 'array'
        AND jsonb_array_length(candidates) BETWEEN 1 AND 12
    ),
    candidates_hash text NOT NULL CHECK (candidates_hash ~ '^[0-9a-f]{64}$'),
    created_by_actor_id uuid NOT NULL REFERENCES actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE case_plan_approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    preview_batch_id uuid NOT NULL REFERENCES case_plan_preview_batches(id),
    case_plan_version_id uuid NOT NULL REFERENCES case_plan_versions(id),
    configuration_release_id uuid NOT NULL REFERENCES work_configuration_releases(id),
    generated_case_ids uuid[] NOT NULL CHECK (cardinality(generated_case_ids) BETWEEN 1 AND 12),
    approved_by_actor_id uuid NOT NULL REFERENCES actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES workflow_events(id),
    approved_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, preview_batch_id),
    UNIQUE (organization_id, idempotency_key)
);

ALTER TABLE case_plans
    ADD CONSTRAINT case_plan_subject_same_org_fk
        FOREIGN KEY (organization_id, subject_id) REFERENCES subjects(organization_id, id),
    ADD CONSTRAINT case_plan_actor_same_org_fk
        FOREIGN KEY (organization_id, created_by_actor_id) REFERENCES actors(organization_id, id);

ALTER TABLE case_plan_versions
    ADD CONSTRAINT case_plan_version_plan_same_org_fk
        FOREIGN KEY (organization_id, case_plan_id) REFERENCES case_plans(organization_id, id),
    ADD CONSTRAINT case_plan_version_base_same_org_fk
        FOREIGN KEY (organization_id, base_version_id) REFERENCES case_plan_versions(organization_id, id),
    ADD CONSTRAINT case_plan_version_actor_same_org_fk
        FOREIGN KEY (organization_id, created_by_actor_id) REFERENCES actors(organization_id, id),
    ADD CONSTRAINT case_plan_version_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES workflow_events(organization_id, id);

ALTER TABLE case_plan_preview_batches
    ADD CONSTRAINT case_plan_preview_version_same_org_fk
        FOREIGN KEY (organization_id, case_plan_version_id) REFERENCES case_plan_versions(organization_id, id),
    ADD CONSTRAINT case_plan_preview_config_same_org_fk
        FOREIGN KEY (organization_id, configuration_release_id) REFERENCES work_configuration_releases(organization_id, id),
    ADD CONSTRAINT case_plan_preview_subject_same_org_fk
        FOREIGN KEY (organization_id, subject_id) REFERENCES subjects(organization_id, id),
    ADD CONSTRAINT case_plan_preview_actor_same_org_fk
        FOREIGN KEY (organization_id, created_by_actor_id) REFERENCES actors(organization_id, id),
    ADD CONSTRAINT case_plan_preview_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES workflow_events(organization_id, id);

ALTER TABLE case_plan_approvals
    ADD CONSTRAINT case_plan_approval_preview_same_org_fk
        FOREIGN KEY (organization_id, preview_batch_id) REFERENCES case_plan_preview_batches(organization_id, id),
    ADD CONSTRAINT case_plan_approval_version_same_org_fk
        FOREIGN KEY (organization_id, case_plan_version_id) REFERENCES case_plan_versions(organization_id, id),
    ADD CONSTRAINT case_plan_approval_config_same_org_fk
        FOREIGN KEY (organization_id, configuration_release_id) REFERENCES work_configuration_releases(organization_id, id),
    ADD CONSTRAINT case_plan_approval_actor_same_org_fk
        FOREIGN KEY (organization_id, approved_by_actor_id) REFERENCES actors(organization_id, id),
    ADD CONSTRAINT case_plan_approval_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES workflow_events(organization_id, id);

CREATE INDEX case_plan_versions_plan_idx
    ON case_plan_versions (organization_id, case_plan_id, version DESC, revision DESC);
CREATE INDEX case_plan_previews_created_idx
    ON case_plan_preview_batches (organization_id, created_at DESC);
CREATE INDEX case_plan_approvals_created_idx
    ON case_plan_approvals (organization_id, approved_at DESC);

ALTER TABLE case_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_plan_preview_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_plan_approvals ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE case_plans, case_plan_versions, case_plan_preview_batches, case_plan_approvals TO dop_app;

CREATE POLICY dop_tenant_isolation ON case_plans
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON case_plan_versions
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON case_plan_preview_batches
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON case_plan_approvals
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_case_plan_definition_error(p_definition jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    interval_months numeric;
    offset_days numeric;
    preview_count numeric;
    anchor_date date;
BEGIN
    IF jsonb_typeof(p_definition) <> 'object'
       OR jsonb_typeof(p_definition->'cadence') <> 'object'
       OR jsonb_typeof(p_definition->'dueRule') <> 'object'
       OR jsonb_typeof(p_definition->'sourceBinding') <> 'object' THEN
        RETURN 'definition_shape_invalid';
    END IF;
    IF jsonb_typeof(p_definition#>'{cadence,intervalMonths}') <> 'number'
       OR jsonb_typeof(p_definition#>'{dueRule,offsetDays}') <> 'number'
       OR jsonb_typeof(p_definition->'defaultPreviewCount') <> 'number' THEN
        RETURN 'definition_number_invalid';
    END IF;
    interval_months := (p_definition#>>'{cadence,intervalMonths}')::numeric;
    offset_days := (p_definition#>>'{dueRule,offsetDays}')::numeric;
    preview_count := (p_definition->>'defaultPreviewCount')::numeric;
    IF interval_months <> trunc(interval_months) OR interval_months NOT BETWEEN 1 AND 12
       OR offset_days <> trunc(offset_days) OR offset_days NOT BETWEEN -31 AND 365
       OR preview_count <> trunc(preview_count) OR preview_count NOT BETWEEN 1 AND 12 THEN
        RETURN 'definition_number_invalid';
    END IF;
    IF coalesce(p_definition#>>'{cadence,mode}', '') <> 'calendar_months'
       OR coalesce(p_definition#>>'{dueRule,basis}', '') NOT IN ('period_start', 'period_end')
       OR coalesce(p_definition#>>'{dueRule,localTime}', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       OR char_length(coalesce(p_definition->>'timezone', '')) NOT BETWEEN 3 AND 80
       OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_definition->>'timezone') THEN
        RETURN 'definition_schedule_invalid';
    END IF;
    IF coalesce(p_definition#>>'{sourceBinding,type}', '') NOT IN ('manual_upload', 'form_connector', 'api')
       OR coalesce(p_definition#>>'{sourceBinding,bindingKey}', '') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
       OR jsonb_typeof(p_definition#>'{sourceBinding,metadata}') <> 'object'
       OR coalesce(p_definition->>'externalDelivery', '') <> 'disabled' THEN
        RETURN 'definition_source_invalid';
    END IF;
    IF coalesce(p_definition#>>'{cadence,anchorDate}', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN 'definition_anchor_invalid';
    END IF;
    anchor_date := (p_definition#>>'{cadence,anchorDate}')::date;
    IF extract(day FROM anchor_date) <> 1 THEN RETURN 'definition_anchor_invalid'; END IF;
    RETURN NULL;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RETURN 'definition_invalid';
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_create_case_plan(
    p_actor_id uuid, p_subject_id uuid, p_plan_key text, p_display_name text,
    p_definition jsonb, p_reason text, p_idempotency_key text,
    p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    normalized_key text := lower(btrim(p_plan_key));
    normalized_name text := btrim(p_display_name);
    validation_error text;
    definition_hash text;
    fingerprint text;
    existing public.case_plan_versions%ROWTYPE;
    plan_id uuid := gen_random_uuid();
    version_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    validation_error := public.dop_case_plan_definition_error(p_definition);
    IF normalized_key !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
       OR char_length(normalized_name) NOT BETWEEN 2 AND 160
       OR char_length(p_reason) NOT BETWEEN 12 AND 1000
       OR validation_error IS NOT NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', coalesce(validation_error, 'invalid_request'));
    END IF;
    definition_hash := encode(digest(p_definition::text, 'sha256'), 'hex');
    fingerprint := encode(digest(concat_ws('|', 'create', p_subject_id::text, normalized_key,
        normalized_name, definition_hash, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.case_plan_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'planId', existing.case_plan_id,
                'versionId', existing.id, 'version', existing.version, 'revision', existing.revision);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    PERFORM 1 FROM public.subjects
     WHERE id = p_subject_id AND organization_id = v_organization_id AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found', 'reason', 'subject_not_found'); END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.work_configuration_releases release
         WHERE release.organization_id = v_organization_id AND release.subject_id = p_subject_id
           AND release.status = 'published'
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'published_configuration_required'); END IF;
    IF EXISTS (SELECT 1 FROM public.case_plans WHERE organization_id = v_organization_id AND plan_key = normalized_key) THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'plan_key_exists');
    END IF;

    INSERT INTO public.case_plans (
        id, organization_id, plan_key, subject_id, display_name, status,
        created_by_actor_id, created_at, updated_at
    ) VALUES (plan_id, v_organization_id, normalized_key, p_subject_id, normalized_name,
        'active', p_actor_id, p_now, p_now);
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', 'CasePlan.DraftCreated', 1,
        'case_plan', plan_id, p_correlation_id, p_actor_id, 'ops-case-plan',
        jsonb_build_object('plan_key', normalized_key, 'subject_id', p_subject_id,
            'version', 1, 'revision', 1, 'definition_hash', definition_hash,
            'external_delivery', 'disabled'), p_now);
    INSERT INTO public.case_plan_versions (
        id, organization_id, case_plan_id, version, revision, status, definition,
        definition_hash, created_by_actor_id, reason, idempotency_key,
        request_fingerprint, event_id, created_at
    ) VALUES (version_id, v_organization_id, plan_id, 1, 1, 'draft', p_definition,
        definition_hash, p_actor_id, p_reason, p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'planId', plan_id,
        'versionId', version_id, 'version', 1, 'revision', 1, 'status', 'draft', 'eventId', event_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_update_case_plan_draft(
    p_actor_id uuid, p_version_id uuid, p_definition jsonb, p_reason text,
    p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    current_version public.case_plan_versions%ROWTYPE;
    existing public.case_plan_versions%ROWTYPE;
    validation_error text;
    definition_hash text;
    fingerprint text;
    version_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    validation_error := public.dop_case_plan_definition_error(p_definition);
    IF validation_error IS NOT NULL OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', coalesce(validation_error, 'invalid_request'));
    END IF;
    definition_hash := encode(digest(p_definition::text, 'sha256'), 'hex');
    fingerprint := encode(digest(concat_ws('|', 'update', p_version_id::text,
        definition_hash, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.case_plan_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'versionId', existing.id,
                'planId', existing.case_plan_id, 'version', existing.version, 'revision', existing.revision);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO current_version FROM public.case_plan_versions version_record
     WHERE version_record.id = p_version_id AND version_record.organization_id = v_organization_id FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    PERFORM 1 FROM public.case_plans plan
     WHERE plan.id = current_version.case_plan_id AND plan.organization_id = v_organization_id
       AND plan.status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'plan_not_active'); END IF;
    IF current_version.status <> 'draft' OR EXISTS (
        SELECT 1 FROM public.case_plan_versions newer
         WHERE newer.organization_id = v_organization_id
           AND newer.case_plan_id = current_version.case_plan_id
           AND newer.version = current_version.version AND newer.revision > current_version.revision
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'version_not_current_draft'); END IF;

    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', 'CasePlan.DraftUpdated', 1,
        'case_plan', current_version.case_plan_id, p_correlation_id, p_actor_id, 'ops-case-plan',
        jsonb_build_object('version', current_version.version,
            'revision', current_version.revision + 1, 'previous_hash', current_version.definition_hash,
            'definition_hash', definition_hash), p_now);
    INSERT INTO public.case_plan_versions (
        id, organization_id, case_plan_id, version, revision, status, definition,
        definition_hash, base_version_id, created_by_actor_id, reason, idempotency_key,
        request_fingerprint, event_id, created_at
    ) VALUES (version_id, v_organization_id, current_version.case_plan_id, current_version.version,
        current_version.revision + 1, 'draft', p_definition, definition_hash,
        current_version.base_version_id, p_actor_id, p_reason, p_idempotency_key,
        fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'planId', current_version.case_plan_id,
        'versionId', version_id, 'version', current_version.version,
        'revision', current_version.revision + 1, 'status', 'draft', 'eventId', event_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_transition_case_plan_version(
    p_actor_id uuid, p_version_id uuid, p_action text, p_reason text,
    p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    current_version public.case_plan_versions%ROWTYPE;
    existing public.case_plan_versions%ROWTYPE;
    fingerprint text;
    next_status text;
    event_type text;
    version_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF p_action NOT IN ('submit_review', 'return_to_draft', 'publish')
       OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', 'transition', p_version_id::text,
        p_action, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.case_plan_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'versionId', existing.id,
                'planId', existing.case_plan_id, 'version', existing.version,
                'revision', existing.revision, 'status', existing.status);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO current_version FROM public.case_plan_versions version_record
     WHERE version_record.id = p_version_id AND version_record.organization_id = v_organization_id FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    PERFORM 1 FROM public.case_plans plan
     WHERE plan.id = current_version.case_plan_id AND plan.organization_id = v_organization_id
       AND plan.status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'plan_not_active'); END IF;
    IF EXISTS (
        SELECT 1 FROM public.case_plan_versions newer
         WHERE newer.organization_id = v_organization_id
           AND newer.case_plan_id = current_version.case_plan_id
           AND newer.version = current_version.version AND newer.revision > current_version.revision
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'version_not_current'); END IF;
    IF (p_action = 'submit_review' AND current_version.status <> 'draft')
       OR (p_action IN ('return_to_draft', 'publish') AND current_version.status <> 'in_review') THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'transition_not_allowed');
    END IF;
    IF public.dop_case_plan_definition_error(current_version.definition) IS NOT NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'definition_invalid');
    END IF;
    IF p_action = 'publish' AND EXISTS (
        SELECT 1 FROM public.case_plan_versions published
         WHERE published.organization_id = v_organization_id
           AND published.case_plan_id = current_version.case_plan_id
           AND published.status = 'published' AND published.version > current_version.version
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'newer_version_already_published'); END IF;

    next_status := CASE p_action WHEN 'submit_review' THEN 'in_review'
        WHEN 'return_to_draft' THEN 'draft' ELSE 'published' END;
    event_type := CASE p_action WHEN 'submit_review' THEN 'CasePlan.ReviewRequested'
        WHEN 'return_to_draft' THEN 'CasePlan.ReviewReturned' ELSE 'CasePlan.Published' END;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', event_type, 1,
        'case_plan', current_version.case_plan_id, p_correlation_id, p_actor_id, 'ops-case-plan',
        jsonb_build_object('version', current_version.version,
            'revision', current_version.revision + 1, 'status', next_status,
            'definition_hash', current_version.definition_hash, 'reason', p_reason), p_now);
    INSERT INTO public.case_plan_versions (
        id, organization_id, case_plan_id, version, revision, status, definition,
        definition_hash, base_version_id, created_by_actor_id, reason, idempotency_key,
        request_fingerprint, event_id, created_at
    ) VALUES (version_id, v_organization_id, current_version.case_plan_id, current_version.version,
        current_version.revision + 1, next_status, current_version.definition,
        current_version.definition_hash, current_version.base_version_id, p_actor_id, p_reason,
        p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'planId', current_version.case_plan_id,
        'versionId', version_id, 'version', current_version.version,
        'revision', current_version.revision + 1, 'status', next_status, 'eventId', event_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_clone_case_plan_version(
    p_actor_id uuid, p_source_version_id uuid, p_reason text,
    p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    source_version public.case_plan_versions%ROWTYPE;
    existing public.case_plan_versions%ROWTYPE;
    fingerprint text;
    next_version integer;
    version_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', 'clone', p_source_version_id::text,
        p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.case_plan_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'versionId', existing.id,
                'planId', existing.case_plan_id, 'version', existing.version, 'revision', existing.revision);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO source_version FROM public.case_plan_versions source_record
     WHERE source_record.id = p_source_version_id
       AND source_record.organization_id = v_organization_id AND source_record.status = 'published';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    PERFORM 1 FROM public.case_plans
     WHERE id = source_version.case_plan_id AND organization_id = v_organization_id
       AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'plan_not_active'); END IF;
    IF EXISTS (
        SELECT 1 FROM public.case_plan_versions open_version
         WHERE open_version.organization_id = v_organization_id
           AND open_version.case_plan_id = source_version.case_plan_id
           AND open_version.status IN ('draft', 'in_review')
           AND NOT EXISTS (
               SELECT 1 FROM public.case_plan_versions newer
                WHERE newer.organization_id = v_organization_id
                  AND newer.case_plan_id = open_version.case_plan_id
                  AND newer.version = open_version.version AND newer.revision > open_version.revision
           )
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'open_version_exists'); END IF;
    SELECT coalesce(max(version), 0) + 1 INTO next_version
      FROM public.case_plan_versions
     WHERE organization_id = v_organization_id AND case_plan_id = source_version.case_plan_id;

    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', 'CasePlan.DraftCreated', 1,
        'case_plan', source_version.case_plan_id, p_correlation_id, p_actor_id, 'ops-case-plan',
        jsonb_build_object('version', next_version, 'revision', 1,
            'base_version_id', source_version.id, 'definition_hash', source_version.definition_hash), p_now);
    INSERT INTO public.case_plan_versions (
        id, organization_id, case_plan_id, version, revision, status, definition,
        definition_hash, base_version_id, created_by_actor_id, reason, idempotency_key,
        request_fingerprint, event_id, created_at
    ) VALUES (version_id, v_organization_id, source_version.case_plan_id, next_version, 1,
        'draft', source_version.definition, source_version.definition_hash, source_version.id,
        p_actor_id, p_reason, p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'planId', source_version.case_plan_id,
        'versionId', version_id, 'version', next_version,
        'revision', 1, 'status', 'draft', 'eventId', event_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_preview_case_plan(
    p_actor_id uuid, p_version_id uuid, p_candidate_count integer, p_start_on date,
    p_reason text, p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_manager(p_actor_id);
    plan_version public.case_plan_versions%ROWTYPE;
    plan_record public.case_plans%ROWTYPE;
    subject_record public.subjects%ROWTYPE;
    configuration public.work_configuration_releases%ROWTYPE;
    workflow_template public.workflow_templates%ROWTYPE;
    existing public.case_plan_preview_batches%ROWTYPE;
    interval_months integer;
    offset_days integer;
    anchor_date date;
    requested_start date;
    candidate_start date;
    candidate_end date;
    due_basis_date date;
    candidate_due timestamptz;
    months_between integer;
    attempts integer := 0;
    organization_key text;
    period_key text;
    generated_case_key text;
    candidates jsonb := '[]'::jsonb;
    candidates_hash text;
    fingerprint text;
    batch_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF p_candidate_count NOT BETWEEN 1 AND 12 OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', 'preview', p_version_id::text,
        p_candidate_count::text, coalesce(p_start_on::text, ''), p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.case_plan_preview_batches
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'previewId', existing.id,
                'candidateCount', jsonb_array_length(existing.candidates));
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO plan_version FROM public.case_plan_versions version_record
     WHERE version_record.id = p_version_id AND version_record.organization_id = v_organization_id
       AND version_record.status = 'published'
       AND version_record.version = (
           SELECT max(candidate.version) FROM public.case_plan_versions candidate
            WHERE candidate.organization_id = v_organization_id
              AND candidate.case_plan_id = version_record.case_plan_id AND candidate.status = 'published'
       );
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'plan_version_not_current_published'); END IF;
    SELECT * INTO plan_record FROM public.case_plans
     WHERE id = plan_version.case_plan_id AND organization_id = v_organization_id
       AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'plan_not_active'); END IF;
    SELECT * INTO subject_record FROM public.subjects
     WHERE id = plan_record.subject_id AND organization_id = v_organization_id
       AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'subject_not_active'); END IF;
    SELECT * INTO configuration FROM public.work_configuration_releases release
     WHERE release.organization_id = v_organization_id AND release.subject_id = plan_record.subject_id
       AND release.status = 'published'
     ORDER BY release.release_number DESC, release.revision DESC LIMIT 1;
    IF NOT FOUND OR configuration.produced_workflow_template_version_id IS NULL
       OR configuration.produced_requirement_set_version_id IS NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'published_configuration_required');
    END IF;
    SELECT * INTO workflow_template FROM public.workflow_templates
     WHERE id = configuration.workflow_template_id AND organization_id = v_organization_id;
    SELECT organization.organization_key INTO organization_key
      FROM public.organizations organization WHERE organization.id = v_organization_id;

    interval_months := (plan_version.definition#>>'{cadence,intervalMonths}')::integer;
    offset_days := (plan_version.definition#>>'{dueRule,offsetDays}')::integer;
    anchor_date := (plan_version.definition#>>'{cadence,anchorDate}')::date;
    SELECT coalesce(p_start_on, max(case_record.period_end) + 1, anchor_date)
      INTO requested_start
      FROM public.cases case_record
     WHERE case_record.organization_id = v_organization_id
       AND case_record.subject_id = plan_record.subject_id
       AND case_record.period_end IS NOT NULL;
    requested_start := greatest(requested_start, anchor_date);
    requested_start := date_trunc('month', requested_start)::date;
    months_between := (extract(year FROM requested_start)::integer - extract(year FROM anchor_date)::integer) * 12
        + extract(month FROM requested_start)::integer - extract(month FROM anchor_date)::integer;
    IF months_between < 0 THEN months_between := 0; END IF;
    IF mod(months_between, interval_months) <> 0 THEN
        months_between := months_between + interval_months - mod(months_between, interval_months);
    END IF;
    candidate_start := (anchor_date + make_interval(months => months_between))::date;

    WHILE jsonb_array_length(candidates) < p_candidate_count AND attempts < 120 LOOP
        candidate_end := (candidate_start + make_interval(months => interval_months) - interval '1 day')::date;
        due_basis_date := CASE plan_version.definition#>>'{dueRule,basis}'
            WHEN 'period_start' THEN candidate_start ELSE candidate_end END;
        candidate_due := (due_basis_date + offset_days
            + (plan_version.definition#>>'{dueRule,localTime}')::time)
            AT TIME ZONE (plan_version.definition->>'timezone');
        period_key := to_char(candidate_start, 'YYYY-MM');
        generated_case_key := organization_key || '|' || workflow_template.template_key || '|'
            || subject_record.subject_key || '|' || period_key;
        IF NOT EXISTS (
            SELECT 1 FROM public.cases existing_case
             WHERE existing_case.organization_id = v_organization_id
               AND existing_case.case_key = generated_case_key
        ) THEN
            candidates := candidates || jsonb_build_array(jsonb_build_object(
                'caseKey', generated_case_key, 'periodKey', period_key,
                'periodStart', candidate_start, 'periodEnd', candidate_end,
                'dueAt', candidate_due, 'timezone', plan_version.definition->>'timezone',
                'sourceBinding', plan_version.definition->'sourceBinding',
                'externalDelivery', 'disabled'
            ));
        END IF;
        candidate_start := (candidate_start + make_interval(months => interval_months))::date;
        attempts := attempts + 1;
    END LOOP;
    IF jsonb_array_length(candidates) <> p_candidate_count THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'preview_horizon_unavailable');
    END IF;
    candidates_hash := encode(digest(candidates::text, 'sha256'), 'hex');
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', 'CasePlan.PreviewCreated', 1,
        'case_plan_preview', batch_id, p_correlation_id, p_actor_id, 'ops-case-plan',
        jsonb_build_object('case_plan_id', plan_record.id, 'case_plan_version_id', plan_version.id,
            'configuration_release_id', configuration.id, 'candidate_count', p_candidate_count,
            'candidates_hash', candidates_hash, 'external_delivery', 'disabled'), p_now);
    INSERT INTO public.case_plan_preview_batches (
        id, organization_id, case_plan_version_id, configuration_release_id, subject_id,
        candidates, candidates_hash, created_by_actor_id, reason, idempotency_key,
        request_fingerprint, event_id, created_at
    ) VALUES (batch_id, v_organization_id, plan_version.id, configuration.id,
        plan_record.subject_id, candidates, candidates_hash, p_actor_id, p_reason,
        p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'previewId', batch_id,
        'candidateCount', p_candidate_count, 'configurationReleaseId', configuration.id,
        'candidatesHash', candidates_hash, 'eventId', event_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_approve_case_plan_preview(
    p_actor_id uuid, p_preview_id uuid, p_reason text, p_idempotency_key text,
    p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_manager(p_actor_id);
    preview public.case_plan_preview_batches%ROWTYPE;
    plan_version public.case_plan_versions%ROWTYPE;
    plan_record public.case_plans%ROWTYPE;
    configuration public.work_configuration_releases%ROWTYPE;
    subject_record public.subjects%ROWTYPE;
    existing public.case_plan_approvals%ROWTYPE;
    prompt_version_id uuid;
    fingerprint text;
    candidate jsonb;
    ordinal bigint;
    case_id uuid;
    case_event_id uuid;
    generated_case_ids uuid[] := ARRAY[]::uuid[];
    approval_id uuid := gen_random_uuid();
    approval_event_id uuid := gen_random_uuid();
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    SELECT * INTO preview FROM public.case_plan_preview_batches batch
     WHERE batch.id = p_preview_id AND batch.organization_id = v_organization_id FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    fingerprint := encode(digest(concat_ws('|', 'approve', p_preview_id::text,
        preview.candidates_hash, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.case_plan_approvals
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'approvalId', existing.id,
                'previewId', existing.preview_batch_id,
                'generatedCaseIds', to_jsonb(existing.generated_case_ids),
                'caseCount', cardinality(existing.generated_case_ids));
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.case_plan_approvals approval
         WHERE approval.organization_id = v_organization_id AND approval.preview_batch_id = preview.id
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'preview_already_approved'); END IF;
    IF encode(digest(preview.candidates::text, 'sha256'), 'hex') <> preview.candidates_hash THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'preview_integrity_failed');
    END IF;
    SELECT * INTO plan_version FROM public.case_plan_versions version_record
     WHERE version_record.id = preview.case_plan_version_id
       AND version_record.organization_id = v_organization_id AND version_record.status = 'published'
       AND version_record.version = (
           SELECT max(candidate.version) FROM public.case_plan_versions candidate
            WHERE candidate.organization_id = v_organization_id
              AND candidate.case_plan_id = version_record.case_plan_id AND candidate.status = 'published'
       );
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'preview_stale_plan'); END IF;
    SELECT * INTO plan_record FROM public.case_plans
     WHERE id = plan_version.case_plan_id AND organization_id = v_organization_id
       AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'plan_not_active'); END IF;
    SELECT * INTO subject_record FROM public.subjects
     WHERE id = preview.subject_id AND organization_id = v_organization_id
       AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'subject_not_active'); END IF;
    SELECT * INTO configuration FROM public.work_configuration_releases release
     WHERE release.id = preview.configuration_release_id
       AND release.organization_id = v_organization_id AND release.status = 'published'
       AND release.release_number = (
           SELECT max(candidate.release_number) FROM public.work_configuration_releases candidate
            WHERE candidate.organization_id = v_organization_id
              AND candidate.subject_id = release.subject_id AND candidate.status = 'published'
       );
    IF NOT FOUND OR configuration.subject_id <> preview.subject_id THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'preview_stale_configuration');
    END IF;
    IF configuration.produced_workflow_template_version_id IS NULL
       OR configuration.produced_requirement_set_version_id IS NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'published_configuration_incomplete');
    END IF;
    SELECT id INTO prompt_version_id FROM public.prompt_versions
     WHERE organization_id = v_organization_id AND prompt_key = 'document-classifier' AND status = 'published'
     ORDER BY version DESC LIMIT 1;
    IF prompt_version_id IS NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'published_prompt_not_found');
    END IF;

    -- Preflight the entire batch before creating anything. A single collision
    -- makes the preview stale; the operator must generate and approve a fresh batch.
    FOR candidate, ordinal IN
        SELECT value, ordinality FROM jsonb_array_elements(preview.candidates) WITH ORDINALITY
    LOOP
        IF coalesce(candidate->>'externalDelivery', '') <> 'disabled'
           OR jsonb_typeof(candidate->'sourceBinding') <> 'object'
           OR EXISTS (
               SELECT 1 FROM public.cases existing_case
                WHERE existing_case.organization_id = v_organization_id
                  AND existing_case.case_key = candidate->>'caseKey'
           ) THEN
            RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'preview_stale_case');
        END IF;
    END LOOP;

    FOR candidate, ordinal IN
        SELECT value, ordinality FROM jsonb_array_elements(preview.candidates) WITH ORDINALITY
    LOOP
        case_id := gen_random_uuid();
        case_event_id := gen_random_uuid();
        INSERT INTO public.cases (
            id, organization_id, case_key, subject_id, workflow_template_version_id,
            requirement_set_version_id, prompt_version_id, external_reference,
            period_start, period_end, timezone, status, risk_status, due_at,
            config_snapshot, version, created_at, updated_at
        ) VALUES (case_id, v_organization_id, candidate->>'caseKey', preview.subject_id,
            configuration.produced_workflow_template_version_id,
            configuration.produced_requirement_set_version_id, prompt_version_id, NULL,
            (candidate->>'periodStart')::date, (candidate->>'periodEnd')::date,
            candidate->>'timezone', 'not_started', 'normal', (candidate->>'dueAt')::timestamptz,
            jsonb_build_object(
                'source', 'case_plan_preview',
                'configuration_release_id', configuration.id,
                'configuration_release_number', configuration.release_number,
                'configuration_definition_hash', configuration.definition_hash,
                'manifest', configuration.manifest,
                'case_plan', jsonb_build_object(
                    'case_plan_id', plan_record.id, 'case_plan_key', plan_record.plan_key,
                    'case_plan_version_id', plan_version.id, 'case_plan_version', plan_version.version,
                    'case_plan_definition_hash', plan_version.definition_hash,
                    'preview_batch_id', preview.id
                ),
                'source_binding', candidate->'sourceBinding',
                'external_delivery', 'disabled',
                'external_messages_require_approval', true
            ), 1, p_now, p_now);
        INSERT INTO public.workflow_events (
            id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
            aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
        ) VALUES (case_event_id, v_organization_id,
            p_idempotency_key || ':case:' || ordinal::text, 'Case.CreatedFromPlan', 1,
            'case', case_id, p_correlation_id, p_actor_id, 'ops-case-plan',
            jsonb_build_object('case_plan_id', plan_record.id,
                'case_plan_version_id', plan_version.id, 'preview_batch_id', preview.id,
                'configuration_release_id', configuration.id,
                'period_key', candidate->>'periodKey',
                'period_start', candidate->>'periodStart', 'period_end', candidate->>'periodEnd',
                'due_at', candidate->>'dueAt', 'source_binding', candidate->'sourceBinding',
                'external_delivery', 'disabled', 'reason', p_reason), p_now);
        generated_case_ids := array_append(generated_case_ids, case_id);
    END LOOP;

    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (approval_event_id, v_organization_id, p_idempotency_key || ':event',
        'CasePlan.PreviewApproved', 1, 'case_plan_preview', preview.id,
        p_correlation_id, p_actor_id, 'ops-case-plan',
        jsonb_build_object('case_plan_id', plan_record.id,
            'case_plan_version_id', plan_version.id,
            'configuration_release_id', configuration.id,
            'candidate_count', jsonb_array_length(preview.candidates),
            'candidates_hash', preview.candidates_hash,
            'generated_case_ids', to_jsonb(generated_case_ids),
            'external_delivery', 'disabled', 'reason', p_reason), p_now);
    INSERT INTO public.case_plan_approvals (
        id, organization_id, preview_batch_id, case_plan_version_id,
        configuration_release_id, generated_case_ids, approved_by_actor_id,
        reason, idempotency_key, request_fingerprint, event_id, approved_at
    ) VALUES (approval_id, v_organization_id, preview.id, plan_version.id,
        configuration.id, generated_case_ids, p_actor_id, p_reason, p_idempotency_key,
        fingerprint, approval_event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'approvalId', approval_id,
        'previewId', preview.id, 'generatedCaseIds', to_jsonb(generated_case_ids),
        'caseCount', cardinality(generated_case_ids), 'eventId', approval_event_id,
        'externalDelivery', 'disabled');
END;
$$;

REVOKE ALL ON FUNCTION public.dop_case_plan_definition_error(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_case_plan(uuid,uuid,text,text,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_update_case_plan_draft(uuid,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_transition_case_plan_version(uuid,uuid,text,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_clone_case_plan_version(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_preview_case_plan(uuid,uuid,integer,date,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_approve_case_plan_preview(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.dop_case_plan_definition_error(jsonb) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_create_case_plan(uuid,uuid,text,text,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_update_case_plan_draft(uuid,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_transition_case_plan_version(uuid,uuid,text,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_clone_case_plan_version(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_preview_case_plan(uuid,uuid,integer,date,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_approve_case_plan_preview(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
