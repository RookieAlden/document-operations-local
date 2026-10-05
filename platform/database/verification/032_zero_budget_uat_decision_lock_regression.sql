BEGIN;

DO $$
DECLARE
    org public.organizations%ROWTYPE;
    owner_id uuid:=gen_random_uuid();
    reviewer_id uuid:=gen_random_uuid();
    at_time timestamptz:=date_trunc('second',now());
    declarations jsonb;
    definition jsonb;
    result jsonb;
    manifest_id uuid;
    blueprint_id uuid;
    owner_mismatch_rejected boolean:=false;
    notifications_before integer;
    notifications_after integer;
BEGIN
    SELECT * INTO org FROM public.organizations ORDER BY created_at,id LIMIT 1;
    IF org.id IS NULL THEN RAISE EXCEPTION 'M32 requires one DEV organization'; END IF;
    PERFORM public.dop_set_organization_context(org.organization_key);
    SELECT count(*) INTO notifications_before FROM public.notifications WHERE organization_id=org.id;

    INSERT INTO public.actors (id,organization_id,external_subject_id,actor_type,display_name,email,status,attributes,created_at,updated_at)
    VALUES
      (owner_id,org.id,'m32-owner-'||owner_id,'admin','M32 synthetic owner','m32-owner-'||owner_id||'@example.invalid','active','{"synthetic":true}',at_time,at_time),
      (reviewer_id,org.id,'m32-reviewer-'||reviewer_id,'admin','M32 synthetic reviewer','m32-reviewer-'||reviewer_id||'@example.invalid','active','{"synthetic":true}',at_time,at_time);

    declarations:=jsonb_build_object(
        'schemaVersion','1.0','sourceEnvironment','DEV','targetEnvironment','UAT',
        'targetProvisioning','not_started','runtimeExecution','disabled','externalDelivery','disabled',
        'externalIngress','disabled','dataBoundary','synthetic_only','approvals',jsonb_build_object(
            'dataRegion',jsonb_build_object('status','approved','reference','verification://m32/sydney'),
            'privacyRetention',jsonb_build_object('status','approved','reference','verification://m32/30-days'),
            'budget',jsonb_build_object('status','approved','reference','verification://m32/zero-budget','monthlyLimitUsd',0),
            'sharedMailbox',jsonb_build_object('status','not_required','reference',NULL)
        ),'secretReferences','[]'::jsonb
    );
    IF public.dop_release_declarations_error(declarations) IS NOT NULL THEN
        RAISE EXCEPTION 'zero-dollar release declaration rejected';
    END IF;
    IF public.dop_release_declarations_error(jsonb_set(declarations,'{approvals,budget,monthlyLimitUsd}','1'))
       <> 'release_budget_limit_invalid' THEN
        RAISE EXCEPTION 'positive release budget accepted';
    END IF;

    result:=public.dop_create_release_manifest(owner_id,'m32-zero-budget',declarations,
        'Freeze the zero-dollar synthetic-only UAT governance inputs.','m32-release-create',gen_random_uuid(),at_time);
    IF result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'M32 release create failed: %',result; END IF;
    manifest_id:=(result->>'manifestId')::uuid;
    result:=public.dop_evaluate_release_manifest(owner_id,manifest_id,
        'Evaluate the zero-dollar UAT governance evidence without provisioning.','m32-release-evaluate',gen_random_uuid(),at_time);
    IF result->>'status'<>'passed' THEN RAISE EXCEPTION 'M32 release evaluation failed: %',result; END IF;
    PERFORM public.dop_submit_release_manifest(owner_id,manifest_id,
        'Submit zero-dollar UAT evidence for independent synthetic review.','m32-release-submit',gen_random_uuid(),at_time);
    result:=public.dop_decide_release_manifest(reviewer_id,manifest_id,'approve',
        'Approve zero-dollar governance evidence without authorizing deployment.','m32-release-approve',gen_random_uuid(),at_time);
    IF result->>'status'<>'approved' THEN RAISE EXCEPTION 'M32 release approval failed: %',result; END IF;

    definition:=jsonb_build_object(
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
            'dataRegion',jsonb_build_object('status','approved','reference','decision://m32/sydney','region','Sydney'),
            'privacyRetention',jsonb_build_object('status','approved','reference','decision://m32/30-days',
                'retentionDays',30,'realDataRequiresReapproval',true),
            'budget',jsonb_build_object('status','approved','reference','decision://m32/zero-budget',
                'monthlyLimitUsd',0,'paidResourceProvisioning','prohibited'),
            'runtimeOwner',jsonb_build_object('status','approved','reference','decision://m32/project-owner','actorId',owner_id)
        ),'variableNames',jsonb_build_array(
            'DOP_ENVIRONMENT','DOP_ORGANIZATION_KEY','DATABASE_URL','OPENAI_API_KEY','DOP_OPS_SESSION_SECRET'),
        'secretReferences','[]'::jsonb,
        'migration',jsonb_build_object('strategy','ordered_sql','seedMode','synthetic_only',
            'migrations',jsonb_build_array('001..028'),
            'verificationScripts',jsonb_build_array('032_zero_budget_uat_decision_lock_regression.sql')),
        'acceptance',jsonb_build_object('healthCheck','required','errorLogs','zero_required',
            'syntheticJourney','required','realData','prohibited'),
        'rollback',jsonb_build_object('strategy','remove_unexposed_target','preserveAuditEvidence',true,'maxMinutes',30)
    );
    IF public.dop_uat_blueprint_definition_error(definition) IS NOT NULL THEN
        RAISE EXCEPTION 'approved M32 definition rejected: %',public.dop_uat_blueprint_definition_error(definition);
    END IF;
    IF public.dop_uat_blueprint_definition_error(jsonb_set(definition,'{decisions,budget,monthlyLimitUsd}','1'))
       <> 'uat_blueprint_budget_invalid' THEN RAISE EXCEPTION 'positive UAT budget accepted'; END IF;
    IF public.dop_uat_blueprint_definition_error(jsonb_set(definition,'{decisions,privacyRetention,retentionDays}','31'))
       <> 'uat_blueprint_privacy_invalid' THEN RAISE EXCEPTION 'retention drift accepted'; END IF;

    BEGIN
        PERFORM public.dop_create_uat_environment_blueprint(owner_id,'m32-owner-mismatch',manifest_id,
            jsonb_set(definition,'{decisions,runtimeOwner,actorId}',to_jsonb(reviewer_id::text)),
            'Reject a runtime owner that differs from the creating administrator.',
            'm32-owner-mismatch',gen_random_uuid(),at_time);
    EXCEPTION WHEN check_violation THEN owner_mismatch_rejected:=true;
    END;
    IF NOT owner_mismatch_rejected THEN RAISE EXCEPTION 'runtime owner mismatch accepted'; END IF;

    result:=public.dop_create_uat_environment_blueprint(owner_id,'m32-zero-budget',manifest_id,definition,
        'Record the approved zero-dollar UAT blueprint without provisioning.','m32-blueprint-create',gen_random_uuid(),at_time);
    IF result->>'outcome'<>'completed' OR (result->>'targetEnvironmentCreated')::boolean THEN
        RAISE EXCEPTION 'M32 blueprint create failed: %',result;
    END IF;
    blueprint_id:=(result->>'blueprintId')::uuid;
    result:=public.dop_run_uat_blueprint_dry_run(reviewer_id,blueprint_id,
        'Verify Sydney, thirty-day retention and zero paid resources in dry-run.','m32-dry-run',gen_random_uuid(),at_time);
    IF result->>'status'<>'passed' OR (result->>'blockerCount')::integer<>0 THEN
        RAISE EXCEPTION 'M32 dry-run failed: %',result;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.uat_blueprint_dry_runs run,
        LATERAL jsonb_array_elements(run.checks) check_item
        WHERE run.id=(result->>'dryRunId')::uuid
          AND check_item->>'code'='zero_budget_paid_resources_prohibited'
          AND check_item->>'status'='passed') THEN
        RAISE EXCEPTION 'zero-budget dry-run evidence missing';
    END IF;
    IF (SELECT side_effects#>>'{paidResourcesCreated}' FROM public.uat_blueprint_dry_runs
        WHERE id=(result->>'dryRunId')::uuid)<>'0' THEN
        RAISE EXCEPTION 'paid resource side effect is not zero';
    END IF;
    SELECT count(*) INTO notifications_after FROM public.notifications WHERE organization_id=org.id;
    IF notifications_after<>notifications_before THEN RAISE EXCEPTION 'M32 created a notification'; END IF;
END;
$$;

SELECT jsonb_build_object(
    'verification','passed','region','Sydney','retentionDays',30,
    'realDataRequiresReapproval',true,'monthlyBudgetUsd',0,
    'paidResourceProvisioning','prohibited','paidResourcesCreated',0,
    'targetEnvironmentCreated',false,'servicesCreated',0,'externalCalls',0,
    'notificationsCreated',0,'persistentSideEffects',0
) AS m32_result;

ROLLBACK;
