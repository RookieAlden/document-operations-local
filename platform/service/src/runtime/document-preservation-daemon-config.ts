import type { Environment } from "../domain/submission.js";

export interface DocumentPreservationDaemonConfig {
  environment: Environment;
  organizationKey: string;
  databaseUrl: string;
  databaseSslCaPath?: string;
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  errorBackoffMs: number;
  healthHost: string;
  healthPort: number;
  readinessMaximumAgeMs: number;
  supabaseUrl: string;
  supabaseStorageToken: string;
  supabaseStorageBucket: string;
  allowedSourceHosts: string[];
  maximumDocumentBytes: number;
  internalPreviewToken: string;
  retentionWorkerEnabled: boolean;
  retentionPollIntervalMs: number;
  retentionLeaseSeconds: number;
}

export function loadDocumentPreservationDaemonConfig(env: NodeJS.ProcessEnv): DocumentPreservationDaemonConfig {
  const environment = required(env.DOP_ENVIRONMENT, "DOP_ENVIRONMENT");
  if (environment !== "DEV" && environment !== "UAT" && environment !== "PROD") {
    throw new Error("DOP_ENVIRONMENT must be DEV, UAT, or PROD");
  }
  const allowedSourceHosts = required(env.DOP_SOURCE_DOWNLOAD_ALLOWED_HOSTS, "DOP_SOURCE_DOWNLOAD_ALLOWED_HOSTS")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (allowedSourceHosts.length === 0) throw new Error("DOP_SOURCE_DOWNLOAD_ALLOWED_HOSTS must not be empty");
  return {
    environment,
    organizationKey: required(env.DOP_ORGANIZATION_KEY, "DOP_ORGANIZATION_KEY"),
    databaseUrl: required(env.DATABASE_URL, "DATABASE_URL"),
    ...(env.DATABASE_SSL_CA_PATH ? { databaseSslCaPath: env.DATABASE_SSL_CA_PATH } : {}),
    workerId: required(env.DOP_WORKER_ID, "DOP_WORKER_ID"),
    concurrency: integer(env.DOP_WORKER_CONCURRENCY ?? "2", "DOP_WORKER_CONCURRENCY", 1, 32),
    pollIntervalMs: integer(env.DOP_WORKER_POLL_MS ?? "1000", "DOP_WORKER_POLL_MS", 100, 60_000),
    errorBackoffMs: integer(env.DOP_WORKER_ERROR_BACKOFF_MS ?? "5000", "DOP_WORKER_ERROR_BACKOFF_MS", 100, 300_000),
    healthHost: env.DOP_WORKER_HEALTH_HOST ?? "127.0.0.1",
    healthPort: integer(env.PORT ?? env.DOP_WORKER_HEALTH_PORT ?? "3002", "PORT", 1, 65_535),
    readinessMaximumAgeMs: integer(env.DOP_WORKER_READINESS_MAX_AGE_MS ?? "30000", "DOP_WORKER_READINESS_MAX_AGE_MS", 1_000, 600_000),
    supabaseUrl: required(env.SUPABASE_URL, "SUPABASE_URL"),
    supabaseStorageToken: required(env.SUPABASE_STORAGE_TOKEN, "SUPABASE_STORAGE_TOKEN"),
    supabaseStorageBucket: required(env.SUPABASE_STORAGE_BUCKET, "SUPABASE_STORAGE_BUCKET"),
    allowedSourceHosts,
    maximumDocumentBytes: integer(env.DOP_MAX_DOCUMENT_BYTES ?? String(20 * 1024 * 1024), "DOP_MAX_DOCUMENT_BYTES", 1, 100 * 1024 * 1024),
    internalPreviewToken: minimumSecret(env.DOP_INTERNAL_PREVIEW_TOKEN, "DOP_INTERNAL_PREVIEW_TOKEN"),
    retentionWorkerEnabled: boolean(env.DOP_RETENTION_WORKER_ENABLED ?? "false", "DOP_RETENTION_WORKER_ENABLED"),
    retentionPollIntervalMs: integer(env.DOP_RETENTION_POLL_MS ?? "300000", "DOP_RETENTION_POLL_MS", 60_000, 3_600_000),
    retentionLeaseSeconds: integer(env.DOP_RETENTION_LEASE_SECONDS ?? "120", "DOP_RETENTION_LEASE_SECONDS", 15, 900),
  };
}

function minimumSecret(value: string | undefined, name: string): string {
  const secret = required(value, name);
  if (secret.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return secret;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function boolean(value:string,name:string):boolean {
  if (value==="true") return true;
  if (value==="false") return false;
  throw new Error(`${name} must be true or false`);
}
