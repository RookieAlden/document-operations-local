BEGIN;

-- M17 turns the M15 seed-only Work Package catalogue into an append-only,
-- operator-governed authoring surface. Existing published package rows remain
-- valid and are backfilled as revision 1.
ALTER TABLE public.work_configuration_package_versions
    ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN display_name_snapshot text,
    ADD COLUMN description_snapshot text,
    ADD COLUMN industry_package_snapshot text,
    ADD COLUMN idempotency_key text,
    ADD COLUMN request_fingerprint text CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'),
    ADD COLUMN event_id uuid;

UPDATE public.work_configuration_package_versions version
   SET display_name_snapshot = package.display_name,
       description_snapshot = package.description,
       industry_package_snapshot = package.industry_package
  FROM public.work_configuration_packages package
 WHERE package.id = version.package_id;

ALTER TABLE public.work_configuration_package_versions
    ALTER COLUMN display_name_snapshot SET NOT NULL,
    ALTER COLUMN description_snapshot SET NOT NULL,
    DROP CONSTRAINT work_configuration_package_versions_status_check,
    DROP CONSTRAINT work_configuration_package_versions_package_id_version_key,
    DROP CONSTRAINT work_configuration_package_versi_package_id_definition_hash_key,
    ADD CONSTRAINT work_package_version_status_check
        CHECK (status IN ('draft', 'in_review', 'published', 'retired')),
    ADD CONSTRAINT work_package_version_number_revision_key
        UNIQUE (package_id, version, revision),
    ADD CONSTRAINT work_package_version_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES public.workflow_events(organization_id, id);

CREATE UNIQUE INDEX work_package_version_idempotency_key
    ON public.work_configuration_package_versions (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
DROP INDEX public.work_package_versions_catalog_idx;
CREATE INDEX work_package_versions_catalog_idx
    ON public.work_configuration_package_versions
       (organization_id, package_id, version DESC, revision DESC);

ALTER TABLE public.work_configuration_packages
    ADD COLUMN current_published_version_id uuid;

UPDATE public.work_configuration_packages package
   SET current_published_version_id = (
       SELECT version.id
         FROM public.work_configuration_package_versions version
        WHERE version.package_id = package.id AND version.status = 'published'
        ORDER BY version.version DESC, version.revision DESC
        LIMIT 1
   );

ALTER TABLE public.work_configuration_packages
    ADD CONSTRAINT work_package_current_version_same_org_fk
        FOREIGN KEY (organization_id, current_published_version_id)
        REFERENCES public.work_configuration_package_versions(organization_id, id);

CREATE TABLE public.work_configuration_package_dry_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    package_id uuid NOT NULL REFERENCES public.work_configuration_packages(id),
    package_version_id uuid NOT NULL REFERENCES public.work_configuration_package_versions(id),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    synthetic_sample jsonb NOT NULL CHECK (jsonb_typeof(synthetic_sample) = 'object'),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    status text NOT NULL CHECK (status IN ('passed', 'failed')),
    run_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    CONSTRAINT work_package_dry_run_package_same_org_fk
        FOREIGN KEY (organization_id, package_id)
        REFERENCES public.work_configuration_packages(organization_id, id),
    CONSTRAINT work_package_dry_run_version_same_org_fk
        FOREIGN KEY (organization_id, package_version_id)
        REFERENCES public.work_configuration_package_versions(organization_id, id),
    CONSTRAINT work_package_dry_run_actor_same_org_fk
        FOREIGN KEY (organization_id, run_by_actor_id)
        REFERENCES public.actors(organization_id, id),
    CONSTRAINT work_package_dry_run_event_same_org_fk
        FOREIGN KEY (organization_id, event_id)
        REFERENCES public.workflow_events(organization_id, id)
);

CREATE INDEX work_package_dry_runs_history_idx
    ON public.work_configuration_package_dry_runs
       (organization_id, package_id, created_at DESC);

ALTER TABLE public.work_configuration_package_dry_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.work_configuration_package_dry_runs TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.work_configuration_package_dry_runs
    FOR SELECT TO dop_app
    USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_work_package_blueprint_error(
    p_organization_id uuid, p_workflow_template_id uuid, p_blueprint jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    manifest jsonb;
BEGIN
    IF jsonb_typeof(p_blueprint) <> 'object'
       OR jsonb_typeof(p_blueprint->'subjectDefaults') <> 'object'
       OR jsonb_typeof(p_blueprint#>'{subjectDefaults,attributes}') <> 'object'
       OR coalesce(p_blueprint#>>'{subjectDefaults,status}', '') NOT IN ('active', 'paused')
       OR jsonb_typeof(p_blueprint->'workflow') <> 'object'
       OR jsonb_typeof(p_blueprint->'requirements') <> 'array' THEN
        RETURN 'package_blueprint_invalid';
    END IF;
    IF coalesce(p_blueprint#>>'{workflow,environment}', '') <> 'DEV'
       OR coalesce((p_blueprint#>>'{workflow,external_messages_require_approval}')::boolean, false) IS NOT TRUE
       OR coalesce(p_blueprint#>>'{workflow,dev_recipient_policy}', '') <> 'allowlist_only' THEN
        RETURN 'package_safety_boundary_invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.workflow_templates
         WHERE id = p_workflow_template_id
           AND organization_id = p_organization_id AND status = 'active'
    ) THEN
        RETURN 'workflow_template_not_found';
    END IF;
    manifest := jsonb_build_object(
        'subject', jsonb_build_object(
            'displayName', 'Synthetic dry-run subject',
            'subjectType', 'synthetic_subject',
            'status', p_blueprint#>>'{subjectDefaults,status}',
            'primaryContactActorId', NULL,
            'attributes', p_blueprint#>'{subjectDefaults,attributes}'
        ),
        'workflow', p_blueprint->'workflow',
        'requirements', p_blueprint->'requirements'
    );
    RETURN public.dop_configuration_manifest_error(p_organization_id, manifest);
EXCEPTION WHEN invalid_text_representation THEN
    RETURN 'package_safety_boundary_invalid';
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_create_work_package(
    p_actor_id uuid, p_package_key text, p_display_name text,
    p_description text, p_industry_package text, p_workflow_template_id uuid,
    p_blueprint jsonb, p_reason text, p_idempotency_key text,
    p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    normalized_key text := lower(btrim(p_package_key));
    normalized_name text := btrim(p_display_name);
    normalized_description text := btrim(p_description);
    normalized_industry text := nullif(lower(btrim(coalesce(p_industry_package, ''))), '');
    validation_error text;
    fingerprint text;
    definition_hash text;
    package_id uuid := gen_random_uuid();
    version_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    existing public.workflow_events%ROWTYPE;
BEGIN
    IF normalized_key !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
       OR char_length(normalized_name) NOT BETWEEN 2 AND 160
       OR char_length(normalized_description) NOT BETWEEN 12 AND 1000
       OR char_length(coalesce(normalized_industry, '')) > 120
       OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    validation_error := public.dop_work_package_blueprint_error(
        v_organization_id, p_workflow_template_id, p_blueprint
    );
    IF validation_error IS NOT NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', validation_error);
    END IF;
    definition_hash := encode(digest(p_blueprint::text, 'sha256'), 'hex');
    fingerprint := encode(digest(concat_ws('|', normalized_key, normalized_name,
        normalized_description, coalesce(normalized_industry, ''),
        p_workflow_template_id::text, p_blueprint::text, p_reason), 'sha256'), 'hex');
    PERFORM 1 FROM public.organizations WHERE id = v_organization_id FOR UPDATE;
    SELECT * INTO existing FROM public.workflow_events
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key || ':event';
    IF FOUND THEN
        IF existing.event_type = 'WorkPackage.Created'
           AND existing.payload->>'request_fingerprint' = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'packageId', existing.aggregate_id,
                'versionId', existing.payload->>'version_id');
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.work_configuration_packages
         WHERE organization_id = v_organization_id AND package_key = normalized_key
    ) THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'package_key_exists');
    END IF;
    INSERT INTO public.work_configuration_packages (
        id, organization_id, package_key, display_name, description,
        industry_package, status, created_at, updated_at
    ) VALUES (package_id, v_organization_id, normalized_key, normalized_name,
        normalized_description, normalized_industry, 'active', p_now, p_now);
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event',
        'WorkPackage.Created', 1, 'work_package', package_id, p_correlation_id,
        p_actor_id, 'ops-work-package', jsonb_build_object(
            'version_id', version_id, 'version', 1, 'revision', 1,
            'definition_hash', definition_hash, 'request_fingerprint', fingerprint,
            'external_delivery', 'disabled'), p_now);
    INSERT INTO public.work_configuration_package_versions (
        id, organization_id, package_id, workflow_template_id, version, revision,
        status, blueprint, definition_hash, display_name_snapshot,
        description_snapshot, industry_package_snapshot, created_by_actor_id,
        reason, idempotency_key, request_fingerprint, event_id, created_at
    ) VALUES (version_id, v_organization_id, package_id, p_workflow_template_id, 1, 1,
        'draft', p_blueprint, definition_hash, normalized_name, normalized_description,
        normalized_industry, p_actor_id, p_reason, p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'packageId', package_id,
        'versionId', version_id, 'version', 1, 'revision', 1, 'status', 'draft');
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_update_work_package_draft(
    p_actor_id uuid, p_version_id uuid, p_display_name text,
    p_description text, p_industry_package text, p_workflow_template_id uuid,
    p_blueprint jsonb, p_reason text, p_idempotency_key text,
    p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    source public.work_configuration_package_versions%ROWTYPE;
    package public.work_configuration_packages%ROWTYPE;
    normalized_name text := btrim(p_display_name);
    normalized_description text := btrim(p_description);
    normalized_industry text := nullif(lower(btrim(coalesce(p_industry_package, ''))), '');
    validation_error text;
    fingerprint text;
    definition_hash text;
    new_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    existing public.work_configuration_package_versions%ROWTYPE;
BEGIN
    IF char_length(normalized_name) NOT BETWEEN 2 AND 160
       OR char_length(normalized_description) NOT BETWEEN 12 AND 1000
       OR char_length(coalesce(normalized_industry, '')) > 120
       OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    validation_error := public.dop_work_package_blueprint_error(
        v_organization_id, p_workflow_template_id, p_blueprint
    );
    IF validation_error IS NOT NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', validation_error);
    END IF;
    definition_hash := encode(digest(p_blueprint::text, 'sha256'), 'hex');
    fingerprint := encode(digest(concat_ws('|', p_version_id::text, normalized_name,
        normalized_description, coalesce(normalized_industry, ''),
        p_workflow_template_id::text, p_blueprint::text, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.work_configuration_package_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'versionId', existing.id,
                'version', existing.version, 'revision', existing.revision, 'status', existing.status);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO source FROM public.work_configuration_package_versions
     WHERE id = p_version_id AND organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found', 'reason', 'package_version_not_found'); END IF;
    SELECT * INTO package FROM public.work_configuration_packages
     WHERE id = source.package_id AND organization_id = v_organization_id FOR UPDATE;
    IF package.status <> 'active' THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'package_not_active'); END IF;
    IF source.status <> 'draft' OR EXISTS (
        SELECT 1 FROM public.work_configuration_package_versions candidate
         WHERE candidate.package_id = source.package_id
           AND (candidate.version, candidate.revision) > (source.version, source.revision)
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'draft_not_current'); END IF;
    IF source.definition_hash = definition_hash
       AND source.display_name_snapshot = normalized_name
       AND source.description_snapshot = normalized_description
       AND coalesce(source.industry_package_snapshot, '') = coalesce(normalized_industry, '')
       AND source.workflow_template_id = p_workflow_template_id THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'definition_unchanged');
    END IF;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event',
        'WorkPackage.DraftRevised', 1, 'work_package', source.package_id,
        p_correlation_id, p_actor_id, 'ops-work-package', jsonb_build_object(
            'source_version_id', source.id, 'version_id', new_id,
            'version', source.version, 'revision', source.revision + 1,
            'definition_hash', definition_hash, 'request_fingerprint', fingerprint,
            'external_delivery', 'disabled'), p_now);
    INSERT INTO public.work_configuration_package_versions (
        id, organization_id, package_id, workflow_template_id, version, revision,
        status, blueprint, definition_hash, display_name_snapshot,
        description_snapshot, industry_package_snapshot, created_by_actor_id,
        reason, idempotency_key, request_fingerprint, event_id, created_at
    ) VALUES (new_id, v_organization_id, source.package_id, p_workflow_template_id,
        source.version, source.revision + 1, 'draft', p_blueprint, definition_hash,
        normalized_name, normalized_description, normalized_industry, p_actor_id,
        p_reason, p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'packageId', source.package_id,
        'versionId', new_id, 'version', source.version,
        'revision', source.revision + 1, 'status', 'draft');
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_clone_work_package_version(
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
    source public.work_configuration_package_versions%ROWTYPE;
    package public.work_configuration_packages%ROWTYPE;
    existing public.work_configuration_package_versions%ROWTYPE;
    fingerprint text;
    next_version integer;
    new_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', p_source_version_id::text, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.work_configuration_package_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'versionId', existing.id,
                'version', existing.version, 'revision', existing.revision, 'status', existing.status);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO source FROM public.work_configuration_package_versions
     WHERE id = p_source_version_id AND organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found', 'reason', 'package_version_not_found'); END IF;
    SELECT * INTO package FROM public.work_configuration_packages
     WHERE id = source.package_id AND organization_id = v_organization_id FOR UPDATE;
    IF package.status <> 'active' THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'package_not_active'); END IF;
    IF source.status <> 'published' OR package.current_published_version_id <> source.id THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'source_not_current_published');
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.work_configuration_package_versions candidate
         WHERE candidate.package_id = source.package_id
           AND candidate.version > source.version AND candidate.status IN ('draft', 'in_review')
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'open_draft_exists'); END IF;
    SELECT coalesce(max(version), 0) + 1 INTO next_version
      FROM public.work_configuration_package_versions WHERE package_id = source.package_id;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event',
        'WorkPackage.VersionCloned', 1, 'work_package', source.package_id,
        p_correlation_id, p_actor_id, 'ops-work-package', jsonb_build_object(
            'source_version_id', source.id, 'version_id', new_id,
            'version', next_version, 'revision', 1,
            'definition_hash', source.definition_hash,
            'request_fingerprint', fingerprint, 'external_delivery', 'disabled'), p_now);
    INSERT INTO public.work_configuration_package_versions (
        id, organization_id, package_id, workflow_template_id, version, revision,
        status, blueprint, definition_hash, display_name_snapshot,
        description_snapshot, industry_package_snapshot, created_by_actor_id,
        reason, idempotency_key, request_fingerprint, event_id, created_at
    ) VALUES (new_id, v_organization_id, source.package_id, source.workflow_template_id,
        next_version, 1, 'draft', source.blueprint, source.definition_hash,
        source.display_name_snapshot, source.description_snapshot,
        source.industry_package_snapshot, p_actor_id, p_reason, p_idempotency_key,
        fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'packageId', source.package_id,
        'versionId', new_id, 'version', next_version, 'revision', 1, 'status', 'draft');
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_run_work_package_dry_run(
    p_actor_id uuid, p_version_id uuid, p_synthetic_sample jsonb,
    p_reason text, p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    source public.work_configuration_package_versions%ROWTYPE;
    package public.work_configuration_packages%ROWTYPE;
    existing public.work_configuration_package_dry_runs%ROWTYPE;
    fingerprint text;
    validation_error text;
    merged_attributes jsonb;
    manifest jsonb;
    result jsonb;
    run_status text;
    run_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', p_version_id::text,
        coalesce(p_synthetic_sample::text, ''), p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.work_configuration_package_dry_runs
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'dryRunId', existing.id,
                'status', existing.status, 'result', existing.result);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO source FROM public.work_configuration_package_versions
     WHERE id = p_version_id AND organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found', 'reason', 'package_version_not_found'); END IF;
    SELECT * INTO package FROM public.work_configuration_packages
     WHERE id = source.package_id AND organization_id = v_organization_id FOR UPDATE;
    IF package.status <> 'active' THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'package_not_active'); END IF;
    IF source.status NOT IN ('draft', 'in_review') OR EXISTS (
        SELECT 1 FROM public.work_configuration_package_versions candidate
         WHERE candidate.package_id = source.package_id
           AND (candidate.version, candidate.revision) > (source.version, source.revision)
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'version_not_current'); END IF;

    IF jsonb_typeof(p_synthetic_sample) <> 'object'
       OR char_length(btrim(coalesce(p_synthetic_sample->>'subjectKey', ''))) NOT BETWEEN 3 AND 80
       OR char_length(btrim(coalesce(p_synthetic_sample->>'displayName', ''))) NOT BETWEEN 2 AND 160
       OR char_length(btrim(coalesce(p_synthetic_sample->>'subjectType', ''))) NOT BETWEEN 2 AND 80
       OR jsonb_typeof(p_synthetic_sample->'attributes') <> 'object'
       OR coalesce((p_synthetic_sample#>>'{attributes,synthetic}')::boolean, false) IS NOT TRUE THEN
        validation_error := 'synthetic_sample_invalid';
    ELSE
        merged_attributes := source.blueprint#>'{subjectDefaults,attributes}'
            || p_synthetic_sample->'attributes'
            || jsonb_build_object('synthetic', true, 'dry_run', true);
        manifest := jsonb_build_object(
            'subject', jsonb_build_object(
                'displayName', btrim(p_synthetic_sample->>'displayName'),
                'subjectType', btrim(p_synthetic_sample->>'subjectType'),
                'status', source.blueprint#>>'{subjectDefaults,status}',
                'primaryContactActorId', NULL,
                'attributes', merged_attributes
            ),
            'workflow', source.blueprint->'workflow',
            'requirements', source.blueprint->'requirements'
        );
        validation_error := public.dop_configuration_manifest_error(v_organization_id, manifest);
    END IF;
    run_status := CASE WHEN validation_error IS NULL THEN 'passed' ELSE 'failed' END;
    result := jsonb_build_object(
        'passed', validation_error IS NULL,
        'validationError', validation_error,
        'definitionHash', source.definition_hash,
        'subjectKey', p_synthetic_sample->>'subjectKey',
        'subjectName', p_synthetic_sample->>'displayName',
        'workflowFrequency', source.blueprint#>>'{workflow,frequency}',
        'requirementCount', jsonb_array_length(source.blueprint->'requirements'),
        'documentTypeCodes', (
            SELECT coalesce(jsonb_agg(item->>'documentTypeCode' ORDER BY item->>'documentTypeCode'), '[]'::jsonb)
              FROM jsonb_array_elements(source.blueprint->'requirements') item
        ),
        'externalDelivery', 'disabled',
        'persistedSubject', false,
        'persistedCase', false
    );
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event',
        'WorkPackage.DryRunCompleted', 1, 'work_package', source.package_id,
        p_correlation_id, p_actor_id, 'ops-work-package', jsonb_build_object(
            'version_id', source.id, 'dry_run_id', run_id, 'status', run_status,
            'definition_hash', source.definition_hash,
            'request_fingerprint', fingerprint, 'external_delivery', 'disabled'), p_now);
    INSERT INTO public.work_configuration_package_dry_runs (
        id, organization_id, package_id, package_version_id, definition_hash,
        synthetic_sample, result, status, run_by_actor_id, reason,
        idempotency_key, request_fingerprint, event_id, created_at
    ) VALUES (run_id, v_organization_id, source.package_id, source.id,
        source.definition_hash, p_synthetic_sample, result, run_status, p_actor_id,
        p_reason, p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'dryRunId', run_id,
        'status', run_status, 'result', result);
EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'synthetic_sample_invalid');
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_transition_work_package_version(
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
    source public.work_configuration_package_versions%ROWTYPE;
    package public.work_configuration_packages%ROWTYPE;
    existing public.work_configuration_package_versions%ROWTYPE;
    target_status text;
    event_type text;
    fingerprint text;
    new_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF p_action NOT IN ('submit_review', 'return_to_draft', 'publish')
       OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', p_version_id::text, p_action, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.work_configuration_package_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'versionId', existing.id,
                'version', existing.version, 'revision', existing.revision, 'status', existing.status);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO source FROM public.work_configuration_package_versions
     WHERE id = p_version_id AND organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found', 'reason', 'package_version_not_found'); END IF;
    SELECT * INTO package FROM public.work_configuration_packages
     WHERE id = source.package_id AND organization_id = v_organization_id FOR UPDATE;
    IF package.status <> 'active' THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'package_not_active'); END IF;
    IF EXISTS (
        SELECT 1 FROM public.work_configuration_package_versions candidate
         WHERE candidate.package_id = source.package_id
           AND (candidate.version, candidate.revision) > (source.version, source.revision)
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'version_not_current'); END IF;
    IF p_action = 'submit_review' AND source.status = 'draft' THEN
        target_status := 'in_review'; event_type := 'WorkPackage.SubmittedForReview';
    ELSIF p_action = 'return_to_draft' AND source.status = 'in_review' THEN
        target_status := 'draft'; event_type := 'WorkPackage.ReturnedToDraft';
    ELSIF p_action = 'publish' AND source.status = 'in_review' THEN
        target_status := 'published'; event_type := 'WorkPackage.Published';
    ELSE
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_transition');
    END IF;
    IF p_action IN ('submit_review', 'publish') AND NOT EXISTS (
        SELECT 1 FROM public.work_configuration_package_dry_runs dry_run
         WHERE dry_run.package_id = source.package_id
           AND dry_run.definition_hash = source.definition_hash
           AND dry_run.status = 'passed'
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'passing_dry_run_required'); END IF;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', event_type, 1,
        'work_package', source.package_id, p_correlation_id, p_actor_id,
        'ops-work-package', jsonb_build_object(
            'source_version_id', source.id, 'version_id', new_id,
            'version', source.version, 'revision', source.revision + 1,
            'status', target_status, 'definition_hash', source.definition_hash,
            'request_fingerprint', fingerprint, 'external_delivery', 'disabled'), p_now);
    INSERT INTO public.work_configuration_package_versions (
        id, organization_id, package_id, workflow_template_id, version, revision,
        status, blueprint, definition_hash, display_name_snapshot,
        description_snapshot, industry_package_snapshot, created_by_actor_id,
        reason, published_at, idempotency_key, request_fingerprint, event_id, created_at
    ) VALUES (new_id, v_organization_id, source.package_id, source.workflow_template_id,
        source.version, source.revision + 1, target_status, source.blueprint,
        source.definition_hash, source.display_name_snapshot, source.description_snapshot,
        source.industry_package_snapshot, p_actor_id, p_reason,
        CASE WHEN target_status = 'published' THEN p_now ELSE NULL END,
        p_idempotency_key, fingerprint, event_id, p_now);
    IF target_status = 'published' THEN
        UPDATE public.work_configuration_packages
           SET current_published_version_id = new_id,
               display_name = source.display_name_snapshot,
               description = source.description_snapshot,
               industry_package = source.industry_package_snapshot,
               updated_at = p_now
         WHERE id = source.package_id;
    END IF;
    RETURN jsonb_build_object('outcome', 'completed', 'packageId', source.package_id,
        'versionId', new_id, 'version', source.version,
        'revision', source.revision + 1, 'status', target_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_retire_work_package(
    p_actor_id uuid, p_package_id uuid, p_reason text,
    p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    package public.work_configuration_packages%ROWTYPE;
    source public.work_configuration_package_versions%ROWTYPE;
    existing public.work_configuration_package_versions%ROWTYPE;
    fingerprint text;
    new_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', p_package_id::text, 'retire', p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.work_configuration_package_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'packageId', existing.package_id,
                'versionId', existing.id, 'status', 'retired');
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO package FROM public.work_configuration_packages
     WHERE id = p_package_id AND organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found', 'reason', 'package_not_found'); END IF;
    IF package.status <> 'active' OR package.current_published_version_id IS NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'package_not_active');
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.work_configuration_package_versions candidate
         WHERE candidate.package_id = package.id AND candidate.status IN ('draft', 'in_review')
           AND NOT EXISTS (
               SELECT 1 FROM public.work_configuration_package_versions later
                WHERE later.package_id = candidate.package_id
                  AND (later.version, later.revision) > (candidate.version, candidate.revision)
           )
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'open_draft_exists'); END IF;
    SELECT * INTO source FROM public.work_configuration_package_versions
     WHERE id = package.current_published_version_id FOR UPDATE;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event',
        'WorkPackage.Retired', 1, 'work_package', package.id, p_correlation_id,
        p_actor_id, 'ops-work-package', jsonb_build_object(
            'source_version_id', source.id, 'version_id', new_id,
            'version', source.version, 'revision', source.revision + 1,
            'definition_hash', source.definition_hash,
            'request_fingerprint', fingerprint, 'external_delivery', 'disabled'), p_now);
    INSERT INTO public.work_configuration_package_versions (
        id, organization_id, package_id, workflow_template_id, version, revision,
        status, blueprint, definition_hash, display_name_snapshot,
        description_snapshot, industry_package_snapshot, created_by_actor_id,
        reason, idempotency_key, request_fingerprint, event_id, created_at
    ) VALUES (new_id, v_organization_id, source.package_id, source.workflow_template_id,
        source.version, source.revision + 1, 'retired', source.blueprint,
        source.definition_hash, source.display_name_snapshot, source.description_snapshot,
        source.industry_package_snapshot, p_actor_id, p_reason, p_idempotency_key,
        fingerprint, event_id, p_now);
    UPDATE public.work_configuration_packages
       SET status = 'retired', updated_at = p_now WHERE id = package.id;
    RETURN jsonb_build_object('outcome', 'completed', 'packageId', package.id,
        'versionId', new_id, 'version', source.version,
        'revision', source.revision + 1, 'status', 'retired');
END;
$$;

-- Preserve the M15 implementation while adding the M17 current-published
-- pointer as an additional fail-closed onboarding gate.
ALTER FUNCTION public.dop_onboard_subject_from_package(
    uuid, uuid, text, text, text, uuid, jsonb, text, text, uuid, timestamptz
) RENAME TO dop_onboard_subject_from_package_m15;

CREATE OR REPLACE FUNCTION public.dop_onboard_subject_from_package(
    p_actor_id uuid, p_package_version_id uuid, p_subject_key text,
    p_display_name text, p_subject_type text, p_primary_contact_actor_id uuid,
    p_attributes jsonb, p_reason text, p_idempotency_key text,
    p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
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
        SELECT 1 FROM public.work_configuration_packages package
         WHERE package.organization_id = v_organization_id
           AND package.status = 'active'
           AND package.current_published_version_id = p_package_version_id
    ) THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'package_version_not_current');
    END IF;
    RETURN public.dop_onboard_subject_from_package_m15(
        p_actor_id, p_package_version_id, p_subject_key, p_display_name,
        p_subject_type, p_primary_contact_actor_id, p_attributes, p_reason,
        p_idempotency_key, p_correlation_id, p_now
    );
END;
$$;

REVOKE ALL ON FUNCTION public.dop_work_package_blueprint_error(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_work_package(uuid,text,text,text,text,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_update_work_package_draft(uuid,uuid,text,text,text,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_clone_work_package_version(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_run_work_package_dry_run(uuid,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_transition_work_package_version(uuid,uuid,text,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_retire_work_package(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_onboard_subject_from_package_m15(uuid,uuid,text,text,text,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_onboard_subject_from_package(uuid,uuid,text,text,text,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.dop_create_work_package(uuid,text,text,text,text,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_update_work_package_draft(uuid,uuid,text,text,text,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_clone_work_package_version(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_run_work_package_dry_run(uuid,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_transition_work_package_version(uuid,uuid,text,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_retire_work_package(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_onboard_subject_from_package(uuid,uuid,text,text,text,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
