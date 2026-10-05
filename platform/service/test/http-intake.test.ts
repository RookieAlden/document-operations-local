import { readFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ReceiveSubmission } from "../src/application/receive-submission.js";
import { ContractValidator } from "../src/contracts/json-schema-validator.js";
import { createIntakeServer } from "../src/http/intake-server.js";
import { FormConnector } from "../src/connectors/forms/form-connector.js";
import { FormConnectorRouter } from "../src/http/form-connector-router.js";
import { InMemorySubmissionIntakeRepository } from "./support/in-memory-repositories.js";
import type { DemoFormAuthorizationRepository } from "../src/ports/demo-form-authorization-repository.js";

const token = "dev-test-token-with-more-than-thirty-two-characters";
const connectorToken = "dev-form-connector-token-with-more-than-thirty-two-characters";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function validSubmission(): unknown {
  const url = new URL("../../tests/fixtures/accounting-submission-dev-client-001.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

async function start(options: {
  requestsPerMinute?: number;
  maxBodyBytes?: number;
  formConnector?: boolean;
  governedDemo?: boolean;
  resolveNativeMetadata?: boolean;
} = {}): Promise<Server> {
  const environment = options.governedDemo ? "UAT" : "DEV";
  const handler = new ReceiveSubmission(
    new ContractValidator(),
    new InMemorySubmissionIntakeRepository(),
    { environment, organizationKey: "dev-accounting-firm" },
  );
  const server = createIntakeServer({
    handler,
    intakeToken: token,
    environment,
    releaseCommit: "b".repeat(40),
    ...(options.requestsPerMinute === undefined ? {} : { requestsPerMinute: options.requestsPerMinute }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    now: () => new Date("2026-08-06T10:00:00Z"),
    ...(options.formConnector ? {
      connectorRouter: new FormConnectorRouter({
        connector: new FormConnector({
          connectorId: "fillout-dev-v1",
          providerFormId: "m7-synthetic-form",
          environment,
          organizationKey: "dev-accounting-firm",
          workflowTemplateKey: "accounting.monthly.document_collection",
          subjectKey: "dev-client-001",
          subjectDisplayName: "Kauri Coast Cafe Limited",
          timezone: "Pacific/Auckland",
          sourceType: "fillout",
          ...(options.governedDemo ? { demoGovernanceRequired: true } : {}),
        }),
        receiver: handler,
        token: connectorToken,
        organizationKey: "dev-accounting-firm",
        ...(options.governedDemo ? { authorizationRepository: governedAuthorizationRepository } : {}),
        ...(options.resolveNativeMetadata ? {
          fileMetadataResolver: {
            async resolve(files) {
              return files.map((file) => ({
                ...file,
                declared_size_bytes: file.declared_size_bytes ?? 3350,
                declared_mime_type: file.declared_mime_type ?? "application/pdf",
              }));
            },
          },
        } : {}),
        ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      }),
    } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server;
}

async function call(
  server: Server,
  options: { method?: string; path?: string; token?: string; body?: unknown; contentType?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }
  const rawBody = options.body === undefined ? "" : JSON.stringify(options.body);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: options.method ?? "POST",
      path: options.path ?? "/v1/submissions",
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(rawBody ? { "content-length": Buffer.byteLength(rawBody) } : {}),
        "content-type": options.contentType ?? "application/json",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    request.on("error", reject);
    request.end(rawBody);
  });
}

describe("HTTP intake boundary", () => {
  it("reports health without exposing secrets", async () => {
    const response = await call(await start(), { method: "GET", path: "/health" });
    expect(response).toMatchObject({ status: 200, body: { status: "ok", environment: "DEV" } });
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it("rejects missing authorization", async () => {
    const response = await call(await start(), { body: validSubmission() });
    expect(response).toMatchObject({ status: 401, body: { error: "unauthorized" } });
  });

  it("accepts a canonical submission and returns opaque identifiers", async () => {
    const response = await call(await start(), { token, body: validSubmission() });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ outcome: "accepted" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("returns the same operation as duplicate without creating another record", async () => {
    const server = await start();
    await call(server, { token, body: validSubmission() });
    const response = await call(server, { token, body: validSubmission() });
    expect(response).toMatchObject({ status: 200, body: { outcome: "duplicate" } });
  });

  it("rejects invalid payloads with 422", async () => {
    const response = await call(await start(), { token, body: { schema_version: "1.0", files: [] } });
    expect(response).toMatchObject({ status: 422, body: { outcome: "rejected" } });
  });

  it("requires JSON content type", async () => {
    const response = await call(await start(), {
      token,
      body: validSubmission(),
      contentType: "text/plain",
    });
    expect(response).toMatchObject({ status: 415, body: { error: "content_type_must_be_application_json" } });
  });

  it("rejects payloads above the configured byte limit", async () => {
    const response = await call(await start({ maxBodyBytes: 32 }), {
      token,
      body: validSubmission(),
    });
    expect(response).toMatchObject({ status: 413, body: { error: "payload_too_large" } });
  });

  it("rate limits authenticated requests", async () => {
    const server = await start({ requestsPerMinute: 1 });
    await call(server, { token, body: { invalid: true } });
    const response = await call(server, { token, body: { invalid: true } });
    expect(response).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(response.headers["retry-after"]).toBe("60");
  });

  it("accepts a fixed-scope form connector submission with its own credential", async () => {
    const server = await start({ formConnector: true });
    const body = formConnectorSubmission();
    const response = await call(server, {
      path: "/v1/connectors/forms/fillout-dev-v1/submissions",
      token: connectorToken,
      body,
    });
    expect(response).toMatchObject({ status: 202, body: { outcome: "accepted" } });

    const duplicate = await call(server, {
      path: "/v1/connectors/forms/fillout-dev-v1/submissions",
      token: connectorToken,
      body,
    });
    expect(duplicate).toMatchObject({ status: 200, body: { outcome: "duplicate" } });
  });

  it("keeps canonical and connector credentials separated", async () => {
    const server = await start({ formConnector: true });
    const connectorWithIntakeToken = await call(server, {
      path: "/v1/connectors/forms/fillout-dev-v1/submissions",
      token,
      body: formConnectorSubmission(),
    });
    expect(connectorWithIntakeToken).toMatchObject({ status: 401, body: { error: "unauthorized" } });

    const canonicalWithConnectorToken = await call(server, {
      token: connectorToken,
      body: validSubmission(),
    });
    expect(canonicalWithConnectorToken).toMatchObject({ status: 401, body: { error: "unauthorized" } });
  });

  it("authorizes a governed UAT demo invitation before mapping trusted Case scope", async () => {
    const server = await start({ formConnector: true, governedDemo: true });
    const body = {
      ...formConnectorSubmission(),
      demo_invitation_token: "synthetic-demo-invitation-token-with-43-chars",
    };
    const response = await call(server, {
      path: "/v1/connectors/forms/fillout-dev-v1/submissions",
      token: connectorToken,
      body,
    });
    expect(response).toMatchObject({ status: 202, body: { outcome: "accepted" } });
    const missing = await call(server, {
      path: "/v1/connectors/forms/fillout-dev-v1/submissions",
      token: connectorToken,
      body: formConnectorSubmission(),
    });
    expect(missing).toMatchObject({ status: 403, body: { error: "demo_invitation_required" } });
  });

  it("hydrates native Fillout file metadata before governed authorization", async () => {
    const server = await start({ formConnector: true, governedDemo: true, resolveNativeMetadata: true });
    const response = await call(server, {
      path: "/v1/connectors/forms/fillout-dev-v1/submissions",
      token: connectorToken,
      body: {
        formId: "m7-synthetic-form",
        formName: "Synthetic UAT intake",
        submission: {
          submissionId: "fillout-native-no-size-001",
          submissionTime: "2026-08-06T10:00:00Z",
          questions: [{
            id: "files-question",
            name: "Accounting documents (PDF, JPG or PNG)",
            type: "FileUpload",
            value: [{
              url: "https://prod-fillout-oregon-s3.s3.us-west-2.amazonaws.com/synthetic.pdf",
              filename: "synthetic.pdf",
            }],
          }],
          urlParameters: [{ id: "period", name: "period", value: "2026-07" }, {
            id: "invitation",
            name: "dop_invitation",
            value: "synthetic-demo-invitation-token-with-43-chars",
          }],
        },
      },
    });
    expect(response).toMatchObject({ status: 202, body: { outcome: "accepted" } });
  });

  it("rejects a different provider form and attempted tenant override", async () => {
    const server = await start({ formConnector: true });
    const wrongForm = await call(server, {
      path: "/v1/connectors/forms/fillout-dev-v1/submissions",
      token: connectorToken,
      body: { ...formConnectorSubmission(), provider_form_id: "legacy-form" },
    });
    expect(wrongForm).toMatchObject({ status: 422, body: { outcome: "rejected" } });

    const attemptedOverride = await call(server, {
      path: "/v1/connectors/forms/fillout-dev-v1/submissions",
      token: connectorToken,
      body: { ...formConnectorSubmission(), organization_key: "other-tenant" },
    });
    expect(attemptedOverride).toMatchObject({ status: 422, body: { outcome: "rejected" } });
  });
});

function formConnectorSubmission(): Record<string, unknown> {
  return {
    schema_version: "1.0",
    provider_form_id: "m7-synthetic-form",
    provider_submission_id: "fillout-dev-submission-001",
    received_at: "2026-08-06T10:00:00Z",
    period: "2026-07",
    files: [{
      source_file_id: "fillout-dev-file-001",
      original_filename: "synthetic-bank-statement.pdf",
      download_url: "https://example.invalid/synthetic-bank-statement.pdf",
      declared_mime_type: "application/pdf",
      declared_size_bytes: 3055,
    }],
  };
}

const governedAuthorizationRepository: DemoFormAuthorizationRepository = {
  async authorize(_organizationKey, request) {
    if (request.invitationTokenSha256.length !== 64) return { outcome: "rejected", reason: "invalid_request" };
    return {
      outcome: "authorized",
      authorizationId: "00000000-0000-4000-8000-000000000951",
      organizationKey: "dev-accounting-firm",
      workflowTemplateKey: "accounting.monthly.document_collection",
      subjectKey: "dev-client-001",
      subjectDisplayName: "Kauri Coast Cafe Limited",
      caseKey: "dev-accounting-firm|accounting.monthly.document_collection|dev-client-001|2026-07",
      period: "2026-07",
      timezone: "Pacific/Auckland",
    };
  },
};
