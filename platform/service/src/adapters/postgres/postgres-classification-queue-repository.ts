import type { Pool } from "pg";
import type {
  ClassificationQueueRepository,
  FindClassificationCandidatesRequest,
} from "../../ports/classification-queue-repository.js";

export class PostgresClassificationQueueRepository implements ClassificationQueueRepository {
  constructor(private readonly pool: Pool) {}

  async findCandidates(request: FindClassificationCandidatesRequest): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id",
        [request.organizationKey],
      );
      const organizationId = organization.rows[0]?.id;
      if (!organizationId) {
        await client.query("COMMIT");
        return [];
      }
      const result = await client.query<{ document_id: string }>(
        `SELECT d.id AS document_id
           FROM documents d
           JOIN cases c
             ON c.organization_id = d.organization_id
            AND c.id = d.case_id
           LEFT JOIN idempotency_reservations ir
             ON ir.organization_id = d.organization_id
            AND ir.scope = 'document.classify'
            AND ir.idempotency_key =
                'document.classify|' || d.id::text || '|' || c.classifier_release_version_id::text
           LEFT JOIN LATERAL (
             SELECT we.next_retry_at
               FROM workflow_errors we
               JOIN workflow_runs wr
                 ON wr.organization_id = we.organization_id
                AND wr.id = we.workflow_run_id
                AND wr.module_id = 'classify-document'
              WHERE we.organization_id = d.organization_id
                AND we.aggregate_type = 'document'
                AND we.aggregate_id = d.id
                AND we.status = 'retry_scheduled'
              ORDER BY we.opened_at DESC
              LIMIT 1
           ) retry ON true
          WHERE d.organization_id = $1
            AND d.incoming_storage_ref IS NOT NULL
            AND d.status IN ('downloaded','incoming_saved','failed_recoverable','reserved')
            AND c.prompt_version_id IS NOT NULL
            AND (
                 ir.id IS NULL
                 OR (ir.status = 'failed_recoverable' AND retry.next_retry_at <= $2)
                 OR (ir.status = 'processing' AND ir.lease_expires_at < $2)
            )
          ORDER BY d.updated_at, d.created_at, d.id
          LIMIT $3`,
        [organizationId, request.now, request.limit],
      );
      await client.query("COMMIT");
      return result.rows.map((row) => row.document_id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async checkReady(organizationKey: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id",
        [organizationKey],
      );
      await client.query("COMMIT");
      return Boolean(result.rows[0]?.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
