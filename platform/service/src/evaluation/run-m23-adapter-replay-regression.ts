import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { replayConnectorAdapter, ConnectorAdapterReplayError } from "../connectors/adapter-contract.js";
import type { SourceConnectorDefinition, SourceConnectorType } from "../ports/ops-source-connector-repository.js";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";

const organizationKey=required(process.env.DOP_ORGANIZATION_KEY,"DOP_ORGANIZATION_KEY");
const pool=new Pool(postgresPoolConfig(required(process.env.DATABASE_URL,"DATABASE_URL"),process.env.DATABASE_SSL_CA_PATH,2));
const client=await pool.connect();
const variants:Array<{type:SourceConnectorType;transport:"operator"|"push"|"pull";capabilities:SourceConnectorDefinition["capabilities"]}>=[
  {type:"manual_upload",transport:"operator",capabilities:["documents","metadata"]},
  {type:"form",transport:"push",capabilities:["documents","metadata","webhook"]},
  {type:"email",transport:"push",capabilities:["documents","metadata","attachments"]},
  {type:"api",transport:"push",capabilities:["documents","metadata"]},
  {type:"sharepoint",transport:"pull",capabilities:["documents","metadata","polling"]},
  {type:"sftp",transport:"pull",capabilities:["documents","polling"]},
  {type:"object_storage",transport:"pull",capabilities:["documents","metadata","polling"]},
];

try {
  await client.query("BEGIN");
  const organization=await client.query<{id:string}>("SELECT dop_set_organization_context($1) AS id",[organizationKey]);
  required(organization.rows[0]?.id,"organization id");
  const before=await persistentCounts(client);
  const admin=await client.query<{id:string}>("SELECT id FROM actors WHERE status='active' AND actor_type='admin' ORDER BY created_at LIMIT 1");
  const adminId=required(admin.rows[0]?.id,"active admin");
  const replayHashes:string[]=[];

  for (const [index,variant] of variants.entries()) {
    const definition=fixture(variant.type,variant.transport,variant.capabilities);
    const created=await mutation(client,"SELECT dop_create_source_connector($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",[
      adminId,definition.connectorKey,`M23 ${variant.type} Adapter`,`Rollback-only M23 ${variant.type} adapter replay evidence.`,definition,
      `Create rollback-only M23 ${variant.type} adapter evidence.`,randomUUID(),randomUUID(),new Date(),
    ]);
    assert(created.outcome==="completed",`${variant.type} connector creation failed`);
    const versionId=required(created.versionId,`${variant.type} version`);
    const version=requiredRow((await client.query<{definition_hash:string}>(
      "SELECT definition_hash FROM source_connector_versions WHERE id=$1",[versionId])).rows[0],`${variant.type} version row`);
    const definitionHash=required(version.definition_hash,`${variant.type} definition hash`);
    const first=replayConnectorAdapter(definition,definitionHash);
    const second=replayConnectorAdapter(definition,definitionHash);
    assert(JSON.stringify(first)===JSON.stringify(second),`${variant.type} replay was not deterministic`);
    assert(first.externalCallCount===0&&first.credentialResolution==="not_attempted"&&!first.persistedDocuments,
      `${variant.type} replay crossed a safety boundary`);
    const idempotencyKey=randomUUID();
    const reason=`Record deterministic rollback-only M23 ${variant.type} adapter replay evidence.`;
    const recorded=await mutation(client,"SELECT dop_record_source_connector_adapter_replay($1,$2,$3,$4,$5,$6,$7) AS result",[
      adminId,versionId,first,reason,idempotencyKey,randomUUID(),new Date(),
    ]);
    assert(recorded.outcome==="completed"&&recorded.adapterContractVersion==="1.0",`${variant.type} evidence was rejected`);
    const replayHash=required(recorded.replayHash,`${variant.type} replay hash`);
    assert(/^[0-9a-f]{64}$/.test(replayHash),`${variant.type} replay hash invalid`);
    replayHashes.push(replayHash);
    if (index===0) {
      const duplicate=await mutation(client,"SELECT dop_record_source_connector_adapter_replay($1,$2,$3,$4,$5,$6,$7) AS result",[
        adminId,versionId,first,reason,idempotencyKey,randomUUID(),new Date(),
      ]);
      assert(duplicate.outcome==="duplicate"&&duplicate.replayHash===replayHash,"adapter replay idempotency failed");
      const submitted=await mutation(client,"SELECT dop_transition_source_connector_version($1,$2,$3,$4,$5,$6,$7) AS result",[
        adminId,versionId,"submit_review","Submit the M23 adapter replay evidence for rollback-only governance verification.",randomUUID(),randomUUID(),new Date(),
      ]);
      assert(submitted.outcome==="completed","Adapter replay did not satisfy governance transition");
    }
  }

  const evidence=await client.query<{count:number;external_calls:number;persisted_documents:number}>(`
    SELECT count(*)::int AS count,
           coalesce(sum((result->>'externalCallCount')::int),0)::int AS external_calls,
           count(*) FILTER (WHERE coalesce((result->>'persistedDocuments')::boolean,true))::int AS persisted_documents
      FROM source_connector_test_runs WHERE adapter_contract_version='1.0' AND replay_hash=ANY($1::text[])
  `,[replayHashes]);
  assert(evidence.rows[0]?.count===7,"not all seven adapter replays were recorded");
  assert(evidence.rows[0]?.external_calls===0&&evidence.rows[0]?.persisted_documents===0,"replay evidence reported side effects");

  let unsafeBlocked=false;
  const unsafe=fixture("api","push",["documents"]); unsafe.testFixtures[0]!.mimeType="image/png";
  try { replayConnectorAdapter(unsafe,"f".repeat(64)); }
  catch(error) { unsafeBlocked=error instanceof ConnectorAdapterReplayError&&error.code==="adapter_fixture_mime_not_allowed"; }
  assert(unsafeBlocked,"unsafe adapter fixture did not fail closed");

  await client.query("ROLLBACK");
  await client.query("BEGIN");
  await client.query("SELECT dop_set_organization_context($1)",[organizationKey]);
  const after=await persistentCounts(client);
  assert(JSON.stringify(before)===JSON.stringify(after),"rollback-only M23 regression left persistent records");
  const rls=requiredRow((await client.query<{tables:number;rls:number}>(`
    SELECT count(*)::int AS tables,count(*) FILTER(WHERE relrowsecurity)::int AS rls
      FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
     WHERE pg_namespace.nspname='public' AND relkind='r'
  `)).rows[0],"RLS evidence");
  assert(rls.tables===rls.rls,"not every public table has RLS enabled");
  const privileges=await client.query<{proname:string;allowed:boolean}>(`
    SELECT proname,has_function_privilege('dop_app',pg_proc.oid,'EXECUTE') AS allowed
      FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
     WHERE pg_namespace.nspname='public'
       AND proname IN ('dop_run_source_connector_test','dop_record_source_connector_adapter_replay')
  `);
  assert(privileges.rows.find((row)=>row.proname==="dop_run_source_connector_test")?.allowed===false,
    "legacy definition-only test remains executable by dop_app");
  assert(privileges.rows.find((row)=>row.proname==="dop_record_source_connector_adapter_replay")?.allowed===true,
    "adapter replay recorder is not executable by dop_app");
  await client.query("COMMIT");
  console.log(JSON.stringify({verification:"passed",adapterContractVersion:"1.0",adapters:"7/7",
    deterministicReplays:"7/7",uniqueReplayHashes:new Set(replayHashes).size,unsafeFixtureBlocked:true,
    externalCalls:0,credentialResolutions:0,documentWrites:0,runtimeExecution:"disabled",externalDelivery:"disabled",
    privileges:{legacyDefinitionTest:"revoked",adapterReplayRecorder:"granted"},
    persistentSideEffects:Object.fromEntries(Object.entries(after).map(([key,value])=>[key,value-(before[key]??0)])),
    rls:`${rls.rls}/${rls.tables}`},null,2));
} catch(error) {
  await client.query("ROLLBACK").catch(()=>undefined); throw error;
} finally { client.release(); await pool.end(); }

function fixture(type:SourceConnectorType,transport:"operator"|"push"|"pull",capabilities:SourceConnectorDefinition["capabilities"]):SourceConnectorDefinition {
  const suffix=randomUUID();
  return {schemaVersion:"1.0",environment:"DEV",connectorKey:`m23.${type}.${suffix}`,connectorType:type,transport,capabilities,
    credentialReference:type==="manual_upload"?{mode:"none",provider:"none",reference:null}:
      {mode:"secret_reference",provider:"railway",reference:"railway://secret/DOP_M23_SYNTHETIC_ADAPTER"},
    dataBoundary:{syntheticOnly:true,externalDelivery:"disabled",maxFilesPerSubmission:5,maxFileBytes:1000,allowedMimeTypes:["application/pdf"]},
    activationPolicy:{explicitApprovalRequired:true,emergencySuspendEnabled:true,runtimeExecution:"disabled"},
    testFixtures:[{fixtureKey:`${type}.fixture`,displayName:`${type} synthetic fixture`,synthetic:true,filename:`${type}-synthetic.pdf`,
      mimeType:"application/pdf",payloadSummary:`Purely synthetic ${type} fixture for deterministic offline adapter replay without external access.`}]};
}
async function mutation(client:PoolClient,sql:string,values:unknown[]):Promise<Record<string,unknown>> {
  const result=await client.query<{result:Record<string,unknown>}>(sql,values); return result.rows[0]?.result??{};
}
async function persistentCounts(client:PoolClient):Promise<Record<string,number>> {
  return requiredRow((await client.query<Record<string,number>>(`SELECT
    (SELECT count(*)::int FROM source_connectors) AS connectors,
    (SELECT count(*)::int FROM source_connector_versions) AS connector_versions,
    (SELECT count(*)::int FROM source_connector_test_runs) AS test_runs,
    (SELECT count(*)::int FROM workflow_events) AS events,
    (SELECT count(*)::int FROM cases) AS cases,
    (SELECT count(*)::int FROM submissions) AS submissions,
    (SELECT count(*)::int FROM documents) AS documents`)).rows[0],"persistent counts");
}
function required(value:unknown,label:string):string { if(typeof value!=="string"||!value) throw new Error(`${label} is required`); return value; }
function requiredRow<T>(value:T|undefined,label:string):T { if(!value) throw new Error(`${label} is required`); return value; }
function assert(condition:unknown,message:string):asserts condition { if(!condition) throw new Error(message); }
