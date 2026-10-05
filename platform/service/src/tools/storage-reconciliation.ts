import { createHash } from "node:crypto";

export interface StorageReconciliationResult {
  databaseReferenceCount: number;
  storageObjectCount: number;
  orphanObjectCount: number;
  missingObjectCount: number;
  orphanReferenceDigest: string;
  missingReferenceDigest: string;
}

export function reconcileStorageReferences(
  databaseReferences: Iterable<string>,
  storageReferences: Iterable<string>,
): StorageReconciliationResult {
  const database = new Set(databaseReferences);
  const storage = new Set(storageReferences);
  const orphans = [...storage].filter((reference) => !database.has(reference)).sort();
  const missing = [...database].filter((reference) => !storage.has(reference)).sort();
  return {
    databaseReferenceCount: database.size,
    storageObjectCount: storage.size,
    orphanObjectCount: orphans.length,
    missingObjectCount: missing.length,
    orphanReferenceDigest: referenceDigest(orphans),
    missingReferenceDigest: referenceDigest(missing),
  };
}

export function referenceDigest(references: Iterable<string>): string {
  return createHash("sha256").update([...references].sort().join("\n"), "utf8").digest("hex");
}
