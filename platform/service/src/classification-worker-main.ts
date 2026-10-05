import { resolve } from "node:path";
import { Pool } from "pg";
import { OpenAIClassificationProvider } from "./adapters/openai/openai-classification-provider.js";
import { PostgresClassificationWorkRepository } from "./adapters/postgres/postgres-classification-work-repository.js";
import { LocalDocumentSourceResolver } from "./adapters/storage/local-document-source-resolver.js";
import { SupabaseDocumentSourceResolver } from "./adapters/storage/supabase-document-source-resolver.js";
import { ClassifyDocument } from "./application/classify-document.js";
import { loadClassificationWorkerRuntimeConfig } from "./runtime/classification-worker-config.js";
import { postgresPoolConfig } from "./runtime/postgres-pool-config.js";

const promptPath = resolve(
  process.env.DOP_CLASSIFICATION_PROMPT_PATH ?? "../prompts/document-classifier/v1.md",
);
const config = loadClassificationWorkerRuntimeConfig(process.env, promptPath);
const pool = new Pool(postgresPoolConfig(config.databaseUrl, config.databaseSslCaPath, 1));
const sourceResolver = config.documentSource === "local"
  ? new LocalDocumentSourceResolver(config.documentRoot)
  : new SupabaseDocumentSourceResolver({
      projectUrl: config.supabaseUrl,
      accessToken: config.supabaseStorageToken,
      bucket: config.supabaseStorageBucket,
    });
const worker = new ClassifyDocument(
  new PostgresClassificationWorkRepository(pool),
  sourceResolver,
  new OpenAIClassificationProvider({
    apiKey: config.openAIApiKey,
    model: config.openAIModel,
    prompt: config.prompt,
    timeoutMs: config.timeoutMs,
  }),
  {
    environment: config.environment,
    organizationKey: config.organizationKey,
    prompt: config.prompt,
    providerModel: config.openAIModel,
  },
);

try {
  const result = await worker.execute({ documentId: config.documentId, workerId: config.workerId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.outcome === "failed_manual" || result.outcome === "failed_recoverable") {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
