-- One-time M33 operation. Compiles and verifies evidence only; it performs no provider call.
DO $$
DECLARE
    owner_id constant uuid:='00000000-0000-4000-8400-000000000402';
    reviewer_id constant uuid:='00000000-0000-4000-8300-000000000301';
    v_blueprint_id uuid; v_package_id uuid; result jsonb; at_time timestamptz:=date_trunc('second',now());
BEGIN
    PERFORM public.dop_set_organization_context('dev-accounting-firm');
    SELECT id INTO STRICT v_blueprint_id FROM public.uat_environment_blueprints
     WHERE blueprint_key='uat-sydney-zero-budget' AND status='draft' ORDER BY version DESC LIMIT 1;
    IF EXISTS (SELECT 1 FROM public.uat_provisioning_packages existing WHERE existing.blueprint_id=v_blueprint_id) THEN
        RAISE EXCEPTION 'M33 package already exists for the approved blueprint; inspect instead of duplicating';
    END IF;
    result:=public.dop_compile_uat_provisioning_package(owner_id,v_blueprint_id,
      'Compile the approved Sydney zero-budget blueprint into a non-executable provisioning package.',
      'm33-provisioning-package-compile',gen_random_uuid(),at_time);
    IF result->>'outcome'<>'completed' OR result->>'executionDecision'<>'no_go'
       OR (result->>'provisioningAuthorized')::boolean OR (result->>'resourcesCreated')::integer<>0 THEN
        RAISE EXCEPTION 'M33 compile failed: %',result;
    END IF;
    v_package_id:=(result->>'packageId')::uuid;
    result:=public.dop_run_uat_provisioning_package_dry_run(reviewer_id,v_package_id,
      'Independently verify the package contract, zero-dollar gate and zero side effects.',
      'm33-provisioning-package-dry-run',gen_random_uuid(),at_time);
    IF result->>'status'<>'passed' OR result->>'executionDecision'<>'no_go'
       OR (result->>'blockerCount')::integer<>0 OR (result#>>'{sideEffects,externalCalls}')::integer<>0 THEN
        RAISE EXCEPTION 'M33 dry-run failed: %',result;
    END IF;
END;
$$;

SELECT jsonb_build_object(
  'packageId',package.id,'packageKey',package.package_key,'version',package.version,
  'blueprintId',package.blueprint_id,'region',package.definition->>'region',
  'retentionDays',(package.definition#>>'{dataBoundary,retentionDays}')::integer,
  'monthlyBudgetUsd',(package.definition#>>'{budget,monthlyLimitUsd}')::numeric,
  'execution',package.definition->>'execution','approvalGate',package.definition#>>'{approvalGate,status}',
  'provisioningAuthorized',(package.definition#>>'{approvalGate,provisioningAuthorized}')::boolean,
  'runbookSteps',jsonb_array_length(package.runbook),'enabledSteps',0,
  'dryRunStatus',run.status,'executionDecision',run.execution_decision,
  'resourcesCreated',0,'externalCalls',run.side_effects#>>'{externalCalls}',
  'estimatedAddedMonthlyCostUsd',run.side_effects#>>'{estimatedAddedMonthlyCostUsd}'
) AS m33_result
FROM public.uat_provisioning_packages package
JOIN LATERAL (
  SELECT * FROM public.uat_provisioning_package_dry_runs candidate
   WHERE candidate.package_id=package.id ORDER BY candidate.created_at DESC,id DESC LIMIT 1
) run ON true
WHERE package.package_key='uat-sydney-zero-budget-provisioning' AND package.status='compiled';
