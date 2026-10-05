export interface StoredOpsUpload {
  caseId: string;
  documentId: string;
  submissionId: string;
  actorId: string;
  filename: string;
  mimeType: "application/pdf" | "image/jpeg" | "image/png";
  sizeBytes: number;
  sha256: string;
  storageReference: string;
  idempotencyKey: string;
  now: Date;
}

export type OpsUploadResult =
  | { outcome: "completed"; caseId: string; documentId: string; submissionId: string; documentStatus: "incoming_saved" }
  | { outcome: "duplicate"; caseId: string; documentId: string | null; submissionId: string | null }
  | { outcome: "not_found"; reason: "case_not_found" }
  | { outcome: "conflict"; reason: "case_closed" | "idempotency_key_reused" };

export type OpsCaseCompletionResult =
  | { outcome: "completed"; caseId: string; taskId: string; taskType: string; assignedActorId: string; dueAt: string | null }
  | { outcome: "duplicate"; caseId: string; taskId: string | null }
  | { outcome: "not_found"; reason: "case_not_found" }
  | { outcome: "conflict"; reason:
      | "manager_required"
      | "case_not_ready"
      | "completeness_not_complete"
      | "open_issues_remaining"
      | "documents_still_processing"
      | "assignee_invalid"
      | "idempotency_key_reused" };

export interface OpsTrialRepository {
  acceptStoredUpload(organizationKey: string, request: StoredOpsUpload): Promise<OpsUploadResult>;
  completeCase(organizationKey: string, request: {
    caseId: string;
    actorId: string;
    assignedActorId: string | null;
    reason: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<OpsCaseCompletionResult>;
}

export interface OpsDocumentUploadBroker {
  store(request: {
    organizationKey: string;
    documentId: string;
    filename: string;
    mimeType: StoredOpsUpload["mimeType"];
    content: Buffer;
    sha256: string;
  }): Promise<{ storageReference: string }>;
}
