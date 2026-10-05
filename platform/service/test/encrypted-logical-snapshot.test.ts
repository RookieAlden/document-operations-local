import { describe,expect,it } from "vitest";
import { canonicalSnapshot,decryptLogicalSnapshot,encryptLogicalSnapshot,snapshotDigest } from "../src/tools/encrypted-logical-snapshot.js";

describe("encrypted logical snapshot",()=>{
  it("canonicalizes, encrypts and restores without plaintext in the archive",()=>{
    const plaintext=canonicalSnapshot({z:[2,1],a:{name:"Synthetic Client",id:"case-1"}});
    const {encrypted,key}=encryptLogicalSnapshot(plaintext,Buffer.alloc(32,7));
    expect(encrypted.includes(Buffer.from("Synthetic Client"))).toBe(false);
    const restored=decryptLogicalSnapshot(encrypted,key);
    expect(restored).toEqual(plaintext);expect(snapshotDigest(restored)).toBe(snapshotDigest(plaintext));
  });
  it("rejects tampered archives",()=>{
    const {encrypted,key}=encryptLogicalSnapshot(Buffer.from("synthetic"),Buffer.alloc(32,3));
    encrypted[encrypted.length-1]=(encrypted[encrypted.length-1]??0)^1;
    expect(()=>decryptLogicalSnapshot(encrypted,key)).toThrow();
  });
});
