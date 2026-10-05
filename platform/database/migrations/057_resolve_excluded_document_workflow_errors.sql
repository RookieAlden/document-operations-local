BEGIN;

-- Excluding a Document is a terminal operator decision for that Case. Any
-- preservation/classification error that predates the exclusion must remain
-- auditable, but it must no longer stay in an actionable processing state.
WITH candidates AS (
  SELECT we.id AS error_id,
         we.organization_id,
         we.aggregate_id AS document_id,
         we.status AS previous_status,
         we.error_code,
         COALESCE(wr.correlation_id, gen_random_uuid()) AS correlation_id
    FROM public.workflow_errors we
    JOIN public.documents d
      ON we.aggregate_type = 'document' AND d.id = we.aggregate_id
    LEFT JOIN public.workflow_runs wr ON wr.id = we.workflow_run_id
   WHERE d.status = 'excluded'
     AND we.status IN ('open','retry_scheduled','waiting_manual')
), inserted_events AS (
  INSERT INTO public.workflow_events (
    id, organization_id, idempotency_key, event_type, event_version,
    aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
  )
  SELECT gen_random_uuid(), c.organization_id,
         'm45.2-excluded-error-reconcile|' || c.error_id,
         'WorkflowError.ResolvedAfterDocumentExclusion', 1,
         'workflow_error', c.error_id, c.correlation_id,
         'dop.migration.057',
         jsonb_build_object(
           'document_id', c.document_id,
           'previous_status', c.previous_status,
           'error_code', c.error_code,
           'resolution_reason', 'document_excluded_from_case'
         ),
         now()
    FROM candidates c
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING id, organization_id, aggregate_id
)
UPDATE public.workflow_errors we
   SET status = 'resolved',
       next_retry_at = NULL,
       resolved_at = now(),
       resolution = COALESCE(we.resolution, '{}'::jsonb) || jsonb_build_object(
         'reason', 'document_excluded_from_case',
         'reconciliation', 'migration_057',
         'event_id', (
           SELECT ev.id
             FROM public.workflow_events ev
            WHERE ev.organization_id = we.organization_id
              AND ev.idempotency_key = 'm45.2-excluded-error-reconcile|' || we.id
         )
       )
  FROM candidates c
 WHERE we.id = c.error_id;

COMMIT;
