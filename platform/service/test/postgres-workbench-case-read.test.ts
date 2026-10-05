import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresOpsReadRepository } from "../src/adapters/postgres/postgres-ops-read-repository.js";

class WorkbenchCaseReadClient {
  readonly statements: string[] = [];
  actorAvailable = true;
  caseAvailable = true;

  async query(text: string): Promise<{ rowCount: number; rows: Array<Record<string, unknown>> }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (sql.startsWith("SELECT dop_set_organization_context($1) AS id")) return result([{ id: "org-1" }]);
    if (sql.startsWith("SELECT id FROM actors")) {
      return result(this.actorAvailable ? [{ id: "actor-1" }] : []);
    }
    if (sql.startsWith("SELECT c.id, s.subject_key")) {
      return result(this.caseAvailable ? [{
        id: "case-1",
        subject_key: "synthetic-client",
        subject_name: "Synthetic Client Limited",
        period_start: "2026-07-01",
        period_end: "2026-09-30",
        status: "waiting_for_documents",
        risk_status: "normal",
        due_at: "2026-08-30T00:00:00.000Z",
        accepted_requirement_count: 1,
        required_requirement_count: 2,
        document_count: 1,
        open_issue_count: 7,
        requirements: [{
          requirementCode: "bank.minimum",
          documentTypeCode: "bank_statement",
          displayName: "Bank statement",
          minimumCount: 2,
          maximumCount: 2,
          acceptedCount: 1,
          missingCount: 1,
          reviewCount: 0,
          duplicateCount: 0,
          excessCount: 0,
          status: "missing",
        }],
        completeness_id: "assessment-latest",
        completeness_status: "incomplete",
        completeness_algorithm_version: "1.0",
        completeness_input_hash: "a".repeat(64),
        completeness_matched_document_count: 1,
        completeness_missing_requirement_count: 1,
        completeness_duplicate_document_count: 0,
        completeness_excess_document_count: 0,
        completeness_review_required_document_count: 0,
        completeness_unmatched_document_count: 0,
        completeness_active_submission_count: 0,
        completeness_created_at: "2026-08-23T00:00:00.000Z",
      }] : []);
    }
    return result([]);
  }

  release(): void {}
}

function result(rows: Array<Record<string, unknown>>) {
  return { rowCount: rows.length, rows };
}

function repositoryFor(client: WorkbenchCaseReadClient) {
  return new PostgresOpsReadRepository({ connect: async () => client } as unknown as Pool);
}

describe("shared Postgres Case list read", () => {
  it("uses the existing latest-completeness Case query without loading internal queues", async () => {
    const client = new WorkbenchCaseReadClient();
    const cases = await repositoryFor(client).listCases(
      "dev-accounting-firm",
      new Date("2026-08-23T01:00:00.000Z"),
      "actor-1",
    );

    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      id: "case-1",
      subjectName: "Synthetic Client Limited",
      acceptedRequirementCount: 1,
      requiredRequirementCount: 2,
      completeness: { id: "assessment-latest", status: "incomplete", createdAt: "2026-08-23T00:00:00.000Z" },
    });
    const caseSql = client.statements.find((sql) => sql.startsWith("SELECT c.id, s.subject_key")) ?? "";
    expect(caseSql).toContain("ORDER BY assessment.created_at DESC, assessment.id DESC LIMIT 1");
    expect(caseSql).toContain("latest_completeness.result->'requirements'");
    expect(client.statements.some((sql) => sql.includes("SELECT i.id, i.case_id"))).toBe(false);
    expect(client.statements.some((sql) => sql.includes("FROM workflow_errors"))).toBe(false);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("rejects a missing or inactive operator before reading any Case", async () => {
    const client = new WorkbenchCaseReadClient();
    client.actorAvailable = false;

    await expect(repositoryFor(client).listCases(
      "dev-accounting-firm",
      new Date("2026-08-23T01:00:00.000Z"),
      "actor-missing",
    )).rejects.toThrow("ops_operator_not_available");
    expect(client.statements.some((sql) => sql.startsWith("SELECT c.id, s.subject_key"))).toBe(false);
    expect(client.statements.at(-1)).toBe("ROLLBACK");
  });

  it("returns no detail and never reads files when the Case is outside the tenant context", async () => {
    const client = new WorkbenchCaseReadClient();
    client.caseAvailable = false;

    const detail = await repositoryFor(client).getCaseDetail(
      "dev-accounting-firm",
      "00000000-0000-4000-8000-000000000001",
      new Date("2026-08-23T01:00:00.000Z"),
      "actor-1",
    );

    expect(detail).toBeNull();
    const caseSql = client.statements.find((sql) => sql.startsWith("SELECT c.id, s.subject_key")) ?? "";
    expect(caseSql).toContain("WHERE ($1::uuid IS NULL OR c.id = $1)");
    expect(client.statements.some((sql) => sql.startsWith("WITH ranked AS"))).toBe(false);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });
});
