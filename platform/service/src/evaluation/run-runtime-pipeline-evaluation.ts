import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { HttpSourceDocumentDownloader } from "../adapters/http/http-source-document-downloader.js";
import { OpenAIClassificationProvider } from "../adapters/openai/openai-classification-provider.js";
import { PostgresClassificationQueueRepository } from "../adapters/postgres/postgres-classification-queue-repository.js";
import { PostgresClassificationWorkRepository } from "../adapters/postgres/postgres-classification-work-repository.js";
import { PostgresCoreRepository } from "../adapters/postgres/postgres-core-repository.js";
import { PostgresDocumentPreservationRepository } from "../adapters/postgres/postgres-document-preservation-repository.js";
import { SupabaseDocumentObjectStore } from "../adapters/storage/supabase-document-object-store.js";
import { SupabaseDocumentSourceResolver } from "../adapters/storage/supabase-document-source-resolver.js";
import { ClassifyDocument } from "../application/classify-document.js";
import { PreserveNextDocument } from "../application/preserve-next-document.js";
import { ReceiveSubmission } from "../application/receive-submission.js";
import { ContractValidator } from "../contracts/json-schema-validator.js";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";

const organizationKey = "dev-accounting-firm";
const projectUrl = required(process.env.SUPABASE_URL, "SUPABASE_URL").replace(/\/$/, "");
const storageToken = required(process.env.SUPABASE_STORAGE_TOKEN, "SUPABASE_STORAGE_TOKEN");
const bucket = required(process.env.SUPABASE_STORAGE_BUCKET, "SUPABASE_STORAGE_BUCKET");
const sourceObjectPath = required(process.env.DOP_EVALUATION_SOURCE_OBJECT_PATH, "DOP_EVALUATION_SOURCE_OBJECT_PATH");
const localFixturePath = resolve(required(process.env.DOP_EVALUATION_LOCAL_FIXTURE, "DOP_EVALUATION_LOCAL_FIXTURE"));
const promptPath = resolve(required(process.env.DOP_CLASSIFICATION_PROMPT_PATH, "DOP_CLASSIFICATION_PROMPT_PATH"));
const fixture = await readFile(localFixturePath);
const sha256 = createHash("sha256").update(fixture).digest("hex");
const signedUrl = await createSignedUrl(projectUrl, storageToken, bucket, sourceObjectPath);
const pool = new Pool(postgresPoolConfig(
  required(process.env.DATABASE_URL, "DATABASE_URL"),
  required(process.env.DATABASE_SSL_CA_PATH, "DATABASE_SSL_CA_PATH"),
  6,
));
const runKey = `runtime-pipeline-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;

try {
  const intake = new ReceiveSubmission(new ContractValidator(), new PostgresCoreRepository(pool), {
    environment: "DEV", organizationKey,
  });
  const received = await intake.execute({
    workerId: "runtime-evaluation:intake",
    input: {
      schema_version: "1.0",
      environment: "DEV",
      organization_key: organizationKey,
      workflow_template_key: "accounting.monthly.document_collection",
      case_key: "dev-accounting-firm|accounting.monthly.document_collection|dev-client-001|2026-07",
      subject: { subject_key: "dev-client-001", display_name: "Kauri Coast Cafe Limited" },
      source: { type: "internal_upload", submission_id: runKey, received_at: new Date().toISOString() },
      business_context: { period: "2026-07", timezone: "Pacific/Auckland", synthetic: true },
      files: [{
        source_file_id: `${runKey}-file-1`,
        original_filename: "dev-client-001_bank-statement_2026-07.pdf",
        download_url: signedUrl,
        declared_mime_type: "application/pdf",
        declared_size_bytes: fixture.byteLength,
        content_hash_sha256: sha256,
      }],
    },
  });
  if (received.outcome !== "accepted") throw new Error(`Runtime intake did not accept: ${received.outcome}`);
  const documentId = received.documentIds[0];
  if (!documentId) throw new Error("Runtime intake returned no document");

  const preservationRepository = new PostgresDocumentPreservationRepository(pool);
  const preserved = await new PreserveNextDocument(
    preservationRepository,
    new HttpSourceDocumentDownloader({
      allowedHosts: [new URL(projectUrl).hostname], maximumBytes: 20 * 1024 * 1024,
    }),
    new SupabaseDocumentObjectStore({ projectUrl, accessToken: storageToken, bucket }),
    { environment: "DEV", organizationKey },
  ).execute({ workerId: "runtime-evaluation:preserve" });
  if (preserved.outcome !== "stored" || preserved.documentId !== documentId) {
    throw new Error(`Runtime preservation did not store expected document: ${preserved.outcome}`);
  }

  const queue = new PostgresClassificationQueueRepository(pool);
  const candidates = await queue.findCandidates({ organizationKey, limit: 10, now: new Date() });
  if (!candidates.includes(documentId)) throw new Error("Stored document did not enter the classification queue");
  const prompt = await readFile(promptPath, "utf8");
  const classified = await new ClassifyDocument(
    new PostgresClassificationWorkRepository(pool),
    new SupabaseDocumentSourceResolver({ projectUrl, accessToken: storageToken, bucket }),
    new OpenAIClassificationProvider({
      apiKey: required(process.env.OPENAI_API_KEY, "OPENAI_API_KEY"),
      model: required(process.env.OPENAI_CLASSIFICATION_MODEL, "OPENAI_CLASSIFICATION_MODEL"),
      prompt,
      timeoutMs: 120_000,
    }),
    { environment: "DEV", organizationKey, prompt, providerModel: required(process.env.OPENAI_CLASSIFICATION_MODEL, "OPENAI_CLASSIFICATION_MODEL") },
  ).execute({ documentId, workerId: "runtime-evaluation:classify" });

  process.stdout.write(`${JSON.stringify({
    verification_passed: classified.outcome === "accepted",
    submission_outcome: received.outcome,
    preservation_outcome: preserved.outcome,
    queue_candidate_found: true,
    classification_outcome: classified.outcome,
    predicted_document_type_code: "predictedDocumentTypeCode" in classified
      ? classified.predictedDocumentTypeCode : null,
    confidence: "confidence" in classified ? classified.confidence : null,
    document_id: documentId,
    content_hash_sha256: sha256,
  })}\n`);
} finally {
  await pool.end();
}

async function createSignedUrl(
  projectUrl: string,
  token: string,
  bucket: string,
  objectPath: string,
): Promise<string> {
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${projectUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedPath}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, apikey: token, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: 600 }),
    },
  );
  if (!response.ok) throw new Error(`Unable to create source URL: HTTP ${response.status}`);
  const body = await response.json() as { signedURL?: unknown; signedUrl?: unknown };
  const path = typeof body.signedURL === "string" ? body.signedURL
    : typeof body.signedUrl === "string" ? body.signedUrl : null;
  if (!path) throw new Error("Storage signing response did not contain a URL");
  if (/^https:\/\//i.test(path)) return new URL(path).toString();
  const normalizedPath = path.startsWith("/object/") ? `/storage/v1${path}` : path;
  return new URL(normalizedPath, projectUrl).toString();
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
