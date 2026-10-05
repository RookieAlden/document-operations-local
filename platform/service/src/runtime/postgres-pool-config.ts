import { readFileSync } from "node:fs";
import type { PoolConfig } from "pg";

export function postgresPoolConfig(
  connectionString: string,
  sslCaPath?: string,
  maximumConnections = 5,
): PoolConfig {
  if (!connectionString) throw new Error("PostgreSQL connection string is required");
  if (!Number.isInteger(maximumConnections) || maximumConnections < 1) {
    throw new Error("PostgreSQL maximum connections must be a positive integer");
  }
  return {
    connectionString: sslCaPath ? withoutConnectionStringTlsOptions(connectionString) : connectionString,
    max: maximumConnections,
    ...(sslCaPath
      ? { ssl: { ca: readFileSync(sslCaPath, "utf8"), rejectUnauthorized: true } }
      : {}),
  };
}

function withoutConnectionStringTlsOptions(connectionString: string): string {
  const parsed = new URL(connectionString);
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    parsed.searchParams.delete(parameter);
  }
  return parsed.toString();
}
