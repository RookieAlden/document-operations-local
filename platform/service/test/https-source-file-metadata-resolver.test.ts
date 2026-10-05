import { describe, expect, it, vi } from "vitest";
import {
  HttpsSourceFileMetadataResolver,
  SourceFileMetadataError,
} from "../src/adapters/http/https-source-file-metadata-resolver.js";

const allowedHost = "prod-fillout-oregon-s3.s3.us-west-2.amazonaws.com";
const sourceUrl = `https://${allowedHost}/synthetic.pdf`;

function file(overrides: Record<string, unknown> = {}) {
  return {
    source_file_id: "fillout-file:0",
    original_filename: "synthetic.pdf",
    download_url: sourceUrl,
    ...overrides,
  };
}

describe("HTTPS source file metadata resolver", () => {
  it("hydrates byte size and MIME from an allowlisted HTTPS HEAD response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 200,
      headers: { "content-length": "3350", "content-type": "application/pdf" },
    })) as unknown as typeof fetch;
    const resolver = new HttpsSourceFileMetadataResolver({ allowedHosts: [allowedHost], fetchImpl });
    await expect(resolver.resolve([file()])).resolves.toEqual([expect.objectContaining({
      declared_size_bytes: 3350,
      declared_mime_type: "application/pdf",
    })]);
    expect(fetchImpl).toHaveBeenCalledWith(sourceUrl, expect.objectContaining({
      method: "HEAD",
      redirect: "manual",
    }));
  });

  it("does not make a network request when trusted metadata is already complete", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const resolver = new HttpsSourceFileMetadataResolver({ allowedHosts: [allowedHost], fetchImpl });
    const complete = file({ declared_size_bytes: 3350, declared_mime_type: "application/pdf" });
    await expect(resolver.resolve([complete])).resolves.toEqual([complete]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed for non-allowlisted hosts, redirects, and missing content length", async () => {
    const resolver = new HttpsSourceFileMetadataResolver({
      allowedHosts: [allowedHost],
      fetchImpl: (async () => new Response(null, { status: 302, headers: { location: sourceUrl } })) as typeof fetch,
    });
    await expect(resolver.resolve([file({ download_url: "https://attacker.invalid/file.pdf" })]))
      .rejects.toEqual(expect.objectContaining<Partial<SourceFileMetadataError>>({ reason: "host_not_allowed" }));
    await expect(resolver.resolve([file()]))
      .rejects.toEqual(expect.objectContaining<Partial<SourceFileMetadataError>>({ reason: "metadata_unavailable" }));

    const missingLength = new HttpsSourceFileMetadataResolver({
      allowedHosts: [allowedHost],
      fetchImpl: (async () => new Response(null, { status: 200, headers: { "content-type": "application/pdf" } })) as typeof fetch,
    });
    await expect(missingLength.resolve([file()]))
      .rejects.toEqual(expect.objectContaining<Partial<SourceFileMetadataError>>({ reason: "invalid_content_length" }));
  });
});
