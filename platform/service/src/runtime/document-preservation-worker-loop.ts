import type { PreserveNextDocument, PreserveNextDocumentResult } from "../application/preserve-next-document.js";
import type { ClassificationWorkerSnapshot } from "./classification-worker-loop.js";

export class DocumentPreservationWorkerLoop {
  private readonly startedAt: Date;
  private status: ClassificationWorkerSnapshot["status"] = "starting";
  private lastPollAt: Date | null = null;
  private lastReadyAt: Date | null = null;
  private lastErrorAt: Date | null = null;
  private lastErrorCode: string | null = null;
  private activeJobs = 0;
  private completedJobs = 0;
  private failedJobs = 0;

  constructor(
    private readonly preserver: Pick<PreserveNextDocument, "execute">,
    private readonly checkReady: () => Promise<boolean>,
    private readonly options: {
      workerId: string;
      concurrency: number;
      pollIntervalMs: number;
      errorBackoffMs: number;
      now?: () => Date;
      sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    },
  ) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32) {
      throw new Error("Worker concurrency must be an integer from 1 to 32");
    }
    this.startedAt = this.now();
  }

  private get now(): () => Date { return this.options.now ?? (() => new Date()); }
  private get sleep(): (milliseconds: number, signal: AbortSignal) => Promise<void> {
    return this.options.sleep ?? abortableSleep;
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
          this.markError(error);
          await this.wait(this.options.errorBackoffMs, signal);
          continue;
        }
        if (processed === 0) await this.wait(this.options.pollIntervalMs, signal);
      }
    } finally {
      this.status = "stopping";
      this.status = "stopped";
    }
  }

  async runCycle(): Promise<number> {
    this.lastPollAt = this.now();
    if (!await this.checkReady()) {
      throw Object.assign(new Error("Preservation database is unavailable"), { code: "database_not_ready" });
    }
    this.lastReadyAt = this.now();
    const results = await Promise.all(
      Array.from({ length: this.options.concurrency }, (_, slot) => this.process(slot)),
    );
    return results.filter((result) => result.outcome !== "empty").length;
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
      reviewJobs: 0,
      failedJobs: this.failedJobs,
    };
  }

  private async process(slot: number): Promise<PreserveNextDocumentResult> {
    this.activeJobs += 1;
    try {
      const result = await this.preserver.execute({ workerId: `${this.options.workerId}:${slot + 1}` });
      if (result.outcome === "stored") this.completedJobs += 1;
      if (result.outcome === "failed_manual" || result.outcome === "failed_recoverable") this.failedJobs += 1;
      return result;
    } catch (error) {
      this.failedJobs += 1;
      this.markError(error);
      return { outcome: "failed_recoverable", documentId: "unknown", errorCode: "worker_error" };
    } finally { this.activeJobs -= 1; }
  }

  private markError(error: unknown): void {
    this.lastErrorAt = this.now();
    this.lastErrorCode = typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "worker_error";
  }

  private async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    try { await this.sleep(milliseconds, signal); } catch (error) { if (!signal.aborted) throw error; }
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
