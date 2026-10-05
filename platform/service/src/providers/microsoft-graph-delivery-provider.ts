import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
} from "node:crypto";
import type {
  DeliveryProvider,
  DeliveryProviderRequest,
  DeliveryProviderResult,
} from "../ports/delivery-provider.js";

export interface AccessTokenProvider {
  getAccessToken(signal: AbortSignal): Promise<string>;
}

export interface MicrosoftGraphMailConfig {
  senderMailbox: string;
  allowedRecipients: readonly string[];
  timeoutMs: number;
}

export class MicrosoftGraphDeliveryProvider implements DeliveryProvider {
  readonly kind = "microsoft_graph" as const;
  private readonly senderMailbox: string;
  private readonly allowedRecipients: ReadonlySet<string>;

  constructor(
    private readonly tokenProvider: AccessTokenProvider,
    config: MicrosoftGraphMailConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.senderMailbox = normalizedMailbox(config.senderMailbox, "sender mailbox");
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 120_000) {
      throw new Error("Microsoft Graph timeout must be between 1000 and 120000ms");
    }
    this.timeoutMs = config.timeoutMs;
    const recipients = config.allowedRecipients.map((value) => normalizedMailbox(value, "allowed recipient"));
    if (recipients.length === 0 || new Set(recipients).size !== recipients.length) {
      throw new Error("Microsoft Graph recipient allowlist must be non-empty and unique");
    }
    this.allowedRecipients = new Set(recipients);
  }

  private readonly timeoutMs: number;

  async deliver(request: DeliveryProviderRequest): Promise<DeliveryProviderResult> {
    const recipient = normalizedMailbox(request.recipientAddress, "recipient");
    if (!this.allowedRecipients.has(recipient)) {
      return { outcome: "manual", errorCode: "microsoft_recipient_not_allowlisted" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let token: string;
    try {
      token = await this.tokenProvider.getAccessToken(controller.signal);
    } catch (error) {
      clearTimeout(timer);
      return tokenFailure(error);
    }

    try {
      const response = await this.fetchImpl(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.senderMailbox)}/sendMail`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "client-request-id": request.clientRequestId,
            "return-client-request-id": "true",
          },
          body: JSON.stringify({
            message: {
              subject: request.subjectLine,
              body: { contentType: "Text", content: request.bodyText },
              toRecipients: [{ emailAddress: { address: recipient } }],
              internetMessageHeaders: [
                { name: "x-dop-delivery-job", value: request.deliveryJobId },
                { name: "x-dop-client-request", value: request.clientRequestId },
                { name: "x-dop-data-boundary", value: "synthetic-uat-only" },
              ],
            },
            saveToSentItems: true,
          }),
        },
      );
      if (response.status === 202) {
        return {
          outcome: "accepted",
          providerMessageId: `graph-client-request:${request.clientRequestId}`,
        };
      }
      if (response.status === 429) {
        return {
          outcome: "recoverable",
          errorCode: "provider_429",
          retryAfterMs: retryAfterMilliseconds(response.headers.get("retry-after")),
        };
      }
      if (response.status >= 500) {
        return { outcome: "unknown", errorCode: "provider_5xx_unknown" };
      }
      return { outcome: "manual", errorCode: `microsoft_graph_http_${response.status}` };
    } catch (error) {
      return {
        outcome: "unknown",
        errorCode: controller.signal.aborted ? "provider_timeout" : "provider_network_unknown",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface CertificateTokenConfig {
  tenantId: string;
  clientId: string;
  certificatePem: string;
  privateKeyPem: string;
  timeoutMs: number;
}

export class CertificateClientCredentialsTokenProvider implements AccessTokenProvider {
  private readonly tokenEndpoint: string;
  private readonly clientId: string;
  private readonly privateKey: ReturnType<typeof createPrivateKey>;
  private readonly certificateThumbprint: string;
  private readonly timeoutMs: number;

  constructor(
    config: CertificateTokenConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!uuid(config.tenantId) || !uuid(config.clientId)) throw new Error("Microsoft tenant and client IDs must be UUIDs");
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 120_000) {
      throw new Error("Microsoft token timeout must be between 1000 and 120000ms");
    }
    const certificate = new X509Certificate(config.certificatePem);
    const privateKey = createPrivateKey(config.privateKeyPem);
    const certificatePublicKey = certificate.publicKey.export({ type: "spki", format: "der" });
    const privatePublicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    if (!certificatePublicKey.equals(privatePublicKey)) throw new Error("Microsoft certificate and private key do not match");
    if (certificate.validTo && new Date(certificate.validTo).getTime() <= this.now().getTime()) {
      throw new Error("Microsoft certificate has expired");
    }
    this.tokenEndpoint = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
    this.clientId = config.clientId;
    this.privateKey = privateKey;
    this.certificateThumbprint = createHash("sha1").update(certificate.raw).digest("base64url");
    this.timeoutMs = config.timeoutMs;
  }

  async getAccessToken(signal: AbortSignal): Promise<string> {
    const issuedAt = Math.floor(this.now().getTime() / 1_000);
    const header = encoded({ alg: "RS256", typ: "JWT", x5t: this.certificateThumbprint });
    const payload = encoded({
      aud: this.tokenEndpoint,
      iss: this.clientId,
      sub: this.clientId,
      jti: randomUUID(),
      nbf: issuedAt - 5,
      exp: issuedAt + 300,
    });
    const unsigned = `${header}.${payload}`;
    const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), this.privateKey).toString("base64url")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const relayAbort = () => controller.abort();
    signal.addEventListener("abort", relayAbort, { once: true });
    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenEndpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        }),
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relayAbort);
    }
    if (!response.ok) throw Object.assign(new Error("microsoft_token_request_failed"), { status: response.status });
    const body = await response.json() as { access_token?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length < 20) {
      throw new Error("microsoft_token_response_invalid");
    }
    return body.access_token;
  }
}

function tokenFailure(error: unknown): DeliveryProviderResult {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status) : null;
  if (status === 429 || (status !== null && status >= 500)) {
    return { outcome: "recoverable", errorCode: status === 429 ? "provider_429" : "provider_5xx", retryAfterMs: 30_000 };
  }
  return { outcome: "manual", errorCode: "microsoft_token_unavailable" };
}

function retryAfterMilliseconds(value: string | null): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, 300_000) : 30_000;
}

function normalizedMailbox(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) || normalized.includes("*")) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
