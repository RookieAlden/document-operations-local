import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MODEL_OUTPUT_SCHEMA_HASH } from "../src/adapters/openai/openai-classification-provider.js";
import { OpenAIClassificationError } from "../src/adapters/openai/openai-classification-provider.js";
import {
  ClassifyDocument,
  decideClassification,
  effectiveConflictFlags,
} from "../src/application/classify-document.js";
import type {
  ClassificationProvider,
  ClassificationProviderResult,
} from "../src/ports/classification-provider.js";
import type {
  ClassificationDocumentType,
  ClassificationWorkContext,
  ClassificationWorkRepository,
  CompleteClassificationWorkRequest,
  FailClassificationWorkRequest,
  ReserveClassificationWorkResult,
} from "../src/ports/classification-work-repository.js";
import type { DocumentSourceResolver } from "../src/ports/document-source-resolver.js";

const PROMPT = "classify synthetic documents";
const MODEL = "gpt-5.6";
const NOW = new Date("2026-08-07T00:00:00Z");

function documentType(overrides: Partial<ClassificationDocumentType> = {}): ClassificationDocumentType {
  return {
    id: "00000000-0000-4000-b000-000000003001",
    code: "bank_statement",
    displayName: "Bank Statement",
    minimumConfidence: 0.8,
    alwaysHumanConfirm: false,
    manualOnConflict: true,
    rejectOnQualityFlags: [],
    rejectOnConflictFlags: [],
    ...overrides,
  };
}

function context(overrides: Partial<ClassificationWorkContext> = {}): ClassificationWorkContext {
  return {
    reservationId: "reservation-1",
    reservationKey: "document.classify|document-1|release-version-1",
    organizationId: "organization-1",
    caseId: "case-1",
    documentId: "document-1",
    filename: "statement.pdf",
    declaredMimeType: "application/pdf",
    storageReference: "storage://incoming/statement.pdf",
    promptVersionId: "prompt-1",
    promptInstructionHash: createHash("sha256").update(PROMPT).digest("hex"),
    configuredModel: MODEL,
    promptInstructions: PROMPT,
    responseSchemaVersion: "1.0",
    responseSchemaHash: MODEL_OUTPUT_SCHEMA_HASH,
    maxOutputTokens: 1500,
    reasoningEffort: "low",
    classifierReleaseVersionId: "release-version-1",
    classifierReleaseDefinitionHash: "c".repeat(64),
    classificationProfileVersionId: "profile-version-1",
    classificationProfileDefinitionHash: "b".repeat(64),
    attemptNumber: 1,
    subjectReferences: ["dev-client-001", "Kauri Coast Cafe Limited"],
    expectedPeriod: "2026-07-01/2026-07-31",
    allowedDocumentTypes: [documentType()],
    ...overrides,
  };
}

function providerResult(overrides: Partial<ClassificationProviderResult["result"]> = {}): ClassificationProviderResult {
  return {
    result: {
      schema_version: "1.0",
      predicted_document_type_code: "bank_statement",
      confidence: 0.99,
      reason: "Statement period and transactions are visible.",
      detected_subject_references: ["Kauri Coast Cafe Limited"],
      detected_period: "2026-07",
      quality_flags: [],
      conflict_flags: [],
      extracted_fields: { account_last_four: "1234" },
      evidence: [{ label: "period", value: "July 2026", page: 1 }],
      ...overrides,
    },
    audit: {
      provider: "openai",
      responseId: "resp_test",
      model: "gpt-5.6-sol",
      inputTokens: 100,
      outputTokens: 50,
    },
  };
}

class FakeRepository implements ClassificationWorkRepository {
  reserveResult: ReserveClassificationWorkResult = { outcome: "acquired", context: context() };
  completed: CompleteClassificationWorkRequest[] = [];
  failed: FailClassificationWorkRequest[] = [];
  completeError?: Error;

  async reserve(): Promise<ReserveClassificationWorkResult> {
    return this.reserveResult;
  }
  async complete(request: CompleteClassificationWorkRequest): Promise<void> {
    if (this.completeError) throw this.completeError;
    this.completed.push(request);
  }
  async fail(request: FailClassificationWorkRequest): Promise<void> {
    this.failed.push(request);
  }
}

function harness(result = providerResult()) {
  const repository = new FakeRepository();
  const sourceResolver: DocumentSourceResolver = {
    resolve: vi.fn(async () => ({ kind: "file_id" as const, fileId: "file_test" })),
  };
  const provider: ClassificationProvider = { classify: vi.fn(async () => result) };
  const useCase = new ClassifyDocument(repository, sourceResolver, provider, {
    environment: "DEV",
    organizationKey: "dev-accounting-firm",
    prompt: PROMPT,
    providerModel: MODEL,
  });
  return { repository, sourceResolver, provider, useCase };
}

describe("ClassifyDocument", () => {
  it("accepts a high-confidence clean classification atomically", async () => {
    const { repository, provider, useCase } = harness();
    const result = await useCase.execute({
      documentId: "document-1", workerId: "worker-1", now: NOW,
    });
    expect(result).toMatchObject({
      outcome: "accepted",
      predictedDocumentTypeCode: "bank_statement",
      confidence: 0.99,
      reviewReasons: [],
      issueId: null,
    });
    expect(provider.classify).toHaveBeenCalledOnce();
    expect(repository.completed).toHaveLength(1);
    expect(repository.completed[0]?.decision).toEqual({
      status: "accepted",
      acceptedDocumentTypeId: "00000000-0000-4000-b000-000000003001",
      reviewReasons: [],
    });
    expect(repository.failed).toHaveLength(0);
  });

  it("routes conflicts to a review issue", async () => {
    const { repository, useCase } = harness(providerResult({
      detected_period: "2026-06",
      conflict_flags: ["period_conflict"],
    }));
    const result = await useCase.execute({ documentId: "document-1", workerId: "worker-1", now: NOW });
    expect(result).toMatchObject({
      outcome: "review_required",
      reviewReasons: ["conflict_flags_present"],
    });
    expect(repository.completed[0]?.issueId).toBeTruthy();
    expect(repository.completed[0]?.reviewEventId).toBeTruthy();
  });

  it("accepts equivalent period representations while preserving the model flag for audit", async () => {
    const originalProviderResult = providerResult({
      detected_period: "2026-07-01/2026-07-31",
      conflict_flags: ["period_conflict"],
    });
    const { repository, useCase } = harness(originalProviderResult);

    const result = await useCase.execute({ documentId: "document-1", workerId: "worker-1", now: NOW });

    expect(result).toMatchObject({ outcome: "accepted", reviewReasons: [] });
    expect(repository.completed[0]?.decision.status).toBe("accepted");
    expect(repository.completed[0]?.providerResult.result.conflict_flags).toEqual(["period_conflict"]);
    expect(originalProviderResult.result.conflict_flags).toEqual(["period_conflict"]);
  });

  it("keeps policy-controlled document types in human review", async () => {
    const { repository, useCase } = harness();
    repository.reserveResult = {
      outcome: "acquired",
      context: context({ allowedDocumentTypes: [documentType({ alwaysHumanConfirm: true })] }),
    };
    const result = await useCase.execute({ documentId: "document-1", workerId: "worker-1", now: NOW });
    expect(result).toMatchObject({
      outcome: "review_required",
      reviewReasons: ["policy_requires_human_confirmation"],
    });
  });

  it("fails closed when the subject-level statistical quality gate has not certified the type", async () => {
    const { repository, useCase } = harness();
    repository.reserveResult = {
      outcome: "acquired",
      context: context({ allowedDocumentTypes: [documentType({ qualityGateRequiresHuman: true })] }),
    };
    const result = await useCase.execute({ documentId: "document-1", workerId: "worker-1", now: NOW });
    expect(result).toMatchObject({
      outcome: "review_required",
      reviewReasons: ["classification_quality_gate_requires_human"],
    });
  });

  it("routes low confidence and quality flags to review", async () => {
    const { repository, useCase } = harness(providerResult({
      confidence: 0.5,
      quality_flags: ["partial"],
    }));
    const result = await useCase.execute({ documentId: "document-1", workerId: "worker-1", now: NOW });
    expect(result).toMatchObject({
      outcome: "review_required",
      reviewReasons: ["low_confidence", "quality_flags_present"],
    });
    expect(repository.completed).toHaveLength(1);
  });

  it("fails closed before provider use when the prompt hash differs", async () => {
    const { repository, provider, useCase } = harness();
    repository.reserveResult = {
      outcome: "acquired",
      context: context({ promptInstructionHash: "0".repeat(64) }),
    };
    const result = await useCase.execute({ documentId: "document-1", workerId: "worker-1", now: NOW });
    expect(result).toMatchObject({ outcome: "failed_manual", errorCode: "prompt_hash_mismatch" });
    expect(provider.classify).not.toHaveBeenCalled();
    expect(repository.failed[0]).toMatchObject({
      failureMode: "manual",
      errorClass: "validation",
      errorCode: "prompt_hash_mismatch",
    });
  });

  it("marks provider outages recoverable without exposing provider details", async () => {
    const { repository, provider, useCase } = harness();
    vi.mocked(provider.classify).mockRejectedValue(Object.assign(new Error("secret provider body"), {
      code: "provider_error",
    }));
    const result = await useCase.execute({ documentId: "document-1", workerId: "worker-1", now: NOW });
    expect(result).toEqual({
      outcome: "failed_recoverable",
      errorCode: "provider_error",
      issueId: null,
      retryScheduled: true,
      circuitOpen: false,
    });
    expect(repository.failed[0]).toMatchObject({
      failureMode: "recoverable",
      errorCode: "provider_error",
      retryScheduled: true,
      circuitOpen: false,
    });
    expect(JSON.stringify(repository.failed[0])).not.toContain("secret provider body");
  });

  it("local user-triggered provider failure never schedules a retry", async () => {
    const { repository, sourceResolver, provider } = harness();
    vi.mocked(provider.classify).mockRejectedValue(Object.assign(new Error("provider failed"), {code:"provider_error"}));
    const local = new ClassifyDocument(repository, sourceResolver, provider, {
      environment:"DEV", organizationKey:"dev-accounting-firm", prompt:PROMPT, providerModel:MODEL, automaticRetries:false,
    });
    const result = await local.execute({documentId:"document-1",workerId:"local-user",now:NOW});
    expect(result).toMatchObject({outcome:"failed_recoverable",retryScheduled:false});
    expect(repository.failed[0]).toMatchObject({retryScheduled:false});
    expect(provider.classify).toHaveBeenCalledOnce();
  });

  it("opens the circuit and suppresses retries when the OpenAI project spend limit is reached", async () => {
    const { repository, provider, useCase } = harness();
    vi.mocked(provider.classify).mockRejectedValue(new OpenAIClassificationError(
      "provider_error",
      "OpenAI classification request returned HTTP 429",
      429,
      "project_spend_limit_exceeded",
      "insufficient_quota",
    ));

    const result = await useCase.execute({ documentId: "document-1", workerId: "worker-1", now: NOW });

    expect(result).toEqual({
      outcome: "failed_recoverable",
      errorCode: "project_spend_limit_exceeded",
      issueId: null,
      retryScheduled: false,
      circuitOpen: true,
    });
    expect(repository.failed[0]).toMatchObject({
      failureMode: "recoverable",
      errorCode: "project_spend_limit_exceeded",
      retryScheduled: false,
      circuitOpen: true,
      safeDetails: {
        provider_status_code: 429,
        provider_code: "project_spend_limit_exceeded",
        provider_type: "insufficient_quota",
      },
    });
  });

  it("stops automatic retries after three transient provider attempts", async () => {
    const { repository, provider, useCase } = harness();
    repository.reserveResult = { outcome: "acquired", context: context({ attemptNumber: 3 }) };
    vi.mocked(provider.classify).mockRejectedValue(new OpenAIClassificationError(
      "provider_error",
      "OpenAI classification request returned HTTP 503",
      503,
      "server_error",
      "server_error",
    ));

    await expect(useCase.execute({ documentId: "document-1", workerId: "worker-1", now: NOW }))
      .resolves.toMatchObject({
        outcome: "failed_recoverable",
        retryScheduled: false,
        circuitOpen: false,
      });
    expect(repository.failed[0]).toMatchObject({ retryScheduled: false, circuitOpen: false });
  });

  it("does not resolve or classify a duplicate reservation", async () => {
    const { repository, sourceResolver, provider, useCase } = harness();
    repository.reserveResult = { outcome: "duplicate", classificationAttemptId: "attempt-existing" };
    const result = await useCase.execute({ documentId: "document-1", workerId: "worker-1", now: NOW });
    expect(result).toEqual({ outcome: "duplicate", classificationAttemptId: "attempt-existing" });
    expect(sourceResolver.resolve).not.toHaveBeenCalled();
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it("leaves a database completion failure for lease recovery instead of writing a false provider failure", async () => {
    const { repository, useCase } = harness();
    repository.completeError = new Error("database unavailable");
    await expect(useCase.execute({
      documentId: "document-1", workerId: "worker-1", now: NOW,
    })).rejects.toThrow("database unavailable");
    expect(repository.failed).toHaveLength(0);
  });
});

describe("classification policy", () => {
  it("only removes period conflict when supported calendar bounds are equal", () => {
    expect(effectiveConflictFlags(
      "2026-Q3",
      "2026-07-01/2026-09-30",
      ["period_conflict", "subject_conflict"],
    )).toEqual(["subject_conflict"]);
    expect(effectiveConflictFlags(
      "2026-07",
      "2026-06",
      ["period_conflict"],
    )).toEqual(["period_conflict"]);
    expect(effectiveConflictFlags(
      "July 2026",
      "2026-07",
      ["period_conflict"],
    )).toEqual(["period_conflict"]);
  });

  it("deduplicates overlapping review reasons", () => {
    expect(decideClassification(documentType({
      rejectOnQualityFlags: ["partial"],
      rejectOnConflictFlags: ["period_conflict"],
    }), {
      confidence: 0.7,
      quality_flags: ["partial"],
      conflict_flags: ["period_conflict"],
    })).toEqual({
      status: "review_required",
      acceptedDocumentTypeId: "00000000-0000-4000-b000-000000003001",
      reviewReasons: [
        "low_confidence",
        "quality_flags_present",
        "conflict_flags_present",
        "quality_rule_matched",
        "conflict_rule_matched",
      ],
    });
  });
});
