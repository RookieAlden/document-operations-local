import type { Pool, PoolClient } from "pg";
import type {
  DemoFormAuthorizationRepository,
  DemoFormAuthorizationResult,
} from "../../ports/demo-form-authorization-repository.js";

export class PostgresDemoFormAuthorizationRepository implements DemoFormAuthorizationRepository {
  constructor(private readonly pool: Pool) {}

  async authorize(
    organizationKey: string,
    request: Parameters<DemoFormAuthorizationRepository["authorize"]>[1],
  ): Promise<DemoFormAuthorizationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: DemoFormAuthorizationResult }>(
        "SELECT dop_authorize_demo_form_submission($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result",
        [
          request.connectorKey,
          request.providerFormId,
          request.providerSubmissionId,
          request.invitationTokenSha256,
          request.claimedPeriod,
          request.fileCount,
          request.declaredTotalBytes,
          request.declaredBytesComplete,
          request.mimeTypes,
          request.correlationId,
          request.now,
        ],
      );
      return result.rows[0]?.result ?? { outcome: "rejected", reason: "invalid_request" };
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
    } finally {
      client.release();
    }
  }
}
