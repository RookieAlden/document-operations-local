import type { Pool, PoolClient } from "pg";
import type {
  ClassifierReleaseDefinition,
  ClassifierReleaseDifference,
  OpsClassifierReleaseEvaluationRun,
  OpsClassifierReleaseMutationResult,
  OpsClassifierReleaseRepository,
  OpsClassifierReleaseSnapshot,
  OpsClassifierReleaseVersion,
} from "../../ports/ops-classifier-release-repository.js";

interface VersionRow {
  id: string;
  release_id: string;
  release_key: string;
  release_display_name: string;
  release_description: string;
  prompt_version_id: string | null;
  version: number;
  revision: number;
  status: "draft" | "in_review" | "published" | "retired";
  definition: ClassifierReleaseDefinition;
  definition_hash: string;
  reason: string;
  created_by_name: string | null;
  created_at: Date | string;
  published_at: Date | string | null;
  is_latest_revision: boolean;
  is_current_published: boolean;
  has_passing_compatibility_evaluation: boolean;
  has_passing_provider_evaluation: boolean;
}

interface EvaluationRow {
  id: string;
  release_id: string;
  release_version_id: string;
  definition_hash: string;
  evaluation_kind: "compatibility" | "provider";
  status: "queued" | "running" | "passed" | "failed";
  result: Record<string, unknown>;
  run_by_name: string;
  reason: string;
  created_at: Date | string;
  completed_at: Date | string | null;
}

export class PostgresOpsClassifierReleaseRepository implements OpsClassifierReleaseRepository {
  constructor(private readonly pool: Pool) {}

  async getReleases(organizationKey: string, actorId: string, now: Date): Promise<OpsClassifierReleaseSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      const actor = await client.query<{ actor_type: "staff" | "manager" | "admin" }>(
        "SELECT actor_type FROM actors WHERE id = $1 AND status = 'active'", [actorId],
      );
      const actorType = actor.rows[0]?.actor_type;
      if (actorType !== "manager" && actorType !== "admin") throw new Error("manager_required");
      const versions = await client.query<VersionRow>(`
        SELECT version.id, release.id AS release_id, release.release_key,
               release.display_name AS release_display_name,
               release.description AS release_description,
               version.prompt_version_id, version.version, version.revision, version.status,
               version.definition, version.definition_hash, version.reason,
               actor.display_name AS created_by_name, version.created_at, version.published_at,
               NOT EXISTS (
                   SELECT 1 FROM classifier_release_versions later
                    WHERE later.release_id = version.release_id
                      AND (later.version, later.revision) > (version.version, version.revision)
               ) AS is_latest_revision,
               release.current_published_version_id = version.id AS is_current_published,
               EXISTS (
                   SELECT 1 FROM classifier_release_evaluation_runs evaluation
                    WHERE evaluation.release_id = version.release_id
                      AND evaluation.definition_hash = version.definition_hash
                      AND evaluation.evaluation_kind = 'compatibility'
                      AND evaluation.status = 'passed'
               ) AS has_passing_compatibility_evaluation,
               EXISTS (
                   SELECT 1 FROM classifier_release_evaluation_runs evaluation
                    WHERE evaluation.release_id = version.release_id
                      AND evaluation.definition_hash = version.definition_hash
                      AND evaluation.evaluation_kind = 'provider'
                      AND evaluation.status = 'passed'
               ) AS has_passing_provider_evaluation
          FROM classifier_release_versions version
          JOIN classifier_releases release ON release.id = version.release_id
          LEFT JOIN actors actor ON actor.id = version.created_by_actor_id
         WHERE release.status = 'active'
         ORDER BY version.version DESC, version.revision DESC
      `);
      const evaluations = await client.query<EvaluationRow>(`
        SELECT evaluation.id, evaluation.release_id, evaluation.release_version_id,
               evaluation.definition_hash, evaluation.evaluation_kind, evaluation.status,
               evaluation.result, actor.display_name AS run_by_name, evaluation.reason,
               evaluation.created_at, evaluation.completed_at
          FROM classifier_release_evaluation_runs evaluation
          JOIN actors actor ON actor.id = evaluation.run_by_actor_id
         ORDER BY evaluation.created_at DESC LIMIT 100
      `);
      const publishedDefinitions = new Map<string, ClassifierReleaseDefinition>();
      for (const row of versions.rows) {
        if (row.is_current_published) publishedDefinitions.set(row.release_id, row.definition);
      }
      return {
        generatedAt: now.toISOString(),
        canManage: actorType === "admin",
        versions: versions.rows.map((row) => toVersion(row, publishedDefinitions.get(row.release_id))),
        evaluationRuns: evaluations.rows.map(toEvaluation),
      };
    });
  }

  async cloneVersion(organizationKey: string, request: Parameters<OpsClassifierReleaseRepository["cloneVersion"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_clone_classifier_release_version($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.versionId, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }

  async updateDraft(organizationKey: string, request: Parameters<OpsClassifierReleaseRepository["updateDraft"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_update_classifier_release_draft($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.versionId, request.definition, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async requestEvaluation(organizationKey: string, request: Parameters<OpsClassifierReleaseRepository["requestEvaluation"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_request_classifier_release_evaluation($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.versionId, request.evaluationKind, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async transitionVersion(organizationKey: string, request: Parameters<OpsClassifierReleaseRepository["transitionVersion"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_transition_classifier_release_version($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.versionId, request.action, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  private async call(organizationKey: string, sql: string, values: unknown[]): Promise<OpsClassifierReleaseMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsClassifierReleaseMutationResult }>(sql, values);
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

function toVersion(row: VersionRow, published: ClassifierReleaseDefinition | undefined): OpsClassifierReleaseVersion {
  return {
    id: row.id, releaseId: row.release_id, releaseKey: row.release_key,
    releaseDisplayName: row.release_display_name, releaseDescription: row.release_description,
    promptVersionId: row.prompt_version_id, version: Number(row.version), revision: Number(row.revision),
    status: row.status, definition: row.definition, definitionHash: row.definition_hash, reason: row.reason,
    createdByName: row.created_by_name, createdAt: iso(row.created_at),
    publishedAt: row.published_at ? iso(row.published_at) : null,
    isLatestRevision: row.is_latest_revision, isCurrentPublished: row.is_current_published,
    hasPassingCompatibilityEvaluation: row.has_passing_compatibility_evaluation,
    hasPassingProviderEvaluation: row.has_passing_provider_evaluation,
    differencesFromPublished: published && !row.is_current_published
      ? compareClassifierReleaseDefinitions(published, row.definition) : [],
  };
}

function toEvaluation(row: EvaluationRow): OpsClassifierReleaseEvaluationRun {
  return {
    id: row.id, releaseId: row.release_id, releaseVersionId: row.release_version_id,
    definitionHash: row.definition_hash, evaluationKind: row.evaluation_kind, status: row.status,
    result: row.result, runByName: row.run_by_name, reason: row.reason,
    createdAt: iso(row.created_at), completedAt: row.completed_at ? iso(row.completed_at) : null,
  };
}

export function compareClassifierReleaseDefinitions(
  before: unknown, after: unknown, path = "",
): ClassifierReleaseDifference[] {
  if (Object.is(before, after)) return [];
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => compareClassifierReleaseDefinitions(
      before[key], after[key], path ? `${path}.${key}` : key,
    ));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const maximum = Math.max(before.length, after.length);
    return Array.from({ length: maximum }, (_, index) => compareClassifierReleaseDefinitions(
      before[index], after[index], `${path}[${index}]`,
    )).flat();
  }
  return [{ path: path || "definition", before, after,
    kind: before === undefined ? "added" : after === undefined ? "removed" : "changed" }];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
