import type { CanonicalSubmission } from "../domain/submission.js";

export interface PlannedDocument {
  id: string;
  idempotencyKey: string;
  file: CanonicalSubmission["files"][number];
  eventId: string;
}

export interface AcceptSubmissionRequest {
  submission: CanonicalSubmission;
  submissionId: string;
  submissionKey: string;
  correlationId: string;
  workflowRunId: string;
  submissionEventId: string;
  documents: PlannedDocument[];
  workerId: string;
  leaseSeconds: number;
  now: Date;
}

export type AcceptSubmissionResult =
  | {
      outcome: "accepted";
      organizationId: string;
      caseId: string;
      submissionId: string;
      documentIds: string[];
      eventIds: string[];
    }
  | { outcome: "duplicate"; submissionId: string | null }
  | { outcome: "in_progress"; leaseExpiresAt: Date | null }
  | { outcome: "binding_rejected"; reason:
      | "source_connector_not_active" | "source_connector_claim_required"
      | "source_connector_claim_mismatch" | "source_connector_transport_mismatch"
      | "source_connector_documents_capability_required" | "source_connector_webhook_capability_required"
      | "source_connector_attachment_capability_required" | "source_connector_file_count_exceeded"
      | "source_connector_declared_mime_required" | "source_connector_declared_size_required"
      | "source_connector_mime_not_allowed" | "source_connector_file_too_large" }
  | { outcome: "admission_rejected"; reason:
      | "nonproduction_real_data_blocked" | "synthetic_subject_required"
      | "production_real_data_claim_required" | "production_subject_and_case_not_authorized"
      | "production_policy_key_required"
      | "active_production_policy_required" | "production_policy_expired"
      | "production_policy_evidence_invalid" | "production_period_out_of_scope"
      | "production_source_out_of_scope" | "production_file_boundary_exceeded"
      | "production_mime_out_of_scope" | "idempotency_payload_mismatch"
      | "data_admission_invalid_request" }
  | { outcome: "not_found"; resource: "organization" | "case_or_workflow" };

export interface SubmissionIntakeRepository {
  accept(request: AcceptSubmissionRequest): Promise<AcceptSubmissionResult>;
}
