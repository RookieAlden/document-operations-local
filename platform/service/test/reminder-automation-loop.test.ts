import { describe, expect, it, vi } from "vitest";
import type { ReminderSchedulerRepository } from "../src/ports/reminder-scheduler-repository.js";
import { loadReminderAutomationConfig } from "../src/runtime/reminder-automation-config.js";
import { ReminderAutomationLoop } from "../src/runtime/reminder-automation-loop.js";

function repository(): ReminderSchedulerRepository {
  return {
    checkReady: vi.fn(async () => true),
    run: vi.fn(async () => ({
      outcome: "completed" as const, scheduleRunId: "run-1",
      casesScanned: 2, remindersCreated: 3, remindersStopped: 1,
      escalationsCreated: 1, externalCallCount: 0 as const,
    })),
  };
}

describe("ReminderAutomationLoop", () => {
  it("uses an hourly idempotency window and only records zero-external-call results", async () => {
    const reminderRepository = repository();
    const now = () => new Date("2026-08-16T09:42:00.000Z");
    const worker = new ReminderAutomationLoop(reminderRepository, {
      organizationKey: "uat-accounting-firm", workerId: "reminder-uat-1",
      pollIntervalMs: 60_000, errorBackoffMs: 1_000, now,
    });

    await worker.runCycle();

    expect(reminderRepository.run).toHaveBeenCalledWith({
      organizationKey: "uat-accounting-firm", workerId: "reminder-uat-1",
      runKey: "reminder-hour|2026-08-16T09", now: now(),
    });
    expect(worker.snapshot()).toMatchObject({
      completedJobs: 1, remindersCreated: 3, remindersStopped: 1,
      escalationsCreated: 1, externalCallCount: 0,
      lastReadyAt: "2026-08-16T09:42:00.000Z",
    });
  });

  it("fails closed before scheduling when the organization is unavailable", async () => {
    const reminderRepository = repository();
    vi.mocked(reminderRepository.checkReady).mockResolvedValue(false);
    const worker = new ReminderAutomationLoop(reminderRepository, {
      organizationKey: "missing", workerId: "reminder-uat-1",
      pollIntervalMs: 60_000, errorBackoffMs: 1_000,
    });
    await expect(worker.runCycle()).rejects.toMatchObject({ code: "organization_unavailable" });
    expect(reminderRepository.run).not.toHaveBeenCalled();
  });

  it("rejects unsafe polling configuration", () => {
    expect(() => new ReminderAutomationLoop(repository(), {
      organizationKey: "uat-accounting-firm", workerId: "worker",
      pollIntervalMs: 59_999, errorBackoffMs: 1_000,
    })).toThrow("at least 60000ms");
  });
});

describe("loadReminderAutomationConfig", () => {
  it("loads bounded UAT defaults without any provider or delivery credential", () => {
    const config = loadReminderAutomationConfig({
      DATABASE_URL: "postgres://runtime.invalid/db",
      DATABASE_SSL_CA_PATH: "/app/certificates/supabase-root-2021.crt",
      DOP_ORGANIZATION_KEY: "uat-accounting-firm",
      DOP_WORKER_ID: "reminder-uat-1",
      PORT: "3000",
    });
    expect(config).toMatchObject({
      organizationKey: "uat-accounting-firm", workerId: "reminder-uat-1",
      pollIntervalMs: 300_000, errorBackoffMs: 30_000,
      deliveryPollIntervalMs: 5_000, deliveryLeaseSeconds: 120,
      readinessMaximumAgeMs: 900_000,
    });
    expect(JSON.stringify(config)).not.toContain("OPENAI");
    expect(JSON.stringify(config)).not.toContain("MICROSOFT");
  });
});
