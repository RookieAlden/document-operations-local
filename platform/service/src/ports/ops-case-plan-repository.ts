export type CasePlanStatus = "draft" | "in_review" | "published";
export type CasePlanSourceType = "manual_upload" | "form_connector" | "email" | "sharepoint" | "api" | "sftp" | "object_storage";

export interface EligibleCasePlanSourceConnector {
  connectorId: string;
  connectorKey: string;
  displayName: string;
  connectorVersionId: string;
  version: number;
  revision: number;
  definitionHash: string;
  sourceType: CasePlanSourceType;
}

export interface CasePlanDefinition {
  cadence: {
    mode: "calendar_months";
    intervalMonths: number;
    anchorDate: string;
  };
  timezone: string;
  dueRule: {
    basis: "period_start" | "period_end";
    offsetDays: number;
    localTime: string;
  };
  defaultPreviewCount: number;
  sourceBinding: {
    type: CasePlanSourceType;
    bindingKey: string;
    metadata: Record<string, unknown>;
  };
  externalDelivery: "disabled";
}

export interface CasePlanVersion {
  id: string;
  planId: string;
  planKey: string;
  planName: string;
  planStatus: "active" | "paused" | "retired";
  subjectId: string;
  subjectKey: string;
  subjectName: string;
  version: number;
  revision: number;
  status: CasePlanStatus;
  definition: CasePlanDefinition;
  definitionHash: string;
  sourceConnectorVersionId: string;
  sourceConnectorDefinitionHash: string;
  sourceConnectorKey: string;
  sourceConnectorDisplayName: string;
  sourceConnectorVersion: number;
  sourceConnectorRevision: number;
  baseVersionId: string | null;
  createdByName: string;
  reason: string;
  createdAt: string;
  isCurrentPublished: boolean;
  validationErrors: string[];
}

export interface CasePlanCandidate {
  caseKey: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  timezone: string;
  sourceBinding: CasePlanDefinition["sourceBinding"];
  externalDelivery: "disabled";
}

export interface CasePlanPreview {
  id: string;
  planVersionId: string;
  planVersion: number;
  planKey: string;
  planName: string;
  subjectId: string;
  subjectKey: string;
  subjectName: string;
  configurationReleaseId: string;
  configurationReleaseNumber: number;
  sourceConnectorVersionId: string;
  sourceConnectorDefinitionHash: string;
  sourceConnectorKey: string;
  sourceConnectorDisplayName: string;
  sourceConnectorVersion: number;
  sourceConnectorRevision: number;
  candidates: CasePlanCandidate[];
  candidatesHash: string;
  createdByName: string;
  reason: string;
  createdAt: string;
  approval: null | {
    id: string;
    generatedCaseIds: string[];
    approvedByName: string;
    reason: string;
    approvedAt: string;
  };
}

export interface OpsCasePlanSnapshot {
  generatedAt: string;
  canManage: boolean;
  canPreview: boolean;
  eligibleSubjects: Array<{
    id: string;
    subjectKey: string;
    subjectName: string;
    configurationReleaseId: string;
    configurationReleaseNumber: number;
  }>;
  eligibleSourceConnectors: EligibleCasePlanSourceConnector[];
  versions: CasePlanVersion[];
  previews: CasePlanPreview[];
}

export type OpsCasePlanMutationResult = Record<string, unknown> & {
  outcome: "completed" | "duplicate" | "conflict" | "not_found";
  reason?: string;
};

export interface OpsCasePlanRepository {
  getCasePlans(organizationKey: string, actorId: string, now: Date): Promise<OpsCasePlanSnapshot>;
  createPlan(organizationKey: string, request: {
    actorId: string; subjectId: string; planKey: string; displayName: string;
    definition: CasePlanDefinition; reason: string; idempotencyKey: string;
    correlationId: string; now: Date;
  }): Promise<OpsCasePlanMutationResult>;
  updateDraft(organizationKey: string, request: {
    actorId: string; versionId: string; definition: CasePlanDefinition; reason: string;
    idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsCasePlanMutationResult>;
  transitionVersion(organizationKey: string, request: {
    actorId: string; versionId: string; action: "submit_review" | "return_to_draft" | "publish";
    reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsCasePlanMutationResult>;
  cloneVersion(organizationKey: string, request: {
    actorId: string; versionId: string; reason: string; idempotencyKey: string;
    correlationId: string; now: Date;
  }): Promise<OpsCasePlanMutationResult>;
  previewPlan(organizationKey: string, request: {
    actorId: string; versionId: string; candidateCount: number; startOn: string | null;
    reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsCasePlanMutationResult>;
  approvePreview(organizationKey: string, request: {
    actorId: string; previewId: string; reason: string; idempotencyKey: string;
    correlationId: string; now: Date;
  }): Promise<OpsCasePlanMutationResult>;
}
