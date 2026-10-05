import type { ClassificationSource } from "./classification-provider.js";

export interface ResolveDocumentSourceRequest {
  documentId: string;
  storageReference: string;
  filename: string;
  declaredMimeType: string;
}

export interface DocumentSourceResolver {
  resolve(request: ResolveDocumentSourceRequest): Promise<ClassificationSource>;
}
