import type { Pool, PoolClient } from "pg";
import type {
  OpsWorkPackageDryRun,
  OpsWorkPackageMutationResult,
  OpsWorkPackageRepository,
  OpsWorkPackageSnapshot,
  OpsWorkPackageVersion,
  WorkPackageBlueprint,
  WorkPackageDifference,
} from "../../ports/ops-work-package-repository.js";

interface VersionRow {
  id: string;
  package_id: string;
  package_key: string;
  package_status: "active" | "retired";
  display_name_snapshot: string;
  description_snapshot: string;
  industry_package_snapshot: string | null;
  workflow_template_id: string;
  workflow_template_name: string;
  version: number;
  revision: number;
  status: "draft" | "in_review" | "published" | "retired";
  blueprint: WorkPackageBlueprint;
  definition_hash: string;
  reason: string;
  created_by_name: string | null;
  created_at: Date | string;
  published_at: Date | string | null;
  is_latest_revision: boolean;
  is_current_published: boolean;
  has_passing_dry_run: boolean;
}

interface DryRunRow {
  id: string;
  package_id: string;
  package_version_id: string;
  definition_hash: string;
  synthetic_sample: Record<string, unknown>;
  result: Record<string, unknown>;
  status: "passed" | "failed";
  run_by_name: string;
  reason: string;
  created_at: Date | string;
}

export class PostgresOpsWorkPackageRepository implements OpsWorkPackageRepository {
  constructor(private readonly pool: Pool) {}

  async getWorkPackages(organizationKey: string, actorId: string, now: Date): Promise<OpsWorkPackageSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      const actor = await client.query<{ actor_type: "staff" | "manager" | "admin" }>(
        "SELECT actor_type FROM actors WHERE id = $1 AND status = 'active'", [actorId],
      );
      const actorType = actor.rows[0]?.actor_type;
      if (actorType !== "manager" && actorType !== "admin") throw new Error("manager_required");
      const versions = await client.query<VersionRow>(`
        SELECT version.id, package.id AS package_id, package.package_key,
               package.status AS package_status, version.display_name_snapshot,
               version.description_snapshot, version.industry_package_snapshot,
               version.workflow_template_id,
               workflow_template.display_name AS workflow_template_name,
               version.version, version.revision, version.status, version.blueprint,
               version.definition_hash, version.reason,
               actor.display_name AS created_by_name, version.created_at,
               version.published_at,
               NOT EXISTS (
                   SELECT 1 FROM work_configuration_package_versions later
                    WHERE later.package_id = version.package_id
                      AND (later.version, later.revision) > (version.version, version.revision)
               ) AS is_latest_revision,
               package.current_published_version_id = version.id AS is_current_published,
               EXISTS (
                   SELECT 1 FROM work_configuration_package_dry_runs dry_run
                    WHERE dry_run.package_id = version.package_id
                      AND dry_run.definition_hash = version.definition_hash
                      AND dry_run.status = 'passed'
               ) AS has_passing_dry_run
          FROM work_configuration_package_versions version
          JOIN work_configuration_packages package ON package.id = version.package_id
          JOIN workflow_templates workflow_template ON workflow_template.id = version.workflow_template_id
          LEFT JOIN actors actor ON actor.id = version.created_by_actor_id
         ORDER BY lower(version.display_name_snapshot), version.version DESC, version.revision DESC
      `);
      const dryRuns = await client.query<DryRunRow>(`
        SELECT dry_run.id, dry_run.package_id, dry_run.package_version_id,
               dry_run.definition_hash, dry_run.synthetic_sample, dry_run.result,
               dry_run.status, actor.display_name AS run_by_name,
               dry_run.reason, dry_run.created_at
          FROM work_configuration_package_dry_runs dry_run
          JOIN actors actor ON actor.id = dry_run.run_by_actor_id
         ORDER BY dry_run.created_at DESC LIMIT 100
      `);
      const workflows = await client.query<{
        id: string; template_key: string; display_name: string; industry_package: string | null;
      }>(`
        SELECT id, template_key, display_name, industry_package
          FROM workflow_templates WHERE status = 'active'
         ORDER BY lower(display_name)
      `);
      const documentTypes = await client.query<{ code: string; display_name: string }>(`
        SELECT code, display_name FROM document_types
         WHERE status = 'active' ORDER BY lower(display_name)
      `);
      const currentBlueprints = new Map<string, WorkPackageBlueprint>();
      for (const row of versions.rows) if (row.is_current_published) currentBlueprints.set(row.package_id, row.blueprint);
      return {
        generatedAt: now.toISOString(),
        canManage: actorType === "admin",
        versions: versions.rows.map((row) => toVersion(row, currentBlueprints.get(row.package_id))),
        dryRuns: dryRuns.rows.map(toDryRun),
        workflowTemplates: workflows.rows.map((row) => ({
          id: row.id, templateKey: row.template_key, displayName: row.display_name,
          industryPackage: row.industry_package,
        })),
        documentTypes: documentTypes.rows.map((row) => ({ code: row.code, displayName: row.display_name })),
      };
    });
  }

  async createPackage(organizationKey: string, request: Parameters<OpsWorkPackageRepository["createPackage"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_create_work_package($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result",
      [request.actorId, request.packageKey, request.displayName, request.description,
        request.industryPackage, request.workflowTemplateId, request.blueprint, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async updateDraft(organizationKey: string, request: Parameters<OpsWorkPackageRepository["updateDraft"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_update_work_package_draft($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result",
      [request.actorId, request.versionId, request.displayName, request.description,
        request.industryPackage, request.workflowTemplateId, request.blueprint, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async cloneVersion(organizationKey: string, request: Parameters<OpsWorkPackageRepository["cloneVersion"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_clone_work_package_version($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.versionId, request.reason, request.idempotencyKey,
        request.correlationId, request.now]);
  }

  async runDryRun(organizationKey: string, request: Parameters<OpsWorkPackageRepository["runDryRun"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_run_work_package_dry_run($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.versionId, request.syntheticSample, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async transitionVersion(organizationKey: string, request: Parameters<OpsWorkPackageRepository["transitionVersion"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_transition_work_package_version($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.versionId, request.action, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async retirePackage(organizationKey: string, request: Parameters<OpsWorkPackageRepository["retirePackage"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_retire_work_package($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.packageId, request.reason, request.idempotencyKey,
        request.correlationId, request.now]);
  }

  private async call(organizationKey: string, sql: string, values: unknown[]): Promise<OpsWorkPackageMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsWorkPackageMutationResult }>(sql, values);
      return result.rows[0]?.result ?? { outcome: "conflict", reason: "mutation_failed" };
    });
  }

  private async transaction<T>(organizationKey: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id", [organizationKey],
      );
      if (!organization.rows[0]?.id) throw new Error("organization_not_found");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

function toVersion(row: VersionRow, publishedBlueprint: WorkPackageBlueprint | undefined): OpsWorkPackageVersion {
  return {
    id: row.id, packageId: row.package_id, packageKey: row.package_key,
    packageStatus: row.package_status, displayName: row.display_name_snapshot,
    description: row.description_snapshot, industryPackage: row.industry_package_snapshot,
    workflowTemplateId: row.workflow_template_id, workflowTemplateName: row.workflow_template_name,
    version: Number(row.version), revision: Number(row.revision), status: row.status,
    blueprint: row.blueprint, definitionHash: row.definition_hash, reason: row.reason,
    createdByName: row.created_by_name, createdAt: iso(row.created_at),
    publishedAt: row.published_at ? iso(row.published_at) : null,
    isLatestRevision: row.is_latest_revision, isCurrentPublished: row.is_current_published,
    hasPassingDryRun: row.has_passing_dry_run,
    differencesFromPublished: publishedBlueprint && !row.is_current_published
      ? compareValues(publishedBlueprint, row.blueprint) : [],
  };
}

function toDryRun(row: DryRunRow): OpsWorkPackageDryRun {
  return {
    id: row.id, packageId: row.package_id, packageVersionId: row.package_version_id,
    definitionHash: row.definition_hash, syntheticSample: row.synthetic_sample,
    result: row.result, status: row.status, runByName: row.run_by_name,
    reason: row.reason, createdAt: iso(row.created_at),
  };
}

export function compareValues(before: unknown, after: unknown, path = ""): WorkPackageDifference[] {
  if (Object.is(before, after)) return [];
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => compareValues(before[key], after[key], path ? `${path}.${key}` : key));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const maximum = Math.max(before.length, after.length);
    return Array.from({ length: maximum }, (_, index) => compareValues(before[index], after[index], `${path}[${index}]`)).flat();
  }
  return [{
    path: path || "definition",
    before,
    after,
    kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
  }];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
