import type { SyntheticDeliveryScenario } from "./delivery-provider.js";

export interface ClaimedDelivery {
  outcome: "claimed";
  expiredUnknownCount: number;
  deliveryJobId: string;
  attemptId: string;
  attemptNumber: number;
  leaseToken: string;
  clientRequestId: string;
  recipientAddress: string;
  subjectLine: string;
  bodyText: string;
  scenario: SyntheticDeliveryScenario;
}

export type DeliveryClaimResult = ClaimedDelivery | {
  outcome: "empty" | "disabled";
  expiredUnknownCount: number;
};

export interface DeliveryAutomationRepository {
  checkReady(organizationKey: string): Promise<boolean>;
  claim(request: {
    organizationKey: string; workerId: string; leaseSeconds: number; now: Date;
  }): Promise<DeliveryClaimResult>;
  complete(request: {
    organizationKey: string; workerId: string; attemptId: string; leaseToken: string;
    outcome: "accepted" | "failed_recoverable" | "failed_manual" | "outcome_unknown";
    providerMessageId?: string; errorCode?: string; retryNotBefore?: Date; now: Date;
  }): Promise<{ outcome: "completed" | "duplicate" | "conflict"; reason?: string }>;
  recordReceipt(request: {
    organizationKey: string; workerId: string; attemptId: string; providerMessageId: string;
    receiptKey: string; receiptType: "delivered" | "bounced"; payloadHash: string;
    occurredAt: Date; receivedAt: Date;
  }): Promise<{ outcome: "completed" | "duplicate" | "conflict"; reason?: string }>;
}
