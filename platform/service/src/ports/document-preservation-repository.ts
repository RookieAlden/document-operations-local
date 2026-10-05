import type { DownloadedSourceDocument } from "./source-document-downloader.js";

export interface DocumentPreservationContext {
  organizationId: string;
  organizationKey: string;
  caseId: string;
  documentId: string;
  reservationId: string;
  attemptNumber: number;
  sourceDownloadReference: string;
  filename: string;
  declaredMimeType: string | null;
  declaredSizeBytes: number | null;
  expectedSha256: string | null;
}

export type ReserveDocumentPreservationResult =
  | { outcome: "acquired"; context: DocumentPreservationContext }
  | { outcome: "empty" };

export interface DocumentPreservationRepository {
  reserveNext(request: {
    organizationKey: string;
    workerId: string;
    leaseSeconds: number;
    now: Date;
  }): Promise<ReserveDocumentPreservationResult>;
  complete(request: {
    context: DocumentPreservationContext;
    downloaded: DownloadedSourceDocument;
    storageReference: string;
    workflowRunId: string;
    eventId: string;
    correlationId: string;
    environment: "DEV" | "UAT" | "PROD";
    now: Date;
  }): Promise<void>;
  fail(request: {
    context: DocumentPreservationContext;
    failureMode: "recoverable" | "manual";
    errorCode: string;
    errorClass: "connector" | "validation" | "unknown";
    workflowRunId: string;
    workflowErrorId: string;
    eventId: string;
    correlationId: string;
    environment: "DEV" | "UAT" | "PROD";
    now: Date;
  }): Promise<void>;
}
