BEGIN;

-- Configuration is revisioned as an append-only release stream. A published
-- row is never edited in place: subsequent changes and rollbacks create a new
-- release series, while existing Cases retain their pinned version references.
CREATE TABLE work_configuration_releases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    series_id uuid NOT NULL,
    release_number integer NOT NULL CHECK (release_number > 0),
    revision integer NOT NULL CHECK (revision > 0),
    subject_id uuid NOT NULL REFERENCES subjects(id),
    workflow_template_id uuid NOT NULL REFERENCES workflow_templates(id),
    requirement_set_id uuid NOT NULL REFERENCES requirement_sets(id),
    status text NOT NULL CHECK (status IN ('draft', 'in_review', 'published')),
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    base_release_id uuid REFERENCES work_configuration_releases(id),
    produced_workflow_template_version_id uuid REFERENCES workflow_template_versions(id),
    produced_requirement_set_version_id uuid REFERENCES requirement_set_versions(id),
    created_by_actor_id uuid REFERENCES actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid REFERENCES workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    UNIQUE (organization_id, series_id, revision),
    UNIQUE (organization_id, subject_id, release_number, revision),
    CHECK (
        (status = 'published' AND produced_workflow_template_version_id IS NOT NULL AND produced_requirement_set_version_id IS NOT NULL)
        OR status <> 'published'
    )
);

ALTER TABLE work_configuration_releases
    ADD CONSTRAINT work_config_subject_same_org_fk
        FOREIGN KEY (organization_id, subject_id) REFERENCES subjects (organization_id, id),
    ADD CONSTRAINT work_config_template_same_org_fk
        FOREIGN KEY (organization_id, workflow_template_id) REFERENCES workflow_templates (organization_id, id),
    ADD CONSTRAINT work_config_set_same_org_fk
        FOREIGN KEY (organization_id, requirement_set_id) REFERENCES requirement_sets (organization_id, id),
    ADD CONSTRAINT work_config_base_same_org_fk
        FOREIGN KEY (organization_id, base_release_id) REFERENCES work_configuration_releases (organization_id, id),
    ADD CONSTRAINT work_config_workflow_version_same_org_fk
        FOREIGN KEY (organization_id, produced_workflow_template_version_id) REFERENCES workflow_template_versions (organization_id, id),
    ADD CONSTRAINT work_config_requirement_version_same_org_fk
        FOREIGN KEY (organization_id, produced_requirement_set_version_id) REFERENCES requirement_set_versions (organization_id, id),
    ADD CONSTRAINT work_config_actor_same_org_fk
        FOREIGN KEY (organization_id, created_by_actor_id) REFERENCES actors (organization_id, id),
    ADD CONSTRAINT work_config_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES workflow_events (organization_id, id);

CREATE INDEX work_configuration_releases_subject_idx
    ON work_configuration_releases (organization_id, subject_id, release_number DESC, revision DESC);
CREATE INDEX work_configuration_releases_series_idx
    ON work_configuration_releases (organization_id, series_id, revision DESC);

ALTER TABLE work_configuration_releases ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE work_configuration_releases TO dop_app;
CREATE POLICY dop_tenant_isolation ON work_configuration_releases
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_configuration_manifest_error(
    p_organization_id uuid, p_manifest jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    requirement jsonb;
    minimum_count numeric;
    maximum_count numeric;
BEGIN
    IF jsonb_typeof(p_manifest) <> 'object'
       OR jsonb_typeof(p_manifest->'subject') <> 'object'
       OR jsonb_typeof(p_manifest->'workflow') <> 'object'
       OR jsonb_typeof(p_manifest->'requirements') <> 'array' THEN
        RETURN 'manifest_shape_invalid';
    END IF;
    IF char_length(btrim(coalesce(p_manifest#>>'{subject,displayName}', ''))) NOT BETWEEN 2 AND 160
       OR char_length(btrim(coalesce(p_manifest#>>'{subject,subjectType}', ''))) NOT BETWEEN 2 AND 80
       OR coalesce(p_manifest#>>'{subject,status}', '') NOT IN ('active', 'paused', 'offboarding', 'closed')
       OR jsonb_typeof(p_manifest#>'{subject,attributes}') <> 'object' THEN
        RETURN 'subject_invalid';
    END IF;
    IF jsonb_array_length(p_manifest->'requirements') < 1 OR jsonb_array_length(p_manifest->'requirements') > 100 THEN
        RETURN 'requirements_count_invalid';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_manifest->'requirements') item
        GROUP BY lower(btrim(item->>'code')) HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_manifest->'requirements') item
        GROUP BY lower(btrim(item->>'documentTypeCode')) HAVING count(*) > 1
    ) THEN
        RETURN 'requirements_duplicate';
    END IF;
    FOR requirement IN SELECT value FROM jsonb_array_elements(p_manifest->'requirements') LOOP
        IF jsonb_typeof(requirement) <> 'object'
           OR char_length(btrim(coalesce(requirement->>'code', ''))) NOT BETWEEN 2 AND 120
           OR char_length(btrim(coalesce(requirement->>'documentTypeCode', ''))) NOT BETWEEN 2 AND 120
           OR jsonb_typeof(requirement->'minimumCount') <> 'number'
           OR (requirement ? 'maximumCount' AND requirement->'maximumCount' <> 'null'::jsonb AND jsonb_typeof(requirement->'maximumCount') <> 'number')
           OR jsonb_typeof(coalesce(requirement->'acceptanceRule', '{}'::jsonb)) <> 'object' THEN
            RETURN 'requirement_invalid';
        END IF;
        minimum_count := (requirement->>'minimumCount')::numeric;
        maximum_count := CASE WHEN requirement->'maximumCount' IS NULL OR requirement->'maximumCount' = 'null'::jsonb
                              THEN NULL ELSE (requirement->>'maximumCount')::numeric END;
        IF minimum_count < 0 OR minimum_count <> trunc(minimum_count)
           OR (maximum_count IS NOT NULL AND (maximum_count < minimum_count OR maximum_count <> trunc(maximum_count))) THEN
            RETURN 'requirement_count_invalid';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.document_types
             WHERE organization_id = p_organization_id AND status = 'active'
               AND code = requirement->>'documentTypeCode'
        ) THEN
            RETURN 'document_type_not_found';
        END IF;
    END LOOP;
    IF nullif(p_manifest#>>'{subject,primaryContactActorId}', '') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.actors
         WHERE organization_id = p_organization_id
           AND id = (p_manifest#>>'{subject,primaryContactActorId}')::uuid
           AND actor_type = 'customer' AND status = 'active'
    ) THEN
        RETURN 'primary_contact_invalid';
    END IF;
    RETURN NULL;
EXCEPTION WHEN invalid_text_representation THEN
    RETURN 'primary_contact_invalid';
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_clone_configuration_release(
    p_actor_id uuid, p_source_release_id uuid, p_reason text,
    p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    source_release public.work_configuration_releases%ROWTYPE;
    existing public.work_configuration_releases%ROWTYPE;
    release_id uuid := gen_random_uuid();
    series_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    next_release integer;
    fingerprint text;
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', 'clone', p_source_release_id::text, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.work_configuration_releases
     WHERE work_configuration_releases.organization_id = v_organization_id
       AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'releaseId', existing.id);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO source_release FROM public.work_configuration_releases
     WHERE id = p_source_release_id AND work_configuration_releases.organization_id = v_organization_id
       AND status = 'published';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    PERFORM 1 FROM public.subjects WHERE id = source_release.subject_id AND subjects.organization_id = v_organization_id FOR UPDATE;
    SELECT coalesce(max(release_number), 0) + 1 INTO next_release
      FROM public.work_configuration_releases
     WHERE work_configuration_releases.organization_id = v_organization_id
       AND subject_id = source_release.subject_id;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', 'Configuration.DraftCreated', 1,
        'work_configuration', release_id, p_correlation_id, p_actor_id, 'ops-configuration',
        jsonb_build_object('subject_id', source_release.subject_id, 'release_number', next_release,
            'base_release_id', source_release.id, 'intent', 'controlled_change_or_rollback'), p_now);
    INSERT INTO public.work_configuration_releases (
        id, organization_id, series_id, release_number, revision, subject_id,
        workflow_template_id, requirement_set_id, status, manifest, definition_hash,
        base_release_id, created_by_actor_id, reason, idempotency_key,
        request_fingerprint, event_id, created_at
    ) VALUES (release_id, v_organization_id, series_id, next_release, 1, source_release.subject_id,
        source_release.workflow_template_id, source_release.requirement_set_id, 'draft', source_release.manifest,
        source_release.definition_hash, source_release.id, p_actor_id, p_reason,
        p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'releaseId', release_id,
        'seriesId', series_id, 'releaseNumber', next_release, 'revision', 1, 'status', 'draft', 'eventId', event_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_update_configuration_draft(
    p_actor_id uuid, p_release_id uuid, p_manifest jsonb, p_reason text,
    p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    current_release public.work_configuration_releases%ROWTYPE;
    existing public.work_configuration_releases%ROWTYPE;
    validation_error text;
    release_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    definition_hash text;
    fingerprint text;
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    validation_error := public.dop_configuration_manifest_error(v_organization_id, p_manifest);
    IF validation_error IS NOT NULL THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', validation_error);
    END IF;
    definition_hash := encode(digest(p_manifest::text, 'sha256'), 'hex');
    fingerprint := encode(digest(concat_ws('|', 'update', p_release_id::text, definition_hash, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.work_configuration_releases
     WHERE work_configuration_releases.organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN RETURN jsonb_build_object('outcome', 'duplicate', 'releaseId', existing.id); END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO current_release FROM public.work_configuration_releases
     WHERE id = p_release_id AND work_configuration_releases.organization_id = v_organization_id FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    IF current_release.status <> 'draft' OR EXISTS (
        SELECT 1 FROM public.work_configuration_releases newer
         WHERE newer.organization_id = v_organization_id AND newer.series_id = current_release.series_id
           AND newer.revision > current_release.revision
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'release_not_current_draft'); END IF;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', 'Configuration.DraftUpdated', 1,
        'work_configuration', release_id, p_correlation_id, p_actor_id, 'ops-configuration',
        jsonb_build_object('series_id', current_release.series_id, 'release_number', current_release.release_number,
            'previous_hash', current_release.definition_hash, 'definition_hash', definition_hash, 'reason', p_reason), p_now);
    INSERT INTO public.work_configuration_releases (
        id, organization_id, series_id, release_number, revision, subject_id,
        workflow_template_id, requirement_set_id, status, manifest, definition_hash,
        base_release_id, created_by_actor_id, reason, idempotency_key,
        request_fingerprint, event_id, created_at
    ) VALUES (release_id, v_organization_id, current_release.series_id, current_release.release_number,
        current_release.revision + 1, current_release.subject_id, current_release.workflow_template_id,
        current_release.requirement_set_id, 'draft', p_manifest, definition_hash,
        current_release.base_release_id, p_actor_id, p_reason, p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'releaseId', release_id,
        'seriesId', current_release.series_id, 'releaseNumber', current_release.release_number,
        'revision', current_release.revision + 1, 'status', 'draft', 'eventId', event_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_transition_configuration_release(
    p_actor_id uuid, p_release_id uuid, p_action text, p_reason text,
    p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    current_release public.work_configuration_releases%ROWTYPE;
    existing public.work_configuration_releases%ROWTYPE;
    validation_error text;
    release_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    next_status text;
    event_type text;
    fingerprint text;
    workflow_hash text;
    requirement_hash text;
    workflow_version_id uuid;
    requirement_version_id uuid;
    next_workflow_version integer;
    next_requirement_version integer;
    requirement jsonb;
BEGIN
    IF p_action NOT IN ('submit_review', 'return_to_draft', 'publish')
       OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', p_action, p_release_id::text, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.work_configuration_releases
     WHERE work_configuration_releases.organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN RETURN jsonb_build_object('outcome', 'duplicate', 'releaseId', existing.id); END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO current_release FROM public.work_configuration_releases
     WHERE id = p_release_id AND work_configuration_releases.organization_id = v_organization_id FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    IF EXISTS (
        SELECT 1 FROM public.work_configuration_releases newer
         WHERE newer.organization_id = v_organization_id AND newer.series_id = current_release.series_id
           AND newer.revision > current_release.revision
    ) THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'release_not_current'); END IF;
    IF (p_action = 'submit_review' AND current_release.status <> 'draft')
       OR (p_action IN ('return_to_draft', 'publish') AND current_release.status <> 'in_review') THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'transition_not_allowed');
    END IF;
    validation_error := public.dop_configuration_manifest_error(v_organization_id, current_release.manifest);
    IF validation_error IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', validation_error); END IF;

    next_status := CASE p_action WHEN 'submit_review' THEN 'in_review' WHEN 'return_to_draft' THEN 'draft' ELSE 'published' END;
    event_type := CASE p_action WHEN 'submit_review' THEN 'Configuration.ReviewRequested'
                              WHEN 'return_to_draft' THEN 'Configuration.ReviewReturned'
                              ELSE 'Configuration.Published' END;

    IF p_action = 'publish' THEN
        PERFORM 1 FROM public.subjects WHERE id = current_release.subject_id AND subjects.organization_id = v_organization_id FOR UPDATE;
        PERFORM 1 FROM public.workflow_templates WHERE id = current_release.workflow_template_id AND workflow_templates.organization_id = v_organization_id FOR UPDATE;
        PERFORM 1 FROM public.requirement_sets WHERE id = current_release.requirement_set_id AND requirement_sets.organization_id = v_organization_id FOR UPDATE;

        workflow_hash := encode(digest((current_release.manifest->'workflow')::text, 'sha256'), 'hex');
        SELECT id INTO workflow_version_id FROM public.workflow_template_versions
         WHERE workflow_template_versions.organization_id = v_organization_id AND workflow_template_id = current_release.workflow_template_id
           AND definition_hash = workflow_hash;
        IF workflow_version_id IS NULL THEN
            SELECT coalesce(max(version), 0) + 1 INTO next_workflow_version
              FROM public.workflow_template_versions WHERE workflow_template_versions.organization_id = v_organization_id
               AND workflow_template_id = current_release.workflow_template_id;
            workflow_version_id := gen_random_uuid();
            INSERT INTO public.workflow_template_versions (
                id, organization_id, workflow_template_id, version, status, definition,
                definition_hash, published_at, created_at
            ) VALUES (workflow_version_id, v_organization_id, current_release.workflow_template_id,
                next_workflow_version, 'published', current_release.manifest->'workflow', workflow_hash, p_now, p_now);
        END IF;

        requirement_hash := encode(digest((current_release.manifest->'requirements')::text, 'sha256'), 'hex');
        SELECT id INTO requirement_version_id FROM public.requirement_set_versions
         WHERE requirement_set_versions.organization_id = v_organization_id AND requirement_set_id = current_release.requirement_set_id
           AND definition_hash = requirement_hash;
        IF requirement_version_id IS NULL THEN
            SELECT coalesce(max(version), 0) + 1 INTO next_requirement_version
              FROM public.requirement_set_versions WHERE requirement_set_versions.organization_id = v_organization_id
               AND requirement_set_id = current_release.requirement_set_id;
            requirement_version_id := gen_random_uuid();
            INSERT INTO public.requirement_set_versions (
                id, organization_id, requirement_set_id, version, status, effective_from,
                definition_hash, created_at
            ) VALUES (requirement_version_id, v_organization_id, current_release.requirement_set_id,
                next_requirement_version, 'published', p_now, requirement_hash, p_now);
            FOR requirement IN SELECT value FROM jsonb_array_elements(current_release.manifest->'requirements') LOOP
                INSERT INTO public.requirements (
                    id, organization_id, requirement_set_version_id, requirement_code,
                    document_type_id, minimum_count, maximum_count, acceptance_rule, created_at
                ) SELECT gen_random_uuid(), v_organization_id, requirement_version_id,
                    btrim(requirement->>'code'), document_type.id,
                    (requirement->>'minimumCount')::integer,
                    CASE WHEN requirement->'maximumCount' IS NULL OR requirement->'maximumCount' = 'null'::jsonb
                         THEN NULL ELSE (requirement->>'maximumCount')::integer END,
                    coalesce(requirement->'acceptanceRule', '{}'::jsonb), p_now
                  FROM public.document_types document_type
                 WHERE document_type.organization_id = v_organization_id
                   AND document_type.code = requirement->>'documentTypeCode';
            END LOOP;
        END IF;

        UPDATE public.subjects SET
            display_name = btrim(current_release.manifest#>>'{subject,displayName}'),
            subject_type = btrim(current_release.manifest#>>'{subject,subjectType}'),
            status = current_release.manifest#>>'{subject,status}',
            primary_contact_actor_id = nullif(current_release.manifest#>>'{subject,primaryContactActorId}', '')::uuid,
            attributes = current_release.manifest#>'{subject,attributes}',
            updated_at = p_now
         WHERE id = current_release.subject_id;
    END IF;

    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', event_type, 1,
        'work_configuration', release_id, p_correlation_id, p_actor_id, 'ops-configuration',
        jsonb_build_object('series_id', current_release.series_id, 'release_number', current_release.release_number,
            'revision', current_release.revision + 1, 'status', next_status, 'reason', p_reason,
            'definition_hash', current_release.definition_hash), p_now);
    INSERT INTO public.work_configuration_releases (
        id, organization_id, series_id, release_number, revision, subject_id,
        workflow_template_id, requirement_set_id, status, manifest, definition_hash,
        base_release_id, produced_workflow_template_version_id, produced_requirement_set_version_id,
        created_by_actor_id, reason, idempotency_key, request_fingerprint, event_id, created_at
    ) VALUES (release_id, v_organization_id, current_release.series_id, current_release.release_number,
        current_release.revision + 1, current_release.subject_id, current_release.workflow_template_id,
        current_release.requirement_set_id, next_status, current_release.manifest, current_release.definition_hash,
        current_release.base_release_id,
        CASE WHEN p_action = 'publish' THEN workflow_version_id ELSE NULL END,
        CASE WHEN p_action = 'publish' THEN requirement_version_id ELSE NULL END,
        p_actor_id, p_reason, p_idempotency_key, fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'releaseId', release_id,
        'seriesId', current_release.series_id, 'releaseNumber', current_release.release_number,
        'revision', current_release.revision + 1, 'status', next_status, 'eventId', event_id,
        'workflowTemplateVersionId', workflow_version_id, 'requirementSetVersionId', requirement_version_id);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_configuration_manifest_error(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_clone_configuration_release(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_update_configuration_draft(uuid,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_transition_configuration_release(uuid,uuid,text,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_clone_configuration_release(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_update_configuration_draft(uuid,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_transition_configuration_release(uuid,uuid,text,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
