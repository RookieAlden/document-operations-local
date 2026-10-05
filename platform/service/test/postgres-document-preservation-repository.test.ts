import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresDocumentPreservationRepository } from "../src/adapters/postgres/postgres-document-preservation-repository.js";
import type { DocumentPreservationContext } from "../src/ports/document-preservation-repository.js";

class FakeClient {
  readonly statements: string[] = [];
  readonly parameters: unknown[][] = [];
  empty = false;

  async query(text: string, parameters: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const normalized = text.replace(/\s+/g, " ").trim();
    this.statements.push(normalized);
    this.parameters.push(parameters);
    if (normalized.startsWith("SELECT dop_set_organization_context($1) AS id")) {
      return { rows: [{ id: "organization-1" }] };
    }
    if (normalized.startsWith("SELECT d.organization_id")) {
      return { rows: this.empty ? [] : [{
        organization_id: "organization-1", organization_key: "dev-accounting-firm",
        case_id: "case-1", document_id: "document-1",
        source_download_ref: "https://files.example.com/doc.pdf",
        original_filename: "doc.pdf", declared_mime_type: "application/pdf",
        size_bytes: 9, content_hash_sha256: "a".repeat(64),
      }] };
    }
    if (normalized.startsWith("INSERT INTO idempotency_reservations")) {
      return { rows: [{ id: "reservation-1", attempt_count: 1 }] };
    }
    return { rows: [] };
  }
  release(): void {}
}

function poolFor(client: FakeClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

function context(): DocumentPreservationContext {
  return {
    organizationId: "organization-1", organizationKey: "dev-accounting-firm", caseId: "case-1",
    documentId: "document-1", reservationId: "reservation-1", attemptNumber: 1,
    sourceDownloadReference: "https://files.example.com/doc.pdf", filename: "doc.pdf",
    declaredMimeType: "application/pdf", declaredSizeBytes: 9, expectedSha256: "a".repeat(64),
  };
}

describe("PostgresDocumentPreservationRepository", () => {
  it("claims one queue item with row skipping and a recoverable lease", async () => {
    const client = new FakeClient();
    const repository = new PostgresDocumentPreservationRepository(poolFor(client));
    await expect(repository.reserveNext({
      organizationKey: "dev-accounting-firm", workerId: "worker-1",
      leaseSeconds: 300, now: new Date("2026-08-07T01:00:00Z"),
    })).resolves.toMatchObject({ outcome: "acquired", context: { documentId: "document-1" } });
    expect(client.statements.some((sql) => sql.includes("FOR UPDATE OF d SKIP LOCKED"))).toBe(true);
    expect(client.statements.some((sql) => sql.includes("ir.lease_expires_at >= $2"))).toBe(true);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("atomically stores metadata, clears the source URL and emits an event", async () => {
    const client = new FakeClient();
    const repository = new PostgresDocumentPreservationRepository(poolFor(client));
    await repository.complete({
      context: context(),
      downloaded: { content: Buffer.from("%PDF-test"), mimeType: "application/pdf", sizeBytes: 9, sha256: "a".repeat(64) },
      storageReference: "supabase://bucket/path.pdf", workflowRunId: "run-1", eventId: "event-1",
      correlationId: "correlation-1", environment: "DEV", now: new Date("2026-08-07T01:00:00Z"),
    });
    expect(client.statements.some((sql) => sql.includes("source_download_ref = NULL"))).toBe(true);
    expect(client.statements.some((sql) => sql.includes("'Document.Stored'"))).toBe(true);
    expect(client.statements.some((sql) => sql.includes("status='completed'"))).toBe(true);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("records a recoverable failure without sensitive details", async () => {
    const client = new FakeClient();
    const repository = new PostgresDocumentPreservationRepository(poolFor(client));
    await repository.fail({
      context: context(), failureMode: "recoverable", errorCode: "source_http_503", errorClass: "connector",
      workflowRunId: "run-1", workflowErrorId: "error-1", eventId: "event-1",
      correlationId: "correlation-1", environment: "DEV", now: new Date("2026-08-07T01:00:00Z"),
    });
    expect(client.statements.some((sql) => sql.includes("'Document.StorageFailed'"))).toBe(true);
    expect(client.parameters.flat()).not.toContain("https://files.example.com/doc.pdf");
    expect(client.statements.at(-1)).toBe("COMMIT");
  });
});
