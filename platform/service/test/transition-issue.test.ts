import { describe, expect, it } from "vitest";
import { TransitionIssue } from "../src/application/transition-issue.js";
import type { OpsIssueRepository, TransitionIssueRequest } from "../src/ports/ops-issue-repository.js";

class StubRepository implements OpsIssueRepository {
  requests: TransitionIssueRequest[] = [];
  async transition(request: TransitionIssueRequest) {
    this.requests.push(request);
    return { outcome: "completed" as const, transitionId: request.transitionId, eventId: request.eventId,
      issueId: request.issueId, action: request.action, issueStatus: "assigned",
      assignedActorId: request.actorId, transitionedAt: request.now.toISOString() };
  }
}

const base = {
  organizationKey: "dev-accounting-firm",
  issueId: "00000000-0000-4000-e000-000000000001",
  actorId: "00000000-0000-4000-8300-000000000301",
  action: "assign_to_me" as const,
  note: "I verified the synthetic issue and will own the next step.",
  idempotencyKey: "00000000-0000-4000-9000-000000000001",
  correlationId: "00000000-0000-4000-9000-000000000002",
  now: new Date("2026-08-07T04:00:00.000Z"),
};

describe("TransitionIssue", () => {
  it("normalizes an operator note and creates immutable audit identifiers", async () => {
    const repository = new StubRepository();
    await new TransitionIssue(repository).execute({ ...base, note: `  ${base.note}  ` });
    expect(repository.requests[0]).toMatchObject({ note: base.note, action: "assign_to_me" });
    expect(repository.requests[0]?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.requests[0]?.transitionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects malformed identifiers, short notes and unknown actions before persistence", async () => {
    const repository = new StubRepository();
    const useCase = new TransitionIssue(repository);
    await expect(useCase.execute({ ...base, issueId: "bad" })).rejects.toMatchObject({ code: "invalid_identifier" });
    await expect(useCase.execute({ ...base, note: "too short" })).rejects.toMatchObject({ code: "invalid_note" });
    await expect(useCase.execute({ ...base, action: "delete" as never })).rejects.toMatchObject({ code: "invalid_action" });
    expect(repository.requests).toHaveLength(0);
  });
});
