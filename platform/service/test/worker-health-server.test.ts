import { request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerHealthServer } from "../src/http/worker-health-server.js";
import type { ClassificationWorkerSnapshot } from "../src/runtime/classification-worker-loop.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function snapshot(overrides: Partial<ClassificationWorkerSnapshot> = {}): ClassificationWorkerSnapshot {
  return {
    status: "running", startedAt: "2026-08-07T00:00:00.000Z",
    lastPollAt: "2026-08-07T01:00:00.000Z", lastReadyAt: "2026-08-07T01:00:00.000Z",
    lastErrorAt: null, lastErrorCode: null, activeJobs: 0, completedJobs: 2,
    reviewJobs: 0, failedJobs: 0, ...overrides,
  };
}

async function call(workerSnapshot: ClassificationWorkerSnapshot, path: string): Promise<{ status: number; body: unknown }> {
  const server = createWorkerHealthServer(
    { snapshot: () => workerSnapshot }, 30_000, () => new Date("2026-08-07T01:00:10.000Z"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("health server did not bind");
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: address.port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("worker health server", () => {
  it("keeps liveness separate from a paused classification circuit", async () => {
    const paused = snapshot({ circuitOpen: true, circuitErrorCode: "project_spend_limit_exceeded" });
    await expect(call(paused, "/ready")).resolves.toMatchObject({
      status: 503, body: { status: "paused", reason: "classification_circuit_open" },
    });
    await expect(call(paused, "/health")).resolves.toMatchObject({ status: 503 });
    await expect(call(paused, "/live")).resolves.toMatchObject({ status: 200 });
  });
  it("reports liveness without returning configuration secrets", async () => {
    const result = await call(snapshot(), "/live");
    expect(result).toEqual({ status: 200, body: { status: "ok", releaseCommit: null } });
  });

  it("exposes the non-secret release commit in health evidence", async () => {
    const server = createWorkerHealthServer(
      { snapshot: () => snapshot() }, 30_000, () => new Date("2026-08-07T01:00:10.000Z"), undefined,
      "a".repeat(40),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("health server did not bind");
    const body = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: address.port, path: "/health" }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      });
      req.on("error", reject); req.end();
    });
    expect(body).toMatchObject({ status: "ready", releaseCommit: "a".repeat(40) });
  });

  it("reports ready only after a recent successful database check", async () => {
    await expect(call(snapshot(), "/ready")).resolves.toMatchObject({
      status: 200, body: { status: "ready", worker: { completedJobs: 2 } },
    });
    await expect(call(snapshot({ lastReadyAt: "2026-08-07T00:00:00.000Z" }), "/ready"))
      .resolves.toMatchObject({ status: 503, body: { status: "not_ready" } });
  });

  it("reports a stopped worker unavailable", async () => {
    await expect(call(snapshot({ status: "stopped" }), "/live"))
      .resolves.toEqual({ status: 503, body: { status: "stopped", releaseCommit: null } });
  });
});
