export interface WorkbenchRequirementOption {
  code: string;
  name: string;
  minimumCount: number;
  maximumCount: number | null;
}

export interface WorkbenchServiceOption {
  id: string;
  name: string;
  description: string;
  frequency: "monthly" | "quarterly";
  requirements: WorkbenchRequirementOption[];
}

export interface WorkbenchSetupSnapshot {
  generatedAt: string;
  serviceOptions: WorkbenchServiceOption[];
}

export type WorkbenchCreateResult =
  | {
      outcome: "completed" | "duplicate";
      commandId: string;
      subjectId: string;
      releaseId: string;
      caseId: string;
      caseKey?: string;
      periodKey?: string;
      dueAt?: string;
      syntheticOnly?: true;
      externalCalls?: 0;
    }
  | { outcome: "not_found" | "conflict"; reason: string; commandId?: string };

export type WorkbenchInvitationResult =
  | {
      outcome: "completed" | "duplicate";
      invitationId: string;
      caseId: string;
      status: string;
      validUntil: string;
      providerFormId?: string;
      eventId?: string;
      recoveryKey?: string;
      tokenSha256?: string;
      remainingSubmissions?: number;
    }
  | { outcome: "not_found" | "conflict"; reason: string; invitationId?: string; canRenew?: boolean };

export interface WorkbenchRepository {
  acknowledgeDuplicates(organizationKey: string, request: {
    actorId: string; caseId: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<{ outcome: "completed" | "duplicate" | "not_found" | "conflict"; reason?: string; caseId?: string; resolvedIssueCount?: number }>;
  escalateReview(organizationKey: string, request: {
    actorId: string; documentId: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<{ outcome: "completed" | "duplicate" | "not_found" | "conflict"; reason?: string; documentId?: string; issueId?: string; eventId?: string }>;
  getSetup(organizationKey: string, now: Date): Promise<WorkbenchSetupSnapshot>;
  createClientCase(organizationKey: string, request: {
    actorId: string;
    packageVersionId: string;
    displayName: string;
    contactName: string | null;
    periodStart: string;
    periodEnd: string;
    requirements: Array<{ code: string; minimumCount: number; maximumCount: number | null }>;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<WorkbenchCreateResult>;
  issueInvitation(organizationKey: string, request: {
    actorId: string;
    caseId: string;
    invitationTokenSha256: string;
    replaceInvitationId?: string;
    maximumSubmissions: number;
    validUntil: Date;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<WorkbenchInvitationResult>;
}
