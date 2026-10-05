import type { Pool } from "pg";
import type {
  RetentionLifecycleRepository, RetentionObjectClaim,
} from "../../ports/retention-lifecycle-repository.js";

export class PostgresRetentionLifecycleRepository implements RetentionLifecycleRepository {
  constructor(private readonly pool: Pool) {}

  async checkReady(organizationKey:string):Promise<boolean> {
    const result=await this.pool.query<{id:string|null}>("SELECT dop_set_organization_context($1) AS id",[organizationKey]);
    return Boolean(result.rows[0]?.id);
  }

  async claim(organizationKey:string,workerId:string,leaseSeconds:number,now:Date) {
    const result=await this.pool.query<{result:unknown}>(
      "SELECT dop_claim_retention_object($1,$2,$3,$4) AS result",[organizationKey,workerId,leaseSeconds,now],
    );
    return normalizeClaim(result.rows[0]?.result);
  }

  async complete(candidateId:string,leaseToken:string,outcome:"deleted"|"not_found"|"failed",errorCode:string|null,now:Date) {
    const result=await this.pool.query<{result:unknown}>(
      "SELECT dop_complete_retention_object($1,$2,$3,$4,$5) AS result",
      [candidateId,leaseToken,outcome,errorCode,now],
    );
    const value=result.rows[0]?.result as Record<string,unknown>|undefined;
    if (!value || !["completed","duplicate"].includes(String(value.outcome))) {
      throw Object.assign(new Error("retention_complete_rejected"),{code:"retention_complete_rejected"});
    }
  }

  async finalize(organizationKey:string,now:Date):Promise<number> {
    const result=await this.pool.query<{result:unknown}>(
      "SELECT dop_finalize_retention_runs($1,$2) AS result",[organizationKey,now],
    );
    const value=result.rows[0]?.result as Record<string,unknown>|undefined;
    if (!value || value.outcome!=="completed" || !Number.isInteger(value.finalizedCases)) {
      throw Object.assign(new Error("retention_finalize_rejected"),{code:"retention_finalize_rejected"});
    }
    return value.finalizedCases as number;
  }
}

function normalizeClaim(value:unknown):RetentionObjectClaim|{outcome:"empty"} {
  if (!value || typeof value!=="object") throw new Error("invalid_retention_claim");
  const row=value as Record<string,unknown>;
  if (row.outcome==="empty") return {outcome:"empty"};
  if (row.outcome!=="claimed" || !["candidateId","retentionRunId","caseId","storageReference",
    "storageReferenceHash","leaseToken"].every((key)=>typeof row[key]==="string")
    || !Number.isInteger(row.attemptCount)) throw new Error("invalid_retention_claim");
  return row as RetentionObjectClaim;
}
