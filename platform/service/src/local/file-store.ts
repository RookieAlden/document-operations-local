import { constants } from "node:fs";
import { link, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { OpsDocumentUploadBroker } from "../ports/ops-trial-repository.js";

const keyPattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{64})\.(pdf|png|jpg)$/;
export function localKey(reference: string): { key: string; documentId: string; hash: string } {
  if (!reference.startsWith("local://")) throw new Error("invalid_local_reference");
  const key = reference.slice(8), match = keyPattern.exec(key);
  if (!match) throw new Error("invalid_local_reference");
  return { key, documentId: match[1]!, hash: match[2]! };
}
export const contentHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Private, immutable files. Database records only reference fully persisted objects. */
export class LocalFileStore implements OpsDocumentUploadBroker {
  constructor(private readonly root: string) {}
  private async directory(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const actual = await realpath(this.root);
    if (actual !== resolve(this.root)) throw new Error("local_store_symlink_not_allowed");
    return actual;
  }
  async store(request: Parameters<OpsDocumentUploadBroker["store"]>[0]): Promise<{ storageReference: string }> {
    const extension = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" }[request.mimeType];
    if (!extension || request.content.length < 1 || request.content.length > 20 * 1024 * 1024
        || contentHash(request.content) !== request.sha256) throw new Error("invalid_local_object");
    const reference = `local://${request.documentId}-${request.sha256}.${extension}`;
    const { key } = localKey(reference), directory = await this.directory();
    const temporary = join(directory, `.pending-${randomUUID()}`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(request.content); await handle.sync(); }
      finally { await handle.close(); }
      // Hard-link publication is atomic and never replaces an existing original.
      await link(temporary, join(directory, key)).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        await this.read(reference);
      });
      const dirHandle = await open(directory, constants.O_RDONLY);
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    return { storageReference: reference };
  }
  async read(reference: string): Promise<Buffer> {
    const { key, hash } = localKey(reference);
    const handle = await open(join(await this.directory(), key), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error("invalid_local_object");
      const bytes = await handle.readFile();
      if (contentHash(bytes) !== hash) throw new Error("local_original_integrity_failed");
      return bytes;
    } finally { await handle.close(); }
  }
}
