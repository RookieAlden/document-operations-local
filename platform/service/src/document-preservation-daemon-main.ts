import { Pool } from "pg";
import { HttpSourceDocumentDownloader } from "./adapters/http/http-source-document-downloader.js";
import { PostgresClassificationQueueRepository } from "./adapters/postgres/postgres-classification-queue-repository.js";
import { PostgresDocumentPreservationRepository } from "./adapters/postgres/postgres-document-preservation-repository.js";
import { PostgresRetentionLifecycleRepository } from "./adapters/postgres/postgres-retention-lifecycle-repository.js";
import { SupabaseDocumentObjectStore } from "./adapters/storage/supabase-document-object-store.js";
import { SupabaseDocumentPreviewSigner } from "./adapters/storage/supabase-document-preview-signer.js";
import { PreserveNextDocument } from "./application/preserve-next-document.js";
import { createWorkerHealthServer } from "./http/worker-health-server.js";
import { InternalDocumentPreviewRouter } from "./http/internal-document-preview-router.js";
import { InternalDocumentUploadRouter } from "./http/internal-document-upload-router.js";
import { loadDocumentPreservationDaemonConfig } from "./runtime/document-preservation-daemon-config.js";
import { DocumentPreservationWorkerLoop } from "./runtime/document-preservation-worker-loop.js";
import { RetentionLifecycleLoop } from "./runtime/retention-lifecycle-loop.js";
import { postgresPoolConfig } from "./runtime/postgres-pool-config.js";

const config = loadDocumentPreservationDaemonConfig(process.env);
const pool = new Pool(postgresPoolConfig(config.databaseUrl, config.databaseSslCaPath, Math.max(4, config.concurrency + 2)));
const repository = new PostgresDocumentPreservationRepository(pool);
const objectStore = new SupabaseDocumentObjectStore({
  projectUrl: config.supabaseUrl,
  accessToken: config.supabaseStorageToken,
  bucket: config.supabaseStorageBucket,
});
const preserver = new PreserveNextDocument(
  repository,
  new HttpSourceDocumentDownloader({
    allowedHosts: config.allowedSourceHosts,
    maximumBytes: config.maximumDocumentBytes,
  }),
  objectStore,
  { environment: config.environment, organizationKey: config.organizationKey },
);
const readiness = new PostgresClassificationQueueRepository(pool);
const worker = new DocumentPreservationWorkerLoop(
  preserver,
  () => readiness.checkReady(config.organizationKey),
  {
    workerId: config.workerId,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    errorBackoffMs: config.errorBackoffMs,
  },
);
const retentionWorker = new RetentionLifecycleLoop(new PostgresRetentionLifecycleRepository(pool), objectStore, {
  organizationKey:config.organizationKey,workerId:`${config.workerId}:retention`,enabled:config.retentionWorkerEnabled,
  pollIntervalMs:config.retentionPollIntervalMs,errorBackoffMs:config.errorBackoffMs,
  leaseSeconds:config.retentionLeaseSeconds,
});
const previewRouter = new InternalDocumentPreviewRouter(new SupabaseDocumentPreviewSigner({
  projectUrl: config.supabaseUrl,
  accessToken: config.supabaseStorageToken,
  bucket: config.supabaseStorageBucket,
}), config.internalPreviewToken);
const uploadRouter = new InternalDocumentUploadRouter(objectStore, config.internalPreviewToken, config.maximumDocumentBytes);
const internalRouter = {
  async handle(request: Parameters<InternalDocumentPreviewRouter["handle"]>[0], response: Parameters<InternalDocumentPreviewRouter["handle"]>[1]) {
    return await previewRouter.handle(request, response) || await uploadRouter.handle(request, response);
  },
};
const combinedWorker={snapshot(){const preservation=worker.snapshot();const retention=retentionWorker.snapshot();
  const ready=[preservation.lastReadyAt,retention.lastReadyAt].filter((v):v is string=>Boolean(v)).sort().at(0)??null;
  return {...preservation,lastReadyAt:ready,lastErrorAt:retention.lastErrorAt??preservation.lastErrorAt,
    lastErrorCode:retention.lastErrorCode??preservation.lastErrorCode,activeJobs:preservation.activeJobs+retention.activeJobs,
    completedJobs:preservation.completedJobs+retention.completedJobs,failedJobs:preservation.failedJobs+retention.failedJobs};}};
const healthServer = createWorkerHealthServer(combinedWorker, config.readinessMaximumAgeMs, () => new Date(), internalRouter, process.env.DOP_RELEASE_COMMIT ?? null);
const abortController = new AbortController();
await new Promise<void>((resolveListen, rejectListen) => {
  healthServer.once("error", rejectListen);
  healthServer.listen(config.healthPort, config.healthHost, resolveListen);
});
function stop(): void { abortController.abort(); }
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  await Promise.all([worker.run(abortController.signal),retentionWorker.run(abortController.signal)]);
} finally {
  await new Promise<void>((resolveClose) => healthServer.close(() => resolveClose()));
  await pool.end();
}
