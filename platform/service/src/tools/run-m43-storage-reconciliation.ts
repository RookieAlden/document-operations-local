import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";
import { reconcileStorageReferences } from "./storage-reconciliation.js";

const databaseUrl=required(process.env.DOP_MIGRATION_DATABASE_URL,"DOP_MIGRATION_DATABASE_URL");
const organizationKey=process.env.DOP_ORGANIZATION_KEY??"uat-accounting-firm";
const actorId=required(process.env.DOP_M43_ACTOR_ID,"DOP_M43_ACTOR_ID");
const bucket=required(process.env.SUPABASE_STORAGE_BUCKET,"SUPABASE_STORAGE_BUCKET");
const pool=new Pool(postgresPoolConfig(databaseUrl,process.env.DATABASE_SSL_CA_PATH,1));
try {
  const client=await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const org=await client.query<{id:string|null}>("SELECT dop_set_organization_context($1) AS id",[organizationKey]);
    if(!org.rows[0]?.id)throw new Error("organization_not_found");
    const dbRows=await client.query<{storage_reference:string}>(`SELECT storage_reference FROM (
      SELECT incoming_storage_ref AS storage_reference FROM documents
       WHERE organization_id=dop_current_organization_id() AND incoming_storage_ref IS NOT NULL
      UNION
      SELECT archive_storage_ref AS storage_reference FROM documents
       WHERE organization_id=dop_current_organization_id() AND archive_storage_ref IS NOT NULL
    ) references_for_organization ORDER BY storage_reference`);
    const storageRows=await client.query<{name:string}>(`SELECT name FROM storage.objects
      WHERE bucket_id=$1 AND name LIKE $2 ESCAPE '\\' ORDER BY name`,[bucket,`${escapeLike(organizationKey)}/%`]);
    await client.query("COMMIT");
    const prefix=`supabase://${bucket}/`;
    const reconciliation=reconcileStorageReferences(
      dbRows.rows.map((row)=>row.storage_reference),storageRows.rows.map((row)=>`${prefix}${row.name}`),
    );
    await client.query("BEGIN");await client.query("SELECT dop_set_organization_context($1)",[organizationKey]);
    const record=await client.query<{result:Record<string,unknown>}>(
      "SELECT dop_record_storage_reconciliation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result",
      [actorId,reconciliation.databaseReferenceCount,reconciliation.storageObjectCount,
        reconciliation.orphanObjectCount,reconciliation.missingObjectCount,reconciliation.orphanReferenceDigest,
        reconciliation.missingReferenceDigest,"Compare synthetic UAT database references with Storage without deleting objects.",
        randomUUID(),randomUUID(),new Date()],
    );
    await client.query("COMMIT");
    if(record.rows[0]?.result.outcome!=="completed")throw new Error(`storage_reconciliation_record_failed:${String(record.rows[0]?.result.reason??"unknown")}`);
    process.stdout.write(`${JSON.stringify({outcome:"completed",status:record.rows[0].result.status,...reconciliation,pathsPersisted:false})}\n`);
  } catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;} finally{client.release();}
} finally {await pool.end();}

function required(value:string|undefined,name:string):string {if(!value)throw new Error(`${name} is required`);return value;}
function escapeLike(value:string):string{return value.replace(/[\\%_]/g,(character)=>`\\${character}`);}
