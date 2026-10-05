import type { Pool, PoolClient } from "pg";
import type {
  OpsReleaseDecision,
  OpsReleaseManifest,
  OpsReleaseReadinessMutationResult,
  OpsReleaseReadinessRepository,
  OpsReleaseReadinessRun,
  OpsReleaseReadinessSnapshot,
  ReleaseComponentPin,
  ReleaseReadinessDeclarations,
} from "../../ports/ops-release-readiness-repository.js";

interface ManifestRow {
  id: string; manifest_key: string; version: number; status: OpsReleaseManifest["status"];
  source_environment: "DEV"; target_environment: "UAT"; component_snapshot: ReleaseComponentPin[];
  component_snapshot_hash: string; readiness_declarations: ReleaseReadinessDeclarations;
  declarations_hash: string; manifest_hash: string; rollback_manifest_id: string | null;
  created_by_name: string | null; submitted_by_name: string | null; approved_by_name: string | null;
  reason: string; created_at: Date | string; submitted_at: Date | string | null; approved_at: Date | string | null;
}
interface RunRow {
  id: string; manifest_id: string; status: "passed" | "blocked"; blocker_count: number;
  drift_detected: boolean; checks: OpsReleaseReadinessRun["checks"];
  run_by_name: string | null; reason: string; created_at: Date | string;
}
interface DecisionRow {
  id: string; manifest_id: string; action: "approved" | "rejected";
  decided_by_name: string | null; reason: string; decided_at: Date | string;
}

export class PostgresOpsReleaseReadinessRepository implements OpsReleaseReadinessRepository {
  constructor(private readonly pool: Pool) {}

  async getSnapshot(organizationKey: string, actorId: string, now: Date): Promise<OpsReleaseReadinessSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      const actor = await client.query<{ actor_type: "staff" | "manager" | "admin" }>(
        "SELECT actor_type FROM actors WHERE id=$1 AND status='active'", [actorId],
      );
      const actorType = actor.rows[0]?.actor_type;
      if (actorType !== "manager" && actorType !== "admin") throw new Error("manager_required");
      const manifests = await client.query<ManifestRow>(`
        SELECT manifest.id,manifest.manifest_key,manifest.version,manifest.status,
               manifest.source_environment,manifest.target_environment,manifest.component_snapshot,
               manifest.component_snapshot_hash,manifest.readiness_declarations,manifest.declarations_hash,
               manifest.manifest_hash,manifest.rollback_manifest_id,creator.display_name AS created_by_name,
               submitter.display_name AS submitted_by_name,approver.display_name AS approved_by_name,
               manifest.reason,manifest.created_at,manifest.submitted_at,manifest.approved_at
          FROM release_manifests manifest
          LEFT JOIN actors creator ON creator.id=manifest.created_by_actor_id
          LEFT JOIN actors submitter ON submitter.id=manifest.submitted_by_actor_id
          LEFT JOIN actors approver ON approver.id=manifest.approved_by_actor_id
         ORDER BY manifest.manifest_key,manifest.version DESC LIMIT 50
      `);
      const runs = await client.query<RunRow>(`
        SELECT run.id,run.manifest_id,run.status,run.blocker_count,run.drift_detected,run.checks,
               actor.display_name AS run_by_name,run.reason,run.created_at
          FROM release_readiness_runs run LEFT JOIN actors actor ON actor.id=run.run_by_actor_id
         ORDER BY run.created_at DESC LIMIT 200
      `);
      const decisions = await client.query<DecisionRow>(`
        SELECT decision.id,decision.manifest_id,decision.action,actor.display_name AS decided_by_name,
               decision.reason,decision.decided_at
          FROM release_approval_decisions decision
          LEFT JOIN actors actor ON actor.id=decision.decided_by_actor_id
         ORDER BY decision.decided_at DESC LIMIT 100
      `);
      const runsByManifest = new Map<string, OpsReleaseReadinessRun[]>();
      for (const row of runs.rows) {
        const list = runsByManifest.get(row.manifest_id) ?? [];
        list.push(toRun(row)); runsByManifest.set(row.manifest_id, list);
      }
      const decisionsByManifest = new Map<string, OpsReleaseDecision[]>();
      for (const row of decisions.rows) {
        const list = decisionsByManifest.get(row.manifest_id) ?? [];
        list.push(toDecision(row)); decisionsByManifest.set(row.manifest_id, list);
      }
      return {
        generatedAt: now.toISOString(), canManage: actorType === "admin", canApprove: true,
        manifests: manifests.rows.map((row) => toManifest(
          row, runsByManifest.get(row.id)?.[0] ?? null, decisionsByManifest.get(row.id) ?? [],
        )),
      };
    });
  }

  async createManifest(organizationKey: string, request: Parameters<OpsReleaseReadinessRepository["createManifest"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_create_release_manifest($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.manifestKey, request.declarations, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }
  async evaluateManifest(organizationKey: string, request: Parameters<OpsReleaseReadinessRepository["evaluateManifest"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_evaluate_release_manifest($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.manifestId, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }
  async submitManifest(organizationKey: string, request: Parameters<OpsReleaseReadinessRepository["submitManifest"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_submit_release_manifest($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.manifestId, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }
  async decideManifest(organizationKey: string, request: Parameters<OpsReleaseReadinessRepository["decideManifest"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_decide_release_manifest($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId, request.manifestId, request.action, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  private async call(organizationKey: string, sql: string, values: unknown[]): Promise<OpsReleaseReadinessMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsReleaseReadinessMutationResult }>(sql, values);
      return result.rows[0]?.result ?? { outcome: "conflict", reason: "mutation_failed" };
    });
  }
  private async transaction<T>(organizationKey: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", [organizationKey]);
      if (!organization.rows[0]?.id) throw new Error("organization_not_found");
      const result = await operation(client); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}

function toManifest(row: ManifestRow, latestRun: OpsReleaseReadinessRun | null, decisions: OpsReleaseDecision[]): OpsReleaseManifest {
  return {
    id: row.id, manifestKey: row.manifest_key, version: Number(row.version), status: row.status,
    sourceEnvironment: row.source_environment, targetEnvironment: row.target_environment,
    components: row.component_snapshot, componentSnapshotHash: row.component_snapshot_hash,
    readinessDeclarations: row.readiness_declarations, declarationsHash: row.declarations_hash,
    manifestHash: row.manifest_hash, rollbackManifestId: row.rollback_manifest_id,
    createdByName: row.created_by_name, submittedByName: row.submitted_by_name,
    approvedByName: row.approved_by_name, reason: row.reason, createdAt: iso(row.created_at)!,
    submittedAt: iso(row.submitted_at), approvedAt: iso(row.approved_at), latestRun, decisions,
  };
}
function toRun(row: RunRow): OpsReleaseReadinessRun {
  return { id: row.id, manifestId: row.manifest_id, status: row.status,
    blockerCount: Number(row.blocker_count), driftDetected: row.drift_detected, checks: row.checks,
    runByName: row.run_by_name, reason: row.reason, createdAt: iso(row.created_at)! };
}
function toDecision(row: DecisionRow): OpsReleaseDecision {
  return { id: row.id, manifestId: row.manifest_id, action: row.action,
    decidedByName: row.decided_by_name, reason: row.reason, decidedAt: iso(row.decided_at)! };
}
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
