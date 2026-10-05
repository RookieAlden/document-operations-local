import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { postgresPoolConfig } from "../src/runtime/postgres-pool-config.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("postgresPoolConfig", () => {
  it("loads a CA and keeps certificate verification enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "dop-pg-ca-"));
    roots.push(root);
    const caPath = join(root, "root.crt");
    writeFileSync(caPath, "test-ca");
    expect(postgresPoolConfig("postgresql://db.test/postgres", caPath, 1)).toEqual({
      connectionString: "postgresql://db.test/postgres",
      max: 1,
      ssl: { ca: "test-ca", rejectUnauthorized: true },
    });
  });

  it("prevents connection-string TLS flags from overriding an explicit verified CA", () => {
    const root = mkdtempSync(join(tmpdir(), "dop-pg-ca-"));
    roots.push(root);
    const caPath = join(root, "root.crt");
    writeFileSync(caPath, "test-ca");
    expect(postgresPoolConfig(
      "postgresql://db.test/postgres?sslmode=require&sslrootcert=provider.crt&application_name=dop",
      caPath,
      1,
    )).toEqual({
      connectionString: "postgresql://db.test/postgres?application_name=dop",
      max: 1,
      ssl: { ca: "test-ca", rejectUnauthorized: true },
    });
  });

  it("does not silently enable insecure TLS when no CA is configured", () => {
    expect(postgresPoolConfig("postgresql://localhost/postgres")).toEqual({
      connectionString: "postgresql://localhost/postgres",
      max: 5,
    });
  });
});
