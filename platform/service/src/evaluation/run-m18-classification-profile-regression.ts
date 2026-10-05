import { Pool } from "pg";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";
import type {
  ClassificationProfileDefinition,
  OpsClassificationProfileSnapshot,
  OpsClassificationProfileVersion,
} from "../ports/ops-classification-profile-repository.js";

interface Session { cookie: string; csrfToken: string }
type JsonRecord = Record<string, unknown>;

const opsUrl = required(process.env.DOP_M18_OPS_URL, "DOP_M18_OPS_URL").replace(/\/$/, "");
const origin = new URL(opsUrl).origin;
const keys = {
  clone: "00000000-0000-4000-a180-000000000101",
  revise: "00000000-0000-4000-a180-000000000102",
  evaluate: "00000000-0000-4000-a180-000000000103",
  review: "00000000-0000-4000-a180-000000000104",
  publish: "00000000-0000-4000-a180-000000000105",
  managerMutation: "00000000-0000-4000-a180-000000000106",
};
const newLabelCode = "compliance_certificate";

const owner = await login(required(process.env.DOP_M18_OWNER_EMAIL, "DOP_M18_OWNER_EMAIL"),
  required(process.env.DOP_M18_OWNER_PASSWORD, "DOP_M18_OWNER_PASSWORD"));
const manager = await login(required(process.env.DOP_M18_MANAGER_EMAIL, "DOP_M18_MANAGER_EMAIL"),
  required(process.env.DOP_M18_MANAGER_PASSWORD, "DOP_M18_MANAGER_PASSWORD"));
const staff = await login(required(process.env.DOP_M18_STAFF_EMAIL, "DOP_M18_STAFF_EMAIL"),
  required(process.env.DOP_M18_STAFF_PASSWORD, "DOP_M18_STAFF_PASSWORD"));

assertStatus(await fetch(`${opsUrl}/v1/ops/classification-profile`, { headers: { cookie: staff.cookie } }), 403,
  "staff classification profile catalog");
const managerSnapshot = await getJson<OpsClassificationProfileSnapshot>(manager, "/v1/ops/classification-profile");
assert(managerSnapshot.canManage === false, "manager unexpectedly received classification mutation rights");
const managerCurrent = managerSnapshot.versions.find((item) => item.isCurrentPublished);
assert(managerCurrent, "manager could not read the current classification profile");
assertStatus(await fetch(`${opsUrl}/v1/ops/classification-profile/${managerCurrent.id}/clone`, {
  method: "POST", headers: mutationHeaders(manager), body: JSON.stringify({
    reason: "Manager must remain outside classification profile mutation rights.",
    idempotencyKey: keys.managerMutation,
  }),
}), 403, "manager classification profile mutation");

const pool = new Pool(postgresPoolConfig(required(process.env.DATABASE_URL, "DATABASE_URL"),
  required(process.env.DOP_M18_DATABASE_SSL_CA_PATH ?? process.env.DATABASE_SSL_CA_PATH, "DOP_M18_DATABASE_SSL_CA_PATH"), 1));
const baseline = await operationalCounts(pool);

let snapshot = await getJson<OpsClassificationProfileSnapshot>(owner, "/v1/ops/classification-profile");
assert(snapshot.canManage, "owner did not receive classification mutation rights");
let published = snapshot.versions.find((item) => item.isCurrentPublished &&
  item.definition.labels.some((label) => label.code === newLabelCode));

if (!published) {
  const currentPublished = snapshot.versions.find((item) => item.isCurrentPublished);
  assert(currentPublished, "current published classification profile is missing");
  let current = latest(snapshot.versions.filter((item) => item.version > currentPublished.version));
  if (!current) {
    const cloned = await postJson(owner, `/v1/ops/classification-profile/${currentPublished.id}/clone`, {
      reason: "Clone the current profile to prove a reusable cross-industry classification extension.",
      idempotencyKey: keys.clone,
    });
    current = await versionById(owner, requiredString(cloned.versionId, "cloned profile version id"));
  }
  if (current.status === "draft" && !current.definition.labels.some((label) => label.code === newLabelCode)) {
    const revised = await postJson(owner, `/v1/ops/classification-profile/${current.id}/revisions`, {
      definition: extendedDefinition(current.definition),
      reason: "Add a cross-industry compliance certificate label and deterministic routing evidence.",
      idempotencyKey: keys.revise,
    });
    current = await versionById(owner, requiredString(revised.versionId, "revised profile version id"));
  }
  assert(current.status === "draft" || current.status === "in_review", "classification profile is not publishable");
  if (current.status === "draft") {
    const body = {
      reason: "Evaluate accepted, low-confidence, unknown and poor-quality synthetic routes without a model call.",
      idempotencyKey: keys.evaluate,
    };
    const evaluation = await postJson(owner, `/v1/ops/classification-profile/${current.id}/evaluations`, body);
    assert(["completed", "duplicate"].includes(String(evaluation.outcome)) && evaluation.status === "passed",
      "classification policy evaluation did not pass");
    assert((evaluation.result as JsonRecord | undefined)?.providerCall === false,
      "classification policy evaluation unexpectedly called a provider");
    const duplicate = await postJson(owner, `/v1/ops/classification-profile/${current.id}/evaluations`, body);
    assert(duplicate.outcome === "duplicate" && duplicate.status === "passed",
      "classification policy evaluation retry was not idempotent");
    const reviewed = await postJson(owner, `/v1/ops/classification-profile/${current.id}/transitions`, {
      action: "submit_review",
      reason: "Submit the exact passing definition hash for controlled publication review.",
      idempotencyKey: keys.review,
    });
    current = await versionById(owner, requiredString(reviewed.versionId, "review profile version id"));
  }
  assert(current.status === "in_review", "classification profile did not enter review");
  const result = await postJson(owner, `/v1/ops/classification-profile/${current.id}/transitions`, {
    action: "publish",
    reason: "Publish the reviewed M18 profile while unknown and ambiguous inputs remain human-routed.",
    idempotencyKey: keys.publish,
  });
  published = await versionById(owner, requiredString(result.versionId, "published profile version id"));
}

assert(published.isCurrentPublished && published.status === "published", "M18 profile is not current published");
const newLabel = published.definition.labels.find((label) => label.code === newLabelCode);
assert(newLabel, "cross-industry compliance certificate label is missing");
assert(newLabel.extractionFields.some((field) => field.key === "certificate_number") &&
  newLabel.extractionFields.some((field) => field.key === "expiry_date"), "governed extraction fields are missing");
assert(published.definition.unknownDocumentRoute === "review_required" &&
  published.definition.ambiguityRoute === "review_required", "fail-closed routing boundary drifted");

snapshot = await getJson<OpsClassificationProfileSnapshot>(owner, "/v1/ops/classification-profile");
const passing = snapshot.evaluationRuns.find((run) => run.definitionHash === published?.definitionHash && run.status === "passed");
assert(passing, "exact-hash passing evaluation evidence is missing");
assert(passing.result.providerCall === false && passing.result.persistedDocuments === false,
  "evaluation safety evidence is incomplete");
assert(published.differencesFromPublished.length === 0,
  "current published profile should not report differences from itself");

const databaseEvidence = await classificationEvidence(pool, published.id, published.definitionHash);
assert(databaseEvidence.documentTypeActive, "published label was not synchronized to the runtime catalog");
assert(databaseEvidence.fieldCount >= 2, "published extraction schema was not synchronized");
assert(databaseEvidence.profileMetadataPinned, "runtime policy metadata does not pin the published profile");
assert(databaseEvidence.attemptProfileColumns, "classification attempts cannot record exact profile provenance");

const finalCounts = await operationalCounts(pool);
assert(finalCounts.subjects === baseline.subjects && finalCounts.cases === baseline.cases &&
  finalCounts.documents === baseline.documents && finalCounts.attempts === baseline.attempts,
"classification policy evaluation persisted an operational record");
assert(finalCounts.externalSends === baseline.externalSends, "classification governance emitted an external send event");
assert(finalCounts.rlsTables === finalCounts.publicTables && finalCounts.publicTables >= 39, "RLS coverage is incomplete");
await pool.end();

console.log(JSON.stringify({
  verification: "passed",
  currentVersion: `${published.version}.${published.revision}`,
  currentDefinitionHash: published.definitionHash,
  governedLabels: published.definition.labels.length,
  crossIndustryLabel: newLabelCode,
  extractionFields: newLabel.extractionFields.map((field) => field.key),
  passingEvaluationCases: `${passing.result.passedCases}/${passing.result.totalCases}`,
  providerCalls: 0,
  operationalRecordsCreated: {
    subjects: finalCounts.subjects - baseline.subjects, cases: finalCounts.cases - baseline.cases,
    documents: finalCounts.documents - baseline.documents, attempts: finalCounts.attempts - baseline.attempts,
  },
  externalMessagesSent: finalCounts.externalSends - baseline.externalSends,
  managerCatalog: "read_only", staffCatalog: "forbidden", rls: `${finalCounts.rlsTables}/${finalCounts.publicTables}`,
}));

function extendedDefinition(source: ClassificationProfileDefinition): ClassificationProfileDefinition {
  const copy = structuredClone(source);
  copy.labels.push({
    code: newLabelCode,
    displayName: "Compliance Certificate",
    description: "Reusable certificate classification for regulated, legal, property and insurance document operations.",
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
    extractionFields: [
      { key: "certificate_number", displayName: "Certificate number", valueType: "string", required: true },
      { key: "issuer_name", displayName: "Issuer name", valueType: "string", required: true },
      { key: "expiry_date", displayName: "Expiry date", valueType: "date", required: false },
    ],
    policy: { minimumConfidence: 0.86, alwaysHumanConfirm: false, manualOnConflict: true,
      rejectOnQualityFlags: ["blurry", "blank", "corrupt", "partial", "password_protected", "unsupported", "mime_mismatch", "other"],
      rejectOnConflictFlags: ["subject_conflict", "period_conflict", "document_type_conflict", "duplicate_suspected", "other"] },
  });
  copy.evaluationCases = [
    { caseKey: "m18.compliance.accepted", displayName: "Clean compliance certificate", synthetic: true,
      filename: "synthetic-compliance-certificate.pdf", mimeType: "application/pdf", predictedLabelCode: newLabelCode,
      ambiguousLabelCodes: [], confidence: 0.98, qualityFlags: [], conflictFlags: [], expectedRoute: "accepted" },
    { caseKey: "m18.compliance.low-confidence", displayName: "Low-confidence compliance certificate", synthetic: true,
      filename: "synthetic-low-confidence.pdf", mimeType: "application/pdf", predictedLabelCode: newLabelCode,
      ambiguousLabelCodes: [], confidence: 0.4, qualityFlags: [], conflictFlags: [], expectedRoute: "review_required" },
    { caseKey: "m18.unknown", displayName: "Unknown synthetic document", synthetic: true,
      filename: "synthetic-unknown.bin", mimeType: "application/octet-stream", predictedLabelCode: "__unknown__",
      ambiguousLabelCodes: [], confidence: 0.96, qualityFlags: [], conflictFlags: [], expectedRoute: "review_required" },
    { caseKey: "m18.compliance.blurry", displayName: "Blurry compliance certificate", synthetic: true,
      filename: "synthetic-blurry-certificate.jpg", mimeType: "image/jpeg", predictedLabelCode: newLabelCode,
      ambiguousLabelCodes: [], confidence: 0.92, qualityFlags: ["blurry"], conflictFlags: [], expectedRoute: "review_required" },
  ];
  return copy;
}

async function classificationEvidence(pool: Pool, versionId: string, definitionHash: string): Promise<{
  documentTypeActive: boolean; fieldCount: number; profileMetadataPinned: boolean; attemptProfileColumns: boolean;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", ["dev-accounting-firm"]);
    assert(context.rows[0]?.id, "DEV organization context was not established");
    const result = await client.query<{ status: string; field_count: number; profile_version_id: string; profile_hash: string;
      attempt_profile_columns: boolean }>(`
      SELECT document_type.status,
             (SELECT count(*)::int
                FROM jsonb_object_keys(COALESCE(document_type.extraction_schema->'properties', '{}'::jsonb))) AS field_count,
             document_type.classification_rules->>'classification_profile_version_id' AS profile_version_id,
             document_type.classification_rules->>'classification_profile_definition_hash' AS profile_hash,
             (SELECT count(*)=2 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='classification_attempts'
                 AND column_name IN ('classification_profile_version_id','classification_profile_definition_hash')) AS attempt_profile_columns
        FROM document_types document_type
       WHERE document_type.code=$1`, [newLabelCode]);
    await client.query("ROLLBACK");
    const row = result.rows[0];
    assert(row, "published runtime document type is missing");
    return { documentTypeActive: row.status === "active", fieldCount: Number(row.field_count),
      profileMetadataPinned: row.profile_version_id === versionId && row.profile_hash === definitionHash,
      attemptProfileColumns: row.attempt_profile_columns };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined); throw error;
  } finally { client.release(); }
}

async function operationalCounts(pool: Pool): Promise<{ subjects: number; cases: number; documents: number; attempts: number;
  externalSends: number; publicTables: number; rlsTables: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", ["dev-accounting-firm"]);
    assert(context.rows[0]?.id, "DEV organization context was not established");
    const result = await client.query<{ subjects: number; cases: number; documents: number; attempts: number;
      external_sends: number; public_tables: number; rls_tables: number }>(`
      SELECT (SELECT count(*)::int FROM subjects) AS subjects,
             (SELECT count(*)::int FROM cases) AS cases,
             (SELECT count(*)::int FROM documents) AS documents,
             (SELECT count(*)::int FROM classification_attempts) AS attempts,
             (SELECT count(*)::int FROM workflow_events WHERE event_type ILIKE '%sent%') AS external_sends,
             (SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'pg_%') AS public_tables,
             (SELECT count(*)::int FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
               WHERE namespace.nspname='public' AND class.relkind='r' AND class.relrowsecurity) AS rls_tables`);
    await client.query("ROLLBACK");
    const row = result.rows[0]; assert(row, "operational invariant query returned no row");
    return { subjects: row.subjects, cases: row.cases, documents: row.documents, attempts: row.attempts,
      externalSends: row.external_sends, publicTables: row.public_tables, rlsTables: row.rls_tables };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined); throw error;
  } finally { client.release(); }
}

async function versionById(session: Session, id: string): Promise<OpsClassificationProfileVersion> {
  const snapshot = await getJson<OpsClassificationProfileSnapshot>(session, "/v1/ops/classification-profile");
  const version = snapshot.versions.find((item) => item.id === id);
  assert(version, `classification profile version ${id} is missing`);
  return version;
}
function latest(versions: OpsClassificationProfileVersion[]): OpsClassificationProfileVersion | undefined {
  return [...versions].sort((left, right) => right.version-left.version || right.revision-left.revision)[0];
}
async function login(email: string, password: string): Promise<Session> {
  const response = await fetch(`${opsUrl}/v1/ops/session`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }) });
  assertStatus(response, 200, `login for ${email}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]; assert(cookie, "login did not return a session cookie");
  const overview = await fetch(`${opsUrl}/v1/ops/overview`, { headers: { cookie } }); assertStatus(overview, 200, "overview after login");
  const body = await overview.json() as JsonRecord;
  return { cookie, csrfToken: requiredString(body.csrfToken, "csrf token") };
}
async function getJson<T>(session: Session, path: string): Promise<T> {
  const response = await fetch(`${opsUrl}${path}`, { headers: { cookie: session.cookie } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${JSON.stringify(result)}`);
  return result as T;
}
async function postJson(session: Session, path: string, body: unknown): Promise<JsonRecord> {
  const response = await fetch(`${opsUrl}${path}`, { method: "POST", headers: mutationHeaders(session), body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
function mutationHeaders(session: Session): Record<string, string> {
  return { cookie: session.cookie, origin, "content-type": "application/json", "x-dop-csrf": session.csrfToken };
}
function assertStatus(response: Response, expected: number, label: string): void {
  if (response.status !== expected) throw new Error(`${label} returned ${response.status}, expected ${expected}`);
}
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`); return value;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is missing`); return value;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
