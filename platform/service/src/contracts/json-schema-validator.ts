import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import type { CanonicalSubmission } from "../domain/submission.js";
import type { WorkflowEvent } from "../domain/workflow-event.js";

export interface ClassificationResult {
  schema_version: "1.0" | "2.0-candidate.1";
  predicted_document_type_code: string | null;
  classification_outcome?: "classified" | "unknown" | "insufficient_evidence";
  abstention_reason?: "outside_allowed_types" | "unreadable" | "incomplete" | "mixed_document" | "ambiguous" | null;
  confidence: number;
  reason: string;
  detected_subject_references?: string[];
  detected_period?: string | null;
  quality_flags: string[];
  conflict_flags: string[];
  extracted_fields: Record<string, unknown>;
  evidence?: Array<{ label: string; value: string; page?: number }>;
}

export interface IndustryPackage {
  package_key: string;
  package_version: string;
  workflow_template_key: string;
  display_name: string;
  timezone: string;
  document_types: Array<{
    code: string;
    display_name: string;
    allowed_mime_types: string[];
    automatic_acceptance: {
      minimum_confidence: number;
      reject_on_quality_flags: string[];
      reject_on_conflict_flags: string[];
    };
  }>;
  requirement_profile: {
    set_key: string;
    version: number;
    requirements: Array<{
      requirement_code: string;
      document_type_code: string;
      minimum_count: number;
      maximum_count?: number | null;
    }>;
  };
  routing: Record<string, string>;
  notifications: Record<string, unknown>;
  storage: Record<string, unknown>;
  handoff: Record<string, unknown>;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ErrorObject[] };

function loadSchema(relativePath: string, version = "v1"): object {
  const candidates = [
    new URL(`../../../contracts/${version}/${relativePath}`, import.meta.url),
    new URL(`../../../../contracts/${version}/${relativePath}`, import.meta.url),
  ];
  const url = candidates.find((candidate) => existsSync(fileURLToPath(candidate)));
  if (!url) {
    throw new Error(`Unable to locate platform contract: ${relativePath}`);
  }
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as object;
}

export class ContractValidator {
  private readonly submission: ValidateFunction<CanonicalSubmission>;
  private readonly workflowEvent: ValidateFunction<WorkflowEvent>;
  private readonly industryPackage: ValidateFunction<IndustryPackage>;
  private readonly classificationResult: ValidateFunction<ClassificationResult>;
  private readonly candidateClassificationResult: ValidateFunction<ClassificationResult>;

  constructor() {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const addFormats = (addFormatsModule.default ?? addFormatsModule) as unknown as FormatsPlugin;
    addFormats(ajv);
    this.submission = ajv.compile<CanonicalSubmission>(loadSchema("submission.schema.json"));
    this.workflowEvent = ajv.compile<WorkflowEvent>(loadSchema("workflow-event.schema.json"));
    this.industryPackage = ajv.compile<IndustryPackage>(loadSchema("industry-package.schema.json"));
    this.candidateClassificationResult = ajv.compile<ClassificationResult>(loadSchema("classification-result.schema.json", "v2-candidate"));
    this.classificationResult = ajv.compile<ClassificationResult>(
      loadSchema("classification-result.schema.json"),
    );
  }

  validateSubmission(input: unknown): ValidationResult<CanonicalSubmission> {
    return this.validate(this.submission, input);
  }

  validateWorkflowEvent(input: unknown): ValidationResult<WorkflowEvent> {
    return this.validate(this.workflowEvent, input);
  }

  validateIndustryPackage(input: unknown): ValidationResult<IndustryPackage> {
    return this.validate(this.industryPackage, input);
  }

  validateClassificationResult(input: unknown): ValidationResult<ClassificationResult> {
    return this.validate(typeof input === "object" && input !== null && "schema_version" in input && input.schema_version === "2.0-candidate.1"
      ? this.candidateClassificationResult : this.classificationResult, input);
  }

  private validate<T>(validator: ValidateFunction<T>, input: unknown): ValidationResult<T> {
    if (validator(input)) {
      return { ok: true, value: input };
    }

    return { ok: false, errors: validator.errors ? [...validator.errors] : [] };
  }
}
