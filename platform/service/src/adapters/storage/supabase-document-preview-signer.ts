import type { DocumentPreviewSigner } from "../../ports/document-preview.js";

export class DocumentPreviewError extends Error {
  constructor(readonly code: "invalid_reference" | "signing_failed") {
    super(code);
  }
}

export interface SupabaseDocumentPreviewSignerOptions {
  projectUrl: string;
  accessToken: string;
  bucket: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class SupabaseDocumentPreviewSigner implements DocumentPreviewSigner {
  private readonly projectUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: SupabaseDocumentPreviewSignerOptions) {
    const url = new URL(options.projectUrl);
    if (url.protocol !== "https:") throw new Error("Supabase project URL must use HTTPS");
    if (!options.accessToken) throw new Error("Supabase Storage access token is required");
    if (!validSegment(options.bucket)) throw new Error("Supabase Storage bucket is invalid");
    this.projectUrl = url.toString().replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  async createSignedPreview(storageReference: string, expiresInSeconds: number): Promise<{ url: string; expiresAt: string }> {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 15 || expiresInSeconds > 300) {
      throw new DocumentPreviewError("invalid_reference");
    }
    const { bucket, objectPath } = parseReference(storageReference);
    if (bucket !== this.options.bucket) throw new DocumentPreviewError("invalid_reference");
    const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.projectUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedPath}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.accessToken}`,
            apikey: this.options.accessToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({ expiresIn: expiresInSeconds }),
        },
      );
    } catch {
      throw new DocumentPreviewError("signing_failed");
    }
    if (!response.ok) throw new DocumentPreviewError("signing_failed");
    const body = await response.json() as { signedURL?: unknown; signedUrl?: unknown };
    const signedPath = typeof body.signedURL === "string" ? body.signedURL
      : typeof body.signedUrl === "string" ? body.signedUrl : null;
    if (!signedPath) throw new DocumentPreviewError("signing_failed");
    const url = signedPath.startsWith("https://")
      ? new URL(signedPath).toString()
      : signedPath.startsWith("/storage/v1/")
        ? `${this.projectUrl}${signedPath}`
        : `${this.projectUrl}/storage/v1/${signedPath.replace(/^\/+/, "")}`;
    if (new URL(url).origin !== new URL(this.projectUrl).origin) throw new DocumentPreviewError("signing_failed");
    return {
      url,
      expiresAt: new Date(this.now().getTime() + expiresInSeconds * 1_000).toISOString(),
    };
  }
}

function parseReference(reference: string): { bucket: string; objectPath: string } {
  if (!reference.startsWith("supabase://")) throw new DocumentPreviewError("invalid_reference");
  let decoded: string;
  try { decoded = decodeURIComponent(reference.slice("supabase://".length)); }
  catch { throw new DocumentPreviewError("invalid_reference"); }
  const slash = decoded.indexOf("/");
  const bucket = slash < 0 ? "" : decoded.slice(0, slash);
  const objectPath = slash < 0 ? "" : decoded.slice(slash + 1);
  if (!validSegment(bucket) || objectPath.split("/").some((part) => !validSegment(part))) {
    throw new DocumentPreviewError("invalid_reference");
  }
  return { bucket, objectPath };
}

function validSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("\0");
}
