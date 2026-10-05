BEGIN;

DO $$
DECLARE
  v_org_id uuid; v_owner_id uuid:='00000000-0000-4000-8400-000000000402';
  v_reviewer_id uuid:='00000000-0000-4000-8300-000000000301';
  v_pack_id uuid; v_request_id uuid; v_ready_request_id uuid; v_result jsonb;
  v_now timestamptz:=date_trunc('second',now());
  v_run_key text:=gen_random_uuid()::text;
  v_notifications_before integer; v_notifications_after integer;
BEGIN
  v_org_id:=public.dop_set_organization_context('dev-accounting-firm');
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'M35 DEV organization missing'; END IF;
  SELECT id INTO STRICT v_pack_id FROM public.uat_activation_approval_packs
   WHERE approval_pack_key='uat-sydney-zero-budget-provisioning-activation-approval' AND status='draft'
   ORDER BY version DESC LIMIT 1;
  SELECT count(*) INTO v_notifications_before FROM public.notifications WHERE organization_id=v_org_id;

  -- Give this rollback-only run a fresh source snapshot so it cannot collide
  -- with the permanent M35 request compiled from an earlier evaluation.
  v_result:=public.dop_evaluate_uat_activation_approval_pack(v_reviewer_id,v_pack_id,
    'Refresh the blocked source snapshot for an isolated rollback-only M35 verification.',
    'm35-verification-initial-source-'||v_run_key,gen_random_uuid(),v_now);

  v_result:=public.dop_compile_uat_final_authorization_request(v_owner_id,v_pack_id,
    'Freeze the current blocked approval snapshot into an execution-free request draft.',
    'm35-verification-blocked-request-'||v_run_key,gen_random_uuid(),v_now);
  IF v_result->>'outcome'<>'completed' OR (v_result->>'blockerCount')::integer<>4
     OR (v_result->>'submissionAllowed')::boolean OR (v_result->>'authorizationGranted')::boolean
     OR v_result->>'executionDecision'<>'no_go' THEN
    RAISE EXCEPTION 'M35 blocked request compile failed: %',v_result;
  END IF;
  v_request_id:=(v_result->>'requestId')::uuid;
  IF public.dop_uat_final_authorization_request_definition_error(
      jsonb_set((SELECT stored.definition FROM public.uat_final_authorization_requests stored WHERE stored.id=v_request_id),
        '{requestGate,authorizationGranted}','true'))<>'uat_final_authorization_request_invalid' THEN
    RAISE EXCEPTION 'M35 accepted authorization drift';
  END IF;
  v_result:=public.dop_evaluate_uat_final_authorization_request(v_reviewer_id,v_request_id,
    'Verify four missing approvals and zero execution side effects.',
    'm35-verification-blocked-evaluation-'||v_run_key,gen_random_uuid(),v_now);
  IF v_result->>'status'<>'blocked' OR (v_result->>'blockerCount')::integer<>4
     OR v_result->>'executionDecision'<>'no_go' OR (v_result#>>'{sideEffects,externalCalls}')::integer<>0 THEN
    RAISE EXCEPTION 'M35 blocked evaluation failed: %',v_result;
  END IF;

  v_result:=public.dop_evaluate_uat_activation_approval_pack(v_reviewer_id,v_pack_id,
    'Create a newer blocked source evaluation to prove snapshot drift closes.',
    'm35-verification-source-drift-'||v_run_key,gen_random_uuid(),v_now+interval '1 second');
  v_result:=public.dop_evaluate_uat_final_authorization_request(v_reviewer_id,v_request_id,
    'Verify a newer activation evaluation invalidates the frozen request snapshot.',
    'm35-verification-drift-evaluation-'||v_run_key,gen_random_uuid(),v_now+interval '1 second');
  IF v_result->>'status'<>'blocked' OR (v_result->>'blockerCount')::integer<>5 THEN
    RAISE EXCEPTION 'M35 source drift did not add a blocker: %',v_result;
  END IF;

  v_result:=public.dop_record_uat_activation_approval_decision(v_owner_id,v_pack_id,'customer_confirmation','approved',
    jsonb_build_object('reference','decision://verification/m35/customer','confirmedAt',v_now),
    'Record transaction-only customer confirmation evidence.','m35-verification-customer-'||v_run_key,gen_random_uuid(),v_now);
  v_result:=public.dop_record_uat_activation_approval_decision(v_owner_id,v_pack_id,'budget_and_cost','approved',
    '{"reference":"decision://verification/m35/budget","currency":"USD","approvedMonthlyLimitUsd":5,"estimatedMonthlyCostUsd":4}',
    'Record transaction-only positive budget and cost evidence.','m35-verification-budget-'||v_run_key,gen_random_uuid(),v_now);
  v_result:=public.dop_record_uat_activation_approval_decision(v_owner_id,v_pack_id,'data_scope','approved',
    '{"reference":"decision://verification/m35/data","mode":"synthetic_only","region":"Sydney","retentionDays":30,"realDataApproved":false}',
    'Record transaction-only explicit synthetic data evidence.','m35-verification-data-'||v_run_key,gen_random_uuid(),v_now);
  v_result:=public.dop_record_uat_activation_approval_decision(v_owner_id,v_pack_id,'provisioning_window','approved',
    jsonb_build_object('reference','decision://verification/m35/window','startsAt',v_now+interval '1 hour','endsAt',v_now+interval '2 hours'),
    'Record transaction-only bounded provisioning window evidence.','m35-verification-window-'||v_run_key,gen_random_uuid(),v_now);
  v_result:=public.dop_evaluate_uat_activation_approval_pack(v_reviewer_id,v_pack_id,
    'Confirm transaction-only approvals are ready for a separate final request.',
    'm35-verification-ready-source-'||v_run_key,gen_random_uuid(),v_now+interval '2 seconds');
  IF v_result->>'status'<>'passed' OR v_result->>'recommendation'<>'ready_for_final_authorization' THEN
    RAISE EXCEPTION 'M35 source did not become ready: %',v_result;
  END IF;
  v_result:=public.dop_compile_uat_final_authorization_request(v_owner_id,v_pack_id,
    'Freeze complete transaction-only evidence into a new non-executable request draft.',
    'm35-verification-ready-request-'||v_run_key,gen_random_uuid(),v_now+interval '2 seconds');
  IF v_result->>'outcome'<>'completed' OR (v_result->>'blockerCount')::integer<>0
     OR (v_result->>'submissionAllowed')::boolean OR (v_result->>'authorizationGranted')::boolean THEN
    RAISE EXCEPTION 'M35 ready request compile failed: %',v_result;
  END IF;
  v_ready_request_id:=(v_result->>'requestId')::uuid;
  v_result:=public.dop_evaluate_uat_final_authorization_request(v_reviewer_id,v_ready_request_id,
    'Confirm complete materials only become ready for submission and remain NO-GO.',
    'm35-verification-ready-evaluation-'||v_run_key,gen_random_uuid(),v_now+interval '2 seconds');
  IF v_result->>'status'<>'ready' OR v_result->>'recommendation'<>'ready_for_submission'
     OR v_result->>'executionDecision'<>'no_go' OR (v_result->>'submissionAllowed')::boolean
     OR (v_result->>'authorizationGranted')::boolean OR (v_result#>>'{sideEffects,externalCalls}')::integer<>0 THEN
    RAISE EXCEPTION 'M35 ready evaluation escaped request-only boundary: %',v_result;
  END IF;
  SELECT count(*) INTO v_notifications_after FROM public.notifications WHERE organization_id=v_org_id;
  IF v_notifications_after<>v_notifications_before THEN RAISE EXCEPTION 'M35 created a notification'; END IF;
END;
$$;

SELECT jsonb_build_object(
  'verification','passed','initialBlockers',4,'driftBlockers',5,'completeRecommendation','ready_for_submission',
  'submissionAllowed',false,'authorizationGranted',false,'executionDecision','no_go','executor','absent',
  'resourcesCreated',0,'externalCalls',0,'estimatedAddedMonthlyCostUsd',0,'notificationsCreated',0
) AS m35_result;

ROLLBACK;
