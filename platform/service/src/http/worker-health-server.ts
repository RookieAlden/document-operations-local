import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ClassificationWorkerSnapshot } from "../runtime/classification-worker-loop.js";

export function createWorkerHealthServer(
  worker: { snapshot(): ClassificationWorkerSnapshot },
  readinessMaximumAgeMs: number,
  now: () => Date = () => new Date(),
  routedHandler?: { handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> },
  releaseCommit: string | null = null,
): Server {
  if (!Number.isInteger(readinessMaximumAgeMs) || readinessMaximumAgeMs < 1_000) {
    throw new Error("Readiness maximum age must be at least 1000ms");
  }
  return createServer(async (request, response) => {
    securityHeaders(response);
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (routedHandler && await routedHandler.handle(request, response)) return;
    if (request.method !== "GET") return send(response, 404, { error: "not_found" });
    const snapshot = worker.snapshot();
    if (path === "/live") {
      const live = snapshot.status !== "stopped";
      return send(response, live ? 200 : 503, { status: live ? "ok" : "stopped", releaseCommit });
    }
    if (path === "/ready" || path === "/health") {
      const ready = !snapshot.circuitOpen && snapshot.status === "running" && snapshot.lastReadyAt !== null &&
        now().getTime() - new Date(snapshot.lastReadyAt).getTime() <= readinessMaximumAgeMs;
      return send(response, ready ? 200 : 503, {
        status: snapshot.circuitOpen ? "paused" : ready ? "ready" : "not_ready",
        ...(snapshot.circuitOpen ? { reason: "classification_circuit_open", recovery: "Resolve the provider limit, then authorize recovery; do not auto-restart." } : {}),
        releaseCommit,
        worker: snapshot,
      });
    }
    return send(response, 404, { error: "not_found" });
  });
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("x-content-type-options", "nosniff");
}

function send(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
