export interface DocumentPreviewSigner {
  createSignedPreview(storageReference: string, expiresInSeconds: number): Promise<{
    url: string;
    expiresAt: string;
  }>;
}

export interface DocumentPreviewBroker {
  createPreview(storageReference: string): Promise<{ url: string; expiresAt: string }>;
}

export interface OpsDocumentPreviewRepository {
  getStorageReference(organizationKey: string, documentId: string): Promise<
    { outcome: "available"; storageReference: string } |
    { outcome: "not_found" } |
    { outcome: "not_ready" }
  >;
}
