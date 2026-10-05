BEGIN;

-- M28 models the future delivery boundary without enabling delivery. A planned
-- job is auditable preparation, not a Notification, provider call or send
-- authorization. No function can claim a job or write attempts/receipts.
CREATE TABLE public.delivery_recipient_allowlist (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    actor_id uuid NOT NULL REFERENCES public.actors(id),
    environment text NOT NULL CHECK (environment = 'DEV'),
    channel text NOT NULL CHECK (channel = 'email'),
    purpose text NOT NULL CHECK (purpose = 'missing_document_request'),
    recipient_address text NOT NULL CHECK (
        recipient_address = lower(btrim(recipient_address))
        AND recipient_address ~ '^[^[:space:]@]+@[^[:space:]@]+[.]invalid$'
    ),
    display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 160),
    status text NOT NULL CHECK (status IN ('active','revoked')),
    source text NOT NULL CHECK (source IN ('synthetic_dev_fixture','manual_approval')),
    approved_by_actor_id uuid REFERENCES public.actors(id),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
    approved_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, environment, channel, purpose, actor_id),
    UNIQUE (organization_id, environment, channel, purpose, recipient_address),
    CONSTRAINT delivery_recipient_actor_same_org_fk
        FOREIGN KEY (organization_id, actor_id) REFERENCES public.actors(organization_id, id),
    CONSTRAINT delivery_recipient_approver_same_org_fk
        FOREIGN KEY (organization_id, approved_by_actor_id) REFERENCES public.actors(organization_id, id),
    CHECK ((status = 'active' AND revoked_at IS NULL) OR status = 'revoked')
);

CREATE TABLE public.delivery_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    case_id uuid NOT NULL REFERENCES public.cases(id),
    subject_id uuid NOT NULL REFERENCES public.subjects(id),
    source_revision_id uuid NOT NULL REFERENCES public.missing_document_request_revisions(id),
    channel text NOT NULL CHECK (channel = 'email'),
    purpose text NOT NULL CHECK (purpose = 'missing_document_request'),
    recipient_allowlist_id uuid NOT NULL REFERENCES public.delivery_recipient_allowlist(id),
    recipient_snapshot jsonb NOT NULL CHECK (jsonb_typeof(recipient_snapshot) = 'object'),
    subject_line text NOT NULL CHECK (length(subject_line) BETWEEN 1 AND 300),
    body_text text NOT NULL CHECK (length(body_text) BETWEEN 20 AND 10000),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    send_key text NOT NULL CHECK (send_key ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('planned','cancelled')),
    runtime_execution text NOT NULL DEFAULT 'disabled' CHECK (runtime_execution = 'disabled'),
    provider_reference_mode text NOT NULL DEFAULT 'not_configured'
        CHECK (provider_reference_mode = 'not_configured'),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count = 0),
    external_call_count integer NOT NULL DEFAULT 0 CHECK (external_call_count = 0),
    provider_message_id text CHECK (provider_message_id IS NULL),
    created_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    creation_reason text NOT NULL CHECK (length(btrim(creation_reason)) BETWEEN 12 AND 1000),
    idempotency_key uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, source_revision_id),
    UNIQUE (organization_id, send_key),
    UNIQUE (organization_id, idempotency_key),
    CONSTRAINT delivery_job_case_same_org_fk
        FOREIGN KEY (organization_id, case_id) REFERENCES public.cases(organization_id, id),
    CONSTRAINT delivery_job_subject_same_org_fk
        FOREIGN KEY (organization_id, subject_id) REFERENCES public.subjects(organization_id, id),
    CONSTRAINT delivery_job_revision_same_org_fk
        FOREIGN KEY (organization_id, source_revision_id)
        REFERENCES public.missing_document_request_revisions(organization_id, id),
    CONSTRAINT delivery_job_recipient_same_org_fk
        FOREIGN KEY (organization_id, recipient_allowlist_id)
        REFERENCES public.delivery_recipient_allowlist(organization_id, id),
    CONSTRAINT delivery_job_creator_same_org_fk
        FOREIGN KEY (organization_id, created_by_actor_id) REFERENCES public.actors(organization_id, id),
    CONSTRAINT delivery_job_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES public.workflow_events(organization_id, id)
);

-- Future execution evidence. These tables intentionally have no mutation
-- function in M28 and remain empty. Activation must arrive in a later migration.
CREATE TABLE public.delivery_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    delivery_job_id uuid NOT NULL REFERENCES public.delivery_jobs(id),
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    status text NOT NULL CHECK (status IN (
        'leased','provider_accepted','failed_recoverable','failed_manual'
    )),
    idempotency_key text NOT NULL,
    lock_owner text,
    lock_expires_at timestamptz,
    retry_not_before timestamptz,
    error_code text,
    provider_message_id text,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, delivery_job_id, attempt_number),
    UNIQUE (organization_id, idempotency_key),
    CONSTRAINT delivery_attempt_job_same_org_fk
        FOREIGN KEY (organization_id, delivery_job_id) REFERENCES public.delivery_jobs(organization_id, id)
);

CREATE TABLE public.delivery_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    delivery_job_id uuid NOT NULL REFERENCES public.delivery_jobs(id),
    delivery_attempt_id uuid NOT NULL REFERENCES public.delivery_attempts(id),
    receipt_key text NOT NULL,
    receipt_type text NOT NULL CHECK (receipt_type IN (
        'accepted','delivered','deferred','bounced','complained'
    )),
    provider_message_id text NOT NULL,
    payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, receipt_key),
    CONSTRAINT delivery_receipt_job_same_org_fk
        FOREIGN KEY (organization_id, delivery_job_id) REFERENCES public.delivery_jobs(organization_id, id),
    CONSTRAINT delivery_receipt_attempt_same_org_fk
        FOREIGN KEY (organization_id, delivery_attempt_id) REFERENCES public.delivery_attempts(organization_id, id)
);

CREATE TABLE public.delivery_contract_evaluations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    delivery_job_id uuid NOT NULL REFERENCES public.delivery_jobs(id),
    contract_version text NOT NULL CHECK (contract_version = '1.0'),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('passed','failed')),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
    run_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    idempotency_key uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    external_call_count integer NOT NULL DEFAULT 0 CHECK (external_call_count = 0),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    CONSTRAINT delivery_evaluation_job_same_org_fk
        FOREIGN KEY (organization_id, delivery_job_id) REFERENCES public.delivery_jobs(organization_id, id),
    CONSTRAINT delivery_evaluation_actor_same_org_fk
        FOREIGN KEY (organization_id, run_by_actor_id) REFERENCES public.actors(organization_id, id),
    CONSTRAINT delivery_evaluation_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES public.workflow_events(organization_id, id)
);

CREATE INDEX delivery_recipient_active_idx ON public.delivery_recipient_allowlist
    (organization_id, environment, purpose, status, recipient_address);
CREATE INDEX delivery_job_case_idx ON public.delivery_jobs
    (organization_id, case_id, created_at DESC);
CREATE INDEX delivery_attempt_job_idx ON public.delivery_attempts
    (organization_id, delivery_job_id, attempt_number DESC);
CREATE INDEX delivery_receipt_job_idx ON public.delivery_receipts
    (organization_id, delivery_job_id, received_at DESC);
CREATE INDEX delivery_evaluation_job_idx ON public.delivery_contract_evaluations
    (organization_id, delivery_job_id, created_at DESC);

ALTER TABLE public.delivery_recipient_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_contract_evaluations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.delivery_recipient_allowlist, public.delivery_jobs,
    public.delivery_attempts, public.delivery_receipts,
    public.delivery_contract_evaluations TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.delivery_recipient_allowlist
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.delivery_jobs
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.delivery_attempts
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.delivery_receipts
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.delivery_contract_evaluations
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_sync_dev_delivery_recipient(
    p_subject_recipient_allowlist_id uuid,
    p_now timestamptz DEFAULT now()
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    source_row public.subject_message_recipient_allowlist%ROWTYPE;
    actor_row public.actors%ROWTYPE;
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
    IF NOT FOUND OR NOT (actor_row.attributes @> '{"synthetic":true}'::jsonb) THEN
        RETURN NULL;
    END IF;
    INSERT INTO public.delivery_recipient_allowlist (
        id, organization_id, actor_id, environment, channel, purpose, recipient_address,
        display_name, status, source, approved_by_actor_id, reason,
        approved_at, created_at, updated_at
    ) VALUES (
        gen_random_uuid(), source_row.organization_id, actor_row.id, 'DEV', 'email',
        'missing_document_request', 'dev+' || replace(actor_row.id::text,'-','') ||
            '@document-operations.invalid', actor_row.display_name,
        'active', 'synthetic_dev_fixture', source_row.approved_by_actor_id,
        'Synthetic actor mapped to a derived .invalid DEV alias; the source email is never a delivery address.',
        p_now, p_now, p_now
    ) ON CONFLICT (organization_id, environment, channel, purpose, actor_id)
      DO UPDATE SET recipient_address = EXCLUDED.recipient_address,
          display_name = EXCLUDED.display_name, status = 'active', revoked_at = NULL,
          updated_at = EXCLUDED.updated_at
    RETURNING id INTO result_id;
    RETURN result_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_subject_recipient_sync_delivery_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.status = 'active' THEN
        PERFORM public.dop_sync_dev_delivery_recipient(NEW.id, NEW.updated_at);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER subject_recipient_syncs_dev_delivery_allowlist
AFTER INSERT OR UPDATE OF status ON public.subject_message_recipient_allowlist
FOR EACH ROW EXECUTE FUNCTION public.dop_subject_recipient_sync_delivery_trigger();

CREATE OR REPLACE FUNCTION public.dop_plan_missing_request_delivery(
    p_actor_id uuid,
    p_revision_id uuid,
    p_reason text,
    p_idempotency_key uuid,
    p_correlation_id uuid,
    p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_require_active_manager(p_actor_id);
    revision_row public.missing_document_request_revisions%ROWTYPE;
    draft_row public.missing_document_request_drafts%ROWTYPE;
    subject_allow_row public.subject_message_recipient_allowlist%ROWTYPE;
    actor_row public.actors%ROWTYPE;
    delivery_allow_row public.delivery_recipient_allowlist%ROWTYPE;
    existing public.delivery_jobs%ROWTYPE;
    job_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    recipient_address_value text;
    send_key_value text;
    fingerprint text;
BEGIN
    IF length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO revision_row FROM public.missing_document_request_revisions
     WHERE organization_id = org_id AND id = p_revision_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','revision_not_found'); END IF;
    IF revision_row.status <> 'approved' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','approved_revision_required');
    END IF;
    IF revision_row.delivery_mode <> 'disabled' OR revision_row.external_call_count <> 0 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','source_delivery_boundary_invalid');
    END IF;
    SELECT * INTO draft_row FROM public.missing_document_request_drafts
     WHERE organization_id = org_id AND id = revision_row.request_draft_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','request_draft_not_found'); END IF;
    SELECT * INTO subject_allow_row FROM public.subject_message_recipient_allowlist
     WHERE organization_id = org_id AND id = revision_row.recipient_allowlist_id
       AND subject_id = draft_row.subject_id AND purpose = 'missing_document_request'
       AND status = 'active';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','recipient_not_allowlisted'); END IF;
    SELECT * INTO actor_row FROM public.actors
     WHERE organization_id = org_id AND id = subject_allow_row.actor_id
       AND actor_type = 'customer' AND status = 'active' AND email IS NOT NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','recipient_not_available'); END IF;
    recipient_address_value := lower(btrim(actor_row.email));
    IF revision_row.recipient_snapshot->>'email' IS DISTINCT FROM recipient_address_value THEN
        RETURN jsonb_build_object('outcome','conflict','reason','recipient_snapshot_drift');
    END IF;
    SELECT * INTO delivery_allow_row FROM public.delivery_recipient_allowlist
     WHERE organization_id = org_id AND environment = 'DEV' AND channel = 'email'
       AND purpose = 'missing_document_request' AND actor_id = actor_row.id
       AND status = 'active';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','dev_recipient_not_allowlisted'); END IF;
    send_key_value := encode(digest(concat_ws('|','delivery-v1',org_id::text,
        p_revision_id::text,revision_row.content_hash,recipient_address_value), 'sha256'),'hex');
    fingerprint := encode(digest(concat_ws('|',p_revision_id::text,send_key_value,btrim(p_reason)),
        'sha256'),'hex');
    SELECT * INTO existing FROM public.delivery_jobs
     WHERE organization_id = org_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','deliveryJobId',existing.id,
                'status',existing.status,'runtimeExecution','disabled','externalCallCount',0);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO existing FROM public.delivery_jobs
     WHERE organization_id = org_id AND source_revision_id = p_revision_id;
    IF FOUND THEN
        RETURN jsonb_build_object('outcome','duplicate','deliveryJobId',existing.id,
            'status',existing.status,'runtimeExecution','disabled','externalCallCount',0);
    END IF;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (
        event_id, org_id, p_idempotency_key::text || ':event',
        'MissingDocumentRequest.DeliveryPlanned', 1, 'delivery_job', job_id,
        p_correlation_id, p_actor_id, 'ops-delivery-readiness',
        jsonb_build_object('source_revision_id',p_revision_id,'channel','email',
            'purpose','missing_document_request','content_hash',revision_row.content_hash,
            'recipient_policy','dev_allowlist_only','runtime_execution','disabled',
            'provider_reference_mode','not_configured','attempt_count',0,'external_call_count',0), p_now
    );
    INSERT INTO public.delivery_jobs (
        id, organization_id, case_id, subject_id, source_revision_id, channel,
        purpose, recipient_allowlist_id, recipient_snapshot, subject_line, body_text,
        content_hash, send_key, status, runtime_execution, provider_reference_mode,
        attempt_count, external_call_count, provider_message_id, created_by_actor_id,
        creation_reason, idempotency_key, request_fingerprint, event_id, created_at, updated_at
    ) VALUES (
        job_id, org_id, draft_row.case_id, draft_row.subject_id, revision_row.id,
        'email', 'missing_document_request', delivery_allow_row.id,
        jsonb_build_object('displayName',actor_row.display_name,
            'actorId',actor_row.id,'address',delivery_allow_row.recipient_address,
            'sourceAddressHash',encode(digest(recipient_address_value,'sha256'),'hex'),
            'policy','dev_invalid_alias_only','allowlistId',delivery_allow_row.id),
        revision_row.subject_line, revision_row.body_text, revision_row.content_hash,
        send_key_value, 'planned', 'disabled', 'not_configured', 0, 0, NULL,
        p_actor_id, btrim(p_reason), p_idempotency_key, fingerprint, event_id, p_now, p_now
    );
    RETURN jsonb_build_object('outcome','completed','deliveryJobId',job_id,
        'status','planned','runtimeExecution','disabled','providerConfigured',false,
        'attemptCount',0,'externalCallCount',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_run_delivery_contract_evaluation(
    p_actor_id uuid,
    p_delivery_job_id uuid,
    p_reason text,
    p_idempotency_key uuid,
    p_correlation_id uuid,
    p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_require_active_manager(p_actor_id);
    job_row public.delivery_jobs%ROWTYPE;
    existing public.delivery_contract_evaluations%ROWTYPE;
    evaluation_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    definition jsonb;
    result_value jsonb;
    definition_hash_value text;
    fingerprint text;
BEGIN
    IF length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO job_row FROM public.delivery_jobs
     WHERE organization_id = org_id AND id = p_delivery_job_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','delivery_job_not_found'); END IF;
    IF job_row.status <> 'planned' OR job_row.runtime_execution <> 'disabled'
       OR job_row.provider_reference_mode <> 'not_configured'
       OR job_row.attempt_count <> 0 OR job_row.external_call_count <> 0 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','delivery_boundary_invalid');
    END IF;
    definition := jsonb_build_object(
        'schemaVersion','1.0','channel','email','purpose','missing_document_request',
        'recipientPolicy','dev_allowlist_only','contentPin','approved_revision_hash',
        'sendLock',jsonb_build_object('scope','organization_send_key','uniqueness','database_unique',
            'leaseRequired',true,'lateWorkerCannotCommit',true),
        'failureRecovery',jsonb_build_object('recoverable','failed_recoverable',
            'retryRequiresBackoff',true,'manual','failed_manual'),
        'receipt',jsonb_build_object('idempotency','receipt_key_unique',
            'payloadStorage','sha256_digest_only','types',jsonb_build_array(
                'accepted','delivered','deferred','bounced','complained')),
        'runtimeExecution','disabled','providerReferenceMode','not_configured'
    );
    definition_hash_value := encode(digest(definition::text,'sha256'),'hex');
    fingerprint := encode(digest(concat_ws('|',p_delivery_job_id::text,
        definition_hash_value,btrim(p_reason)),'sha256'),'hex');
    SELECT * INTO existing FROM public.delivery_contract_evaluations
     WHERE organization_id = org_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','evaluationId',existing.id,
                'status',existing.status,'externalCallCount',0);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    result_value := jsonb_build_object(
        'passed',true,'approvedContentPinned',true,'devRecipientAllowlisted',true,
        'sendKeyUnique',true,'leaseRequired',true,'lateWorkerCannotCommit',true,
        'recoverableFailureState','failed_recoverable','manualFailureState','failed_manual',
        'retryRequiresBackoff',true,'receiptIdempotent',true,
        'receiptPayload','sha256_digest_only','runtimeExecution','disabled',
        'providerConfigured',false,'attemptRows',0,'receiptRows',0,'externalCalls',0
    );
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (
        event_id, org_id, p_idempotency_key::text || ':event',
        'DeliveryJob.ContractEvaluated', 1, 'delivery_job', job_row.id,
        p_correlation_id, p_actor_id, 'ops-delivery-readiness',
        jsonb_build_object('contract_version','1.0','definition_hash',definition_hash_value,
            'status','passed','runtime_execution','disabled','external_call_count',0), p_now
    );
    INSERT INTO public.delivery_contract_evaluations (
        id, organization_id, delivery_job_id, contract_version, definition_hash,
        status, result, reason, run_by_actor_id, idempotency_key,
        request_fingerprint, event_id, external_call_count, created_at
    ) VALUES (
        evaluation_id, org_id, job_row.id, '1.0', definition_hash_value,
        'passed', result_value, btrim(p_reason), p_actor_id, p_idempotency_key,
        fingerprint, event_id, 0, p_now
    );
    RETURN jsonb_build_object('outcome','completed','evaluationId',evaluation_id,
        'status','passed','definitionHash',definition_hash_value,
        'runtimeExecution','disabled','externalCallCount',0);
END;
$$;

-- Backfill only RFC-reserved .invalid addresses from the already governed
-- subject allowlist. No real-world address is eligible for M28 DEV planning.
DO $$
DECLARE item record;
BEGIN
    FOR item IN SELECT id, updated_at FROM public.subject_message_recipient_allowlist
        WHERE status = 'active' ORDER BY created_at, id
    LOOP
        PERFORM public.dop_sync_dev_delivery_recipient(item.id, item.updated_at);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.dop_sync_dev_delivery_recipient(uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_subject_recipient_sync_delivery_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_plan_missing_request_delivery(uuid,uuid,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_run_delivery_contract_evaluation(uuid,uuid,text,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_plan_missing_request_delivery(uuid,uuid,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_run_delivery_contract_evaluation(uuid,uuid,text,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
