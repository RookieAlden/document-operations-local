BEGIN;

DO $$
DECLARE
    org public.organizations%ROWTYPE;
    admin_one uuid:=gen_random_uuid();
    admin_two uuid:=gen_random_uuid();
    staff_actor uuid:=gen_random_uuid();
    at_time timestamptz:=date_trunc('second',now());
    approvals jsonb:=jsonb_build_object(
        'schemaVersion','1.0','sourceEnvironment','DEV','targetEnvironment','UAT',
        'targetProvisioning','not_started','runtimeExecution','disabled','externalDelivery','disabled',
        'externalIngress','disabled','dataBoundary','synthetic_only','approvals',jsonb_build_object(
            'dataRegion',jsonb_build_object('status','approved','reference','verification://m31/region'),
            'privacyRetention',jsonb_build_object('status','approved','reference','verification://m31/retention'),
            'budget',jsonb_build_object('status','approved','reference','verification://m31/budget','monthlyLimitUsd',0),
            'sharedMailbox',jsonb_build_object('status','not_required','reference',NULL)
        ),'secretReferences',jsonb_build_array('verification://m31/database')
    );
    pending_definition jsonb;
    approved_definition jsonb;
    manifest_result jsonb;
    evaluate_result jsonb;
    submit_result jsonb;
    approve_result jsonb;
    create_result jsonb;
    duplicate_result jsonb;
    invalid_result jsonb;
    blocked_result jsonb;
    passed_result jsonb;
    manifest_id uuid;
    blueprint_id uuid;
    notifications_before integer;
    notifications_after integer;
    staff_denied boolean:=false;
BEGIN
    SELECT * INTO org FROM public.organizations ORDER BY created_at,id LIMIT 1;
    IF org.id IS NULL THEN RAISE EXCEPTION 'M31 requires one DEV organization'; END IF;
    PERFORM public.dop_set_organization_context(org.organization_key);
    SELECT count(*) INTO notifications_before FROM public.notifications WHERE organization_id=org.id;
    INSERT INTO public.actors (id,organization_id,external_subject_id,actor_type,display_name,email,status,attributes,created_at,updated_at)
    VALUES
      (admin_one,org.id,'m31-admin-one-'||admin_one,'admin','M31 synthetic planner','m31-planner-'||admin_one||'@example.invalid','active','{"synthetic":true}',at_time,at_time),
      (admin_two,org.id,'m31-admin-two-'||admin_two,'admin','M31 synthetic reviewer','m31-reviewer-'||admin_two||'@example.invalid','active','{"synthetic":true}',at_time,at_time),
      (staff_actor,org.id,'m31-staff-'||staff_actor,'staff','M31 synthetic staff','m31-staff-'||staff_actor||'@example.invalid','active','{"synthetic":true}',at_time,at_time);

    manifest_result:=public.dop_create_release_manifest(admin_one,'m31-dev-to-uat',approvals,
        'Freeze synthetic M31 release inputs for blueprint verification only.','m31-manifest-create',gen_random_uuid(),at_time);
    IF manifest_result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'M31 manifest creation failed: %',manifest_result; END IF;
    manifest_id:=(manifest_result->>'manifestId')::uuid;
    evaluate_result:=public.dop_evaluate_release_manifest(admin_one,manifest_id,
        'Evaluate the exact synthetic M31 release inputs before blueprint reference.','m31-manifest-evaluate',gen_random_uuid(),at_time);
    IF evaluate_result->>'status'<>'passed' THEN RAISE EXCEPTION 'M31 manifest evaluation failed: %',evaluate_result; END IF;
    submit_result:=public.dop_submit_release_manifest(admin_one,manifest_id,
        'Submit synthetic M31 release inputs for independent verification approval.','m31-manifest-submit',gen_random_uuid(),at_time);
    approve_result:=public.dop_decide_release_manifest(admin_two,manifest_id,'approve',
        'Independently approve synthetic M31 release inputs without provisioning UAT.','m31-manifest-approve',gen_random_uuid(),at_time);
    IF submit_result->>'status'<>'in_review' OR approve_result->>'status'<>'approved' THEN
        RAISE EXCEPTION 'M31 manifest approval failed: %, %',submit_result,approve_result;
    END IF;

    pending_definition:=jsonb_build_object(
        'schemaVersion','1.0','sourceEnvironment','DEV','targetEnvironment','UAT',
        'provisioningMode','dry_run_only','targetProvisioning','not_started','dataBoundary','synthetic_only',
        'dataCopy','none','runtimeExecution','disabled','externalIngress','disabled','externalDelivery','disabled',
        'secretMaterialization','disabled','topology',jsonb_build_object(
            'provider','railway','isolation','dedicated_environment','database','dedicated_supabase_project',
            'storage','dedicated_private_bucket','services',jsonb_build_array(
                jsonb_build_object('key','intake','plannedExposure','internal_only','replicas',1,'runtimeState','disabled'),
                jsonb_build_object('key','preservation','plannedExposure','internal_only','replicas',1,'runtimeState','disabled'),
                jsonb_build_object('key','classification','plannedExposure','internal_only','replicas',1,'runtimeState','disabled')
            )
        ),'decisions',jsonb_build_object(
            'dataRegion',jsonb_build_object('status','pending','reference',NULL),
            'privacyRetention',jsonb_build_object('status','pending','reference',NULL),
            'budget',jsonb_build_object('status','pending','reference',NULL),
            'runtimeOwner',jsonb_build_object('status','pending','reference',NULL)
        ),'variableNames',jsonb_build_array('DOP_ENVIRONMENT','DOP_ORGANIZATION_KEY','DATABASE_URL','OPENAI_API_KEY','DOP_OPS_SESSION_SECRET'),
        'secretReferences',jsonb_build_array(
            jsonb_build_object('variableName','DATABASE_URL','reference','vault://uat/database-url'),
            jsonb_build_object('variableName','OPENAI_API_KEY','reference','vault://uat/openai-api-key'),
            jsonb_build_object('variableName','DOP_OPS_SESSION_SECRET','reference','vault://uat/ops-session-secret')
        ),'migration',jsonb_build_object('strategy','ordered_sql','seedMode','synthetic_only',
            'migrations',jsonb_build_array('001..027'),'verificationScripts',jsonb_build_array('031_uat_environment_blueprint_dry_run_regression.sql')),
        'acceptance',jsonb_build_object('healthCheck','required','errorLogs','zero_required','syntheticJourney','required','realData','prohibited'),
        'rollback',jsonb_build_object('strategy','remove_unexposed_target','preserveAuditEvidence',true,'maxMinutes',30)
    );

    BEGIN
        PERFORM public.dop_create_uat_environment_blueprint(staff_actor,'m31-uat',manifest_id,pending_definition,
            'Staff must not create a UAT environment blueprint.','m31-staff-denied',gen_random_uuid(),at_time);
    EXCEPTION WHEN insufficient_privilege THEN staff_denied:=true;
    END;
    IF NOT staff_denied THEN RAISE EXCEPTION 'staff created a UAT blueprint'; END IF;
    create_result:=public.dop_create_uat_environment_blueprint(admin_one,'m31-uat',manifest_id,pending_definition,
        'Create a blocked but complete UAT blueprint before policy decisions exist.','m31-blueprint-pending',gen_random_uuid(),at_time);
    IF create_result->>'outcome'<>'completed' OR (create_result->>'targetEnvironmentCreated')::boolean THEN
        RAISE EXCEPTION 'pending blueprint creation failed: %',create_result;
    END IF;
    blueprint_id:=(create_result->>'blueprintId')::uuid;
    duplicate_result:=public.dop_create_uat_environment_blueprint(admin_one,'m31-uat',manifest_id,pending_definition,
        'Create a blocked but complete UAT blueprint before policy decisions exist.','m31-blueprint-pending',gen_random_uuid(),at_time);
    IF duplicate_result->>'outcome'<>'duplicate' OR (duplicate_result->>'blueprintId')::uuid<>blueprint_id THEN
        RAISE EXCEPTION 'blueprint idempotency failed: %',duplicate_result;
    END IF;
    invalid_result:=public.dop_create_uat_environment_blueprint(admin_one,'m31-unsafe',manifest_id,
        jsonb_set(pending_definition,'{secretReferences,0,value}','"secret"'),
        'Reject a blueprint that attempts to persist a secret value.','m31-blueprint-secret',gen_random_uuid(),at_time);
    IF invalid_result->>'reason'<>'uat_blueprint_secret_reference_invalid' THEN
        RAISE EXCEPTION 'secret value was not rejected: %',invalid_result;
    END IF;
    blocked_result:=public.dop_run_uat_blueprint_dry_run(admin_two,blueprint_id,
        'Dry-run the pending blueprint and enumerate every missing decision.','m31-dry-run-blocked',gen_random_uuid(),at_time);
    IF blocked_result->>'status'<>'blocked' OR (blocked_result->>'blockerCount')::integer<>4
       OR (blocked_result#>>'{sideEffects,externalCalls}')::integer<>0 THEN
        RAISE EXCEPTION 'pending decisions were not blocked: %',blocked_result;
    END IF;

    approved_definition:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(pending_definition,
        '{decisions,dataRegion}',jsonb_build_object('status','approved','reference','decision://m31/region')),
        '{decisions,privacyRetention}',jsonb_build_object('status','approved','reference','decision://m31/retention')),
        '{decisions,budget}',jsonb_build_object('status','approved','reference','decision://m31/budget','monthlyLimitUsd',0)),
        '{decisions,runtimeOwner}',jsonb_build_object('status','approved','reference','decision://m31/runtime-owner'));
    create_result:=public.dop_create_uat_environment_blueprint(admin_one,'m31-uat',manifest_id,approved_definition,
        'Create the approved-input blueprint version for a zero-side-effect dry-run.','m31-blueprint-approved',gen_random_uuid(),at_time+interval '1 second');
    IF create_result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'approved blueprint creation failed: %',create_result; END IF;
    passed_result:=public.dop_run_uat_blueprint_dry_run(admin_two,(create_result->>'blueprintId')::uuid,
        'Confirm the complete plan while every provisioning and runtime action remains disabled.','m31-dry-run-passed',gen_random_uuid(),at_time+interval '1 second');
    IF passed_result->>'status'<>'passed' OR (passed_result->>'blockerCount')::integer<>0
       OR (passed_result#>>'{sideEffects,servicesCreated}')::integer<>0
       OR (passed_result#>>'{sideEffects,secretValuesResolved}')::integer<>0 THEN
        RAISE EXCEPTION 'approved blueprint dry-run failed: %',passed_result;
    END IF;
    IF EXISTS (SELECT 1 FROM public.uat_environment_blueprints WHERE organization_id=org.id AND (
        definition->>'targetProvisioning'<>'not_started' OR definition->>'runtimeExecution'<>'disabled'
        OR definition->>'externalIngress'<>'disabled' OR definition->>'externalDelivery'<>'disabled'
        OR definition->>'dataBoundary'<>'synthetic_only' OR definition->>'dataCopy'<>'none')) THEN
        RAISE EXCEPTION 'M31 blueprint escaped its safety boundary';
    END IF;
    SELECT count(*) INTO notifications_after FROM public.notifications WHERE organization_id=org.id;
    IF notifications_after<>notifications_before THEN RAISE EXCEPTION 'M31 created a Notification'; END IF;
    IF has_table_privilege('dop_app','public.uat_environment_blueprints','INSERT')
       OR has_table_privilege('dop_app','public.uat_environment_blueprints','UPDATE')
       OR has_table_privilege('dop_app','public.uat_environment_blueprints','DELETE')
       OR has_table_privilege('dop_app','public.uat_blueprint_dry_runs','INSERT') THEN
        RAISE EXCEPTION 'dop_app gained direct M31 write privileges';
    END IF;
    IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname IN ('uat_environment_blueprints','uat_blueprint_dry_runs') AND c.relrowsecurity)<>2 THEN
        RAISE EXCEPTION 'M31 RLS is incomplete';
    END IF;
END;
$$;

SELECT jsonb_build_object('verification','passed','pendingDecisionBlockers',4,'passingBlockers',0,
    'targetEnvironmentCreated',false,'servicesCreated',0,'secretValuesStored',false,
    'secretValuesResolved',0,'dataCopied',false,'runtimeStarted',false,'notificationsCreated',0,
    'externalCalls',0,'persistentSideEffects',0) AS m31_result;

ROLLBACK;
