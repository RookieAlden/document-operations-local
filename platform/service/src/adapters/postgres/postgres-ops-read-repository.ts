import type { Pool, PoolClient } from "pg";
import type {
  OpsActivityItem,
  OpsCaseDetail,
  OpsCaseDocument,
  OpsCaseSummary,
  OpsIssueSummary,
  OpsMissingDocumentRequestDraft,
  OpsOverview,
  OpsReadRepository,
  OpsRequirementProgress,
  OpsReviewDecisionSummary,
  OpsRecentDocument,
  OpsReminderInstance,
  OpsReviewDocument,
  OpsWorkflowErrorItem,
} from "../../ports/ops-read-repository.js";

interface CaseRow {
  id: string;
  subject_key: string;
  subject_name: string;
  period_start: string | null;
  period_end: string | null;
  status: string;
  risk_status: string | null;
  due_at: Date | string | null;
  accepted_requirement_count: number;
  required_requirement_count: number;
  document_count: number;
  open_issue_count: number;
  requirements: unknown;
  completeness_id: string | null;
  completeness_status: "pending" | "review_required" | "incomplete" | "complete" | null;
  completeness_algorithm_version: "1.0" | null;
  completeness_input_hash: string | null;
  completeness_matched_document_count: number | null;
  completeness_missing_requirement_count: number | null;
  completeness_duplicate_document_count: number | null;
  completeness_excess_document_count: number | null;
  completeness_review_required_document_count: number | null;
  completeness_unmatched_document_count: number | null;
  completeness_active_submission_count: number | null;
  completeness_created_at: Date | string | null;
}

interface ReviewRow {
  supervisor_review_requested?: boolean;
  id: string;
  case_id: string;
  subject_name: string;
  period_start: string | null;
  period_end: string | null;
  filename: string;
  status: string;
  document_type_code: string | null;
  document_type_name: string | null;
  confidence: number | string | null;
  review_reason: string | null;
  updated_at: Date | string;
  available_document_types: unknown;
}

interface IssueRow {
  id: string;
  case_id: string;
  document_id: string | null;
  subject_name: string;
  issue_type: string;
  severity: string;
  status: string;
  routing_reason: string | null;
  filename: string | null;
  due_at: Date | string | null;
  opened_at: Date | string;
  assigned_actor_id: string | null;
  assigned_actor_name: string | null;
  details: unknown;
}

interface MissingRequestDraftRow {
  id: string;
  assessment_id: string;
  draft_version: number;
  status: "draft" | "superseded" | "cancelled";
  recipient_snapshot: unknown;
  subject_line: string;
  body_text: string;
  requested_items: unknown;
  source_issue_count: number;
  content_hash: string;
  delivery_mode: "disabled";
  external_call_count: number;
  created_at: Date | string;
}

interface MissingRequestRecipientRow {
  id: string;
  actor_id: string;
  display_name: string;
  email: string;
  source: "canonical_primary_contact" | "manual_approval";
  approved_at: Date | string;
}

interface MissingRequestRevisionRow {
  id: string;
  revision: number;
  status: "draft" | "in_review" | "changes_requested" | "approved" | "rejected" | "superseded" | "cancelled";
  recipient_snapshot: unknown;
  subject_line: string;
  body_text: string;
  content_hash: string;
  change_reason: string;
  created_by_actor_id: string | null;
  created_by_name: string | null;
  submitted_by_actor_id: string | null;
  submitted_by_name: string | null;
  submitted_at: Date | string | null;
  reviewed_by_name: string | null;
  reviewed_at: Date | string | null;
  review_reason: string | null;
  delivery_mode: "disabled";
  external_call_count: number;
  created_at: Date | string;
}

interface MissingRequestDecisionRow {
  id: string;
  revision_id: string;
  action: "submitted" | "returned" | "approved" | "rejected";
  actor_name: string;
  reason: string;
  content_hash: string;
  decided_at: Date | string;
}

interface DeliveryPlanRow {
  id: string;
  source_revision_id: string;
  status: "planned" | "queued" | "processing" | "accepted" | "delivered" | "deferred" |
    "bounced" | "failed_recoverable" | "failed_manual" | "outcome_unknown" | "cancelled";
  recipient_snapshot: unknown;
  content_hash: string;
  runtime_execution: "disabled" | "synthetic";
  provider_reference_mode: "not_configured" | "synthetic";
  synthetic_scenario: string | null;
  provider_message_id: string | null;
  last_error_code: string | null;
  authorized_at: Date | string | null;
  attempt_count: number;
  external_call_count: number;
  created_by_name: string | null;
  creation_reason: string;
  created_at: Date | string;
}

interface DeliveryAttemptRow {
  id: string; delivery_job_id: string; attempt_number: number; status: string;
  error_code: string | null; provider_message_id: string | null;
  started_at: Date | string; completed_at: Date | string | null;
  retry_not_before: Date | string | null; external_call_count: number;
}
interface DeliveryReceiptRow {
  id: string; delivery_job_id: string; receipt_type: string; provider_message_id: string;
  payload_hash: string; occurred_at: Date | string; received_at: Date | string;
}

interface DeliveryEvaluationRow {
  id: string;
  delivery_job_id: string;
  status: "passed" | "failed";
  contract_version: "1.0";
  definition_hash: string;
  result: unknown;
  reason: string;
  run_by_name: string | null;
  external_call_count: number;
  created_at: Date | string;
}

interface DecisionRow {
  id: string; document_id: string; filename: string; subject_name: string; action: string;
  exclusion_reason: "wrong_subject" | "wrong_period" | "irrelevant_or_unknown" | null;
  document_status: string; document_type_name: string | null; rationale: string;
  actor_name: string; decided_at: Date | string;
}

interface RecentDocumentRow {
  id: string; filename: string; subject_name: string; status: string;
  document_type_name: string | null; updated_at: Date | string; preview_available: boolean;
}

interface ReminderRow {
  id: string; reminder_kind: OpsReminderInstance["kind"]; sequence_number: number;
  scheduled_at: Date | string; status: OpsReminderInstance["status"]; trigger_reason: string;
  stop_reason: string | null; recipient_snapshot: unknown; content_snapshot: unknown;
  policy_snapshot: unknown; content_hash: string; delivery_mode: "disabled";
  external_call_count: number; created_at: Date | string;
  escalation_owner_actor_id: string | null; escalation_owner_name: string | null;
  escalation_status: string | null; escalation_opened_at: Date | string | null;
  decision_action: "approve" | "reject" | null; decision_actor_name: string | null;
  decision_reason: string | null; decision_decided_at: Date | string | null;
}

interface ActivityRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: Date | string;
}

interface WorkflowErrorRow {
  id: string;
  document_id: string | null;
  case_id: string | null;
  subject_name: string | null;
  filename: string | null;
  module_id: string | null;
  error_code: string;
  error_class: string;
  status: string;
  retry_count: number;
  next_retry_at: Date | string | null;
  opened_at: Date | string;
}

interface CaseDocumentRow {
  conflict_flags?: string[]; supervisor_review_requested?: boolean;
  id: string; original_filename: string; declared_mime_type: string | null; detected_mime_type: string | null;
  size_bytes: number | string | null; status: string; document_type_code: string | null; document_type_name: string | null;
  confidence: number | string | null; review_reason: string | null; created_at: Date | string; updated_at: Date | string;
  preview_available: boolean; content_group_size: number; content_group_position: number;
  filename_group_size: number; filename_group_position: number; attempt_number: number | null;
  attempt_status: string | null; attempt_error_code: string | null; attempt_started_at: Date | string | null;
  attempt_completed_at: Date | string | null; active_error_code: string | null; active_error_class: string | null;
  active_error_status: string | null; retry_count: number | null; next_retry_at: Date | string | null;
  error_opened_at: Date | string | null;
  match_status: "matched" | "review_required" | "duplicate" | "unmatched" | "processing" | "excluded" | null;
  match_requirement_code: string | null;
  match_duplicate_kind: "none" | "same_content" | null;
  match_is_excess: boolean | null;
  match_counts_toward_minimum: boolean | null;
  match_reason_code: string | null;
}

export class PostgresOpsReadRepository implements OpsReadRepository {
  constructor(private readonly pool: Pool) {}

  async listCases(organizationKey: string, _now: Date, operatorActorId: string): Promise<OpsCaseSummary[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id",
        [organizationKey],
      );
      if (!organization.rows[0]?.id) throw new Error("organization_not_found");
      const operator = await client.query<{ id: string }>(
        `SELECT id FROM actors
          WHERE id = $1 AND status = 'active' AND actor_type IN ('staff','manager','admin')`,
        [operatorActorId],
      );
      if (!operator.rows[0]) throw new Error("ops_operator_not_available");
      const cases = await loadCases(client);
      await client.query("COMMIT");
      return cases;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getOverview(organizationKey: string, now: Date, operatorActorId: string): Promise<OpsOverview> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id",
        [organizationKey],
      );
      if (!organization.rows[0]?.id) throw new Error("organization_not_found");

      const operator = await client.query<{ id: string; display_name: string; actor_type: "staff" | "manager" | "admin" }>(
        `SELECT id, display_name, actor_type
           FROM actors
          WHERE id = $1 AND status = 'active' AND actor_type IN ('staff','manager','admin')`,
        [operatorActorId],
      );
      if (!operator.rows[0]) throw new Error("ops_operator_not_available");

      const cases = await loadCases(client);
      const reviewQueue = await loadReviewQueue(client);
      const recentReviewDecisions = await loadReviewDecisions(client);
      const recentDocuments = await loadRecentDocuments(client);
      const issues = await loadIssues(client);
      const retryQueue = await loadWorkflowErrors(client, now);
      const activity = await loadActivity(client);
      await client.query("COMMIT");

      return {
        generatedAt: now.toISOString(),
        organizationKey,
        operator: {
          id: operator.rows[0].id,
          displayName: operator.rows[0].display_name,
          actorType: operator.rows[0].actor_type,
        },
        summary: {
          activeCaseCount: cases.filter((item) => !["completed", "cancelled"].includes(item.status)).length,
          dueSoonCaseCount: cases.filter((item) => item.riskStatus === "due_soon").length,
          overdueCaseCount: cases.filter((item) => item.riskStatus === "overdue").length,
          reviewDocumentCount: reviewQueue.length,
          openIssueCount: issues.filter((item) => ["open","assigned","waiting_external","waiting_internal","reopened"].includes(item.status)).length,
          scheduledRetryCount: retryQueue.filter((item) => item.status === "retry_scheduled").length,
          manualErrorCount: retryQueue.filter((item) => ["open", "waiting_manual"].includes(item.status)).length,
          overdueRetryCount: retryQueue.filter((item) => item.status === "retry_scheduled" &&
            (item.nextRetryAt === null || new Date(item.nextRetryAt).getTime() <= now.getTime())).length,
        },
        cases,
        reviewQueue,
        recentReviewDecisions,
        recentDocuments,
        issues,
        retryQueue,
        recentActivity: activity,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCaseDetail(organizationKey: string, caseId: string, now: Date, operatorActorId: string): Promise<OpsCaseDetail | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id", [organizationKey],
      );
      if (!organization.rows[0]?.id) throw new Error("organization_not_found");
      const operator = await client.query<{ id: string }>(
        `SELECT id FROM actors
          WHERE id = $1 AND status = 'active' AND actor_type IN ('staff','manager','admin')`,
        [operatorActorId],
      );
      if (!operator.rows[0]) throw new Error("ops_operator_not_available");
      const cases = await loadCases(client, caseId);
      const selectedCase = cases[0];
      if (!selectedCase) {
        await client.query("COMMIT");
        return null;
      }
      const documents = await loadCaseDocuments(client, caseId);
      const issues = await loadIssues(client, caseId);
      const missingDocumentRequestDraft = await loadMissingRequestDraft(client, caseId);
      const reminders = await loadCaseReminders(client, caseId);
      const handoffTask = await loadCaseHandoffTask(client, caseId);
      const recentActivity = await loadActivity(client, caseId);
      await client.query("COMMIT");
      return { generatedAt: now.toISOString(), case: selectedCase, documents, issues, missingDocumentRequestDraft, reminders, handoffTask, recentActivity };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

async function loadCaseReminders(client: PoolClient, caseId: string): Promise<OpsReminderInstance[]> {
  const result = await client.query<ReminderRow>(
    `SELECT reminder.id,reminder.reminder_kind,reminder.sequence_number,
            reminder.scheduled_at,reminder.status,reminder.trigger_reason,reminder.stop_reason,
            reminder.recipient_snapshot,reminder.content_snapshot,reminder.policy_snapshot,
            reminder.content_hash,reminder.delivery_mode,reminder.external_call_count,reminder.created_at,
            reminder.escalation_owner_actor_id,owner.display_name AS escalation_owner_name,
            escalation.status AS escalation_status,escalation.opened_at AS escalation_opened_at,
            decision.action AS decision_action,decision_actor.display_name AS decision_actor_name,
            decision.reason AS decision_reason,decision.decided_at AS decision_decided_at
       FROM reminder_instances reminder
       LEFT JOIN actors owner ON owner.id=reminder.escalation_owner_actor_id
       LEFT JOIN reminder_escalations escalation ON escalation.reminder_instance_id=reminder.id
       LEFT JOIN LATERAL (
           SELECT item.* FROM reminder_decisions item
            WHERE item.reminder_instance_id=reminder.id
            ORDER BY item.decided_at DESC,item.id DESC LIMIT 1
       ) decision ON true
       LEFT JOIN actors decision_actor ON decision_actor.id=decision.actor_id
      WHERE reminder.case_id=$1
      ORDER BY reminder.scheduled_at DESC,reminder.id DESC`, [caseId],
  );
  return result.rows.map((row) => {
    const recipient = object(row.recipient_snapshot);
    const content = object(row.content_snapshot);
    const policy = object(row.policy_snapshot);
    return {
      id: row.id, kind: row.reminder_kind, sequenceNumber: Number(row.sequence_number),
      scheduledAt: iso(row.scheduled_at), status: row.status, triggerReason: row.trigger_reason,
      stopReason: row.stop_reason,
      recipient: {
        displayName: typeof recipient.displayName === "string" ? recipient.displayName : null,
        address: typeof recipient.address === "string" ? recipient.address : "hidden@document-operations.invalid",
      },
      content: {
        subjectLine: typeof content.subjectLine === "string" ? content.subjectLine : "提醒草稿",
        bodyText: typeof content.bodyText === "string" ? content.bodyText : "内容不可用",
        requestedItems: Array.isArray(content.requestedItems) ? content.requestedItems : [],
      },
      policy: {
        timezone: stringOrNull(policy.timezone), calendarKey: stringOrNull(policy.calendarKey),
        workweek: stringOrNull(policy.workweek),
        leadBusinessDays: numberOrNull(policy.leadBusinessDays),
        intervalBusinessDays: numberOrNull(policy.intervalBusinessDays),
        maximumReminders: numberOrNull(policy.maximumReminders),
        escalationBusinessDays: numberOrNull(policy.escalationBusinessDays),
        escalationDefaultApplied: policy.escalationDefaultApplied === true,
        stopConditions: Array.isArray(policy.stopConditions)
          ? policy.stopConditions.filter((item): item is string => typeof item === "string") : [],
      },
      escalation: row.escalation_owner_actor_id && row.escalation_owner_name && row.escalation_status && row.escalation_opened_at ? {
        ownerActorId: row.escalation_owner_actor_id, ownerName: row.escalation_owner_name,
        status: row.escalation_status, openedAt: iso(row.escalation_opened_at),
      } : null,
      decision: row.decision_action && row.decision_actor_name && row.decision_reason && row.decision_decided_at ? {
        action: row.decision_action, actorName: row.decision_actor_name,
        reason: row.decision_reason, decidedAt: iso(row.decision_decided_at),
      } : null,
      contentHash: row.content_hash, deliveryMode: "disabled", externalCallCount: 0,
      createdAt: iso(row.created_at),
    };
  });
}

async function loadWorkflowErrors(client: PoolClient, now: Date): Promise<OpsWorkflowErrorItem[]> {
  const result = await client.query<WorkflowErrorRow>(
    `SELECT we.id,
            CASE WHEN we.aggregate_type = 'document' THEN we.aggregate_id END AS document_id,
            d.case_id, s.display_name AS subject_name, d.original_filename AS filename,
            wr.module_id, we.error_code, we.error_class, we.status,
            we.retry_count, we.next_retry_at, we.opened_at
       FROM workflow_errors we
       LEFT JOIN workflow_runs wr ON wr.id = we.workflow_run_id
       LEFT JOIN documents d
         ON we.aggregate_type = 'document' AND d.id = we.aggregate_id
       LEFT JOIN cases c ON c.id = d.case_id
       LEFT JOIN subjects s ON s.id = c.subject_id
      WHERE we.status IN ('open','retry_scheduled','waiting_manual')
        AND (we.aggregate_type <> 'document'
             OR d.status IN ('failed_recoverable','failed_manual','review_required'))
      ORDER BY CASE
                 WHEN we.status IN ('open','waiting_manual') THEN 0
                 WHEN we.next_retry_at IS NULL OR we.next_retry_at <= $1 THEN 1
                 ELSE 2
               END,
               we.next_retry_at NULLS FIRST, we.opened_at, we.id
      LIMIT 100`,
    [now],
  );
  return result.rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    caseId: row.case_id,
    subjectName: row.subject_name,
    filename: row.filename,
    moduleId: row.module_id,
    errorCode: row.error_code,
    errorClass: row.error_class,
    status: row.status,
    retryCount: Number(row.retry_count),
    nextRetryAt: isoOrNull(row.next_retry_at),
    openedAt: iso(row.opened_at),
  }));
}

async function loadCases(client: PoolClient, caseId: string | null = null): Promise<OpsCaseSummary[]> {
  const result = await client.query<CaseRow>(
    `SELECT c.id, s.subject_key, s.display_name AS subject_name,
            c.period_start::text, c.period_end::text, c.status, c.risk_status, c.due_at,
            progress.accepted_requirement_count,
            progress.required_requirement_count,
            COALESCE(documents.document_count, 0)::integer AS document_count,
            COALESCE(open_issues.open_issue_count, 0)::integer AS open_issue_count,
            COALESCE(latest_completeness.result->'requirements', progress.requirements) AS requirements,
            latest_completeness.id AS completeness_id,
            latest_completeness.status AS completeness_status,
            latest_completeness.algorithm_version AS completeness_algorithm_version,
            latest_completeness.input_hash AS completeness_input_hash,
            latest_completeness.matched_document_count AS completeness_matched_document_count,
            latest_completeness.missing_requirement_count AS completeness_missing_requirement_count,
            latest_completeness.duplicate_document_count AS completeness_duplicate_document_count,
            latest_completeness.excess_document_count AS completeness_excess_document_count,
            latest_completeness.review_required_document_count AS completeness_review_required_document_count,
            latest_completeness.unmatched_document_count AS completeness_unmatched_document_count,
            latest_completeness.active_submission_count AS completeness_active_submission_count,
            latest_completeness.created_at AS completeness_created_at
       FROM cases c
       JOIN subjects s ON s.id = c.subject_id
       LEFT JOIN LATERAL (
         SELECT assessment.*
           FROM case_completeness_assessments assessment
          WHERE assessment.case_id = c.id
          ORDER BY assessment.created_at DESC, assessment.id DESC
          LIMIT 1
       ) latest_completeness ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(LEAST(item.accepted_count, item.minimum_count)), 0)::integer AS accepted_requirement_count,
                COALESCE(sum(item.minimum_count), 0)::integer AS required_requirement_count,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'requirementCode', item.requirement_code,
                  'documentTypeCode', item.document_type_code,
                  'displayName', item.display_name,
                  'minimumCount', item.minimum_count,
                  'maximumCount', item.maximum_count,
                  'acceptedCount', item.accepted_count,
                  'missingCount', greatest(item.minimum_count - item.accepted_count, 0),
                  'reviewCount', item.review_count,
                  'duplicateCount', 0,
                  'excessCount', CASE WHEN item.maximum_count IS NULL THEN 0 ELSE greatest(item.accepted_count - item.maximum_count, 0) END,
                  'status', CASE
                    WHEN item.review_count > 0 THEN 'review_required'
                    WHEN item.accepted_count < item.minimum_count THEN 'missing'
                    WHEN item.maximum_count IS NOT NULL AND item.accepted_count > item.maximum_count THEN 'excess'
                    ELSE 'complete'
                  END
                ) ORDER BY item.requirement_code), '[]'::jsonb) AS requirements
           FROM (
             SELECT r.requirement_code, dt.code AS document_type_code, dt.display_name,
                    r.minimum_count, r.maximum_count,
                    (SELECT count(*)::integer FROM documents d
                      WHERE d.case_id = c.id AND d.accepted_document_type_id = dt.id
                        AND d.status IN ('accepted','human_confirmed','archived')) AS accepted_count,
                    (SELECT count(*)::integer FROM documents d
                      WHERE d.case_id = c.id AND d.accepted_document_type_id = dt.id
                        AND d.status = 'review_required') AS review_count
               FROM requirements r
               JOIN document_types dt ON dt.id = r.document_type_id
              WHERE r.requirement_set_version_id = c.requirement_set_version_id
           ) item
       ) progress ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS document_count FROM documents d WHERE d.case_id = c.id
       ) documents ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS open_issue_count FROM issues i
          WHERE i.case_id = c.id AND i.status IN ('open','assigned','waiting_external','waiting_internal','reopened')
       ) open_issues ON true
      WHERE ($1::uuid IS NULL OR c.id = $1)
      ORDER BY CASE COALESCE(c.risk_status, 'normal')
                 WHEN 'blocked' THEN 0 WHEN 'overdue' THEN 1 WHEN 'due_soon' THEN 2 ELSE 3 END,
               c.due_at NULLS LAST, s.display_name, c.period_start DESC`,
    [caseId],
  );
  return result.rows.map((row) => {
    const requirements = requirementArray(row.requirements);
    return {
      id: row.id,
      subjectKey: row.subject_key,
      subjectName: row.subject_name,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      status: row.status,
      riskStatus: row.risk_status ?? "normal",
      dueAt: isoOrNull(row.due_at),
      acceptedRequirementCount: requirements.reduce((sum, item) => sum + Math.min(item.acceptedCount, item.minimumCount), 0),
      requiredRequirementCount: requirements.reduce((sum, item) => sum + item.minimumCount, 0),
      documentCount: Number(row.document_count),
      openIssueCount: Number(row.open_issue_count),
      requirements,
      completeness: row.completeness_id === null || row.completeness_created_at === null ? null : {
        id: row.completeness_id,
        status: row.completeness_status ?? "pending",
        algorithmVersion: row.completeness_algorithm_version ?? "1.0",
        inputHash: row.completeness_input_hash ?? "",
        matchedDocumentCount: Number(row.completeness_matched_document_count ?? 0),
        missingRequirementCount: Number(row.completeness_missing_requirement_count ?? 0),
        duplicateDocumentCount: Number(row.completeness_duplicate_document_count ?? 0),
        excessDocumentCount: Number(row.completeness_excess_document_count ?? 0),
        reviewRequiredDocumentCount: Number(row.completeness_review_required_document_count ?? 0),
        unmatchedDocumentCount: Number(row.completeness_unmatched_document_count ?? 0),
        activeSubmissionCount: Number(row.completeness_active_submission_count ?? 0),
        createdAt: iso(row.completeness_created_at),
      },
    };
  });
}

async function loadReviewQueue(client: PoolClient): Promise<OpsReviewDocument[]> {
  const result = await client.query<ReviewRow>(
    `SELECT d.id, d.case_id, s.display_name AS subject_name,
            c.period_start::text, c.period_end::text, d.original_filename AS filename,
            d.status, dt.code AS document_type_code, dt.display_name AS document_type_name,
            (d.classification_summary->>'confidence')::numeric AS confidence,
            d.review_reason, d.updated_at,
            coalesce(d.classification_summary @> '{"supervisor_review_requested":true}',false) AS supervisor_review_requested,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('code', available.code, 'displayName', available.display_name)
                               ORDER BY available.display_name)
                FROM (
                  SELECT DISTINCT dt_allowed.code, dt_allowed.display_name
                    FROM requirements r
                    JOIN document_types dt_allowed ON dt_allowed.id = r.document_type_id
                   WHERE r.requirement_set_version_id = c.requirement_set_version_id
                     AND dt_allowed.status = 'active'
                ) available
            ), '[]'::jsonb) AS available_document_types
       FROM documents d
       JOIN cases c ON c.id = d.case_id
       JOIN subjects s ON s.id = c.subject_id
       LEFT JOIN document_types dt ON dt.id = d.accepted_document_type_id
      WHERE d.status IN ('review_required','failed_manual','failed_recoverable')
      ORDER BY CASE d.status WHEN 'failed_manual' THEN 0 WHEN 'review_required' THEN 1 ELSE 2 END,
               d.updated_at, d.id
      LIMIT 100`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    caseId: row.case_id,
    subjectName: row.subject_name,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    filename: row.filename,
    status: row.status,
    documentTypeCode: row.document_type_code,
    documentTypeName: row.document_type_name,
    confidence: row.confidence === null ? null : Number(row.confidence),
    reviewReason: row.review_reason,
    supervisorReviewRequested: row.supervisor_review_requested === true,
    updatedAt: iso(row.updated_at),
    availableDocumentTypes: documentTypeOptions(row.available_document_types),
  }));
}

async function loadIssues(client: PoolClient, caseId: string | null = null): Promise<OpsIssueSummary[]> {
  const result = await client.query<IssueRow>(
    `SELECT i.id, i.case_id, i.document_id, s.display_name AS subject_name,
            i.issue_type, i.severity, i.status, i.routing_reason,
            d.original_filename AS filename, i.due_at, i.opened_at,
            i.assigned_actor_id, assigned.display_name AS assigned_actor_name, i.details
       FROM issues i
       JOIN cases c ON c.id = i.case_id
       JOIN subjects s ON s.id = c.subject_id
       LEFT JOIN documents d ON d.id = i.document_id
       LEFT JOIN actors assigned ON assigned.id = i.assigned_actor_id
      WHERE ($1::uuid IS NULL OR i.case_id = $1)
      ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               i.due_at NULLS LAST, i.opened_at
      LIMIT 100`,
    [caseId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    caseId: row.case_id,
    documentId: row.document_id,
    subjectName: row.subject_name,
    issueType: row.issue_type,
    severity: row.severity,
    status: row.status,
    routingReason: row.routing_reason,
    filename: row.filename,
    dueAt: isoOrNull(row.due_at),
    openedAt: iso(row.opened_at),
    assignedActorId: row.assigned_actor_id,
    assignedActorName: row.assigned_actor_name,
    completenessException: completenessException(row.details),
  }));
}

async function loadMissingRequestDraft(client: PoolClient, caseId: string): Promise<OpsMissingDocumentRequestDraft | null> {
  const result = await client.query<MissingRequestDraftRow>(
    `SELECT draft.id, draft.assessment_id, draft.draft_version, draft.status,
            draft.recipient_snapshot, draft.subject_line, draft.body_text,
            draft.requested_items, cardinality(draft.source_issue_ids)::integer AS source_issue_count,
            draft.content_hash, draft.delivery_mode, draft.external_call_count, draft.created_at
       FROM missing_document_request_drafts draft
      WHERE draft.case_id = $1 AND draft.status = 'draft'
      ORDER BY draft.draft_version DESC, draft.id DESC
      LIMIT 1`,
    [caseId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const recipients = await client.query<MissingRequestRecipientRow>(
    `SELECT allowlist.id, allowlist.actor_id, actor.display_name, lower(actor.email) AS email,
            allowlist.source, allowlist.approved_at
       FROM subject_message_recipient_allowlist allowlist
       JOIN actors actor ON actor.id = allowlist.actor_id
      WHERE allowlist.subject_id = (
              SELECT subject_id FROM missing_document_request_drafts WHERE id = $1
            )
        AND allowlist.purpose = 'missing_document_request'
        AND allowlist.status = 'active'
        AND actor.status = 'active' AND actor.actor_type = 'customer' AND actor.email IS NOT NULL
      ORDER BY lower(actor.display_name), actor.id`,
    [row.id],
  );
  const revisions = await client.query<MissingRequestRevisionRow>(
    `SELECT revision.id, revision.revision, revision.status, revision.recipient_snapshot,
            revision.subject_line, revision.body_text, revision.content_hash,
            revision.change_reason, revision.created_by_actor_id,
            creator.display_name AS created_by_name,
            revision.submitted_by_actor_id, submitter.display_name AS submitted_by_name,
            revision.submitted_at, reviewer.display_name AS reviewed_by_name,
            revision.reviewed_at, revision.review_reason,
            revision.delivery_mode, revision.external_call_count, revision.created_at
       FROM missing_document_request_revisions revision
       LEFT JOIN actors creator ON creator.id = revision.created_by_actor_id
       LEFT JOIN actors submitter ON submitter.id = revision.submitted_by_actor_id
       LEFT JOIN actors reviewer ON reviewer.id = revision.reviewed_by_actor_id
      WHERE revision.request_draft_id = $1
      ORDER BY revision.revision DESC, revision.id DESC`,
    [row.id],
  );
  const decisions = await client.query<MissingRequestDecisionRow>(
    `SELECT decision.id, decision.revision_id, decision.action,
            actor.display_name AS actor_name, decision.reason,
            decision.content_hash, decision.decided_at
       FROM missing_document_request_review_decisions decision
       JOIN actors actor ON actor.id = decision.actor_id
       JOIN missing_document_request_revisions revision ON revision.id = decision.revision_id
      WHERE revision.request_draft_id = $1
      ORDER BY decision.decided_at DESC, decision.id DESC`,
    [row.id],
  );
  const deliveryPlans = await client.query<DeliveryPlanRow>(
    `SELECT job.id, job.source_revision_id, job.status, job.recipient_snapshot,
            job.content_hash, job.runtime_execution, job.provider_reference_mode,
            job.attempt_count, job.external_call_count, job.synthetic_scenario,
            job.provider_message_id, job.last_error_code, job.authorized_at,
            actor.display_name AS created_by_name, job.creation_reason, job.created_at
       FROM delivery_jobs job
       JOIN missing_document_request_revisions revision ON revision.id = job.source_revision_id
       LEFT JOIN actors actor ON actor.id = job.created_by_actor_id
      WHERE revision.request_draft_id = $1
      ORDER BY job.created_at DESC, job.id DESC`,
    [row.id],
  );
  const deliveryAttempts = await client.query<DeliveryAttemptRow>(
    `SELECT attempt.id,attempt.delivery_job_id,attempt.attempt_number,attempt.status,
            attempt.error_code,attempt.provider_message_id,attempt.started_at,
            attempt.completed_at,attempt.retry_not_before,attempt.external_call_count
       FROM delivery_attempts attempt
       JOIN delivery_jobs job ON job.id=attempt.delivery_job_id
       JOIN missing_document_request_revisions revision ON revision.id=job.source_revision_id
      WHERE revision.request_draft_id=$1
      ORDER BY attempt.attempt_number,attempt.id`, [row.id],
  );
  const deliveryReceipts = await client.query<DeliveryReceiptRow>(
    `SELECT receipt.id,receipt.delivery_job_id,receipt.receipt_type,receipt.provider_message_id,
            receipt.payload_hash,receipt.occurred_at,receipt.received_at
       FROM delivery_receipts receipt
       JOIN delivery_jobs job ON job.id=receipt.delivery_job_id
       JOIN missing_document_request_revisions revision ON revision.id=job.source_revision_id
      WHERE revision.request_draft_id=$1
      ORDER BY receipt.received_at,receipt.id`, [row.id],
  );
  const deliveryEvaluations = await client.query<DeliveryEvaluationRow>(
    `SELECT evaluation.id, evaluation.delivery_job_id, evaluation.status,
            evaluation.contract_version, evaluation.definition_hash, evaluation.result,
            evaluation.reason, actor.display_name AS run_by_name,
            evaluation.external_call_count, evaluation.created_at
       FROM delivery_contract_evaluations evaluation
       JOIN delivery_jobs job ON job.id = evaluation.delivery_job_id
       JOIN missing_document_request_revisions revision ON revision.id = job.source_revision_id
       LEFT JOIN actors actor ON actor.id = evaluation.run_by_actor_id
      WHERE revision.request_draft_id = $1
      ORDER BY evaluation.created_at DESC, evaluation.id DESC`,
    [row.id],
  );
  const recipient = typeof row.recipient_snapshot === "object" && row.recipient_snapshot !== null
    ? row.recipient_snapshot as Record<string, unknown> : {};
  return {
    id: row.id,
    assessmentId: row.assessment_id,
    version: Number(row.draft_version),
    status: row.status,
    recipient: {
      resolutionStatus: recipient.resolutionStatus === "ready" ? "ready" : "unresolved",
      displayName: typeof recipient.displayName === "string" ? recipient.displayName : null,
      email: typeof recipient.email === "string" ? recipient.email : null,
    },
    subjectLine: row.subject_line,
    bodyText: row.body_text,
    requestedItems: missingRequestItems(row.requested_items),
    sourceIssueCount: Number(row.source_issue_count),
    contentHash: row.content_hash,
    deliveryMode: "disabled",
    externalCallCount: 0,
    createdAt: iso(row.created_at),
    recipientPolicy: {
      mode: "allowlist_only",
      candidates: recipients.rows.map((candidate) => ({
        allowlistId: candidate.id,
        actorId: candidate.actor_id,
        displayName: candidate.display_name,
        email: candidate.email,
        source: candidate.source,
        approvedAt: iso(candidate.approved_at),
      })),
    },
    revisions: revisions.rows.map((revision) => {
      const snapshot = typeof revision.recipient_snapshot === "object" && revision.recipient_snapshot !== null
        ? revision.recipient_snapshot as Record<string, unknown> : {};
      return {
        id: revision.id,
        revision: Number(revision.revision),
        status: revision.status,
        recipient: {
          resolutionStatus: snapshot.resolutionStatus === "ready" ? "ready" as const : "unresolved" as const,
          actorId: typeof snapshot.actorId === "string" ? snapshot.actorId : null,
          displayName: typeof snapshot.displayName === "string" ? snapshot.displayName : null,
          email: typeof snapshot.email === "string" ? snapshot.email : null,
        },
        subjectLine: revision.subject_line,
        bodyText: revision.body_text,
        contentHash: revision.content_hash,
        changeReason: revision.change_reason,
        createdByActorId: revision.created_by_actor_id,
        createdByName: revision.created_by_name,
        submittedByActorId: revision.submitted_by_actor_id,
        submittedByName: revision.submitted_by_name,
        submittedAt: isoOrNull(revision.submitted_at),
        reviewedByName: revision.reviewed_by_name,
        reviewedAt: isoOrNull(revision.reviewed_at),
        reviewReason: revision.review_reason,
        deliveryMode: "disabled" as const,
        externalCallCount: 0 as const,
        createdAt: iso(revision.created_at),
      };
    }),
    reviewDecisions: decisions.rows.map((decision) => ({
      id: decision.id,
      revisionId: decision.revision_id,
      action: decision.action,
      actorName: decision.actor_name,
      reason: decision.reason,
      contentHash: decision.content_hash,
      decidedAt: iso(decision.decided_at),
    })),
    deliveryPlans: deliveryPlans.rows.map((job) => {
      const snapshot = typeof job.recipient_snapshot === "object" && job.recipient_snapshot !== null
        ? job.recipient_snapshot as Record<string, unknown> : {};
      return {
        id: job.id,
        revisionId: job.source_revision_id,
        status: job.status,
        recipient: {
          displayName: typeof snapshot.displayName === "string" ? snapshot.displayName : null,
          address: typeof snapshot.address === "string" ? snapshot.address : null,
        },
        contentHash: job.content_hash,
        runtimeExecution: job.runtime_execution,
        providerConfigured: job.provider_reference_mode === "synthetic",
        scenario: job.synthetic_scenario,
        providerMessageId: job.provider_message_id,
        lastErrorCode: job.last_error_code,
        authorizedAt: isoOrNull(job.authorized_at),
        attemptCount: Number(job.attempt_count),
        externalCallCount: 0 as const,
        createdByName: job.created_by_name,
        creationReason: job.creation_reason,
        createdAt: iso(job.created_at),
        attempts: deliveryAttempts.rows.filter((attempt) => attempt.delivery_job_id === job.id).map((attempt) => ({
          id: attempt.id, attemptNumber: Number(attempt.attempt_number), status: attempt.status,
          errorCode: attempt.error_code, providerMessageId: attempt.provider_message_id,
          startedAt: iso(attempt.started_at), completedAt: isoOrNull(attempt.completed_at),
          retryNotBefore: isoOrNull(attempt.retry_not_before), externalCallCount: 0 as const,
        })),
        receipts: deliveryReceipts.rows.filter((receipt) => receipt.delivery_job_id === job.id).map((receipt) => ({
          id: receipt.id, receiptType: receipt.receipt_type,
          providerMessageId: receipt.provider_message_id, payloadHash: receipt.payload_hash,
          occurredAt: iso(receipt.occurred_at), receivedAt: iso(receipt.received_at),
        })),
      };
    }),
    deliveryEvaluations: deliveryEvaluations.rows.map((evaluation) => ({
      id: evaluation.id,
      deliveryJobId: evaluation.delivery_job_id,
      status: evaluation.status,
      contractVersion: "1.0" as const,
      definitionHash: evaluation.definition_hash,
      result: typeof evaluation.result === "object" && evaluation.result !== null
        ? evaluation.result as Record<string, unknown> : {},
      reason: evaluation.reason,
      runByName: evaluation.run_by_name,
      externalCallCount: 0 as const,
      createdAt: iso(evaluation.created_at),
    })),
  };
}

async function loadReviewDecisions(client: PoolClient): Promise<OpsReviewDecisionSummary[]> {
  const result = await client.query<DecisionRow>(
    `SELECT decision.id, decision.document_id, d.original_filename AS filename,
            s.display_name AS subject_name, decision.action, decision.exclusion_reason,
            d.status AS document_status,
            dt.display_name AS document_type_name, decision.rationale,
            actor.display_name AS actor_name, decision.decided_at
       FROM document_review_decisions decision
       JOIN documents d ON d.id = decision.document_id
       JOIN cases c ON c.id = d.case_id
       JOIN subjects s ON s.id = c.subject_id
       JOIN actors actor ON actor.id = decision.actor_id
       LEFT JOIN document_types dt ON dt.id = d.accepted_document_type_id
      ORDER BY decision.decided_at DESC, decision.id DESC
      LIMIT 30`,
  );
  return result.rows.map((row) => ({
    id: row.id, documentId: row.document_id, filename: row.filename, subjectName: row.subject_name,
    action: row.action, documentStatus: row.document_status, documentTypeName: row.document_type_name,
    exclusionReason: row.exclusion_reason,
    rationale: row.rationale, actorName: row.actor_name, decidedAt: iso(row.decided_at),
  }));
}

async function loadRecentDocuments(client: PoolClient): Promise<OpsRecentDocument[]> {
  const result = await client.query<RecentDocumentRow>(
    `SELECT d.id, d.original_filename AS filename, s.display_name AS subject_name,
            d.status, dt.display_name AS document_type_name, d.updated_at,
            (d.incoming_storage_ref IS NOT NULL) AS preview_available
       FROM documents d
       JOIN cases c ON c.id = d.case_id
       JOIN subjects s ON s.id = c.subject_id
       LEFT JOIN document_types dt ON dt.id = d.accepted_document_type_id
      ORDER BY d.updated_at DESC, d.id DESC
      LIMIT 50`,
  );
  return result.rows.map((row) => ({
    id: row.id, filename: row.filename, subjectName: row.subject_name, status: row.status,
    documentTypeName: row.document_type_name, updatedAt: iso(row.updated_at),
    previewAvailable: row.preview_available,
  }));
}

async function loadActivity(client: PoolClient, caseId: string | null = null): Promise<OpsActivityItem[]> {
  const result = await client.query<ActivityRow>(
    `SELECT id, event_type, aggregate_type, aggregate_id, occurred_at
      FROM workflow_events event
      WHERE $1::uuid IS NULL
         OR (event.aggregate_type = 'case' AND event.aggregate_id = $1)
         OR (event.aggregate_type = 'document' AND EXISTS (
              SELECT 1 FROM documents d WHERE d.id = event.aggregate_id AND d.case_id = $1))
         OR (event.aggregate_type = 'issue' AND EXISTS (
              SELECT 1 FROM issues i WHERE i.id = event.aggregate_id AND i.case_id = $1))
         OR (event.aggregate_type = 'missing_document_request_draft' AND EXISTS (
              SELECT 1 FROM missing_document_request_drafts draft
               WHERE draft.id = event.aggregate_id AND draft.case_id = $1))
         OR (event.aggregate_type = 'delivery_job' AND EXISTS (
              SELECT 1 FROM delivery_jobs job
               WHERE job.id = event.aggregate_id AND job.case_id = $1))
         OR (event.aggregate_type = 'task' AND EXISTS (
              SELECT 1 FROM tasks task
               WHERE task.id = event.aggregate_id AND task.case_id = $1))
      ORDER BY occurred_at DESC, id DESC
      LIMIT 20`,
    [caseId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    occurredAt: iso(row.occurred_at),
  }));
}

async function loadCaseHandoffTask(client: PoolClient, caseId: string): Promise<import("../../ports/ops-read-repository.js").OpsHandoffTask | null> {
  const result = await client.query<{
    id: string; name: string; task_type: string; status: "open" | "waiting" | "in_progress" | "completed" | "cancelled";
    assigned_actor_id: string | null; assigned_actor_name: string | null;
    due_at: Date | string | null; instructions: string; completion_criteria: string;
    created_at: Date | string; external_execution: string | null;
  }>(
    `SELECT task.id, task.name, task.task_type, task.status, task.assigned_actor_id,
            actor.display_name AS assigned_actor_name, task.due_at, task.created_at,
            task.instructions, task.completion_criteria,
            task.context->>'externalExecution' AS external_execution
       FROM tasks task
       LEFT JOIN actors actor ON actor.id = task.assigned_actor_id
      WHERE task.case_id = $1 AND task.task_key = 'case-handoff|' || $1::text
      LIMIT 1`,
    [caseId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id, name: row.name, taskType: row.task_type, status: row.status,
    assignedActorId: row.assigned_actor_id, assignedActorName: row.assigned_actor_name,
    dueAt: isoOrNull(row.due_at), instructions: row.instructions,
    completionCriteria: row.completion_criteria, createdAt: iso(row.created_at), externalExecution: "disabled",
  } : null;
}

async function loadCaseDocuments(client: PoolClient, caseId: string): Promise<OpsCaseDocument[]> {
  const result = await client.query<CaseDocumentRow>(
    `WITH ranked AS (
       SELECT d.*,
              CASE WHEN d.content_hash_sha256 IS NULL THEN 1
                   ELSE count(*) OVER (PARTITION BY d.case_id, d.content_hash_sha256) END::integer AS content_group_size,
              CASE WHEN d.content_hash_sha256 IS NULL THEN 1
                   ELSE row_number() OVER (PARTITION BY d.case_id, d.content_hash_sha256 ORDER BY d.created_at, d.id) END::integer AS content_group_position,
              count(*) OVER (PARTITION BY d.case_id, lower(d.original_filename))::integer AS filename_group_size,
              row_number() OVER (PARTITION BY d.case_id, lower(d.original_filename) ORDER BY d.created_at, d.id)::integer AS filename_group_position
         FROM documents d
        WHERE d.case_id = $1
     )
     SELECT d.id, d.original_filename, d.declared_mime_type, d.detected_mime_type, d.size_bytes,
            d.status, dt.code AS document_type_code, dt.display_name AS document_type_name,
            (d.classification_summary->>'confidence')::numeric AS confidence, d.review_reason,
            d.classification_summary->'conflict_flags' AS conflict_flags,
            coalesce(d.classification_summary @> '{"supervisor_review_requested":true}',false) AS supervisor_review_requested,
            d.created_at, d.updated_at, (d.incoming_storage_ref IS NOT NULL) AS preview_available,
            d.content_group_size, d.content_group_position, d.filename_group_size, d.filename_group_position,
            attempt.attempt_number, attempt.status AS attempt_status, attempt.error_code AS attempt_error_code,
            attempt.started_at AS attempt_started_at, attempt.completed_at AS attempt_completed_at,
            active_error.error_code AS active_error_code, active_error.error_class AS active_error_class,
            active_error.status AS active_error_status, active_error.retry_count, active_error.next_retry_at,
            active_error.opened_at AS error_opened_at,
            latest_match.match_status, matched_requirement.requirement_code AS match_requirement_code,
            latest_match.duplicate_kind AS match_duplicate_kind,
            latest_match.is_excess AS match_is_excess,
            latest_match.counts_toward_minimum AS match_counts_toward_minimum,
            latest_match.reason_code AS match_reason_code
       FROM ranked d
       LEFT JOIN document_types dt ON dt.id = d.accepted_document_type_id
       LEFT JOIN LATERAL (
         SELECT match.*
           FROM case_completeness_assessments assessment
           JOIN document_requirement_matches match ON match.assessment_id = assessment.id
          WHERE assessment.case_id = d.case_id AND match.document_id = d.id
          ORDER BY assessment.created_at DESC, assessment.id DESC
          LIMIT 1
       ) latest_match ON true
       LEFT JOIN requirements matched_requirement ON matched_requirement.id = latest_match.requirement_id
       LEFT JOIN LATERAL (
         SELECT ca.attempt_number, ca.status, ca.error_code, ca.started_at, ca.completed_at
           FROM classification_attempts ca WHERE ca.document_id = d.id
          ORDER BY ca.attempt_number DESC LIMIT 1
       ) attempt ON true
       LEFT JOIN LATERAL (
         SELECT we.error_code, we.error_class, we.status, we.retry_count, we.next_retry_at, we.opened_at
           FROM workflow_errors we
         WHERE we.aggregate_type = 'document' AND we.aggregate_id = d.id
            AND d.status IN ('failed_recoverable','review_required','failed_manual')
            AND we.status IN ('open','retry_scheduled','waiting_manual')
          ORDER BY we.opened_at DESC, we.id DESC LIMIT 1
       ) active_error ON true
      ORDER BY d.created_at, d.id`,
    [caseId],
  );
  return result.rows.map((row) => {
    const contentRelated = Number(row.content_group_size) > 1;
    const filenameRelated = Number(row.filename_group_size) > 1;
    return {
      id: row.id, filename: row.original_filename, declaredMimeType: row.declared_mime_type,
      detectedMimeType: row.detected_mime_type, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      status: row.status, documentTypeCode: row.document_type_code, documentTypeName: row.document_type_name,
      confidence: row.confidence === null ? null : Number(row.confidence), reviewReason: row.review_reason,
      conflictFlags: Array.isArray(row.conflict_flags) ? row.conflict_flags : [],
      supervisorReviewRequested: row.supervisor_review_requested === true,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), previewAvailable: row.preview_available,
      relation: contentRelated
        ? { kind: "same_content" as const, position: Number(row.content_group_position), total: Number(row.content_group_size) }
        : filenameRelated
          ? { kind: "same_filename" as const, position: Number(row.filename_group_position), total: Number(row.filename_group_size) }
          : { kind: "unique" as const, position: 1, total: 1 },
      latestAttempt: row.attempt_number === null || row.attempt_started_at === null ? null : {
        attemptNumber: Number(row.attempt_number), status: row.attempt_status ?? "unknown", errorCode: row.attempt_error_code,
        startedAt: iso(row.attempt_started_at), completedAt: isoOrNull(row.attempt_completed_at),
      },
      activeError: row.active_error_code === null || row.error_opened_at === null ? null : {
        errorCode: row.active_error_code, errorClass: row.active_error_class ?? "unknown",
        status: row.active_error_status ?? "open", retryCount: Number(row.retry_count ?? 0),
        nextRetryAt: isoOrNull(row.next_retry_at), openedAt: iso(row.error_opened_at),
      },
      requirementMatch: row.match_status === null ? null : {
        status: row.match_status,
        requirementCode: row.match_requirement_code,
        duplicateKind: row.match_duplicate_kind ?? "none",
        isExcess: row.match_is_excess === true,
        countsTowardMinimum: row.match_counts_toward_minimum === true,
        reasonCode: row.match_reason_code ?? "unknown",
      },
    };
  });
}

type CompletenessExceptionSummary = NonNullable<OpsIssueSummary["completenessException"]>;

function completenessException(value: unknown): CompletenessExceptionSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const root = value as Record<string, unknown>;
  if (typeof root.completenessException !== "object" || root.completenessException === null) return null;
  const item = root.completenessException as Record<string, unknown>;
  const exceptionType = String(item.exceptionType);
  if (!["missing", "duplicate", "excess", "review_required", "unmatched"].includes(exceptionType) ||
      typeof item.assessmentId !== "string") return null;
  return {
    assessmentId: item.assessmentId,
    exceptionType: exceptionType as CompletenessExceptionSummary["exceptionType"],
    requirementCode: typeof item.requirementCode === "string" ? item.requirementCode : null,
    displayName: typeof item.displayName === "string" ? item.displayName : null,
    quantity: Math.max(Number(item.quantity ?? 1), 1),
  };
}

function missingRequestItems(value: unknown): OpsMissingDocumentRequestDraft["requestedItems"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.requirementCode !== "string" || typeof item.documentTypeCode !== "string" ||
        typeof item.displayName !== "string") return [];
    return [{
      requirementCode: item.requirementCode,
      documentTypeCode: item.documentTypeCode,
      displayName: item.displayName,
      missingCount: Math.max(Number(item.missingCount ?? 0), 0),
    }];
  });
}

function requirementArray(value: unknown): OpsRequirementProgress[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.requirementCode !== "string" ||
        typeof candidate.documentTypeCode !== "string" ||
        typeof candidate.displayName !== "string") return [];
    return [{
      requirementCode: candidate.requirementCode,
      documentTypeCode: candidate.documentTypeCode,
      displayName: candidate.displayName,
      minimumCount: Number(candidate.minimumCount ?? 0),
      maximumCount: candidate.maximumCount === null || candidate.maximumCount === undefined ? null : Number(candidate.maximumCount),
      acceptedCount: Number(candidate.acceptedCount ?? 0),
      missingCount: Number(candidate.missingCount ?? Math.max(Number(candidate.minimumCount ?? 0) - Number(candidate.acceptedCount ?? 0), 0)),
      reviewCount: Number(candidate.reviewCount ?? 0),
      duplicateCount: Number(candidate.duplicateCount ?? 0),
      excessCount: Number(candidate.excessCount ?? 0),
      status: requirementStatus(candidate.status),
    }];
  });
}

function requirementStatus(value: unknown): OpsRequirementProgress["status"] {
  return ["complete", "missing", "review_required", "excess", "attention"].includes(String(value))
    ? value as OpsRequirementProgress["status"] : "missing";
}

function documentTypeOptions(value: unknown): Array<{ code: string; displayName: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const candidate = item as Record<string, unknown>;
    return typeof candidate.code === "string" && typeof candidate.displayName === "string"
      ? [{ code: candidate.code, displayName: candidate.displayName }]
      : [];
  });
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
