import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  OpsReminderRepository,
  ReminderDecisionResult,
} from "../../ports/ops-reminder-repository.js";

export class PostgresOpsReminderRepository implements OpsReminderRepository {
  constructor(private readonly pool: Pool) {}

  async decide(organizationKey: string, request: Parameters<OpsReminderRepository["decide"]>[1]): Promise<ReminderDecisionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id", [organizationKey],
      );
      if (!organization.rows[0]?.id) {
        await client.query("COMMIT");
        return { outcome: "not_found", reason: "organization_not_found" };
      }
      const fingerprint = createHash("sha256").update([
        request.reminderInstanceId, request.action, request.reason.trim(),
      ].join("|")).digest("hex");
      const result = await client.query<{ result: unknown }>(
        "SELECT dop_decide_reminder($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
        [request.actorId, request.reminderInstanceId, request.action, request.reason.trim(),
          request.idempotencyKey, fingerprint, randomUUID(), randomUUID(),
          request.correlationId, request.now],
      );
      await client.query("COMMIT");
      return normalize(result.rows[0]?.result);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function normalize(value: unknown): ReminderDecisionResult {
  if (!value || typeof value !== "object") throw new Error("invalid_reminder_decision_result");
  const row = value as Record<string, unknown>;
  if (!['completed','duplicate','conflict','not_found'].includes(String(row.outcome))) {
    throw new Error("invalid_reminder_decision_outcome");
  }
  return {
    outcome: row.outcome as ReminderDecisionResult["outcome"],
    ...(typeof row.decisionId === "string" ? { decisionId: row.decisionId } : {}),
    ...(typeof row.reminderInstanceId === "string" ? { reminderInstanceId: row.reminderInstanceId } : {}),
    ...(row.status === "approved" || row.status === "rejected" ? { status: row.status } : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    ...(row.deliveryMode === "disabled" ? { deliveryMode: "disabled" as const } : {}),
    ...(row.externalCallCount === 0 ? { externalCallCount: 0 as const } : {}),
  };
}
