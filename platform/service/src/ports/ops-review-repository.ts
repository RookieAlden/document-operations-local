export type DocumentReviewAction = "confirm" | "reclassify" | "request_information" | "exclude" | "reopen";
export type DocumentExclusionReason = "wrong_subject" | "wrong_period" | "irrelevant_or_unknown";

export interface ResolveDocumentReviewRequest {
  organizationKey: string;
  documentId: string;
  actorId: string;
  action: DocumentReviewAction;
  exclusionReason: DocumentExclusionReason | null;
  documentTypeCode: string | null;
  rationale: string;
  idempotencyKey: string;
  requestFingerprint: string;
  decisionId: string;
  eventId: string;
  issueId: string;
  correlationId: string;
  now: Date;
}

export interface CompletedDocumentReview {
  outcome: "completed" | "duplicate";
  decisionId: string;
  eventId: string;
  documentId: string;
  action: DocumentReviewAction;
  exclusionReason: DocumentExclusionReason | null;
  documentStatus: string;
  documentTypeCode: string | null;
  issueStatus: string | null;
  decidedAt: string;
}

export type ResolveDocumentReviewResult = CompletedDocumentReview |
  { outcome: "not_found"; resource: "organization" | "operator" | "document" | "document_type" } |
  { outcome: "conflict"; reason: "idempotency_key_reused" | "review_already_resolved" | "current_type_missing" | "system_retry_in_progress" | "manager_required" | "document_not_reopenable" | "case_closed" };

export interface OpsReviewRepository {
  resolve(request: ResolveDocumentReviewRequest): Promise<ResolveDocumentReviewResult>;
}
