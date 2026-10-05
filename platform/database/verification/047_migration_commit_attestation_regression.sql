BEGIN;

DO $$
DECLARE
  mutation_grants integer;
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM public.dop_schema_migration_commit_attestations attestation
    JOIN public.dop_schema_migration_ledger ledger
      ON ledger.version=attestation.migration_version
    WHERE ledger.version='051'
      AND ledger.git_commit=attestation.recorded_git_commit
      AND attestation.attested_git_commit='7ddd95d4f7cd2bb66b38f3dd015659a94c6aa015'
      AND attestation.reason_code='operator_supplied_commit_suffix_incorrect'
  ) THEN RAISE EXCEPTION 'migration 051 commit correction chain is incomplete'; END IF;

  BEGIN
    UPDATE public.dop_schema_migration_commit_attestations
       SET evidence_note='tampered attestation'
     WHERE migration_version='051';
    RAISE EXCEPTION 'migration commit attestation unexpectedly updated';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  SELECT count(*) INTO mutation_grants
    FROM information_schema.role_table_grants
   WHERE grantee='dop_app' AND table_schema='public'
     AND table_name='dop_schema_migration_commit_attestations'
     AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE');
  IF mutation_grants<>0 THEN
    RAISE EXCEPTION 'runtime role received migration attestation table privileges';
  END IF;
END $$;

ROLLBACK;
