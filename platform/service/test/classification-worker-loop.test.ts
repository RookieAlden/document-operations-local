import { describe, expect, it, vi } from "vitest";
import type { ClassificationQueueRepository } from "../src/ports/classification-queue-repository.js";
import { ClassificationWorkerLoop } from "../src/runtime/classification-worker-loop.js";

function queue(documentIds: string[]): ClassificationQueueRepository {
  return {
    checkReady: vi.fn(async () => true),
    findCandidates: vi.fn(async () => documentIds.splice(0, 2)),
  };
}

describe("ClassificationWorkerLoop", () => {
  it("processes a bounded candidate batch with distinct slot identities", async () => {
    const repository = queue(["document-1", "document-2"]);
    const classifier = {
      execute: vi.fn(async () => ({
        outcome: "accepted" as const,
        classificationAttemptId: "attempt-1",
        predictedDocumentTypeCode: "bank_statement",
        confidence: 0.99,
        reviewReasons: [],
        issueId: null,
      })),
    };
    const worker = new ClassificationWorkerLoop(repository, classifier, {
      organizationKey: "dev-accounting-firm",
      workerId: "worker-a",
      concurrency: 2,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
      now: () => new Date("2026-08-07T01:00:00Z"),
    });

    await expect(worker.runCycle()).resolves.toBe(2);
    expect(classifier.execute).toHaveBeenNthCalledWith(1, {
      documentId: "document-1", workerId: "worker-a:1",
    });
    expect(classifier.execute).toHaveBeenNthCalledWith(2, {
      documentId: "document-2", workerId: "worker-a:2",
    });
    expect(worker.snapshot()).toMatchObject({
      activeJobs: 0,
      completedJobs: 2,
      failedJobs: 0,
      lastReadyAt: "2026-08-07T01:00:00.000Z",
    });
  });

  it("isolates a job exception so another candidate can finish", async () => {
    const repository = queue(["document-1", "document-2"]);
    const classifier = {
      execute: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("database body must stay private"), { code: "database_error" }))
        .mockResolvedValueOnce({
          outcome: "review_required", classificationAttemptId: "attempt-2",
          predictedDocumentTypeCode: "invoice", confidence: 0.8,
          reviewReasons: ["low_confidence"], issueId: "issue-1",
        }),
    };
    const onError = vi.fn();
    const worker = new ClassificationWorkerLoop(repository, classifier, {
      organizationKey: "dev-accounting-firm", workerId: "worker-a",
      concurrency: 2, pollIntervalMs: 100, errorBackoffMs: 100,
      now: () => new Date("2026-08-07T01:00:00Z"),
      onError,
    });

    await worker.runCycle();

    expect(worker.snapshot()).toMatchObject({
      reviewJobs: 1, failedJobs: 1, lastErrorCode: "database_error",
    });
    expect(onError).toHaveBeenCalledWith({
      scope: "document", errorCode: "database_error", documentId: "document-1",
    });
    expect(JSON.stringify(worker.snapshot())).not.toContain("database body");
    expect(JSON.stringify(onError.mock.calls)).not.toContain("database body");
  });

  it("fails readiness when the bound organization is unavailable", async () => {
    const repository: ClassificationQueueRepository = {
      checkReady: vi.fn(async () => false),
      findCandidates: vi.fn(async () => []),
    };
    const worker = new ClassificationWorkerLoop(repository, { execute: vi.fn() }, {
      organizationKey: "missing", workerId: "worker-a", concurrency: 1,
      pollIntervalMs: 100, errorBackoffMs: 100,
    });
    await expect(worker.runCycle()).rejects.toMatchObject({ code: "organization_unavailable" });
    expect(repository.findCandidates).not.toHaveBeenCalled();
  });

  it("uses one process-unique lease identity for release evaluations", async () => {
    const runNext = vi.fn(async (_request: { organizationKey: string; workerId: string; now: Date }) => false);
    const releaseEvaluator = { runNext };
    const worker = new ClassificationWorkerLoop(queue([]), { execute: vi.fn() }, {
      organizationKey: "dev-accounting-firm", workerId: "worker-a", concurrency: 1,
      pollIntervalMs: 100, errorBackoffMs: 100,
      now: () => new Date("2026-08-08T00:00:00Z"),
    }, releaseEvaluator);
    await worker.runCycle();
    await worker.runCycle();
    const identities = runNext.mock.calls.map(([request]) => request.workerId);
    expect(identities[0]).toMatch(/^worker-a:release-evaluator:[0-9a-f-]{36}$/);
    expect(identities[1]).toBe(identities[0]);
  });

  it("stops claiming more documents after a quota result opens the process circuit", async () => {
    const documents = ["document-1", "document-2"];
    const repository: ClassificationQueueRepository = {
      checkReady: vi.fn(async () => true),
      findCandidates: vi.fn(async () => documents.splice(0, 1)),
    };
    const classifier = {
      execute: vi.fn(async () => ({
        outcome: "failed_recoverable" as const,
        errorCode: "project_spend_limit_exceeded",
        issueId: null,
        retryScheduled: false,
        circuitOpen: true,
      })),
    };
    const onError = vi.fn();
    const worker = new ClassificationWorkerLoop(repository, classifier, {
      organizationKey: "dev-accounting-firm",
      workerId: "worker-a",
      concurrency: 1,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
      now: () => new Date("2026-08-22T00:00:00Z"),
      onError,
    });

    await expect(worker.runCycle()).resolves.toBe(1);
    await expect(worker.runCycle()).resolves.toBe(0);

    expect(classifier.execute).toHaveBeenCalledOnce();
    expect(repository.findCandidates).toHaveBeenCalledOnce();
    expect(worker.snapshot()).toMatchObject({
      circuitOpen: true,
      circuitErrorCode: "project_spend_limit_exceeded",
      failedJobs: 1,
    });
    expect(onError).toHaveBeenCalledWith({
      scope: "document",
      errorCode: "project_spend_limit_exceeded",
      documentId: "document-1",
    });
  });
});
