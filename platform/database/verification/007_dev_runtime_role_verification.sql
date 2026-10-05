WITH metrics AS (
    SELECT
        (SELECT rolcanlogin
                    AND NOT rolsuper
                    AND NOT rolcreatedb
                    AND NOT rolcreaterole
                    AND NOT rolreplication
                    AND NOT rolbypassrls
           FROM pg_roles
          WHERE rolname = 'dop_app_dev') AS role_attributes_safe,
        EXISTS (
            SELECT 1
              FROM pg_auth_members memberships
              JOIN pg_roles granted_role ON granted_role.oid = memberships.roleid
              JOIN pg_roles member_role ON member_role.oid = memberships.member
             WHERE granted_role.rolname = 'dop_app'
               AND member_role.rolname = 'dop_app_dev'
        ) AS inherits_dop_app,
        (SELECT count(*)
           FROM information_schema.role_table_grants
          WHERE grantee = 'dop_app_dev') AS direct_table_grant_count
)
SELECT role_attributes_safe
       AND inherits_dop_app
       AND direct_table_grant_count = 0 AS verification_passed,
       *
FROM metrics;
