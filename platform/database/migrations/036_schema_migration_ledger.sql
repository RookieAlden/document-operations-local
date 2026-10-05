BEGIN;

-- Admin-only, append-only evidence for the exact migration file bytes applied
-- to an environment. Runtime roles deliberately receive no table privileges.
CREATE TABLE public.dop_schema_migration_ledger (
    version text PRIMARY KEY CHECK (version ~ '^[0-9]{3}$'),
    filename text NOT NULL UNIQUE CHECK (filename ~ '^[0-9]{3}_[A-Za-z0-9._-]+\.sql$'),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    execution_mode text NOT NULL CHECK (execution_mode IN ('applied','baseline_verified')),
    git_commit text NOT NULL CHECK (git_commit ~ '^[0-9a-f]{40}$'),
    applied_by text NOT NULL,
    evidence_note text NOT NULL CHECK (char_length(evidence_note) BETWEEN 12 AND 500),
    applied_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dop_schema_migration_ledger IS
    'Append-only migration version/checksum evidence. baseline_verified identifies pre-ledger migrations verified at the current schema head; applied identifies migrations executed by the ledger runner.';

CREATE FUNCTION public.dop_reject_schema_migration_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION 'dop_schema_migration_ledger is append-only';
END;
$$;

CREATE TRIGGER dop_schema_migration_ledger_append_only
BEFORE UPDATE OR DELETE ON public.dop_schema_migration_ledger
FOR EACH ROW EXECUTE FUNCTION public.dop_reject_schema_migration_ledger_mutation();

ALTER TABLE public.dop_schema_migration_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dop_schema_migration_ledger FROM PUBLIC, dop_app;
REVOKE ALL ON FUNCTION public.dop_reject_schema_migration_ledger_mutation() FROM PUBLIC;

COMMIT;
