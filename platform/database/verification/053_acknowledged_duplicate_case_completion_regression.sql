BEGIN;

DO $$
DECLARE
    function_definition text;
BEGIN
    IF to_regclass('public.case_completeness_acknowledgements') IS NULL THEN
        RAISE EXCEPTION 'case completeness acknowledgement ledger is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'case_completeness_acknowledgements'
          AND c.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'case completeness acknowledgement ledger must have RLS enabled';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.case_completeness_acknowledgements'::regclass
           AND tgname = 'case_completeness_acknowledgements_immutable'
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'case completeness acknowledgement immutability trigger is missing';
    END IF;
    SELECT pg_get_functiondef(
        'public.dop_acknowledge_resolved_duplicate_case(uuid,uuid,timestamptz)'::regprocedure
    ) INTO function_definition;
    IF function_definition NOT LIKE '%other_completeness_blockers%'
       OR function_definition NOT LIKE '%open_issues_remaining%'
       OR function_definition NOT LIKE '%Case.CompletenessDuplicateAcknowledged%'
       OR function_definition NOT LIKE '%operator_resolved_all_duplicate_issues%' THEN
        RAISE EXCEPTION 'duplicate acknowledgement safety gates are incomplete';
    END IF;
    IF has_table_privilege('dop_app','public.case_completeness_acknowledgements','INSERT')
       OR has_table_privilege('dop_app','public.case_completeness_acknowledgements','UPDATE')
       OR has_table_privilege('dop_app','public.case_completeness_acknowledgements','DELETE') THEN
        RAISE EXCEPTION 'dop_app must not mutate acknowledgement evidence directly';
    END IF;
    IF NOT has_function_privilege(
        'dop_app',
        'public.dop_acknowledge_resolved_duplicate_case(uuid,uuid,timestamptz)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'dop_app cannot invoke the guarded acknowledgement function';
    END IF;
END;
$$;

ROLLBACK;
