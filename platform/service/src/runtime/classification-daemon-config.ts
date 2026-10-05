import {
  loadClassificationWorkerBaseRuntimeConfig,
  type ClassificationWorkerBaseRuntimeConfig,
} from "./classification-worker-config.js";

export type ClassificationDaemonRuntimeConfig = ClassificationWorkerBaseRuntimeConfig & {
  concurrency: number;
  pollIntervalMs: number;
  errorBackoffMs: number;
  healthHost: string;
  healthPort: number;
  readinessMaximumAgeMs: number;
};

export function loadClassificationDaemonRuntimeConfig(
  env: NodeJS.ProcessEnv,
  promptPath: string,
): ClassificationDaemonRuntimeConfig {
  const base = loadClassificationWorkerBaseRuntimeConfig(env, promptPath);
  return {
    ...base,
    concurrency: integer(env.DOP_WORKER_CONCURRENCY ?? "2", "DOP_WORKER_CONCURRENCY", 1, 32),
    pollIntervalMs: integer(env.DOP_WORKER_POLL_MS ?? "1000", "DOP_WORKER_POLL_MS", 100, 60_000),
    errorBackoffMs: integer(env.DOP_WORKER_ERROR_BACKOFF_MS ?? "5000", "DOP_WORKER_ERROR_BACKOFF_MS", 100, 300_000),
    healthHost: env.DOP_WORKER_HEALTH_HOST ?? "127.0.0.1",
    healthPort: integer(env.PORT ?? env.DOP_WORKER_HEALTH_PORT ?? "3001", "PORT", 1, 65_535),
    readinessMaximumAgeMs: integer(
      env.DOP_WORKER_READINESS_MAX_AGE_MS ?? "30000",
      "DOP_WORKER_READINESS_MAX_AGE_MS",
      1_000,
      600_000,
    ),
  };
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}
