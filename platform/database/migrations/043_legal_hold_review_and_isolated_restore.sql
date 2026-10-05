BEGIN;

-- A review deadline is not a release deadline. The hold remains active and
-- blocks planning, claiming and finalization until a manager/admin explicitly
-- releases it through dop_set_case_legal_hold.
ALTER TABLE public.case_legal_holds
    ADD COLUMN review_state text NOT NULL DEFAULT 'scheduled'
      CHECK (review_state IN ('scheduled','pending_review')),
    ADD COLUMN review_marked_at timestamptz,
    ADD COLUMN review_event_id uuid REFERENCES public.workflow_events(id),
    ADD CONSTRAINT case_legal_holds_review_evidence_check CHECK (
      (review_state='scheduled' AND review_marked_at IS NULL AND review_event_id IS NULL)
      OR (review_state='pending_review' AND review_marked_at IS NOT NULL AND review_event_id IS NOT NULL)
    );

CREATE OR REPLACE FUNCTION public.dop_mark_due_legal_holds_for_review(
    p_organization_key text,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org_id uuid; hold record; event_id uuid; marked integer:=0;
BEGIN
  SELECT id INTO org_id FROM public.organizations WHERE organization_key=p_organization_key AND status='active';
  IF org_id IS NULL THEN RETURN jsonb_build_object('outcome','completed','markedForReview',0); END IF;
  FOR hold IN
    SELECT * FROM public.case_legal_holds
     WHERE organization_id=org_id AND status='active' AND review_state='scheduled' AND review_due_at<=p_now
     ORDER BY review_due_at,id FOR UPDATE SKIP LOCKED
  LOOP
    event_id:=gen_random_uuid();
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (event_id,org_id,'legal-hold-review-due|'||hold.id,'Case.LegalHoldReviewRequired',1,
      'case',hold.case_id,gen_random_uuid(),hold.approved_by_actor_id,'retention-worker',
      jsonb_build_object('legalHoldId',hold.id,'reviewDueAt',hold.review_due_at,
        'statusRemains','active','automaticRelease',false),p_now);
    UPDATE public.case_legal_holds SET review_state='pending_review',review_marked_at=p_now,
      review_event_id=event_id,updated_at=p_now WHERE id=hold.id;
    marked:=marked+1;
  END LOOP;
  RETURN jsonb_build_object('outcome','completed','markedForReview',marked);
END; $$;

-- Repair any row that an earlier worker may have automatically expired. The
-- UAT ledger currently has none, but this forward-only correction is safe for
-- every environment and adds the missing audit event if needed.
DO $$
DECLARE hold record; event_id uuid;
BEGIN
  FOR hold IN SELECT * FROM public.case_legal_holds WHERE status='expired' FOR UPDATE LOOP
    event_id:=gen_random_uuid();
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (event_id,hold.organization_id,'legal-hold-expiry-corrected|'||hold.id,
      'Case.LegalHoldReviewRequired',1,'case',hold.case_id,gen_random_uuid(),hold.approved_by_actor_id,
      'migration-043',jsonb_build_object('legalHoldId',hold.id,'correctedAutomaticExpiry',true,
        'statusRemains','active','automaticRelease',false),now());
    UPDATE public.case_legal_holds SET status='active',review_state='pending_review',review_marked_at=now(),
      review_event_id=event_id,released_by_actor_id=NULL,released_at=NULL,release_reason=NULL,updated_at=now()
      WHERE id=hold.id;
  END LOOP;
END $$;

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
      JOIN public.retention_case_candidates c ON c.organization_id=o.organization_id AND c.id=o.retention_case_candidate_id
     WHERE o.organization_id=org_id AND r.mode='apply' AND r.status IN ('queued','processing')
       AND c.status='candidate' AND o.attempt_count<3
       AND (o.status='queued' OR (o.status='processing' AND o.lease_expires_at<=p_now)
         OR (o.status='failed' AND o.updated_at<=p_now-interval '5 minutes'))
       AND NOT EXISTS (SELECT 1 FROM public.case_legal_holds h
         WHERE h.organization_id=org_id AND h.case_id=o.case_id AND h.status='active')
     ORDER BY o.created_at,o.id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','empty'); END IF;
    UPDATE public.retention_object_candidates SET status='processing',lease_owner=btrim(p_worker_id),
      lease_token=token,lease_expires_at=p_now+make_interval(secs=>p_lease_seconds),
      attempt_count=attempt_count+1,last_error_code=NULL,updated_at=p_now WHERE id=candidate.id;
    UPDATE public.retention_runs SET status='processing',updated_at=p_now WHERE id=candidate.retention_run_id AND status='queued';
    RETURN jsonb_build_object('outcome','claimed','candidateId',candidate.id,'retentionRunId',candidate.retention_run_id,
      'caseId',candidate.case_id,'storageReference',candidate.storage_reference,'storageReferenceHash',candidate.storage_reference_hash,
      'leaseToken',token,'attemptCount',candidate.attempt_count+1);
END; $$;

-- Supersede the same-database temporary-table drills. They remain visible as
-- historical evidence but cannot satisfy M43 acceptance.
ALTER TABLE public.retention_restore_drills DROP CONSTRAINT retention_restore_drills_status_check;
ALTER TABLE public.retention_restore_drills DROP CONSTRAINT retention_restore_drills_target_check;
ALTER TABLE public.retention_restore_drills DROP CONSTRAINT retention_restore_drills_row_count_check;
ALTER TABLE public.retention_restore_drills
    ADD COLUMN schema_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN relationships_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN migration_ledger_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN rls_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN restore_target_destroyed boolean NOT NULL DEFAULT false,
    ADD COLUMN source_migration_version text,
    ADD COLUMN restored_table_count integer NOT NULL DEFAULT 0,
    ADD COLUMN restored_relationship_count integer NOT NULL DEFAULT 0,
    ADD COLUMN restored_rls_policy_count integer NOT NULL DEFAULT 0;
UPDATE public.retention_restore_drills SET status='superseded'
 WHERE status='passed' AND restore_target='temporary_postgres_table';
ALTER TABLE public.retention_restore_drills
    ADD CONSTRAINT retention_restore_drills_status_check CHECK (status IN ('passed','failed','superseded')),
    ADD CONSTRAINT retention_restore_drills_target_check CHECK (
      restore_target IN ('isolated_pglite_postgresql','temporary_postgres_table','legacy_in_memory_verification')),
    ADD CONSTRAINT retention_restore_drills_row_count_check CHECK (restored_row_count >= 1),
    ADD CONSTRAINT retention_restore_drills_migration_version_check CHECK (
      source_migration_version IS NULL OR source_migration_version ~ '^[0-9]{3}$'),
    ADD CONSTRAINT retention_restore_drills_evidence_check CHECK (
      status<>'passed' OR (restore_target='isolated_pglite_postgresql' AND schema_verified
        AND relationships_verified AND migration_ledger_verified AND rls_verified
        AND restore_target_destroyed
        AND source_migration_version IS NOT NULL AND restored_table_count>=8
        AND restored_relationship_count>=6 AND restored_rls_policy_count>=7
        AND backup_digest=restored_digest AND temporary_artifacts_removed
        AND artifact_purged_at>=artifact_expires_at)
    );

CREATE OR REPLACE FUNCTION public.dop_record_retention_restore_drill_v2(
    p_actor_id uuid,p_case_id uuid,p_status text,p_backup_digest text,p_restored_digest text,
    p_actual_rto_seconds integer,p_restored_row_count integer,p_source_migration_version text,
    p_restored_table_count integer,p_restored_relationship_count integer,p_restored_rls_policy_count integer,
    p_schema_verified boolean,p_relationships_verified boolean,p_migration_ledger_verified boolean,p_rls_verified boolean,
    p_restore_target_destroyed boolean,
    p_reason text,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org_id uuid:=public.dop_require_active_admin(p_actor_id); policy public.data_retention_policies%ROWTYPE;
  drill_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid();
BEGIN
  IF p_status NOT IN ('passed','failed') OR p_backup_digest !~ '^[0-9a-f]{64}$'
    OR p_restored_digest !~ '^[0-9a-f]{64}$' OR p_actual_rto_seconds<0 OR p_restored_row_count<1
    OR p_source_migration_version !~ '^[0-9]{3}$' OR p_restored_table_count<8
    OR p_restored_relationship_count<6 OR p_restored_rls_policy_count<7
    OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  IF p_status='passed' AND (p_backup_digest<>p_restored_digest OR NOT p_schema_verified
      OR NOT p_relationships_verified OR NOT p_migration_ledger_verified OR NOT p_rls_verified
      OR NOT p_restore_target_destroyed) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','isolated_restore_evidence_incomplete'); END IF;
  SELECT * INTO policy FROM public.data_retention_policies WHERE organization_id=org_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.cases WHERE organization_id=org_id AND id=p_case_id) THEN
    RETURN jsonb_build_object('outcome','not_found'); END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND idempotency_key='restore-drill-v2|'||p_idempotency_key) THEN
    RETURN jsonb_build_object('outcome','duplicate'); END IF;
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (event_id,org_id,'restore-drill-v2|'||p_idempotency_key,'Retention.RestoreDrillRecorded',3,'case',p_case_id,
    p_correlation_id,p_actor_id,'retention-isolated-restore-drill',jsonb_build_object('status',p_status,
    'backupDigest',p_backup_digest,'restoredDigest',p_restored_digest,'actualRtoSeconds',p_actual_rto_seconds,
    'restoreTarget','isolated_pglite_postgresql','restoredRowCount',p_restored_row_count,
    'sourceMigrationVersion',p_source_migration_version,'restoredTableCount',p_restored_table_count,
    'restoredRelationshipCount',p_restored_relationship_count,'restoredRlsPolicyCount',p_restored_rls_policy_count,
    'schemaVerified',p_schema_verified,'relationshipsVerified',p_relationships_verified,
    'migrationLedgerVerified',p_migration_ledger_verified,'rlsVerified',p_rls_verified,
    'restoreTargetDestroyed',p_restore_target_destroyed,
    'plaintextWrittenToDisk',false,'temporaryArtifactsRemoved',true,
    'artifactExpiresAt',p_now,'artifactPurgedAt',p_now),p_now);
  INSERT INTO public.retention_restore_drills (id,organization_id,source_case_id,status,backup_format,
    backup_digest,restored_digest,rpo_hours,rto_target_hours,actual_rto_seconds,plaintext_written_to_disk,
    temporary_artifacts_removed,restore_target,restored_row_count,artifact_expires_at,artifact_purged_at,
    schema_verified,relationships_verified,migration_ledger_verified,rls_verified,restore_target_destroyed,source_migration_version,
    restored_table_count,restored_relationship_count,restored_rls_policy_count,
    run_by_actor_id,reason,event_id,created_at)
  VALUES (drill_id,org_id,p_case_id,p_status,'encrypted_logical_snapshot',p_backup_digest,p_restored_digest,
    policy.rpo_hours,policy.rto_hours,p_actual_rto_seconds,false,true,'isolated_pglite_postgresql',
    p_restored_row_count,p_now,p_now,p_schema_verified,p_relationships_verified,p_migration_ledger_verified,
    p_rls_verified,p_restore_target_destroyed,p_source_migration_version,p_restored_table_count,p_restored_relationship_count,
    p_restored_rls_policy_count,p_actor_id,btrim(p_reason),event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','restoreDrillId',drill_id,'status',p_status,
    'restoreTarget','isolated_pglite_postgresql','artifactExpiresAt',p_now,'artifactPurgedAt',p_now);
END; $$;

REVOKE ALL ON FUNCTION public.dop_record_retention_restore_drill(uuid,uuid,text,text,text,integer,text,uuid,uuid,timestamptz) FROM dop_app;
REVOKE ALL ON FUNCTION public.dop_mark_due_legal_holds_for_review(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_record_retention_restore_drill_v2(uuid,uuid,text,text,text,integer,integer,text,integer,integer,integer,boolean,boolean,boolean,boolean,boolean,text,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_record_retention_restore_drill_v2(uuid,uuid,text,text,text,integer,integer,text,integer,integer,integer,boolean,boolean,boolean,boolean,boolean,text,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
