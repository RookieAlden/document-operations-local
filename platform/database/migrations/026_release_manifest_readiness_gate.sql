BEGIN;

-- M30 freezes the cross-module configuration required for a future UAT
-- promotion. It records readiness evidence only: it cannot create an
-- environment, resolve credentials, activate ingress or deliver messages.
CREATE TABLE public.release_manifests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    manifest_key text NOT NULL CHECK (manifest_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','in_review','approved','rejected','superseded')),
    source_environment text NOT NULL CHECK (source_environment='DEV'),
    target_environment text NOT NULL CHECK (target_environment='UAT'),
    component_snapshot jsonb NOT NULL CHECK (jsonb_typeof(component_snapshot)='array'),
    component_snapshot_hash text NOT NULL CHECK (component_snapshot_hash ~ '^[0-9a-f]{64}$'),
    readiness_declarations jsonb NOT NULL CHECK (jsonb_typeof(readiness_declarations)='object'),
    declarations_hash text NOT NULL CHECK (declarations_hash ~ '^[0-9a-f]{64}$'),
    manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    rollback_manifest_id uuid,
    created_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    submitted_by_actor_id uuid REFERENCES public.actors(id),
    approved_by_actor_id uuid REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    submitted_at timestamptz,
    approved_at timestamptz,
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    UNIQUE (organization_id,manifest_key,version),
    UNIQUE (organization_id,manifest_hash),
    CONSTRAINT release_manifest_rollback_same_org_fk
        FOREIGN KEY (organization_id,rollback_manifest_id)
        REFERENCES public.release_manifests(organization_id,id),
    CONSTRAINT release_manifest_creator_same_org_fk
        FOREIGN KEY (organization_id,created_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT release_manifest_submitter_same_org_fk
        FOREIGN KEY (organization_id,submitted_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT release_manifest_approver_same_org_fk
        FOREIGN KEY (organization_id,approved_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT release_manifest_event_same_org_fk
        FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE TABLE public.release_readiness_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    manifest_id uuid NOT NULL REFERENCES public.release_manifests(id),
    manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    current_component_snapshot_hash text NOT NULL CHECK (current_component_snapshot_hash ~ '^[0-9a-f]{64}$'),
    policy_version text NOT NULL CHECK (policy_version='1.0'),
    status text NOT NULL CHECK (status IN ('passed','blocked')),
    blocker_count integer NOT NULL CHECK (blocker_count >= 0),
    drift_detected boolean NOT NULL,
    checks jsonb NOT NULL CHECK (jsonb_typeof(checks)='array'),
    run_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    CONSTRAINT release_readiness_manifest_same_org_fk
        FOREIGN KEY (organization_id,manifest_id)
        REFERENCES public.release_manifests(organization_id,id),
    CONSTRAINT release_readiness_actor_same_org_fk
        FOREIGN KEY (organization_id,run_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT release_readiness_event_same_org_fk
        FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE TABLE public.release_approval_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    manifest_id uuid NOT NULL REFERENCES public.release_manifests(id),
    manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    action text NOT NULL CHECK (action IN ('approved','rejected')),
    decided_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    decided_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    CONSTRAINT release_decision_manifest_same_org_fk
        FOREIGN KEY (organization_id,manifest_id)
        REFERENCES public.release_manifests(organization_id,id),
    CONSTRAINT release_decision_actor_same_org_fk
        FOREIGN KEY (organization_id,decided_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT release_decision_event_same_org_fk
        FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE INDEX release_manifests_history_idx
    ON public.release_manifests (organization_id,manifest_key,version DESC);
CREATE INDEX release_readiness_history_idx
    ON public.release_readiness_runs (organization_id,manifest_id,created_at DESC);
CREATE INDEX release_decisions_history_idx
    ON public.release_approval_decisions (organization_id,manifest_id,decided_at DESC);

ALTER TABLE public.release_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_readiness_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_approval_decisions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.release_manifests,public.release_readiness_runs,
    public.release_approval_decisions TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.release_manifests
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.release_readiness_runs
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.release_approval_decisions
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_build_release_component_snapshot(p_organization_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
WITH components AS (
    SELECT 'work_package'::text AS component_type, package.package_key AS component_key,
           package.id AS root_id, version.id AS version_id,
           concat('v',version.version,'.r',version.revision) AS version_label,
           version.definition_hash, package.status AS lifecycle_status
      FROM public.work_configuration_packages package
      JOIN public.work_configuration_package_versions version
        ON version.id=package.current_published_version_id
     WHERE package.organization_id=p_organization_id AND package.status='active'
    UNION ALL
    SELECT 'work_configuration', subject.subject_key, subject.id, release.id,
           concat('r',release.release_number,'.v',release.revision),
           release.definition_hash, subject.status
      FROM public.subjects subject
      JOIN LATERAL (
          SELECT candidate.* FROM public.work_configuration_releases candidate
           WHERE candidate.organization_id=p_organization_id
             AND candidate.subject_id=subject.id AND candidate.status='published'
           ORDER BY candidate.release_number DESC,candidate.revision DESC,candidate.created_at DESC
           LIMIT 1
      ) release ON true
     WHERE subject.organization_id=p_organization_id AND subject.status='active'
    UNION ALL
    SELECT 'case_plan', plan.plan_key, plan.id, version.id,
           concat('v',version.version,'.r',version.revision),
           version.definition_hash, plan.status
      FROM public.case_plans plan
      JOIN LATERAL (
          SELECT candidate.* FROM public.case_plan_versions candidate
           WHERE candidate.organization_id=p_organization_id
             AND candidate.case_plan_id=plan.id AND candidate.status='published'
           ORDER BY candidate.version DESC,candidate.revision DESC,candidate.created_at DESC
           LIMIT 1
      ) version ON true
     WHERE plan.organization_id=p_organization_id AND plan.status='active'
    UNION ALL
    SELECT 'classification_profile', profile.profile_key, profile.id, version.id,
           concat('v',version.version,'.r',version.revision),
           version.definition_hash, profile.status
      FROM public.classification_profiles profile
      JOIN public.classification_profile_versions version
        ON version.id=profile.current_published_version_id
     WHERE profile.organization_id=p_organization_id AND profile.status='active'
    UNION ALL
    SELECT 'classifier_release', release.release_key, release.id, version.id,
           concat('v',version.version,'.r',version.revision),
           version.definition_hash, release.status
      FROM public.classifier_releases release
      JOIN public.classifier_release_versions version
        ON version.id=release.current_published_version_id
     WHERE release.organization_id=p_organization_id AND release.status='active'
    UNION ALL
    SELECT 'source_connector', connector.connector_key, connector.id, version.id,
           concat('v',version.version,'.r',version.revision),
           version.definition_hash, connector.lifecycle_status
      FROM public.source_connectors connector
      JOIN public.source_connector_versions version ON version.id=connector.active_version_id
     WHERE connector.organization_id=p_organization_id AND connector.lifecycle_status='active'
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'componentType',component_type,'componentKey',component_key,
    'rootId',root_id,'versionId',version_id,'versionLabel',version_label,
    'definitionHash',definition_hash,'lifecycleStatus',lifecycle_status
) ORDER BY component_type,component_key,version_id),'[]'::jsonb)
FROM components;
$$;

CREATE OR REPLACE FUNCTION public.dop_release_declarations_error(p_declarations jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
    approval_key text;
    approval jsonb;
    secret_reference jsonb;
BEGIN
    IF jsonb_typeof(p_declarations)<>'object'
       OR p_declarations->>'schemaVersion'<>'1.0'
       OR p_declarations->>'sourceEnvironment'<>'DEV'
       OR p_declarations->>'targetEnvironment'<>'UAT'
       OR p_declarations->>'targetProvisioning'<>'not_started'
       OR p_declarations->>'runtimeExecution'<>'disabled'
       OR p_declarations->>'externalDelivery'<>'disabled'
       OR p_declarations->>'externalIngress'<>'disabled'
       OR p_declarations->>'dataBoundary'<>'synthetic_only'
       OR jsonb_typeof(p_declarations->'approvals')<>'object'
       OR jsonb_typeof(p_declarations->'secretReferences')<>'array'
       OR jsonb_array_length(p_declarations->'secretReferences')>20 THEN
        RETURN 'release_declarations_invalid';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_declarations) key
         WHERE key NOT IN ('schemaVersion','sourceEnvironment','targetEnvironment','targetProvisioning',
            'runtimeExecution','externalDelivery','externalIngress','dataBoundary','approvals','secretReferences')
    ) OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_declarations->'approvals') key
         WHERE key NOT IN ('dataRegion','privacyRetention','budget','sharedMailbox')
    ) THEN RETURN 'release_declarations_unknown_field'; END IF;
    FOREACH approval_key IN ARRAY ARRAY['dataRegion','privacyRetention','budget','sharedMailbox'] LOOP
        approval:=p_declarations#>(ARRAY['approvals',approval_key]);
        IF jsonb_typeof(approval)<>'object'
           OR approval->>'status' NOT IN ('pending','approved','not_required')
           OR NOT (jsonb_typeof(approval->'reference')='string' OR approval->'reference'='null'::jsonb)
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(approval) key
                       WHERE key NOT IN ('status','reference','monthlyLimitUsd'))
           OR (approval_key<>'budget' AND approval ? 'monthlyLimitUsd') THEN
            RETURN 'release_approval_declaration_invalid';
        END IF;
        IF (approval->>'reference' IS NOT NULL AND char_length(approval->>'reference') NOT BETWEEN 3 AND 240)
           OR (approval->>'status'='approved' AND approval->>'reference' IS NULL)
           OR (approval->>'status'='not_required' AND approval->>'reference' IS NOT NULL) THEN
            RETURN 'release_approval_reference_required';
        END IF;
    END LOOP;
    approval:=p_declarations#>'{approvals,budget}';
    IF approval->>'status'='approved' THEN
        IF jsonb_typeof(approval->'monthlyLimitUsd')<>'number' THEN
            RETURN 'release_budget_limit_invalid';
        END IF;
        IF (approval->>'monthlyLimitUsd')::numeric <= 0 OR (approval->>'monthlyLimitUsd')::numeric > 1000 THEN
            RETURN 'release_budget_limit_invalid';
        END IF;
    ELSIF approval ? 'monthlyLimitUsd' THEN
        RETURN 'release_budget_limit_invalid';
    END IF;
    FOR secret_reference IN SELECT value FROM jsonb_array_elements(p_declarations->'secretReferences') LOOP
        IF jsonb_typeof(secret_reference)<>'string'
           OR secret_reference#>>'{}' !~ '^[a-z][a-z0-9+.-]*://[^?#[:space:]]{3,240}$' THEN
            RETURN 'release_secret_reference_invalid';
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_create_release_manifest(
    p_actor_id uuid,p_manifest_key text,p_declarations jsonb,p_reason text,
    p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,extensions,pg_temp
AS $$
DECLARE
    v_organization_id uuid:=public.dop_require_active_admin(p_actor_id);
    normalized_key text:=lower(btrim(p_manifest_key));
    declaration_error text;
    components jsonb;
    component_hash text;
    declaration_hash text;
    combined_hash text;
    fingerprint text;
    next_version integer;
    rollback_id uuid;
    manifest_id uuid:=gen_random_uuid();
    event_id uuid:=gen_random_uuid();
    existing public.release_manifests%ROWTYPE;
BEGIN
    IF normalized_key !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
       OR char_length(p_reason) NOT BETWEEN 12 AND 1000
       OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    declaration_error:=public.dop_release_declarations_error(p_declarations);
    IF declaration_error IS NOT NULL THEN
        RETURN jsonb_build_object('outcome','conflict','reason',declaration_error);
    END IF;
    components:=public.dop_build_release_component_snapshot(v_organization_id);
    IF jsonb_array_length(components)=0 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','release_components_unavailable');
    END IF;
    component_hash:=encode(digest(components::text,'sha256'),'hex');
    declaration_hash:=encode(digest(p_declarations::text,'sha256'),'hex');
    combined_hash:=encode(digest(concat_ws('|','1.0',normalized_key,component_hash,declaration_hash),'sha256'),'hex');
    fingerprint:=encode(digest(concat_ws('|',normalized_key,p_declarations::text,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.release_manifests
     WHERE release_manifests.organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint=fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','manifestId',existing.id,
                'version',existing.version,'status',existing.status,'manifestHash',existing.manifest_hash);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    IF EXISTS (SELECT 1 FROM public.release_manifests
        WHERE release_manifests.organization_id=v_organization_id AND manifest_hash=combined_hash) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','release_manifest_unchanged');
    END IF;
    SELECT coalesce(max(version),0)+1 INTO next_version FROM public.release_manifests
     WHERE release_manifests.organization_id=v_organization_id AND manifest_key=normalized_key;
    SELECT id INTO rollback_id FROM public.release_manifests
     WHERE release_manifests.organization_id=v_organization_id AND manifest_key=normalized_key AND status='approved'
     ORDER BY version DESC LIMIT 1;
    INSERT INTO public.workflow_events (
        id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at
    ) VALUES (event_id,v_organization_id,p_idempotency_key||':event','ReleaseManifest.Created',1,
        'release_manifest',manifest_id,p_correlation_id,p_actor_id,'ops-release-readiness',
        jsonb_build_object('manifestKey',normalized_key,'version',next_version,
            'manifestHash',combined_hash,'componentSnapshotHash',component_hash,
            'componentCount',jsonb_array_length(components),'sourceEnvironment','DEV',
            'targetEnvironment','UAT','targetProvisioning','not_started',
            'runtimeExecution','disabled','externalDelivery','disabled','externalCalls',0),p_now);
    INSERT INTO public.release_manifests (
        id,organization_id,manifest_key,version,status,source_environment,target_environment,
        component_snapshot,component_snapshot_hash,readiness_declarations,declarations_hash,
        manifest_hash,rollback_manifest_id,created_by_actor_id,reason,idempotency_key,
        request_fingerprint,event_id,created_at
    ) VALUES (manifest_id,v_organization_id,normalized_key,next_version,'draft','DEV','UAT',
        components,component_hash,p_declarations,declaration_hash,combined_hash,rollback_id,
        p_actor_id,p_reason,p_idempotency_key,fingerprint,event_id,p_now);
    RETURN jsonb_build_object('outcome','completed','manifestId',manifest_id,'version',next_version,
        'status','draft','manifestHash',combined_hash,'componentCount',jsonb_array_length(components),
        'rollbackManifestId',rollback_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_evaluate_release_manifest(
    p_actor_id uuid,p_manifest_id uuid,p_reason text,p_idempotency_key text,
    p_correlation_id uuid,p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,extensions,pg_temp
AS $$
DECLARE
    v_organization_id uuid:=public.dop_require_active_manager(p_actor_id);
    manifest public.release_manifests%ROWTYPE;
    existing public.release_readiness_runs%ROWTYPE;
    current_components jsonb;
    current_hash text;
    fingerprint text;
    event_id uuid:=gen_random_uuid();
    run_id uuid:=gen_random_uuid();
    checks jsonb:='[]'::jsonb;
    blockers integer;
    coverage_ok boolean;
    compatibility_ok boolean;
    connector_safety_ok boolean;
    passed boolean;
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000
       OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO manifest FROM public.release_manifests
     WHERE id=p_manifest_id AND release_manifests.organization_id=v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','manifest_not_found'); END IF;
    IF manifest.status IN ('rejected','superseded') THEN
        RETURN jsonb_build_object('outcome','conflict','reason','manifest_not_evaluable');
    END IF;
    fingerprint:=encode(digest(concat_ws('|',p_manifest_id::text,manifest.manifest_hash,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.release_readiness_runs
     WHERE release_readiness_runs.organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint=fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','runId',existing.id,'status',existing.status,
                'blockerCount',existing.blocker_count,'driftDetected',existing.drift_detected);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    current_components:=public.dop_build_release_component_snapshot(v_organization_id);
    current_hash:=encode(digest(current_components::text,'sha256'),'hex');
    coverage_ok:=
        (SELECT count(*) FROM public.work_configuration_packages package WHERE package.organization_id=v_organization_id AND status='active')
          =(SELECT count(*) FROM jsonb_array_elements(current_components) item WHERE item->>'componentType'='work_package')
        AND (SELECT count(*) FROM public.case_plans plan WHERE plan.organization_id=v_organization_id AND status='active')
          =(SELECT count(*) FROM jsonb_array_elements(current_components) item WHERE item->>'componentType'='case_plan')
        AND (SELECT count(*) FROM public.classification_profiles profile WHERE profile.organization_id=v_organization_id AND status='active')
          =(SELECT count(*) FROM jsonb_array_elements(current_components) item WHERE item->>'componentType'='classification_profile')
        AND (SELECT count(*) FROM public.classifier_releases release WHERE release.organization_id=v_organization_id AND status='active')
          =(SELECT count(*) FROM jsonb_array_elements(current_components) item WHERE item->>'componentType'='classifier_release')
        AND (SELECT count(*) FROM public.source_connectors connector WHERE connector.organization_id=v_organization_id AND lifecycle_status='active')
          =(SELECT count(*) FROM jsonb_array_elements(current_components) item WHERE item->>'componentType'='source_connector')
        AND (SELECT count(*) FROM public.subjects subject WHERE subject.organization_id=v_organization_id AND status='active')
          =(SELECT count(*) FROM jsonb_array_elements(current_components) item WHERE item->>'componentType'='work_configuration')
        AND (SELECT count(*) FROM jsonb_array_elements(current_components) item WHERE item->>'componentType'='work_configuration')>0;
    SELECT EXISTS (
        SELECT 1 FROM public.classifier_releases release
        JOIN public.classifier_release_versions release_version ON release_version.id=release.current_published_version_id
        JOIN public.classification_profiles profile ON profile.organization_id=release.organization_id AND profile.status='active'
        JOIN public.classification_profile_versions profile_version ON profile_version.id=profile.current_published_version_id
        WHERE release.organization_id=v_organization_id AND release.status='active'
          AND release_version.definition->>'classificationProfileVersionId'=profile_version.id::text
          AND release_version.definition->>'classificationProfileDefinitionHash'=profile_version.definition_hash
    ) INTO compatibility_ok;
    SELECT NOT EXISTS (
        SELECT 1 FROM public.source_connectors connector
        LEFT JOIN public.source_connector_versions version ON version.id=connector.active_version_id
        WHERE connector.organization_id=v_organization_id AND connector.lifecycle_status='active'
          AND (version.id IS NULL
               OR version.definition#>>'{dataBoundary,syntheticOnly}'<>'true'
               OR version.definition#>>'{dataBoundary,externalDelivery}'<>'disabled'
               OR version.definition#>>'{activationPolicy,runtimeExecution}'<>'disabled')
    ) INTO connector_safety_ok;

    checks:=checks||jsonb_build_array(jsonb_build_object('code','component_snapshot_present','status',
        CASE WHEN jsonb_array_length(manifest.component_snapshot)>0 THEN 'passed' ELSE 'blocked' END,
        'evidence',jsonb_build_object('componentCount',jsonb_array_length(manifest.component_snapshot))));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','no_component_drift','status',
        CASE WHEN current_hash=manifest.component_snapshot_hash THEN 'passed' ELSE 'blocked' END,
        'evidence',jsonb_build_object('frozenHash',manifest.component_snapshot_hash,'currentHash',current_hash)));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','component_coverage','status',
        CASE WHEN coverage_ok THEN 'passed' ELSE 'blocked' END,'evidence',jsonb_build_object('currentComponentCount',jsonb_array_length(current_components))));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','classifier_profile_alignment','status',
        CASE WHEN compatibility_ok THEN 'passed' ELSE 'blocked' END,'evidence',jsonb_build_object('aligned',compatibility_ok)));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','connector_safety_boundary','status',
        CASE WHEN connector_safety_ok THEN 'passed' ELSE 'blocked' END,
        'evidence',jsonb_build_object('syntheticOnly',true,'runtimeExecution','disabled','externalDelivery','disabled')));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','target_not_provisioned','status',
        CASE WHEN manifest.readiness_declarations->>'targetProvisioning'='not_started' THEN 'passed' ELSE 'blocked' END,
        'evidence',jsonb_build_object('targetEnvironment','UAT','provisioning','not_started')));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','external_capabilities_disabled','status',
        CASE WHEN manifest.readiness_declarations->>'runtimeExecution'='disabled'
                  AND manifest.readiness_declarations->>'externalDelivery'='disabled'
                  AND manifest.readiness_declarations->>'externalIngress'='disabled' THEN 'passed' ELSE 'blocked' END,
        'evidence',jsonb_build_object('runtimeExecution','disabled','externalDelivery','disabled','externalIngress','disabled','externalCalls',0)));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','synthetic_data_boundary','status',
        CASE WHEN manifest.readiness_declarations->>'dataBoundary'='synthetic_only' THEN 'passed' ELSE 'blocked' END,
        'evidence',jsonb_build_object('dataBoundary',manifest.readiness_declarations->>'dataBoundary')));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','data_region_approval','status',
        CASE WHEN manifest.readiness_declarations#>>'{approvals,dataRegion,status}'='approved' THEN 'passed' ELSE 'blocked' END,
        'evidence',manifest.readiness_declarations#>'{approvals,dataRegion}'));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','privacy_retention_approval','status',
        CASE WHEN manifest.readiness_declarations#>>'{approvals,privacyRetention,status}'='approved' THEN 'passed' ELSE 'blocked' END,
        'evidence',manifest.readiness_declarations#>'{approvals,privacyRetention}'));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','budget_approval','status',
        CASE WHEN manifest.readiness_declarations#>>'{approvals,budget,status}'='approved' THEN 'passed' ELSE 'blocked' END,
        'evidence',manifest.readiness_declarations#>'{approvals,budget}'));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','shared_mailbox_boundary','status',
        CASE WHEN manifest.readiness_declarations#>>'{approvals,sharedMailbox,status}' IN ('approved','not_required') THEN 'passed' ELSE 'blocked' END,
        'evidence',manifest.readiness_declarations#>'{approvals,sharedMailbox}'));
    checks:=checks||jsonb_build_array(jsonb_build_object('code','secret_references_only','status','passed',
        'evidence',jsonb_build_object('referenceCount',jsonb_array_length(manifest.readiness_declarations->'secretReferences'),'secretValuesStored',false)));
    SELECT count(*)::integer INTO blockers FROM jsonb_array_elements(checks) item WHERE item->>'status'='blocked';
    passed:=blockers=0;
    INSERT INTO public.workflow_events (
        id,organization_id,idempotency_key,event_type,event_version,aggregate_type,aggregate_id,
        correlation_id,actor_id,producer,payload,occurred_at
    ) VALUES (event_id,v_organization_id,p_idempotency_key||':event','ReleaseManifest.ReadinessEvaluated',1,
        'release_manifest',manifest.id,p_correlation_id,p_actor_id,'ops-release-readiness',
        jsonb_build_object('manifestHash',manifest.manifest_hash,'policyVersion','1.0',
            'status',CASE WHEN passed THEN 'passed' ELSE 'blocked' END,'blockerCount',blockers,
            'driftDetected',current_hash<>manifest.component_snapshot_hash,'targetEnvironmentCreated',false,
            'runtimeExecution','disabled','externalDelivery','disabled','externalCalls',0,'secretValuesStored',false),p_now);
    INSERT INTO public.release_readiness_runs (
        id,organization_id,manifest_id,manifest_hash,current_component_snapshot_hash,policy_version,
        status,blocker_count,drift_detected,checks,run_by_actor_id,reason,idempotency_key,
        request_fingerprint,event_id,created_at
    ) VALUES (run_id,v_organization_id,manifest.id,manifest.manifest_hash,current_hash,'1.0',
        CASE WHEN passed THEN 'passed' ELSE 'blocked' END,blockers,current_hash<>manifest.component_snapshot_hash,
        checks,p_actor_id,p_reason,p_idempotency_key,fingerprint,event_id,p_now);
    RETURN jsonb_build_object('outcome','completed','runId',run_id,
        'status',CASE WHEN passed THEN 'passed' ELSE 'blocked' END,'blockerCount',blockers,
        'driftDetected',current_hash<>manifest.component_snapshot_hash,'checks',checks);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_submit_release_manifest(
    p_actor_id uuid,p_manifest_id uuid,p_reason text,p_idempotency_key text,
    p_correlation_id uuid,p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,extensions,pg_temp
AS $$
DECLARE
    v_organization_id uuid:=public.dop_require_active_admin(p_actor_id);
    manifest public.release_manifests%ROWTYPE;
    latest_run public.release_readiness_runs%ROWTYPE;
    current_hash text;
    event_id uuid:=gen_random_uuid();
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000
       OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO manifest FROM public.release_manifests WHERE id=p_manifest_id AND release_manifests.organization_id=v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','manifest_not_found'); END IF;
    IF manifest.status='in_review' AND manifest.submitted_by_actor_id=p_actor_id THEN
        RETURN jsonb_build_object('outcome','duplicate','manifestId',manifest.id,'status',manifest.status);
    END IF;
    IF manifest.status<>'draft' THEN RETURN jsonb_build_object('outcome','conflict','reason','manifest_not_draft'); END IF;
    SELECT * INTO latest_run FROM public.release_readiness_runs
     WHERE manifest_id=manifest.id ORDER BY created_at DESC,id DESC LIMIT 1;
    current_hash:=encode(digest(public.dop_build_release_component_snapshot(v_organization_id)::text,'sha256'),'hex');
    IF latest_run.id IS NULL OR latest_run.status<>'passed' OR latest_run.manifest_hash<>manifest.manifest_hash
       OR current_hash<>manifest.component_snapshot_hash THEN
        RETURN jsonb_build_object('outcome','conflict','reason','fresh_passing_readiness_required');
    END IF;
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (event_id,v_organization_id,p_idempotency_key||':event','ReleaseManifest.SubmittedForReview',1,
        'release_manifest',manifest.id,p_correlation_id,p_actor_id,'ops-release-readiness',
        jsonb_build_object('manifestHash',manifest.manifest_hash,'readinessRunId',latest_run.id,
            'targetEnvironmentCreated',false,'externalCalls',0),p_now);
    UPDATE public.release_manifests SET status='in_review',submitted_by_actor_id=p_actor_id,
        submitted_at=p_now WHERE id=manifest.id;
    RETURN jsonb_build_object('outcome','completed','manifestId',manifest.id,'status','in_review');
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_decide_release_manifest(
    p_actor_id uuid,p_manifest_id uuid,p_action text,p_reason text,p_idempotency_key text,
    p_correlation_id uuid,p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,extensions,pg_temp
AS $$
DECLARE
    v_organization_id uuid:=public.dop_require_active_manager(p_actor_id);
    manifest public.release_manifests%ROWTYPE;
    latest_run public.release_readiness_runs%ROWTYPE;
    existing public.release_approval_decisions%ROWTYPE;
    current_hash text;
    fingerprint text;
    event_id uuid:=gen_random_uuid();
    decision_id uuid:=gen_random_uuid();
    target_status text;
BEGIN
    IF p_action NOT IN ('approve','reject') OR char_length(p_reason) NOT BETWEEN 12 AND 1000
       OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    fingerprint:=encode(digest(concat_ws('|',p_manifest_id::text,p_action,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.release_approval_decisions
     WHERE release_approval_decisions.organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint=fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','decisionId',existing.id,'action',existing.action);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO manifest FROM public.release_manifests
     WHERE id=p_manifest_id AND release_manifests.organization_id=v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','manifest_not_found'); END IF;
    IF manifest.status<>'in_review' THEN RETURN jsonb_build_object('outcome','conflict','reason','manifest_not_in_review'); END IF;
    IF p_actor_id IN (manifest.created_by_actor_id,manifest.submitted_by_actor_id) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','independent_reviewer_required');
    END IF;
    IF p_action='approve' THEN
        SELECT * INTO latest_run FROM public.release_readiness_runs
         WHERE manifest_id=manifest.id ORDER BY created_at DESC,id DESC LIMIT 1;
        current_hash:=encode(digest(public.dop_build_release_component_snapshot(v_organization_id)::text,'sha256'),'hex');
        IF latest_run.id IS NULL OR latest_run.status<>'passed'
           OR latest_run.manifest_hash<>manifest.manifest_hash
           OR current_hash<>manifest.component_snapshot_hash THEN
            RETURN jsonb_build_object('outcome','conflict','reason','fresh_passing_readiness_required');
        END IF;
        target_status:='approved';
    ELSE target_status:='rejected'; END IF;
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (event_id,v_organization_id,p_idempotency_key||':event',
        CASE WHEN p_action='approve' THEN 'ReleaseManifest.Approved' ELSE 'ReleaseManifest.Rejected' END,1,
        'release_manifest',manifest.id,p_correlation_id,p_actor_id,'ops-release-readiness',
        jsonb_build_object('manifestHash',manifest.manifest_hash,'decision',target_status,
            'rollbackManifestId',manifest.rollback_manifest_id,'targetEnvironmentCreated',false,
            'runtimeExecution','disabled','externalDelivery','disabled','externalCalls',0),p_now);
    INSERT INTO public.release_approval_decisions (id,organization_id,manifest_id,manifest_hash,action,
        decided_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,decided_at)
    VALUES (decision_id,v_organization_id,manifest.id,manifest.manifest_hash,target_status,p_actor_id,
        p_reason,p_idempotency_key,fingerprint,event_id,p_now);
    IF target_status='approved' THEN
        UPDATE public.release_manifests SET status='superseded'
         WHERE release_manifests.organization_id=v_organization_id AND manifest_key=manifest.manifest_key
           AND status='approved' AND id<>manifest.id;
        UPDATE public.release_manifests SET status='approved',approved_by_actor_id=p_actor_id,
            approved_at=p_now WHERE id=manifest.id;
    ELSE
        UPDATE public.release_manifests SET status='rejected' WHERE id=manifest.id;
    END IF;
    RETURN jsonb_build_object('outcome','completed','manifestId',manifest.id,'decisionId',decision_id,
        'status',target_status,'rollbackManifestId',manifest.rollback_manifest_id);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_build_release_component_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_release_declarations_error(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_release_manifest(uuid,text,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_evaluate_release_manifest(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_submit_release_manifest(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_decide_release_manifest(uuid,uuid,text,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_create_release_manifest(uuid,text,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_evaluate_release_manifest(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_submit_release_manifest(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_decide_release_manifest(uuid,uuid,text,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
