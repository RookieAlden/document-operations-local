import type { Environment } from "../domain/submission.js";

export interface RuntimeConfig {
  environment: Environment;
  organizationKey: string;
  databaseUrl: string;
  databaseSslCaPath?: string;
  intakeToken: string;
  opsIdentity?: {
    supabaseUrl: string;
    publishableKey: string;
    sessionSecret: string;
  };
  opsStaticDirectory?: string;
  clientPortalOrigin?: string;
  workbenchEnabled: boolean;
  opsSecureCookie: boolean;
  previewBrokerUrl?: string;
  internalPreviewToken?: string;
  formConnector?: {
    connectorId: string;
    providerFormId: string;
    token: string;
    workflowTemplateKey: string;
    subjectKey: string;
    subjectDisplayName: string;
    timezone: string;
    demoGovernanceRequired: boolean;
    sourceMetadataAllowedHosts?: string[];
    productionAdmissionPolicyKey?: string;
  };
  host: string;
  port: number;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const environment = env.DOP_ENVIRONMENT;
  if (environment !== "DEV" && environment !== "UAT" && environment !== "PROD") {
    throw new Error("DOP_ENVIRONMENT must be DEV, UAT, or PROD");
  }
  const databaseUrl = required(env.DATABASE_URL, "DATABASE_URL");
  const organizationKey = required(env.DOP_ORGANIZATION_KEY, "DOP_ORGANIZATION_KEY");
  const intakeToken = required(env.DOP_INTAKE_TOKEN, "DOP_INTAKE_TOKEN");
  if (intakeToken.length < 32) {
    throw new Error("DOP_INTAKE_TOKEN must contain at least 32 characters");
  }
  const opsValues = [env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, env.DOP_OPS_SESSION_SECRET];
  const hasOpsValue = opsValues.some((value) => value !== undefined);
  if (hasOpsValue && opsValues.some((value) => !value)) {
    throw new Error("SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and DOP_OPS_SESSION_SECRET are required together");
  }
  if (env.SUPABASE_URL && !/^https:\/\//.test(env.SUPABASE_URL)) {
    throw new Error("SUPABASE_URL must use HTTPS");
  }
  if (env.SUPABASE_PUBLISHABLE_KEY && !env.SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_")) {
    throw new Error("SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key");
  }
  if (env.DOP_OPS_SESSION_SECRET !== undefined && env.DOP_OPS_SESSION_SECRET.length < 32) {
    throw new Error("DOP_OPS_SESSION_SECRET must contain at least 32 characters");
  }
  if (env.DOP_CLIENT_PORTAL_ORIGIN !== undefined && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(env.DOP_CLIENT_PORTAL_ORIGIN)) {
    throw new Error("DOP_CLIENT_PORTAL_ORIGIN must be an HTTPS origin without a path");
  }
  if (env.DOP_WORKBENCH_ENABLED !== undefined && !["true", "false"].includes(env.DOP_WORKBENCH_ENABLED)) {
    throw new Error("DOP_WORKBENCH_ENABLED must be true or false");
  }
  if (env.DOP_WORKBENCH_ENABLED === "true" && (!hasOpsValue || !env.DOP_CLIENT_PORTAL_ORIGIN)) {
    throw new Error("employee workbench requires Ops identity and DOP_CLIENT_PORTAL_ORIGIN");
  }
  const previewBrokerUrl = env.DOP_PREVIEW_BROKER_URL;
  const internalPreviewToken = env.DOP_INTERNAL_PREVIEW_TOKEN;
  if ((previewBrokerUrl && !internalPreviewToken) || (!previewBrokerUrl && internalPreviewToken)) {
    throw new Error("DOP_PREVIEW_BROKER_URL and DOP_INTERNAL_PREVIEW_TOKEN must be set together");
  }
  if (internalPreviewToken && internalPreviewToken.length < 32) {
    throw new Error("DOP_INTERNAL_PREVIEW_TOKEN must contain at least 32 characters");
  }
  const connectorValues = [
    env.DOP_FORM_CONNECTOR_ID,
    env.DOP_FORM_CONNECTOR_PROVIDER_FORM_ID,
    env.DOP_FORM_CONNECTOR_TOKEN,
    env.DOP_FORM_CONNECTOR_WORKFLOW_TEMPLATE_KEY,
    env.DOP_FORM_CONNECTOR_SUBJECT_KEY,
    env.DOP_FORM_CONNECTOR_SUBJECT_DISPLAY_NAME,
    env.DOP_FORM_CONNECTOR_TIMEZONE,
  ];
  const hasConnectorValue = connectorValues.some((value) => value !== undefined);
  if (hasConnectorValue && connectorValues.some((value) => !value)) {
    throw new Error("all DOP_FORM_CONNECTOR_* variables are required when the form connector is enabled");
  }
  if (env.DOP_FORM_CONNECTOR_TOKEN !== undefined && env.DOP_FORM_CONNECTOR_TOKEN.length < 32) {
    throw new Error("DOP_FORM_CONNECTOR_TOKEN must contain at least 32 characters");
  }
  if (env.DOP_FORM_CONNECTOR_ID !== undefined && !/^[a-z0-9][a-z0-9._-]{1,118}[a-z0-9]$/.test(env.DOP_FORM_CONNECTOR_ID)) {
    throw new Error("DOP_FORM_CONNECTOR_ID must be a lowercase connector key between 3 and 120 characters");
  }
  if (hasConnectorValue && environment === "PROD"
      && !/^[a-z0-9][a-z0-9._-]{2,119}$/.test(env.DOP_PRODUCTION_ADMISSION_POLICY_KEY ?? "")) {
    throw new Error("PROD form connector requires DOP_PRODUCTION_ADMISSION_POLICY_KEY");
  }
  if (env.DOP_FORM_CONNECTOR_DEMO_GOVERNANCE !== undefined
      && !["true", "false"].includes(env.DOP_FORM_CONNECTOR_DEMO_GOVERNANCE)) {
    throw new Error("DOP_FORM_CONNECTOR_DEMO_GOVERNANCE must be true or false");
  }
  if (env.DOP_FORM_CONNECTOR_DEMO_GOVERNANCE === "true" && (!hasConnectorValue || environment !== "UAT")) {
    throw new Error("governed demo form connector requires a complete UAT form connector configuration");
  }
  const sourceMetadataAllowedHosts = parseHostList(env.DOP_FORM_CONNECTOR_SOURCE_ALLOWED_HOSTS);
  if (env.DOP_FORM_CONNECTOR_DEMO_GOVERNANCE === "true" && sourceMetadataAllowedHosts.length === 0) {
    throw new Error("governed demo form connector requires DOP_FORM_CONNECTOR_SOURCE_ALLOWED_HOSTS");
  }
  if (env.DOP_FORM_CONNECTOR_DEMO_GOVERNANCE === "true" && !env.DOP_CLIENT_PORTAL_ORIGIN) {
    throw new Error("governed demo form connector requires DOP_CLIENT_PORTAL_ORIGIN");
  }
  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }

  return {
    environment,
    organizationKey,
    databaseUrl,
    ...(env.DATABASE_SSL_CA_PATH ? { databaseSslCaPath: env.DATABASE_SSL_CA_PATH } : {}),
    intakeToken,
    ...(hasOpsValue ? { opsIdentity: {
      supabaseUrl: env.SUPABASE_URL!,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY!,
      sessionSecret: env.DOP_OPS_SESSION_SECRET!,
    } } : {}),
    ...(env.DOP_OPS_STATIC_DIR ? { opsStaticDirectory: env.DOP_OPS_STATIC_DIR } : {}),
    ...(env.DOP_CLIENT_PORTAL_ORIGIN ? { clientPortalOrigin: env.DOP_CLIENT_PORTAL_ORIGIN } : {}),
    workbenchEnabled: env.DOP_WORKBENCH_ENABLED === "true",
    opsSecureCookie: env.DOP_OPS_SECURE_COOKIE !== "false",
    ...(previewBrokerUrl ? { previewBrokerUrl } : {}),
    ...(internalPreviewToken ? { internalPreviewToken } : {}),
    ...(hasConnectorValue ? {
      formConnector: {
        connectorId: env.DOP_FORM_CONNECTOR_ID!,
        providerFormId: env.DOP_FORM_CONNECTOR_PROVIDER_FORM_ID!,
        token: env.DOP_FORM_CONNECTOR_TOKEN!,
        workflowTemplateKey: env.DOP_FORM_CONNECTOR_WORKFLOW_TEMPLATE_KEY!,
        subjectKey: env.DOP_FORM_CONNECTOR_SUBJECT_KEY!,
        subjectDisplayName: env.DOP_FORM_CONNECTOR_SUBJECT_DISPLAY_NAME!,
        timezone: env.DOP_FORM_CONNECTOR_TIMEZONE!,
        demoGovernanceRequired: env.DOP_FORM_CONNECTOR_DEMO_GOVERNANCE === "true",
        ...(sourceMetadataAllowedHosts.length > 0 ? { sourceMetadataAllowedHosts } : {}),
        ...(env.DOP_PRODUCTION_ADMISSION_POLICY_KEY ? {
          productionAdmissionPolicyKey: env.DOP_PRODUCTION_ADMISSION_POLICY_KEY,
        } : {}),
      },
    } : {}),
    host: env.HOST ?? "127.0.0.1",
    port,
  };
}

function parseHostList(value: string | undefined): string[] {
  if (!value) return [];
  const hosts = value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (hosts.some((host) => !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ||
      host.includes("..") || host.includes("*"))) {
    throw new Error("DOP_FORM_CONNECTOR_SOURCE_ALLOWED_HOSTS must contain exact hostnames only");
  }
  return [...new Set(hosts)];
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
