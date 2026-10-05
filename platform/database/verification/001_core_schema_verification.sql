SELECT
    count(*) AS public_tables,
    count(*) FILTER (WHERE rowsecurity) AS rls_enabled_tables,
    bool_and(rowsecurity) AS all_rls_enabled
FROM pg_tables
WHERE schemaname = 'public';

SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND NOT rowsecurity
ORDER BY tablename;
