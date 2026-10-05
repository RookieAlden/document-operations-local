import type { CanonicalSubmission } from "../../domain/submission.js";
import type { FormConnectorFileMetadataResolver } from "../../http/form-connector-router.js";

export interface HttpsSourceFileMetadataResolverOptions {
  allowedHosts: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SourceFileMetadataError extends Error {
  constructor(readonly reason: "host_not_allowed" | "metadata_unavailable" | "invalid_content_length") {
    super(reason);
  }
}

export class HttpsSourceFileMetadataResolver implements FormConnectorFileMetadataResolver {
  private readonly allowedHosts: Set<string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpsSourceFileMetadataResolverOptions) {
    this.allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    if (this.allowedHosts.size === 0) throw new Error("at least one source metadata host is required");
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async resolve(files: CanonicalSubmission["files"]): Promise<CanonicalSubmission["files"]> {
    return await Promise.all(files.map(async (file) => {
      if (file.declared_size_bytes !== undefined && file.declared_mime_type) return file;
      const url = this.allowedUrl(file.download_url);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new SourceFileMetadataError("metadata_unavailable");
      }
      if (!response.ok || response.status >= 300) {
        throw new SourceFileMetadataError("metadata_unavailable");
      }
      const contentLength = response.headers.get("content-length");
      const size = contentLength === null ? NaN : Number(contentLength);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new SourceFileMetadataError("invalid_content_length");
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      return {
        ...file,
        declared_size_bytes: file.declared_size_bytes ?? size,
        ...(file.declared_mime_type || !contentType ? {} : { declared_mime_type: contentType }),
      };
    }));
  }

  private allowedUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new SourceFileMetadataError("host_not_allowed");
    }
    if (url.protocol !== "https:" || url.username || url.password ||
        (url.port !== "" && url.port !== "443") || !this.allowedHosts.has(url.hostname.toLowerCase())) {
      throw new SourceFileMetadataError("host_not_allowed");
    }
    return url.toString();
  }
}
