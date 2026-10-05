import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresOpsTaskRepository } from "../src/adapters/postgres/postgres-ops-task-repository.js";
import type { TransitionTaskRequest } from "../src/ports/ops-task-repository.js";

class FakeClient {
  statements: string[] = [];
  functionResult: Record<string, unknown> = {
    outcome: "completed", transitionId: "transition-1", eventId: "event-1", taskId: "task-1",
    action: "claim", taskStatus: "open", assignedActorId: "actor-1", transitionedAt: "2026-08-16T04:00:00.000Z",
  };
  async query(text: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (sql.startsWith("SELECT dop_set_organization_context")) return { rows: [{ id: "org-1" }], rowCount: 1 };
    if (sql.startsWith("SELECT dop_transition_task")) return { rows: [{ result: this.functionResult }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
  release(): void {}
}

function request(): TransitionTaskRequest {
  return { organizationKey: "dev", taskId: "task-1", actorId: "actor-1", action: "claim",
    assignedActorId: null, reason: "Claim the synthetic handoff task.", idempotencyKey: "idem-1",
    requestFingerprint: "a".repeat(64), transitionId: "transition-1", eventId: "event-1",
    correlationId: "correlation-1", now: new Date("2026-08-16T04:00:00.000Z") };
}

describe("PostgresOpsTaskRepository", () => {
  it("sets tenant context and delegates the atomic lifecycle mutation to the guarded function", async () => {
    const client = new FakeClient();
    const result = await new PostgresOpsTaskRepository({ connect: async () => client } as unknown as Pool).transition(request());
    expect(result).toMatchObject({ outcome: "completed", taskStatus: "open", assignedActorId: "actor-1" });
    expect(client.statements.some((sql) => sql.startsWith("SELECT dop_transition_task"))).toBe(true);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("preserves database conflict results without partial writes", async () => {
    const client = new FakeClient();
    client.functionResult = { outcome: "conflict", reason: "task_already_assigned" };
    const result = await new PostgresOpsTaskRepository({ connect: async () => client } as unknown as Pool).transition(request());
    expect(result).toEqual({ outcome: "conflict", reason: "task_already_assigned" });
    expect(client.statements.at(-1)).toBe("COMMIT");
  });
});
