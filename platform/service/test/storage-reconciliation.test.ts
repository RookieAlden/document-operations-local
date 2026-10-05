import { describe,expect,it } from "vitest";
import { reconcileStorageReferences,referenceDigest } from "../src/tools/storage-reconciliation.js";

describe("storage reconciliation",()=>{
  it("counts orphan and missing objects without retaining path details",()=>{
    const result=reconcileStorageReferences(["ref/a","ref/b"],["ref/b","ref/c"]);
    expect(result).toEqual({databaseReferenceCount:2,storageObjectCount:2,orphanObjectCount:1,
      missingObjectCount:1,orphanReferenceDigest:referenceDigest(["ref/c"]),missingReferenceDigest:referenceDigest(["ref/a"])});
    expect(Object.values(result)).not.toContain("ref/a");expect(Object.values(result)).not.toContain("ref/c");
  });
  it("deduplicates and canonicalizes reference order",()=>{
    expect(reconcileStorageReferences(["b","a","a"],["a","b"])).toMatchObject({
      databaseReferenceCount:2,storageObjectCount:2,orphanObjectCount:0,missingObjectCount:0,
      orphanReferenceDigest:referenceDigest([]),missingReferenceDigest:referenceDigest([]),
    });
  });
});
