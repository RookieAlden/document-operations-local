import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/runtime/config.js";

const base = {
  DOP_ENVIRONMENT: "DEV",
  DATABASE_URL: "postgresql://localhost/dev",
  DOP_ORGANIZATION_KEY: "dev-accounting-firm",
  DOP_INTAKE_TOKEN: "intake-token-with-more-than-thirty-two-characters",
};

const connector = {
  DOP_FORM_CONNECTOR_ID: "fillout-dev-v1",
  DOP_FORM_CONNECTOR_PROVIDER_FORM_ID: "m7-synthetic-form",
  DOP_FORM_CONNECTOR_TOKEN: "connector-token-with-more-than-thirty-two-characters",
  DOP_FORM_CONNECTOR_WORKFLOW_TEMPLATE_KEY: "accounting.monthly.document_collection",
  DOP_FORM_CONNECTOR_SUBJECT_KEY: "dev-client-001",
  DOP_FORM_CONNECTOR_SUBJECT_DISPLAY_NAME: "Kauri Coast Cafe Limited",
  DOP_FORM_CONNECTOR_TIMEZONE: "Pacific/Auckland",
};

describe("runtime config", () => {
  it("keeps the form connector disabled when no connector secret is configured", () => {
    expect(loadRuntimeConfig(base).formConnector).toBeUndefined();
  });

  it("loads Supabase Ops identity only as a complete fail-closed group", () => {
    const config = loadRuntimeConfig({
      ...base,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example-key",
      DOP_OPS_SESSION_SECRET: "session-secret-with-more-than-thirty-two-characters",
    });
    expect(config.opsIdentity).toMatchObject({
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_example-key",
    });
    expect(() => loadRuntimeConfig({ ...base, SUPABASE_URL: "https://example.supabase.co" }))
      .toThrow("required together");
    expect(() => loadRuntimeConfig({
      ...base,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example-key",
      DOP_OPS_SESSION_SECRET: "too-short",
    })).toThrow("DOP_OPS_SESSION_SECRET must contain at least 32 characters");
  });

  it("keeps the employee workbench fail-closed unless its full UAT boundary is explicit", () => {
    expect(loadRuntimeConfig(base).workbenchEnabled).toBe(false);
    expect(() => loadRuntimeConfig({ ...base, DOP_WORKBENCH_ENABLED: "true" }))
      .toThrow("employee workbench requires Ops identity and DOP_CLIENT_PORTAL_ORIGIN");
    expect(() => loadRuntimeConfig({ ...base, DOP_WORKBENCH_ENABLED: "yes" }))
      .toThrow("DOP_WORKBENCH_ENABLED must be true or false");
    const loaded = loadRuntimeConfig({
      ...base,
      DOP_ENVIRONMENT: "UAT",
      DOP_WORKBENCH_ENABLED: "true",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example-key",
      DOP_OPS_SESSION_SECRET: "session-secret-with-more-than-thirty-two-characters",
      DOP_CLIENT_PORTAL_ORIGIN: "https://dop-intake-uat.example.invalid",
    });
    expect(loaded.workbenchEnabled).toBe(true);
  });

  it("loads an all-or-nothing fixed-scope form connector", () => {
    const config = loadRuntimeConfig({
      ...base,
      ...connector,
    });
    expect(config.formConnector).toMatchObject({
      connectorId: "fillout-dev-v1",
      subjectKey: "dev-client-001",
    });
  });

  it("fails closed for partial or weak connector configuration", () => {
    expect(() => loadRuntimeConfig({
      ...base,
      DOP_FORM_CONNECTOR_ID: "fillout-dev-v1",
    })).toThrow("all DOP_FORM_CONNECTOR_* variables are required");

    expect(() => loadRuntimeConfig({
      ...base,
      DOP_FORM_CONNECTOR_ID: "fillout-dev-v1",
      DOP_FORM_CONNECTOR_PROVIDER_FORM_ID: "m7-synthetic-form",
      DOP_FORM_CONNECTOR_TOKEN: "too-short",
      DOP_FORM_CONNECTOR_WORKFLOW_TEMPLATE_KEY: "accounting.monthly.document_collection",
      DOP_FORM_CONNECTOR_SUBJECT_KEY: "dev-client-001",
      DOP_FORM_CONNECTOR_SUBJECT_DISPLAY_NAME: "Kauri Coast Cafe Limited",
      DOP_FORM_CONNECTOR_TIMEZONE: "Pacific/Auckland",
    })).toThrow("DOP_FORM_CONNECTOR_TOKEN must contain at least 32 characters");
  });

  it("requires an explicit production admission policy for a PROD form connector", () => {
    expect(() => loadRuntimeConfig({ ...base, ...connector, DOP_ENVIRONMENT: "PROD" }))
      .toThrow("PROD form connector requires DOP_PRODUCTION_ADMISSION_POLICY_KEY");
    const config = loadRuntimeConfig({
      ...base,
      ...connector,
      DOP_ENVIRONMENT: "PROD",
      DOP_PRODUCTION_ADMISSION_POLICY_KEY: "prod.blue-peak.2026-q3",
    });
    expect(config.formConnector).toMatchObject({
      productionAdmissionPolicyKey: "prod.blue-peak.2026-q3",
    });
  });

  it("only enables governed demo form intake with a complete UAT connector", () => {
    expect(() => loadRuntimeConfig({
      ...base,
      ...connector,
      DOP_FORM_CONNECTOR_DEMO_GOVERNANCE: "true",
    })).toThrow("governed demo form connector requires a complete UAT form connector configuration");
    const loaded = loadRuntimeConfig({
      ...base,
      ...connector,
      DOP_ENVIRONMENT: "UAT",
      DOP_FORM_CONNECTOR_DEMO_GOVERNANCE: "true",
      DOP_FORM_CONNECTOR_SOURCE_ALLOWED_HOSTS: "prod-fillout-oregon-s3.s3.us-west-2.amazonaws.com",
      DOP_CLIENT_PORTAL_ORIGIN: "https://dop-intake-uat.example.invalid",
    });
    expect(loaded.formConnector?.demoGovernanceRequired).toBe(true);
    expect(loaded.clientPortalOrigin).toBe("https://dop-intake-uat.example.invalid");
  });

  it("accepts the canonical dotted connector key used by governed UAT forms", () => {
    const loaded = loadRuntimeConfig({
      ...base,
      ...connector,
      DOP_ENVIRONMENT: "UAT",
      DOP_FORM_CONNECTOR_ID: "m45-1.synthetic-fillout-uat",
      DOP_FORM_CONNECTOR_DEMO_GOVERNANCE: "true",
      DOP_FORM_CONNECTOR_SOURCE_ALLOWED_HOSTS: "prod-fillout-oregon-s3.s3.us-west-2.amazonaws.com",
      DOP_CLIENT_PORTAL_ORIGIN: "https://dop-intake-uat.example.invalid",
    });
    expect(loaded.formConnector?.connectorId).toBe("m45-1.synthetic-fillout-uat");
    expect(() => loadRuntimeConfig({
      ...base,
      ...connector,
      DOP_FORM_CONNECTOR_ID: "M45/unsafe",
    })).toThrow("lowercase connector key");
  });

  it("requires exact source metadata hosts for governed native file uploads", () => {
    expect(() => loadRuntimeConfig({
      ...base,
      ...connector,
      DOP_ENVIRONMENT: "UAT",
      DOP_FORM_CONNECTOR_DEMO_GOVERNANCE: "true",
    })).toThrow("requires DOP_FORM_CONNECTOR_SOURCE_ALLOWED_HOSTS");
    expect(() => loadRuntimeConfig({
      ...base,
      ...connector,
      DOP_ENVIRONMENT: "UAT",
      DOP_FORM_CONNECTOR_DEMO_GOVERNANCE: "true",
      DOP_FORM_CONNECTOR_SOURCE_ALLOWED_HOSTS: "*.amazonaws.com",
    })).toThrow("exact hostnames only");
  });

  it("requires a path-free HTTPS client portal origin for governed UAT", () => {
    expect(() => loadRuntimeConfig({
      ...base,...connector,DOP_ENVIRONMENT:"UAT",DOP_FORM_CONNECTOR_DEMO_GOVERNANCE:"true",
      DOP_FORM_CONNECTOR_SOURCE_ALLOWED_HOSTS:"prod-fillout-oregon-s3.s3.us-west-2.amazonaws.com",
    })).toThrow("requires DOP_CLIENT_PORTAL_ORIGIN");
    expect(() => loadRuntimeConfig({
      ...base,...connector,DOP_ENVIRONMENT:"UAT",DOP_FORM_CONNECTOR_DEMO_GOVERNANCE:"true",
      DOP_FORM_CONNECTOR_SOURCE_ALLOWED_HOSTS:"prod-fillout-oregon-s3.s3.us-west-2.amazonaws.com",
      DOP_CLIENT_PORTAL_ORIGIN:"https://dop-intake-uat.example.invalid/submit",
    })).toThrow("without a path");
  });
});
