export interface DemoFormAuthorizationRequest {
  connectorKey: string;
  providerFormId: string;
  providerSubmissionId: string;
  invitationTokenSha256: string;
  claimedPeriod: string;
  fileCount: number;
  declaredTotalBytes: number;
  declaredBytesComplete: boolean;
  mimeTypes: string[];
  correlationId: string;
  now: Date;
}

export interface DemoFormAuthorizedScope {
  organizationKey: string;
  workflowTemplateKey: string;
  subjectKey: string;
  subjectDisplayName: string;
  caseKey: string;
  period: string;
  timezone: string;
}

export type DemoFormAuthorizationResult =
  | ({ outcome: "authorized" | "duplicate"; authorizationId: string } & DemoFormAuthorizedScope)
  | { outcome: "rejected"; reason:
      | "entry_not_active"
      | "invitation_not_found"
      | "invitation_not_active"
      | "invitation_not_current"
      | "invitation_expired"
      | "invitation_submission_limit_reached"
      | "case_not_receiving"
      | "synthetic_scope_required"
      | "period_mismatch"
      | "file_count_exceeded"
      | "declared_bytes_required"
      | "declared_bytes_exceeded"
      | "mime_type_required"
      | "mime_type_not_allowed"
      | "idempotency_payload_mismatch"
      | "invalid_request" };

export interface DemoFormAuthorizationRepository {
  authorize(
    organizationKey: string,
    request: DemoFormAuthorizationRequest,
  ): Promise<DemoFormAuthorizationResult>;
}
