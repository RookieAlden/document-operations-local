import { randomUUID } from "node:crypto";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { canonicalSnapshot,encryptLogicalSnapshot,snapshotDigest } from "./encrypted-logical-snapshot.js";
import { restoreEncryptedBundleToIsolatedPostgres,type IsolatedRestoreBundle } from "./isolated-logical-restore.js";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";

const databaseUrl=required(process.env.DOP_MIGRATION_DATABASE_URL,"DOP_MIGRATION_DATABASE_URL");
const organizationKey=process.env.DOP_ORGANIZATION_KEY??"uat-accounting-firm";
const actorId=required(process.env.DOP_M43_ACTOR_ID,"DOP_M43_ACTOR_ID");
const caseId=required(process.env.DOP_M43_CASE_ID,"DOP_M43_CASE_ID");
const pool=new Pool(postgresPoolConfig(databaseUrl,process.env.DATABASE_SSL_CA_PATH,1));
const started=Date.now();let backupDirectory:string|null=null;
try {
  const client=await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const org=await client.query<{id:string|null}>("SELECT dop_set_organization_context($1) AS id",[organizationKey]);
    if(!org.rows[0]?.id)throw new Error("organization_not_found");
    const snapshot=await client.query<{bundle:IsolatedRestoreBundle}>(`SELECT jsonb_build_object(
      'content',jsonb_build_object(
        'organization',(SELECT jsonb_build_object('id',o.id,'organization_key',o.organization_key) FROM organizations o WHERE o.id=dop_current_organization_id()),
        'case',(SELECT to_jsonb(c)-'config_snapshot' FROM cases c WHERE c.organization_id=dop_current_organization_id() AND c.id=$1),
        'submissions',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') FROM submissions s WHERE s.organization_id=dop_current_organization_id() AND s.case_id=$1),
        'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]') FROM documents d WHERE d.organization_id=dop_current_organization_id() AND d.case_id=$1),
        'classificationAttempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM classification_attempts a WHERE a.organization_id=dop_current_organization_id() AND a.document_id IN (SELECT id FROM documents WHERE organization_id=dop_current_organization_id() AND case_id=$1)),
        'issues',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]') FROM issues i WHERE i.organization_id=dop_current_organization_id() AND i.case_id=$1),
        'tasks',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM tasks t WHERE t.organization_id=dop_current_organization_id() AND t.case_id=$1),
        'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') FROM workflow_events e WHERE e.organization_id=dop_current_organization_id() AND ((e.aggregate_type='case' AND e.aggregate_id=$1) OR (e.aggregate_type='document' AND e.aggregate_id IN (SELECT id FROM documents WHERE organization_id=dop_current_organization_id() AND case_id=$1))))
      ),
      'migrationLedger',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.version),'[]') FROM dop_schema_migration_ledger l)
    ) AS bundle`,[caseId]);
    await client.query("COMMIT");
    const bundle=snapshot.rows[0]?.bundle;
    if(!bundle?.content.case)throw new Error("case_not_found");
    const plaintext=canonicalSnapshot(bundle);const backupDigest=snapshotDigest(plaintext);
    const encrypted=encryptLogicalSnapshot(plaintext);
    backupDirectory=await mkdtemp(join(tmpdir(),"dop-m43-backup-"));
    const archivePath=join(backupDirectory,"snapshot.dopm43");
    await writeFile(archivePath,encrypted.encrypted,{mode:0o600});
    const evidence=await restoreEncryptedBundleToIsolatedPostgres(await readFile(archivePath),encrypted.key);
    encrypted.key.fill(0);plaintext.fill(0);
    await rm(backupDirectory,{recursive:true,force:true});backupDirectory=null;
    const actualRtoSeconds=Math.max(0,Math.ceil((Date.now()-started)/1000));
    const status=backupDigest===evidence.restoredDigest&&evidence.schemaVerified&&evidence.relationshipsVerified
      &&evidence.migrationLedgerVerified&&evidence.rlsVerified&&evidence.restoreTargetDestroyed?"passed":"failed";
    await client.query("BEGIN");await client.query("SELECT dop_set_organization_context($1)",[organizationKey]);
    const record=await client.query<{result:Record<string,unknown>}>(
      "SELECT dop_record_retention_restore_drill_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) AS result",
      [actorId,caseId,status,backupDigest,evidence.restoredDigest,actualRtoSeconds,evidence.restoredRowCount,
        evidence.sourceMigrationVersion,evidence.restoredTableCount,evidence.restoredRelationshipCount,
        evidence.restoredRlsPolicyCount,evidence.schemaVerified,evidence.relationshipsVerified,
        evidence.migrationLedgerVerified,evidence.rlsVerified,evidence.restoreTargetDestroyed,
        "Encrypted logical backup restored into an independent ephemeral PostgreSQL target; schema, relations, migration ledger, RLS, row counts and digest verified before destroying the target.",
        randomUUID(),randomUUID(),new Date()],
    );
    await client.query("COMMIT");
    if(record.rows[0]?.result.outcome!=="completed")throw new Error(`restore_drill_record_failed:${String(record.rows[0]?.result.reason??"unknown")}`);
    process.stdout.write(`${JSON.stringify({outcome:status,caseId,backupDigest,...evidence,actualRtoSeconds,
      restoreTarget:"isolated_pglite_postgresql",plaintextWrittenToDisk:false,temporaryArtifactsRemoved:true})}\n`);
  } catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;} finally{client.release();}
} finally {if(backupDirectory)await rm(backupDirectory,{recursive:true,force:true}).catch(()=>undefined);await pool.end();}

function required(value:string|undefined,name:string):string {if(!value)throw new Error(`${name} is required`);return value;}
