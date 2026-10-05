import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresOpsIssueRepository } from "../src/adapters/postgres/postgres-ops-issue-repository.js";
import type { TransitionIssueRequest } from "../src/ports/ops-issue-repository.js";

class FakeClient {
  statements: string[] = [];
  status = "open";
  actorType = "staff";
  async query(text: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (sql.startsWith("SELECT dop_set_organization_context")) return { rows: [{ id: "org-1" }], rowCount: 1 };
    if (sql.startsWith("SELECT id, request_fingerprint")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT id, actor_type")) return { rows: [{ id: "actor-1", actor_type: this.actorType }], rowCount: 1 };
    if (sql.startsWith("SELECT id, status")) return { rows: [{ id: "issue-1", status: this.status, assigned_actor_id: null }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }
  release(): void {}
}

function request(action: TransitionIssueRequest["action"] = "assign_to_me"): TransitionIssueRequest {
  return { organizationKey: "dev", issueId: "issue-1", actorId: "actor-1", action,
    note: "Synthetic evidence supports this state transition.", idempotencyKey: "idem-1",
    requestFingerprint: "a".repeat(64), transitionId: "transition-1", eventId: "event-1",
    correlationId: "correlation-1", now: new Date("2026-08-07T05:00:00.000Z") };
}

describe("PostgresOpsIssueRepository", () => {
  it("updates the issue and appends both transition and workflow audit records atomically", async () => {
    const client = new FakeClient();
    const pool = { connect: async () => client } as unknown as Pool;
    const result = await new PostgresOpsIssueRepository(pool).transition(request());
    expect(result).toMatchObject({ outcome: "completed", issueStatus: "assigned", assignedActorId: "actor-1" });
    expect(client.statements.some((sql) => sql.startsWith("UPDATE issues"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO workflow_events"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO issue_operator_transitions"))).toBe(true);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("enforces the state machine and supervisor-only reopen boundary", async () => {
    const invalid = new FakeClient();
    invalid.status = "open";
    const invalidResult = await new PostgresOpsIssueRepository({ connect: async () => invalid } as unknown as Pool).transition(request("resolve"));
    expect(invalidResult).toEqual({ outcome: "conflict", reason: "transition_not_allowed" });

    const staff = new FakeClient();
    staff.status = "resolved";
    const staffResult = await new PostgresOpsIssueRepository({ connect: async () => staff } as unknown as Pool).transition(request("reopen"));
    expect(staffResult).toEqual({ outcome: "conflict", reason: "manager_required" });
  });

  it("evaluates duplicate acknowledgement atomically after resolving an Issue", async () => {
    const client = new FakeClient();
    client.status = "assigned";
    const pool = { connect: async () => client } as unknown as Pool;
    const result = await new PostgresOpsIssueRepository(pool).transition(request("resolve"));
    expect(result).toMatchObject({ outcome: "completed", issueStatus: "resolved" });
    const transitionIndex = client.statements.findIndex((sql) => sql.startsWith("INSERT INTO issue_operator_transitions"));
    const acknowledgementIndex = client.statements.findIndex((sql) => sql.startsWith("SELECT dop_acknowledge_resolved_duplicate_case"));
    expect(transitionIndex).toBeGreaterThan(-1);
    expect(acknowledgementIndex).toBeGreaterThan(transitionIndex);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });
});
