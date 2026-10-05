WITH checks AS (
    SELECT
        EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'documents'
               AND column_name = 'source_download_ref'
               AND data_type = 'text'
        ) AS source_reference_column_exists,
        EXISTS (
            SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public'
               AND tablename = 'documents'
               AND indexname = 'documents_preservation_queue_idx'
               AND indexdef LIKE '%source_download_ref IS NOT NULL%'
        ) AS queue_index_exists,
        has_column_privilege('dop_app', 'public.documents', 'source_download_ref', 'SELECT')
            AND has_column_privilege('dop_app', 'public.documents', 'source_download_ref', 'INSERT')
            AND has_column_privilege('dop_app', 'public.documents', 'source_download_ref', 'UPDATE')
            AS runtime_column_privileges_ok
)
SELECT source_reference_column_exists
   AND queue_index_exists
   AND runtime_column_privileges_ok AS verification_passed,
       *
  FROM checks;
