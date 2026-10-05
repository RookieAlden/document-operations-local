BEGIN;

DO $$
DECLARE
  org_id uuid; admin_id uuid; manager_id uuid; staff_id uuid; target_case_id uuid;
  isolated_subject_id uuid:=gen_random_uuid();
  result jsonb; hold_id uuid; run_id uuid; candidate_id uuid; proof_id uuid;
  object_lease_token uuid;
  after_objects integer; direct_mutation_grants integer;
BEGIN
  SELECT id INTO org_id FROM public.organizations WHERE organization_key='uat-accounting-firm';
  IF org_id IS NULL THEN RAISE EXCEPTION 'UAT organization missing'; END IF;
  PERFORM public.dop_set_organization_context('uat-accounting-firm');
  SELECT id INTO admin_id FROM public.actors WHERE organization_id=org_id AND actor_type='admin' AND status='active' ORDER BY created_at LIMIT 1;
  SELECT id INTO manager_id FROM public.actors WHERE organization_id=org_id AND actor_type='manager' AND status='active' ORDER BY created_at LIMIT 1;
  SELECT id INTO staff_id FROM public.actors WHERE organization_id=org_id AND actor_type='staff' AND status='active' ORDER BY created_at LIMIT 1;
  SELECT candidate.id INTO target_case_id FROM public.cases candidate
   WHERE candidate.organization_id=org_id AND candidate.status='completed' AND candidate.content_deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.case_legal_holds hold_row
       WHERE hold_row.organization_id=org_id AND hold_row.case_id=candidate.id AND hold_row.status='active')
   ORDER BY candidate.completed_at NULLS LAST,candidate.id LIMIT 1;
  IF admin_id IS NULL OR manager_id IS NULL OR staff_id IS NULL OR target_case_id IS NULL THEN
    RAISE EXCEPTION 'M43 regression fixtures unavailable';
  END IF;

  INSERT INTO public.subjects (id,organization_id,subject_key,subject_type,display_name,status,
    primary_contact_actor_id,attributes,created_at,updated_at)
  VALUES (isolated_subject_id,org_id,'m43-regression-'||replace(isolated_subject_id::text,'-',''),
    'synthetic_test','M43 isolated deletion regression subject','active',NULL,
    '{"syntheticOnly":true,"sensitiveMarker":"M43_REGRESSION_SUBJECT_CONTENT"}'::jsonb,
    '2026-07-01T00:00:00Z','2026-07-01T00:00:00Z');
  UPDATE public.cases SET subject_id=isolated_subject_id WHERE id=target_case_id;

  UPDATE public.cases SET completed_at='2026-07-01T00:00:00Z',updated_at='2026-07-01T00:00:00Z',
    config_snapshot=config_snapshot-'synthetic_only'-'syntheticOnly' WHERE id=target_case_id;
  result:=public.dop_confirm_retention_policy(admin_id,30,'case_terminal_at',ARRAY['manager','admin'],24,4,
    'Confirm the synthetic UAT retention policy inside a rollback-only regression.',gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:00:00Z');
  IF result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'policy confirmation failed: %',result; END IF;

  result:=public.dop_plan_retention_run(admin_id,'dry_run',
    'Prove that a terminal Case without an explicit synthetic marker is excluded.',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:00:30Z');
  IF result->>'outcome'<>'completed' OR (result->>'excludedUnmarkedCases')::integer<1
      OR EXISTS(SELECT 1 FROM public.retention_case_candidates
        WHERE retention_run_id=(result->>'retentionRunId')::uuid AND case_id=target_case_id) THEN
    RAISE EXCEPTION 'unmarked Case entered retention planning: %',result; END IF;
  UPDATE public.cases SET config_snapshot=config_snapshot||'{"synthetic_only":true}'::jsonb
   WHERE id=target_case_id;
  IF NOT public.dop_case_is_explicitly_synthetic((SELECT config_snapshot FROM public.cases WHERE id=target_case_id)) THEN
    RAISE EXCEPTION 'explicit synthetic marker predicate failed'; END IF;

  result:=public.dop_set_case_legal_hold(manager_id,target_case_id,'place',
    'Protect the synthetic candidate while proving hold review boundaries.', '2026-08-17T00:01:00Z',gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:00:00Z');
  IF result->>'outcome'<>'completed' OR result->>'status'<>'active' THEN RAISE EXCEPTION 'hold placement failed: %',result; END IF;
  hold_id:=(result->>'legalHoldId')::uuid;

  result:=public.dop_plan_retention_run(admin_id,'dry_run','Dry-run must delete zero objects and exclude held cases.',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:00:00Z');
  IF result->>'outcome'<>'completed' OR (result->>'candidateCases')::integer<>0 OR (result->>'deletedObjects')::integer<>0 THEN
    RAISE EXCEPTION 'hold was not excluded from dry-run: %',result; END IF;

  result:=public.dop_mark_due_legal_holds_for_review('uat-accounting-firm','2026-08-17T00:02:00Z');
  IF (result->>'markedForReview')::integer<>1 THEN RAISE EXCEPTION 'due hold was not marked for review: %',result; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.case_legal_holds WHERE id=hold_id AND status='active'
      AND review_state='pending_review' AND released_at IS NULL) THEN
    RAISE EXCEPTION 'due hold no longer blocks deletion'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND event_type='Case.LegalHoldReviewRequired' AND aggregate_id=target_case_id
      AND payload->>'automaticRelease'='false') THEN RAISE EXCEPTION 'hold review audit event missing'; END IF;
  result:=public.dop_plan_retention_run(admin_id,'dry_run','Pending-review hold must continue deleting zero objects.',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:02:30Z');
  IF (result->>'candidateCases')::integer<>0 OR (result->>'deletedObjects')::integer<>0 THEN
    RAISE EXCEPTION 'pending-review hold failed to block planning: %',result; END IF;

  result:=public.dop_set_case_legal_hold(manager_id,target_case_id,'release',
    'Manager explicitly releases the reviewed synthetic legal hold.', '2026-08-17T00:01:00Z',gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:03:00Z');
  IF result->>'outcome'<>'completed' OR result->>'status'<>'released' THEN RAISE EXCEPTION 'hold release failed: %',result; END IF;
  IF EXISTS(SELECT 1 FROM public.case_legal_holds WHERE id=hold_id AND status<>'released') THEN RAISE EXCEPTION 'hold status drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND event_type='Case.LegalHoldReleased' AND aggregate_id=target_case_id AND actor_id=manager_id) THEN
    RAISE EXCEPTION 'explicit hold release audit event missing'; END IF;

  result:=public.dop_plan_retention_run(admin_id,'dry_run','Preview eligible synthetic cases without deleting any content.',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:04:00Z');
  IF (result->>'candidateCases')::integer<1 OR (result->>'deletedObjects')::integer<>0 THEN RAISE EXCEPTION 'dry-run boundary failed: %',result; END IF;
  result:=public.dop_plan_retention_run(admin_id,'apply','Execute rollback-only synthetic retention lifecycle verification.',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:05:00Z');
  IF result->>'outcome'<>'completed' OR result->>'status'<>'queued' THEN RAISE EXCEPTION 'apply plan failed: %',result; END IF;
  run_id:=(result->>'retentionRunId')::uuid;
  SELECT count(*) INTO after_objects FROM public.retention_object_candidates WHERE retention_run_id=run_id;
  IF after_objects<>(result->>'candidateObjects')::integer THEN RAISE EXCEPTION 'object candidate accounting failed'; END IF;

  result:=public.dop_set_case_legal_hold(manager_id,target_case_id,'place',
    'Hold an already planned synthetic deletion before the worker claims it.', '2026-08-17T00:06:00Z',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:05:30Z');
  hold_id:=(result->>'legalHoldId')::uuid;
  result:=public.dop_claim_retention_object('uat-accounting-firm','regression-worker',120,'2026-08-17T00:07:00Z');
  IF result->>'outcome'<>'empty' THEN RAISE EXCEPTION 'due hold failed to block worker claim: %',result; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.case_legal_holds WHERE id=hold_id AND status='active' AND review_state='pending_review') THEN
    RAISE EXCEPTION 'worker did not preserve due hold as pending review'; END IF;
  result:=public.dop_set_case_legal_hold(manager_id,target_case_id,'release',
    'Manager explicitly releases the second reviewed synthetic legal hold.', '2026-08-17T00:06:00Z',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:08:00Z');
  IF result->>'status'<>'released' THEN RAISE EXCEPTION 'second hold release failed: %',result; END IF;

  result:=public.dop_claim_retention_object('uat-accounting-firm','regression-worker',120,'2026-08-17T00:09:00Z');
  IF result->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'object claim after explicit release failed: %',result; END IF;
  candidate_id:=(result->>'candidateId')::uuid; object_lease_token:=(result->>'leaseToken')::uuid;
  result:=public.dop_complete_retention_object(candidate_id,object_lease_token,'failed','synthetic_transient_failure','2026-08-17T00:09:00Z');
  IF result->>'status'<>'failed' THEN RAISE EXCEPTION 'failure result was not recorded: %',result; END IF;
  UPDATE public.retention_object_candidates SET status='processing',lease_owner='regression-backoff-isolation',
    lease_token=gen_random_uuid(),lease_expires_at='2026-08-17T00:20:00Z',updated_at='2026-08-17T00:09:00Z'
    WHERE retention_run_id=run_id AND id<>candidate_id AND status='queued';
  result:=public.dop_claim_retention_object('uat-accounting-firm','regression-worker',120,'2026-08-17T00:13:59Z');
  IF result->>'outcome'<>'empty' THEN RAISE EXCEPTION 'failed object retried before backoff: %',result; END IF;
  result:=public.dop_claim_retention_object('uat-accounting-firm','regression-worker',120,'2026-08-17T00:14:01Z');
  IF result->>'outcome'<>'claimed' OR (result->>'candidateId')::uuid<>candidate_id OR (result->>'attemptCount')::integer<>2 THEN
    RAISE EXCEPTION 'failed object recovery claim failed: %',result; END IF;
  object_lease_token:=(result->>'leaseToken')::uuid;
  result:=public.dop_complete_retention_object(candidate_id,object_lease_token,'not_found',NULL,'2026-08-17T00:14:02Z');
  IF result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'recovered object completion failed: %',result; END IF;
  UPDATE public.retention_object_candidates SET status='queued',lease_owner=NULL,lease_token=NULL,
    lease_expires_at=NULL,updated_at='2026-08-17T00:14:02Z'
    WHERE retention_run_id=run_id AND status='processing' AND lease_owner='regression-backoff-isolation';
  LOOP
    result:=public.dop_claim_retention_object('uat-accounting-firm','regression-worker',120,'2026-08-17T00:15:00Z');
    EXIT WHEN result->>'outcome'='empty';
    IF result->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'remaining object claim failed: %',result; END IF;
    result:=public.dop_complete_retention_object((result->>'candidateId')::uuid,(result->>'leaseToken')::uuid,
      'not_found',NULL,'2026-08-17T00:15:01Z');
    IF result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'remaining object completion failed: %',result; END IF;
  END LOOP;
  result:=public.dop_finalize_retention_runs('uat-accounting-firm','2026-08-17T00:16:00Z');
  IF (result->>'finalizedCases')::integer<1 THEN RAISE EXCEPTION 'case finalization failed: %',result; END IF;
  SELECT id INTO proof_id FROM public.data_deletion_proofs WHERE retention_run_id=run_id AND case_id=target_case_id;
  IF proof_id IS NULL THEN RAISE EXCEPTION 'deletion proof missing'; END IF;
  IF EXISTS(SELECT 1 FROM public.documents WHERE organization_id=org_id AND case_id=target_case_id
      AND (archive_storage_ref IS NOT NULL OR incoming_storage_ref IS NOT NULL OR original_filename<>'[deleted]'
        OR classification_summary IS NOT NULL OR idempotency_key<>'deleted-'||replace(id::text,'-','')
        OR source_download_ref IS NOT NULL OR source_envelope IS NOT NULL
        OR content_deletion_proof_id IS DISTINCT FROM proof_id)) THEN
    RAISE EXCEPTION 'document sensitive content remains';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.cases WHERE id=target_case_id
      AND case_key='deleted-'||replace(id::text,'-','')) THEN
    RAISE EXCEPTION 'human-readable case key remains'; END IF;
  IF EXISTS(SELECT 1 FROM public.submissions WHERE organization_id=org_id AND case_id=target_case_id
      AND (submission_key<>'deleted-'||replace(id::text,'-','')
        OR source_submission_id<>'deleted-'||replace(id::text,'-','')
        OR canonical_envelope IS NOT NULL OR source_provenance->>'contentDeleted'<>'true')) THEN
    RAISE EXCEPTION 'submission identifiers remain'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.subjects WHERE id=isolated_subject_id
      AND subject_key='deleted-'||replace(id::text,'-','') AND display_name='[deleted]'
      AND status='closed' AND primary_contact_actor_id IS NULL
      AND attributes->>'contentDeleted'='true' AND attributes->>'proofId'=proof_id::text) THEN
    RAISE EXCEPTION 'orphaned subject sensitive content remains'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND event_type='Subject.ContentDeleted' AND aggregate_id=isolated_subject_id
      AND payload->>'proofId'=proof_id::text) THEN
    RAISE EXCEPTION 'subject deletion audit event missing'; END IF;
  IF EXISTS(SELECT 1 FROM public.delivery_jobs WHERE organization_id=org_id AND case_id=target_case_id
      AND (body_text<>'Content deleted under retention policy.' OR recipient_snapshot->>'address'<>'deleted@document-operations.invalid')) THEN
    RAISE EXCEPTION 'delivery sensitive snapshot remains';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id AND event_type='Case.ContentDeleted'
      AND payload->>'proofId'=proof_id::text) THEN RAISE EXCEPTION 'minimal deletion event missing'; END IF;

  result:=public.dop_record_retention_restore_drill_v2(admin_id,target_case_id,'passed',repeat('a',64),repeat('a',64),
    3,8,'044',9,12,8,true,true,true,true,true,
    'Verify an independent isolated PostgreSQL restoration and target destruction.',gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:17:00Z');
  IF result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'restore drill record failed: %',result; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.retention_restore_drills WHERE organization_id=org_id
      AND source_case_id=target_case_id AND restore_target='isolated_pglite_postgresql' AND restored_row_count=8
      AND schema_verified AND relationships_verified AND migration_ledger_verified AND rls_verified
      AND restore_target_destroyed AND source_migration_version='044'
      AND artifact_expires_at=artifact_purged_at AND temporary_artifacts_removed) THEN
    RAISE EXCEPTION 'restore artifact lifecycle evidence missing'; END IF;

  result:=public.dop_record_storage_reconciliation(admin_id,2,2,0,0,repeat('0',64),repeat('0',64),
    'Record a clean path-free storage reconciliation in rollback-only verification.',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:06:30Z');
  IF result->>'outcome'<>'completed' OR result->>'status'<>'passed' THEN
    RAISE EXCEPTION 'storage reconciliation record failed: %',result; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.storage_reconciliation_runs WHERE organization_id=org_id
      AND orphan_object_count=0 AND missing_object_count=0) THEN
    RAISE EXCEPTION 'storage reconciliation evidence missing'; END IF;

  SELECT count(*) INTO direct_mutation_grants FROM information_schema.role_table_grants
   WHERE grantee='dop_app' AND table_schema='public'
     AND table_name IN ('data_retention_policies','case_legal_holds','retention_runs','retention_case_candidates',
       'retention_object_candidates','data_deletion_proofs','retention_restore_drills','storage_reconciliation_runs')
     AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF direct_mutation_grants<>0 THEN RAISE EXCEPTION 'dop_app has direct lifecycle mutation grants'; END IF;
  IF EXISTS(SELECT 1 FROM public.case_legal_holds WHERE organization_id=org_id AND status='expired') THEN
    RAISE EXCEPTION 'automatic legal hold expiry remains possible'; END IF;
  IF has_function_privilege('dop_app',
      'public.dop_record_retention_restore_drill(uuid,uuid,text,text,text,integer,text,uuid,uuid,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'legacy same-database restore evidence function remains executable'; END IF;

  BEGIN
    result:=public.dop_disable_retention_execution(manager_id,
      'A manager must not be able to close or alter the destructive execution gate.',
      gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:18:00Z');
    RAISE EXCEPTION 'manager unexpectedly changed the execution gate: %',result;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  result:=public.dop_disable_retention_execution(admin_id,
    'Close destructive execution after the rollback-only synthetic lifecycle verification.',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:18:30Z');
  IF result->>'outcome'<>'completed' OR (result->>'executionEnabled')::boolean THEN
    RAISE EXCEPTION 'admin failed to close execution gate: %',result; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND event_type='Retention.ExecutionDisabled' AND actor_id=admin_id
      AND payload->>'executionEnabled'='false') THEN
    RAISE EXCEPTION 'execution disable audit event missing'; END IF;
  result:=public.dop_plan_retention_run(admin_id,'apply',
    'Apply must remain blocked after the destructive execution gate is closed.',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:19:00Z');
  IF result->>'outcome'<>'conflict' OR result->>'reason'<>'execution_not_enabled' THEN
    RAISE EXCEPTION 'disabled execution gate did not block apply: %',result; END IF;
  result:=public.dop_claim_retention_object('uat-accounting-firm','regression-worker',120,'2026-08-17T00:19:30Z');
  IF result->>'outcome'<>'empty' THEN RAISE EXCEPTION 'disabled execution gate allowed an object claim: %',result; END IF;

  BEGIN
    result:=public.dop_plan_retention_run(staff_id,'apply','Staff must never approve a destructive lifecycle run.',
      gen_random_uuid(),gen_random_uuid(),'2026-08-17T00:07:00Z');
    RAISE EXCEPTION 'staff unexpectedly planned apply run: %',result;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

ROLLBACK;
