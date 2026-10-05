import { createHash } from "node:crypto";
import { request as httpRequest, createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InternalDocumentUploadRouter } from "../src/http/internal-document-upload-router.js";
import type { DocumentObjectStore, PutDocumentObjectRequest } from "../src/ports/document-object-store.js";

const token = "internal-document-upload-token-over-thirty-two-characters";
const documentId = "00000000-0000-4000-8a00-000000000001";
const servers: Server[] = [];

class StubStore implements DocumentObjectStore {
  requests: PutDocumentObjectRequest[] = [];
  async put(request: PutDocumentObjectRequest) {
    this.requests.push(request);
    return { storageReference: `supabase://dop-incoming-dev/${request.organizationKey}/${request.documentId}/${request.sha256}` };
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(maximumBytes = 1_024) {
  const store = new StubStore();
  const router = new InternalDocumentUploadRouter(store, token, maximumBytes);
  const server = createServer(async (request, response) => {
    if (!await router.handle(request, response)) { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { server, store };
}

async function call(server: Server, content: Buffer, overrides: Record<string, string> = {}) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const sha256 = createHash("sha256").update(content).digest("hex");
  return await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: address.port, method: "POST",
      path: "/internal/v1/document-upload", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/pdf",
        "content-length": content.length, "x-dop-organization-key": "dev-accounting-firm",
        "x-dop-document-id": documentId, "x-dop-filename": encodeURIComponent("synthetic.pdf"),
        "x-dop-sha256": sha256, ...overrides,
      } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
      });
    request.on("error", reject);
    request.end(content);
  });
}

describe("internal document upload boundary", () => {
  it("stores an authenticated PDF only after signature and hash verification", async () => {
    const { server, store } = await start();
    const content = Buffer.from("%PDF-1.7\nsynthetic-only\n%%EOF");
    const response = await call(server, content);
    expect(response.status).toBe(200);
    expect(response.body.storageReference).toMatch(/^supabase:\/\//);
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]).toMatchObject({ organizationKey: "dev-accounting-firm", documentId,
      filename: "synthetic.pdf", mimeType: "application/pdf", content });
  });

  it("rejects missing authentication without touching storage", async () => {
    const { server, store } = await start();
    const response = await call(server, Buffer.from("%PDF-test"), { authorization: "Bearer wrong" });
    expect(response).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(store.requests).toHaveLength(0);
  });

  it("rejects a MIME/signature mismatch and an oversized body", async () => {
    const mismatchFixture = await start();
    const mismatch = await call(mismatchFixture.server, Buffer.from("not a pdf"));
    expect(mismatch).toEqual({ status: 422, body: { error: "file_signature_mismatch" } });
    expect(mismatchFixture.store.requests).toHaveLength(0);

    const oversizedFixture = await start(8);
    const oversized = await call(oversizedFixture.server, Buffer.from("%PDF-more-than-eight"));
    expect(oversized).toEqual({ status: 413, body: { error: "document_too_large" } });
    expect(oversizedFixture.store.requests).toHaveLength(0);
  });
});
