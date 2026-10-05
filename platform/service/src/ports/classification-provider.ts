import type { ClassificationResult } from "../contracts/json-schema-validator.js";

export type ClassificationSource =
  | { kind: "text"; text: string }
  | { kind: "image_url"; imageUrl: string; detail?: "low" | "high" | "auto" }
  | { kind: "file_url"; fileUrl: string }
  | { kind: "file_id"; fileId: string }
  | { kind: "file_data"; filename: string; mimeType: string; base64: string };

export interface AllowedDocumentType {
  code: string;
  displayName: string;
  description?: string;
}

export interface ClassificationRequest {
  documentId: string;
  filename: string;
  declaredMimeType: string;
  allowedDocumentTypes: AllowedDocumentType[];
  source: ClassificationSource;
  expectedSubjectReferences?: string[];
  expectedPeriod?: string | null;
  execution?: {
    model: string;
    prompt: string;
    promptInstructionHash: string;
    responseSchemaVersion: "1.0" | "2.0-candidate.1";
    responseSchemaHash: string;
    maxOutputTokens: number;
    reasoningEffort: "low" | "medium" | "high";
  };
}

export interface ClassificationProviderResult {
  result: ClassificationResult;
  audit: {
    provider: "openai";
    responseId: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

export interface ClassificationProvider {
  classify(request: ClassificationRequest): Promise<ClassificationProviderResult>;
}
