export interface ReminderAutomationConfig {
  databaseUrl: string;
  databaseSslCaPath?: string;
  organizationKey: string;
  workerId: string;
  pollIntervalMs: number;
  errorBackoffMs: number;
  deliveryPollIntervalMs: number;
  deliveryLeaseSeconds: number;
  healthHost: string;
  healthPort: number;
  readinessMaximumAgeMs: number;
}

export function loadReminderAutomationConfig(env: NodeJS.ProcessEnv): ReminderAutomationConfig {
  return {
    databaseUrl: required(env.DATABASE_URL, "DATABASE_URL"),
    ...(env.DATABASE_SSL_CA_PATH ? { databaseSslCaPath: env.DATABASE_SSL_CA_PATH } : {}),
    organizationKey: required(env.DOP_ORGANIZATION_KEY, "DOP_ORGANIZATION_KEY"),
    workerId: required(env.DOP_WORKER_ID, "DOP_WORKER_ID"),
    pollIntervalMs: integer(env.DOP_REMINDER_POLL_MS ?? "300000", "DOP_REMINDER_POLL_MS", 60_000, 3_600_000),
    errorBackoffMs: integer(env.DOP_WORKER_ERROR_BACKOFF_MS ?? "30000", "DOP_WORKER_ERROR_BACKOFF_MS", 1_000, 600_000),
    deliveryPollIntervalMs: integer(env.DOP_DELIVERY_POLL_MS ?? "5000", "DOP_DELIVERY_POLL_MS", 1_000, 300_000),
    deliveryLeaseSeconds: integer(env.DOP_DELIVERY_LEASE_SECONDS ?? "120", "DOP_DELIVERY_LEASE_SECONDS", 15, 900),
    healthHost: env.DOP_WORKER_HEALTH_HOST ?? "127.0.0.1",
    healthPort: integer(env.PORT ?? "3000", "PORT", 1, 65_535),
    readinessMaximumAgeMs: integer(
      env.DOP_WORKER_READINESS_MAX_AGE_MS ?? "900000",
      "DOP_WORKER_READINESS_MAX_AGE_MS", 60_000, 7_200_000,
    ),
  };
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
