BEGIN;

-- A synthetic-only policy is not sufficient evidence that an individual Case
-- is synthetic. Destructive planning, object claims and final redaction must
-- all require the Case snapshot itself to carry the canonical JSON boolean.
CREATE OR REPLACE FUNCTION public.dop_case_is_explicitly_synthetic(p_config_snapshot jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(p_config_snapshot @> '{"synthetic_only":true}'::jsonb,false)
$$;

CREATE OR REPLACE FUNCTION public.dop_disable_retention_execution(
    p_actor_id uuid,p_reason text,p_idempotency_key uuid,p_correlation_id uuid,
    p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_admin(p_actor_id);
  policy public.data_retention_policies%ROWTYPE;
  event_id uuid:=gen_random_uuid();
BEGIN
  IF length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND idempotency_key='retention-execution-disabled|'||p_idempotency_key) THEN
    RETURN jsonb_build_object('outcome','duplicate','executionEnabled',false);
  END IF;
  SELECT * INTO policy FROM public.data_retention_policies
   WHERE organization_id=org_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','policy_not_found'); END IF;
  UPDATE public.data_retention_policies
     SET execution_enabled=false,reason=btrim(p_reason),updated_by_actor_id=p_actor_id,updated_at=p_now
   WHERE organization_id=org_id;
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (event_id,org_id,'retention-execution-disabled|'||p_idempotency_key,
    'Retention.ExecutionDisabled',1,'organization',org_id,p_correlation_id,p_actor_id,
    'ops-retention',jsonb_build_object('policyVersion',policy.policy_version,
      'previousExecutionEnabled',policy.execution_enabled,'executionEnabled',false,
      'syntheticOnly',policy.synthetic_only,'reason',btrim(p_reason)),p_now);
  RETURN jsonb_build_object('outcome','completed','executionEnabled',false,
    'previousExecutionEnabled',policy.execution_enabled,'eventId',event_id,
    'policyVersion',policy.policy_version);
END; $$;

CREATE OR REPLACE FUNCTION public.dop_plan_retention_run(
    p_actor_id uuid,p_mode text,p_reason text,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
    org_id uuid:=public.dop_require_active_admin(p_actor_id); policy public.data_retention_policies%ROWTYPE;
    existing public.retention_runs%ROWTYPE; run_id uuid:=gen_random_uuid(); fingerprint text;
    case_count_value integer:=0; document_count_value integer:=0; object_count_value integer:=0;
    excluded_unmarked_case_count_value integer:=0;
BEGIN
    IF p_mode NOT IN ('dry_run','apply') OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO policy FROM public.data_retention_policies WHERE organization_id=org_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','policy_not_configured'); END IF;
    IF NOT policy.synthetic_only THEN
        RETURN jsonb_build_object('outcome','conflict','reason','synthetic_only_policy_required');
    END IF;
    IF p_mode='apply' AND NOT policy.execution_enabled THEN
        RETURN jsonb_build_object('outcome','conflict','reason','execution_not_enabled');
    END IF;
    fingerprint:=encode(digest(concat_ws('|',p_mode,btrim(p_reason),policy.policy_version,
      'explicit_case_synthetic_only_v1',p_now::text),'sha256'),'hex');
    SELECT * INTO existing FROM public.retention_runs WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','retentionRunId',existing.id,'status',existing.status); END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    INSERT INTO public.retention_runs (id,organization_id,mode,status,policy_version,cutoff_at,
      requested_by_actor_id,reason,idempotency_key,request_fingerprint,started_at,completed_at,created_at,updated_at)
    VALUES (run_id,org_id,p_mode,CASE WHEN p_mode='dry_run' THEN 'completed' ELSE 'queued' END,
      policy.policy_version,p_now-make_interval(days=>policy.retention_days),p_actor_id,btrim(p_reason),
      p_idempotency_key,fingerprint,p_now,CASE WHEN p_mode='dry_run' THEN p_now END,p_now,p_now);

    SELECT count(*) INTO excluded_unmarked_case_count_value
      FROM public.cases c
     WHERE c.organization_id=org_id AND c.status IN ('completed','cancelled')
       AND coalesce(c.completed_at,c.updated_at) <= p_now-make_interval(days=>policy.retention_days)
       AND c.content_deleted_at IS NULL
       AND NOT public.dop_case_is_explicitly_synthetic(c.config_snapshot)
       AND NOT EXISTS (SELECT 1 FROM public.case_legal_holds h
         WHERE h.organization_id=org_id AND h.case_id=c.id AND h.status='active');

    INSERT INTO public.retention_case_candidates (organization_id,retention_run_id,case_id,terminal_at,
      document_count,object_count,status,content_digest,created_at,updated_at)
    SELECT org_id,run_id,c.id,coalesce(c.completed_at,c.updated_at),count(DISTINCT d.id),
      count(DISTINCT refs.storage_reference),'candidate',
      encode(digest(concat_ws('|',c.id::text,coalesce(c.completed_at,c.updated_at)::text,
        count(DISTINCT d.id)::text,count(DISTINCT refs.storage_reference)::text),'sha256'),'hex'),p_now,p_now
      FROM public.cases c
      LEFT JOIN public.documents d ON d.organization_id=c.organization_id AND d.case_id=c.id
      LEFT JOIN LATERAL (VALUES (d.incoming_storage_ref),(d.archive_storage_ref)) refs(storage_reference)
        ON refs.storage_reference IS NOT NULL
     WHERE c.organization_id=org_id AND c.status IN ('completed','cancelled')
       AND coalesce(c.completed_at,c.updated_at) <= p_now-make_interval(days=>policy.retention_days)
       AND c.content_deleted_at IS NULL
       AND public.dop_case_is_explicitly_synthetic(c.config_snapshot)
       AND NOT EXISTS (SELECT 1 FROM public.case_legal_holds h
         WHERE h.organization_id=org_id AND h.case_id=c.id AND h.status='active')
     GROUP BY c.id,c.completed_at,c.updated_at;

    IF p_mode='apply' THEN
      INSERT INTO public.retention_object_candidates (organization_id,retention_run_id,
        retention_case_candidate_id,case_id,document_id,object_kind,storage_reference,
        storage_reference_hash,status,created_at,updated_at)
      SELECT org_id,run_id,cc.id,d.case_id,d.id,refs.object_kind,refs.storage_reference,
        encode(digest(refs.storage_reference,'sha256'),'hex'),'queued',p_now,p_now
        FROM public.retention_case_candidates cc
        JOIN public.documents d ON d.organization_id=cc.organization_id AND d.case_id=cc.case_id
        CROSS JOIN LATERAL (VALUES ('incoming',d.incoming_storage_ref),('archive',d.archive_storage_ref))
          refs(object_kind,storage_reference)
       WHERE cc.organization_id=org_id AND cc.retention_run_id=run_id AND refs.storage_reference IS NOT NULL
      ON CONFLICT (organization_id,retention_run_id,storage_reference_hash) DO NOTHING;
    END IF;
    SELECT count(*),coalesce(sum(candidate_row.document_count),0),coalesce(sum(candidate_row.object_count),0)
      INTO case_count_value,document_count_value,object_count_value
      FROM public.retention_case_candidates candidate_row
     WHERE candidate_row.organization_id=org_id AND candidate_row.retention_run_id=run_id;
    UPDATE public.retention_runs SET candidate_case_count=case_count_value,
      candidate_document_count=document_count_value,candidate_object_count=object_count_value,
      status=CASE WHEN p_mode='apply' AND case_count_value=0 THEN 'completed' ELSE status END,
      completed_at=CASE WHEN p_mode='apply' AND case_count_value=0 THEN p_now ELSE completed_at END,
      updated_at=p_now WHERE id=run_id;
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (gen_random_uuid(),org_id,'retention-run|'||p_idempotency_key,'Retention.RunPlanned',2,
      'retention_run',run_id,p_correlation_id,p_actor_id,'ops-retention',jsonb_build_object(
      'mode',p_mode,'policyVersion',policy.policy_version,'candidateCases',case_count_value,
      'candidateDocuments',document_count_value,'candidateObjects',object_count_value,
      'excludedUnmarkedCases',excluded_unmarked_case_count_value,
      'caseSyntheticMarker','config_snapshot.synthetic_only=true','deletedObjects',0),p_now);
    RETURN jsonb_build_object('outcome','completed','retentionRunId',run_id,
      'status',CASE WHEN p_mode='dry_run' OR case_count_value=0 THEN 'completed' ELSE 'queued' END,
      'mode',p_mode,'candidateCases',case_count_value,'candidateDocuments',document_count_value,
      'candidateObjects',object_count_value,'excludedUnmarkedCases',excluded_unmarked_case_count_value,
      'deletedObjects',0);
END; $$;

CREATE OR REPLACE FUNCTION public.dop_claim_retention_object(
    p_organization_key text,p_worker_id text,p_lease_seconds integer,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org_id uuid; candidate public.retention_object_candidates%ROWTYPE; token uuid:=gen_random_uuid();
BEGIN
    IF length(btrim(p_worker_id)) NOT BETWEEN 3 AND 200 OR p_lease_seconds NOT BETWEEN 15 AND 900 THEN
      RETURN jsonb_build_object('outcome','conflict','reason','invalid_claim'); END IF;
    SELECT id INTO org_id FROM public.organizations WHERE organization_key=p_organization_key AND status='active';
    IF org_id IS NULL THEN RETURN jsonb_build_object('outcome','empty'); END IF;
    PERFORM public.dop_mark_due_legal_holds_for_review(p_organization_key,p_now);
    SELECT o.* INTO candidate FROM public.retention_object_candidates o
      JOIN public.retention_runs r ON r.organization_id=o.organization_id AND r.id=o.retention_run_id
      JOIN public.retention_case_candidates candidate_case
        ON candidate_case.organization_id=o.organization_id AND candidate_case.id=o.retention_case_candidate_id
      JOIN public.cases case_row
        ON case_row.organization_id=o.organization_id AND case_row.id=o.case_id
      JOIN public.data_retention_policies policy ON policy.organization_id=o.organization_id
     WHERE o.organization_id=org_id AND r.mode='apply' AND r.status IN ('queued','processing')
       AND policy.execution_enabled AND policy.synthetic_only
       AND public.dop_case_is_explicitly_synthetic(case_row.config_snapshot)
       AND candidate_case.status='candidate' AND o.attempt_count<3
       AND (o.status='queued' OR (o.status='processing' AND o.lease_expires_at<=p_now)
         OR (o.status='failed' AND o.updated_at<=p_now-interval '5 minutes'))
       AND NOT EXISTS (SELECT 1 FROM public.case_legal_holds h
         WHERE h.organization_id=org_id AND h.case_id=o.case_id AND h.status='active')
     ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','empty'); END IF;
    UPDATE public.retention_object_candidates SET status='processing',lease_owner=btrim(p_worker_id),
      lease_token=token,lease_expires_at=p_now+make_interval(secs=>p_lease_seconds),
      attempt_count=attempt_count+1,last_error_code=NULL,updated_at=p_now WHERE id=candidate.id;
    UPDATE public.retention_runs SET status='processing',updated_at=p_now WHERE id=candidate.retention_run_id AND status='queued';
    RETURN jsonb_build_object('outcome','claimed','candidateId',candidate.id,'retentionRunId',candidate.retention_run_id,
      'caseId',candidate.case_id,'storageReference',candidate.storage_reference,'storageReferenceHash',candidate.storage_reference_hash,
      'leaseToken',token,'attemptCount',candidate.attempt_count+1);
END; $$;

CREATE OR REPLACE FUNCTION public.dop_guard_synthetic_case_content_deletion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE policy public.data_retention_policies%ROWTYPE;
BEGIN
  SELECT * INTO policy FROM public.data_retention_policies
   WHERE organization_id=OLD.organization_id;
  IF NOT FOUND OR NOT policy.execution_enabled OR NOT policy.synthetic_only THEN
    RAISE EXCEPTION 'retention execution is not enabled for this organization' USING ERRCODE='42501';
  END IF;
  IF NOT public.dop_case_is_explicitly_synthetic(OLD.config_snapshot) THEN
    RAISE EXCEPTION 'case is not explicitly marked synthetic_only' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS dop_guard_synthetic_case_content_deletion_trigger ON public.cases;
CREATE TRIGGER dop_guard_synthetic_case_content_deletion_trigger
BEFORE UPDATE OF content_deleted_at ON public.cases
FOR EACH ROW
WHEN (OLD.content_deleted_at IS NULL AND NEW.content_deleted_at IS NOT NULL)
EXECUTE FUNCTION public.dop_guard_synthetic_case_content_deletion();

REVOKE ALL ON FUNCTION public.dop_case_is_explicitly_synthetic(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_disable_retention_execution(uuid,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_plan_retention_run(uuid,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_claim_retention_object(text,text,integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_guard_synthetic_case_content_deletion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_case_is_explicitly_synthetic(jsonb) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_disable_retention_execution(uuid,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_plan_retention_run(uuid,text,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_claim_retention_object(text,text,integer,timestamptz) TO dop_app;

COMMIT;
