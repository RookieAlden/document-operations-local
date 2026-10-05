import type { Pool } from "pg";
import type {
  ReminderScheduleResult,
  ReminderSchedulerRepository,
} from "../../ports/reminder-scheduler-repository.js";

export class PostgresReminderSchedulerRepository implements ReminderSchedulerRepository {
  constructor(private readonly pool: Pool) {}

  async checkReady(organizationKey: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id", [organizationKey],
      );
      await client.query("COMMIT");
      return Boolean(result.rows[0]?.id);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async run(request: {
    organizationKey: string; workerId: string; runKey: string; now: Date;
  }): Promise<ReminderScheduleResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id", [request.organizationKey],
      );
      if (!organization.rows[0]?.id) {
        await client.query("COMMIT");
        return empty("conflict", "organization_not_found");
      }
      const result = await client.query<{ result: unknown }>(
        "SELECT dop_run_reminder_scheduler($1,$2,$3) AS result",
        [request.workerId, request.runKey, request.now],
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

function normalize(value: unknown): ReminderScheduleResult {
  if (!value || typeof value !== "object") throw new Error("invalid_reminder_schedule_result");
  const row = value as Record<string, unknown>;
  if (!['completed', 'duplicate', 'conflict'].includes(String(row.outcome))) {
    throw new Error("invalid_reminder_schedule_outcome");
  }
  return {
    outcome: row.outcome as ReminderScheduleResult["outcome"],
    ...(typeof row.scheduleRunId === "string" ? { scheduleRunId: row.scheduleRunId } : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    casesScanned: number(row.casesScanned),
    remindersCreated: number(row.remindersCreated),
    remindersStopped: number(row.remindersStopped),
    escalationsCreated: number(row.escalationsCreated),
    externalCallCount: 0,
  };
}

function empty(outcome: "conflict", reason: string): ReminderScheduleResult {
  return { outcome, reason, casesScanned: 0, remindersCreated: 0,
    remindersStopped: 0, escalationsCreated: 0, externalCallCount: 0 };
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("invalid_reminder_schedule_count");
  return parsed;
}
