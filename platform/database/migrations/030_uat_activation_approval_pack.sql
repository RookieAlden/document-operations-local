BEGIN;

-- M34 stages explicit evidence required before a future UAT activation request.
-- It never authorizes or performs provider actions; even a complete pack remains NO-GO
-- until a separate, future final-authorization stage is approved.
CREATE TABLE public.uat_activation_approval_packs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    approval_pack_key text NOT NULL CHECK (approval_pack_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','superseded')),
    provisioning_package_id uuid NOT NULL REFERENCES public.uat_provisioning_packages(id),
    provisioning_package_definition_hash text NOT NULL CHECK (provisioning_package_definition_hash ~ '^[0-9a-f]{64}$'),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    previous_approval_pack_id uuid,
    compiled_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    UNIQUE (organization_id,approval_pack_key,version),
    UNIQUE (organization_id,provisioning_package_id,definition_hash),
    CONSTRAINT uat_activation_pack_package_same_org_fk FOREIGN KEY (organization_id,provisioning_package_id)
        REFERENCES public.uat_provisioning_packages(organization_id,id),
    CONSTRAINT uat_activation_pack_previous_same_org_fk FOREIGN KEY (organization_id,previous_approval_pack_id)
        REFERENCES public.uat_activation_approval_packs(organization_id,id),
    CONSTRAINT uat_activation_pack_actor_same_org_fk FOREIGN KEY (organization_id,compiled_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT uat_activation_pack_event_same_org_fk FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE TABLE public.uat_activation_approval_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    approval_pack_id uuid NOT NULL REFERENCES public.uat_activation_approval_packs(id),
    decision_key text NOT NULL CHECK (decision_key IN ('customer_confirmation','budget_and_cost','data_scope','provisioning_window')),
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL CHECK (status IN ('approved','rejected')),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    previous_decision_id uuid,
    decided_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    UNIQUE (organization_id,approval_pack_id,decision_key,version),
    CONSTRAINT uat_activation_decision_pack_same_org_fk FOREIGN KEY (organization_id,approval_pack_id)
        REFERENCES public.uat_activation_approval_packs(organization_id,id),
    CONSTRAINT uat_activation_decision_previous_same_org_fk FOREIGN KEY (organization_id,previous_decision_id)
        REFERENCES public.uat_activation_approval_decisions(organization_id,id),
    CONSTRAINT uat_activation_decision_actor_same_org_fk FOREIGN KEY (organization_id,decided_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT uat_activation_decision_event_same_org_fk FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE TABLE public.uat_activation_approval_evaluations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    approval_pack_id uuid NOT NULL REFERENCES public.uat_activation_approval_packs(id),
    approval_pack_definition_hash text NOT NULL CHECK (approval_pack_definition_hash ~ '^[0-9a-f]{64}$'),
    policy_version text NOT NULL CHECK (policy_version='1.0'),
    status text NOT NULL CHECK (status IN ('passed','blocked')),
    recommendation text NOT NULL CHECK (recommendation IN ('ready_for_final_authorization','blocked')),
    execution_decision text NOT NULL CHECK (execution_decision='no_go'),
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
    CONSTRAINT uat_activation_evaluation_pack_same_org_fk FOREIGN KEY (organization_id,approval_pack_id)
        REFERENCES public.uat_activation_approval_packs(organization_id,id),
    CONSTRAINT uat_activation_evaluation_actor_same_org_fk FOREIGN KEY (organization_id,run_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT uat_activation_evaluation_event_same_org_fk FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE INDEX uat_activation_approval_packs_history_idx ON public.uat_activation_approval_packs
    (organization_id,approval_pack_key,version DESC);
CREATE INDEX uat_activation_approval_decisions_history_idx ON public.uat_activation_approval_decisions
    (organization_id,approval_pack_id,decision_key,version DESC);
CREATE INDEX uat_activation_approval_evaluations_history_idx ON public.uat_activation_approval_evaluations
    (organization_id,approval_pack_id,created_at DESC);

ALTER TABLE public.uat_activation_approval_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uat_activation_approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uat_activation_approval_evaluations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.uat_activation_approval_packs,public.uat_activation_approval_decisions,
    public.uat_activation_approval_evaluations TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.uat_activation_approval_packs FOR SELECT TO dop_app
    USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.uat_activation_approval_decisions FOR SELECT TO dop_app
    USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.uat_activation_approval_evaluations FOR SELECT TO dop_app
    USING (organization_id=public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_uat_activation_approval_pack_definition_error(p_definition jsonb)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT CASE
  WHEN jsonb_typeof(p_definition)<>'object'
    OR p_definition->>'schemaVersion'<>'1.0'
    OR p_definition->>'sourceEnvironment'<>'DEV'
    OR p_definition->>'targetEnvironment'<>'UAT'
    OR p_definition->>'mode'<>'approval_evidence_only'
    OR p_definition->>'execution'<>'prohibited'
    OR p_definition->>'providerActions'<>'disabled'
    OR p_definition#>>'{target,region}'<>'Sydney'
    OR p_definition#>>'{target,retentionDays}'<>'30'
    OR p_definition#>>'{currentPolicy,monthlyBudgetUsd}'<>'0'
    OR p_definition#>>'{currentPolicy,paidResourceProvisioning}'<>'prohibited'
    OR p_definition#>>'{currentPolicy,dataMode}'<>'synthetic_only'
    OR p_definition#>>'{currentPolicy,realDataRequiresReapproval}'<>'true'
    OR p_definition#>>'{currentPolicy,provisioningAuthorized}'<>'false'
    OR p_definition#>>'{finalAuthorization,required}'<>'true'
    OR p_definition#>>'{finalAuthorization,handledBy}'<>'separate_stage'
    OR p_definition#>>'{finalAuthorization,status}'<>'not_requested'
    OR jsonb_typeof(p_definition->'requiredDecisions')<>'array'
    OR jsonb_array_length(p_definition->'requiredDecisions')<>4
    OR (SELECT count(DISTINCT item) FROM jsonb_array_elements_text(p_definition->'requiredDecisions') item
         WHERE item IN ('customer_confirmation','budget_and_cost','data_scope','provisioning_window'))<>4
    OR coalesce(p_definition#>>'{sourcePackage,id}','') !~ '^[0-9a-f-]{36}$'
    OR coalesce(p_definition#>>'{sourcePackage,definitionHash}','') !~ '^[0-9a-f]{64}$'
    OR coalesce(p_definition#>>'{sourcePackage,dryRunId}','') !~ '^[0-9a-f-]{36}$'
    OR coalesce(p_definition#>>'{inheritedEvidence,blueprintId}','') !~ '^[0-9a-f-]{36}$'
    OR coalesce(p_definition#>>'{inheritedEvidence,runtimeOwnerActorId}','') !~ '^[0-9a-f-]{36}$'
  THEN 'uat_activation_approval_pack_invalid' ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION public.dop_uat_activation_decision_error(
    p_decision_key text,p_status text,p_evidence jsonb,p_now timestamptz
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_reference text; v_start timestamptz; v_end timestamptz;
BEGIN
  IF p_decision_key NOT IN ('customer_confirmation','budget_and_cost','data_scope','provisioning_window')
     OR p_status NOT IN ('approved','rejected') OR jsonb_typeof(p_evidence)<>'object' THEN
    RETURN 'uat_activation_decision_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_evidence) key
      WHERE key ~* '(secret|token|password|credential|api.?key|connection.?string)') THEN
    RETURN 'uat_activation_decision_sensitive_evidence';
  END IF;
  v_reference:=p_evidence->>'reference';
  IF v_reference IS NULL OR char_length(v_reference)>300 OR v_reference !~* '^[a-z][a-z0-9+.-]*://[^[:space:]]+$' THEN
    RETURN 'uat_activation_decision_reference_invalid';
  END IF;
  IF p_status='rejected' THEN RETURN NULL; END IF;
  IF p_decision_key='customer_confirmation' THEN
    BEGIN
      IF (p_evidence->>'confirmedAt')::timestamptz>p_now OR (p_evidence->>'confirmedAt')::timestamptz<p_now-interval '365 days' THEN
        RETURN 'uat_activation_customer_confirmation_invalid';
      END IF;
    EXCEPTION WHEN OTHERS THEN RETURN 'uat_activation_customer_confirmation_invalid'; END;
  ELSIF p_decision_key='budget_and_cost' THEN
    BEGIN
      IF p_evidence->>'currency'<>'USD'
         OR (p_evidence->>'approvedMonthlyLimitUsd')::numeric<=0
         OR (p_evidence->>'approvedMonthlyLimitUsd')::numeric>1000
         OR (p_evidence->>'estimatedMonthlyCostUsd')::numeric<=0
         OR (p_evidence->>'estimatedMonthlyCostUsd')::numeric>(p_evidence->>'approvedMonthlyLimitUsd')::numeric THEN
        RETURN 'uat_activation_budget_and_cost_invalid';
      END IF;
    EXCEPTION WHEN OTHERS THEN RETURN 'uat_activation_budget_and_cost_invalid'; END;
  ELSIF p_decision_key='data_scope' THEN
    IF p_evidence->>'mode' NOT IN ('synthetic_only','real_data') OR p_evidence->>'region'<>'Sydney'
       OR p_evidence->>'retentionDays'<>'30'
       OR (p_evidence->>'mode'='real_data')<>(coalesce(p_evidence->>'realDataApproved','false')='true') THEN
      RETURN 'uat_activation_data_scope_invalid';
    END IF;
  ELSE
    BEGIN
      v_start:=(p_evidence->>'startsAt')::timestamptz; v_end:=(p_evidence->>'endsAt')::timestamptz;
      IF v_start<p_now OR v_end<=v_start OR v_end-v_start>interval '24 hours' THEN
        RETURN 'uat_activation_provisioning_window_invalid';
      END IF;
    EXCEPTION WHEN OTHERS THEN RETURN 'uat_activation_provisioning_window_invalid'; END;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_compile_uat_activation_approval_pack(
    p_actor_id uuid,p_package_id uuid,p_reason text,p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_organization_id uuid:=public.dop_require_active_admin(p_actor_id);
  v_package public.uat_provisioning_packages%ROWTYPE;
  v_package_run public.uat_provisioning_package_dry_runs%ROWTYPE;
  v_blueprint public.uat_environment_blueprints%ROWTYPE;
  v_existing public.uat_activation_approval_packs%ROWTYPE;
  v_definition jsonb; v_definition_error text; v_definition_hash text; v_fingerprint text;
  v_pack_key text; v_next_version integer; v_previous_id uuid;
  v_pack_id uuid:=gen_random_uuid(); v_event_id uuid:=gen_random_uuid();
BEGIN
  IF char_length(p_reason) NOT BETWEEN 12 AND 1000 OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  SELECT * INTO v_package FROM public.uat_provisioning_packages
   WHERE id=p_package_id AND organization_id=v_organization_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','uat_provisioning_package_not_found'); END IF;
  IF v_package.status<>'compiled' THEN RETURN jsonb_build_object('outcome','conflict','reason','uat_provisioning_package_not_current'); END IF;
  SELECT * INTO v_package_run FROM public.uat_provisioning_package_dry_runs
   WHERE package_id=v_package.id AND organization_id=v_organization_id ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_package_run.id IS NULL OR v_package_run.status<>'passed' OR v_package_run.execution_decision<>'no_go'
     OR v_package_run.package_definition_hash<>v_package.definition_hash THEN
    RETURN jsonb_build_object('outcome','conflict','reason','fresh_passing_uat_package_dry_run_required');
  END IF;
  SELECT * INTO STRICT v_blueprint FROM public.uat_environment_blueprints WHERE id=v_package.blueprint_id;
  v_pack_key:=v_package.package_key||'-activation-approval';
  v_definition:=jsonb_build_object(
    'schemaVersion','1.0','sourceEnvironment','DEV','targetEnvironment','UAT','mode','approval_evidence_only',
    'execution','prohibited','providerActions','disabled',
    'target',jsonb_build_object('region','Sydney','retentionDays',30),
    'currentPolicy',jsonb_build_object('monthlyBudgetUsd',0,'paidResourceProvisioning','prohibited',
      'dataMode','synthetic_only','realDataRequiresReapproval',true,'provisioningAuthorized',false),
    'sourcePackage',jsonb_build_object('id',v_package.id,'definitionHash',v_package.definition_hash,'dryRunId',v_package_run.id),
    'inheritedEvidence',jsonb_build_object('blueprintId',v_package.blueprint_id,
      'runtimeOwnerActorId',v_blueprint.definition#>>'{decisions,runtimeOwner,actorId}'),
    'requiredDecisions',jsonb_build_array('customer_confirmation','budget_and_cost','data_scope','provisioning_window'),
    'finalAuthorization',jsonb_build_object('required',true,'handledBy','separate_stage','status','not_requested'));
  v_definition_error:=public.dop_uat_activation_approval_pack_definition_error(v_definition);
  IF v_definition_error IS NOT NULL THEN RETURN jsonb_build_object('outcome','conflict','reason',v_definition_error); END IF;
  v_definition_hash:=encode(digest(v_definition::text,'sha256'),'hex');
  v_fingerprint:=encode(digest(concat_ws('|',p_package_id::text,p_reason),'sha256'),'hex');
  SELECT * INTO v_existing FROM public.uat_activation_approval_packs
   WHERE organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint=v_fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','approvalPackId',v_existing.id,'version',v_existing.version,'executionDecision','no_go'); END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
  END IF;
  IF EXISTS (SELECT 1 FROM public.uat_activation_approval_packs candidate
      WHERE candidate.organization_id=v_organization_id AND candidate.provisioning_package_id=v_package.id
        AND candidate.definition_hash=v_definition_hash) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','uat_activation_approval_pack_unchanged');
  END IF;
  SELECT coalesce(max(version),0)+1 INTO v_next_version FROM public.uat_activation_approval_packs
   WHERE organization_id=v_organization_id AND approval_pack_key=v_pack_key;
  SELECT id INTO v_previous_id FROM public.uat_activation_approval_packs
   WHERE organization_id=v_organization_id AND approval_pack_key=v_pack_key ORDER BY version DESC LIMIT 1;
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
      aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (v_event_id,v_organization_id,p_idempotency_key||':event','UatActivationApprovalPack.Compiled',1,
      'uat_activation_approval_pack',v_pack_id,p_correlation_id,p_actor_id,'ops-uat-activation',
      jsonb_build_object('sourcePackageId',v_package.id,'definitionHash',v_definition_hash,
        'requiredDecisionCount',4,'executionDecision','no_go','resourcesCreated',0,'externalCalls',0),p_now);
  UPDATE public.uat_activation_approval_packs SET status='superseded'
   WHERE organization_id=v_organization_id AND approval_pack_key=v_pack_key AND status='draft';
  INSERT INTO public.uat_activation_approval_packs (id,organization_id,approval_pack_key,version,status,
      provisioning_package_id,provisioning_package_definition_hash,definition,definition_hash,previous_approval_pack_id,
      compiled_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_pack_id,v_organization_id,v_pack_key,v_next_version,'draft',v_package.id,v_package.definition_hash,
      v_definition,v_definition_hash,v_previous_id,p_actor_id,p_reason,p_idempotency_key,v_fingerprint,v_event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','approvalPackId',v_pack_id,'version',v_next_version,
    'status','draft','pendingDecisionCount',4,'executionDecision','no_go','provisioningAuthorized',false,
    'resourcesCreated',0,'externalCalls',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_record_uat_activation_approval_decision(
    p_actor_id uuid,p_approval_pack_id uuid,p_decision_key text,p_status text,p_evidence jsonb,p_reason text,
    p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_organization_id uuid:=public.dop_require_active_admin(p_actor_id);
  v_pack public.uat_activation_approval_packs%ROWTYPE;
  v_existing public.uat_activation_approval_decisions%ROWTYPE;
  v_error text; v_evidence_hash text; v_fingerprint text; v_next_version integer; v_previous_id uuid;
  v_decision_id uuid:=gen_random_uuid(); v_event_id uuid:=gen_random_uuid();
BEGIN
  IF char_length(p_reason) NOT BETWEEN 12 AND 1000 OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  SELECT * INTO v_pack FROM public.uat_activation_approval_packs
   WHERE id=p_approval_pack_id AND organization_id=v_organization_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','uat_activation_approval_pack_not_found'); END IF;
  IF v_pack.status<>'draft' THEN RETURN jsonb_build_object('outcome','conflict','reason','uat_activation_approval_pack_not_current'); END IF;
  v_error:=public.dop_uat_activation_decision_error(p_decision_key,p_status,p_evidence,p_now);
  IF v_error IS NOT NULL THEN RETURN jsonb_build_object('outcome','conflict','reason',v_error); END IF;
  v_evidence_hash:=encode(digest(p_evidence::text,'sha256'),'hex');
  v_fingerprint:=encode(digest(concat_ws('|',p_approval_pack_id::text,p_decision_key,p_status,v_evidence_hash,p_reason),'sha256'),'hex');
  SELECT * INTO v_existing FROM public.uat_activation_approval_decisions
   WHERE organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint=v_fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','decisionId',v_existing.id,'version',v_existing.version,'status',v_existing.status); END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
  END IF;
  SELECT coalesce(max(version),0)+1 INTO v_next_version FROM public.uat_activation_approval_decisions
   WHERE organization_id=v_organization_id AND approval_pack_id=v_pack.id AND decision_key=p_decision_key;
  SELECT id INTO v_previous_id FROM public.uat_activation_approval_decisions
   WHERE organization_id=v_organization_id AND approval_pack_id=v_pack.id AND decision_key=p_decision_key
   ORDER BY version DESC LIMIT 1;
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
      aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (v_event_id,v_organization_id,p_idempotency_key||':event','UatActivationApprovalDecision.Recorded',1,
      'uat_activation_approval_pack',v_pack.id,p_correlation_id,p_actor_id,'ops-uat-activation',
      jsonb_build_object('decisionId',v_decision_id,'decisionKey',p_decision_key,'status',p_status,
        'evidenceHash',v_evidence_hash,'executionDecision','no_go'),p_now);
  INSERT INTO public.uat_activation_approval_decisions (id,organization_id,approval_pack_id,decision_key,version,status,
      evidence,evidence_hash,previous_decision_id,decided_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_decision_id,v_organization_id,v_pack.id,p_decision_key,v_next_version,p_status,p_evidence,
      v_evidence_hash,v_previous_id,p_actor_id,p_reason,p_idempotency_key,v_fingerprint,v_event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','decisionId',v_decision_id,'decisionKey',p_decision_key,
    'version',v_next_version,'status',p_status,'executionDecision','no_go','provisioningAuthorized',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_evaluate_uat_activation_approval_pack(
    p_actor_id uuid,p_approval_pack_id uuid,p_reason text,p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_organization_id uuid:=public.dop_require_active_manager(p_actor_id);
  v_pack public.uat_activation_approval_packs%ROWTYPE;
  v_package public.uat_provisioning_packages%ROWTYPE;
  v_existing public.uat_activation_approval_evaluations%ROWTYPE;
  v_source_valid boolean; v_customer boolean; v_budget boolean; v_data boolean; v_window boolean;
  v_blockers integer; v_status text; v_recommendation text; v_checks jsonb; v_fingerprint text;
  v_effects jsonb:=jsonb_build_object('environmentsCreated',0,'servicesCreated',0,'databasesCreated',0,
    'storageBucketsCreated',0,'domainsCreated',0,'secretValuesResolved',0,'schedulersCreated',0,
    'dataCopied',false,'runtimeStarted',false,'externalCalls',0,'notificationsCreated',0,'estimatedAddedMonthlyCostUsd',0);
  v_evaluation_id uuid:=gen_random_uuid(); v_event_id uuid:=gen_random_uuid();
BEGIN
  IF char_length(p_reason) NOT BETWEEN 12 AND 1000 OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  v_fingerprint:=encode(digest(concat_ws('|',p_approval_pack_id::text,p_reason),'sha256'),'hex');
  SELECT * INTO v_existing FROM public.uat_activation_approval_evaluations
   WHERE organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint=v_fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','evaluationId',v_existing.id,
      'status',v_existing.status,'recommendation',v_existing.recommendation,'executionDecision','no_go','blockerCount',v_existing.blocker_count); END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
  END IF;
  SELECT * INTO v_pack FROM public.uat_activation_approval_packs
   WHERE id=p_approval_pack_id AND organization_id=v_organization_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','uat_activation_approval_pack_not_found'); END IF;
  IF v_pack.status<>'draft' OR public.dop_uat_activation_approval_pack_definition_error(v_pack.definition) IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','conflict','reason','uat_activation_approval_pack_not_current');
  END IF;
  SELECT * INTO v_package FROM public.uat_provisioning_packages
   WHERE id=v_pack.provisioning_package_id AND organization_id=v_organization_id;
  v_source_valid:=v_package.status='compiled' AND v_package.definition_hash=v_pack.provisioning_package_definition_hash
    AND EXISTS (SELECT 1 FROM public.uat_provisioning_package_dry_runs run WHERE run.package_id=v_package.id
      AND run.package_definition_hash=v_package.definition_hash AND run.status='passed' AND run.execution_decision='no_go');
  SELECT coalesce((SELECT decision.status='approved' FROM public.uat_activation_approval_decisions decision
    WHERE decision.approval_pack_id=v_pack.id AND decision.decision_key='customer_confirmation' ORDER BY version DESC LIMIT 1),false) INTO v_customer;
  SELECT coalesce((SELECT decision.status='approved' FROM public.uat_activation_approval_decisions decision
    WHERE decision.approval_pack_id=v_pack.id AND decision.decision_key='budget_and_cost' ORDER BY version DESC LIMIT 1),false) INTO v_budget;
  SELECT coalesce((SELECT decision.status='approved' FROM public.uat_activation_approval_decisions decision
    WHERE decision.approval_pack_id=v_pack.id AND decision.decision_key='data_scope' ORDER BY version DESC LIMIT 1),false) INTO v_data;
  SELECT coalesce((SELECT decision.status='approved' FROM public.uat_activation_approval_decisions decision
    WHERE decision.approval_pack_id=v_pack.id AND decision.decision_key='provisioning_window' ORDER BY version DESC LIMIT 1),false) INTO v_window;
  v_blockers:=(NOT v_source_valid)::integer+(NOT v_customer)::integer+(NOT v_budget)::integer+(NOT v_data)::integer+(NOT v_window)::integer;
  v_status:=CASE WHEN v_blockers=0 THEN 'passed' ELSE 'blocked' END;
  v_recommendation:=CASE WHEN v_blockers=0 THEN 'ready_for_final_authorization' ELSE 'blocked' END;
  v_checks:=jsonb_build_array(
    jsonb_build_object('code','source_package_current_and_verified','status',CASE WHEN v_source_valid THEN 'passed' ELSE 'blocked' END,'evidence',jsonb_build_object('packageId',v_package.id,'definitionHash',v_pack.provisioning_package_definition_hash)),
    jsonb_build_object('code','zero_budget_gate_active','status','passed','evidence',v_pack.definition->'currentPolicy'),
    jsonb_build_object('code','customer_confirmation','status',CASE WHEN v_customer THEN 'passed' ELSE 'blocked' END,'evidence',jsonb_build_object('approved',v_customer)),
    jsonb_build_object('code','budget_and_cost','status',CASE WHEN v_budget THEN 'passed' ELSE 'blocked' END,'evidence',jsonb_build_object('approved',v_budget)),
    jsonb_build_object('code','data_scope','status',CASE WHEN v_data THEN 'passed' ELSE 'blocked' END,'evidence',jsonb_build_object('approved',v_data)),
    jsonb_build_object('code','provisioning_window','status',CASE WHEN v_window THEN 'passed' ELSE 'blocked' END,'evidence',jsonb_build_object('approved',v_window)),
    jsonb_build_object('code','final_authorization_separate','status','passed','evidence',jsonb_build_object('required',true,'requested',false,'provisioningAuthorized',false)),
    jsonb_build_object('code','zero_side_effects','status','passed','evidence',v_effects));
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
      aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (v_event_id,v_organization_id,p_idempotency_key||':event','UatActivationApprovalPack.Evaluated',1,
      'uat_activation_approval_pack',v_pack.id,p_correlation_id,p_actor_id,'ops-uat-activation',
      jsonb_build_object('status',v_status,'recommendation',v_recommendation,'executionDecision','no_go',
        'blockerCount',v_blockers,'sideEffects',v_effects),p_now);
  INSERT INTO public.uat_activation_approval_evaluations (id,organization_id,approval_pack_id,
      approval_pack_definition_hash,policy_version,status,recommendation,execution_decision,blocker_count,checks,
      side_effects,run_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_evaluation_id,v_organization_id,v_pack.id,v_pack.definition_hash,'1.0',v_status,v_recommendation,
      'no_go',v_blockers,v_checks,v_effects,p_actor_id,p_reason,p_idempotency_key,v_fingerprint,v_event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','evaluationId',v_evaluation_id,'status',v_status,
    'recommendation',v_recommendation,'executionDecision','no_go','blockerCount',v_blockers,
    'provisioningAuthorized',false,'sideEffects',v_effects);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_uat_activation_approval_pack_definition_error(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_uat_activation_decision_error(text,text,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_compile_uat_activation_approval_pack(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_record_uat_activation_approval_decision(uuid,uuid,text,text,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_evaluate_uat_activation_approval_pack(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_compile_uat_activation_approval_pack(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_record_uat_activation_approval_decision(uuid,uuid,text,text,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_evaluate_uat_activation_approval_pack(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;

COMMENT ON TABLE public.uat_activation_approval_packs IS 'M34 immutable UAT activation approval evidence packs; never provisioning authorization.';
COMMENT ON TABLE public.uat_activation_approval_decisions IS 'Append-only explicit decision evidence; references and hashes only, no secret material.';
COMMENT ON TABLE public.uat_activation_approval_evaluations IS 'Append-only NO-GO evaluations; passing means ready to request a separate final authorization only.';

COMMIT;
