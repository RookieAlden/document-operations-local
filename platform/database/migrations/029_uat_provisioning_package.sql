BEGIN;

-- M33 compiles an approved UAT blueprint into a provider-neutral package.
-- The package is evidence, not infrastructure as code: every external action is prohibited.
CREATE TABLE public.uat_provisioning_packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    package_key text NOT NULL CHECK (package_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL DEFAULT 'compiled' CHECK (status IN ('compiled','superseded')),
    blueprint_id uuid NOT NULL REFERENCES public.uat_environment_blueprints(id),
    blueprint_definition_hash text NOT NULL CHECK (blueprint_definition_hash ~ '^[0-9a-f]{64}$'),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    runbook jsonb NOT NULL CHECK (jsonb_typeof(runbook)='array'),
    runbook_hash text NOT NULL CHECK (runbook_hash ~ '^[0-9a-f]{64}$'),
    previous_package_id uuid,
    compiled_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    UNIQUE (organization_id,package_key,version),
    UNIQUE (organization_id,blueprint_id,definition_hash),
    CONSTRAINT uat_package_blueprint_same_org_fk FOREIGN KEY (organization_id,blueprint_id)
        REFERENCES public.uat_environment_blueprints(organization_id,id),
    CONSTRAINT uat_package_previous_same_org_fk FOREIGN KEY (organization_id,previous_package_id)
        REFERENCES public.uat_provisioning_packages(organization_id,id),
    CONSTRAINT uat_package_actor_same_org_fk FOREIGN KEY (organization_id,compiled_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT uat_package_event_same_org_fk FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE TABLE public.uat_provisioning_package_dry_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    package_id uuid NOT NULL REFERENCES public.uat_provisioning_packages(id),
    package_definition_hash text NOT NULL CHECK (package_definition_hash ~ '^[0-9a-f]{64}$'),
    policy_version text NOT NULL CHECK (policy_version='1.0'),
    status text NOT NULL CHECK (status='passed'),
    execution_decision text NOT NULL CHECK (execution_decision='no_go'),
    blocker_count integer NOT NULL CHECK (blocker_count=0),
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
    CONSTRAINT uat_package_run_package_same_org_fk FOREIGN KEY (organization_id,package_id)
        REFERENCES public.uat_provisioning_packages(organization_id,id),
    CONSTRAINT uat_package_run_actor_same_org_fk FOREIGN KEY (organization_id,run_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT uat_package_run_event_same_org_fk FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE INDEX uat_provisioning_packages_history_idx
    ON public.uat_provisioning_packages (organization_id,package_key,version DESC);
CREATE INDEX uat_provisioning_package_dry_runs_history_idx
    ON public.uat_provisioning_package_dry_runs (organization_id,package_id,created_at DESC);

ALTER TABLE public.uat_provisioning_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uat_provisioning_package_dry_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.uat_provisioning_packages,public.uat_provisioning_package_dry_runs TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.uat_provisioning_packages
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.uat_provisioning_package_dry_runs
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_uat_provisioning_package_definition_error(p_definition jsonb)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
SELECT CASE
    WHEN jsonb_typeof(p_definition)<>'object'
       OR p_definition->>'schemaVersion'<>'1.0'
       OR p_definition->>'sourceEnvironment'<>'DEV'
       OR p_definition->>'targetEnvironment'<>'UAT'
       OR p_definition->>'mode'<>'compile_only'
       OR p_definition->>'execution'<>'prohibited'
       OR p_definition->>'region'<>'Sydney'
       OR p_definition#>>'{budget,monthlyLimitUsd}'<>'0'
       OR p_definition#>>'{budget,paidResourceProvisioning}'<>'prohibited'
       OR p_definition#>>'{budget,reapprovalRequired}'<>'true'
       OR p_definition#>>'{dataBoundary,syntheticOnly}'<>'true'
       OR p_definition#>>'{dataBoundary,realDataRequiresReapproval}'<>'true'
       OR p_definition#>>'{dataBoundary,retentionDays}'<>'30'
       OR p_definition#>>'{dataBoundary,devDataCopy}'<>'none'
       OR p_definition#>>'{railwayPlan,action}'<>'plan_only'
       OR p_definition#>>'{railwayPlan,environment,create}'<>'false'
       OR p_definition#>>'{railwayPlan,environment,start}'<>'false'
       OR p_definition#>>'{supabasePlan,action}'<>'plan_only'
       OR p_definition#>>'{supabasePlan,project,create}'<>'false'
       OR p_definition#>>'{supabasePlan,database,create}'<>'false'
       OR p_definition#>>'{supabasePlan,storage,create}'<>'false'
       OR p_definition#>>'{retentionJob,execution}'<>'disabled'
       OR p_definition#>>'{approvalGate,status}'<>'blocked_by_zero_budget'
       OR p_definition#>>'{approvalGate,provisioningAuthorized}'<>'false'
       OR jsonb_typeof(p_definition#>'{railwayPlan,services}')<>'array'
       OR jsonb_array_length(p_definition#>'{railwayPlan,services}')<>3
       OR jsonb_typeof(p_definition->'runbook')<>'array'
       OR jsonb_array_length(p_definition->'runbook')<>10
      THEN 'uat_provisioning_package_invalid'
    WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_definition#>'{railwayPlan,services}') service
         WHERE service->>'key' NOT IN ('intake','preservation','classification')
            OR service->>'create'<>'false' OR service->>'start'<>'false'
            OR service->>'publicDomainCreate'<>'false' OR service->>'plannedReplicas'<>'1'
    ) OR (SELECT count(DISTINCT service->>'key')
            FROM jsonb_array_elements(p_definition#>'{railwayPlan,services}') service)<>3
      THEN 'uat_provisioning_package_service_invalid'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_definition->'runbook') step
                  WHERE step->>'execution'<>'disabled')
      THEN 'uat_provisioning_package_execution_enabled'
    ELSE NULL
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_compile_uat_provisioning_package(
    p_actor_id uuid,p_blueprint_id uuid,p_reason text,p_idempotency_key text,
    p_correlation_id uuid,p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,extensions,pg_temp
AS $$
DECLARE
    v_organization_id uuid:=public.dop_require_active_admin(p_actor_id);
    blueprint public.uat_environment_blueprints%ROWTYPE;
    latest_run public.uat_blueprint_dry_runs%ROWTYPE;
    v_package_key text;
    definition jsonb;
    runbook jsonb;
    definition_error text;
    v_definition_hash text;
    v_runbook_hash text;
    fingerprint text;
    next_version integer;
    previous_id uuid;
    package_id uuid:=gen_random_uuid();
    event_id uuid:=gen_random_uuid();
    existing public.uat_provisioning_packages%ROWTYPE;
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO blueprint FROM public.uat_environment_blueprints
     WHERE id=p_blueprint_id AND organization_id=v_organization_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','uat_blueprint_not_found'); END IF;
    IF blueprint.status<>'draft' THEN RETURN jsonb_build_object('outcome','conflict','reason','uat_blueprint_not_current'); END IF;
    SELECT * INTO latest_run FROM public.uat_blueprint_dry_runs
     WHERE blueprint_id=blueprint.id AND organization_id=v_organization_id ORDER BY created_at DESC,id DESC LIMIT 1;
    IF latest_run.id IS NULL OR latest_run.status<>'passed' OR latest_run.blueprint_definition_hash<>blueprint.definition_hash THEN
        RETURN jsonb_build_object('outcome','conflict','reason','fresh_passing_uat_dry_run_required');
    END IF;
    v_package_key:=blueprint.blueprint_key||'-provisioning';
    runbook:=jsonb_build_array(
        jsonb_build_object('sequence',1,'action','verify_approved_blueprint','execution','disabled'),
        jsonb_build_object('sequence',2,'action','verify_zero_budget_gate','execution','disabled'),
        jsonb_build_object('sequence',3,'action','quote_provider_cost','execution','disabled'),
        jsonb_build_object('sequence',4,'action','create_railway_environment','execution','disabled'),
        jsonb_build_object('sequence',5,'action','create_supabase_data_plane','execution','disabled'),
        jsonb_build_object('sequence',6,'action','apply_ordered_migrations','execution','disabled'),
        jsonb_build_object('sequence',7,'action','register_secret_references','execution','disabled'),
        jsonb_build_object('sequence',8,'action','configure_thirty_day_cleanup','execution','disabled'),
        jsonb_build_object('sequence',9,'action','run_synthetic_acceptance','execution','disabled'),
        jsonb_build_object('sequence',10,'action','rollback_unexposed_target','execution','disabled')
    );
    definition:=jsonb_build_object(
        'schemaVersion','1.0','sourceEnvironment','DEV','targetEnvironment','UAT','mode','compile_only',
        'execution','prohibited','region','Sydney',
        'budget',jsonb_build_object('monthlyLimitUsd',0,'paidResourceProvisioning','prohibited','reapprovalRequired',true),
        'dataBoundary',jsonb_build_object('syntheticOnly',true,'realDataRequiresReapproval',true,'retentionDays',30,'devDataCopy','none'),
        'railwayPlan',jsonb_build_object('action','plan_only','environment',jsonb_build_object('name','uat','create',false,'start',false),
            'services',jsonb_build_array(
                jsonb_build_object('key','intake','plannedReplicas',1,'create',false,'start',false,'publicDomainCreate',false),
                jsonb_build_object('key','preservation','plannedReplicas',1,'create',false,'start',false,'publicDomainCreate',false),
                jsonb_build_object('key','classification','plannedReplicas',1,'create',false,'start',false,'publicDomainCreate',false)),
            'variableNames',blueprint.definition->'variableNames','secretReferences',blueprint.definition->'secretReferences'),
        'supabasePlan',jsonb_build_object('action','plan_only','project',jsonb_build_object('region','Sydney','create',false),
            'database',jsonb_build_object('create',false),'storage',jsonb_build_object('private',true,'create',false)),
        'migration',jsonb_build_object('strategy','ordered_sql','migrations',jsonb_build_array('001..029'),
            'verificationScripts',jsonb_build_array('033_uat_provisioning_package_regression.sql'),'execution','disabled'),
        'retentionJob',jsonb_build_object('retentionDays',30,'scheduler','not_configured','execution','disabled'),
        'acceptance',blueprint.definition->'acceptance','rollback',blueprint.definition->'rollback','runbook',runbook,
        'approvalGate',jsonb_build_object('status','blocked_by_zero_budget','provisioningAuthorized',false,
            'reapprovalRequired',true,'requiredBeforeExecution',jsonb_build_array('positive_uat_budget','real_data_approval_if_applicable'))
    );
    definition_error:=public.dop_uat_provisioning_package_definition_error(definition);
    IF definition_error IS NOT NULL THEN RETURN jsonb_build_object('outcome','conflict','reason',definition_error); END IF;
    v_definition_hash:=encode(digest(definition::text,'sha256'),'hex');
    v_runbook_hash:=encode(digest(runbook::text,'sha256'),'hex');
    fingerprint:=encode(digest(concat_ws('|',p_blueprint_id::text,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.uat_provisioning_packages
     WHERE organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','packageId',existing.id,'version',existing.version); END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    IF EXISTS (SELECT 1 FROM public.uat_provisioning_packages candidate
        WHERE candidate.organization_id=v_organization_id AND candidate.blueprint_id=blueprint.id
          AND candidate.definition_hash=v_definition_hash) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','uat_provisioning_package_unchanged');
    END IF;
    SELECT coalesce(max(version),0)+1 INTO next_version FROM public.uat_provisioning_packages
     WHERE organization_id=v_organization_id AND package_key=v_package_key;
    SELECT id INTO previous_id FROM public.uat_provisioning_packages
     WHERE organization_id=v_organization_id AND package_key=v_package_key ORDER BY version DESC LIMIT 1;
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (event_id,v_organization_id,p_idempotency_key||':event','UatProvisioningPackage.Compiled',1,
        'uat_provisioning_package',package_id,p_correlation_id,p_actor_id,'ops-uat-provisioning',
        jsonb_build_object('blueprintId',blueprint.id,'definitionHash',v_definition_hash,'runbookHash',v_runbook_hash,
            'executionDecision','no_go','resourcesCreated',0,'externalCalls',0),p_now);
    UPDATE public.uat_provisioning_packages SET status='superseded'
     WHERE organization_id=v_organization_id AND package_key=v_package_key AND status='compiled';
    INSERT INTO public.uat_provisioning_packages (id,organization_id,package_key,version,status,blueprint_id,
        blueprint_definition_hash,definition,definition_hash,runbook,runbook_hash,previous_package_id,
        compiled_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
    VALUES (package_id,v_organization_id,v_package_key,next_version,'compiled',blueprint.id,blueprint.definition_hash,
        definition,v_definition_hash,runbook,v_runbook_hash,previous_id,p_actor_id,p_reason,p_idempotency_key,fingerprint,event_id,p_now);
    RETURN jsonb_build_object('outcome','completed','packageId',package_id,'version',next_version,'status','compiled',
        'executionDecision','no_go','provisioningAuthorized',false,'resourcesCreated',0,'externalCalls',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_run_uat_provisioning_package_dry_run(
    p_actor_id uuid,p_package_id uuid,p_reason text,p_idempotency_key text,
    p_correlation_id uuid,p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,extensions,pg_temp
AS $$
DECLARE
    v_organization_id uuid:=public.dop_require_active_manager(p_actor_id);
    v_package public.uat_provisioning_packages%ROWTYPE;
    existing public.uat_provisioning_package_dry_runs%ROWTYPE;
    fingerprint text;
    checks jsonb;
    effects jsonb:=jsonb_build_object('environmentsCreated',0,'servicesCreated',0,'databasesCreated',0,
        'storageBucketsCreated',0,'domainsCreated',0,'secretValuesResolved',0,'schedulersCreated',0,
        'dataCopied',false,'runtimeStarted',false,'externalCalls',0,'notificationsCreated',0,'estimatedAddedMonthlyCostUsd',0);
    run_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid();
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    fingerprint:=encode(digest(concat_ws('|',p_package_id::text,p_reason),'sha256'),'hex');
    SELECT * INTO existing FROM public.uat_provisioning_package_dry_runs
     WHERE organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','dryRunId',existing.id,'status','passed','executionDecision','no_go'); END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO v_package FROM public.uat_provisioning_packages
     WHERE id=p_package_id AND organization_id=v_organization_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','uat_provisioning_package_not_found'); END IF;
    IF v_package.status<>'compiled' THEN RETURN jsonb_build_object('outcome','conflict','reason','uat_provisioning_package_not_current'); END IF;
    IF public.dop_uat_provisioning_package_definition_error(v_package.definition) IS NOT NULL THEN
        RETURN jsonb_build_object('outcome','conflict','reason','uat_provisioning_package_invalid');
    END IF;
    checks:=jsonb_build_array(
        jsonb_build_object('code','approved_blueprint_bound','status','passed','evidence',jsonb_build_object('blueprintId',v_package.blueprint_id,'definitionHash',v_package.blueprint_definition_hash)),
        jsonb_build_object('code','zero_budget_gate_active','status','passed','evidence',jsonb_build_object('monthlyLimitUsd',0,'provisioningAuthorized',false)),
        jsonb_build_object('code','all_provider_actions_disabled','status','passed','evidence',jsonb_build_object('runbookSteps',10,'enabledSteps',0)),
        jsonb_build_object('code','sydney_synthetic_boundary','status','passed','evidence',jsonb_build_object('region','Sydney','syntheticOnly',true,'realDataAllowed',false)),
        jsonb_build_object('code','thirty_day_cleanup_contract','status','passed','evidence',jsonb_build_object('retentionDays',30,'schedulerCreated',false)),
        jsonb_build_object('code','secret_references_only','status','passed','evidence',jsonb_build_object('valuesResolved',0)),
        jsonb_build_object('code','rollback_contract_present','status','passed','evidence',v_package.definition->'rollback'),
        jsonb_build_object('code','zero_side_effects','status','passed','evidence',effects)
    );
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (event_id,v_organization_id,p_idempotency_key||':event','UatProvisioningPackage.DryRunCompleted',1,
        'uat_provisioning_package',v_package.id,p_correlation_id,p_actor_id,'ops-uat-provisioning',
        jsonb_build_object('definitionHash',v_package.definition_hash,'status','passed','executionDecision','no_go',
            'blockerCount',0,'sideEffects',effects),p_now);
    INSERT INTO public.uat_provisioning_package_dry_runs (id,organization_id,package_id,package_definition_hash,
        policy_version,status,execution_decision,blocker_count,checks,side_effects,run_by_actor_id,reason,
        idempotency_key,request_fingerprint,event_id,created_at)
    VALUES (run_id,v_organization_id,v_package.id,v_package.definition_hash,'1.0','passed','no_go',0,checks,effects,
        p_actor_id,p_reason,p_idempotency_key,fingerprint,event_id,p_now);
    RETURN jsonb_build_object('outcome','completed','dryRunId',run_id,'status','passed','executionDecision','no_go',
        'blockerCount',0,'provisioningAuthorized',false,'checks',checks,'sideEffects',effects);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_uat_provisioning_package_definition_error(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_compile_uat_provisioning_package(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_run_uat_provisioning_package_dry_run(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_compile_uat_provisioning_package(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_run_uat_provisioning_package_dry_run(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;

COMMENT ON TABLE public.uat_provisioning_packages IS
'M33 provider-neutral UAT provisioning evidence. It is deliberately non-executable while the UAT budget is zero.';

COMMIT;
