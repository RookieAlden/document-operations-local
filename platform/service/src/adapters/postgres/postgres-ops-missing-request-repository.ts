import type { Pool, PoolClient } from "pg";
import type {
  OpsMissingRequestMutationResult,
  OpsMissingRequestRepository,
} from "../../ports/ops-missing-request-repository.js";

export class PostgresOpsMissingRequestRepository implements OpsMissingRequestRepository {
  constructor(private readonly pool: Pool) {}

  async createRevision(
    organizationKey: string,
    request: Parameters<OpsMissingRequestRepository["createRevision"]>[1],
  ): Promise<OpsMissingRequestMutationResult> {
    return await this.call(organizationKey,
      "SELECT dop_create_missing_request_revision($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
      [request.actorId, request.requestDraftId, request.recipientActorId,
        request.subjectLine, request.bodyText, request.reason, request.idempotencyKey,
        request.correlationId, request.now]);
  }

  async transitionRevision(
    organizationKey: string,
    request: Parameters<OpsMissingRequestRepository["transitionRevision"]>[1],
  ): Promise<OpsMissingRequestMutationResult> {
    return await this.call(organizationKey,
      "SELECT dop_transition_missing_request_revision($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.revisionId, request.action, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async planDelivery(
    organizationKey: string,
    request: Parameters<OpsMissingRequestRepository["planDelivery"]>[1],
  ): Promise<OpsMissingRequestMutationResult> {
    return await this.call(organizationKey,
      "SELECT dop_plan_missing_request_delivery($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.revisionId, request.reason, request.idempotencyKey,
        request.correlationId, request.now]);
  }

  async runDeliveryEvaluation(
    organizationKey: string,
    request: Parameters<OpsMissingRequestRepository["runDeliveryEvaluation"]>[1],
  ): Promise<OpsMissingRequestMutationResult> {
    return await this.call(organizationKey,
      "SELECT dop_run_delivery_contract_evaluation($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.deliveryJobId, request.reason, request.idempotencyKey,
        request.correlationId, request.now]);
  }

  async authorizeSyntheticDelivery(
    organizationKey: string,
    request: Parameters<OpsMissingRequestRepository["authorizeSyntheticDelivery"]>[1],
  ): Promise<OpsMissingRequestMutationResult> {
    return await this.call(organizationKey,
      "SELECT dop_authorize_synthetic_delivery($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.deliveryJobId, request.scenario, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async reconcileUnknownDelivery(
    organizationKey: string,
    request: Parameters<OpsMissingRequestRepository["reconcileUnknownDelivery"]>[1],
  ): Promise<OpsMissingRequestMutationResult> {
    return await this.call(organizationKey,
      "SELECT dop_reconcile_delivery_unknown($1,$2,$3,$4,$5,$6,$7,$8) AS result",
      [request.actorId, request.deliveryJobId, request.action, request.providerMessageId ?? null,
        request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }

  private async call(
    organizationKey: string,
    sql: string,
    values: unknown[],
  ): Promise<OpsMissingRequestMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsMissingRequestMutationResult }>(sql, values);
      return result.rows[0]?.result ?? { outcome: "conflict", reason: "mutation_failed" };
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
    } finally {
      client.release();
    }
  }
}
