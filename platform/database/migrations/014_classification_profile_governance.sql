BEGIN;

-- M18 makes the classification language a governed, append-only product
-- surface. The existing document_types table remains the stable runtime
-- catalogue, but only a published profile may update it.
ALTER TABLE public.document_types
    ADD COLUMN description text NOT NULL DEFAULT '';

UPDATE public.document_types
   SET description = '用于识别和提取“' || display_name || '”类资料的标准分类定义。'
 WHERE btrim(description) = '';

CREATE TABLE public.classification_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    profile_key text NOT NULL CHECK (profile_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 160),
    description text NOT NULL CHECK (char_length(description) BETWEEN 12 AND 1000),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    current_published_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, profile_key)
);

CREATE UNIQUE INDEX one_active_classification_profile_per_org
    ON public.classification_profiles (organization_id)
    WHERE status = 'active';

CREATE TABLE public.classification_profile_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    profile_id uuid NOT NULL REFERENCES public.classification_profiles(id),
    version integer NOT NULL CHECK (version > 0),
    revision integer NOT NULL CHECK (revision > 0),
    status text NOT NULL CHECK (status IN ('draft', 'in_review', 'published', 'retired')),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    created_by_actor_id uuid REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text,
    request_fingerprint text CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid,
    created_at timestamptz NOT NULL,
    published_at timestamptz,
    UNIQUE (organization_id, id),
    UNIQUE (profile_id, version, revision),
    CONSTRAINT classification_profile_version_profile_same_org_fk
        FOREIGN KEY (organization_id, profile_id)
        REFERENCES public.classification_profiles(organization_id, id),
    CONSTRAINT classification_profile_version_actor_same_org_fk
        FOREIGN KEY (organization_id, created_by_actor_id)
        REFERENCES public.actors(organization_id, id),
    CONSTRAINT classification_profile_version_event_same_org_fk
        FOREIGN KEY (organization_id, event_id)
        REFERENCES public.workflow_events(organization_id, id)
);

CREATE UNIQUE INDEX classification_profile_version_idempotency_key
    ON public.classification_profile_versions (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX classification_profile_versions_history_idx
    ON public.classification_profile_versions
       (organization_id, profile_id, version DESC, revision DESC);

CREATE TABLE public.classification_profile_evaluation_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    profile_id uuid NOT NULL REFERENCES public.classification_profiles(id),
    profile_version_id uuid NOT NULL REFERENCES public.classification_profile_versions(id),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
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
    CONSTRAINT classification_profile_evaluation_profile_same_org_fk
        FOREIGN KEY (organization_id, profile_id)
        REFERENCES public.classification_profiles(organization_id, id),
    CONSTRAINT classification_profile_evaluation_version_same_org_fk
        FOREIGN KEY (organization_id, profile_version_id)
        REFERENCES public.classification_profile_versions(organization_id, id),
    CONSTRAINT classification_profile_evaluation_actor_same_org_fk
        FOREIGN KEY (organization_id, run_by_actor_id)
        REFERENCES public.actors(organization_id, id),
    CONSTRAINT classification_profile_evaluation_event_same_org_fk
        FOREIGN KEY (organization_id, event_id)
        REFERENCES public.workflow_events(organization_id, id)
);

CREATE INDEX classification_profile_evaluations_history_idx
    ON public.classification_profile_evaluation_runs
       (organization_id, profile_id, created_at DESC);

ALTER TABLE public.classification_attempts
    ADD COLUMN classification_profile_version_id uuid,
    ADD COLUMN classification_profile_definition_hash text
        CHECK (classification_profile_definition_hash IS NULL OR classification_profile_definition_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE public.classification_attempts
    ADD CONSTRAINT classification_attempt_profile_version_same_org_fk
        FOREIGN KEY (organization_id, classification_profile_version_id)
        REFERENCES public.classification_profile_versions(organization_id, id);

ALTER TABLE public.classification_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classification_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classification_profile_evaluation_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.classification_profiles TO dop_app;
GRANT SELECT ON TABLE public.classification_profile_versions TO dop_app;
GRANT SELECT ON TABLE public.classification_profile_evaluation_runs TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.classification_profiles
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.classification_profile_versions
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.classification_profile_evaluation_runs
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_classification_profile_definition_error(
    p_organization_id uuid, p_definition jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    label_item jsonb;
    field_item jsonb;
    case_item jsonb;
    text_item jsonb;
    accepted_coverage boolean := false;
    review_coverage boolean := false;
    unknown_coverage boolean := false;
BEGIN
    IF jsonb_typeof(p_definition) <> 'object'
       OR p_definition->>'schemaVersion' <> '1.0'
       OR p_definition->>'environment' <> 'DEV'
       OR p_definition->>'unknownDocumentRoute' <> 'review_required'
       OR p_definition->>'ambiguityRoute' <> 'review_required'
       OR jsonb_typeof(p_definition->'labels') <> 'array'
       OR jsonb_array_length(p_definition->'labels') NOT BETWEEN 1 AND 100
       OR jsonb_typeof(p_definition->'evaluationCases') <> 'array'
       OR jsonb_array_length(p_definition->'evaluationCases') NOT BETWEEN 3 AND 200 THEN
        RETURN 'classification_profile_definition_invalid';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_definition->'labels') item
         GROUP BY item->>'code' HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_definition->'evaluationCases') item
         GROUP BY item->>'caseKey' HAVING count(*) > 1
    ) THEN RETURN 'classification_profile_duplicate_key'; END IF;

    FOR label_item IN SELECT value FROM jsonb_array_elements(p_definition->'labels') LOOP
        IF jsonb_typeof(label_item) <> 'object'
           OR coalesce(label_item->>'code', '') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
           OR char_length(btrim(coalesce(label_item->>'displayName', ''))) NOT BETWEEN 2 AND 160
           OR char_length(btrim(coalesce(label_item->>'description', ''))) NOT BETWEEN 12 AND 1000
           OR jsonb_typeof(label_item->'allowedMimeTypes') <> 'array'
           OR jsonb_array_length(label_item->'allowedMimeTypes') NOT BETWEEN 1 AND 20
           OR jsonb_typeof(label_item->'extractionFields') <> 'array'
           OR jsonb_array_length(label_item->'extractionFields') > 50
           OR jsonb_typeof(label_item->'policy') <> 'object'
           OR (label_item#>>'{policy,minimumConfidence}')::numeric NOT BETWEEN 0 AND 1
           OR jsonb_typeof(label_item#>'{policy,alwaysHumanConfirm}') <> 'boolean'
           OR jsonb_typeof(label_item#>'{policy,manualOnConflict}') <> 'boolean'
           OR jsonb_typeof(label_item#>'{policy,rejectOnQualityFlags}') <> 'array'
           OR jsonb_typeof(label_item#>'{policy,rejectOnConflictFlags}') <> 'array' THEN
            RETURN 'classification_label_invalid';
        END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(label_item->'allowedMimeTypes') item
             WHERE jsonb_typeof(item) <> 'string'
                OR trim(both '"' from item::text) !~ '^[a-z0-9.+-]+/[a-z0-9.+*-]+$'
        ) THEN RETURN 'classification_label_mime_invalid'; END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(label_item->'extractionFields') item
             GROUP BY item->>'key' HAVING count(*) > 1
        ) THEN RETURN 'classification_extraction_field_duplicate'; END IF;
        FOR field_item IN SELECT value FROM jsonb_array_elements(label_item->'extractionFields') LOOP
            IF coalesce(field_item->>'key', '') !~ '^[a-z][a-z0-9_]{1,79}$'
               OR char_length(btrim(coalesce(field_item->>'displayName', ''))) NOT BETWEEN 2 AND 160
               OR field_item->>'valueType' NOT IN ('string', 'number', 'date', 'boolean')
               OR jsonb_typeof(field_item->'required') <> 'boolean' THEN
                RETURN 'classification_extraction_field_invalid';
            END IF;
        END LOOP;
        FOR text_item IN
            SELECT value FROM jsonb_array_elements(label_item#>'{policy,rejectOnQualityFlags}')
        LOOP
            IF trim(both '"' from text_item::text) NOT IN
               ('blurry','blank','corrupt','partial','password_protected','unsupported','mime_mismatch','other') THEN
                RETURN 'classification_quality_flag_invalid';
            END IF;
        END LOOP;
        FOR text_item IN
            SELECT value FROM jsonb_array_elements(label_item#>'{policy,rejectOnConflictFlags}')
        LOOP
            IF trim(both '"' from text_item::text) NOT IN
               ('subject_conflict','period_conflict','document_type_conflict','duplicate_suspected','other') THEN
                RETURN 'classification_conflict_flag_invalid';
            END IF;
        END LOOP;
    END LOOP;

    -- M18 is additive: a published label already used by Cases or Work
    -- Packages cannot silently disappear from a later profile.
    IF EXISTS (
        SELECT 1 FROM public.document_types document_type
         WHERE document_type.organization_id = p_organization_id
           AND document_type.status = 'active'
           AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(p_definition->'labels') item
                WHERE item->>'code' = document_type.code
           )
    ) THEN RETURN 'active_document_type_missing'; END IF;

    FOR case_item IN SELECT value FROM jsonb_array_elements(p_definition->'evaluationCases') LOOP
        IF coalesce(case_item->>'caseKey', '') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
           OR char_length(btrim(coalesce(case_item->>'displayName', ''))) NOT BETWEEN 2 AND 160
           OR coalesce((case_item->>'synthetic')::boolean, false) IS NOT TRUE
           OR char_length(btrim(coalesce(case_item->>'filename', ''))) NOT BETWEEN 3 AND 255
           OR coalesce(case_item->>'mimeType', '') !~ '^[a-z0-9.+-]+/[a-z0-9.+*-]+$'
           OR (case_item->>'confidence')::numeric NOT BETWEEN 0 AND 1
           OR jsonb_typeof(case_item->'ambiguousLabelCodes') <> 'array'
           OR jsonb_typeof(case_item->'qualityFlags') <> 'array'
           OR jsonb_typeof(case_item->'conflictFlags') <> 'array'
           OR case_item->>'expectedRoute' NOT IN ('accepted', 'review_required') THEN
            RETURN 'classification_evaluation_case_invalid';
        END IF;
        accepted_coverage := accepted_coverage OR case_item->>'expectedRoute' = 'accepted';
        review_coverage := review_coverage OR case_item->>'expectedRoute' = 'review_required';
        unknown_coverage := unknown_coverage OR (
            jsonb_array_length(case_item->'ambiguousLabelCodes') > 0 OR NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(p_definition->'labels') item
                 WHERE item->>'code' = case_item->>'predictedLabelCode'
            )
        );
    END LOOP;
    IF NOT accepted_coverage OR NOT review_coverage OR NOT unknown_coverage THEN
        RETURN 'classification_evaluation_coverage_missing';
    END IF;
    RETURN NULL;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN 'classification_profile_definition_invalid';
END;
$$;

-- Backfill one published profile per organization from the current runtime
-- catalogue. This creates no Subjects, Cases, Documents or attempts.
DO $$
DECLARE
    org record;
    profile_id uuid;
    version_id uuid;
    definition jsonb;
    labels jsonb;
    first_code text;
    definition_hash text;
BEGIN
    FOR org IN
        SELECT DISTINCT organization_id FROM public.document_types WHERE status = 'active'
    LOOP
        profile_id := gen_random_uuid();
        version_id := gen_random_uuid();
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'code', document_type.code,
                   'displayName', document_type.display_name,
                   'description', document_type.description,
                   'allowedMimeTypes', to_jsonb(document_type.allowed_mime_types),
                   'extractionFields', coalesce((
                       SELECT jsonb_agg(jsonb_build_object(
                           'key', property.key,
                           'displayName', initcap(replace(property.key, '_', ' ')),
                           'valueType', CASE
                               WHEN property.value->>'format' = 'date' THEN 'date'
                               WHEN property.value->>'type' IN ('number','integer') THEN 'number'
                               WHEN property.value->>'type' = 'boolean' THEN 'boolean'
                               ELSE 'string' END,
                           'required', coalesce(document_type.extraction_schema->'required', '[]'::jsonb) ? property.key
                       ) ORDER BY property.key)
                       FROM jsonb_each(coalesce(document_type.extraction_schema->'properties', '{}'::jsonb)) property
                   ), '[]'::jsonb),
                   'policy', jsonb_build_object(
                       'minimumConfidence', coalesce((document_type.classification_rules->>'minimum_confidence')::numeric, 0.8),
                       'alwaysHumanConfirm', coalesce((document_type.classification_rules->>'always_human_confirm')::boolean, false),
                       'manualOnConflict', coalesce((document_type.classification_rules->>'manual_on_conflict')::boolean, true),
                       'rejectOnQualityFlags', coalesce(document_type.classification_rules->'reject_on_quality_flags',
                           '["blurry","blank","corrupt","partial","password_protected","unsupported","mime_mismatch","other"]'::jsonb),
                       'rejectOnConflictFlags', coalesce(document_type.classification_rules->'reject_on_conflict_flags',
                           '["subject_conflict","period_conflict","document_type_conflict","duplicate_suspected","other"]'::jsonb)
                   )
               ) ORDER BY document_type.code), '[]'::jsonb), min(document_type.code)
          INTO labels, first_code
          FROM public.document_types document_type
         WHERE document_type.organization_id = org.organization_id
           AND document_type.status = 'active';
        definition := jsonb_build_object(
            'schemaVersion', '1.0', 'environment', 'DEV',
            'unknownDocumentRoute', 'review_required',
            'ambiguityRoute', 'review_required', 'labels', labels,
            'evaluationCases', jsonb_build_array(
                jsonb_build_object('caseKey','baseline.accepted','displayName','基线高置信度通过',
                    'synthetic',true,'filename','synthetic-accepted.pdf','mimeType','application/pdf',
                    'predictedLabelCode',first_code,'ambiguousLabelCodes','[]'::jsonb,'confidence',0.99,
                    'qualityFlags','[]'::jsonb,'conflictFlags','[]'::jsonb,'expectedRoute','accepted'),
                jsonb_build_object('caseKey','baseline.low-confidence','displayName','基线低置信度复核',
                    'synthetic',true,'filename','synthetic-low-confidence.pdf','mimeType','application/pdf',
                    'predictedLabelCode',first_code,'ambiguousLabelCodes','[]'::jsonb,'confidence',0.01,
                    'qualityFlags','[]'::jsonb,'conflictFlags','[]'::jsonb,'expectedRoute','review_required'),
                jsonb_build_object('caseKey','baseline.unknown','displayName','基线未知类别复核',
                    'synthetic',true,'filename','synthetic-unknown.bin','mimeType','application/octet-stream',
                    'predictedLabelCode','__unknown__','ambiguousLabelCodes','[]'::jsonb,'confidence',0.95,
                    'qualityFlags','[]'::jsonb,'conflictFlags','[]'::jsonb,'expectedRoute','review_required')
            )
        );
        definition_hash := encode(digest(definition::text, 'sha256'), 'hex');
        INSERT INTO public.classification_profiles (
            id, organization_id, profile_key, display_name, description, status,
            current_published_version_id, created_at, updated_at
        ) VALUES (profile_id, org.organization_id, 'default-document-classifier',
            '默认资料分类体系', '控制资料标签、抽取字段、判断阈值与人工复核边界。',
            'active', NULL, now(), now());
        INSERT INTO public.classification_profile_versions (
            id, organization_id, profile_id, version, revision, status,
            definition, definition_hash, created_by_actor_id, reason, created_at, published_at
        ) VALUES (version_id, org.organization_id, profile_id, 1, 1, 'published',
            definition, definition_hash, NULL, 'M18 从现有生产目录建立的基线发布版本。', now(), now());
        UPDATE public.classification_profiles
           SET current_published_version_id = version_id WHERE id = profile_id;
    END LOOP;
END;
$$;

ALTER TABLE public.classification_profiles
    ADD CONSTRAINT classification_profile_current_version_same_org_fk
        FOREIGN KEY (organization_id, current_published_version_id)
        REFERENCES public.classification_profile_versions(organization_id, id);

CREATE OR REPLACE FUNCTION public.dop_clone_classification_profile_version(
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
    source public.classification_profile_versions%ROWTYPE;
    profile public.classification_profiles%ROWTYPE;
    existing public.classification_profile_versions%ROWTYPE;
    fingerprint text;
    next_version integer;
    new_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|',p_source_version_id::text,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.classification_profile_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','versionId',existing.id,
                'version',existing.version,'revision',existing.revision,'status',existing.status);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO source FROM public.classification_profile_versions
     WHERE id = p_source_version_id AND organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','classification_profile_version_not_found'); END IF;
    SELECT * INTO profile FROM public.classification_profiles
     WHERE id = source.profile_id AND organization_id = v_organization_id FOR UPDATE;
    IF profile.status <> 'active' OR source.status <> 'published'
       OR profile.current_published_version_id <> source.id THEN
        RETURN jsonb_build_object('outcome','conflict','reason','source_not_current_published');
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.classification_profile_versions candidate
         WHERE candidate.profile_id = source.profile_id AND candidate.status IN ('draft','in_review')
           AND NOT EXISTS (SELECT 1 FROM public.classification_profile_versions later
               WHERE later.profile_id = candidate.profile_id
                 AND (later.version,later.revision) > (candidate.version,candidate.revision))
    ) THEN RETURN jsonb_build_object('outcome','conflict','reason','open_draft_exists'); END IF;
    SELECT coalesce(max(version),0)+1 INTO next_version
      FROM public.classification_profile_versions WHERE profile_id = source.profile_id;
    INSERT INTO public.workflow_events (
        id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at
    ) VALUES (event_id,v_organization_id,p_idempotency_key||':event','ClassificationProfile.VersionCloned',1,
        'classification_profile',source.profile_id,p_correlation_id,p_actor_id,'ops-classification-profile',
        jsonb_build_object('source_version_id',source.id,'version_id',new_id,'version',next_version,
            'revision',1,'definition_hash',source.definition_hash,'request_fingerprint',fingerprint,
            'external_delivery','disabled'),p_now);
    INSERT INTO public.classification_profile_versions (
        id,organization_id,profile_id,version,revision,status,definition,definition_hash,
        created_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at
    ) VALUES (new_id,v_organization_id,source.profile_id,next_version,1,'draft',source.definition,
        source.definition_hash,p_actor_id,p_reason,p_idempotency_key,fingerprint,event_id,p_now);
    RETURN jsonb_build_object('outcome','completed','profileId',source.profile_id,'versionId',new_id,
        'version',next_version,'revision',1,'status','draft');
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_update_classification_profile_draft(
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
    source public.classification_profile_versions%ROWTYPE;
    existing public.classification_profile_versions%ROWTYPE;
    validation_error text;
    definition_hash text;
    fingerprint text;
    new_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    validation_error := public.dop_classification_profile_definition_error(v_organization_id,p_definition);
    IF validation_error IS NOT NULL THEN
        RETURN jsonb_build_object('outcome','conflict','reason',validation_error);
    END IF;
    definition_hash := encode(digest(p_definition::text,'sha256'),'hex');
    fingerprint := encode(digest(concat_ws('|',p_version_id::text,p_definition::text,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.classification_profile_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','versionId',existing.id,
                'version',existing.version,'revision',existing.revision,'status',existing.status);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO source FROM public.classification_profile_versions
     WHERE id = p_version_id AND organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','classification_profile_version_not_found'); END IF;
    IF source.status <> 'draft' OR EXISTS (
        SELECT 1 FROM public.classification_profile_versions later
         WHERE later.profile_id = source.profile_id
           AND (later.version,later.revision) > (source.version,source.revision)
    ) THEN RETURN jsonb_build_object('outcome','conflict','reason','version_not_current'); END IF;
    INSERT INTO public.workflow_events (
        id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at
    ) VALUES (event_id,v_organization_id,p_idempotency_key||':event','ClassificationProfile.DraftRevised',1,
        'classification_profile',source.profile_id,p_correlation_id,p_actor_id,'ops-classification-profile',
        jsonb_build_object('source_version_id',source.id,'version_id',new_id,'version',source.version,
            'revision',source.revision+1,'definition_hash',definition_hash,
            'request_fingerprint',fingerprint,'external_delivery','disabled'),p_now);
    INSERT INTO public.classification_profile_versions (
        id,organization_id,profile_id,version,revision,status,definition,definition_hash,
        created_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at
    ) VALUES (new_id,v_organization_id,source.profile_id,source.version,source.revision+1,'draft',
        p_definition,definition_hash,p_actor_id,p_reason,p_idempotency_key,fingerprint,event_id,p_now);
    RETURN jsonb_build_object('outcome','completed','profileId',source.profile_id,'versionId',new_id,
        'version',source.version,'revision',source.revision+1,'status','draft');
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_run_classification_profile_evaluation(
    p_actor_id uuid, p_version_id uuid, p_reason text,
    p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    source public.classification_profile_versions%ROWTYPE;
    existing public.classification_profile_evaluation_runs%ROWTYPE;
    validation_error text;
    fingerprint text;
    case_item jsonb;
    label_item jsonb;
    reason_item text;
    reasons jsonb;
    actual_route text;
    total_count integer := 0;
    passed_count integer := 0;
    case_results jsonb := '[]'::jsonb;
    result jsonb;
    run_status text;
    run_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|',p_version_id::text,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.classification_profile_evaluation_runs
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','evaluationRunId',existing.id,
                'status',existing.status,'result',existing.result);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO source FROM public.classification_profile_versions
     WHERE id = p_version_id AND organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','classification_profile_version_not_found'); END IF;
    IF source.status NOT IN ('draft','in_review') OR EXISTS (
        SELECT 1 FROM public.classification_profile_versions later
         WHERE later.profile_id = source.profile_id
           AND (later.version,later.revision) > (source.version,source.revision)
    ) THEN RETURN jsonb_build_object('outcome','conflict','reason','version_not_current'); END IF;
    validation_error := public.dop_classification_profile_definition_error(v_organization_id,source.definition);
    IF validation_error IS NOT NULL THEN
        RETURN jsonb_build_object('outcome','conflict','reason',validation_error);
    END IF;
    FOR case_item IN SELECT value FROM jsonb_array_elements(source.definition->'evaluationCases') LOOP
        total_count := total_count + 1;
        reasons := '[]'::jsonb;
        SELECT item INTO label_item FROM jsonb_array_elements(source.definition->'labels') item
         WHERE item->>'code' = case_item->>'predictedLabelCode' LIMIT 1;
        IF label_item IS NULL THEN reasons := reasons || jsonb_build_array('unknown_document_type'); END IF;
        IF jsonb_array_length(case_item->'ambiguousLabelCodes') > 0 THEN
            reasons := reasons || jsonb_build_array('ambiguous_document_type');
        END IF;
        IF label_item IS NOT NULL THEN
            IF (case_item->>'confidence')::numeric < (label_item#>>'{policy,minimumConfidence}')::numeric THEN
                reasons := reasons || jsonb_build_array('low_confidence');
            END IF;
            IF (label_item#>>'{policy,alwaysHumanConfirm}')::boolean THEN
                reasons := reasons || jsonb_build_array('policy_requires_human_confirmation');
            END IF;
            IF jsonb_array_length(case_item->'qualityFlags') > 0 THEN
                reasons := reasons || jsonb_build_array('quality_flags_present');
            END IF;
            IF (label_item#>>'{policy,manualOnConflict}')::boolean
               AND jsonb_array_length(case_item->'conflictFlags') > 0 THEN
                reasons := reasons || jsonb_build_array('conflict_flags_present');
            END IF;
            IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(case_item->'qualityFlags') AS quality_flag(flag_value)
                WHERE label_item#>'{policy,rejectOnQualityFlags}' ? flag_value) THEN
                reasons := reasons || jsonb_build_array('quality_rule_matched');
            END IF;
            IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(case_item->'conflictFlags') AS conflict_flag(flag_value)
                WHERE label_item#>'{policy,rejectOnConflictFlags}' ? flag_value) THEN
                reasons := reasons || jsonb_build_array('conflict_rule_matched');
            END IF;
        END IF;
        actual_route := CASE WHEN jsonb_array_length(reasons)=0 THEN 'accepted' ELSE 'review_required' END;
        IF actual_route = case_item->>'expectedRoute' THEN passed_count := passed_count + 1; END IF;
        case_results := case_results || jsonb_build_array(jsonb_build_object(
            'caseKey',case_item->>'caseKey','displayName',case_item->>'displayName',
            'expectedRoute',case_item->>'expectedRoute','actualRoute',actual_route,
            'passed',actual_route=case_item->>'expectedRoute','reasons',reasons));
        label_item := NULL;
    END LOOP;
    run_status := CASE WHEN passed_count=total_count THEN 'passed' ELSE 'failed' END;
    result := jsonb_build_object('passed',run_status='passed','definitionHash',source.definition_hash,
        'totalCases',total_count,'passedCases',passed_count,'failedCases',total_count-passed_count,
        'caseResults',case_results,'externalDelivery','disabled','persistedDocuments',false,
        'providerCall',false);
    INSERT INTO public.workflow_events (
        id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at
    ) VALUES (event_id,v_organization_id,p_idempotency_key||':event','ClassificationProfile.EvaluationCompleted',1,
        'classification_profile',source.profile_id,p_correlation_id,p_actor_id,'ops-classification-profile',
        jsonb_build_object('version_id',source.id,'evaluation_run_id',run_id,'status',run_status,
            'definition_hash',source.definition_hash,'request_fingerprint',fingerprint,
            'external_delivery','disabled'),p_now);
    INSERT INTO public.classification_profile_evaluation_runs (
        id,organization_id,profile_id,profile_version_id,definition_hash,result,status,
        run_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at
    ) VALUES (run_id,v_organization_id,source.profile_id,source.id,source.definition_hash,result,
        run_status,p_actor_id,p_reason,p_idempotency_key,fingerprint,event_id,p_now);
    RETURN jsonb_build_object('outcome','completed','evaluationRunId',run_id,
        'status',run_status,'result',result);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_transition_classification_profile_version(
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
    source public.classification_profile_versions%ROWTYPE;
    profile public.classification_profiles%ROWTYPE;
    existing public.classification_profile_versions%ROWTYPE;
    target_status text;
    event_type text;
    fingerprint text;
    new_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    label_item jsonb;
    field_item jsonb;
    properties jsonb;
    required_fields jsonb;
    field_schema jsonb;
BEGIN
    IF p_action NOT IN ('submit_review','return_to_draft','publish')
       OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|',p_version_id::text,p_action,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.classification_profile_versions
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','versionId',existing.id,
                'version',existing.version,'revision',existing.revision,'status',existing.status);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO source FROM public.classification_profile_versions
     WHERE id = p_version_id AND organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','classification_profile_version_not_found'); END IF;
    SELECT * INTO profile FROM public.classification_profiles
     WHERE id = source.profile_id AND organization_id = v_organization_id FOR UPDATE;
    IF profile.status <> 'active' OR EXISTS (
        SELECT 1 FROM public.classification_profile_versions later
         WHERE later.profile_id=source.profile_id
           AND (later.version,later.revision)>(source.version,source.revision)
    ) THEN RETURN jsonb_build_object('outcome','conflict','reason','version_not_current'); END IF;
    IF p_action='submit_review' AND source.status='draft' THEN
        target_status:='in_review'; event_type:='ClassificationProfile.SubmittedForReview';
    ELSIF p_action='return_to_draft' AND source.status='in_review' THEN
        target_status:='draft'; event_type:='ClassificationProfile.ReturnedToDraft';
    ELSIF p_action='publish' AND source.status='in_review' THEN
        target_status:='published'; event_type:='ClassificationProfile.Published';
    ELSE RETURN jsonb_build_object('outcome','conflict','reason','invalid_transition'); END IF;
    IF p_action IN ('submit_review','publish') AND NOT EXISTS (
        SELECT 1 FROM public.classification_profile_evaluation_runs evaluation
         WHERE evaluation.profile_id=source.profile_id
           AND evaluation.definition_hash=source.definition_hash AND evaluation.status='passed'
    ) THEN RETURN jsonb_build_object('outcome','conflict','reason','passing_evaluation_required'); END IF;
    INSERT INTO public.workflow_events (
        id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at
    ) VALUES (event_id,v_organization_id,p_idempotency_key||':event',event_type,1,
        'classification_profile',source.profile_id,p_correlation_id,p_actor_id,'ops-classification-profile',
        jsonb_build_object('source_version_id',source.id,'version_id',new_id,'version',source.version,
            'revision',source.revision+1,'status',target_status,'definition_hash',source.definition_hash,
            'request_fingerprint',fingerprint,'external_delivery','disabled'),p_now);
    INSERT INTO public.classification_profile_versions (
        id,organization_id,profile_id,version,revision,status,definition,definition_hash,
        created_by_actor_id,reason,published_at,idempotency_key,request_fingerprint,event_id,created_at
    ) VALUES (new_id,v_organization_id,source.profile_id,source.version,source.revision+1,
        target_status,source.definition,source.definition_hash,p_actor_id,p_reason,
        CASE WHEN target_status='published' THEN p_now ELSE NULL END,
        p_idempotency_key,fingerprint,event_id,p_now);
    IF target_status='published' THEN
        FOR label_item IN SELECT value FROM jsonb_array_elements(source.definition->'labels') LOOP
            properties := '{}'::jsonb;
            required_fields := '[]'::jsonb;
            FOR field_item IN SELECT value FROM jsonb_array_elements(label_item->'extractionFields') LOOP
                field_schema := jsonb_build_object('type',CASE field_item->>'valueType'
                    WHEN 'number' THEN 'number' WHEN 'boolean' THEN 'boolean' ELSE 'string' END,
                    'title',field_item->>'displayName');
                IF field_item->>'valueType'='date' THEN
                    field_schema := field_schema || jsonb_build_object('format','date');
                END IF;
                properties := properties || jsonb_build_object(field_item->>'key',field_schema);
                IF (field_item->>'required')::boolean THEN
                    required_fields := required_fields || jsonb_build_array(field_item->>'key');
                END IF;
            END LOOP;
            INSERT INTO public.document_types (
                organization_id,code,display_name,description,allowed_mime_types,
                extraction_schema,classification_rules,status,created_at,updated_at
            ) VALUES (v_organization_id,label_item->>'code',btrim(label_item->>'displayName'),
                btrim(label_item->>'description'),ARRAY(SELECT jsonb_array_elements_text(label_item->'allowedMimeTypes')),
                jsonb_build_object('type','object','additionalProperties',true,'properties',properties,'required',required_fields),
                jsonb_build_object('minimum_confidence',(label_item#>>'{policy,minimumConfidence}')::numeric,
                    'always_human_confirm',(label_item#>>'{policy,alwaysHumanConfirm}')::boolean,
                    'manual_on_conflict',(label_item#>>'{policy,manualOnConflict}')::boolean,
                    'reject_on_quality_flags',label_item#>'{policy,rejectOnQualityFlags}',
                    'reject_on_conflict_flags',label_item#>'{policy,rejectOnConflictFlags}',
                    'classification_profile_version_id',new_id,
                    'classification_profile_definition_hash',source.definition_hash),
                'active',p_now,p_now)
            ON CONFLICT (organization_id,code) DO UPDATE SET
                display_name=EXCLUDED.display_name,description=EXCLUDED.description,
                allowed_mime_types=EXCLUDED.allowed_mime_types,extraction_schema=EXCLUDED.extraction_schema,
                classification_rules=EXCLUDED.classification_rules,status='active',updated_at=EXCLUDED.updated_at;
        END LOOP;
        UPDATE public.classification_profiles
           SET current_published_version_id=new_id,updated_at=p_now WHERE id=source.profile_id;
    END IF;
    RETURN jsonb_build_object('outcome','completed','profileId',source.profile_id,'versionId',new_id,
        'version',source.version,'revision',source.revision+1,'status',target_status);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_classification_profile_definition_error(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_clone_classification_profile_version(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_update_classification_profile_draft(uuid,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_run_classification_profile_evaluation(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_transition_classification_profile_version(uuid,uuid,text,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_clone_classification_profile_version(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_update_classification_profile_draft(uuid,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_run_classification_profile_evaluation(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_transition_classification_profile_version(uuid,uuid,text,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
