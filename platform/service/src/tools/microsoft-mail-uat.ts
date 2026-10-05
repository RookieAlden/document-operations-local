import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  CertificateClientCredentialsTokenProvider,
  MicrosoftGraphDeliveryProvider,
} from "../providers/microsoft-graph-delivery-provider.js";

const CONTROLLED_SUBJECT = "[SYNTHETIC UAT] M42 controlled Microsoft delivery test";
const CONTROLLED_BODY = [
  "Synthetic UAT content only. No real customer data.",
  "Purpose: verify the Document Operations Platform Microsoft Graph delivery boundary,",
  "scoped shared-mailbox authorization, Sent Items recording, and manual receipt confirmation.",
].join(" ");

export interface MicrosoftMailUatConfig {
  tenantId: string;
  clientId: string;
  certificatePem: string;
  privateKeyPem: string;
  senderMailbox: string;
  recipientMailbox: string;
  graphEnabled: boolean;
  sendApproved: boolean;
  dataBoundary: "synthetic_only";
  timeoutMs: number;
}

export function loadMicrosoftMailUatConfig(env: NodeJS.ProcessEnv): MicrosoftMailUatConfig {
  const senderMailbox = mailbox(required(env.DOP_MICROSOFT_SENDER_MAILBOX, "DOP_MICROSOFT_SENDER_MAILBOX"));
  const recipientMailbox = mailbox(required(env.DOP_MICROSOFT_TEST_RECIPIENT, "DOP_MICROSOFT_TEST_RECIPIENT"));
  if (senderMailbox !== recipientMailbox) {
    throw new Error("M42 controlled test recipient must equal the dedicated UAT shared mailbox");
  }
  const dataBoundary = required(env.DOP_DATA_BOUNDARY, "DOP_DATA_BOUNDARY");
  if (dataBoundary !== "synthetic_only") throw new Error("DOP_DATA_BOUNDARY must be synthetic_only");
  return {
    tenantId: required(env.DOP_MICROSOFT_TENANT_ID, "DOP_MICROSOFT_TENANT_ID"),
    clientId: required(env.DOP_MICROSOFT_CLIENT_ID, "DOP_MICROSOFT_CLIENT_ID"),
    certificatePem: decodeBase64(env.DOP_MICROSOFT_CERTIFICATE_BASE64, "DOP_MICROSOFT_CERTIFICATE_BASE64"),
    privateKeyPem: decodeBase64(env.DOP_MICROSOFT_PRIVATE_KEY_BASE64, "DOP_MICROSOFT_PRIVATE_KEY_BASE64"),
    senderMailbox,
    recipientMailbox,
    graphEnabled: strictBoolean(env.DOP_MICROSOFT_GRAPH_ENABLED, "DOP_MICROSOFT_GRAPH_ENABLED"),
    sendApproved: strictBoolean(env.DOP_MICROSOFT_TEST_SEND_APPROVED, "DOP_MICROSOFT_TEST_SEND_APPROVED"),
    dataBoundary,
    timeoutMs: integer(env.DOP_MICROSOFT_TIMEOUT_MS ?? "15000", "DOP_MICROSOFT_TIMEOUT_MS", 1_000, 120_000),
  };
}

export async function runMicrosoftMailUat(
  mode: "offline" | "token" | "send",
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const config = loadMicrosoftMailUatConfig(env);
  if (mode !== "offline" && !config.graphEnabled) {
    throw new Error("Microsoft Graph remains disabled by DOP_MICROSOFT_GRAPH_ENABLED");
  }
  const tokenProvider = new CertificateClientCredentialsTokenProvider({
    tenantId: config.tenantId,
    clientId: config.clientId,
    certificatePem: config.certificatePem,
    privateKeyPem: config.privateKeyPem,
    timeoutMs: config.timeoutMs,
  }, fetchImpl);

  if (mode === "offline") {
    return safeEvidence(config, { result: "offline_validation_passed", externalCalls: 0 });
  }

  if (mode === "token") {
    const controller = new AbortController();
    await tokenProvider.getAccessToken(controller.signal);
    return safeEvidence(config, { result: "token_acquired", externalCalls: 1, mailSent: false });
  }
  if (!config.sendApproved) throw new Error("Controlled send remains disabled by DOP_MICROSOFT_TEST_SEND_APPROVED");

  const clientRequestId = randomUUID();
  const provider = new MicrosoftGraphDeliveryProvider(tokenProvider, {
    senderMailbox: config.senderMailbox,
    allowedRecipients: [config.recipientMailbox],
    timeoutMs: config.timeoutMs,
  }, fetchImpl);
  const result = await provider.deliver({
    deliveryJobId: randomUUID(),
    attemptNumber: 1,
    clientRequestId,
    recipientAddress: config.recipientMailbox,
    subjectLine: CONTROLLED_SUBJECT,
    bodyText: CONTROLLED_BODY,
    scenario: "success",
  });
  return safeEvidence(config, {
    result: result.outcome,
    clientRequestId,
    providerResult: result,
    externalCalls: 1,
    mailSent: result.outcome === "accepted",
    automaticRetry: false,
  });
}

function safeEvidence(config: MicrosoftMailUatConfig, detail: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: "m42_controlled_microsoft_uat",
    dataBoundary: config.dataBoundary,
    senderMailbox: config.senderMailbox,
    recipientMailbox: config.recipientMailbox,
    graphEnabled: config.graphEnabled,
    sendApproved: config.sendApproved,
    certificateLoaded: true,
    privateKeyLoaded: true,
    ...detail,
  };
}

function decodeBase64(value: string | undefined, name: string): string {
  const encoded = required(value, name);
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) throw new Error(`${name} must be base64`);
  const decoded = Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN")) throw new Error(`${name} did not decode to PEM material`);
  return decoded;
}

function strictBoolean(value: string | undefined, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly true or false`);
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function mailbox(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) || normalized.includes("*")) {
    throw new Error("Invalid M42 controlled mailbox");
  }
  return normalized;
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const argument = process.argv[2] ?? "offline";
  if (argument !== "offline" && argument !== "token" && argument !== "send") {
    throw new Error("Usage: microsoft-mail-uat <offline|token|send>");
  }
  const result = await runMicrosoftMailUat(argument);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (argument === "send" && result.result !== "accepted") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      event: "microsoft_mail_uat_failed",
      errorCode: error instanceof Error ? error.message : "unknown_error",
    })}\n`);
    process.exitCode = 1;
  });
}
