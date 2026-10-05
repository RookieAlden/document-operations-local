BEGIN;

INSERT INTO idempotency_reservations (
    id, organization_id, scope, idempotency_key, status, lease_owner,
    lease_expires_at, attempt_count, created_at, updated_at
) VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
    '00000000-0000-4000-8000-000000000001',
    'submission.receive',
    'verification|atomic-intake-001',
    'processing',
    'verification-worker',
    '2026-08-06T10:05:00Z',
    1,
    '2026-08-06T10:00:00Z',
    '2026-08-06T10:00:00Z'
);

INSERT INTO submissions (
    id, organization_id, case_id, submission_key, source,
    source_submission_id, status, expected_document_count,
    terminal_document_count, raw_payload_reference, received_at,
    created_at, updated_at
) VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-d000-000000005001',
    'verification|atomic-intake-001',
    'api',
    'atomic-intake-001',
    'accepted',
    1,
    0,
    'fixture://atomic-intake-001',
    '2026-08-06T10:00:00Z',
    '2026-08-06T10:00:00Z',
    '2026-08-06T10:00:00Z'
);

INSERT INTO documents (
    id, organization_id, case_id, submission_id, idempotency_key,
    source_file_id, original_filename, declared_mime_type, size_bytes,
    status, created_at, updated_at
) VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-d000-000000005001',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02',
    'verification|atomic-intake-001|file-001',
    'file-001',
    'synthetic-bank-statement.pdf',
    'application/pdf',
    12345,
    'reserved',
    '2026-08-06T10:00:00Z',
    '2026-08-06T10:00:00Z'
);

INSERT INTO workflow_runs (
    id, organization_id, module_id, module_version, environment,
    correlation_id, aggregate_type, aggregate_id, status,
    started_at, completed_at, metrics
) VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee04',
    '00000000-0000-4000-8000-000000000001',
    'receive-submission',
    '1.0.0',
    'DEV',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee05',
    'submission',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02',
    'succeeded',
    '2026-08-06T10:00:00Z',
    '2026-08-06T10:00:00Z',
    '{"document_count":1}'::jsonb
);

INSERT INTO workflow_events (
    id, organization_id, idempotency_key, event_type, event_version,
    aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
) VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee06',
    '00000000-0000-4000-8000-000000000001',
    'verification|submission-accepted|001',
    'Submission.Accepted',
    1,
    'submission',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee05',
    'verification.atomic-intake',
    '{"file_count":1}'::jsonb,
    '2026-08-06T10:00:00Z'
), (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee07',
    '00000000-0000-4000-8000-000000000001',
    'verification|document-queued|001',
    'Document.Queued',
    1,
    'document',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee05',
    'verification.atomic-intake',
    '{"source_file_id":"file-001"}'::jsonb,
    '2026-08-06T10:00:00Z'
);

UPDATE idempotency_reservations
SET status = 'completed',
    lease_owner = NULL,
    lease_expires_at = NULL,
    resource_type = 'submission',
    resource_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02',
    completed_at = '2026-08-06T10:00:00Z',
    updated_at = '2026-08-06T10:00:00Z'
WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01';

DO $$
BEGIN
    BEGIN
        INSERT INTO submissions (
            id, organization_id, case_id, submission_key, source,
            source_submission_id, status, expected_document_count,
            terminal_document_count, received_at
        ) VALUES (
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee08',
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-d000-000000005001',
            'verification|atomic-intake-001',
            'api',
            'atomic-intake-001',
            'accepted',
            1,
            0,
            '2026-08-06T10:00:00Z'
        );
        RAISE EXCEPTION 'idempotency verification failed: duplicate submission was accepted';
    EXCEPTION
        WHEN unique_violation THEN NULL;
    END;
END $$;

SELECT
    (SELECT count(*) FROM submissions WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02') AS submissions,
    (SELECT count(*) FROM documents WHERE submission_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02') AS documents,
    (SELECT count(*) FROM workflow_runs WHERE aggregate_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02') AS runs,
    (SELECT count(*) FROM workflow_events WHERE correlation_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee05') AS events,
    (SELECT count(*) FROM idempotency_reservations WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01' AND status = 'completed') AS completed_reservations;

ROLLBACK;
