import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ReceiveSubmission, ReceiveSubmissionResult } from "../application/receive-submission.js";

interface RoutedHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export interface IntakeServerOptions {
  handler: ReceiveSubmission;
  intakeToken: string;
  environment: "DEV" | "UAT" | "PROD";
  releaseCommit?: string | null;
  maxBodyBytes?: number;
  requestsPerMinute?: number;
  now?: () => Date;
  opsRouter?: RoutedHttpHandler;
  workbenchRouter?: RoutedHttpHandler;
  clientPortalRouter?: RoutedHttpHandler;
  connectorRouter?: RoutedHttpHandler;
}

interface RateBucket {
  windowStartedAt: number;
  count: number;
}

export function createIntakeServer(options: IntakeServerOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const requestsPerMinute = options.requestsPerMinute ?? 30;
  const now = options.now ?? (() => new Date());
  const expectedTokenHash = sha256(options.intakeToken);
  const buckets = new Map<string, RateBucket>();

  const server = createServer(async (request, response) => {
    applySecurityHeaders(response);
    const requestId = normalizeRequestId(request.headers["x-request-id"]) ?? randomUUID();
    response.setHeader("x-request-id", requestId);

    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          status: "ok", environment: options.environment, releaseCommit: options.releaseCommit ?? null,
        });
      }
      if (options.opsRouter && await options.opsRouter.handle(request, response)) return;
      if (options.workbenchRouter && await options.workbenchRouter.handle(request, response)) return;
      if (options.clientPortalRouter && await options.clientPortalRouter.handle(request, response)) return;
      if (options.connectorRouter && await options.connectorRouter.handle(request, response)) return;
      if (request.method !== "POST" || url.pathname !== "/v1/submissions") {
        return sendJson(response, 404, { error: "not_found", request_id: requestId });
      }
      if (!authorized(request, expectedTokenHash)) {
        return sendJson(response, 401, { error: "unauthorized", request_id: requestId });
      }
      if (!allowRequest(request, buckets, requestsPerMinute, now().getTime())) {
        response.setHeader("retry-after", "60");
        return sendJson(response, 429, { error: "rate_limited", request_id: requestId });
      }
      if (!isJsonContentType(request.headers["content-type"])) {
        return sendJson(response, 415, { error: "content_type_must_be_application_json", request_id: requestId });
      }

      const rawBody = await readBody(request, maxBodyBytes);
      let input: unknown;
      try {
        input = JSON.parse(rawBody);
      } catch {
        return sendJson(response, 400, { error: "invalid_json", request_id: requestId });
      }

      const result = await options.handler.execute({
        input,
        workerId: `http-intake:${requestId}`,
        correlationId: requestId,
        now: now(),
      });
      return sendResult(response, requestId, result);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return sendJson(response, 413, { error: "payload_too_large", request_id: requestId });
      }
      return sendJson(response, 500, { error: "internal_error", request_id: requestId });
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function sendResult(response: ServerResponse, requestId: string, result: ReceiveSubmissionResult): void {
  if (result.outcome === "accepted") {
    return sendJson(response, 202, {
      outcome: result.outcome,
      request_id: requestId,
      submission_id: result.submissionId,
      document_ids: result.documentIds,
      event_ids: result.eventIds,
    });
  }
  if (result.outcome === "rejected") {
    return sendJson(response, 422, { outcome: result.outcome, request_id: requestId, errors: result.errors });
  }
  return sendJson(response, 200, { outcome: result.outcome, request_id: requestId });
}

function authorized(request: IncomingMessage, expectedTokenHash: Buffer): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const supplied = authorization.slice("Bearer ".length);
  if (!supplied) {
    return false;
  }
  return timingSafeEqual(sha256(supplied), expectedTokenHash);
}

function allowRequest(
  request: IncomingMessage,
  buckets: Map<string, RateBucket>,
  limit: number,
  now: number,
): boolean {
  const key = request.socket.remoteAddress ?? "unknown";
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStartedAt >= 60_000) {
    buckets.set(key, { windowStartedAt: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= limit;
}

function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) {
        reject(new BodyTooLargeError());
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

class BodyTooLargeError extends Error {}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function normalizeRequestId(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : undefined;
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
