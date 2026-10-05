import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DocumentPreviewSigner } from "../ports/document-preview.js";

export class InternalDocumentPreviewRouter {
  private readonly expectedTokenHash: Buffer;

  constructor(private readonly signer: DocumentPreviewSigner, token: string) {
    if (token.length < 32) throw new Error("DOP_INTERNAL_PREVIEW_TOKEN must contain at least 32 characters");
    this.expectedTokenHash = sha256(token);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/internal/v1/document-preview") return false;
    securityHeaders(response);
    if (request.method !== "POST") return send(response, 404, { error: "not_found" });
    if (!authorized(request, this.expectedTokenHash)) return send(response, 401, { error: "unauthorized" });
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return send(response, 415, { error: "content_type_must_be_application_json" });
    }
    let body: unknown;
    try { body = await readBody(request, 4_096); }
    catch { return send(response, 400, { error: "invalid_request" }); }
    const storageReference = typeof body === "object" && body !== null && "storageReference" in body
      ? (body as { storageReference?: unknown }).storageReference : null;
    if (typeof storageReference !== "string" || storageReference.length > 2_000) {
      return send(response, 400, { error: "invalid_request" });
    }
    try {
      return send(response, 200, await this.signer.createSignedPreview(storageReference, 60));
    } catch {
      return send(response, 404, { error: "preview_unavailable" });
    }
  }
}

function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return token.length > 0 && timingSafeEqual(sha256(token), expected);
}

async function readBody(request: IncomingMessage, maximum: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) { reject(new Error("too_large")); request.resume(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("invalid_json")); } });
    request.on("error", reject);
  });
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("x-content-type-options", "nosniff");
}

function send(response: ServerResponse, status: number, body: unknown): true {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
  return true;
}

function sha256(value: string): Buffer { return createHash("sha256").update(value).digest(); }
