import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import type { ReceiveSubmissionResult } from "../../application/receive-submission.js";
import type { CanonicalSubmission, Environment } from "../../domain/submission.js";

const FORM_SUBMISSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "provider_form_id",
    "provider_submission_id",
    "received_at",
    "period",
    "files",
  ],
  properties: {
    schema_version: { const: "1.0" },
    provider_form_id: { type: "string", minLength: 1, maxLength: 300 },
    provider_submission_id: { type: "string", minLength: 1, maxLength: 300 },
    received_at: { type: "string", format: "date-time" },
    period: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$", maxLength: 80 },
    demo_invitation_token: { type: "string", minLength: 32, maxLength: 300 },
    files: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_file_id", "original_filename", "download_url"],
        properties: {
          source_file_id: { type: "string", minLength: 1, maxLength: 300 },
          original_filename: { type: "string", minLength: 1, maxLength: 500 },
          download_url: { type: "string", format: "uri", pattern: "^https://", maxLength: 4000 },
          declared_mime_type: { type: "string", maxLength: 200 },
          declared_size_bytes: { type: "integer", minimum: 0 },
          content_hash_sha256: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
        },
      },
    },
  },
} as const;

export interface FormConnectorSubmission {
  schema_version: "1.0";
  provider_form_id: string;
  provider_submission_id: string;
  received_at: string;
  period: string;
  demo_invitation_token?: string;
  files: CanonicalSubmission["files"];
}

export interface FormConnectorProfile {
  connectorId: string;
  providerFormId: string;
  environment: Environment;
  organizationKey: string;
  workflowTemplateKey: string;
  subjectKey: string;
  subjectDisplayName: string;
  timezone: string;
  sourceType: "fillout";
  productionAdmissionPolicyKey?: string;
  demoGovernanceRequired?: boolean;
  periodQuestionName?: string;
  fileQuestionName?: string;
  invitationQuestionName?: string;
}

export interface FormConnectorAuthorizedScope {
  organizationKey: string;
  workflowTemplateKey: string;
  subjectKey: string;
  subjectDisplayName: string;
  caseKey: string;
  period: string;
  timezone: string;
}

export type FormConnectorInspectionResult =
  | { ok: true; value: {
      providerFormId: string;
      providerSubmissionId: string;
      receivedAt: string;
      claimedPeriod: string;
      invitationToken: string | null;
      files: CanonicalSubmission["files"];
    } }
  | { ok: false; errors: Array<{ instancePath: string; message: string }> };

export type FormConnectorInspection = Extract<FormConnectorInspectionResult, { ok: true }>["value"];

export type FormConnectorMappingResult =
  | { ok: true; value: CanonicalSubmission }
  | { ok: false; errors: Array<{ instancePath: string; message: string }> };

export interface CanonicalSubmissionReceiver {
  execute(command: {
    input: unknown;
    workerId: string;
    correlationId?: string;
    now?: Date;
  }): Promise<ReceiveSubmissionResult>;
}

export class FormConnector {
  private readonly validate: ValidateFunction<FormConnectorSubmission>;

  constructor(readonly profile: FormConnectorProfile) {
    if (profile.environment === "PROD" && !profile.productionAdmissionPolicyKey) {
      throw new Error("PROD form connector requires a production admission policy key");
    }
    if (profile.demoGovernanceRequired && profile.environment !== "UAT") {
      throw new Error("governed demo form connector is only allowed in UAT");
    }
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const addFormats = (addFormatsModule.default ?? addFormatsModule) as unknown as FormatsPlugin;
    addFormats(ajv);
    this.validate = ajv.compile<FormConnectorSubmission>(FORM_SUBMISSION_SCHEMA);
  }

  inspect(input: unknown): FormConnectorInspectionResult {
    return this.normalize(input);
  }

  map(input: unknown, authorizedScope?: FormConnectorAuthorizedScope): FormConnectorMappingResult {
    const normalized = this.normalize(input);
    if (!normalized.ok) return normalized;
    return this.mapInspection(normalized.value, authorizedScope);
  }

  mapInspection(
    inputValue: FormConnectorInspection,
    authorizedScope?: FormConnectorAuthorizedScope,
  ): FormConnectorMappingResult {
    if (this.profile.demoGovernanceRequired && !authorizedScope) {
      return { ok: false, errors: [{
        instancePath: "/demo_invitation_token",
        message: "requires a valid governed UAT demo invitation",
      }] };
    }
    if (authorizedScope && inputValue.claimedPeriod !== authorizedScope.period) {
      return { ok: false, errors: [{
        instancePath: "/period",
        message: "does not match the period fixed by the governed invitation",
      }] };
    }
    const scope = authorizedScope ?? {
      organizationKey: this.profile.organizationKey,
      workflowTemplateKey: this.profile.workflowTemplateKey,
      subjectKey: this.profile.subjectKey,
      subjectDisplayName: this.profile.subjectDisplayName,
      caseKey: [
        this.profile.organizationKey,
        this.profile.workflowTemplateKey,
        this.profile.subjectKey,
        inputValue.claimedPeriod,
      ].join("|"),
      period: inputValue.claimedPeriod,
      timezone: this.profile.timezone,
    };
    return {
      ok: true,
      value: {
        schema_version: "1.0",
        environment: this.profile.environment,
        organization_key: scope.organizationKey,
        workflow_template_key: scope.workflowTemplateKey,
        case_key: scope.caseKey,
        subject: {
          subject_key: scope.subjectKey,
          display_name: scope.subjectDisplayName,
        },
        source: {
          type: this.profile.sourceType,
          connector_key: this.profile.connectorId,
          submission_id: inputValue.providerSubmissionId,
          received_at: inputValue.receivedAt,
          source_reference: `${this.profile.sourceType}://form/${encodeURIComponent(inputValue.providerFormId)}` +
            `/submission/${encodeURIComponent(inputValue.providerSubmissionId)}`,
        },
        business_context: {
          period: scope.period,
          timezone: scope.timezone,
        },
        data_classification: this.profile.environment === "PROD" ? {
          mode: "real_data",
          production_admission_policy_key: this.profile.productionAdmissionPolicyKey!,
        } : { mode: "synthetic_only" },
        files: inputValue.files,
      },
    };
  }

  private normalize(input: unknown): FormConnectorInspectionResult {
    if (isNativeFilloutEnvelope(input)) {
      if (input.formId !== this.profile.providerFormId) {
        return {
          ok: false,
          errors: [{
            instancePath: "/formId",
            message: "does not match the form bound to this connector credential",
          }],
        };
      }
      return this.normalizeNativeFillout(input.submission);
    }
    if (isFilloutMakeBridgeSubmission(input)) return this.normalizeFilloutMakeBridge(input);
    if (isNativeFilloutSubmission(input)) return this.normalizeNativeFillout(input);
    if (!this.validate(input)) {
      return {
        ok: false,
        errors: (this.validate.errors ?? []).map((error) => ({
          instancePath: error.instancePath,
          message: error.message ?? "schema validation failed",
        })),
      };
    }
    const periodPattern = this.profile.demoGovernanceRequired
      ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
      : /^[0-9]{4}-(?:(?:0[1-9]|1[0-2])|Q[1-4])$/;
    if (!periodPattern.test(input.period)) {
      return { ok: false, errors: [{
        instancePath: "/period",
        message: this.profile.demoGovernanceRequired
          ? "must contain the exact governed Case period key"
          : "must use YYYY-MM or YYYY-QN format",
      }] };
    }
    if (input.provider_form_id !== this.profile.providerFormId) {
      return {
        ok: false,
        errors: [{
          instancePath: "/provider_form_id",
          message: "does not match the form bound to this connector credential",
        }],
      };
    }

    return { ok: true, value: {
      providerFormId: input.provider_form_id,
      providerSubmissionId: input.provider_submission_id,
      receivedAt: input.received_at,
      claimedPeriod: input.period,
      invitationToken: input.demo_invitation_token ?? null,
      files: input.files,
    } };
  }

  private normalizeNativeFillout(input: NativeFilloutSubmission): FormConnectorInspectionResult {
    const periodQuestionName = this.profile.periodQuestionName ?? "Accounting period (YYYY-MM)";
    const fileQuestionName = this.profile.fileQuestionName ?? "Accounting documents (PDF, JPG or PNG)";
    const periodQuestion = input.questions.find((question) => question.name === periodQuestionName);
    const periodParameter = input.urlParameters?.find((parameter) => parameter.name === "period");
    const claimedPeriod = this.profile.demoGovernanceRequired
      ? periodParameter?.value
      : typeof periodQuestion?.value === "string" ? periodQuestion.value : periodParameter?.value;
    const claimedPeriodPattern = this.profile.demoGovernanceRequired
      ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
      : /^[0-9]{4}-(?:(?:0[1-9]|1[0-2])|Q[1-4])$/;
    if (typeof claimedPeriod !== "string" || !claimedPeriodPattern.test(claimedPeriod)) {
      return {
        ok: false,
        errors: [{
          instancePath: this.profile.demoGovernanceRequired ? "/urlParameters" : "/questions",
          message: this.profile.demoGovernanceRequired
            ? "must contain the exact governed Case period key"
            : `must contain ${periodQuestionName} in YYYY-MM or YYYY-QN format`,
        }],
      };
    }
    const fileQuestion = input.questions.find((question) => question.name === fileQuestionName);
    const files = fileQuestion ? nativeFiles(fileQuestion) : [];
    if (files.length === 0) {
      return {
        ok: false,
        errors: [{
          instancePath: "/questions",
          message: `must contain at least one HTTPS file in ${fileQuestionName}`,
        }],
      };
    }
    const invitationQuestionName = this.profile.invitationQuestionName ?? "DOP demo invitation token";
    const invitationQuestion = input.questions.find((question) => question.name === invitationQuestionName);
    const invitationParameter = input.urlParameters?.find((parameter) => parameter.name === "dop_invitation");
    const invitationToken = this.profile.demoGovernanceRequired
      ? invitationParameter?.value
      : typeof invitationQuestion?.value === "string" ? invitationQuestion.value : invitationParameter?.value;
    return this.normalize({
      schema_version: "1.0",
      provider_form_id: this.profile.providerFormId,
      provider_submission_id: input.submissionId,
      received_at: input.submissionTime,
      period: claimedPeriod,
      ...(typeof invitationToken === "string" ? {
        demo_invitation_token: invitationToken,
      } : {}),
      files,
    });
  }

  private normalizeFilloutMakeBridge(input: FilloutMakeBridgeSubmission): FormConnectorInspectionResult {
    return this.normalize({
      schema_version: "1.0",
      provider_form_id: input.provider_form_id,
      provider_submission_id: input.provider_submission_id,
      received_at: input.received_at,
      period: input.period,
      ...(input.demo_invitation_token ? { demo_invitation_token: input.demo_invitation_token } : {}),
      files: providerFiles(input.provider_files, input.provider_submission_id),
    });
  }
}

interface FilloutMakeBridgeSubmission {
  connector_bridge_version: "fillout-make-v1" | "fillout-make-v2";
  provider_form_id: string;
  provider_submission_id: string;
  received_at: string;
  period: string;
  demo_invitation_token?: string;
  provider_files: unknown[];
}

interface NativeFilloutQuestion {
  id: string;
  name: string;
  type?: string;
  value: unknown;
}

interface NativeFilloutSubmission {
  submissionId: string;
  submissionTime: string;
  questions: NativeFilloutQuestion[];
  urlParameters?: Array<{
    id: string;
    name: string;
    value: string;
  }>;
}

interface NativeFilloutEnvelope {
  formId: string;
  formName?: string;
  submission: NativeFilloutSubmission;
}

function isNativeFilloutSubmission(input: unknown): input is NativeFilloutSubmission {
  if (!isRecord(input) || typeof input.submissionId !== "string" ||
      typeof input.submissionTime !== "string" || !Array.isArray(input.questions)) return false;
  if (!input.questions.every((question) => isRecord(question) &&
    typeof question.id === "string" && typeof question.name === "string" && "value" in question)) return false;
  return input.urlParameters === undefined || (Array.isArray(input.urlParameters) &&
    input.urlParameters.every((parameter) => isRecord(parameter) &&
      typeof parameter.id === "string" && typeof parameter.name === "string" &&
      typeof parameter.value === "string"));
}

function isNativeFilloutEnvelope(input: unknown): input is NativeFilloutEnvelope {
  return isRecord(input) && typeof input.formId === "string" &&
    isNativeFilloutSubmission(input.submission);
}

function isFilloutMakeBridgeSubmission(input: unknown): input is FilloutMakeBridgeSubmission {
  if (!isRecord(input) || !["fillout-make-v1", "fillout-make-v2"].includes(String(input.connector_bridge_version))) return false;
  const allowed = new Set([
    "connector_bridge_version",
    "provider_form_id",
    "provider_submission_id",
    "received_at",
    "period",
    "demo_invitation_token",
    "provider_files",
  ]);
  return Object.keys(input).every((key) => allowed.has(key)) &&
    typeof input.provider_form_id === "string" &&
    typeof input.provider_submission_id === "string" &&
    typeof input.received_at === "string" &&
    typeof input.period === "string" &&
    (input.demo_invitation_token === undefined || typeof input.demo_invitation_token === "string") &&
    Array.isArray(input.provider_files);
}

function nativeFiles(question: NativeFilloutQuestion): CanonicalSubmission["files"] {
  const values = Array.isArray(question.value) ? question.value : [question.value];
  const files: CanonicalSubmission["files"] = [];
  values.forEach((value, index) => {
    const source = typeof value === "string" ? { url: value } : isRecord(value) ? value : null;
    if (!source) return;
    const url = firstString(source.url, source.downloadUrl, source.download_url);
    if (!url || !/^https:\/\//i.test(url)) return;
    const filename = firstString(source.name, source.filename, source.fileName) ?? filenameFromUrl(url, index);
    const mimeType = firstString(source.mimeType, source.mime_type, source.contentType, source.type) ??
      mimeTypeFromFilename(filename);
    const size = firstInteger(source.size, source.sizeBytes, source.size_bytes);
    files.push({
      source_file_id: `${question.id}:${index}`,
      original_filename: filename,
      download_url: url,
      ...(mimeType?.includes("/") ? { declared_mime_type: mimeType } : {}),
      ...(size === undefined ? {} : { declared_size_bytes: size }),
    });
  });
  return files;
}

function providerFiles(values: unknown[], submissionId: string): CanonicalSubmission["files"] {
  const files: CanonicalSubmission["files"] = [];
  values.forEach((value, index) => {
    const source = typeof value === "string" ? { url: value } : isRecord(value) ? value : null;
    if (!source) return;
    const url = firstString(source.url, source.downloadUrl, source.download_url);
    if (!url || !/^https:\/\//i.test(url)) return;
    const filename = firstString(source.name, source.filename, source.fileName) ?? filenameFromUrl(url, index);
    const mimeType = firstString(source.mimeType, source.mime_type, source.contentType, source.type) ??
      mimeTypeFromFilename(filename);
    const size = firstInteger(source.size, source.sizeBytes, source.size_bytes);
    files.push({
      source_file_id: firstString(source.id, source.fileId, source.file_id) ?? `${submissionId}:${index}`,
      original_filename: filename,
      download_url: url,
      ...(mimeType?.includes("/") ? { declared_mime_type: mimeType } : {}),
      ...(size === undefined ? {} : { declared_size_bytes: size }),
    });
  });
  return files;
}

function filenameFromUrl(value: string, index: number): string {
  try {
    const candidate = decodeURIComponent(new URL(value).pathname.split("/").filter(Boolean).at(-1) ?? "");
    return candidate.slice(0, 500) || `fillout-upload-${index + 1}`;
  } catch {
    return `fillout-upload-${index + 1}`;
  }
}

function mimeTypeFromFilename(filename: string): string | undefined {
  const extension = filename.toLowerCase().split(".").at(-1);
  return {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    csv: "text/csv",
    txt: "text/plain",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }[extension ?? ""];
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function firstInteger(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
