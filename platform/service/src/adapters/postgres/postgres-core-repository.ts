import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  IdempotencyRepository,
  ReservationRequest,
  ReservationResult,
} from "../../ports/idempotency-repository.js";
import type { WorkflowEventRepository } from "../../ports/workflow-event-repository.js";
import type { WorkflowEvent } from "../../domain/workflow-event.js";
import type {
  AcceptSubmissionRequest,
  AcceptSubmissionResult,
  SubmissionIntakeRepository,
} from "../../ports/submission-intake-repository.js";

interface ReservationRow {
  id: string;
  status: string;
  lease_expires_at: Date | null;
}

interface IntakeContextRow {
  organization_id: string;
  case_id: string;
  source_connector_version_id: string | null;
  source_connector_definition_hash: string | null;
  source_connector_key: string | null;
  connector_lifecycle_status: string | null;
  connector_active_version_id: string | null;
  connector_version_status: string | null;
  connector_definition: Record<string, unknown> | null;
  connector_enforcement_profile: Record<string, unknown> | null;
}

interface ExistingIntakeRow {
  status: string;
  lease_expires_at: Date | null;
  resource_id: string | null;
}

interface DataAdmissionEvaluation {
  allowed?: boolean;
  reason?: string;
  decisionId?: string | null;
  policyId?: string | null;
}

export class PostgresCoreRepository implements
  IdempotencyRepository,
  WorkflowEventRepository,
  SubmissionIntakeRepository {
  constructor(private readonly pool: Pool) {}

  async reserve(request: ReservationRequest): Promise<ReservationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT dop_set_organization_context_by_id($1)", [request.organizationId]);
      const acquired = await this.acquireOrRecover(client, request);
      if (acquired) {
        await client.query("COMMIT");
        return {
          outcome: "acquired",
          reservationId: acquired.id,
          leaseExpiresAt: acquired.lease_expires_at as Date,
        };
      }

      const existing = await client.query<ReservationRow>(
        `SELECT id, status, lease_expires_at
           FROM idempotency_reservations
          WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
          FOR UPDATE`,
        [request.organizationId, request.scope, request.idempotencyKey],
      );
      await client.query("COMMIT");

      const row = existing.rows[0];
      if (!row) {
        throw new Error("idempotency reservation disappeared during transaction");
      }
      if (row.status === "processing") {
        return { outcome: "in_progress", reservationId: row.id, leaseExpiresAt: row.lease_expires_at };
      }
      return { outcome: "duplicate", reservationId: row.id, status: row.status };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async append(event: WorkflowEvent): Promise<"inserted" | "duplicate"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT dop_set_organization_context_by_id($1)", [event.organization_id]);
      const result = await client.query(
        `INSERT INTO workflow_events (
         id, organization_id, idempotency_key, event_type, event_version,
         aggregate_type, aggregate_id, correlation_id, causation_id, actor_id,
         producer, payload, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        event.event_id,
        event.organization_id,
        event.idempotency_key,
        event.event_type,
        event.event_version,
        event.aggregate_type,
        event.aggregate_id,
        event.correlation_id,
        event.causation_id ?? null,
        event.actor_id ?? null,
        event.producer,
        JSON.stringify(event.payload),
        event.occurred_at,
        ],
      );
      await client.query("COMMIT");
      return result.rowCount === 1 ? "inserted" : "duplicate";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async accept(request: AcceptSubmissionRequest): Promise<AcceptSubmissionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id",
        [request.submission.organization_key],
      );
      const organizationId = organization.rows[0]?.id;
      if (!organizationId) {
        await client.query("COMMIT");
        return { outcome: "not_found", resource: "organization" };
      }

      const context = await client.query<IntakeContextRow>(
        `SELECT c.organization_id, c.id AS case_id,
                c.source_connector_version_id, c.source_connector_definition_hash,
                connector.connector_key AS source_connector_key,
                connector.lifecycle_status AS connector_lifecycle_status,
                connector.active_version_id AS connector_active_version_id,
                connector_version.status AS connector_version_status,
                connector_version.definition AS connector_definition,
                connector_version.enforcement_profile AS connector_enforcement_profile
           FROM cases c
           JOIN workflow_template_versions wtv
             ON wtv.organization_id = c.organization_id
            AND wtv.id = c.workflow_template_version_id
           JOIN workflow_templates wt
             ON wt.organization_id = wtv.organization_id
             AND wt.id = wtv.workflow_template_id
           LEFT JOIN source_connector_versions connector_version
             ON connector_version.organization_id=c.organization_id
            AND connector_version.id=c.source_connector_version_id
           LEFT JOIN source_connectors connector
             ON connector.organization_id=connector_version.organization_id
            AND connector.id=connector_version.connector_id
          WHERE c.organization_id = $1
            AND c.case_key = $2
            AND wt.template_key = $3
            AND c.status <> 'cancelled'`,
        [organizationId, request.submission.case_key, request.submission.workflow_template_key],
      );
      const caseId = context.rows[0]?.case_id;
      if (!caseId) {
        await client.query("COMMIT");
        return { outcome: "not_found", resource: "case_or_workflow" };
      }
      const intakeContext = context.rows[0]!;
      if (intakeContext.source_connector_version_id) {
        if (intakeContext.connector_lifecycle_status !== "active"
          || intakeContext.connector_active_version_id !== intakeContext.source_connector_version_id
          || intakeContext.connector_version_status !== "active") {
          await client.query("COMMIT");
          return { outcome: "binding_rejected", reason: "source_connector_not_active" };
        }
        if (!request.submission.source.connector_key) {
          await client.query("COMMIT");
          return { outcome: "binding_rejected", reason: "source_connector_claim_required" };
        }
        if (request.submission.source.connector_key !== intakeContext.source_connector_key) {
          await client.query("COMMIT");
          return { outcome: "binding_rejected", reason: "source_connector_claim_mismatch" };
        }
        if (!submissionSourceMatchesConnector(request.submission.source.type, intakeContext.connector_definition)) {
          await client.query("COMMIT");
          return { outcome: "binding_rejected", reason: "source_connector_transport_mismatch" };
        }
        const capabilityError = connectorCapabilityBoundaryError(
          request.submission.source.type,
          intakeContext.connector_enforcement_profile,
          request.documents.map((document) => document.file),
        );
        if (capabilityError) {
          await client.query("COMMIT");
          return { outcome: "binding_rejected", reason: capabilityError };
        }
      }

      const dataMode = request.submission.data_classification?.mode
        ?? (request.submission.environment === "PROD" ? "real_data" : "synthetic_only");
      const admission = await client.query<{ result: DataAdmissionEvaluation }>(
        `SELECT public.dop_evaluate_submission_data_admission(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
         ) AS result`,
        [
          caseId,
          request.submission.environment,
          dataMode,
          request.submission.data_classification?.production_admission_policy_key ?? null,
          request.submission.source.type,
          request.documents.length,
          Math.max(...request.documents.map((document) => document.file.declared_size_bytes ?? 0)),
          request.documents.map((document) =>
            document.file.declared_mime_type?.trim().toLowerCase() || "__missing__"),
          dataAdmissionFingerprint(request),
          `data-admission|${request.submissionKey}`,
          request.correlationId,
          request.now,
        ],
      );
      const admissionResult = admission.rows[0]?.result;
      if (!admissionResult?.allowed) {
        await client.query("COMMIT");
        return {
          outcome: "admission_rejected",
          reason: dataAdmissionReason(admissionResult?.reason),
        };
      }

      // source_submission_id is the provider-level idempotency boundary. Older
      // ingestion paths may have used a different internal submission_key, so
      // resolve the source identity before reserving a new key and attempting
      // an INSERT that would otherwise fail the database uniqueness boundary.
      const existingSourceSubmission = await client.query<{ id: string }>(
        `SELECT id
           FROM submissions
          WHERE organization_id = $1
            AND source = $2
            AND source_submission_id = $3
          FOR UPDATE`,
        [
          organizationId,
          request.submission.source.type,
          request.submission.source.submission_id,
        ],
      );
      if (existingSourceSubmission.rows[0]) {
        await client.query("COMMIT");
        return { outcome: "duplicate", submissionId: existingSourceSubmission.rows[0].id };
      }

      const leaseExpiresAt = new Date(request.now.getTime() + request.leaseSeconds * 1000);
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO idempotency_reservations (
           organization_id, scope, idempotency_key, status, lease_owner,
           lease_expires_at, attempt_count, created_at, updated_at
         ) VALUES ($1,'submission.receive',$2,'processing',$3,$4,1,$5,$5)
         ON CONFLICT (organization_id, scope, idempotency_key) DO UPDATE
           SET status = 'processing',
               lease_owner = EXCLUDED.lease_owner,
               lease_expires_at = EXCLUDED.lease_expires_at,
               attempt_count = idempotency_reservations.attempt_count + 1,
               updated_at = EXCLUDED.updated_at,
               last_error_code = NULL
         WHERE idempotency_reservations.status = 'failed_recoverable'
            OR (idempotency_reservations.status = 'processing'
                AND idempotency_reservations.lease_expires_at < EXCLUDED.updated_at)
         RETURNING id`,
        [organizationId, request.submissionKey, request.workerId, leaseExpiresAt, request.now],
      );

      if (reservation.rowCount !== 1) {
        const existing = await client.query<ExistingIntakeRow>(
          `SELECT status, lease_expires_at, resource_id
             FROM idempotency_reservations
            WHERE organization_id = $1
              AND scope = 'submission.receive'
              AND idempotency_key = $2
            FOR UPDATE`,
          [organizationId, request.submissionKey],
        );
        await client.query("COMMIT");
        const row = existing.rows[0];
        if (!row) {
          throw new Error("submission reservation disappeared during transaction");
        }
        if (row.status === "processing") {
          return { outcome: "in_progress", leaseExpiresAt: row.lease_expires_at };
        }
        return { outcome: "duplicate", submissionId: row.resource_id };
      }

      await client.query(
        `INSERT INTO submissions (
           id, organization_id, case_id, submission_key, source,
           source_submission_id, status, expected_document_count,
           terminal_document_count, raw_payload_reference, received_at,
           source_connector_key, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'accepted',$7,0,$8,$9,$10,$11,$11)`,
        [
          request.submissionId,
          organizationId,
          caseId,
          request.submissionKey,
          request.submission.source.type,
          request.submission.source.submission_id,
          request.documents.length,
          request.submission.source.source_reference ?? null,
          request.submission.source.received_at,
          request.submission.source.connector_key ?? null,
          request.now,
        ],
      );

      for (const document of request.documents) {
        await client.query(
          `INSERT INTO documents (
             id, organization_id, case_id, submission_id, idempotency_key,
             source_file_id, original_filename, declared_mime_type,
             size_bytes, content_hash_sha256, source_download_ref,
             status, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'reserved',$12,$12)`,
          [
            document.id,
            organizationId,
            caseId,
            request.submissionId,
            document.idempotencyKey,
            document.file.source_file_id ?? null,
            document.file.original_filename,
            document.file.declared_mime_type ?? null,
            document.file.declared_size_bytes ?? null,
            document.file.content_hash_sha256?.toLowerCase() ?? null,
            document.file.download_url,
            request.now,
          ],
        );
      }

      await client.query(
        `INSERT INTO workflow_runs (
           id, organization_id, module_id, module_version, environment,
           correlation_id, aggregate_type, aggregate_id, status,
           started_at, completed_at, metrics
         ) VALUES ($1,$2,'receive-submission','1.0.0',$3,$4,'submission',$5,
                   'succeeded',$6,$6,$7::jsonb)`,
        [
          request.workflowRunId,
          organizationId,
          request.submission.environment,
          request.correlationId,
          request.submissionId,
          request.now,
          JSON.stringify({ document_count: request.documents.length }),
        ],
      );

      await client.query(
        `INSERT INTO workflow_events (
           id, organization_id, idempotency_key, event_type, event_version,
           aggregate_type, aggregate_id, correlation_id, producer, payload,
           occurred_at
         ) VALUES ($1,$2,$3,'Submission.Accepted',1,'submission',$4,$5,
                   'dop.core.receive-submission.v2',$6::jsonb,$7)`,
        [
          request.submissionEventId,
          organizationId,
          `submission-accepted|${request.submissionKey}`,
          request.submissionId,
          request.correlationId,
          JSON.stringify({
            case_key: request.submission.case_key,
            file_count: request.documents.length,
            source_type: request.submission.source.type,
            source_connector_key: request.submission.source.connector_key ?? null,
            source_connector_version_id: intakeContext.source_connector_version_id,
            source_connector_definition_hash: intakeContext.source_connector_definition_hash,
            data_mode: dataMode,
            data_admission_decision_id: admissionResult.decisionId ?? null,
            production_data_admission_policy_id: admissionResult.policyId ?? null,
          }),
          request.now,
        ],
      );

      for (const document of request.documents) {
        await client.query(
          `INSERT INTO workflow_events (
             id, organization_id, idempotency_key, event_type, event_version,
             aggregate_type, aggregate_id, correlation_id, causation_id,
             producer, payload, occurred_at
           ) VALUES ($1,$2,$3,'Document.Queued',1,'document',$4,$5,$6,
                     'dop.core.receive-submission.v2',$7::jsonb,$8)`,
          [
            document.eventId,
            organizationId,
            `document-queued|${document.idempotencyKey}`,
            document.id,
            request.correlationId,
            request.submissionEventId,
            JSON.stringify({ source_file_id: document.file.source_file_id ?? null }),
            request.now,
          ],
        );
      }

      await client.query(
        `UPDATE idempotency_reservations
            SET status = 'completed',
                lease_owner = NULL,
                lease_expires_at = NULL,
                resource_type = 'submission',
                resource_id = $3,
                completed_at = $4,
                updated_at = $4
          WHERE organization_id = $1
            AND scope = 'submission.receive'
            AND idempotency_key = $2`,
        [organizationId, request.submissionKey, request.submissionId, request.now],
      );

      await client.query("COMMIT");
      return {
        outcome: "accepted",
        organizationId,
        caseId,
        submissionId: request.submissionId,
        documentIds: request.documents.map((document) => document.id),
        eventIds: [request.submissionEventId, ...request.documents.map((document) => document.eventId)],
      };
    } catch (error) {
      await client.query("ROLLBACK");
      const bindingReason = sourceConnectorBindingError(error);
      if (bindingReason) return { outcome: "binding_rejected", reason: bindingReason };
      throw error;
    } finally {
      client.release();
    }
  }

  private async acquireOrRecover(
    client: PoolClient,
    request: ReservationRequest,
  ): Promise<ReservationRow | undefined> {
    const leaseExpiresAt = new Date(request.now.getTime() + request.leaseSeconds * 1000);
    const result = await client.query<ReservationRow>(
      `INSERT INTO idempotency_reservations (
         organization_id, scope, idempotency_key, status, lease_owner,
         lease_expires_at, attempt_count, created_at, updated_at
       ) VALUES ($1,$2,$3,'processing',$4,$5,1,$6,$6)
       ON CONFLICT (organization_id, scope, idempotency_key) DO UPDATE
         SET status = 'processing',
             lease_owner = EXCLUDED.lease_owner,
             lease_expires_at = EXCLUDED.lease_expires_at,
             attempt_count = idempotency_reservations.attempt_count + 1,
             updated_at = EXCLUDED.updated_at,
             last_error_code = NULL
       WHERE idempotency_reservations.status = 'failed_recoverable'
          OR (idempotency_reservations.status = 'processing'
              AND idempotency_reservations.lease_expires_at < EXCLUDED.updated_at)
       RETURNING id, status, lease_expires_at`,
      [
        request.organizationId,
        request.scope,
        request.idempotencyKey,
        request.leaseOwner,
        leaseExpiresAt,
        request.now,
      ],
    );
    return result.rows[0];
  }
}

function dataAdmissionFingerprint(request: AcceptSubmissionRequest): string {
  const value = {
    environment: request.submission.environment,
    caseKey: request.submission.case_key,
    source: request.submission.source.type,
    submissionKey: request.submissionKey,
    dataClassification: request.submission.data_classification ?? null,
    files: request.documents.map((document) => ({
      sourceFileId: document.file.source_file_id ?? null,
      filename: document.file.original_filename,
      mimeType: document.file.declared_mime_type?.trim().toLowerCase() ?? null,
      sizeBytes: document.file.declared_size_bytes ?? null,
      contentHash: document.file.content_hash_sha256?.toLowerCase() ?? null,
    })),
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type DataAdmissionReason = Extract<AcceptSubmissionResult,{outcome:"admission_rejected"}>["reason"];

function dataAdmissionReason(reason: string | undefined): DataAdmissionReason {
  const known: DataAdmissionReason[] = [
    "nonproduction_real_data_blocked",
    "synthetic_subject_required",
    "production_real_data_claim_required",
    "production_subject_and_case_not_authorized",
    "production_policy_key_required",
    "active_production_policy_required",
    "production_policy_expired",
    "production_policy_evidence_invalid",
    "production_period_out_of_scope",
    "production_source_out_of_scope",
    "production_file_boundary_exceeded",
    "production_mime_out_of_scope",
    "idempotency_payload_mismatch",
  ];
  return known.includes(reason as DataAdmissionReason)
    ? reason as DataAdmissionReason
    : "data_admission_invalid_request";
}

function submissionSourceMatchesConnector(source: string, definition: Record<string, unknown> | null): boolean {
  const connectorType = definition?.connectorType;
  return (connectorType === "manual_upload" && source === "internal_upload")
    || (connectorType === "form" && source === "fillout")
    || (connectorType === "email" && source === "email")
    || (connectorType === "api" && source === "api");
}

type ConnectorBoundaryError = Extract<AcceptSubmissionResult,{outcome:"binding_rejected"}>["reason"];

function connectorCapabilityBoundaryError(
  source: string,
  profile: Record<string, unknown> | null,
  files: AcceptSubmissionRequest["documents"][number]["file"][],
): ConnectorBoundaryError | null {
  const capabilities = Array.isArray(profile?.capabilities)
    ? profile.capabilities.filter((item): item is string => typeof item === "string") : [];
  if (!capabilities.includes("documents")) return "source_connector_documents_capability_required";
  if (source === "fillout" && !capabilities.includes("webhook")) return "source_connector_webhook_capability_required";
  if (source === "email" && !capabilities.includes("attachments")) return "source_connector_attachment_capability_required";
  const maximumFiles = typeof profile?.maxFilesPerSubmission === "number" ? profile.maxFilesPerSubmission : 0;
  const maximumBytes = typeof profile?.maxFileBytes === "number" ? profile.maxFileBytes : 0;
  const allowedMimeTypes = Array.isArray(profile?.allowedMimeTypes)
    ? profile.allowedMimeTypes.filter((item): item is string => typeof item === "string") : [];
  if (maximumFiles < 1 || files.length > maximumFiles) return "source_connector_file_count_exceeded";
  for (const file of files) {
    if (!file.declared_mime_type?.trim()) return "source_connector_declared_mime_required";
    if (file.declared_size_bytes === undefined) return "source_connector_declared_size_required";
    if (!allowedMimeTypes.includes(file.declared_mime_type.trim().toLowerCase())) return "source_connector_mime_not_allowed";
    if (maximumBytes < 1 || file.declared_size_bytes > maximumBytes) return "source_connector_file_too_large";
  }
  return null;
}

function sourceConnectorBindingError(error: unknown): ConnectorBoundaryError | null {
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") return null;
  return ["source_connector_not_active", "source_connector_claim_required", "source_connector_claim_mismatch",
    "source_connector_transport_mismatch", "source_connector_documents_capability_required",
    "source_connector_webhook_capability_required", "source_connector_attachment_capability_required",
    "source_connector_file_count_exceeded", "source_connector_declared_mime_required",
    "source_connector_declared_size_required", "source_connector_mime_not_allowed",
    "source_connector_file_too_large"].includes(error.message)
    ? error.message as ConnectorBoundaryError
    : null;
}
