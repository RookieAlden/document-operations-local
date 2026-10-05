BEGIN;

-- M39 records the approved positive UAT budget as a new, non-executable
-- governance generation. It does not create, start, resize or connect to a
-- provider resource. The previous zero-dollar records remain historical.
CREATE TABLE public.uat_authorization_recompilations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    authorization_key text NOT NULL CHECK (authorization_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
    version integer NOT NULL CHECK (version > 0),
    release_manifest_id uuid NOT NULL REFERENCES public.release_manifests(id),
    blueprint_id uuid NOT NULL REFERENCES public.uat_environment_blueprints(id),
    provisioning_package_id uuid NOT NULL REFERENCES public.uat_provisioning_packages(id),
    activation_approval_pack_id uuid NOT NULL REFERENCES public.uat_activation_approval_packs(id),
    final_authorization_request_id uuid NOT NULL REFERENCES public.uat_final_authorization_requests(id),
    current_policy jsonb NOT NULL CHECK (jsonb_typeof(current_policy)='object'),
    cost_plan jsonb NOT NULL CHECK (jsonb_typeof(cost_plan)='object'),
    iac_plan jsonb NOT NULL CHECK (jsonb_typeof(iac_plan)='object'),
    secret_references jsonb NOT NULL CHECK (jsonb_typeof(secret_references)='array'),
    destruction_plan jsonb NOT NULL CHECK (jsonb_typeof(destruction_plan)='array'),
    actual_effects jsonb NOT NULL CHECK (jsonb_typeof(actual_effects)='object'),
    bundle_hash text NOT NULL CHECK (bundle_hash ~ '^[0-9a-f]{64}$'),
    compiled_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    UNIQUE (organization_id,authorization_key,version),
    UNIQUE (organization_id,bundle_hash),
    CONSTRAINT uat_recompilation_manifest_same_org_fk FOREIGN KEY (organization_id,release_manifest_id)
        REFERENCES public.release_manifests(organization_id,id),
    CONSTRAINT uat_recompilation_blueprint_same_org_fk FOREIGN KEY (organization_id,blueprint_id)
        REFERENCES public.uat_environment_blueprints(organization_id,id),
    CONSTRAINT uat_recompilation_package_same_org_fk FOREIGN KEY (organization_id,provisioning_package_id)
        REFERENCES public.uat_provisioning_packages(organization_id,id),
    CONSTRAINT uat_recompilation_pack_same_org_fk FOREIGN KEY (organization_id,activation_approval_pack_id)
        REFERENCES public.uat_activation_approval_packs(organization_id,id),
    CONSTRAINT uat_recompilation_request_same_org_fk FOREIGN KEY (organization_id,final_authorization_request_id)
        REFERENCES public.uat_final_authorization_requests(organization_id,id),
    CONSTRAINT uat_recompilation_actor_same_org_fk FOREIGN KEY (organization_id,compiled_by_actor_id)
        REFERENCES public.actors(organization_id,id),
    CONSTRAINT uat_recompilation_event_same_org_fk FOREIGN KEY (organization_id,event_id)
        REFERENCES public.workflow_events(organization_id,id),
    CONSTRAINT uat_recompilation_policy_boundary CHECK (
        current_policy->>'schemaVersion'='2.0'
        AND current_policy->>'dataRegion'='Sydney'
        AND current_policy->>'retentionDays'='30'
        AND current_policy->>'dataMode'='synthetic_only'
        AND current_policy->>'realDataApproved'='false'
        AND current_policy->>'monthlyBudgetLimitUsd'='40'
        AND current_policy->>'resourceCreationAuthorized'='false'
        AND current_policy->>'runtimeExecution'='disabled'
        AND current_policy->>'externalIngress'='disabled'
        AND current_policy->>'externalDelivery'='disabled'
    ),
    CONSTRAINT uat_recompilation_zero_effects CHECK (
        actual_effects->>'environmentsCreated'='0'
        AND actual_effects->>'servicesCreated'='0'
        AND actual_effects->>'databasesCreated'='0'
        AND actual_effects->>'storageBucketsCreated'='0'
        AND actual_effects->>'domainsCreated'='0'
        AND actual_effects->>'secretValuesResolved'='0'
        AND actual_effects->>'runtimeStarted'='false'
        AND actual_effects->>'externalCalls'='0'
        AND actual_effects->>'estimatedAddedMonthlyCostUsd'='0'
    )
);

CREATE INDEX uat_authorization_recompilations_history_idx
    ON public.uat_authorization_recompilations (organization_id,authorization_key,version DESC);

ALTER TABLE public.uat_authorization_recompilations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.uat_authorization_recompilations TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.uat_authorization_recompilations
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());

-- Replace the M32 zero-dollar trigger with a version-aware boundary. Historical
-- schema 1.0 rows remain valid; schema 2.0 permits the approved $40 planning
-- ceiling but still rejects resource creation or runtime activation.
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
    IF NEW.definition->>'schemaVersion'='1.0' THEN
        IF (NEW.definition#>>'{decisions,budget,monthlyLimitUsd}')::numeric<>0
           OR NEW.definition#>>'{decisions,budget,paidResourceProvisioning}'<>'prohibited' THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='uat_paid_resources_prohibited';
        END IF;
    ELSIF NEW.definition->>'schemaVersion'='2.0' THEN
        IF (NEW.definition#>>'{decisions,budget,monthlyLimitUsd}')::numeric<>40
           OR NEW.definition#>>'{decisions,budget,paidResourceProvisioning}'<>'planned_after_explicit_creation_approval'
           OR NEW.definition->>'targetProvisioning'<>'not_started'
           OR NEW.definition->>'runtimeExecution'<>'disabled'
           OR NEW.definition->>'externalIngress'<>'disabled'
           OR NEW.definition->>'externalDelivery'<>'disabled'
           OR NEW.definition->>'dataBoundary'<>'synthetic_only' THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='uat_m39_authorization_boundary_invalid';
        END IF;
    ELSE
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='uat_blueprint_schema_version_invalid';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_append_zero_budget_uat_dry_run_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE blueprint_definition jsonb; budget_usd numeric; resource_policy text;
BEGIN
    SELECT definition INTO STRICT blueprint_definition
      FROM public.uat_environment_blueprints
     WHERE id=NEW.blueprint_id AND organization_id=NEW.organization_id;
    budget_usd:=(blueprint_definition#>>'{decisions,budget,monthlyLimitUsd}')::numeric;
    resource_policy:=blueprint_definition#>>'{decisions,budget,paidResourceProvisioning}';
    NEW.checks:=NEW.checks||jsonb_build_array(
        jsonb_build_object('code',CASE WHEN budget_usd=0 THEN 'zero_budget_paid_resources_prohibited' ELSE 'approved_budget_creation_gate' END,
            'status','passed','evidence',jsonb_build_object('monthlyBudgetUsd',budget_usd,
                'paidResourceProvisioning',resource_policy,'resourceCreationAuthorized',false,'paidResourcesCreated',0)),
        jsonb_build_object('code','real_data_reapproval_gate','status','passed','evidence',
            jsonb_build_object('dataBoundary','synthetic_only','retentionDays',30,
                'realDataRequiresReapproval',true,'currentRealDataAllowed',false))
    );
    NEW.side_effects:=NEW.side_effects||jsonb_build_object(
        'monthlyBudgetUsd',budget_usd,'paidResourceProvisioning',resource_policy,
        'resourceCreationAuthorized',false,'paidResourcesCreated',0);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.dop_enforce_zero_budget_uat_blueprint() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_append_zero_budget_uat_dry_run_evidence() FROM PUBLIC;

COMMENT ON TABLE public.uat_authorization_recompilations IS
'M39 append-only authorization compilations. A $40 planning ceiling is recorded while UAT creation, execution, real data and external delivery remain unauthorized.';

COMMIT;
