export interface PutDocumentObjectRequest {
  organizationKey: string;
  documentId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  content: Buffer;
}

export interface DocumentObjectStore {
  put(request: PutDocumentObjectRequest): Promise<{ storageReference: string }>;
}
