import { createHash } from "node:crypto";
import type {
  DeliveryProvider,
  DeliveryProviderRequest,
  DeliveryProviderResult,
} from "../ports/delivery-provider.js";

export class SyntheticDeliveryProvider implements DeliveryProvider {
  readonly kind = "synthetic" as const;

  async deliver(request: DeliveryProviderRequest): Promise<DeliveryProviderResult> {
    if (!request.recipientAddress.endsWith(".invalid")) {
      throw Object.assign(new Error("Synthetic provider rejected unsafe recipient"), {
        code: "unsafe_recipient",
      });
    }
    if (request.scenario === "rate_limited_once" && request.attemptNumber === 1) {
      return { outcome: "recoverable", errorCode: "provider_429", retryAfterMs: 1_000 };
    }
    if (request.scenario === "server_error_once" && request.attemptNumber === 1) {
      return { outcome: "recoverable", errorCode: "provider_5xx", retryAfterMs: 1_000 };
    }
    if (request.scenario === "timeout_unknown") {
      return { outcome: "unknown", errorCode: "provider_timeout" };
    }
    if (request.scenario === "crash_after_claim") return { outcome: "crash_simulated" };

    const providerMessageId = `synthetic:${createHash("sha256")
      .update(`${request.deliveryJobId}|${request.clientRequestId}`)
      .digest("hex")}`;
    if (request.scenario === "bounced") {
      return { outcome: "accepted", providerMessageId, receipt: "bounced" };
    }
    return {
      outcome: "accepted",
      providerMessageId,
      receipt: "delivered",
      ...(request.scenario === "receipt_replay" ? { replayReceipt: true } : {}),
    };
  }
}
