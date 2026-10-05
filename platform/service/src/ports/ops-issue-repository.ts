export type IssueOperatorAction = "assign_to_me" | "wait_internal" | "wait_external" | "resolve" | "reopen" | "close";

export interface TransitionIssueRequest {
  organizationKey: string;
  issueId: string;
  actorId: string;
  action: IssueOperatorAction;
  note: string;
  idempotencyKey: string;
  requestFingerprint: string;
  transitionId: string;
  eventId: string;
  correlationId: string;
  now: Date;
}

export type TransitionIssueResult = {
  outcome: "completed" | "duplicate";
  transitionId: string;
  eventId: string;
  issueId: string;
  action: IssueOperatorAction;
  issueStatus: string;
  assignedActorId: string | null;
  transitionedAt: string;
} | { outcome: "not_found"; resource: "organization" | "operator" | "issue" } |
  { outcome: "conflict"; reason: "idempotency_key_reused" | "transition_not_allowed" | "manager_required" };

export interface OpsIssueRepository {
  transition(request: TransitionIssueRequest): Promise<TransitionIssueResult>;
}
