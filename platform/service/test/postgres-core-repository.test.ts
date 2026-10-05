import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresCoreRepository } from "../src/adapters/postgres/postgres-core-repository.js";
import { ContractValidator } from "../src/contracts/json-schema-validator.js";
import type { CanonicalSubmission } from "../src/domain/submission.js";
import type { AcceptSubmissionRequest } from "../src/ports/submission-intake-repository.js";

interface FakeResult {
  rowCount: number;
  rows: Array<Record<string, unknown>>;
}

class FakeClient {
  readonly statements: string[] = [];
  failOn?: string;
  duplicate = false;
  sourceDuplicate = false;
  governed = false;
  admissionAllowed = true;
  admissionReason = "synthetic_subject_allowed";
  enforcementProfile: Record<string, unknown> = {
    capabilities: ["documents", "metadata", "webhook"],
    maxFilesPerSubmission: 5,
    maxFileBytes: 1_000_000,
    allowedMimeTypes: ["application/pdf"],
  };

  async query(text: string): Promise<FakeResult> {
    const normalized = text.replace(/\s+/g, " ").trim();
    this.statements.push(normalized);
    if (this.failOn && normalized.includes(this.failOn)) {
      throw new Error("simulated database failure");
    }
    if (normalized.startsWith("SELECT dop_set_organization_context($1) AS id")) {
      return { rowCount: 1, rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
    }
    if (normalized.startsWith("SELECT c.organization_id")) {
      return {
        rowCount: 1,
        rows: [{
          organization_id: "00000000-0000-4000-8000-000000000001",
          case_id: "00000000-0000-4000-d000-000000005001",
          ...(this.governed ? {
            source_connector_version_id: "00000000-0000-4000-e000-000000007001",
            source_connector_definition_hash: "a".repeat(64),
            source_connector_key: "fillout-dev-v1",
            connector_lifecycle_status: "active",
            connector_active_version_id: "00000000-0000-4000-e000-000000007001",
            connector_version_status: "active",
            connector_definition: { connectorType: "form" },
            connector_enforcement_profile: this.enforcementProfile,
          } : {}),
        }],
      };
    }
    if (normalized.startsWith("SELECT public.dop_evaluate_submission_data_admission")) {
      return {
        rowCount: 1,
        rows: [{ result: {
          allowed: this.admissionAllowed,
          reason: this.admissionReason,
          decisionId: "00000000-0000-4000-e000-000000006107",
          policyId: null,
        } }],
      };
    }
    if (normalized.startsWith("SELECT id FROM submissions")) {
      return this.sourceDuplicate
        ? { rowCount: 1, rows: [{ id: "00000000-0000-4000-e000-000000006109" }] }
        : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("INSERT INTO idempotency_reservations")) {
      return this.duplicate
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{ id: "00000000-0000-4000-e000-000000006001" }] };
    }
    if (normalized.startsWith("SELECT status, lease_expires_at, resource_id")) {
      return {
        rowCount: 1,
        rows: [{
          status: "completed",
          lease_expires_at: null,
          resource_id: "00000000-0000-4000-e000-000000006101",
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  }

  release(): void {}
}

function poolFor(client: FakeClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

function fixture(): CanonicalSubmission {
  const path = fileURLToPath(new URL("../../tests/fixtures/accounting-submission-dev-client-001.json", import.meta.url));
  const input = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const validated = new ContractValidator().validateSubmission(input);
  if (!validated.ok) {
    throw new Error("test fixture is invalid");
  }
  return validated.value;
}

function request(connectorKey?: string): AcceptSubmissionRequest {
  const submission = fixture();
  if (connectorKey) submission.source.connector_key = connectorKey;
  return {
    submission,
    submissionId: "00000000-0000-4000-e000-000000006101",
    submissionKey: "fillout|submission-dev-client-001-2026-07-001",
    correlationId: "00000000-0000-4000-e000-000000006102",
    workflowRunId: "00000000-0000-4000-e000-000000006103",
    submissionEventId: "00000000-0000-4000-e000-000000006104",
    documents: [{
      id: "00000000-0000-4000-e000-000000006105",
      idempotencyKey: "fillout|submission-dev-client-001-2026-07-001|file-dev-client-001-bank-001",
      file: submission.files[0]!,
      eventId: "00000000-0000-4000-e000-000000006106",
    }],
    workerId: "test-worker",
    leaseSeconds: 300,
    now: new Date("2026-08-06T10:00:00Z"),
  };
}

describe("PostgresCoreRepository atomic intake", () => {
  it("commits all intake records in one transaction", async () => {
    const client = new FakeClient();
    const repository = new PostgresCoreRepository(poolFor(client));

    const result = await repository.accept(request());

    expect(result).toMatchObject({ outcome: "accepted" });
    expect(client.statements[0]).toBe("BEGIN");
    expect(client.statements.at(-1)).toBe("COMMIT");
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO submissions"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO documents"))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO workflow_runs"))).toBe(true);
    expect(client.statements.filter((sql) => sql.startsWith("INSERT INTO workflow_events"))).toHaveLength(2);
    expect(client.statements.some((sql) => sql.startsWith("UPDATE idempotency_reservations"))).toBe(true);
  });

  it("rolls back the entire transaction when a document insert fails", async () => {
    const client = new FakeClient();
    client.failOn = "INSERT INTO documents";
    const repository = new PostgresCoreRepository(poolFor(client));

    await expect(repository.accept(request())).rejects.toThrow("simulated database failure");

    expect(client.statements).toContain("ROLLBACK");
    expect(client.statements).not.toContain("COMMIT");
  });

  it("returns an existing completed submission without writing another one", async () => {
    const client = new FakeClient();
    client.duplicate = true;
    const repository = new PostgresCoreRepository(poolFor(client));

    const result = await repository.accept(request());

    expect(result).toEqual({
      outcome: "duplicate",
      submissionId: "00000000-0000-4000-e000-000000006101",
    });
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO submissions"))).toBe(false);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("returns a provider source duplicate even when an older path used another internal key", async () => {
    const client = new FakeClient();
    client.sourceDuplicate = true;
    const repository = new PostgresCoreRepository(poolFor(client));

    const result = await repository.accept(request());

    expect(result).toEqual({
      outcome: "duplicate",
      submissionId: "00000000-0000-4000-e000-000000006109",
    });
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO idempotency_reservations"))).toBe(false);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO submissions"))).toBe(false);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("accepts an exact governed connector claim and writes intake provenance", async () => {
    const client = new FakeClient();
    client.governed = true;
    const repository = new PostgresCoreRepository(poolFor(client));

    const result = await repository.accept(request("fillout-dev-v1"));

    expect(result).toMatchObject({ outcome: "accepted" });
    expect(client.statements.some((sql) => sql.includes("source_connector_key"))).toBe(true);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("fails closed before reservation when the governed connector claim differs", async () => {
    const client = new FakeClient();
    client.governed = true;
    const repository = new PostgresCoreRepository(poolFor(client));

    const result = await repository.accept(request("wrong.connector"));

    expect(result).toEqual({ outcome: "binding_rejected", reason: "source_connector_claim_mismatch" });
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO idempotency_reservations"))).toBe(false);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("fails closed before reservation when documents capability is absent", async () => {
    const client = new FakeClient();
    client.governed = true;
    client.enforcementProfile = { ...client.enforcementProfile, capabilities: ["metadata", "webhook"] };
    const result = await new PostgresCoreRepository(poolFor(client)).accept(request("fillout-dev-v1"));
    expect(result).toEqual({ outcome: "binding_rejected", reason: "source_connector_documents_capability_required" });
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO idempotency_reservations"))).toBe(false);
  });

  it("fails closed before reservation when a MIME type is outside the Connector boundary", async () => {
    const client = new FakeClient();
    client.governed = true;
    client.enforcementProfile = { ...client.enforcementProfile, allowedMimeTypes: ["image/png"] };
    const result = await new PostgresCoreRepository(poolFor(client)).accept(request("fillout-dev-v1"));
    expect(result).toEqual({ outcome: "binding_rejected", reason: "source_connector_mime_not_allowed" });
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO idempotency_reservations"))).toBe(false);
  });

  it("fails closed before reservation when a file exceeds the Connector byte boundary", async () => {
    const client = new FakeClient();
    client.governed = true;
    client.enforcementProfile = { ...client.enforcementProfile, maxFileBytes: 100 };
    const result = await new PostgresCoreRepository(poolFor(client)).accept(request("fillout-dev-v1"));
    expect(result).toEqual({ outcome: "binding_rejected", reason: "source_connector_file_too_large" });
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO idempotency_reservations"))).toBe(false);
  });

  it("evaluates data admission before reserving work", async () => {
    const client = new FakeClient();
    const result = await new PostgresCoreRepository(poolFor(client)).accept(request());
    expect(result).toMatchObject({ outcome: "accepted" });
    const admissionIndex = client.statements.findIndex((sql) =>
      sql.startsWith("SELECT public.dop_evaluate_submission_data_admission"));
    const reservationIndex = client.statements.findIndex((sql) =>
      sql.startsWith("INSERT INTO idempotency_reservations"));
    expect(admissionIndex).toBeGreaterThan(0);
    expect(reservationIndex).toBeGreaterThan(admissionIndex);
  });

  it("commits a blocked admission audit without reserving or writing documents", async () => {
    const client = new FakeClient();
    client.admissionAllowed = false;
    client.admissionReason = "active_production_policy_required";
    const result = await new PostgresCoreRepository(poolFor(client)).accept(request());
    expect(result).toEqual({
      outcome: "admission_rejected",
      reason: "active_production_policy_required",
    });
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO idempotency_reservations"))).toBe(false);
    expect(client.statements.some((sql) => sql.startsWith("INSERT INTO documents"))).toBe(false);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });
});
