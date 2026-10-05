import type { Pool, PoolClient } from "pg";
import { ConnectorAdapterReplayError, replayConnectorAdapter } from "../../connectors/adapter-contract.js";
import type {
  OpsSourceConnectorMutationResult,
  OpsSourceConnectorRepository,
  OpsSourceConnectorSnapshot,
  OpsSourceConnectorTestRun,
  OpsSourceConnectorVersion,
  SourceConnectorDefinition,
  SourceConnectorDifference,
} from "../../ports/ops-source-connector-repository.js";

interface VersionRow {
  id: string; connector_id: string; connector_key: string; display_name: string; description: string;
  lifecycle_status: "registered" | "active" | "suspended" | "revoked";
  version: number; revision: number;
  status: "draft" | "in_review" | "approved" | "active" | "suspended" | "revoked";
  definition: SourceConnectorDefinition; enforcement_profile: OpsSourceConnectorVersion["enforcementProfile"];
  definition_hash: string; reason: string;
  created_by_name: string | null; created_at: Date | string;
  is_latest_revision: boolean; is_current_version: boolean; is_active_version: boolean;
  has_passing_test: boolean; referenced_by_plan_count: number;
}

interface TestRow {
  id: string; connector_id: string; connector_version_id: string; definition_hash: string;
  status: "passed" | "failed"; result: Record<string, unknown>; run_by_name: string | null;
  adapter_contract_version: "1.0" | null; replay_hash: string | null;
  reason: string; created_at: Date | string;
}

export const SOURCE_CONNECTOR_TYPES = ["manual_upload", "form", "email", "sharepoint", "api", "sftp", "object_storage"] as const;
export const SOURCE_CONNECTOR_CAPABILITIES = ["documents", "metadata", "attachments", "webhook", "polling"] as const;

export class PostgresOpsSourceConnectorRepository implements OpsSourceConnectorRepository {
  constructor(private readonly pool: Pool) {}

  async getConnectors(organizationKey: string, actorId: string, now: Date): Promise<OpsSourceConnectorSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      const actor = await client.query<{ actor_type: "staff" | "manager" | "admin" }>(
        "SELECT actor_type FROM actors WHERE id=$1 AND status='active'", [actorId],
      );
      const actorType = actor.rows[0]?.actor_type;
      if (actorType !== "manager" && actorType !== "admin") throw new Error("manager_required");
      const versions = await client.query<VersionRow>(`
        SELECT version.id, connector.id AS connector_id, connector.connector_key,
               connector.display_name, connector.description, connector.lifecycle_status,
               version.version, version.revision, version.status, version.definition,version.enforcement_profile,
               version.definition_hash, version.reason, actor.display_name AS created_by_name,
               version.created_at,
               NOT EXISTS (
                 SELECT 1 FROM source_connector_versions later
                  WHERE later.connector_id=version.connector_id
                    AND (later.version,later.revision)>(version.version,version.revision)
               ) AS is_latest_revision,
               connector.current_version_id=version.id AS is_current_version,
               connector.active_version_id=version.id AS is_active_version,
               EXISTS (
                 SELECT 1 FROM source_connector_test_runs test
                  WHERE test.connector_id=version.connector_id
                    AND test.definition_hash=version.definition_hash AND test.status='passed'
               ) AS has_passing_test,
               (SELECT count(*)::int FROM case_plan_versions plan
                 WHERE plan.organization_id=version.organization_id
                   AND plan.source_connector_version_id=version.id
                   AND plan.status='published') AS referenced_by_plan_count
          FROM source_connector_versions version
          JOIN source_connectors connector ON connector.id=version.connector_id
          LEFT JOIN actors actor ON actor.id=version.created_by_actor_id
         ORDER BY connector.connector_key,version.version DESC,version.revision DESC
      `);
      const tests = await client.query<TestRow>(`
        SELECT test.id,test.connector_id,test.connector_version_id,test.definition_hash,
               test.status,test.result,test.adapter_contract_version,test.replay_hash,
               actor.display_name AS run_by_name,test.reason,test.created_at
          FROM source_connector_test_runs test
          LEFT JOIN actors actor ON actor.id=test.run_by_actor_id
         ORDER BY test.created_at DESC LIMIT 100
      `);
      const activeDefinitions = new Map<string, SourceConnectorDefinition>();
      for (const row of versions.rows) if (row.is_active_version) activeDefinitions.set(row.connector_id, row.definition);
      return {
        generatedAt: now.toISOString(), canManage: actorType === "admin",
        versions: versions.rows.map((row) => toVersion(row, activeDefinitions.get(row.connector_id))),
        testRuns: tests.rows.map(toTest), supportedTypes: [...SOURCE_CONNECTOR_TYPES],
        supportedCapabilities: [...SOURCE_CONNECTOR_CAPABILITIES],
      };
    });
  }

  async createConnector(organizationKey: string, request: Parameters<OpsSourceConnectorRepository["createConnector"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_create_source_connector($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
      [request.actorId,request.connectorKey,request.displayName,request.description,request.definition,
        request.reason,request.idempotencyKey,request.correlationId,request.now]);
  }

  async updateDraft(organizationKey: string, request: Parameters<OpsSourceConnectorRepository["updateDraft"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_update_source_connector_draft($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId,request.versionId,request.definition,request.reason,request.idempotencyKey,
        request.correlationId,request.now]);
  }

  async runTest(organizationKey: string, request: Parameters<OpsSourceConnectorRepository["runTest"]>[1]):Promise<OpsSourceConnectorMutationResult> {
    return await this.transaction<OpsSourceConnectorMutationResult>(organizationKey, async (client) => {
      const version=await client.query<{
        definition: SourceConnectorDefinition; definition_hash: string;
        enforcement_profile: OpsSourceConnectorVersion["enforcementProfile"];
      }>(`SELECT definition,definition_hash,enforcement_profile FROM source_connector_versions WHERE id=$1`,[request.versionId]);
      const row=version.rows[0];
      if (!row) return {outcome:"not_found",reason:"source_connector_version_not_found"};
      const definition:SourceConnectorDefinition={...row.definition,dataBoundary:{...row.definition.dataBoundary,
        maxFilesPerSubmission:row.definition.dataBoundary.maxFilesPerSubmission ?? row.enforcement_profile.maxFilesPerSubmission}};
      let evidence;
      try { evidence=replayConnectorAdapter(definition,row.definition_hash); }
      catch (error) {
        if (error instanceof ConnectorAdapterReplayError) return {outcome:"conflict",reason:error.code};
        throw error;
      }
      const result=await client.query<{result:OpsSourceConnectorMutationResult}>(
        "SELECT dop_record_source_connector_adapter_replay($1,$2,$3,$4,$5,$6,$7) AS result",
        [request.actorId,request.versionId,evidence,request.reason,request.idempotencyKey,request.correlationId,request.now]);
      return result.rows[0]?.result ?? {outcome:"conflict",reason:"mutation_failed"};
    });
  }

  async transitionVersion(organizationKey: string, request: Parameters<OpsSourceConnectorRepository["transitionVersion"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_transition_source_connector_version($1,$2,$3,$4,$5,$6,$7) AS result",
      [request.actorId,request.versionId,request.action,request.reason,request.idempotencyKey,
        request.correlationId,request.now]);
  }

  private async call(organizationKey: string, sql: string, values: unknown[]): Promise<OpsSourceConnectorMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsSourceConnectorMutationResult }>(sql, values);
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

function toVersion(row: VersionRow, active: SourceConnectorDefinition | undefined): OpsSourceConnectorVersion {
  return {
    id:row.id,connectorId:row.connector_id,connectorKey:row.connector_key,displayName:row.display_name,
    description:row.description,lifecycleStatus:row.lifecycle_status,version:Number(row.version),revision:Number(row.revision),
    status:row.status,definition:row.definition,enforcementProfile:row.enforcement_profile,
    definitionHash:row.definition_hash,reason:row.reason,
    createdByName:row.created_by_name,createdAt:iso(row.created_at),isLatestRevision:row.is_latest_revision,
    isCurrentVersion:row.is_current_version,isActiveVersion:row.is_active_version,
    hasPassingTest:row.has_passing_test,referencedByPlanCount:Number(row.referenced_by_plan_count),
    differencesFromActive:active && !row.is_active_version ? compareSourceConnectorDefinitions(active,row.definition) : [],
  };
}

function toTest(row: TestRow): OpsSourceConnectorTestRun {
  return { id:row.id,connectorId:row.connector_id,connectorVersionId:row.connector_version_id,
    definitionHash:row.definition_hash,status:row.status,result:row.result,runByName:row.run_by_name,
    adapterContractVersion:row.adapter_contract_version,replayHash:row.replay_hash,
    reason:row.reason,createdAt:iso(row.created_at) };
}

export function compareSourceConnectorDefinitions(before: unknown, after: unknown, path=""): SourceConnectorDifference[] {
  if (Object.is(before,after)) return [];
  if (isObject(before) && isObject(after)) {
    const keys=[...new Set([...Object.keys(before),...Object.keys(after)])].sort();
    return keys.flatMap((key)=>compareSourceConnectorDefinitions(before[key],after[key],path?`${path}.${key}`:key));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const maximum=Math.max(before.length,after.length);
    return Array.from({length:maximum},(_,index)=>compareSourceConnectorDefinitions(before[index],after[index],`${path}[${index}]`)).flat();
  }
  return [{path:path||"definition",before,after,kind:before===undefined?"added":after===undefined?"removed":"changed"}];
}
function isObject(value: unknown): value is Record<string,unknown> { return Boolean(value)&&typeof value==="object"&&!Array.isArray(value); }
function iso(value: Date|string): string { return value instanceof Date?value.toISOString():new Date(value).toISOString(); }
