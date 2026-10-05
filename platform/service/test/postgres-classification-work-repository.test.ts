import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { MODEL_OUTPUT_SCHEMA_HASH } from "../src/adapters/openai/openai-classification-provider.js";
import {
  formatPeriod,
  PostgresClassificationWorkRepository,
} from "../src/adapters/postgres/postgres-classification-work-repository.js";
import type {
  ClassificationWorkContext,
  CompleteClassificationWorkRequest,
  FailClassificationWorkRequest,
} from "../src/ports/classification-work-repository.js";

interface FakeResult {
  rowCount: number;
  rows: Array<Record<string, unknown>>;
}

class ClassificationFakeClient {
  readonly statements: string[] = [];
  readonly parameters: unknown[][] = [];
  failOn?: string;
  duplicate = false;

  async query(text: string, values: unknown[] = []): Promise<FakeResult> {
    const normalized = text.replace(/\s+/g, " ").trim();
    this.statements.push(normalized);
    this.parameters.push(values);
    if (this.failOn && normalized.includes(this.failOn)) throw new Error("simulated classification DB failure");
    if (normalized.startsWith("SELECT dop_set_organization_context($1) AS id")) {
      return { rowCount: 1, rows: [{ id: "organization-1" }] };
    }
    if (normalized.startsWith("SELECT d.organization_id")) {
      return {
        rowCount: 1,
        rows: [{
          organization_id: "organization-1",
          case_id: "case-1",
          subject_id: "subject-1",
          document_id: "document-1",
          original_filename: "statement.pdf",
          declared_mime_type: "application/pdf",
          incoming_storage_ref: "storage://incoming/statement.pdf",
          prompt_version_id: "prompt-1",
          instruction_hash: "a".repeat(64),
          configured_model: "gpt-5.6",
          classifier_release_version_id: "release-version-1",
          classifier_release_definition_hash: "c".repeat(64),
          classifier_release_prompt_version_id: "prompt-1",
          classifier_release_status: "published",
          classifier_release_definition: {
            model: "gpt-5.6",
            promptInstructions: "Synthetic classification prompt for the governed release boundary.",
            promptInstructionHash: "a".repeat(64),
            classificationProfileVersionId: "profile-version-1",
            classificationProfileDefinitionHash: "b".repeat(64),
            responseSchemaVersion: "1.0",
            responseSchemaHash: MODEL_OUTPUT_SCHEMA_HASH,
            requestPolicy: { maxOutputTokens: 1500, reasoningEffort: "low" },
          },
          subject_key: "dev-client-001",
          subject_display_name: "Kauri Coast Cafe Limited",
          period_start: "2026-07-01",
          period_end: "2026-07-31",
        }],
      };
    }
    if (normalized.startsWith("SELECT version.id AS version_id")) {
      return { rowCount: 1, rows: [{
        version_id: "profile-version-1",
        definition_hash: "b".repeat(64),
        definition: { labels: [{ code: "bank_statement" }] },
      }] };
    }
    if (normalized.startsWith("INSERT INTO idempotency_reservations")) {
      return this.duplicate
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{ id: "reservation-1" }] };
    }
    if (normalized.startsWith("SELECT status, lease_expires_at, resource_id")) {
      return {
        rowCount: 1,
        rows: [{ status: "completed", lease_expires_at: null, resource_id: "attempt-existing" }],
      };
    }
    if (normalized.startsWith("SELECT COALESCE(MAX(attempt_number)")) {
      return { rowCount: 1, rows: [{ attempt_number: 2 }] };
    }
    if (normalized.startsWith("SELECT document_type.id, document_type.code, document_type.display_name")) {
      return {
        rowCount: 1,
        rows: [{
          id: "document-type-1",
          code: "bank_statement",
          display_name: "Bank Statement",
          description: "Synthetic bank statement classification definition.",
          extraction_schema: { type: "object", properties: { account_number: { type: "string" } } },
          classification_rules: {
            minimum_confidence: 0.8,
            manual_on_conflict: true,
            reject_on_quality_flags: ["partial"],
          },
          quality_gate_requires_human: false,
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  }

  release(): void {}
}

function poolFor(client: ClassificationFakeClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

function context(): ClassificationWorkContext {
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
    promptInstructionHash: "a".repeat(64),
    configuredModel: "gpt-5.6",
    promptInstructions: "Synthetic classification prompt for the governed release boundary.",
    responseSchemaVersion: "1.0",
    responseSchemaHash: MODEL_OUTPUT_SCHEMA_HASH,
    maxOutputTokens: 1500,
    reasoningEffort: "low",
    classifierReleaseVersionId: "release-version-1",
    classifierReleaseDefinitionHash: "c".repeat(64),
    classificationProfileVersionId: "profile-version-1",
    classificationProfileDefinitionHash: "b".repeat(64),
    attemptNumber: 2,
    subjectReferences: ["dev-client-001", "Kauri Coast Cafe Limited"],
    expectedPeriod: "2026-07-01/2026-07-31",
    allowedDocumentTypes: [{
      id: "document-type-1",
      code: "bank_statement",
      displayName: "Bank Statement",
      minimumConfidence: 0.8,
      alwaysHumanConfirm: false,
      qualityGateRequiresHuman: false,
      manualOnConflict: true,
      rejectOnQualityFlags: ["partial"],
      rejectOnConflictFlags: [],
    }],
  };
}

function completeRequest(review = false): CompleteClassificationWorkRequest {
  return {
    context: context(),
    providerResult: {
      result: {
        schema_version: "1.0",
        predicted_document_type_code: "bank_statement",
        confidence: 0.99,
        reason: "Statement period is visible.",
        detected_subject_references: ["Kauri Coast Cafe Limited"],
        detected_period: "2026-07",
        quality_flags: [],
        conflict_flags: review ? ["period_conflict"] : [],
        extracted_fields: {},
        evidence: [],
      },
      audit: {
        provider: "openai",
        responseId: "resp-test",
        model: "gpt-5.6-sol",
        inputTokens: 100,
        outputTokens: 50,
      },
    },
    decision: {
      status: review ? "review_required" : "accepted",
      acceptedDocumentTypeId: "document-type-1",
      reviewReasons: review ? ["conflict_flags_present"] : [],
    },
    classificationAttemptId: "attempt-2",
    workflowRunId: "run-2",
    classifiedEventId: "event-classified-2",
    ...(review ? { issueId: "issue-2", reviewEventId: "event-review-2" } : {}),
    correlationId: "correlation-2",
    environment: "DEV",
    now: new Date("2026-08-07T00:00:00Z"),
  };
}

function failRequest(mode: "recoverable" | "manual"): FailClassificationWorkRequest {
  return {
    context: context(),
    classificationAttemptId: "attempt-failed-2",
    workflowRunId: "run-failed-2",
    workflowErrorId: "error-2",
    ...(mode === "manual" ? { issueId: "issue-failed-2" } : {}),
    eventId: "event-failed-2",
    correlationId: "correlation-2",
    environment: "DEV",
    failureMode: mode,
    retryScheduled: mode === "recoverable",
    circuitOpen: false,
    errorCode: mode === "manual" ? "provider_refusal" : "provider_error",
    errorClass: "provider",
    now: new Date("2026-08-07T00:00:00Z"),
  };
}

describe("PostgresClassificationWorkRepository", () => {
  it("reserves one prompt-bound classification lease and loads tenant context", async () => {
    const client = new ClassificationFakeClient();
    const repository = new PostgresClassificationWorkRepository(poolFor(client));
    const result = await repository.reserve({
      organizationKey: "dev-accounting-firm",
      documentId: "document-1",
      workerId: "worker-1",
      leaseSeconds: 300,
      now: new Date("2026-08-07T00:00:00Z"),
    });
    expect(result).toMatchObject({
      outcome: "acquired",
      context: {
        reservationKey: "document.classify|document-1|release-version-1",
        attemptNumber: 2,
        subjectReferences: ["dev-client-001", "Kauri Coast Cafe Limited"],
        expectedPeriod: "2026-07",
        allowedDocumentTypes: [{
          code: "bank_statement",
          minimumConfidence: 0.8,
          manualOnConflict: true,
          rejectOnQualityFlags: ["partial"],
        }],
      },
    });
    expect(client.statements[0]).toBe("BEGIN");
    const profileQuery = client.statements.find((sql) => sql.startsWith("SELECT version.id AS version_id")) ?? "";
    expect(profileQuery).not.toContain("FOR SHARE");
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("normalizes full calendar months and quarters but preserves custom ranges", () => {
    expect(formatPeriod("2026-07-01", "2026-07-31")).toBe("2026-07");
    expect(formatPeriod("2026-04-01", "2026-06-30")).toBe("2026-Q2");
    expect(formatPeriod("2026-07-05", "2026-07-20")).toBe("2026-07-05/2026-07-20");
    expect(formatPeriod(new Date(2026, 6, 1), new Date(2026, 6, 31))).toBe("2026-07");
  });

  it("returns a completed prompt-bound attempt as a duplicate", async () => {
    const client = new ClassificationFakeClient();
    client.duplicate = true;
    const repository = new PostgresClassificationWorkRepository(poolFor(client));
    const result = await repository.reserve({
      organizationKey: "dev-accounting-firm",
      documentId: "document-1",
      workerId: "worker-1",
      leaseSeconds: 300,
      now: new Date("2026-08-07T00:00:00Z"),
    });
    expect(result).toEqual({ outcome: "duplicate", classificationAttemptId: "attempt-existing" });
    expect(client.statements.some((sql) => sql.startsWith("SELECT COALESCE(MAX(attempt_number)"))).toBe(false);
  });

  it("commits classification, document state, review issue, events and reservation together", async () => {
    const client = new ClassificationFakeClient();
    const repository = new PostgresClassificationWorkRepository(poolFor(client));
    await repository.complete(completeRequest(true));
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO classification_attempts"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("UPDATE documents"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO issues"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO workflow_runs"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("UPDATE workflow_errors") && sql.includes("classification_retry_succeeded"))).toBe(true);
    expect(client.statements.filter((sql) => sql.startsWith("INSERT INTO workflow_events"))).toHaveLength(2);
    expect(client.parameters.flat()).toContain("document-classified|document-1|prompt-1|2");
    expect(client.parameters.flat()).toContain("document-review-required|document-1|prompt-1|2");
    expect(client.statements.some((sql) => sql.startsWith("UPDATE idempotency_reservations"))).toBe(true);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("records recoverable provider failures without opening a manual issue", async () => {
    const client = new ClassificationFakeClient();
    const repository = new PostgresClassificationWorkRepository(poolFor(client));
    await repository.fail(failRequest("recoverable"));
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO workflow_errors"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("UPDATE workflow_errors previous_error") &&
      sql.includes("superseded_by_classification_attempt"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO issues"))).toBe(false);
    expect(client.statements.some((sql) => sql.startsWith("UPDATE idempotency_reservations"))).toBe(true);
    expect(client.statements.some((sql) => sql.includes("THEN $6::timestamptz"))).toBe(true);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("consolidates quota failures into one non-retryable audited workflow error", async () => {
    const client = new ClassificationFakeClient();
    const repository = new PostgresClassificationWorkRepository(poolFor(client));
    await repository.fail({
      ...failRequest("recoverable"),
      errorCode: "project_spend_limit_exceeded",
      retryScheduled: false,
      circuitOpen: true,
      safeDetails: { provider_status_code: 429, provider_code: "project_spend_limit_exceeded" },
    });

    const insertIndex = client.statements.findIndex((sql) => sql.startsWith("INSERT INTO workflow_errors"));
    expect(insertIndex).toBeGreaterThan(-1);
    expect(client.parameters[insertIndex]).toContain("waiting_manual");
    expect(client.parameters[insertIndex]).toContain(1);
    expect(client.parameters[insertIndex]).toContain(null);
    const safeDetails = JSON.parse(String(client.parameters[insertIndex]?.[9])) as Record<string, unknown>;
    expect(safeDetails).toMatchObject({
      circuit_open: true,
      retry_scheduled: false,
      provider_status_code: 429,
      provider_code: "project_spend_limit_exceeded",
    });
  });

  it("rolls back every classification write when review issue persistence fails", async () => {
    const client = new ClassificationFakeClient();
    client.failOn = "INSERT INTO issues";
    const repository = new PostgresClassificationWorkRepository(poolFor(client));
    await expect(repository.complete(completeRequest(true))).rejects.toThrow("simulated classification DB failure");
    expect(client.statements).toContain("ROLLBACK");
    expect(client.statements).not.toContain("COMMIT");
  });
});
