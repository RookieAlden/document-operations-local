export type TaskOperatorAction = "claim" | "start" | "wait" | "resume" | "complete" | "reassign" | "reopen";

export interface OpsTaskItem {
  id: string;
  name: string;
  caseId: string;
  subjectName: string;
  periodStart: string | null;
  periodEnd: string | null;
  taskType: string;
  status: "open" | "waiting" | "in_progress" | "completed" | "cancelled";
  assignedActorId: string | null;
  assignedActorName: string | null;
  dueAt: string | null;
  instructions: string;
  completionCriteria: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  externalExecution: "disabled";
}

export interface OpsTaskTransitionItem {
  id: string;
  taskId: string;
  actorName: string;
  action: TaskOperatorAction;
  previousStatus: string;
  resultingStatus: string;
  previousAssignedActorName: string | null;
  resultingAssignedActorName: string | null;
  reason: string;
  eventId: string;
  transitionedAt: string;
}

export interface OpsTaskSnapshot {
  generatedAt: string;
  canManage: boolean;
  operatorActorId: string;
  assignees: Array<{ id: string; displayName: string; actorType: "staff" | "manager" | "admin" }>;
  tasks: OpsTaskItem[];
  recentTransitions: OpsTaskTransitionItem[];
}

export interface TransitionTaskRequest {
  organizationKey: string;
  taskId: string;
  actorId: string;
  action: TaskOperatorAction;
  assignedActorId: string | null;
  reason: string;
  idempotencyKey: string;
  requestFingerprint: string;
  transitionId: string;
  eventId: string;
  correlationId: string;
  now: Date;
}

export type TransitionTaskResult = {
  outcome: "completed" | "duplicate";
  transitionId: string;
  eventId: string;
  taskId: string;
  action: TaskOperatorAction;
  taskStatus: string;
  assignedActorId: string | null;
  transitionedAt: string;
} | { outcome: "not_found"; resource: "organization" | "operator" | "task" } |
  { outcome: "conflict"; reason: "idempotency_key_reused" | "transition_not_allowed" | "manager_required" |
    "task_not_owned" | "task_already_assigned" | "assignee_required" | "assignee_invalid" };

export interface OpsTaskRepository {
  getSnapshot(organizationKey: string, operatorActorId: string, now: Date): Promise<OpsTaskSnapshot>;
  transition(request: TransitionTaskRequest): Promise<TransitionTaskResult>;
}
