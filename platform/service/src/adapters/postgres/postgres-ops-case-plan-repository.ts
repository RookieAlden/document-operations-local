import type { Pool, PoolClient } from "pg";
import type {
  CasePlanCandidate,
  CasePlanDefinition,
  CasePlanVersion,
  OpsCasePlanMutationResult,
  OpsCasePlanRepository,
  OpsCasePlanSnapshot,
} from "../../ports/ops-case-plan-repository.js";

interface VersionRow {
  id: string; plan_id: string; plan_key: string; plan_name: string;
  plan_status: "active" | "paused" | "retired"; subject_id: string;
  subject_key: string; subject_name: string; version: number; revision: number;
  status: "draft" | "in_review" | "published"; definition: CasePlanDefinition;
  definition_hash: string; base_version_id: string | null; created_by_name: string;
  reason: string; created_at: Date | string; is_current_published: boolean;
  source_connector_version_id: string; source_connector_definition_hash: string;
  source_connector_key: string; source_connector_display_name: string;
  source_connector_version: number; source_connector_revision: number;
}

interface PreviewRow {
  id: string; plan_version_id: string; plan_version: number; plan_key: string;
  plan_name: string; subject_id: string; subject_key: string; subject_name: string;
  configuration_release_id: string; configuration_release_number: number;
  source_connector_version_id: string; source_connector_definition_hash: string;
  source_connector_key: string; source_connector_display_name: string;
  source_connector_version: number; source_connector_revision: number;
  candidates: CasePlanCandidate[]; candidates_hash: string; created_by_name: string;
  reason: string; created_at: Date | string; approval_id: string | null;
  generated_case_ids: string[] | null; approved_by_name: string | null;
  approval_reason: string | null; approved_at: Date | string | null;
}

export class PostgresOpsCasePlanRepository implements OpsCasePlanRepository {
  constructor(private readonly pool: Pool) {}

  async getCasePlans(organizationKey: string, actorId: string, now: Date): Promise<OpsCasePlanSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      const actorType = await requireReader(client, actorId);
      const subjects = await client.query<{
        id: string; subject_key: string; subject_name: string;
        configuration_release_id: string; configuration_release_number: number;
      }>(`
        SELECT DISTINCT ON (subject.id) subject.id, subject.subject_key,
               subject.display_name AS subject_name,
               release.id AS configuration_release_id,
               release.release_number AS configuration_release_number
          FROM subjects subject
          JOIN work_configuration_releases release ON release.subject_id = subject.id
         WHERE subject.status = 'active' AND release.status = 'published'
         ORDER BY subject.id, release.release_number DESC, release.revision DESC
      `);
      const versions = await client.query<VersionRow>(`
        SELECT version.id, plan.id AS plan_id, plan.plan_key, plan.display_name AS plan_name,
               plan.status AS plan_status, subject.id AS subject_id, subject.subject_key,
               subject.display_name AS subject_name, version.version, version.revision,
               version.status, version.definition, version.definition_hash,
               version.source_connector_version_id, version.source_connector_definition_hash,
               source_connector.connector_key AS source_connector_key,
               source_connector.display_name AS source_connector_display_name,
               source_version.version AS source_connector_version,
               source_version.revision AS source_connector_revision,
               version.base_version_id, actor.display_name AS created_by_name,
               version.reason, version.created_at,
               (version.status = 'published' AND version.version = (
                    SELECT max(published.version) FROM case_plan_versions published
                     WHERE published.case_plan_id = plan.id AND published.status = 'published'
                )) AS is_current_published
          FROM case_plan_versions version
          JOIN case_plans plan ON plan.id = version.case_plan_id
          JOIN source_connector_versions source_version ON source_version.id=version.source_connector_version_id
          JOIN source_connectors source_connector ON source_connector.id=source_version.connector_id
          JOIN subjects subject ON subject.id = plan.subject_id
          JOIN actors actor ON actor.id = version.created_by_actor_id
         ORDER BY lower(subject.display_name), plan.plan_key, version.version DESC, version.revision DESC
      `);
      const sourceConnectors = await client.query<{
        connector_id: string; connector_key: string; display_name: string;
        connector_version_id: string; version: number; revision: number;
        definition_hash: string; connector_type: string;
      }>(`
        SELECT connector.id AS connector_id, connector.connector_key, connector.display_name,
               version.id AS connector_version_id, version.version, version.revision,
               version.definition_hash, version.definition->>'connectorType' AS connector_type
          FROM source_connectors connector
          JOIN source_connector_versions version
            ON version.organization_id=connector.organization_id
           AND version.id=connector.active_version_id
         WHERE connector.lifecycle_status='active' AND version.status='active'
           AND version.definition->>'connectorType' IN
             ('manual_upload','form','email','sharepoint','api','sftp','object_storage')
         ORDER BY lower(connector.display_name),connector.connector_key
      `);
      const previews = await client.query<PreviewRow>(`
        SELECT preview.id, preview.case_plan_version_id AS plan_version_id,
               version.version AS plan_version, plan.plan_key, plan.display_name AS plan_name,
               subject.id AS subject_id, subject.subject_key, subject.display_name AS subject_name,
               preview.configuration_release_id, configuration.release_number AS configuration_release_number,
               preview.source_connector_version_id, preview.source_connector_definition_hash,
               source_connector.connector_key AS source_connector_key,
               source_connector.display_name AS source_connector_display_name,
               source_version.version AS source_connector_version,
               source_version.revision AS source_connector_revision,
               preview.candidates, preview.candidates_hash,
               creator.display_name AS created_by_name, preview.reason, preview.created_at,
               approval.id AS approval_id, approval.generated_case_ids,
               approver.display_name AS approved_by_name, approval.reason AS approval_reason,
               approval.approved_at
          FROM case_plan_preview_batches preview
          JOIN case_plan_versions version ON version.id = preview.case_plan_version_id
          JOIN case_plans plan ON plan.id = version.case_plan_id
          JOIN subjects subject ON subject.id = preview.subject_id
          JOIN work_configuration_releases configuration ON configuration.id = preview.configuration_release_id
          JOIN source_connector_versions source_version ON source_version.id=preview.source_connector_version_id
          JOIN source_connectors source_connector ON source_connector.id=source_version.connector_id
          JOIN actors creator ON creator.id = preview.created_by_actor_id
          LEFT JOIN case_plan_approvals approval ON approval.preview_batch_id = preview.id
          LEFT JOIN actors approver ON approver.id = approval.approved_by_actor_id
         ORDER BY preview.created_at DESC LIMIT 50
      `);
      return {
        generatedAt: now.toISOString(),
        canManage: actorType === "admin",
        canPreview: actorType === "manager" || actorType === "admin",
        eligibleSubjects: subjects.rows.map((row) => ({
          id: row.id, subjectKey: row.subject_key, subjectName: row.subject_name,
          configurationReleaseId: row.configuration_release_id,
          configurationReleaseNumber: row.configuration_release_number,
        })),
        eligibleSourceConnectors: sourceConnectors.rows.map((row) => ({
          connectorId: row.connector_id, connectorKey: row.connector_key,
          displayName: row.display_name, connectorVersionId: row.connector_version_id,
          version: row.version, revision: row.revision, definitionHash: row.definition_hash,
          sourceType: casePlanSourceType(row.connector_type),
        })),
        versions: versions.rows.map(toVersion),
        previews: previews.rows.map((row) => ({
          id: row.id, planVersionId: row.plan_version_id, planVersion: row.plan_version,
          planKey: row.plan_key, planName: row.plan_name, subjectId: row.subject_id,
          subjectKey: row.subject_key, subjectName: row.subject_name,
          configurationReleaseId: row.configuration_release_id,
          configurationReleaseNumber: row.configuration_release_number,
          sourceConnectorVersionId: row.source_connector_version_id,
          sourceConnectorDefinitionHash: row.source_connector_definition_hash,
          sourceConnectorKey: row.source_connector_key,
          sourceConnectorDisplayName: row.source_connector_display_name,
          sourceConnectorVersion: row.source_connector_version,
          sourceConnectorRevision: row.source_connector_revision,
          candidates: row.candidates, candidatesHash: row.candidates_hash,
          createdByName: row.created_by_name, reason: row.reason, createdAt: iso(row.created_at),
          approval: row.approval_id && row.generated_case_ids && row.approved_by_name && row.approval_reason && row.approved_at
            ? { id: row.approval_id, generatedCaseIds: row.generated_case_ids,
              approvedByName: row.approved_by_name, reason: row.approval_reason,
              approvedAt: iso(row.approved_at) }
            : null,
        })),
      };
    });
  }

  async createPlan(organizationKey: string, request: Parameters<OpsCasePlanRepository["createPlan"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_create_case_plan($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
      [request.actorId, request.subjectId, request.planKey, request.displayName,
        request.definition, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }

  async updateDraft(organizationKey: string, request: Parameters<OpsCasePlanRepository["updateDraft"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_update_case_plan_draft($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.versionId, request.definition, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async transitionVersion(organizationKey: string, request: Parameters<OpsCasePlanRepository["transitionVersion"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_transition_case_plan_version($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.versionId, request.action, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async cloneVersion(organizationKey: string, request: Parameters<OpsCasePlanRepository["cloneVersion"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_clone_case_plan_version($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.versionId, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async previewPlan(organizationKey: string, request: Parameters<OpsCasePlanRepository["previewPlan"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_preview_case_plan($1,$2,$3,$4,$5,$6,$7,$8) AS result",
      [request.actorId, request.versionId, request.candidateCount, request.startOn,
        request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }

  async approvePreview(organizationKey: string, request: Parameters<OpsCasePlanRepository["approvePreview"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_approve_case_plan_preview($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.previewId, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  private async call(organizationKey: string, sql: string, values: unknown[]): Promise<OpsCasePlanMutationResult> {
    try {
      return await this.transaction(organizationKey, async (client) => {
        const result = await client.query<{ result: OpsCasePlanMutationResult }>(sql, values);
        return result.rows[0]?.result ?? { outcome: "conflict", reason: "mutation_failed" };
      });
    } catch (error) {
      const message = databaseErrorMessage(error);
      if (["source_connector_not_active", "source_connector_version_mismatch"].includes(message)) {
        return { outcome: "conflict", reason: message };
      }
      throw error;
    }
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

function toVersion(row: VersionRow): CasePlanVersion {
  return {
    id: row.id, planId: row.plan_id, planKey: row.plan_key, planName: row.plan_name,
    planStatus: row.plan_status, subjectId: row.subject_id, subjectKey: row.subject_key,
    subjectName: row.subject_name, version: row.version, revision: row.revision,
    status: row.status, definition: row.definition, definitionHash: row.definition_hash,
    sourceConnectorVersionId: row.source_connector_version_id,
    sourceConnectorDefinitionHash: row.source_connector_definition_hash,
    sourceConnectorKey: row.source_connector_key,
    sourceConnectorDisplayName: row.source_connector_display_name,
    sourceConnectorVersion: row.source_connector_version,
    sourceConnectorRevision: row.source_connector_revision,
    baseVersionId: row.base_version_id, createdByName: row.created_by_name,
    reason: row.reason, createdAt: iso(row.created_at), isCurrentPublished: row.is_current_published,
    validationErrors: validateDefinition(row.definition),
  };
}

function validateDefinition(definition: CasePlanDefinition): string[] {
  const errors: string[] = [];
  if (definition.cadence?.mode !== "calendar_months"
    || !Number.isInteger(definition.cadence?.intervalMonths)
    || definition.cadence.intervalMonths < 1 || definition.cadence.intervalMonths > 12) errors.push("周期无效");
  if (!/^\d{4}-\d{2}-01$/.test(definition.cadence?.anchorDate ?? "")) errors.push("锚点日期无效");
  if (!definition.timezone) errors.push("时区缺失");
  if (!Number.isInteger(definition.dueRule?.offsetDays)
    || definition.dueRule.offsetDays < -31 || definition.dueRule.offsetDays > 365
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(definition.dueRule?.localTime ?? "")) errors.push("截止规则无效");
  if (!Number.isInteger(definition.defaultPreviewCount)
    || definition.defaultPreviewCount < 1 || definition.defaultPreviewCount > 12) errors.push("默认预览数量无效");
  if (!definition.sourceBinding?.bindingKey || !["manual_upload", "form_connector", "email", "sharepoint", "api", "sftp", "object_storage"].includes(definition.sourceBinding.type)
    || definition.externalDelivery !== "disabled") errors.push("资料来源边界无效");
  return errors;
}

function casePlanSourceType(connectorType: string): CasePlanDefinition["sourceBinding"]["type"] {
  if (connectorType === "form") return "form_connector";
  if (["manual_upload", "email", "sharepoint", "api", "sftp", "object_storage"].includes(connectorType)) {
    return connectorType as CasePlanDefinition["sourceBinding"]["type"];
  }
  throw new Error("unsupported_source_connector_type");
}

async function requireReader(client: PoolClient, actorId: string): Promise<"manager" | "admin"> {
  const result = await client.query<{ actor_type: "manager" | "admin" }>(
    "SELECT actor_type FROM actors WHERE id = $1 AND actor_type IN ('manager','admin') AND status = 'active'", [actorId],
  );
  const actorType = result.rows[0]?.actor_type;
  if (!actorType) throw new Error("manager_required");
  return actorType;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function databaseErrorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : "";
}
