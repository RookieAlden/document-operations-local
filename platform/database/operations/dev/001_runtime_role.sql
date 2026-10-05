-- DEV-only runtime login. No password is embedded in SQL or source control.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dop_app_dev') THEN
        CREATE ROLE dop_app_dev LOGIN;
    END IF;
END $$;

DO $$
DECLARE
    role_is_safe boolean;
BEGIN
    SELECT rolcanlogin
        AND NOT rolsuper
        AND NOT rolcreatedb
        AND NOT rolcreaterole
        AND NOT rolreplication
        AND NOT rolbypassrls
      INTO role_is_safe
      FROM pg_roles
     WHERE rolname = 'dop_app_dev';

    IF role_is_safe IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'dop_app_dev is missing or has unsafe role attributes';
    END IF;
END $$;

ALTER ROLE dop_app_dev SET row_security = on;
GRANT dop_app TO dop_app_dev;

COMMIT;
