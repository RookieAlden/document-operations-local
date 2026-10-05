import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresClassificationQueueRepository } from "../src/adapters/postgres/postgres-classification-queue-repository.js";

class FakeClient {
  readonly statements: string[] = [];
  readonly parameters: unknown[][] = [];
  organizationId: string | null = "organization-1";

  async query(text: string, parameters: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const normalized = text.replace(/\s+/g, " ").trim();
    this.statements.push(normalized);
    this.parameters.push(parameters);
    if (normalized.startsWith("SELECT dop_set_organization_context")) {
      return { rows: [{ id: this.organizationId }] };
    }
    if (normalized.startsWith("SELECT d.id AS document_id")) {
      return { rows: [{ document_id: "document-1" }, { document_id: "document-2" }] };
    }
    return { rows: [] };
  }
  release(): void {}
}

function poolFor(client: FakeClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

describe("PostgresClassificationQueueRepository", () => {
  it("returns only ready or recoverable prompt-bound documents", async () => {
    const client = new FakeClient();
    const repository = new PostgresClassificationQueueRepository(poolFor(client));
    await expect(repository.findCandidates({
      organizationKey: "dev-accounting-firm", limit: 2, now: new Date("2026-08-07T01:00:00Z"),
    })).resolves.toEqual(["document-1", "document-2"]);
    const sql = client.statements.find((statement) => statement.startsWith("SELECT d.id AS document_id")) ?? "";
    expect(sql).toContain("d.incoming_storage_ref IS NOT NULL");
    expect(sql).toContain("c.classifier_release_version_id::text");
    expect(sql).not.toContain("c.prompt_version_id::text");
    expect(sql).toContain("wr.module_id = 'classify-document'");
    expect(sql).toContain("ir.status = 'failed_recoverable' AND retry.next_retry_at <= $2");
    expect(sql).toContain("ir.lease_expires_at < $2");
    expect(client.parameters).toContainEqual([
      "organization-1", new Date("2026-08-07T01:00:00Z"), 2,
    ]);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("returns no candidates for an unknown organization", async () => {
    const client = new FakeClient();
    client.organizationId = null;
    const repository = new PostgresClassificationQueueRepository(poolFor(client));
    await expect(repository.findCandidates({
      organizationKey: "missing", limit: 1, now: new Date(),
    })).resolves.toEqual([]);
    expect(client.statements.some((statement) => statement.startsWith("SELECT d.id AS document_id"))).toBe(false);
  });
});
