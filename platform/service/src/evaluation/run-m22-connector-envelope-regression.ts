import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { replayConnectorAdapter } from "../connectors/adapter-contract.js";
import type { SourceConnectorDefinition } from "../ports/ops-source-connector-repository.js";
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
    SELECT plan.subject_id,version.definition FROM case_plan_versions version
    JOIN case_plans plan ON plan.id=version.case_plan_id
    WHERE version.status='published' ORDER BY version.created_at DESC LIMIT 1
  `);
  const subjectId=required(seed.rows[0]?.subject_id,"published Case Plan subject");
  const definition=structuredClone(seed.rows[0]?.definition ?? {}) as Record<string,unknown>;
  const connectorKey=`m22.synthetic-envelope.${randomUUID()}`;
  const connectorDefinition:SourceConnectorDefinition={schemaVersion:"1.0",environment:"DEV",connectorKey,connectorType:"api",transport:"push",
    capabilities:["documents","metadata","webhook"],
    credentialReference:{mode:"secret_reference",provider:"railway",reference:"railway://secret/DOP_M22_SYNTHETIC_CONNECTOR"},
    dataBoundary:{syntheticOnly:true,externalDelivery:"disabled",maxFilesPerSubmission:1,maxFileBytes:1000,
      allowedMimeTypes:["application/pdf"]},
    activationPolicy:{explicitApprovalRequired:true,emergencySuspendEnabled:true,runtimeExecution:"disabled"},
    testFixtures:[{fixtureKey:"m22.synthetic.pdf",displayName:"M22 synthetic PDF",synthetic:true,
      filename:"synthetic-m22.pdf",mimeType:"application/pdf",
      payloadSummary:"Purely synthetic M22 fixture for deterministic envelope boundary verification without network access."}]};
  const connectorCreated=await mutation(client,"SELECT dop_create_source_connector($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",[
    adminId,connectorKey,"M22 Synthetic Envelope API","Rollback-only Connector for M22 envelope boundary evaluation.",connectorDefinition,
    "Create a rollback-only M22 Connector with explicit file boundaries.",randomUUID(),randomUUID(),new Date(),
  ]);
  const connectorDraftId=required(connectorCreated.versionId,"M22 Connector draft");
  const connectorDraft=requiredRow((await client.query<{definition_hash:string}>(
    "SELECT definition_hash FROM source_connector_versions WHERE id=$1",[connectorDraftId])).rows[0],"M22 draft row");
  const connectorReplay=replayConnectorAdapter(connectorDefinition,required(connectorDraft.definition_hash,"M22 definition hash"));
  const connectorTest=await mutation(client,"SELECT dop_record_source_connector_adapter_replay($1,$2,$3,$4,$5,$6,$7) AS result",[
    adminId,connectorDraftId,connectorReplay,"Run the deterministic M22 Connector adapter replay without external calls.",randomUUID(),randomUUID(),new Date(),
  ]);
  assert(connectorTest.outcome==="completed","M22 Connector contract test failed");
  let connectorVersionId=connectorDraftId;
  for (const [action,reason] of [
    ["submit_review","Submit the explicit M22 file boundary for governance review."],
    ["approve","Approve the deterministic M22 Connector boundary definition."],
    ["activate","Activate only the rollback-only M22 governance binding; runtime remains disabled."],
  ] as const) {
    const transitioned=await mutation(client,"SELECT dop_transition_source_connector_version($1,$2,$3,$4,$5,$6,$7) AS result",[
      adminId,connectorVersionId,action,reason,randomUUID(),randomUUID(),new Date(),
    ]);
    assert(transitioned.outcome==="completed",`M22 Connector ${action} failed`);
    connectorVersionId=required(transitioned.versionId,`M22 Connector ${action} version`);
  }
  const connector=requiredRow((await client.query<{
    connector_key:string;connector_version_id:string;definition_hash:string;enforcement_profile:Record<string,unknown>;
  }>(`SELECT connector.connector_key,version.id AS connector_version_id,version.definition_hash,version.enforcement_profile
      FROM source_connectors connector JOIN source_connector_versions version ON version.id=connector.active_version_id
      WHERE connector.connector_key=$1`,[connectorKey])).rows[0],"active M22 Connector");

  await expectConstraint(client,"m22_definition_capability",async()=>{
    const invalidKey=`m22.invalid.${randomUUID()}`;
    await mutation(client,"SELECT dop_create_source_connector($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",[
      adminId,invalidKey,"M22 Invalid Capability","Rollback-only invalid Connector proving the database capability backstop.",
      {...connectorDefinition,connectorKey:invalidKey,capabilities:["metadata","webhook"]},
      "Prove new Connector definitions cannot omit the documents capability.",randomUUID(),randomUUID(),new Date(),
    ]);
  },"source_connector_documents_capability_required");

  definition.sourceBinding={type:"api",bindingKey:connector.connector_key,metadata:{synthetic:true,m22:true}};
  definition.externalDelivery="disabled";
  const created=await mutation(client,"SELECT dop_create_case_plan($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",[
    adminId,subjectId,`m22.envelope.${randomUUID()}`,"M22 Synthetic Envelope",definition,
    "Create a rollback-only M22 canonical envelope regression plan.",randomUUID(),randomUUID(),new Date(),
  ]);
  const draftId=required(created.versionId,"M22 draft version");
  const reviewed=await mutation(client,"SELECT dop_transition_case_plan_version($1,$2,$3,$4,$5,$6,$7) AS result",[
    adminId,draftId,"submit_review","Submit the exact M22 boundary plan for controlled review.",randomUUID(),randomUUID(),new Date(),
  ]);
  const reviewId=required(reviewed.versionId,"M22 review version");
  const published=await mutation(client,"SELECT dop_transition_case_plan_version($1,$2,$3,$4,$5,$6,$7) AS result",[
    adminId,reviewId,"publish","Publish the rollback-only M22 envelope regression plan.",randomUUID(),randomUUID(),new Date(),
  ]);
  const publishedId=required(published.versionId,"M22 published version");
  const preview=await mutation(client,"SELECT dop_preview_case_plan($1,$2,$3,$4,$5,$6,$7,$8) AS result",[
    managerId,publishedId,1,null,"Preview one synthetic M22 envelope Case.",randomUUID(),randomUUID(),new Date(),
  ]);
  const previewId=required(preview.previewId,"M22 preview");
  const approval=await mutation(client,"SELECT dop_approve_case_plan_preview($1,$2,$3,$4,$5,$6) AS result",[
    managerId,previewId,"Approve one rollback-only synthetic M22 envelope Case.",randomUUID(),randomUUID(),new Date(),
  ]);
  const caseId=required((approval.generatedCaseIds as string[]|undefined)?.[0],"M22 generated Case");

  await expectConstraint(client,"m22_count",async()=>insertSubmission(client,organizationId,caseId,connector.connector_key,2),
    "source_connector_file_count_exceeded");

  const submissionId=await insertSubmission(client,organizationId,caseId,connector.connector_key,1);
  const submission=requiredRow((await client.query<{canonical_envelope:Record<string,unknown>;source_provenance:Record<string,unknown>}>(
    "SELECT canonical_envelope,source_provenance FROM submissions WHERE id=$1",[submissionId])).rows[0],"canonical submission envelope");
  assert(path(submission.canonical_envelope,"validation.fileCount")==="passed","submission file-count evidence missing");
  assert(path(submission.canonical_envelope,"boundary.maxFilesPerSubmission")===1,"submission boundary was not fixed");
  assert(path(submission.source_provenance,"enforcementProfile.maxFileBytes")===1000,"source provenance missed normalized enforcement profile");

  await expectConstraint(client,"m22_mime_required",async()=>insertDocument(client,organizationId,caseId,submissionId,null,900),
    "source_connector_declared_mime_required");
  await expectConstraint(client,"m22_size_required",async()=>insertDocument(client,organizationId,caseId,submissionId,"application/pdf",null),
    "source_connector_declared_size_required");
  await expectConstraint(client,"m22_mime_block",async()=>insertDocument(client,organizationId,caseId,submissionId,"image/png",900),
    "source_connector_mime_not_allowed");
  await expectConstraint(client,"m22_size_block",async()=>insertDocument(client,organizationId,caseId,submissionId,"application/pdf",1001),
    "source_connector_file_too_large");
  const documentId=await insertDocument(client,organizationId,caseId,submissionId,"APPLICATION/PDF",999);
  const document=requiredRow((await client.query<{declared_mime_type:string;source_envelope:Record<string,unknown>}>(
    "SELECT declared_mime_type,source_envelope FROM documents WHERE id=$1",[documentId])).rows[0],"canonical document envelope");
  assert(document.declared_mime_type==="application/pdf","document MIME was not normalized");
  assert(path(document.source_envelope,"validation.status")==="passed","document envelope validation evidence missing");
  assert(path(document.source_envelope,"file.downloadReference")==="documents.source_download_ref","provider URL leaked into envelope");
  assert(!JSON.stringify(document.source_envelope).includes("example.invalid"),"provider URL was copied into canonical envelope");

  await client.query("ROLLBACK");
  await client.query("BEGIN");
  await client.query("SELECT dop_set_organization_context($1)",[organizationKey]);
  const after=await persistentCounts(client);
  assert(JSON.stringify(before)===JSON.stringify(after),"rollback-only M22 regression left persistent records");
  const rls=requiredRow((await client.query<{tables:number;rls:number}>(`
    SELECT count(*)::int AS tables,count(*) FILTER(WHERE relrowsecurity)::int AS rls
    FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
    WHERE pg_namespace.nspname='public' AND relkind='r'
  `)).rows[0],"RLS evidence");
  assert(rls.tables===rls.rls,"not every public table has RLS enabled");
  await client.query("COMMIT");
  console.log(JSON.stringify({verification:"passed",connectorKey:connector.connector_key,
    connectorVersionId:connector.connector_version_id,definitionHash:connector.definition_hash,
    enforcement:{maxFilesPerSubmission:1,maxFileBytes:1000,allowedMimeTypes:["application/pdf"]},
    blocked:{invalidDefinitionCapability:true,fileCount:true,missingMime:true,missingSize:true,disallowedMime:true,oversize:true},
    envelopes:["submission.canonical_envelope","document.source_envelope"],normalizedMime:"application/pdf",
    providerUrlCopied:false,runtimeExecution:"disabled",externalDelivery:"disabled",externalCalls:0,
    persistentSideEffects:{plans:after.plans-before.plans,cases:after.cases-before.cases,
      submissions:after.submissions-before.submissions,documents:after.documents-before.documents},rls:`${rls.rls}/${rls.tables}`},null,2));
} catch(error) {
  await client.query("ROLLBACK").catch(()=>undefined); throw error;
} finally { client.release(); await pool.end(); }

async function insertSubmission(client:PoolClient,organizationId:string,caseId:string,connectorKey:string,fileCount:number):Promise<string> {
  const id=randomUUID(); const now=new Date();
  await client.query(`INSERT INTO submissions(id,organization_id,case_id,submission_key,source,source_submission_id,status,
    expected_document_count,terminal_document_count,raw_payload_reference,received_at,source_connector_key,created_at,updated_at)
    VALUES($1,$2,$3,$4,'api',$5,'accepted',$6,0,'synthetic://m22-payload',$7,$8,$7,$7)`,
  [id,organizationId,caseId,`api|m22-${id}`,`m22-${id}`,fileCount,now,connectorKey]);
  return id;
}
async function insertDocument(client:PoolClient,organizationId:string,caseId:string,submissionId:string,mime:string|null,size:number|null):Promise<string> {
  const id=randomUUID(); const now=new Date();
  await client.query(`INSERT INTO documents(id,organization_id,case_id,submission_id,idempotency_key,source_file_id,
    original_filename,declared_mime_type,size_bytes,content_hash_sha256,source_download_ref,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic-m22.pdf',$7,$8,$9,'https://example.invalid/m22/synthetic.pdf','reserved',$10,$10)`,
  [id,organizationId,caseId,submissionId,`m22-doc|${id}`,`m22-file-${id}`,mime,size,"a".repeat(64),now]);
  return id;
}
async function mutation(client:PoolClient,sql:string,values:unknown[]):Promise<Record<string,unknown>> {
  const result=await client.query<{result:Record<string,unknown>}>(sql,values); return result.rows[0]?.result ?? {};
}
async function expectConstraint(client:PoolClient,name:string,operation:()=>Promise<unknown>,message:string):Promise<void> {
  await client.query(`SAVEPOINT ${name}`);
  try { await operation(); throw new Error(`expected ${message}`); }
  catch(error) { if (!(error instanceof Error) || error.message!==message) throw error; }
  finally { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); }
}
async function persistentCounts(client:PoolClient):Promise<{plans:number;cases:number;submissions:number;documents:number}> {
  return requiredRow((await client.query<{plans:number;cases:number;submissions:number;documents:number}>(`
    SELECT (SELECT count(*)::int FROM case_plans) AS plans,(SELECT count(*)::int FROM cases) AS cases,
      (SELECT count(*)::int FROM submissions) AS submissions,(SELECT count(*)::int FROM documents) AS documents
  `)).rows[0],"persistent counts");
}
function path(value:Record<string,unknown>,key:string):unknown {
  return key.split(".").reduce<unknown>((current,part)=>current&&typeof current==="object"?(current as Record<string,unknown>)[part]:undefined,value);
}
function required(value:unknown,label:string):string { if(typeof value!=="string"||!value) throw new Error(`${label} is required`); return value; }
function requiredRow<T>(value:T|undefined,label:string):T { if(!value) throw new Error(`${label} is required`); return value; }
function assert(condition:unknown,message:string):asserts condition { if(!condition) throw new Error(message); }
