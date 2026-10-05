import { randomUUID } from "node:crypto";
import type { DocumentObjectStore } from "../ports/document-object-store.js";
import type { DocumentPreservationRepository } from "../ports/document-preservation-repository.js";
import type { SourceDocumentDownloader } from "../ports/source-document-downloader.js";

export type PreserveNextDocumentResult =
  | { outcome: "empty" }
  | { outcome: "stored"; documentId: string; storageReference: string; sizeBytes: number; sha256: string }
  | { outcome: "failed_recoverable" | "failed_manual"; documentId: string; errorCode: string };

export class PreserveNextDocument {
  constructor(
    private readonly repository: DocumentPreservationRepository,
    private readonly downloader: SourceDocumentDownloader,
    private readonly objectStore: DocumentObjectStore,
    private readonly scope: {
      environment: "DEV" | "UAT" | "PROD";
      organizationKey: string;
    },
  ) {}

  async execute(command: { workerId: string; correlationId?: string; now?: Date }): Promise<PreserveNextDocumentResult> {
    const now = command.now ?? new Date();
    const correlationId = command.correlationId ?? randomUUID();
    const reserved = await this.repository.reserveNext({
      organizationKey: this.scope.organizationKey,
      workerId: command.workerId,
      leaseSeconds: 300,
      now,
    });
    if (reserved.outcome === "empty") return reserved;
    const { context } = reserved;

    try {
      const downloaded = await this.downloader.download({
        url: context.sourceDownloadReference,
        filename: context.filename,
        declaredMimeType: context.declaredMimeType,
        declaredSizeBytes: context.declaredSizeBytes,
        expectedSha256: context.expectedSha256,
      });
      const stored = await this.objectStore.put({
        organizationKey: context.organizationKey,
        documentId: context.documentId,
        filename: context.filename,
        mimeType: downloaded.mimeType,
        sha256: downloaded.sha256,
        content: downloaded.content,
      });
      await this.repository.complete({
        context,
        downloaded,
        storageReference: stored.storageReference,
        workflowRunId: randomUUID(),
        eventId: randomUUID(),
        correlationId,
        environment: this.scope.environment,
        now,
      });
      return {
        outcome: "stored",
        documentId: context.documentId,
        storageReference: stored.storageReference,
        sizeBytes: downloaded.sizeBytes,
        sha256: downloaded.sha256,
      };
    } catch (error) {
      const failure = codedFailure(error);
      await this.repository.fail({
        context,
        failureMode: failure.failureMode,
        errorCode: failure.code,
        errorClass: failure.errorClass,
        workflowRunId: randomUUID(),
        workflowErrorId: randomUUID(),
        eventId: randomUUID(),
        correlationId,
        environment: this.scope.environment,
        now,
      });
      return {
        outcome: failure.failureMode === "manual" ? "failed_manual" : "failed_recoverable",
        documentId: context.documentId,
        errorCode: failure.code,
      };
    }
  }
}

function codedFailure(error: unknown): {
  code: string;
  failureMode: "recoverable" | "manual";
  errorClass: "connector" | "validation" | "unknown";
} {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; failureMode?: unknown };
    if (typeof candidate.code === "string") {
      const failureMode = candidate.failureMode === "manual" ? "manual" : "recoverable";
      return {
        code: candidate.code,
        failureMode,
        errorClass: candidate.code.startsWith("source_") ? "validation" : "connector",
      };
    }
  }
  return { code: "document_preservation_error", failureMode: "recoverable", errorClass: "unknown" };
}
