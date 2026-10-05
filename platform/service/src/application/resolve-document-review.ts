import { createHash, randomUUID } from "node:crypto";
import type {
  DocumentExclusionReason,
  DocumentReviewAction,
  OpsReviewRepository,
  ResolveDocumentReviewResult,
} from "../ports/ops-review-repository.js";

export interface ResolveDocumentReviewInput {
  organizationKey: string;
  documentId: string;
  actorId: string;
  action: DocumentReviewAction;
  exclusionReason?: DocumentExclusionReason | null;
  documentTypeCode?: string | null;
  rationale: string;
  idempotencyKey: string;
  correlationId: string;
  now: Date;
}

export class ResolveDocumentReview {
  constructor(private readonly repository: OpsReviewRepository) {}

  async execute(input: ResolveDocumentReviewInput): Promise<ResolveDocumentReviewResult> {
    const rationale = input.rationale.trim();
    const documentTypeCode = input.action === "reclassify" ? input.documentTypeCode?.trim() ?? null : null;
    const exclusionReason = input.action === "exclude" ? input.exclusionReason ?? null : null;
    if (!isUuid(input.documentId) || !isUuid(input.actorId) || !isUuid(input.idempotencyKey) || !isUuid(input.correlationId)) {
      throw new DocumentReviewInputError("invalid_identifier");
    }
    if (!input.organizationKey || input.organizationKey.length > 120) throw new DocumentReviewInputError("invalid_organization");
    if (!(["confirm", "reclassify", "request_information", "exclude", "reopen"] as string[]).includes(input.action)) {
      throw new DocumentReviewInputError("invalid_action");
    }
    if (rationale.length < 12 || rationale.length > 1000) throw new DocumentReviewInputError("invalid_rationale");
    if (input.action === "reclassify" && (!documentTypeCode || !/^[a-z0-9][a-z0-9_-]{1,79}$/.test(documentTypeCode))) {
      throw new DocumentReviewInputError("document_type_required");
    }
    if (input.action === "exclude" && !isExclusionReason(exclusionReason)) {
      throw new DocumentReviewInputError("exclusion_reason_required");
    }

    const requestFingerprint = createHash("sha256").update(JSON.stringify({
      documentId: input.documentId,
      actorId: input.actorId,
      action: input.action,
      exclusionReason,
      documentTypeCode,
      rationale,
    })).digest("hex");

    return await this.repository.resolve({
      organizationKey: input.organizationKey,
      documentId: input.documentId,
      actorId: input.actorId,
      action: input.action,
      exclusionReason,
      documentTypeCode,
      rationale,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      decisionId: randomUUID(),
      eventId: randomUUID(),
      issueId: randomUUID(),
      correlationId: input.correlationId,
      now: input.now,
    });
  }
}

function isExclusionReason(value: unknown): value is DocumentExclusionReason {
  return ["wrong_subject", "wrong_period", "irrelevant_or_unknown"].includes(String(value));
}

export class DocumentReviewInputError extends Error {
  constructor(readonly code: string) { super(code); }
}

function isUuid(value: string): boolean {
  // PostgreSQL accepts the canonical 8-4-4-4-12 text shape. Historic DEV
  // fixtures predate strict RFC-4122 variant enforcement, so validate shape
  // here and let the database UUID type remain authoritative.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
