import { createCipheriv,createDecipheriv,createHash,randomBytes } from "node:crypto";

const MAGIC=Buffer.from("DOPM43\0","ascii");

export function canonicalSnapshot(value:unknown):Buffer {
  return Buffer.from(JSON.stringify(sortValue(value)),"utf8");
}
export function snapshotDigest(snapshot:Buffer):string { return createHash("sha256").update(snapshot).digest("hex"); }
export function encryptLogicalSnapshot(plaintext:Buffer,key:Buffer=randomBytes(32)):{encrypted:Buffer;key:Buffer} {
  if(key.length!==32)throw new Error("snapshot key must contain 32 bytes");
  const nonce=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,nonce);
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);const tag=cipher.getAuthTag();
  return {encrypted:Buffer.concat([MAGIC,nonce,tag,ciphertext]),key};
}
export function decryptLogicalSnapshot(encrypted:Buffer,key:Buffer):Buffer {
  if(key.length!==32||encrypted.length<MAGIC.length+28||!encrypted.subarray(0,MAGIC.length).equals(MAGIC))
    throw new Error("invalid encrypted logical snapshot");
  const nonce=encrypted.subarray(MAGIC.length,MAGIC.length+12);
  const tag=encrypted.subarray(MAGIC.length+12,MAGIC.length+28);
  const decipher=createDecipheriv("aes-256-gcm",key,nonce);decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted.subarray(MAGIC.length+28)),decipher.final()]);
}
function sortValue(value:unknown):unknown {
  if(Array.isArray(value))return value.map(sortValue);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>)
    .sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sortValue(item)]));
  return value;
}
