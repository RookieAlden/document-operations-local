-- One-time M35 operation. Freezes the current four blockers into an unsubmitted request draft.
-- It performs no provider call and provides no submit, approve, authorize, or execute function.
DO $$
DECLARE
  v_owner_id constant uuid:='00000000-0000-4000-8400-000000000402';
  v_reviewer_id constant uuid:='00000000-0000-4000-8300-000000000301';
  v_pack_id uuid; v_request_id uuid; v_result jsonb; v_now timestamptz:=date_trunc('second',now());
BEGIN
  PERFORM public.dop_set_organization_context('dev-accounting-firm');
  SELECT id INTO STRICT v_pack_id FROM public.uat_activation_approval_packs
   WHERE approval_pack_key='uat-sydney-zero-budget-provisioning-activation-approval' AND status='draft'
   ORDER BY version DESC LIMIT 1;
  IF EXISTS (SELECT 1 FROM public.uat_final_authorization_requests existing WHERE existing.approval_pack_id=v_pack_id) THEN
    RAISE EXCEPTION 'M35 request already exists for the current approval pack; inspect instead of duplicating';
  END IF;
  v_result:=public.dop_compile_uat_final_authorization_request(v_owner_id,v_pack_id,
    'Freeze the current approval snapshot and disabled change set as an unsubmitted final-authorization request draft.',
    'm35-final-authorization-request-compile',gen_random_uuid(),v_now);
  IF v_result->>'outcome'<>'completed' OR (v_result->>'blockerCount')::integer<>4
     OR (v_result->>'submissionAllowed')::boolean OR (v_result->>'authorizationGranted')::boolean
     OR v_result->>'executionDecision'<>'no_go' THEN
    RAISE EXCEPTION 'M35 compile failed: %',v_result;
  END IF;
  v_request_id:=(v_result->>'requestId')::uuid;
  v_result:=public.dop_evaluate_uat_final_authorization_request(v_reviewer_id,v_request_id,
    'Record the four current execution blockers and verify the request has zero side effects.',
    'm35-final-authorization-request-evaluation',gen_random_uuid(),v_now);
  IF v_result->>'status'<>'blocked' OR (v_result->>'blockerCount')::integer<>4
     OR v_result->>'executionDecision'<>'no_go' OR (v_result#>>'{sideEffects,externalCalls}')::integer<>0 THEN
    RAISE EXCEPTION 'M35 evaluation failed: %',v_result;
  END IF;
END;
$$;

SELECT jsonb_build_object(
  'requestId',request.id,'requestKey',request.request_key,'version',request.version,
  'approvalPackId',request.approval_pack_id,'region',request.definition#>>'{target,region}',
  'retentionDays',(request.definition#>>'{target,retentionDays}')::integer,
  'currentMonthlyBudgetUsd',(request.definition#>>'{currentPolicy,monthlyBudgetUsd}')::numeric,
  'proposedMonthlyBudgetUsd',request.definition#>>'{proposedPolicy,monthlyBudgetUsd}',
  'changeSetSteps',jsonb_array_length(request.change_set),'enabledSteps',0,'executor',request.definition->>'executor',
  'status',evaluation.status,'recommendation',evaluation.recommendation,'blockerCount',evaluation.blocker_count,
  'submissionAllowed',(request.definition#>>'{requestGate,submissionAllowed}')::boolean,
  'authorizationGranted',(request.definition#>>'{requestGate,authorizationGranted}')::boolean,
  'executionDecision',evaluation.execution_decision,'resourcesCreated',0,
  'externalCalls',evaluation.side_effects#>>'{externalCalls}','estimatedAddedMonthlyCostUsd',evaluation.side_effects#>>'{estimatedAddedMonthlyCostUsd}'
) AS m35_result
FROM public.uat_final_authorization_requests request
JOIN LATERAL (
  SELECT * FROM public.uat_final_authorization_evaluations candidate
   WHERE candidate.request_id=request.id ORDER BY candidate.created_at DESC,id DESC LIMIT 1
) evaluation ON true
WHERE request.request_key='uat-sydney-zero-budget-provisioning-activation-approval-final-request' AND request.status='draft';
