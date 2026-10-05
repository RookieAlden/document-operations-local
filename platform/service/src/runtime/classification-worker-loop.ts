import { randomUUID } from "node:crypto";
import type { ClassifyDocument, ClassifyDocumentResult } from "../application/classify-document.js";
import type { ClassificationQueueRepository } from "../ports/classification-queue-repository.js";

export interface ClassificationWorkerLoopOptions {
  organizationKey: string;
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  errorBackoffMs: number;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onError?: (event: { scope: "cycle" | "document"; errorCode: string; documentId?: string }) => void;
}

export interface ClassificationWorkerSnapshot {
  status: "starting" | "running" | "stopping" | "stopped";
  startedAt: string;
  lastPollAt: string | null;
  lastReadyAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  activeJobs: number;
  completedJobs: number;
  reviewJobs: number;
  failedJobs: number;
  circuitOpen?: boolean;
  circuitErrorCode?: string | null;
}

export class ClassificationWorkerLoop {
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly startedAt: Date;
  private status: ClassificationWorkerSnapshot["status"] = "starting";
  private lastPollAt: Date | null = null;
  private lastReadyAt: Date | null = null;
  private lastErrorAt: Date | null = null;
  private lastErrorCode: string | null = null;
  private activeJobs = 0;
  private completedJobs = 0;
  private reviewJobs = 0;
  private failedJobs = 0;
  private circuitOpen = false;
  private circuitErrorCode: string | null = null;
  private readonly releaseEvaluationWorkerId: string;
  private readonly onError: NonNullable<ClassificationWorkerLoopOptions["onError"]>;

  constructor(
    private readonly queue: ClassificationQueueRepository,
    private readonly classifier: Pick<ClassifyDocument, "execute">,
    private readonly options: ClassificationWorkerLoopOptions,
    private readonly releaseEvaluator?: { runNext(request: {
      organizationKey: string; workerId: string; now: Date;
    }): Promise<boolean> },
  ) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32) {
      throw new Error("Worker concurrency must be an integer from 1 to 32");
    }
    if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 100) {
      throw new Error("Worker poll interval must be at least 100ms");
    }
    if (!Number.isInteger(options.errorBackoffMs) || options.errorBackoffMs < 100) {
      throw new Error("Worker error backoff must be at least 100ms");
    }
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    this.startedAt = this.now();
    this.releaseEvaluationWorkerId = `${options.workerId}:release-evaluator:${randomUUID()}`;
    this.onError = options.onError ?? ((event) => console.error(JSON.stringify({
      event: "classification_worker_error",
      ...event,
    })));
  }

  async run(signal: AbortSignal): Promise<void> {
    this.status = "running";
    try {
      while (!signal.aborted) {
        let processed = 0;
        try {
          processed = await this.runCycle();
          this.lastErrorCode = null;
        } catch (error) {
          this.lastErrorAt = this.now();
          this.lastErrorCode = safeErrorCode(error);
          this.onError({ scope: "cycle", errorCode: this.lastErrorCode });
          await this.wait(this.options.errorBackoffMs, signal);
          continue;
        }
        if (processed === 0) await this.wait(this.options.pollIntervalMs, signal);
      }
    } finally {
      this.status = "stopping";
      while (this.activeJobs > 0) await this.wait(25, new AbortController().signal);
      this.status = "stopped";
    }
  }

  async runCycle(): Promise<number> {
    this.lastPollAt = this.now();
    const ready = await this.queue.checkReady(this.options.organizationKey);
    if (!ready) throw Object.assign(new Error("Worker organization is unavailable"), { code: "organization_unavailable" });
    this.lastReadyAt = this.now();
    if (this.circuitOpen) return 0;
    const candidates = await this.queue.findCandidates({
      organizationKey: this.options.organizationKey,
      limit: this.options.concurrency,
      now: this.now(),
    });
    const evaluationPromise = this.releaseEvaluator?.runNext({
      organizationKey: this.options.organizationKey,
      workerId: this.releaseEvaluationWorkerId,
      now: this.now(),
    }) ?? Promise.resolve(false);
    const [, evaluated] = await Promise.all([
      Promise.all(candidates.map((documentId, index) => this.process(documentId, index))),
      evaluationPromise,
    ]);
    return candidates.length + (evaluated ? 1 : 0);
  }

  snapshot(): ClassificationWorkerSnapshot {
    return {
      status: this.status,
      startedAt: this.startedAt.toISOString(),
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      lastReadyAt: this.lastReadyAt?.toISOString() ?? null,
      lastErrorAt: this.lastErrorAt?.toISOString() ?? null,
      lastErrorCode: this.lastErrorCode,
      activeJobs: this.activeJobs,
      completedJobs: this.completedJobs,
      reviewJobs: this.reviewJobs,
      failedJobs: this.failedJobs,
      circuitOpen: this.circuitOpen,
      circuitErrorCode: this.circuitErrorCode,
    };
  }

  private async process(documentId: string, slot: number): Promise<void> {
    this.activeJobs += 1;
    try {
      const result = await this.classifier.execute({
        documentId,
        workerId: `${this.options.workerId}:${slot + 1}`,
      });
      this.record(result, documentId);
    } catch (error) {
      this.failedJobs += 1;
      this.lastErrorAt = this.now();
      this.lastErrorCode = safeErrorCode(error);
      this.onError({ scope: "document", errorCode: this.lastErrorCode, documentId });
    } finally {
      this.activeJobs -= 1;
    }
  }

  private record(result: ClassifyDocumentResult, documentId: string): void {
    if (result.outcome === "accepted") this.completedJobs += 1;
    else if (result.outcome === "review_required") this.reviewJobs += 1;
    else if (result.outcome === "failed_manual" || result.outcome === "failed_recoverable") {
      this.failedJobs += 1;
      this.lastErrorAt = this.now();
      this.lastErrorCode = result.errorCode;
      if (result.circuitOpen) {
        this.circuitOpen = true;
        this.circuitErrorCode = result.errorCode;
      }
      this.onError({ scope: "document", errorCode: result.errorCode, documentId });
    }
  }

  private async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    try {
      await this.sleep(milliseconds, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "worker_error";
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
