BEGIN;

-- M44 makes statistical classification evidence an enforceable, subject-level
-- runtime boundary. A subject without an active quality programme continues to
-- use its published Classification Profile; once a programme is configured,
-- only document types certified by its latest passing run may auto-accept.
CREATE TABLE public.classification_quality_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  subject_id uuid NOT NULL REFERENCES public.subjects(id),
  classification_profile_version_id uuid NOT NULL REFERENCES public.classification_profile_versions(id),
  classifier_release_version_id uuid NOT NULL REFERENCES public.classifier_release_versions(id),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('active','retired')),
  confidence_level numeric(4,3) NOT NULL DEFAULT 0.95 CHECK (confidence_level=0.95),
  minimum_precision_lower_bound numeric(4,3) NOT NULL DEFAULT 0.95
    CHECK (minimum_precision_lower_bound>0 AND minimum_precision_lower_bound<=1),
  minimum_independent_families integer NOT NULL DEFAULT 60 CHECK (minimum_independent_families>=1),
  high_risk_document_type_codes text[] NOT NULL DEFAULT '{}',
  certified_auto_accept_document_type_codes text[] NOT NULL DEFAULT '{}',
  monthly_provider_limit_usd numeric(8,4) NOT NULL DEFAULT 3 CHECK (monthly_provider_limit_usd>0),
  application_circuit_breaker_usd numeric(8,4) NOT NULL DEFAULT 2.5
    CHECK (application_circuit_breaker_usd>0 AND application_circuit_breaker_usd<=monthly_provider_limit_usd),
  first_client_configuration jsonb NOT NULL CHECK (jsonb_typeof(first_client_configuration)='object'),
  latest_quality_run_id uuid,
  created_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
  idempotency_key uuid NOT NULL,
  event_id uuid NOT NULL REFERENCES public.workflow_events(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,subject_id,version),
  UNIQUE (organization_id,idempotency_key),
  CONSTRAINT classification_quality_policy_subject_same_org_fk FOREIGN KEY (organization_id,subject_id)
    REFERENCES public.subjects(organization_id,id),
  CONSTRAINT classification_quality_policy_actor_same_org_fk FOREIGN KEY (organization_id,created_by_actor_id)
    REFERENCES public.actors(organization_id,id),
  CONSTRAINT classification_quality_policy_event_same_org_fk FOREIGN KEY (organization_id,event_id)
    REFERENCES public.workflow_events(organization_id,id)
);
CREATE UNIQUE INDEX one_active_classification_quality_policy_per_subject
  ON public.classification_quality_policies(organization_id,subject_id) WHERE status='active';

CREATE TABLE public.classification_quality_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  policy_id uuid NOT NULL REFERENCES public.classification_quality_policies(id),
  subject_id uuid NOT NULL REFERENCES public.subjects(id),
  dataset_hash text NOT NULL CHECK (dataset_hash ~ '^[0-9a-f]{64}$'),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('passed','failed','circuit_open')),
  physical_observation_count integer NOT NULL CHECK (physical_observation_count>0),
  independent_family_count integer NOT NULL CHECK (independent_family_count>0),
  near_duplicate_excluded_count integer NOT NULL CHECK (near_duplicate_excluded_count>=0),
  unsafe_auto_accept_family_count integer NOT NULL CHECK (unsafe_auto_accept_family_count>=0),
  input_token_count integer NOT NULL CHECK (input_token_count>=0),
  output_token_count integer NOT NULL CHECK (output_token_count>=0),
  estimated_cost_usd numeric(10,6) NOT NULL CHECK (estimated_cost_usd>=0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  run_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
  idempotency_key uuid NOT NULL,
  event_id uuid NOT NULL REFERENCES public.workflow_events(id),
  created_at timestamptz NOT NULL,
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  CONSTRAINT classification_quality_run_policy_same_org_fk FOREIGN KEY (organization_id,policy_id)
    REFERENCES public.classification_quality_policies(organization_id,id),
  CONSTRAINT classification_quality_run_subject_same_org_fk FOREIGN KEY (organization_id,subject_id)
    REFERENCES public.subjects(organization_id,id),
  CONSTRAINT classification_quality_run_actor_same_org_fk FOREIGN KEY (organization_id,run_by_actor_id)
    REFERENCES public.actors(organization_id,id),
  CONSTRAINT classification_quality_run_event_same_org_fk FOREIGN KEY (organization_id,event_id)
    REFERENCES public.workflow_events(organization_id,id)
);
ALTER TABLE public.classification_quality_policies ADD CONSTRAINT classification_quality_policy_latest_run_same_org_fk
  FOREIGN KEY (organization_id,latest_quality_run_id) REFERENCES public.classification_quality_runs(organization_id,id);
CREATE INDEX classification_quality_runs_history_idx
  ON public.classification_quality_runs(organization_id,subject_id,created_at DESC);

ALTER TABLE public.classification_quality_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classification_quality_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.classification_quality_policies,public.classification_quality_runs TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.classification_quality_policies FOR SELECT TO dop_app
  USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.classification_quality_runs FOR SELECT TO dop_app
  USING (organization_id=public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_configure_classification_quality_policy(
  p_actor_id uuid,p_subject_id uuid,p_classification_profile_version_id uuid,
  p_classifier_release_version_id uuid,p_high_risk_document_type_codes text[],
  p_first_client_configuration jsonb,p_reason text,p_idempotency_key uuid,
  p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_admin(p_actor_id);
  existing public.classification_quality_policies%ROWTYPE;
  current_policy public.classification_quality_policies%ROWTYPE;
  policy_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); next_version integer;
BEGIN
  IF length(btrim(p_reason)) NOT BETWEEN 12 AND 1000
    OR jsonb_typeof(p_first_client_configuration)<>'object'
    OR coalesce((p_first_client_configuration->>'syntheticOnly')::boolean,false) IS NOT TRUE
    OR NOT (p_first_client_configuration ?& ARRAY['requirements','deadlinePolicy','owner','handoff'])
    OR cardinality(p_high_risk_document_type_codes)<1 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  SELECT * INTO existing FROM public.classification_quality_policies
   WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','policyId',existing.id,'version',existing.version); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.subjects WHERE organization_id=org_id AND id=p_subject_id
      AND status='active' AND attributes @> '{"synthetic":true}'::jsonb) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','synthetic_subject_required');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.classification_profile_versions WHERE organization_id=org_id
      AND id=p_classification_profile_version_id AND status='published')
    OR NOT EXISTS(SELECT 1 FROM public.classifier_release_versions WHERE organization_id=org_id
      AND id=p_classifier_release_version_id AND status='published') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','published_runtime_required');
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_high_risk_document_type_codes) code WHERE NOT EXISTS(
      SELECT 1 FROM public.document_types d WHERE d.organization_id=org_id AND d.status='active' AND d.code=code)) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','unknown_high_risk_document_type');
  END IF;
  SELECT * INTO current_policy FROM public.classification_quality_policies
   WHERE organization_id=org_id AND subject_id=p_subject_id AND status='active' FOR UPDATE;
  next_version:=coalesce(current_policy.version,0)+1;
  IF current_policy.id IS NOT NULL THEN
    UPDATE public.classification_quality_policies SET status='retired',updated_at=p_now WHERE id=current_policy.id;
  END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'classification-quality-policy|'||p_idempotency_key,
    'ClassificationQuality.PolicyConfigured',1,'subject',p_subject_id,p_correlation_id,p_actor_id,
    'ops-classification-quality',jsonb_build_object('policyId',policy_id,'version',next_version,
      'syntheticOnly',true,'minimumIndependentFamilies',60,'confidenceLevel',0.95,
      'minimumPrecisionLowerBound',0.95,'monthlyProviderLimitUsd',3,
      'applicationCircuitBreakerUsd',2.5,'certifiedAutoAcceptDocumentTypeCodes','[]'::jsonb),p_now);
  INSERT INTO public.classification_quality_policies(id,organization_id,subject_id,
    classification_profile_version_id,classifier_release_version_id,version,status,
    high_risk_document_type_codes,first_client_configuration,created_by_actor_id,reason,
    idempotency_key,event_id,created_at,updated_at)
  VALUES(policy_id,org_id,p_subject_id,p_classification_profile_version_id,p_classifier_release_version_id,
    next_version,'active',ARRAY(SELECT DISTINCT unnest(p_high_risk_document_type_codes) ORDER BY 1),
    p_first_client_configuration,p_actor_id,btrim(p_reason),p_idempotency_key,event_id,p_now,p_now);
  RETURN jsonb_build_object('outcome','completed','policyId',policy_id,'version',next_version,
    'certifiedAutoAcceptDocumentTypeCodes','[]'::jsonb);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
END; $$;

CREATE OR REPLACE FUNCTION public.dop_record_classification_quality_run(
  p_actor_id uuid,p_policy_id uuid,p_dataset_hash text,p_manifest_hash text,p_status text,
  p_result jsonb,p_reason text,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_admin(p_actor_id);
  policy public.classification_quality_policies%ROWTYPE;
  existing public.classification_quality_runs%ROWTYPE;
  run_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); certified text[];
  physical_count integer; family_count integer; duplicate_count integer; unsafe_count integer;
  input_count integer; output_count integer; cost numeric;
BEGIN
  IF p_status NOT IN ('passed','failed','circuit_open') OR p_dataset_hash !~ '^[0-9a-f]{64}$'
    OR p_manifest_hash !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_result)<>'object'
    OR coalesce((p_result->>'syntheticOnly')::boolean,false) IS NOT TRUE
    OR p_result ?| ARRAY['rawContent','content','fileBytes','apiKey','secret']
    OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  SELECT * INTO existing FROM public.classification_quality_runs
   WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','qualityRunId',existing.id,'status',existing.status); END IF;
  SELECT * INTO policy FROM public.classification_quality_policies
   WHERE organization_id=org_id AND id=p_policy_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','active_policy_not_found'); END IF;
  physical_count:=(p_result->>'physicalObservations')::integer;
  family_count:=(p_result->>'independentFamilies')::integer;
  duplicate_count:=(p_result->>'nearDuplicateObservationsExcluded')::integer;
  unsafe_count:=(p_result->>'unsafeAutoAcceptFamilies')::integer;
  input_count:=(p_result->>'totalInputTokens')::integer;
  output_count:=(p_result->>'totalOutputTokens')::integer;
  cost:=(p_result->>'estimatedCostUsd')::numeric;
  SELECT coalesce(array_agg(value ORDER BY value),'{}') INTO certified
    FROM jsonb_array_elements_text(coalesce(p_result->'certifiedAutoAcceptDocumentTypeCodes','[]'::jsonb));
  IF physical_count<1 OR family_count<1 OR duplicate_count<>physical_count-family_count
    OR unsafe_count<0 OR input_count<0 OR output_count<0 OR cost<0
    OR (p_status='passed' AND (unsafe_count<>0 OR cost>policy.application_circuit_breaker_usd))
    OR (p_status<>'passed' AND cardinality(certified)>0)
    OR EXISTS(SELECT 1 FROM unnest(certified) code WHERE NOT EXISTS(
      SELECT 1 FROM public.document_types d WHERE d.organization_id=org_id AND d.status='active' AND d.code=code)) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','quality_result_invalid');
  END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'classification-quality-run|'||p_idempotency_key,
    'ClassificationQuality.RunRecorded',1,'subject',policy.subject_id,p_correlation_id,p_actor_id,
    'ops-classification-quality',jsonb_build_object('qualityRunId',run_id,'policyId',policy.id,
      'status',p_status,'datasetHash',p_dataset_hash,'manifestHash',p_manifest_hash,
      'physicalObservations',physical_count,'independentFamilies',family_count,
      'nearDuplicatesExcluded',duplicate_count,'unsafeAutoAcceptFamilies',unsafe_count,
      'estimatedCostUsd',cost,'certifiedAutoAcceptDocumentTypeCodes',to_jsonb(certified),
      'syntheticOnly',true),p_now);
  INSERT INTO public.classification_quality_runs(id,organization_id,policy_id,subject_id,dataset_hash,
    manifest_hash,status,physical_observation_count,independent_family_count,near_duplicate_excluded_count,
    unsafe_auto_accept_family_count,input_token_count,output_token_count,estimated_cost_usd,result,
    run_by_actor_id,reason,idempotency_key,event_id,created_at)
  VALUES(run_id,org_id,policy.id,policy.subject_id,p_dataset_hash,p_manifest_hash,p_status,
    physical_count,family_count,duplicate_count,unsafe_count,input_count,output_count,cost,p_result,
    p_actor_id,btrim(p_reason),p_idempotency_key,event_id,p_now);
  UPDATE public.classification_quality_policies SET latest_quality_run_id=run_id,
    certified_auto_accept_document_type_codes=CASE WHEN p_status='passed' THEN certified ELSE '{}' END,
    updated_at=p_now WHERE id=policy.id;
  RETURN jsonb_build_object('outcome','completed','qualityRunId',run_id,'status',p_status,
    'certifiedAutoAcceptDocumentTypeCodes',to_jsonb(CASE WHEN p_status='passed' THEN certified ELSE '{}' END));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
END; $$;

REVOKE ALL ON public.classification_quality_policies,public.classification_quality_runs FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_configure_classification_quality_policy(uuid,uuid,uuid,uuid,text[],jsonb,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_record_classification_quality_run(uuid,uuid,text,text,text,jsonb,text,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_configure_classification_quality_policy(uuid,uuid,uuid,uuid,text[],jsonb,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_record_classification_quality_run(uuid,uuid,text,text,text,jsonb,text,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
