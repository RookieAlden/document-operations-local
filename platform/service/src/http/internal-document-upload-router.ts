import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DocumentObjectStore } from "../ports/document-object-store.js";

const allowedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);

export class InternalDocumentUploadRouter {
  private readonly expectedTokenHash: Buffer;

  constructor(
    private readonly objectStore: DocumentObjectStore,
    token: string,
    private readonly maximumBytes: number,
  ) {
    if (token.length < 32) throw new Error("DOP_INTERNAL_PREVIEW_TOKEN must contain at least 32 characters");
    if (!Number.isInteger(maximumBytes) || maximumBytes < 1) throw new Error("maximum document bytes must be positive");
    this.expectedTokenHash = sha256(token);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/internal/v1/document-upload") return false;
    securityHeaders(response);
    if (request.method !== "POST") return send(response, 404, { error: "not_found" });
    if (!authorized(request, this.expectedTokenHash)) return send(response, 401, { error: "unauthorized" });
    const mimeType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!allowedMimeTypes.has(mimeType)) return send(response, 415, { error: "unsupported_document_type" });
    const organizationKey = firstHeader(request.headers["x-dop-organization-key"]);
    const documentId = firstHeader(request.headers["x-dop-document-id"]);
    const encodedFilename = firstHeader(request.headers["x-dop-filename"]);
    const expectedSha256 = firstHeader(request.headers["x-dop-sha256"]);
    let filename = "";
    try { filename = decodeURIComponent(encodedFilename ?? ""); } catch { /* invalid below */ }
    if (!organizationKey || organizationKey.length > 160 || !isUuid(documentId ?? "")
      || !validFilename(filename) || !/^[0-9a-f]{64}$/.test(expectedSha256 ?? "")) {
      return send(response, 400, { error: "invalid_upload_metadata" });
    }
    let content: Buffer;
    try { content = await readBody(request, this.maximumBytes); }
    catch (error) {
      return send(response, error instanceof Error && error.message === "too_large" ? 413 : 400,
        { error: error instanceof Error && error.message === "too_large" ? "document_too_large" : "invalid_upload" });
    }
    const detectedMimeType = detectMime(content);
    const actualSha256 = createHash("sha256").update(content).digest("hex");
    if (detectedMimeType !== mimeType || actualSha256 !== expectedSha256) {
      return send(response, 422, { error: detectedMimeType !== mimeType ? "file_signature_mismatch" : "content_hash_mismatch" });
    }
    try {
      const stored = await this.objectStore.put({
        organizationKey,
        documentId: documentId!,
        filename,
        mimeType,
        content,
        sha256: actualSha256,
      });
      return send(response, 200, stored);
    } catch {
      return send(response, 503, { error: "storage_write_failed" });
    }
  }
}

function detectMime(content: Buffer): string | null {
  if (content.length >= 5 && content.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  return null;
}

function validFilename(value: string): boolean {
  return value.length >= 1 && value.length <= 180 && !/[\/\\\0\r\n]/.test(value);
}

function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return token.length > 0 && timingSafeEqual(sha256(token), expected);
}

async function readBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) { reject(new Error("too_large")); request.resume(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function sha256(value: string): Buffer { return createHash("sha256").update(value).digest(); }
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
