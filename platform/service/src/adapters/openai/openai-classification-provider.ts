import { createHash } from "node:crypto";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import {
  ContractValidator,
  type ClassificationResult,
} from "../../contracts/json-schema-validator.js";
import type {
  ClassificationProvider,
  ClassificationProviderResult,
  ClassificationRequest,
} from "../../ports/classification-provider.js";

export const MODEL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "predicted_document_type_code",
    "confidence",
    "reason",
    "detected_subject_references",
    "detected_period",
    "quality_flags",
    "conflict_flags",
    "extracted_fields",
    "evidence",
  ],
  properties: {
    schema_version: { type: "string", const: "1.0" },
    predicted_document_type_code: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    detected_subject_references: {
      type: "array",
      maxItems: 20,
      items: { type: "string" },
    },
    detected_period: { type: ["string", "null"] },
    quality_flags: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "blurry", "blank", "corrupt", "partial", "password_protected", "unsupported",
          "mime_mismatch", "other",
        ],
      },
    },
    conflict_flags: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "subject_conflict", "period_conflict", "document_type_conflict",
          "duplicate_suspected", "other",
        ],
      },
    },
    extracted_fields: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value"],
        properties: {
          key: { type: "string" },
          value: { type: ["string", "number", "boolean", "null"] },
        },
      },
    },
    evidence: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value", "page"],
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          page: { type: ["integer", "null"], minimum: 1 },
        },
      },
    },
  },
} as const;

export const MODEL_OUTPUT_SCHEMA_HASH = createHash("sha256")
  .update(JSON.stringify(MODEL_OUTPUT_SCHEMA))
  .digest("hex");

export const CANDIDATE_SCHEMA_VERSION = "2.0-candidate.1" as const;
export const CANDIDATE_MODEL_OUTPUT_SCHEMA = {
  ...MODEL_OUTPUT_SCHEMA,
  required: [...MODEL_OUTPUT_SCHEMA.required, "classification_outcome", "abstention_reason"],
  properties: {
    ...MODEL_OUTPUT_SCHEMA.properties,
    schema_version: { type: "string", const: CANDIDATE_SCHEMA_VERSION },
    predicted_document_type_code: { type: ["string", "null"] },
    classification_outcome: { type: "string", enum: ["classified", "unknown", "insufficient_evidence"] },
    abstention_reason: { type: ["string", "null"], enum: [null, "outside_allowed_types", "unreadable", "incomplete", "mixed_document", "ambiguous"] },
  },
} as const;
export const CANDIDATE_MODEL_OUTPUT_SCHEMA_HASH = createHash("sha256")
  .update(JSON.stringify(CANDIDATE_MODEL_OUTPUT_SCHEMA)).digest("hex");
export function classificationSchemaHash(version: string): string | null {
  return version === "1.0" ? MODEL_OUTPUT_SCHEMA_HASH
    : version === CANDIDATE_SCHEMA_VERSION ? CANDIDATE_MODEL_OUTPUT_SCHEMA_HASH : null;
}

interface StrictModelOutput {
  schema_version: "1.0" | typeof CANDIDATE_SCHEMA_VERSION;
  predicted_document_type_code: string | null;
  classification_outcome?: ClassificationResult["classification_outcome"];
  abstention_reason?: ClassificationResult["abstention_reason"];
  confidence: number;
  reason: string;
  detected_subject_references: string[];
  detected_period: string | null;
  quality_flags: string[];
  conflict_flags: string[];
  extracted_fields: Array<{ key: string; value: string | number | boolean | null }>;
  evidence: Array<{ label: string; value: string; page: number | null }>;
}

interface OpenAIResponse {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  error?: unknown;
  output?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

export type ClassificationFailureCode =
  | "aborted"
  | "provider_error"
  | "provider_incomplete"
  | "provider_refusal"
  | "invalid_provider_response"
  | "invalid_classification";

export class OpenAIClassificationError extends Error {
  constructor(
    readonly code: ClassificationFailureCode,
    message: string,
    readonly statusCode?: number,
    readonly providerCode?: string,
    readonly providerType?: string,
    readonly providerParam?: string,
    readonly providerMessage?: string,
  ) {
    super(message);
    this.name = "OpenAIClassificationError";
  }
}

export interface OpenAIClassificationProviderOptions {
  apiKey: string;
  model: string;
  prompt: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OpenAIClassificationProvider implements ClassificationProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly validateModelOutput: ValidateFunction<StrictModelOutput>;
  private readonly validateCandidateOutput: ValidateFunction<StrictModelOutput>;
  private readonly contractValidator = new ContractValidator();
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAIClassificationProviderOptions) {
    if (!options.apiKey) throw new Error("OpenAI API key is required");
    if (!options.model) throw new Error("OpenAI model is required");
    if (!options.prompt.trim()) throw new Error("Classification prompt is required");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.validateModelOutput = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
      .compile<StrictModelOutput>(MODEL_OUTPUT_SCHEMA);
    this.validateCandidateOutput = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
      .compile<StrictModelOutput>(CANDIDATE_MODEL_OUTPUT_SCHEMA);
  }

  async classify(request: ClassificationRequest): Promise<ClassificationProviderResult> {
    ensureRequestIsSafe(request);
    ensureExecutionIsSafe(request);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(this.buildRequestBody(request)),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === "AbortError") {
        throw new OpenAIClassificationError("aborted", "OpenAI classification request timed out");
      }
      throw new OpenAIClassificationError("provider_error", "OpenAI classification request failed");
    }

    try {
      if (!response.ok) {
        const diagnostic = await readProviderErrorDiagnostic(response, this.options.apiKey);
        throw new OpenAIClassificationError(
          "provider_error",
          `OpenAI classification request returned HTTP ${response.status}`,
          response.status,
          diagnostic.code,
          diagnostic.type,
          diagnostic.param,
          diagnostic.message,
        );
      }

      let payload: OpenAIResponse;
      try {
        payload = await response.json() as OpenAIResponse;
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new OpenAIClassificationError("aborted", "OpenAI classification response timed out");
        }
        throw new OpenAIClassificationError(
          "invalid_provider_response",
          "OpenAI classification response was not valid JSON",
        );
      }
      return this.parseResponse(payload, request);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildRequestBody(request: ClassificationRequest): Record<string, unknown> {
    const execution = request.execution ?? {
      model: this.options.model,
      prompt: this.options.prompt,
      promptInstructionHash: createHash("sha256").update(this.options.prompt).digest("hex"),
      responseSchemaVersion: "1.0" as const,
      responseSchemaHash: MODEL_OUTPUT_SCHEMA_HASH,
      maxOutputTokens: 1500,
      reasoningEffort: "low" as const,
    };
    const context = {
      document_id: request.documentId,
      filename: request.filename,
      declared_mime_type: request.declaredMimeType,
      allowed_document_types: request.allowedDocumentTypes.map((item) => ({
        code: item.code,
        display_name: item.displayName,
        ...(item.description ? { description: item.description } : {}),
      })),
      expected_subject_references: request.expectedSubjectReferences ?? [],
      expected_period: request.expectedPeriod ?? null,
    };

    return {
      model: execution.model,
      store: false,
      instructions: execution.prompt,
      max_output_tokens: execution.maxOutputTokens,
      ...(/^(gpt-5|gpt-6|o[134])/.test(execution.model) ? { reasoning: { effort: execution.reasoningEffort } } : {}),
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: `Classification context:\n${JSON.stringify(context)}` },
          sourceContent(request),
        ],
      }],
      text: {
        format: {
          type: "json_schema",
          name: execution.responseSchemaVersion === CANDIDATE_SCHEMA_VERSION ? "document_classification_v2_candidate" : "document_classification_v1",
          strict: true,
          schema: execution.responseSchemaVersion === CANDIDATE_SCHEMA_VERSION ? CANDIDATE_MODEL_OUTPUT_SCHEMA : MODEL_OUTPUT_SCHEMA,
        },
      },
    };
  }

  private parseResponse(
    payload: OpenAIResponse,
    request: ClassificationRequest,
  ): ClassificationProviderResult {
    if (payload.status !== "completed") {
      throw new OpenAIClassificationError(
        "provider_incomplete",
        "OpenAI classification response did not complete",
      );
    }
    if (payload.error !== null && payload.error !== undefined) {
      throw new OpenAIClassificationError(
        "provider_error",
        "OpenAI classification response contained an error",
      );
    }

    const content = findAssistantContent(payload.output);
    if (content.refusal) {
      throw new OpenAIClassificationError("provider_refusal", "OpenAI declined to classify the document");
    }
    if (!content.text) {
      throw new OpenAIClassificationError(
        "invalid_provider_response",
        "OpenAI classification response did not contain output text",
      );
    }

    let modelOutput: unknown;
    try {
      modelOutput = JSON.parse(content.text);
    } catch {
      throw new OpenAIClassificationError(
        "invalid_classification",
        "OpenAI classification output was not valid JSON",
      );
    }
    const validateOutput = request.execution?.responseSchemaVersion === CANDIDATE_SCHEMA_VERSION
      ? this.validateCandidateOutput : this.validateModelOutput;
    if (!validateOutput(modelOutput)) {
      throw new OpenAIClassificationError(
        "invalid_classification",
        "OpenAI classification output did not match the strict schema",
      );
    }
    if (modelOutput.predicted_document_type_code !== null && !request.allowedDocumentTypes.some((item) => item.code === modelOutput.predicted_document_type_code)) {
      throw new OpenAIClassificationError(
        "invalid_classification",
        "OpenAI classification selected a document type outside the allowed set",
      );
    }

    const extractedFields: Record<string, unknown> = {};
    for (const item of modelOutput.extracted_fields) {
      if (Object.hasOwn(extractedFields, item.key)) {
        throw new OpenAIClassificationError(
          "invalid_classification",
          "OpenAI classification output contained duplicate extracted field keys",
        );
      }
      extractedFields[item.key] = item.value;
    }
    const canonical: ClassificationResult = {
      schema_version: modelOutput.schema_version,
      predicted_document_type_code: modelOutput.predicted_document_type_code,
      ...(modelOutput.schema_version === CANDIDATE_SCHEMA_VERSION ? { classification_outcome: modelOutput.classification_outcome!, abstention_reason: modelOutput.abstention_reason! } : {}),
      confidence: modelOutput.confidence,
      reason: modelOutput.reason,
      detected_subject_references: modelOutput.detected_subject_references,
      detected_period: modelOutput.detected_period,
      quality_flags: modelOutput.quality_flags,
      conflict_flags: modelOutput.conflict_flags,
      extracted_fields: extractedFields,
      evidence: modelOutput.evidence.map((item) => ({
        label: item.label,
        value: item.value,
        ...(item.page === null ? {} : { page: item.page }),
      })),
    };
    const validated = this.contractValidator.validateClassificationResult(canonical);
    if (!validated.ok) {
      throw new OpenAIClassificationError(
        "invalid_classification",
        "Normalized classification did not match the platform contract",
      );
    }
    if (!payload.id || typeof payload.id !== "string" || !payload.model || typeof payload.model !== "string") {
      throw new OpenAIClassificationError(
        "invalid_provider_response",
        "OpenAI classification response lacked audit identifiers",
      );
    }

    return {
      result: validated.value,
      audit: {
        provider: "openai",
        responseId: payload.id,
        model: payload.model,
        inputTokens: asTokenCount(payload.usage?.input_tokens),
        outputTokens: asTokenCount(payload.usage?.output_tokens),
      },
    };
  }
}

function ensureExecutionIsSafe(request: ClassificationRequest): void {
  const execution = request.execution;
  if (!execution) return;
  const promptHash = createHash("sha256").update(execution.prompt).digest("hex");
  if (!/^[a-z0-9][a-z0-9._:-]{2,119}$/i.test(execution.model) ||
      !execution.prompt.trim() || promptHash !== execution.promptInstructionHash ||
      classificationSchemaHash(execution.responseSchemaVersion) === null || execution.responseSchemaHash !== classificationSchemaHash(execution.responseSchemaVersion) ||
      !Number.isInteger(execution.maxOutputTokens) || execution.maxOutputTokens < 256 ||
      execution.maxOutputTokens > 4_000 || !["low", "medium", "high"].includes(execution.reasoningEffort)) {
    throw new OpenAIClassificationError("invalid_classification", "Classifier release execution definition is invalid");
  }
}

function ensureRequestIsSafe(request: ClassificationRequest): void {
  if (request.allowedDocumentTypes.length === 0) {
    throw new Error("At least one allowed document type is required");
  }
  const codes = new Set<string>();
  for (const item of request.allowedDocumentTypes) {
    if (!item.code || codes.has(item.code)) throw new Error("Document type codes must be non-empty and unique");
    codes.add(item.code);
  }
}

function sourceContent(request: ClassificationRequest): Record<string, unknown> {
  switch (request.source.kind) {
    case "text":
      return { type: "input_text", text: `Untrusted document content follows:\n${request.source.text}` };
    case "image_url":
      return {
        type: "input_image",
        image_url: request.source.imageUrl,
        detail: request.source.detail ?? "auto",
      };
    case "file_url":
      return { type: "input_file", file_url: request.source.fileUrl };
    case "file_id":
      return { type: "input_file", file_id: request.source.fileId };
    case "file_data":
      return {
        type: "input_file",
        filename: request.source.filename,
        file_data: `data:${request.source.mimeType};base64,${request.source.base64}`,
      };
  }
}

function findAssistantContent(output: unknown): { text?: string; refusal?: string } {
  if (!Array.isArray(output)) return {};
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content)) continue;
      if (content.type === "refusal" && typeof content.refusal === "string") return { refusal: content.refusal };
      if (content.type === "output_text" && typeof content.text === "string") return { text: content.text };
    }
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

async function readProviderErrorDiagnostic(response: Response, apiKey: string): Promise<{
  code?: string;
  type?: string;
  param?: string;
  message?: string;
}> {
  try {
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || !isRecord(payload.error)) return {};
    const code = typeof payload.error.code === "string" ? payload.error.code : undefined;
    return {
      ...safeDiagnosticField(payload.error.code, "code"),
      ...safeDiagnosticField(payload.error.type, "type"),
      ...safeDiagnosticField(payload.error.param, "param"),
      ...(code === "invalid_json_schema" ? safeSchemaMessage(payload.error.message, apiKey) : {}),
    };
  } catch {
    return {};
  }
}

function safeSchemaMessage(value: unknown, apiKey: string): { message?: string } {
  if (typeof value !== "string" || value.length > 1200) return {};
  if (value.includes(apiKey) || /data:|https?:|sk-[a-zA-Z0-9_-]/i.test(value)) return {};
  return { message: value };
}

function safeDiagnosticField(
  value: unknown,
  field: "code" | "type" | "param",
): Partial<Record<"code" | "type" | "param", string>> {
  if (typeof value !== "string" || value.length > 200 || !/^[a-zA-Z0-9_.\[\]-]+$/.test(value)) return {};
  return { [field]: value };
}
