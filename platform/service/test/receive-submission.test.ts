import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ReceiveSubmission } from "../src/application/receive-submission.js";
import { ContractValidator } from "../src/contracts/json-schema-validator.js";
import {
  InMemorySubmissionIntakeRepository,
} from "./support/in-memory-repositories.js";

const correlationId = "6f729f6f-a246-4cf8-ad11-298e9c75f217";

function validSubmission(): unknown {
  const url = new URL("../../tests/fixtures/accounting-submission-dev-client-001.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("ReceiveSubmission", () => {
  it("atomically accepts a submission, its documents, run, and events", async () => {
    const repository = new InMemorySubmissionIntakeRepository();
    const handler = new ReceiveSubmission(new ContractValidator(), repository, {
      environment: "DEV",
      organizationKey: "dev-accounting-firm",
    });

    const result = await handler.execute({
      input: validSubmission(),
      correlationId,
      workerId: "test-worker",
      now: new Date("2026-08-06T09:00:00Z"),
    });

    expect(result).toMatchObject({ outcome: "accepted", idempotencyKey: "fillout|submission-dev-client-001-2026-07-001" });
    expect(result.outcome === "accepted" && result.documentIds).toHaveLength(1);
    expect(result.outcome === "accepted" && result.eventIds).toHaveLength(2);
    expect(repository.accepted).toHaveLength(1);
  });

  it("returns duplicate after an atomic acceptance", async () => {
    const repository = new InMemorySubmissionIntakeRepository();
    const handler = new ReceiveSubmission(new ContractValidator(), repository, {
      environment: "DEV",
      organizationKey: "dev-accounting-firm",
    });
    const command = {
      input: validSubmission(),
      correlationId,
      workerId: "test-worker",
      now: new Date("2026-08-06T09:00:00Z"),
    };

    await handler.execute(command);
    const duplicate = await handler.execute(command);

    expect(duplicate).toEqual({ outcome: "duplicate", idempotencyKey: "fillout|submission-dev-client-001-2026-07-001" });
    expect(repository.accepted).toHaveLength(1);
  });

  it("does not take over an active lease", async () => {
    const repository = new InMemorySubmissionIntakeRepository();
    repository.activeLeases.set("fillout|submission-dev-client-001-2026-07-001", new Date("2026-08-06T09:05:00Z"));
    const handler = new ReceiveSubmission(new ContractValidator(), repository, {
      environment: "DEV",
      organizationKey: "dev-accounting-firm",
    });

    const result = await handler.execute({
      input: validSubmission(),
      correlationId,
      workerId: "test-worker",
      now: new Date("2026-08-06T09:00:00Z"),
    });

    expect(result).toEqual({ outcome: "in_progress", idempotencyKey: "fillout|submission-dev-client-001-2026-07-001" });
    expect(repository.accepted).toHaveLength(0);
  });

  it("rejects invalid input before reserving work", async () => {
    const repository = new InMemorySubmissionIntakeRepository();
    const handler = new ReceiveSubmission(new ContractValidator(), repository, {
      environment: "DEV",
      organizationKey: "dev-accounting-firm",
    });

    const result = await handler.execute({
      input: { schema_version: "1.0", files: [] },
      correlationId,
      workerId: "test-worker",
    });

    expect(result.outcome).toBe("rejected");
    expect(repository.accepted).toHaveLength(0);
  });

  it("rejects a payload for a different environment", async () => {
    const repository = new InMemorySubmissionIntakeRepository();
    const handler = new ReceiveSubmission(new ContractValidator(), repository, {
      environment: "UAT",
      organizationKey: "dev-accounting-firm",
    });

    const result = await handler.execute({ input: validSubmission(), workerId: "test-worker" });

    expect(result).toMatchObject({
      outcome: "rejected",
      errors: [{ instancePath: "/environment", message: "must equal runtime environment UAT" }],
    });
    expect(repository.accepted).toHaveLength(0);
  });

  it("rejects an unknown case before persistence", async () => {
    const repository = new InMemorySubmissionIntakeRepository();
    const handler = new ReceiveSubmission(new ContractValidator(), repository, {
      environment: "DEV",
      organizationKey: "dev-accounting-firm",
    });
    const input = validSubmission() as { case_key: string };
    input.case_key = "unknown-case";

    const result = await handler.execute({ input, workerId: "test-worker" });

    expect(result).toMatchObject({ outcome: "rejected", errors: [{ instancePath: "/case_key" }] });
    expect(repository.accepted).toHaveLength(0);
  });

  it("rejects a tenant key that is not bound to the intake credential", async () => {
    const repository = new InMemorySubmissionIntakeRepository();
    const handler = new ReceiveSubmission(new ContractValidator(), repository, {
      environment: "DEV",
      organizationKey: "different-tenant",
    });

    const result = await handler.execute({ input: validSubmission(), workerId: "test-worker" });

    expect(result).toMatchObject({ outcome: "rejected", errors: [{ instancePath: "/organization_key" }] });
    expect(repository.accepted).toHaveLength(0);
  });

  it("rejects an explicit real-data claim in UAT before persistence", async () => {
    const repository = new InMemorySubmissionIntakeRepository();
    const handler = new ReceiveSubmission(new ContractValidator(), repository, {
      environment: "UAT",
      organizationKey: "dev-accounting-firm",
    });
    const input = validSubmission() as Record<string, unknown>;
    input.environment = "UAT";
    input.data_classification = {
      mode: "real_data",
      production_admission_policy_key: "prod.blue-peak.2026-q3",
    };
    const result = await handler.execute({ input, workerId: "test-worker" });
    expect(result).toMatchObject({
      outcome: "rejected",
      errors: [{ instancePath: "/data_classification/mode" }],
    });
    expect(repository.accepted).toHaveLength(0);
  });

  it("requires an explicit real-data claim in PROD", async () => {
    const repository = new InMemorySubmissionIntakeRepository();
    const handler = new ReceiveSubmission(new ContractValidator(), repository, {
      environment: "PROD",
      organizationKey: "dev-accounting-firm",
    });
    const input = validSubmission() as Record<string, unknown>;
    input.environment = "PROD";
    const result = await handler.execute({ input, workerId: "test-worker" });
    expect(result).toMatchObject({
      outcome: "rejected",
      errors: [{ instancePath: "/data_classification/mode" }],
    });
    expect(repository.accepted).toHaveLength(0);
  });

  it("still blocks PROD when a claim exists but no active database policy authorizes it", async () => {
    const repository = new InMemorySubmissionIntakeRepository();
    const handler = new ReceiveSubmission(new ContractValidator(), repository, {
      environment: "PROD",
      organizationKey: "dev-accounting-firm",
    });
    const input = validSubmission() as Record<string, unknown>;
    input.environment = "PROD";
    input.data_classification = {
      mode: "real_data",
      production_admission_policy_key: "prod.blue-peak.2026-q3",
    };
    const result = await handler.execute({ input, workerId: "test-worker" });
    expect(result).toMatchObject({
      outcome: "rejected",
      errors: [{ instancePath: "/data_classification" }],
    });
    expect(repository.accepted).toHaveLength(0);
  });
});
