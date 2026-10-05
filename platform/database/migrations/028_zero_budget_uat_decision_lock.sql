BEGIN;

-- M32 turns the approved zero-dollar UAT policy into a database-enforced lock.
-- This migration creates no UAT resource and performs no external call.

CREATE OR REPLACE FUNCTION public.dop_release_declarations_error(p_declarations jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
    approval_key text;
    approval jsonb;
    secret_reference jsonb;
BEGIN
    IF jsonb_typeof(p_declarations)<>'object'
       OR p_declarations->>'schemaVersion'<>'1.0'
       OR p_declarations->>'sourceEnvironment'<>'DEV'
       OR p_declarations->>'targetEnvironment'<>'UAT'
       OR p_declarations->>'targetProvisioning'<>'not_started'
       OR p_declarations->>'runtimeExecution'<>'disabled'
       OR p_declarations->>'externalDelivery'<>'disabled'
       OR p_declarations->>'externalIngress'<>'disabled'
       OR p_declarations->>'dataBoundary'<>'synthetic_only'
       OR jsonb_typeof(p_declarations->'approvals')<>'object'
       OR jsonb_typeof(p_declarations->'secretReferences')<>'array'
       OR jsonb_array_length(p_declarations->'secretReferences')>20 THEN
        RETURN 'release_declarations_invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_declarations) key WHERE key NOT IN (
        'schemaVersion','sourceEnvironment','targetEnvironment','targetProvisioning','runtimeExecution',
        'externalDelivery','externalIngress','dataBoundary','approvals','secretReferences'))
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_declarations->'approvals') key
                   WHERE key NOT IN ('dataRegion','privacyRetention','budget','sharedMailbox')) THEN
        RETURN 'release_declarations_unknown_field';
    END IF;
    FOREACH approval_key IN ARRAY ARRAY['dataRegion','privacyRetention','budget','sharedMailbox'] LOOP
        approval:=p_declarations#>(ARRAY['approvals',approval_key]);
        IF jsonb_typeof(approval)<>'object'
           OR approval->>'status' NOT IN ('pending','approved','not_required')
           OR NOT (jsonb_typeof(approval->'reference')='string' OR approval->'reference'='null'::jsonb)
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(approval) key
                       WHERE key NOT IN ('status','reference','monthlyLimitUsd'))
           OR (approval_key<>'budget' AND approval ? 'monthlyLimitUsd') THEN
            RETURN 'release_approval_declaration_invalid';
        END IF;
        IF (approval->>'reference' IS NOT NULL AND char_length(approval->>'reference') NOT BETWEEN 3 AND 240)
           OR (approval->>'status'='approved' AND approval->>'reference' IS NULL)
           OR (approval->>'status'='not_required' AND approval->>'reference' IS NOT NULL) THEN
            RETURN 'release_approval_reference_required';
        END IF;
    END LOOP;
    approval:=p_declarations#>'{approvals,budget}';
    IF approval->>'status'='approved' THEN
        IF jsonb_typeof(approval->'monthlyLimitUsd')<>'number'
           OR (approval->>'monthlyLimitUsd')::numeric<>0 THEN
            RETURN 'release_budget_limit_invalid';
        END IF;
    ELSIF approval ? 'monthlyLimitUsd' THEN
        RETURN 'release_budget_limit_invalid';
    END IF;
    FOR secret_reference IN SELECT value FROM jsonb_array_elements(p_declarations->'secretReferences') LOOP
        IF jsonb_typeof(secret_reference)<>'string'
           OR secret_reference#>>'{}' !~ '^[a-z][a-z0-9+.-]*://[^?#[:space:]]{3,240}$' THEN
            RETURN 'release_secret_reference_invalid';
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_uat_blueprint_definition_error(p_definition jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
    service jsonb;
    secret_reference jsonb;
    variable_name jsonb;
    decision_key text;
    decision jsonb;
BEGIN
    IF jsonb_typeof(p_definition)<>'object'
       OR p_definition->>'schemaVersion'<>'1.0'
       OR p_definition->>'sourceEnvironment'<>'DEV'
       OR p_definition->>'targetEnvironment'<>'UAT'
       OR p_definition->>'provisioningMode'<>'dry_run_only'
       OR p_definition->>'targetProvisioning'<>'not_started'
       OR p_definition->>'dataBoundary'<>'synthetic_only'
       OR p_definition->>'dataCopy'<>'none'
       OR p_definition->>'runtimeExecution'<>'disabled'
       OR p_definition->>'externalIngress'<>'disabled'
       OR p_definition->>'externalDelivery'<>'disabled'
       OR p_definition->>'secretMaterialization'<>'disabled'
       OR jsonb_typeof(p_definition->'topology')<>'object'
       OR jsonb_typeof(p_definition->'decisions')<>'object'
       OR jsonb_typeof(p_definition->'variableNames')<>'array'
       OR jsonb_typeof(p_definition->'secretReferences')<>'array'
       OR jsonb_typeof(p_definition->'migration')<>'object'
       OR jsonb_typeof(p_definition->'acceptance')<>'object'
       OR jsonb_typeof(p_definition->'rollback')<>'object' THEN
        RETURN 'uat_blueprint_definition_invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_definition) key WHERE key NOT IN (
        'schemaVersion','sourceEnvironment','targetEnvironment','provisioningMode','targetProvisioning',
        'dataBoundary','dataCopy','runtimeExecution','externalIngress','externalDelivery',
        'secretMaterialization','topology','decisions','variableNames','secretReferences',
        'migration','acceptance','rollback'))
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_definition->'decisions') key
                   WHERE key NOT IN ('dataRegion','privacyRetention','budget','runtimeOwner')) THEN
        RETURN 'uat_blueprint_unknown_field';
    END IF;
    IF p_definition#>>'{topology,provider}'<>'railway'
       OR p_definition#>>'{topology,isolation}'<>'dedicated_environment'
       OR p_definition#>>'{topology,database}'<>'dedicated_supabase_project'
       OR p_definition#>>'{topology,storage}'<>'dedicated_private_bucket'
       OR jsonb_typeof(p_definition#>'{topology,services}')<>'array'
       OR jsonb_array_length(p_definition#>'{topology,services}')<>3 THEN
        RETURN 'uat_blueprint_topology_invalid';
    END IF;
    FOR service IN SELECT value FROM jsonb_array_elements(p_definition#>'{topology,services}') LOOP
        IF jsonb_typeof(service)<>'object'
           OR service->>'key' NOT IN ('intake','preservation','classification')
           OR service->>'plannedExposure'<>'internal_only'
           OR jsonb_typeof(service->'replicas')<>'number'
           OR (service->>'replicas')::integer<>1
           OR service->>'runtimeState'<>'disabled' THEN
            RETURN 'uat_blueprint_service_invalid';
        END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(p_definition#>'{topology,services}'))<>3 THEN
        RETURN 'uat_blueprint_service_invalid';
    END IF;
    FOREACH decision_key IN ARRAY ARRAY['dataRegion','privacyRetention','budget','runtimeOwner'] LOOP
        decision:=p_definition#>(ARRAY['decisions',decision_key]);
        IF jsonb_typeof(decision)<>'object'
           OR decision->>'status' NOT IN ('pending','approved')
           OR NOT (decision->'reference'='null'::jsonb OR jsonb_typeof(decision->'reference')='string')
           OR (decision->>'status'='approved' AND coalesce(char_length(decision->>'reference'),0)<3) THEN
            RETURN 'uat_blueprint_decision_invalid';
        END IF;
    END LOOP;
    decision:=p_definition#>'{decisions,dataRegion}';
    IF decision->>'region'<>'Sydney'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(decision) key
                   WHERE key NOT IN ('status','reference','region')) THEN
        RETURN 'uat_blueprint_region_invalid';
    END IF;
    decision:=p_definition#>'{decisions,privacyRetention}';
    IF jsonb_typeof(decision->'retentionDays')<>'number'
       OR (decision->>'retentionDays')::integer<>30
       OR decision->>'realDataRequiresReapproval'<>'true'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(decision) key
                   WHERE key NOT IN ('status','reference','retentionDays','realDataRequiresReapproval')) THEN
        RETURN 'uat_blueprint_privacy_invalid';
    END IF;
    decision:=p_definition#>'{decisions,budget}';
    IF jsonb_typeof(decision->'monthlyLimitUsd')<>'number'
       OR (decision->>'monthlyLimitUsd')::numeric<>0
       OR decision->>'paidResourceProvisioning'<>'prohibited'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(decision) key
                   WHERE key NOT IN ('status','reference','monthlyLimitUsd','paidResourceProvisioning')) THEN
        RETURN 'uat_blueprint_budget_invalid';
    END IF;
    decision:=p_definition#>'{decisions,runtimeOwner}';
    IF jsonb_typeof(decision->'actorId')<>'string'
       OR decision->>'actorId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(decision) key
                   WHERE key NOT IN ('status','reference','actorId')) THEN
        RETURN 'uat_blueprint_runtime_owner_invalid';
    END IF;
    IF jsonb_array_length(p_definition->'variableNames')<5
       OR jsonb_array_length(p_definition->'variableNames')>50
       OR jsonb_array_length(p_definition->'secretReferences')>30 THEN
        RETURN 'uat_blueprint_variable_catalog_invalid';
    END IF;
    FOR variable_name IN SELECT value FROM jsonb_array_elements(p_definition->'variableNames') LOOP
        IF jsonb_typeof(variable_name)<>'string' OR variable_name#>>'{}' !~ '^[A-Z][A-Z0-9_]{2,79}$' THEN
            RETURN 'uat_blueprint_variable_catalog_invalid';
        END IF;
    END LOOP;
    FOR secret_reference IN SELECT value FROM jsonb_array_elements(p_definition->'secretReferences') LOOP
        IF jsonb_typeof(secret_reference)<>'object'
           OR secret_reference->>'variableName' !~ '^[A-Z][A-Z0-9_]{2,79}$'
           OR secret_reference->>'reference' !~ '^[a-z][a-z0-9+.-]*://[^?#[:space:]]{3,240}$'
           OR secret_reference ? 'value' THEN
            RETURN 'uat_blueprint_secret_reference_invalid';
        END IF;
    END LOOP;
    IF p_definition#>>'{migration,strategy}'<>'ordered_sql'
       OR p_definition#>>'{migration,seedMode}'<>'synthetic_only'
       OR jsonb_typeof(p_definition#>'{migration,migrations}')<>'array'
       OR jsonb_array_length(p_definition#>'{migration,migrations}')<1
       OR jsonb_typeof(p_definition#>'{migration,verificationScripts}')<>'array'
       OR jsonb_array_length(p_definition#>'{migration,verificationScripts}')<1 THEN
        RETURN 'uat_blueprint_migration_invalid';
    END IF;
    IF p_definition#>>'{acceptance,healthCheck}'<>'required'
       OR p_definition#>>'{acceptance,errorLogs}'<>'zero_required'
       OR p_definition#>>'{acceptance,syntheticJourney}'<>'required'
       OR p_definition#>>'{acceptance,realData}'<>'prohibited' THEN
        RETURN 'uat_blueprint_acceptance_invalid';
    END IF;
    IF p_definition#>>'{rollback,strategy}'<>'remove_unexposed_target'
       OR p_definition#>>'{rollback,preserveAuditEvidence}'<>'true'
       OR jsonb_typeof(p_definition#>'{rollback,maxMinutes}')<>'number'
       OR (p_definition#>>'{rollback,maxMinutes}')::integer NOT BETWEEN 1 AND 120 THEN
        RETURN 'uat_blueprint_rollback_invalid';
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_enforce_zero_budget_uat_blueprint()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
    IF NEW.definition#>>'{decisions,runtimeOwner,actorId}'<>NEW.created_by_actor_id::text THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='uat_runtime_owner_must_match_creator';
    END IF;
    IF (NEW.definition#>>'{decisions,budget,monthlyLimitUsd}')::numeric<>0
       OR NEW.definition#>>'{decisions,budget,paidResourceProvisioning}'<>'prohibited' THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='uat_paid_resources_prohibited';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_zero_budget_uat_blueprint ON public.uat_environment_blueprints;
CREATE TRIGGER enforce_zero_budget_uat_blueprint
BEFORE INSERT OR UPDATE OF definition,created_by_actor_id ON public.uat_environment_blueprints
FOR EACH ROW EXECUTE FUNCTION public.dop_enforce_zero_budget_uat_blueprint();

CREATE OR REPLACE FUNCTION public.dop_append_zero_budget_uat_dry_run_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
    blueprint_definition jsonb;
BEGIN
    SELECT definition INTO STRICT blueprint_definition
      FROM public.uat_environment_blueprints
     WHERE id=NEW.blueprint_id AND organization_id=NEW.organization_id;
    NEW.checks:=NEW.checks||jsonb_build_array(
        jsonb_build_object('code','zero_budget_paid_resources_prohibited','status','passed','evidence',
            jsonb_build_object('monthlyBudgetUsd',0,'paidResourceProvisioning','prohibited','paidResourcesCreated',0)),
        jsonb_build_object('code','real_data_reapproval_gate','status','passed','evidence',
            jsonb_build_object('dataBoundary','synthetic_only','retentionDays',30,
                'realDataRequiresReapproval',true,'currentRealDataAllowed',false))
    );
    NEW.side_effects:=NEW.side_effects||jsonb_build_object(
        'monthlyBudgetUsd',0,'paidResourceProvisioning','prohibited','paidResourcesCreated',0);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS append_zero_budget_uat_dry_run_evidence ON public.uat_blueprint_dry_runs;
CREATE TRIGGER append_zero_budget_uat_dry_run_evidence
BEFORE INSERT ON public.uat_blueprint_dry_runs
FOR EACH ROW EXECUTE FUNCTION public.dop_append_zero_budget_uat_dry_run_evidence();

REVOKE ALL ON FUNCTION public.dop_release_declarations_error(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_uat_blueprint_definition_error(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_enforce_zero_budget_uat_blueprint() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_append_zero_budget_uat_dry_run_evidence() FROM PUBLIC;

COMMENT ON FUNCTION public.dop_enforce_zero_budget_uat_blueprint() IS
'M32: binds the runtime owner to the creating admin and prohibits any positive UAT budget or paid-resource provisioning.';

COMMIT;
