export type MissingRequestReviewAction = "submit_review" | "return_to_draft" | "approve" | "reject";

export interface OpsMissingRequestMutationResult {
  outcome: "completed" | "duplicate" | "not_found" | "conflict";
  reason?: string;
  revisionId?: string;
  revision?: number;
  status?: string;
  decisionId?: string;
  action?: string;
  contentHash?: string;
  deliveryMode?: "disabled" | "synthetic";
  deliveryJobId?: string;
  evaluationId?: string;
  runtimeExecution?: "disabled" | "synthetic";
  providerConfigured?: boolean;
  attemptCount?: number;
  definitionHash?: string;
  externalCallCount?: 0;
  scenario?: string;
}

export interface OpsMissingRequestRepository {
  createRevision(organizationKey: string, request: {
    actorId: string;
    requestDraftId: string;
    recipientActorId: string;
    subjectLine: string;
    bodyText: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsMissingRequestMutationResult>;

  transitionRevision(organizationKey: string, request: {
    actorId: string;
    revisionId: string;
    action: MissingRequestReviewAction;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsMissingRequestMutationResult>;

  planDelivery(organizationKey: string, request: {
    actorId: string;
    revisionId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsMissingRequestMutationResult>;

  runDeliveryEvaluation(organizationKey: string, request: {
    actorId: string;
    deliveryJobId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsMissingRequestMutationResult>;

  authorizeSyntheticDelivery(organizationKey: string, request: {
    actorId: string;
    deliveryJobId: string;
    scenario: "success" | "rate_limited_once" | "server_error_once" | "timeout_unknown" |
      "crash_after_claim" | "bounced" | "receipt_replay";
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsMissingRequestMutationResult>;

  reconcileUnknownDelivery(organizationKey: string, request: {
    actorId: string;
    deliveryJobId: string;
    action: "proved_not_sent_retry" | "confirmed_sent" | "remain_unknown";
    providerMessageId?: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsMissingRequestMutationResult>;
}
