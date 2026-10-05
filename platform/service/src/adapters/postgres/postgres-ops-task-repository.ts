import type { Pool, PoolClient } from "pg";
import type {
  OpsTaskRepository,
  OpsTaskSnapshot,
  TaskOperatorAction,
  TransitionTaskRequest,
  TransitionTaskResult,
} from "../../ports/ops-task-repository.js";

interface FunctionRow { result: unknown }

export class PostgresOpsTaskRepository implements OpsTaskRepository {
  constructor(private readonly pool: Pool) {}

  async getSnapshot(organizationKey: string, operatorActorId: string, now: Date): Promise<OpsTaskSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", [organizationKey]);
      if (!organization.rows[0]?.id) throw new Error("organization_not_found");
      const operator = await client.query<{ id: string; actor_type: "staff" | "manager" | "admin" }>(
        `SELECT id, actor_type FROM actors
          WHERE id=$1 AND status='active' AND actor_type IN ('staff','manager','admin')`,
        [operatorActorId],
      );
      if (!operator.rows[0]) throw new Error("ops_operator_not_available");
      const assignees = await client.query<{ id: string; display_name: string; actor_type: "staff" | "manager" | "admin" }>(
        `SELECT id, display_name, actor_type FROM actors
          WHERE status='active' AND actor_type IN ('staff','manager','admin')
          ORDER BY display_name, id`,
      );
      const tasks = await client.query<{
        id: string; name: string; case_id: string; subject_name: string; period_start: string | null; period_end: string | null;
        task_type: string; status: "open" | "waiting" | "in_progress" | "completed" | "cancelled";
        assigned_actor_id: string | null; assigned_actor_name: string | null; due_at: Date | string | null;
        instructions: string; completion_criteria: string;
        created_at: Date | string; updated_at: Date | string; completed_at: Date | string | null;
      }>(`SELECT task.id,task.name,task.case_id,subject.display_name AS subject_name,
                  case_row.period_start::text,case_row.period_end::text,task.task_type,task.status,
                  task.assigned_actor_id,assignee.display_name AS assigned_actor_name,
                  task.due_at,task.instructions,task.completion_criteria,
                  task.created_at,task.updated_at,task.completed_at
             FROM tasks task
             JOIN cases case_row ON case_row.id=task.case_id
             JOIN subjects subject ON subject.id=case_row.subject_id
             LEFT JOIN actors assignee ON assignee.id=task.assigned_actor_id
            ORDER BY CASE task.status WHEN 'in_progress' THEN 0 WHEN 'waiting' THEN 1 WHEN 'open' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
                     task.due_at NULLS LAST,task.updated_at DESC,task.id DESC
            LIMIT 200`);
      const transitions = await client.query<{
        id: string; task_id: string; actor_name: string; action: TaskOperatorAction;
        previous_status: string; resulting_status: string; previous_assigned_actor_name: string | null;
        resulting_assigned_actor_name: string | null; reason: string; event_id: string; transitioned_at: Date | string;
      }>(`SELECT transition.id,transition.task_id,actor.display_name AS actor_name,transition.action,
                  transition.previous_status,transition.resulting_status,
                  previous_actor.display_name AS previous_assigned_actor_name,
                  resulting_actor.display_name AS resulting_assigned_actor_name,
                  transition.reason,transition.event_id,transition.transitioned_at
             FROM task_operator_transitions transition
             JOIN actors actor ON actor.id=transition.actor_id
             LEFT JOIN actors previous_actor ON previous_actor.id=transition.previous_assigned_actor_id
             LEFT JOIN actors resulting_actor ON resulting_actor.id=transition.resulting_assigned_actor_id
            ORDER BY transition.transitioned_at DESC,transition.id DESC LIMIT 100`);
      await client.query("COMMIT");
      return {
        generatedAt: now.toISOString(),
        canManage: ["manager", "admin"].includes(operator.rows[0].actor_type),
        operatorActorId,
        assignees: assignees.rows.map((row) => ({ id: row.id, displayName: row.display_name, actorType: row.actor_type })),
        tasks: tasks.rows.map((row) => ({
          id: row.id, name: row.name, caseId: row.case_id, subjectName: row.subject_name,
          periodStart: row.period_start, periodEnd: row.period_end,
          taskType: row.task_type, status: row.status,
          assignedActorId: row.assigned_actor_id, assignedActorName: row.assigned_actor_name,
          dueAt: isoOrNull(row.due_at), instructions: row.instructions, completionCriteria: row.completion_criteria,
          createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
          completedAt: isoOrNull(row.completed_at), externalExecution: "disabled",
        })),
        recentTransitions: transitions.rows.map((row) => ({
          id: row.id, taskId: row.task_id, actorName: row.actor_name, action: row.action,
          previousStatus: row.previous_status, resultingStatus: row.resulting_status,
          previousAssignedActorName: row.previous_assigned_actor_name,
          resultingAssignedActorName: row.resulting_assigned_actor_name,
          reason: row.reason, eventId: row.event_id, transitionedAt: iso(row.transitioned_at),
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async transition(request: TransitionTaskRequest): Promise<TransitionTaskResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", [request.organizationKey]);
      if (!organization.rows[0]?.id) {
        await client.query("COMMIT");
        return { outcome: "not_found", resource: "organization" };
      }
      const result = await client.query<FunctionRow>(
        "SELECT dop_transition_task($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result",
        [request.actorId,request.taskId,request.action,request.assignedActorId,request.reason,
          request.idempotencyKey,request.requestFingerprint,request.transitionId,request.eventId,
          request.correlationId,request.now],
      );
      await client.query("COMMIT");
      return normalizeResult(result.rows[0]?.result);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

function normalizeResult(value: unknown): TransitionTaskResult {
  if (!value || typeof value !== "object") throw new Error("invalid_task_transition_result");
  const row = value as Record<string, unknown>;
  if (row.outcome === "not_found") return { outcome: "not_found", resource: row.resource as "operator" | "task" };
  if (row.outcome === "conflict") return {
    outcome: "conflict",
    reason: row.reason as Extract<TransitionTaskResult, { outcome: "conflict" }>["reason"],
  };
  return {
    outcome: row.outcome as "completed" | "duplicate",
    transitionId: String(row.transitionId), eventId: String(row.eventId), taskId: String(row.taskId),
    action: row.action as TaskOperatorAction, taskStatus: String(row.taskStatus),
    assignedActorId: typeof row.assignedActorId === "string" ? row.assignedActorId : null,
    transitionedAt: new Date(String(row.transitionedAt)).toISOString(),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function isoOrNull(value: Date | string | null): string | null { return value === null ? null : iso(value); }
