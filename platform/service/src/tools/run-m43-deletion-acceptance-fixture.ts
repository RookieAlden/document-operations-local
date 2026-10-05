import { createHash,randomUUID } from "node:crypto";
import { Pool,type PoolClient } from "pg";
import { SupabaseDocumentObjectStore } from "../adapters/storage/supabase-document-object-store.js";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";

const IDS={subject:"00000000-0000-4000-a430-000000000001",case:"00000000-0000-4000-a430-000000000002",
  submission:"00000000-0000-4000-a430-000000000003",documents:["00000000-0000-4000-a430-000000000004","00000000-0000-4000-a430-000000000005"],
  event:"00000000-0000-4000-a430-000000000006"} as const;
const CASE_KEY="M43-SYNTHETIC-RETENTION-ACCEPTANCE";
const SUBJECT_KEY="m43-synthetic-retention-acceptance";
const FILES=[{name:"M43_SYNTHETIC_RETENTION_A.txt",content:"PURELY SYNTHETIC M43 RETENTION ACCEPTANCE OBJECT A\nNo real customer data.\n"},
  {name:"M43_SYNTHETIC_RETENTION_B.txt",content:"PURELY SYNTHETIC M43 RETENTION ACCEPTANCE OBJECT B\nNo real customer data.\n"}];
const mode=process.argv[2]??"preview";
if(!["prepare","preview"].includes(mode))throw new Error("usage: m43:deletion-fixture <prepare|preview>");
const databaseUrl=required(process.env.DOP_MIGRATION_DATABASE_URL,"DOP_MIGRATION_DATABASE_URL");
const organizationKey=process.env.DOP_ORGANIZATION_KEY??"uat-accounting-firm";
const pool=new Pool(postgresPoolConfig(databaseUrl,process.env.DATABASE_SSL_CA_PATH,1));
try{
  if(mode==="prepare"&&!await fixtureExists(pool))await prepareFixture(pool);
  if(!await fixtureExists(pool))throw new Error("m43_acceptance_fixture_not_prepared");
  await ensureLegalHoldAndDryRun(pool);
  process.stdout.write(`${JSON.stringify(await preview(pool),null,2)}\n`);
}finally{await pool.end();}

async function fixtureExists(pool:Pool):Promise<boolean>{
  const result=await pool.query("SELECT EXISTS(SELECT 1 FROM cases WHERE id=$1 AND case_key=$2) AS exists",[IDS.case,CASE_KEY]);
  return result.rows[0]?.exists===true;
}

async function prepareFixture(pool:Pool):Promise<void>{
  const projectUrl=required(process.env.SUPABASE_PROJECT_URL,"SUPABASE_PROJECT_URL");
  const accessToken=required(process.env.SUPABASE_SECRET_KEY,"SUPABASE_SECRET_KEY");
  const bucket=required(process.env.SUPABASE_STORAGE_BUCKET,"SUPABASE_STORAGE_BUCKET");
  const source=await sourceRows(pool);const store=new SupabaseDocumentObjectStore({projectUrl,accessToken,bucket});
  const uploaded:Array<{reference:string;hash:string;size:number;name:string}>=[];
  try{
    for(let index=0;index<FILES.length;index++){
      const file=FILES[index]!;const content=Buffer.from(file.content,"utf8");const hash=createHash("sha256").update(content).digest("hex");
      const result=await store.put({organizationKey,documentId:IDS.documents[index]!,filename:file.name,mimeType:"text/plain",sha256:hash,content});
      uploaded.push({reference:result.storageReference,hash,size:content.length,name:file.name});
    }
    await transaction(pool,async(client)=>{
      await setContext(client);const now=new Date();const terminal=new Date(now.getTime()-31*24*60*60*1000);
      const subject={...source.subject,id:IDS.subject,organization_id:source.organizationId,subject_key:SUBJECT_KEY,
        display_name:"M43 Synthetic Retention Acceptance Ltd",status:"active",primary_contact_actor_id:null,
        attributes:{synthetic_only:true,milestone:"M43",purpose:"retention deletion acceptance"},created_at:terminal,updated_at:now};
      await client.query("INSERT INTO subjects SELECT * FROM jsonb_populate_record(NULL::subjects,$1::jsonb)",[JSON.stringify(subject)]);
      const caseRow={...source.case,id:IDS.case,organization_id:source.organizationId,case_key:CASE_KEY,subject_id:IDS.subject,
        external_reference:"PURELY-SYNTHETIC-M43-DELETE",period_start:"2026-01-01",period_end:"2026-01-31",
        status:"completed",risk_status:"normal",due_at:terminal,config_snapshot:{...objectValue(source.case.config_snapshot),
          synthetic_only:true,milestone:"M43",purpose:"retention deletion acceptance",real_customer_data:false},
        created_at:terminal,updated_at:terminal,completed_at:terminal,
        content_deleted_at:null,content_deletion_proof_id:null};
      await client.query("INSERT INTO cases SELECT * FROM jsonb_populate_record(NULL::cases,$1::jsonb)",[JSON.stringify(caseRow)]);
      const submission={...source.submission,id:IDS.submission,organization_id:source.organizationId,case_id:IDS.case,
        submission_key:"m43-synthetic-retention-acceptance-submission",source:"internal",
        source_submission_id:"m43-synthetic-retention-acceptance",status:"completed",expected_document_count:2,
        terminal_document_count:2,raw_payload_reference:null,received_at:terminal,completed_at:terminal,created_at:terminal,updated_at:terminal};
      await client.query("INSERT INTO submissions SELECT * FROM jsonb_populate_record(NULL::submissions,$1::jsonb)",[JSON.stringify(submission)]);
      for(let index=0;index<uploaded.length;index++){
        const object=uploaded[index]!;const document={...source.document,id:IDS.documents[index],organization_id:source.organizationId,
          case_id:IDS.case,submission_id:IDS.submission,idempotency_key:`m43-synthetic-retention-${index+1}`,
          source_file_id:`m43-synthetic-file-${index+1}`,original_filename:object.name,declared_mime_type:"text/plain",
          detected_mime_type:"text/plain",size_bytes:object.size,content_hash_sha256:object.hash,incoming_storage_ref:null,
          archive_storage_ref:object.reference,status:"archived",classification_summary:{synthetic_only:true,
            classification:"M43RetentionAcceptance",confidence:1},review_reason:null,created_at:terminal,updated_at:terminal,
          archived_at:terminal,content_deleted_at:null,content_deletion_proof_id:null};
        await client.query("INSERT INTO documents SELECT * FROM jsonb_populate_record(NULL::documents,$1::jsonb)",[JSON.stringify(document)]);
      }
      await client.query(`INSERT INTO workflow_events(id,organization_id,idempotency_key,event_type,event_version,
        aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
        VALUES($1,$2,$3,'Retention.AcceptanceFixturePrepared',1,'case',$4,$5,$6,'m43-acceptance-fixture',$7,$8)`,
      [IDS.event,source.organizationId,"m43-acceptance-fixture-prepared",IDS.case,randomUUID(),source.adminId,
        {syntheticOnly:true,documentCount:2,storageObjectCount:2,realCustomerData:false},now]);
    });
  }catch(error){for(const object of uploaded)await store.delete(object.reference).catch(()=>undefined);throw error;}
}

async function ensureLegalHoldAndDryRun(pool:Pool):Promise<void>{
  await transaction(pool,async(client)=>{
    await setContext(client);const actors=await client.query(`SELECT
      (SELECT id FROM actors WHERE organization_id=dop_current_organization_id() AND actor_type='manager' AND status='active' ORDER BY created_at LIMIT 1) AS manager_id,
      (SELECT id FROM actors WHERE organization_id=dop_current_organization_id() AND actor_type='admin' AND status='active' ORDER BY created_at LIMIT 1) AS admin_id`);
    const managerId=required(String(actors.rows[0]?.manager_id??""),"manager actor");const adminId=required(String(actors.rows[0]?.admin_id??""),"admin actor");
    const active=await client.query("SELECT id FROM case_legal_holds WHERE organization_id=dop_current_organization_id() AND case_id=$1 AND status='active'",[IDS.case]);
    if(!active.rowCount){const result=await client.query<{result:Record<string,unknown>}>(
      "SELECT dop_set_case_legal_hold($1,$2,'place',$3,$4,$5,$6,$7) AS result",
      [managerId,IDS.case,"Protect the dedicated synthetic deletion fixture until the operator explicitly approves release.",
        new Date(Date.now()+7*24*60*60*1000),randomUUID(),randomUUID(),new Date()]);
      if(result.rows[0]?.result.outcome!=="completed")throw new Error(`fixture_hold_failed:${String(result.rows[0]?.result.reason??"unknown")}`);
    }
    const dry=await client.query<{result:Record<string,unknown>}>(
      "SELECT dop_plan_retention_run($1,'dry_run',$2,$3,$4,$5) AS result",
      [adminId,"Preview the held dedicated synthetic M43 deletion acceptance fixture without deleting objects.",randomUUID(),randomUUID(),new Date()]);
    if(dry.rows[0]?.result.outcome!=="completed"||dry.rows[0]?.result.deletedObjects!==0)
      throw new Error("fixture_dry_run_boundary_failed");
  });
}

async function preview(pool:Pool):Promise<Record<string,unknown>>{
  const client=await pool.connect();try{await client.query("BEGIN READ ONLY");await setContext(client);
    const result=await client.query(`SELECT c.id,c.case_key,s.display_name,c.status,c.completed_at,
      (SELECT count(*)::int FROM documents d WHERE d.organization_id=c.organization_id AND d.case_id=c.id) AS document_count,
      (SELECT count(DISTINCT ref) FROM documents d CROSS JOIN LATERAL (VALUES(d.incoming_storage_ref),(d.archive_storage_ref)) refs(ref)
        WHERE d.organization_id=c.organization_id AND d.case_id=c.id AND ref IS NOT NULL)::int AS referenced_object_count,
      (SELECT count(*)::int FROM storage.objects o WHERE o.bucket_id=$2 AND (o.name LIKE $3 OR o.name LIKE $4)) AS existing_storage_object_count,
      (SELECT count(*)::int FROM workflow_events e WHERE e.organization_id=c.organization_id AND e.aggregate_type='case' AND e.aggregate_id=c.id) AS case_event_count,
      (SELECT count(*)::int FROM case_legal_holds h WHERE h.organization_id=c.organization_id AND h.case_id=c.id AND h.status='active') AS active_hold_count,
      (SELECT review_state FROM case_legal_holds h WHERE h.organization_id=c.organization_id AND h.case_id=c.id AND h.status='active' LIMIT 1) AS hold_review_state,
      (SELECT count(*)::int FROM retention_runs r WHERE r.organization_id=c.organization_id AND r.mode='dry_run' AND r.candidate_case_count=0) AS zero_candidate_dry_runs
      FROM cases c JOIN subjects s ON s.organization_id=c.organization_id AND s.id=c.subject_id
      WHERE c.organization_id=dop_current_organization_id() AND c.id=$1`,[IDS.case,process.env.SUPABASE_STORAGE_BUCKET??"dop-originals-uat",
        `${organizationKey}/${IDS.documents[0]}/%`,`${organizationKey}/${IDS.documents[1]}/%`]);
    await client.query("COMMIT");const row=result.rows[0];if(!row)throw new Error("fixture_not_found");
    return {milestone:"M43",dataBoundary:"purely_synthetic",realCustomerData:false,
      fixture:{caseId:row.id,caseKey:row.case_key,subjectName:row.display_name,status:row.status,completedAt:row.completed_at,
        documentCount:row.document_count,referencedObjectCount:row.referenced_object_count,existingStorageObjectCount:row.existing_storage_object_count},
      legalHold:{active:row.active_hold_count===1,reviewState:row.hold_review_state,automaticRelease:false,
        releaseRequiredRole:"manager_or_admin"},dryRun:{deletedObjects:0,heldCaseCandidateCount:0},
      deletionImpactIfApproved:{storageObjectsDeleted:row.referenced_object_count,documentsRedacted:row.document_count,
        caseMarkedContentDeleted:1,caseAuditEventsSubjectToContentRedaction:row.case_event_count,
        retainedEvidence:"minimal IDs, timestamps, policy version, hashes, counts, outcomes and deletion proof"}};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
}

async function sourceRows(pool:Pool):Promise<{organizationId:string;adminId:string;subject:Record<string,unknown>;case:Record<string,unknown>;submission:Record<string,unknown>;document:Record<string,unknown>}>{
  const client=await pool.connect();try{await client.query("BEGIN READ ONLY");await setContext(client);
    const result=await client.query(`SELECT dop_current_organization_id() AS organization_id,
      (SELECT id FROM actors WHERE organization_id=dop_current_organization_id() AND actor_type='admin' AND status='active' ORDER BY created_at LIMIT 1) AS admin_id,
      to_jsonb(s) AS subject_row,to_jsonb(c) AS case_row,to_jsonb(sub) AS submission_row,to_jsonb(d) AS document_row
      FROM documents d JOIN submissions sub ON sub.organization_id=d.organization_id AND sub.id=d.submission_id
      JOIN cases c ON c.organization_id=d.organization_id AND c.id=d.case_id
      JOIN subjects s ON s.organization_id=c.organization_id AND s.id=c.subject_id
      WHERE d.organization_id=dop_current_organization_id() AND c.content_deleted_at IS NULL ORDER BY d.created_at LIMIT 1`);
    await client.query("COMMIT");const row=result.rows[0];if(!row)throw new Error("source_fixture_unavailable");
    return {organizationId:row.organization_id,adminId:row.admin_id,subject:row.subject_row,case:row.case_row,
      submission:row.submission_row,document:row.document_row};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
}
async function setContext(client:PoolClient){const result=await client.query("SELECT dop_set_organization_context($1) AS id",[organizationKey]);if(!result.rows[0]?.id)throw new Error("organization_not_found");}
async function transaction(pool:Pool,callback:(client:PoolClient)=>Promise<void>){const client=await pool.connect();try{await client.query("BEGIN");await callback(client);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}}
function required(value:string|undefined,name:string):string{if(!value)throw new Error(`${name} is required`);return value;}
function objectValue(value:unknown):Record<string,unknown>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};}
