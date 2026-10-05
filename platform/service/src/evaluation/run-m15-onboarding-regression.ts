import { Pool } from "pg";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";
import type { OpsConfigurationSnapshot, WorkConfigurationRelease } from "../ports/ops-configuration-repository.js";
import type { OpsOnboardingSnapshot } from "../ports/ops-onboarding-repository.js";

interface Session { cookie: string; csrfToken: string }
type JsonRecord = Record<string, unknown>;

const opsUrl = required(process.env.DOP_M15_OPS_URL, "DOP_M15_OPS_URL").replace(/\/$/, "");
const origin = new URL(opsUrl).origin;
const subjectKey = "m15-rimu-design";
const subjectName = "Rimu Lane Design Limited";
const keys = {
  onboarding: "00000000-0000-4000-a150-000000000101",
  submitV1: "00000000-0000-4000-a150-000000000102",
  publishV1: "00000000-0000-4000-a150-000000000103",
  caseV1: "00000000-0000-4000-a150-000000000104",
  cloneV2: "00000000-0000-4000-a150-000000000105",
  updateV2: "00000000-0000-4000-a150-000000000106",
  submitV2: "00000000-0000-4000-a150-000000000107",
  publishV2: "00000000-0000-4000-a150-000000000108",
  caseV2: "00000000-0000-4000-a150-000000000109",
};

const owner = await login(required(process.env.DOP_M15_OWNER_EMAIL, "DOP_M15_OWNER_EMAIL"), required(process.env.DOP_M15_OWNER_PASSWORD, "DOP_M15_OWNER_PASSWORD"));
const manager = await login(required(process.env.DOP_M15_MANAGER_EMAIL, "DOP_M15_MANAGER_EMAIL"), required(process.env.DOP_M15_MANAGER_PASSWORD, "DOP_M15_MANAGER_PASSWORD"));
const staff = await login(required(process.env.DOP_M15_STAFF_EMAIL, "DOP_M15_STAFF_EMAIL"), required(process.env.DOP_M15_STAFF_PASSWORD, "DOP_M15_STAFF_PASSWORD"));

assertStatus(await fetch(`${opsUrl}/v1/ops/onboarding`, { headers: { cookie: manager.cookie } }), 403, "manager onboarding catalog");
assertStatus(await fetch(`${opsUrl}/v1/ops/onboarding`, { headers: { cookie: staff.cookie } }), 403, "staff onboarding catalog");
assertStatus(await fetch(`${opsUrl}/v1/ops/configurations`, { headers: { cookie: staff.cookie } }), 403, "staff configuration catalog");

const catalog = await getJson<OpsOnboardingSnapshot>(owner, "/v1/ops/onboarding");
const packageVersion = catalog.packages.find((item) => item.packageKey === "accounting.monthly.basic");
assert(packageVersion, "monthly onboarding package is missing");
assert(catalog.packages.length >= 2, "expected at least two published onboarding packages");

const onboardingBody = {
  packageVersionId: packageVersion.id,
  subjectKey,
  displayName: subjectName,
  subjectType: "accounting_client",
  primaryContactActorId: null,
  attributes: { synthetic: false, regression_probe: "m15" },
  reason: "Create the controlled M15 synthetic Subject and first configuration draft.",
  idempotencyKey: keys.onboarding,
};
const onboarded = await postJson(owner, "/v1/ops/onboarding/subjects", onboardingBody);
assert(["completed", "duplicate"].includes(String(onboarded.outcome)), "onboarding did not complete");
const onboardingDuplicate = await postJson(owner, "/v1/ops/onboarding/subjects", onboardingBody);
assert(onboardingDuplicate.outcome === "duplicate", "onboarding retry was not idempotent");

let configurations = await getJson<OpsConfigurationSnapshot>(owner, "/v1/ops/configurations");
let subjectReleases = releasesFor(configurations, subjectKey);
assert(subjectReleases.length >= 1, "onboarded Subject has no configuration draft");

let publishedV1 = subjectReleases.find((item) => item.releaseNumber === 1 && item.status === "published");
if (!publishedV1) {
  const draftV1 = currentRevision(subjectReleases.filter((item) => item.releaseNumber === 1));
  assert(draftV1?.status === "draft", "configuration v1 is not a draft");
  const inReview = await postJson(owner, `/v1/ops/configurations/${draftV1.id}/transitions`, {
    action: "submit_review", reason: "Review the initial M15 synthetic configuration before publication.", idempotencyKey: keys.submitV1,
  });
  const reviewId = requiredString(inReview.releaseId, "v1 review release id");
  const published = await postJson(owner, `/v1/ops/configurations/${reviewId}/transitions`, {
    action: "publish", reason: "Publish the reviewed M15 synthetic configuration for future Case creation.", idempotencyKey: keys.publishV1,
  });
  const publishedId = requiredString(published.releaseId, "v1 published release id");
  configurations = await getJson<OpsConfigurationSnapshot>(owner, "/v1/ops/configurations");
  publishedV1 = configurations.releases.find((item) => item.id === publishedId);
}
assert(publishedV1?.status === "published", "configuration v1 was not published");

const firstCaseBody = {
  periodKey: "2026-09", periodStart: "2026-09-01", periodEnd: "2026-09-30",
  dueAt: "2026-10-07T04:00:00.000Z", timezone: "Pacific/Auckland",
  externalReference: "M15-SYNTHETIC-SEP",
  reason: "Create the first future synthetic Case pinned to configuration version one.",
  idempotencyKey: keys.caseV1,
};
const caseV1 = await postJson(owner, `/v1/ops/configurations/${publishedV1.id}/cases`, firstCaseBody);
assert(["completed", "duplicate"].includes(String(caseV1.outcome)), "configuration v1 Case did not complete");
const caseV1Duplicate = await postJson(owner, `/v1/ops/configurations/${publishedV1.id}/cases`, firstCaseBody);
assert(caseV1Duplicate.outcome === "duplicate", "Case retry was not idempotent");

configurations = await getJson<OpsConfigurationSnapshot>(owner, "/v1/ops/configurations");
subjectReleases = releasesFor(configurations, subjectKey);
let publishedV2 = subjectReleases.find((item) => item.releaseNumber === 2 && item.status === "published");
if (!publishedV2) {
  const cloned = await postJson(owner, `/v1/ops/configurations/${publishedV1.id}/clone`, {
    reason: "Create version two to prove existing Cases keep their pinned configuration.", idempotencyKey: keys.cloneV2,
  });
  const cloneId = requiredString(cloned.releaseId, "v2 clone release id");
  configurations = await getJson<OpsConfigurationSnapshot>(owner, "/v1/ops/configurations");
  const clone = configurations.releases.find((item) => item.id === cloneId);
  assert(clone?.status === "draft", "configuration v2 clone is not a draft");
  const manifest = {
    ...clone.manifest,
    workflow: { ...clone.manifest.workflow, m15_case_snapshot_probe: "post-case-v2" },
  };
  const updated = await postJson(owner, `/v1/ops/configurations/${clone.id}/revisions`, {
    manifest, reason: "Add the M15 immutable Case snapshot regression marker to version two.", idempotencyKey: keys.updateV2,
  });
  const updatedId = requiredString(updated.releaseId, "v2 updated release id");
  const review = await postJson(owner, `/v1/ops/configurations/${updatedId}/transitions`, {
    action: "submit_review", reason: "Review the M15 version two snapshot marker before publication.", idempotencyKey: keys.submitV2,
  });
  const reviewId = requiredString(review.releaseId, "v2 review release id");
  const published = await postJson(owner, `/v1/ops/configurations/${reviewId}/transitions`, {
    action: "publish", reason: "Publish M15 version two while preserving the existing pinned Case.", idempotencyKey: keys.publishV2,
  });
  const publishedId = requiredString(published.releaseId, "v2 published release id");
  configurations = await getJson<OpsConfigurationSnapshot>(owner, "/v1/ops/configurations");
  publishedV2 = configurations.releases.find((item) => item.id === publishedId);
}
assert(publishedV2?.isCurrentPublished, "configuration v2 is not the current published release");

const managerCase = await postJson(manager, `/v1/ops/configurations/${publishedV2.id}/cases`, {
  periodKey: "2026-10", periodStart: "2026-10-01", periodEnd: "2026-10-31",
  dueAt: "2026-11-07T04:00:00.000Z", timezone: "Pacific/Auckland",
  externalReference: "M15-SYNTHETIC-OCT",
  reason: "Manager creates the next future synthetic Case from current version two.",
  idempotencyKey: keys.caseV2,
});
assert(["completed", "duplicate"].includes(String(managerCase.outcome)), "manager could not create a future Case");
const staffCase = await fetch(`${opsUrl}/v1/ops/configurations/${publishedV2.id}/cases`, {
  method: "POST",
  headers: mutationHeaders(staff),
  body: JSON.stringify({ ...firstCaseBody, periodKey: "2026-11", idempotencyKey: "00000000-0000-4000-a150-000000000110" }),
});
assertStatus(staffCase, 403, "staff Case creation");

const pool = new Pool(postgresPoolConfig(
  required(process.env.DATABASE_URL, "DATABASE_URL"),
  required(process.env.DATABASE_SSL_CA_PATH, "DATABASE_SSL_CA_PATH"),
  1,
));
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const context = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", ["dev-accounting-firm"]);
  assert(context.rows[0]?.id, "DEV organization context was not established");
  const invariant = await client.query<{
    onboarding_count: number; subject_count: number; case_count: number; synthetic_locked: boolean;
    v1_release_id: string; v2_release_id: string; v1_marker: string | null; v2_marker: string | null;
    event_count: number; external_send_count: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM subject_onboardings onboarding JOIN subjects subject ON subject.id = onboarding.subject_id WHERE subject.subject_key = $1) AS onboarding_count,
      (SELECT count(*)::int FROM subjects WHERE subject_key = $1) AS subject_count,
      (SELECT count(*)::int FROM cases case_record JOIN subjects subject ON subject.id = case_record.subject_id WHERE subject.subject_key = $1) AS case_count,
      (SELECT (attributes->>'synthetic')::boolean FROM subjects WHERE subject_key = $1) AS synthetic_locked,
      (SELECT config_snapshot->>'configuration_release_id' FROM cases case_record JOIN subjects subject ON subject.id = case_record.subject_id WHERE subject.subject_key = $1 AND period_start = '2026-09-01') AS v1_release_id,
      (SELECT id::text FROM work_configuration_releases release JOIN subjects subject ON subject.id = release.subject_id WHERE subject.subject_key = $1 AND release.status = 'published' ORDER BY release.release_number DESC LIMIT 1) AS v2_release_id,
      (SELECT config_snapshot#>>'{manifest,workflow,m15_case_snapshot_probe}' FROM cases case_record JOIN subjects subject ON subject.id = case_record.subject_id WHERE subject.subject_key = $1 AND period_start = '2026-09-01') AS v1_marker,
      (SELECT config_snapshot#>>'{manifest,workflow,m15_case_snapshot_probe}' FROM cases case_record JOIN subjects subject ON subject.id = case_record.subject_id WHERE subject.subject_key = $1 AND period_start = '2026-10-01') AS v2_marker,
      (SELECT count(*)::int FROM workflow_events event JOIN subjects subject ON subject.id = event.aggregate_id WHERE subject.subject_key = $1 AND event.event_type = 'Subject.Onboarded') AS event_count,
      (SELECT count(*)::int FROM workflow_events WHERE event_type ILIKE '%sent%' AND payload::text LIKE '%' || $1 || '%') AS external_send_count
  `, [subjectKey]);
  const row = invariant.rows[0];
  assert(row?.onboarding_count === 1 && row.subject_count === 1, "onboarding was not exactly-once");
  assert(row.case_count === 2, "expected exactly two future Cases");
  assert(row.synthetic_locked === true, "synthetic package boundary was not locked");
  assert(row.v1_release_id === publishedV1.id, "first Case did not pin configuration v1");
  assert(row.v2_release_id === publishedV2.id, "configuration v2 is not current");
  assert(row.v1_marker === null && row.v2_marker === "post-case-v2", "Case snapshots were rewritten or not pinned");
  assert(row.event_count === 1 && row.external_send_count === 0, "audit or external-send invariant failed");
  await client.query("ROLLBACK");
  console.log(JSON.stringify({
    verification: "passed", packages: catalog.packages.length, subjectKey,
    onboardingCount: row.onboarding_count, caseCount: row.case_count,
    currentConfigurationRelease: publishedV2.id, pinnedConfigurationRelease: publishedV1.id,
    managerOnboarding: "forbidden", staffConfiguration: "forbidden", staffCaseCreation: "forbidden",
    syntheticLocked: row.synthetic_locked, externalMessagesSent: row.external_send_count,
  }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
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
  assertStatus(response, 200, `GET ${path}`);
  return await response.json() as T;
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

function releasesFor(snapshot: OpsConfigurationSnapshot, key: string): WorkConfigurationRelease[] {
  return snapshot.releases.filter((item) => item.subjectKey === key);
}

function currentRevision(releases: WorkConfigurationRelease[]): WorkConfigurationRelease | undefined {
  return [...releases].sort((left, right) => right.revision - left.revision)[0];
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
