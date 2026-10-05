export type ReleaseManifestStatus = "draft" | "in_review" | "approved" | "rejected" | "superseded";

export interface ReleaseComponentPin {
  componentType: "work_package" | "work_configuration" | "case_plan" | "classification_profile" | "classifier_release" | "source_connector";
  componentKey: string;
  rootId: string;
  versionId: string;
  versionLabel: string;
  definitionHash: string;
  lifecycleStatus: string;
}

export interface ReleaseApprovalDeclaration {
  status: "pending" | "approved" | "not_required";
  reference: string | null;
  monthlyLimitUsd?: number;
}

export interface ReleaseReadinessDeclarations {
  schemaVersion: "1.0" | "2.0";
  sourceEnvironment: "DEV";
  targetEnvironment: "UAT";
  targetProvisioning: "not_started";
  runtimeExecution: "disabled";
  externalDelivery: "disabled";
  externalIngress: "disabled";
  dataBoundary: "synthetic_only";
  resourceCreationApproval?: "not_granted";
  approvals: {
    dataRegion: ReleaseApprovalDeclaration;
    privacyRetention: ReleaseApprovalDeclaration;
    budget: ReleaseApprovalDeclaration;
    sharedMailbox: ReleaseApprovalDeclaration;
  };
  secretReferences: string[];
}

export interface ReleaseReadinessCheck {
  code: string;
  status: "passed" | "blocked";
  evidence: Record<string, unknown>;
}

export interface OpsReleaseReadinessRun {
  id: string;
  manifestId: string;
  status: "passed" | "blocked";
  blockerCount: number;
  driftDetected: boolean;
  checks: ReleaseReadinessCheck[];
  runByName: string | null;
  reason: string;
  createdAt: string;
}

export interface OpsReleaseDecision {
  id: string;
  manifestId: string;
  action: "approved" | "rejected";
  decidedByName: string | null;
  reason: string;
  decidedAt: string;
}

export interface OpsReleaseManifest {
  id: string;
  manifestKey: string;
  version: number;
  status: ReleaseManifestStatus;
  sourceEnvironment: "DEV";
  targetEnvironment: "UAT";
  components: ReleaseComponentPin[];
  componentSnapshotHash: string;
  readinessDeclarations: ReleaseReadinessDeclarations;
  declarationsHash: string;
  manifestHash: string;
  rollbackManifestId: string | null;
  createdByName: string | null;
  submittedByName: string | null;
  approvedByName: string | null;
  reason: string;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  latestRun: OpsReleaseReadinessRun | null;
  decisions: OpsReleaseDecision[];
}

export interface OpsReleaseReadinessSnapshot {
  generatedAt: string;
  canManage: boolean;
  canApprove: boolean;
  manifests: OpsReleaseManifest[];
}

export type OpsReleaseReadinessMutationResult = Record<string, unknown> & {
  outcome: "completed" | "duplicate" | "conflict" | "not_found";
  reason?: string;
};

export interface OpsReleaseReadinessRepository {
  getSnapshot(organizationKey: string, actorId: string, now: Date): Promise<OpsReleaseReadinessSnapshot>;
  createManifest(organizationKey: string, request: {
    actorId: string; manifestKey: string; declarations: ReleaseReadinessDeclarations;
    reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsReleaseReadinessMutationResult>;
  evaluateManifest(organizationKey: string, request: {
    actorId: string; manifestId: string; reason: string; idempotencyKey: string;
    correlationId: string; now: Date;
  }): Promise<OpsReleaseReadinessMutationResult>;
  submitManifest(organizationKey: string, request: {
    actorId: string; manifestId: string; reason: string; idempotencyKey: string;
    correlationId: string; now: Date;
  }): Promise<OpsReleaseReadinessMutationResult>;
  decideManifest(organizationKey: string, request: {
    actorId: string; manifestId: string; action: "approve" | "reject"; reason: string;
    idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsReleaseReadinessMutationResult>;
}
