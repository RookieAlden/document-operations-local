import { Pool } from "pg";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";
import type {
  OpsSourceConnectorSnapshot,
  OpsSourceConnectorVersion,
  SourceConnectorDefinition,
} from "../ports/ops-source-connector-repository.js";

interface Session { cookie: string; csrfToken: string }
type JsonRecord = Record<string, unknown>;

const opsUrl=required(process.env.DOP_M20_OPS_URL,"DOP_M20_OPS_URL").replace(/\/$/,"");
const origin=new URL(opsUrl).origin;
const connectorKey="m20.synthetic-api-registry";
const keys={create:"00000000-0000-4000-a200-000000000101",revise:"00000000-0000-4000-a200-000000000102",
  test:"00000000-0000-4000-a200-000000000103",review:"00000000-0000-4000-a200-000000000104",
  approve:"00000000-0000-4000-a200-000000000105",activate:"00000000-0000-4000-a200-000000000106",
  suspend:"00000000-0000-4000-a200-000000000107",reactivate:"00000000-0000-4000-a200-000000000108",
  managerMutation:"00000000-0000-4000-a200-000000000109"};

const owner=await login(required(process.env.DOP_M20_OWNER_EMAIL,"DOP_M20_OWNER_EMAIL"),required(process.env.DOP_M20_OWNER_PASSWORD,"DOP_M20_OWNER_PASSWORD"));
const manager=await login(required(process.env.DOP_M20_MANAGER_EMAIL,"DOP_M20_MANAGER_EMAIL"),required(process.env.DOP_M20_MANAGER_PASSWORD,"DOP_M20_MANAGER_PASSWORD"));
const staff=await login(required(process.env.DOP_M20_STAFF_EMAIL,"DOP_M20_STAFF_EMAIL"),required(process.env.DOP_M20_STAFF_PASSWORD,"DOP_M20_STAFF_PASSWORD"));

assertStatus(await fetch(`${opsUrl}/v1/ops/source-connectors`,{headers:{cookie:staff.cookie}}),403,"staff source connector catalog");
const managerSnapshot=await getJson<OpsSourceConnectorSnapshot>(manager,"/v1/ops/source-connectors");
assert(managerSnapshot.canManage===false,"manager unexpectedly received connector mutation rights");
const managerVersion=managerSnapshot.versions[0]; assert(managerVersion,"manager could not read connector catalog");
assertStatus(await fetch(`${opsUrl}/v1/ops/source-connectors/${managerVersion.id}/tests`,{
  method:"POST",headers:mutationHeaders(manager),body:JSON.stringify({reason:"Manager must remain outside connector mutation rights.",idempotencyKey:keys.managerMutation}),
}),403,"manager connector mutation");

const pool=new Pool(postgresPoolConfig(required(process.env.DATABASE_URL,"DATABASE_URL"),
  required(process.env.DOP_M20_DATABASE_SSL_CA_PATH??process.env.DATABASE_SSL_CA_PATH,"DOP_M20_DATABASE_SSL_CA_PATH"),1));
const baseline=await operationalCounts(pool);
let snapshot=await getJson<OpsSourceConnectorSnapshot>(owner,"/v1/ops/source-connectors");
assert(snapshot.canManage,"owner did not receive connector mutation rights");
const baselineBinding=snapshot.versions.find((item)=>item.connectorKey==="m16-rimu-controlled-upload"&&item.isActiveVersion);
assert(baselineBinding&&baselineBinding.referencedByPlanCount>=1,"existing Case Plan binding was not governed by the registry");

let current=latest(snapshot.versions.filter((item)=>item.connectorKey===connectorKey));
if (!current) {
  const created=await postJson(owner,"/v1/ops/source-connectors",{connectorKey,displayName:"M20 纯虚构 API 入口",
    description:"用于证明跨行业资料来源登记、审批、暂停和撤销边界的纯虚构 DEV 连接器。",
    definition:definition(),reason:"建立 M20 纯虚构 API 连接器以验证通用资料来源治理生命周期。",idempotencyKey:keys.create});
  current=await versionById(owner,requiredString(created.versionId,"created connector version id"));
}
if (current.status==="draft"&&current.revision===1) {
  const revised=await postJson(owner,`/v1/ops/source-connectors/${current.id}/revisions`,{
    definition:{...current.definition,capabilities:[...current.definition.capabilities,"attachments"],
      dataBoundary:{...current.definition.dataBoundary,maxFilesPerSubmission:20}},
    reason:"追加附件能力以证明定义修订会生成不可变新记录并使旧测试证据失效。",idempotencyKey:keys.revise});
  current=await versionById(owner,requiredString(revised.versionId,"revised connector version id"));
}
if (current.status==="draft") {
  const body={reason:"使用纯虚构契约检查能力、Secret Reference 格式和固定禁用边界。",idempotencyKey:keys.test};
  const tested=await postJson(owner,`/v1/ops/source-connectors/${current.id}/tests`,body);
  assert(tested.status==="passed"&&(tested.result as JsonRecord)?.externalCallCount===0,"connector test made an external call");
  const duplicate=await postJson(owner,`/v1/ops/source-connectors/${current.id}/tests`,body);
  assert(duplicate.outcome==="duplicate"&&duplicate.status==="passed","connector test retry was not idempotent");
  const reviewed=await postJson(owner,`/v1/ops/source-connectors/${current.id}/transitions`,{
    action:"submit_review",reason:"送审与通过测试完全相同的定义哈希，且运行执行继续固定关闭。",idempotencyKey:keys.review});
  current=await versionById(owner,requiredString(reviewed.versionId,"review connector version id"));
}
if (current.status==="in_review") {
  const approved=await postJson(owner,`/v1/ops/source-connectors/${current.id}/transitions`,{
    action:"approve",reason:"批准纯虚构连接器定义；只认可目录资格，不解析凭证或接通外部系统。",idempotencyKey:keys.approve});
  current=await versionById(owner,requiredString(approved.versionId,"approved connector version id"));
}
if (current.status==="approved") {
  const activated=await postJson(owner,`/v1/ops/source-connectors/${current.id}/transitions`,{
    action:"activate",reason:"治理启用纯虚构连接器以证明未来配置可引用，同时运行执行仍为关闭。",idempotencyKey:keys.activate});
  current=await versionById(owner,requiredString(activated.versionId,"active connector version id"));
}
if (current.status==="active"&&current.revision<7) {
  const suspended=await postJson(owner,`/v1/ops/source-connectors/${current.id}/transitions`,{
    action:"suspend",reason:"模拟安全窗口中的紧急暂停，确认连接器可以立即从可绑定状态撤下。",idempotencyKey:keys.suspend});
  current=await versionById(owner,requiredString(suspended.versionId,"suspended connector version id"));
}
if (current.status==="suspended") {
  const reactivated=await postJson(owner,`/v1/ops/source-connectors/${current.id}/transitions`,{
    action:"reactivate",reason:"完成纯虚构复核后重新治理启用，继续保持网络和外部发送关闭。",idempotencyKey:keys.reactivate});
  current=await versionById(owner,requiredString(reactivated.versionId,"reactivated connector version id"));
}

assert(current.status==="active"&&current.isActiveVersion&&current.lifecycleStatus==="active","M20 connector is not the active governed version");
assert(current.definition.activationPolicy.runtimeExecution==="disabled"&&current.definition.dataBoundary.externalDelivery==="disabled",
  "connector runtime safety boundary drifted");
snapshot=await getJson<OpsSourceConnectorSnapshot>(owner,"/v1/ops/source-connectors");
const passing=snapshot.testRuns.find((item)=>item.connectorId===current?.connectorId&&item.definitionHash===current?.definitionHash&&item.status==="passed");
assert(passing,"exact-hash connector test evidence is missing");
assert(passing.result.externalCallCount===0&&passing.result.persistedDocuments===false&&passing.result.runtimeExecution==="disabled",
  "connector test safety evidence is incomplete");
const evidence=await databaseEvidence(pool,current.connectorId);
assert(evidence.versionCount>=7&&evidence.eventCount>=7,"append-only connector lifecycle evidence is incomplete");
assert(evidence.rawCredentialColumns===0,"registry contains a raw credential column");
const finalCounts=await operationalCounts(pool);
assert(finalCounts.subjects===baseline.subjects&&finalCounts.cases===baseline.cases&&finalCounts.documents===baseline.documents&&finalCounts.attempts===baseline.attempts,
  "connector governance persisted an operational record");
assert(finalCounts.externalSends===baseline.externalSends,"connector governance emitted an external send event");
assert(finalCounts.publicTables===finalCounts.rlsTables&&finalCounts.publicTables>=45,"RLS coverage is incomplete");
await pool.end();

console.log(JSON.stringify({verification:"passed",connectorKey,currentVersion:`${current.version}.${current.revision}`,
  currentDefinitionHash:current.definitionHash,lifecycle:current.lifecycleStatus,capabilities:current.definition.capabilities,
  credentialStorage:"reference_only",contractTest:{fixtures:passing.result.fixtureCount,externalCalls:0,persistedDocuments:0,runtimeExecution:"disabled"},
  existingPlanBinding:{connectorKey:baselineBinding.connectorKey,references:baselineBinding.referencedByPlanCount},
  operationalRecordsCreated:{subjects:0,cases:0,documents:0,attempts:0},externalMessagesSent:0,
  managerCatalog:"read_only",staffCatalog:"forbidden",rls:`${finalCounts.rlsTables}/${finalCounts.publicTables}`}));

function definition(): SourceConnectorDefinition { return {schemaVersion:"1.0",environment:"DEV",connectorKey,connectorType:"api",transport:"push",
  capabilities:["documents","metadata","webhook"],credentialReference:{mode:"secret_reference",provider:"railway",reference:"railway://secret/DOP_M20_SYNTHETIC_CONNECTOR"},
  dataBoundary:{syntheticOnly:true,externalDelivery:"disabled",maxFilesPerSubmission:20,maxFileBytes:26_214_400,allowedMimeTypes:["application/pdf","image/jpeg","image/png","text/plain"]},
  activationPolicy:{explicitApprovalRequired:true,emergencySuspendEnabled:true,runtimeExecution:"disabled"},
  testFixtures:[{fixtureKey:"m20.synthetic-api",displayName:"M20 纯虚构 API 资料",synthetic:true,filename:"synthetic-m20-api-document.pdf",mimeType:"application/pdf",
    payloadSummary:"Purely synthetic DEV connector contract fixture with no real person, business, credential, document or external delivery."}]}; }

async function databaseEvidence(pool:Pool,connectorId:string):Promise<{versionCount:number;eventCount:number;rawCredentialColumns:number}> {
  const client=await pool.connect(); try { await client.query("BEGIN"); await client.query("SELECT dop_set_organization_context($1)",["dev-accounting-firm"]);
    const result=await client.query<{version_count:number;event_count:number;raw_credential_columns:number}>(`
      SELECT (SELECT count(*)::int FROM source_connector_versions WHERE connector_id=$1) AS version_count,
             (SELECT count(*)::int FROM workflow_events WHERE aggregate_type='source_connector' AND aggregate_id=$1) AS event_count,
             (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public'
               AND table_name IN ('source_connectors','source_connector_versions','source_connector_test_runs')
               AND column_name IN ('token','secret','password','api_key','credential_value')) AS raw_credential_columns`,[connectorId]);
    await client.query("ROLLBACK"); const row=result.rows[0]; assert(row,"connector evidence query returned no row");
    return {versionCount:Number(row.version_count),eventCount:Number(row.event_count),rawCredentialColumns:Number(row.raw_credential_columns)};
  } catch(error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; } finally { client.release(); } }

async function operationalCounts(pool:Pool):Promise<{subjects:number;cases:number;documents:number;attempts:number;externalSends:number;publicTables:number;rlsTables:number}> {
  const client=await pool.connect(); try { await client.query("BEGIN"); await client.query("SELECT dop_set_organization_context($1)",["dev-accounting-firm"]);
    const result=await client.query<{subjects:number;cases:number;documents:number;attempts:number;external_sends:number;public_tables:number;rls_tables:number}>(`
      SELECT (SELECT count(*)::int FROM subjects) subjects,(SELECT count(*)::int FROM cases) cases,
        (SELECT count(*)::int FROM documents) documents,(SELECT count(*)::int FROM classification_attempts) attempts,
        (SELECT count(*)::int FROM workflow_events WHERE event_type ILIKE '%sent%') external_sends,
        (SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'pg_%') public_tables,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity) rls_tables`);
    await client.query("ROLLBACK"); const row=result.rows[0]; assert(row,"operational count query returned no row");
    return {subjects:Number(row.subjects),cases:Number(row.cases),documents:Number(row.documents),attempts:Number(row.attempts),externalSends:Number(row.external_sends),publicTables:Number(row.public_tables),rlsTables:Number(row.rls_tables)};
  } catch(error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; } finally { client.release(); } }

async function versionById(session:Session,id:string):Promise<OpsSourceConnectorVersion> { const current=await getJson<OpsSourceConnectorSnapshot>(session,"/v1/ops/source-connectors");
  const version=current.versions.find((item)=>item.id===id); assert(version,`source connector version ${id} is missing`); return version; }
function latest(items:OpsSourceConnectorVersion[]):OpsSourceConnectorVersion|undefined { return [...items].sort((a,b)=>b.version-a.version||b.revision-a.revision)[0]; }
async function login(email:string,password:string):Promise<Session> { const response=await fetch(`${opsUrl}/v1/ops/session`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
  assertStatus(response,200,`login for ${email}`); const cookie=response.headers.get("set-cookie")?.split(";",1)[0]; assert(cookie,"login did not return a session cookie");
  const overview=await fetch(`${opsUrl}/v1/ops/overview`,{headers:{cookie}}); assertStatus(overview,200,"overview after login"); const body=await overview.json() as JsonRecord;
  return {cookie,csrfToken:requiredString(body.csrfToken,"csrf token")}; }
async function getJson<T>(session:Session,path:string):Promise<T> { const response=await fetch(`${opsUrl}${path}`,{headers:{cookie:session.cookie}}); const result=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${JSON.stringify(result)}`); return result as T; }
async function postJson(session:Session,path:string,body:unknown):Promise<JsonRecord> { const response=await fetch(`${opsUrl}${path}`,{method:"POST",headers:mutationHeaders(session),body:JSON.stringify(body)});
  const result=await response.json().catch(()=>({})) as JsonRecord; if(!response.ok) throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(result)}`); return result; }
function mutationHeaders(session:Session):Record<string,string> { return {cookie:session.cookie,origin,"content-type":"application/json","x-dop-csrf":session.csrfToken}; }
function assertStatus(response:Response,expected:number,label:string):void { if(response.status!==expected) throw new Error(`${label} returned ${response.status}, expected ${expected}`); }
function required(value:string|undefined,name:string):string { if(!value) throw new Error(`${name} is required`); return value; }
function requiredString(value:unknown,name:string):string { if(typeof value!=="string"||!value) throw new Error(`${name} is missing`); return value; }
function assert(condition:unknown,message:string):asserts condition { if(!condition) throw new Error(message); }
