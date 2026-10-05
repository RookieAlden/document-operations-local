BEGIN;

ALTER TABLE public.documents
    ADD COLUMN IF NOT EXISTS source_download_ref text;

CREATE INDEX IF NOT EXISTS documents_preservation_queue_idx
    ON public.documents (organization_id, updated_at, created_at)
    WHERE incoming_storage_ref IS NULL
      AND source_download_ref IS NOT NULL
      AND status IN ('reserved', 'failed_recoverable');

COMMENT ON COLUMN public.documents.source_download_ref IS
    'Ephemeral HTTPS source reference. Cleared immediately after the original is preserved in private storage.';

COMMIT;
