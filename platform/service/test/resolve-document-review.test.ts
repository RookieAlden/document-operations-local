import { describe, expect, it } from "vitest";
import { ResolveDocumentReview } from "../src/application/resolve-document-review.js";
import type { OpsReviewRepository, ResolveDocumentReviewRequest } from "../src/ports/ops-review-repository.js";

class StubRepository implements OpsReviewRepository {
  requests: ResolveDocumentReviewRequest[] = [];
  async resolve(request: ResolveDocumentReviewRequest) {
    this.requests.push(request);
    return {
      outcome: "completed" as const,
      decisionId: request.decisionId,
      eventId: request.eventId,
      documentId: request.documentId,
      action: request.action,
      exclusionReason: request.exclusionReason,
      documentStatus: "human_confirmed",
      documentTypeCode: request.documentTypeCode,
      issueStatus: "resolved",
      decidedAt: request.now.toISOString(),
    };
  }
}

const base = {
  organizationKey: "dev-accounting-firm",
  documentId: "00000000-0000-4000-e000-000000000001",
  actorId: "00000000-0000-4000-8200-000000000201",
  action: "confirm" as const,
  rationale: "  Synthetic evidence was checked against the visible period.  ",
  idempotencyKey: "00000000-0000-4000-9000-000000000001",
  correlationId: "00000000-0000-4000-9000-000000000002",
  now: new Date("2026-08-07T03:00:00.000Z"),
};

describe("ResolveDocumentReview", () => {
  it("normalizes the rationale and creates immutable audit identifiers", async () => {
    const repository = new StubRepository();
    const useCase = new ResolveDocumentReview(repository);
    await useCase.execute(base);
    expect(repository.requests[0]).toMatchObject({
      action: "confirm",
      documentTypeCode: null,
      rationale: "Synthetic evidence was checked against the visible period.",
    });
    expect(repository.requests[0]?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.requests[0]?.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(repository.requests[0]?.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("requires an allowed type code for reclassification", async () => {
    const useCase = new ResolveDocumentReview(new StubRepository());
    await expect(useCase.execute({ ...base, action: "reclassify", documentTypeCode: "" }))
      .rejects.toMatchObject({ code: "document_type_required" });
  });

  it("accepts an audited wrong-subject exclusion without changing the document type", async () => {
    const repository = new StubRepository();
    const useCase = new ResolveDocumentReview(repository);
    await useCase.execute({
      ...base,
      action: "exclude",
      exclusionReason: "wrong_subject",
      documentTypeCode: "invoice",
      rationale: "  The preserved file belongs to another synthetic subject.  ",
    });
    expect(repository.requests[0]).toMatchObject({
      action: "exclude",
      exclusionReason: "wrong_subject",
      documentTypeCode: null,
      rationale: "The preserved file belongs to another synthetic subject.",
    });
  });

  it("requires an explicit governed reason for every exclusion", async () => {
    const useCase = new ResolveDocumentReview(new StubRepository());
    await expect(useCase.execute({ ...base, action: "exclude" }))
      .rejects.toMatchObject({ code: "exclusion_reason_required" });
  });

  it("rejects short rationale and malformed idempotency identifiers before persistence", async () => {
    const repository = new StubRepository();
    const useCase = new ResolveDocumentReview(repository);
    await expect(useCase.execute({ ...base, rationale: "too short" }))
      .rejects.toMatchObject({ code: "invalid_rationale" });
    await expect(useCase.execute({ ...base, idempotencyKey: "retry-1" }))
      .rejects.toMatchObject({ code: "invalid_identifier" });
    expect(repository.requests).toHaveLength(0);
  });
});
