BEGIN;

-- Preserve an incorrect scorer result and append a corrected interpretation of
-- the same provider observations without charging or calling the provider a
-- second time. Provider cost and incremental rescore cost are deliberately
-- separate so budget accounting cannot double-count an evidence-only rescore.
ALTER TABLE public.classification_quality_runs
  ADD COLUMN scorer_version text NOT NULL DEFAULT '1.0' CHECK (scorer_version ~ '^[0-9]+\.[0-9]+$'),
  ADD COLUMN source_quality_run_id uuid,
  ADD COLUMN incremental_estimated_cost_usd numeric(10,6) NOT NULL DEFAULT 0
    CHECK (incremental_estimated_cost_usd>=0);
UPDATE public.classification_quality_runs
   SET incremental_estimated_cost_usd=estimated_cost_usd
 WHERE source_quality_run_id IS NULL;
ALTER TABLE public.classification_quality_runs
  ADD CONSTRAINT classification_quality_rescore_source_same_org_fk
  FOREIGN KEY (organization_id,source_quality_run_id)
  REFERENCES public.classification_quality_runs(organization_id,id);

CREATE OR REPLACE FUNCTION public.dop_record_classification_quality_rescore(
  p_actor_id uuid,p_source_quality_run_id uuid,p_scorer_version text,p_status text,
  p_result jsonb,p_reason text,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_admin(p_actor_id);
  source_run public.classification_quality_runs%ROWTYPE;
  policy public.classification_quality_policies%ROWTYPE;
  existing public.classification_quality_runs%ROWTYPE;
  run_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); certified text[];
  physical_count integer; family_count integer; duplicate_count integer; unsafe_count integer;
  input_count integer; output_count integer; cost numeric;
BEGIN
  IF p_scorer_version !~ '^[0-9]+\.[0-9]+$' OR p_status NOT IN ('passed','failed')
    OR jsonb_typeof(p_result)<>'object'
    OR coalesce((p_result->>'syntheticOnly')::boolean,false) IS NOT TRUE
    OR p_result ?| ARRAY['rawContent','content','fileBytes','apiKey','secret']
    OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  SELECT * INTO existing FROM public.classification_quality_runs
   WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','qualityRunId',existing.id,'status',existing.status); END IF;
  SELECT * INTO source_run FROM public.classification_quality_runs
   WHERE organization_id=org_id AND id=p_source_quality_run_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','source_quality_run_not_found'); END IF;
  SELECT * INTO policy FROM public.classification_quality_policies
   WHERE organization_id=org_id AND id=source_run.policy_id AND status='active' FOR UPDATE;
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
  IF physical_count<>source_run.physical_observation_count
    OR family_count<>source_run.independent_family_count
    OR duplicate_count<>source_run.near_duplicate_excluded_count
    OR input_count<>source_run.input_token_count OR output_count<>source_run.output_token_count
    OR cost<>source_run.estimated_cost_usd OR unsafe_count<0
    OR (p_status='passed' AND unsafe_count<>0)
    OR (p_status<>'passed' AND cardinality(certified)>0)
    OR EXISTS(SELECT 1 FROM unnest(certified) code WHERE NOT EXISTS(
      SELECT 1 FROM public.document_types d WHERE d.organization_id=org_id AND d.status='active' AND d.code=code)) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','rescore_result_invalid');
  END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'classification-quality-rescore|'||p_idempotency_key,
    'ClassificationQuality.RunRescored',1,'subject',source_run.subject_id,p_correlation_id,p_actor_id,
    'ops-classification-quality',jsonb_build_object('qualityRunId',run_id,'sourceQualityRunId',source_run.id,
      'policyId',policy.id,'status',p_status,'scorerVersion',p_scorer_version,
      'datasetHash',source_run.dataset_hash,'manifestHash',source_run.manifest_hash,
      'physicalObservations',physical_count,'independentFamilies',family_count,
      'nearDuplicatesExcluded',duplicate_count,'unsafeAutoAcceptFamilies',unsafe_count,
      'providerEstimatedCostUsd',cost,'incrementalEstimatedCostUsd',0,
      'certifiedAutoAcceptDocumentTypeCodes',to_jsonb(certified),'syntheticOnly',true),p_now);
  INSERT INTO public.classification_quality_runs(id,organization_id,policy_id,subject_id,dataset_hash,
    manifest_hash,status,physical_observation_count,independent_family_count,near_duplicate_excluded_count,
    unsafe_auto_accept_family_count,input_token_count,output_token_count,estimated_cost_usd,result,
    run_by_actor_id,reason,idempotency_key,event_id,created_at,scorer_version,source_quality_run_id,
    incremental_estimated_cost_usd)
  VALUES(run_id,org_id,policy.id,policy.subject_id,source_run.dataset_hash,source_run.manifest_hash,p_status,
    physical_count,family_count,duplicate_count,unsafe_count,input_count,output_count,cost,p_result,
    p_actor_id,btrim(p_reason),p_idempotency_key,event_id,p_now,p_scorer_version,source_run.id,0);
  UPDATE public.classification_quality_policies SET latest_quality_run_id=run_id,
    certified_auto_accept_document_type_codes=CASE WHEN p_status='passed' THEN certified ELSE '{}' END,
    updated_at=p_now WHERE id=policy.id;
  RETURN jsonb_build_object('outcome','completed','qualityRunId',run_id,
    'sourceQualityRunId',source_run.id,'status',p_status,'scorerVersion',p_scorer_version,
    'incrementalEstimatedCostUsd',0,
    'certifiedAutoAcceptDocumentTypeCodes',to_jsonb(CASE WHEN p_status='passed' THEN certified ELSE '{}' END));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
END; $$;

REVOKE ALL ON FUNCTION public.dop_record_classification_quality_rescore(uuid,uuid,text,text,jsonb,text,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_record_classification_quality_rescore(uuid,uuid,text,text,jsonb,text,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
