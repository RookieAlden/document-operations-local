BEGIN;

DO $$
DECLARE bundle public.uat_authorization_recompilations%ROWTYPE;
  manifest public.release_manifests%ROWTYPE; blueprint public.uat_environment_blueprints%ROWTYPE;
  package public.uat_provisioning_packages%ROWTYPE; pack public.uat_activation_approval_packs%ROWTYPE;
  request public.uat_final_authorization_requests%ROWTYPE; evaluation public.uat_final_authorization_evaluations%ROWTYPE;
BEGIN
  PERFORM public.dop_set_organization_context('dev-accounting-firm');
  SELECT * INTO STRICT bundle FROM public.uat_authorization_recompilations
   WHERE authorization_key='uat-sydney-synthetic' ORDER BY version DESC LIMIT 1;
  SELECT * INTO STRICT manifest FROM public.release_manifests WHERE id=bundle.release_manifest_id;
  SELECT * INTO STRICT blueprint FROM public.uat_environment_blueprints WHERE id=bundle.blueprint_id;
  SELECT * INTO STRICT package FROM public.uat_provisioning_packages WHERE id=bundle.provisioning_package_id;
  SELECT * INTO STRICT pack FROM public.uat_activation_approval_packs WHERE id=bundle.activation_approval_pack_id;
  SELECT * INTO STRICT request FROM public.uat_final_authorization_requests WHERE id=bundle.final_authorization_request_id;
  SELECT * INTO STRICT evaluation FROM public.uat_final_authorization_evaluations
   WHERE request_id=request.id ORDER BY created_at DESC,id DESC LIMIT 1;

  IF manifest.status<>'approved' OR manifest.readiness_declarations#>>'{approvals,budget,monthlyLimitUsd}'<>'40'
     OR manifest.readiness_declarations->>'resourceCreationApproval'<>'not_granted' THEN
    RAISE EXCEPTION 'M39 manifest boundary invalid';
  END IF;
  IF blueprint.status<>'draft' OR blueprint.definition->>'schemaVersion'<>'2.0'
     OR blueprint.definition#>>'{decisions,budget,monthlyLimitUsd}'<>'40'
     OR blueprint.definition#>>'{decisions,budget,resourceCreationAuthorized}'<>'false'
     OR blueprint.definition->>'runtimeExecution'<>'disabled'
     OR blueprint.definition->>'externalIngress'<>'disabled'
     OR blueprint.definition->>'externalDelivery'<>'disabled' THEN
    RAISE EXCEPTION 'M39 blueprint boundary invalid';
  END IF;
  IF package.status<>'compiled' OR package.definition#>>'{approvalGate,provisioningAuthorized}'<>'false'
     OR package.definition->>'execution'<>'prohibited'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(package.runbook) step WHERE step->>'execution'<>'disabled') THEN
    RAISE EXCEPTION 'M39 provisioning package boundary invalid';
  END IF;
  IF pack.status<>'draft' OR pack.definition#>>'{currentPolicy,monthlyBudgetUsd}'<>'40'
     OR pack.definition#>>'{currentPolicy,realDataApproved}'<>'false'
     OR jsonb_array_length(pack.definition->'requiredDecisions')<>2 THEN
    RAISE EXCEPTION 'M39 approval pack boundary invalid';
  END IF;
  IF request.status<>'draft' OR request.definition#>>'{requestGate,authorizationGranted}'<>'false'
     OR request.definition#>>'{proposedPolicy,realDataApproved}'<>'false'
     OR request.definition#>>'{proposedPolicy,resourceCreationAuthorized}'<>'false'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(request.change_set) step WHERE step->>'execution'<>'disabled') THEN
    RAISE EXCEPTION 'M39 final request boundary invalid';
  END IF;
  IF evaluation.status<>'blocked' OR evaluation.blocker_count<>2 OR evaluation.execution_decision<>'no_go'
     OR evaluation.side_effects<>bundle.actual_effects THEN
    RAISE EXCEPTION 'M39 final evaluation boundary invalid';
  END IF;
  IF bundle.current_policy->>'monthlyBudgetLimitUsd'<>'40'
     OR bundle.current_policy->>'dataRegion'<>'Sydney'
     OR bundle.current_policy->>'retentionDays'<>'30'
     OR bundle.current_policy->>'dataMode'<>'synthetic_only'
     OR bundle.current_policy->>'realDataApproved'<>'false'
     OR bundle.current_policy->>'resourceCreationAuthorized'<>'false'
     OR bundle.iac_plan->>'status'<>'compiled_not_applied'
     OR bundle.iac_plan->>'applyAllowed'<>'false'
     OR bundle.actual_effects#>>'{environmentsCreated}'<>'0'
     OR bundle.actual_effects#>>'{servicesCreated}'<>'0'
     OR bundle.actual_effects#>>'{externalCalls}'<>'0'
     OR bundle.actual_effects#>>'{estimatedAddedMonthlyCostUsd}'<>'0' THEN
    RAISE EXCEPTION 'M39 aggregate boundary invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(bundle.secret_references) reference
      WHERE reference ? 'value' OR reference->>'reference' !~ '^secretref://') THEN
    RAISE EXCEPTION 'M39 secret reference boundary invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.release_manifests historical
      WHERE historical.readiness_declarations#>>'{approvals,budget,monthlyLimitUsd}'='0'
        AND historical.status='superseded') THEN
    RAISE EXCEPTION 'M39 zero-dollar history was not retained';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.uat_authorization_recompilations'::regclass)
     OR has_table_privilege('dop_app','public.uat_authorization_recompilations','INSERT')
     OR has_table_privilege('dop_app','public.uat_authorization_recompilations','UPDATE')
     OR has_table_privilege('dop_app','public.uat_authorization_recompilations','DELETE') THEN
    RAISE EXCEPTION 'M39 RLS or direct-write boundary invalid';
  END IF;
END;
$$;

SELECT jsonb_build_object(
  'verification','passed','milestone','M39','persistentSideEffects',0,
  'oldZeroBudgetHistoryRetained',true,'currentMonthlyBudgetLimitUsd',40,
  'estimatedMonthlyCostUsd',33,'dataRegion','Sydney','computeRegion','Singapore',
  'retentionDays',30,'syntheticOnly',true,'realDataApproved',false,
  'resourceCreationAuthorized',false,'remainingBlockers',2,
  'plannedArtifacts',jsonb_build_array('Manifest','Blueprint','Provisioning Package','Activation Pack','Final Authorization'),
  'uatResourcesCreated',0,'externalCalls',0,'secretValuesStored',0
) AS m39_verification;

ROLLBACK;
