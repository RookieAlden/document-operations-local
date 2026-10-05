import type { Pool, PoolClient } from "pg";
import type { IssueOperatorAction, OpsIssueRepository, TransitionIssueRequest, TransitionIssueResult } from "../../ports/ops-issue-repository.js";

interface ExistingRow { id: string; request_fingerprint: string; event_id: string; issue_id: string; action: IssueOperatorAction; resulting_status: string; resulting_assigned_actor_id: string | null; transitioned_at: Date | string }
interface IssueRow { id: string; status: string; assigned_actor_id: string | null }

const allowed: Record<IssueOperatorAction, string[]> = {
  assign_to_me: ["open", "reopened", "assigned", "waiting_internal", "waiting_external"],
  wait_internal: ["assigned", "waiting_external", "waiting_internal"],
  wait_external: ["assigned", "waiting_internal", "waiting_external"],
  resolve: ["assigned", "waiting_internal", "waiting_external", "reopened"],
  reopen: ["resolved", "closed"],
  close: ["resolved"],
};

export class PostgresOpsIssueRepository implements OpsIssueRepository {
  constructor(private readonly pool: Pool) {}

  async transition(request: TransitionIssueRequest): Promise<TransitionIssueResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", [request.organizationKey]);
      const organizationId = organization.rows[0]?.id;
      if (!organizationId) return await notFound(client, "organization");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${organizationId}|ops-issue|${request.idempotencyKey}`,
      ]);
      const existing = await loadExisting(client, request.idempotencyKey);
      if (existing) {
        await client.query("COMMIT");
        if (existing.request_fingerprint !== request.requestFingerprint) return { outcome: "conflict", reason: "idempotency_key_reused" };
        return completed(existing, "duplicate");
      }
      const operator = await client.query<{ id: string; actor_type: string }>(
        "SELECT id, actor_type FROM actors WHERE id = $1 AND status = 'active' AND actor_type IN ('staff','manager','admin')",
        [request.actorId],
      );
      if (!operator.rows[0]) return await notFound(client, "operator");
      if (["reopen", "close"].includes(request.action) && !["manager", "admin"].includes(operator.rows[0].actor_type)) {
        await client.query("COMMIT");
        return { outcome: "conflict", reason: "manager_required" };
      }
      const issueResult = await client.query<IssueRow>("SELECT id, status, assigned_actor_id FROM issues WHERE id = $1 FOR UPDATE", [request.issueId]);
      const issue = issueResult.rows[0];
      if (!issue) return await notFound(client, "issue");
      if (!allowed[request.action].includes(issue.status)) {
        await client.query("COMMIT");
        return { outcome: "conflict", reason: "transition_not_allowed" };
      }
      const resultingStatus = statusFor(request.action);
      const assignedActorId = request.action === "assign_to_me" || request.action === "reopen" ? request.actorId : issue.assigned_actor_id;
      await client.query(
        `UPDATE issues SET status = $2, assigned_actor_id = $3,
             details = details || $4::jsonb,
             resolved_at = CASE WHEN $2::text = 'resolved' THEN $5::timestamptz ELSE NULL::timestamptz END,
             closed_at = CASE WHEN $2::text = 'closed' THEN $5::timestamptz ELSE NULL::timestamptz END
          WHERE id = $1`,
        [request.issueId, resultingStatus, assignedActorId, JSON.stringify({ latest_operator_transition: {
          action: request.action, actor_id: request.actorId, note: request.note, at: request.now.toISOString(),
        } }), request.now],
      );
      await client.query(
        `INSERT INTO workflow_events (id, organization_id, idempotency_key, event_type, event_version,
           aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at)
         VALUES ($1,$2,$3,'Issue.StatusChanged',1,'issue',$4,$5,$6,'dop.ops.issue.v1',$7::jsonb,$8)`,
        [request.eventId, organizationId, `ops-issue|${request.idempotencyKey}`, request.issueId, request.correlationId,
          request.actorId, JSON.stringify({ transition_id: request.transitionId, action: request.action,
            previous_status: issue.status, resulting_status: resultingStatus,
            previous_assigned_actor_id: issue.assigned_actor_id, resulting_assigned_actor_id: assignedActorId,
            note: request.note }), request.now],
      );
      await client.query(
        `INSERT INTO issue_operator_transitions (id, organization_id, issue_id, actor_id, idempotency_key,
           request_fingerprint, action, previous_status, resulting_status, previous_assigned_actor_id,
           resulting_assigned_actor_id, note, event_id, transitioned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [request.transitionId, organizationId, request.issueId, request.actorId, request.idempotencyKey,
          request.requestFingerprint, request.action, issue.status, resultingStatus, issue.assigned_actor_id,
          assignedActorId, request.note, request.eventId, request.now],
      );
      if (request.action === "resolve" || request.action === "close") {
        await client.query(
          "SELECT dop_acknowledge_resolved_duplicate_case($1,$2,$3) AS result",
          [request.issueId, request.actorId, request.now],
        );
      }
      await client.query("COMMIT");
      return { outcome: "completed", transitionId: request.transitionId, eventId: request.eventId,
        issueId: request.issueId, action: request.action, issueStatus: resultingStatus,
        assignedActorId, transitionedAt: request.now.toISOString() };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

function statusFor(action: IssueOperatorAction): string {
  return ({ assign_to_me: "assigned", wait_internal: "waiting_internal", wait_external: "waiting_external",
    resolve: "resolved", reopen: "reopened", close: "closed" })[action];
}

async function loadExisting(client: PoolClient, key: string): Promise<ExistingRow | null> {
  const result = await client.query<ExistingRow>(`SELECT id, request_fingerprint, event_id, issue_id, action,
     resulting_status, resulting_assigned_actor_id, transitioned_at
     FROM issue_operator_transitions WHERE idempotency_key = $1`, [key]);
  return result.rows[0] ?? null;
}

function completed(row: ExistingRow, outcome: "duplicate"): TransitionIssueResult {
  return { outcome, transitionId: row.id, eventId: row.event_id, issueId: row.issue_id, action: row.action,
    issueStatus: row.resulting_status, assignedActorId: row.resulting_assigned_actor_id,
    transitionedAt: row.transitioned_at instanceof Date ? row.transitioned_at.toISOString() : new Date(row.transitioned_at).toISOString() };
}

async function notFound(client: PoolClient, resource: "organization" | "operator" | "issue"): Promise<TransitionIssueResult> {
  await client.query("COMMIT");
  return { outcome: "not_found", resource };
}
