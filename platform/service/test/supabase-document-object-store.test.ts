import { describe, expect, it, vi } from "vitest";
import { SupabaseDocumentObjectStore } from "../src/adapters/storage/supabase-document-object-store.js";

const TOKEN = "storage-secret-must-not-leak";
const request = {
  organizationKey: "dev-accounting-firm",
  documentId: "00000000-0000-4000-8000-000000000001",
  filename: "July Statement (final).pdf",
  mimeType: "application/pdf",
  sha256: "a".repeat(64),
  content: Buffer.from("%PDF-test"),
};

describe("SupabaseDocumentObjectStore", () => {
  it("uses a content-addressed private object path and does not upsert", async () => {
    const fetchImplementation = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const store = new SupabaseDocumentObjectStore({
      projectUrl: "https://project.supabase.co", accessToken: TOKEN,
      bucket: "dop-incoming-dev", fetch: fetchImplementation,
    });
    await expect(store.put(request)).resolves.toEqual({
      storageReference: `supabase://dop-incoming-dev/dev-accounting-firm/${request.documentId}/${request.sha256}-July-Statement-final-.pdf`,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      expect.stringContaining(`/storage/v1/object/dop-incoming-dev/dev-accounting-firm/${request.documentId}/`),
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-upsert": "false" }) }),
    );
  });

  it("treats an existing content-addressed object as an idempotent success", async () => {
    const store = new SupabaseDocumentObjectStore({
      projectUrl: "https://project.supabase.co", accessToken: TOKEN, bucket: "dop-incoming-dev",
      fetch: vi.fn(async () => new Response("exists", { status: 409 })) as unknown as typeof fetch,
    });
    await expect(store.put(request)).resolves.toMatchObject({ storageReference: expect.stringContaining(request.sha256) });
  });

  it("accepts the current Supabase KeyAlreadyExists response shape", async () => {
    const store = new SupabaseDocumentObjectStore({
      projectUrl: "https://project.supabase.co", accessToken: TOKEN, bucket: "dop-incoming-dev",
      fetch: vi.fn(async () => new Response(JSON.stringify({
        statusCode: "409", error: "Duplicate", message: "The resource already exists", code: "KeyAlreadyExists",
      }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    await expect(store.put(request)).resolves.toMatchObject({ storageReference: expect.stringContaining(request.sha256) });
  });

  it("does not treat an unrelated Storage 400 as an idempotent success", async () => {
    const store = new SupabaseDocumentObjectStore({
      projectUrl: "https://project.supabase.co", accessToken: TOKEN, bucket: "dop-incoming-dev",
      fetch: vi.fn(async () => new Response(JSON.stringify({
        statusCode: "400", error: "BadRequest", code: "InvalidRequest",
      }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    await expect(store.put(request)).rejects.toMatchObject({ code: "storage_write_failed" });
  });

  it("fails safely without exposing the provider body or token", async () => {
    const store = new SupabaseDocumentObjectStore({
      projectUrl: "https://project.supabase.co", accessToken: TOKEN, bucket: "dop-incoming-dev",
      fetch: vi.fn(async () => new Response(`secret ${TOKEN}`, { status: 403 })) as unknown as typeof fetch,
    });
    let thrown: unknown;
    try { await store.put(request); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "storage_write_failed" });
    expect(String(thrown)).not.toContain(TOKEN);
  });

  it("deletes only a reference inside the configured private bucket",async()=>{
    const fetchImplementation=vi.fn(async()=>new Response("{}",{status:200})) as unknown as typeof fetch;
    const store=new SupabaseDocumentObjectStore({projectUrl:"https://project.supabase.co",accessToken:TOKEN,
      bucket:"dop-incoming-dev",fetch:fetchImplementation});
    await expect(store.delete("supabase://dop-incoming-dev/org/document/file.pdf")).resolves.toBe("deleted");
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://project.supabase.co/storage/v1/object/dop-incoming-dev/org/document/file.pdf",
      expect.objectContaining({method:"DELETE"}),
    );
    await expect(store.delete("supabase://another-bucket/org/document/file.pdf"))
      .rejects.toMatchObject({code:"storage_delete_failed"});
  });

  it("makes deletion idempotent and fails closed on provider errors",async()=>{
    const missing=new SupabaseDocumentObjectStore({projectUrl:"https://project.supabase.co",accessToken:TOKEN,
      bucket:"dop-incoming-dev",fetch:vi.fn(async()=>new Response("",{status:404})) as unknown as typeof fetch});
    await expect(missing.delete("supabase://dop-incoming-dev/org/document/file.pdf")).resolves.toBe("not_found");
    const failed=new SupabaseDocumentObjectStore({projectUrl:"https://project.supabase.co",accessToken:TOKEN,
      bucket:"dop-incoming-dev",fetch:vi.fn(async()=>new Response(`secret ${TOKEN}`,{status:503})) as unknown as typeof fetch});
    let thrown:unknown;try{await failed.delete("supabase://dop-incoming-dev/org/document/file.pdf");}catch(error){thrown=error;}
    expect(thrown).toMatchObject({code:"storage_delete_failed"});expect(String(thrown)).not.toContain(TOKEN);
  });
});
