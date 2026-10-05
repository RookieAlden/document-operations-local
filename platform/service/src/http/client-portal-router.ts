import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { ClientPortalRepository } from "../ports/client-portal-repository.js";

export interface ClientPortalRouterOptions {
  repository: ClientPortalRepository;
  staticDirectory: string;
  environment: "DEV" | "UAT" | "PROD";
  now?: () => Date;
  requestsPerMinute?: number;
}

interface RateBucket { startedAt: number; count: number }

export class ClientPortalRouter {
  private readonly now: () => Date;
  private readonly requestsPerMinute: number;
  private readonly buckets = new Map<string, RateBucket>();

  constructor(private readonly options: ClientPortalRouterOptions) {
    this.now = options.now ?? (() => new Date());
    this.requestsPerMinute = options.requestsPerMinute ?? 90;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && (url.pathname === "/submit" || url.pathname === "/submit/")) {
      await this.sendAsset(response, "index.html", "text/html; charset=utf-8", false);
      return true;
    }
    const asset = portalAsset(url.pathname);
    if (request.method === "GET" && asset) {
      await this.sendAsset(response, asset.filename, asset.contentType, asset.cacheable);
      return true;
    }
    if (url.pathname !== "/v1/client-portal/case") return false;
    portalApiHeaders(response);
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (this.options.environment !== "UAT") {
      sendJson(response, 404, { error: "not_found" });
      return true;
    }
    const source = request.socket.remoteAddress ?? "unknown";
    if (!this.allow(source, this.now().getTime())) {
      response.setHeader("retry-after", "60");
      sendJson(response, 429, { error: "too_many_requests" });
      return true;
    }
    const token = portalToken(request);
    if (!token) {
      sendJson(response, 401, { error: "link_unavailable" });
      return true;
    }
    const tokenSha256 = createHash("sha256").update(token).digest("hex");
    const result = await this.options.repository.read(tokenSha256, randomUUID(), this.now());
    if (result.outcome !== "authorized") {
      sendJson(response, 401, { error: "link_unavailable" });
      return true;
    }
    const formUrl = `https://forms.fillout.com/t/${encodeURIComponent(result.providerFormId)}`;
    const submissionUrl = `${formUrl}?dop_invitation=${encodeURIComponent(token)}&period=${encodeURIComponent(result.periodKey)}`;
    sendJson(response, 200, { ...result.snapshot, submissionUrl });
    return true;
  }

  private allow(key: string, now: number): boolean {
    const existing = this.buckets.get(key);
    if (!existing || now - existing.startedAt >= 60_000) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= this.requestsPerMinute;
  }

  private async sendAsset(response: ServerResponse, filename: string, contentType: string, cacheable: boolean): Promise<void> {
    portalPageHeaders(response, cacheable);
    try {
      const body = await readFile(join(this.options.staticDirectory, filename));
      response.statusCode = 200;
      response.setHeader("content-type", contentType);
      response.end(body);
    } catch {
      sendJson(response, 404, { error: "not_found" });
    }
  }
}

function portalToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("DOP-Portal ")) return null;
  const token = authorization.slice("DOP-Portal ".length);
  return /^[A-Za-z0-9_-]{40,100}$/.test(token) ? token : null;
}

function portalAsset(pathname: string): { filename: string; contentType: string; cacheable: boolean } | null {
  if (pathname === "/client-portal/app.js") return { filename: "app.js", contentType: "text/javascript; charset=utf-8", cacheable: true };
  if (pathname === "/client-portal/app.css") return { filename: "app.css", contentType: "text/css; charset=utf-8", cacheable: true };
  return null;
}

function portalPageHeaders(response: ServerResponse, cacheable: boolean): void {
  response.setHeader("cache-control", cacheable ? "private, max-age=300" : "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
}

function portalApiHeaders(response: ServerResponse): void {
  portalPageHeaders(response, false);
  response.setHeader("vary", "Authorization");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
