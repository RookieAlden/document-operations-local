BEGIN;

-- Forward-only correction for the M43 run planner. PostgreSQL correctly
-- rejected an unqualified count column because the original function used
-- local variables with the same names. No retention run reached execution.
CREATE OR REPLACE FUNCTION public.dop_plan_retention_run(
    p_actor_id uuid,p_mode text,p_reason text,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
    org_id uuid:=public.dop_require_active_admin(p_actor_id); policy public.data_retention_policies%ROWTYPE;
    existing public.retention_runs%ROWTYPE; run_id uuid:=gen_random_uuid(); fingerprint text;
    case_count_value integer:=0; document_count_value integer:=0; object_count_value integer:=0;
BEGIN
    IF p_mode NOT IN ('dry_run','apply') OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO policy FROM public.data_retention_policies WHERE organization_id=org_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','policy_not_configured'); END IF;
    IF p_mode='apply' AND NOT policy.execution_enabled THEN
        RETURN jsonb_build_object('outcome','conflict','reason','execution_not_enabled');
    END IF;
    fingerprint:=encode(digest(concat_ws('|',p_mode,btrim(p_reason),policy.policy_version,p_now::text),'sha256'),'hex');
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
    VALUES (gen_random_uuid(),org_id,'retention-run|'||p_idempotency_key,'Retention.RunPlanned',1,
      'retention_run',run_id,p_correlation_id,p_actor_id,'ops-retention',jsonb_build_object(
      'mode',p_mode,'policyVersion',policy.policy_version,'candidateCases',case_count_value,
      'candidateDocuments',document_count_value,'candidateObjects',object_count_value,'deletedObjects',0),p_now);
    RETURN jsonb_build_object('outcome','completed','retentionRunId',run_id,
      'status',CASE WHEN p_mode='dry_run' OR case_count_value=0 THEN 'completed' ELSE 'queued' END,
      'mode',p_mode,'candidateCases',case_count_value,'candidateDocuments',document_count_value,
      'candidateObjects',object_count_value,'deletedObjects',0);
END; $$;

REVOKE ALL ON FUNCTION public.dop_plan_retention_run(uuid,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_plan_retention_run(uuid,text,text,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
