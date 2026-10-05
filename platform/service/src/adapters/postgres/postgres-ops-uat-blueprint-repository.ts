import type { Pool, PoolClient } from "pg";
import type {
  OpsUatBlueprint,
  OpsUatBlueprintDryRun,
  OpsUatBlueprintMutationResult,
  OpsUatProvisioningPackage,
  OpsUatProvisioningPackageDryRun,
  OpsUatActivationApprovalPack,
  OpsUatActivationDecision,
  OpsUatActivationEvaluation,
  OpsUatFinalAuthorizationRequest,
  OpsUatFinalAuthorizationEvaluation,
  OpsUatBlueprintRepository,
  OpsUatBlueprintSnapshot,
  OpsUatAuthorizationRecompilation,
  UatBlueprintDryRunCheck,
  UatEnvironmentBlueprintDefinition,
} from "../../ports/ops-uat-blueprint-repository.js";

interface BlueprintRow {
  id: string; blueprint_key: string; version: number; status: "draft" | "superseded";
  release_manifest_id: string | null; release_manifest_label: string | null;
  definition: UatEnvironmentBlueprintDefinition; definition_hash: string;
  deployment_plan: OpsUatBlueprint["deploymentPlan"]; deployment_plan_hash: string;
  previous_blueprint_id: string | null; created_by_name: string | null; reason: string; created_at: Date | string;
}
interface ProvisioningPackageRow {
  id: string; package_key: string; version: number; status: "compiled" | "superseded";
  blueprint_id: string; blueprint_label: string; definition: OpsUatProvisioningPackage["definition"];
  definition_hash: string; runbook_hash: string; previous_package_id: string | null;
  compiled_by_name: string | null; reason: string; created_at: Date | string;
}
interface ProvisioningPackageRunRow {
  id: string; package_id: string; status: "passed"; execution_decision: "no_go"; blocker_count: 0;
  checks: UatBlueprintDryRunCheck[]; side_effects: Record<string, unknown>;
  run_by_name: string | null; reason: string; created_at: Date | string;
}
interface DryRunRow {
  id: string; blueprint_id: string; status: "passed" | "blocked"; blocker_count: number;
  checks: UatBlueprintDryRunCheck[]; side_effects: Record<string, unknown>;
  run_by_name: string | null; reason: string; created_at: Date | string;
}
interface ActivationPackRow {
  id:string; approval_pack_key:string; version:number; status:"draft"|"superseded";
  provisioning_package_id:string; provisioning_package_label:string;
  definition:OpsUatActivationApprovalPack["definition"]; definition_hash:string;
  previous_approval_pack_id:string|null; compiled_by_name:string|null; reason:string; created_at:Date|string;
}
interface ActivationDecisionRow {
  id:string; approval_pack_id:string; decision_key:OpsUatActivationDecision["decisionKey"]; version:number;
  status:"approved"|"rejected"; evidence:Record<string,unknown>; evidence_hash:string;
  decided_by_name:string|null; reason:string; created_at:Date|string;
}
interface ActivationEvaluationRow {
  id:string; approval_pack_id:string; status:"passed"|"blocked";
  recommendation:"ready_for_final_authorization"|"blocked"; execution_decision:"no_go";
  blocker_count:number; checks:UatBlueprintDryRunCheck[]; side_effects:Record<string,unknown>;
  run_by_name:string|null; reason:string; created_at:Date|string;
}
interface FinalAuthorizationRequestRow {
  id:string; request_key:string; version:number; status:"draft"|"superseded";
  approval_pack_id:string; approval_pack_label:string; definition:OpsUatFinalAuthorizationRequest["definition"];
  definition_hash:string; change_set_hash:string; previous_request_id:string|null;
  compiled_by_name:string|null; reason:string; created_at:Date|string;
}
interface FinalAuthorizationEvaluationRow {
  id:string; request_id:string; status:"ready"|"blocked"; recommendation:"ready_for_submission"|"blocked";
  execution_decision:"no_go"; blocker_count:number; checks:UatBlueprintDryRunCheck[];
  side_effects:Record<string,unknown>; run_by_name:string|null; reason:string; created_at:Date|string;
}
interface AuthorizationRecompilationRow {
  id:string; authorization_key:string; version:number;
  current_policy:OpsUatAuthorizationRecompilation["currentPolicy"];
  cost_plan:Record<string,unknown>; iac_plan:Record<string,unknown>;
  secret_references:OpsUatAuthorizationRecompilation["secretReferences"];
  destruction_plan:OpsUatAuthorizationRecompilation["destructionPlan"];
  actual_effects:Record<string,unknown>; bundle_hash:string;
  compiled_by_name:string|null; reason:string; created_at:Date|string;
}

export class PostgresOpsUatBlueprintRepository implements OpsUatBlueprintRepository {
  constructor(private readonly pool: Pool) {}

  async getSnapshot(organizationKey: string, actorId: string, now: Date): Promise<OpsUatBlueprintSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      const actor = await client.query<{ actor_type: "staff" | "manager" | "admin" }>(
        "SELECT actor_type FROM actors WHERE id=$1 AND status='active'", [actorId],
      );
      const actorType = actor.rows[0]?.actor_type;
      if (actorType !== "manager" && actorType !== "admin") throw new Error("manager_required");
      const manifests = await client.query<{ id: string; manifest_key: string; version: number; status: string }>(`
        SELECT id,manifest_key,version,status FROM release_manifests
         ORDER BY manifest_key,version DESC LIMIT 50
      `);
      const blueprints = await client.query<BlueprintRow>(`
        SELECT blueprint.id,blueprint.blueprint_key,blueprint.version,blueprint.status,
               blueprint.release_manifest_id,
               CASE WHEN manifest.id IS NULL THEN NULL ELSE concat(manifest.manifest_key,' · v',manifest.version,' · ',manifest.status) END AS release_manifest_label,
               blueprint.definition,blueprint.definition_hash,blueprint.deployment_plan,
               blueprint.deployment_plan_hash,blueprint.previous_blueprint_id,
               actor.display_name AS created_by_name,blueprint.reason,blueprint.created_at
          FROM uat_environment_blueprints blueprint
          LEFT JOIN release_manifests manifest ON manifest.id=blueprint.release_manifest_id
          LEFT JOIN actors actor ON actor.id=blueprint.created_by_actor_id
         ORDER BY blueprint.blueprint_key,blueprint.version DESC LIMIT 50
      `);
      const dryRuns = await client.query<DryRunRow>(`
        SELECT run.id,run.blueprint_id,run.status,run.blocker_count,run.checks,run.side_effects,
               actor.display_name AS run_by_name,run.reason,run.created_at
          FROM uat_blueprint_dry_runs run LEFT JOIN actors actor ON actor.id=run.run_by_actor_id
         ORDER BY run.created_at DESC,id DESC LIMIT 200
      `);
      const packages = await client.query<ProvisioningPackageRow>(`
        SELECT package.id,package.package_key,package.version,package.status,package.blueprint_id,
               concat(blueprint.blueprint_key,' · v',blueprint.version) AS blueprint_label,
               package.definition,package.definition_hash,package.runbook_hash,package.previous_package_id,
               actor.display_name AS compiled_by_name,package.reason,package.created_at
          FROM uat_provisioning_packages package
          JOIN uat_environment_blueprints blueprint ON blueprint.id=package.blueprint_id
          LEFT JOIN actors actor ON actor.id=package.compiled_by_actor_id
         ORDER BY package.package_key,package.version DESC LIMIT 50
      `);
      const packageRuns = await client.query<ProvisioningPackageRunRow>(`
        SELECT run.id,run.package_id,run.status,run.execution_decision,run.blocker_count,run.checks,
               run.side_effects,actor.display_name AS run_by_name,run.reason,run.created_at
          FROM uat_provisioning_package_dry_runs run
          LEFT JOIN actors actor ON actor.id=run.run_by_actor_id
         ORDER BY run.created_at DESC,run.id DESC LIMIT 200
      `);
      const approvalPacks=await client.query<ActivationPackRow>(`
        SELECT approval.id,approval.approval_pack_key,approval.version,approval.status,
               approval.provisioning_package_id,
               concat(package.package_key,' · v',package.version) AS provisioning_package_label,
               approval.definition,approval.definition_hash,approval.previous_approval_pack_id,
               actor.display_name AS compiled_by_name,approval.reason,approval.created_at
          FROM uat_activation_approval_packs approval
          JOIN uat_provisioning_packages package ON package.id=approval.provisioning_package_id
          LEFT JOIN actors actor ON actor.id=approval.compiled_by_actor_id
         ORDER BY approval.approval_pack_key,approval.version DESC LIMIT 50
      `);
      const approvalDecisions=await client.query<ActivationDecisionRow>(`
        SELECT DISTINCT ON (decision.approval_pack_id,decision.decision_key)
               decision.id,decision.approval_pack_id,decision.decision_key,decision.version,
               decision.status,decision.evidence,decision.evidence_hash,
               actor.display_name AS decided_by_name,decision.reason,decision.created_at
          FROM uat_activation_approval_decisions decision
          LEFT JOIN actors actor ON actor.id=decision.decided_by_actor_id
         ORDER BY decision.approval_pack_id,decision.decision_key,decision.version DESC LIMIT 200
      `);
      const approvalEvaluations=await client.query<ActivationEvaluationRow>(`
        SELECT evaluation.id,evaluation.approval_pack_id,evaluation.status,evaluation.recommendation,
               evaluation.execution_decision,evaluation.blocker_count,evaluation.checks,evaluation.side_effects,
               actor.display_name AS run_by_name,evaluation.reason,evaluation.created_at
          FROM uat_activation_approval_evaluations evaluation
          LEFT JOIN actors actor ON actor.id=evaluation.run_by_actor_id
         ORDER BY evaluation.created_at DESC,evaluation.id DESC LIMIT 200
      `);
      const finalRequests=await client.query<FinalAuthorizationRequestRow>(`
        SELECT request.id,request.request_key,request.version,request.status,request.approval_pack_id,
               concat(approval.approval_pack_key,' · v',approval.version) AS approval_pack_label,
               request.definition,request.definition_hash,request.change_set_hash,request.previous_request_id,
               actor.display_name AS compiled_by_name,request.reason,request.created_at
          FROM uat_final_authorization_requests request
          JOIN uat_activation_approval_packs approval ON approval.id=request.approval_pack_id
          LEFT JOIN actors actor ON actor.id=request.compiled_by_actor_id
         ORDER BY request.request_key,request.version DESC LIMIT 50
      `);
      const finalEvaluations=await client.query<FinalAuthorizationEvaluationRow>(`
        SELECT evaluation.id,evaluation.request_id,evaluation.status,evaluation.recommendation,
               evaluation.execution_decision,evaluation.blocker_count,evaluation.checks,evaluation.side_effects,
               actor.display_name AS run_by_name,evaluation.reason,evaluation.created_at
          FROM uat_final_authorization_evaluations evaluation
          LEFT JOIN actors actor ON actor.id=evaluation.run_by_actor_id
         ORDER BY evaluation.created_at DESC,evaluation.id DESC LIMIT 200
      `);
      const authorization=await client.query<AuthorizationRecompilationRow>(`
        SELECT compilation.id,compilation.authorization_key,compilation.version,
               compilation.current_policy,compilation.cost_plan,compilation.iac_plan,
               compilation.secret_references,compilation.destruction_plan,compilation.actual_effects,
               compilation.bundle_hash,actor.display_name AS compiled_by_name,
               compilation.reason,compilation.created_at
          FROM uat_authorization_recompilations compilation
          LEFT JOIN actors actor ON actor.id=compilation.compiled_by_actor_id
         ORDER BY compilation.version DESC,compilation.created_at DESC LIMIT 1
      `);
      const latestByBlueprint = new Map<string, OpsUatBlueprintDryRun>();
      for (const row of dryRuns.rows) if (!latestByBlueprint.has(row.blueprint_id)) latestByBlueprint.set(row.blueprint_id, toDryRun(row));
      const latestByPackage = new Map<string, OpsUatProvisioningPackageDryRun>();
      for (const row of packageRuns.rows) if (!latestByPackage.has(row.package_id)) latestByPackage.set(row.package_id, toPackageDryRun(row));
      const decisionsByApprovalPack=new Map<string,OpsUatActivationDecision[]>();
      for (const row of approvalDecisions.rows) {
        const decisions=decisionsByApprovalPack.get(row.approval_pack_id)??[];
        decisions.push(toActivationDecision(row)); decisionsByApprovalPack.set(row.approval_pack_id,decisions);
      }
      const evaluationByApprovalPack=new Map<string,OpsUatActivationEvaluation>();
      for (const row of approvalEvaluations.rows) if (!evaluationByApprovalPack.has(row.approval_pack_id)) evaluationByApprovalPack.set(row.approval_pack_id,toActivationEvaluation(row));
      const evaluationByFinalRequest=new Map<string,OpsUatFinalAuthorizationEvaluation>();
      for (const row of finalEvaluations.rows) if (!evaluationByFinalRequest.has(row.request_id)) evaluationByFinalRequest.set(row.request_id,toFinalAuthorizationEvaluation(row));
      return {
        generatedAt: now.toISOString(), canManage: actorType === "admin",
        releaseManifests: manifests.rows.map((row) => ({ id: row.id, manifestKey: row.manifest_key, version: Number(row.version), status: row.status })),
        blueprints: blueprints.rows.map((row) => toBlueprint(row, latestByBlueprint.get(row.id) ?? null)),
        provisioningPackages: packages.rows.map((row) => toPackage(row, latestByPackage.get(row.id) ?? null)),
        activationApprovalPacks: approvalPacks.rows.map((row)=>toActivationPack(row,
          decisionsByApprovalPack.get(row.id)??[],evaluationByApprovalPack.get(row.id)??null)),
        finalAuthorizationRequests: finalRequests.rows.map((row)=>toFinalAuthorizationRequest(row,evaluationByFinalRequest.get(row.id)??null)),
        currentAuthorization: authorization.rows[0] ? toAuthorizationRecompilation(authorization.rows[0]) : null,
      };
    });
  }

  async createBlueprint(organizationKey: string, request: Parameters<OpsUatBlueprintRepository["createBlueprint"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_create_uat_environment_blueprint($1,$2,$3,$4,$5,$6,$7,$8) AS result",
      [request.actorId,request.blueprintKey,request.releaseManifestId,request.definition,request.reason,
        request.idempotencyKey,request.correlationId,request.now]);
  }
  async runDryRun(organizationKey: string, request: Parameters<OpsUatBlueprintRepository["runDryRun"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_run_uat_blueprint_dry_run($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId,request.blueprintId,request.reason,request.idempotencyKey,request.correlationId,request.now]);
  }
  async compileProvisioningPackage(organizationKey: string, request: Parameters<OpsUatBlueprintRepository["compileProvisioningPackage"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_compile_uat_provisioning_package($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId,request.blueprintId,request.reason,request.idempotencyKey,request.correlationId,request.now]);
  }
  async runProvisioningPackageDryRun(organizationKey: string, request: Parameters<OpsUatBlueprintRepository["runProvisioningPackageDryRun"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_run_uat_provisioning_package_dry_run($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId,request.packageId,request.reason,request.idempotencyKey,request.correlationId,request.now]);
  }
  async compileActivationApprovalPack(organizationKey:string,request:Parameters<OpsUatBlueprintRepository["compileActivationApprovalPack"]>[1]) {
    return await this.call(organizationKey,"SELECT dop_compile_uat_activation_approval_pack($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId,request.packageId,request.reason,request.idempotencyKey,request.correlationId,request.now]);
  }
  async recordActivationDecision(organizationKey:string,request:Parameters<OpsUatBlueprintRepository["recordActivationDecision"]>[1]) {
    return await this.call(organizationKey,"SELECT dop_record_uat_activation_approval_decision($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
      [request.actorId,request.approvalPackId,request.decisionKey,request.status,request.evidence,request.reason,
        request.idempotencyKey,request.correlationId,request.now]);
  }
  async evaluateActivationApprovalPack(organizationKey:string,request:Parameters<OpsUatBlueprintRepository["evaluateActivationApprovalPack"]>[1]) {
    return await this.call(organizationKey,"SELECT dop_evaluate_uat_activation_approval_pack($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId,request.approvalPackId,request.reason,request.idempotencyKey,request.correlationId,request.now]);
  }
  async compileFinalAuthorizationRequest(organizationKey:string,request:Parameters<OpsUatBlueprintRepository["compileFinalAuthorizationRequest"]>[1]) {
    return await this.call(organizationKey,"SELECT dop_compile_uat_final_authorization_request($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId,request.approvalPackId,request.reason,request.idempotencyKey,request.correlationId,request.now]);
  }
  async evaluateFinalAuthorizationRequest(organizationKey:string,request:Parameters<OpsUatBlueprintRepository["evaluateFinalAuthorizationRequest"]>[1]) {
    return await this.call(organizationKey,"SELECT dop_evaluate_uat_final_authorization_request($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId,request.requestId,request.reason,request.idempotencyKey,request.correlationId,request.now]);
  }
  private async call(organizationKey: string, sql: string, values: unknown[]): Promise<OpsUatBlueprintMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsUatBlueprintMutationResult }>(sql, values);
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

function toBlueprint(row: BlueprintRow, latestDryRun: OpsUatBlueprintDryRun | null): OpsUatBlueprint {
  return {
    id:row.id,blueprintKey:row.blueprint_key,version:Number(row.version),status:row.status,
    releaseManifestId:row.release_manifest_id,releaseManifestLabel:row.release_manifest_label,
    definition:row.definition,definitionHash:row.definition_hash,deploymentPlan:row.deployment_plan,
    deploymentPlanHash:row.deployment_plan_hash,previousBlueprintId:row.previous_blueprint_id,
    createdByName:row.created_by_name,reason:row.reason,createdAt:iso(row.created_at),latestDryRun,
  };
}
function toDryRun(row: DryRunRow): OpsUatBlueprintDryRun {
  return { id:row.id,blueprintId:row.blueprint_id,status:row.status,blockerCount:Number(row.blocker_count),
    checks:row.checks,sideEffects:row.side_effects,runByName:row.run_by_name,reason:row.reason,createdAt:iso(row.created_at) };
}
function toPackage(row: ProvisioningPackageRow, latestDryRun: OpsUatProvisioningPackageDryRun | null): OpsUatProvisioningPackage {
  return { id:row.id,packageKey:row.package_key,version:Number(row.version),status:row.status,
    blueprintId:row.blueprint_id,blueprintLabel:row.blueprint_label,definition:row.definition,
    definitionHash:row.definition_hash,runbookHash:row.runbook_hash,previousPackageId:row.previous_package_id,
    compiledByName:row.compiled_by_name,reason:row.reason,createdAt:iso(row.created_at),latestDryRun };
}
function toPackageDryRun(row: ProvisioningPackageRunRow): OpsUatProvisioningPackageDryRun {
  return { id:row.id,packageId:row.package_id,status:row.status,executionDecision:row.execution_decision,
    blockerCount:0,checks:row.checks,sideEffects:row.side_effects,runByName:row.run_by_name,
    reason:row.reason,createdAt:iso(row.created_at) };
}
function toActivationPack(row:ActivationPackRow,latestDecisions:OpsUatActivationDecision[],latestEvaluation:OpsUatActivationEvaluation|null):OpsUatActivationApprovalPack {
  return {id:row.id,approvalPackKey:row.approval_pack_key,version:Number(row.version),status:row.status,
    provisioningPackageId:row.provisioning_package_id,provisioningPackageLabel:row.provisioning_package_label,
    definition:row.definition,definitionHash:row.definition_hash,previousApprovalPackId:row.previous_approval_pack_id,
    compiledByName:row.compiled_by_name,reason:row.reason,createdAt:iso(row.created_at),latestDecisions,latestEvaluation};
}
function toActivationDecision(row:ActivationDecisionRow):OpsUatActivationDecision {
  return {id:row.id,approvalPackId:row.approval_pack_id,decisionKey:row.decision_key,version:Number(row.version),
    status:row.status,evidence:row.evidence,evidenceHash:row.evidence_hash,decidedByName:row.decided_by_name,
    reason:row.reason,createdAt:iso(row.created_at)};
}
function toActivationEvaluation(row:ActivationEvaluationRow):OpsUatActivationEvaluation {
  return {id:row.id,approvalPackId:row.approval_pack_id,status:row.status,recommendation:row.recommendation,
    executionDecision:row.execution_decision,blockerCount:Number(row.blocker_count),checks:row.checks,
    sideEffects:row.side_effects,runByName:row.run_by_name,reason:row.reason,createdAt:iso(row.created_at)};
}
function toFinalAuthorizationRequest(row:FinalAuthorizationRequestRow,latestEvaluation:OpsUatFinalAuthorizationEvaluation|null):OpsUatFinalAuthorizationRequest {
  return {id:row.id,requestKey:row.request_key,version:Number(row.version),status:row.status,
    approvalPackId:row.approval_pack_id,approvalPackLabel:row.approval_pack_label,definition:row.definition,
    definitionHash:row.definition_hash,changeSetHash:row.change_set_hash,previousRequestId:row.previous_request_id,
    compiledByName:row.compiled_by_name,reason:row.reason,createdAt:iso(row.created_at),latestEvaluation};
}
function toFinalAuthorizationEvaluation(row:FinalAuthorizationEvaluationRow):OpsUatFinalAuthorizationEvaluation {
  return {id:row.id,requestId:row.request_id,status:row.status,recommendation:row.recommendation,
    executionDecision:row.execution_decision,blockerCount:Number(row.blocker_count),checks:row.checks,
    sideEffects:row.side_effects,runByName:row.run_by_name,reason:row.reason,createdAt:iso(row.created_at)};
}
function toAuthorizationRecompilation(row:AuthorizationRecompilationRow):OpsUatAuthorizationRecompilation {
  return {id:row.id,authorizationKey:row.authorization_key,version:Number(row.version),
    currentPolicy:row.current_policy,costPlan:row.cost_plan,iacPlan:row.iac_plan,
    secretReferences:row.secret_references,destructionPlan:row.destruction_plan,
    actualEffects:row.actual_effects,bundleHash:row.bundle_hash,compiledByName:row.compiled_by_name,
    reason:row.reason,createdAt:iso(row.created_at)};
}
function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
