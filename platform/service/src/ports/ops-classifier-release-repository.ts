export interface ClassifierReleaseEvaluationCase {
  caseKey: string;
  displayName: string;
  synthetic: true;
  inputText: string;
  filename: string;
  mimeType: "text/plain";
  expectedLabelCode: string;
  minimumConfidence: number;
}

export interface ClassifierReleaseDefinition {
  schemaVersion: "1.0";
  environment: "DEV";
  provider: "openai";
  model: string;
  promptKey: string;
  promptInstructions: string;
  promptInstructionHash: string;
  classificationProfileVersionId: string;
  classificationProfileDefinitionHash: string;
  responseSchemaVersion: "1.0";
  responseSchemaHash: string;
  requestPolicy: {
    store: false;
    reasoningEffort: "low" | "medium" | "high";
    maxOutputTokens: number;
  };
  providerEvaluationCases: ClassifierReleaseEvaluationCase[];
}

export interface ClassifierReleaseDifference {
  path: string;
  before: unknown;
  after: unknown;
  kind: "added" | "removed" | "changed";
}

export interface OpsClassifierReleaseVersion {
  id: string;
  releaseId: string;
  releaseKey: string;
  releaseDisplayName: string;
  releaseDescription: string;
  promptVersionId: string | null;
  version: number;
  revision: number;
  status: "draft" | "in_review" | "published" | "retired";
  definition: ClassifierReleaseDefinition;
  definitionHash: string;
  reason: string;
  createdByName: string | null;
  createdAt: string;
  publishedAt: string | null;
  isLatestRevision: boolean;
  isCurrentPublished: boolean;
  hasPassingCompatibilityEvaluation: boolean;
  hasPassingProviderEvaluation: boolean;
  differencesFromPublished: ClassifierReleaseDifference[];
}

export interface OpsClassifierReleaseEvaluationRun {
  id: string;
  releaseId: string;
  releaseVersionId: string;
  definitionHash: string;
  evaluationKind: "compatibility" | "provider";
  status: "queued" | "running" | "passed" | "failed";
  result: Record<string, unknown>;
  runByName: string;
  reason: string;
  createdAt: string;
  completedAt: string | null;
}

export interface OpsClassifierReleaseSnapshot {
  generatedAt: string;
  canManage: boolean;
  versions: OpsClassifierReleaseVersion[];
  evaluationRuns: OpsClassifierReleaseEvaluationRun[];
}

export type OpsClassifierReleaseMutationResult = Record<string, unknown> & {
  outcome: "completed" | "queued" | "duplicate" | "conflict" | "not_found";
  reason?: string;
};

export interface OpsClassifierReleaseRepository {
  getReleases(organizationKey: string, actorId: string, now: Date): Promise<OpsClassifierReleaseSnapshot>;
  cloneVersion(organizationKey: string, request: {
    actorId: string; versionId: string; reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsClassifierReleaseMutationResult>;
  updateDraft(organizationKey: string, request: {
    actorId: string; versionId: string; definition: ClassifierReleaseDefinition;
    reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsClassifierReleaseMutationResult>;
  requestEvaluation(organizationKey: string, request: {
    actorId: string; versionId: string; evaluationKind: "compatibility" | "provider";
    reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsClassifierReleaseMutationResult>;
  transitionVersion(organizationKey: string, request: {
    actorId: string; versionId: string; action: "submit_review" | "return_to_draft" | "publish";
    reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsClassifierReleaseMutationResult>;
}

export interface ClaimedClassifierReleaseEvaluation {
  id: string;
  organizationId: string;
  releaseId: string;
  releaseVersionId: string;
  actorId: string;
  correlationId: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  definitionHash: string;
  definition: ClassifierReleaseDefinition;
  allowedDocumentTypes: Array<{ code: string; displayName: string; description?: string }>;
}

export interface ClassifierReleaseEvaluationWorkRepository {
  claimNext(request: {
    organizationKey: string; workerId: string; leaseSeconds: number; now: Date;
  }): Promise<ClaimedClassifierReleaseEvaluation | null>;
  complete(request: {
    evaluation: ClaimedClassifierReleaseEvaluation; status: "passed" | "failed";
    result: Record<string, unknown>; now: Date;
  }): Promise<void>;
  fail(request: {
    evaluation: ClaimedClassifierReleaseEvaluation; errorCode: string; now: Date;
  }): Promise<void>;
}
