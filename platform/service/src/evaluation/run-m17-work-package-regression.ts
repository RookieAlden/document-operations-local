import { Pool } from "pg";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";
import type {
  OpsWorkPackageSnapshot,
  OpsWorkPackageVersion,
  WorkPackageBlueprint,
} from "../ports/ops-work-package-repository.js";

interface Session { cookie: string; csrfToken: string }
type JsonRecord = Record<string, unknown>;

const opsUrl = required(process.env.DOP_M17_OPS_URL, "DOP_M17_OPS_URL").replace(/\/$/, "");
const origin = new URL(opsUrl).origin;
const mainPackageKey = "m17-generic-document-operations";
const retirePackageKey = "m17-retirement-probe";
const keys = {
  createMain: "00000000-0000-4000-a170-000000000101",
  reviseV1: "00000000-0000-4000-a170-000000000102",
  dryRunV1: "00000000-0000-4000-a170-000000000103",
  reviewV1: "00000000-0000-4000-a170-000000000104",
  publishV1: "00000000-0000-4000-a170-000000000105",
  cloneV2: "00000000-0000-4000-a170-000000000106",
  reviseV2: "00000000-0000-4000-a170-000000000107",
  dryRunV2: "00000000-0000-4000-a170-000000000108",
  reviewV2: "00000000-0000-4000-a170-000000000109",
  publishV2: "00000000-0000-4000-a170-000000000110",
  managerMutation: "00000000-0000-4000-a170-000000000111",
  invalidDryRun: "00000000-0000-4000-a170-000000000112",
  createRetire: "00000000-0000-4000-a170-000000000113",
  dryRunRetire: "00000000-0000-4000-a170-000000000114",
  reviewRetire: "00000000-0000-4000-a170-000000000115",
  publishRetire: "00000000-0000-4000-a170-000000000116",
  retire: "00000000-0000-4000-a170-000000000117",
};

const owner = await login(
  required(process.env.DOP_M17_OWNER_EMAIL, "DOP_M17_OWNER_EMAIL"),
  required(process.env.DOP_M17_OWNER_PASSWORD, "DOP_M17_OWNER_PASSWORD"),
);
const manager = await login(
  required(process.env.DOP_M17_MANAGER_EMAIL, "DOP_M17_MANAGER_EMAIL"),
  required(process.env.DOP_M17_MANAGER_PASSWORD, "DOP_M17_MANAGER_PASSWORD"),
);
const staff = await login(
  required(process.env.DOP_M17_STAFF_EMAIL, "DOP_M17_STAFF_EMAIL"),
  required(process.env.DOP_M17_STAFF_PASSWORD, "DOP_M17_STAFF_PASSWORD"),
);

assertStatus(await fetch(`${opsUrl}/v1/ops/work-packages`, { headers: { cookie: staff.cookie } }), 403, "staff Work Package catalog");
const managerSnapshot = await getJson<OpsWorkPackageSnapshot>(manager, "/v1/ops/work-packages");
assert(managerSnapshot.canManage === false, "manager unexpectedly received Work Package mutation rights");
assertStatus(await fetch(`${opsUrl}/v1/ops/work-packages`, {
  method: "POST",
  headers: mutationHeaders(manager),
  body: JSON.stringify({ idempotencyKey: keys.managerMutation }),
}), 403, "manager Work Package mutation");

const pool = new Pool(postgresPoolConfig(
  required(process.env.DATABASE_URL, "DATABASE_URL"),
  required(process.env.DOP_M17_DATABASE_SSL_CA_PATH ?? process.env.DATABASE_SSL_CA_PATH, "DOP_M17_DATABASE_SSL_CA_PATH"),
  1,
));
const baseline = await operationalCounts(pool);

let snapshot = await getJson<OpsWorkPackageSnapshot>(owner, "/v1/ops/work-packages");
assert(snapshot.canManage, "owner did not receive Work Package mutation rights");
const seed = snapshot.versions.find((item) => item.isCurrentPublished && item.packageStatus === "active"
  && item.packageKey !== mainPackageKey && item.packageKey !== retirePackageKey);
assert(seed, "no active published seed Work Package is available");

const initialBlueprint = structuredClone(seed.blueprint);
const createMainBody = {
  packageKey: mainPackageKey,
  displayName: "Generic document operations",
  description: "Reusable DEV work package for classification-oriented document operations across subject types.",
  industryPackage: "cross-industry",
  workflowTemplateId: seed.workflowTemplateId,
  blueprint: initialBlueprint,
  reason: "Create the reusable M17 Work Package under controlled DEV-only governance.",
  idempotencyKey: keys.createMain,
};
const mainCreated = await postJson(owner, "/v1/ops/work-packages", createMainBody);
assert(["completed", "duplicate"].includes(String(mainCreated.outcome)), "main Work Package creation did not complete");
const mainDuplicate = await postJson(owner, "/v1/ops/work-packages", createMainBody);
assert(mainDuplicate.outcome === "duplicate", "main Work Package creation retry was not idempotent");

snapshot = await getJson<OpsWorkPackageSnapshot>(owner, "/v1/ops/work-packages");
let mainVersions = packageVersions(snapshot, mainPackageKey);
assert(mainVersions.length >= 1, "main Work Package version history is missing");

let publishedV1 = mainVersions.find((item) => item.version === 1 && item.status === "published");
if (!publishedV1) {
  let current = latest(mainVersions.filter((item) => item.version === 1));
  assert(current, "main Work Package v1 is missing");
  if (current.status === "draft" && current.revision === 1) {
    const revised = await postJson(owner, `/v1/ops/work-packages/${current.id}/revisions`, {
      displayName: "Generic document operations",
      description: "Reusable DEV work package for classification-oriented document operations across subject types.",
      industryPackage: "cross-industry",
      workflowTemplateId: current.workflowTemplateId,
      blueprint: reviseBlueprint(current.blueprint, "on_demand", "v1-r2", 1),
      reason: "Record an append-only v1 revision before dry-run and controlled publication.",
      idempotencyKey: keys.reviseV1,
    });
    current = await versionById(owner, requiredString(revised.versionId, "v1 revised version id"));
  }
  assert(current.status === "draft" || current.status === "in_review", "main Work Package v1 is not publishable");
  if (current.status === "draft") {
    await assertDryRun(owner, current, keys.dryRunV1, "m17-v1-synthetic", true);
    const reviewed = await postJson(owner, `/v1/ops/work-packages/${current.id}/transitions`, {
      action: "submit_review",
      reason: "Review the passing M17 v1 synthetic evidence before publication.",
      idempotencyKey: keys.reviewV1,
    });
    current = await versionById(owner, requiredString(reviewed.versionId, "v1 review version id"));
  }
  assert(current.status === "in_review", "main Work Package v1 did not enter review");
  const published = await postJson(owner, `/v1/ops/work-packages/${current.id}/transitions`, {
    action: "publish",
    reason: "Publish reviewed M17 v1 while external delivery remains disabled.",
    idempotencyKey: keys.publishV1,
  });
  publishedV1 = await versionById(owner, requiredString(published.versionId, "v1 published version id"));
}
assert(publishedV1.status === "published", "main Work Package v1 was not published");

snapshot = await getJson<OpsWorkPackageSnapshot>(owner, "/v1/ops/work-packages");
mainVersions = packageVersions(snapshot, mainPackageKey);
let publishedV2 = mainVersions.find((item) => item.version === 2 && item.status === "published");
if (!publishedV2) {
  let current = latest(mainVersions.filter((item) => item.version === 2));
  if (!current) {
    const cloned = await postJson(owner, `/v1/ops/work-packages/${publishedV1.id}/clone`, {
      reason: "Clone current M17 v1 into a new append-only version for a reusable classification change.",
      idempotencyKey: keys.cloneV2,
    });
    current = await versionById(owner, requiredString(cloned.versionId, "v2 clone version id"));
  }
  if (current.status === "draft" && current.revision === 1) {
    const revised = await postJson(owner, `/v1/ops/work-packages/${current.id}/revisions`, {
      displayName: "Generic document operations",
      description: "Reusable DEV work package for classification-oriented document operations across subject types.",
      industryPackage: "cross-industry",
      workflowTemplateId: current.workflowTemplateId,
      blueprint: reviseBlueprint(current.blueprint, "event_based", "v2-r2", 2),
      reason: "Revise M17 v2 to prove structured changes produce a visible version difference.",
      idempotencyKey: keys.reviseV2,
    });
    current = await versionById(owner, requiredString(revised.versionId, "v2 revised version id"));
  }
  assert(current.status === "draft" || current.status === "in_review", "main Work Package v2 is not publishable");
  if (current.status === "draft") {
    await assertDryRun(owner, current, keys.dryRunV2, "m17-v2-synthetic", false);
    const reviewed = await postJson(owner, `/v1/ops/work-packages/${current.id}/transitions`, {
      action: "submit_review",
      reason: "Review the exact M17 v2 definition hash and synthetic evidence before publication.",
      idempotencyKey: keys.reviewV2,
    });
    current = await versionById(owner, requiredString(reviewed.versionId, "v2 review version id"));
  }
  const published = await postJson(owner, `/v1/ops/work-packages/${current.id}/transitions`, {
    action: "publish",
    reason: "Publish reviewed M17 v2 while retaining the DEV and allowlist-only safety boundary.",
    idempotencyKey: keys.publishV2,
  });
  publishedV2 = await versionById(owner, requiredString(published.versionId, "v2 published version id"));
}
assert(publishedV2.status === "published" && publishedV2.isCurrentPublished, "main Work Package v2 is not current published");

assertStatus(await fetch(`${opsUrl}/v1/ops/work-packages/${publishedV2.id}/dry-runs`, {
  method: "POST",
  headers: mutationHeaders(owner),
  body: JSON.stringify({
    syntheticSample: { subjectKey: "m17-not-synthetic", displayName: "Unsafe sample", subjectType: "test_subject", attributes: { synthetic: false } },
    reason: "Reject a sample that is not explicitly marked synthetic.",
    idempotencyKey: keys.invalidDryRun,
  }),
}), 400, "non-synthetic Work Package dry-run");

snapshot = await getJson<OpsWorkPackageSnapshot>(owner, "/v1/ops/work-packages");
const retireSeed = snapshot.versions.find((item) => item.packageKey === retirePackageKey);
if (!retireSeed) {
  await postJson(owner, "/v1/ops/work-packages", {
    packageKey: retirePackageKey,
    displayName: "M17 retirement probe",
    description: "Disposable synthetic Work Package used only to prove controlled retirement behavior.",
    industryPackage: "cross-industry",
    workflowTemplateId: seed.workflowTemplateId,
    blueprint: reviseBlueprint(seed.blueprint, "on_demand", "retirement-probe", 1),
    reason: "Create a disposable M17 package for the retirement governance regression.",
    idempotencyKey: keys.createRetire,
  });
}
snapshot = await getJson<OpsWorkPackageSnapshot>(owner, "/v1/ops/work-packages");
let retireVersions = packageVersions(snapshot, retirePackageKey);
let retireCurrent = latest(retireVersions);
assert(retireCurrent, "retirement probe version is missing");
if (retireCurrent.packageStatus === "active" && retireCurrent.status === "draft") {
  await assertDryRun(owner, retireCurrent, keys.dryRunRetire, "m17-retire-synthetic", false);
  const reviewed = await postJson(owner, `/v1/ops/work-packages/${retireCurrent.id}/transitions`, {
    action: "submit_review",
    reason: "Review the retirement probe before its temporary controlled publication.",
    idempotencyKey: keys.reviewRetire,
  });
  retireCurrent = await versionById(owner, requiredString(reviewed.versionId, "retirement review version id"));
}
if (retireCurrent.packageStatus === "active" && retireCurrent.status === "in_review") {
  const published = await postJson(owner, `/v1/ops/work-packages/${retireCurrent.id}/transitions`, {
    action: "publish",
    reason: "Temporarily publish the synthetic retirement probe without enabling delivery.",
    idempotencyKey: keys.publishRetire,
  });
  retireCurrent = await versionById(owner, requiredString(published.versionId, "retirement published version id"));
}
if (retireCurrent.packageStatus === "active") {
  const retired = await postJson(owner, `/v1/ops/work-packages/${retireCurrent.packageId}/retire`, {
    reason: "Retire the disposable M17 probe and remove it from future onboarding choices.",
    idempotencyKey: keys.retire,
  });
  retireCurrent = await versionById(owner, requiredString(retired.versionId, "retired version id"));
}
assert(retireCurrent.status === "retired" && retireCurrent.packageStatus === "retired", "retirement probe remains active");

snapshot = await getJson<OpsWorkPackageSnapshot>(owner, "/v1/ops/work-packages");
mainVersions = packageVersions(snapshot, mainPackageKey);
publishedV1 = mainVersions.find((item) => item.version === 1 && item.status === "published");
publishedV2 = mainVersions.find((item) => item.version === 2 && item.status === "published");
assert(publishedV1 && publishedV2?.isCurrentPublished, "published Work Package history is incomplete");
assert(mainVersions.length >= 8, "append-only Work Package history did not retain all revisions");
assert(publishedV1.differencesFromPublished.some((difference) => difference.path.includes("frequency")
  || difference.path.includes("minimumCount") || difference.path.includes("m17_revision_marker")),
"v1-to-v2 Work Package differences were not exposed");
assert(snapshot.dryRuns.filter((item) => item.packageId === publishedV2?.packageId && item.status === "passed").length >= 2,
  "main Work Package passing dry-run evidence is incomplete");

const onboarding = await getJson<{ packages: { packageKey: string; id: string }[] }>(owner, "/v1/ops/onboarding");
assert(onboarding.packages.some((item) => item.packageKey === mainPackageKey && item.id === publishedV2?.id),
  "onboarding catalog does not expose only the current M17 published version");
assert(!onboarding.packages.some((item) => item.packageKey === retirePackageKey),
  "retired Work Package remains available for onboarding");

const finalCounts = await operationalCounts(pool);
assert(finalCounts.subjects === baseline.subjects && finalCounts.cases === baseline.cases,
  "Work Package dry-runs persisted a Subject or Case");
assert(finalCounts.externalSends === baseline.externalSends, "Work Package governance emitted an external send event");
assert(finalCounts.rlsTables === finalCounts.publicTables && finalCounts.publicTables >= 36, "RLS coverage is incomplete");
await pool.end();

console.log(JSON.stringify({
  verification: "passed",
  packageKey: mainPackageKey,
  currentVersion: `${publishedV2.version}.${publishedV2.revision}`,
  retainedHistoryRows: mainVersions.length,
  passingDryRuns: snapshot.dryRuns.filter((item) => item.packageId === publishedV2.packageId && item.status === "passed").length,
  managerCatalog: "read_only",
  staffCatalog: "forbidden",
  retirementProbe: "retired_and_removed_from_onboarding",
  subjectsCreatedByDryRun: finalCounts.subjects - baseline.subjects,
  casesCreatedByDryRun: finalCounts.cases - baseline.cases,
  externalMessagesSent: finalCounts.externalSends - baseline.externalSends,
  rls: `${finalCounts.rlsTables}/${finalCounts.publicTables}`,
}));

async function assertDryRun(session: Session, version: OpsWorkPackageVersion, idempotencyKey: string, subjectKey: string, assertDuplicate: boolean) {
  const body = {
    syntheticSample: {
      subjectKey,
      displayName: `Synthetic ${subjectKey}`,
      subjectType: "synthetic_subject",
      attributes: { synthetic: true, regression_probe: "m17" },
    },
    reason: `Run controlled synthetic evidence for ${subjectKey} without persisting operational records.`,
    idempotencyKey,
  };
  const result = await postJson(session, `/v1/ops/work-packages/${version.id}/dry-runs`, body);
  assert(["completed", "duplicate"].includes(String(result.outcome)) && result.status === "passed", `${subjectKey} dry-run did not pass`);
  if (assertDuplicate) {
    const duplicate = await postJson(session, `/v1/ops/work-packages/${version.id}/dry-runs`, body);
    assert(duplicate.outcome === "duplicate" && duplicate.status === "passed", `${subjectKey} dry-run retry was not idempotent`);
  }
}

function reviseBlueprint(source: WorkPackageBlueprint, frequency: string, marker: string, minimumCount: number): WorkPackageBlueprint {
  const copy = structuredClone(source);
  copy.subjectDefaults.attributes = {
    ...copy.subjectDefaults.attributes,
    synthetic_template: true,
    reusable_classification_package: true,
    m17_revision_marker: marker,
  };
  copy.workflow = { ...copy.workflow, frequency, m17_regression_probe: marker };
  copy.requirements = copy.requirements.map((item, index) => index === 0 ? {
    ...item,
    minimumCount,
    maximumCount: item.maximumCount === null ? null : Math.max(item.maximumCount, minimumCount),
    acceptanceRule: { ...item.acceptanceRule, m17_regression_probe: marker },
  } : item);
  return copy;
}

async function versionById(session: Session, id: string): Promise<OpsWorkPackageVersion> {
  const current = await getJson<OpsWorkPackageSnapshot>(session, "/v1/ops/work-packages");
  const version = current.versions.find((item) => item.id === id);
  assert(version, `Work Package version ${id} is missing`);
  return version;
}

function packageVersions(snapshot: OpsWorkPackageSnapshot, packageKey: string): OpsWorkPackageVersion[] {
  return snapshot.versions.filter((item) => item.packageKey === packageKey);
}

function latest(versions: OpsWorkPackageVersion[]): OpsWorkPackageVersion | undefined {
  return [...versions].sort((left, right) => right.version - left.version || right.revision - left.revision)[0];
}

async function operationalCounts(pool: Pool): Promise<{ subjects: number; cases: number; externalSends: number; publicTables: number; rlsTables: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", ["dev-accounting-firm"]);
    assert(context.rows[0]?.id, "DEV organization context was not established");
    const result = await client.query<{
      subjects: number; cases: number; external_sends: number; public_tables: number; rls_tables: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM subjects) AS subjects,
        (SELECT count(*)::int FROM cases) AS cases,
        (SELECT count(*)::int FROM workflow_events WHERE event_type ILIKE '%sent%') AS external_sends,
        (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'pg_%') AS public_tables,
        (SELECT count(*)::int FROM pg_class class JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
          WHERE namespace.nspname = 'public' AND class.relkind = 'r' AND class.relrowsecurity) AS rls_tables
    `);
    await client.query("ROLLBACK");
    const row = result.rows[0];
    assert(row, "operational invariant query returned no row");
    return { subjects: row.subjects, cases: row.cases, externalSends: row.external_sends, publicTables: row.public_tables, rlsTables: row.rls_tables };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function login(email: string, password: string): Promise<Session> {
  const response = await fetch(`${opsUrl}/v1/ops/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  assertStatus(response, 200, `login for ${email}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "login did not return a session cookie");
  const overview = await fetch(`${opsUrl}/v1/ops/overview`, { headers: { cookie } });
  assertStatus(overview, 200, "overview after login");
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
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is missing`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
