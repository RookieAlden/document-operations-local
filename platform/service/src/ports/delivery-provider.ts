export type SyntheticDeliveryScenario =
  | "success"
  | "rate_limited_once"
  | "server_error_once"
  | "timeout_unknown"
  | "crash_after_claim"
  | "bounced"
  | "receipt_replay";

export interface DeliveryProviderRequest {
  deliveryJobId: string;
  attemptNumber: number;
  clientRequestId: string;
  recipientAddress: string;
  subjectLine: string;
  bodyText: string;
  scenario: SyntheticDeliveryScenario;
}

export type DeliveryProviderResult =
  | { outcome: "accepted"; providerMessageId: string; receipt?: "delivered" | "bounced"; replayReceipt?: boolean }
  | { outcome: "recoverable"; errorCode: "provider_429" | "provider_5xx"; retryAfterMs: number }
  | { outcome: "manual"; errorCode: string }
  | { outcome: "unknown"; errorCode: "provider_timeout" | "provider_5xx_unknown" | "provider_network_unknown" }
  | { outcome: "crash_simulated" };

export interface DeliveryProvider {
  readonly kind: "synthetic" | "microsoft_graph";
  deliver(request: DeliveryProviderRequest): Promise<DeliveryProviderResult>;
}
