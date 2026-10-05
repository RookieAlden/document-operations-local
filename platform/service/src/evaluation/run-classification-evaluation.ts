import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { OpenAIClassificationProvider } from "../adapters/openai/openai-classification-provider.js";
import { loadClassificationRuntimeConfig } from "../runtime/classification-config.js";
import { decideClassification, effectiveConflictFlags } from "../application/classify-document.js";

interface EvaluationFixture {
  fixture_id: string;
  path: string;
  mime_type: string;
  subject_key: string;
  subject_display_name: string;
  expected_period: string;
  expected_document_type_code: string;
  acceptable_document_type_codes?: string[];
  expected_conflict_flags: string[];
  required_conflict_flags?: string[];
  required_quality_flags?: string[];
  allow_additional_conflict_flags?: boolean;
  required_any_review_signal?: boolean;
  always_human_review: boolean;
  expected_route?: "accepted" | "review_required";
}

interface EvaluationManifest {
  manifest_version: string;
  environment: "DEV";
  data_classification: "synthetic_only";
  allowed_document_type_codes: string[];
  fixtures: EvaluationFixture[];
}

const serviceDirectory = process.cwd();
const workspaceRoot = resolve(serviceDirectory, "../..");
const manifestPath = resolve(
  workspaceRoot,
  "platform/tests/fixtures/classification-evaluation-manifest.json",
);
const promptPath = resolve(workspaceRoot, "platform/prompts/document-classifier/v1.md");
const outputPath = resolve(
  workspaceRoot,
  "output/evaluation/classification-evaluation-latest.json",
);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as EvaluationManifest;
if (manifest.environment !== "DEV" || manifest.data_classification !== "synthetic_only") {
  throw new Error("Evaluation runner accepts only explicitly synthetic DEV manifests");
}

const evaluationEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? readOpenAIDevKeyFromMacOSKeychain(),
};
const config = loadClassificationRuntimeConfig(evaluationEnvironment, promptPath);
const provider = new OpenAIClassificationProvider({
  apiKey: config.openAIApiKey,
  model: config.openAIModel,
  prompt: config.prompt,
  timeoutMs: config.timeoutMs,
});

const allowedDocumentTypes = manifest.allowed_document_type_codes.map((code) => ({
  code,
  displayName: code.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" "),
}));
const results: Array<Record<string, unknown>> = [];
let passed = 0;
let totalInputTokens = 0;
let totalOutputTokens = 0;

for (const fixture of manifest.fixtures) {
  const absolutePath = resolve(workspaceRoot, fixture.path);
  const bytes = readFileSync(absolutePath);
  const source = fixture.mime_type === "application/pdf"
    ? {
        kind: "file_data" as const,
        filename: basename(absolutePath),
        mimeType: fixture.mime_type,
        base64: bytes.toString("base64"),
      }
    : {
        kind: "image_url" as const,
        imageUrl: `data:${fixture.mime_type};base64,${bytes.toString("base64")}`,
        detail: "high" as const,
      };
  try {
    const response = await provider.classify({
      documentId: fixture.fixture_id,
      filename: basename(absolutePath),
      declaredMimeType: fixture.mime_type,
      allowedDocumentTypes,
      source,
      expectedSubjectReferences: [fixture.subject_key, fixture.subject_display_name],
      expectedPeriod: fixture.expected_period,
    });
    if (response.result.schema_version !== "1.0" || response.result.predicted_document_type_code === null) throw new Error("legacy_evaluation_requires_v1");
    const acceptableTypes = fixture.acceptable_document_type_codes ?? [fixture.expected_document_type_code];
    const typePassed = acceptableTypes.includes(response.result.predicted_document_type_code);
    const conflictFlagsPassed = fixture.allow_additional_conflict_flags
      ? containsEvery(response.result.conflict_flags, fixture.required_conflict_flags ?? fixture.expected_conflict_flags)
      : sameStringSet(fixture.expected_conflict_flags, response.result.conflict_flags);
    const qualityFlagsPassed = containsEvery(
      response.result.quality_flags,
      fixture.required_quality_flags ?? [],
    );
    const effectiveFlags = effectiveConflictFlags(
      fixture.expected_period,
      response.result.detected_period,
      response.result.conflict_flags,
    );
    const decision = decideClassification({
      id: fixture.fixture_id,
      code: response.result.predicted_document_type_code,
      displayName: response.result.predicted_document_type_code,
      minimumConfidence: 0.8,
      alwaysHumanConfirm: fixture.always_human_review,
      manualOnConflict: true,
      rejectOnQualityFlags: ["blurry", "blank", "corrupt", "partial", "password_protected", "unsupported", "mime_mismatch", "other"],
      rejectOnConflictFlags: ["subject_conflict", "period_conflict", "document_type_conflict", "duplicate_suspected", "other"],
    }, {
      confidence: response.result.confidence,
      quality_flags: response.result.quality_flags,
      conflict_flags: effectiveFlags,
    });
    const routePassed = fixture.expected_route === undefined || decision.status === fixture.expected_route;
    const reviewSignalPassed = !fixture.required_any_review_signal || decision.status === "review_required";
    const fixturePassed = typePassed && conflictFlagsPassed && qualityFlagsPassed && routePassed && reviewSignalPassed;
    if (fixturePassed) passed += 1;
    totalInputTokens += response.audit.inputTokens ?? 0;
    totalOutputTokens += response.audit.outputTokens ?? 0;
    results.push({
      fixture_id: fixture.fixture_id,
      passed: fixturePassed,
      expected_document_type_code: fixture.expected_document_type_code,
      acceptable_document_type_codes: acceptableTypes,
      actual_document_type_code: response.result.predicted_document_type_code,
      expected_conflict_flags: fixture.expected_conflict_flags,
      actual_conflict_flags: response.result.conflict_flags,
      required_quality_flags: fixture.required_quality_flags ?? [],
      confidence: response.result.confidence,
      quality_flags: response.result.quality_flags,
      expected_route: fixture.expected_route ?? null,
      actual_route: decision.status,
      review_reasons: decision.reviewReasons,
      always_human_review: fixture.always_human_review,
      response_id: response.audit.responseId,
      model: response.audit.model,
      input_tokens: response.audit.inputTokens,
      output_tokens: response.audit.outputTokens,
    });
  } catch (error) {
    results.push({
      fixture_id: fixture.fixture_id,
      passed: false,
      error_code: isCodedError(error) ? error.code : "unexpected_error",
      error_message: error instanceof Error ? error.message : "Unknown error",
      ...(isProviderDiagnostic(error) ? {
        provider_code: error.providerCode ?? null,
        provider_type: error.providerType ?? null,
        provider_param: error.providerParam ?? null,
        provider_message: error.providerMessage ?? null,
      } : {}),
    });
  }
}

const report = {
  report_version: "1.0",
  manifest_version: manifest.manifest_version,
  environment: manifest.environment,
  generated_at: new Date().toISOString(),
  model_requested: config.openAIModel,
  summary: {
    passed,
    failed: manifest.fixtures.length - passed,
    total: manifest.fixtures.length,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
  },
  results,
};

mkdirSync(resolve(outputPath, ".."), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report.summary));
console.log(`Evaluation report written to ${outputPath}`);
if (passed !== manifest.fixtures.length) process.exitCode = 1;

function isCodedError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code?: unknown }).code === "string";
}

function sameStringSet(expected: string[], actual: string[]): boolean {
  return expected.length === actual.length &&
    [...expected].sort().every((value, index) => value === [...actual].sort()[index]);
}

function containsEvery(actual: string[], required: string[]): boolean {
  return required.every((value) => actual.includes(value));
}

function isProviderDiagnostic(error: unknown): error is {
  providerCode?: string;
  providerType?: string;
  providerParam?: string;
  providerMessage?: string;
} {
  return typeof error === "object" && error !== null &&
    ("providerCode" in error || "providerType" in error || "providerParam" in error ||
      "providerMessage" in error);
}

function readOpenAIDevKeyFromMacOSKeychain(): string {
  if (process.platform !== "darwin") {
    throw new Error("OPENAI_API_KEY is required outside macOS");
  }
  const value = execFileSync("/usr/bin/security", [
    "find-generic-password",
    "-a", "openai-dev",
    "-s", "dop-openai-dev",
    "-w",
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!value) throw new Error("OpenAI DEV Keychain entry is empty");
  return value;
}
