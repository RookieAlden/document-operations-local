import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresOpsReviewRepository } from "../src/adapters/postgres/postgres-ops-review-repository.js";
import type { ResolveDocumentReviewRequest } from "../src/ports/ops-review-repository.js";

interface FakeResult { rowCount: number; rows: Array<Record<string, unknown>> }

class ReviewFakeClient {
  statements: string[] = [];
  parameters: unknown[][] = [];
  existing: Record<string, unknown> | null = null;
  documentStatus = "review_required";
  currentTypeId: string | null = "type-bank";
  actorType = "manager";
  actorActive = true;
  caseStatus = "review_required";
  caseVisible = true;
  supervisorRequested = false;
  failOn?: string;

  async query(text: string, values: unknown[] = []): Promise<FakeResult> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    this.parameters.push(values);
    if (this.failOn && sql.includes(this.failOn)) throw new Error("simulated review DB failure");
    if (sql.startsWith("SELECT dop_set_organization_context($1) AS id")) return { rowCount: 1, rows: [{ id: "organization-1" }] };
    if (sql.startsWith("SELECT decision.id")) return { rowCount: this.existing ? 1 : 0, rows: this.existing ? [this.existing] : [] };
    if (sql.startsWith("SELECT id, actor_type FROM actors")) return { rowCount: this.actorActive ? 1 : 0, rows: this.actorActive ? [{ id: "actor-1", actor_type: this.actorType }] : [] };
    if (sql.startsWith("SELECT dop_lock_document_review_case")) return { rowCount: 1, rows: [{ status: this.caseVisible ? this.caseStatus : null }] };
    if (sql.startsWith("SELECT d.id, d.case_id")) return { rowCount: 1, rows: [{ id: "document-1", case_id: "case-1", status: this.documentStatus, supervisor_review_requested: this.supervisorRequested, accepted_document_type_id: this.currentTypeId, document_type_code: this.currentTypeId ? "bank_statement" : null }] };
    if (sql.startsWith("SELECT DISTINCT dt.id")) return { rowCount: 1, rows: [{ id: "type-invoice", code: "invoice" }] };
    if (sql.startsWith("UPDATE issues")) return { rowCount: 1, rows: [{ id: "issue-1" }] };
    if (sql.startsWith("INSERT INTO issues")) return { rowCount: 1, rows: [{ id: "issue-reopen" }] };
    return { rowCount: 1, rows: [] };
  }

  release(): void {}
}

function poolFor(client: ReviewFakeClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

function request(overrides: Partial<ResolveDocumentReviewRequest> = {}): ResolveDocumentReviewRequest {
  return {
    organizationKey: "dev-accounting-firm",
    documentId: "document-1",
    actorId: "actor-1",
    action: "confirm",
    exclusionReason: null,
    documentTypeCode: null,
    rationale: "Synthetic evidence was checked by the operator.",
    idempotencyKey: "idem-1",
    requestFingerprint: "a".repeat(64),
    decisionId: "decision-1",
    eventId: "event-1",
    issueId: "issue-new-1",
    correlationId: "correlation-1",
    now: new Date("2026-08-07T03:00:00.000Z"),
    ...overrides,
  };
}

describe("PostgresOpsReviewRepository", () => {
  it("commits document, issue, immutable decision and actor-attributed event together", async () => {
    const client = new ReviewFakeClient();
    const result = await new PostgresOpsReviewRepository(poolFor(client)).resolve(request());
    expect(result).toMatchObject({ outcome: "completed", documentStatus: "human_confirmed", issueStatus: "resolved" });
    expect(client.statements.some((sql) => sql.startsWith("UPDATE documents"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("UPDATE issues"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO workflow_events"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO document_review_decisions"))).toBe(true);
    expect(client.parameters.flat()).toContain("actor-1");
    expect(client.parameters.flat()).toContain("Document.HumanConfirmed");
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("reclassifies only through a case-configured active document type", async () => {
    const client = new ReviewFakeClient();
    const result = await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({ action: "reclassify", documentTypeCode: "invoice" }));
    expect(result).toMatchObject({ outcome: "completed", documentTypeCode: "invoice" });
    expect(client.statements.some((sql) => sql.startsWith("SELECT DISTINCT dt.id"))).toBe(true);
    expect(client.parameters.flat()).toContain("type-invoice");
    expect(client.parameters.flat()).toContain("Document.Reclassified");
  });

  it("lets a manager exclude a wrong-subject original while retaining immutable evidence", async () => {
    const client = new ReviewFakeClient();
    const result = await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({
      action: "exclude",
      exclusionReason: "wrong_subject",
      rationale: "The preserved synthetic invoice belongs to another subject.",
    }));
    expect(result).toMatchObject({ outcome: "completed", documentStatus: "excluded", issueStatus: "resolved" });
    expect(client.parameters.flat()).toContain("Document.ExcludedFromCase");
    expect(client.parameters.flat()).toContain("operator_excluded_wrong_subject");
    expect(client.parameters.flat()).toContain("wrong_subject");
    expect(client.parameters.flat()).toContain("excluded");
    expect(client.parameters.flat()).toContain("exclude");
    expect(client.statements.some((sql) => sql.startsWith("UPDATE issues"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("UPDATE workflow_errors"))).toBe(true);
    expect(client.parameters.flat()).toContain("decision-1");
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO document_review_decisions"))).toBe(true);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("does not resolve processing errors for a non-exclusion review action", async () => {
    const client = new ReviewFakeClient();
    await new PostgresOpsReviewRepository(poolFor(client)).resolve(request());
    expect(client.statements.some((sql) => sql.startsWith("UPDATE workflow_errors"))).toBe(false);
  });

  it.each([
    ["wrong_subject", "operator_excluded_wrong_subject"],
    ["wrong_period", "operator_excluded_wrong_period"],
    ["irrelevant_or_unknown", "operator_excluded_irrelevant_or_unknown"],
  ] as const)("records exclusion reason %s in the document, decision and immutable event", async (exclusionReason, reviewReason) => {
    const client = new ReviewFakeClient();
    const result = await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({
      action: "exclude", exclusionReason,
      rationale: `Synthetic exclusion audit for ${exclusionReason}.`,
    }));
    expect(result).toMatchObject({ outcome: "completed", exclusionReason, documentStatus: "excluded" });
    expect(client.parameters.flat()).toContain(exclusionReason);
    expect(client.parameters.flat()).toContain(reviewReason);
    expect(client.parameters.flat().some((value) => typeof value === "string" && value.includes(`\"exclusion_reason\":\"${exclusionReason}\"`))).toBe(true);
  });

  it("returns a matching decision as an idempotent duplicate", async () => {
    const client = new ReviewFakeClient();
    client.existing = {
      id: "decision-existing", request_fingerprint: "a".repeat(64), event_id: "event-existing",
      document_id: "document-1", action: "confirm", resulting_status: "human_confirmed",
      document_type_code: "bank_statement", decided_at: "2026-08-07T03:00:00.000Z",
    };
    const result = await new PostgresOpsReviewRepository(poolFor(client)).resolve(request());
    expect(result).toMatchObject({ outcome: "duplicate", decisionId: "decision-existing" });
    expect(client.statements.some((sql) => sql.startsWith("UPDATE documents"))).toBe(false);
  });

  it("rejects a resolved document and rolls back all writes on failure", async () => {
    const resolvedClient = new ReviewFakeClient();
    resolvedClient.documentStatus = "human_confirmed";
    const conflict = await new PostgresOpsReviewRepository(poolFor(resolvedClient)).resolve(request());
    expect(conflict).toEqual({ outcome: "conflict", reason: "review_already_resolved" });

    const failingClient = new ReviewFakeClient();
    failingClient.failOn = "INSERT INTO document_review_decisions";
    await expect(new PostgresOpsReviewRepository(poolFor(failingClient)).resolve(request())).rejects.toThrow("simulated review DB failure");
    expect(failingClient.statements).toContain("ROLLBACK");
    expect(failingClient.statements.at(-1)).toBe("ROLLBACK");
  });

  it("lets a manager reopen a confirmed document without erasing the prior decision", async () => {
    const client = new ReviewFakeClient();
    client.documentStatus = "human_confirmed";
    const result = await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({ action: "reopen" }));
    expect(result).toMatchObject({ outcome: "completed", documentStatus: "review_required", issueStatus: "reopened" });
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO issues"))).toBe(true);
    expect(client.parameters.flat()).toContain("Document.ReviewReopened");
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO document_review_decisions"))).toBe(true);
  });

  it("keeps supervisor correction unavailable to a staff actor", async () => {
    const client = new ReviewFakeClient();
    client.documentStatus = "human_confirmed";
    client.actorType = "staff";
    const result = await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({ action: "reopen" }));
    expect(result).toEqual({ outcome: "conflict", reason: "manager_required" });
    expect(client.statements.some((sql) => sql.startsWith("UPDATE documents"))).toBe(false);
  });

  it.each(["wrong_subject", "wrong_period", "irrelevant_or_unknown"] as const)("lets staff exclude %s, even after escalation, without deleting originals", async (reason) => {
    const client = new ReviewFakeClient();
    client.actorType = "staff";
    client.supervisorRequested = true;
    const result = await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({ action: "exclude", exclusionReason: reason }));
    expect(result).toMatchObject({ outcome: "completed", documentStatus: "excluded", exclusionReason: reason });
    expect(client.statements.join(" ")).not.toMatch(/DELETE|UPDATE document_review_decisions|SET storage_/i);
    expect(client.parameters.flat()).toContain("Document.ExcludedFromCase");
  });

  it("lets staff restore only excluded documents to review, never directly to accepted", async () => {
    const client = new ReviewFakeClient(); client.actorType = "staff"; client.documentStatus = "excluded";
    const result = await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({ action: "reopen" }));
    expect(result).toMatchObject({ outcome: "completed", documentStatus: "review_required", issueStatus: "reopened" });
    expect(client.parameters.flat()).toContain("exclusion_restored_for_review");
    expect(client.parameters.flat()).toContain("Document.ReviewReopened");
    expect(client.parameters.flat()).not.toContain("human_confirmed");
  });

  it.each(["confirm", "reclassify", "request_information"] as const)("staff still cannot bypass supervisor hold using %s", async (action) => {
    const client = new ReviewFakeClient(); client.actorType = "staff"; client.supervisorRequested = true;
    expect(await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({ action })))
      .toEqual({ outcome: "conflict", reason: "manager_required" });
  });

  it.each(["exclude", "reopen"] as const)("preserves an existing supervisor hold through %s", async (action) => {
    const client = new ReviewFakeClient(); client.actorType = "staff"; client.supervisorRequested = true;
    if (action === "reopen") client.documentStatus = "excluded";
    expect(await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({ action, exclusionReason: action === "exclude" ? "wrong_period" : null })))
      .toMatchObject({ outcome: "completed" });
    const update = client.statements.findIndex((sql) => sql.startsWith("UPDATE documents"));
    expect(JSON.parse(client.parameters[update]?.[4] as string).supervisor_review_requested).toBe(true);
  });

  it.each(["completed", "cancelled"])("protects %s Cases from exclusion and restoration", async (caseStatus) => {
    for (const action of ["exclude", "reopen"] as const) {
      const client = new ReviewFakeClient(); client.caseStatus = caseStatus; client.actorType = "staff";
      expect(await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({ action })))
        .toEqual({ outcome: "conflict", reason: "case_closed" });
      expect(client.statements.some((sql) => sql.startsWith("UPDATE"))).toBe(false);
    }
  });

  it("fails closed for an inaccessible Case", async () => {
    const client = new ReviewFakeClient(); client.caseVisible = false;
    expect(await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({ action: "exclude", exclusionReason: "wrong_period" })))
      .toEqual({ outcome: "not_found", resource: "document" });
    expect(client.statements.some((sql) => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("checks active identity before idempotent replay", async () => {
    const client = new ReviewFakeClient(); client.actorActive = false;
    client.existing = { request_fingerprint: "a".repeat(64) };
    expect(await new PostgresOpsReviewRepository(poolFor(client)).resolve(request()))
      .toEqual({ outcome: "not_found", resource: "operator" });
  });

  it("lets a manager reopen an excluded original without erasing the exclusion decision", async () => {
    const client = new ReviewFakeClient();
    client.documentStatus = "excluded";
    const result = await new PostgresOpsReviewRepository(poolFor(client)).resolve(request({ action: "reopen" }));
    expect(result).toMatchObject({ outcome: "completed", documentStatus: "review_required", issueStatus: "reopened" });
    expect(client.parameters.flat()).toContain("Document.ReviewReopened");
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO document_review_decisions"))).toBe(true);
  });
});
