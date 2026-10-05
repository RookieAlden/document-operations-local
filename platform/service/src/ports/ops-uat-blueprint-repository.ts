export type UatDecisionBase = {
  status: "pending" | "approved";
  reference: string | null;
};

export type UatDataRegionDecision = UatDecisionBase & { region: string };
export type UatPrivacyRetentionDecision = UatDecisionBase & {
  retentionDays: number;
  realDataRequiresReapproval: true;
};
export type UatBudgetDecision = UatDecisionBase & {
  monthlyLimitUsd: number;
  estimatedMonthlyCostUsd?: number;
  paidResourceProvisioning: "prohibited" | "planned_after_explicit_creation_approval";
  resourceCreationAuthorized?: false;
};
export type UatRuntimeOwnerDecision = UatDecisionBase & { actorId: string };

export interface UatEnvironmentBlueprintDefinition {
  schemaVersion: "1.0" | "2.0";
  sourceEnvironment: "DEV";
  targetEnvironment: "UAT";
  provisioningMode: "dry_run_only" | "plan_only";
  targetProvisioning: "not_started";
  dataBoundary: "synthetic_only";
  dataCopy: "none";
  runtimeExecution: "disabled";
  externalIngress: "disabled";
  externalDelivery: "disabled";
  secretMaterialization: "disabled";
  topology: {
    provider: "railway";
    isolation: "dedicated_environment";
    database: "dedicated_supabase_project";
    storage: "dedicated_private_bucket";
    services: Array<{
      key: "intake" | "preservation" | "classification";
      plannedExposure: "internal_only";
      replicas: 1;
      runtimeState: "disabled";
    }>;
  };
  decisions: {
    dataRegion: UatDataRegionDecision;
    privacyRetention: UatPrivacyRetentionDecision;
    budget: UatBudgetDecision;
    runtimeOwner: UatRuntimeOwnerDecision;
  };
  variableNames: string[];
  secretReferences: Array<{ variableName: string; reference: string }>;
  migration: { strategy: "ordered_sql"; seedMode: "synthetic_only"; migrations: string[]; verificationScripts: string[] };
  acceptance: { healthCheck: "required"; errorLogs: "zero_required"; syntheticJourney: "required"; realData: "prohibited" };
  rollback: { strategy: "remove_unexposed_target"; preserveAuditEvidence: true; maxMinutes: number };
}

export interface UatBlueprintDryRunCheck {
  code: string;
  status: "passed" | "blocked";
  evidence: Record<string, unknown>;
}

export interface OpsUatBlueprintDryRun {
  id: string;
  blueprintId: string;
  status: "passed" | "blocked";
  blockerCount: number;
  checks: UatBlueprintDryRunCheck[];
  sideEffects: Record<string, unknown>;
  runByName: string | null;
  reason: string;
  createdAt: string;
}

export interface OpsUatBlueprint {
  id: string;
  blueprintKey: string;
  version: number;
  status: "draft" | "superseded";
  releaseManifestId: string | null;
  releaseManifestLabel: string | null;
  definition: UatEnvironmentBlueprintDefinition;
  definitionHash: string;
  deploymentPlan: Array<{ sequence: number; action: string; execution: "disabled"; count?: number }>;
  deploymentPlanHash: string;
  previousBlueprintId: string | null;
  createdByName: string | null;
  reason: string;
  createdAt: string;
  latestDryRun: OpsUatBlueprintDryRun | null;
}

export interface UatProvisioningPackageDefinition {
  schemaVersion: "1.0" | "2.0";
  sourceEnvironment: "DEV";
  targetEnvironment: "UAT";
  mode: "compile_only";
  execution: "prohibited";
  region: "Sydney";
  budget: {
    monthlyLimitUsd: number;
    estimatedMonthlyCostUsd?: number;
    paidResourceProvisioning: "prohibited" | "planned_after_explicit_creation_approval";
    reapprovalRequired?: true;
    resourceCreationAuthorized?: false;
  };
  dataBoundary: { syntheticOnly: true; realDataRequiresReapproval: true; retentionDays: 30; devDataCopy: "none" };
  railwayPlan: {
    action: "plan_only";
    environment: { name: "uat"; create: false; start: false };
    services: Array<{ key: "intake" | "preservation" | "classification"; plannedReplicas: 1; create: false; start: false; publicDomainCreate: false }>;
    variableNames: string[];
    secretReferences: Array<{ variableName: string; reference: string }>;
  };
  supabasePlan: {
    action: "plan_only";
    project: { region: "Sydney"; create: false };
    database: { create: false };
    storage: { private: true; create: false };
  };
  migration: { strategy: "ordered_sql"; migrations: string[]; verificationScripts: string[]; execution: "disabled" };
  retentionJob: { retentionDays: 30; scheduler: "not_configured"; execution: "disabled" };
  acceptance: UatEnvironmentBlueprintDefinition["acceptance"];
  rollback: UatEnvironmentBlueprintDefinition["rollback"];
  runbook: Array<{ sequence: number; action: string; execution: "disabled" }>;
  approvalGate: { status: "blocked_by_zero_budget" | "blocked_by_explicit_creation_approval"; provisioningAuthorized: false; reapprovalRequired?: true; requiredBeforeExecution: string[] };
}

export interface OpsUatProvisioningPackageDryRun {
  id: string;
  packageId: string;
  status: "passed";
  executionDecision: "no_go";
  blockerCount: 0;
  checks: UatBlueprintDryRunCheck[];
  sideEffects: Record<string, unknown>;
  runByName: string | null;
  reason: string;
  createdAt: string;
}

export interface OpsUatProvisioningPackage {
  id: string;
  packageKey: string;
  version: number;
  status: "compiled" | "superseded";
  blueprintId: string;
  blueprintLabel: string;
  definition: UatProvisioningPackageDefinition;
  definitionHash: string;
  runbookHash: string;
  previousPackageId: string | null;
  compiledByName: string | null;
  reason: string;
  createdAt: string;
  latestDryRun: OpsUatProvisioningPackageDryRun | null;
}

export type UatActivationDecisionKey =
  | "customer_confirmation"
  | "budget_and_cost"
  | "data_scope"
  | "provisioning_window";

export interface UatActivationApprovalPackDefinition {
  schemaVersion: "1.0" | "2.0";
  sourceEnvironment: "DEV";
  targetEnvironment: "UAT";
  mode: "approval_evidence_only";
  execution: "prohibited";
  providerActions: "disabled";
  target: { region: "Sydney"; retentionDays: 30 };
  currentPolicy: {
    monthlyBudgetUsd: number;
    estimatedMonthlyCostUsd?: number;
    paidResourceProvisioning: "prohibited" | "planned_after_explicit_creation_approval";
    dataMode: "synthetic_only";
    realDataApproved?: false;
    realDataRequiresReapproval: true;
    provisioningAuthorized: false;
  };
  sourcePackage: { id: string; definitionHash: string; dryRunId: string };
  inheritedEvidence: { blueprintId: string; runtimeOwnerActorId: string };
  requiredDecisions: string[];
  finalAuthorization: { required: true; handledBy: "separate_stage"; status: "not_requested" };
}

export interface OpsUatActivationDecision {
  id: string;
  approvalPackId: string;
  decisionKey: UatActivationDecisionKey;
  version: number;
  status: "approved" | "rejected";
  evidence: Record<string, unknown>;
  evidenceHash: string;
  decidedByName: string | null;
  reason: string;
  createdAt: string;
}

export interface OpsUatActivationEvaluation {
  id: string;
  approvalPackId: string;
  status: "passed" | "blocked";
  recommendation: "ready_for_final_authorization" | "blocked";
  executionDecision: "no_go";
  blockerCount: number;
  checks: UatBlueprintDryRunCheck[];
  sideEffects: Record<string, unknown>;
  runByName: string | null;
  reason: string;
  createdAt: string;
}

export interface OpsUatActivationApprovalPack {
  id: string;
  approvalPackKey: string;
  version: number;
  status: "draft" | "superseded";
  provisioningPackageId: string;
  provisioningPackageLabel: string;
  definition: UatActivationApprovalPackDefinition;
  definitionHash: string;
  previousApprovalPackId: string | null;
  compiledByName: string | null;
  reason: string;
  createdAt: string;
  latestDecisions: OpsUatActivationDecision[];
  latestEvaluation: OpsUatActivationEvaluation | null;
}

export interface UatFinalAuthorizationRequestDefinition {
  schemaVersion: "1.0" | "2.0";
  sourceEnvironment: "DEV";
  targetEnvironment: "UAT";
  mode: "authorization_request_draft";
  execution: "prohibited";
  providerActions: "disabled";
  executor: "absent";
  sourceApprovalPack: {
    id: string;
    definitionHash: string;
    evaluationId: string;
    evaluationStatus: "passed" | "blocked";
    blockerCount: number;
  };
  target: { region: "Sydney"; retentionDays: 30 };
  currentPolicy: UatActivationApprovalPackDefinition["currentPolicy"];
  proposedPolicy: {
    customerConfirmed: boolean;
    monthlyBudgetUsd: number | null;
    estimatedMonthlyCostUsd: number | null;
    dataMode: "synthetic_only" | "real_data" | null;
    realDataApproved: boolean;
    windowStartsAt: string | null;
    windowEndsAt: string | null;
  };
  changeSet: Array<{ sequence: number; action: string; execution: "disabled" }>;
  riskControls: {
    secretValues: "prohibited";
    dataCopy: "none";
    externalIngress: "disabled";
    externalDelivery: "disabled";
    rollback: "remove_unexposed_target";
    finalAuthorizationRequired: true;
  };
  requestGate: { status: "not_submitted"; submissionAllowed: false; authorizationGranted: false };
}

export interface OpsUatAuthorizationRecompilation {
  id: string;
  authorizationKey: string;
  version: number;
  currentPolicy: {
    schemaVersion: "2.0";
    dataRegion: "Sydney";
    computeRegion: "Singapore";
    retentionDays: 30;
    dataMode: "synthetic_only";
    realDataApproved: false;
    realDataRequiresReapproval: true;
    monthlyBudgetLimitUsd: 40;
    resourceCreationAuthorized: false;
    executionWindow: null;
    runtimeOwnerActorId: string;
    runtimeExecution: "disabled";
    externalIngress: "disabled";
    externalDelivery: "disabled";
    devDataCopy: "none";
  };
  costPlan: Record<string, unknown>;
  iacPlan: Record<string, unknown>;
  secretReferences: Array<{ variableName: string; reference: string }>;
  destructionPlan: Array<{ sequence: number; action: string; execution: "disabled" }>;
  actualEffects: Record<string, unknown>;
  bundleHash: string;
  compiledByName: string | null;
  reason: string;
  createdAt: string;
}

export interface OpsUatFinalAuthorizationEvaluation {
  id: string;
  requestId: string;
  status: "ready" | "blocked";
  recommendation: "ready_for_submission" | "blocked";
  executionDecision: "no_go";
  blockerCount: number;
  checks: UatBlueprintDryRunCheck[];
  sideEffects: Record<string, unknown>;
  runByName: string | null;
  reason: string;
  createdAt: string;
}

export interface OpsUatFinalAuthorizationRequest {
  id: string;
  requestKey: string;
  version: number;
  status: "draft" | "superseded";
  approvalPackId: string;
  approvalPackLabel: string;
  definition: UatFinalAuthorizationRequestDefinition;
  definitionHash: string;
  changeSetHash: string;
  previousRequestId: string | null;
  compiledByName: string | null;
  reason: string;
  createdAt: string;
  latestEvaluation: OpsUatFinalAuthorizationEvaluation | null;
}

export interface OpsUatBlueprintSnapshot {
  generatedAt: string;
  canManage: boolean;
  releaseManifests: Array<{ id: string; manifestKey: string; version: number; status: string }>;
  blueprints: OpsUatBlueprint[];
  provisioningPackages: OpsUatProvisioningPackage[];
  activationApprovalPacks: OpsUatActivationApprovalPack[];
  finalAuthorizationRequests: OpsUatFinalAuthorizationRequest[];
  currentAuthorization: OpsUatAuthorizationRecompilation | null;
}

export type OpsUatBlueprintMutationResult = Record<string, unknown> & {
  outcome: "completed" | "duplicate" | "conflict" | "not_found";
  reason?: string;
};

export interface OpsUatBlueprintRepository {
  getSnapshot(organizationKey: string, actorId: string, now: Date): Promise<OpsUatBlueprintSnapshot>;
  createBlueprint(organizationKey: string, request: {
    actorId: string;
    blueprintKey: string;
    releaseManifestId: string | null;
    definition: UatEnvironmentBlueprintDefinition;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsUatBlueprintMutationResult>;
  runDryRun(organizationKey: string, request: {
    actorId: string;
    blueprintId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsUatBlueprintMutationResult>;
  compileProvisioningPackage(organizationKey: string, request: {
    actorId: string;
    blueprintId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsUatBlueprintMutationResult>;
  runProvisioningPackageDryRun(organizationKey: string, request: {
    actorId: string;
    packageId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsUatBlueprintMutationResult>;
  compileActivationApprovalPack(organizationKey: string, request: {
    actorId: string;
    packageId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsUatBlueprintMutationResult>;
  recordActivationDecision(organizationKey: string, request: {
    actorId: string;
    approvalPackId: string;
    decisionKey: UatActivationDecisionKey;
    status: "approved" | "rejected";
    evidence: Record<string, unknown>;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsUatBlueprintMutationResult>;
  evaluateActivationApprovalPack(organizationKey: string, request: {
    actorId: string;
    approvalPackId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsUatBlueprintMutationResult>;
  compileFinalAuthorizationRequest(organizationKey: string, request: {
    actorId: string;
    approvalPackId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsUatBlueprintMutationResult>;
  evaluateFinalAuthorizationRequest(organizationKey: string, request: {
    actorId: string;
    requestId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsUatBlueprintMutationResult>;
}
