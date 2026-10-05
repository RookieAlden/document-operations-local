export type ReminderDecisionAction = "approve" | "reject";

export interface ReminderDecisionResult {
  outcome: "completed" | "duplicate" | "conflict" | "not_found";
  decisionId?: string;
  reminderInstanceId?: string;
  status?: "approved" | "rejected";
  reason?: string;
  deliveryMode?: "disabled";
  externalCallCount?: 0;
}

export interface OpsReminderRepository {
  decide(organizationKey: string, request: {
    actorId: string;
    reminderInstanceId: string;
    action: ReminderDecisionAction;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<ReminderDecisionResult>;
}
