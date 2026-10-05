import type { Pool, PoolClient } from "pg";
import type {
  DeliveryAutomationRepository,
  DeliveryClaimResult,
} from "../../ports/delivery-automation-repository.js";

export class PostgresDeliveryAutomationRepository implements DeliveryAutomationRepository {
  constructor(private readonly pool: Pool) {}

  async checkReady(organizationKey: string): Promise<boolean> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ enabled: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM delivery_runtime_controls
            WHERE organization_id = dop_current_organization_id()
              AND environment = 'UAT' AND provider_mode = 'synthetic'
              AND runtime_enabled AND NOT kill_switch
         ) AS enabled`,
      );
      return result.rows[0]?.enabled === true;
    });
  }

  async claim(request: Parameters<DeliveryAutomationRepository["claim"]>[0]): Promise<DeliveryClaimResult> {
    return await this.transaction(request.organizationKey, async (client) => {
      const result = await client.query<{ result: DeliveryClaimResult }>(
        "SELECT dop_claim_synthetic_delivery($1,$2,$3) AS result",
        [request.workerId, request.leaseSeconds, request.now],
      );
      return result.rows[0]?.result ?? { outcome: "empty", expiredUnknownCount: 0 };
    });
  }

  async complete(request: Parameters<DeliveryAutomationRepository["complete"]>[0]) {
    return await this.transaction(request.organizationKey, async (client) => {
      const result = await client.query<{ result: { outcome: "completed" | "duplicate" | "conflict"; reason?: string } }>(
        "SELECT dop_complete_synthetic_delivery_attempt($1,$2,$3,$4,$5,$6,$7,$8) AS result",
        [request.workerId, request.attemptId, request.leaseToken, request.outcome,
          request.providerMessageId ?? null, request.errorCode ?? null,
          request.retryNotBefore ?? null, request.now],
      );
      return result.rows[0]?.result ?? { outcome: "conflict" as const, reason: "mutation_failed" };
    });
  }

  async recordReceipt(request: Parameters<DeliveryAutomationRepository["recordReceipt"]>[0]) {
    return await this.transaction(request.organizationKey, async (client) => {
      const result = await client.query<{ result: { outcome: "completed" | "duplicate" | "conflict"; reason?: string } }>(
        "SELECT dop_record_synthetic_delivery_receipt($1,$2,$3,$4,$5,$6,$7,$8) AS result",
        [request.workerId, request.attemptId, request.providerMessageId, request.receiptKey,
          request.receiptType, request.payloadHash, request.occurredAt, request.receivedAt],
      );
      return result.rows[0]?.result ?? { outcome: "conflict" as const, reason: "mutation_failed" };
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
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
