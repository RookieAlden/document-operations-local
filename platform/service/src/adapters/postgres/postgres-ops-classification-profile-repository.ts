import type { Pool, PoolClient } from "pg";
import type {
  ClassificationProfileDefinition,
  ClassificationProfileDifference,
  OpsClassificationProfileEvaluationRun,
  OpsClassificationProfileMutationResult,
  OpsClassificationProfileRepository,
  OpsClassificationProfileSnapshot,
  OpsClassificationProfileVersion,
} from "../../ports/ops-classification-profile-repository.js";

interface VersionRow {
  id: string;
  profile_id: string;
  profile_key: string;
  profile_display_name: string;
  profile_description: string;
  version: number;
  revision: number;
  status: "draft" | "in_review" | "published" | "retired";
  definition: ClassificationProfileDefinition;
  definition_hash: string;
  reason: string;
  created_by_name: string | null;
  created_at: Date | string;
  published_at: Date | string | null;
  is_latest_revision: boolean;
  is_current_published: boolean;
  has_passing_evaluation: boolean;
}

interface EvaluationRow {
  id: string;
  profile_id: string;
  profile_version_id: string;
  definition_hash: string;
  result: Record<string, unknown>;
  status: "passed" | "failed";
  run_by_name: string;
  reason: string;
  created_at: Date | string;
}

export const CLASSIFICATION_QUALITY_FLAGS = [
  "blurry", "blank", "corrupt", "partial", "password_protected", "unsupported", "mime_mismatch", "other",
];
export const CLASSIFICATION_CONFLICT_FLAGS = [
  "subject_conflict", "period_conflict", "document_type_conflict", "duplicate_suspected", "other",
];

export class PostgresOpsClassificationProfileRepository implements OpsClassificationProfileRepository {
  constructor(private readonly pool: Pool) {}

  async getProfile(organizationKey: string, actorId: string, now: Date): Promise<OpsClassificationProfileSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      const actor = await client.query<{ actor_type: "staff" | "manager" | "admin" }>(
        "SELECT actor_type FROM actors WHERE id = $1 AND status = 'active'", [actorId],
      );
      const actorType = actor.rows[0]?.actor_type;
      if (actorType !== "manager" && actorType !== "admin") throw new Error("manager_required");
      const versions = await client.query<VersionRow>(`
        SELECT version.id, profile.id AS profile_id, profile.profile_key,
               profile.display_name AS profile_display_name,
               profile.description AS profile_description,
               version.version, version.revision, version.status, version.definition,
               version.definition_hash, version.reason,
               actor.display_name AS created_by_name, version.created_at, version.published_at,
               NOT EXISTS (
                   SELECT 1 FROM classification_profile_versions later
                    WHERE later.profile_id = version.profile_id
                      AND (later.version, later.revision) > (version.version, version.revision)
               ) AS is_latest_revision,
               profile.current_published_version_id = version.id AS is_current_published,
               EXISTS (
                   SELECT 1 FROM classification_profile_evaluation_runs evaluation
                    WHERE evaluation.profile_id = version.profile_id
                      AND evaluation.definition_hash = version.definition_hash
                      AND evaluation.status = 'passed'
               ) AS has_passing_evaluation
          FROM classification_profile_versions version
          JOIN classification_profiles profile ON profile.id = version.profile_id
          LEFT JOIN actors actor ON actor.id = version.created_by_actor_id
         WHERE profile.status = 'active'
         ORDER BY version.version DESC, version.revision DESC
      `);
      const evaluations = await client.query<EvaluationRow>(`
        SELECT evaluation.id, evaluation.profile_id, evaluation.profile_version_id,
               evaluation.definition_hash, evaluation.result, evaluation.status,
               actor.display_name AS run_by_name, evaluation.reason, evaluation.created_at
          FROM classification_profile_evaluation_runs evaluation
          JOIN actors actor ON actor.id = evaluation.run_by_actor_id
         ORDER BY evaluation.created_at DESC LIMIT 100
      `);
      const publishedDefinitions = new Map<string, ClassificationProfileDefinition>();
      for (const row of versions.rows) {
        if (row.is_current_published) publishedDefinitions.set(row.profile_id, row.definition);
      }
      return {
        generatedAt: now.toISOString(),
        canManage: actorType === "admin",
        versions: versions.rows.map((row) => toVersion(row, publishedDefinitions.get(row.profile_id))),
        evaluationRuns: evaluations.rows.map(toEvaluation),
        qualityFlags: CLASSIFICATION_QUALITY_FLAGS,
        conflictFlags: CLASSIFICATION_CONFLICT_FLAGS,
      };
    });
  }

  async cloneVersion(organizationKey: string, request: Parameters<OpsClassificationProfileRepository["cloneVersion"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_clone_classification_profile_version($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.versionId, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }

  async updateDraft(organizationKey: string, request: Parameters<OpsClassificationProfileRepository["updateDraft"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_update_classification_profile_draft($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.versionId, request.definition, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async runEvaluation(organizationKey: string, request: Parameters<OpsClassificationProfileRepository["runEvaluation"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_run_classification_profile_evaluation($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.versionId, request.reason, request.idempotencyKey,
        request.correlationId, request.now]);
  }

  async transitionVersion(organizationKey: string, request: Parameters<OpsClassificationProfileRepository["transitionVersion"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_transition_classification_profile_version($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.versionId, request.action, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  private async call(organizationKey: string, sql: string, values: unknown[]): Promise<OpsClassificationProfileMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsClassificationProfileMutationResult }>(sql, values);
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

function toVersion(row: VersionRow, published: ClassificationProfileDefinition | undefined): OpsClassificationProfileVersion {
  return {
    id: row.id, profileId: row.profile_id, profileKey: row.profile_key,
    profileDisplayName: row.profile_display_name, profileDescription: row.profile_description,
    version: Number(row.version), revision: Number(row.revision), status: row.status,
    definition: row.definition, definitionHash: row.definition_hash, reason: row.reason,
    createdByName: row.created_by_name, createdAt: iso(row.created_at),
    publishedAt: row.published_at ? iso(row.published_at) : null,
    isLatestRevision: row.is_latest_revision, isCurrentPublished: row.is_current_published,
    hasPassingEvaluation: row.has_passing_evaluation,
    differencesFromPublished: published && !row.is_current_published
      ? compareClassificationProfileDefinitions(published, row.definition) : [],
  };
}

function toEvaluation(row: EvaluationRow): OpsClassificationProfileEvaluationRun {
  return {
    id: row.id, profileId: row.profile_id, profileVersionId: row.profile_version_id,
    definitionHash: row.definition_hash, result: row.result, status: row.status,
    runByName: row.run_by_name, reason: row.reason, createdAt: iso(row.created_at),
  };
}

export function compareClassificationProfileDefinitions(
  before: unknown, after: unknown, path = "",
): ClassificationProfileDifference[] {
  if (Object.is(before, after)) return [];
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => compareClassificationProfileDefinitions(
      before[key], after[key], path ? `${path}.${key}` : key,
    ));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const maximum = Math.max(before.length, after.length);
    return Array.from({ length: maximum }, (_, index) => compareClassificationProfileDefinitions(
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
