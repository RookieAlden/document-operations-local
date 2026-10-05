import type { DocumentPreviewBroker } from "../../ports/document-preview.js";

export class HttpDocumentPreviewBroker implements DocumentPreviewBroker {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Preview broker URL must use HTTP or HTTPS");
    if (options.token.length < 32) throw new Error("Internal preview token must contain at least 32 characters");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.token = options.token;
  }

  private readonly token: string;

  async createPreview(storageReference: string): Promise<{ url: string; expiresAt: string }> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}/internal/v1/document-preview`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ storageReference }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch { throw new Error("preview_broker_unavailable"); }
    if (!response.ok) throw new Error(response.status === 404 ? "preview_not_found" : "preview_broker_unavailable");
    const body = await response.json() as { url?: unknown; expiresAt?: unknown };
    if (typeof body.url !== "string" || typeof body.expiresAt !== "string") throw new Error("preview_broker_unavailable");
    return { url: body.url, expiresAt: body.expiresAt };
  }
}
