-- Run with the UAT runtime connection, never the migration/admin connection.
BEGIN;

DO $$
DECLARE
    visible_without_context integer;
    visible_uat_organizations integer;
    destructive_grants integer;
    direct_ops_session_grants integer;
    direct_migration_ledger_grants integer;
    public_tables_without_rls integer;
    rls_tables_without_policy integer;
BEGIN
    IF current_user <> 'dop_app_uat' THEN
        RAISE EXCEPTION 'verification must run as dop_app_uat';
    END IF;

    SELECT count(*) INTO visible_without_context FROM organizations;
    IF visible_without_context <> 0 THEN
        RAISE EXCEPTION 'UAT runtime role did not fail closed without tenant context';
    END IF;

    PERFORM dop_set_organization_context('uat-accounting-firm');
    SELECT count(*) INTO visible_uat_organizations FROM organizations;
    IF visible_uat_organizations <> 1 THEN
        RAISE EXCEPTION 'UAT tenant isolation failed';
    END IF;

    SELECT count(*) INTO destructive_grants
      FROM information_schema.role_table_grants
     WHERE grantee IN ('dop_app','dop_app_uat')
       AND privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
    IF destructive_grants <> 0 THEN
        RAISE EXCEPTION 'dop_app has destructive table grants';
    END IF;

    SELECT count(*) INTO direct_ops_session_grants
      FROM information_schema.role_table_grants
     WHERE grantee IN ('dop_app','dop_app_uat')
       AND table_schema = 'public'
       AND table_name = 'ops_sessions';
    IF direct_ops_session_grants <> 0 THEN
        RAISE EXCEPTION 'ops_sessions must remain function-only for dop_app';
    END IF;

    SELECT count(*) INTO direct_migration_ledger_grants
      FROM information_schema.role_table_grants
     WHERE grantee IN ('dop_app','dop_app_uat')
       AND table_schema = 'public'
       AND table_name = 'dop_schema_migration_ledger';
    IF direct_migration_ledger_grants <> 0 THEN
        RAISE EXCEPTION 'migration ledger must remain admin-only';
    END IF;

    SELECT count(*) INTO public_tables_without_rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND NOT c.relrowsecurity;
    IF public_tables_without_rls <> 0 THEN
        RAISE EXCEPTION 'one or more public tables do not have RLS enabled';
    END IF;

    SELECT count(*) INTO rls_tables_without_policy
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relrowsecurity
       -- These four ledgers are deliberately admin/function-only. RLS is
       -- enabled as a fail-closed backstop, while the runtime role has no
       -- table grant and therefore no tenant policy is intentionally present.
       AND c.relname NOT IN (
           'ops_sessions',
           'dop_schema_migration_ledger',
           'dop_schema_migration_commit_attestations',
           'client_portal_access_attempts'
       )
       AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);
    IF rls_tables_without_policy <> 0 THEN
        RAISE EXCEPTION 'one or more UAT RLS tables have no policy';
    END IF;
END $$;

SELECT
    current_user AS runtime_role,
    (SELECT count(*) FROM organizations) AS visible_organizations,
    (SELECT count(*) FROM subjects) AS visible_subjects,
    (SELECT count(*) FROM cases) AS visible_cases,
    (SELECT count(*)
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r') AS public_table_count,
    (SELECT count(*)
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity) AS rls_table_count,
    (SELECT count(*)
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
        AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)) AS rls_tables_with_policy;

ROLLBACK;
