export type WorkConfigurationStatus = "draft" | "in_review" | "published";

export interface WorkConfigurationRequirement {
  code: string;
  documentTypeCode: string;
  minimumCount: number;
  maximumCount: number | null;
  acceptanceRule: Record<string, unknown>;
}

export interface WorkConfigurationManifest {
  subject: {
    displayName: string;
    subjectType: string;
    status: "active" | "paused" | "offboarding" | "closed";
    primaryContactActorId: string | null;
    attributes: Record<string, unknown>;
  };
  workflow: Record<string, unknown>;
  requirements: WorkConfigurationRequirement[];
}

export interface WorkConfigurationRelease {
  id: string;
  seriesId: string;
  releaseNumber: number;
  revision: number;
  status: WorkConfigurationStatus;
  subjectId: string;
  subjectKey: string;
  subjectName: string;
  workflowTemplateId: string;
  workflowTemplateName: string;
  requirementSetId: string;
  requirementSetName: string;
  manifest: WorkConfigurationManifest;
  definitionHash: string;
  baseReleaseId: string | null;
  baseManifest: WorkConfigurationManifest | null;
  producedWorkflowVersion: number | null;
  producedRequirementVersion: number | null;
  createdByName: string | null;
  reason: string;
  createdAt: string;
  isCurrentPublished: boolean;
  validationErrors: string[];
  diff: string[];
}

export interface OpsConfigurationSnapshot {
  generatedAt: string;
  canManage: boolean;
  canCreateCases: boolean;
  releases: WorkConfigurationRelease[];
  documentTypes: { code: string; displayName: string }[];
  customerContacts: { id: string; displayName: string; email: string | null }[];
}

export type OpsConfigurationMutationResult = Record<string, unknown> & {
  outcome: "completed" | "duplicate" | "conflict" | "not_found";
  reason?: string;
};

export interface OpsConfigurationRepository {
  getConfigurations(organizationKey: string, actorId: string, now: Date): Promise<OpsConfigurationSnapshot>;
  cloneRelease(organizationKey: string, request: {
    actorId: string; releaseId: string; reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsConfigurationMutationResult>;
  updateDraft(organizationKey: string, request: {
    actorId: string; releaseId: string; manifest: WorkConfigurationManifest; reason: string;
    idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsConfigurationMutationResult>;
  transitionRelease(organizationKey: string, request: {
    actorId: string; releaseId: string; action: "submit_review" | "return_to_draft" | "publish";
    reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsConfigurationMutationResult>;
}
