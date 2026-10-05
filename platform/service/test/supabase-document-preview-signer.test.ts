import { describe, expect, it, vi } from "vitest";
import { SupabaseDocumentPreviewSigner } from "../src/adapters/storage/supabase-document-preview-signer.js";

describe("SupabaseDocumentPreviewSigner", () => {
  it("creates a one-minute URL without exposing the storage credential", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/storage/v1/object/sign/dop-incoming-dev/org/document/file.pdf");
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret-storage-token" });
      expect(init?.body).toBe(JSON.stringify({ expiresIn: 60 }));
      return new Response(JSON.stringify({ signedURL: "/object/sign/dop-incoming-dev/org/document/file.pdf?token=short-lived" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const signer = new SupabaseDocumentPreviewSigner({
      projectUrl: "https://example.supabase.co", accessToken: "secret-storage-token",
      bucket: "dop-incoming-dev", fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });
    const result = await signer.createSignedPreview("supabase://dop-incoming-dev/org/document/file.pdf", 60);
    expect(result).toEqual({
      url: "https://example.supabase.co/storage/v1/object/sign/dop-incoming-dev/org/document/file.pdf?token=short-lived",
      expiresAt: "2026-08-07T00:01:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("secret-storage-token");
  });

  it("rejects cross-bucket and path traversal references before calling storage", async () => {
    const fetch = vi.fn();
    const signer = new SupabaseDocumentPreviewSigner({
      projectUrl: "https://example.supabase.co", accessToken: "token", bucket: "expected",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(signer.createSignedPreview("supabase://other/path/file.pdf", 60)).rejects.toMatchObject({ code: "invalid_reference" });
    await expect(signer.createSignedPreview("supabase://expected/path/../file.pdf", 60)).rejects.toMatchObject({ code: "invalid_reference" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
