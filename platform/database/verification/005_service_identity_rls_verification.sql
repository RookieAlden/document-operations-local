BEGIN;

INSERT INTO organizations (id, organization_key, display_name, status)
VALUES (
    '00000000-0000-4000-8000-000000009999',
    'tenant-rls-hidden-test',
    'Hidden Tenant RLS Test',
    'active'
);

SET LOCAL ROLE dop_app;
SELECT dop_set_organization_context('dev-accounting-firm') AS bound_organization_id;

WITH metrics AS (
    SELECT
        (SELECT NOT rolcanlogin
                    AND NOT rolsuper
                    AND NOT rolcreatedb
                    AND NOT rolcreaterole
                    AND NOT rolreplication
                    AND NOT rolbypassrls
           FROM pg_roles
          WHERE rolname = 'dop_app') AS role_attributes_safe,
        (SELECT count(*)
           FROM pg_policies
          WHERE schemaname = 'public'
            AND policyname = 'dop_tenant_isolation'
            AND 'dop_app' = ANY(roles)) AS public_policy_count,
        (SELECT count(DISTINCT tablename)
           FROM pg_policies
          WHERE schemaname = 'public'
            AND policyname = 'dop_tenant_isolation'
            AND 'dop_app' = ANY(roles)) AS protected_table_count,
        (SELECT count(*)
           FROM information_schema.role_table_grants
          WHERE grantee = 'dop_app'
            AND privilege_type = 'SELECT') AS select_grant_count,
        (SELECT count(*)
           FROM information_schema.role_table_grants
          WHERE grantee = 'dop_app'
            AND privilege_type = 'INSERT') AS insert_grant_count,
        (SELECT count(*)
           FROM information_schema.role_table_grants
          WHERE grantee = 'dop_app'
            AND privilege_type = 'UPDATE') AS update_grant_count,
        (SELECT count(*)
           FROM information_schema.role_table_grants
          WHERE grantee = 'dop_app'
            AND privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')) AS destructive_grant_count,
        (SELECT count(*) FROM organizations) AS visible_organizations,
        (SELECT count(*) FROM subjects) AS visible_subjects,
        (SELECT count(*) FROM cases) AS visible_cases,
        (SELECT count(*)
           FROM organizations
          WHERE organization_key = 'tenant-rls-hidden-test') AS hidden_tenant_visible_count
)
SELECT role_attributes_safe
       AND public_policy_count = 23
       AND protected_table_count = 23
       AND select_grant_count = 23
       AND insert_grant_count = 11
       AND update_grant_count = 11
       AND destructive_grant_count = 0
       AND visible_organizations = 1
       AND visible_subjects = 5
       AND visible_cases = 4
       AND hidden_tenant_visible_count = 0 AS verification_passed,
       *
FROM metrics;

ROLLBACK;
