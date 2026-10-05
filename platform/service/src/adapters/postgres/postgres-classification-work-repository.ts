import type { Pool, PoolClient } from "pg";
import {
  classificationSummary,
  type ClassificationDocumentType,
  type ClassificationWorkRepository,
  type CompleteClassificationWorkRequest,
  type FailClassificationWorkRequest,
  type ReserveClassificationWorkRequest,
  type ReserveClassificationWorkResult,
} from "../../ports/classification-work-repository.js";

interface ContextRow {
  organization_id: string;
  case_id: string;
  subject_id: string;
  document_id: string;
  original_filename: string;
  declared_mime_type: string | null;
  incoming_storage_ref: string | null;
  prompt_version_id: string | null;
  instruction_hash: string | null;
  configured_model: string | null;
  classifier_release_version_id: string | null;
  classifier_release_definition_hash: string | null;
  classifier_release_prompt_version_id: string | null;
  classifier_release_status: string | null;
  classifier_release_definition: unknown;
  subject_key: string;
  subject_display_name: string;
  period_start: Date | string | null;
  period_end: Date | string | null;
}

interface DocumentTypeRow {
  id: string;
  code: string;
  display_name: string;
  description: string;
  classification_rules: unknown;
  extraction_schema: unknown;
  quality_gate_requires_human: boolean;
}

interface ClassificationProfileRow {
  version_id: string;
  definition_hash: string;
  definition: { labels?: unknown };
}

interface ExistingReservationRow {
  status: string;
  lease_expires_at: Date | null;
  resource_id: string | null;
}

export class PostgresClassificationWorkRepository implements ClassificationWorkRepository {
  constructor(private readonly pool: Pool) {}

  async reserve(request: ReserveClassificationWorkRequest): Promise<ReserveClassificationWorkResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id",
        [request.organizationKey],
      );
      const organizationId = organization.rows[0]?.id;
      if (!organizationId) return await commitNotFound(client, "organization");

      const contextResult = await client.query<ContextRow>(
        `SELECT d.organization_id,
                d.case_id,
                c.subject_id,
                d.id AS document_id,
                d.original_filename,
                d.declared_mime_type,
                d.incoming_storage_ref,
                c.prompt_version_id,
                pv.instruction_hash,
                pv.model AS configured_model,
                c.classifier_release_version_id,
                release_version.definition_hash AS classifier_release_definition_hash,
                release_version.prompt_version_id AS classifier_release_prompt_version_id,
                release_version.status AS classifier_release_status,
                release_version.definition AS classifier_release_definition,
                s.subject_key,
                s.display_name AS subject_display_name,
                c.period_start,
                c.period_end
           FROM documents d
           JOIN cases c
             ON c.organization_id = d.organization_id
            AND c.id = d.case_id
           JOIN subjects s
             ON s.organization_id = c.organization_id
            AND s.id = c.subject_id
           LEFT JOIN prompt_versions pv
             ON pv.organization_id = c.organization_id
            AND pv.id = c.prompt_version_id
           LEFT JOIN classifier_release_versions release_version
             ON release_version.organization_id = c.organization_id
            AND release_version.id = c.classifier_release_version_id
          WHERE d.organization_id = $1
            AND d.id = $2
            AND d.status IN ('downloaded','incoming_saved','failed_recoverable','reserved')
          FOR UPDATE OF d`,
        [organizationId, request.documentId],
      );
      const row = contextResult.rows[0];
      if (!row || !row.incoming_storage_ref) return await commitNotFound(client, "document");
      if (!row.prompt_version_id || !row.instruction_hash || !row.configured_model) {
        return await commitNotFound(client, "prompt_version");
      }
      if (!row.classifier_release_version_id || !row.classifier_release_definition_hash ||
          row.classifier_release_status !== "published" ||
          row.classifier_release_prompt_version_id !== row.prompt_version_id) {
        return await commitNotFound(client, "classifier_release");
      }
      const releaseDefinition = classifierReleaseDefinition(row.classifier_release_definition);
      if (!releaseDefinition || releaseDefinition.promptInstructionHash !== row.instruction_hash ||
          releaseDefinition.model !== row.configured_model) {
        return await commitNotFound(client, "classifier_release");
      }
      const profile = await client.query<ClassificationProfileRow>(`
        SELECT version.id AS version_id, version.definition_hash, version.definition
          FROM classification_profile_versions version
         WHERE version.organization_id = $1
           AND version.id = $2
           AND version.definition_hash = $3
           AND version.status = 'published'
         LIMIT 1`, [organizationId, releaseDefinition.classificationProfileVersionId,
          releaseDefinition.classificationProfileDefinitionHash]);
      const activeProfile = profile.rows[0];
      if (!activeProfile) return await commitNotFound(client, "classification_profile");

      const reservationKey = `document.classify|${row.document_id}|${row.classifier_release_version_id}`;
      const leaseExpiresAt = new Date(request.now.getTime() + request.leaseSeconds * 1000);
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO idempotency_reservations (
           organization_id, scope, idempotency_key, status, lease_owner,
           lease_expires_at, attempt_count, created_at, updated_at
         ) VALUES ($1,'document.classify',$2,'processing',$3,$4,1,$5,$5)
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
        [organizationId, reservationKey, request.workerId, leaseExpiresAt, request.now],
      );
      const reservationId = reservation.rows[0]?.id;
      if (!reservationId) {
        const existing = await client.query<ExistingReservationRow>(
          `SELECT status, lease_expires_at, resource_id
             FROM idempotency_reservations
            WHERE organization_id = $1
              AND scope = 'document.classify'
              AND idempotency_key = $2
            FOR UPDATE`,
          [organizationId, reservationKey],
        );
        await client.query("COMMIT");
        const current = existing.rows[0];
        if (!current) throw new Error("classification reservation disappeared during transaction");
        if (current.status === "processing") {
          return { outcome: "in_progress", leaseExpiresAt: current.lease_expires_at };
        }
        return { outcome: "duplicate", classificationAttemptId: current.resource_id };
      }

      const attempt = await client.query<{ attempt_number: number }>(
        `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
           FROM classification_attempts
          WHERE organization_id = $1 AND document_id = $2`,
        [organizationId, row.document_id],
      );
      const labels = Array.isArray(activeProfile.definition.labels) ? activeProfile.definition.labels : [];
      const labelCodes = labels.flatMap((item) => isRecord(item) && typeof item.code === "string" ? [item.code] : []);
      const types = await client.query<DocumentTypeRow>(
        `SELECT document_type.id, document_type.code, document_type.display_name,
                document_type.description, document_type.classification_rules,
                document_type.extraction_schema,
                CASE WHEN quality_policy.id IS NOT NULL
                     THEN NOT (document_type.code = ANY(quality_policy.certified_auto_accept_document_type_codes))
                     ELSE false END AS quality_gate_requires_human
           FROM document_types document_type
           LEFT JOIN classification_quality_policies quality_policy
             ON quality_policy.organization_id=document_type.organization_id
            AND quality_policy.subject_id=$3 AND quality_policy.status='active'
          WHERE document_type.organization_id = $1 AND document_type.status = 'active'
            AND document_type.code = ANY($2::text[])
          ORDER BY document_type.code`,
        [organizationId, labelCodes, row.subject_id],
      );
      await client.query("COMMIT");
      return {
        outcome: "acquired",
        context: {
          reservationId,
          reservationKey,
          organizationId,
          caseId: row.case_id,
          documentId: row.document_id,
          filename: row.original_filename,
          declaredMimeType: row.declared_mime_type ?? "application/octet-stream",
          storageReference: row.incoming_storage_ref,
          promptVersionId: row.prompt_version_id,
          promptInstructionHash: row.instruction_hash,
          configuredModel: row.configured_model,
          promptInstructions: releaseDefinition.promptInstructions,
          responseSchemaVersion: releaseDefinition.responseSchemaVersion,
          responseSchemaHash: releaseDefinition.responseSchemaHash,
          maxOutputTokens: releaseDefinition.requestPolicy.maxOutputTokens,
          reasoningEffort: releaseDefinition.requestPolicy.reasoningEffort,
          classifierReleaseVersionId: row.classifier_release_version_id,
          classifierReleaseDefinitionHash: row.classifier_release_definition_hash,
          classificationProfileVersionId: activeProfile.version_id,
          classificationProfileDefinitionHash: activeProfile.definition_hash,
          attemptNumber: Number(attempt.rows[0]?.attempt_number ?? 1),
          subjectReferences: [row.subject_key, row.subject_display_name],
          expectedPeriod: formatPeriod(row.period_start, row.period_end),
          allowedDocumentTypes: types.rows.map(toDocumentType),
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(request: CompleteClassificationWorkRequest): Promise<void> {
    const client = await this.pool.connect();
    const { context, providerResult, decision } = request;
    try {
      await client.query("BEGIN");
      await client.query("SELECT dop_set_organization_context_by_id($1)", [context.organizationId]);
      await client.query(
        `INSERT INTO classification_attempts (
           id, organization_id, document_id, attempt_number, prompt_version_id,
           classifier_release_version_id, classifier_release_definition_hash,
           classification_profile_version_id, classification_profile_definition_hash,
           provider, model, status, predicted_document_type_code, confidence,
           result, raw_response_reference, started_at, completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'succeeded',$12,$13,$14::jsonb,NULL,$15,$15)`,
        [
          request.classificationAttemptId,
          context.organizationId,
          context.documentId,
          context.attemptNumber,
          context.promptVersionId,
          context.classifierReleaseVersionId,
          context.classifierReleaseDefinitionHash,
          context.classificationProfileVersionId,
          context.classificationProfileDefinitionHash,
          providerResult.audit.provider,
          providerResult.audit.model,
          providerResult.result.predicted_document_type_code,
          providerResult.result.confidence,
          JSON.stringify(providerResult.result),
          request.now,
        ],
      );
      await client.query(
        `UPDATE documents
            SET accepted_document_type_id = $3,
                status = $4,
                classification_summary = $5::jsonb,
                review_reason = $6,
                updated_at = $7
          WHERE organization_id = $1 AND id = $2`,
        [
          context.organizationId,
          context.documentId,
          decision.acceptedDocumentTypeId,
          decision.status,
          JSON.stringify(classificationSummary(providerResult.result, providerResult.audit, context, decision.effectiveConflictFlags)),
          decision.reviewReasons.length ? decision.reviewReasons.join(",") : null,
          request.now,
        ],
      );
      if (decision.status === "review_required" && request.issueId) {
        await upsertReviewIssue(client, {
          id: request.issueId,
          organizationId: context.organizationId,
          caseId: context.caseId,
          documentId: context.documentId,
          issueKey: `classification-review|${context.documentId}|${context.promptVersionId}`,
          routingReason: decision.reviewReasons.join(","),
          details: {
            classification_attempt_id: request.classificationAttemptId,
            predicted_document_type_code: providerResult.result.predicted_document_type_code,
            confidence: providerResult.result.confidence,
            quality_flags: providerResult.result.quality_flags,
            conflict_flags: decision.effectiveConflictFlags ?? providerResult.result.conflict_flags,
          },
          now: request.now,
        });
      }
      await client.query(
        `INSERT INTO workflow_runs (
           id, organization_id, module_id, module_version, environment,
           correlation_id, aggregate_type, aggregate_id, status,
           started_at, completed_at, metrics
         ) VALUES ($1,$2,'classify-document','1.0.0',$3,$4,'document',$5,
                   'succeeded',$6,$6,$7::jsonb)`,
        [
          request.workflowRunId,
          context.organizationId,
          request.environment,
          request.correlationId,
          context.documentId,
          request.now,
          JSON.stringify({
            input_tokens: providerResult.audit.inputTokens,
            output_tokens: providerResult.audit.outputTokens,
            review_required: decision.status === "review_required",
            classifier_release_version_id: context.classifierReleaseVersionId,
            classifier_release_definition_hash: context.classifierReleaseDefinitionHash,
          }),
        ],
      );
      await client.query(
        `UPDATE workflow_errors
            SET status = 'resolved', resolved_at = $3,
                resolution = jsonb_build_object('reason', 'classification_retry_succeeded',
                                                'classification_attempt_id', $4::text)
          WHERE organization_id = $1 AND aggregate_type = 'document' AND aggregate_id = $2
            AND status IN ('open','retry_scheduled','waiting_manual')`,
        [context.organizationId, context.documentId, request.now, request.classificationAttemptId],
      );
      await client.query(
        `INSERT INTO workflow_events (
           id, organization_id, idempotency_key, event_type, event_version,
           aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
         ) VALUES ($1,$2,$3,'Document.Classified',1,'document',$4,$5,
                   'dop.core.classify-document.v1',$6::jsonb,$7)`,
        [
          request.classifiedEventId,
          context.organizationId,
          `document-classified|${context.documentId}|${context.promptVersionId}|${context.attemptNumber}`,
          context.documentId,
          request.correlationId,
          JSON.stringify({
            classification_attempt_id: request.classificationAttemptId,
            predicted_document_type_code: providerResult.result.predicted_document_type_code,
            confidence: providerResult.result.confidence,
            status: decision.status,
          }),
          request.now,
        ],
      );
      if (decision.status === "review_required" && request.reviewEventId && request.issueId) {
        await client.query(
          `INSERT INTO workflow_events (
             id, organization_id, idempotency_key, event_type, event_version,
             aggregate_type, aggregate_id, correlation_id, causation_id,
             producer, payload, occurred_at
           ) VALUES ($1,$2,$3,'Document.ReviewRequired',1,'document',$4,$5,$6,
                     'dop.core.classify-document.v1',$7::jsonb,$8)`,
          [
            request.reviewEventId,
            context.organizationId,
            `document-review-required|${context.documentId}|${context.promptVersionId}|${context.attemptNumber}`,
            context.documentId,
            request.correlationId,
            request.classifiedEventId,
            JSON.stringify({ issue_id: request.issueId, reasons: decision.reviewReasons }),
            request.now,
          ],
        );
      }
      await completeReservation(client, context, request.classificationAttemptId, request.now);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async fail(request: FailClassificationWorkRequest): Promise<void> {
    const client = await this.pool.connect();
    const { context } = request;
    const attemptStatus = request.failureMode === "manual" ? "failed_manual" : "failed_recoverable";
    try {
      await client.query("BEGIN");
      await client.query("SELECT dop_set_organization_context_by_id($1)", [context.organizationId]);
      await client.query(
        `INSERT INTO classification_attempts (
           id, organization_id, document_id, attempt_number, prompt_version_id,
           classifier_release_version_id, classifier_release_definition_hash,
           classification_profile_version_id, classification_profile_definition_hash,
           provider, model, status, error_code, started_at, completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'openai',$10,$11,$12,$13,$13)`,
        [
          request.classificationAttemptId,
          context.organizationId,
          context.documentId,
          context.attemptNumber,
          context.promptVersionId,
          context.classifierReleaseVersionId,
          context.classifierReleaseDefinitionHash,
          context.classificationProfileVersionId,
          context.classificationProfileDefinitionHash,
          context.configuredModel,
          attemptStatus,
          request.errorCode,
          request.now,
        ],
      );
      await client.query(
        `UPDATE documents
            SET status = $3,
                review_reason = $4,
                updated_at = $5
          WHERE organization_id = $1 AND id = $2`,
        [
          context.organizationId,
          context.documentId,
          request.failureMode === "manual" ? "review_required" : "failed_recoverable",
          request.errorCode,
          request.now,
        ],
      );
      await client.query(
        `INSERT INTO workflow_runs (
           id, organization_id, module_id, module_version, environment,
           correlation_id, aggregate_type, aggregate_id, status,
           started_at, completed_at, metrics
         ) VALUES ($1,$2,'classify-document','1.0.0',$3,$4,'document',$5,$6,$7,$7,'{}'::jsonb)`,
        [
          request.workflowRunId,
          context.organizationId,
          request.environment,
          request.correlationId,
          context.documentId,
          attemptStatus,
          request.now,
        ],
      );
      await client.query(
        `UPDATE workflow_errors previous_error
            SET status = 'resolved', resolved_at = $3,
                resolution = jsonb_build_object(
                  'reason', 'superseded_by_classification_attempt',
                  'classification_attempt_id', $4::text
                )
           FROM workflow_runs previous_run
          WHERE previous_error.organization_id = $1
            AND previous_error.aggregate_type = 'document'
            AND previous_error.aggregate_id = $2
            AND previous_error.status IN ('open','retry_scheduled','waiting_manual')
            AND previous_run.organization_id = previous_error.organization_id
            AND previous_run.id = previous_error.workflow_run_id
            AND previous_run.module_id = 'classify-document'`,
        [context.organizationId, context.documentId, request.now, request.classificationAttemptId],
      );
      await client.query(
        `INSERT INTO workflow_errors (
           id, organization_id, workflow_run_id, aggregate_type, aggregate_id,
           error_code, error_class, status, retry_count, next_retry_at,
           safe_details, opened_at
         ) VALUES ($1,$2,$3,'document',$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [
          request.workflowErrorId,
          context.organizationId,
          request.workflowRunId,
          context.documentId,
          request.errorCode,
          request.errorClass,
          request.retryScheduled ? "retry_scheduled" : "waiting_manual",
          Math.max(0, context.attemptNumber - 1),
          request.retryScheduled ? new Date(request.now.getTime() + 5 * 60_000) : null,
          JSON.stringify({
            classification_attempt_id: request.classificationAttemptId,
            attempt_number: context.attemptNumber,
            retry_scheduled: request.retryScheduled,
            circuit_open: request.circuitOpen,
            ...(request.safeDetails ?? {}),
          }),
          request.now,
        ],
      );
      if (request.failureMode === "manual" && request.issueId) {
        await upsertReviewIssue(client, {
          id: request.issueId,
          organizationId: context.organizationId,
          caseId: context.caseId,
          documentId: context.documentId,
          issueKey: `classification-failure|${context.documentId}|${context.promptVersionId}`,
          routingReason: request.errorCode,
          details: { classification_attempt_id: request.classificationAttemptId, error_code: request.errorCode },
          now: request.now,
        });
      }
      await client.query(
        `INSERT INTO workflow_events (
           id, organization_id, idempotency_key, event_type, event_version,
           aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
         ) VALUES ($1,$2,$3,'Document.ClassificationFailed',1,'document',$4,$5,
                   'dop.core.classify-document.v1',$6::jsonb,$7)`,
        [
          request.eventId,
          context.organizationId,
          `document-classification-failed|${context.documentId}|${context.promptVersionId}|${context.attemptNumber}`,
          context.documentId,
          request.correlationId,
          JSON.stringify({
            classification_attempt_id: request.classificationAttemptId,
            error_code: request.errorCode,
            failure_mode: request.failureMode,
            retry_scheduled: request.retryScheduled,
            circuit_open: request.circuitOpen,
          }),
          request.now,
        ],
      );
      await client.query(
        `UPDATE idempotency_reservations
            SET status = $3,
                lease_owner = NULL,
                lease_expires_at = NULL,
                resource_type = 'classification_attempt',
                resource_id = $4,
                last_error_code = $5,
                completed_at = CASE WHEN $3 = 'failed_manual' THEN $6::timestamptz ELSE NULL END,
                updated_at = $6::timestamptz
          WHERE organization_id = $1
            AND scope = 'document.classify'
            AND idempotency_key = $2`,
        [
          context.organizationId,
          context.reservationKey,
          attemptStatus,
          request.classificationAttemptId,
          request.errorCode,
          request.now,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function commitNotFound(
  client: PoolClient,
  resource: "organization" | "document" | "prompt_version" | "classification_profile" | "classifier_release",
): Promise<ReserveClassificationWorkResult> {
  await client.query("COMMIT");
  return { outcome: "not_found", resource };
}

interface RuntimeClassifierReleaseDefinition {
  model: string;
  promptInstructions: string;
  promptInstructionHash: string;
  classificationProfileVersionId: string;
  classificationProfileDefinitionHash: string;
  responseSchemaVersion: "1.0" | "2.0-candidate.1";
  responseSchemaHash: string;
  requestPolicy: { maxOutputTokens: number; reasoningEffort: "low" | "medium" | "high" };
}

function classifierReleaseDefinition(value: unknown): RuntimeClassifierReleaseDefinition | null {
  if (!isRecord(value) || typeof value.model !== "string" || typeof value.promptInstructions !== "string" ||
      typeof value.promptInstructionHash !== "string" || typeof value.classificationProfileVersionId !== "string" ||
      typeof value.classificationProfileDefinitionHash !== "string" || !["1.0", "2.0-candidate.1"].includes(String(value.responseSchemaVersion)) ||
      typeof value.responseSchemaHash !== "string" || !isRecord(value.requestPolicy) ||
      typeof value.requestPolicy.maxOutputTokens !== "number" ||
      !["low", "medium", "high"].includes(String(value.requestPolicy.reasoningEffort))) return null;
  return value as unknown as RuntimeClassifierReleaseDefinition;
}

function toDocumentType(row: DocumentTypeRow): ClassificationDocumentType {
  const rules = isRecord(row.classification_rules) ? row.classification_rules : {};
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    description: classificationDescription(row),
    minimumConfidence: numberRule(rules.minimum_confidence, 1),
    alwaysHumanConfirm: rules.always_human_confirm === true,
    qualityGateRequiresHuman: row.quality_gate_requires_human === true,
    manualOnConflict: rules.manual_on_conflict !== false,
    rejectOnQualityFlags: stringArray(rules.reject_on_quality_flags),
    rejectOnConflictFlags: stringArray(rules.reject_on_conflict_flags),
  };
}

function classificationDescription(row: DocumentTypeRow): string {
  const schema = isRecord(row.extraction_schema) ? row.extraction_schema : {};
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  return properties.length
    ? `${row.description} 建议抽取字段：${properties.join("、")}。`
    : row.description;
}

function numberRule(value: unknown, fallback: number): number {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function formatPeriod(start: Date | string | null, end: Date | string | null): string | null {
  if (!start || !end) return null;
  const startDate = isoDate(start);
  const endDate = isoDate(end);
  const startParts = dateParts(startDate);
  const endParts = dateParts(endDate);
  if (startParts && endParts && startParts.day === 1) {
    const lastDay = new Date(Date.UTC(endParts.year, endParts.month, 0)).getUTCDate();
    if (startParts.year === endParts.year && startParts.month === endParts.month && endParts.day === lastDay) {
      return `${startParts.year}-${String(startParts.month).padStart(2, "0")}`;
    }
    const quarter = Math.floor((startParts.month - 1) / 3) + 1;
    const quarterStartMonth = (quarter - 1) * 3 + 1;
    const quarterEndMonth = quarterStartMonth + 2;
    const quarterEndDay = new Date(Date.UTC(startParts.year, quarterEndMonth, 0)).getUTCDate();
    if (startParts.month === quarterStartMonth && endParts.year === startParts.year &&
        endParts.month === quarterEndMonth && endParts.day === quarterEndDay) {
      return `${startParts.year}-Q${quarter}`;
    }
  }
  return `${startDate}/${endDate}`;
}

function isoDate(value: Date | string): string {
  if (!(value instanceof Date)) return String(value).slice(0, 10);

  // PostgreSQL DATE has no timezone. node-postgres materializes it at local
  // midnight, so converting that value to UTC can shift the calendar date in
  // positive-offset regions such as New Zealand.
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function dateParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

async function upsertReviewIssue(
  client: PoolClient,
  input: {
    id: string;
    organizationId: string;
    caseId: string;
    documentId: string;
    issueKey: string;
    routingReason: string;
    details: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO issues (
       id, organization_id, case_id, document_id, issue_key, issue_type,
       severity, status, routing_reason, details, opened_at
     ) VALUES ($1,$2,$3,$4,$5,'document_classification_review','medium','open',$6,$7::jsonb,$8)
     ON CONFLICT (organization_id, issue_key) DO UPDATE
       SET status = CASE WHEN issues.status IN ('resolved','closed') THEN 'reopened' ELSE issues.status END,
           routing_reason = EXCLUDED.routing_reason,
           details = EXCLUDED.details,
           resolved_at = NULL,
           closed_at = NULL`,
    [
      input.id,
      input.organizationId,
      input.caseId,
      input.documentId,
      input.issueKey,
      input.routingReason,
      JSON.stringify(input.details),
      input.now,
    ],
  );
}

async function completeReservation(
  client: PoolClient,
  context: { organizationId: string; reservationKey: string },
  classificationAttemptId: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_reservations
        SET status = 'completed',
            lease_owner = NULL,
            lease_expires_at = NULL,
            resource_type = 'classification_attempt',
            resource_id = $3,
            last_error_code = NULL,
            completed_at = $4,
            updated_at = $4
      WHERE organization_id = $1
        AND scope = 'document.classify'
        AND idempotency_key = $2`,
    [context.organizationId, context.reservationKey, classificationAttemptId, now],
  );
}
