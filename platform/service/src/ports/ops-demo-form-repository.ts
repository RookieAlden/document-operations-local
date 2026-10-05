export interface OpsDemoFormEntry {
  id: string;
  entryKey: string;
  version: number;
  connectorKey: string;
  providerFormId: string;
  status: "active" | "disabled";
  allowedMimeTypes: string[];
  maximumFilesPerSubmission: number;
  maximumDeclaredBytes: number;
  requireDeclaredBytes: boolean;
}

export interface OpsDemoFormInvitation {
  id: string;
  entryVersionId: string;
  caseId: string;
  caseKey: string;
  subjectDisplayName: string;
  periodKey: string;
  status: "active" | "revoked" | "exhausted";
  usedSubmissions: number;
  maximumSubmissions: number;
  validUntil: string;
  createdAt: string;
}

export interface OpsDemoFormEligibleCase {
  id: string;
  caseKey: string;
  subjectDisplayName: string;
  status: string;
  periodKey: string;
  submissionCount: number;
}

export interface OpsDemoFormIssue {
  id: string;
  caseId: string;
  issueKey: string;
  issueType: string;
  status: string;
  documentFilename: string | null;
  displayName: string;
}

export interface OpsClientPortalQuestion {
  id: string;
  caseId: string;
  issueId: string;
  version: number;
  status: "published" | "resolved" | "withdrawn";
  publicTitle: string;
  publicBody: string;
  publishedAt: string;
  concludedAt: string | null;
}

export interface OpsDemoFormSnapshot {
  generatedAt: string;
  entries: OpsDemoFormEntry[];
  invitations: OpsDemoFormInvitation[];
  eligibleCases: OpsDemoFormEligibleCase[];
  issues: OpsDemoFormIssue[];
  clientQuestions: OpsClientPortalQuestion[];
}

export type OpsDemoFormMutationResult =
  | { outcome: "completed" | "duplicate"; invitationId: string; status: string; validUntil?: string; eventId?: string }
  | { outcome: "not_found"; reason: string }
  | { outcome: "conflict"; reason: string };

export type OpsClientPortalQuestionMutationResult =
  | { outcome: "completed" | "duplicate"; questionId: string; status?: string; eventId?: string }
  | { outcome: "not_found"; reason: string }
  | { outcome: "conflict"; reason: string };

export interface OpsDemoFormRepository {
  getSnapshot(organizationKey: string, now: Date): Promise<OpsDemoFormSnapshot>;
  issueInvitation(organizationKey: string, request: {
    actorId: string;
    entryVersionId: string;
    caseId: string;
    invitationTokenSha256: string;
    periodKey: string;
    allowInitial: boolean;
    allowSupplement: boolean;
    maximumSubmissions: number;
    validFrom: Date;
    validUntil: Date;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsDemoFormMutationResult>;
  revokeInvitation(organizationKey: string, request: {
    actorId: string;
    invitationId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsDemoFormMutationResult>;
  publishClientQuestion(organizationKey: string, request: {
    actorId: string;
    caseId: string;
    issueId: string;
    publicTitle: string;
    publicBody: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsClientPortalQuestionMutationResult>;
  transitionClientQuestion(organizationKey: string, request: {
    actorId: string;
    questionId: string;
    action: "resolve" | "withdraw";
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsClientPortalQuestionMutationResult>;
}
