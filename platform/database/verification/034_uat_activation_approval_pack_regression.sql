BEGIN;

DO $$
DECLARE
  v_org public.organizations%ROWTYPE;
  v_owner_id uuid; v_reviewer_id uuid;
  v_source public.uat_provisioning_packages%ROWTYPE;
  v_source_definition jsonb; v_source_definition_hash text;
  v_package_id uuid:=gen_random_uuid(); v_package_event_id uuid:=gen_random_uuid(); v_run_event_id uuid:=gen_random_uuid();
  v_pack_id uuid; v_result jsonb; v_now timestamptz:=date_trunc('second',now());
  v_notifications_before integer; v_notifications_after integer;
BEGIN
  SELECT * INTO v_org FROM public.organizations ORDER BY created_at,id LIMIT 1;
  IF v_org.id IS NULL THEN RAISE EXCEPTION 'M34 requires one DEV organization'; END IF;
  PERFORM public.dop_set_organization_context(v_org.organization_key);
  SELECT id INTO v_owner_id FROM public.actors WHERE organization_id=v_org.id AND actor_type='admin' AND status='active' ORDER BY created_at,id LIMIT 1;
  SELECT id INTO v_reviewer_id FROM public.actors WHERE organization_id=v_org.id AND actor_type IN ('manager','admin') AND status='active' ORDER BY actor_type DESC,created_at,id LIMIT 1;
  SELECT * INTO v_source FROM public.uat_provisioning_packages WHERE organization_id=v_org.id AND status='compiled' ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_owner_id IS NULL OR v_reviewer_id IS NULL OR v_source.id IS NULL THEN
    RAISE EXCEPTION 'M34 requires active admin, reviewer and compiled M33 package';
  END IF;
  SELECT count(*) INTO v_notifications_before FROM public.notifications WHERE organization_id=v_org.id;
  v_source_definition:=v_source.definition||jsonb_build_object('verificationNonce',v_package_id);
  v_source_definition_hash:=encode(digest(v_source_definition::text,'sha256'),'hex');
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (v_package_event_id,v_org.id,'m34-verification-source-event-'||v_package_id,'UatProvisioningPackage.Compiled',1,
    'uat_provisioning_package',v_package_id,gen_random_uuid(),v_owner_id,'m34-verification','{}',v_now);
  INSERT INTO public.uat_provisioning_packages (id,organization_id,package_key,version,status,blueprint_id,
    blueprint_definition_hash,definition,definition_hash,runbook,runbook_hash,compiled_by_actor_id,reason,
    idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_package_id,v_org.id,'m34-verification-'||substr(replace(v_package_id::text,'-',''),1,16),1,'compiled',v_source.blueprint_id,
    v_source.blueprint_definition_hash,v_source_definition,v_source_definition_hash,v_source.runbook,v_source.runbook_hash,
    v_owner_id,'Create a transaction-only M34 source package.','m34-verification-source-'||v_package_id,
    repeat('a',64),v_package_event_id,v_now);
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (v_run_event_id,v_org.id,'m34-verification-source-run-event-'||v_package_id,'UatProvisioningPackage.DryRunCompleted',1,
    'uat_provisioning_package',v_package_id,gen_random_uuid(),v_reviewer_id,'m34-verification','{}',v_now);
  INSERT INTO public.uat_provisioning_package_dry_runs (organization_id,package_id,package_definition_hash,policy_version,
    status,execution_decision,blocker_count,checks,side_effects,run_by_actor_id,reason,idempotency_key,
    request_fingerprint,event_id,created_at)
  VALUES (v_org.id,v_package_id,v_source_definition_hash,'1.0','passed','no_go',0,'[]','{"externalCalls":0,"estimatedAddedMonthlyCostUsd":0}',
    v_reviewer_id,'Provide fresh passing transaction-only M33 evidence.','m34-verification-source-run-'||v_package_id,
    repeat('b',64),v_run_event_id,v_now);

  v_result:=public.dop_compile_uat_activation_approval_pack(v_owner_id,v_package_id,
    'Compile the M34 explicit approval checklist without authorizing provisioning.',
    'm34-verification-approval-pack',gen_random_uuid(),v_now);
  IF v_result->>'outcome'<>'completed' OR v_result->>'executionDecision'<>'no_go'
     OR (v_result->>'pendingDecisionCount')::integer<>4 OR (v_result->>'provisioningAuthorized')::boolean THEN
    RAISE EXCEPTION 'M34 approval pack compile failed: %',v_result;
  END IF;
  v_pack_id:=(v_result->>'approvalPackId')::uuid;
  IF public.dop_uat_activation_approval_pack_definition_error(
      jsonb_set((SELECT stored.definition FROM public.uat_activation_approval_packs stored WHERE stored.id=v_pack_id),
        '{currentPolicy,provisioningAuthorized}','true'))<>'uat_activation_approval_pack_invalid' THEN
    RAISE EXCEPTION 'M34 accepted provisioning authorization drift';
  END IF;
  IF public.dop_uat_activation_decision_error('customer_confirmation','approved',
      '{"reference":"decision://test/customer","confirmedAt":"2026-01-01T00:00:00Z","apiKey":"forbidden"}',v_now)
      <>'uat_activation_decision_sensitive_evidence' THEN
    RAISE EXCEPTION 'M34 accepted sensitive approval evidence';
  END IF;
  v_result:=public.dop_evaluate_uat_activation_approval_pack(v_reviewer_id,v_pack_id,
    'Verify the initial pack reports four missing decisions and zero side effects.',
    'm34-verification-initial-evaluation',gen_random_uuid(),v_now);
  IF v_result->>'status'<>'blocked' OR (v_result->>'blockerCount')::integer<>4
     OR v_result->>'executionDecision'<>'no_go' OR (v_result#>>'{sideEffects,externalCalls}')::integer<>0 THEN
    RAISE EXCEPTION 'M34 initial evaluation failed: %',v_result;
  END IF;
  v_result:=public.dop_record_uat_activation_approval_decision(v_owner_id,v_pack_id,'customer_confirmation','approved',
    jsonb_build_object('reference','decision://verification/customer','confirmedAt',v_now),
    'Record transaction-only customer confirmation evidence.','m34-verification-customer',gen_random_uuid(),v_now);
  IF v_result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'customer decision failed: %',v_result; END IF;
  v_result:=public.dop_record_uat_activation_approval_decision(v_owner_id,v_pack_id,'budget_and_cost','approved',
    '{"reference":"decision://verification/budget","currency":"USD","approvedMonthlyLimitUsd":5,"estimatedMonthlyCostUsd":4}',
    'Record transaction-only positive budget and cost evidence.','m34-verification-budget',gen_random_uuid(),v_now);
  IF v_result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'budget decision failed: %',v_result; END IF;
  v_result:=public.dop_record_uat_activation_approval_decision(v_owner_id,v_pack_id,'data_scope','approved',
    '{"reference":"decision://verification/data","mode":"synthetic_only","region":"Sydney","retentionDays":30,"realDataApproved":false}',
    'Record transaction-only synthetic data scope evidence.','m34-verification-data',gen_random_uuid(),v_now);
  IF v_result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'data decision failed: %',v_result; END IF;
  v_result:=public.dop_record_uat_activation_approval_decision(v_owner_id,v_pack_id,'provisioning_window','approved',
    jsonb_build_object('reference','decision://verification/window','startsAt',v_now+interval '1 hour','endsAt',v_now+interval '2 hours'),
    'Record transaction-only bounded provisioning window evidence.','m34-verification-window',gen_random_uuid(),v_now);
  IF v_result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'window decision failed: %',v_result; END IF;
  v_result:=public.dop_evaluate_uat_activation_approval_pack(v_reviewer_id,v_pack_id,
    'Verify complete approvals only recommend a separate final authorization.',
    'm34-verification-complete-evaluation',gen_random_uuid(),v_now);
  IF v_result->>'status'<>'passed' OR v_result->>'recommendation'<>'ready_for_final_authorization'
     OR v_result->>'executionDecision'<>'no_go' OR (v_result->>'provisioningAuthorized')::boolean THEN
    RAISE EXCEPTION 'M34 complete evaluation escaped NO-GO: %',v_result;
  END IF;
  SELECT count(*) INTO v_notifications_after FROM public.notifications WHERE organization_id=v_org.id;
  IF v_notifications_after<>v_notifications_before THEN RAISE EXCEPTION 'M34 created a notification'; END IF;
END;
$$;

SELECT jsonb_build_object(
  'verification','passed','initialBlockers',4,'completeRecommendation','ready_for_final_authorization',
  'executionDecision','no_go','provisioningAuthorized',false,'providerActions','disabled',
  'resourcesCreated',0,'externalCalls',0,'estimatedAddedMonthlyCostUsd',0,'notificationsCreated',0
) AS m34_result;

ROLLBACK;
