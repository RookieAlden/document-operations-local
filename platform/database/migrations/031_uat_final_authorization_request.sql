BEGIN;

-- M35 compiles an execution-free final-authorization request draft and reviews its change set.
-- It intentionally provides no submit, approve, or execute function.
CREATE TABLE public.uat_final_authorization_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    request_key text NOT NULL CHECK (request_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
    version integer NOT NULL CHECK (version>0),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','superseded')),
    approval_pack_id uuid NOT NULL REFERENCES public.uat_activation_approval_packs(id),
    approval_pack_definition_hash text NOT NULL CHECK (approval_pack_definition_hash ~ '^[0-9a-f]{64}$'),
    approval_evaluation_id uuid NOT NULL REFERENCES public.uat_activation_approval_evaluations(id),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    change_set jsonb NOT NULL CHECK (jsonb_typeof(change_set)='array'),
    change_set_hash text NOT NULL CHECK (change_set_hash ~ '^[0-9a-f]{64}$'),
    previous_request_id uuid,
    compiled_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    UNIQUE (organization_id,request_key,version),
    UNIQUE (organization_id,approval_pack_id,definition_hash),
    CONSTRAINT uat_final_request_pack_same_org_fk FOREIGN KEY (organization_id,approval_pack_id)
        REFERENCES public.uat_activation_approval_packs(organization_id,id),
    CONSTRAINT uat_final_request_previous_same_org_fk FOREIGN KEY (organization_id,previous_request_id)
        REFERENCES public.uat_final_authorization_requests(organization_id,id),
    CONSTRAINT uat_final_request_actor_same_org_fk FOREIGN KEY (organization_id,compiled_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT uat_final_request_event_same_org_fk FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE TABLE public.uat_final_authorization_evaluations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    request_id uuid NOT NULL REFERENCES public.uat_final_authorization_requests(id),
    request_definition_hash text NOT NULL CHECK (request_definition_hash ~ '^[0-9a-f]{64}$'),
    policy_version text NOT NULL CHECK (policy_version='1.0'),
    status text NOT NULL CHECK (status IN ('ready','blocked')),
    recommendation text NOT NULL CHECK (recommendation IN ('ready_for_submission','blocked')),
    execution_decision text NOT NULL CHECK (execution_decision='no_go'),
    blocker_count integer NOT NULL CHECK (blocker_count>=0),
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
    CONSTRAINT uat_final_evaluation_request_same_org_fk FOREIGN KEY (organization_id,request_id)
        REFERENCES public.uat_final_authorization_requests(organization_id,id),
    CONSTRAINT uat_final_evaluation_actor_same_org_fk FOREIGN KEY (organization_id,run_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT uat_final_evaluation_event_same_org_fk FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id)
);

CREATE INDEX uat_final_authorization_requests_history_idx ON public.uat_final_authorization_requests
    (organization_id,request_key,version DESC);
CREATE INDEX uat_final_authorization_evaluations_history_idx ON public.uat_final_authorization_evaluations
    (organization_id,request_id,created_at DESC);

ALTER TABLE public.uat_final_authorization_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uat_final_authorization_evaluations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.uat_final_authorization_requests,public.uat_final_authorization_evaluations TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.uat_final_authorization_requests FOR SELECT TO dop_app
    USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.uat_final_authorization_evaluations FOR SELECT TO dop_app
    USING (organization_id=public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_uat_final_authorization_request_definition_error(p_definition jsonb)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT CASE
  WHEN jsonb_typeof(p_definition)<>'object'
    OR p_definition->>'schemaVersion'<>'1.0'
    OR p_definition->>'sourceEnvironment'<>'DEV'
    OR p_definition->>'targetEnvironment'<>'UAT'
    OR p_definition->>'mode'<>'authorization_request_draft'
    OR p_definition->>'execution'<>'prohibited'
    OR p_definition->>'providerActions'<>'disabled'
    OR p_definition->>'executor'<>'absent'
    OR p_definition#>>'{target,region}'<>'Sydney'
    OR p_definition#>>'{target,retentionDays}'<>'30'
    OR p_definition#>>'{currentPolicy,monthlyBudgetUsd}'<>'0'
    OR p_definition#>>'{currentPolicy,paidResourceProvisioning}'<>'prohibited'
    OR p_definition#>>'{currentPolicy,dataMode}'<>'synthetic_only'
    OR p_definition#>>'{currentPolicy,realDataRequiresReapproval}'<>'true'
    OR p_definition#>>'{currentPolicy,provisioningAuthorized}'<>'false'
    OR p_definition#>>'{riskControls,secretValues}'<>'prohibited'
    OR p_definition#>>'{riskControls,dataCopy}'<>'none'
    OR p_definition#>>'{riskControls,externalIngress}'<>'disabled'
    OR p_definition#>>'{riskControls,externalDelivery}'<>'disabled'
    OR p_definition#>>'{riskControls,rollback}'<>'remove_unexposed_target'
    OR p_definition#>>'{riskControls,finalAuthorizationRequired}'<>'true'
    OR p_definition#>>'{requestGate,status}'<>'not_submitted'
    OR p_definition#>>'{requestGate,submissionAllowed}'<>'false'
    OR p_definition#>>'{requestGate,authorizationGranted}'<>'false'
    OR jsonb_typeof(p_definition->'changeSet')<>'array'
    OR jsonb_array_length(p_definition->'changeSet')<>10
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_definition->'changeSet') step WHERE step->>'execution'<>'disabled')
    OR coalesce(p_definition#>>'{sourceApprovalPack,id}','') !~ '^[0-9a-f-]{36}$'
    OR coalesce(p_definition#>>'{sourceApprovalPack,definitionHash}','') !~ '^[0-9a-f]{64}$'
    OR coalesce(p_definition#>>'{sourceApprovalPack,evaluationId}','') !~ '^[0-9a-f-]{36}$'
    OR p_definition#>>'{sourceApprovalPack,evaluationStatus}' NOT IN ('passed','blocked')
    OR coalesce(p_definition#>>'{sourceApprovalPack,blockerCount}','') !~ '^[0-9]+$'
  THEN 'uat_final_authorization_request_invalid' ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION public.dop_compile_uat_final_authorization_request(
    p_actor_id uuid,p_approval_pack_id uuid,p_reason text,p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_organization_id uuid:=public.dop_require_active_admin(p_actor_id);
  v_pack public.uat_activation_approval_packs%ROWTYPE;
  v_evaluation public.uat_activation_approval_evaluations%ROWTYPE;
  v_existing public.uat_final_authorization_requests%ROWTYPE;
  v_customer jsonb; v_budget jsonb; v_data jsonb; v_window jsonb;
  v_change_set jsonb; v_definition jsonb; v_error text; v_definition_hash text; v_change_set_hash text; v_fingerprint text;
  v_request_key text; v_next_version integer; v_previous_id uuid;
  v_request_id uuid:=gen_random_uuid(); v_event_id uuid:=gen_random_uuid();
BEGIN
  IF char_length(p_reason) NOT BETWEEN 12 AND 1000 OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  SELECT * INTO v_pack FROM public.uat_activation_approval_packs
   WHERE id=p_approval_pack_id AND organization_id=v_organization_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','uat_activation_approval_pack_not_found'); END IF;
  IF v_pack.status<>'draft' THEN RETURN jsonb_build_object('outcome','conflict','reason','uat_activation_approval_pack_not_current'); END IF;
  SELECT * INTO v_evaluation FROM public.uat_activation_approval_evaluations
   WHERE approval_pack_id=v_pack.id AND organization_id=v_organization_id ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_evaluation.id IS NULL OR v_evaluation.approval_pack_definition_hash<>v_pack.definition_hash THEN
    RETURN jsonb_build_object('outcome','conflict','reason','fresh_uat_activation_evaluation_required');
  END IF;
  SELECT latest.evidence INTO v_customer FROM (SELECT decision.status,decision.evidence
    FROM public.uat_activation_approval_decisions decision WHERE decision.approval_pack_id=v_pack.id
      AND decision.decision_key='customer_confirmation' ORDER BY version DESC LIMIT 1) latest WHERE latest.status='approved';
  SELECT latest.evidence INTO v_budget FROM (SELECT decision.status,decision.evidence
    FROM public.uat_activation_approval_decisions decision WHERE decision.approval_pack_id=v_pack.id
      AND decision.decision_key='budget_and_cost' ORDER BY version DESC LIMIT 1) latest WHERE latest.status='approved';
  SELECT latest.evidence INTO v_data FROM (SELECT decision.status,decision.evidence
    FROM public.uat_activation_approval_decisions decision WHERE decision.approval_pack_id=v_pack.id
      AND decision.decision_key='data_scope' ORDER BY version DESC LIMIT 1) latest WHERE latest.status='approved';
  SELECT latest.evidence INTO v_window FROM (SELECT decision.status,decision.evidence
    FROM public.uat_activation_approval_decisions decision WHERE decision.approval_pack_id=v_pack.id
      AND decision.decision_key='provisioning_window' ORDER BY version DESC LIMIT 1) latest WHERE latest.status='approved';
  v_change_set:=jsonb_build_array(
    jsonb_build_object('sequence',1,'action','verify_activation_approval_evidence','execution','disabled'),
    jsonb_build_object('sequence',2,'action','verify_provider_quote_and_budget','execution','disabled'),
    jsonb_build_object('sequence',3,'action','review_m33_to_proposed_change_diff','execution','disabled'),
    jsonb_build_object('sequence',4,'action','create_railway_uat_environment','execution','disabled'),
    jsonb_build_object('sequence',5,'action','create_supabase_sydney_project','execution','disabled'),
    jsonb_build_object('sequence',6,'action','apply_ordered_migrations','execution','disabled'),
    jsonb_build_object('sequence',7,'action','materialize_secret_references','execution','disabled'),
    jsonb_build_object('sequence',8,'action','configure_thirty_day_retention','execution','disabled'),
    jsonb_build_object('sequence',9,'action','run_synthetic_acceptance','execution','disabled'),
    jsonb_build_object('sequence',10,'action','rollback_unexposed_target','execution','disabled'));
  v_definition:=jsonb_build_object(
    'schemaVersion','1.0','sourceEnvironment','DEV','targetEnvironment','UAT','mode','authorization_request_draft',
    'execution','prohibited','providerActions','disabled','executor','absent',
    'sourceApprovalPack',jsonb_build_object('id',v_pack.id,'definitionHash',v_pack.definition_hash,
      'evaluationId',v_evaluation.id,'evaluationStatus',v_evaluation.status,'blockerCount',v_evaluation.blocker_count),
    'target',jsonb_build_object('region','Sydney','retentionDays',30),'currentPolicy',v_pack.definition->'currentPolicy',
    'proposedPolicy',jsonb_build_object(
      'customerConfirmed',v_customer IS NOT NULL,
      'monthlyBudgetUsd',CASE WHEN v_budget IS NULL THEN NULL ELSE (v_budget->>'approvedMonthlyLimitUsd')::numeric END,
      'estimatedMonthlyCostUsd',CASE WHEN v_budget IS NULL THEN NULL ELSE (v_budget->>'estimatedMonthlyCostUsd')::numeric END,
      'dataMode',CASE WHEN v_data IS NULL THEN NULL ELSE v_data->>'mode' END,
      'realDataApproved',coalesce((v_data->>'realDataApproved')::boolean,false),
      'windowStartsAt',CASE WHEN v_window IS NULL THEN NULL ELSE v_window->>'startsAt' END,
      'windowEndsAt',CASE WHEN v_window IS NULL THEN NULL ELSE v_window->>'endsAt' END),
    'changeSet',v_change_set,
    'riskControls',jsonb_build_object('secretValues','prohibited','dataCopy','none','externalIngress','disabled',
      'externalDelivery','disabled','rollback','remove_unexposed_target','finalAuthorizationRequired',true),
    'requestGate',jsonb_build_object('status','not_submitted','submissionAllowed',false,'authorizationGranted',false));
  v_error:=public.dop_uat_final_authorization_request_definition_error(v_definition);
  IF v_error IS NOT NULL THEN RETURN jsonb_build_object('outcome','conflict','reason',v_error); END IF;
  v_definition_hash:=encode(digest(v_definition::text,'sha256'),'hex');
  v_change_set_hash:=encode(digest(v_change_set::text,'sha256'),'hex');
  v_fingerprint:=encode(digest(concat_ws('|',p_approval_pack_id::text,v_evaluation.id::text,p_reason),'sha256'),'hex');
  SELECT * INTO v_existing FROM public.uat_final_authorization_requests
   WHERE organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint=v_fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','requestId',v_existing.id,'version',v_existing.version,'executionDecision','no_go'); END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
  END IF;
  IF EXISTS (SELECT 1 FROM public.uat_final_authorization_requests candidate
      WHERE candidate.organization_id=v_organization_id AND candidate.approval_pack_id=v_pack.id
        AND candidate.definition_hash=v_definition_hash) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','uat_final_authorization_request_unchanged');
  END IF;
  v_request_key:=v_pack.approval_pack_key||'-final-request';
  SELECT coalesce(max(version),0)+1 INTO v_next_version FROM public.uat_final_authorization_requests
   WHERE organization_id=v_organization_id AND request_key=v_request_key;
  SELECT id INTO v_previous_id FROM public.uat_final_authorization_requests
   WHERE organization_id=v_organization_id AND request_key=v_request_key ORDER BY version DESC LIMIT 1;
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
      aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (v_event_id,v_organization_id,p_idempotency_key||':event','UatFinalAuthorizationRequest.Compiled',1,
      'uat_final_authorization_request',v_request_id,p_correlation_id,p_actor_id,'ops-uat-final-authorization',
      jsonb_build_object('approvalPackId',v_pack.id,'definitionHash',v_definition_hash,'changeSetHash',v_change_set_hash,
        'sourceBlockerCount',v_evaluation.blocker_count,'submissionAllowed',false,'executionDecision','no_go','externalCalls',0),p_now);
  UPDATE public.uat_final_authorization_requests SET status='superseded'
   WHERE organization_id=v_organization_id AND request_key=v_request_key AND status='draft';
  INSERT INTO public.uat_final_authorization_requests (id,organization_id,request_key,version,status,approval_pack_id,
      approval_pack_definition_hash,approval_evaluation_id,definition,definition_hash,change_set,change_set_hash,
      previous_request_id,compiled_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_request_id,v_organization_id,v_request_key,v_next_version,'draft',v_pack.id,v_pack.definition_hash,
      v_evaluation.id,v_definition,v_definition_hash,v_change_set,v_change_set_hash,v_previous_id,p_actor_id,p_reason,
      p_idempotency_key,v_fingerprint,v_event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','requestId',v_request_id,'version',v_next_version,'status','draft',
    'blockerCount',v_evaluation.blocker_count,'submissionAllowed',false,'authorizationGranted',false,
    'executionDecision','no_go','resourcesCreated',0,'externalCalls',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_evaluate_uat_final_authorization_request(
    p_actor_id uuid,p_request_id uuid,p_reason text,p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_organization_id uuid:=public.dop_require_active_manager(p_actor_id);
  v_request public.uat_final_authorization_requests%ROWTYPE;
  v_pack public.uat_activation_approval_packs%ROWTYPE;
  v_activation public.uat_activation_approval_evaluations%ROWTYPE;
  v_existing public.uat_final_authorization_evaluations%ROWTYPE;
  v_source_current boolean; v_customer boolean; v_budget boolean; v_data boolean; v_window boolean;
  v_blockers integer; v_status text; v_recommendation text; v_checks jsonb; v_fingerprint text;
  v_effects jsonb:=jsonb_build_object('environmentsCreated',0,'servicesCreated',0,'databasesCreated',0,
    'storageBucketsCreated',0,'domainsCreated',0,'secretValuesResolved',0,'schedulersCreated',0,
    'migrationsApplied',0,'dataCopied',false,'runtimeStarted',false,'externalCalls',0,'notificationsCreated',0,
    'estimatedAddedMonthlyCostUsd',0);
  v_evaluation_id uuid:=gen_random_uuid(); v_event_id uuid:=gen_random_uuid();
BEGIN
  IF char_length(p_reason) NOT BETWEEN 12 AND 1000 OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  v_fingerprint:=encode(digest(concat_ws('|',p_request_id::text,p_reason),'sha256'),'hex');
  SELECT * INTO v_existing FROM public.uat_final_authorization_evaluations
   WHERE organization_id=v_organization_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint=v_fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','evaluationId',v_existing.id,
      'status',v_existing.status,'recommendation',v_existing.recommendation,'executionDecision','no_go','blockerCount',v_existing.blocker_count); END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
  END IF;
  SELECT * INTO v_request FROM public.uat_final_authorization_requests
   WHERE id=p_request_id AND organization_id=v_organization_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','uat_final_authorization_request_not_found'); END IF;
  IF v_request.status<>'draft' OR public.dop_uat_final_authorization_request_definition_error(v_request.definition) IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','conflict','reason','uat_final_authorization_request_not_current');
  END IF;
  SELECT * INTO v_pack FROM public.uat_activation_approval_packs WHERE id=v_request.approval_pack_id AND organization_id=v_organization_id;
  SELECT * INTO v_activation FROM public.uat_activation_approval_evaluations
   WHERE approval_pack_id=v_pack.id ORDER BY created_at DESC,id DESC LIMIT 1;
  v_source_current:=v_pack.status='draft' AND v_pack.definition_hash=v_request.approval_pack_definition_hash
    AND v_activation.id=v_request.approval_evaluation_id
    AND v_activation.id::text=v_request.definition#>>'{sourceApprovalPack,evaluationId}';
  v_customer:=coalesce((v_request.definition#>>'{proposedPolicy,customerConfirmed}')::boolean,false);
  v_budget:=coalesce(coalesce((v_request.definition#>>'{proposedPolicy,monthlyBudgetUsd}')::numeric,0)>0
    AND coalesce((v_request.definition#>>'{proposedPolicy,estimatedMonthlyCostUsd}')::numeric,0)>0
    AND (v_request.definition#>>'{proposedPolicy,estimatedMonthlyCostUsd}')::numeric<=(v_request.definition#>>'{proposedPolicy,monthlyBudgetUsd}')::numeric,false);
  v_data:=coalesce(v_request.definition#>>'{proposedPolicy,dataMode}' IN ('synthetic_only','real_data')
    AND ((v_request.definition#>>'{proposedPolicy,dataMode}')='real_data')=coalesce((v_request.definition#>>'{proposedPolicy,realDataApproved}')::boolean,false),false);
  v_window:=v_request.definition#>>'{proposedPolicy,windowStartsAt}' IS NOT NULL
    AND v_request.definition#>>'{proposedPolicy,windowEndsAt}' IS NOT NULL;
  v_blockers:=(NOT v_source_current)::integer+(NOT v_customer)::integer+(NOT v_budget)::integer+(NOT v_data)::integer+(NOT v_window)::integer;
  v_status:=CASE WHEN v_blockers=0 THEN 'ready' ELSE 'blocked' END;
  v_recommendation:=CASE WHEN v_blockers=0 THEN 'ready_for_submission' ELSE 'blocked' END;
  v_checks:=jsonb_build_array(
    jsonb_build_object('code','activation_snapshot_current','status',CASE WHEN v_source_current THEN 'passed' ELSE 'blocked' END,'evidence',jsonb_build_object('approvalPackId',v_pack.id,'evaluationId',v_activation.id)),
    jsonb_build_object('code','customer_confirmation_frozen','status',CASE WHEN v_customer THEN 'passed' ELSE 'blocked' END,'evidence',jsonb_build_object('confirmed',v_customer)),
    jsonb_build_object('code','positive_budget_covers_cost','status',CASE WHEN v_budget THEN 'passed' ELSE 'blocked' END,'evidence',v_request.definition->'proposedPolicy'),
    jsonb_build_object('code','data_scope_explicit','status',CASE WHEN v_data THEN 'passed' ELSE 'blocked' END,'evidence',v_request.definition->'proposedPolicy'),
    jsonb_build_object('code','bounded_execution_window','status',CASE WHEN v_window THEN 'passed' ELSE 'blocked' END,'evidence',v_request.definition->'proposedPolicy'),
    jsonb_build_object('code','all_change_steps_disabled','status','passed','evidence',jsonb_build_object('steps',10,'enabledSteps',0)),
    jsonb_build_object('code','risk_controls_locked','status','passed','evidence',v_request.definition->'riskControls'),
    jsonb_build_object('code','request_not_submitted','status','passed','evidence',v_request.definition->'requestGate'),
    jsonb_build_object('code','zero_side_effects','status','passed','evidence',v_effects));
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
      aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (v_event_id,v_organization_id,p_idempotency_key||':event','UatFinalAuthorizationRequest.Evaluated',1,
      'uat_final_authorization_request',v_request.id,p_correlation_id,p_actor_id,'ops-uat-final-authorization',
      jsonb_build_object('status',v_status,'recommendation',v_recommendation,'executionDecision','no_go',
        'blockerCount',v_blockers,'submissionAllowed',false,'authorizationGranted',false,'sideEffects',v_effects),p_now);
  INSERT INTO public.uat_final_authorization_evaluations (id,organization_id,request_id,request_definition_hash,
      policy_version,status,recommendation,execution_decision,blocker_count,checks,side_effects,run_by_actor_id,
      reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_evaluation_id,v_organization_id,v_request.id,v_request.definition_hash,'1.0',v_status,v_recommendation,
      'no_go',v_blockers,v_checks,v_effects,p_actor_id,p_reason,p_idempotency_key,v_fingerprint,v_event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','evaluationId',v_evaluation_id,'status',v_status,
    'recommendation',v_recommendation,'executionDecision','no_go','blockerCount',v_blockers,
    'submissionAllowed',false,'authorizationGranted',false,'sideEffects',v_effects);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_uat_final_authorization_request_definition_error(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_compile_uat_final_authorization_request(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_evaluate_uat_final_authorization_request(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_compile_uat_final_authorization_request(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_evaluate_uat_final_authorization_request(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;

COMMENT ON TABLE public.uat_final_authorization_requests IS 'M35 append-only final-authorization request drafts; submission and execution are absent.';
COMMENT ON TABLE public.uat_final_authorization_evaluations IS 'M35 execution-free change reviews; ready never grants authorization or performs provider actions.';

COMMIT;
