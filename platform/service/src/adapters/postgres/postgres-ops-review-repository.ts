import type { Pool, PoolClient } from "pg";
import type {
  CompletedDocumentReview,
  DocumentReviewAction,
  OpsReviewRepository,
  ResolveDocumentReviewRequest,
  ResolveDocumentReviewResult,
} from "../../ports/ops-review-repository.js";

interface ExistingDecisionRow {
  id: string;
  request_fingerprint: string;
  event_id: string;
  document_id: string;
  action: DocumentReviewAction;
  exclusion_reason: "wrong_subject" | "wrong_period" | "irrelevant_or_unknown" | null;
  resulting_status: string;
  document_type_code: string | null;
  decided_at: Date | string;
}

interface DocumentRow {
  supervisor_review_requested?: boolean;
  id: string;
  case_id: string;
  status: string;
  accepted_document_type_id: string | null;
  document_type_code: string | null;
}

export class PostgresOpsReviewRepository implements OpsReviewRepository {
  constructor(private readonly pool: Pool) {}

  async resolve(request: ResolveDocumentReviewRequest): Promise<ResolveDocumentReviewResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id",
        [request.organizationKey],
      );
      const organizationId = organization.rows[0]?.id;
      if (!organizationId) return await commitNotFound(client, "organization");

      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${organizationId}|ops-review|${request.idempotencyKey}`,
      ]);
      const operator = await client.query<{ id: string; actor_type: string }>(
        `SELECT id, actor_type FROM actors
          WHERE id = $1 AND status = 'active' AND actor_type IN ('staff','manager','admin')`,
        [request.actorId],
      );
      if (!operator.rows[0]) return await commitNotFound(client, "operator");
      // Authorization is checked even for a replay. The tenant RLS context above
      // is the same boundary used for staff Case reads; no cross-tenant grant.
      const existing = await loadExistingDecision(client, request.idempotencyKey);
      if (existing) {
        await client.query("COMMIT");
        if (existing.request_fingerprint !== request.requestFingerprint) {
          return { outcome: "conflict", reason: "idempotency_key_reused" };
        }
        return completedFromExisting(existing);
      }

      // Lock the Case before the Document, serializing review with completion.
      // Correcting an exclusion must never silently reopen a completed Case.
      const caseResult = await client.query<{ status: string | null }>(
        "SELECT dop_lock_document_review_case($1,$2) AS status", [request.actorId, request.documentId],
      );
      if (!caseResult.rows[0]?.status) return await commitNotFound(client, "document");
      if (["completed", "cancelled"].includes(caseResult.rows[0].status)) {
        await client.query("COMMIT");
        return { outcome: "conflict", reason: "case_closed" };
      }

      const documentResult = await client.query<DocumentRow>(
        `SELECT d.id, d.case_id, d.status, d.accepted_document_type_id,
                current_type.code AS document_type_code,
                coalesce(d.classification_summary @> '{"supervisor_review_requested":true}',false) AS supervisor_review_requested
           FROM documents d
           LEFT JOIN document_types current_type ON current_type.id = d.accepted_document_type_id
          WHERE d.id = $1
          FOR UPDATE OF d`,
        [request.documentId],
      );
      const document = documentResult.rows[0];
      if (!document) return await commitNotFound(client, "document");
      const staff = operator.rows[0].actor_type === "staff";
      if (request.action === "reopen" && staff && document.status !== "excluded") {
        await client.query("COMMIT");
        return { outcome: "conflict", reason: "manager_required" };
      }
      // Staff may safely exclude an escalated file, but cannot accept it by
      // confirming/reclassifying and bypassing the existing supervisor hold.
      if (document.supervisor_review_requested && staff && request.action !== "exclude" &&
          !(request.action === "reopen" && document.status === "excluded")) {
        await client.query("COMMIT");
        return { outcome: "conflict", reason: "manager_required" };
      }
      if (document.status === "failed_recoverable") {
        await client.query("COMMIT");
        return { outcome: "conflict", reason: "system_retry_in_progress" };
      }
      if (request.action === "reopen" && !["human_confirmed", "excluded"].includes(document.status)) {
        await client.query("COMMIT");
        return { outcome: "conflict", reason: "document_not_reopenable" };
      }
      if (request.action !== "reopen" && !["review_required", "failed_manual"].includes(document.status)) {
        await client.query("COMMIT");
        return { outcome: "conflict", reason: "review_already_resolved" };
      }

      let decidedDocumentTypeId = document.accepted_document_type_id;
      let decidedDocumentTypeCode = document.document_type_code;
      if (request.action === "confirm" && !decidedDocumentTypeId) {
        await client.query("COMMIT");
        return { outcome: "conflict", reason: "current_type_missing" };
      }
      if (request.action === "reclassify") {
        const target = await client.query<{ id: string; code: string }>(
          `SELECT DISTINCT dt.id, dt.code
             FROM documents d
             JOIN cases c ON c.id = d.case_id
             JOIN requirements r ON r.requirement_set_version_id = c.requirement_set_version_id
             JOIN document_types dt ON dt.id = r.document_type_id
            WHERE d.id = $1 AND dt.code = $2 AND dt.status = 'active'`,
          [request.documentId, request.documentTypeCode],
        );
        if (!target.rows[0]) return await commitNotFound(client, "document_type");
        decidedDocumentTypeId = target.rows[0].id;
        decidedDocumentTypeCode = target.rows[0].code;
      }

      const resultingStatus = request.action === "exclude"
        ? "excluded"
        : request.action === "reopen" || request.action === "request_information"
          ? "review_required"
          : "human_confirmed";
      const issueIds = request.action === "reopen"
        ? await reopenDocumentIssue(client, request, organizationId, document.case_id, document.status === "excluded")
        : request.action === "request_information"
        ? await waitForExternalInformation(client, request, organizationId, document.case_id)
        : await resolveDocumentIssues(
          client, request.documentId, request.actorId, request.action, request.rationale, request.now,
        );
      const issueStatus = issueIds.length
        ? request.action === "request_information" ? "waiting_external" : request.action === "reopen" ? "reopened" : "resolved"
        : null;

      await client.query(
        `UPDATE documents
            SET accepted_document_type_id = $2,
                status = $3,
                review_reason = $4,
                classification_summary = COALESCE(classification_summary, '{}'::jsonb) || $5::jsonb,
                updated_at = $6
          WHERE id = $1`,
        [
          request.documentId,
          decidedDocumentTypeId,
          resultingStatus,
          request.action === "request_information" ? "operator_requested_information"
            : request.action === "exclude" ? reviewReasonForExclusion(request.exclusionReason)
              : request.action === "reopen" ? document.status === "excluded" ? "exclusion_restored_for_review" : "supervisor_reopened" : null,
          JSON.stringify({
            supervisor_review_requested: ["request_information", "exclude", "reopen"].includes(request.action) && document.supervisor_review_requested === true,
            human_review: {
              action: request.action,
              exclusion_reason: request.exclusionReason,
              actor_id: request.actorId,
              decided_document_type_code: decidedDocumentTypeCode,
              decided_at: request.now.toISOString(),
            },
          }),
          request.now,
        ],
      );

      const resolvedWorkflowErrorIds = request.action === "exclude"
        ? (await client.query<{ id: string }>(
          `UPDATE workflow_errors
              SET status = 'resolved',
                  next_retry_at = NULL,
                  resolved_at = $2,
                  resolution = COALESCE(resolution, '{}'::jsonb) || jsonb_build_object(
                    'reason', 'document_excluded_from_case',
                    'decision_id', $3::uuid,
                    'actor_id', $4::uuid
                  )
            WHERE aggregate_type = 'document'
              AND aggregate_id = $1
              AND status IN ('open','retry_scheduled','waiting_manual')
          RETURNING id`,
          [request.documentId, request.now, request.decisionId, request.actorId],
        )).rows.map((row) => row.id)
        : [];

      const eventType = eventTypeFor(request.action);
      await client.query(
        `INSERT INTO workflow_events (
           id, organization_id, idempotency_key, event_type, event_version,
           aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
         ) VALUES ($1,$2,$3,$4,1,'document',$5,$6,$7,'dop.ops.review.v1',$8::jsonb,$9)`,
        [
          request.eventId,
          organizationId,
          `ops-review|${request.idempotencyKey}`,
          eventType,
          request.documentId,
          request.correlationId,
          request.actorId,
          JSON.stringify({
            decision_id: request.decisionId,
            action: request.action,
            exclusion_reason: request.exclusionReason,
            previous_status: document.status,
            resulting_status: resultingStatus,
            previous_document_type_code: document.document_type_code,
            decided_document_type_code: decidedDocumentTypeCode,
            rationale: request.rationale,
            related_issue_ids: issueIds,
            resolved_workflow_error_ids: resolvedWorkflowErrorIds,
          }),
          request.now,
        ],
      );

      await client.query(
        `INSERT INTO document_review_decisions (
           id, organization_id, document_id, actor_id, idempotency_key, request_fingerprint,
           action, exclusion_reason, previous_document_type_id, decided_document_type_id, previous_status,
           resulting_status, rationale, related_issue_ids, event_id, decided_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid[],$15,$16)`,
        [
          request.decisionId,
          organizationId,
          request.documentId,
          request.actorId,
          request.idempotencyKey,
          request.requestFingerprint,
          request.action,
          request.exclusionReason,
          document.accepted_document_type_id,
          decidedDocumentTypeId,
          document.status,
          resultingStatus,
          request.rationale,
          issueIds,
          request.eventId,
          request.now,
        ],
      );
      await client.query("COMMIT");
      return {
        outcome: "completed",
        decisionId: request.decisionId,
        eventId: request.eventId,
        documentId: request.documentId,
        action: request.action,
        exclusionReason: request.exclusionReason,
        documentStatus: resultingStatus,
        documentTypeCode: decidedDocumentTypeCode,
        issueStatus,
        decidedAt: request.now.toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadExistingDecision(client: PoolClient, idempotencyKey: string): Promise<ExistingDecisionRow | null> {
  const result = await client.query<ExistingDecisionRow>(
    `SELECT decision.id, decision.request_fingerprint, decision.event_id, decision.document_id,
            decision.action, decision.exclusion_reason, decision.resulting_status,
            dt.code AS document_type_code, decision.decided_at
       FROM document_review_decisions decision
       LEFT JOIN document_types dt ON dt.id = decision.decided_document_type_id
      WHERE decision.idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function reviewReasonForExclusion(reason: ResolveDocumentReviewRequest["exclusionReason"]): string {
  if (reason === "wrong_subject") return "operator_excluded_wrong_subject";
  if (reason === "wrong_period") return "operator_excluded_wrong_period";
  return "operator_excluded_irrelevant_or_unknown";
}

async function waitForExternalInformation(
  client: PoolClient,
  request: ResolveDocumentReviewRequest,
  organizationId: string,
  caseId: string,
): Promise<string[]> {
  const updated = await client.query<{ id: string }>(
    `UPDATE issues
        SET status = 'waiting_external',
            routing_reason = 'operator_requested_information',
            details = details || $2::jsonb,
            resolved_at = NULL,
            closed_at = NULL
      WHERE document_id = $1
        AND status IN ('open','assigned','waiting_external','waiting_internal','reopened')
      RETURNING id`,
    [
      request.documentId,
      JSON.stringify({ manual_review: { actor_id: request.actorId, rationale: request.rationale, decided_at: request.now.toISOString() } }),
    ],
  );
  if (updated.rows.length) return updated.rows.map((row) => row.id);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO issues (
       id, organization_id, case_id, document_id, issue_key, issue_type,
       severity, status, routing_reason, details, opened_at
     ) VALUES ($1,$2,$3,$4,$5,'document_information_required','medium','waiting_external',
               'operator_requested_information',$6::jsonb,$7)
     RETURNING id`,
    [
      request.issueId,
      organizationId,
      caseId,
      request.documentId,
      `manual-information|${request.documentId}|${request.idempotencyKey}`,
      JSON.stringify({ manual_review: { actor_id: request.actorId, rationale: request.rationale } }),
      request.now,
    ],
  );
  return inserted.rows.map((row) => row.id);
}

async function resolveDocumentIssues(
  client: PoolClient,
  documentId: string,
  actorId: string,
  action: DocumentReviewAction,
  rationale: string,
  now: Date,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `UPDATE issues
        SET status = 'resolved',
            details = details || $2::jsonb,
            resolved_at = $3,
            closed_at = NULL
      WHERE document_id = $1
        AND status IN ('open','assigned','waiting_external','waiting_internal','reopened')
      RETURNING id`,
    [documentId, JSON.stringify({ resolution: { actor_id: actorId, action, rationale } }), now],
  );
  return result.rows.map((row) => row.id);
}

async function reopenDocumentIssue(
  client: PoolClient,
  request: ResolveDocumentReviewRequest,
  organizationId: string,
  caseId: string,
  restoringExclusion: boolean,
): Promise<string[]> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO issues (
       id, organization_id, case_id, document_id, issue_key, issue_type,
       severity, status, assigned_actor_id, routing_reason, details, opened_at
     ) VALUES ($1,$2,$3,$4,$5,$9,'high','reopened',$6,
               $10,$7::jsonb,$8)
     RETURNING id`,
    [request.issueId, organizationId, caseId, request.documentId,
      `supervisor-reopen|${request.documentId}|${request.idempotencyKey}`, request.actorId,
      JSON.stringify({ review_correction: { actor_id: request.actorId, rationale: request.rationale,
        restores_exclusion: restoringExclusion } }), request.now,
      restoringExclusion ? "document_review_required" : "supervisor_correction",
      restoringExclusion ? "exclusion_restored_for_review" : "supervisor_reopened"],
  );
  return inserted.rows.map((row) => row.id);
}

function eventTypeFor(action: DocumentReviewAction): string {
  if (action === "confirm") return "Document.HumanConfirmed";
  if (action === "reclassify") return "Document.Reclassified";
  if (action === "exclude") return "Document.ExcludedFromCase";
  if (action === "reopen") return "Document.ReviewReopened";
  return "Document.InformationRequested";
}

function completedFromExisting(row: ExistingDecisionRow): CompletedDocumentReview {
  return {
    outcome: "duplicate",
    decisionId: row.id,
    eventId: row.event_id,
    documentId: row.document_id,
    action: row.action,
    exclusionReason: row.exclusion_reason,
    documentStatus: row.resulting_status,
    documentTypeCode: row.document_type_code,
    issueStatus: row.action === "request_information" ? "waiting_external" : row.action === "reopen" ? "reopened" : "resolved",
    decidedAt: iso(row.decided_at),
  };
}

async function commitNotFound(
  client: PoolClient,
  resource: "organization" | "operator" | "document" | "document_type",
): Promise<ResolveDocumentReviewResult> {
  await client.query("COMMIT");
  return { outcome: "not_found", resource };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
