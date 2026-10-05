import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDocumentSourceResolver } from "../src/adapters/storage/local-document-source-resolver.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dop-local-source-"));
  roots.push(root);
  mkdirSync(join(root, "incoming"));
  return root;
}

function request(storageReference: string, declaredMimeType: string, filename = "document.pdf") {
  return { documentId: "doc-1", storageReference, filename, declaredMimeType };
}

describe("LocalDocumentSourceResolver", () => {
  it("returns PDF bytes as a file_data source", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "incoming", "statement.pdf"), Buffer.from("%PDF-test"));
    const source = await new LocalDocumentSourceResolver(root).resolve(
      request("local://incoming/statement.pdf", "application/pdf", "statement.pdf"),
    );
    expect(source).toEqual({
      kind: "file_data",
      filename: "statement.pdf",
      mimeType: "application/pdf",
      base64: Buffer.from("%PDF-test").toString("base64"),
    });
  });

  it("returns images as high-detail data URLs", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "incoming", "receipt.png"), Buffer.from([1, 2, 3]));
    await expect(new LocalDocumentSourceResolver(root).resolve(
      request("local://incoming/receipt.png", "image/png", "receipt.png"),
    )).resolves.toEqual({ kind: "image_url", imageUrl: "data:image/png;base64,AQID", detail: "high" });
  });

  it("returns CSV as untrusted text input", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "incoming", "summary.csv"), "date,total\n2026-07,42\n");
    await expect(new LocalDocumentSourceResolver(root).resolve(
      request("local://incoming/summary.csv", "text/csv", "summary.csv"),
    )).resolves.toEqual({ kind: "text", text: "date,total\n2026-07,42\n" });
  });

  it("rejects traversal through a symlink", async () => {
    const root = fixtureRoot();
    const outside = mkdtempSync(join(tmpdir(), "dop-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.pdf"), "secret");
    symlinkSync(join(outside, "secret.pdf"), join(root, "incoming", "linked.pdf"));
    await expect(new LocalDocumentSourceResolver(root).resolve(
      request("local://incoming/linked.pdf", "application/pdf"),
    )).rejects.toMatchObject({ code: "source_unavailable" });
  });

  it("rejects unsupported schemes and MIME types", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "incoming", "payload.bin"), "payload");
    const resolver = new LocalDocumentSourceResolver(root);
    await expect(resolver.resolve(request("file:///tmp/payload.bin", "application/pdf")))
      .rejects.toMatchObject({ code: "source_unavailable" });
    await expect(resolver.resolve(request("local://incoming/payload.bin", "application/octet-stream")))
      .rejects.toMatchObject({ code: "source_unavailable" });
  });

  it("enforces a byte limit before reading the file", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "incoming", "large.pdf"), "12345");
    await expect(new LocalDocumentSourceResolver(root, 4).resolve(
      request("local://incoming/large.pdf", "application/pdf"),
    )).rejects.toMatchObject({ code: "source_unavailable" });
  });
});
