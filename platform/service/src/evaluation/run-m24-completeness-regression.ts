import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";

const organizationKey=required(process.env.DOP_ORGANIZATION_KEY,"DOP_ORGANIZATION_KEY");
const pool=new Pool(postgresPoolConfig(required(process.env.DATABASE_URL,"DATABASE_URL"),process.env.DATABASE_SSL_CA_PATH,2));
const client=await pool.connect();

try {
  await client.query("BEGIN");
  const organization=await client.query<{id:string}>("SELECT dop_set_organization_context($1) AS id",[organizationKey]);
  const organizationId=required(organization.rows[0]?.id,"organization id");
  const before=await persistentCounts(client);
  const seed=requiredRow((await client.query<{
    id:string;subject_id:string;workflow_template_version_id:string;prompt_version_id:string;
    timezone:string;config_snapshot:Record<string,unknown>;classifier_release_version_id:string;
  }>(`
    SELECT c.id,c.subject_id,c.workflow_template_version_id,c.prompt_version_id,c.timezone,
           c.config_snapshot,c.classifier_release_version_id
      FROM cases c
     WHERE c.source_connector_version_id IS NULL
       AND c.status<>'cancelled'
     ORDER BY c.created_at
     LIMIT 1
  `)).rows[0],"legacy synthetic seed Case");
  const types=await client.query<{id:string;code:string}>(`
    SELECT id,code FROM document_types
     WHERE status='active'
     ORDER BY code
     LIMIT 2
  `);
  assert(types.rows.length===2,"two active Document Types are required");
  const firstType=requiredRow(types.rows[0],"first Document Type");
  const secondType=requiredRow(types.rows[1],"second Document Type");
  const now=new Date();

  const setId=randomUUID();
  const versionId=randomUUID();
  await client.query(`
    INSERT INTO requirement_sets(id,organization_id,set_key,display_name,created_at,updated_at)
    VALUES($1,$2,$3,'M24 rollback-only completeness requirements',$4,$4)
  `,[setId,organizationId,`m24.${randomUUID()}`,now]);
  await client.query(`
    INSERT INTO requirement_set_versions(id,organization_id,requirement_set_id,version,status,effective_from,definition_hash,created_at)
    VALUES($1,$2,$3,1,'published',$4,$5,$4)
  `,[versionId,organizationId,setId,now,createHash("sha256").update(versionId).digest("hex")]);
  const firstRequirementId=randomUUID();
  const secondRequirementId=randomUUID();
  await client.query(`
    INSERT INTO requirements(id,organization_id,requirement_set_version_id,requirement_code,document_type_id,
      minimum_count,maximum_count,acceptance_rule,created_at)
    VALUES
      ($1,$3,$4,'m24.first',$5,1,1,'{"synthetic":true}'::jsonb,$7),
      ($2,$3,$4,'m24.second',$6,1,1,'{"synthetic":true}'::jsonb,$7)
  `,[firstRequirementId,secondRequirementId,organizationId,versionId,firstType.id,secondType.id,now]);

  const caseId=randomUUID();
  const caseKey=`m24-completeness-${randomUUID()}`;
  await client.query(`
    INSERT INTO cases(id,organization_id,case_key,subject_id,workflow_template_version_id,
      requirement_set_version_id,prompt_version_id,external_reference,period_start,period_end,
      timezone,status,risk_status,due_at,config_snapshot,version,created_at,updated_at,
      classifier_release_version_id,source_connector_version_id,source_connector_definition_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,'M24-ROLLBACK','2026-08-01','2026-08-31',
      $8,'waiting_for_documents','normal',$9,$10::jsonb,1,$11,$11,$12,NULL,NULL)
  `,[caseId,organizationId,caseKey,seed.subject_id,seed.workflow_template_version_id,versionId,
    seed.prompt_version_id,seed.timezone,new Date(now.getTime()+7*86_400_000),
    JSON.stringify({...seed.config_snapshot,m24:{synthetic:true,rollbackOnly:true}}),now,seed.classifier_release_version_id]);

  const submissionId=randomUUID();
  await client.query(`
    INSERT INTO submissions(id,organization_id,case_id,submission_key,source,source_submission_id,status,
      expected_document_count,terminal_document_count,received_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,'internal_upload',$5,'accepted',4,0,$6,$6,$6)
  `,[submissionId,organizationId,caseId,`internal_upload|${submissionId}`,`m24-${submissionId}`,now]);

  const documentIds=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  const hashes=["1".repeat(64),"1".repeat(64),"2".repeat(64),"3".repeat(64)];
  for (const [index,documentId] of documentIds.entries()) {
    await client.query(`
      INSERT INTO documents(id,organization_id,case_id,submission_id,idempotency_key,source_file_id,
        original_filename,declared_mime_type,detected_mime_type,size_bytes,content_hash_sha256,
        incoming_storage_ref,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'application/pdf','application/pdf',128,$8,$9,'reserved',$10,$10)
    `,[documentId,organizationId,caseId,submissionId,`m24|${documentId}`,`m24-file-${index+1}`,
      `m24-synthetic-${index+1}.pdf`,hashes[index],`synthetic/m24/${documentId}`,new Date(now.getTime()+index)]);
  }

  await client.query("UPDATE documents SET accepted_document_type_id=$2,status='accepted',updated_at=$3 WHERE id=$1",
    [documentIds[0],firstType.id,new Date(now.getTime()+10)]);
  await client.query("UPDATE documents SET accepted_document_type_id=$2,status='accepted',updated_at=$3 WHERE id=$1",
    [documentIds[1],firstType.id,new Date(now.getTime()+11)]);
  await client.query("UPDATE documents SET accepted_document_type_id=$2,status='accepted',updated_at=$3 WHERE id=$1",
    [documentIds[2],firstType.id,new Date(now.getTime()+12)]);
  await client.query("UPDATE documents SET accepted_document_type_id=$2,status='review_required',updated_at=$3 WHERE id=$1",
    [documentIds[3],secondType.id,new Date(now.getTime()+13)]);

  const first=requiredRow((await client.query<AssessmentRow>(`
    SELECT * FROM case_completeness_assessments
     WHERE case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1
  `,[caseId])).rows[0],"first completeness assessment");
  assert(first.status==="review_required","exceptions did not fail closed to review_required");
  assert(Number(first.duplicate_document_count)===1,"same-content duplicate was not identified");
  assert(Number(first.excess_document_count)===1,"maximum_count excess was not identified");
  assert(Number(first.review_required_document_count)===1,"human confirmation was not identified");
  assert(Number(first.missing_requirement_count)===1,"review-only requirement was not reported missing");
  const firstMatches=await client.query<{document_id:string;match_status:string;is_excess:boolean;counts_toward_minimum:boolean}>(`
    SELECT document_id,match_status,is_excess,counts_toward_minimum
      FROM document_requirement_matches WHERE assessment_id=$1
  `,[first.id]);
  assert(firstMatches.rows.length===4,"one match row per Document was not recorded");
  assert(firstMatches.rows.some((row)=>row.document_id===documentIds[1]&&row.match_status==="duplicate"),
    "duplicate Document match evidence missing");
  assert(firstMatches.rows.some((row)=>row.document_id===documentIds[2]&&row.is_excess),
    "excess Document match evidence missing");

  const repeated=await client.query<{id:string}>("SELECT dop_recompute_submission_completeness($1,$2) AS id",[submissionId,new Date(now.getTime()+14)]);
  assert(repeated.rows[0]?.id===first.id,"identical completeness input was not idempotent");

  await client.query("UPDATE requirements SET maximum_count=2 WHERE id=ANY($1::uuid[])",[[firstRequirementId,secondRequirementId]]);
  await client.query("UPDATE documents SET content_hash_sha256=$2,accepted_document_type_id=$3,updated_at=$4 WHERE id=$1",
    [documentIds[1],"4".repeat(64),secondType.id,new Date(now.getTime()+20)]);
  await client.query("UPDATE documents SET status='human_confirmed',updated_at=$2 WHERE id=$1",
    [documentIds[3],new Date(now.getTime()+21)]);

  const final=requiredRow((await client.query<AssessmentRow>(`
    SELECT * FROM case_completeness_assessments
     WHERE case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1
  `,[caseId])).rows[0],"final completeness assessment");
  assert(final.status==="complete","resolved synthetic Case did not become complete");
  for (const field of ["missing_requirement_count","duplicate_document_count","excess_document_count",
    "review_required_document_count","unmatched_document_count"] as const) {
    assert(Number(final[field])===0,`${field} did not resolve to zero`);
  }
  const finalCase=requiredRow((await client.query<{status:string}>("SELECT status FROM cases WHERE id=$1",[caseId])).rows[0],"final Case");
  assert(finalCase.status==="ready","complete Case did not advance to ready");
  const terminal=requiredRow((await client.query<{status:string;terminal_document_count:number;expected_document_count:number}>(
    "SELECT status,terminal_document_count,expected_document_count FROM submissions WHERE id=$1",[submissionId])).rows[0],"terminal Submission");
  assert(terminal.status==="completed"&&Number(terminal.terminal_document_count)===Number(terminal.expected_document_count),
    "Submission terminal boundary was not maintained");
  const history=await client.query<{assessments:number;events:number}>(`
    SELECT (SELECT count(*)::int FROM case_completeness_assessments WHERE case_id=$1) AS assessments,
           (SELECT count(*)::int FROM workflow_events WHERE aggregate_type='case' AND aggregate_id=$1
             AND event_type='Case.CompletenessAssessed') AS events
  `,[caseId]);
  assert(Number(history.rows[0]?.assessments)>=3,"append-only completeness history was not retained");
  assert(history.rows[0]?.assessments===history.rows[0]?.events,"assessment/event evidence count drifted");

  await client.query("ROLLBACK");
  await client.query("BEGIN");
  await client.query("SELECT dop_set_organization_context($1)",[organizationKey]);
  const after=await persistentCounts(client);
  assert(JSON.stringify(before)===JSON.stringify(after),"rollback-only M24 regression left persistent records");
  const rls=requiredRow((await client.query<{tables:number;rls:number}>(`
    SELECT count(*)::int AS tables,count(*) FILTER(WHERE relrowsecurity)::int AS rls
      FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
     WHERE pg_namespace.nspname='public' AND relkind='r'
  `)).rows[0],"RLS evidence");
  assert(rls.tables===rls.rls,"not every public table has RLS enabled");
  const callable=requiredRow((await client.query<{allowed:boolean}>(`
    SELECT has_function_privilege('dop_app',pg_proc.oid,'EXECUTE') AS allowed
      FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
     WHERE pg_namespace.nspname='public' AND proname='dop_recompute_submission_completeness'
  `)).rows[0],"completeness function privilege");
  assert(callable.allowed===false,"application role can invoke internal completeness recomputation directly");
  await client.query("COMMIT");
  console.log(JSON.stringify({verification:"passed",algorithmVersion:"1.0",terminalBoundary:"4/4",
    firstAssessment:{status:first.status,missing:Number(first.missing_requirement_count),duplicates:Number(first.duplicate_document_count),
      excess:Number(first.excess_document_count),reviewRequired:Number(first.review_required_document_count)},
    finalAssessment:{status:final.status,caseStatus:finalCase.status,exceptions:0},
    appendOnlyAssessments:Number(history.rows[0]?.assessments),externalCalls:0,externalDelivery:"disabled",
    persistentSideEffects:Object.fromEntries(Object.entries(after).map(([key,value])=>[key,value-(before[key]??0)])),
    rls:`${rls.rls}/${rls.tables}`,directRecomputePrivilege:"revoked"},null,2));
} catch(error) {
  await client.query("ROLLBACK").catch(()=>undefined); throw error;
} finally { client.release(); await pool.end(); }

interface AssessmentRow {
  id:string;status:string;missing_requirement_count:number;duplicate_document_count:number;
  excess_document_count:number;review_required_document_count:number;unmatched_document_count:number;
}

async function persistentCounts(client:PoolClient):Promise<Record<string,number>> {
  return requiredRow((await client.query<Record<string,number>>(`SELECT
    (SELECT count(*)::int FROM requirement_sets) AS requirement_sets,
    (SELECT count(*)::int FROM requirement_set_versions) AS requirement_versions,
    (SELECT count(*)::int FROM requirements) AS requirements,
    (SELECT count(*)::int FROM cases) AS cases,
    (SELECT count(*)::int FROM submissions) AS submissions,
    (SELECT count(*)::int FROM documents) AS documents,
    (SELECT count(*)::int FROM case_completeness_assessments) AS assessments,
    (SELECT count(*)::int FROM document_requirement_matches) AS matches,
    (SELECT count(*)::int FROM workflow_events) AS events`)).rows[0],"persistent counts");
}
function required(value:unknown,label:string):string { if(typeof value!=="string"||!value) throw new Error(`${label} is required`); return value; }
function requiredRow<T>(value:T|undefined,label:string):T { if(!value) throw new Error(`${label} is required`); return value; }
function assert(condition:unknown,message:string):asserts condition { if(!condition) throw new Error(message); }
