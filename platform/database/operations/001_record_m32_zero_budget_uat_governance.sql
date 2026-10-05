-- One-time, idempotent M32 governance operation for the existing DEV project.
-- Creates governance evidence only. It does not provision, start, resize or connect to UAT resources.
DO $$
DECLARE
    owner_id constant uuid:='00000000-0000-4000-8400-000000000402'; -- DEV Owner
    reviewer_id constant uuid:='00000000-0000-4000-8300-000000000301'; -- synthetic independent manager
    at_time timestamptz:=date_trunc('second',now());
    declarations jsonb;
    definition jsonb;
    result jsonb;
    manifest_id uuid;
    blueprint_id uuid;
BEGIN
    PERFORM public.dop_set_organization_context('dev-accounting-firm');
    IF EXISTS (SELECT 1 FROM public.release_manifests WHERE manifest_key='dev-to-uat-zero-budget')
       OR EXISTS (SELECT 1 FROM public.uat_environment_blueprints WHERE blueprint_key='uat-sydney-zero-budget') THEN
        RAISE EXCEPTION 'M32 governance records already exist; inspect instead of creating another version';
    END IF;

    declarations:=jsonb_build_object(
        'schemaVersion','1.0','sourceEnvironment','DEV','targetEnvironment','UAT',
        'targetProvisioning','not_started','runtimeExecution','disabled','externalDelivery','disabled',
        'externalIngress','disabled','dataBoundary','synthetic_only','approvals',jsonb_build_object(
            'dataRegion',jsonb_build_object('status','approved','reference','decision://uat/region/sydney'),
            'privacyRetention',jsonb_build_object('status','approved',
                'reference','decision://uat/retention/30-days-real-data-reapproval'),
            'budget',jsonb_build_object('status','approved',
                'reference','decision://uat/budget/zero-paid-resources-prohibited','monthlyLimitUsd',0),
            'sharedMailbox',jsonb_build_object('status','not_required','reference',NULL)
        ),'secretReferences','[]'::jsonb
    );
    result:=public.dop_create_release_manifest(owner_id,'dev-to-uat-zero-budget',declarations,
        'Freeze approved Sydney, thirty-day and zero-dollar UAT governance decisions.',
        'm32-governance-release-create',gen_random_uuid(),at_time);
    IF result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'release create failed: %',result; END IF;
    manifest_id:=(result->>'manifestId')::uuid;
    result:=public.dop_evaluate_release_manifest(owner_id,manifest_id,
        'Evaluate the approved zero-dollar UAT governance record without provisioning.',
        'm32-governance-release-evaluate',gen_random_uuid(),at_time);
    IF result->>'status'<>'passed' THEN RAISE EXCEPTION 'release evaluation failed: %',result; END IF;
    result:=public.dop_submit_release_manifest(owner_id,manifest_id,
        'Submit the approved zero-dollar UAT governance record for independent review.',
        'm32-governance-release-submit',gen_random_uuid(),at_time);
    IF result->>'status'<>'in_review' THEN RAISE EXCEPTION 'release submit failed: %',result; END IF;
    result:=public.dop_decide_release_manifest(reviewer_id,manifest_id,'approve',
        'Independently confirm the governance evidence without authorizing UAT deployment.',
        'm32-governance-release-approve',gen_random_uuid(),at_time);
    IF result->>'status'<>'approved' THEN RAISE EXCEPTION 'release approval failed: %',result; END IF;

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
            'dataRegion',jsonb_build_object('status','approved','reference','decision://uat/region/sydney','region','Sydney'),
            'privacyRetention',jsonb_build_object('status','approved',
                'reference','decision://uat/retention/30-days-real-data-reapproval',
                'retentionDays',30,'realDataRequiresReapproval',true),
            'budget',jsonb_build_object('status','approved',
                'reference','decision://uat/budget/zero-paid-resources-prohibited',
                'monthlyLimitUsd',0,'paidResourceProvisioning','prohibited'),
            'runtimeOwner',jsonb_build_object('status','approved',
                'reference','decision://uat/runtime-owner/dev-owner','actorId',owner_id)
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
    result:=public.dop_create_uat_environment_blueprint(owner_id,'uat-sydney-zero-budget',manifest_id,definition,
        'Record the approved Sydney zero-dollar UAT blueprint without provisioning.',
        'm32-governance-blueprint-create',gen_random_uuid(),at_time);
    IF result->>'outcome'<>'completed' OR (result->>'targetEnvironmentCreated')::boolean THEN
        RAISE EXCEPTION 'blueprint create failed: %',result;
    END IF;
    blueprint_id:=(result->>'blueprintId')::uuid;
    result:=public.dop_run_uat_blueprint_dry_run(reviewer_id,blueprint_id,
        'Confirm every M32 decision and zero paid resources in a no-side-effect dry-run.',
        'm32-governance-dry-run',gen_random_uuid(),at_time);
    IF result->>'status'<>'passed' OR (result->>'blockerCount')::integer<>0 THEN
        RAISE EXCEPTION 'blueprint dry-run failed: %',result;
    END IF;
END;
$$;

SELECT jsonb_build_object(
    'manifestId',manifest.id,'manifestStatus',manifest.status,
    'blueprintId',blueprint.id,'blueprintStatus',blueprint.status,
    'dryRunId',run.id,'dryRunStatus',run.status,'blockerCount',run.blocker_count,
    'region',blueprint.definition#>>'{decisions,dataRegion,region}',
    'retentionDays',(blueprint.definition#>>'{decisions,privacyRetention,retentionDays}')::integer,
    'realDataRequiresReapproval',(blueprint.definition#>>'{decisions,privacyRetention,realDataRequiresReapproval}')::boolean,
    'monthlyBudgetUsd',(blueprint.definition#>>'{decisions,budget,monthlyLimitUsd}')::numeric,
    'paidResourceProvisioning',blueprint.definition#>>'{decisions,budget,paidResourceProvisioning}',
    'runtimeOwner',owner_actor.display_name,'reviewer',reviewer_actor.display_name,
    'targetEnvironmentCreated',false,'paidResourcesCreated',run.side_effects#>>'{paidResourcesCreated}',
    'externalCalls',run.side_effects#>>'{externalCalls}'
) AS m32_governance_result
FROM public.release_manifests manifest
JOIN public.uat_environment_blueprints blueprint ON blueprint.release_manifest_id=manifest.id
JOIN LATERAL (
    SELECT * FROM public.uat_blueprint_dry_runs candidate
     WHERE candidate.blueprint_id=blueprint.id ORDER BY candidate.created_at DESC LIMIT 1
) run ON true
JOIN public.actors owner_actor ON owner_actor.id=blueprint.created_by_actor_id
JOIN public.actors reviewer_actor ON reviewer_actor.id=run.run_by_actor_id
WHERE manifest.manifest_key='dev-to-uat-zero-budget'
  AND blueprint.blueprint_key='uat-sydney-zero-budget';
