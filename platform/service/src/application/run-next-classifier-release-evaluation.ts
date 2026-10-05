import { createHash } from "node:crypto";
import { MODEL_OUTPUT_SCHEMA_HASH } from "../adapters/openai/openai-classification-provider.js";
import type { ClassificationProvider } from "../ports/classification-provider.js";
import type { ClassifierReleaseEvaluationWorkRepository } from "../ports/ops-classifier-release-repository.js";

export class RunNextClassifierReleaseEvaluation {
  constructor(
    private readonly repository: ClassifierReleaseEvaluationWorkRepository,
    private readonly provider: ClassificationProvider,
  ) {}

  async runNext(request: { organizationKey: string; workerId: string; now: Date }): Promise<boolean> {
    const evaluation = await this.repository.claimNext({
      organizationKey: request.organizationKey,
      workerId: request.workerId,
      leaseSeconds: 1_800,
      now: request.now,
    });
    if (!evaluation) return false;
    try {
      const definition = evaluation.definition;
      if (definition.promptInstructionHash !== createHash("sha256").update(definition.promptInstructions).digest("hex") ||
          definition.responseSchemaVersion !== "1.0" || definition.responseSchemaHash !== MODEL_OUTPUT_SCHEMA_HASH) {
        await this.repository.fail({ evaluation, errorCode: "release_contract_mismatch", now: new Date() });
        return true;
      }
      const providerResults = await mapWithConcurrency(definition.providerEvaluationCases, 3, async (testCase) => {
        const response = await this.provider.classify({
          documentId: `synthetic:${evaluation.releaseVersionId}:${testCase.caseKey}`,
          filename: testCase.filename,
          declaredMimeType: testCase.mimeType,
          allowedDocumentTypes: evaluation.allowedDocumentTypes,
          source: { kind: "text", text: testCase.inputText },
          expectedSubjectReferences: ["SYNTHETIC-EVALUATION"],
          expectedPeriod: null,
          execution: {
            model: definition.model,
            prompt: definition.promptInstructions,
            promptInstructionHash: definition.promptInstructionHash,
            responseSchemaVersion: definition.responseSchemaVersion,
            responseSchemaHash: definition.responseSchemaHash,
            maxOutputTokens: definition.requestPolicy.maxOutputTokens,
            reasoningEffort: definition.requestPolicy.reasoningEffort,
          },
        });
        const passed = response.result.predicted_document_type_code === testCase.expectedLabelCode &&
          response.result.confidence >= testCase.minimumConfidence;
        return { testCase, response, passed };
      });
      const caseResults = providerResults.map(({ testCase, response, passed }) => ({
        caseKey: testCase.caseKey,
        expectedLabelCode: testCase.expectedLabelCode,
        actualLabelCode: response.result.predicted_document_type_code,
        minimumConfidence: testCase.minimumConfidence,
        actualConfidence: response.result.confidence,
        passed,
        responseId: response.audit.responseId,
        resolvedModel: response.audit.model,
      }));
      const responseIds = providerResults.map(({ response }) => response.audit.responseId);
      const resolvedModels = new Set(providerResults.map(({ response }) => response.audit.model));
      const inputTokenCountComplete = providerResults.every(({ response }) => response.audit.inputTokens !== null);
      const outputTokenCountComplete = providerResults.every(({ response }) => response.audit.outputTokens !== null);
      const inputTokens = providerResults.reduce((total, { response }) => total + (response.audit.inputTokens ?? 0), 0);
      const outputTokens = providerResults.reduce((total, { response }) => total + (response.audit.outputTokens ?? 0), 0);
      const passedCases = caseResults.filter((item) => item.passed === true).length;
      const passed = passedCases === caseResults.length && caseResults.length >= 3;
      await this.repository.complete({
        evaluation,
        status: passed ? "passed" : "failed",
        result: {
          passed,
          definitionHash: evaluation.definitionHash,
          totalCases: caseResults.length,
          passedCases,
          failedCases: caseResults.length - passedCases,
          caseResults,
          providerCallCount: responseIds.length,
          configuredModel: definition.model,
          resolvedModels: [...resolvedModels],
          inputTokens: inputTokenCountComplete ? inputTokens : null,
          outputTokens: outputTokenCountComplete ? outputTokens : null,
          persistedDocuments: false,
          externalDelivery: "disabled",
        },
        now: new Date(),
      });
    } catch (error) {
      await this.repository.fail({ evaluation, errorCode: safeErrorCode(error), now: new Date() });
    }
    return true;
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length && firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await task(items[index]!);
      } catch (error) {
        firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return "provider_evaluation_failed";
}
