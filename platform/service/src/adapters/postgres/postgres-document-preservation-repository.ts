import type { Pool } from "pg";
import type {
  DocumentPreservationContext,
  DocumentPreservationRepository,
  ReserveDocumentPreservationResult,
} from "../../ports/document-preservation-repository.js";

interface CandidateRow {
  organization_id: string;
  organization_key: string;
  case_id: string;
  document_id: string;
  source_download_ref: string;
  original_filename: string;
  declared_mime_type: string | null;
  size_bytes: string | number | null;
  content_hash_sha256: string | null;
}

export class PostgresDocumentPreservationRepository implements DocumentPreservationRepository {
  constructor(private readonly pool: Pool) {}

  async reserveNext(request: {
    organizationKey: string; workerId: string; leaseSeconds: number; now: Date;
  }): Promise<ReserveDocumentPreservationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id", [request.organizationKey],
      );
      const organizationId = organization.rows[0]?.id;
      if (!organizationId) {
        await client.query("COMMIT");
        return { outcome: "empty" };
      }
      const candidate = await client.query<CandidateRow>(
        `SELECT d.organization_id, o.organization_key, d.case_id,
                d.id AS document_id, d.source_download_ref,
                d.original_filename, d.declared_mime_type,
                d.size_bytes, d.content_hash_sha256
           FROM documents d
           JOIN organizations o ON o.id = d.organization_id
          WHERE d.organization_id = $1
            AND d.incoming_storage_ref IS NULL
            AND d.source_download_ref IS NOT NULL
            AND d.status IN ('reserved','failed_recoverable')
            AND NOT EXISTS (
              SELECT 1 FROM idempotency_reservations ir
               WHERE ir.organization_id = d.organization_id
                 AND ir.scope = 'document.preserve'
                 AND ir.idempotency_key = 'document.preserve|' || d.id::text
                 AND (ir.status IN ('completed','failed_manual')
                      OR (ir.status = 'processing' AND ir.lease_expires_at >= $2))
            )
          ORDER BY d.updated_at, d.created_at, d.id
          FOR UPDATE OF d SKIP LOCKED
          LIMIT 1`,
        [organizationId, request.now],
      );
      const row = candidate.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return { outcome: "empty" };
      }
      const leaseExpiresAt = new Date(request.now.getTime() + request.leaseSeconds * 1000);
      const reservation = await client.query<{ id: string; attempt_count: number }>(
        `INSERT INTO idempotency_reservations (
           organization_id, scope, idempotency_key, status, lease_owner,
           lease_expires_at, attempt_count, created_at, updated_at
         ) VALUES ($1,'document.preserve',$2,'processing',$3,$4,1,$5,$5)
         ON CONFLICT (organization_id, scope, idempotency_key) DO UPDATE
           SET status = 'processing', lease_owner = EXCLUDED.lease_owner,
               lease_expires_at = EXCLUDED.lease_expires_at,
               attempt_count = idempotency_reservations.attempt_count + 1,
               last_error_code = NULL, updated_at = EXCLUDED.updated_at
         WHERE idempotency_reservations.status = 'failed_recoverable'
            OR (idempotency_reservations.status = 'processing'
                AND idempotency_reservations.lease_expires_at < EXCLUDED.updated_at)
         RETURNING id, attempt_count`,
        [organizationId, `document.preserve|${row.document_id}`, request.workerId, leaseExpiresAt, request.now],
      );
      const lease = reservation.rows[0];
      if (!lease) {
        await client.query("COMMIT");
        return { outcome: "empty" };
      }
      await client.query("COMMIT");
      return {
        outcome: "acquired",
        context: {
          organizationId: row.organization_id,
          organizationKey: row.organization_key,
          caseId: row.case_id,
          documentId: row.document_id,
          reservationId: lease.id,
          attemptNumber: Number(lease.attempt_count),
          sourceDownloadReference: row.source_download_ref,
          filename: row.original_filename,
          declaredMimeType: row.declared_mime_type,
          declaredSizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
          expectedSha256: row.content_hash_sha256,
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(request: Parameters<DocumentPreservationRepository["complete"]>[0]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT dop_set_organization_context_by_id($1)", [request.context.organizationId]);
      await client.query(
        `UPDATE documents SET status = 'incoming_saved', incoming_storage_ref = $3,
                detected_mime_type = $4, size_bytes = $5, content_hash_sha256 = $6,
                source_download_ref = NULL, updated_at = $7
          WHERE organization_id = $1 AND id = $2`,
        [request.context.organizationId, request.context.documentId, request.storageReference,
          request.downloaded.mimeType, request.downloaded.sizeBytes, request.downloaded.sha256, request.now],
      );
      await client.query(
        `INSERT INTO workflow_runs (id, organization_id, module_id, module_version,
           environment, correlation_id, aggregate_type, aggregate_id, status,
           input_reference, output_reference, started_at, completed_at, metrics)
         VALUES ($1,$2,'preserve-document','1.0.0',$3,$4,'document',$5,'succeeded',
                 NULL,$6,$7,$7,$8::jsonb)`,
        [request.workflowRunId, request.context.organizationId, request.environment,
          request.correlationId, request.context.documentId, request.storageReference, request.now,
          JSON.stringify({ size_bytes: request.downloaded.sizeBytes })],
      );
      await client.query(
        `INSERT INTO workflow_events (id, organization_id, idempotency_key,
           event_type, event_version, aggregate_type, aggregate_id, correlation_id,
           producer, payload, occurred_at)
         VALUES ($1,$2,$3,'Document.Stored',1,'document',$4,$5,
                 'dop.core.preserve-document.v1',$6::jsonb,$7)`,
        [request.eventId, request.context.organizationId,
          `document-stored|${request.context.documentId}|${request.downloaded.sha256}`,
          request.context.documentId, request.correlationId,
          JSON.stringify({ mime_type: request.downloaded.mimeType, size_bytes: request.downloaded.sizeBytes,
            content_hash_sha256: request.downloaded.sha256 }), request.now],
      );
      await client.query(
        `UPDATE idempotency_reservations SET status='completed', lease_owner=NULL,
                lease_expires_at=NULL, resource_type='document', resource_id=$3,
                last_error_code=NULL, completed_at=$4, updated_at=$4
          WHERE organization_id=$1 AND id=$2 AND status='processing'`,
        [request.context.organizationId, request.context.reservationId, request.context.documentId, request.now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async fail(request: Parameters<DocumentPreservationRepository["fail"]>[0]): Promise<void> {
    const client = await this.pool.connect();
    const status = request.failureMode === "manual" ? "failed_manual" : "failed_recoverable";
    try {
      await client.query("BEGIN");
      await client.query("SELECT dop_set_organization_context_by_id($1)", [request.context.organizationId]);
      await client.query(
        `UPDATE documents SET status=$3, review_reason=$4, updated_at=$5
          WHERE organization_id=$1 AND id=$2`,
        [request.context.organizationId, request.context.documentId, status, request.errorCode, request.now],
      );
      await client.query(
        `INSERT INTO workflow_runs (id, organization_id, module_id, module_version,
           environment, correlation_id, aggregate_type, aggregate_id, status,
           started_at, completed_at, metrics)
         VALUES ($1,$2,'preserve-document','1.0.0',$3,$4,'document',$5,$6,$7,$7,'{}'::jsonb)`,
        [request.workflowRunId, request.context.organizationId, request.environment,
          request.correlationId, request.context.documentId, status, request.now],
      );
      await client.query(
        `INSERT INTO workflow_errors (id, organization_id, workflow_run_id,
           aggregate_type, aggregate_id, error_code, error_class, status,
           retry_count, next_retry_at, safe_details, opened_at)
         VALUES ($1,$2,$3,'document',$4,$5,$6,$7,0,$8,$9::jsonb,$10)`,
        [request.workflowErrorId, request.context.organizationId, request.workflowRunId,
          request.context.documentId, request.errorCode, request.errorClass,
          request.failureMode === "manual" ? "waiting_manual" : "retry_scheduled",
          request.failureMode === "manual" ? null : new Date(request.now.getTime() + 5 * 60_000),
          JSON.stringify({ preservation_attempt: request.context.attemptNumber }), request.now],
      );
      await client.query(
        `INSERT INTO workflow_events (id, organization_id, idempotency_key,
           event_type, event_version, aggregate_type, aggregate_id, correlation_id,
           producer, payload, occurred_at)
         VALUES ($1,$2,$3,'Document.StorageFailed',1,'document',$4,$5,
                 'dop.core.preserve-document.v1',$6::jsonb,$7)`,
        [request.eventId, request.context.organizationId,
          `document-storage-failed|${request.context.documentId}|${request.context.attemptNumber}`,
          request.context.documentId, request.correlationId,
          JSON.stringify({ error_code: request.errorCode, failure_mode: request.failureMode }), request.now],
      );
      await client.query(
        `UPDATE idempotency_reservations SET status=$3, lease_owner=NULL,
                lease_expires_at=NULL, last_error_code=$4,
                completed_at=CASE WHEN $3='failed_manual' THEN $5::timestamptz ELSE NULL END,
                updated_at=$5::timestamptz
          WHERE organization_id=$1 AND id=$2`,
        [request.context.organizationId, request.context.reservationId, status, request.errorCode, request.now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}
