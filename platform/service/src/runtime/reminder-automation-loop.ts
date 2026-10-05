import type { ReminderSchedulerRepository } from "../ports/reminder-scheduler-repository.js";

export interface ReminderAutomationSnapshot {
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
  remindersCreated: number;
  remindersStopped: number;
  escalationsCreated: number;
  externalCallCount: 0;
}

export interface ReminderAutomationOptions {
  organizationKey: string;
  workerId: string;
  pollIntervalMs: number;
  errorBackoffMs: number;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onError?: (event: { scope: "cycle"; errorCode: string }) => void;
}

export class ReminderAutomationLoop {
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly startedAt: Date;
  private status: ReminderAutomationSnapshot["status"] = "starting";
  private lastPollAt: Date | null = null;
  private lastReadyAt: Date | null = null;
  private lastErrorAt: Date | null = null;
  private lastErrorCode: string | null = null;
  private completedJobs = 0;
  private failedJobs = 0;
  private remindersCreated = 0;
  private remindersStopped = 0;
  private escalationsCreated = 0;
  private readonly onError: NonNullable<ReminderAutomationOptions["onError"]>;

  constructor(private readonly repository: ReminderSchedulerRepository,
    private readonly options: ReminderAutomationOptions) {
    if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 60_000) {
      throw new Error("Reminder poll interval must be at least 60000ms");
    }
    if (!Number.isInteger(options.errorBackoffMs) || options.errorBackoffMs < 1_000) {
      throw new Error("Reminder error backoff must be at least 1000ms");
    }
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    this.startedAt = this.now();
    this.onError = options.onError ?? ((event) => console.error(JSON.stringify({
      event: "reminder_automation_error", ...event,
    })));
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
          this.onError({ scope: "cycle", errorCode: this.lastErrorCode });
          await this.wait(this.options.errorBackoffMs, signal);
        }
      }
    } finally {
      this.status = "stopping";
      this.status = "stopped";
    }
  }

  async runCycle(): Promise<void> {
    const now = this.now();
    this.lastPollAt = now;
    if (!await this.repository.checkReady(this.options.organizationKey)) {
      throw Object.assign(new Error("Reminder organization is unavailable"), { code: "organization_unavailable" });
    }
    this.lastReadyAt = this.now();
    const hourKey = now.toISOString().slice(0, 13);
    const result = await this.repository.run({
      organizationKey: this.options.organizationKey,
      workerId: this.options.workerId,
      runKey: `reminder-hour|${hourKey}`,
      now,
    });
    if (result.outcome === "conflict") {
      throw Object.assign(new Error("Reminder scheduler rejected cycle"), { code: result.reason ?? "scheduler_conflict" });
    }
    this.completedJobs += result.outcome === "completed" ? 1 : 0;
    this.remindersCreated += result.remindersCreated;
    this.remindersStopped += result.remindersStopped;
    this.escalationsCreated += result.escalationsCreated;
  }

  snapshot(): ReminderAutomationSnapshot {
    return {
      status: this.status, startedAt: this.startedAt.toISOString(),
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      lastReadyAt: this.lastReadyAt?.toISOString() ?? null,
      lastErrorAt: this.lastErrorAt?.toISOString() ?? null,
      lastErrorCode: this.lastErrorCode, activeJobs: 0,
      completedJobs: this.completedJobs, reviewJobs: 0, failedJobs: this.failedJobs,
      remindersCreated: this.remindersCreated, remindersStopped: this.remindersStopped,
      escalationsCreated: this.escalationsCreated, externalCallCount: 0,
    };
  }

  private async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    try { await this.sleep(milliseconds, signal); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}

function safeErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : "reminder_automation_error";
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
