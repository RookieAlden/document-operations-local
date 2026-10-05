import type { Pool, PoolClient } from "pg";
import type {
  OpsCaseCompletionResult,
  OpsTrialRepository,
  OpsUploadResult,
} from "../../ports/ops-trial-repository.js";

export class PostgresOpsTrialRepository implements OpsTrialRepository {
  constructor(private readonly pool: Pool) {}

  async acceptStoredUpload(
    organizationKey: string,
    request: Parameters<OpsTrialRepository["acceptStoredUpload"]>[1],
  ): Promise<OpsUploadResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsUploadResult }>(
        "SELECT dop_accept_stored_ops_upload($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result",
        [request.actorId, request.caseId, request.documentId, request.submissionId,
          request.filename, request.mimeType, request.sizeBytes, request.sha256,
          request.storageReference, request.idempotencyKey, request.now],
      );
      return result.rows[0]?.result ?? { outcome: "conflict", reason: "idempotency_key_reused" };
    });
  }

  async completeCase(
    organizationKey: string,
    request: Parameters<OpsTrialRepository["completeCase"]>[1],
  ): Promise<OpsCaseCompletionResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsCaseCompletionResult }>(
        "SELECT dop_complete_case_and_create_handoff($1,$2,$3,$4,$5,$6) AS result",
        [request.actorId, request.caseId, request.assignedActorId, request.reason,
          request.idempotencyKey, request.now],
      );
      return result.rows[0]?.result ?? { outcome: "conflict", reason: "idempotency_key_reused" };
    });
  }

  private async transaction<T>(organizationKey: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id", [organizationKey],
      );
      if (!organization.rows[0]?.id) throw new Error("organization_not_found");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
