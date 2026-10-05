export interface OpsRequirementProgress {
  requirementCode: string;
  documentTypeCode: string;
  displayName: string;
  minimumCount: number;
  maximumCount: number | null;
  acceptedCount: number;
  missingCount: number;
  reviewCount: number;
  duplicateCount: number;
  excessCount: number;
  status: "complete" | "missing" | "review_required" | "excess" | "attention";
}

export interface OpsCaseCompleteness {
  id: string;
  status: "pending" | "review_required" | "incomplete" | "complete";
  algorithmVersion: "1.0";
  inputHash: string;
  matchedDocumentCount: number;
  missingRequirementCount: number;
  duplicateDocumentCount: number;
  excessDocumentCount: number;
  reviewRequiredDocumentCount: number;
  unmatchedDocumentCount: number;
  activeSubmissionCount: number;
  createdAt: string;
}

export interface OpsCaseSummary {
  id: string;
  subjectKey: string;
  subjectName: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: string;
  riskStatus: string;
  dueAt: string | null;
  acceptedRequirementCount: number;
  requiredRequirementCount: number;
  documentCount: number;
  openIssueCount: number;
  requirements: OpsRequirementProgress[];
  completeness: OpsCaseCompleteness | null;
}

export interface OpsReviewDocument {
  supervisorReviewRequested?: boolean;
  id: string;
  caseId: string;
  subjectName: string;
  periodStart: string | null;
  periodEnd: string | null;
  filename: string;
  status: string;
  documentTypeCode: string | null;
  documentTypeName: string | null;
  confidence: number | null;
  reviewReason: string | null;
  updatedAt: string;
  availableDocumentTypes: Array<{ code: string; displayName: string }>;
}

export interface OpsOperator {
  id: string;
  displayName: string;
  actorType: "staff" | "manager" | "admin";
}

export interface OpsIssueSummary {
  id: string;
  caseId: string;
  documentId: string | null;
  subjectName: string;
  issueType: string;
  severity: string;
  status: string;
  routingReason: string | null;
  filename: string | null;
  dueAt: string | null;
  openedAt: string;
  assignedActorId?: string | null;
  assignedActorName?: string | null;
  completenessException?: {
    assessmentId: string;
    exceptionType: "missing" | "duplicate" | "excess" | "review_required" | "unmatched";
    requirementCode: string | null;
    displayName: string | null;
    quantity: number;
  } | null;
}

export interface OpsMissingDocumentRequestDraft {
  id: string;
  assessmentId: string;
  version: number;
  status: "draft" | "superseded" | "cancelled";
  recipient: {
    resolutionStatus: "ready" | "unresolved";
    displayName: string | null;
    email: string | null;
  };
  subjectLine: string;
  bodyText: string;
  requestedItems: Array<{
    requirementCode: string;
    documentTypeCode: string;
    displayName: string;
    missingCount: number;
  }>;
  sourceIssueCount: number;
  contentHash: string;
  deliveryMode: "disabled";
  externalCallCount: 0;
  createdAt: string;
  recipientPolicy: {
    mode: "allowlist_only";
    candidates: Array<{
      allowlistId: string;
      actorId: string;
      displayName: string;
      email: string;
      source: "canonical_primary_contact" | "manual_approval";
      approvedAt: string;
    }>;
  };
  revisions: Array<{
    id: string;
    revision: number;
    status: "draft" | "in_review" | "changes_requested" | "approved" | "rejected" | "superseded" | "cancelled";
    recipient: {
      resolutionStatus: "ready" | "unresolved";
      actorId: string | null;
      displayName: string | null;
      email: string | null;
    };
    subjectLine: string;
    bodyText: string;
    contentHash: string;
    changeReason: string;
    createdByActorId: string | null;
    createdByName: string | null;
    submittedByActorId: string | null;
    submittedByName: string | null;
    submittedAt: string | null;
    reviewedByName: string | null;
    reviewedAt: string | null;
    reviewReason: string | null;
    deliveryMode: "disabled";
    externalCallCount: 0;
    createdAt: string;
  }>;
  reviewDecisions: Array<{
    id: string;
    revisionId: string;
    action: "submitted" | "returned" | "approved" | "rejected";
    actorName: string;
    reason: string;
    contentHash: string;
    decidedAt: string;
  }>;
  deliveryPlans: Array<{
    id: string;
    revisionId: string;
    status: "planned" | "queued" | "processing" | "accepted" | "delivered" | "deferred" |
      "bounced" | "failed_recoverable" | "failed_manual" | "outcome_unknown" | "cancelled";
    recipient: { displayName: string | null; address: string | null };
    contentHash: string;
    runtimeExecution: "disabled" | "synthetic";
    providerConfigured: boolean;
    scenario: string | null;
    providerMessageId: string | null;
    lastErrorCode: string | null;
    authorizedAt: string | null;
    attemptCount: number;
    externalCallCount: 0;
    createdByName: string | null;
    creationReason: string;
    createdAt: string;
    attempts: Array<{
      id: string; attemptNumber: number; status: string; errorCode: string | null;
      providerMessageId: string | null; startedAt: string; completedAt: string | null;
      retryNotBefore: string | null; externalCallCount: 0;
    }>;
    receipts: Array<{
      id: string; receiptType: string; providerMessageId: string;
      payloadHash: string; occurredAt: string; receivedAt: string;
    }>;
  }>;
  deliveryEvaluations: Array<{
    id: string;
    deliveryJobId: string;
    status: "passed" | "failed";
    contractVersion: "1.0";
    definitionHash: string;
    result: Record<string, unknown>;
    reason: string;
    runByName: string | null;
    externalCallCount: 0;
    createdAt: string;
  }>;
}

export interface OpsReviewDecisionSummary {
  id: string;
  documentId: string;
  filename: string;
  subjectName: string;
  action: string;
  exclusionReason: "wrong_subject" | "wrong_period" | "irrelevant_or_unknown" | null;
  documentStatus: string;
  documentTypeName: string | null;
  rationale: string;
  actorName: string;
  decidedAt: string;
}

export interface OpsRecentDocument {
  id: string;
  filename: string;
  subjectName: string;
  status: string;
  documentTypeName: string | null;
  updatedAt: string;
  previewAvailable: boolean;
}

export interface OpsCaseDocument {
  conflictFlags?: string[];
  supervisorReviewRequested?: boolean;
  id: string;
  filename: string;
  declaredMimeType: string | null;
  detectedMimeType: string | null;
  sizeBytes: number | null;
  status: string;
  documentTypeCode: string | null;
  documentTypeName: string | null;
  confidence: number | null;
  reviewReason: string | null;
  createdAt: string;
  updatedAt: string;
  previewAvailable: boolean;
  relation: {
    kind: "unique" | "same_content" | "same_filename";
    position: number;
    total: number;
  };
  latestAttempt: {
    attemptNumber: number;
    status: string;
    errorCode: string | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
  activeError: {
    errorCode: string;
    errorClass: string;
    status: string;
    retryCount: number;
    nextRetryAt: string | null;
    openedAt: string;
  } | null;
  requirementMatch: {
    status: "matched" | "review_required" | "duplicate" | "unmatched" | "processing" | "excluded";
    requirementCode: string | null;
    duplicateKind: "none" | "same_content";
    isExcess: boolean;
    countsTowardMinimum: boolean;
    reasonCode: string;
  } | null;
}

export interface OpsActivityItem {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
}

export interface OpsHandoffTask {
  id: string;
  name: string;
  taskType: string;
  status: "open" | "waiting" | "in_progress" | "completed" | "cancelled";
  assignedActorId: string | null;
  assignedActorName: string | null;
  dueAt: string | null;
  instructions: string;
  completionCriteria: string;
  createdAt: string;
  externalExecution: "disabled";
}

export interface OpsReminderInstance {
  id: string;
  kind: "initial" | "follow_up" | "overdue" | "escalation";
  sequenceNumber: number;
  scheduledAt: string;
  status: "pending_approval" | "approved" | "rejected" | "cancelled";
  triggerReason: string;
  stopReason: string | null;
  recipient: { displayName: string | null; address: string };
  content: { subjectLine: string; bodyText: string; requestedItems: unknown[] };
  policy: {
    timezone: string | null;
    calendarKey: string | null;
    workweek: string | null;
    leadBusinessDays: number | null;
    intervalBusinessDays: number | null;
    maximumReminders: number | null;
    escalationBusinessDays: number | null;
    escalationDefaultApplied: boolean;
    stopConditions: string[];
  };
  escalation: { ownerActorId: string; ownerName: string; status: string; openedAt: string } | null;
  decision: { action: "approve" | "reject"; actorName: string; reason: string; decidedAt: string } | null;
  contentHash: string;
  deliveryMode: "disabled";
  externalCallCount: 0;
  createdAt: string;
}

export interface OpsWorkflowErrorItem {
  id: string;
  documentId: string | null;
  caseId: string | null;
  subjectName: string | null;
  filename: string | null;
  moduleId: string | null;
  errorCode: string;
  errorClass: string;
  status: string;
  retryCount: number;
  nextRetryAt: string | null;
  openedAt: string;
}

export interface OpsOverview {
  generatedAt: string;
  organizationKey: string;
  operator: OpsOperator;
  summary: {
    activeCaseCount: number;
    dueSoonCaseCount: number;
    overdueCaseCount: number;
    reviewDocumentCount: number;
    openIssueCount: number;
    scheduledRetryCount: number;
    manualErrorCount: number;
    overdueRetryCount: number;
  };
  cases: OpsCaseSummary[];
  reviewQueue: OpsReviewDocument[];
  recentReviewDecisions?: OpsReviewDecisionSummary[];
  recentDocuments?: OpsRecentDocument[];
  issues: OpsIssueSummary[];
  retryQueue: OpsWorkflowErrorItem[];
  recentActivity: OpsActivityItem[];
}

export interface OpsCaseDetail {
  generatedAt: string;
  case: OpsCaseSummary;
  documents: OpsCaseDocument[];
  issues: OpsIssueSummary[];
  missingDocumentRequestDraft: OpsMissingDocumentRequestDraft | null;
  reminders: OpsReminderInstance[];
  handoffTask: OpsHandoffTask | null;
  recentActivity: OpsActivityItem[];
}

export interface OpsReadRepository {
  listCases(organizationKey: string, now: Date, operatorActorId: string): Promise<OpsCaseSummary[]>;
  getOverview(organizationKey: string, now: Date, operatorActorId: string): Promise<OpsOverview>;
  getCaseDetail(organizationKey: string, caseId: string, now: Date, operatorActorId: string): Promise<OpsCaseDetail | null>;
}
