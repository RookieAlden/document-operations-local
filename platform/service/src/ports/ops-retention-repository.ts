export type LegalHoldAction = "place" | "release";
export type RetentionRunMode = "dry_run" | "apply";

export interface RetentionDashboard {
  policy: null | {
    retentionDays: number;
    anchor: "case_terminal_at";
    holdApproverRoles: string[];
    rpoHours: number;
    rtoHours: number;
    executionEnabled: boolean;
    syntheticOnly: true;
    policyVersion: string;
  };
  activeHolds: Array<{
    id: string; caseId: string; caseKey: string; subjectName: string;
    reason: string; approvedBy: string; approvedAt: string; reviewDueAt: string;
    reviewState: "scheduled" | "pending_review";
  }>;
  recentRuns: Array<{
    id: string; mode: RetentionRunMode; status: string; cutoffAt: string;
    candidateCases: number; candidateDocuments: number; candidateObjects: number;
    deletedObjects: number; notFoundObjects: number; redactedCases: number;
    failedObjects: number; externalCalls: number; startedAt: string; completedAt: string | null;
  }>;
  deletionProofs: Array<{
    id: string; caseId: string; caseKey: string; policyVersion: string; deletedAt: string;
    documentCount: number; deletedObjects: number; notFoundObjects: number;
    redactedEvents: number; proofHash: string;
  }>;
  restoreDrills: Array<{
    id: string; caseId: string; caseKey: string; status: string; backupDigest: string;
    restoredDigest: string; rpoHours: number; rtoTargetHours: number;
    actualRtoSeconds: number; restoreTarget: string; restoredRowCount: number;
    artifactExpiresAt: string; artifactPurgedAt: string; schemaVerified: boolean;
    relationshipsVerified: boolean; migrationLedgerVerified: boolean; rlsVerified: boolean;
    restoreTargetDestroyed: boolean;
    sourceMigrationVersion: string | null; restoredTableCount: number;
    restoredRelationshipCount: number; restoredRlsPolicyCount: number; createdAt: string;
  }>;
  storageReconciliations: Array<{
    id: string; status: string; databaseReferenceCount: number; storageObjectCount: number;
    orphanObjectCount: number; missingObjectCount: number; orphanReferenceDigest: string;
    missingReferenceDigest: string; inspectedAt: string;
  }>;
}

export interface RetentionMutationResult {
  outcome: "completed" | "duplicate" | "conflict" | "not_found";
  reason?: string;
  [key: string]: unknown;
}

export interface OpsRetentionRepository {
  getDashboard(organizationKey: string): Promise<RetentionDashboard>;
  confirmPolicy(organizationKey: string, request: {
    actorId: string; retentionDays: 30; anchor: "case_terminal_at";
    holdApproverRoles: ["manager", "admin"];
    rpoHours: number; rtoHours: number; reason: string;
    idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<RetentionMutationResult>;
  setLegalHold(organizationKey: string, request: {
    actorId: string; caseId: string; action: LegalHoldAction; reason: string;
    reviewDueAt: Date; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<RetentionMutationResult>;
  planRun(organizationKey: string, request: {
    actorId: string; mode: RetentionRunMode; reason: string;
    idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<RetentionMutationResult>;
}
