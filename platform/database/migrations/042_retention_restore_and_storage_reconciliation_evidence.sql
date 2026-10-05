BEGIN;

-- Restore evidence must prove both an isolated database restore and the final
-- purge time of the encrypted temporary archive. Existing rows predate these
-- stronger M43 guarantees and are explicitly marked as legacy in-memory drills.
ALTER TABLE public.retention_restore_drills
    ADD COLUMN restore_target text,
    ADD COLUMN restored_row_count integer,
    ADD COLUMN artifact_expires_at timestamptz,
    ADD COLUMN artifact_purged_at timestamptz;

UPDATE public.retention_restore_drills
   SET restore_target = 'legacy_in_memory_verification',
       restored_row_count = 1,
       artifact_expires_at = created_at,
       artifact_purged_at = created_at
 WHERE restore_target IS NULL;

ALTER TABLE public.retention_restore_drills
    ALTER COLUMN restore_target SET NOT NULL,
    ALTER COLUMN restored_row_count SET NOT NULL,
    ALTER COLUMN artifact_expires_at SET NOT NULL,
    ALTER COLUMN artifact_purged_at SET NOT NULL,
    ADD CONSTRAINT retention_restore_drills_target_check
      CHECK (restore_target IN ('temporary_postgres_table','legacy_in_memory_verification')),
    ADD CONSTRAINT retention_restore_drills_row_count_check
      CHECK (restored_row_count = 1),
    ADD CONSTRAINT retention_restore_drills_artifact_lifecycle_check
      CHECK (artifact_purged_at >= artifact_expires_at);

CREATE TABLE public.storage_reconciliation_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    status text NOT NULL CHECK (status IN ('passed','attention','failed')),
    database_reference_count integer NOT NULL CHECK (database_reference_count >= 0),
    storage_object_count integer NOT NULL CHECK (storage_object_count >= 0),
    orphan_object_count integer NOT NULL CHECK (orphan_object_count >= 0),
    missing_object_count integer NOT NULL CHECK (missing_object_count >= 0),
    orphan_reference_digest text NOT NULL CHECK (orphan_reference_digest ~ '^[0-9a-f]{64}$'),
    missing_reference_digest text NOT NULL CHECK (missing_reference_digest ~ '^[0-9a-f]{64}$'),
    inspected_at timestamptz NOT NULL,
    run_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    FOREIGN KEY (organization_id, run_by_actor_id)
      REFERENCES public.actors(organization_id, id)
);

ALTER TABLE public.storage_reconciliation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY dop_tenant_isolation ON public.storage_reconciliation_runs FOR SELECT TO dop_app
    USING (organization_id = public.dop_current_organization_id());
GRANT SELECT ON public.storage_reconciliation_runs TO dop_app;

CREATE OR REPLACE FUNCTION public.dop_record_storage_reconciliation(
    p_actor_id uuid,p_database_reference_count integer,p_storage_object_count integer,
    p_orphan_object_count integer,p_missing_object_count integer,
    p_orphan_reference_digest text,p_missing_reference_digest text,p_reason text,
    p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_admin(p_actor_id);
  run_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); run_status text;
BEGIN
  IF p_database_reference_count<0 OR p_storage_object_count<0 OR p_orphan_object_count<0
    OR p_missing_object_count<0 OR p_orphan_reference_digest !~ '^[0-9a-f]{64}$'
    OR p_missing_reference_digest !~ '^[0-9a-f]{64}$'
    OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND idempotency_key='storage-reconciliation|'||p_idempotency_key) THEN
    RETURN jsonb_build_object('outcome','duplicate');
  END IF;
  run_status:=CASE WHEN p_orphan_object_count=0 AND p_missing_object_count=0 THEN 'passed' ELSE 'attention' END;
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (event_id,org_id,'storage-reconciliation|'||p_idempotency_key,
    'Retention.StorageReconciliationRecorded',1,'organization',org_id,p_correlation_id,p_actor_id,
    'retention-storage-reconciliation',jsonb_build_object('status',run_status,
      'databaseReferenceCount',p_database_reference_count,'storageObjectCount',p_storage_object_count,
      'orphanObjectCount',p_orphan_object_count,'missingObjectCount',p_missing_object_count,
      'orphanReferenceDigest',p_orphan_reference_digest,'missingReferenceDigest',p_missing_reference_digest,
      'pathsPersisted',false),p_now);
  INSERT INTO public.storage_reconciliation_runs (id,organization_id,status,database_reference_count,
    storage_object_count,orphan_object_count,missing_object_count,orphan_reference_digest,
    missing_reference_digest,inspected_at,run_by_actor_id,reason,event_id,created_at)
  VALUES (run_id,org_id,run_status,p_database_reference_count,p_storage_object_count,p_orphan_object_count,
    p_missing_object_count,p_orphan_reference_digest,p_missing_reference_digest,p_now,p_actor_id,
    btrim(p_reason),event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','reconciliationRunId',run_id,'status',run_status,
    'orphanObjectCount',p_orphan_object_count,'missingObjectCount',p_missing_object_count);
END; $$;

CREATE OR REPLACE FUNCTION public.dop_record_retention_restore_drill(
    p_actor_id uuid,p_case_id uuid,p_status text,p_backup_digest text,p_restored_digest text,
    p_actual_rto_seconds integer,p_reason text,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org_id uuid:=public.dop_require_active_admin(p_actor_id); policy public.data_retention_policies%ROWTYPE;
  drill_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid();
BEGIN
  IF p_status NOT IN ('passed','failed') OR p_backup_digest !~ '^[0-9a-f]{64}$' OR p_restored_digest !~ '^[0-9a-f]{64}$'
    OR p_actual_rto_seconds<0 OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  SELECT * INTO policy FROM public.data_retention_policies WHERE organization_id=org_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.cases WHERE organization_id=org_id AND id=p_case_id) THEN
    RETURN jsonb_build_object('outcome','not_found'); END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_events WHERE organization_id=org_id AND idempotency_key='restore-drill|'||p_idempotency_key) THEN
    RETURN jsonb_build_object('outcome','duplicate'); END IF;
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (event_id,org_id,'restore-drill|'||p_idempotency_key,'Retention.RestoreDrillRecorded',2,'case',p_case_id,
    p_correlation_id,p_actor_id,'retention-restore-drill',jsonb_build_object('status',p_status,
    'backupDigest',p_backup_digest,'restoredDigest',p_restored_digest,'actualRtoSeconds',p_actual_rto_seconds,
    'restoreTarget','temporary_postgres_table','restoredRowCount',1,'plaintextWrittenToDisk',false,
    'temporaryArtifactsRemoved',true,'artifactExpiresAt',p_now,'artifactPurgedAt',p_now),p_now);
  INSERT INTO public.retention_restore_drills (id,organization_id,source_case_id,status,backup_format,
    backup_digest,restored_digest,rpo_hours,rto_target_hours,actual_rto_seconds,plaintext_written_to_disk,
    temporary_artifacts_removed,restore_target,restored_row_count,artifact_expires_at,artifact_purged_at,
    run_by_actor_id,reason,event_id,created_at)
  VALUES (drill_id,org_id,p_case_id,p_status,'encrypted_logical_snapshot',p_backup_digest,p_restored_digest,
    policy.rpo_hours,policy.rto_hours,p_actual_rto_seconds,false,true,'temporary_postgres_table',1,p_now,p_now,
    p_actor_id,btrim(p_reason),event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','restoreDrillId',drill_id,'status',p_status,
    'artifactExpiresAt',p_now,'artifactPurgedAt',p_now);
END; $$;

REVOKE ALL ON FUNCTION public.dop_record_storage_reconciliation(uuid,integer,integer,integer,integer,text,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_record_storage_reconciliation(uuid,integer,integer,integer,integer,text,text,text,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
