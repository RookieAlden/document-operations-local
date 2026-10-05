import type { OpsDocumentUploadBroker } from "../../ports/ops-trial-repository.js";

export interface HttpDocumentUploadBrokerOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export class HttpDocumentUploadBroker implements OpsDocumentUploadBroker {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: HttpDocumentUploadBrokerOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Document upload broker URL must use HTTP or HTTPS");
    if (options.token.length < 32) throw new Error("Document upload broker token must contain at least 32 characters");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async store(request: Parameters<OpsDocumentUploadBroker["store"]>[0]): Promise<{ storageReference: string }> {
    const response = await this.fetchImplementation(`${this.baseUrl}/internal/v1/document-upload`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": request.mimeType,
        "x-dop-organization-key": request.organizationKey,
        "x-dop-document-id": request.documentId,
        "x-dop-filename": encodeURIComponent(request.filename),
        "x-dop-sha256": request.sha256,
      },
      body: new Uint8Array(request.content),
    });
    if (!response.ok) throw new Error(`document_upload_broker_http_${response.status}`);
    const body = await response.json() as { storageReference?: unknown };
    if (typeof body.storageReference !== "string" || !body.storageReference.startsWith("supabase://")) {
      throw new Error("document_upload_broker_invalid_response");
    }
    return { storageReference: body.storageReference };
  }
}
