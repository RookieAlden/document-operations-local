import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalLogin } from "./fixed-login.js";
export const LOCAL_AI_MODEL = "gpt-5.6-sol";
export interface PersonalSettings {
  login: LocalLogin;
  ai: { enabled: boolean; apiKey: string; model: string; budgetUsd: number; maxCalls: number };
}
export async function loadPersonalSettings(directory: string): Promise<PersonalSettings> {
  const settings=JSON.parse(await readFile(join(directory,"settings.json"),"utf8")) as PersonalSettings;
  if (!settings.login || !/^[a-zA-Z0-9._-]{2,80}$/.test(settings.login.username)
      || typeof settings.login.salt!=="string" || !/^[a-f0-9]{128}$/.test(settings.login.verifier))
    throw new Error("invalid_personal_login_settings");
  if (!settings.ai || settings.ai.model!==LOCAL_AI_MODEL || typeof settings.ai.apiKey!=="string"
      || !Number.isFinite(settings.ai.budgetUsd) || settings.ai.budgetUsd<0
      || !Number.isInteger(settings.ai.maxCalls) || settings.ai.maxCalls<0)
    throw new Error("invalid_personal_ai_settings");
  return settings;
}
