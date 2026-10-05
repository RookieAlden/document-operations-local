BEGIN;

-- M42 activates only an isolated UAT synthetic provider. It cannot resolve a
-- real domain, carries no external credential and records zero external calls.
ALTER TABLE public.delivery_recipient_allowlist
    DROP CONSTRAINT delivery_recipient_allowlist_environment_check;
ALTER TABLE public.delivery_recipient_allowlist
    ADD CONSTRAINT delivery_recipient_allowlist_environment_check
    CHECK (environment IN ('DEV','UAT'));

ALTER TABLE public.delivery_jobs
    DROP CONSTRAINT delivery_jobs_status_check,
    DROP CONSTRAINT delivery_jobs_runtime_execution_check,
    DROP CONSTRAINT delivery_jobs_provider_reference_mode_check,
    DROP CONSTRAINT delivery_jobs_attempt_count_check,
    DROP CONSTRAINT delivery_jobs_external_call_count_check,
    DROP CONSTRAINT delivery_jobs_provider_message_id_check;
ALTER TABLE public.delivery_jobs
    ADD COLUMN synthetic_scenario text,
    ADD COLUMN current_attempt_id uuid,
    ADD COLUMN authorized_by_actor_id uuid,
    ADD COLUMN authorized_at timestamptz,
    ADD COLUMN outcome_unknown_at timestamptz,
    ADD COLUMN last_error_code text,
    ADD CONSTRAINT delivery_jobs_status_check CHECK (status IN (
        'planned','queued','processing','accepted','delivered','deferred','bounced',
        'failed_recoverable','failed_manual','outcome_unknown','cancelled'
    )),
    ADD CONSTRAINT delivery_jobs_runtime_execution_check
        CHECK (runtime_execution IN ('disabled','synthetic')),
    ADD CONSTRAINT delivery_jobs_provider_reference_mode_check
        CHECK (provider_reference_mode IN ('not_configured','synthetic')),
    ADD CONSTRAINT delivery_jobs_attempt_count_check CHECK (attempt_count BETWEEN 0 AND 3),
    ADD CONSTRAINT delivery_jobs_external_call_count_check CHECK (external_call_count = 0),
    ADD CONSTRAINT delivery_jobs_synthetic_scenario_check CHECK (
        synthetic_scenario IS NULL OR synthetic_scenario IN (
            'success','rate_limited_once','server_error_once','timeout_unknown',
            'crash_after_claim','bounced','receipt_replay'
        )
    ),
    ADD CONSTRAINT delivery_jobs_authorizer_same_org_fk
        FOREIGN KEY (organization_id, authorized_by_actor_id)
        REFERENCES public.actors(organization_id, id);

ALTER TABLE public.delivery_attempts
    DROP CONSTRAINT delivery_attempts_status_check;
ALTER TABLE public.delivery_attempts
    ADD COLUMN lease_token uuid,
    ADD COLUMN provider_kind text NOT NULL DEFAULT 'synthetic'
        CHECK (provider_kind = 'synthetic'),
    ADD COLUMN client_request_id text,
    ADD COLUMN external_call_count integer NOT NULL DEFAULT 0 CHECK (external_call_count = 0),
    ADD CONSTRAINT delivery_attempts_status_check CHECK (status IN (
        'leased','provider_accepted','failed_recoverable','failed_manual','outcome_unknown'
    ));

ALTER TABLE public.delivery_receipts
    ADD COLUMN provider_kind text NOT NULL DEFAULT 'synthetic'
        CHECK (provider_kind = 'synthetic');

CREATE TABLE public.delivery_runtime_controls (
    organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
    environment text NOT NULL CHECK (environment = 'UAT'),
    provider_mode text NOT NULL CHECK (provider_mode IN ('disabled','synthetic')),
    runtime_enabled boolean NOT NULL,
    kill_switch boolean NOT NULL,
    microsoft_graph_enabled boolean NOT NULL DEFAULT false CHECK (NOT microsoft_graph_enabled),
    external_send_enabled boolean NOT NULL DEFAULT false CHECK (NOT external_send_enabled),
    allowed_domain text NOT NULL CHECK (allowed_domain = '.invalid'),
    max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
    updated_by_actor_id uuid,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, environment),
    FOREIGN KEY (organization_id, updated_by_actor_id)
        REFERENCES public.actors(organization_id, id)
);
ALTER TABLE public.delivery_runtime_controls ENABLE ROW LEVEL SECURITY;
CREATE POLICY dop_tenant_isolation ON public.delivery_runtime_controls
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
GRANT SELECT ON TABLE public.delivery_runtime_controls TO dop_app;

INSERT INTO public.delivery_runtime_controls (
    organization_id, environment, provider_mode, runtime_enabled, kill_switch,
    microsoft_graph_enabled, external_send_enabled, allowed_domain, max_attempts,
    reason, updated_at
)
SELECT id, 'UAT',
       CASE WHEN organization_key = 'uat-accounting-firm' THEN 'synthetic' ELSE 'disabled' END,
       organization_key = 'uat-accounting-firm',
       organization_key <> 'uat-accounting-firm',
       false, false, '.invalid', 3,
       CASE WHEN organization_key = 'uat-accounting-firm'
         THEN 'M42 authorizes only the deterministic no-network synthetic UAT provider.'
         ELSE 'M42 keeps synthetic delivery disabled outside the approved UAT organization.' END,
       now()
  FROM public.organizations
 ON CONFLICT (organization_id) DO NOTHING;

UPDATE public.delivery_recipient_allowlist allowlist
   SET environment = 'UAT', updated_at = now()
  FROM public.organizations organization
 WHERE organization.id = allowlist.organization_id
   AND organization.organization_key = 'uat-accounting-firm'
   AND allowlist.environment = 'DEV';

CREATE OR REPLACE FUNCTION public.dop_sync_dev_delivery_recipient(
    p_subject_recipient_allowlist_id uuid,
    p_now timestamptz DEFAULT now()
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    source_row public.subject_message_recipient_allowlist%ROWTYPE;
    actor_row public.actors%ROWTYPE;
    organization_key_value text;
    environment_value text;
    result_id uuid;
BEGIN
    SELECT * INTO source_row FROM public.subject_message_recipient_allowlist
     WHERE id = p_subject_recipient_allowlist_id;
    IF NOT FOUND OR source_row.purpose <> 'missing_document_request' OR source_row.status <> 'active' THEN
        RETURN NULL;
    END IF;
    SELECT * INTO actor_row FROM public.actors
     WHERE organization_id = source_row.organization_id AND id = source_row.actor_id
       AND actor_type = 'customer' AND status = 'active' AND email IS NOT NULL;
    IF NOT FOUND OR NOT (actor_row.attributes @> '{"synthetic":true}'::jsonb) THEN RETURN NULL; END IF;
    SELECT organization_key INTO organization_key_value FROM public.organizations
     WHERE id = source_row.organization_id;
    environment_value := CASE WHEN organization_key_value = 'uat-accounting-firm' THEN 'UAT' ELSE 'DEV' END;
    INSERT INTO public.delivery_recipient_allowlist (
        id, organization_id, actor_id, environment, channel, purpose, recipient_address,
        display_name, status, source, approved_by_actor_id, reason,
        approved_at, created_at, updated_at
    ) VALUES (
        gen_random_uuid(), source_row.organization_id, actor_row.id, environment_value, 'email',
        'missing_document_request', lower(environment_value) || '+' || replace(actor_row.id::text,'-','') ||
            '@document-operations.invalid', actor_row.display_name,
        'active', 'synthetic_dev_fixture', source_row.approved_by_actor_id,
        'Synthetic actor mapped to a derived .invalid alias; the source email is never a delivery address.',
        p_now, p_now, p_now
    ) ON CONFLICT (organization_id, environment, channel, purpose, actor_id)
      DO UPDATE SET recipient_address = EXCLUDED.recipient_address,
          display_name = EXCLUDED.display_name, status = 'active', revoked_at = NULL,
          updated_at = EXCLUDED.updated_at
    RETURNING id INTO result_id;
    RETURN result_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_plan_missing_request_delivery(
    p_actor_id uuid, p_revision_id uuid, p_reason text, p_idempotency_key uuid,
    p_correlation_id uuid, p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_require_active_manager(p_actor_id);
    revision_row public.missing_document_request_revisions%ROWTYPE;
    draft_row public.missing_document_request_drafts%ROWTYPE;
    subject_allow_row public.subject_message_recipient_allowlist%ROWTYPE;
    actor_row public.actors%ROWTYPE;
    delivery_allow_row public.delivery_recipient_allowlist%ROWTYPE;
    existing public.delivery_jobs%ROWTYPE;
    job_id uuid := gen_random_uuid(); event_id uuid := gen_random_uuid();
    recipient_address_value text; send_key_value text; fingerprint text;
BEGIN
    IF length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO revision_row FROM public.missing_document_request_revisions
     WHERE organization_id = org_id AND id = p_revision_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','revision_not_found'); END IF;
    IF revision_row.status <> 'approved' THEN RETURN jsonb_build_object('outcome','conflict','reason','approved_revision_required'); END IF;
    IF revision_row.delivery_mode <> 'disabled' OR revision_row.external_call_count <> 0 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','source_delivery_boundary_invalid');
    END IF;
    SELECT * INTO draft_row FROM public.missing_document_request_drafts
     WHERE organization_id = org_id AND id = revision_row.request_draft_id;
    SELECT * INTO subject_allow_row FROM public.subject_message_recipient_allowlist
     WHERE organization_id = org_id AND id = revision_row.recipient_allowlist_id
       AND subject_id = draft_row.subject_id AND purpose = 'missing_document_request' AND status = 'active';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','recipient_not_allowlisted'); END IF;
    SELECT * INTO actor_row FROM public.actors
     WHERE organization_id = org_id AND id = subject_allow_row.actor_id
       AND actor_type = 'customer' AND status = 'active' AND email IS NOT NULL;
    IF NOT FOUND OR NOT (actor_row.attributes @> '{"synthetic":true}'::jsonb) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','synthetic_recipient_required');
    END IF;
    recipient_address_value := lower(btrim(actor_row.email));
    IF revision_row.recipient_snapshot->>'email' IS DISTINCT FROM recipient_address_value THEN
        RETURN jsonb_build_object('outcome','conflict','reason','recipient_snapshot_drift');
    END IF;
    SELECT * INTO delivery_allow_row FROM public.delivery_recipient_allowlist
     WHERE organization_id = org_id AND environment IN ('UAT','DEV') AND channel = 'email'
       AND purpose = 'missing_document_request' AND actor_id = actor_row.id AND status = 'active'
     ORDER BY CASE environment WHEN 'UAT' THEN 0 ELSE 1 END LIMIT 1;
    IF NOT FOUND OR delivery_allow_row.recipient_address !~ '[.]invalid$' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','synthetic_recipient_not_allowlisted');
    END IF;
    send_key_value := encode(digest(concat_ws('|','delivery-v2',org_id::text,
        p_revision_id::text,revision_row.content_hash,delivery_allow_row.recipient_address),'sha256'),'hex');
    fingerprint := encode(digest(concat_ws('|',p_revision_id::text,send_key_value,btrim(p_reason)),'sha256'),'hex');
    SELECT * INTO existing FROM public.delivery_jobs WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
      IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','deliveryJobId',existing.id,'status',existing.status,'runtimeExecution',existing.runtime_execution,'externalCallCount',0); END IF;
      RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO existing FROM public.delivery_jobs WHERE organization_id=org_id AND source_revision_id=p_revision_id;
    IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','deliveryJobId',existing.id,'status',existing.status,'runtimeExecution',existing.runtime_execution,'externalCallCount',0); END IF;
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (event_id,org_id,p_idempotency_key::text||':event','MissingDocumentRequest.DeliveryPlanned',2,
      'delivery_job',job_id,p_correlation_id,p_actor_id,'ops-delivery-readiness',jsonb_build_object(
      'source_revision_id',p_revision_id,'recipient_policy','invalid_alias_only','runtime_execution','disabled',
      'provider_reference_mode','not_configured','external_call_count',0),p_now);
    INSERT INTO public.delivery_jobs (id,organization_id,case_id,subject_id,source_revision_id,channel,purpose,
      recipient_allowlist_id,recipient_snapshot,subject_line,body_text,content_hash,send_key,status,
      runtime_execution,provider_reference_mode,attempt_count,external_call_count,provider_message_id,
      created_by_actor_id,creation_reason,idempotency_key,request_fingerprint,event_id,created_at,updated_at)
    VALUES (job_id,org_id,draft_row.case_id,draft_row.subject_id,revision_row.id,'email','missing_document_request',
      delivery_allow_row.id,jsonb_build_object('displayName',actor_row.display_name,'actorId',actor_row.id,
      'address',delivery_allow_row.recipient_address,'sourceAddressHash',encode(digest(recipient_address_value,'sha256'),'hex'),
      'policy','invalid_alias_only','allowlistId',delivery_allow_row.id),revision_row.subject_line,
      revision_row.body_text,revision_row.content_hash,send_key_value,'planned','disabled','not_configured',0,0,NULL,
      p_actor_id,btrim(p_reason),p_idempotency_key,fingerprint,event_id,p_now,p_now);
    RETURN jsonb_build_object('outcome','completed','deliveryJobId',job_id,'status','planned',
      'runtimeExecution','disabled','providerConfigured',false,'attemptCount',0,'externalCallCount',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_authorize_synthetic_delivery(
    p_actor_id uuid, p_delivery_job_id uuid, p_scenario text, p_reason text,
    p_idempotency_key uuid, p_correlation_id uuid, p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  org_id uuid := public.dop_require_active_manager(p_actor_id);
  job_row public.delivery_jobs%ROWTYPE; event_id uuid := gen_random_uuid(); prior_event public.workflow_events%ROWTYPE;
BEGIN
  IF p_scenario NOT IN ('success','rate_limited_once','server_error_once','timeout_unknown','crash_after_claim','bounced','receipt_replay')
     OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  SELECT * INTO prior_event FROM public.workflow_events WHERE organization_id=org_id AND idempotency_key='delivery-authorize|'||p_idempotency_key::text;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','deliveryJobId',prior_event.aggregate_id); END IF;
  SELECT * INTO job_row FROM public.delivery_jobs WHERE organization_id=org_id AND id=p_delivery_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','delivery_job_not_found'); END IF;
  IF job_row.status <> 'planned' OR job_row.runtime_execution <> 'disabled' OR job_row.attempt_count <> 0 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','delivery_not_authorizable');
  END IF;
  IF job_row.recipient_snapshot->>'address' !~ '[.]invalid$' THEN
    RETURN jsonb_build_object('outcome','conflict','reason','unsafe_recipient');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.delivery_contract_evaluations WHERE organization_id=org_id
      AND delivery_job_id=job_row.id AND status='passed') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','passing_contract_evaluation_required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.delivery_runtime_controls WHERE organization_id=org_id
      AND environment='UAT' AND provider_mode='synthetic' AND runtime_enabled AND NOT kill_switch
      AND NOT microsoft_graph_enabled AND NOT external_send_enabled) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','synthetic_runtime_disabled');
  END IF;
  UPDATE public.delivery_jobs SET status='queued',runtime_execution='synthetic',
    provider_reference_mode='synthetic',synthetic_scenario=p_scenario,
    authorized_by_actor_id=p_actor_id,authorized_at=p_now,updated_at=p_now
   WHERE organization_id=org_id AND id=job_row.id;
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (event_id,org_id,'delivery-authorize|'||p_idempotency_key::text,'DeliveryJob.SyntheticAuthorized',1,
    'delivery_job',job_row.id,p_correlation_id,p_actor_id,'dop.ops.delivery.v1',jsonb_build_object(
    'scenario',p_scenario,'recipient_domain','.invalid','provider','synthetic','microsoft_graph_enabled',false,
    'external_send_enabled',false,'external_call_count',0,'reason',btrim(p_reason)),p_now);
  RETURN jsonb_build_object('outcome','completed','deliveryJobId',job_row.id,'status','queued',
    'runtimeExecution','synthetic','scenario',p_scenario,'externalCallCount',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_create_delivery_unknown_task(
  p_organization_id uuid, p_delivery_job_id uuid, p_now timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE job_row public.delivery_jobs%ROWTYPE; task_id uuid;
BEGIN
  SELECT * INTO job_row FROM public.delivery_jobs WHERE organization_id=p_organization_id AND id=p_delivery_job_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.tasks (id,organization_id,case_id,task_key,task_type,status,context,created_at,updated_at)
  VALUES (gen_random_uuid(),p_organization_id,job_row.case_id,'delivery-unknown|'||job_row.id::text,
    'delivery.outcome_unknown','open',jsonb_build_object('deliveryJobId',job_row.id,
    'externalExecution','disabled','automaticRetry','blocked','possibleDuplicateRequiresAuthorization',true),p_now,p_now)
  ON CONFLICT (organization_id,task_key) DO UPDATE SET status=CASE WHEN tasks.status='cancelled' THEN 'open' ELSE tasks.status END,
    context=tasks.context||jsonb_build_object('lastObservedAt',p_now),updated_at=p_now
  RETURNING id INTO task_id;
  RETURN task_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_claim_synthetic_delivery(
  p_worker_id text, p_lease_seconds integer, p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $$
DECLARE org_id uuid := public.dop_current_organization_id(); job_row public.delivery_jobs%ROWTYPE;
  attempt_id uuid := gen_random_uuid(); lease_value uuid := gen_random_uuid(); attempt_number_value integer;
  expired_row record; expired_count integer := 0; client_request_value text;
BEGIN
  IF org_id IS NULL OR length(p_worker_id) NOT BETWEEN 3 AND 200 OR p_lease_seconds NOT BETWEEN 15 AND 900 THEN
    RETURN jsonb_build_object('outcome','disabled','expiredUnknownCount',0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.delivery_runtime_controls WHERE organization_id=org_id
      AND provider_mode='synthetic' AND runtime_enabled AND NOT kill_switch
      AND NOT microsoft_graph_enabled AND NOT external_send_enabled) THEN
    RETURN jsonb_build_object('outcome','disabled','expiredUnknownCount',0);
  END IF;
  FOR expired_row IN
    SELECT attempt.id AS attempt_id, attempt.delivery_job_id
      FROM public.delivery_attempts attempt JOIN public.delivery_jobs job ON job.id=attempt.delivery_job_id
     WHERE attempt.organization_id=org_id AND attempt.status='leased' AND attempt.lock_expires_at < p_now
       AND job.status='processing' FOR UPDATE OF attempt,job SKIP LOCKED
  LOOP
    UPDATE public.delivery_attempts SET status='outcome_unknown',error_code='worker_lease_expired',
      completed_at=p_now,lock_owner=NULL,lock_expires_at=NULL
     WHERE organization_id=org_id AND id=expired_row.attempt_id;
    UPDATE public.delivery_jobs SET status='outcome_unknown',current_attempt_id=NULL,
      outcome_unknown_at=p_now,last_error_code='worker_lease_expired',updated_at=p_now
     WHERE organization_id=org_id AND id=expired_row.delivery_job_id;
    PERFORM public.dop_create_delivery_unknown_task(org_id,expired_row.delivery_job_id,p_now);
    INSERT INTO public.workflow_events (organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,producer,payload,occurred_at)
    VALUES (org_id,'delivery-expired|'||expired_row.attempt_id::text,'DeliveryJob.OutcomeUnknown',1,
      'delivery_job',expired_row.delivery_job_id,gen_random_uuid(),'dop.delivery.synthetic.v1',
      jsonb_build_object('attempt_id',expired_row.attempt_id,'reason','worker_lease_expired',
      'automatic_retry','blocked','external_call_count',0),p_now)
    ON CONFLICT (organization_id,idempotency_key) DO NOTHING;
    expired_count := expired_count + 1;
  END LOOP;
  SELECT * INTO job_row FROM public.delivery_jobs
   WHERE organization_id=org_id AND runtime_execution='synthetic'
     AND status IN ('queued','failed_recoverable') AND attempt_count < 3
     AND (status='queued' OR EXISTS (SELECT 1 FROM public.delivery_attempts a
       WHERE a.organization_id=org_id AND a.delivery_job_id=delivery_jobs.id
         AND a.attempt_number=delivery_jobs.attempt_count AND a.retry_not_before <= p_now))
   ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','empty','expiredUnknownCount',expired_count); END IF;
  IF job_row.recipient_snapshot->>'address' !~ '[.]invalid$' OR job_row.synthetic_scenario IS NULL THEN
    UPDATE public.delivery_jobs SET status='failed_manual',last_error_code='unsafe_execution_boundary',updated_at=p_now
      WHERE organization_id=org_id AND id=job_row.id;
    RETURN jsonb_build_object('outcome','empty','expiredUnknownCount',expired_count);
  END IF;
  attempt_number_value := job_row.attempt_count + 1;
  client_request_value := encode(digest(job_row.send_key||'|'||attempt_number_value::text,'sha256'),'hex');
  INSERT INTO public.delivery_attempts (id,organization_id,delivery_job_id,attempt_number,status,
    idempotency_key,lock_owner,lock_expires_at,lease_token,provider_kind,client_request_id,
    external_call_count,started_at,created_at)
  VALUES (attempt_id,org_id,job_row.id,attempt_number_value,'leased',
    job_row.send_key||':'||attempt_number_value::text,p_worker_id,p_now+make_interval(secs=>p_lease_seconds),
    lease_value,'synthetic',client_request_value,0,p_now,p_now);
  UPDATE public.delivery_jobs SET status='processing',attempt_count=attempt_number_value,
    current_attempt_id=attempt_id,last_error_code=NULL,updated_at=p_now WHERE organization_id=org_id AND id=job_row.id;
  RETURN jsonb_build_object('outcome','claimed','expiredUnknownCount',expired_count,
    'deliveryJobId',job_row.id,'attemptId',attempt_id,'attemptNumber',attempt_number_value,
    'leaseToken',lease_value,'clientRequestId',client_request_value,
    'recipientAddress',job_row.recipient_snapshot->>'address','subjectLine',job_row.subject_line,
    'bodyText',job_row.body_text,'scenario',job_row.synthetic_scenario);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_complete_synthetic_delivery_attempt(
  p_worker_id text, p_attempt_id uuid, p_lease_token uuid, p_outcome text,
  p_provider_message_id text, p_error_code text, p_retry_not_before timestamptz, p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE org_id uuid := public.dop_current_organization_id(); attempt_row public.delivery_attempts%ROWTYPE;
  job_status text; event_type_value text;
BEGIN
  IF p_outcome NOT IN ('accepted','failed_recoverable','failed_manual','outcome_unknown') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_outcome');
  END IF;
  SELECT * INTO attempt_row FROM public.delivery_attempts WHERE organization_id=org_id AND id=p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','attempt_not_found'); END IF;
  IF attempt_row.status <> 'leased' THEN
    IF attempt_row.status = (CASE p_outcome WHEN 'accepted' THEN 'provider_accepted' ELSE p_outcome END) THEN
      RETURN jsonb_build_object('outcome','duplicate');
    END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','attempt_already_final');
  END IF;
  IF attempt_row.lock_owner IS DISTINCT FROM p_worker_id OR attempt_row.lease_token IS DISTINCT FROM p_lease_token
     OR attempt_row.lock_expires_at < p_now THEN
    RETURN jsonb_build_object('outcome','conflict','reason','lease_lost');
  END IF;
  IF p_outcome='accepted' AND (p_provider_message_id IS NULL OR p_provider_message_id !~ '^synthetic:[0-9a-f]{64}$') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','synthetic_provider_reference_required');
  END IF;
  IF p_outcome='failed_recoverable' AND (p_retry_not_before IS NULL OR p_retry_not_before < p_now) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','retry_backoff_required');
  END IF;
  job_status := CASE p_outcome WHEN 'accepted' THEN 'accepted' ELSE p_outcome END;
  event_type_value := CASE p_outcome WHEN 'accepted' THEN 'DeliveryJob.ProviderAccepted'
    WHEN 'outcome_unknown' THEN 'DeliveryJob.OutcomeUnknown' ELSE 'DeliveryJob.AttemptFailed' END;
  UPDATE public.delivery_attempts SET status=CASE p_outcome WHEN 'accepted' THEN 'provider_accepted' ELSE p_outcome END,
    retry_not_before=p_retry_not_before,error_code=p_error_code,provider_message_id=p_provider_message_id,
    completed_at=p_now,lock_owner=NULL,lock_expires_at=NULL WHERE organization_id=org_id AND id=p_attempt_id;
  UPDATE public.delivery_jobs SET status=job_status,current_attempt_id=NULL,
    provider_message_id=coalesce(p_provider_message_id,provider_message_id),last_error_code=p_error_code,
    outcome_unknown_at=CASE WHEN p_outcome='outcome_unknown' THEN p_now ELSE outcome_unknown_at END,updated_at=p_now
    WHERE organization_id=org_id AND id=attempt_row.delivery_job_id;
  IF p_outcome IN ('outcome_unknown','failed_manual') THEN
    PERFORM public.dop_create_delivery_unknown_task(org_id,attempt_row.delivery_job_id,p_now);
  END IF;
  INSERT INTO public.workflow_events (organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,producer,payload,occurred_at)
  VALUES (org_id,'delivery-complete|'||p_attempt_id::text,event_type_value,1,'delivery_job',
    attempt_row.delivery_job_id,gen_random_uuid(),'dop.delivery.synthetic.v1',jsonb_build_object(
    'attempt_id',p_attempt_id,'outcome',p_outcome,'error_code',p_error_code,
    'provider_message_id',p_provider_message_id,'automatic_retry',CASE WHEN p_outcome='outcome_unknown' THEN 'blocked' ELSE 'policy' END,
    'external_call_count',0),p_now);
  RETURN jsonb_build_object('outcome','completed','status',job_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_record_synthetic_delivery_receipt(
  p_worker_id text, p_attempt_id uuid, p_provider_message_id text, p_receipt_key text,
  p_receipt_type text, p_payload_hash text, p_occurred_at timestamptz, p_received_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE org_id uuid := public.dop_current_organization_id(); attempt_row public.delivery_attempts%ROWTYPE;
  existing public.delivery_receipts%ROWTYPE; receipt_id uuid:=gen_random_uuid(); job_status text;
BEGIN
  IF length(p_worker_id) NOT BETWEEN 3 AND 200 OR p_receipt_type NOT IN ('delivered','bounced')
     OR p_payload_hash !~ '^[0-9a-f]{64}$' OR p_provider_message_id !~ '^synthetic:[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_receipt');
  END IF;
  SELECT * INTO existing FROM public.delivery_receipts WHERE organization_id=org_id AND receipt_key=p_receipt_key;
  IF FOUND THEN
    IF existing.payload_hash=p_payload_hash AND existing.receipt_type=p_receipt_type
      AND existing.provider_message_id=p_provider_message_id THEN RETURN jsonb_build_object('outcome','duplicate','receiptId',existing.id); END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','receipt_key_reused');
  END IF;
  SELECT * INTO attempt_row FROM public.delivery_attempts WHERE organization_id=org_id AND id=p_attempt_id
    AND status='provider_accepted' AND provider_message_id=p_provider_message_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','accepted_attempt_required'); END IF;
  INSERT INTO public.delivery_receipts (id,organization_id,delivery_job_id,delivery_attempt_id,receipt_key,
    receipt_type,provider_message_id,payload_hash,occurred_at,received_at,created_at,provider_kind)
  VALUES (receipt_id,org_id,attempt_row.delivery_job_id,attempt_row.id,p_receipt_key,p_receipt_type,
    p_provider_message_id,p_payload_hash,p_occurred_at,p_received_at,p_received_at,'synthetic');
  job_status := p_receipt_type;
  UPDATE public.delivery_jobs SET status=job_status,updated_at=p_received_at
    WHERE organization_id=org_id AND id=attempt_row.delivery_job_id;
  INSERT INTO public.workflow_events (organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,producer,payload,occurred_at)
  VALUES (org_id,'delivery-receipt|'||p_receipt_key,'DeliveryJob.ReceiptRecorded',1,'delivery_job',
    attempt_row.delivery_job_id,gen_random_uuid(),'dop.delivery.synthetic.v1',jsonb_build_object(
    'receipt_id',receipt_id,'receipt_type',p_receipt_type,'payload_hash',p_payload_hash,
    'provider','synthetic','external_call_count',0),p_received_at);
  RETURN jsonb_build_object('outcome','completed','receiptId',receipt_id,'status',job_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_reconcile_delivery_unknown(
  p_actor_id uuid, p_delivery_job_id uuid, p_action text, p_provider_message_id text,
  p_reason text, p_idempotency_key uuid, p_correlation_id uuid, p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE org_id uuid:=public.dop_require_active_manager(p_actor_id); job_row public.delivery_jobs%ROWTYPE;
  prior public.workflow_events%ROWTYPE; resulting_status text;
BEGIN
  IF p_action NOT IN ('proved_not_sent_retry','confirmed_sent','remain_unknown')
     OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  SELECT * INTO prior FROM public.workflow_events WHERE organization_id=org_id
    AND idempotency_key='delivery-reconcile|'||p_idempotency_key::text;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','deliveryJobId',prior.aggregate_id,
    'status',prior.payload->>'resulting_status'); END IF;
  SELECT * INTO job_row FROM public.delivery_jobs WHERE organization_id=org_id AND id=p_delivery_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','delivery_job_not_found'); END IF;
  IF job_row.status <> 'outcome_unknown' THEN RETURN jsonb_build_object('outcome','conflict','reason','outcome_unknown_required'); END IF;
  IF p_action='confirmed_sent' AND (p_provider_message_id IS NULL OR p_provider_message_id !~ '^synthetic:[0-9a-f]{64}$') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','provider_proof_required');
  END IF;
  resulting_status := CASE p_action WHEN 'proved_not_sent_retry' THEN 'queued'
    WHEN 'confirmed_sent' THEN 'accepted' ELSE 'outcome_unknown' END;
  UPDATE public.delivery_jobs SET status=resulting_status,
    provider_message_id=CASE WHEN p_action='confirmed_sent' THEN p_provider_message_id ELSE provider_message_id END,
    last_error_code=CASE WHEN p_action='remain_unknown' THEN last_error_code ELSE NULL END,updated_at=p_now
    WHERE organization_id=org_id AND id=job_row.id;
  IF p_action <> 'remain_unknown' THEN
    UPDATE public.tasks SET status='cancelled',updated_at=p_now
      WHERE organization_id=org_id AND task_key='delivery-unknown|'||job_row.id::text
        AND status IN ('open','waiting','in_progress');
  END IF;
  INSERT INTO public.workflow_events (organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (org_id,'delivery-reconcile|'||p_idempotency_key::text,'DeliveryJob.UnknownReconciled',1,
    'delivery_job',job_row.id,p_correlation_id,p_actor_id,'dop.ops.delivery.v1',jsonb_build_object(
    'action',p_action,'resulting_status',resulting_status,'reason',btrim(p_reason),
    'provider_message_id',p_provider_message_id,'automatic_retry','blocked','external_call_count',0),p_now);
  RETURN jsonb_build_object('outcome','completed','deliveryJobId',job_row.id,'status',resulting_status,'action',p_action);
END;
$$;

CREATE INDEX delivery_jobs_runtime_queue_idx ON public.delivery_jobs
  (organization_id,runtime_execution,status,updated_at,id);

REVOKE INSERT,UPDATE,DELETE ON TABLE public.delivery_runtime_controls,public.delivery_jobs,
  public.delivery_attempts,public.delivery_receipts FROM dop_app;
REVOKE ALL ON FUNCTION public.dop_authorize_synthetic_delivery(uuid,uuid,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_delivery_unknown_task(uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_claim_synthetic_delivery(text,integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_complete_synthetic_delivery_attempt(text,uuid,uuid,text,text,text,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_record_synthetic_delivery_receipt(text,uuid,text,text,text,text,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_reconcile_delivery_unknown(uuid,uuid,text,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_authorize_synthetic_delivery(uuid,uuid,text,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_claim_synthetic_delivery(text,integer,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_complete_synthetic_delivery_attempt(text,uuid,uuid,text,text,text,timestamptz,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_record_synthetic_delivery_receipt(text,uuid,text,text,text,text,timestamptz,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_reconcile_delivery_unknown(uuid,uuid,text,text,text,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
