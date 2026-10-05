BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'document_review_decisions'
    ) THEN
        RAISE EXCEPTION 'document_review_decisions is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'document_review_decisions' AND c.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'document_review_decisions RLS is disabled';
    END IF;

    IF NOT has_table_privilege('dop_app', 'public.document_review_decisions', 'SELECT')
       OR NOT has_table_privilege('dop_app', 'public.document_review_decisions', 'INSERT')
       OR has_table_privilege('dop_app', 'public.document_review_decisions', 'UPDATE')
       OR has_table_privilege('dop_app', 'public.document_review_decisions', 'DELETE') THEN
        RAISE EXCEPTION 'document_review_decisions privileges are not append-only';
    END IF;
END $$;

SELECT true AS verification_passed,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.document_review_decisions'::regclass) AS rls_enabled,
       has_table_privilege('dop_app', 'public.document_review_decisions', 'SELECT') AS can_select,
       has_table_privilege('dop_app', 'public.document_review_decisions', 'INSERT') AS can_insert,
       has_table_privilege('dop_app', 'public.document_review_decisions', 'UPDATE') AS can_update,
       has_table_privilege('dop_app', 'public.document_review_decisions', 'DELETE') AS can_delete;

ROLLBACK;
