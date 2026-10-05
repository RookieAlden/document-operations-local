import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export const LOCAL_MARKER = "dop-local-persistence-stage1";
export const LOCAL_ORGANIZATION = "dev-accounting-firm";
export interface LocalConfig {
  marker: typeof LOCAL_MARKER;
  initialized: boolean;
  appPort: number;
  databasePort: number;
  databasePassword: string;
  adminPassword: string;
  sessionSecret: string;
  pgBin: string;
  configHome: string;
}
export async function loadLocalConfig(directory: string): Promise<LocalConfig> {
  const home = resolve(directory);
  if (await realpath(home) !== home) throw new Error("local_home_symlink_not_allowed");
  const config = JSON.parse(await readFile(join(home, "runtime.json"), "utf8")) as LocalConfig;
  if (config.marker !== LOCAL_MARKER || !config.initialized
      || ![config.appPort, config.databasePort].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535)
      || config.appPort === config.databasePort || !/^[a-f0-9]{64}$/.test(config.databasePassword)
      || !/^[a-f0-9]{64}$/.test(config.sessionSecret)) throw new Error("invalid_local_runtime_config");
  return config;
}
