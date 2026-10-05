import { Pool } from "pg";
import { PostgresReminderSchedulerRepository } from "./adapters/postgres/postgres-reminder-scheduler-repository.js";
import { PostgresDeliveryAutomationRepository } from "./adapters/postgres/postgres-delivery-automation-repository.js";
import { createWorkerHealthServer } from "./http/worker-health-server.js";
import { SyntheticDeliveryProvider } from "./providers/synthetic-delivery-provider.js";
import { DeliveryAutomationLoop } from "./runtime/delivery-automation-loop.js";
import { loadReminderAutomationConfig } from "./runtime/reminder-automation-config.js";
import { ReminderAutomationLoop } from "./runtime/reminder-automation-loop.js";
import { postgresPoolConfig } from "./runtime/postgres-pool-config.js";

const config = loadReminderAutomationConfig(process.env);
const pool = new Pool(postgresPoolConfig(config.databaseUrl, config.databaseSslCaPath, 3));
const reminderWorker = new ReminderAutomationLoop(new PostgresReminderSchedulerRepository(pool), {
  organizationKey: config.organizationKey,
  workerId: config.workerId,
  pollIntervalMs: config.pollIntervalMs,
  errorBackoffMs: config.errorBackoffMs,
});
const deliveryWorker = new DeliveryAutomationLoop(
  new PostgresDeliveryAutomationRepository(pool), new SyntheticDeliveryProvider(), {
    organizationKey: config.organizationKey, workerId: `${config.workerId}:delivery`,
    pollIntervalMs: config.deliveryPollIntervalMs,
    errorBackoffMs: config.errorBackoffMs, leaseSeconds: config.deliveryLeaseSeconds,
  },
);
const worker = {
  snapshot() {
    const reminder = reminderWorker.snapshot();
    const delivery = deliveryWorker.snapshot();
    const readyTimes = [reminder.lastReadyAt, delivery.lastReadyAt].filter((value): value is string => Boolean(value));
    return {
      status: reminder.status === "stopped" || delivery.status === "stopped" ? "stopped" as const
        : reminder.status === "running" && delivery.status === "running" ? "running" as const : "starting" as const,
      startedAt: reminder.startedAt,
      lastPollAt: delivery.lastPollAt ?? reminder.lastPollAt,
      lastReadyAt: readyTimes.length === 2 ? readyTimes.sort()[0] ?? null : null,
      lastErrorAt: delivery.lastErrorAt ?? reminder.lastErrorAt,
      lastErrorCode: delivery.lastErrorCode ?? reminder.lastErrorCode,
      activeJobs: delivery.activeJobs,
      completedJobs: reminder.completedJobs + delivery.completedJobs,
      reviewJobs: delivery.reviewJobs,
      failedJobs: reminder.failedJobs + delivery.failedJobs,
      reminder, delivery,
    };
  },
};
const healthServer = createWorkerHealthServer(
  worker, config.readinessMaximumAgeMs, () => new Date(), undefined,
  process.env.DOP_RELEASE_COMMIT ?? null,
);
const abortController = new AbortController();

await new Promise<void>((resolveListen, rejectListen) => {
  healthServer.once("error", rejectListen);
  healthServer.listen(config.healthPort, config.healthHost, resolveListen);
});

function stop(): void { abortController.abort(); }
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

try { await Promise.all([reminderWorker.run(abortController.signal), deliveryWorker.run(abortController.signal)]); }
finally {
  await new Promise<void>((resolveClose) => healthServer.close(() => resolveClose()));
  await pool.end();
}
