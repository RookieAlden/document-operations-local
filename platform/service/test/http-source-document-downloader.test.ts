import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HttpSourceDocumentDownloader } from "../src/adapters/http/http-source-document-downloader.js";

const pdf = Buffer.from("%PDF-1.7\nsynthetic");
const sha256 = createHash("sha256").update(pdf).digest("hex");
const request = {
  url: "https://files.example.com/signed/document.pdf?token=private",
  filename: "document.pdf",
  declaredMimeType: "application/pdf",
  declaredSizeBytes: pdf.length,
  expectedSha256: sha256,
};

function downloader(fetchImplementation: typeof fetch, maximumBytes = 1024): HttpSourceDocumentDownloader {
  return new HttpSourceDocumentDownloader({
    allowedHosts: ["files.example.com"], maximumBytes, fetch: fetchImplementation,
  });
}

describe("HttpSourceDocumentDownloader", () => {
  it("downloads an allowlisted HTTPS source and verifies its integrity", async () => {
    const fetchImplementation = vi.fn(async () => new Response(pdf, {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": String(pdf.length) },
    })) as unknown as typeof fetch;
    await expect(downloader(fetchImplementation).download(request)).resolves.toEqual({
      content: pdf, mimeType: "application/pdf", sizeBytes: pdf.length, sha256,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "files.example.com" }),
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("rejects HTTP, credentials, unknown hosts and redirects before following them", async () => {
    const fetchImplementation = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } })) as unknown as typeof fetch;
    for (const url of [
      "http://files.example.com/document.pdf",
      "https://user:secret@files.example.com/document.pdf",
      "https://evil.test/document.pdf",
    ]) {
      await expect(downloader(fetchImplementation).download({ ...request, url }))
        .rejects.toMatchObject({ code: "source_url_not_allowed", failureMode: "manual" });
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
    await expect(downloader(fetchImplementation).download(request))
      .rejects.toMatchObject({ code: "source_redirect_rejected", failureMode: "manual" });
  });

  it("enforces streaming size bounds even without a content-length header", async () => {
    const fetchImplementation = vi.fn(async () => new Response(pdf, {
      status: 200, headers: { "content-type": "application/pdf" },
    })) as unknown as typeof fetch;
    await expect(downloader(fetchImplementation, 4).download({
      ...request, declaredSizeBytes: null, expectedSha256: null,
    })).rejects.toMatchObject({ code: "source_too_large", failureMode: "manual" });
  });

  it("rejects MIME, signature, size and hash mismatches", async () => {
    const cases = [
      { body: pdf, headers: { "content-type": "text/plain" }, input: request, code: "source_mime_mismatch" },
      { body: Buffer.from("not-a-pdf"), headers: { "content-type": "application/pdf" }, input: { ...request, declaredSizeBytes: null, expectedSha256: null }, code: "source_signature_mismatch" },
      { body: pdf, headers: { "content-type": "application/pdf" }, input: { ...request, declaredSizeBytes: 1 }, code: "source_size_mismatch" },
      { body: pdf, headers: { "content-type": "application/pdf" }, input: { ...request, expectedSha256: "0".repeat(64) }, code: "source_hash_mismatch" },
    ];
    for (const testCase of cases) {
      const fetchImplementation = vi.fn(async () => new Response(testCase.body, {
        status: 200, headers: testCase.headers,
      })) as unknown as typeof fetch;
      await expect(downloader(fetchImplementation).download(testCase.input))
        .rejects.toMatchObject({ code: testCase.code, failureMode: "manual" });
    }
  });

  it("marks transient provider responses recoverable without exposing response bodies", async () => {
    const secret = "upstream-secret-body";
    const fetchImplementation = vi.fn(async () => new Response(secret, { status: 503 })) as unknown as typeof fetch;
    let thrown: unknown;
    try { await downloader(fetchImplementation).download(request); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "source_http_503", failureMode: "recoverable" });
    expect(String(thrown)).not.toContain(secret);
  });
});
