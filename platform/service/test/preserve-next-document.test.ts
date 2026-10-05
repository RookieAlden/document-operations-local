import { describe, expect, it, vi } from "vitest";
import { PreserveNextDocument } from "../src/application/preserve-next-document.js";
import type { DocumentPreservationRepository } from "../src/ports/document-preservation-repository.js";

function context() {
  return {
    organizationId: "organization-1", organizationKey: "dev-accounting-firm", caseId: "case-1",
    documentId: "document-1", reservationId: "reservation-1", attemptNumber: 1,
    sourceDownloadReference: "https://files.example.com/doc.pdf", filename: "doc.pdf",
    declaredMimeType: "application/pdf", declaredSizeBytes: 9, expectedSha256: null,
  };
}

function repository(): DocumentPreservationRepository & { completed: unknown[]; failed: unknown[] } {
  const completed: unknown[] = [];
  const failed: unknown[] = [];
  return {
    completed, failed,
    reserveNext: vi.fn(async () => ({ outcome: "acquired" as const, context: context() })),
    complete: vi.fn(async (request) => { completed.push(request); }),
    fail: vi.fn(async (request) => { failed.push(request); }),
  };
}

describe("PreserveNextDocument", () => {
  it("downloads, verifies and stores before atomically completing the document", async () => {
    const repo = repository();
    const downloaded = { content: Buffer.from("%PDF-test"), mimeType: "application/pdf", sizeBytes: 9, sha256: "a".repeat(64) };
    const downloader = { download: vi.fn(async () => downloaded) };
    const objectStore = { put: vi.fn(async () => ({ storageReference: "supabase://bucket/path.pdf" })) };
    const useCase = new PreserveNextDocument(repo, downloader, objectStore, {
      environment: "DEV", organizationKey: "dev-accounting-firm",
    });

    await expect(useCase.execute({ workerId: "worker-1", now: new Date("2026-08-07T02:00:00Z") }))
      .resolves.toMatchObject({ outcome: "stored", documentId: "document-1", sizeBytes: 9 });
    expect(objectStore.put).toHaveBeenCalledWith(expect.objectContaining({ sha256: "a".repeat(64) }));
    expect(repo.completed).toHaveLength(1);
    expect(repo.failed).toHaveLength(0);
  });

  it("routes integrity failures to manual handling without attempting storage", async () => {
    const repo = repository();
    const downloader = { download: vi.fn(async () => {
      throw Object.assign(new Error("sensitive URL"), { code: "source_hash_mismatch", failureMode: "manual" });
    }) };
    const objectStore = { put: vi.fn() };
    const useCase = new PreserveNextDocument(repo, downloader, objectStore, {
      environment: "DEV", organizationKey: "dev-accounting-firm",
    });
    await expect(useCase.execute({ workerId: "worker-1" })).resolves.toEqual({
      outcome: "failed_manual", documentId: "document-1", errorCode: "source_hash_mismatch",
    });
    expect(objectStore.put).not.toHaveBeenCalled();
    expect(repo.failed[0]).toMatchObject({ failureMode: "manual", errorClass: "validation" });
    expect(JSON.stringify(repo.failed[0])).not.toContain("sensitive URL");
  });

  it("returns empty without downloading when no document is available", async () => {
    const repo = repository();
    vi.mocked(repo.reserveNext).mockResolvedValue({ outcome: "empty" });
    const downloader = { download: vi.fn() };
    const useCase = new PreserveNextDocument(repo, downloader, { put: vi.fn() }, {
      environment: "DEV", organizationKey: "dev-accounting-firm",
    });
    await expect(useCase.execute({ workerId: "worker-1" })).resolves.toEqual({ outcome: "empty" });
    expect(downloader.download).not.toHaveBeenCalled();
  });
});
