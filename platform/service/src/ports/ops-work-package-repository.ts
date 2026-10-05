import type { WorkConfigurationRequirement } from "./ops-configuration-repository.js";

export interface WorkPackageBlueprint {
  subjectDefaults: {
    status: "active" | "paused";
    attributes: Record<string, unknown>;
  };
  workflow: Record<string, unknown> & {
    frequency: string;
    environment: "DEV";
    external_messages_require_approval: true;
    dev_recipient_policy: "allowlist_only";
  };
  requirements: WorkConfigurationRequirement[];
}

export interface WorkPackageDifference {
  path: string;
  before: unknown;
  after: unknown;
  kind: "added" | "removed" | "changed";
}

export interface OpsWorkPackageVersion {
  id: string;
  packageId: string;
  packageKey: string;
  packageStatus: "active" | "retired";
  displayName: string;
  description: string;
  industryPackage: string | null;
  workflowTemplateId: string;
  workflowTemplateName: string;
  version: number;
  revision: number;
  status: "draft" | "in_review" | "published" | "retired";
  blueprint: WorkPackageBlueprint;
  definitionHash: string;
  reason: string;
  createdByName: string | null;
  createdAt: string;
  publishedAt: string | null;
  isLatestRevision: boolean;
  isCurrentPublished: boolean;
  hasPassingDryRun: boolean;
  differencesFromPublished: WorkPackageDifference[];
}

export interface OpsWorkPackageDryRun {
  id: string;
  packageId: string;
  packageVersionId: string;
  definitionHash: string;
  syntheticSample: Record<string, unknown>;
  result: Record<string, unknown>;
  status: "passed" | "failed";
  runByName: string;
  reason: string;
  createdAt: string;
}

export interface OpsWorkPackageSnapshot {
  generatedAt: string;
  canManage: boolean;
  versions: OpsWorkPackageVersion[];
  dryRuns: OpsWorkPackageDryRun[];
  workflowTemplates: {
    id: string;
    templateKey: string;
    displayName: string;
    industryPackage: string | null;
  }[];
  documentTypes: { code: string; displayName: string }[];
}

export type OpsWorkPackageMutationResult = Record<string, unknown> & {
  outcome: "completed" | "duplicate" | "conflict" | "not_found";
  reason?: string;
};

export interface OpsWorkPackageRepository {
  getWorkPackages(organizationKey: string, actorId: string, now: Date): Promise<OpsWorkPackageSnapshot>;
  createPackage(organizationKey: string, request: {
    actorId: string;
    packageKey: string;
    displayName: string;
    description: string;
    industryPackage: string | null;
    workflowTemplateId: string;
    blueprint: WorkPackageBlueprint;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsWorkPackageMutationResult>;
  updateDraft(organizationKey: string, request: {
    actorId: string;
    versionId: string;
    displayName: string;
    description: string;
    industryPackage: string | null;
    workflowTemplateId: string;
    blueprint: WorkPackageBlueprint;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsWorkPackageMutationResult>;
  cloneVersion(organizationKey: string, request: {
    actorId: string;
    versionId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsWorkPackageMutationResult>;
  runDryRun(organizationKey: string, request: {
    actorId: string;
    versionId: string;
    syntheticSample: Record<string, unknown>;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsWorkPackageMutationResult>;
  transitionVersion(organizationKey: string, request: {
    actorId: string;
    versionId: string;
    action: "submit_review" | "return_to_draft" | "publish";
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsWorkPackageMutationResult>;
  retirePackage(organizationKey: string, request: {
    actorId: string;
    packageId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsWorkPackageMutationResult>;
}
