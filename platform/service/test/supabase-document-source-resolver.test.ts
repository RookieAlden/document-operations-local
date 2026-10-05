import { describe, expect, it, vi } from "vitest";
import { SupabaseDocumentSourceResolver } from "../src/adapters/storage/supabase-document-source-resolver.js";

const TOKEN = "test-storage-token-that-must-not-leak";
const baseRequest = {
  documentId: "doc-1",
  storageReference: "supabase://dop-incoming-dev/org-1/statement.pdf",
  filename: "statement.pdf",
  declaredMimeType: "application/pdf",
};

function response(body: BodyInit, init: ResponseInit = {}): typeof fetch {
  return vi.fn(async () => new Response(body, init)) as unknown as typeof fetch;
}

describe("SupabaseDocumentSourceResolver", () => {
  it("downloads a private object with authorization and returns file_data", async () => {
    const fetchImplementation = response(Buffer.from("%PDF-test"), {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": "9" },
    });
    const resolver = new SupabaseDocumentSourceResolver({
      projectUrl: "https://project.supabase.co/",
      accessToken: TOKEN,
      bucket: "dop-incoming-dev",
      fetch: fetchImplementation,
    });
    await expect(resolver.resolve(baseRequest)).resolves.toEqual({
      kind: "file_data",
      filename: "statement.pdf",
      mimeType: "application/pdf",
      base64: Buffer.from("%PDF-test").toString("base64"),
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://project.supabase.co/storage/v1/object/authenticated/dop-incoming-dev/org-1/statement.pdf",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}`, apikey: TOKEN },
      }),
    );
  });

  it("rejects another bucket and traversal paths before making a request", async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch;
    const resolver = new SupabaseDocumentSourceResolver({
      projectUrl: "https://project.supabase.co",
      accessToken: TOKEN,
      bucket: "dop-incoming-dev",
      fetch: fetchImplementation,
    });
    await expect(resolver.resolve({ ...baseRequest, storageReference: "supabase://other/file.pdf" }))
      .rejects.toMatchObject({ code: "source_unavailable" });
    await expect(resolver.resolve({ ...baseRequest, storageReference: "supabase://dop-incoming-dev/../file.pdf" }))
      .rejects.toMatchObject({ code: "source_unavailable" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("rejects oversized content from headers and actual bytes", async () => {
    const headerResolver = new SupabaseDocumentSourceResolver({
      projectUrl: "https://project.supabase.co", accessToken: TOKEN, bucket: "dop-incoming-dev",
      maximumBytes: 4,
      fetch: response("12345", { status: 200, headers: { "content-type": "application/pdf", "content-length": "5" } }),
    });
    await expect(headerResolver.resolve(baseRequest)).rejects.toMatchObject({ code: "source_unavailable" });
    const bodyResolver = new SupabaseDocumentSourceResolver({
      projectUrl: "https://project.supabase.co", accessToken: TOKEN, bucket: "dop-incoming-dev",
      maximumBytes: 4,
      fetch: response("12345", { status: 200, headers: { "content-type": "application/pdf" } }),
    });
    await expect(bodyResolver.resolve(baseRequest)).rejects.toMatchObject({ code: "source_unavailable" });
  });

  it("fails safely without exposing a token or provider error body", async () => {
    const resolver = new SupabaseDocumentSourceResolver({
      projectUrl: "https://project.supabase.co", accessToken: TOKEN, bucket: "dop-incoming-dev",
      fetch: response(`sensitive ${TOKEN}`, { status: 403 }),
    });
    let thrown: unknown;
    try { await resolver.resolve(baseRequest); } catch (error) { thrown = error; }
    expect(String(thrown)).not.toContain(TOKEN);
    expect(thrown).toMatchObject({ code: "source_unavailable" });
  });

  it("rejects stored MIME mismatches", async () => {
    const resolver = new SupabaseDocumentSourceResolver({
      projectUrl: "https://project.supabase.co", accessToken: TOKEN, bucket: "dop-incoming-dev",
      fetch: response("payload", { status: 200, headers: { "content-type": "text/plain" } }),
    });
    await expect(resolver.resolve(baseRequest)).rejects.toMatchObject({ code: "source_unavailable" });
  });
});
