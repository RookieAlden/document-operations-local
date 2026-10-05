export type Environment = "DEV" | "UAT" | "PROD";

export interface CanonicalSubmission {
  schema_version: "1.0";
  environment: Environment;
  organization_key: string;
  workflow_template_key: string;
  case_key: string;
  subject: {
    subject_key: string;
    display_name?: string;
  };
  source: {
    type: "fillout" | "email" | "api" | "internal_upload";
    connector_key?: string;
    submission_id: string;
    received_at: string;
    source_reference?: string;
  };
  business_context?: {
    period?: string;
    timezone?: string;
    [key: string]: unknown;
  };
  data_classification?: {
    mode: "synthetic_only" | "real_data";
    production_admission_policy_key?: string;
  };
  files: Array<{
    source_file_id?: string;
    original_filename: string;
    download_url: string;
    declared_mime_type?: string;
    declared_size_bytes?: number;
    content_hash_sha256?: string;
  }>;
}

export function submissionIdempotencyKey(submission: CanonicalSubmission): string {
  return `${submission.source.type}|${submission.source.submission_id}`;
}

export function documentIdempotencyKey(
  submission: CanonicalSubmission,
  file: CanonicalSubmission["files"][number],
  index: number,
): string {
  const stableFilePart = file.source_file_id
    ?? file.content_hash_sha256
    ?? `${index}|${file.original_filename}|${file.declared_size_bytes ?? "unknown-size"}`;
  return `${submission.source.type}|${submission.source.submission_id}|${stableFilePart}`;
}
