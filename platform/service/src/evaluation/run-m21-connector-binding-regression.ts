import { randomUUID } from "node:crypto";
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
  const actors=await client.query<{id:string;actor_type:string}>(
    "SELECT id,actor_type FROM actors WHERE status='active' AND actor_type IN ('admin','manager') ORDER BY actor_type",
  );
  const adminId=required(actors.rows.find((row)=>row.actor_type==="admin")?.id,"active admin");
  const managerId=required(actors.rows.find((row)=>row.actor_type==="manager")?.id,"active manager");
  const seed=await client.query<{subject_id:string;definition:Record<string,unknown>}>(`
    SELECT plan.subject_id,version.definition
      FROM case_plan_versions version
      JOIN case_plans plan ON plan.id=version.case_plan_id
     WHERE version.status='published'
     ORDER BY version.created_at DESC LIMIT 1
  `);
  const subjectId=required(seed.rows[0]?.subject_id,"published Case Plan subject");
  const baselineDefinition=structuredClone(seed.rows[0]?.definition ?? {}) as Record<string,unknown>;
  const connectors=await client.query<{
    connector_key:string;display_name:string;connector_version_id:string;
    version:number;revision:number;definition_hash:string;connector_type:string;
  }>(`
    SELECT connector.connector_key,connector.display_name,version.id AS connector_version_id,
           version.version,version.revision,version.definition_hash,
           version.definition->>'connectorType' AS connector_type
      FROM source_connectors connector
      JOIN source_connector_versions version ON version.id=connector.active_version_id
     WHERE connector.lifecycle_status='active' AND version.status='active'
     ORDER BY connector.connector_key
  `);
  const manual=requiredRow(connectors.rows.find((row)=>row.connector_type==="manual_upload"),"active manual connector");
  const api=requiredRow(connectors.rows.find((row)=>row.connector_type==="api"),"active API connector");
  baselineDefinition.sourceBinding={type:"manual_upload",bindingKey:manual.connector_key,metadata:{synthetic:true,m21:true}};
  baselineDefinition.externalDelivery="disabled";

  const planKey=`m21.connector-binding.${randomUUID()}`;
  const created=await mutation(client,"SELECT dop_create_case_plan($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",[
    adminId,subjectId,planKey,"M21 Synthetic Connector Binding",baselineDefinition,
    "Create a rollback-only M21 connector binding regression plan.",randomUUID(),randomUUID(),new Date(),
  ]);
  assert(created.outcome==="completed","M21 Case Plan creation failed");
  const createdVersionId=required(created.versionId,"created version id");
  const apiDefinition={...baselineDefinition,sourceBinding:{type:"api",bindingKey:api.connector_key,metadata:{synthetic:true,m21:true}}};
  const revised=await mutation(client,"SELECT dop_update_case_plan_draft($1,$2,$3,$4,$5,$6,$7) AS result",[
    adminId,createdVersionId,apiDefinition,"Bind the plan to the exact active synthetic API connector.",randomUUID(),randomUUID(),new Date(),
  ]);
  assert(revised.outcome==="completed","M21 Case Plan revision failed");
  const revisedVersionId=required(revised.versionId,"revised version id");
  const reviewed=await mutation(client,"SELECT dop_transition_case_plan_version($1,$2,$3,$4,$5,$6,$7) AS result",[
    adminId,revisedVersionId,"submit_review","Submit the exact connector pin for controlled review.",randomUUID(),randomUUID(),new Date(),
  ]);
  assert(reviewed.outcome==="completed","M21 Case Plan review transition failed");
  const reviewedVersionId=required(reviewed.versionId,"reviewed version id");
  const published=await mutation(client,"SELECT dop_transition_case_plan_version($1,$2,$3,$4,$5,$6,$7) AS result",[
    adminId,reviewedVersionId,"publish","Publish the rollback-only connector binding regression plan.",randomUUID(),randomUUID(),new Date(),
  ]);
  assert(published.outcome==="completed","M21 Case Plan publish failed");
  const publishedVersionId=required(published.versionId,"published version id");

  const preview=await mutation(client,"SELECT dop_preview_case_plan($1,$2,$3,$4,$5,$6,$7,$8) AS result",[
    managerId,publishedVersionId,1,null,"Preview one synthetic Case with an immutable connector pin.",randomUUID(),randomUUID(),new Date(),
  ]);
  assert(preview.outcome==="completed","M21 preview failed");
  const previewId=required(preview.previewId,"preview id");
  const approval=await mutation(client,"SELECT dop_approve_case_plan_preview($1,$2,$3,$4,$5,$6) AS result",[
    managerId,previewId,"Approve one rollback-only synthetic Case for provenance verification.",randomUUID(),randomUUID(),new Date(),
  ]);
  assert(approval.outcome==="completed","M21 preview approval failed");
  const generatedCaseIds=approval.generatedCaseIds as string[];
  const caseId=required(generatedCaseIds?.[0],"generated Case id");

  const pins=await client.query<{
    plan_version_id:string;plan_hash:string;preview_version_id:string;preview_hash:string;
    approval_version_id:string;approval_hash:string;case_version_id:string;case_hash:string;
    snapshot_version_id:string;snapshot_hash:string;
  }>(`
    SELECT plan.source_connector_version_id AS plan_version_id,
           plan.source_connector_definition_hash AS plan_hash,
           preview.source_connector_version_id AS preview_version_id,
           preview.source_connector_definition_hash AS preview_hash,
           approval.source_connector_version_id AS approval_version_id,
           approval.source_connector_definition_hash AS approval_hash,
           case_record.source_connector_version_id AS case_version_id,
           case_record.source_connector_definition_hash AS case_hash,
           case_record.config_snapshot#>>'{source_binding,connectorVersionId}' AS snapshot_version_id,
           case_record.config_snapshot#>>'{source_binding,connectorDefinitionHash}' AS snapshot_hash
      FROM case_plan_versions plan
      JOIN case_plan_preview_batches preview ON preview.case_plan_version_id=plan.id
      JOIN case_plan_approvals approval ON approval.preview_batch_id=preview.id
      JOIN cases case_record ON case_record.id=ANY(approval.generated_case_ids)
     WHERE plan.id=$1 AND preview.id=$2 AND case_record.id=$3
  `,[publishedVersionId,previewId,caseId]);
  const pin=requiredRow(pins.rows[0],"M21 pin evidence");
  for (const value of [pin.plan_version_id,pin.preview_version_id,pin.approval_version_id,pin.case_version_id,pin.snapshot_version_id]) {
    assert(value===api.connector_version_id,"connector Version ID drifted across M21 artifacts");
  }
  for (const value of [pin.plan_hash,pin.preview_hash,pin.approval_hash,pin.case_hash,pin.snapshot_hash]) {
    assert(value===api.definition_hash,"connector Definition Hash drifted across M21 artifacts");
  }

  const submissionId=randomUUID();
  await client.query(`
    INSERT INTO submissions(id,organization_id,case_id,submission_key,source,source_submission_id,status,
      expected_document_count,terminal_document_count,received_at,source_connector_key,created_at,updated_at)
    VALUES($1,$2,$3,$4,'api',$5,'accepted',1,0,$6,$7,$6,$6)
  `,[submissionId,organizationId,caseId,`api|m21-${submissionId}`,`m21-${submissionId}`,new Date(),api.connector_key]);
  const provenance=await client.query<{
    source_connector_version_id:string;source_connector_definition_hash:string;source_connector_key:string;
    source_provenance:Record<string,unknown>;
  }>("SELECT source_connector_version_id,source_connector_definition_hash,source_connector_key,source_provenance FROM submissions WHERE id=$1",[submissionId]);
  const intake=requiredRow(provenance.rows[0],"intake provenance");
  assert(intake.source_connector_version_id===api.connector_version_id,"intake Version ID was not pinned");
  assert(intake.source_connector_definition_hash===api.definition_hash,"intake Definition Hash was not pinned");
  assert(intake.source_connector_key===api.connector_key,"intake connector key drifted");
  assert(intake.source_provenance.runtimeExecution==="disabled" && intake.source_provenance.externalDelivery==="disabled","intake safety boundary drifted");

  await expectConstraint(client,"m21_wrong_claim",async()=>{
    const id=randomUUID();
    await client.query(`
      INSERT INTO submissions(id,organization_id,case_id,submission_key,source,source_submission_id,status,
        expected_document_count,terminal_document_count,received_at,source_connector_key,created_at,updated_at)
      VALUES($1,$2,$3,$4,'api',$5,'accepted',1,0,$6,'wrong.connector',$6,$6)
    `,[id,organizationId,caseId,`api|m21-${id}`,`m21-${id}`,new Date()]);
  },"source_connector_claim_mismatch");

  const suspended=await mutation(client,"SELECT dop_transition_source_connector_version($1,$2,$3,$4,$5,$6,$7) AS result",[
    adminId,api.connector_version_id,"suspend","Suspend inside the rollback-only M21 fail-closed regression.",randomUUID(),randomUUID(),new Date(),
  ]);
  assert(suspended.outcome==="completed","rollback-only connector suspension failed");
  await expectConstraint(client,"m21_suspended_preview",async()=>{
    await client.query("SELECT dop_preview_case_plan($1,$2,$3,$4,$5,$6,$7,$8)",[
      managerId,publishedVersionId,1,"2031-01-01","Prove suspended connectors cannot create a new preview.",randomUUID(),randomUUID(),new Date(),
    ]);
  },"source_connector_not_active");
  await expectConstraint(client,"m21_suspended_intake",async()=>{
    const id=randomUUID();
    await client.query(`
      INSERT INTO submissions(id,organization_id,case_id,submission_key,source,source_submission_id,status,
        expected_document_count,terminal_document_count,received_at,source_connector_key,created_at,updated_at)
      VALUES($1,$2,$3,$4,'api',$5,'accepted',1,0,$6,$7,$6,$6)
    `,[id,organizationId,caseId,`api|m21-${id}`,`m21-${id}`,new Date(),api.connector_key]);
  },"source_connector_not_active");

  await client.query("ROLLBACK");
  await client.query("BEGIN");
  await client.query("SELECT dop_set_organization_context($1)",[organizationKey]);
  const after=await persistentCounts(client);
  assert(JSON.stringify(before)===JSON.stringify(after),"rollback-only M21 regression left persistent records");
  const rls=await client.query<{tables:number;rls:number}>(`
    SELECT count(*)::int AS tables,count(*) FILTER(WHERE relrowsecurity)::int AS rls
      FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
     WHERE pg_namespace.nspname='public' AND relkind='r'
  `);
  const rlsEvidence=requiredRow(rls.rows[0],"RLS evidence");
  assert(rlsEvidence.tables===rlsEvidence.rls,"not every public table has RLS enabled");
  await client.query("COMMIT");
  console.log(JSON.stringify({
    verification:"passed",eligibleConnectors:connectors.rows.length,
    pinnedConnector:{connectorKey:api.connector_key,connectorVersionId:api.connector_version_id,
      version:api.version,revision:api.revision,definitionHash:api.definition_hash},
    artifacts:["case_plan_version","preview","approval","case","submission"],
    mismatchedClaim:"blocked",suspendedPreview:"blocked",suspendedIntake:"blocked",
    runtimeExecution:"disabled",externalDelivery:"disabled",externalCalls:0,
    persistentSideEffects:{plans:after.plans-before.plans,previews:after.previews-before.previews,
      approvals:after.approvals-before.approvals,cases:after.cases-before.cases,submissions:after.submissions-before.submissions},
    rls:`${rlsEvidence.rls}/${rlsEvidence.tables}`,
  },null,2));
} catch(error) {
  await client.query("ROLLBACK").catch(()=>undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}

async function mutation(client:PoolClient,sql:string,values:unknown[]):Promise<Record<string,unknown>> {
  const result=await client.query<{result:Record<string,unknown>}>(sql,values);
  return result.rows[0]?.result ?? {};
}
async function expectConstraint(client:PoolClient,name:string,operation:()=>Promise<void>,message:string):Promise<void> {
  await client.query(`SAVEPOINT ${name}`);
  try { await operation(); throw new Error(`expected ${message}`); }
  catch(error) {
    const actual=error instanceof Error?error.message:"";
    if (actual!==message) throw error;
  } finally { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); }
}
async function persistentCounts(client:PoolClient):Promise<{tables:number;plans:number;previews:number;approvals:number;cases:number;submissions:number}> {
  const result=await client.query<{tables:number;plans:number;previews:number;approvals:number;cases:number;submissions:number}>(`
    SELECT (SELECT count(*)::int FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
             WHERE pg_namespace.nspname='public' AND relkind='r') AS tables,
           (SELECT count(*)::int FROM case_plans) AS plans,
           (SELECT count(*)::int FROM case_plan_preview_batches) AS previews,
           (SELECT count(*)::int FROM case_plan_approvals) AS approvals,
           (SELECT count(*)::int FROM cases) AS cases,
           (SELECT count(*)::int FROM submissions) AS submissions
  `);
  return requiredRow(result.rows[0],"persistent counts");
}
function required(value:unknown,label:string):string {
  if (typeof value!=="string" || !value) throw new Error(`${label} is required`);
  return value;
}
function requiredRow<T>(value:T|undefined,label:string):T {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
function assert(condition:unknown,message:string):asserts condition {
  if (!condition) throw new Error(message);
}
