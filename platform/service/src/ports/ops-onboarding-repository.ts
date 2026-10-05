import type { WorkConfigurationRequirement } from "./ops-configuration-repository.js";

export interface OpsOnboardingPackage {
  id: string;
  packageId: string;
  packageKey: string;
  displayName: string;
  description: string;
  industryPackage: string | null;
  version: number;
  workflowTemplateId: string;
  workflowTemplateName: string;
  subjectDefaults: { status: "active" | "paused"; attributes: Record<string, unknown> };
  workflow: Record<string, unknown>;
  requirements: WorkConfigurationRequirement[];
  definitionHash: string;
  publishedAt: string;
}

export interface OpsSubjectOnboarding {
  id: string;
  subjectId: string;
  subjectKey: string;
  subjectName: string;
  packageName: string;
  packageVersion: number;
  configurationReleaseId: string;
  configurationStatus: "draft" | "in_review" | "published";
  createdByName: string;
  reason: string;
  createdAt: string;
}

export interface OpsOnboardingSnapshot {
  generatedAt: string;
  packages: OpsOnboardingPackage[];
  recentOnboardings: OpsSubjectOnboarding[];
  customerContacts: { id: string; displayName: string; email: string | null }[];
}

export type OpsOnboardingMutationResult = Record<string, unknown> & {
  outcome: "completed" | "duplicate" | "conflict" | "not_found";
  reason?: string;
};

export interface OpsOnboardingRepository {
  getOnboarding(organizationKey: string, actorId: string, now: Date): Promise<OpsOnboardingSnapshot>;
  onboardSubject(organizationKey: string, request: {
    actorId: string;
    packageVersionId: string;
    subjectKey: string;
    displayName: string;
    subjectType: string;
    primaryContactActorId: string | null;
    attributes: Record<string, unknown>;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsOnboardingMutationResult>;
  createCase(organizationKey: string, request: {
    actorId: string;
    releaseId: string;
    periodKey: string;
    periodStart: string;
    periodEnd: string;
    dueAt: Date;
    timezone: string;
    externalReference: string | null;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsOnboardingMutationResult>;
}
