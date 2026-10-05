import type { ClassificationSource } from "../../ports/classification-provider.js";
import type {
  DocumentSourceResolver,
  ResolveDocumentSourceRequest,
} from "../../ports/document-source-resolver.js";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TEXT_MIME_TYPES = new Set(["text/plain", "text/csv"]);
const FILE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export class SupabaseDocumentSourceError extends Error {
  readonly code = "source_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "SupabaseDocumentSourceError";
  }
}

export interface SupabaseDocumentSourceResolverOptions {
  projectUrl: string;
  accessToken: string;
  bucket: string;
  maximumBytes?: number;
  fetch?: typeof fetch;
}

export class SupabaseDocumentSourceResolver implements DocumentSourceResolver {
  private readonly fetchImplementation: typeof fetch;
  private readonly maximumBytes: number;
  private readonly projectUrl: string;

  constructor(private readonly options: SupabaseDocumentSourceResolverOptions) {
    const url = new URL(options.projectUrl);
    if (url.protocol !== "https:") throw new Error("Supabase project URL must use HTTPS");
    if (!options.accessToken) throw new Error("Supabase Storage access token is required");
    if (!validSegment(options.bucket)) throw new Error("Supabase Storage bucket is invalid");
    this.maximumBytes = options.maximumBytes ?? 20 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1) {
      throw new Error("Maximum document bytes must be a positive integer");
    }
    this.projectUrl = url.toString().replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async resolve(request: ResolveDocumentSourceRequest): Promise<ClassificationSource> {
    const { bucket, objectPath } = parseReference(request.storageReference);
    if (bucket !== this.options.bucket) {
      throw new SupabaseDocumentSourceError("Document reference targets an unexpected bucket");
    }
    const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.projectUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encodedPath}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${this.options.accessToken}`,
            apikey: this.options.accessToken,
          },
        },
      );
    } catch {
      throw new SupabaseDocumentSourceError("Supabase Storage request failed");
    }
    if (!response.ok) {
      throw new SupabaseDocumentSourceError(`Supabase Storage returned HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.maximumBytes) {
      throw new SupabaseDocumentSourceError("Document exceeds the configured source size limit");
    }
    const content = Buffer.from(await response.arrayBuffer());
    if (content.byteLength > this.maximumBytes) {
      throw new SupabaseDocumentSourceError("Document exceeds the configured source size limit");
    }

    const mimeType = canonicalMime(request.declaredMimeType);
    const responseMime = canonicalMime(response.headers.get("content-type") ?? mimeType);
    if (responseMime !== mimeType) {
      throw new SupabaseDocumentSourceError("Stored object MIME type differs from the declared MIME type");
    }
    if (IMAGE_MIME_TYPES.has(mimeType)) {
      return { kind: "image_url", imageUrl: `data:${mimeType};base64,${content.toString("base64")}`, detail: "high" };
    }
    if (TEXT_MIME_TYPES.has(mimeType)) return { kind: "text", text: content.toString("utf8") };
    if (FILE_MIME_TYPES.has(mimeType)) {
      return { kind: "file_data", filename: request.filename, mimeType, base64: content.toString("base64") };
    }
    throw new SupabaseDocumentSourceError("Document MIME type is not supported by the Supabase resolver");
  }
}

function parseReference(reference: string): { bucket: string; objectPath: string } {
  if (!reference.startsWith("supabase://")) {
    throw new SupabaseDocumentSourceError("Document reference must use the supabase:// scheme");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference.slice("supabase://".length));
  } catch {
    throw new SupabaseDocumentSourceError("Document reference contains invalid encoding");
  }
  const slash = decoded.indexOf("/");
  const bucket = slash < 0 ? "" : decoded.slice(0, slash);
  const objectPath = slash < 0 ? "" : decoded.slice(slash + 1);
  const segments = objectPath.split("/");
  if (!validSegment(bucket) || segments.length === 0 || segments.some((item) => !validSegment(item))) {
    throw new SupabaseDocumentSourceError("Document reference is invalid");
  }
  return { bucket, objectPath };
}

function validSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("\0");
}

function canonicalMime(value: string): string {
  return value.toLowerCase().split(";", 1)[0]?.trim() ?? "";
}
