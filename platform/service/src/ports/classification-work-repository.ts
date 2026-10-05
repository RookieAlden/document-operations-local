import type { ClassificationResult } from "../contracts/json-schema-validator.js";
import type { Environment } from "../domain/submission.js";
import type { ClassificationProviderResult } from "./classification-provider.js";

export interface ClassificationDocumentType {
  id: string;
  code: string;
  displayName: string;
  description?: string;
  minimumConfidence: number;
  alwaysHumanConfirm: boolean;
  qualityGateRequiresHuman?: boolean;
  manualOnConflict: boolean;
  rejectOnQualityFlags: string[];
  rejectOnConflictFlags: string[];
}

export interface ClassificationWorkContext {
  reservationId: string;
  reservationKey: string;
  organizationId: string;
  caseId: string;
  documentId: string;
  filename: string;
  declaredMimeType: string;
  storageReference: string;
  promptVersionId: string;
  promptInstructionHash: string;
  configuredModel: string;
  promptInstructions: string;
  responseSchemaVersion: "1.0" | "2.0-candidate.1";
  responseSchemaHash: string;
  maxOutputTokens: number;
  reasoningEffort: "low" | "medium" | "high";
  classifierReleaseVersionId: string;
  classifierReleaseDefinitionHash: string;
  classificationProfileVersionId: string;
  classificationProfileDefinitionHash: string;
  attemptNumber: number;
  subjectReferences: string[];
  expectedPeriod: string | null;
  allowedDocumentTypes: ClassificationDocumentType[];
}

export interface ReserveClassificationWorkRequest {
  organizationKey: string;
  documentId: string;
  workerId: string;
  leaseSeconds: number;
  now: Date;
}

export type ReserveClassificationWorkResult =
  | { outcome: "acquired"; context: ClassificationWorkContext }
  | { outcome: "duplicate"; classificationAttemptId: string | null }
  | { outcome: "in_progress"; leaseExpiresAt: Date | null }
  | { outcome: "not_found"; resource: "organization" | "document" | "prompt_version" | "classification_profile" | "classifier_release" };

export interface ClassificationDecision {
  status: "accepted" | "review_required";
  acceptedDocumentTypeId: string | null;
  effectiveConflictFlags?: string[];
  reviewReasons: string[];
}

export interface CompleteClassificationWorkRequest {
  context: ClassificationWorkContext;
  providerResult: ClassificationProviderResult;
  decision: ClassificationDecision;
  classificationAttemptId: string;
  workflowRunId: string;
  classifiedEventId: string;
  reviewEventId?: string;
  issueId?: string;
  correlationId: string;
  environment: Environment;
  now: Date;
}

export interface FailClassificationWorkRequest {
  context: ClassificationWorkContext;
  classificationAttemptId: string;
  workflowRunId: string;
  workflowErrorId: string;
  issueId?: string;
  eventId: string;
  correlationId: string;
  environment: Environment;
  failureMode: "recoverable" | "manual";
  retryScheduled: boolean;
  circuitOpen: boolean;
  errorCode: string;
  errorClass: "connector" | "provider" | "validation" | "unknown";
  safeDetails?: Record<string, string | number | boolean | null>;
  now: Date;
}

export interface ClassificationWorkRepository {
  reserve(request: ReserveClassificationWorkRequest): Promise<ReserveClassificationWorkResult>;
  complete(request: CompleteClassificationWorkRequest): Promise<void>;
  fail(request: FailClassificationWorkRequest): Promise<void>;
}

export function classificationSummary(
  result: ClassificationResult,
  audit: ClassificationProviderResult["audit"],
  context?: Pick<ClassificationWorkContext, "classifierReleaseVersionId" | "classifierReleaseDefinitionHash">,
  effectiveConflictFlags?: string[],
): Record<string, unknown> {
  return {
    schema_version: result.schema_version,
    predicted_document_type_code: result.predicted_document_type_code,
    ...(result.schema_version === "2.0-candidate.1" ? { classification_outcome: result.classification_outcome, abstention_reason: result.abstention_reason } : {}),
    confidence: result.confidence,
    quality_flags: result.quality_flags,
    conflict_flags: effectiveConflictFlags ?? result.conflict_flags,
    ...(effectiveConflictFlags ? { model_conflict_flags: result.conflict_flags, effective_conflict_flags: effectiveConflictFlags } : {}),
    provider: audit.provider,
    model: audit.model,
    response_id: audit.responseId,
    ...(context ? {
      classifier_release_version_id: context.classifierReleaseVersionId,
      classifier_release_definition_hash: context.classifierReleaseDefinitionHash,
    } : {}),
  };
}
