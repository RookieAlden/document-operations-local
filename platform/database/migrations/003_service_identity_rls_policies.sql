BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dop_app') THEN
        CREATE ROLE dop_app NOLOGIN;
    END IF;
END $$;

-- Hosted Supabase administrators cannot explicitly toggle SUPERUSER/BYPASSRLS
-- attributes, even to disable them. CREATE ROLE uses the safe defaults, while
-- this assertion prevents an unsafe pre-existing role from being accepted.
DO $$
DECLARE
    unsafe_role boolean;
BEGIN
    SELECT rolcanlogin
        OR rolsuper
        OR rolcreatedb
        OR rolcreaterole
        OR rolreplication
        OR rolbypassrls
      INTO unsafe_role
      FROM pg_roles
     WHERE rolname = 'dop_app';

    IF unsafe_role IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'dop_app exists with unsafe role attributes';
    END IF;
END $$;

ALTER ROLE dop_app SET row_security = on;

-- Allow the Supabase dashboard administrator to assume the restricted role
-- for RLS verification. This does not grant any privilege to dop_app.
GRANT dop_app TO postgres;

CREATE OR REPLACE FUNCTION public.dop_current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT NULLIF(current_setting('dop.organization_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION public.dop_set_organization_context_by_id(p_organization_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target_id uuid;
    current_id uuid;
BEGIN
    SELECT id INTO target_id
      FROM public.organizations
     WHERE id = p_organization_id
       AND status = 'active';

    IF target_id IS NULL THEN
        RAISE EXCEPTION 'organization is not active or does not exist'
            USING ERRCODE = 'P0002';
    END IF;

    current_id := public.dop_current_organization_id();
    IF current_id IS NOT NULL AND current_id <> target_id THEN
        RAISE EXCEPTION 'organization context cannot change within a transaction'
            USING ERRCODE = '42501';
    END IF;

    PERFORM set_config('dop.organization_id', target_id::text, true);
    RETURN target_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_set_organization_context(p_organization_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target_id uuid;
BEGIN
    SELECT id INTO target_id
      FROM public.organizations
     WHERE organization_key = p_organization_key
       AND status = 'active';

    IF target_id IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN public.dop_set_organization_context_by_id(target_id);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_current_organization_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_set_organization_context_by_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_set_organization_context(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_current_organization_id() TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_set_organization_context_by_id(uuid) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_set_organization_context(text) TO dop_app;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM dop_app;
GRANT USAGE ON SCHEMA public TO dop_app;

GRANT SELECT ON TABLE
    organizations,
    actors,
    subjects,
    workflow_templates,
    workflow_template_versions,
    document_types,
    requirement_sets,
    requirement_set_versions,
    requirements,
    prompt_versions,
    cases,
    connector_configs
TO dop_app;

GRANT SELECT, INSERT, UPDATE ON TABLE
    submissions,
    documents,
    classification_attempts,
    issues,
    tasks,
    approvals,
    notifications,
    idempotency_reservations,
    workflow_runs,
    workflow_errors,
    workflow_events
TO dop_app;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'organizations',
        'actors',
        'subjects',
        'workflow_templates',
        'workflow_template_versions',
        'document_types',
        'requirement_sets',
        'requirement_set_versions',
        'requirements',
        'prompt_versions',
        'cases',
        'submissions',
        'documents',
        'classification_attempts',
        'issues',
        'tasks',
        'approvals',
        'notifications',
        'idempotency_reservations',
        'workflow_runs',
        'workflow_errors',
        'workflow_events',
        'connector_configs'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS dop_tenant_isolation ON public.%I', table_name);
        IF table_name = 'organizations' THEN
            EXECUTE format(
                'CREATE POLICY dop_tenant_isolation ON public.%I FOR ALL TO dop_app USING (id = public.dop_current_organization_id()) WITH CHECK (id = public.dop_current_organization_id())',
                table_name
            );
        ELSE
            EXECUTE format(
                'CREATE POLICY dop_tenant_isolation ON public.%I FOR ALL TO dop_app USING (organization_id = public.dop_current_organization_id()) WITH CHECK (organization_id = public.dop_current_organization_id())',
                table_name
            );
        END IF;
    END LOOP;
END $$;

COMMIT;
