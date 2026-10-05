-- One-time M34 operation. It records the current four approval gaps and no approval decisions.
-- It performs no provider call and cannot authorize provisioning.
DO $$
DECLARE
  v_owner_id constant uuid:='00000000-0000-4000-8400-000000000402';
  v_reviewer_id constant uuid:='00000000-0000-4000-8300-000000000301';
  v_package_id uuid; v_pack_id uuid; v_result jsonb; v_now timestamptz:=date_trunc('second',now());
BEGIN
  PERFORM public.dop_set_organization_context('dev-accounting-firm');
  SELECT id INTO STRICT v_package_id FROM public.uat_provisioning_packages
   WHERE package_key='uat-sydney-zero-budget-provisioning' AND status='compiled' ORDER BY version DESC LIMIT 1;
  IF EXISTS (SELECT 1 FROM public.uat_activation_approval_packs existing
      WHERE existing.provisioning_package_id=v_package_id) THEN
    RAISE EXCEPTION 'M34 approval pack already exists for the current package; inspect instead of duplicating';
  END IF;
  v_result:=public.dop_compile_uat_activation_approval_pack(v_owner_id,v_package_id,
    'Prepare the explicit first-customer, positive-budget, data-scope and execution-window approval checklist.',
    'm34-activation-approval-pack-compile',gen_random_uuid(),v_now);
  IF v_result->>'outcome'<>'completed' OR (v_result->>'pendingDecisionCount')::integer<>4
     OR v_result->>'executionDecision'<>'no_go' OR (v_result->>'provisioningAuthorized')::boolean THEN
    RAISE EXCEPTION 'M34 compile failed: %',v_result;
  END IF;
  v_pack_id:=(v_result->>'approvalPackId')::uuid;
  v_result:=public.dop_evaluate_uat_activation_approval_pack(v_reviewer_id,v_pack_id,
    'Record the four current approval blockers while verifying zero external side effects.',
    'm34-activation-approval-pack-evaluation',gen_random_uuid(),v_now);
  IF v_result->>'status'<>'blocked' OR (v_result->>'blockerCount')::integer<>4
     OR v_result->>'executionDecision'<>'no_go' OR (v_result#>>'{sideEffects,externalCalls}')::integer<>0 THEN
    RAISE EXCEPTION 'M34 evaluation failed: %',v_result;
  END IF;
END;
$$;

SELECT jsonb_build_object(
  'approvalPackId',approval.id,'approvalPackKey',approval.approval_pack_key,'version',approval.version,
  'sourcePackageId',approval.provisioning_package_id,'region',approval.definition#>>'{target,region}',
  'retentionDays',(approval.definition#>>'{target,retentionDays}')::integer,
  'currentMonthlyBudgetUsd',(approval.definition#>>'{currentPolicy,monthlyBudgetUsd}')::numeric,
  'pendingDecisionCount',evaluation.blocker_count,'decisionRows',(SELECT count(*) FROM public.uat_activation_approval_decisions decision WHERE decision.approval_pack_id=approval.id),
  'status',evaluation.status,'recommendation',evaluation.recommendation,'executionDecision',evaluation.execution_decision,
  'provisioningAuthorized',(approval.definition#>>'{currentPolicy,provisioningAuthorized}')::boolean,
  'resourcesCreated',0,'externalCalls',evaluation.side_effects#>>'{externalCalls}',
  'estimatedAddedMonthlyCostUsd',evaluation.side_effects#>>'{estimatedAddedMonthlyCostUsd}'
) AS m34_result
FROM public.uat_activation_approval_packs approval
JOIN LATERAL (
  SELECT * FROM public.uat_activation_approval_evaluations candidate
   WHERE candidate.approval_pack_id=approval.id ORDER BY candidate.created_at DESC,id DESC LIMIT 1
) evaluation ON true
WHERE approval.approval_pack_key='uat-sydney-zero-budget-provisioning-activation-approval' AND approval.status='draft';
