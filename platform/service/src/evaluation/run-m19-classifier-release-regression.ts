import { createHash } from "node:crypto";
import { Pool } from "pg";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";
import type {
  ClassifierReleaseDefinition,
  OpsClassifierReleaseSnapshot,
  OpsClassifierReleaseVersion,
} from "../ports/ops-classifier-release-repository.js";

interface Session { cookie: string; csrfToken: string }
type JsonRecord = Record<string, unknown>;

const opsUrl = required(process.env.DOP_M19_OPS_URL, "DOP_M19_OPS_URL").replace(/\/$/, "");
const origin = new URL(opsUrl).origin;
const releaseMarker = "M19_CLASSIFIER_RELEASE_GOVERNANCE";
const keys = {
  clone: "00000000-0000-4000-a190-000000000101",
  revise: "00000000-0000-4000-a190-000000000102",
  compatibility: "00000000-0000-4000-a190-000000000103",
  provider: "00000000-0000-4000-a190-000000000108",
  review: "00000000-0000-4000-a190-000000000105",
  publish: "00000000-0000-4000-a190-000000000106",
  managerMutation: "00000000-0000-4000-a190-000000000107",
};

const owner = await login(required(process.env.DOP_M19_OWNER_EMAIL, "DOP_M19_OWNER_EMAIL"),
  required(process.env.DOP_M19_OWNER_PASSWORD, "DOP_M19_OWNER_PASSWORD"));
const manager = await login(required(process.env.DOP_M19_MANAGER_EMAIL, "DOP_M19_MANAGER_EMAIL"),
  required(process.env.DOP_M19_MANAGER_PASSWORD, "DOP_M19_MANAGER_PASSWORD"));
const staff = await login(required(process.env.DOP_M19_STAFF_EMAIL, "DOP_M19_STAFF_EMAIL"),
  required(process.env.DOP_M19_STAFF_PASSWORD, "DOP_M19_STAFF_PASSWORD"));

assertStatus(await fetch(`${opsUrl}/v1/ops/classifier-releases`, { headers: { cookie: staff.cookie } }), 403,
  "staff classifier release catalog");
const managerSnapshot = await getJson<OpsClassifierReleaseSnapshot>(manager, "/v1/ops/classifier-releases");
assert(managerSnapshot.canManage === false, "manager unexpectedly received classifier release mutation rights");
const managerCurrent = managerSnapshot.versions.find((item) => item.isCurrentPublished);
assert(managerCurrent, "manager could not read the current classifier release");
assertStatus(await fetch(`${opsUrl}/v1/ops/classifier-releases/${managerCurrent.id}/clone`, {
  method: "POST", headers: mutationHeaders(manager), body: JSON.stringify({
    reason: "Manager must remain outside classifier release mutation rights.",
    idempotencyKey: keys.managerMutation,
  }),
}), 403, "manager classifier release mutation");

const pool = new Pool(postgresPoolConfig(required(process.env.DATABASE_URL, "DATABASE_URL"),
  required(process.env.DOP_M19_DATABASE_SSL_CA_PATH ?? process.env.DATABASE_SSL_CA_PATH,
    "DOP_M19_DATABASE_SSL_CA_PATH"), 1));
const baseline = await operationalEvidence(pool);

let snapshot = await getJson<OpsClassifierReleaseSnapshot>(owner, "/v1/ops/classifier-releases");
assert(snapshot.canManage, "owner did not receive classifier release mutation rights");
let published = snapshot.versions.find((item) => item.isCurrentPublished &&
  item.definition.promptInstructions.includes(releaseMarker));

if (!published) {
  const currentPublished = snapshot.versions.find((item) => item.isCurrentPublished);
  assert(currentPublished, "current classifier release is missing");
  let current = latest(snapshot.versions.filter((item) => item.releaseId === currentPublished.releaseId &&
    item.version > currentPublished.version));
  if (!current) {
    const cloned = await postJson(owner, `/v1/ops/classifier-releases/${currentPublished.id}/clone`, {
      reason: "Clone the immutable baseline to prove complete classifier release governance.",
      idempotencyKey: keys.clone,
    });
    current = await versionById(owner, requiredString(cloned.versionId, "cloned classifier release version id"));
  }
  if (current.status === "draft" && !current.definition.promptInstructions.includes(releaseMarker)) {
    const revised = await postJson(owner, `/v1/ops/classifier-releases/${current.id}/revisions`, {
      definition: evaluatedDefinition(current.definition),
      reason: "Bind an auditable Prompt revision and three compact cross-domain synthetic provider fixtures.",
      idempotencyKey: keys.revise,
    });
    current = await versionById(owner, requiredString(revised.versionId, "revised classifier release version id"));
  }
  assert(current.status === "draft" || current.status === "in_review", "classifier release is not publishable");
  if (current.status === "draft") {
    const compatibilityBody = {
      evaluationKind: "compatibility", reason: "Verify exact Prompt, response Schema and classification profile hashes without a provider call.",
      idempotencyKey: keys.compatibility,
    };
    const compatibility = await postJson(owner, `/v1/ops/classifier-releases/${current.id}/evaluations`, compatibilityBody);
    assert(["completed", "duplicate"].includes(String(compatibility.outcome)) && compatibility.status === "passed",
      "classifier release compatibility evaluation did not pass");
    assert((compatibility.result as JsonRecord | undefined)?.providerCallCount === 0,
      "compatibility evaluation unexpectedly called the provider");
    const duplicate = await postJson(owner, `/v1/ops/classifier-releases/${current.id}/evaluations`, compatibilityBody);
    assert(duplicate.outcome === "duplicate" && duplicate.status === "passed",
      "compatibility evaluation retry was not idempotent");

    const providerBody = {
      evaluationKind: "provider", reason: "Run the exact release against three synthetic text fixtures with no operational persistence.",
      idempotencyKey: keys.provider,
    };
    const provider = await postJson(owner, `/v1/ops/classifier-releases/${current.id}/evaluations`, providerBody);
    assert(["queued", "duplicate"].includes(String(provider.outcome)), "provider evaluation was not queued idempotently");
    await waitForProviderEvaluation(owner, current.definitionHash);
    current = await versionById(owner, current.id);
    const reviewed = await postJson(owner, `/v1/ops/classifier-releases/${current.id}/transitions`, {
      action: "submit_review", reason: "Submit the exact definition hash after compatibility and provider evaluations both passed.",
      idempotencyKey: keys.review,
    });
    current = await versionById(owner, requiredString(reviewed.versionId, "review classifier release version id"));
  }
  assert(current.status === "in_review", "classifier release did not enter review");
  const result = await postJson(owner, `/v1/ops/classifier-releases/${current.id}/transitions`, {
    action: "publish", reason: "Publish the reviewed M19 release for future Cases while preserving every existing Case pin.",
    idempotencyKey: keys.publish,
  });
  published = await versionById(owner, requiredString(result.versionId, "published classifier release version id"));
}

assert(published.isCurrentPublished && published.status === "published", "M19 classifier release is not current published");
snapshot = await getJson<OpsClassifierReleaseSnapshot>(owner, "/v1/ops/classifier-releases");
const compatibility = snapshot.evaluationRuns.find((run) => run.definitionHash === published?.definitionHash &&
  run.evaluationKind === "compatibility" && run.status === "passed");
const provider = snapshot.evaluationRuns.find((run) => run.definitionHash === published?.definitionHash &&
  run.evaluationKind === "provider" && run.status === "passed");
assert(compatibility && provider, "exact-hash passing evaluation evidence is incomplete");
assert(provider.result.persistedDocuments === false && provider.result.externalDelivery === "disabled",
  "provider evaluation safety evidence is incomplete");
assert(provider.result.providerCallCount === 3 && provider.result.totalCases === 3 && provider.result.passedCases === 3,
  "provider evaluation did not pass exactly three synthetic fixtures");

const finalEvidence = await operationalEvidence(pool, published.id, published.promptVersionId);
assert(finalEvidence.subjects === baseline.subjects && finalEvidence.cases === baseline.cases &&
  finalEvidence.documents === baseline.documents && finalEvidence.attempts === baseline.attempts,
"classifier release evaluation persisted an operational record");
assert(finalEvidence.externalSends === baseline.externalSends, "classifier release governance emitted an external send event");
assert(finalEvidence.existingCasesStillPinned && finalEvidence.futureCasePinsCurrent,
  "immutable existing-Case or future-Case release pinning failed");
assert(finalEvidence.attemptReleaseColumns, "classification attempts cannot record exact release provenance");
assert(finalEvidence.rlsTables === finalEvidence.publicTables && finalEvidence.publicTables >= 42, "RLS coverage is incomplete");
await pool.end();

console.log(JSON.stringify({
  verification: "passed",
  currentVersion: `${published.version}.${published.revision}`,
  currentDefinitionHash: published.definitionHash,
  promptVersionId: published.promptVersionId,
  promptInstructionHash: published.definition.promptInstructionHash,
  responseSchemaHash: published.definition.responseSchemaHash,
  classificationProfileVersionId: published.definition.classificationProfileVersionId,
  configuredModel: published.definition.model,
  resolvedModels: provider.result.resolvedModels,
  providerEvaluationCases: `${provider.result.passedCases}/${provider.result.totalCases}`,
  providerCalls: provider.result.providerCallCount,
  inputTokens: provider.result.inputTokens,
  outputTokens: provider.result.outputTokens,
  existingCasesPreserved: finalEvidence.existingCasesStillPinned,
  futureCasesUseCurrent: finalEvidence.futureCasePinsCurrent,
  operationalRecordsCreated: {
    subjects: finalEvidence.subjects-baseline.subjects, cases: finalEvidence.cases-baseline.cases,
    documents: finalEvidence.documents-baseline.documents, attempts: finalEvidence.attempts-baseline.attempts,
  },
  externalMessagesSent: finalEvidence.externalSends-baseline.externalSends,
  managerCatalog: "read_only", staffCatalog: "forbidden", rls: `${finalEvidence.rlsTables}/${finalEvidence.publicTables}`,
}));

function evaluatedDefinition(source: ClassifierReleaseDefinition): ClassifierReleaseDefinition {
  const promptInstructions = `${source.promptInstructions.trimEnd()}\n\n${releaseMarker}: Treat synthetic plaintext fixtures as extracted document text. Continue to choose only an allowed document type code and keep all evidence grounded in the supplied text.\n`;
  return {
    ...structuredClone(source),
    promptInstructions,
    promptInstructionHash: createHash("sha256").update(promptInstructions).digest("hex"),
    providerEvaluationCases: [
      { caseKey: "m19.bank-statement", displayName: "Synthetic bank statement", synthetic: true,
        inputText: "SYNTHETIC DEV BANK STATEMENT. Account holder: Kauri Test Limited. Statement period: July 2026. Opening balance NZD 4,250.00. Transactions include deposits and card payments. Closing balance NZD 5,105.40.",
        filename: "synthetic-bank-statement.txt", mimeType: "text/plain", expectedLabelCode: "bank_statement", minimumConfidence: 0.65 },
      { caseKey: "m19.invoice", displayName: "Synthetic supplier invoice", synthetic: true,
        inputText: "SYNTHETIC DEV TAX INVOICE. Invoice number INV-TEST-204. Supplier: Fictional Harbour Supplies. Subtotal NZD 800.00, GST NZD 120.00, total amount due NZD 920.00. Payment due 20 August 2026.",
        filename: "synthetic-invoice.txt", mimeType: "text/plain", expectedLabelCode: "invoice", minimumConfidence: 0.65 },
      { caseKey: "m19.compliance-certificate", displayName: "Synthetic compliance certificate", synthetic: true,
        inputText: "SYNTHETIC DEV COMPLIANCE CERTIFICATE. Certificate number CERT-TEST-88. Issuer: Fictional Standards Authority. This certifies compliance with the stated safety standard. Expiry date: 31 December 2027.",
        filename: "synthetic-compliance-certificate.txt", mimeType: "text/plain", expectedLabelCode: "compliance_certificate", minimumConfidence: 0.65 },
    ],
  };
}

async function waitForProviderEvaluation(session: Session, definitionHash: string): Promise<void> {
  for (let attempt=0; attempt<120; attempt+=1) {
    const current = await getJson<OpsClassifierReleaseSnapshot>(session, "/v1/ops/classifier-releases");
    const run = current.evaluationRuns.find((item) => item.definitionHash===definitionHash && item.evaluationKind==="provider");
    if (run?.status === "passed") return;
    if (run?.status === "failed") throw new Error(`provider evaluation failed: ${JSON.stringify(run.result)}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("provider evaluation did not reach a terminal state within four minutes");
}

async function operationalEvidence(pool: Pool, currentReleaseVersionId?: string, promptVersionId?: string | null): Promise<{
  subjects: number; cases: number; documents: number; attempts: number; externalSends: number;
  publicTables: number; rlsTables: number; existingCasesStillPinned: boolean;
  futureCasePinsCurrent: boolean; attemptReleaseColumns: boolean;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", ["dev-accounting-firm"]);
    assert(context.rows[0]?.id, "DEV organization context was not established");
    const result = await client.query<{ subjects: number; cases: number; documents: number; attempts: number;
      external_sends: number; public_tables: number; rls_tables: number; attempt_release_columns: boolean }>(`
      SELECT (SELECT count(*)::int FROM subjects) AS subjects,
             (SELECT count(*)::int FROM cases) AS cases,
             (SELECT count(*)::int FROM documents) AS documents,
             (SELECT count(*)::int FROM classification_attempts) AS attempts,
             (SELECT count(*)::int FROM workflow_events WHERE event_type ILIKE '%sent%') AS external_sends,
             (SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'pg_%') AS public_tables,
             (SELECT count(*)::int FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
               WHERE namespace.nspname='public' AND class.relkind='r' AND class.relrowsecurity) AS rls_tables,
             (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public'
               AND table_name='classification_attempts' AND column_name IN
               ('classifier_release_version_id','classifier_release_definition_hash')) AS attempt_release_columns`);
    const row = result.rows[0]; assert(row, "operational invariant query returned no row");
    let existingCasesStillPinned = true;
    let futureCasePinsCurrent = true;
    if (currentReleaseVersionId) {
      const existing = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM cases WHERE classifier_release_version_id=$1", [currentReleaseVersionId]);
      existingCasesStillPinned = Number(existing.rows[0]?.count ?? 0) === 0;
      const future = await client.query<{ current_version_id: string; current_prompt_version_id: string | null;
        trigger_enabled: boolean }>(`
        SELECT release.current_published_version_id::text AS current_version_id,
               version.prompt_version_id::text AS current_prompt_version_id,
               EXISTS (
                 SELECT 1 FROM pg_trigger trigger
                 JOIN pg_class relation ON relation.oid=trigger.tgrelid
                 JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
                 WHERE namespace.nspname='public' AND relation.relname='cases'
                   AND trigger.tgname='pin_current_classifier_release_before_case_insert'
                   AND NOT trigger.tgisinternal AND trigger.tgenabled<>'D'
               ) AS trigger_enabled
          FROM classifier_releases release
          JOIN classifier_release_versions version ON version.id=release.current_published_version_id
         WHERE release.organization_id=(SELECT id FROM organizations WHERE organization_key='dev-accounting-firm')
           AND release.status='active' LIMIT 1`);
      futureCasePinsCurrent = future.rows[0]?.current_version_id===currentReleaseVersionId &&
        future.rows[0]?.current_prompt_version_id===promptVersionId && future.rows[0]?.trigger_enabled===true;
    }
    await client.query("ROLLBACK");
    return { subjects: row.subjects, cases: row.cases, documents: row.documents, attempts: row.attempts,
      externalSends: row.external_sends, publicTables: row.public_tables, rlsTables: row.rls_tables,
      existingCasesStillPinned, futureCasePinsCurrent, attemptReleaseColumns: row.attempt_release_columns };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined); throw error;
  } finally { client.release(); }
}

async function versionById(session: Session, id: string): Promise<OpsClassifierReleaseVersion> {
  const snapshot = await getJson<OpsClassifierReleaseSnapshot>(session, "/v1/ops/classifier-releases");
  const version = snapshot.versions.find((item) => item.id === id);
  assert(version, `classifier release version ${id} is missing`);
  return version;
}
function latest(versions: OpsClassifierReleaseVersion[]): OpsClassifierReleaseVersion | undefined {
  return [...versions].sort((left,right) => right.version-left.version || right.revision-left.revision)[0];
}
async function login(email: string, password: string): Promise<Session> {
  const response = await fetch(`${opsUrl}/v1/ops/session`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email,password }) });
  assertStatus(response,200,`login for ${email}`);
  const cookie=response.headers.get("set-cookie")?.split(";",1)[0]; assert(cookie,"login did not return a session cookie");
  const overview=await fetch(`${opsUrl}/v1/ops/overview`,{headers:{cookie}}); assertStatus(overview,200,"overview after login");
  const body=await overview.json() as JsonRecord;
  return {cookie,csrfToken:requiredString(body.csrfToken,"csrf token")};
}
async function getJson<T>(session: Session,path: string): Promise<T> {
  const response=await fetch(`${opsUrl}${path}`,{headers:{cookie:session.cookie}}); const result=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${JSON.stringify(result)}`); return result as T;
}
async function postJson(session: Session,path: string,body: unknown): Promise<JsonRecord> {
  const response=await fetch(`${opsUrl}${path}`,{method:"POST",headers:mutationHeaders(session),body:JSON.stringify(body)});
  const result=await response.json().catch(()=>({})) as JsonRecord;
  if (!response.ok) throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(result)}`); return result;
}
function mutationHeaders(session: Session): Record<string,string> {
  return {cookie:session.cookie,origin,"content-type":"application/json","x-dop-csrf":session.csrfToken};
}
function assertStatus(response: Response,expected: number,label: string): void {
  if (response.status!==expected) throw new Error(`${label} returned ${response.status}, expected ${expected}`);
}
function required(value: string|undefined,name: string): string { if (!value) throw new Error(`${name} is required`); return value; }
function requiredString(value: unknown,name: string): string { if (typeof value!=="string" || !value) throw new Error(`${name} is missing`); return value; }
function assert(condition: unknown,message: string): asserts condition { if (!condition) throw new Error(message); }
