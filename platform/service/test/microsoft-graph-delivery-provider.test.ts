import { describe, expect, it, vi } from "vitest";
import type { AccessTokenProvider } from "../src/providers/microsoft-graph-delivery-provider.js";
import { MicrosoftGraphDeliveryProvider } from "../src/providers/microsoft-graph-delivery-provider.js";
import type { DeliveryProviderRequest } from "../src/ports/delivery-provider.js";

const request: DeliveryProviderRequest = {
  deliveryJobId: "00000000-0000-4000-8000-000000000042",
  attemptNumber: 1,
  clientRequestId: "11111111-1111-4111-8111-111111111111",
  recipientAddress: "document-ops-uat@aijiaofu.onmicrosoft.com",
  subjectLine: "[SYNTHETIC UAT] M42 controlled delivery test",
  bodyText: "Synthetic UAT content only. No real customer data.",
  scenario: "success",
};

function token(): AccessTokenProvider {
  return { getAccessToken: vi.fn(async () => "a".repeat(100)) };
}

function provider(fetchImpl: typeof fetch) {
  return new MicrosoftGraphDeliveryProvider(token(), {
    senderMailbox: "document-ops-uat@aijiaofu.onmicrosoft.com",
    allowedRecipients: ["document-ops-uat@aijiaofu.onmicrosoft.com"],
    timeoutMs: 5_000,
  }, fetchImpl);
}

describe("MicrosoftGraphDeliveryProvider", () => {
  it("accepts only a 202 response and saves to Sent Items with audit headers", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { saveToSentItems: boolean; message: { internetMessageHeaders: { name: string; value: string }[] } };
      expect(body.saveToSentItems).toBe(true);
      expect(body.message.internetMessageHeaders).toContainEqual({ name: "x-dop-data-boundary", value: "synthetic-uat-only" });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    await expect(provider(fetchImpl).deliver(request)).resolves.toEqual({
      outcome: "accepted",
      providerMessageId: `graph-client-request:${request.clientRequestId}`,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/users/document-ops-uat%40aijiaofu.onmicrosoft.com/sendMail",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails closed before token acquisition for recipients outside the exact allowlist", async () => {
    const tokenProvider = token();
    const graph = new MicrosoftGraphDeliveryProvider(tokenProvider, {
      senderMailbox: "document-ops-uat@aijiaofu.onmicrosoft.com",
      allowedRecipients: ["document-ops-uat@aijiaofu.onmicrosoft.com"],
      timeoutMs: 5_000,
    }, vi.fn() as unknown as typeof fetch);
    await expect(graph.deliver({ ...request, recipientAddress: "outside@example.com" })).resolves.toEqual({
      outcome: "manual", errorCode: "microsoft_recipient_not_allowlisted",
    });
    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
  });

  it("retries an explicit 429 but treats 5xx as outcome unknown", async () => {
    const rateLimited = vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": "12" } })) as unknown as typeof fetch;
    await expect(provider(rateLimited).deliver(request)).resolves.toEqual({
      outcome: "recoverable", errorCode: "provider_429", retryAfterMs: 12_000,
    });
    const serverError = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    await expect(provider(serverError).deliver(request)).resolves.toEqual({
      outcome: "unknown", errorCode: "provider_5xx_unknown",
    });
  });

  it("treats timeout/network ambiguity as unknown and 4xx as manual", async () => {
    const timeout = vi.fn(async () => { throw new Error("socket reset"); }) as unknown as typeof fetch;
    await expect(provider(timeout).deliver(request)).resolves.toEqual({
      outcome: "unknown", errorCode: "provider_network_unknown",
    });
    const forbidden = vi.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    await expect(provider(forbidden).deliver(request)).resolves.toEqual({
      outcome: "manual", errorCode: "microsoft_graph_http_403",
    });
  });
});
