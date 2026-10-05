import { createHash, randomUUID } from "node:crypto";
import type { OpsTaskRepository, TaskOperatorAction, TransitionTaskResult } from "../ports/ops-task-repository.js";

const actions: TaskOperatorAction[] = ["claim", "start", "wait", "resume", "complete", "reassign", "reopen"];

export class TransitionTask {
  constructor(private readonly repository: OpsTaskRepository) {}

  async execute(input: {
    organizationKey: string;
    taskId: string;
    actorId: string;
    action: TaskOperatorAction;
    assignedActorId: string | null;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<TransitionTaskResult> {
    const reason = input.reason.trim();
    if (![input.taskId, input.actorId, input.idempotencyKey, input.correlationId].every(isUuid)) {
      throw new TaskTransitionInputError("invalid_identifier");
    }
    if (input.assignedActorId !== null && !isUuid(input.assignedActorId)) {
      throw new TaskTransitionInputError("invalid_assignee");
    }
    if (!input.organizationKey || input.organizationKey.length > 120) {
      throw new TaskTransitionInputError("invalid_organization");
    }
    if (!actions.includes(input.action)) throw new TaskTransitionInputError("invalid_action");
    if (reason.length < 12 || reason.length > 1000) throw new TaskTransitionInputError("invalid_reason");
    const requestFingerprint = createHash("sha256").update(JSON.stringify({
      taskId: input.taskId,
      actorId: input.actorId,
      action: input.action,
      assignedActorId: input.assignedActorId,
      reason,
    })).digest("hex");
    return await this.repository.transition({
      ...input,
      reason,
      requestFingerprint,
      transitionId: randomUUID(),
      eventId: randomUUID(),
    });
  }
}

export class TaskTransitionInputError extends Error {
  constructor(readonly code: string) { super(code); }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
