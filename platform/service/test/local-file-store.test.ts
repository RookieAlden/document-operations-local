import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { LocalFileStore, contentHash, localKey } from "../src/local/file-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {recursive:true,force:true}))); });
async function setup() { const root=await mkdtemp(join(tmpdir(),"dop-store-"));directories.push(root);
  // macOS /var is a symlink; the runtime uses canonical paths too.
  const {realpath}=await import("node:fs/promises");return new LocalFileStore(await realpath(root)); }
function input() { const content=Buffer.from("%PDF-1.7\nFictional local test\n%%EOF"); return {
  organizationKey:"dev-accounting-firm",documentId:randomUUID(),filename:"测试.pdf",mimeType:"application/pdf" as const,
  content,sha256:contentHash(content)}; }
describe("persistent local original store", () => {
  it("persists real bytes, rejects corruption, and makes concurrent retries idempotent", async () => {
    const store=await setup(), request=input();
    const results=await Promise.all([store.store(request),store.store(request)]);
    expect(results[0]).toEqual(results[1]);
    expect(await store.read(results[0]!.storageReference)).toEqual(request.content);
    const files=await readdir(directories[0]!);expect(files).toHaveLength(1);
    expect(await readFile(join(directories[0]!,files[0]!))).toEqual(request.content);
    await writeFile(join(directories[0]!,files[0]!),"changed bytes");
    await expect(store.read(results[0]!.storageReference)).rejects.toThrow("integrity");
    await expect(store.store(request)).rejects.toThrow("integrity");
  });
  it("rejects traversal and invalid byte/hash pairs before writing", async () => {
    const store=await setup(), request=input();
    for(const ref of ["local://../file.pdf","supabase://bucket/file","local://%2e%2e/test"])
      expect(()=>localKey(ref)).toThrow();
    await expect(store.store({...request,sha256:"0".repeat(64)})).rejects.toThrow();
    expect(await readdir(directories[0]!)).toEqual([]);
  });
  it("never follows an object symlink", async () => {
    const store=await setup(), request=input();
    const key=`${request.documentId}-${request.sha256}.pdf`;
    await symlink("/etc/hosts",join(directories[0]!,key));
    await expect(store.read(`local://${key}`)).rejects.toThrow();
    await expect(store.store(request)).rejects.toThrow();
  });
});
