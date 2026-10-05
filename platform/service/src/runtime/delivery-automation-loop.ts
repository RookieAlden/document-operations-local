import { createHash } from "node:crypto";
import type { DeliveryAutomationRepository } from "../ports/delivery-automation-repository.js";
import type { DeliveryProvider } from "../ports/delivery-provider.js";

export interface DeliveryAutomationSnapshot {
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
  acceptedJobs: number;
  receiptCount: number;
  outcomeUnknownCount: number;
  externalCallCount: 0;
}

export interface DeliveryAutomationOptions {
  organizationKey: string;
  workerId: string;
  pollIntervalMs: number;
  errorBackoffMs: number;
  leaseSeconds: number;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onError?: (event: { scope: "cycle"; errorCode: string }) => void;
}

export class DeliveryAutomationLoop {
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly startedAt: Date;
  private status: DeliveryAutomationSnapshot["status"] = "starting";
  private lastPollAt: Date | null = null;
  private lastReadyAt: Date | null = null;
  private lastErrorAt: Date | null = null;
  private lastErrorCode: string | null = null;
  private activeJobs = 0;
  private completedJobs = 0;
  private failedJobs = 0;
  private acceptedJobs = 0;
  private receiptCount = 0;
  private outcomeUnknownCount = 0;

  constructor(
    private readonly repository: DeliveryAutomationRepository,
    private readonly provider: DeliveryProvider,
    private readonly options: DeliveryAutomationOptions,
  ) {
    if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 1_000) {
      throw new Error("Delivery poll interval must be at least 1000ms");
    }
    if (!Number.isInteger(options.errorBackoffMs) || options.errorBackoffMs < 1_000) {
      throw new Error("Delivery error backoff must be at least 1000ms");
    }
    if (!Number.isInteger(options.leaseSeconds) || options.leaseSeconds < 15 || options.leaseSeconds > 900) {
      throw new Error("Delivery lease must be between 15 and 900 seconds");
    }
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    this.startedAt = this.now();
  }

  async run(signal: AbortSignal): Promise<void> {
    this.status = "running";
    try {
      while (!signal.aborted) {
        try {
          await this.runCycle();
          this.lastErrorCode = null;
          await this.wait(this.options.pollIntervalMs, signal);
        } catch (error) {
          this.failedJobs += 1;
          this.lastErrorAt = this.now();
          this.lastErrorCode = safeErrorCode(error);
          (this.options.onError ?? defaultOnError)({ scope: "cycle", errorCode: this.lastErrorCode });
          await this.wait(this.options.errorBackoffMs, signal);
        }
      }
    } finally { this.status = "stopping"; this.status = "stopped"; }
  }

  async runCycle(): Promise<void> {
    const now = this.now();
    this.lastPollAt = now;
    const ready = await this.repository.checkReady(this.options.organizationKey);
    if (!ready) {
      // Disabled delivery is a safe, healthy state. The reminder half of the
      // shared Automation service can continue running without provider calls.
      this.lastReadyAt = now;
      return;
    }
    this.lastReadyAt = now;
    const claim = await this.repository.claim({
      organizationKey: this.options.organizationKey,
      workerId: this.options.workerId,
      leaseSeconds: this.options.leaseSeconds,
      now,
    });
    this.outcomeUnknownCount += claim.expiredUnknownCount ?? 0;
    if (claim.outcome !== "claimed") return;
    this.activeJobs = 1;
    try {
      const result = await this.provider.deliver(claim);
      if (result.outcome === "crash_simulated") return;
      if (result.outcome === "recoverable") {
        await this.complete(claim.attemptId, claim.leaseToken, "failed_recoverable", {
          errorCode: result.errorCode,
          retryNotBefore: new Date(now.getTime() + result.retryAfterMs),
        });
        return;
      }
      if (result.outcome === "manual") {
        await this.complete(claim.attemptId, claim.leaseToken, "failed_manual", {
          errorCode: result.errorCode,
        });
        return;
      }
      if (result.outcome === "unknown") {
        await this.complete(claim.attemptId, claim.leaseToken, "outcome_unknown", {
          errorCode: result.errorCode,
        });
        this.outcomeUnknownCount += 1;
        return;
      }
      await this.complete(claim.attemptId, claim.leaseToken, "accepted", {
        providerMessageId: result.providerMessageId,
      });
      this.acceptedJobs += 1;
      if (result.receipt) {
        const receiptKey = `${result.providerMessageId}|${result.receipt}`;
        const payloadHash = createHash("sha256").update(receiptKey).digest("hex");
        const receipt = {
          organizationKey: this.options.organizationKey,
          workerId: this.options.workerId,
          attemptId: claim.attemptId,
          providerMessageId: result.providerMessageId,
          receiptKey, receiptType: result.receipt, payloadHash,
          occurredAt: now, receivedAt: now,
        } as const;
        const recorded = await this.repository.recordReceipt(receipt);
        if (recorded.outcome === "conflict") throw code(recorded.reason ?? "receipt_conflict");
        if (recorded.outcome === "completed") this.receiptCount += 1;
        if (result.replayReceipt) {
          const replay = await this.repository.recordReceipt(receipt);
          if (replay.outcome !== "duplicate") throw code("receipt_replay_not_idempotent");
        }
      }
      this.completedJobs += 1;
    } finally { this.activeJobs = 0; }
  }

  snapshot(): DeliveryAutomationSnapshot {
    return {
      status: this.status, startedAt: this.startedAt.toISOString(),
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      lastReadyAt: this.lastReadyAt?.toISOString() ?? null,
      lastErrorAt: this.lastErrorAt?.toISOString() ?? null,
      lastErrorCode: this.lastErrorCode, activeJobs: this.activeJobs,
      completedJobs: this.completedJobs, reviewJobs: this.outcomeUnknownCount,
      failedJobs: this.failedJobs, acceptedJobs: this.acceptedJobs,
      receiptCount: this.receiptCount, outcomeUnknownCount: this.outcomeUnknownCount,
      externalCallCount: 0,
    };
  }

  private async complete(
    attemptId: string,
    leaseToken: string,
    outcome: "accepted" | "failed_recoverable" | "failed_manual" | "outcome_unknown",
    detail: { providerMessageId?: string; errorCode?: string; retryNotBefore?: Date },
  ): Promise<void> {
    const result = await this.repository.complete({
      organizationKey: this.options.organizationKey, workerId: this.options.workerId,
      attemptId, leaseToken, outcome, ...detail, now: this.now(),
    });
    if (result.outcome === "conflict") throw code(result.reason ?? "completion_conflict");
  }

  private async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    try { await this.sleep(milliseconds, signal); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}

function code(errorCode: string): Error {
  return Object.assign(new Error(errorCode), { code: errorCode });
}
function safeErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : "delivery_automation_error";
}
function defaultOnError(event: { scope: "cycle"; errorCode: string }): void {
  console.error(JSON.stringify({ event: "delivery_automation_error", ...event }));
}
function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
