import { describe, expect, it } from "vitest";
import { loadMicrosoftMailUatConfig, runMicrosoftMailUat } from "../src/tools/microsoft-mail-uat.js";

const certificate = `-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----`;
const privateKey = `-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----`;

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DOP_MICROSOFT_TENANT_ID: "c61deb4d-e646-443c-82bb-4ab14afb9892",
    DOP_MICROSOFT_CLIENT_ID: "2aaff94f-431d-4f1c-a3de-a1a331b17825",
    DOP_MICROSOFT_CERTIFICATE_BASE64: Buffer.from(certificate).toString("base64"),
    DOP_MICROSOFT_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString("base64"),
    DOP_MICROSOFT_SENDER_MAILBOX: "document-ops-uat@aijiaofu.onmicrosoft.com",
    DOP_MICROSOFT_TEST_RECIPIENT: "document-ops-uat@aijiaofu.onmicrosoft.com",
    DOP_MICROSOFT_GRAPH_ENABLED: "false",
    DOP_MICROSOFT_TEST_SEND_APPROVED: "false",
    DOP_DATA_BOUNDARY: "synthetic_only",
  };
}

describe("M42 controlled Microsoft UAT gate", () => {
  it("requires the recipient to be the same dedicated shared mailbox", () => {
    expect(() => loadMicrosoftMailUatConfig({
      ...baseEnv(), DOP_MICROSOFT_TEST_RECIPIENT: "outside@example.com",
    })).toThrow("must equal the dedicated UAT shared mailbox");
  });

  it("requires explicit booleans and the synthetic-only data boundary", () => {
    expect(() => loadMicrosoftMailUatConfig({ ...baseEnv(), DOP_MICROSOFT_GRAPH_ENABLED: "1" }))
      .toThrow("must be exactly true or false");
    expect(() => loadMicrosoftMailUatConfig({ ...baseEnv(), DOP_DATA_BOUNDARY: "real" }))
      .toThrow("must be synthetic_only");
  });

  it("cannot acquire a token while the Graph kill switch is false", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ access_token: "a".repeat(100) }), { status: 200 });
    await expect(runMicrosoftMailUat("token", baseEnv(), fakeFetch as typeof fetch))
      .rejects.toThrow("Microsoft Graph remains disabled");
  });
});
