import { createHash, randomUUID } from "node:crypto";
import type { IssueOperatorAction, OpsIssueRepository, TransitionIssueResult } from "../ports/ops-issue-repository.js";

export class TransitionIssue {
  constructor(private readonly repository: OpsIssueRepository) {}

  async execute(input: {
    organizationKey: string; issueId: string; actorId: string; action: IssueOperatorAction;
    note: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<TransitionIssueResult> {
    const note = input.note.trim();
    if (![input.issueId, input.actorId, input.idempotencyKey, input.correlationId].every(isUuid)) {
      throw new IssueTransitionInputError("invalid_identifier");
    }
    if (!input.organizationKey || input.organizationKey.length > 120) throw new IssueTransitionInputError("invalid_organization");
    if (!(["assign_to_me", "wait_internal", "wait_external", "resolve", "reopen", "close"] as string[]).includes(input.action)) {
      throw new IssueTransitionInputError("invalid_action");
    }
    if (note.length < 12 || note.length > 1000) throw new IssueTransitionInputError("invalid_note");
    const requestFingerprint = createHash("sha256").update(JSON.stringify({
      issueId: input.issueId, actorId: input.actorId, action: input.action, note,
    })).digest("hex");
    return await this.repository.transition({
      ...input, note, requestFingerprint, transitionId: randomUUID(), eventId: randomUUID(),
    });
  }
}

export class IssueTransitionInputError extends Error {
  constructor(readonly code: string) { super(code); }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
