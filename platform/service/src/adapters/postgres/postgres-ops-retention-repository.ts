import type { Pool, PoolClient } from "pg";
import type {
  OpsRetentionRepository, RetentionDashboard, RetentionMutationResult,
} from "../../ports/ops-retention-repository.js";

export class PostgresOpsRetentionRepository implements OpsRetentionRepository {
  constructor(private readonly pool: Pool) {}

  async getDashboard(organizationKey: string): Promise<RetentionDashboard> {
    return this.transaction(organizationKey, async (client) => {
      const policyResult = await client.query<{
        retention_days:number; anchor:"case_terminal_at"; hold_approver_roles:string[];
        rpo_hours:number; rto_hours:number; execution_enabled:boolean; synthetic_only:true; policy_version:string;
      }>(`SELECT retention_days,anchor,hold_approver_roles,rpo_hours,rto_hours,
          execution_enabled,synthetic_only,policy_version FROM data_retention_policies
          WHERE organization_id=dop_current_organization_id()`);
      const holds = await client.query(`SELECT h.id,h.case_id,c.case_key,s.display_name AS subject_name,
          h.reason,a.display_name AS approved_by,h.approved_at,h.review_due_at,h.review_state
        FROM case_legal_holds h JOIN cases c ON c.organization_id=h.organization_id AND c.id=h.case_id
        JOIN subjects s ON s.organization_id=c.organization_id AND s.id=c.subject_id
        JOIN actors a ON a.organization_id=h.organization_id AND a.id=h.approved_by_actor_id
        WHERE h.organization_id=dop_current_organization_id() AND h.status='active'
        ORDER BY h.review_due_at,h.id`);
      const runs = await client.query(`SELECT id,mode,status,cutoff_at,candidate_case_count,
          candidate_document_count,candidate_object_count,deleted_object_count,not_found_object_count,
          redacted_case_count,failed_object_count,external_call_count,started_at,completed_at
        FROM retention_runs WHERE organization_id=dop_current_organization_id()
        ORDER BY started_at DESC,id DESC LIMIT 20`);
      const proofs = await client.query(`SELECT p.id,p.case_id,c.case_key,p.policy_version,p.deleted_at,
          p.document_count,p.object_deleted_count,p.object_not_found_count,p.redacted_event_count,p.proof_hash
        FROM data_deletion_proofs p JOIN cases c ON c.organization_id=p.organization_id AND c.id=p.case_id
        WHERE p.organization_id=dop_current_organization_id() ORDER BY p.deleted_at DESC,p.id DESC LIMIT 20`);
      const drills = await client.query(`SELECT d.id,d.source_case_id,c.case_key,d.status,d.backup_digest,
          d.restored_digest,d.rpo_hours,d.rto_target_hours,d.actual_rto_seconds,d.restore_target,
          d.restored_row_count,d.artifact_expires_at,d.artifact_purged_at,d.schema_verified,
          d.relationships_verified,d.migration_ledger_verified,d.rls_verified,d.restore_target_destroyed,d.source_migration_version,
          d.restored_table_count,d.restored_relationship_count,d.restored_rls_policy_count,d.created_at
        FROM retention_restore_drills d JOIN cases c ON c.organization_id=d.organization_id AND c.id=d.source_case_id
        WHERE d.organization_id=dop_current_organization_id() ORDER BY d.created_at DESC,d.id DESC LIMIT 20`);
      const reconciliations = await client.query(`SELECT id,status,database_reference_count,storage_object_count,
          orphan_object_count,missing_object_count,orphan_reference_digest,missing_reference_digest,inspected_at
        FROM storage_reconciliation_runs WHERE organization_id=dop_current_organization_id()
        ORDER BY inspected_at DESC,id DESC LIMIT 20`);
      const p = policyResult.rows[0];
      return {
        policy: p ? { retentionDays:p.retention_days,anchor:p.anchor,holdApproverRoles:p.hold_approver_roles,
          rpoHours:p.rpo_hours,rtoHours:p.rto_hours,executionEnabled:p.execution_enabled,
          syntheticOnly:p.synthetic_only,policyVersion:p.policy_version } : null,
        activeHolds: holds.rows.map((r:any)=>({id:r.id,caseId:r.case_id,caseKey:r.case_key,
          subjectName:r.subject_name,reason:r.reason,approvedBy:r.approved_by,
          approvedAt:iso(r.approved_at),reviewDueAt:iso(r.review_due_at),reviewState:r.review_state})),
        recentRuns: runs.rows.map((r:any)=>({id:r.id,mode:r.mode,status:r.status,cutoffAt:iso(r.cutoff_at),
          candidateCases:r.candidate_case_count,candidateDocuments:r.candidate_document_count,
          candidateObjects:r.candidate_object_count,deletedObjects:r.deleted_object_count,
          notFoundObjects:r.not_found_object_count,redactedCases:r.redacted_case_count,
          failedObjects:r.failed_object_count,externalCalls:r.external_call_count,
          startedAt:iso(r.started_at),completedAt:r.completed_at?iso(r.completed_at):null})),
        deletionProofs: proofs.rows.map((r:any)=>({id:r.id,caseId:r.case_id,caseKey:r.case_key,
          policyVersion:r.policy_version,deletedAt:iso(r.deleted_at),documentCount:r.document_count,
          deletedObjects:r.object_deleted_count,notFoundObjects:r.object_not_found_count,
          redactedEvents:r.redacted_event_count,proofHash:r.proof_hash})),
        restoreDrills: drills.rows.map((r:any)=>({id:r.id,caseId:r.source_case_id,caseKey:r.case_key,
          status:r.status,backupDigest:r.backup_digest,restoredDigest:r.restored_digest,
          rpoHours:r.rpo_hours,rtoTargetHours:r.rto_target_hours,
          actualRtoSeconds:r.actual_rto_seconds,restoreTarget:r.restore_target,
          restoredRowCount:r.restored_row_count,artifactExpiresAt:iso(r.artifact_expires_at),
          artifactPurgedAt:iso(r.artifact_purged_at),schemaVerified:r.schema_verified,
          relationshipsVerified:r.relationships_verified,migrationLedgerVerified:r.migration_ledger_verified,
          rlsVerified:r.rls_verified,restoreTargetDestroyed:r.restore_target_destroyed,
          sourceMigrationVersion:r.source_migration_version,
          restoredTableCount:r.restored_table_count,restoredRelationshipCount:r.restored_relationship_count,
          restoredRlsPolicyCount:r.restored_rls_policy_count,createdAt:iso(r.created_at)})),
        storageReconciliations: reconciliations.rows.map((r:any)=>({id:r.id,status:r.status,
          databaseReferenceCount:r.database_reference_count,storageObjectCount:r.storage_object_count,
          orphanObjectCount:r.orphan_object_count,missingObjectCount:r.missing_object_count,
          orphanReferenceDigest:r.orphan_reference_digest,missingReferenceDigest:r.missing_reference_digest,
          inspectedAt:iso(r.inspected_at)})),
      };
    });
  }

  async confirmPolicy(organizationKey:string, request:Parameters<OpsRetentionRepository["confirmPolicy"]>[1]) {
    return this.call(organizationKey,"dop_confirm_retention_policy",
      [request.actorId,request.retentionDays,request.anchor,request.holdApproverRoles,
        request.rpoHours,request.rtoHours,request.reason,request.idempotencyKey,request.correlationId,request.now]);
  }

  async setLegalHold(organizationKey:string, request:Parameters<OpsRetentionRepository["setLegalHold"]>[1]) {
    return this.call(organizationKey,"dop_set_case_legal_hold",
      [request.actorId,request.caseId,request.action,request.reason,request.reviewDueAt,
        request.idempotencyKey,request.correlationId,request.now]);
  }

  async planRun(organizationKey:string, request:Parameters<OpsRetentionRepository["planRun"]>[1]) {
    return this.call(organizationKey,"dop_plan_retention_run",
      [request.actorId,request.mode,request.reason,request.idempotencyKey,request.correlationId,request.now]);
  }

  private async call(organizationKey:string, functionName:string, values:unknown[]):Promise<RetentionMutationResult> {
    return this.transaction(organizationKey, async (client) => {
      const placeholders=values.map((_,index)=>`$${index+1}`).join(",");
      const result=await client.query<{result:unknown}>(`SELECT ${functionName}(${placeholders}) AS result`,values);
      return normalize(result.rows[0]?.result);
    });
  }

  private async transaction<T>(organizationKey:string, callback:(client:PoolClient)=>Promise<T>):Promise<T> {
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      const org=await client.query<{id:string|null}>("SELECT dop_set_organization_context($1) AS id",[organizationKey]);
      if (!org.rows[0]?.id) throw new Error("organization_not_found");
      const value=await callback(client); await client.query("COMMIT"); return value;
    } catch (error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; }
    finally { client.release(); }
  }
}

function normalize(value:unknown):RetentionMutationResult {
  if (!value || typeof value!=="object") throw new Error("invalid_retention_mutation_result");
  const row=value as Record<string,unknown>;
  if (!["completed","duplicate","conflict","not_found"].includes(String(row.outcome))) {
    throw new Error("invalid_retention_mutation_outcome");
  }
  return row as RetentionMutationResult;
}
function iso(value:unknown):string { return value instanceof Date?value.toISOString():new Date(String(value)).toISOString(); }
