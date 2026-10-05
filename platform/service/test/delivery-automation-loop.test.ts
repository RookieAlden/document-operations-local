import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedDelivery,
  DeliveryAutomationRepository,
} from "../src/ports/delivery-automation-repository.js";
import { SyntheticDeliveryProvider } from "../src/providers/synthetic-delivery-provider.js";
import { DeliveryAutomationLoop } from "../src/runtime/delivery-automation-loop.js";

const baseClaim: ClaimedDelivery = {
  outcome: "claimed", expiredUnknownCount: 0,
  deliveryJobId: "job-1", attemptId: "attempt-1", attemptNumber: 1,
  leaseToken: "lease-1", clientRequestId: "request-1",
  recipientAddress: "uat+fixture@document-operations.invalid",
  subjectLine: "Synthetic missing-document request",
  bodyText: "This body contains only synthetic UAT fixture content.",
  scenario: "success",
};

function repository(claim: ClaimedDelivery = baseClaim): DeliveryAutomationRepository {
  return {
    checkReady: vi.fn(async () => true),
    claim: vi.fn(async () => claim),
    complete: vi.fn(async () => ({ outcome: "completed" as const })),
    recordReceipt: vi.fn(async () => ({ outcome: "completed" as const })),
  };
}

function worker(repositoryValue: DeliveryAutomationRepository) {
  return new DeliveryAutomationLoop(repositoryValue, new SyntheticDeliveryProvider(), {
    organizationKey: "uat-accounting-firm", workerId: "automation-uat:delivery",
    pollIntervalMs: 1_000, errorBackoffMs: 1_000, leaseSeconds: 120,
    now: () => new Date("2026-08-16T10:00:00.000Z"),
  });
}

describe("DeliveryAutomationLoop", () => {
  it("accepts and records a digest-only delivered receipt with zero external calls", async () => {
    const db = repository();
    await worker(db).runCycle();
    expect(db.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "accepted", providerMessageId: expect.stringMatching(/^synthetic:[0-9a-f]{64}$/),
    }));
    const expectedId = `synthetic:${createHash("sha256").update("job-1|request-1").digest("hex")}`;
    expect(db.recordReceipt).toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: expectedId, receiptType: "delivered",
      payloadHash: createHash("sha256").update(`${expectedId}|delivered`).digest("hex"),
    }));
  });

  it.each([
    ["rate_limited_once", "provider_429"],
    ["server_error_once", "provider_5xx"],
  ] as const)("records %s as recoverable with backoff", async (scenario, errorCode) => {
    const db = repository({ ...baseClaim, scenario });
    await worker(db).runCycle();
    expect(db.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed_recoverable", errorCode,
      retryNotBefore: new Date("2026-08-16T10:00:01.000Z"),
    }));
    expect(db.recordReceipt).not.toHaveBeenCalled();
  });

  it("blocks automatic retry when the provider result is unknown", async () => {
    const db = repository({ ...baseClaim, scenario: "timeout_unknown" });
    const automation = worker(db);
    await automation.runCycle();
    expect(db.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "outcome_unknown", errorCode: "provider_timeout",
    }));
    expect(db.claim).toHaveBeenCalledTimes(1);
    expect(automation.snapshot()).toMatchObject({ outcomeUnknownCount: 1, externalCallCount: 0 });
  });

  it("leaves a simulated crash leased so database expiry can conservatively mark it unknown", async () => {
    const db = repository({ ...baseClaim, scenario: "crash_after_claim" });
    await worker(db).runCycle();
    expect(db.complete).not.toHaveBeenCalled();
    expect(db.recordReceipt).not.toHaveBeenCalled();
  });

  it("requires an RFC-reserved invalid recipient", async () => {
    const db = repository({ ...baseClaim, recipientAddress: "unsafe@example.com" });
    await expect(worker(db).runCycle()).rejects.toMatchObject({ code: "unsafe_recipient" });
    expect(db.complete).not.toHaveBeenCalled();
  });

  it("treats a replayed receipt as idempotent", async () => {
    const db = repository({ ...baseClaim, scenario: "receipt_replay" });
    vi.mocked(db.recordReceipt)
      .mockResolvedValueOnce({ outcome: "completed" })
      .mockResolvedValueOnce({ outcome: "duplicate" });
    await worker(db).runCycle();
    expect(db.recordReceipt).toHaveBeenCalledTimes(2);
  });

  it("makes a disabled runtime healthy without claiming or calling a provider", async () => {
    const db = repository();
    vi.mocked(db.checkReady).mockResolvedValue(false);
    await worker(db).runCycle();
    expect(db.claim).not.toHaveBeenCalled();
    expect(db.complete).not.toHaveBeenCalled();
  });
});
