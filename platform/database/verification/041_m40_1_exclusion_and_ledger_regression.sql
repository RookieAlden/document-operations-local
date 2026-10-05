BEGIN;

DO $$
DECLARE
    ledger_rows integer;
    bad_rows integer;
    direct_runtime_grants integer;
    ledger_policies integer;
    ledger_mutation_triggers integer;
    completeness_definition text;
BEGIN
    SELECT count(*) INTO ledger_rows FROM public.dop_schema_migration_ledger;
    IF ledger_rows < 37 THEN
        RAISE EXCEPTION 'migration ledger is incomplete: % rows', ledger_rows;
    END IF;

    SELECT count(*) INTO bad_rows
      FROM public.dop_schema_migration_ledger
     WHERE version !~ '^[0-9]{3}$'
        OR filename !~ '^[0-9]{3}_[A-Za-z0-9._-]+\.sql$'
        OR sha256 !~ '^[0-9a-f]{64}$'
        OR git_commit !~ '^[0-9a-f]{40}$';
    IF bad_rows <> 0 THEN RAISE EXCEPTION 'invalid migration ledger evidence'; END IF;

    SELECT count(*) INTO direct_runtime_grants
      FROM information_schema.role_table_grants
     WHERE grantee IN ('dop_app','dop_app_uat')
       AND table_schema='public' AND table_name='dop_schema_migration_ledger';
    IF direct_runtime_grants <> 0 THEN RAISE EXCEPTION 'runtime role can read or write migration ledger'; END IF;

    SELECT count(*) INTO ledger_policies
      FROM pg_policy
     WHERE polrelid='public.dop_schema_migration_ledger'::regclass;
    IF ledger_policies <> 0 THEN RAISE EXCEPTION 'admin-only migration ledger must not have runtime policy'; END IF;

    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.dop_schema_migration_ledger'::regclass) THEN
        RAISE EXCEPTION 'migration ledger RLS is not enabled';
    END IF;

    SELECT count(*) INTO ledger_mutation_triggers
      FROM pg_trigger
     WHERE tgrelid='public.dop_schema_migration_ledger'::regclass
       AND tgname='dop_schema_migration_ledger_append_only'
       AND NOT tgisinternal;
    IF ledger_mutation_triggers <> 1 THEN
        RAISE EXCEPTION 'migration ledger append-only trigger is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid='public.document_review_decisions'::regclass
           AND conname='document_review_decisions_exclusion_reason_check'
    ) THEN RAISE EXCEPTION 'governed exclusion reason constraint is missing'; END IF;

    completeness_definition := pg_get_functiondef(
        'public.dop_recompute_submission_completeness(uuid,timestamptz)'::regprocedure
    );
    IF position('document_excluded_wrong_subject' IN completeness_definition)=0
       OR position('document_excluded_wrong_period' IN completeness_definition)=0
       OR position('document_excluded_irrelevant_or_unknown' IN completeness_definition)=0 THEN
        RAISE EXCEPTION 'completeness evidence does not preserve governed exclusion reasons';
    END IF;
END $$;

SELECT version, filename, sha256, execution_mode, git_commit, applied_at
  FROM public.dop_schema_migration_ledger
 ORDER BY version;

ROLLBACK;
