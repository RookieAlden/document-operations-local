import type { Pool, PoolClient } from "pg";
import type {
  OpsConfigurationMutationResult,
  OpsConfigurationRepository,
  OpsConfigurationSnapshot,
  WorkConfigurationManifest,
  WorkConfigurationRelease,
  WorkConfigurationStatus,
} from "../../ports/ops-configuration-repository.js";

interface ReleaseRow {
  id: string; series_id: string; release_number: number; revision: number; status: WorkConfigurationStatus;
  subject_id: string; subject_key: string; subject_name: string;
  workflow_template_id: string; workflow_template_name: string;
  requirement_set_id: string; requirement_set_name: string;
  manifest: WorkConfigurationManifest; definition_hash: string; base_release_id: string | null;
  base_manifest: WorkConfigurationManifest | null; produced_workflow_version: number | null;
  produced_requirement_version: number | null; created_by_name: string | null;
  reason: string; created_at: Date | string;
}

export class PostgresOpsConfigurationRepository implements OpsConfigurationRepository {
  constructor(private readonly pool: Pool) {}

  async getConfigurations(organizationKey: string, actorId: string, now: Date): Promise<OpsConfigurationSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      const actorType = await requireManager(client, actorId);
      const result = await client.query<ReleaseRow>(`
        WITH latest AS (
          SELECT DISTINCT ON (series_id) *
            FROM work_configuration_releases
           ORDER BY series_id, revision DESC
        )
        SELECT release.id, release.series_id, release.release_number, release.revision, release.status,
               subject.id AS subject_id, subject.subject_key, subject.display_name AS subject_name,
               template.id AS workflow_template_id, template.display_name AS workflow_template_name,
               requirement_set.id AS requirement_set_id, requirement_set.display_name AS requirement_set_name,
               release.manifest, release.definition_hash, release.base_release_id,
               base.manifest AS base_manifest, workflow_version.version AS produced_workflow_version,
               requirement_version.version AS produced_requirement_version,
               creator.display_name AS created_by_name, release.reason, release.created_at
          FROM latest release
          JOIN subjects subject ON subject.id = release.subject_id
          JOIN workflow_templates template ON template.id = release.workflow_template_id
          JOIN requirement_sets requirement_set ON requirement_set.id = release.requirement_set_id
          LEFT JOIN work_configuration_releases base ON base.id = release.base_release_id
          LEFT JOIN workflow_template_versions workflow_version ON workflow_version.id = release.produced_workflow_template_version_id
          LEFT JOIN requirement_set_versions requirement_version ON requirement_version.id = release.produced_requirement_set_version_id
          LEFT JOIN actors creator ON creator.id = release.created_by_actor_id
         ORDER BY lower(subject.display_name), release.release_number DESC
      `);
      const documentTypes = await client.query<{ code: string; display_name: string }>(
        "SELECT code, display_name FROM document_types WHERE status = 'active' ORDER BY lower(display_name)",
      );
      const contacts = await client.query<{ id: string; display_name: string; email: string | null }>(
        "SELECT id, display_name, email FROM actors WHERE actor_type = 'customer' AND status = 'active' ORDER BY lower(display_name)",
      );
      const latestPublished = new Map<string, number>();
      for (const row of result.rows) {
        if (row.status === "published") latestPublished.set(row.subject_id, Math.max(latestPublished.get(row.subject_id) ?? 0, row.release_number));
      }
      return {
        generatedAt: now.toISOString(),
        canManage: actorType === "admin",
        canCreateCases: true,
        releases: result.rows.map((row): WorkConfigurationRelease => ({
          id: row.id, seriesId: row.series_id, releaseNumber: row.release_number, revision: row.revision,
          status: row.status, subjectId: row.subject_id, subjectKey: row.subject_key, subjectName: row.subject_name,
          workflowTemplateId: row.workflow_template_id, workflowTemplateName: row.workflow_template_name,
          requirementSetId: row.requirement_set_id, requirementSetName: row.requirement_set_name,
          manifest: row.manifest, definitionHash: row.definition_hash, baseReleaseId: row.base_release_id,
          baseManifest: row.base_manifest, producedWorkflowVersion: row.produced_workflow_version,
          producedRequirementVersion: row.produced_requirement_version, createdByName: row.created_by_name,
          reason: row.reason, createdAt: iso(row.created_at),
          isCurrentPublished: row.status === "published" && latestPublished.get(row.subject_id) === row.release_number,
          validationErrors: validateManifest(row.manifest, documentTypes.rows.map((item) => item.code)),
          diff: manifestDiff(row.base_manifest, row.manifest),
        })),
        documentTypes: documentTypes.rows.map((item) => ({ code: item.code, displayName: item.display_name })),
        customerContacts: contacts.rows.map((item) => ({ id: item.id, displayName: item.display_name, email: item.email })),
      };
    });
  }

  async cloneRelease(organizationKey: string, request: Parameters<OpsConfigurationRepository["cloneRelease"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_clone_configuration_release($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.releaseId, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }

  async updateDraft(organizationKey: string, request: Parameters<OpsConfigurationRepository["updateDraft"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_update_configuration_draft($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.releaseId, request.manifest, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }

  async transitionRelease(organizationKey: string, request: Parameters<OpsConfigurationRepository["transitionRelease"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_transition_configuration_release($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.releaseId, request.action, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }

  private async call(organizationKey: string, sql: string, values: unknown[]): Promise<OpsConfigurationMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsConfigurationMutationResult }>(sql, values);
      return result.rows[0]?.result ?? { outcome: "conflict", reason: "mutation_failed" };
    });
  }

  private async transaction<T>(organizationKey: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", [organizationKey]);
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

async function requireManager(client: PoolClient, actorId: string): Promise<"manager" | "admin"> {
  const result = await client.query<{ actor_type: "manager" | "admin" }>(
    "SELECT actor_type FROM actors WHERE id = $1 AND actor_type IN ('manager','admin') AND status = 'active'", [actorId],
  );
  if (!result.rows[0]) throw new Error("manager_required");
  return result.rows[0].actor_type;
}

export function validateManifest(manifest: WorkConfigurationManifest, documentTypes: string[]): string[] {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object" || !manifest.subject || !manifest.workflow || !Array.isArray(manifest.requirements)) return ["配置结构不完整"];
  if (manifest.subject.displayName?.trim().length < 2) errors.push("客户名称至少需要 2 个字符");
  if (!['active', 'paused', 'offboarding', 'closed'].includes(manifest.subject.status)) errors.push("客户状态无效");
  if (manifest.requirements.length < 1 || manifest.requirements.length > 100) errors.push("资料要求需要 1–100 项");
  const codes = new Set<string>();
  const types = new Set<string>();
  for (const requirement of manifest.requirements) {
    if (!requirement.code?.trim() || codes.has(requirement.code.trim().toLowerCase())) errors.push("资料要求代码必须填写且不能重复");
    codes.add(requirement.code?.trim().toLowerCase());
    if (!documentTypes.includes(requirement.documentTypeCode)) errors.push(`资料类型 ${requirement.documentTypeCode || "（空）"} 不存在或未启用`);
    if (types.has(requirement.documentTypeCode)) errors.push(`资料类型 ${requirement.documentTypeCode} 不能重复`);
    types.add(requirement.documentTypeCode);
    if (!Number.isInteger(requirement.minimumCount) || requirement.minimumCount < 0
      || (requirement.maximumCount !== null && (!Number.isInteger(requirement.maximumCount) || requirement.maximumCount < requirement.minimumCount))) {
      errors.push(`${requirement.code || "未命名要求"} 的数量范围无效`);
    }
  }
  return [...new Set(errors)];
}

export function manifestDiff(base: WorkConfigurationManifest | null, current: WorkConfigurationManifest): string[] {
  if (!base) return ["已导入为基准版本"];
  const changes: string[] = [];
  if (base.subject.displayName !== current.subject.displayName) changes.push("客户名称");
  if (base.subject.status !== current.subject.status) changes.push("客户状态");
  if (base.subject.primaryContactActorId !== current.subject.primaryContactActorId) changes.push("主要联系人");
  if (JSON.stringify(base.subject.attributes) !== JSON.stringify(current.subject.attributes)) changes.push("客户属性");
  if (JSON.stringify(base.workflow) !== JSON.stringify(current.workflow)) changes.push("工作流定义");
  const baseRequirements = new Map(base.requirements.map((item) => [item.code, JSON.stringify(item)]));
  const currentRequirements = new Map(current.requirements.map((item) => [item.code, JSON.stringify(item)]));
  const added = [...currentRequirements.keys()].filter((key) => !baseRequirements.has(key)).length;
  const removed = [...baseRequirements.keys()].filter((key) => !currentRequirements.has(key)).length;
  const changed = [...currentRequirements.keys()].filter((key) => baseRequirements.has(key) && baseRequirements.get(key) !== currentRequirements.get(key)).length;
  if (added) changes.push(`新增 ${added} 项资料要求`);
  if (removed) changes.push(`移除 ${removed} 项资料要求`);
  if (changed) changes.push(`修改 ${changed} 项资料要求`);
  return changes.length ? changes : ["与基准版本相同"];
}

function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
