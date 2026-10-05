BEGIN;

-- M31 records an executable-looking plan that is intentionally non-executable.
-- It never provisions an environment, resolves a credential, enables ingress,
-- starts a runtime, copies DEV data or sends an external message.
CREATE TABLE public.uat_environment_blueprints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    blueprint_key text NOT NULL CHECK (blueprint_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','superseded')),
    release_manifest_id uuid,
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    deployment_plan jsonb NOT NULL CHECK (jsonb_typeof(deployment_plan)='array'),
    deployment_plan_hash text NOT NULL CHECK (deployment_plan_hash ~ '^[0-9a-f]{64}$'),
    previous_blueprint_id uuid,
    created_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    UNIQUE (organization_id,blueprint_key,version),
    UNIQUE (organization_id,definition_hash),
    CONSTRAINT uat_blueprint_manifest_same_org_fk FOREIGN KEY (organization_id,release_manifest_id)
        REFERENCES public.release_manifests(organization_id,id),
    CONSTRAINT uat_blueprint_previous_same_org_fk FOREIGN KEY (organization_id,previous_blueprint_id)
        REFERENCES public.uat_environment_blueprints(organization_id,id),
    CONSTRAINT uat_blueprint_actor_same_org_fk FOREIGN KEY (organization_id,created_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT uat_blueprint_event_same_org_fk FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE TABLE public.uat_blueprint_dry_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    blueprint_id uuid NOT NULL REFERENCES public.uat_environment_blueprints(id),
    blueprint_definition_hash text NOT NULL CHECK (blueprint_definition_hash ~ '^[0-9a-f]{64}$'),
    policy_version text NOT NULL CHECK (policy_version='1.0'),
    status text NOT NULL CHECK (status IN ('passed','blocked')),
    blocker_count integer NOT NULL CHECK (blocker_count >= 0),
    checks jsonb NOT NULL CHECK (jsonb_typeof(checks)='array'),
    side_effects jsonb NOT NULL CHECK (jsonb_typeof(side_effects)='object'),
    run_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    CONSTRAINT uat_dry_run_blueprint_same_org_fk FOREIGN KEY (organization_id,blueprint_id)
        REFERENCES public.uat_environment_blueprints(organization_id,id),
    CONSTRAINT uat_dry_run_actor_same_org_fk FOREIGN KEY (organization_id,run_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT uat_dry_run_event_same_org_fk FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE INDEX uat_environment_blueprints_history_idx
    ON public.uat_environment_blueprints (organization_id,blueprint_key,version DESC);
CREATE INDEX uat_blueprint_dry_runs_history_idx
    ON public.uat_blueprint_dry_runs (organization_id,blueprint_id,created_at DESC);

ALTER TABLE public.uat_environment_blueprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uat_blueprint_dry_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.uat_environment_blueprints,public.uat_blueprint_dry_runs TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.uat_environment_blueprints
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.uat_blueprint_dry_runs
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_uat_blueprint_definition_error(p_definition jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
    service jsonb;
    secret_reference jsonb;
    variable_name jsonb;
    decision_key text;
    decision jsonb;
BEGIN
    IF jsonb_typeof(p_definition)<>'object'
       OR p_definition->>'schemaVersion'<>'1.0'
       OR p_definition->>'sourceEnvironment'<>'DEV'
       OR p_definition->>'targetEnvironment'<>'UAT'
       OR p_definition->>'provisioningMode'<>'dry_run_only'
       OR p_definition->>'targetProvisioning'<>'not_started'
       OR p_definition->>'dataBoundary'<>'synthetic_only'
       OR p_definition->>'dataCopy'<>'none'
       OR p_definition->>'runtimeExecution'<>'disabled'
       OR p_definition->>'externalIngress'<>'disabled'
       OR p_definition->>'externalDelivery'<>'disabled'
       OR p_definition->>'secretMaterialization'<>'disabled'
       OR jsonb_typeof(p_definition->'topology')<>'object'
       OR jsonb_typeof(p_definition->'decisions')<>'object'
       OR jsonb_typeof(p_definition->'variableNames')<>'array'
       OR jsonb_typeof(p_definition->'secretReferences')<>'array'
       OR jsonb_typeof(p_definition->'migration')<>'object'
       OR jsonb_typeof(p_definition->'acceptance')<>'object'
       OR jsonb_typeof(p_definition->'rollback')<>'object' THEN
        RETURN 'uat_blueprint_definition_invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_definition) key WHERE key NOT IN (
        'schemaVersion','sourceEnvironment','targetEnvironment','provisioningMode','targetProvisioning',
        'dataBoundary','dataCopy','runtimeExecution','externalIngress','externalDelivery',
        'secretMaterialization','topology','decisions','variableNames','secretReferences',
        'migration','acceptance','rollback','runtimeOwners')) THEN
        RETURN 'uat_blueprint_unknown_field';
    END IF;
    IF p_definition#>>'{topology,provider}'<>'railway'
       OR p_definition#>>'{topology,isolation}'<>'dedicated_environment'
       OR p_definition#>>'{topology,database}'<>'dedicated_supabase_project'
       OR p_definition#>>'{topology,storage}'<>'dedicated_private_bucket'
       OR jsonb_typeof(p_definition#>'{topology,services}')<>'array'
       OR jsonb_array_length(p_definition#>'{topology,services}')<>3 THEN
        RETURN 'uat_blueprint_topology_invalid';
    END IF;
    FOR service IN SELECT value FROM jsonb_array_elements(p_definition#>'{topology,services}') LOOP
        IF jsonb_typeof(service)<>'object' OR service->>'key' NOT IN ('intake','preservation','classification')
           OR service->>'plannedExposure'<>'internal_only'
           OR jsonb_typeof(service->'replicas')<>'number' OR (service->>'replicas')::integer<>1
           OR service->>'runtimeState'<>'disabled' THEN RETURN 'uat_blueprint_service_invalid'; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(p_definition#>'{topology,services}'))<>3 THEN
        RETURN 'uat_blueprint_service_invalid';
    END IF;
    FOREACH decision_key IN ARRAY ARRAY['dataRegion','privacyRetention','budget','runtimeOwner'] LOOP
        decision:=p_definition#>(ARRAY['decisions',decision_key]);
        IF jsonb_typeof(decision)<>'object' OR decision->>'status' NOT IN ('pending','approved')
           OR NOT (decision->'reference'='null'::jsonb OR jsonb_typeof(decision->'reference')='string')
           OR (decision->>'status'='approved' AND coalesce(char_length(decision->>'reference'),0)<3) THEN
            RETURN 'uat_blueprint_decision_invalid';
        END IF;
    END LOOP;
    decision:=p_definition#>'{decisions,budget}';
    IF decision->>'status'='approved' AND (jsonb_typeof(decision->'monthlyLimitUsd')<>'number'
       OR (decision->>'monthlyLimitUsd')::numeric<=0 OR (decision->>'monthlyLimitUsd')::numeric>1000) THEN
        RETURN 'uat_blueprint_budget_invalid';
    END IF;
    IF jsonb_array_length(p_definition->'variableNames')<5 OR jsonb_array_length(p_definition->'variableNames')>50
       OR jsonb_array_length(p_definition->'secretReferences')>30 THEN RETURN 'uat_blueprint_variable_catalog_invalid'; END IF;
    FOR variable_name IN SELECT value FROM jsonb_array_elements(p_definition->'variableNames') LOOP
        IF jsonb_typeof(variable_name)<>'string' OR variable_name#>>'{}' !~ '^[A-Z][A-Z0-9_]{2,79}$' THEN
            RETURN 'uat_blueprint_variable_catalog_invalid';
        END IF;
    END LOOP;
    FOR secret_reference IN SELECT value FROM jsonb_array_elements(p_definition->'secretReferences') LOOP
        IF jsonb_typeof(secret_reference)<>'object'
           OR secret_reference->>'variableName' !~ '^[A-Z][A-Z0-9_]{2,79}$'
           OR secret_reference->>'reference' !~ '^[a-z][a-z0-9+.-]*://[^?#[:space:]]{3,240}$'
           OR secret_reference ? 'value' THEN RETURN 'uat_blueprint_secret_reference_invalid'; END IF;
    END LOOP;
    IF p_definition#>>'{migration,strategy}'<>'ordered_sql'
       OR p_definition#>>'{migration,seedMode}'<>'synthetic_only'
       OR jsonb_typeof(p_definition#>'{migration,migrations}')<>'array'
       OR jsonb_array_length(p_definition#>'{migration,migrations}')<1
       OR jsonb_typeof(p_definition#>'{migration,verificationScripts}')<>'array'
       OR jsonb_array_length(p_definition#>'{migration,verificationScripts}')<1 THEN
        RETURN 'uat_blueprint_migration_invalid';
    END IF;
    IF p_definition#>>'{acceptance,healthCheck}'<>'required'
       OR p_definition#>>'{acceptance,errorLogs}'<>'zero_required'
       OR p_definition#>>'{acceptance,syntheticJourney}'<>'required'
       OR p_definition#>>'{acceptance,realData}'<>'prohibited' THEN RETURN 'uat_blueprint_acceptance_invalid'; END IF;
    IF p_definition#>>'{rollback,strategy}'<>'remove_unexposed_target'
       OR p_definition#>>'{rollback,preserveAuditEvidence}'<>'true'
       OR jsonb_typeof(p_definition#>'{rollback,maxMinutes}')<>'number'
       OR (p_definition#>>'{rollback,maxMinutes}')::integer NOT BETWEEN 1 AND 120 THEN
        RETURN 'uat_blueprint_rollback_invalid';
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_build_uat_deployment_plan(p_definition jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
SELECT jsonb_build_array(
    jsonb_build_object('sequence',1,'action','verify_governance_inputs','execution','disabled'),
    jsonb_build_object('sequence',2,'action','prepare_isolated_data_plane','execution','disabled'),
    jsonb_build_object('sequence',3,'action','apply_ordered_migrations','execution','disabled','count',jsonb_array_length(p_definition#>'{migration,migrations}')),
    jsonb_build_object('sequence',4,'action','register_secret_references','execution','disabled','count',jsonb_array_length(p_definition->'secretReferences')),
    jsonb_build_object('sequence',5,'action','prepare_three_services','execution','disabled'),
    jsonb_build_object('sequence',6,'action','run_synthetic_acceptance','execution','disabled'),
    jsonb_build_object('sequence',7,'action','record_go_no_go','execution','disabled'),
    jsonb_build_object('sequence',8,'action','rollback_unexposed_target_if_required','execution','disabled')
);
$$;

CREATE OR REPLACE FUNCTION public.dop_create_uat_environment_blueprint(
    p_actor_id uuid,p_blueprint_key text,p_release_manifest_id uuid,p_definition jsonb,p_reason text,
    p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,extensions,pg_temp
AS $$
DECLARE
    v_organization_id uuid:=public.dop_require_active_admin(p_actor_id);
    normalized_key text:=lower(btrim(p_blueprint_key));
    definition_error text;
    v_definition_hash text;
    plan jsonb;
    plan_hash text;
    fingerprint text;
    next_version integer;
    previous_id uuid;
    blueprint_id uuid:=gen_random_uuid();
    event_id uuid:=gen_random_uuid();
    existing public.uat_environment_blueprints%ROWTYPE;
BEGIN
    IF normalized_key !~ '^[a-z0-9][a-z0-9._-]{2,119}$' OR char_length(p_reason) NOT BETWEEN 12 AND 1000
       OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    definition_error:=public.dop_uat_blueprint_definition_error(p_definition);
    IF definition_error IS NOT NULL THEN RETURN jsonb_build_object('outcome','conflict','reason',definition_error); END IF;
    IF p_release_manifest_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.release_manifests
        WHERE id=p_release_manifest_id AND organization_id=v_organization_id) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','release_manifest_reference_invalid');
    END IF;
    v_definition_hash:=encode(digest(p_definition::text,'sha256'),'hex');
    plan:=public.dop_build_uat_deployment_plan(p_definition);
    plan_hash:=encode(digest(plan::text,'sha256'),'hex');
    fingerprint:=encode(digest(concat_ws('|',normalized_key,coalesce(p_release_manifest_id::text,''),p_definition::text,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.uat_environment_blueprints
     WHERE organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','blueprintId',existing.id,'version',existing.version,'definitionHash',existing.definition_hash); END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    IF EXISTS (SELECT 1 FROM public.uat_environment_blueprints candidate
        WHERE candidate.organization_id=v_organization_id AND candidate.definition_hash=v_definition_hash) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','uat_blueprint_unchanged');
    END IF;
    SELECT coalesce(max(version),0)+1 INTO next_version FROM public.uat_environment_blueprints
     WHERE organization_id=v_organization_id AND blueprint_key=normalized_key;
    SELECT id INTO previous_id FROM public.uat_environment_blueprints
     WHERE organization_id=v_organization_id AND blueprint_key=normalized_key ORDER BY version DESC LIMIT 1;
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (event_id,v_organization_id,p_idempotency_key||':event','UatEnvironmentBlueprint.Created',1,
        'uat_environment_blueprint',blueprint_id,p_correlation_id,p_actor_id,'ops-uat-blueprint',
        jsonb_build_object('blueprintKey',normalized_key,'version',next_version,'definitionHash',v_definition_hash,
            'planHash',plan_hash,'targetEnvironmentCreated',false,'secretValuesStored',false,'externalCalls',0),p_now);
    UPDATE public.uat_environment_blueprints SET status='superseded'
     WHERE organization_id=v_organization_id AND blueprint_key=normalized_key AND status='draft';
    INSERT INTO public.uat_environment_blueprints (id,organization_id,blueprint_key,version,status,
        release_manifest_id,definition,definition_hash,deployment_plan,deployment_plan_hash,previous_blueprint_id,
        created_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
    VALUES (blueprint_id,v_organization_id,normalized_key,next_version,'draft',p_release_manifest_id,p_definition,
        v_definition_hash,plan,plan_hash,previous_id,p_actor_id,p_reason,p_idempotency_key,fingerprint,event_id,p_now);
    RETURN jsonb_build_object('outcome','completed','blueprintId',blueprint_id,'version',next_version,
        'status','draft','definitionHash',v_definition_hash,'deploymentPlanHash',plan_hash,
        'targetEnvironmentCreated',false,'externalCalls',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_run_uat_blueprint_dry_run(
    p_actor_id uuid,p_blueprint_id uuid,p_reason text,p_idempotency_key text,
    p_correlation_id uuid,p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,extensions,pg_temp
AS $$
DECLARE
    v_organization_id uuid:=public.dop_require_active_manager(p_actor_id);
    blueprint public.uat_environment_blueprints%ROWTYPE;
    manifest_status text;
    existing public.uat_blueprint_dry_runs%ROWTYPE;
    fingerprint text;
    checks jsonb:='[]'::jsonb;
    blockers integer;
    run_id uuid:=gen_random_uuid();
    event_id uuid:=gen_random_uuid();
    check_passed boolean;
    effects jsonb:=jsonb_build_object('targetEnvironmentCreated',false,'servicesCreated',0,
        'databaseCreated',false,'storageCreated',false,'domainsCreated',0,'secretValuesResolved',0,
        'dataCopied',false,'runtimeStarted',false,'externalCalls',0,'notificationsCreated',0);
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    fingerprint:=encode(digest(concat_ws('|',p_blueprint_id::text,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.uat_blueprint_dry_runs WHERE organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','dryRunId',existing.id,'status',existing.status,'blockerCount',existing.blocker_count); END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO blueprint FROM public.uat_environment_blueprints WHERE id=p_blueprint_id AND organization_id=v_organization_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','uat_blueprint_not_found'); END IF;
    IF blueprint.status<>'draft' THEN RETURN jsonb_build_object('outcome','conflict','reason','uat_blueprint_not_current'); END IF;
    SELECT status INTO manifest_status FROM public.release_manifests WHERE id=blueprint.release_manifest_id AND organization_id=v_organization_id;
    check_passed:=manifest_status='approved';
    checks:=checks||jsonb_build_array(jsonb_build_object('code','approved_release_manifest','status',CASE WHEN check_passed THEN 'passed' ELSE 'blocked' END,'evidence',jsonb_build_object('manifestId',blueprint.release_manifest_id,'status',coalesce(manifest_status,'missing'))));
    FOREACH manifest_status IN ARRAY ARRAY['dataRegion','privacyRetention','budget','runtimeOwner'] LOOP
        check_passed:=blueprint.definition#>>ARRAY['decisions',manifest_status,'status']='approved';
        checks:=checks||jsonb_build_array(jsonb_build_object('code',lower(regexp_replace(manifest_status,'([A-Z])','_\1','g'))||'_decision','status',CASE WHEN check_passed THEN 'passed' ELSE 'blocked' END,'evidence',blueprint.definition#>ARRAY['decisions',manifest_status]));
    END LOOP;
    checks:=checks||jsonb_build_array(
        jsonb_build_object('code','isolated_topology','status','passed','evidence',jsonb_build_object('serviceCount',3,'provider','railway')),
        jsonb_build_object('code','synthetic_data_only','status','passed','evidence',jsonb_build_object('dataCopy','none','seedMode','synthetic_only')),
        jsonb_build_object('code','external_capabilities_disabled','status','passed','evidence',jsonb_build_object('runtime','disabled','ingress','disabled','delivery','disabled')),
        jsonb_build_object('code','secret_references_only','status','passed','evidence',jsonb_build_object('referenceCount',jsonb_array_length(blueprint.definition->'secretReferences'),'valuesResolved',0)),
        jsonb_build_object('code','ordered_migration_plan','status','passed','evidence',jsonb_build_object('migrationCount',jsonb_array_length(blueprint.definition#>'{migration,migrations}'),'verificationCount',jsonb_array_length(blueprint.definition#>'{migration,verificationScripts}'))),
        jsonb_build_object('code','acceptance_and_rollback','status','passed','evidence',jsonb_build_object('health','required','realData','prohibited','rollback','remove_unexposed_target')),
        jsonb_build_object('code','zero_side_effects','status','passed','evidence',effects)
    );
    SELECT count(*) INTO blockers FROM jsonb_array_elements(checks) item WHERE item->>'status'='blocked';
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (event_id,v_organization_id,p_idempotency_key||':event','UatEnvironmentBlueprint.DryRunCompleted',1,
        'uat_environment_blueprint',blueprint.id,p_correlation_id,p_actor_id,'ops-uat-blueprint',
        jsonb_build_object('definitionHash',blueprint.definition_hash,'status',CASE WHEN blockers=0 THEN 'passed' ELSE 'blocked' END,
            'blockerCount',blockers,'sideEffects',effects),p_now);
    INSERT INTO public.uat_blueprint_dry_runs (id,organization_id,blueprint_id,blueprint_definition_hash,
        policy_version,status,blocker_count,checks,side_effects,run_by_actor_id,reason,idempotency_key,
        request_fingerprint,event_id,created_at)
    VALUES (run_id,v_organization_id,blueprint.id,blueprint.definition_hash,'1.0',
        CASE WHEN blockers=0 THEN 'passed' ELSE 'blocked' END,blockers,checks,effects,p_actor_id,p_reason,
        p_idempotency_key,fingerprint,event_id,p_now);
    RETURN jsonb_build_object('outcome','completed','dryRunId',run_id,
        'status',CASE WHEN blockers=0 THEN 'passed' ELSE 'blocked' END,'blockerCount',blockers,
        'checks',checks,'sideEffects',effects);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_uat_blueprint_definition_error(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_build_uat_deployment_plan(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_uat_environment_blueprint(uuid,text,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_run_uat_blueprint_dry_run(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_create_uat_environment_blueprint(uuid,text,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_run_uat_blueprint_dry_run(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
