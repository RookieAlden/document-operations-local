BEGIN;

-- M23 upgrades Source Connector contract tests from definition-only checks to
-- deterministic offline adapter replays. Existing test rows remain readable;
-- all new application tests must carry Adapter Contract evidence.
ALTER TABLE public.source_connector_test_runs
  ADD COLUMN adapter_contract_version text,
  ADD COLUMN replay_hash text;

ALTER TABLE public.source_connector_test_runs
  ADD CONSTRAINT source_connector_test_adapter_contract_valid CHECK (
    adapter_contract_version IS NULL OR adapter_contract_version='1.0'
  ),
  ADD CONSTRAINT source_connector_test_replay_hash_valid CHECK (
    replay_hash IS NULL OR replay_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT source_connector_test_replay_pair CHECK (
    (adapter_contract_version IS NULL)=(replay_hash IS NULL)
  );

CREATE OR REPLACE FUNCTION public.dop_record_source_connector_adapter_replay(
  p_actor_id uuid,p_version_id uuid,p_evidence jsonb,p_reason text,
  p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,extensions,pg_temp
AS $$
DECLARE org_id uuid:=public.dop_require_active_admin(p_actor_id);
  source public.source_connector_versions%ROWTYPE; root public.source_connectors%ROWTYPE;
  existing public.source_connector_test_runs%ROWTYPE; fixture jsonb;
  fingerprint text; run_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); replay_hash_value text;
BEGIN
  IF char_length(p_reason) NOT BETWEEN 12 AND 1000 OR jsonb_typeof(p_evidence)<>'object' THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  SELECT * INTO source FROM public.source_connector_versions
   WHERE organization_id=org_id AND id=p_version_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','source_connector_version_not_found'); END IF;
  SELECT * INTO root FROM public.source_connectors WHERE id=source.connector_id;
  IF root.current_version_id<>source.id OR source.status='revoked' THEN
    RETURN jsonb_build_object('outcome','conflict','reason','version_not_current');
  END IF;
  IF p_evidence->>'contractVersion' IS DISTINCT FROM '1.0'
     OR p_evidence->>'adapterKey' IS DISTINCT FROM source.definition->>'connectorType'
     OR p_evidence->>'connectorType' IS DISTINCT FROM source.definition->>'connectorType'
     OR p_evidence->>'transport' IS DISTINCT FROM source.definition->>'transport'
     OR p_evidence->>'definitionHash' IS DISTINCT FROM source.definition_hash
     OR coalesce((p_evidence->>'syntheticOnly')::boolean,false) IS NOT TRUE
     OR jsonb_typeof(p_evidence->'fixtureCount') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_evidence->'passedCount') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_evidence->'externalCallCount') IS DISTINCT FROM 'number'
     OR (p_evidence->>'fixtureCount')::integer<>jsonb_array_length(source.definition->'testFixtures')
     OR (p_evidence->>'passedCount')::integer<>(p_evidence->>'fixtureCount')::integer
     OR (p_evidence->>'externalCallCount')::integer<>0
     OR p_evidence->>'credentialResolution'<>'not_attempted'
     OR coalesce((p_evidence->>'persistedDocuments')::boolean,true) IS NOT FALSE
     OR p_evidence->>'runtimeExecution'<>'disabled'
     OR p_evidence->>'externalDelivery'<>'disabled'
     OR jsonb_typeof(p_evidence->'fixtures') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_evidence->'fixtures')<>(p_evidence->>'fixtureCount')::integer THEN
    RETURN jsonb_build_object('outcome','conflict','reason','adapter_replay_evidence_invalid');
  END IF;
  FOR fixture IN SELECT value FROM jsonb_array_elements(p_evidence->'fixtures') LOOP
    IF fixture->>'status' IS DISTINCT FROM 'passed'
       OR coalesce(fixture->>'fixtureKey','') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
       OR coalesce(fixture->>'canonicalSourceType','') NOT IN
          ('internal_upload','fillout','email','api','sharepoint','sftp','object_storage')
       OR coalesce(fixture->>'canonicalSubmissionHash','') !~ '^[0-9a-f]{64}$'
       OR coalesce(fixture->>'canonicalEnvelopeHash','') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(fixture->'fileCount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(fixture->'declaredSizeBytes') IS DISTINCT FROM 'number'
       OR coalesce((fixture->>'fileCount')::integer,0)<>1
       OR coalesce((fixture->>'declaredSizeBytes')::bigint,0)<1 THEN
      RETURN jsonb_build_object('outcome','conflict','reason','adapter_replay_fixture_invalid');
    END IF;
  END LOOP;
  replay_hash_value:=encode(digest(p_evidence::text,'sha256'),'hex');
  fingerprint:=encode(digest(concat_ws('|',p_version_id::text,replay_hash_value,p_reason),'sha256'),'hex');
  SELECT * INTO existing FROM public.source_connector_test_runs
   WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.request_fingerprint=fingerprint THEN
      RETURN jsonb_build_object('outcome','duplicate','testRunId',existing.id,'status',existing.status,
        'replayHash',existing.replay_hash,'result',existing.result);
    END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
  END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,aggregate_type,aggregate_id,
    correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,p_idempotency_key||':event','SourceConnector.AdapterReplayPassed',1,'source_connector',source.connector_id,
    p_correlation_id,p_actor_id,'ops-source-connector',jsonb_build_object('version_id',source.id,
      'definition_hash',source.definition_hash,'adapter_contract_version','1.0','replay_hash',replay_hash_value,
      'fixture_count',(p_evidence->>'fixtureCount')::integer,'external_calls',0,'persisted_documents',false,
      'external_delivery','disabled'),p_now);
  INSERT INTO public.source_connector_test_runs(id,organization_id,connector_id,connector_version_id,definition_hash,status,
    result,adapter_contract_version,replay_hash,run_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES(run_id,org_id,source.connector_id,source.id,source.definition_hash,'passed',p_evidence,'1.0',replay_hash_value,
    p_actor_id,p_reason,p_idempotency_key,fingerprint,event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','testRunId',run_id,'status','passed',
    'adapterContractVersion','1.0','replayHash',replay_hash_value,'result',p_evidence);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('outcome','conflict','reason','adapter_replay_evidence_invalid');
END;
$$;

-- The legacy function could record a passing row without executing an adapter.
-- Remove application access; historical rows remain immutable evidence.
REVOKE EXECUTE ON FUNCTION public.dop_run_source_connector_test(uuid,uuid,text,text,uuid,timestamptz) FROM dop_app;
REVOKE ALL ON FUNCTION public.dop_record_source_connector_adapter_replay(uuid,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_record_source_connector_adapter_replay(uuid,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
