import { PGlite } from "@electric-sql/pglite";
import { canonicalSnapshot,decryptLogicalSnapshot,snapshotDigest } from "./encrypted-logical-snapshot.js";

export interface IsolatedRestoreBundle {
  content: {
    organization: Record<string,unknown>;
    case: Record<string,unknown>;
    submissions: Record<string,unknown>[];
    documents: Record<string,unknown>[];
    classificationAttempts: Record<string,unknown>[];
    issues: Record<string,unknown>[];
    tasks: Record<string,unknown>[];
    events: Record<string,unknown>[];
  };
  migrationLedger: Record<string,unknown>[];
}

export interface IsolatedRestoreEvidence {
  restoredDigest:string; restoredRowCount:number; sourceMigrationVersion:string;
  restoredTableCount:number; restoredRelationshipCount:number; restoredRlsPolicyCount:number;
  schemaVerified:boolean; relationshipsVerified:boolean; migrationLedgerVerified:boolean;
  rlsVerified:boolean; restoreTargetDestroyed:boolean;
}

const TABLES=["restore_organizations","restore_cases","restore_submissions","restore_documents",
  "restore_classification_attempts","restore_issues","restore_tasks","restore_workflow_events",
  "restore_migration_ledger"] as const;
const RLS_TABLES=TABLES.slice(0,8);

export async function restoreEncryptedBundleToIsolatedPostgres(
  encrypted:Buffer,key:Buffer,
):Promise<IsolatedRestoreEvidence> {
  const restored=decryptLogicalSnapshot(encrypted,key);
  const bundle=JSON.parse(restored.toString("utf8")) as IsolatedRestoreBundle;
  restored.fill(0);
  validateBundle(bundle);
  const db=await PGlite.create();
  let evidence:Omit<IsolatedRestoreEvidence,"restoreTargetDestroyed">;
  try {
    await db.exec(schemaSql());
    await insertBundle(db,bundle);
    evidence=await verifyRestore(db,bundle);
  } finally {
    await db.close();
  }
  return {...evidence,restoreTargetDestroyed:true};
}

async function insertBundle(db:PGlite,bundle:IsolatedRestoreBundle):Promise<void>{
  const org=bundle.content.organization;const caseRow=bundle.content.case;
  await db.query("INSERT INTO restore_organizations(id,organization_key,payload) VALUES ($1,$2,$3::jsonb)",
    [requiredString(org.id,"organization.id"),requiredString(org.organization_key,"organization.organization_key"),JSON.stringify(org)]);
  await insertPayload(db,"restore_cases",caseRow,["id","organization_id"]);
  for(const row of bundle.content.submissions)await insertPayload(db,"restore_submissions",row,["id","organization_id","case_id"]);
  for(const row of bundle.content.documents)await insertPayload(db,"restore_documents",row,["id","organization_id","case_id"]);
  for(const row of bundle.content.classificationAttempts)await insertPayload(db,"restore_classification_attempts",row,["id","organization_id","document_id"]);
  for(const row of bundle.content.issues)await insertPayload(db,"restore_issues",row,["id","organization_id","case_id"]);
  for(const row of bundle.content.tasks)await insertPayload(db,"restore_tasks",row,["id","organization_id","case_id"]);
  for(const row of bundle.content.events)await insertPayload(db,"restore_workflow_events",row,["id","organization_id"]);
  for(const row of bundle.migrationLedger){
    await db.query(`INSERT INTO restore_migration_ledger(version,filename,sha256,execution_mode,git_commit,payload)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,[requiredString(row.version,"ledger.version"),
      requiredString(row.filename,"ledger.filename"),requiredString(row.sha256,"ledger.sha256"),
      requiredString(row.execution_mode,"ledger.execution_mode"),requiredString(row.git_commit,"ledger.git_commit"),JSON.stringify(row)]);
  }
}

async function insertPayload(db:PGlite,table:string,row:Record<string,unknown>,keys:string[]):Promise<void>{
  const columns=[...keys,"payload"];const values=[...keys.map((key)=>requiredString(row[key],`${table}.${key}`)),JSON.stringify(row)];
  const placeholders=columns.map((_,index)=>`$${index+1}${index===columns.length-1?"::jsonb":""}`).join(",");
  await db.query(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${placeholders})`,values);
}

async function verifyRestore(db:PGlite,bundle:IsolatedRestoreBundle):Promise<Omit<IsolatedRestoreEvidence,"restoreTargetDestroyed">>{
  const tableResult=await db.query<{table_name:string}>(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name LIKE 'restore_%' ORDER BY table_name`);
  const restoredTableCount=tableResult.rows.length;
  const schemaVerified=TABLES.every((table)=>tableResult.rows.some((row)=>row.table_name===table));
  const relationshipResult=await db.query<{count:number}>(`SELECT count(*)::int AS count FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid WHERE c.contype='f' AND t.relname LIKE 'restore_%'`);
  const restoredRelationshipCount=relationshipResult.rows[0]?.count??0;
  const orphanResult=await db.query<{count:number}>(`SELECT (
    (SELECT count(*) FROM restore_cases c LEFT JOIN restore_organizations o ON o.id=c.organization_id WHERE o.id IS NULL)+
    (SELECT count(*) FROM restore_submissions s LEFT JOIN restore_cases c ON c.id=s.case_id WHERE c.id IS NULL)+
    (SELECT count(*) FROM restore_documents d LEFT JOIN restore_cases c ON c.id=d.case_id WHERE c.id IS NULL)+
    (SELECT count(*) FROM restore_classification_attempts a LEFT JOIN restore_documents d ON d.id=a.document_id WHERE d.id IS NULL)+
    (SELECT count(*) FROM restore_issues i LEFT JOIN restore_cases c ON c.id=i.case_id WHERE c.id IS NULL)+
    (SELECT count(*) FROM restore_tasks t LEFT JOIN restore_cases c ON c.id=t.case_id WHERE c.id IS NULL)
  )::int AS count`);
  const expectedCounts:Record<string,number>={restore_organizations:1,restore_cases:1,
    restore_submissions:bundle.content.submissions.length,restore_documents:bundle.content.documents.length,
    restore_classification_attempts:bundle.content.classificationAttempts.length,restore_issues:bundle.content.issues.length,
    restore_tasks:bundle.content.tasks.length,restore_workflow_events:bundle.content.events.length,
    restore_migration_ledger:bundle.migrationLedger.length};
  let rowCountsMatch=true;for(const [table,expected] of Object.entries(expectedCounts)){
    const count=await db.query<{count:number}>(`SELECT count(*)::int AS count FROM ${table}`);
    if(count.rows[0]?.count!==expected)rowCountsMatch=false;
  }
  const relationshipsVerified=restoredRelationshipCount>=6&&(orphanResult.rows[0]?.count??-1)===0&&rowCountsMatch;
  const sourceMigrationVersion=requiredString(bundle.migrationLedger.at(-1)?.version,"latest migration version");
  const ledgerResult=await db.query<{version:string;count:number}>(`SELECT max(version) AS version,count(*)::int AS count FROM restore_migration_ledger`);
  const migrationLedgerVerified=ledgerResult.rows[0]?.version===sourceMigrationVersion
    &&ledgerResult.rows[0]?.count===bundle.migrationLedger.length;
  const rlsMeta=await db.query<{rls_count:number;policy_count:number}>(`SELECT
    (SELECT count(*)::int FROM pg_class WHERE relname=ANY($1::text[]) AND relrowsecurity) AS rls_count,
    (SELECT count(*)::int FROM pg_policies WHERE tablename=ANY($1::text[])) AS policy_count`,[RLS_TABLES]);
  await db.exec("SET ROLE dop_restore_reader");
  await db.query("SELECT set_config('dop.restore_org_id',$1,false)",[requiredString(bundle.content.organization.id,"organization.id")]);
  const visible=await db.query<{count:number}>("SELECT count(*)::int AS count FROM restore_cases");
  await db.query("SELECT set_config('dop.restore_org_id',$1,false)",["00000000-0000-4000-8000-000000000000"]);
  const hidden=await db.query<{count:number}>("SELECT count(*)::int AS count FROM restore_cases");
  await db.exec("RESET ROLE");
  const restoredRlsPolicyCount=rlsMeta.rows[0]?.policy_count??0;
  const rlsVerified=(rlsMeta.rows[0]?.rls_count??0)>=7&&restoredRlsPolicyCount>=7
    &&visible.rows[0]?.count===1&&hidden.rows[0]?.count===0;
  const restoredBundle: IsolatedRestoreBundle={content:{
    organization:(await payloads(db,"restore_organizations"))[0]!,case:(await payloads(db,"restore_cases"))[0]!,
    submissions:await payloads(db,"restore_submissions"),documents:await payloads(db,"restore_documents"),
    classificationAttempts:await payloads(db,"restore_classification_attempts"),issues:await payloads(db,"restore_issues"),
    tasks:await payloads(db,"restore_tasks"),events:await payloads(db,"restore_workflow_events")},
    migrationLedger:await payloads(db,"restore_migration_ledger")};
  const restoredDigest=snapshotDigest(canonicalSnapshot(restoredBundle));
  const restoredRowCount=Object.values(expectedCounts).reduce((sum,count)=>sum+count,0)-bundle.migrationLedger.length;
  return {restoredDigest,restoredRowCount,sourceMigrationVersion,restoredTableCount,restoredRelationshipCount,
    restoredRlsPolicyCount,schemaVerified,relationshipsVerified,migrationLedgerVerified,rlsVerified};
}

async function payloads(db:PGlite,table:string):Promise<Record<string,unknown>[]>{
  const order=table==="restore_migration_ledger"?"version":"id";
  const result=await db.query<{payload:Record<string,unknown>}>(`SELECT payload FROM ${table} ORDER BY ${order}`);
  return result.rows.map((row)=>row.payload);
}

function validateBundle(bundle:IsolatedRestoreBundle):void{
  if(!bundle||typeof bundle!=="object"||!bundle.content||!Array.isArray(bundle.migrationLedger)||bundle.migrationLedger.length<1)
    throw new Error("invalid isolated restore bundle");
  for(const key of ["submissions","documents","classificationAttempts","issues","tasks","events"] as const)
    if(!Array.isArray(bundle.content[key]))throw new Error(`invalid bundle ${key}`);
}
function requiredString(value:unknown,label:string):string{
  if(typeof value!=="string"||!value)throw new Error(`${label} is required`);return value;
}

function schemaSql():string{return `
CREATE ROLE dop_restore_reader NOLOGIN NOSUPERUSER;
CREATE TABLE restore_organizations(id uuid PRIMARY KEY,organization_key text NOT NULL UNIQUE,payload jsonb NOT NULL);
CREATE TABLE restore_cases(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES restore_organizations(id),payload jsonb NOT NULL);
CREATE TABLE restore_submissions(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES restore_organizations(id),case_id uuid NOT NULL REFERENCES restore_cases(id),payload jsonb NOT NULL);
CREATE TABLE restore_documents(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES restore_organizations(id),case_id uuid NOT NULL REFERENCES restore_cases(id),payload jsonb NOT NULL);
CREATE TABLE restore_classification_attempts(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES restore_organizations(id),document_id uuid NOT NULL REFERENCES restore_documents(id),payload jsonb NOT NULL);
CREATE TABLE restore_issues(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES restore_organizations(id),case_id uuid NOT NULL REFERENCES restore_cases(id),payload jsonb NOT NULL);
CREATE TABLE restore_tasks(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES restore_organizations(id),case_id uuid NOT NULL REFERENCES restore_cases(id),payload jsonb NOT NULL);
CREATE TABLE restore_workflow_events(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES restore_organizations(id),payload jsonb NOT NULL);
CREATE TABLE restore_migration_ledger(version text PRIMARY KEY CHECK(version~'^[0-9]{3}$'),filename text NOT NULL UNIQUE,sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),execution_mode text NOT NULL,git_commit text NOT NULL CHECK(git_commit~'^[0-9a-f]{40}$'),payload jsonb NOT NULL);
${RLS_TABLES.map((table)=>{const column=table==="restore_organizations"?"id":"organization_id";return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON ${table} FOR SELECT TO dop_restore_reader USING (${column}::text=current_setting('dop.restore_org_id',true)); GRANT SELECT ON ${table} TO dop_restore_reader;`;}).join("\n")}
`;}
