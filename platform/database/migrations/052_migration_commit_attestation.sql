BEGIN;

-- The migration ledger is append-only. Migration 051 was applied with the
-- correct file checksum but an operator-supplied Git SHA whose suffix did not
-- resolve to the commit that contains the migration. Preserve that row and add
-- an equally immutable correction instead of rewriting history.
CREATE TABLE public.dop_schema_migration_commit_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_version text NOT NULL REFERENCES public.dop_schema_migration_ledger(version),
  recorded_git_commit text NOT NULL CHECK (recorded_git_commit ~ '^[0-9a-f]{40}$'),
  attested_git_commit text NOT NULL CHECK (attested_git_commit ~ '^[0-9a-f]{40}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,119}$'),
  evidence_note text NOT NULL CHECK (char_length(evidence_note) BETWEEN 12 AND 500),
  attested_by text NOT NULL,
  attested_at timestamptz NOT NULL,
  UNIQUE (migration_version,recorded_git_commit,attested_git_commit),
  CHECK (recorded_git_commit<>attested_git_commit)
);

CREATE FUNCTION public.dop_reject_schema_migration_commit_attestation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'dop_schema_migration_commit_attestations is append-only' USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER dop_schema_migration_commit_attestations_append_only
BEFORE UPDATE OR DELETE ON public.dop_schema_migration_commit_attestations
FOR EACH ROW EXECUTE FUNCTION public.dop_reject_schema_migration_commit_attestation_mutation();

ALTER TABLE public.dop_schema_migration_commit_attestations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dop_schema_migration_commit_attestations FROM PUBLIC, dop_app;
REVOKE ALL ON FUNCTION public.dop_reject_schema_migration_commit_attestation_mutation() FROM PUBLIC;

INSERT INTO public.dop_schema_migration_commit_attestations(
  migration_version,recorded_git_commit,attested_git_commit,reason_code,
  evidence_note,attested_by,attested_at
)
SELECT ledger.version,ledger.git_commit,
  '7ddd95d4f7cd2bb66b38f3dd015659a94c6aa015',
  'operator_supplied_commit_suffix_incorrect',
  'Migration 051 checksum and transaction were valid; this append-only attestation records the actual Git commit containing the applied file.',
  current_user,'2026-08-18T02:30:00Z'::timestamptz
FROM public.dop_schema_migration_ledger ledger
WHERE ledger.version='051'
  AND ledger.git_commit='7ddd95dc3d87b2b996f0f9b16066b017d326e7d2';

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM public.dop_schema_migration_commit_attestations
     WHERE migration_version='051'
       AND recorded_git_commit='7ddd95dc3d87b2b996f0f9b16066b017d326e7d2'
       AND attested_git_commit='7ddd95d4f7cd2bb66b38f3dd015659a94c6aa015'
  ) THEN RAISE EXCEPTION 'migration 051 commit attestation was not recorded'; END IF;
END $$;

COMMENT ON TABLE public.dop_schema_migration_commit_attestations IS
'Append-only corrections to operator-supplied migration ledger commit metadata. Original ledger rows remain unchanged.';

COMMIT;
