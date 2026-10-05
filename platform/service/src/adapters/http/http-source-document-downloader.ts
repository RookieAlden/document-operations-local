import { createHash } from "node:crypto";
import type {
  DownloadedSourceDocument,
  DownloadSourceDocumentRequest,
  SourceDocumentDownloader,
} from "../../ports/source-document-downloader.js";

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export class SourceDocumentDownloadError extends Error {
  constructor(readonly code: string, readonly failureMode: "recoverable" | "manual") {
    super(code);
    this.name = "SourceDocumentDownloadError";
  }
}

export interface HttpSourceDocumentDownloaderOptions {
  allowedHosts: string[];
  maximumBytes?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HttpSourceDocumentDownloader implements SourceDocumentDownloader {
  private readonly allowedHosts: Set<string>;
  private readonly maximumBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: HttpSourceDocumentDownloaderOptions) {
    this.allowedHosts = new Set(options.allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
    if (this.allowedHosts.size === 0) throw new Error("At least one source download host is required");
    this.maximumBytes = options.maximumBytes ?? 20 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1) {
      throw new Error("Maximum source bytes must be a positive integer");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 300_000) {
      throw new Error("Source timeout must be an integer from 1000 to 300000");
    }
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async download(request: DownloadSourceDocumentRequest): Promise<DownloadedSourceDocument> {
    const url = safeSourceUrl(request.url, this.allowedHosts);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: [...ALLOWED_MIME_TYPES].join(",") },
      });
    } catch {
      throw new SourceDocumentDownloadError("source_download_failed", "recoverable");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new SourceDocumentDownloadError("source_redirect_rejected", "manual");
    }
    if (!response.ok) {
      const recoverable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      throw new SourceDocumentDownloadError(`source_http_${response.status}`, recoverable ? "recoverable" : "manual");
    }
    const headerLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(headerLength) && headerLength > this.maximumBytes) {
      throw new SourceDocumentDownloadError("source_too_large", "manual");
    }
    const content = await readBoundedBody(response, this.maximumBytes);
    if (request.declaredSizeBytes !== null && request.declaredSizeBytes !== content.byteLength) {
      throw new SourceDocumentDownloadError("source_size_mismatch", "manual");
    }
    const responseMime = canonicalMime(response.headers.get("content-type") ?? "");
    const declaredMime = canonicalMime(request.declaredMimeType ?? responseMime);
    if (!ALLOWED_MIME_TYPES.has(declaredMime) || responseMime !== declaredMime) {
      throw new SourceDocumentDownloadError("source_mime_mismatch", "manual");
    }
    if (!signatureMatches(declaredMime, content)) {
      throw new SourceDocumentDownloadError("source_signature_mismatch", "manual");
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (request.expectedSha256 !== null && request.expectedSha256.toLowerCase() !== sha256) {
      throw new SourceDocumentDownloadError("source_hash_mismatch", "manual");
    }
    return { content, mimeType: declaredMime, sizeBytes: content.byteLength, sha256 };
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new SourceDocumentDownloadError("source_too_large", "manual");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, total);
}

function safeSourceUrl(value: string, allowedHosts: Set<string>): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceDocumentDownloadError("source_url_invalid", "manual");
  }
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new SourceDocumentDownloadError("source_url_not_allowed", "manual");
  }
  return url;
}

function canonicalMime(value: string): string {
  return value.toLowerCase().split(";", 1)[0]?.trim() ?? "";
}

function signatureMatches(mimeType: string, content: Buffer): boolean {
  if (mimeType === "application/pdf") return content.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mimeType === "image/png") return content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mimeType === "image/jpeg") return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (mimeType === "image/webp") {
    return content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return content[0] === 0x50 && content[1] === 0x4b;
  }
  return !content.includes(0);
}
