import { resolve } from "node:path";
import { Pool } from "pg";
import { OpenAIClassificationProvider } from "./adapters/openai/openai-classification-provider.js";
import { PostgresClassificationQueueRepository } from "./adapters/postgres/postgres-classification-queue-repository.js";
import { PostgresClassifierReleaseEvaluationWorkRepository } from "./adapters/postgres/postgres-classifier-release-evaluation-work-repository.js";
import { PostgresClassificationWorkRepository } from "./adapters/postgres/postgres-classification-work-repository.js";
import { LocalDocumentSourceResolver } from "./adapters/storage/local-document-source-resolver.js";
import { SupabaseDocumentSourceResolver } from "./adapters/storage/supabase-document-source-resolver.js";
import { ClassifyDocument } from "./application/classify-document.js";
import { RunNextClassifierReleaseEvaluation } from "./application/run-next-classifier-release-evaluation.js";
import { createWorkerHealthServer } from "./http/worker-health-server.js";
import { loadClassificationDaemonRuntimeConfig } from "./runtime/classification-daemon-config.js";
import { ClassificationWorkerLoop } from "./runtime/classification-worker-loop.js";
import { postgresPoolConfig } from "./runtime/postgres-pool-config.js";

const promptPath = resolve(
  process.env.DOP_CLASSIFICATION_PROMPT_PATH ?? "../prompts/document-classifier/v1.md",
);
const config = loadClassificationDaemonRuntimeConfig(process.env, promptPath);
const pool = new Pool(postgresPoolConfig(
  config.databaseUrl,
  config.databaseSslCaPath,
  Math.max(4, config.concurrency + 2),
));
const sourceResolver = config.documentSource === "local"
  ? new LocalDocumentSourceResolver(config.documentRoot)
  : new SupabaseDocumentSourceResolver({
      projectUrl: config.supabaseUrl,
      accessToken: config.supabaseStorageToken,
      bucket: config.supabaseStorageBucket,
    });
const provider = new OpenAIClassificationProvider({
  apiKey: config.openAIApiKey,
  model: config.openAIModel,
  prompt: config.prompt,
  timeoutMs: config.timeoutMs,
});
const classifier = new ClassifyDocument(
  new PostgresClassificationWorkRepository(pool),
  sourceResolver,
  provider,
  {
    environment: config.environment,
    organizationKey: config.organizationKey,
    prompt: config.prompt,
    providerModel: config.openAIModel,
  },
);
const worker = new ClassificationWorkerLoop(
  new PostgresClassificationQueueRepository(pool),
  classifier,
  {
    organizationKey: config.organizationKey,
    workerId: config.workerId,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    errorBackoffMs: config.errorBackoffMs,
  },
  new RunNextClassifierReleaseEvaluation(
    new PostgresClassifierReleaseEvaluationWorkRepository(pool),
    provider,
  ),
);
const healthServer = createWorkerHealthServer(
  worker, config.readinessMaximumAgeMs, () => new Date(), undefined, process.env.DOP_RELEASE_COMMIT ?? null,
);
const abortController = new AbortController();

await new Promise<void>((resolveListen, rejectListen) => {
  healthServer.once("error", rejectListen);
  healthServer.listen(config.healthPort, config.healthHost, resolveListen);
});

function stop(): void {
  abortController.abort();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

try {
  await worker.run(abortController.signal);
} finally {
  await new Promise<void>((resolveClose) => healthServer.close(() => resolveClose()));
  await pool.end();
}
