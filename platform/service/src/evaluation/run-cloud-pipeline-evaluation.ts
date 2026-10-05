import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";

const organizationKey = "dev-accounting-firm";
const projectUrl = required(process.env.SUPABASE_URL, "SUPABASE_URL").replace(/\/$/, "");
const storageToken = required(process.env.SUPABASE_STORAGE_TOKEN, "SUPABASE_STORAGE_TOKEN");
const bucket = required(process.env.SUPABASE_STORAGE_BUCKET, "SUPABASE_STORAGE_BUCKET");
const intakeUrl = required(process.env.DOP_CLOUD_INTAKE_URL, "DOP_CLOUD_INTAKE_URL").replace(/\/$/, "");
const formGatewayUrl = process.env.DOP_FORM_GATEWAY_URL?.replace(/\/$/, "");
const connectorToken = process.env.DOP_FORM_CONNECTOR_TOKEN;
const nativeConnectorPayload = process.env.DOP_FORM_CONNECTOR_NATIVE === "true";
const makeBridgeConnectorPayload = process.env.DOP_FORM_CONNECTOR_MAKE_BRIDGE === "true";
const intakeToken = connectorToken ?? required(process.env.DOP_INTAKE_TOKEN, "DOP_INTAKE_TOKEN");
const connectorId = process.env.DOP_FORM_CONNECTOR_ID;
const providerFormId = process.env.DOP_FORM_CONNECTOR_PROVIDER_FORM_ID;
if (connectorToken && (!connectorId || !providerFormId)) {
  throw new Error("DOP_FORM_CONNECTOR_ID and DOP_FORM_CONNECTOR_PROVIDER_FORM_ID are required for connector evaluation");
}
const fixturePath = resolve(required(process.env.DOP_EVALUATION_LOCAL_FIXTURE, "DOP_EVALUATION_LOCAL_FIXTURE"));
const fixture = await readFile(fixturePath);
const sha256 = createHash("sha256").update(fixture).digest("hex");
const runKey = `cloud-pipeline-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const sourceObjectPath = `synthetic/cloud-evaluation/${runKey}.pdf`;
const pool = new Pool(postgresPoolConfig(
  required(process.env.DATABASE_URL, "DATABASE_URL"),
  required(process.env.DATABASE_SSL_CA_PATH, "DATABASE_SSL_CA_PATH"),
  2,
));

try {
  await uploadSource(sourceObjectPath, fixture);
  const signedUrl = await createSignedUrl(sourceObjectPath);
  const endpoint = formGatewayUrl ?? (connectorToken
    ? `${intakeUrl}/v1/connectors/forms/${encodeURIComponent(connectorId!)}/submissions`
    : `${intakeUrl}/v1/submissions`);
  const submissionTime = new Date().toISOString();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...(formGatewayUrl ? {} : { authorization: `Bearer ${intakeToken}` }),
      "content-type": "application/json",
      "x-request-id": randomUUID(),
    },
    body: JSON.stringify(formGatewayUrl ? {
      formId: providerFormId,
      formName: "Accounting Document Intake DEV · Connector V1",
      submission: {
        submissionId: runKey,
        submissionTime,
        lastUpdatedAt: submissionTime,
        questions: [{
          id: "period-question",
          name: "Accounting period (YYYY-MM)",
          type: "ShortAnswer",
          value: "2026-07",
        }, {
          id: "files-question",
          name: "Accounting documents (PDF, JPG or PNG)",
          type: "FileUpload",
          value: [{
            id: `${runKey}-file-1`,
            name: "dev-client-001_bank-statement_2026-07.pdf",
            url: signedUrl,
            type: "application/pdf",
            size: fixture.byteLength,
          }],
        }],
      },
    } : connectorToken && makeBridgeConnectorPayload ? {
      connector_bridge_version: "fillout-make-v1",
      provider_form_id: providerFormId,
      provider_submission_id: runKey,
      received_at: new Date().toISOString(),
      period: "2026-07",
      provider_files: [{
        id: `${runKey}-file-1`,
        name: "dev-client-001_bank-statement_2026-07.pdf",
        url: signedUrl,
        type: "application/pdf",
        size: fixture.byteLength,
      }],
    } : connectorToken && nativeConnectorPayload ? {
      submissionId: runKey,
      submissionTime: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      questions: [{
        id: "period-question",
        name: "Accounting period (YYYY-MM)",
        type: "ShortAnswer",
        value: "2026-07",
      }, {
        id: "files-question",
        name: "Accounting documents (PDF, JPG or PNG)",
        type: "FileUpload",
        value: [{
          name: "dev-client-001_bank-statement_2026-07.pdf",
          url: signedUrl,
          mimeType: "application/pdf",
          size: fixture.byteLength,
        }],
      }],
    } : connectorToken ? {
      schema_version: "1.0",
      provider_form_id: providerFormId,
      provider_submission_id: runKey,
      received_at: new Date().toISOString(),
      period: "2026-07",
      files: [{
        source_file_id: `${runKey}-file-1`,
        original_filename: "dev-client-001_bank-statement_2026-07.pdf",
        download_url: signedUrl,
        declared_mime_type: "application/pdf",
        declared_size_bytes: fixture.byteLength,
        content_hash_sha256: sha256,
      }],
    } : {
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
    }),
  });
  const responseText = await response.text();
  let body: {
    outcome?: unknown;
    submission_id?: unknown;
    document_ids?: unknown;
    error?: unknown;
  } = {};
  try {
    body = JSON.parse(responseText) as typeof body;
  } catch {
    if (!formGatewayUrl) throw new Error(`Cloud intake returned invalid JSON: HTTP ${response.status}`);
  }
  if (formGatewayUrl ? !response.ok : response.status !== 202 || body.outcome !== "accepted") {
    throw new Error(`Cloud intake rejected the synthetic submission: HTTP ${response.status}`);
  }
  const documentId = formGatewayUrl
    ? await waitForDocumentId(runKey, 60_000)
    : Array.isArray(body.document_ids) && typeof body.document_ids[0] === "string"
      ? body.document_ids[0]
      : null;
  if (!documentId) throw new Error("Cloud intake returned no document id");

  const result = await waitForClassification(documentId, 180_000);
  const verificationPassed = result.status === "accepted"
    && result.accepted_document_type_code === "bank_statement"
    && result.source_download_ref === null
    && typeof result.incoming_storage_ref === "string"
    && result.size_bytes === fixture.byteLength
    && result.content_hash_sha256 === sha256
    && result.classification_attempt_count === 1
    && result.attempts_without_raw_response === 1
    && result.stored_event_count === 1
    && result.classified_event_count === 1
    && result.open_issue_count === 0;
  if (!verificationPassed) throw new Error("Cloud pipeline reached a terminal state but failed its invariants");

  process.stdout.write(`${JSON.stringify({
    verification_passed: true,
    intake_mode: formGatewayUrl ? "fillout_make_gateway"
      : connectorToken
      ? makeBridgeConnectorPayload ? "form_connector_make_bridge"
        : nativeConnectorPayload ? "form_connector_native" : "form_connector_normalized"
      : "canonical_api",
    intake_outcome: formGatewayUrl ? "accepted" : body.outcome,
    document_id: documentId,
    document_status: result.status,
    predicted_document_type_code: result.accepted_document_type_code,
    confidence: result.confidence,
    source_reference_cleared: result.source_download_ref === null,
    private_storage_reference_present: typeof result.incoming_storage_ref === "string",
    size_bytes: result.size_bytes,
    content_hash_sha256: result.content_hash_sha256,
    classification_attempt_count: result.classification_attempt_count,
    raw_response_reference_count: result.classification_attempt_count - result.attempts_without_raw_response,
    stored_event_count: result.stored_event_count,
    classified_event_count: result.classified_event_count,
    open_issue_count: result.open_issue_count,
  })}\n`);
} finally {
  await removeSource(sourceObjectPath).catch(() => undefined);
  await pool.end();
}

interface PipelineState {
  status: string;
  source_download_ref: string | null;
  incoming_storage_ref: string | null;
  size_bytes: number | null;
  content_hash_sha256: string | null;
  accepted_document_type_code: string | null;
  confidence: number | null;
  classification_attempt_count: number;
  attempts_without_raw_response: number;
  stored_event_count: number;
  classified_event_count: number;
  open_issue_count: number;
}

async function waitForClassification(documentId: string, timeoutMs: number): Promise<PipelineState> {
  const deadline = Date.now() + timeoutMs;
  let latest: PipelineState | null = null;
  while (Date.now() < deadline) {
    latest = await readPipelineState(documentId);
    if (["accepted", "review_required", "failed_manual"].includes(latest.status)) return latest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Cloud pipeline timed out; last status was ${latest?.status ?? "not_found"}`);
}

async function waitForDocumentId(sourceSubmissionId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT dop_set_organization_context($1)", [organizationKey]);
      const result = await client.query<{ id: string }>(
        `SELECT d.id
           FROM documents d
           JOIN submissions s ON s.id = d.submission_id
          WHERE s.source = 'fillout' AND s.source_submission_id = $1
          ORDER BY d.created_at DESC
          LIMIT 1`,
        [sourceSubmissionId],
      );
      await client.query("COMMIT");
      if (result.rows[0]?.id) return result.rows[0].id;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("Make gateway accepted the request but no document appeared before timeout");
}

async function readPipelineState(documentId: string): Promise<PipelineState> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT dop_set_organization_context($1)", [organizationKey]);
    const result = await client.query<PipelineState>(
      `SELECT d.status, d.source_download_ref, d.incoming_storage_ref,
              d.size_bytes::integer, d.content_hash_sha256, dt.code AS accepted_document_type_code,
              (d.classification_summary->>'confidence')::numeric::float8 AS confidence,
              (SELECT count(*)::integer FROM classification_attempts ca WHERE ca.document_id = d.id) AS classification_attempt_count,
              (SELECT count(*)::integer FROM classification_attempts ca WHERE ca.document_id = d.id AND ca.raw_response_reference IS NULL) AS attempts_without_raw_response,
              (SELECT count(*)::integer FROM workflow_events we WHERE we.aggregate_id = d.id AND we.event_type = 'Document.Stored') AS stored_event_count,
              (SELECT count(*)::integer FROM workflow_events we WHERE we.aggregate_id = d.id AND we.event_type = 'Document.Classified') AS classified_event_count,
              (SELECT count(*)::integer FROM issues i WHERE i.document_id = d.id AND i.status IN ('open','assigned','waiting_external','waiting_internal','reopened')) AS open_issue_count
         FROM documents d
         LEFT JOIN document_types dt ON dt.id = d.accepted_document_type_id
        WHERE d.id = $1`,
      [documentId],
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) throw new Error("Cloud document disappeared during evaluation");
    return row;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function uploadSource(path: string, content: Buffer): Promise<void> {
  const response = await fetch(storageObjectUrl(path), {
    method: "POST",
    headers: storageHeaders({ "content-type": "application/pdf", "x-upsert": "false" }),
    body: new Uint8Array(content),
  });
  if (!response.ok) throw new Error(`Unable to upload synthetic source: HTTP ${response.status}`);
}

async function createSignedUrl(path: string): Promise<string> {
  const response = await fetch(`${projectUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodePath(path)}`, {
    method: "POST",
    headers: storageHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ expiresIn: 600 }),
  });
  if (!response.ok) throw new Error(`Unable to sign synthetic source: HTTP ${response.status}`);
  const body = await response.json() as { signedURL?: unknown; signedUrl?: unknown };
  const signedPath = typeof body.signedURL === "string" ? body.signedURL
    : typeof body.signedUrl === "string" ? body.signedUrl : null;
  if (!signedPath) throw new Error("Storage signing response did not contain a URL");
  if (/^https:\/\//i.test(signedPath)) return new URL(signedPath).toString();
  const normalized = signedPath.startsWith("/object/") ? `/storage/v1${signedPath}` : signedPath;
  return new URL(normalized, projectUrl).toString();
}

async function removeSource(path: string): Promise<void> {
  const response = await fetch(storageObjectUrl(path), { method: "DELETE", headers: storageHeaders() });
  if (!response.ok && response.status !== 404) throw new Error(`Unable to remove synthetic source: HTTP ${response.status}`);
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

async function rollbackQuietly(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
