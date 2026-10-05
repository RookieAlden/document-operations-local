import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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

export class LocalDocumentSourceError extends Error {
  readonly code = "source_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "LocalDocumentSourceError";
  }
}

export class LocalDocumentSourceResolver implements DocumentSourceResolver {
  constructor(
    private readonly documentRoot: string,
    private readonly maximumBytes = 20 * 1024 * 1024,
  ) {
    if (!isAbsolute(documentRoot)) throw new Error("Document root must be an absolute path");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error("Maximum document bytes must be a positive integer");
    }
  }

  async resolve(request: ResolveDocumentSourceRequest): Promise<ClassificationSource> {
    const relativeReference = parseLocalReference(request.storageReference);
    const root = await safeRealpath(this.documentRoot);
    const candidate = await safeRealpath(resolve(root, relativeReference));
    const fromRoot = relative(root, candidate);
    if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new LocalDocumentSourceError("Document reference is outside the configured root");
    }

    const metadata = await stat(candidate).catch(() => null);
    if (!metadata?.isFile()) throw new LocalDocumentSourceError("Document source is not a regular file");
    if (metadata.size > this.maximumBytes) {
      throw new LocalDocumentSourceError("Document exceeds the configured source size limit");
    }

    const mimeType = request.declaredMimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
    if (![...IMAGE_MIME_TYPES, ...TEXT_MIME_TYPES, ...FILE_MIME_TYPES].includes(mimeType)) {
      throw new LocalDocumentSourceError("Document MIME type is not supported by the local resolver");
    }
    const content = await readFile(candidate);
    if (IMAGE_MIME_TYPES.has(mimeType)) {
      return { kind: "image_url", imageUrl: `data:${mimeType};base64,${content.toString("base64")}`, detail: "high" };
    }
    if (TEXT_MIME_TYPES.has(mimeType)) {
      return { kind: "text", text: content.toString("utf8") };
    }
    return {
      kind: "file_data",
      filename: request.filename,
      mimeType,
      base64: content.toString("base64"),
    };
  }
}

function parseLocalReference(reference: string): string {
  if (!reference.startsWith("local://")) {
    throw new LocalDocumentSourceError("Document reference must use the local:// scheme");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference.slice("local://".length));
  } catch {
    throw new LocalDocumentSourceError("Document reference contains invalid encoding");
  }
  if (!decoded || decoded.includes("\0") || isAbsolute(decoded)) {
    throw new LocalDocumentSourceError("Document reference is invalid");
  }
  return decoded;
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new LocalDocumentSourceError("Document source is unavailable");
  }
}
