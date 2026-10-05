import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresWorkbenchRepository } from "../src/adapters/postgres/postgres-workbench-repository.js";

class WorkbenchClient {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  async query(text: string, values?: unknown[]) {
    const sql = text.replace(/\s+/g, " ").trim();
    this.calls.push({ sql, ...(values ? { values } : {}) });
    if (sql.startsWith("SELECT dop_set_organization_context")) return rows([{ id: "org-1" }]);
    if (sql.startsWith("SELECT version.id")) return rows([{
      id: "package-version-1", display_name: "季度会计资料基础包", description: "季度资料收集",
      frequency: "quarterly", requirements: [{ code: "bank.minimum", name: "银行流水", minimumCount: 3, maximumCount: 3 }],
    }]);
    if (sql.startsWith("SELECT dop_create_workbench_client_case")) return rows([{
      result: { outcome: "completed", commandId: "command-1", subjectId: "subject-1", releaseId: "release-1", caseId: "case-1" },
    }]);
    if (sql.startsWith("SELECT dop_workbench_issue_case_invitation")) return rows([{
      result: { outcome: "completed", invitationId: "invitation-1", caseId: "case-1", status: "active", validUntil: "2026-09-16T00:00:00.000Z" },
    }]);
    return rows([]);
  }
  release() {}
}

function rows(value: Array<Record<string, unknown>>) { return { rowCount: value.length, rows: value }; }
function setup() { const client = new WorkbenchClient(); return { client, repository: new PostgresWorkbenchRepository({ connect: async () => client } as unknown as Pool) }; }

describe("Postgres employee workbench repository", () => {
  it("projects only current published synthetic monthly or quarterly service options", async () => {
    const { client, repository } = setup();
    const snapshot = await repository.getSetup("uat-accounting-firm", new Date("2026-09-02T00:00:00.000Z"));
    expect(snapshot.serviceOptions).toEqual([{
      id: "package-version-1", name: "季度会计资料基础包", description: "季度资料收集", frequency: "quarterly",
      requirements: [{ code: "bank.minimum", name: "银行流水", minimumCount: 3, maximumCount: 3 }],
    }]);
    const query = client.calls.find((call) => call.sql.startsWith("SELECT version.id"))?.sql ?? "";
    expect(query).toContain("package.current_published_version_id=version.id");
    expect(query).toContain("subjectDefaults,attributes,synthetic");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("delegates the atomic client and Case command without direct table writes", async () => {
    const { client, repository } = setup();
    const result = await repository.createClientCase("uat-accounting-firm", {
      actorId: "actor-1", packageVersionId: "package-version-1", displayName: "星河咨询有限公司", contactName: null,
      periodStart: "2026-10-01", periodEnd: "2026-12-31",
      requirements: [{ code: "bank.minimum", minimumCount: 3, maximumCount: 3 }],
      idempotencyKey: "00000000-0000-4000-8000-000000000001", correlationId: "00000000-0000-4000-8000-000000000002",
      now: new Date("2026-09-02T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ outcome: "completed", caseId: "case-1" });
    expect(client.calls.some((call) => call.sql.startsWith("SELECT dop_create_workbench_client_case"))).toBe(true);
    expect(client.calls.some((call) => /^INSERT|^UPDATE|^DELETE/.test(call.sql))).toBe(false);
  });

  it("delegates governed invitation issuance and keeps the token itself outside the database result", async () => {
    const { client, repository } = setup();
    const result = await repository.issueInvitation("uat-accounting-firm", {
      actorId: "actor-1", caseId: "case-1", invitationTokenSha256: "a".repeat(64), maximumSubmissions: 20,
      validUntil: new Date("2026-09-16T00:00:00.000Z"), idempotencyKey: "00000000-0000-4000-8000-000000000003",
      correlationId: "00000000-0000-4000-8000-000000000004", now: new Date("2026-09-02T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ outcome: "completed", invitationId: "invitation-1" });
    expect(client.calls.find((call) => call.sql.startsWith("SELECT dop_workbench_issue_case_invitation"))?.values?.[2]).toBe("a".repeat(64));
  });
});
