import type { Environment } from "../domain/submission.js";
import {
  loadClassificationRuntimeConfig,
  type ClassificationRuntimeConfig,
} from "./classification-config.js";

export interface ClassificationWorkerBaseConfig extends ClassificationRuntimeConfig {
  environment: Environment;
  organizationKey: string;
  databaseUrl: string;
  databaseSslCaPath?: string;
  workerId: string;
}

export type ClassificationWorkerBaseRuntimeConfig = ClassificationWorkerBaseConfig & (
  | { documentSource: "local"; documentRoot: string }
  | { documentSource: "supabase"; supabaseUrl: string; supabaseStorageToken: string; supabaseStorageBucket: string }
);

export type ClassificationWorkerRuntimeConfig = ClassificationWorkerBaseRuntimeConfig & { documentId: string };

export function loadClassificationWorkerRuntimeConfig(
  env: NodeJS.ProcessEnv,
  promptPath: string,
): ClassificationWorkerRuntimeConfig {
  const base = loadClassificationWorkerBaseRuntimeConfig(env, promptPath);
  const documentId = required(env.DOP_DOCUMENT_ID, "DOP_DOCUMENT_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(documentId)) {
    throw new Error("DOP_DOCUMENT_ID must be a UUID");
  }
  return { ...base, documentId };
}

export function loadClassificationWorkerBaseRuntimeConfig(
  env: NodeJS.ProcessEnv,
  promptPath: string,
): ClassificationWorkerBaseRuntimeConfig {
  const rawEnvironment = env.DOP_ENVIRONMENT;
  if (rawEnvironment !== "DEV" && rawEnvironment !== "UAT" && rawEnvironment !== "PROD") {
    throw new Error("DOP_ENVIRONMENT must be DEV, UAT, or PROD");
  }
  const environment: Environment = rawEnvironment;
  const workerId = required(env.DOP_WORKER_ID, "DOP_WORKER_ID");
  if (workerId.length > 128) throw new Error("DOP_WORKER_ID must not exceed 128 characters");
  const base = {
    environment,
    organizationKey: required(env.DOP_ORGANIZATION_KEY, "DOP_ORGANIZATION_KEY"),
    databaseUrl: required(env.DATABASE_URL, "DATABASE_URL"),
    ...(env.DATABASE_SSL_CA_PATH ? { databaseSslCaPath: env.DATABASE_SSL_CA_PATH } : {}),
    workerId,
    ...loadClassificationRuntimeConfig(env, promptPath),
  };
  const documentSource = env.DOP_DOCUMENT_SOURCE ?? "local";
  if (documentSource === "local") {
    const documentRoot = required(env.DOP_DOCUMENT_ROOT, "DOP_DOCUMENT_ROOT");
    if (!documentRoot.startsWith("/")) throw new Error("DOP_DOCUMENT_ROOT must be an absolute path");
    return { ...base, documentSource, documentRoot };
  }
  if (documentSource === "supabase") {
    return {
      ...base,
      documentSource,
      supabaseUrl: required(env.SUPABASE_URL, "SUPABASE_URL"),
      supabaseStorageToken: required(env.SUPABASE_STORAGE_TOKEN, "SUPABASE_STORAGE_TOKEN"),
      supabaseStorageBucket: required(env.SUPABASE_STORAGE_BUCKET, "SUPABASE_STORAGE_BUCKET"),
    };
  }
  throw new Error("DOP_DOCUMENT_SOURCE must be local or supabase");
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
