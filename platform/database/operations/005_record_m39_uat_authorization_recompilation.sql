-- One-time M39 compilation. This writes governance evidence only.
-- It does not call Railway, Supabase, OpenAI or any other provider.
DO $$
DECLARE
  v_org_id uuid;
  v_owner_id constant uuid:='00000000-0000-4000-8400-000000000402';
  v_reviewer_id constant uuid:='00000000-0000-4000-8300-000000000301';
  v_now timestamptz:=date_trunc('second',now());
  v_correlation_id uuid:=gen_random_uuid();
  v_manifest_id uuid:=gen_random_uuid(); v_manifest_event_id uuid:=gen_random_uuid();
  v_readiness_id uuid:=gen_random_uuid(); v_readiness_event_id uuid:=gen_random_uuid();
  v_decision_id uuid:=gen_random_uuid(); v_decision_event_id uuid:=gen_random_uuid();
  v_blueprint_id uuid:=gen_random_uuid(); v_blueprint_event_id uuid:=gen_random_uuid();
  v_blueprint_run_id uuid:=gen_random_uuid(); v_blueprint_run_event_id uuid:=gen_random_uuid();
  v_package_id uuid:=gen_random_uuid(); v_package_event_id uuid:=gen_random_uuid();
  v_package_run_id uuid:=gen_random_uuid(); v_package_run_event_id uuid:=gen_random_uuid();
  v_pack_id uuid:=gen_random_uuid(); v_pack_event_id uuid:=gen_random_uuid();
  v_pack_evaluation_id uuid:=gen_random_uuid(); v_pack_evaluation_event_id uuid:=gen_random_uuid();
  v_request_id uuid:=gen_random_uuid(); v_request_event_id uuid:=gen_random_uuid();
  v_request_evaluation_id uuid:=gen_random_uuid(); v_request_evaluation_event_id uuid:=gen_random_uuid();
  v_bundle_id uuid:=gen_random_uuid(); v_bundle_event_id uuid:=gen_random_uuid();
  v_snapshot jsonb; v_declarations jsonb; v_manifest_hash text; v_snapshot_hash text; v_declarations_hash text;
  v_blueprint jsonb; v_blueprint_hash text; v_deployment_plan jsonb; v_deployment_plan_hash text;
  v_runbook jsonb; v_package jsonb; v_package_hash text; v_runbook_hash text;
  v_pack jsonb; v_pack_hash text; v_pack_checks jsonb; v_zero_effects jsonb;
  v_change_set jsonb; v_request jsonb; v_request_hash text; v_change_set_hash text; v_request_checks jsonb;
  v_current_policy jsonb; v_cost_plan jsonb; v_iac_plan jsonb; v_secret_references jsonb;
  v_destruction_plan jsonb; v_bundle_hash text;
BEGIN
  v_org_id:=public.dop_set_organization_context('dev-accounting-firm');
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'M39 organization not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.uat_authorization_recompilations
      WHERE organization_id=v_org_id AND authorization_key='uat-sydney-synthetic') THEN
    RAISE EXCEPTION 'M39 authorization already compiled; inspect instead of duplicating';
  END IF;

  v_zero_effects:=jsonb_build_object(
    'environmentsCreated',0,'servicesCreated',0,'databasesCreated',0,'storageBucketsCreated',0,
    'domainsCreated',0,'secretValuesResolved',0,'schedulersCreated',0,'migrationsApplied',0,
    'dataCopied',false,'runtimeStarted',false,'externalCalls',0,'notificationsCreated',0,
    'estimatedAddedMonthlyCostUsd',0);
  v_secret_references:=jsonb_build_array(
    jsonb_build_object('variableName','DATABASE_URL','reference','secretref://uat/supabase/database-url'),
    jsonb_build_object('variableName','SUPABASE_URL','reference','secretref://uat/supabase/project-url'),
    jsonb_build_object('variableName','SUPABASE_PUBLISHABLE_KEY','reference','secretref://uat/supabase/publishable-key'),
    jsonb_build_object('variableName','SUPABASE_STORAGE_TOKEN','reference','secretref://uat/supabase/storage-token'),
    jsonb_build_object('variableName','OPENAI_API_KEY','reference','secretref://uat/openai/project-key'),
    jsonb_build_object('variableName','DOP_OPS_SESSION_SECRET','reference','secretref://uat/railway/ops-session-secret'));
  v_current_policy:=jsonb_build_object(
    'schemaVersion','2.0','dataRegion','Sydney','computeRegion','Singapore','retentionDays',30,
    'dataMode','synthetic_only','realDataApproved',false,'realDataRequiresReapproval',true,
    'monthlyBudgetLimitUsd',40,'resourceCreationAuthorized',false,'executionWindow',NULL,
    'runtimeOwnerActorId',v_owner_id,'runtimeExecution','disabled','externalIngress','disabled',
    'externalDelivery','disabled','devDataCopy','none');
  v_cost_plan:=jsonb_build_object(
    'currency','USD','monthlyLimitUsd',40,'estimatedMonthlyCostUsd',33,
    'resources',jsonb_build_array(
      jsonb_build_object('provider','Supabase','plan','Pro','region','Sydney','monthlyAllowanceUsd',25),
      jsonb_build_object('provider','Railway','plan','Hobby','region','Singapore','monthlyAllowanceUsd',5,
        'earlyWarningUsd',2.5,'nativeAlertUsd',3.5,'stopNonEssentialUsd',4.5,'computeHardLimitUsd',5),
      jsonb_build_object('provider','OpenAI','plan','usage_capped','monthlyAllowanceUsd',3),
      jsonb_build_object('provider','Budget buffer','plan','tax_fx_micro_overage_only','monthlyAllowanceUsd',7)),
    'priceReferences',jsonb_build_array(
      'https://supabase.com/pricing','https://railway.com/pricing','https://openai.com/api/pricing/'));
  v_iac_plan:=jsonb_build_object(
    'schemaVersion','2.0','status','compiled_not_applied','applyAllowed',false,
    'requiresExplicitM40Approval',true,'targetEnvironmentExists',false,
    'plannedForM40',jsonb_build_object('environmentsToCreate',2,'servicesToCreate',3,
      'databasesToCreate',1,'privateStorageBucketsToCreate',1,'publicDomainsToCreate',1,
      'supabaseRegion','Sydney','railwayRegion','Singapore'),
    'm39ActualEffects',v_zero_effects);
  v_destruction_plan:=jsonb_build_array(
    jsonb_build_object('sequence',1,'action','disable_ingress_and_stop_uat_runtime','execution','disabled'),
    jsonb_build_object('sequence',2,'action','export_minimal_audit_and_cost_evidence','execution','disabled'),
    jsonb_build_object('sequence',3,'action','delete_uat_storage_objects_and_derived_content','execution','disabled'),
    jsonb_build_object('sequence',4,'action','delete_supabase_uat_project','execution','disabled'),
    jsonb_build_object('sequence',5,'action','delete_railway_uat_services_and_workspace','execution','disabled'),
    jsonb_build_object('sequence',6,'action','revoke_openai_uat_key_and_archive_project','execution','disabled'),
    jsonb_build_object('sequence',7,'action','record_provider_receipts_and_zero_live_resources','execution','disabled'));

  v_snapshot:=public.dop_build_release_component_snapshot(v_org_id);
  v_snapshot_hash:=encode(digest(v_snapshot::text,'sha256'),'hex');
  v_declarations:=jsonb_build_object(
    'schemaVersion','2.0','sourceEnvironment','DEV','targetEnvironment','UAT',
    'targetProvisioning','not_started','runtimeExecution','disabled','externalDelivery','disabled',
    'externalIngress','disabled','dataBoundary','synthetic_only','resourceCreationApproval','not_granted',
    'approvals',jsonb_build_object(
      'dataRegion',jsonb_build_object('status','approved','reference','decision://uat/region/sydney'),
      'privacyRetention',jsonb_build_object('status','approved','reference','decision://uat/retention/30-days-real-data-reapproval'),
      'budget',jsonb_build_object('status','approved','reference','decision://uat/budget/monthly-limit-40','monthlyLimitUsd',40),
      'sharedMailbox',jsonb_build_object('status','not_required','reference',NULL)),
    'secretReferences',(SELECT coalesce(jsonb_agg(item->>'reference'),'[]'::jsonb) FROM jsonb_array_elements(v_secret_references) item));
  v_declarations_hash:=encode(digest(v_declarations::text,'sha256'),'hex');
  v_manifest_hash:=encode(digest(concat_ws('|',v_snapshot_hash,v_declarations_hash,'m39'),'sha256'),'hex');
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (v_manifest_event_id,v_org_id,'m39-release-manifest:event','ReleaseManifest.Created',2,
    'release_manifest',v_manifest_id,v_correlation_id,v_owner_id,'m39-uat-authorization',
    jsonb_build_object('manifestHash',v_manifest_hash,'monthlyBudgetLimitUsd',40,
      'resourceCreationAuthorized',false,'externalCalls',0),v_now);
  UPDATE public.release_manifests SET status='superseded'
   WHERE organization_id=v_org_id AND target_environment='UAT' AND status IN ('draft','in_review','approved');
  INSERT INTO public.release_manifests (id,organization_id,manifest_key,version,status,source_environment,target_environment,
    component_snapshot,component_snapshot_hash,readiness_declarations,declarations_hash,manifest_hash,rollback_manifest_id,
    created_by_actor_id,submitted_by_actor_id,approved_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,
    created_at,submitted_at,approved_at)
  VALUES (v_manifest_id,v_org_id,'dev-to-uat-governance',1,'approved','DEV','UAT',v_snapshot,v_snapshot_hash,
    v_declarations,v_declarations_hash,v_manifest_hash,NULL,v_owner_id,v_owner_id,v_reviewer_id,
    'Compile the approved forty-dollar synthetic UAT policy while keeping resource creation separately blocked.',
    'm39-release-manifest',encode(digest('m39-release-manifest','sha256'),'hex'),v_manifest_event_id,v_now,v_now,v_now);

  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (v_readiness_event_id,v_org_id,'m39-release-readiness:event','ReleaseManifest.Evaluated',2,
    'release_manifest',v_manifest_id,v_correlation_id,v_owner_id,'m39-uat-authorization',
    jsonb_build_object('status','passed','blockerCount',0,'driftDetected',false,'externalCalls',0),v_now);
  INSERT INTO public.release_readiness_runs (id,organization_id,manifest_id,manifest_hash,current_component_snapshot_hash,
    policy_version,status,blocker_count,drift_detected,checks,run_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_readiness_id,v_org_id,v_manifest_id,v_manifest_hash,v_snapshot_hash,'1.0','passed',0,false,
    jsonb_build_array(
      jsonb_build_object('code','component_snapshot_current','status','passed','evidence',jsonb_build_object('hash',v_snapshot_hash)),
      jsonb_build_object('code','uat_budget_policy_approved','status','passed','evidence',jsonb_build_object('monthlyLimitUsd',40,'creationAuthorized',false)),
      jsonb_build_object('code','synthetic_sydney_boundary','status','passed','evidence',jsonb_build_object('dataRegion','Sydney','retentionDays',30,'realDataApproved',false)),
      jsonb_build_object('code','zero_side_effects','status','passed','evidence',v_zero_effects)),
    v_owner_id,'Verify the M39 manifest without creating or changing any provider resource.',
    'm39-release-readiness',encode(digest('m39-release-readiness','sha256'),'hex'),v_readiness_event_id,v_now);
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (v_decision_event_id,v_org_id,'m39-release-approval:event','ReleaseManifest.Approved',2,
    'release_manifest',v_manifest_id,v_correlation_id,v_reviewer_id,'m39-uat-authorization',
    jsonb_build_object('manifestHash',v_manifest_hash,'deploymentAuthorized',false,'externalCalls',0),v_now);
  INSERT INTO public.release_approval_decisions (id,organization_id,manifest_id,manifest_hash,action,decided_by_actor_id,
    reason,idempotency_key,request_fingerprint,event_id,decided_at)
  VALUES (v_decision_id,v_org_id,v_manifest_id,v_manifest_hash,'approved',v_reviewer_id,
    'Independently approve the planning evidence while withholding M40 resource creation authorization.',
    'm39-release-approval',encode(digest('m39-release-approval','sha256'),'hex'),v_decision_event_id,v_now);

  v_deployment_plan:=jsonb_build_array(
    jsonb_build_object('sequence',1,'action','verify_governance_inputs','execution','disabled'),
    jsonb_build_object('sequence',2,'action','prepare_isolated_data_plane','execution','disabled'),
    jsonb_build_object('sequence',3,'action','apply_ordered_migrations','execution','disabled'),
    jsonb_build_object('sequence',4,'action','register_secret_references','execution','disabled'),
    jsonb_build_object('sequence',5,'action','prepare_three_services','execution','disabled'),
    jsonb_build_object('sequence',6,'action','configure_cost_controls','execution','disabled'),
    jsonb_build_object('sequence',7,'action','configure_thirty_day_retention','execution','disabled'),
    jsonb_build_object('sequence',8,'action','run_synthetic_acceptance','execution','disabled'),
    jsonb_build_object('sequence',9,'action','record_go_no_go','execution','disabled'),
    jsonb_build_object('sequence',10,'action','rollback_unexposed_target_if_required','execution','disabled'));
  v_blueprint:=jsonb_build_object(
    'schemaVersion','2.0','sourceEnvironment','DEV','targetEnvironment','UAT','provisioningMode','plan_only',
    'targetProvisioning','not_started','dataBoundary','synthetic_only','dataCopy','none','runtimeExecution','disabled',
    'externalIngress','disabled','externalDelivery','disabled','secretMaterialization','disabled',
    'topology',jsonb_build_object('provider','railway','computeRegion','Singapore','isolation','dedicated_environment',
      'database','dedicated_supabase_project','dataRegion','Sydney','storage','dedicated_private_bucket','services',jsonb_build_array(
        jsonb_build_object('key','intake','plannedExposure','internal_only','replicas',1,'runtimeState','disabled'),
        jsonb_build_object('key','preservation','plannedExposure','internal_only','replicas',1,'runtimeState','disabled'),
        jsonb_build_object('key','classification','plannedExposure','internal_only','replicas',1,'runtimeState','disabled'))),
    'decisions',jsonb_build_object(
      'dataRegion',jsonb_build_object('status','approved','reference','decision://uat/region/sydney','region','Sydney'),
      'privacyRetention',jsonb_build_object('status','approved','reference','decision://uat/retention/30-days-real-data-reapproval','retentionDays',30,'realDataRequiresReapproval',true),
      'budget',jsonb_build_object('status','approved','reference','decision://uat/budget/monthly-limit-40','monthlyLimitUsd',40,
        'estimatedMonthlyCostUsd',33,'paidResourceProvisioning','planned_after_explicit_creation_approval','resourceCreationAuthorized',false),
      'runtimeOwner',jsonb_build_object('status','approved','reference','decision://uat/runtime-owner/dev-owner','actorId',v_owner_id)),
    'variableNames',jsonb_build_array('DOP_ENVIRONMENT','DOP_ORGANIZATION_KEY','DATABASE_URL','SUPABASE_URL',
      'SUPABASE_PUBLISHABLE_KEY','SUPABASE_STORAGE_TOKEN','SUPABASE_STORAGE_BUCKET','OPENAI_API_KEY','DOP_OPS_SESSION_SECRET'),
    'secretReferences',v_secret_references,
    'migration',jsonb_build_object('strategy','ordered_sql','seedMode','synthetic_only','migrations',jsonb_build_array('001..035'),
      'verificationScripts',jsonb_build_array('039_uat_authorization_recompilation_regression.sql')),
    'acceptance',jsonb_build_object('healthCheck','required','errorLogs','zero_required','syntheticJourney','required','realData','prohibited'),
    'rollback',jsonb_build_object('strategy','remove_unexposed_target','preserveAuditEvidence',true,'maxMinutes',60));
  v_blueprint_hash:=encode(digest(v_blueprint::text,'sha256'),'hex');
  v_deployment_plan_hash:=encode(digest(v_deployment_plan::text,'sha256'),'hex');
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at) VALUES (v_blueprint_event_id,v_org_id,'m39-blueprint:event','UatEnvironmentBlueprint.Created',2,
    'uat_environment_blueprint',v_blueprint_id,v_correlation_id,v_owner_id,'m39-uat-authorization',
    jsonb_build_object('definitionHash',v_blueprint_hash,'targetEnvironmentCreated',false,'resourceCreationAuthorized',false,'externalCalls',0),v_now);
  UPDATE public.uat_environment_blueprints SET status='superseded' WHERE organization_id=v_org_id AND status='draft';
  INSERT INTO public.uat_environment_blueprints (id,organization_id,blueprint_key,version,status,release_manifest_id,definition,
    definition_hash,deployment_plan,deployment_plan_hash,previous_blueprint_id,created_by_actor_id,reason,idempotency_key,
    request_fingerprint,event_id,created_at)
  VALUES (v_blueprint_id,v_org_id,'uat-sydney-governed',1,'draft',v_manifest_id,v_blueprint,v_blueprint_hash,
    v_deployment_plan,v_deployment_plan_hash,NULL,v_owner_id,
    'Compile the forty-dollar Sydney synthetic UAT blueprint with every provider action disabled.',
    'm39-blueprint',encode(digest('m39-blueprint','sha256'),'hex'),v_blueprint_event_id,v_now);
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at) VALUES (v_blueprint_run_event_id,v_org_id,'m39-blueprint-run:event','UatEnvironmentBlueprint.DryRunCompleted',2,
    'uat_environment_blueprint',v_blueprint_id,v_correlation_id,v_reviewer_id,'m39-uat-authorization',
    jsonb_build_object('status','passed','blockerCount',0,'resourceCreationAuthorized',false,'sideEffects',v_zero_effects),v_now);
  INSERT INTO public.uat_blueprint_dry_runs (id,organization_id,blueprint_id,blueprint_definition_hash,policy_version,status,
    blocker_count,checks,side_effects,run_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_blueprint_run_id,v_org_id,v_blueprint_id,v_blueprint_hash,'1.0','passed',0,
    jsonb_build_array(
      jsonb_build_object('code','approved_release_manifest','status','passed','evidence',jsonb_build_object('manifestId',v_manifest_id)),
      jsonb_build_object('code','approved_budget_creation_gate','status','passed','evidence',jsonb_build_object('monthlyLimitUsd',40,'creationAuthorized',false)),
      jsonb_build_object('code','synthetic_data_only','status','passed','evidence',jsonb_build_object('realDataApproved',false)),
      jsonb_build_object('code','secret_references_only','status','passed','evidence',jsonb_build_object('referenceCount',jsonb_array_length(v_secret_references),'valuesResolved',0)),
      jsonb_build_object('code','zero_side_effects','status','passed','evidence',v_zero_effects)),v_zero_effects,
    v_reviewer_id,'Verify the M39 blueprint and its explicit creation gate without provider calls.',
    'm39-blueprint-run',encode(digest('m39-blueprint-run','sha256'),'hex'),v_blueprint_run_event_id,v_now);

  v_runbook:=jsonb_build_array(
    jsonb_build_object('sequence',1,'action','verify_approved_blueprint','execution','disabled'),
    jsonb_build_object('sequence',2,'action','verify_budget_and_creation_gate','execution','disabled'),
    jsonb_build_object('sequence',3,'action','verify_provider_quotes','execution','disabled'),
    jsonb_build_object('sequence',4,'action','create_railway_environment','execution','disabled'),
    jsonb_build_object('sequence',5,'action','create_supabase_data_plane','execution','disabled'),
    jsonb_build_object('sequence',6,'action','apply_ordered_migrations','execution','disabled'),
    jsonb_build_object('sequence',7,'action','materialize_secret_references','execution','disabled'),
    jsonb_build_object('sequence',8,'action','configure_thirty_day_cleanup','execution','disabled'),
    jsonb_build_object('sequence',9,'action','run_synthetic_acceptance','execution','disabled'),
    jsonb_build_object('sequence',10,'action','rollback_unexposed_target','execution','disabled'));
  v_package:=jsonb_build_object(
    'schemaVersion','2.0','sourceEnvironment','DEV','targetEnvironment','UAT','mode','compile_only','execution','prohibited',
    'region','Sydney','computeRegion','Singapore','budget',jsonb_build_object('monthlyLimitUsd',40,'estimatedMonthlyCostUsd',33,
      'paidResourceProvisioning','planned_after_explicit_creation_approval','resourceCreationAuthorized',false),
    'costPlan',v_cost_plan,'dataBoundary',jsonb_build_object('syntheticOnly',true,'realDataRequiresReapproval',true,
      'realDataApproved',false,'retentionDays',30,'devDataCopy','none'),
    'railwayPlan',jsonb_build_object('action','plan_only','environment',jsonb_build_object('name','uat','create',false,'start',false),
      'services',jsonb_build_array(
        jsonb_build_object('key','intake','plannedReplicas',1,'create',false,'start',false,'publicDomainCreate',false),
        jsonb_build_object('key','preservation','plannedReplicas',1,'create',false,'start',false,'publicDomainCreate',false),
        jsonb_build_object('key','classification','plannedReplicas',1,'create',false,'start',false,'publicDomainCreate',false)),
      'costControls',jsonb_build_object('earlyWarningUsd',2.5,'nativeAlertUsd',3.5,'stopNonEssentialUsd',4.5,'hardLimitUsd',5),
      'variableNames',v_blueprint->'variableNames','secretReferences',v_secret_references),
    'supabasePlan',jsonb_build_object('action','plan_only','project',jsonb_build_object('region','Sydney','plan','Pro','create',false),
      'database',jsonb_build_object('create',false),'storage',jsonb_build_object('private',true,'create',false)),
    'openAiPlan',jsonb_build_object('action','plan_only','separateProject',true,'monthlyCapUsd',3,'create',false,'keyCreated',false),
    'migration',jsonb_build_object('strategy','ordered_sql','migrations',jsonb_build_array('001..035'),
      'verificationScripts',jsonb_build_array('039_uat_authorization_recompilation_regression.sql'),'execution','disabled'),
    'retentionJob',jsonb_build_object('retentionDays',30,'scheduler','not_configured','execution','disabled'),
    'acceptance',v_blueprint->'acceptance','rollback',v_blueprint->'rollback','runbook',v_runbook,
    'approvalGate',jsonb_build_object('status','blocked_by_explicit_creation_approval','provisioningAuthorized',false,
      'requiredBeforeExecution',jsonb_build_array('bounded_execution_window','explicit_m40_creation_approval')));
  v_package_hash:=encode(digest(v_package::text,'sha256'),'hex'); v_runbook_hash:=encode(digest(v_runbook::text,'sha256'),'hex');
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at) VALUES (v_package_event_id,v_org_id,'m39-package:event','UatProvisioningPackage.Compiled',2,
    'uat_provisioning_package',v_package_id,v_correlation_id,v_owner_id,'m39-uat-authorization',
    jsonb_build_object('definitionHash',v_package_hash,'executionDecision','no_go','resourcesCreated',0,'externalCalls',0),v_now);
  UPDATE public.uat_provisioning_packages SET status='superseded' WHERE organization_id=v_org_id AND status='compiled';
  INSERT INTO public.uat_provisioning_packages (id,organization_id,package_key,version,status,blueprint_id,
    blueprint_definition_hash,definition,definition_hash,runbook,runbook_hash,previous_package_id,compiled_by_actor_id,
    reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_package_id,v_org_id,'uat-sydney-governed-provisioning',1,'compiled',v_blueprint_id,v_blueprint_hash,v_package,
    v_package_hash,v_runbook,v_runbook_hash,NULL,v_owner_id,'Compile a provider-neutral M40 plan while keeping all ten actions disabled.',
    'm39-package',encode(digest('m39-package','sha256'),'hex'),v_package_event_id,v_now);
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at) VALUES (v_package_run_event_id,v_org_id,'m39-package-run:event','UatProvisioningPackage.DryRunCompleted',2,
    'uat_provisioning_package',v_package_id,v_correlation_id,v_reviewer_id,'m39-uat-authorization',
    jsonb_build_object('status','passed','executionDecision','no_go','sideEffects',v_zero_effects),v_now);
  INSERT INTO public.uat_provisioning_package_dry_runs (id,organization_id,package_id,package_definition_hash,
    policy_version,status,execution_decision,blocker_count,checks,side_effects,run_by_actor_id,reason,idempotency_key,
    request_fingerprint,event_id,created_at)
  VALUES (v_package_run_id,v_org_id,v_package_id,v_package_hash,'1.0','passed','no_go',0,
    jsonb_build_array(
      jsonb_build_object('code','approved_blueprint_bound','status','passed','evidence',jsonb_build_object('blueprintId',v_blueprint_id)),
      jsonb_build_object('code','approved_budget_creation_gate','status','passed','evidence',jsonb_build_object('monthlyLimitUsd',40,'creationAuthorized',false)),
      jsonb_build_object('code','all_provider_actions_disabled','status','passed','evidence',jsonb_build_object('runbookSteps',10,'enabledSteps',0)),
      jsonb_build_object('code','zero_side_effects','status','passed','evidence',v_zero_effects)),v_zero_effects,v_reviewer_id,
    'Verify the M39 provisioning package has no executable or provider side effect.',
    'm39-package-run',encode(digest('m39-package-run','sha256'),'hex'),v_package_run_event_id,v_now);

  v_pack:=jsonb_build_object(
    'schemaVersion','2.0','sourceEnvironment','DEV','targetEnvironment','UAT','mode','approval_evidence_only',
    'execution','prohibited','providerActions','disabled','target',jsonb_build_object('region','Sydney','retentionDays',30),
    'currentPolicy',jsonb_build_object('monthlyBudgetUsd',40,'estimatedMonthlyCostUsd',33,
      'paidResourceProvisioning','planned_after_explicit_creation_approval','dataMode','synthetic_only',
      'realDataApproved',false,'realDataRequiresReapproval',true,'provisioningAuthorized',false),
    'sourcePackage',jsonb_build_object('id',v_package_id,'definitionHash',v_package_hash,'dryRunId',v_package_run_id),
    'inheritedEvidence',jsonb_build_object('blueprintId',v_blueprint_id,'runtimeOwnerActorId',v_owner_id),
    'approvedDecisions',jsonb_build_array('budget_and_cost','data_scope'),
    'requiredDecisions',jsonb_build_array('provisioning_window','explicit_creation_authorization'),
    'finalAuthorization',jsonb_build_object('required',true,'handledBy','separate_user_authorization','status','not_requested'));
  v_pack_hash:=encode(digest(v_pack::text,'sha256'),'hex');
  v_pack_checks:=jsonb_build_array(
    jsonb_build_object('code','source_package_current_and_verified','status','passed','evidence',jsonb_build_object('packageId',v_package_id)),
    jsonb_build_object('code','budget_and_cost','status','passed','evidence',v_cost_plan),
    jsonb_build_object('code','data_scope','status','passed','evidence',jsonb_build_object('mode','synthetic_only','realDataApproved',false)),
    jsonb_build_object('code','provisioning_window','status','blocked','evidence',jsonb_build_object('required',true,'maxHours',24)),
    jsonb_build_object('code','explicit_creation_authorization','status','blocked','evidence',jsonb_build_object('requiredForMilestone','M40')),
    jsonb_build_object('code','zero_side_effects','status','passed','evidence',v_zero_effects));
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at) VALUES (v_pack_event_id,v_org_id,'m39-approval-pack:event','UatActivationApprovalPack.Compiled',2,
    'uat_activation_approval_pack',v_pack_id,v_correlation_id,v_owner_id,'m39-uat-authorization',
    jsonb_build_object('definitionHash',v_pack_hash,'pendingDecisionCount',2,'executionDecision','no_go','externalCalls',0),v_now);
  UPDATE public.uat_activation_approval_packs SET status='superseded' WHERE organization_id=v_org_id AND status='draft';
  INSERT INTO public.uat_activation_approval_packs (id,organization_id,approval_pack_key,version,status,provisioning_package_id,
    provisioning_package_definition_hash,definition,definition_hash,previous_approval_pack_id,compiled_by_actor_id,reason,
    idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_pack_id,v_org_id,'uat-sydney-governed-activation-approval',1,'draft',v_package_id,v_package_hash,v_pack,
    v_pack_hash,NULL,v_owner_id,'Freeze the approved budget and synthetic scope while retaining two explicit M40 blockers.',
    'm39-approval-pack',encode(digest('m39-approval-pack','sha256'),'hex'),v_pack_event_id,v_now);
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at) VALUES (v_pack_evaluation_event_id,v_org_id,'m39-approval-pack-evaluation:event','UatActivationApprovalPack.Evaluated',2,
    'uat_activation_approval_pack',v_pack_id,v_correlation_id,v_reviewer_id,'m39-uat-authorization',
    jsonb_build_object('status','blocked','blockerCount',2,'executionDecision','no_go','sideEffects',v_zero_effects),v_now);
  INSERT INTO public.uat_activation_approval_evaluations (id,organization_id,approval_pack_id,approval_pack_definition_hash,
    policy_version,status,recommendation,execution_decision,blocker_count,checks,side_effects,run_by_actor_id,reason,
    idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_pack_evaluation_id,v_org_id,v_pack_id,v_pack_hash,'1.0','blocked','blocked','no_go',2,v_pack_checks,
    v_zero_effects,v_reviewer_id,'Confirm the execution window and explicit M40 creation approval are still missing.',
    'm39-approval-pack-evaluation',encode(digest('m39-approval-pack-evaluation','sha256'),'hex'),v_pack_evaluation_event_id,v_now);

  v_change_set:=v_runbook;
  v_change_set_hash:=encode(digest(v_change_set::text,'sha256'),'hex');
  v_request:=jsonb_build_object(
    'schemaVersion','2.0','sourceEnvironment','DEV','targetEnvironment','UAT','mode','authorization_request_draft',
    'execution','prohibited','providerActions','disabled','executor','absent',
    'sourceApprovalPack',jsonb_build_object('id',v_pack_id,'definitionHash',v_pack_hash,
      'evaluationId',v_pack_evaluation_id,'evaluationStatus','blocked','blockerCount',2),
    'target',jsonb_build_object('region','Sydney','computeRegion','Singapore','retentionDays',30),
    'currentPolicy',v_pack->'currentPolicy','proposedPolicy',jsonb_build_object('customerConfirmed',false,
      'customerConfirmationRequiredForSyntheticUat',false,'monthlyBudgetUsd',40,'estimatedMonthlyCostUsd',33,
      'dataMode','synthetic_only','realDataApproved',false,'windowStartsAt',NULL,'windowEndsAt',NULL,
      'resourceCreationAuthorized',false),'changeSet',v_change_set,
    'riskControls',jsonb_build_object('secretValues','prohibited','dataCopy','none','externalIngress','disabled',
      'externalDelivery','disabled','rollback','remove_unexposed_target','finalAuthorizationRequired',true),
    'requestGate',jsonb_build_object('status','not_submitted','submissionAllowed',false,'authorizationGranted',false));
  v_request_hash:=encode(digest(v_request::text,'sha256'),'hex');
  v_request_checks:=jsonb_build_array(
    jsonb_build_object('code','activation_snapshot_current','status','passed','evidence',jsonb_build_object('approvalPackId',v_pack_id)),
    jsonb_build_object('code','positive_budget_covers_cost','status','passed','evidence',jsonb_build_object('limitUsd',40,'estimateUsd',33)),
    jsonb_build_object('code','data_scope_explicit','status','passed','evidence',jsonb_build_object('mode','synthetic_only','realDataApproved',false)),
    jsonb_build_object('code','bounded_execution_window','status','blocked','evidence',jsonb_build_object('maxHours',24)),
    jsonb_build_object('code','explicit_creation_authorization','status','blocked','evidence',jsonb_build_object('milestone','M40')),
    jsonb_build_object('code','all_change_steps_disabled','status','passed','evidence',jsonb_build_object('steps',10,'enabledSteps',0)),
    jsonb_build_object('code','zero_side_effects','status','passed','evidence',v_zero_effects));
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at) VALUES (v_request_event_id,v_org_id,'m39-final-request:event','UatFinalAuthorizationRequest.Compiled',2,
    'uat_final_authorization_request',v_request_id,v_correlation_id,v_owner_id,'m39-uat-authorization',
    jsonb_build_object('definitionHash',v_request_hash,'blockerCount',2,'authorizationGranted',false,'externalCalls',0),v_now);
  UPDATE public.uat_final_authorization_requests SET status='superseded' WHERE organization_id=v_org_id AND status='draft';
  INSERT INTO public.uat_final_authorization_requests (id,organization_id,request_key,version,status,approval_pack_id,
    approval_pack_definition_hash,approval_evaluation_id,definition,definition_hash,change_set,change_set_hash,
    previous_request_id,compiled_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (v_request_id,v_org_id,'uat-sydney-governed-final-request',1,'draft',v_pack_id,v_pack_hash,v_pack_evaluation_id,
    v_request,v_request_hash,v_change_set,v_change_set_hash,NULL,v_owner_id,
    'Compile the final M40 creation request draft without submitting, authorizing or executing it.',
    'm39-final-request',encode(digest('m39-final-request','sha256'),'hex'),v_request_event_id,v_now);
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at) VALUES (v_request_evaluation_event_id,v_org_id,'m39-final-request-evaluation:event','UatFinalAuthorizationRequest.Evaluated',2,
    'uat_final_authorization_request',v_request_id,v_correlation_id,v_reviewer_id,'m39-uat-authorization',
    jsonb_build_object('status','blocked','blockerCount',2,'authorizationGranted',false,'executionDecision','no_go','sideEffects',v_zero_effects),v_now);
  INSERT INTO public.uat_final_authorization_evaluations (id,organization_id,request_id,request_definition_hash,policy_version,
    status,recommendation,execution_decision,blocker_count,checks,side_effects,run_by_actor_id,reason,idempotency_key,
    request_fingerprint,event_id,created_at)
  VALUES (v_request_evaluation_id,v_org_id,v_request_id,v_request_hash,'1.0','blocked','blocked','no_go',2,
    v_request_checks,v_zero_effects,v_reviewer_id,'Verify the draft remains blocked by execution window and explicit creation approval.',
    'm39-final-request-evaluation',encode(digest('m39-final-request-evaluation','sha256'),'hex'),v_request_evaluation_event_id,v_now);

  v_bundle_hash:=encode(digest(concat_ws('|',v_manifest_hash,v_blueprint_hash,v_package_hash,v_pack_hash,
    v_request_hash,v_current_policy::text,v_cost_plan::text,v_iac_plan::text,v_destruction_plan::text),'sha256'),'hex');
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at) VALUES (v_bundle_event_id,v_org_id,'m39-authorization-bundle:event','UatAuthorization.Recompiled',1,
    'uat_authorization_recompilation',v_bundle_id,v_correlation_id,v_owner_id,'m39-uat-authorization',
    jsonb_build_object('bundleHash',v_bundle_hash,'monthlyBudgetLimitUsd',40,'realDataApproved',false,
      'resourceCreationAuthorized',false,'remainingBlockers',2,'sideEffects',v_zero_effects),v_now);
  INSERT INTO public.uat_authorization_recompilations (id,organization_id,authorization_key,version,release_manifest_id,
    blueprint_id,provisioning_package_id,activation_approval_pack_id,final_authorization_request_id,current_policy,
    cost_plan,iac_plan,secret_references,destruction_plan,actual_effects,bundle_hash,compiled_by_actor_id,reason,
    idempotency_key,event_id,created_at)
  VALUES (v_bundle_id,v_org_id,'uat-sydney-synthetic',1,v_manifest_id,v_blueprint_id,v_package_id,v_pack_id,v_request_id,
    v_current_policy,v_cost_plan,v_iac_plan,v_secret_references,v_destruction_plan,v_zero_effects,v_bundle_hash,v_owner_id,
    'Recompile the approved M39 governance chain while creating no UAT resource and granting no execution authority.',
    'm39-authorization-bundle',v_bundle_event_id,v_now);
END;
$$;

SELECT jsonb_build_object(
  'milestone','M39','authorizationVersion',bundle.version,
  'monthlyBudgetLimitUsd',(bundle.current_policy->>'monthlyBudgetLimitUsd')::numeric,
  'estimatedMonthlyCostUsd',(bundle.cost_plan->>'estimatedMonthlyCostUsd')::numeric,
  'dataRegion',bundle.current_policy->>'dataRegion','computeRegion',bundle.current_policy->>'computeRegion',
  'retentionDays',(bundle.current_policy->>'retentionDays')::integer,
  'realDataApproved',(bundle.current_policy->>'realDataApproved')::boolean,
  'resourceCreationAuthorized',(bundle.current_policy->>'resourceCreationAuthorized')::boolean,
  'executionWindow',bundle.current_policy->'executionWindow',
  'remainingBlockers',evaluation.blocker_count,'executionDecision',evaluation.execution_decision,
  'actualEffects',bundle.actual_effects,'secretReferenceCount',jsonb_array_length(bundle.secret_references),
  'bundleHash',bundle.bundle_hash
) AS m39_result
FROM public.uat_authorization_recompilations bundle
JOIN public.uat_final_authorization_evaluations evaluation
  ON evaluation.request_id=bundle.final_authorization_request_id
WHERE bundle.authorization_key='uat-sydney-synthetic'
ORDER BY bundle.version DESC LIMIT 1;
