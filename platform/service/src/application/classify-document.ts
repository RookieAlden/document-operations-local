import { createHash, randomUUID } from "node:crypto";
import { ContractValidator } from "../contracts/json-schema-validator.js";
import type { Environment } from "../domain/submission.js";
import {
  classificationSchemaHash,
  CANDIDATE_SCHEMA_VERSION,
  OpenAIClassificationError,
} from "../adapters/openai/openai-classification-provider.js";
import type { ClassificationProvider } from "../ports/classification-provider.js";
import type {
  ClassificationDecision,
  ClassificationDocumentType,
  ClassificationWorkContext,
  ClassificationWorkRepository,
} from "../ports/classification-work-repository.js";
import type { DocumentSourceResolver } from "../ports/document-source-resolver.js";

export interface ClassifyDocumentScope {
  environment: Environment;
  organizationKey: string;
  prompt: string;
  providerModel: string;
  /** Only the credential-free local candidate harness opts in. Runtime workers default off. */
  allowCandidateAbstention?: boolean;
  automaticRetries?: boolean;
}

export interface ClassifyDocumentCommand {
  documentId: string;
  workerId: string;
  correlationId?: string;
  now?: Date;
}

export type ClassifyDocumentResult =
  | {
      outcome: "accepted" | "review_required";
      classificationAttemptId: string;
      predictedDocumentTypeCode: string | null;
      confidence: number;
      reviewReasons: string[];
      issueId: string | null;
    }
  | { outcome: "duplicate"; classificationAttemptId: string | null }
  | { outcome: "in_progress"; leaseExpiresAt: Date | null }
  | { outcome: "not_found"; resource: "organization" | "document" | "prompt_version" | "classification_profile" | "classifier_release" }
  | {
      outcome: "failed_recoverable" | "failed_manual";
      errorCode: string;
      issueId: string | null;
      retryScheduled: boolean;
      circuitOpen: boolean;
    };

export const MAX_AUTOMATIC_CLASSIFICATION_ATTEMPTS = 3;

const QUOTA_CIRCUIT_CODES = new Set([
  "project_spend_limit_exceeded",
  "organization_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "billing_hard_limit_reached",
  "credit_balance_exhausted",
  "insufficient_quota",
]);

export class ClassifyDocument {
  private readonly contractValidator = new ContractValidator();
  constructor(
    private readonly repository: ClassificationWorkRepository,
    private readonly sourceResolver: DocumentSourceResolver,
    private readonly provider: ClassificationProvider,
    private readonly scope: ClassifyDocumentScope,
  ) {}

  async execute(command: ClassifyDocumentCommand): Promise<ClassifyDocumentResult> {
    const now = command.now ?? new Date();
    const correlationId = command.correlationId ?? randomUUID();
    const reserved = await this.repository.reserve({
      organizationKey: this.scope.organizationKey,
      documentId: command.documentId,
      workerId: command.workerId,
      leaseSeconds: 300,
      now,
    });
    if (reserved.outcome !== "acquired") return reserved;

    const context = reserved.context;
    if (context.promptInstructionHash !== createHash("sha256").update(context.promptInstructions).digest("hex")) {
      return this.fail(context, correlationId, now, "manual", "prompt_hash_mismatch", "validation");
    }
    if (classificationSchemaHash(context.responseSchemaVersion) === null ||
        context.responseSchemaHash !== classificationSchemaHash(context.responseSchemaVersion) ||
        (context.responseSchemaVersion === CANDIDATE_SCHEMA_VERSION && !this.scope.allowCandidateAbstention)) {
      return this.fail(context, correlationId, now, "manual", "response_schema_mismatch", "validation");
    }

    let providerResult;
    try {
      const source = await this.sourceResolver.resolve({
        documentId: context.documentId,
        storageReference: context.storageReference,
        filename: context.filename,
        declaredMimeType: context.declaredMimeType,
      });
      providerResult = await this.provider.classify({
        documentId: context.documentId,
        filename: context.filename,
        declaredMimeType: context.declaredMimeType,
        allowedDocumentTypes: context.allowedDocumentTypes.map((item) => ({
          code: item.code,
          displayName: item.displayName,
          ...(item.description ? { description: item.description } : {}),
        })),
        source,
        expectedSubjectReferences: context.subjectReferences,
        expectedPeriod: context.expectedPeriod,
        execution: {
          model: context.configuredModel,
          prompt: context.promptInstructions,
          promptInstructionHash: context.promptInstructionHash,
          responseSchemaVersion: context.responseSchemaVersion,
          responseSchemaHash: context.responseSchemaHash,
          maxOutputTokens: context.maxOutputTokens,
          reasoningEffort: context.reasoningEffort,
        },
      });
    } catch (error) {
      const failure = classificationFailure(error, context.attemptNumber);
      return this.fail(
        context,
        correlationId,
        now,
        failure.failureMode,
        failure.errorCode,
        failure.errorCode === "source_unavailable" ? "connector" : "provider",
        {
          retryScheduled: failure.retryScheduled,
          circuitOpen: failure.circuitOpen,
          ...(failure.safeDetails ? { safeDetails: failure.safeDetails } : {}),
        },
      );
    }

    if (!this.contractValidator.validateClassificationResult(providerResult.result).ok) {
      return this.fail(context, correlationId, now, "manual", "invalid_classification", "validation");
    }
    const documentType = context.allowedDocumentTypes.find(
      (item) => item.code === providerResult.result.predicted_document_type_code,
    );
    if (providerResult.result.schema_version !== context.responseSchemaVersion) {
      return this.fail(context, correlationId, now, "manual", "response_schema_mismatch", "validation");
    }
    const abstaining = providerResult.result.schema_version === CANDIDATE_SCHEMA_VERSION &&
      ["unknown", "insufficient_evidence"].includes(providerResult.result.classification_outcome ?? "") &&
      providerResult.result.predicted_document_type_code === null;
    if (!documentType && !abstaining) {
      return this.fail(context, correlationId, now, "manual", "document_type_not_allowed", "validation");
    }
    const effectiveFlags = context.responseSchemaVersion === CANDIDATE_SCHEMA_VERSION
      ? candidateConflictFlags(context.expectedPeriod, providerResult.result.detected_period, providerResult.result.conflict_flags)
      : effectiveConflictFlags(context.expectedPeriod, providerResult.result.detected_period, providerResult.result.conflict_flags);
    const evidence = { ...providerResult.result, conflict_flags: effectiveFlags };
    const decision = abstaining ? decideAbstention(evidence) : decideClassification(documentType!, evidence);
    if (context.responseSchemaVersion === CANDIDATE_SCHEMA_VERSION) {
      decision.effectiveConflictFlags = effectiveFlags;
      if (effectiveFlags.length > 0) {
        decision.status = "review_required";
        decision.reviewReasons = [...new Set([...decision.reviewReasons, "conflict_flags_present", ...effectiveFlags])];
      }
    }
    const classificationAttemptId = randomUUID();
    const issueId = decision.status === "review_required" ? randomUUID() : undefined;
    await this.repository.complete({
      context,
      providerResult,
      decision,
      classificationAttemptId,
      workflowRunId: randomUUID(),
      classifiedEventId: randomUUID(),
      ...(issueId ? { issueId, reviewEventId: randomUUID() } : {}),
      correlationId,
      environment: this.scope.environment,
      now,
    });
    return {
      outcome: decision.status,
      classificationAttemptId,
      predictedDocumentTypeCode: providerResult.result.predicted_document_type_code,
      confidence: providerResult.result.confidence,
      reviewReasons: decision.reviewReasons,
      issueId: issueId ?? null,
    };
  }

  private async fail(
    context: ClassificationWorkContext,
    correlationId: string,
    now: Date,
    failureMode: "recoverable" | "manual",
    errorCode: string,
    errorClass: "connector" | "provider" | "validation" | "unknown",
    options: {
      retryScheduled?: boolean;
      circuitOpen?: boolean;
      safeDetails?: Record<string, string | number | boolean | null>;
    } = {},
  ): Promise<ClassifyDocumentResult> {
    const issueId = failureMode === "manual" ? randomUUID() : undefined;
    const retryScheduled = this.scope.automaticRetries !== false && failureMode === "recoverable" && (options.retryScheduled ?? true);
    const circuitOpen = options.circuitOpen ?? false;
    await this.repository.fail({
      context,
      classificationAttemptId: randomUUID(),
      workflowRunId: randomUUID(),
      workflowErrorId: randomUUID(),
      ...(issueId ? { issueId } : {}),
      eventId: randomUUID(),
      correlationId,
      environment: this.scope.environment,
      failureMode,
      retryScheduled,
      circuitOpen,
      errorCode,
      errorClass,
      ...(options.safeDetails ? { safeDetails: options.safeDetails } : {}),
      now,
    });
    return {
      outcome: failureMode === "manual" ? "failed_manual" : "failed_recoverable",
      errorCode,
      issueId: issueId ?? null,
      retryScheduled,
      circuitOpen,
    };
  }
}

/**
 * A model may conservatively raise period_conflict even when two supported
 * representations describe the same accounting period. Keep its original
 * result for audit persistence, but use deterministic calendar bounds when
 * deciding whether the document needs human review.
 */
export function effectiveConflictFlags(
  expectedPeriod: string | null | undefined,
  detectedPeriod: string | null | undefined,
  conflictFlags: string[],
): string[] {
  if (!conflictFlags.includes("period_conflict")) return conflictFlags;

  const expectedBounds = periodBounds(expectedPeriod);
  const detectedBounds = periodBounds(detectedPeriod);
  if (!expectedBounds || !detectedBounds || expectedBounds !== detectedBounds) return conflictFlags;

  return conflictFlags.filter((flag) => flag !== "period_conflict");
}

/** Candidate only: add a conflict only when inclusive date ranges are disjoint.
 * A quarterly Case can contain monthly statements. Containment, partial overlap,
 * and unreadable dates do not prove irrelevance; preserve any model flags for review.
 */
export function candidateConflictFlags(expected: string | null | undefined, detected: string | null | undefined, flags: string[]): string[] {
  const a = periodBounds(expected), b = periodBounds(detected);
  let disjoint = false;
  if (a && b) {
    const [expectedStart, expectedEnd] = a.split("/") as [string, string];
    const [detectedStart, detectedEnd] = b.split("/") as [string, string];
    disjoint = detectedEnd < expectedStart || detectedStart > expectedEnd;
  }
  return [...new Set([...flags, ...(disjoint ? ["period_conflict"] : [])])];
}

function periodBounds(period: string | null | undefined): string | null {
  if (!period) return null;

  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) {
    const year = Number(month[1]);
    const monthNumber = Number(month[2]);
    if (!validYear(year) || monthNumber < 1 || monthNumber > 12) return null;
    const start = isoDate(year, monthNumber, 1);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return `${start}/${isoDate(year, monthNumber, lastDay)}`;
  }

  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) {
    const year = Number(quarter[1]);
    const quarterNumber = Number(quarter[2]);
    if (!validYear(year)) return null;
    const firstMonth = (quarterNumber - 1) * 3 + 1;
    const lastMonth = firstMonth + 2;
    const lastDay = new Date(Date.UTC(year, lastMonth, 0)).getUTCDate();
    return `${isoDate(year, firstMonth, 1)}/${isoDate(year, lastMonth, lastDay)}`;
  }

  const range = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(period);
  if (range && validIsoDate(range[1]!) && validIsoDate(range[2]!) && range[1]! <= range[2]!) {
    return `${range[1]}/${range[2]}`;
  }

  return null;
}

function validYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1 && year <= 9999;
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!validYear(year) || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function decideAbstention(result: import("../contracts/json-schema-validator.js").ClassificationResult): ClassificationDecision {
  return { status: "review_required", acceptedDocumentTypeId: null,
    reviewReasons: [...new Set([`classification_${result.classification_outcome}`,
      `abstention_${result.abstention_reason}`, ...result.conflict_flags,
      ...(result.quality_flags.length ? ["quality_flags_present"] : [])])] };
}

export function decideClassification(
  documentType: ClassificationDocumentType,
  result: {
    confidence: number;
    quality_flags: string[];
    conflict_flags: string[];
  },
): ClassificationDecision {
  const reviewReasons: string[] = [];
  if (result.confidence < documentType.minimumConfidence) reviewReasons.push("low_confidence");
  if (documentType.alwaysHumanConfirm) reviewReasons.push("policy_requires_human_confirmation");
  if (documentType.qualityGateRequiresHuman) reviewReasons.push("classification_quality_gate_requires_human");
  if (result.quality_flags.length > 0) reviewReasons.push("quality_flags_present");
  if (documentType.manualOnConflict && result.conflict_flags.length > 0) {
    reviewReasons.push("conflict_flags_present");
  }
  if (result.quality_flags.some((flag) => documentType.rejectOnQualityFlags.includes(flag))) {
    reviewReasons.push("quality_rule_matched");
  }
  if (result.conflict_flags.some((flag) => documentType.rejectOnConflictFlags.includes(flag))) {
    reviewReasons.push("conflict_rule_matched");
  }
  return {
    status: reviewReasons.length === 0 ? "accepted" : "review_required",
    acceptedDocumentTypeId: documentType.id,
    reviewReasons: [...new Set(reviewReasons)],
  };
}

function codedError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "unknown_provider_error";
}

export function classificationFailure(
  error: unknown,
  attemptNumber: number,
): {
  failureMode: "recoverable" | "manual";
  errorCode: string;
  retryScheduled: boolean;
  circuitOpen: boolean;
  safeDetails?: Record<string, string | number | boolean | null>;
} {
  const genericCode = codedError(error);
  const manual = genericCode === "provider_refusal" || genericCode === "invalid_classification";
  if (manual) {
    return { failureMode: "manual", errorCode: genericCode, retryScheduled: false, circuitOpen: false };
  }

  if (error instanceof OpenAIClassificationError) {
    const providerCode = error.providerCode;
    const providerType = error.providerType;
    const quotaCode = providerCode && QUOTA_CIRCUIT_CODES.has(providerCode)
      ? providerCode
      : providerType && QUOTA_CIRCUIT_CODES.has(providerType)
        ? providerType
        : null;
    const safeDetails = {
      ...(error.statusCode !== undefined ? { provider_status_code: error.statusCode } : {}),
      ...(providerCode ? { provider_code: providerCode } : {}),
      ...(providerType ? { provider_type: providerType } : {}),
    };
    if (quotaCode) {
      return {
        failureMode: "recoverable",
        errorCode: quotaCode,
        retryScheduled: false,
        circuitOpen: true,
        safeDetails,
      };
    }
    return {
      failureMode: "recoverable",
      errorCode: genericCode,
      retryScheduled: attemptNumber < MAX_AUTOMATIC_CLASSIFICATION_ATTEMPTS,
      circuitOpen: false,
      safeDetails,
    };
  }

  return {
    failureMode: "recoverable",
    errorCode: genericCode,
    retryScheduled: attemptNumber < MAX_AUTOMATIC_CLASSIFICATION_ATTEMPTS,
    circuitOpen: false,
  };
}
