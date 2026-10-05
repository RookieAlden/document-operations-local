import type {
  DocumentObjectStore,
  PutDocumentObjectRequest,
} from "../../ports/document-object-store.js";

export class DocumentObjectStoreError extends Error {
  readonly code = "storage_write_failed";
  readonly failureMode = "recoverable";

  constructor(message: string) {
    super(message);
    this.name = "DocumentObjectStoreError";
  }
}

export class DocumentObjectDeleteError extends Error {
  readonly code = "storage_delete_failed";
  readonly failureMode = "recoverable";
  constructor(message:string){super(message);this.name="DocumentObjectDeleteError";}
}

export interface SupabaseDocumentObjectStoreOptions {
  projectUrl: string;
  accessToken: string;
  bucket: string;
  fetch?: typeof fetch;
}

export class SupabaseDocumentObjectStore implements DocumentObjectStore {
  private readonly projectUrl: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: SupabaseDocumentObjectStoreOptions) {
    const url = new URL(options.projectUrl);
    if (url.protocol !== "https:") throw new Error("Supabase project URL must use HTTPS");
    if (!options.accessToken) throw new Error("Supabase Storage access token is required");
    if (!safeSegment(options.bucket)) throw new Error("Supabase Storage bucket is invalid");
    this.projectUrl = url.toString().replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async put(request: PutDocumentObjectRequest): Promise<{ storageReference: string }> {
    const objectPath = [
      safePathSegment(request.organizationKey),
      safePathSegment(request.documentId),
      `${request.sha256}-${safeFilename(request.filename)}`,
    ].join("/");
    const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.projectUrl}/storage/v1/object/${encodeURIComponent(this.options.bucket)}/${encodedPath}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.accessToken}`,
            apikey: this.options.accessToken,
            "content-type": request.mimeType,
            "x-upsert": "false",
          },
          body: new Uint8Array(request.content),
        },
      );
    } catch {
      throw new DocumentObjectStoreError("Supabase Storage upload request failed");
    }
    const duplicate = response.status === 409 || await isSupabaseDuplicate(response);
    if (!response.ok && !duplicate) {
      throw new DocumentObjectStoreError(`Supabase Storage upload returned HTTP ${response.status}`);
    }
    return { storageReference: `supabase://${this.options.bucket}/${objectPath}` };
  }

  async delete(storageReference:string):Promise<"deleted"|"not_found"> {
    const parsed=parseStorageReference(storageReference,this.options.bucket);
    const encodedPath=parsed.split("/").map(encodeURIComponent).join("/");
    let response:Response;
    try {
      response=await this.fetchImplementation(
        `${this.projectUrl}/storage/v1/object/${encodeURIComponent(this.options.bucket)}/${encodedPath}`,
        {method:"DELETE",headers:{authorization:`Bearer ${this.options.accessToken}`,apikey:this.options.accessToken}},
      );
    } catch { throw new DocumentObjectDeleteError("Supabase Storage delete request failed"); }
    if (response.status===404) return "not_found";
    if (!response.ok) throw new DocumentObjectDeleteError(`Supabase Storage delete returned HTTP ${response.status}`);
    return "deleted";
  }
}

function parseStorageReference(reference:string,expectedBucket:string):string {
  const prefix=`supabase://${expectedBucket}/`;
  if (!reference.startsWith(prefix)) throw new DocumentObjectDeleteError("Storage reference is outside the configured bucket");
  const path=reference.slice(prefix.length);
  if (!path || path.split("/").some((segment)=>!safeSegment(segment))) {
    throw new DocumentObjectDeleteError("Storage reference path is invalid");
  }
  return path;
}

async function isSupabaseDuplicate(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  const body = await response.clone().json().catch(() => null) as {
    statusCode?: unknown;
    error?: unknown;
    code?: unknown;
  } | null;
  return body?.code === "KeyAlreadyExists"
    && (body.statusCode === 409 || body.statusCode === "409")
    && body.error === "Duplicate";
}

function safeFilename(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 180) || "document";
}

function safePathSegment(value: string): string {
  if (!safeSegment(value)) throw new DocumentObjectStoreError("Object path segment is invalid");
  return value;
}

function safeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\0");
}
