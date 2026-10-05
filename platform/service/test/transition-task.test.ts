import { describe, expect, it } from "vitest";
import { TransitionTask } from "../src/application/transition-task.js";
import type { OpsTaskRepository, TransitionTaskRequest, TransitionTaskResult } from "../src/ports/ops-task-repository.js";

const ids = {
  task: "00000000-0000-4000-8000-000000000001",
  actor: "00000000-0000-4000-8000-000000000002",
  assignee: "00000000-0000-4000-8000-000000000003",
  idempotency: "00000000-0000-4000-8000-000000000004",
  correlation: "00000000-0000-4000-8000-000000000005",
};

class StubTaskRepository implements OpsTaskRepository {
  requests: TransitionTaskRequest[] = [];
  async getSnapshot(): Promise<never> { throw new Error("unused"); }
  async transition(request: TransitionTaskRequest): Promise<TransitionTaskResult> {
    this.requests.push(request);
    return { outcome: "completed", transitionId: request.transitionId, eventId: request.eventId,
      taskId: request.taskId, action: request.action, taskStatus: "open",
      assignedActorId: request.actorId, transitionedAt: request.now.toISOString() };
  }
}

describe("TransitionTask", () => {
  it("normalizes input and fingerprints the assignee-sensitive request", async () => {
    const repository = new StubTaskRepository();
    const handler = new TransitionTask(repository);
    const result = await handler.execute({ organizationKey: "dev", taskId: ids.task, actorId: ids.actor,
      action: "reassign", assignedActorId: ids.assignee, reason: "  Reassign this synthetic task to the designated operator.  ",
      idempotencyKey: ids.idempotency, correlationId: ids.correlation,
      now: new Date("2026-08-16T04:00:00.000Z") });
    expect(result.outcome).toBe("completed");
    expect(repository.requests[0]).toMatchObject({ action: "reassign", assignedActorId: ids.assignee,
      reason: "Reassign this synthetic task to the designated operator." });
    expect(repository.requests[0]?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.requests[0]?.transitionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(repository.requests[0]?.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects malformed identifiers, unsupported actions and short reasons before persistence", async () => {
    const repository = new StubTaskRepository();
    const handler = new TransitionTask(repository);
    const base = { organizationKey: "dev", taskId: ids.task, actorId: ids.actor,
      action: "claim" as const, assignedActorId: null, reason: "Claim this synthetic task now.",
      idempotencyKey: ids.idempotency, correlationId: ids.correlation, now: new Date() };
    await expect(handler.execute({ ...base, taskId: "bad" })).rejects.toMatchObject({ code: "invalid_identifier" });
    await expect(handler.execute({ ...base, action: "delete" as never })).rejects.toMatchObject({ code: "invalid_action" });
    await expect(handler.execute({ ...base, reason: "too short" })).rejects.toMatchObject({ code: "invalid_reason" });
    expect(repository.requests).toHaveLength(0);
  });
});
