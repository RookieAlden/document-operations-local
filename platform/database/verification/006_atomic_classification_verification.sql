-- Transactional DEV smoke test for the persistence half of classify-document.
-- Every row is rolled back after verification.
BEGIN;

SET LOCAL ROLE dop_app;
SELECT dop_set_organization_context('dev-accounting-firm') AS bound_organization_id;

INSERT INTO submissions (
    id, organization_id, case_id, submission_key, source,
    source_submission_id, status, expected_document_count,
    terminal_document_count, received_at
) VALUES (
    '00000000-0000-4000-e000-000000009001',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-d000-000000005001',
    'verification|classify-document|submission',
    'synthetic_verification',
    'classification-smoke-001',
    'processing',
    1,
    0,
    now()
);

INSERT INTO documents (
    id, organization_id, case_id, submission_id, idempotency_key,
    source_file_id, original_filename, declared_mime_type,
    detected_mime_type, size_bytes, content_hash_sha256,
    incoming_storage_ref, status
) VALUES (
    '00000000-0000-4000-e000-000000009002',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-d000-000000005001',
    '00000000-0000-4000-e000-000000009001',
    'verification|classify-document|document',
    'classification-smoke-file-001',
    'synthetic-bank-statement-july-2026.pdf',
    'application/pdf',
    'application/pdf',
    1024,
    repeat('a', 64),
    'incoming://verification/synthetic-bank-statement-july-2026.pdf',
    'incoming_saved'
);

INSERT INTO idempotency_reservations (
    id, organization_id, scope, idempotency_key, status,
    lease_owner, lease_expires_at, attempt_count, created_at, updated_at
) VALUES (
    '00000000-0000-4000-e000-000000009003',
    '00000000-0000-4000-8000-000000000001',
    'document.classify',
    'document.classify|00000000-0000-4000-e000-000000009002|00000000-0000-4000-b100-000000003101',
    'processing',
    'verification-worker',
    now() + interval '5 minutes',
    1,
    now(),
    now()
);

INSERT INTO classification_attempts (
    id, organization_id, document_id, attempt_number, prompt_version_id,
    provider, model, status, predicted_document_type_code, confidence,
    result, raw_response_reference, started_at, completed_at
) VALUES (
    '00000000-0000-4000-e000-000000009004',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-e000-000000009002',
    1,
    '00000000-0000-4000-b100-000000003101',
    'openai',
    'gpt-5.6-sol',
    'succeeded',
    'bank_statement',
    0.9900,
    '{"predicted_document_type_code":"bank_statement","confidence":0.99,"quality_flags":[],"conflict_flags":[],"safe_reason":"Synthetic statement matched the expected client and period."}'::jsonb,
    NULL,
    now(),
    now()
);

UPDATE documents
   SET accepted_document_type_id = '00000000-0000-4000-b000-000000003001',
       status = 'classified',
       classification_summary = '{"provider":"openai","model":"gpt-5.6-sol","predicted_document_type_code":"bank_statement","confidence":0.99,"quality_flags":[],"conflict_flags":[]}'::jsonb,
       review_reason = NULL,
       updated_at = now()
 WHERE id = '00000000-0000-4000-e000-000000009002';

INSERT INTO workflow_runs (
    id, organization_id, module_id, module_version, environment,
    correlation_id, aggregate_type, aggregate_id, status,
    started_at, completed_at, metrics
) VALUES (
    '00000000-0000-4000-e000-000000009005',
    '00000000-0000-4000-8000-000000000001',
    'classify-document',
    '1.0.0',
    'DEV',
    '00000000-0000-4000-e000-000000009007',
    'document',
    '00000000-0000-4000-e000-000000009002',
    'succeeded',
    now(),
    now(),
    '{"input_tokens":100,"output_tokens":20,"review_required":false}'::jsonb
);

INSERT INTO workflow_events (
    id, organization_id, idempotency_key, event_type, event_version,
    aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
) VALUES (
    '00000000-0000-4000-e000-000000009006',
    '00000000-0000-4000-8000-000000000001',
    'document-classified|00000000-0000-4000-e000-000000009002|00000000-0000-4000-b100-000000003101',
    'Document.Classified',
    1,
    'document',
    '00000000-0000-4000-e000-000000009002',
    '00000000-0000-4000-e000-000000009007',
    'dop.core.classify-document.v1',
    '{"classification_attempt_id":"00000000-0000-4000-e000-000000009004","predicted_document_type_code":"bank_statement","confidence":0.99,"status":"classified"}'::jsonb,
    now()
);

UPDATE idempotency_reservations
   SET status = 'completed',
       resource_type = 'classification_attempt',
       resource_id = '00000000-0000-4000-e000-000000009004',
       lease_owner = NULL,
       lease_expires_at = NULL,
       completed_at = now(),
       updated_at = now()
 WHERE id = '00000000-0000-4000-e000-000000009003';

WITH metrics AS (
    SELECT
        (SELECT status FROM documents
          WHERE id = '00000000-0000-4000-e000-000000009002') AS document_status,
        (SELECT dt.code
           FROM documents d
           JOIN document_types dt ON dt.id = d.accepted_document_type_id
          WHERE d.id = '00000000-0000-4000-e000-000000009002') AS accepted_document_type_code,
        (SELECT count(*) FROM classification_attempts
          WHERE document_id = '00000000-0000-4000-e000-000000009002') AS classification_attempt_count,
        (SELECT count(*) FROM classification_attempts
          WHERE document_id = '00000000-0000-4000-e000-000000009002'
            AND raw_response_reference IS NULL) AS attempts_without_raw_response,
        (SELECT count(*) FROM workflow_runs
          WHERE id = '00000000-0000-4000-e000-000000009005'
            AND status = 'succeeded') AS succeeded_workflow_run_count,
        (SELECT count(*) FROM workflow_events
          WHERE id = '00000000-0000-4000-e000-000000009006'
            AND event_type = 'Document.Classified') AS classified_event_count,
        (SELECT count(*) FROM idempotency_reservations
          WHERE id = '00000000-0000-4000-e000-000000009003'
            AND status = 'completed'
            AND resource_id = '00000000-0000-4000-e000-000000009004') AS completed_reservation_count
)
SELECT document_status = 'classified'
       AND accepted_document_type_code = 'bank_statement'
       AND classification_attempt_count = 1
       AND attempts_without_raw_response = 1
       AND succeeded_workflow_run_count = 1
       AND classified_event_count = 1
       AND completed_reservation_count = 1 AS verification_passed,
       *
FROM metrics;

ROLLBACK;
