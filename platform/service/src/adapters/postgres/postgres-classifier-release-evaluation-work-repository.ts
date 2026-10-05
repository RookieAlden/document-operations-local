import type { Pool, PoolClient } from "pg";
import type {
  ClaimedClassifierReleaseEvaluation,
  ClassifierReleaseDefinition,
  ClassifierReleaseEvaluationWorkRepository,
} from "../../ports/ops-classifier-release-repository.js";

interface EvaluationRow {
  id: string;
  organization_id: string;
  release_id: string;
  release_version_id: string;
  run_by_actor_id: string;
  correlation_id: string;
  lease_owner: string;
  lease_expires_at: Date;
  definition_hash: string;
  definition: ClassifierReleaseDefinition;
  profile_definition: { labels?: unknown };
}

export class PostgresClassifierReleaseEvaluationWorkRepository implements ClassifierReleaseEvaluationWorkRepository {
  constructor(private readonly pool: Pool) {}

  async claimNext(request: Parameters<ClassifierReleaseEvaluationWorkRepository["claimNext"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id", [request.organizationKey],
      );
      const organizationId = organization.rows[0]?.id;
      if (!organizationId) {
        await client.query("COMMIT");
        return null;
      }
      const leaseExpiresAt = new Date(request.now.getTime() + request.leaseSeconds * 1000);
      const result = await client.query<EvaluationRow>(`
        WITH candidate AS (
          SELECT evaluation.id
            FROM classifier_release_evaluation_runs evaluation
           WHERE evaluation.organization_id = $1
             AND evaluation.evaluation_kind = 'provider'
             AND (evaluation.status = 'queued'
                  OR (evaluation.status = 'running' AND evaluation.lease_expires_at < $2))
           ORDER BY evaluation.created_at
           FOR UPDATE OF evaluation SKIP LOCKED
           LIMIT 1
        ), claimed AS (
          UPDATE classifier_release_evaluation_runs evaluation
             SET status = 'running', lease_owner = $3, lease_expires_at = $4,
                 started_at = coalesce(evaluation.started_at, $2), updated_at = $2
            FROM candidate
           WHERE evaluation.id = candidate.id
           RETURNING evaluation.*
        )
        SELECT claimed.id, claimed.organization_id, claimed.release_id,
               claimed.release_version_id, claimed.run_by_actor_id, initial_event.correlation_id,
               claimed.lease_owner, claimed.lease_expires_at,
               claimed.definition_hash,
               release_version.definition,
               profile_version.definition AS profile_definition
          FROM claimed
          JOIN classifier_release_versions release_version
            ON release_version.organization_id = claimed.organization_id
           AND release_version.id = claimed.release_version_id
          JOIN workflow_events initial_event
            ON initial_event.organization_id = claimed.organization_id
           AND initial_event.id = claimed.event_id
          JOIN classification_profile_versions profile_version
            ON profile_version.organization_id = claimed.organization_id
           AND profile_version.id = (release_version.definition->>'classificationProfileVersionId')::uuid
           AND profile_version.definition_hash = release_version.definition->>'classificationProfileDefinitionHash'`,
        [organizationId, request.now, request.workerId, leaseExpiresAt],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row ? toClaimed(row) : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async complete(request: Parameters<ClassifierReleaseEvaluationWorkRepository["complete"]>[0]): Promise<void> {
    await this.finish(request.evaluation, request.status, request.result, request.now);
  }

  async fail(request: Parameters<ClassifierReleaseEvaluationWorkRepository["fail"]>[0]): Promise<void> {
    await this.finish(request.evaluation, "failed", {
      passed: false,
      definitionHash: request.evaluation.definitionHash,
      errorCode: request.errorCode,
      providerCallCount: 0,
      persistedDocuments: false,
      externalDelivery: "disabled",
    }, request.now);
  }

  private async finish(
    evaluation: ClaimedClassifierReleaseEvaluation,
    status: "passed" | "failed",
    result: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT dop_set_organization_context_by_id($1)", [evaluation.organizationId]);
      const updated = await client.query(`
        UPDATE classifier_release_evaluation_runs
           SET status = $3, result = $4::jsonb, completed_at = $5,
               lease_owner = NULL, lease_expires_at = NULL, updated_at = $5
         WHERE organization_id = $1 AND id = $2
           AND evaluation_kind = 'provider' AND status = 'running'
           AND definition_hash = $6 AND lease_owner = $7 AND lease_expires_at = $8
         RETURNING id`, [evaluation.organizationId, evaluation.id, status, JSON.stringify(result), now,
          evaluation.definitionHash, evaluation.leaseOwner, evaluation.leaseExpiresAt]);
      if (updated.rowCount !== 1) throw new Error("classifier_release_evaluation_lease_lost");
      await client.query(`
        INSERT INTO workflow_events (
          id, organization_id, idempotency_key, event_type, event_version,
          aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
        ) VALUES (gen_random_uuid(),$1,$2,'ClassifierRelease.ProviderEvaluationCompleted',1,
          'classifier_release',$3,$4,$5,'classifier-release-evaluator',$6::jsonb,$7)
        ON CONFLICT (organization_id,idempotency_key) DO NOTHING`, [
        evaluation.organizationId, `classifier-release-provider-evaluation-completed|${evaluation.id}`,
        evaluation.releaseId, evaluation.correlationId, evaluation.actorId, JSON.stringify({
          evaluation_run_id: evaluation.id,
          release_version_id: evaluation.releaseVersionId,
          definition_hash: evaluation.definitionHash,
          status,
          provider_call_count: result.providerCallCount ?? 0,
          persisted_documents: false,
          external_delivery: "disabled",
        }), now,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

function toClaimed(row: EvaluationRow): ClaimedClassifierReleaseEvaluation {
  const labels = Array.isArray(row.profile_definition.labels) ? row.profile_definition.labels : [];
  return {
    id: row.id,
    organizationId: row.organization_id,
    releaseId: row.release_id,
    releaseVersionId: row.release_version_id,
    actorId: row.run_by_actor_id,
    correlationId: row.correlation_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    definitionHash: row.definition_hash,
    definition: row.definition,
    allowedDocumentTypes: labels.flatMap((value) => {
      if (!isRecord(value) || typeof value.code !== "string" || typeof value.displayName !== "string") return [];
      return [{ code: value.code, displayName: value.displayName,
        ...(typeof value.description === "string" ? { description: value.description } : {}) }];
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
