-- LOCAL BOOTSTRAP ONLY. Based on migration 032; cloud migrations remain unchanged.
-- Preserves its transaction/idempotency/events and only changes the storage contract.
BEGIN;

-- M36 exposes a synthetic-only operator upload path without granting the
-- browser Storage credentials. The Preservation service stores the bytes
-- first; this function records the already-preserved original and queues the
-- existing classifier. The case/content hash is the durable replay key.
CREATE OR REPLACE FUNCTION public.dop_accept_stored_ops_upload(
    p_actor_id uuid,
    p_case_id uuid,
    p_document_id uuid,
    p_submission_id uuid,
    p_filename text,
    p_mime_type text,
    p_size_bytes bigint,
    p_sha256 text,
    p_storage_reference text,
    p_idempotency_key text,
    p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    organization_id_value uuid := public.dop_current_organization_id();
    case_row public.cases%ROWTYPE;
    reservation_row public.idempotency_reservations%ROWTYPE;
    existing_document record;
    correlation_id_value uuid := gen_random_uuid();
    workflow_run_id_value uuid := gen_random_uuid();
    submission_event_id_value uuid := gen_random_uuid();
    document_event_id_value uuid := gen_random_uuid();
BEGIN
    IF organization_id_value IS NULL THEN
        RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.actors
         WHERE organization_id = organization_id_value AND id = p_actor_id
           AND actor_type IN ('staff','manager','admin') AND status = 'active'
    ) THEN
        RAISE EXCEPTION 'active operator required' USING ERRCODE = '42501';
    END IF;
    IF p_mime_type NOT IN ('application/pdf','image/jpeg','image/png')
       OR p_size_bytes < 1 OR p_size_bytes > 20971520
       OR p_sha256 !~ '^[0-9a-f]{64}$'
       OR length(p_filename) NOT BETWEEN 1 AND 180
       OR position('/' in p_filename) > 0
       OR position(chr(92) in p_filename) > 0
       OR p_filename ~ '[[:cntrl:]]'
       OR p_storage_reference !~ '^local://[0-9a-f-]{36}-[0-9a-f]{64}\.(pdf|png|jpg)$'
       OR p_storage_reference NOT LIKE 'local://' || p_document_id::text || '-' || p_sha256 || '.%'
       OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=organization_id_value
           AND settings->>'local_persistence_mode'='stage1')
       OR length(p_idempotency_key) < 20 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;

    SELECT * INTO case_row
      FROM public.cases
     WHERE organization_id = organization_id_value AND id = p_case_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('outcome','not_found','reason','case_not_found');
    END IF;
    IF case_row.status IN ('completed','cancelled') THEN
        RETURN jsonb_build_object('outcome','conflict','reason','case_closed');
    END IF;

    SELECT * INTO reservation_row
      FROM public.idempotency_reservations
     WHERE organization_id = organization_id_value
       AND scope = 'ops.document_upload'
       AND idempotency_key = p_idempotency_key
     FOR UPDATE;
    IF FOUND THEN
        SELECT d.id AS document_id, d.submission_id
          INTO existing_document
          FROM public.documents d
         WHERE d.organization_id = organization_id_value
           AND d.id = reservation_row.resource_id;
        RETURN jsonb_build_object(
            'outcome','duplicate', 'caseId',p_case_id,
            'documentId',existing_document.document_id,
            'submissionId',existing_document.submission_id
        );
    END IF;

    INSERT INTO public.idempotency_reservations (
        organization_id, scope, idempotency_key, status, attempt_count,
        resource_type, resource_id, created_at, updated_at
    ) VALUES (
        organization_id_value, 'ops.document_upload', p_idempotency_key,
        'reserved', 1, 'document', p_document_id, p_now, p_now
    );

    INSERT INTO public.submissions (
        id, organization_id, case_id, submission_key, source,
        source_submission_id, status, expected_document_count,
        terminal_document_count, received_at, created_at, updated_at
    ) VALUES (
        p_submission_id, organization_id_value, p_case_id,
        p_idempotency_key, 'internal_upload', p_idempotency_key,
        'processing', 1, 0, p_now, p_now, p_now
    );

    INSERT INTO public.documents (
        id, organization_id, case_id, submission_id, idempotency_key,
        source_file_id, original_filename, declared_mime_type,
        detected_mime_type, size_bytes, content_hash_sha256,
        incoming_storage_ref, status, created_at, updated_at
    ) VALUES (
        p_document_id, organization_id_value, p_case_id, p_submission_id,
        p_idempotency_key, p_sha256, p_filename, p_mime_type,
        p_mime_type, p_size_bytes, p_sha256, p_storage_reference,
        'incoming_saved', p_now, p_now
    );

    UPDATE public.cases
       SET status = 'in_progress', updated_at = p_now
     WHERE id = p_case_id AND status NOT IN ('completed','cancelled');

    INSERT INTO public.workflow_runs (
        id, organization_id, module_id, module_version, environment,
        correlation_id, aggregate_type, aggregate_id, status,
        output_reference, started_at, completed_at, metrics
    ) VALUES (
        workflow_run_id_value, organization_id_value,
        'ops-document-upload','1.0.0','DEV', correlation_id_value,
        'document',p_document_id,'succeeded',p_storage_reference,p_now,p_now,
        jsonb_build_object('size_bytes',p_size_bytes,'mime_type',p_mime_type)
    );

    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id,
        producer, payload, occurred_at
    ) VALUES (
        submission_event_id_value, organization_id_value,
        'ops-submission-accepted|' || p_submission_id::text,
        'Submission.Accepted',1,'submission',p_submission_id,correlation_id_value,
        p_actor_id,'dop.local.synthetic-upload.v1',
        jsonb_build_object('case_id',p_case_id,'file_count',1,'source_type','internal_upload'),p_now
    );
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, causation_id, actor_id,
        producer, payload, occurred_at
    ) VALUES (
        document_event_id_value, organization_id_value,
        'ops-document-stored|' || p_document_id::text,
        'Document.Stored',1,'document',p_document_id,correlation_id_value,
        submission_event_id_value,p_actor_id,'dop.local.synthetic-upload.v1',
        jsonb_build_object('case_id',p_case_id,'mime_type',p_mime_type,
          'size_bytes',p_size_bytes,'content_hash_sha256',p_sha256),p_now
    );

    UPDATE public.idempotency_reservations
       SET status='completed', resource_type='document', resource_id=p_document_id,
           completed_at=p_now, updated_at=p_now
     WHERE organization_id=organization_id_value
       AND scope='ops.document_upload' AND idempotency_key=p_idempotency_key;

    RETURN jsonb_build_object(
        'outcome','completed','caseId',p_case_id,'documentId',p_document_id,
        'submissionId',p_submission_id,'documentStatus','incoming_saved'
    );
END;
$$;


COMMIT;
