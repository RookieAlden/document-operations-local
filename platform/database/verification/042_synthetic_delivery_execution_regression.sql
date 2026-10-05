BEGIN;

DO $$
DECLARE
  draft_row public.missing_document_request_drafts%ROWTYPE;
  revision_row public.missing_document_request_revisions%ROWTYPE;
  manager_id uuid;
  job_id uuid;
  evaluation_result jsonb;
  authorize_result jsonb;
  claim_result jsonb;
  completion_result jsonb;
  receipt_result jsonb;
  reconcile_result jsonb;
  base_time timestamptz := '2026-08-16T12:00:00Z';
  fixture_revision_id uuid := gen_random_uuid();
  fixture_event_id uuid := gen_random_uuid();
  fixture_hash text;
BEGIN
  SELECT * INTO draft_row FROM public.missing_document_request_drafts
   WHERE status='draft' ORDER BY created_at DESC,id DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'M42 requires one synthetic missing-request draft'; END IF;
  PERFORM public.dop_set_organization_context((SELECT organization_key FROM public.organizations WHERE id=draft_row.organization_id));
  SELECT id INTO manager_id FROM public.actors WHERE organization_id=draft_row.organization_id
    AND actor_type IN ('manager','admin') AND status='active' ORDER BY actor_type DESC,id LIMIT 1;
  IF manager_id IS NULL THEN RAISE EXCEPTION 'M42 requires one active manager'; END IF;
  SELECT * INTO revision_row FROM public.missing_document_request_revisions
    WHERE organization_id=draft_row.organization_id AND request_draft_id=draft_row.id
      AND recipient_allowlist_id IS NOT NULL ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'M42 requires one governed synthetic recipient revision'; END IF;

  UPDATE public.missing_document_request_revisions SET status='superseded'
    WHERE organization_id=draft_row.organization_id AND request_draft_id=draft_row.id AND status='approved';
  fixture_hash := encode(digest('m42|'||fixture_revision_id::text,'sha256'),'hex');
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (fixture_event_id,draft_row.organization_id,'m42-fixture|'||fixture_revision_id::text,
    'MissingDocumentRequest.M42FixtureApproved',1,'missing_document_request_revision',fixture_revision_id,
    gen_random_uuid(),manager_id,'m42-regression',jsonb_build_object('synthetic',true,'external_call_count',0),base_time);
  INSERT INTO public.missing_document_request_revisions (id,organization_id,request_draft_id,revision,status,
    recipient_allowlist_id,recipient_reference,recipient_snapshot,subject_line,body_text,content_hash,change_reason,
    created_by_actor_id,submitted_by_actor_id,submitted_at,reviewed_by_actor_id,reviewed_at,review_reason,
    delivery_mode,external_call_count,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES (fixture_revision_id,draft_row.organization_id,draft_row.id,
    (SELECT coalesce(max(revision),0)+1 FROM public.missing_document_request_revisions WHERE request_draft_id=draft_row.id),
    'approved',revision_row.recipient_allowlist_id,revision_row.recipient_reference,revision_row.recipient_snapshot,
    'M42 synthetic delivery verification',
    'This is purely synthetic UAT content used to verify safe delivery outcomes and no real external send.',
    fixture_hash,'M42 creates one transaction-scoped approved fixture for repeatable delivery verification.',
    manager_id,manager_id,base_time,manager_id,base_time,
    'Independent regression approval is transaction scoped and contains no real customer data.',
    'disabled',0,gen_random_uuid(),encode(digest('m42-request|'||fixture_revision_id::text,'sha256'),'hex'),
    fixture_event_id,base_time);

  SELECT public.dop_plan_missing_request_delivery(manager_id,fixture_revision_id,
    'Plan exact synthetic M42 content without granting execution.',gen_random_uuid(),gen_random_uuid(),base_time)
    INTO authorize_result;
  IF authorize_result->>'outcome' <> 'completed' THEN RAISE EXCEPTION 'M42 planning failed: %',authorize_result; END IF;
  job_id := (authorize_result->>'deliveryJobId')::uuid;
  SELECT public.dop_run_delivery_contract_evaluation(manager_id,job_id,
    'Verify lease, retry, unknown-result and receipt contracts before authorization.',
    gen_random_uuid(),gen_random_uuid(),base_time) INTO evaluation_result;
  IF evaluation_result->>'status' <> 'passed' THEN RAISE EXCEPTION 'M42 contract failed: %',evaluation_result; END IF;

  SELECT public.dop_authorize_synthetic_delivery(manager_id,job_id,'success',
    'Authorize only a no-network .invalid synthetic success scenario.',gen_random_uuid(),gen_random_uuid(),base_time)
    INTO authorize_result;
  IF authorize_result->>'status' <> 'queued' OR authorize_result->>'runtimeExecution' <> 'synthetic' THEN
    RAISE EXCEPTION 'M42 authorization failed: %',authorize_result;
  END IF;
  SELECT public.dop_claim_synthetic_delivery('m42-worker',120,base_time) INTO claim_result;
  IF claim_result->>'outcome' <> 'claimed' OR claim_result->>'recipientAddress' !~ '[.]invalid$' THEN
    RAISE EXCEPTION 'M42 claim failed safe boundary: %',claim_result;
  END IF;
  SELECT public.dop_complete_synthetic_delivery_attempt('m42-worker',(claim_result->>'attemptId')::uuid,
    (claim_result->>'leaseToken')::uuid,'accepted','synthetic:'||repeat('a',64),NULL,NULL,base_time+interval '1 second')
    INTO completion_result;
  IF completion_result->>'status' <> 'accepted' THEN RAISE EXCEPTION 'M42 accept failed: %',completion_result; END IF;
  SELECT public.dop_record_synthetic_delivery_receipt('m42-worker',(claim_result->>'attemptId')::uuid,
    'synthetic:'||repeat('a',64),'m42-success-delivered','delivered',repeat('b',64),base_time+interval '2 seconds',base_time+interval '2 seconds')
    INTO receipt_result;
  IF receipt_result->>'status' <> 'delivered' THEN RAISE EXCEPTION 'M42 receipt failed: %',receipt_result; END IF;
  SELECT public.dop_record_synthetic_delivery_receipt('m42-worker',(claim_result->>'attemptId')::uuid,
    'synthetic:'||repeat('a',64),'m42-success-delivered','delivered',repeat('b',64),base_time+interval '2 seconds',base_time+interval '3 seconds')
    INTO receipt_result;
  IF receipt_result->>'outcome' <> 'duplicate' THEN RAISE EXCEPTION 'M42 receipt replay was not idempotent: %',receipt_result; END IF;

  -- Recoverable 429: backoff gates the next claim, then retry succeeds.
  DELETE FROM public.delivery_receipts WHERE organization_id=draft_row.organization_id AND delivery_job_id=job_id;
  DELETE FROM public.delivery_attempts WHERE organization_id=draft_row.organization_id AND delivery_job_id=job_id;
  UPDATE public.delivery_jobs SET status='queued',attempt_count=0,current_attempt_id=NULL,provider_message_id=NULL,
    synthetic_scenario='rate_limited_once',last_error_code=NULL WHERE id=job_id;
  SELECT public.dop_claim_synthetic_delivery('m42-worker',120,base_time+interval '10 seconds') INTO claim_result;
  PERFORM public.dop_complete_synthetic_delivery_attempt('m42-worker',(claim_result->>'attemptId')::uuid,
    (claim_result->>'leaseToken')::uuid,'failed_recoverable',NULL,'provider_429',base_time+interval '20 seconds',base_time+interval '11 seconds');
  IF (public.dop_claim_synthetic_delivery('m42-worker',120,base_time+interval '19 seconds'))->>'outcome' <> 'empty' THEN
    RAISE EXCEPTION 'M42 retry ignored provider backoff';
  END IF;
  IF (public.dop_claim_synthetic_delivery('m42-worker',120,base_time+interval '20 seconds'))->>'outcome' <> 'claimed' THEN
    RAISE EXCEPTION 'M42 retry did not resume after backoff';
  END IF;

  -- Timeout: unknown result creates a human Task and never auto-retries.
  DELETE FROM public.delivery_attempts WHERE organization_id=draft_row.organization_id AND delivery_job_id=job_id;
  UPDATE public.delivery_jobs SET status='queued',attempt_count=0,current_attempt_id=NULL,
    synthetic_scenario='timeout_unknown',last_error_code=NULL WHERE id=job_id;
  SELECT public.dop_claim_synthetic_delivery('m42-worker',120,base_time+interval '30 seconds') INTO claim_result;
  PERFORM public.dop_complete_synthetic_delivery_attempt('m42-worker',(claim_result->>'attemptId')::uuid,
    (claim_result->>'leaseToken')::uuid,'outcome_unknown',NULL,'provider_timeout',NULL,base_time+interval '31 seconds');
  IF (public.dop_claim_synthetic_delivery('m42-worker',120,base_time+interval '32 seconds'))->>'outcome' <> 'empty'
     OR NOT EXISTS (SELECT 1 FROM public.tasks WHERE organization_id=draft_row.organization_id
       AND task_key='delivery-unknown|'||job_id::text AND status='open') THEN
    RAISE EXCEPTION 'M42 unknown result retried automatically or lacked a human task';
  END IF;
  SELECT public.dop_reconcile_delivery_unknown(manager_id,job_id,'remain_unknown',NULL,
    'Evidence remains inconclusive, so keep the human task and block retry.',gen_random_uuid(),gen_random_uuid(),base_time+interval '33 seconds')
    INTO reconcile_result;
  IF reconcile_result->>'status' <> 'outcome_unknown' THEN RAISE EXCEPTION 'M42 inconclusive reconciliation changed state'; END IF;
  SELECT public.dop_reconcile_delivery_unknown(manager_id,job_id,'proved_not_sent_retry',NULL,
    'Synthetic provider ledger proves no acceptance, so one governed retry is permitted.',gen_random_uuid(),gen_random_uuid(),base_time+interval '34 seconds')
    INTO reconcile_result;
  IF reconcile_result->>'status' <> 'queued' THEN RAISE EXCEPTION 'M42 proved-not-sent reconciliation failed'; END IF;

  -- Crash: an expired lease becomes unknown before any other job can be claimed.
  DELETE FROM public.delivery_attempts WHERE organization_id=draft_row.organization_id AND delivery_job_id=job_id;
  UPDATE public.delivery_jobs SET status='queued',attempt_count=0,current_attempt_id=NULL,
    synthetic_scenario='crash_after_claim',last_error_code=NULL WHERE id=job_id;
  SELECT public.dop_claim_synthetic_delivery('m42-crash-worker',15,base_time+interval '40 seconds') INTO claim_result;
  SELECT public.dop_claim_synthetic_delivery('m42-recovery-worker',15,base_time+interval '56 seconds') INTO completion_result;
  IF completion_result->>'outcome' <> 'empty' OR (completion_result->>'expiredUnknownCount')::integer <> 1
     OR (SELECT status FROM public.delivery_jobs WHERE id=job_id) <> 'outcome_unknown' THEN
    RAISE EXCEPTION 'M42 expired lease was not conservatively marked unknown: %',completion_result;
  END IF;

  -- Kill switch is stronger than queued state and unapproved planned jobs are inert.
  UPDATE public.delivery_jobs SET status='queued',attempt_count=0,current_attempt_id=NULL,
    synthetic_scenario='success' WHERE id=job_id;
  UPDATE public.delivery_runtime_controls SET kill_switch=true WHERE organization_id=draft_row.organization_id;
  IF (public.dop_claim_synthetic_delivery('m42-worker',120,base_time+interval '60 seconds'))->>'outcome' <> 'disabled' THEN
    RAISE EXCEPTION 'M42 kill switch did not stop claims';
  END IF;
  UPDATE public.delivery_runtime_controls SET kill_switch=false WHERE organization_id=draft_row.organization_id;
  UPDATE public.delivery_jobs SET status='planned',runtime_execution='disabled',provider_reference_mode='not_configured',
    attempt_count=0,current_attempt_id=NULL,synthetic_scenario=NULL WHERE id=job_id;
  IF (public.dop_claim_synthetic_delivery('m42-worker',120,base_time+interval '61 seconds'))->>'outcome' <> 'empty' THEN
    RAISE EXCEPTION 'M42 claimed an unapproved planned job';
  END IF;

  IF EXISTS (SELECT 1 FROM public.delivery_runtime_controls WHERE organization_id=draft_row.organization_id
      AND (microsoft_graph_enabled OR external_send_enabled OR allowed_domain<>'.invalid'))
     OR EXISTS (SELECT 1 FROM public.delivery_jobs WHERE organization_id=draft_row.organization_id AND external_call_count<>0)
     OR EXISTS (SELECT 1 FROM public.delivery_attempts WHERE organization_id=draft_row.organization_id AND external_call_count<>0) THEN
    RAISE EXCEPTION 'M42 crossed the no-network synthetic boundary';
  END IF;
  IF has_table_privilege('dop_app','public.delivery_jobs','UPDATE')
     OR has_table_privilege('dop_app','public.delivery_attempts','INSERT')
     OR has_table_privilege('dop_app','public.delivery_receipts','INSERT')
     OR has_table_privilege('dop_app','public.delivery_runtime_controls','UPDATE') THEN
    RAISE EXCEPTION 'M42 application role has direct delivery write privileges';
  END IF;
  IF NOT has_function_privilege('dop_app','public.dop_authorize_synthetic_delivery(uuid,uuid,text,text,uuid,uuid,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('dop_app','public.dop_reconcile_delivery_unknown(uuid,uuid,text,text,text,uuid,uuid,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'M42 governed operator functions are not executable';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'M42 found a public table without RLS';
  END IF;
  RAISE NOTICE 'M42 verification passed: authorization, lease, 429 backoff, timeout/crash unknown, human task, reconciliation, receipt replay, kill switch, external calls 0';
END;
$$;

SELECT jsonb_build_object(
  'verification','passed','provider','synthetic','networkCalls',0,
  'microsoftGraph',false,'realExternalSend',false,'recipientDomain','.invalid',
  'scenarios',jsonb_build_array('success','429','5xx-service-test','timeout','crash','bounce-service-test','receipt-replay'),
  'unknownResult','human-task-no-auto-retry','killSwitch',true,'rls','passed'
) AS m42_verification;

ROLLBACK;
