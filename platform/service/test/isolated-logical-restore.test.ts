import { describe,expect,it } from "vitest";
import { encryptLogicalSnapshot,canonicalSnapshot,snapshotDigest } from "../src/tools/encrypted-logical-snapshot.js";
import { restoreEncryptedBundleToIsolatedPostgres,type IsolatedRestoreBundle } from "../src/tools/isolated-logical-restore.js";

describe("isolated logical restore",()=>{
  it("restores an encrypted bundle into an independent PostgreSQL target and destroys it",async()=>{
    const org="00000000-0000-4000-8000-000000000001";const caseId="00000000-0000-4000-8000-000000000002";
    const documentId="00000000-0000-4000-8000-000000000003";
    const bundle:IsolatedRestoreBundle={content:{organization:{id:org,organization_key:"synthetic-uat"},
      case:{id:caseId,organization_id:org,case_key:"CASE-SYNTHETIC"},
      submissions:[{id:"00000000-0000-4000-8000-000000000004",organization_id:org,case_id:caseId}],
      documents:[{id:documentId,organization_id:org,case_id:caseId,original_filename:"synthetic.pdf"}],
      classificationAttempts:[{id:"00000000-0000-4000-8000-000000000005",organization_id:org,document_id:documentId}],
      issues:[{id:"00000000-0000-4000-8000-000000000006",organization_id:org,case_id:caseId}],
      tasks:[{id:"00000000-0000-4000-8000-000000000007",organization_id:org,case_id:caseId}],
      events:[{id:"00000000-0000-4000-8000-000000000008",organization_id:org,event_type:"Synthetic"}]},
      migrationLedger:[{version:"043",filename:"043_synthetic.sql",sha256:"a".repeat(64),execution_mode:"applied",git_commit:"b".repeat(40)}]};
    const plaintext=canonicalSnapshot(bundle);const backupDigest=snapshotDigest(plaintext);
    const encrypted=encryptLogicalSnapshot(plaintext,Buffer.alloc(32,9));
    const evidence=await restoreEncryptedBundleToIsolatedPostgres(encrypted.encrypted,encrypted.key);
    expect(evidence).toMatchObject({restoredDigest:backupDigest,sourceMigrationVersion:"043",restoredTableCount:9,
      schemaVerified:true,relationshipsVerified:true,migrationLedgerVerified:true,rlsVerified:true,
      restoreTargetDestroyed:true});
    expect(evidence.restoredRelationshipCount).toBeGreaterThanOrEqual(6);
    expect(evidence.restoredRlsPolicyCount).toBeGreaterThanOrEqual(7);
  },30_000);
});
