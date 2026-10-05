BEGIN;

INSERT INTO organizations (
    id, organization_key, display_name, status, default_timezone, settings
) VALUES (
    'ffffffff-ffff-4fff-8fff-fffffffffff1',
    'tenant-isolation-test',
    'Temporary Tenant Isolation Test',
    'active',
    'Pacific/Auckland',
    '{"temporary":true}'::jsonb
);

INSERT INTO actors (
    id, organization_id, external_subject_id, actor_type, display_name
) VALUES (
    'ffffffff-ffff-4fff-8fff-fffffffffff2',
    'ffffffff-ffff-4fff-8fff-fffffffffff1',
    'temporary-cross-tenant-actor',
    'customer',
    'Temporary Cross Tenant Actor'
);

INSERT INTO subjects (
    id, organization_id, subject_key, subject_type, display_name, status
) VALUES (
    'ffffffff-ffff-4fff-8fff-fffffffffff3',
    'ffffffff-ffff-4fff-8fff-fffffffffff1',
    'temporary-cross-tenant-subject',
    'test_subject',
    'Temporary Cross Tenant Subject',
    'active'
);

INSERT INTO document_types (
    id, organization_id, code, display_name, allowed_mime_types
) VALUES (
    'ffffffff-ffff-4fff-8fff-fffffffffff4',
    'ffffffff-ffff-4fff-8fff-fffffffffff1',
    'temporary_cross_tenant_type',
    'Temporary Cross Tenant Type',
    ARRAY['application/pdf']
);

DO $$
BEGIN
    BEGIN
        INSERT INTO subjects (
            id, organization_id, subject_key, subject_type, display_name,
            status, primary_contact_actor_id
        ) VALUES (
            'ffffffff-ffff-4fff-8fff-ffffffffffe1',
            '00000000-0000-4000-8000-000000000001',
            'must-fail-cross-tenant-contact',
            'test_subject',
            'Must Fail Cross Tenant Contact',
            'active',
            'ffffffff-ffff-4fff-8fff-fffffffffff2'
        );
        RAISE EXCEPTION 'tenant isolation failed: cross-tenant primary contact was accepted';
    EXCEPTION
        WHEN foreign_key_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO cases (
            id, organization_id, case_key, subject_id,
            workflow_template_version_id, requirement_set_version_id,
            timezone, status, config_snapshot
        ) VALUES (
            'ffffffff-ffff-4fff-8fff-ffffffffffe2',
            '00000000-0000-4000-8000-000000000001',
            'must-fail-cross-tenant-case',
            'ffffffff-ffff-4fff-8fff-fffffffffff3',
            '00000000-0000-4000-a100-000000002101',
            '00000000-0000-4000-c100-000000004101',
            'Pacific/Auckland',
            'not_started',
            '{"source":"tenant_isolation_verification"}'::jsonb
        );
        RAISE EXCEPTION 'tenant isolation failed: cross-tenant case subject was accepted';
    EXCEPTION
        WHEN foreign_key_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO requirements (
            id, organization_id, requirement_set_version_id,
            requirement_code, document_type_id, minimum_count
        ) VALUES (
            'ffffffff-ffff-4fff-8fff-ffffffffffe3',
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-c100-000000004101',
            'must-fail-cross-tenant-document-type',
            'ffffffff-ffff-4fff-8fff-fffffffffff4',
            1
        );
        RAISE EXCEPTION 'tenant isolation failed: cross-tenant document type was accepted';
    EXCEPTION
        WHEN foreign_key_violation THEN NULL;
    END;
END $$;

SELECT
    23 AS expected_rls_tables,
    count(*) FILTER (WHERE rowsecurity) AS actual_rls_tables,
    (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS explicit_policy_count,
    bool_and(rowsecurity) AS all_public_tables_rls_enabled
FROM pg_tables
WHERE schemaname = 'public';

ROLLBACK;
