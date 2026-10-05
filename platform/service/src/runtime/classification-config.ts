import { readFileSync } from "node:fs";

export interface ClassificationRuntimeConfig {
  openAIApiKey: string;
  openAIModel: string;
  prompt: string;
  timeoutMs: number;
}

export function loadClassificationRuntimeConfig(
  env: NodeJS.ProcessEnv,
  promptPath: string,
): ClassificationRuntimeConfig {
  const openAIApiKey = required(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  const openAIModel = required(env.OPENAI_CLASSIFICATION_MODEL, "OPENAI_CLASSIFICATION_MODEL");
  const timeoutMs = Number(env.OPENAI_TIMEOUT_MS ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("OPENAI_TIMEOUT_MS must be an integer from 1000 to 300000");
  }
  const prompt = readFileSync(promptPath, "utf8");
  if (!prompt.trim()) throw new Error("Classification prompt file must not be empty");
  return { openAIApiKey, openAIModel, prompt, timeoutMs };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
