import { Pool } from "pg";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";
import type { CasePlanDefinition, CasePlanVersion, OpsCasePlanSnapshot } from "../ports/ops-case-plan-repository.js";

interface Session { cookie: string; csrfToken: string }
type JsonRecord = Record<string, unknown>;

const opsUrl = required(process.env.DOP_M16_OPS_URL ?? process.env.DOP_M15_OPS_URL, "DOP_M16_OPS_URL").replace(/\/$/, "");
const origin = new URL(opsUrl).origin;
const subjectKey = "m15-rimu-design";
const planKey = "m16-rimu-monthly-plan";
const keys = {
  create: "00000000-0000-4000-a160-000000000101",
  submit: "00000000-0000-4000-a160-000000000102",
  publish: "00000000-0000-4000-a160-000000000103",
  preview: "00000000-0000-4000-a160-000000000104",
  staffPreview: "00000000-0000-4000-a160-000000000105",
  staffApprove: "00000000-0000-4000-a160-000000000106",
  approve: "00000000-0000-4000-a160-000000000107",
};
const definition: CasePlanDefinition = {
  cadence: { mode: "calendar_months", intervalMonths: 1, anchorDate: "2026-11-01" },
  timezone: "Pacific/Auckland",
  dueRule: { basis: "period_end", offsetDays: 7, localTime: "17:00" },
  defaultPreviewCount: 2,
  sourceBinding: {
    type: "manual_upload",
    bindingKey: "m16-rimu-controlled-upload",
    metadata: { synthetic: true, regressionProbe: "m16" },
  },
  externalDelivery: "disabled",
};

const owner = await login(
  required(process.env.DOP_M16_OWNER_EMAIL ?? process.env.DOP_M15_OWNER_EMAIL, "DOP_M16_OWNER_EMAIL"),
  required(process.env.DOP_M16_OWNER_PASSWORD ?? process.env.DOP_M15_OWNER_PASSWORD, "DOP_M16_OWNER_PASSWORD"),
);
const manager = await login(
  required(process.env.DOP_M16_MANAGER_EMAIL ?? process.env.DOP_M15_MANAGER_EMAIL, "DOP_M16_MANAGER_EMAIL"),
  required(process.env.DOP_M16_MANAGER_PASSWORD ?? process.env.DOP_M15_MANAGER_PASSWORD, "DOP_M16_MANAGER_PASSWORD"),
);
const staff = await login(
  required(process.env.DOP_M16_STAFF_EMAIL ?? process.env.DOP_M15_STAFF_EMAIL, "DOP_M16_STAFF_EMAIL"),
  required(process.env.DOP_M16_STAFF_PASSWORD ?? process.env.DOP_M15_STAFF_PASSWORD, "DOP_M16_STAFF_PASSWORD"),
);

assertStatus(await fetch(`${opsUrl}/v1/ops/case-plans`, { headers: { cookie: staff.cookie } }), 403, "staff Case Plan catalog");

let snapshot = await getJson<OpsCasePlanSnapshot>(owner, "/v1/ops/case-plans");
const subject = snapshot.eligibleSubjects.find((item) => item.subjectKey === subjectKey);
assert(subject, "M15 synthetic Subject with a published configuration is missing");

let planVersions = snapshot.versions.filter((item) => item.planKey === planKey);
if (planVersions.length === 0) {
  const created = await postJson(owner, "/v1/ops/case-plans", {
    subjectId: subject.id,
    planKey,
    displayName: "Rimu monthly document operations",
    definition,
    reason: "Create the controlled M16 monthly Case Plan for synthetic regression.",
    idempotencyKey: keys.create,
  });
  assert(["completed", "duplicate"].includes(String(created.outcome)), "Case Plan creation did not complete");
  const duplicate = await postJson(owner, "/v1/ops/case-plans", {
    subjectId: subject.id,
    planKey,
    displayName: "Rimu monthly document operations",
    definition,
    reason: "Create the controlled M16 monthly Case Plan for synthetic regression.",
    idempotencyKey: keys.create,
  });
  assert(duplicate.outcome === "duplicate", "Case Plan creation retry was not idempotent");
  snapshot = await getJson<OpsCasePlanSnapshot>(owner, "/v1/ops/case-plans");
  planVersions = snapshot.versions.filter((item) => item.planKey === planKey);
}
assert(planVersions.length > 0, "Case Plan has no version history");

let published = currentPublished(planVersions);
if (!published) {
  let current = currentRevision(planVersions);
  assert(current, "Case Plan current revision is missing");
  if (current.status === "draft") {
    const reviewed = await postJson(owner, `/v1/ops/case-plans/${current.id}/transitions`, {
      action: "submit_review",
      reason: "Review the M16 cadence, due rule and source binding before publication.",
      idempotencyKey: keys.submit,
    });
    const reviewedId = requiredString(reviewed.versionId, "reviewed Case Plan version id");
    snapshot = await getJson<OpsCasePlanSnapshot>(owner, "/v1/ops/case-plans");
    current = snapshot.versions.find((item) => item.id === reviewedId);
  }
  assert(current?.status === "in_review", "Case Plan did not enter review");
  const publication = await postJson(owner, `/v1/ops/case-plans/${current.id}/transitions`, {
    action: "publish",
    reason: "Publish the reviewed M16 plan while keeping all external delivery disabled.",
    idempotencyKey: keys.publish,
  });
  const publishedId = requiredString(publication.versionId, "published Case Plan version id");
  snapshot = await getJson<OpsCasePlanSnapshot>(owner, "/v1/ops/case-plans");
  published = snapshot.versions.find((item) => item.id === publishedId);
}
assert(published?.status === "published" && published.isCurrentPublished, "Case Plan is not current published");
assert(published.definition.externalDelivery === "disabled", "published Case Plan opened external delivery");

const previewBody = {
  candidateCount: 2,
  startOn: "2026-11-01",
  reason: "Preview the November and December synthetic Cases before manual approval.",
  idempotencyKey: keys.preview,
};
const previewResult = await postJson(manager, `/v1/ops/case-plans/${published.id}/previews`, previewBody);
assert(["completed", "duplicate"].includes(String(previewResult.outcome)), "manager preview did not complete");
const previewId = requiredString(previewResult.previewId, "Case Plan preview id");
const previewDuplicate = await postJson(manager, `/v1/ops/case-plans/${published.id}/previews`, previewBody);
assert(previewDuplicate.outcome === "duplicate", "preview retry was not idempotent");

assertStatus(await fetch(`${opsUrl}/v1/ops/case-plans/${published.id}/previews`, {
  method: "POST",
  headers: mutationHeaders(staff),
  body: JSON.stringify({ ...previewBody, idempotencyKey: keys.staffPreview }),
}), 403, "staff Case Plan preview");
assertStatus(await fetch(`${opsUrl}/v1/ops/case-plan-previews/${previewId}/approve`, {
  method: "POST",
  headers: mutationHeaders(staff),
  body: JSON.stringify({ reason: "Staff must not approve this controlled synthetic Case batch.", idempotencyKey: keys.staffApprove }),
}), 403, "staff Case Plan approval");

const approvalBody = {
  reason: "Approve the exact two-period M16 preview as one atomic synthetic batch.",
  idempotencyKey: keys.approve,
};
const approval = await postJson(manager, `/v1/ops/case-plan-previews/${previewId}/approve`, approvalBody);
assert(["completed", "duplicate"].includes(String(approval.outcome)), "manager approval did not complete");
assert(Array.isArray(approval.generatedCaseIds) && approval.generatedCaseIds.length === 2, "approval did not return exactly two Case ids");
const approvalDuplicate = await postJson(manager, `/v1/ops/case-plan-previews/${previewId}/approve`, approvalBody);
assert(approvalDuplicate.outcome === "duplicate", "approval retry was not idempotent");
assert(Array.isArray(approvalDuplicate.generatedCaseIds) && approvalDuplicate.generatedCaseIds.length === 2, "approval retry changed the Case batch");

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
    plan_count: number; preview_count: number; approval_count: number; case_count: number;
    published_plan_count: number; current_configuration_id: string; pinned_configuration_count: number;
    source_binding_count: number; external_delivery_count: number; plan_event_count: number;
    case_event_count: number; external_send_count: number; rls_table_count: number; rls_enabled_count: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM case_plans WHERE plan_key = $1) AS plan_count,
      (SELECT count(*)::int FROM case_plan_preview_batches batch JOIN case_plan_versions version ON version.id = batch.case_plan_version_id JOIN case_plans plan ON plan.id = version.case_plan_id WHERE plan.plan_key = $1) AS preview_count,
      (SELECT count(*)::int FROM case_plan_approvals approval JOIN case_plan_versions version ON version.id = approval.case_plan_version_id JOIN case_plans plan ON plan.id = version.case_plan_id WHERE plan.plan_key = $1) AS approval_count,
      (SELECT count(*)::int FROM cases case_record JOIN subjects subject ON subject.id = case_record.subject_id WHERE subject.subject_key = $2 AND case_record.period_start IN ('2026-11-01','2026-12-01')) AS case_count,
      (SELECT count(*)::int FROM case_plan_versions version JOIN case_plans plan ON plan.id = version.case_plan_id WHERE plan.plan_key = $1 AND version.status = 'published') AS published_plan_count,
      (SELECT release.id::text FROM work_configuration_releases release JOIN subjects subject ON subject.id = release.subject_id WHERE subject.subject_key = $2 AND release.status = 'published' ORDER BY release.release_number DESC, release.revision DESC LIMIT 1) AS current_configuration_id,
      (SELECT count(*)::int FROM cases case_record JOIN subjects subject ON subject.id = case_record.subject_id WHERE subject.subject_key = $2 AND case_record.period_start IN ('2026-11-01','2026-12-01') AND case_record.config_snapshot->>'configuration_release_id' = $3) AS pinned_configuration_count,
      (SELECT count(*)::int FROM cases case_record JOIN subjects subject ON subject.id = case_record.subject_id WHERE subject.subject_key = $2 AND case_record.period_start IN ('2026-11-01','2026-12-01') AND case_record.config_snapshot#>>'{source_binding,bindingKey}' = 'm16-rimu-controlled-upload') AS source_binding_count,
      (SELECT count(*)::int FROM cases case_record JOIN subjects subject ON subject.id = case_record.subject_id WHERE subject.subject_key = $2 AND case_record.period_start IN ('2026-11-01','2026-12-01') AND case_record.config_snapshot->>'external_delivery' = 'disabled') AS external_delivery_count,
      (SELECT count(*)::int FROM workflow_events event
        WHERE event.producer = 'ops-case-plan' AND event.event_type LIKE 'CasePlan.%'
          AND (event.aggregate_id = (SELECT id FROM case_plans WHERE plan_key = $1)
            OR event.aggregate_id IN (
              SELECT batch.id FROM case_plan_preview_batches batch
              JOIN case_plan_versions version ON version.id = batch.case_plan_version_id
              JOIN case_plans plan ON plan.id = version.case_plan_id WHERE plan.plan_key = $1
            ))) AS plan_event_count,
      (SELECT count(*)::int FROM workflow_events event JOIN cases case_record ON case_record.id = event.aggregate_id JOIN subjects subject ON subject.id = case_record.subject_id WHERE subject.subject_key = $2 AND event.event_type = 'Case.CreatedFromPlan') AS case_event_count,
      (SELECT count(*)::int FROM workflow_events WHERE event_type ILIKE '%sent%' AND payload::text LIKE '%' || $2 || '%') AS external_send_count,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'pg_%') AS rls_table_count,
      (SELECT count(*)::int FROM pg_class class JOIN pg_namespace namespace ON namespace.oid = class.relnamespace WHERE namespace.nspname = 'public' AND class.relkind = 'r' AND class.relrowsecurity) AS rls_enabled_count
  `, [planKey, subjectKey, subject.configurationReleaseId]);
  const row = invariant.rows[0];
  assert(row?.plan_count === 1 && row.preview_count === 1 && row.approval_count === 1, "Plan, preview or approval was not exactly-once");
  assert(row.case_count === 2, "approval did not create exactly two future Cases");
  assert(row.published_plan_count === 1, "published Case Plan history is inconsistent");
  assert(row.current_configuration_id === subject.configurationReleaseId && row.pinned_configuration_count === 2, "approved Cases did not pin the previewed current configuration");
  assert(row.source_binding_count === 2 && row.external_delivery_count === 2, "source binding or external-delivery boundary was not copied exactly");
  assert(row.plan_event_count >= 5 && row.case_event_count === 2 && row.external_send_count === 0, "audit or external-send invariant failed");
  assert(row.rls_table_count === row.rls_enabled_count && row.rls_table_count >= 35, "RLS coverage is incomplete");
  await client.query("ROLLBACK");
  console.log(JSON.stringify({
    verification: "passed", planKey, planVersionId: published.id, previewId,
    candidateCount: 2, approvedCaseCount: row.case_count,
    pinnedConfigurationRelease: subject.configurationReleaseId,
    sourceBinding: definition.sourceBinding.bindingKey,
    staffCatalog: "forbidden", staffPreview: "forbidden", staffApproval: "forbidden",
    rls: `${row.rls_enabled_count}/${row.rls_table_count}`,
    externalMessagesSent: row.external_send_count,
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

function currentRevision(versions: CasePlanVersion[]): CasePlanVersion | undefined {
  return [...versions].sort((left, right) => right.version - left.version || right.revision - left.revision)[0];
}

function currentPublished(versions: CasePlanVersion[]): CasePlanVersion | undefined {
  return versions.find((item) => item.status === "published" && item.isCurrentPublished);
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
