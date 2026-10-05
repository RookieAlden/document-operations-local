BEGIN;

DO $$
DECLARE
    org public.organizations%ROWTYPE;
    owner_id uuid:=gen_random_uuid(); reviewer_id uuid:=gen_random_uuid();
    blueprint_id uuid:=gen_random_uuid(); blueprint_event_id uuid:=gen_random_uuid(); blueprint_run_event_id uuid:=gen_random_uuid();
    definition jsonb; result jsonb; package_id uuid; at_time timestamptz:=date_trunc('second',now());
    notifications_before integer; notifications_after integer;
BEGIN
    SELECT * INTO org FROM public.organizations ORDER BY created_at,id LIMIT 1;
    IF org.id IS NULL THEN RAISE EXCEPTION 'M33 requires one DEV organization'; END IF;
    PERFORM public.dop_set_organization_context(org.organization_key);
    SELECT count(*) INTO notifications_before FROM public.notifications WHERE organization_id=org.id;
    INSERT INTO public.actors (id,organization_id,external_subject_id,actor_type,display_name,email,status,attributes,created_at,updated_at)
    VALUES
      (owner_id,org.id,'m33-owner-'||owner_id,'admin','M33 synthetic owner','m33-owner-'||owner_id||'@example.invalid','active','{"synthetic":true}',at_time,at_time),
      (reviewer_id,org.id,'m33-reviewer-'||reviewer_id,'manager','M33 synthetic reviewer','m33-reviewer-'||reviewer_id||'@example.invalid','active','{"synthetic":true}',at_time,at_time);
    definition:=jsonb_build_object(
      'schemaVersion','1.0','sourceEnvironment','DEV','targetEnvironment','UAT','provisioningMode','dry_run_only',
      'targetProvisioning','not_started','dataBoundary','synthetic_only','dataCopy','none','runtimeExecution','disabled',
      'externalIngress','disabled','externalDelivery','disabled','secretMaterialization','disabled',
      'topology',jsonb_build_object('provider','railway','isolation','dedicated_environment','database','dedicated_supabase_project',
        'storage','dedicated_private_bucket','services',jsonb_build_array(
          jsonb_build_object('key','intake','plannedExposure','internal_only','replicas',1,'runtimeState','disabled'),
          jsonb_build_object('key','preservation','plannedExposure','internal_only','replicas',1,'runtimeState','disabled'),
          jsonb_build_object('key','classification','plannedExposure','internal_only','replicas',1,'runtimeState','disabled'))),
      'decisions',jsonb_build_object(
        'dataRegion',jsonb_build_object('status','approved','reference','verification://m33/sydney','region','Sydney'),
        'privacyRetention',jsonb_build_object('status','approved','reference','verification://m33/30-days','retentionDays',30,'realDataRequiresReapproval',true),
        'budget',jsonb_build_object('status','approved','reference','verification://m33/zero-budget','monthlyLimitUsd',0,'paidResourceProvisioning','prohibited'),
        'runtimeOwner',jsonb_build_object('status','approved','reference','verification://m33/owner','actorId',owner_id)),
      'variableNames',jsonb_build_array('DOP_ENVIRONMENT','DOP_ORGANIZATION_KEY','DATABASE_URL','OPENAI_API_KEY','DOP_OPS_SESSION_SECRET'),
      'secretReferences','[]'::jsonb,
      'migration',jsonb_build_object('strategy','ordered_sql','seedMode','synthetic_only','migrations',jsonb_build_array('001..029'),
        'verificationScripts',jsonb_build_array('033_uat_provisioning_package_regression.sql')),
      'acceptance',jsonb_build_object('healthCheck','required','errorLogs','zero_required','syntheticJourney','required','realData','prohibited'),
      'rollback',jsonb_build_object('strategy','remove_unexposed_target','preserveAuditEvidence',true,'maxMinutes',30));
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
      aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (blueprint_event_id,org.id,'m33-verification-blueprint-event','UatEnvironmentBlueprint.Created',1,
      'uat_environment_blueprint',blueprint_id,gen_random_uuid(),owner_id,'m33-verification','{}',at_time);
    INSERT INTO public.uat_environment_blueprints (id,organization_id,blueprint_key,version,status,definition,definition_hash,
      deployment_plan,deployment_plan_hash,created_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
    VALUES (blueprint_id,org.id,'m33-verification-blueprint',1,'draft',definition,encode(digest(definition::text,'sha256'),'hex'),
      public.dop_build_uat_deployment_plan(definition),repeat('a',64),owner_id,'Verify the M33 package compiler contract.',
      'm33-verification-blueprint',repeat('b',64),blueprint_event_id,at_time);
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
      aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (blueprint_run_event_id,org.id,'m33-verification-blueprint-run-event','UatEnvironmentBlueprint.DryRunCompleted',1,
      'uat_environment_blueprint',blueprint_id,gen_random_uuid(),reviewer_id,'m33-verification','{}',at_time);
    INSERT INTO public.uat_blueprint_dry_runs (organization_id,blueprint_id,blueprint_definition_hash,policy_version,status,
      blocker_count,checks,side_effects,run_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
    VALUES (org.id,blueprint_id,encode(digest(definition::text,'sha256'),'hex'),'1.0','passed',0,'[]','{}',reviewer_id,
      'Provide fresh passing synthetic blueprint evidence.','m33-verification-blueprint-run',repeat('c',64),blueprint_run_event_id,at_time);
    result:=public.dop_compile_uat_provisioning_package(owner_id,blueprint_id,
      'Compile the deterministic non-executable M33 package.','m33-verification-package',gen_random_uuid(),at_time);
    IF result->>'outcome'<>'completed' OR result->>'executionDecision'<>'no_go'
       OR (result->>'provisioningAuthorized')::boolean OR (result->>'resourcesCreated')::integer<>0 THEN
      RAISE EXCEPTION 'M33 package compile failed: %',result;
    END IF;
    package_id:=(result->>'packageId')::uuid;
    IF public.dop_uat_provisioning_package_definition_error(
        jsonb_set((SELECT stored.definition FROM public.uat_provisioning_packages stored WHERE stored.id=package_id),'{railwayPlan,environment,create}','true'))
       <> 'uat_provisioning_package_invalid' THEN RAISE EXCEPTION 'resource creation drift accepted'; END IF;
    result:=public.dop_run_uat_provisioning_package_dry_run(reviewer_id,package_id,
      'Verify NO-GO, zero cost and zero external side effects.','m33-verification-package-run',gen_random_uuid(),at_time);
    IF result->>'status'<>'passed' OR result->>'executionDecision'<>'no_go' OR (result->>'blockerCount')::integer<>0
       OR (result#>>'{sideEffects,externalCalls}')::integer<>0
       OR (result#>>'{sideEffects,estimatedAddedMonthlyCostUsd}')::numeric<>0 THEN
      RAISE EXCEPTION 'M33 package dry-run failed: %',result;
    END IF;
    SELECT count(*) INTO notifications_after FROM public.notifications WHERE organization_id=org.id;
    IF notifications_after<>notifications_before THEN RAISE EXCEPTION 'M33 created a notification'; END IF;
END;
$$;

SELECT jsonb_build_object(
  'verification','passed','region','Sydney','retentionDays',30,'syntheticOnly',true,
  'executionDecision','no_go','provisioningAuthorized',false,'monthlyBudgetUsd',0,
  'environmentsCreated',0,'servicesCreated',0,'databasesCreated',0,'storageBucketsCreated',0,
  'domainsCreated',0,'schedulersCreated',0,'secretValuesResolved',0,'externalCalls',0,
  'estimatedAddedMonthlyCostUsd',0,'notificationsCreated',0
) AS m33_result;

ROLLBACK;
