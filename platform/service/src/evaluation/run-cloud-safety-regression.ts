import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  HttpSourceDocumentDownloader,
  SourceDocumentDownloadError,
} from "../adapters/http/http-source-document-downloader.js";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";

const organizationKey = "dev-accounting-firm";
const projectUrl = required(process.env.SUPABASE_URL, "SUPABASE_URL").replace(/\/$/, "");
const storageToken = required(process.env.SUPABASE_STORAGE_TOKEN, "SUPABASE_STORAGE_TOKEN");
const bucket = required(process.env.SUPABASE_STORAGE_BUCKET, "SUPABASE_STORAGE_BUCKET");
const opsUrl = required(process.env.DOP_CLOUD_OPS_URL, "DOP_CLOUD_OPS_URL").replace(/\/$/, "");
const opsEmail = required(process.env.DOP_OPS_EMAIL, "DOP_OPS_EMAIL");
const opsPassword = required(process.env.DOP_OPS_PASSWORD, "DOP_OPS_PASSWORD");
const fixturePath = resolve(required(process.env.DOP_EVALUATION_LOCAL_FIXTURE, "DOP_EVALUATION_LOCAL_FIXTURE"));
if (process.env.DOP_CLOUD_REGRESSION_CONFIRM !== "synthetic-dev-only") {
  throw new Error("DOP_CLOUD_REGRESSION_CONFIRM must equal synthetic-dev-only");
}

const fixture = await readFile(fixturePath);
const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
const corruptFixture = Buffer.from("%PDX- M11 synthetic corrupt document; not a PDF\n", "utf8");
const runKey = `m11-cloud-safety-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const sourceObjects = {
  corrupt: `synthetic/m11-regression/${runKey}/corrupt.pdf`,
  mimeMismatch: `synthetic/m11-regression/${runKey}/mime-mismatch.pdf`,
  duplicateOne: `synthetic/m11-regression/${runKey}/duplicate-one.pdf`,
  duplicateTwo: `synthetic/m11-regression/${runKey}/duplicate-two.pdf`,
};
const uploadedObjects: string[] = [];
const regressionIssueIds: string[] = [];
const resolvedIssueIds = new Set<string>();
const pool = new Pool(postgresPoolConfig(
  required(process.env.DATABASE_URL, "DATABASE_URL"),
  required(process.env.DATABASE_SSL_CA_PATH, "DATABASE_SSL_CA_PATH"),
  6,
));

try {
  await uploadSource(sourceObjects.corrupt, corruptFixture, "application/pdf");
  await uploadSource(sourceObjects.mimeMismatch, fixture, "image/png");
  await uploadSource(sourceObjects.duplicateOne, fixture, "application/pdf");
  await uploadSource(sourceObjects.duplicateTwo, fixture, "application/pdf");

  const signed = {
    corrupt: await createSignedUrl(sourceObjects.corrupt),
    mimeMismatch: await createSignedUrl(sourceObjects.mimeMismatch),
    duplicateOne: await createSignedUrl(sourceObjects.duplicateOne),
    duplicateTwo: await createSignedUrl(sourceObjects.duplicateTwo),
  };
  const downloader = new HttpSourceDocumentDownloader({
    allowedHosts: [new URL(projectUrl).hostname],
    maximumBytes: 20 * 1024 * 1024,
  });

  const corruptError = await expectedDownloadError(downloader, {
    url: signed.corrupt,
    filename: "m11-corrupt.pdf",
    declaredMimeType: "application/pdf",
    declaredSizeBytes: corruptFixture.byteLength,
    expectedSha256: null,
  }, "source_signature_mismatch");
  const mimeMismatchError = await expectedDownloadError(downloader, {
    url: signed.mimeMismatch,
    filename: "m11-mime-mismatch.pdf",
    declaredMimeType: "application/pdf",
    declaredSizeBytes: fixture.byteLength,
    expectedSha256: fixtureSha256,
  }, "source_mime_mismatch");
  const duplicateDownloads = await Promise.all([
    downloader.download({
      url: signed.duplicateOne, filename: "m11-duplicate-a.pdf",
      declaredMimeType: "application/pdf", declaredSizeBytes: fixture.byteLength,
      expectedSha256: fixtureSha256,
    }),
    downloader.download({
      url: signed.duplicateTwo, filename: "m11-duplicate-b.pdf",
      declaredMimeType: "application/pdf", declaredSizeBytes: fixture.byteLength,
      expectedSha256: fixtureSha256,
    }),
  ]);
  if (duplicateDownloads[0].sha256 !== duplicateDownloads[1].sha256 ||
      !duplicateDownloads[0].content.equals(duplicateDownloads[1].content)) {
    throw new Error("Duplicate-content regression did not produce identical canonical evidence");
  }

  regressionIssueIds.push(...await seedRegressionIssues());
  const session = await createOpsSession();
  const batchIdempotencyKey = randomUUID();
  const batchPayload = {
    action: "assign_to_me",
    issueIds: regressionIssueIds,
    note: `M11 synthetic concurrent batch regression ${runKey}`,
    idempotencyKey: batchIdempotencyKey,
  };
  const concurrentResponses = await Promise.all([
    opsMutation("/v1/ops/issues/batch-transitions", session, batchPayload),
    opsMutation("/v1/ops/issues/batch-transitions", session, batchPayload),
  ]);
  const concurrencyEvidence = verifyConcurrentResponses(concurrentResponses, regressionIssueIds);
  const persistedEvidence = await readBatchEvidence(regressionIssueIds, batchIdempotencyKey);
  if (persistedEvidence.transitionCount !== regressionIssueIds.length ||
      persistedEvidence.eventCount !== regressionIssueIds.length) {
    throw new Error("Concurrent batch regression produced duplicate persistent transitions or events");
  }

  for (const issueId of regressionIssueIds) {
    const restored = await opsMutation(`/v1/ops/issues/${encodeURIComponent(issueId)}/transitions`, session, {
      action: "resolve",
      note: `M11 synthetic regression completed; keep immutable evidence ${runKey}`,
      idempotencyKey: randomUUID(),
    });
    if (restored.outcome !== "completed" && restored.outcome !== "duplicate") {
      throw new Error(`Unable to resolve synthetic regression issue ${issueId}`);
    }
    resolvedIssueIds.add(issueId);
  }
  const finalIssueStates = await readIssueStates(regressionIssueIds);
  if (finalIssueStates.some((item) => item.status !== "resolved")) {
    throw new Error("Synthetic regression issues were not restored to resolved state");
  }
  await removeUploadedSources();

  process.stdout.write(`${JSON.stringify({
    verification_passed: true,
    run_key: runKey,
    corrupt_file: { expected_error: corruptError, temporary_object_removed: true },
    mime_mismatch: { expected_error: mimeMismatchError, temporary_object_removed: true },
    duplicate_content: {
      same_sha256: duplicateDownloads[0].sha256 === duplicateDownloads[1].sha256,
      bytes: duplicateDownloads[0].sizeBytes,
      temporary_objects_removed: true,
    },
    concurrent_batch: {
      issue_count: regressionIssueIds.length,
      completed_results: concurrencyEvidence.completedCount,
      duplicate_results: concurrencyEvidence.duplicateCount,
      persistent_transition_count: persistedEvidence.transitionCount,
      persistent_event_count: persistedEvidence.eventCount,
      final_issue_statuses: finalIssueStates.map((item) => item.status),
    },
  })}\n`);
} finally {
  if (regressionIssueIds.some((id) => !resolvedIssueIds.has(id))) {
    await safetyResolveIssues(regressionIssueIds).catch(() => undefined);
  }
  await Promise.all(uploadedObjects.map((path) => removeSource(path).catch(() => undefined)));
  await pool.end();
}

interface OpsSession {
  cookie: string;
  csrfToken: string;
}

interface BatchResult {
  outcome?: unknown;
  requestedCount?: unknown;
  completedCount?: unknown;
  results?: Array<{ issueId?: unknown; outcome?: unknown }>;
}

async function uploadSource(path: string, content: Buffer, contentType: string): Promise<void> {
  const response = await fetch(storageObjectUrl(path), {
    method: "POST",
    headers: storageHeaders({ "content-type": contentType, "x-upsert": "false" }),
    body: new Uint8Array(content),
  });
  if (!response.ok) throw new Error(`Unable to upload ${path}: HTTP ${response.status}`);
  uploadedObjects.push(path);
}

async function createSignedUrl(path: string): Promise<string> {
  const response = await fetch(`${projectUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodePath(path)}`, {
    method: "POST",
    headers: storageHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ expiresIn: 600 }),
  });
  if (!response.ok) throw new Error(`Unable to sign ${path}: HTTP ${response.status}`);
  const body = await response.json() as { signedURL?: unknown; signedUrl?: unknown };
  const signedPath = typeof body.signedURL === "string" ? body.signedURL
    : typeof body.signedUrl === "string" ? body.signedUrl : null;
  if (!signedPath) throw new Error("Storage signing response did not contain a URL");
  if (/^https:\/\//i.test(signedPath)) return new URL(signedPath).toString();
  const normalized = signedPath.startsWith("/object/") ? `/storage/v1${signedPath}` : signedPath;
  return new URL(normalized, projectUrl).toString();
}

async function expectedDownloadError(
  downloader: HttpSourceDocumentDownloader,
  request: Parameters<HttpSourceDocumentDownloader["download"]>[0],
  expectedCode: string,
): Promise<string> {
  try {
    await downloader.download(request);
  } catch (error) {
    if (error instanceof SourceDocumentDownloadError && error.code === expectedCode && error.failureMode === "manual") {
      return error.code;
    }
    throw error;
  }
  throw new Error(`Expected ${expectedCode}, but the download succeeded`);
}

async function seedRegressionIssues(): Promise<string[]> {
  const client = await pool.connect();
  const ids = [randomUUID(), randomUUID()];
  try {
    await client.query("BEGIN");
    const organization = await client.query<{ id: string | null }>(
      "SELECT dop_set_organization_context($1) AS id", [organizationKey],
    );
    const organizationId = organization.rows[0]?.id;
    if (!organizationId) throw new Error("Regression organization was not found");
    const caseResult = await client.query<{ id: string }>(
      `SELECT c.id FROM cases c JOIN subjects s ON s.id = c.subject_id
        WHERE s.subject_key = 'dev-client-001' ORDER BY c.period_start DESC LIMIT 1`,
    );
    const caseId = caseResult.rows[0]?.id;
    if (!caseId) throw new Error("Regression Case was not found");
    for (const [index, id] of ids.entries()) {
      const issueKey = `${runKey}|concurrent-batch|${index + 1}`;
      await client.query(
        `INSERT INTO issues (id, organization_id, case_id, issue_key, issue_type, severity,
           status, routing_reason, details, opened_at)
         VALUES ($1,$2,$3,$4,'synthetic_regression','low','open',
                 'm11_concurrent_batch_regression',$5::jsonb,now())`,
        [id, organizationId, caseId, issueKey, JSON.stringify({ synthetic: true, regression_run_key: runKey })],
      );
      await client.query(
        `INSERT INTO workflow_events (id, organization_id, idempotency_key, event_type, event_version,
           aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at)
         VALUES ($1,$2,$3,'Issue.RegressionSeeded',1,'issue',$4,$5,
                 'dop.evaluation.cloud-safety.v1',$6::jsonb,now())`,
        [randomUUID(), organizationId, `${runKey}|issue-seeded|${index + 1}`, id, randomUUID(),
          JSON.stringify({ synthetic: true, regression_run_key: runKey })],
      );
    }
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally { client.release(); }
}

async function createOpsSession(): Promise<OpsSession> {
  const login = await fetch(`${opsUrl}/v1/ops/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: opsEmail, password: opsPassword }),
  });
  if (!login.ok) throw new Error(`Ops login failed: HTTP ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Ops login did not return a session cookie");
  const overview = await fetch(`${opsUrl}/v1/ops/overview`, { headers: { cookie } });
  if (!overview.ok) throw new Error(`Ops overview failed: HTTP ${overview.status}`);
  const body = await overview.json() as { csrfToken?: unknown };
  if (typeof body.csrfToken !== "string") throw new Error("Ops overview did not return a CSRF token");
  return { cookie, csrfToken: body.csrfToken };
}

async function opsMutation(path: string, session: OpsSession, payload: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${opsUrl}${path}`, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      origin: opsUrl,
      "content-type": "application/json",
      "x-dop-csrf": session.csrfToken,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Ops mutation ${path} failed: HTTP ${response.status} ${String(body.error ?? "")}`);
  return body;
}

function verifyConcurrentResponses(responses: Record<string, unknown>[], issueIds: string[]): {
  completedCount: number; duplicateCount: number;
} {
  const parsed = responses as BatchResult[];
  if (parsed.some((item) => item.outcome !== "completed" || item.requestedCount !== issueIds.length ||
      item.completedCount !== issueIds.length || !Array.isArray(item.results))) {
    throw new Error("Concurrent batch endpoint did not report complete idempotent outcomes");
  }
  let completedCount = 0;
  let duplicateCount = 0;
  for (const issueId of issueIds) {
    const outcomes = parsed.flatMap((item) => item.results ?? [])
      .filter((item) => item.issueId === issueId)
      .map((item) => item.outcome)
      .sort();
    if (outcomes.length !== 2 || outcomes[0] !== "completed" || outcomes[1] !== "duplicate") {
      throw new Error(`Issue ${issueId} did not produce exactly one completed and one duplicate result`);
    }
    completedCount += 1;
    duplicateCount += 1;
  }
  return { completedCount, duplicateCount };
}

async function readBatchEvidence(issueIds: string[], batchKey: string): Promise<{
  transitionCount: number; eventCount: number;
}> {
  const keys = issueIds.map((issueId) => derivedBatchKey(batchKey, issueId));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT dop_set_organization_context($1)", [organizationKey]);
    const result = await client.query<{ transition_count: number; event_count: number }>(
      `SELECT
         (SELECT count(*)::integer FROM issue_operator_transitions
           WHERE issue_id = ANY($1::uuid[]) AND idempotency_key = ANY($2::text[])) AS transition_count,
         (SELECT count(*)::integer FROM workflow_events
           WHERE aggregate_id = ANY($1::uuid[]) AND idempotency_key = ANY($3::text[])) AS event_count`,
      [issueIds, keys, keys.map((key) => `ops-issue|${key}`)],
    );
    await client.query("COMMIT");
    return {
      transitionCount: Number(result.rows[0]?.transition_count ?? 0),
      eventCount: Number(result.rows[0]?.event_count ?? 0),
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally { client.release(); }
}

async function readIssueStates(issueIds: string[]): Promise<Array<{ id: string; status: string }>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT dop_set_organization_context($1)", [organizationKey]);
    const result = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM issues WHERE id = ANY($1::uuid[]) ORDER BY id", [issueIds],
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally { client.release(); }
}

async function safetyResolveIssues(issueIds: string[]): Promise<void> {
  if (issueIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT dop_set_organization_context($1)", [organizationKey]);
    await client.query(
      `UPDATE issues SET status='resolved', resolved_at=now(),
         details=details || $2::jsonb WHERE id = ANY($1::uuid[]) AND status <> 'resolved'`,
      [issueIds, JSON.stringify({ regression_safety_cleanup: true, regression_run_key: runKey })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally { client.release(); }
}

async function removeSource(path: string): Promise<void> {
  const response = await fetch(storageObjectUrl(path), { method: "DELETE", headers: storageHeaders() });
  if (!response.ok && response.status !== 404) throw new Error(`Unable to remove ${path}: HTTP ${response.status}`);
}

async function removeUploadedSources(): Promise<void> {
  const paths = uploadedObjects.splice(0);
  await Promise.all(paths.map(removeSource));
}

function storageObjectUrl(path: string): string {
  return `${projectUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodePath(path)}`;
}

function storageHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${storageToken}`, apikey: storageToken, ...extra };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function derivedBatchKey(batchKey: string, issueId: string): string {
  const hex = createHmac("sha256", batchKey).update(issueId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
