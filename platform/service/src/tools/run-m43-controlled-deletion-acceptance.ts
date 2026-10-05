import { randomUUID } from "node:crypto";
import { Pool,type PoolClient } from "pg";
import { SupabaseDocumentObjectStore } from "../adapters/storage/supabase-document-object-store.js";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";

const CASE_ID="00000000-0000-4000-a430-000000000002";
const CASE_KEY="M43-SYNTHETIC-RETENTION-ACCEPTANCE";
const DOCUMENT_IDS=["00000000-0000-4000-a430-000000000004","00000000-0000-4000-a430-000000000005"];
const organizationKey=process.env.DOP_ORGANIZATION_KEY??"uat-accounting-firm";
const databaseUrl=required(process.env.DOP_MIGRATION_DATABASE_URL,"DOP_MIGRATION_DATABASE_URL");
const bucket=required(process.env.SUPABASE_STORAGE_BUCKET,"SUPABASE_STORAGE_BUCKET");
const store=new SupabaseDocumentObjectStore({projectUrl:required(process.env.SUPABASE_PROJECT_URL,"SUPABASE_PROJECT_URL"),
  accessToken:required(process.env.SUPABASE_SECRET_KEY,"SUPABASE_SECRET_KEY"),bucket});
const pool=new Pool(postgresPoolConfig(databaseUrl,process.env.DATABASE_SSL_CA_PATH,1));
try{
  const previousRunId=await completedRunId(pool);
  if(previousRunId){
    await ensureExecutionDisabled(pool);
    const evidence=await verifyDeletion(pool,previousRunId);
    process.stdout.write(`${JSON.stringify({outcome:"passed",execution:"previously_completed_reverified",
      approvedCase:{caseId:CASE_ID,caseKey:CASE_KEY},applyRunId:previousRunId,...evidence},null,2)}\n`);
  }else{
    const plan=await authorizeAndPlan(pool);
    const objectOutcomes:Record<string,number>={deleted:0,not_found:0};
    while(true){
      const claim=await call(pool,"dop_claim_retention_object",[organizationKey,"m43-controlled-acceptance",120,new Date()]);
      if(claim.outcome==="empty")break;
      if(claim.outcome!=="claimed"||claim.retentionRunId!==plan.runId||claim.caseId!==CASE_ID
        ||typeof claim.storageReference!=="string"||!plan.allowedReferences.has(claim.storageReference)
        ||typeof claim.candidateId!=="string"||typeof claim.leaseToken!=="string"){
        throw new Error("retention_claim_escaped_approved_scope");
      }
      const outcome=await store.delete(claim.storageReference);
      const completed=await call(pool,"dop_complete_retention_object",
        [claim.candidateId,claim.leaseToken,outcome,null,new Date()]);
      if(completed.outcome!=="completed"&&completed.outcome!=="duplicate")throw new Error("retention_object_completion_failed");
      objectOutcomes[outcome]=(objectOutcomes[outcome]??0)+1;
    }
    const finalized=await call(pool,"dop_finalize_retention_runs",[organizationKey,new Date()]);
    if(finalized.outcome!=="completed"||Number(finalized.finalizedCases)!==1)throw new Error("retention_finalization_failed");
    await ensureExecutionDisabled(pool);
    const evidence=await verifyDeletion(pool,plan.runId);
    process.stdout.write(`${JSON.stringify({outcome:"passed",execution:"completed_now",approvedCase:{caseId:CASE_ID,caseKey:CASE_KEY},
      dryRun:plan.dryRun,applyRunId:plan.runId,objectOutcomes,...evidence},null,2)}\n`);
  }
}finally{await pool.end();}

async function completedRunId(pool:Pool):Promise<string|null>{
  const client=await pool.connect();try{await client.query("BEGIN READ ONLY");await setContext(client);
    const result=await client.query<{retention_run_id:string}>(`SELECT proof.retention_run_id
      FROM data_deletion_proofs proof JOIN cases case_row
        ON case_row.organization_id=proof.organization_id AND case_row.id=proof.case_id
      WHERE proof.organization_id=dop_current_organization_id() AND proof.case_id=$1
        AND case_row.content_deleted_at IS NOT NULL ORDER BY proof.deleted_at DESC LIMIT 1`,[CASE_ID]);
    await client.query("COMMIT");return result.rows[0]?.retention_run_id??null;
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}}

async function authorizeAndPlan(pool:Pool):Promise<{runId:string;allowedReferences:Set<string>;dryRun:Record<string,unknown>}>{
  const client=await pool.connect();try{await client.query("BEGIN");await setContext(client);
    const fixture=await client.query(`SELECT c.id,c.case_key,c.status,c.completed_at,
      dop_case_is_explicitly_synthetic(c.config_snapshot) AS is_explicitly_synthetic,
      (SELECT count(*)::int FROM documents d WHERE d.organization_id=c.organization_id AND d.case_id=c.id) AS document_count,
      (SELECT count(*)::int FROM case_legal_holds h WHERE h.organization_id=c.organization_id AND h.case_id=c.id AND h.status='active') AS active_hold_count
      FROM cases c WHERE c.organization_id=dop_current_organization_id() AND c.id=$1 FOR UPDATE`,[CASE_ID]);
    const fixtureRow=fixture.rows[0];
    if(!fixtureRow||fixtureRow.case_key!==CASE_KEY||fixtureRow.status!=="completed"||fixtureRow.document_count!==2
      ||fixtureRow.is_explicitly_synthetic!==true
      ||fixtureRow.active_hold_count!==1)throw new Error("approved_fixture_boundary_changed");
    const actors=await client.query(`SELECT
      (SELECT id FROM actors WHERE organization_id=dop_current_organization_id() AND actor_type='manager' AND status='active' ORDER BY created_at LIMIT 1) AS manager_id,
      (SELECT id FROM actors WHERE organization_id=dop_current_organization_id() AND actor_type='admin' AND status='active' ORDER BY created_at LIMIT 1) AS admin_id`);
    const managerId=required(String(actors.rows[0]?.manager_id??""),"manager actor");
    const adminId=required(String(actors.rows[0]?.admin_id??""),"admin actor");
    const policy=await client.query(`SELECT execution_enabled,synthetic_only,retention_days,anchor,hold_approver_roles,rpo_hours,rto_hours
      FROM data_retention_policies WHERE organization_id=dop_current_organization_id() FOR UPDATE`);
    const policyRow=policy.rows[0];
    if(policyRow?.execution_enabled!==true||policyRow.synthetic_only!==true||policyRow.retention_days!==30||policyRow.anchor!=="case_terminal_at"
      ||JSON.stringify(policyRow.hold_approver_roles)!==JSON.stringify(["manager","admin"])
      ||policyRow.rpo_hours!==24||policyRow.rto_hours!==4){
      throw new Error("retention_policy_requires_separate_explicit_enablement");
    }
    const hold=await client.query("SELECT id,review_due_at FROM case_legal_holds WHERE organization_id=dop_current_organization_id() AND case_id=$1 AND status='active' FOR UPDATE",[CASE_ID]);
    const release=await invoke(client,"dop_set_case_legal_hold",[managerId,CASE_ID,"release",
      "Operator explicitly approved release of the dedicated synthetic M43 deletion acceptance hold.",
      hold.rows[0]?.review_due_at??new Date(),randomUUID(),randomUUID(),new Date()]);
    if(release.outcome!=="completed"||release.status!=="released")throw new Error("explicit_legal_hold_release_failed");
    const dryRun=await invoke(client,"dop_plan_retention_run",[adminId,"dry_run",
      "Final pre-delete preview for the explicitly approved dedicated synthetic M43 acceptance Case.",randomUUID(),randomUUID(),new Date()]);
    if(dryRun.outcome!=="completed"||Number(dryRun.candidateCases)!==1||Number(dryRun.candidateDocuments)!==2
      ||Number(dryRun.candidateObjects)!==2||Number(dryRun.deletedObjects)!==0)throw new Error("final_dry_run_scope_mismatch");
    const dryCandidates=await client.query("SELECT case_id FROM retention_case_candidates WHERE retention_run_id=$1",
      [dryRun.retentionRunId]);
    if(dryCandidates.rowCount!==1||dryCandidates.rows[0]?.case_id!==CASE_ID)throw new Error("final_dry_run_case_mismatch");
    const activeRuns=await client.query(`SELECT count(*)::int AS count FROM retention_runs r
      WHERE r.organization_id=dop_current_organization_id() AND r.mode='apply'
        AND r.status IN ('queued','processing')`);
    if(activeRuns.rows[0]?.count!==0)throw new Error("unrelated_active_retention_run_exists");
    const apply=await invoke(client,"dop_plan_retention_run",[adminId,"apply",
      "Execute the explicitly approved real deletion drill for the dedicated synthetic M43 acceptance Case only.",
      randomUUID(),randomUUID(),new Date()]);
    if(apply.outcome!=="completed"||apply.status!=="queued"||Number(apply.candidateCases)!==1
      ||Number(apply.candidateDocuments)!==2||Number(apply.candidateObjects)!==2)throw new Error("apply_run_scope_mismatch");
    const objects=await client.query<{case_id:string;document_id:string;storage_reference:string}>(`SELECT case_id,document_id,storage_reference
      FROM retention_object_candidates WHERE retention_run_id=$1 ORDER BY storage_reference`,[apply.retentionRunId]);
    if(objects.rowCount!==2||objects.rows.some((row)=>row.case_id!==CASE_ID||!DOCUMENT_IDS.includes(row.document_id)
      ||!row.storage_reference.startsWith(`supabase://${bucket}/${organizationKey}/`)))throw new Error("apply_object_scope_mismatch");
    await client.query("COMMIT");
    return {runId:String(apply.retentionRunId),allowedReferences:new Set(objects.rows.map((row)=>row.storage_reference)),dryRun};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
}

async function verifyDeletion(pool:Pool,runId:string):Promise<Record<string,unknown>>{
  const client=await pool.connect();try{await client.query("BEGIN READ ONLY");await setContext(client);
    const result=await client.query(`SELECT
      (SELECT count(*)::int FROM storage.objects WHERE bucket_id=$2 AND (name LIKE $3 OR name LIKE $4)) AS storage_objects_remaining,
      (SELECT count(*)::int FROM documents WHERE organization_id=dop_current_organization_id() AND case_id=$1
        AND archive_storage_ref IS NULL AND incoming_storage_ref IS NULL AND original_filename='[deleted]'
        AND idempotency_key='deleted-'||replace(id::text,'-','')
        AND classification_summary IS NULL AND content_deleted_at IS NOT NULL) AS redacted_documents,
      (SELECT count(*)::int FROM submissions WHERE organization_id=dop_current_organization_id() AND case_id=$1
        AND submission_key='deleted-'||replace(id::text,'-','')
        AND source_submission_id='deleted-'||replace(id::text,'-','')
        AND raw_payload_reference IS NULL AND canonical_envelope IS NULL
        AND source_provenance->>'contentDeleted'='true') AS redacted_submissions,
      (SELECT count(*)::int FROM cases WHERE organization_id=dop_current_organization_id() AND id=$1
        AND content_deleted_at IS NOT NULL AND content_deletion_proof_id IS NOT NULL
        AND case_key='deleted-'||replace(id::text,'-','')
        AND external_reference IS NULL AND config_snapshot->>'contentDeleted'='true'
        AND config_snapshot->>'proofId'=content_deletion_proof_id::text) AS redacted_cases,
      (SELECT count(*)::int FROM subjects s JOIN cases c ON c.organization_id=s.organization_id AND c.subject_id=s.id
        WHERE c.organization_id=dop_current_organization_id() AND c.id=$1
          AND s.subject_key='deleted-'||replace(s.id::text,'-','') AND s.display_name='[deleted]'
          AND s.status='closed' AND s.primary_contact_actor_id IS NULL
          AND s.attributes->>'contentDeleted'='true') AS redacted_subjects,
      (SELECT count(*)::int FROM data_deletion_proofs WHERE organization_id=dop_current_organization_id()
        AND retention_run_id=$5 AND case_id=$1 AND object_deleted_count=2 AND object_not_found_count=0) AS minimal_proofs,
      (SELECT count(*)::int FROM retention_runs WHERE organization_id=dop_current_organization_id() AND id=$5
        AND status='completed' AND candidate_case_count=1 AND candidate_document_count=2
        AND candidate_object_count=2 AND deleted_object_count=2 AND failed_object_count=0 AND redacted_case_count=1) AS completed_runs,
      (SELECT count(*)::int FROM documents WHERE organization_id=dop_current_organization_id() AND case_id=$1
        AND (source_download_ref IS NOT NULL OR source_envelope IS NOT NULL
          OR to_jsonb(documents)::text ILIKE '%M43_SYNTHETIC_RETENTION_%'
          OR to_jsonb(documents)::text ILIKE '%supabase://%')) AS recoverable_document_sensitive_rows,
      (SELECT count(*)::int FROM workflow_events WHERE organization_id=dop_current_organization_id()
        AND event_type='Case.ContentDeleted' AND aggregate_id=$1) AS deletion_events,
      (SELECT count(*)::int FROM workflow_events e JOIN cases c ON c.organization_id=e.organization_id AND c.subject_id=e.aggregate_id
        WHERE c.organization_id=dop_current_organization_id() AND c.id=$1
          AND e.event_type='Subject.ContentDeleted') AS subject_deletion_events,
      (SELECT count(*)::int FROM data_retention_policies WHERE organization_id=dop_current_organization_id()
        AND NOT execution_enabled AND synthetic_only AND retention_days=30 AND anchor='case_terminal_at'
        AND hold_approver_roles=ARRAY['manager','admin']::text[] AND rpo_hours=24 AND rto_hours=4) AS closed_policies,
      (SELECT count(*)::int FROM workflow_events WHERE organization_id=dop_current_organization_id()
        AND event_type='Retention.ExecutionDisabled' AND payload->>'executionEnabled'='false') AS execution_disabled_events,
      (SELECT count(*)::int FROM case_legal_holds h JOIN actors a ON a.organization_id=h.organization_id AND a.id=h.released_by_actor_id
        WHERE h.organization_id=dop_current_organization_id() AND h.case_id=$1 AND h.status='released'
          AND a.actor_type IN ('manager','admin')) AS explicit_hold_releases`,
      [CASE_ID,bucket,`${organizationKey}/${DOCUMENT_IDS[0]}/%`,`${organizationKey}/${DOCUMENT_IDS[1]}/%`,runId]);
    await client.query("COMMIT");const row=result.rows[0];
    if(!row||row.storage_objects_remaining!==0||row.redacted_documents!==2||row.redacted_submissions!==1
      ||row.redacted_cases!==1||row.redacted_subjects!==1
      ||row.minimal_proofs!==1||row.completed_runs!==1||row.recoverable_document_sensitive_rows!==0||row.deletion_events!==1)
      throw new Error(`post_deletion_verification_failed:${JSON.stringify(row)}`);
    if(row.subject_deletion_events!==1||row.closed_policies!==1||row.execution_disabled_events<1||row.explicit_hold_releases!==1)
      throw new Error(`governance_verification_failed:${JSON.stringify(row)}`);
    return {storageObjectsRemaining:0,redactedDocuments:2,redactedSubmissions:1,redactedCases:1,redactedSubjects:1,minimalDeletionProofs:1,
      completedRetentionRuns:1,recoverableDocumentSensitiveRows:0,deletionAuditEvents:1,subjectDeletionAuditEvents:1,
      retentionPolicy:{retentionDays:30,anchor:"case_terminal_at",legalHoldRoles:["manager","admin"],rpoHours:24,rtoHours:4,
        syntheticOnly:true,executionEnabled:false},executionDisabledAuditEvents:row.execution_disabled_events,
      explicitLegalHoldRelease:true};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
}

async function ensureExecutionDisabled(pool:Pool):Promise<void>{
  const client=await pool.connect();try{await client.query("BEGIN");await setContext(client);
    const state=await client.query(`SELECT execution_enabled,
      (SELECT id FROM actors WHERE organization_id=dop_current_organization_id() AND actor_type='admin'
        AND status='active' ORDER BY created_at LIMIT 1) AS admin_id
      FROM data_retention_policies WHERE organization_id=dop_current_organization_id() FOR UPDATE`);
    if(!state.rows[0])throw new Error("retention_policy_not_found");
    if(state.rows[0].execution_enabled===true){
      const result=await invoke(client,"dop_disable_retention_execution",[required(String(state.rows[0].admin_id??""),"admin actor"),
        "Close destructive execution immediately after the explicitly approved M43 synthetic Case run.",
        randomUUID(),randomUUID(),new Date()]);
      if(result.outcome!=="completed"||result.executionEnabled!==false)throw new Error("retention_execution_close_failed");
    }
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}}

async function call(pool:Pool,functionName:string,values:unknown[]):Promise<Record<string,unknown>>{
  const client=await pool.connect();try{await client.query("BEGIN");await setContext(client);const result=await invoke(client,functionName,values);await client.query("COMMIT");return result;
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}}
async function invoke(client:PoolClient,functionName:string,values:unknown[]):Promise<Record<string,unknown>>{
  const placeholders=values.map((_,index)=>`$${index+1}`).join(",");
  const result=await client.query<{result:Record<string,unknown>}>(`SELECT ${functionName}(${placeholders}) AS result`,values);
  if(!result.rows[0]?.result)throw new Error(`${functionName}_returned_no_result`);return result.rows[0].result;
}
async function setContext(client:PoolClient){const result=await client.query("SELECT dop_set_organization_context($1) AS id",[organizationKey]);if(!result.rows[0]?.id)throw new Error("organization_not_found");}
function required(value:string|undefined,name:string):string{if(!value)throw new Error(`${name} is required`);return value;}
