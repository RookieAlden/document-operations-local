export type ClassificationRoute = "accepted" | "review_required";

export interface ClassificationExtractionField {
  key: string;
  displayName: string;
  valueType: "string" | "number" | "date" | "boolean";
  required: boolean;
}

export interface ClassificationLabelDefinition {
  code: string;
  displayName: string;
  description: string;
  allowedMimeTypes: string[];
  extractionFields: ClassificationExtractionField[];
  policy: {
    minimumConfidence: number;
    alwaysHumanConfirm: boolean;
    manualOnConflict: boolean;
    rejectOnQualityFlags: string[];
    rejectOnConflictFlags: string[];
  };
}

export interface ClassificationEvaluationCase {
  caseKey: string;
  displayName: string;
  synthetic: true;
  filename: string;
  mimeType: string;
  predictedLabelCode: string;
  ambiguousLabelCodes: string[];
  confidence: number;
  qualityFlags: string[];
  conflictFlags: string[];
  expectedRoute: ClassificationRoute;
}

export interface ClassificationProfileDefinition {
  schemaVersion: "1.0";
  environment: "DEV";
  unknownDocumentRoute: "review_required";
  ambiguityRoute: "review_required";
  labels: ClassificationLabelDefinition[];
  evaluationCases: ClassificationEvaluationCase[];
}

export interface ClassificationProfileDifference {
  path: string;
  before: unknown;
  after: unknown;
  kind: "added" | "removed" | "changed";
}

export interface OpsClassificationProfileVersion {
  id: string;
  profileId: string;
  profileKey: string;
  profileDisplayName: string;
  profileDescription: string;
  version: number;
  revision: number;
  status: "draft" | "in_review" | "published" | "retired";
  definition: ClassificationProfileDefinition;
  definitionHash: string;
  reason: string;
  createdByName: string | null;
  createdAt: string;
  publishedAt: string | null;
  isLatestRevision: boolean;
  isCurrentPublished: boolean;
  hasPassingEvaluation: boolean;
  differencesFromPublished: ClassificationProfileDifference[];
}

export interface OpsClassificationProfileEvaluationRun {
  id: string;
  profileId: string;
  profileVersionId: string;
  definitionHash: string;
  result: Record<string, unknown>;
  status: "passed" | "failed";
  runByName: string;
  reason: string;
  createdAt: string;
}

export interface OpsClassificationProfileSnapshot {
  generatedAt: string;
  canManage: boolean;
  versions: OpsClassificationProfileVersion[];
  evaluationRuns: OpsClassificationProfileEvaluationRun[];
  qualityFlags: string[];
  conflictFlags: string[];
}

export type OpsClassificationProfileMutationResult = Record<string, unknown> & {
  outcome: "completed" | "duplicate" | "conflict" | "not_found";
  reason?: string;
};

export interface OpsClassificationProfileRepository {
  getProfile(organizationKey: string, actorId: string, now: Date): Promise<OpsClassificationProfileSnapshot>;
  cloneVersion(organizationKey: string, request: {
    actorId: string;
    versionId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsClassificationProfileMutationResult>;
  updateDraft(organizationKey: string, request: {
    actorId: string;
    versionId: string;
    definition: ClassificationProfileDefinition;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsClassificationProfileMutationResult>;
  runEvaluation(organizationKey: string, request: {
    actorId: string;
    versionId: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsClassificationProfileMutationResult>;
  transitionVersion(organizationKey: string, request: {
    actorId: string;
    versionId: string;
    action: "submit_review" | "return_to_draft" | "publish";
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsClassificationProfileMutationResult>;
}
