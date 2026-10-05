import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { postgresPoolConfig } from "../runtime/postgres-pool-config.js";

interface MigrationFile {
  version: string;
  filename: string;
  path: string;
  sql: string;
  sha256: string;
}

const mode = process.argv[2];
const databaseUrl = process.env.DOP_MIGRATION_DATABASE_URL;
const gitCommit = process.env.DOP_MIGRATION_GIT_COMMIT;
const databaseSslCaPath = process.env.DOP_MIGRATION_SSL_CA_PATH;
const migrationDirectory = resolve(option("--migrations-dir") ?? "../database/migrations");
const fromVersion = option("--from");
const throughVersion = option("--through");

if (!databaseUrl) throw new Error("DOP_MIGRATION_DATABASE_URL is required");
if (!/^[0-9a-f]{40}$/.test(gitCommit ?? "")) throw new Error("DOP_MIGRATION_GIT_COMMIT must be a full Git SHA");
if (!["apply", "baseline", "verify"].includes(mode ?? "")) {
  throw new Error("usage: migration-ledger <apply|baseline|verify> [--from NNN] [--through NNN] [--migrations-dir PATH]");
}

const files = select(await loadMigrations(migrationDirectory), fromVersion, throughVersion);
if (!files.length) throw new Error("no migrations selected");
const pool = new Pool(postgresPoolConfig(databaseUrl, databaseSslCaPath, 1));

try {
  if (mode === "apply") await applyMigrations(pool, files, gitCommit!);
  if (mode === "baseline") await baselineMigrations(pool, files, gitCommit!);
  const evidence = await verifyLedger(pool, files, !fromVersion && !throughVersion);
  process.stdout.write(`${JSON.stringify({ mode, gitCommit, migrationDirectory, ...evidence }, null, 2)}\n`);
} finally {
  await pool.end();
}

async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => /^\d{3}_[A-Za-z0-9._-]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(names.map(async (filename) => {
    const path = resolve(directory, filename);
    const sql = await readFile(path, "utf8");
    return { version: filename.slice(0, 3), filename, path, sql, sha256: createHash("sha256").update(sql).digest("hex") };
  }));
  const versions = new Set<string>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error(`duplicate migration version ${migration.version}`);
    versions.add(migration.version);
  }
  return migrations;
}

function select(files: MigrationFile[], from?: string, through?: string): MigrationFile[] {
  if (from && !/^\d{3}$/.test(from)) throw new Error("--from must be NNN");
  if (through && !/^\d{3}$/.test(through)) throw new Error("--through must be NNN");
  return files.filter((file) => (!from || file.version >= from) && (!through || file.version <= through));
}

async function applyMigrations(pool: Pool, migrations: MigrationFile[], commit: string): Promise<void> {
  for (const migration of migrations) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ledgerExists = await hasLedger(client);
      if (!ledgerExists && migration.version !== "036") {
        throw new Error("migration 036 must bootstrap the ledger before later migrations are applied");
      }
      if (ledgerExists) {
        const existing = await ledgerRow(client, migration.version);
        if (existing) {
          if (existing.sha256 !== migration.sha256 || existing.filename !== migration.filename) {
            throw new Error(`checksum drift for migration ${migration.version}`);
          }
          await client.query("ROLLBACK");
          continue;
        }
      }
      await client.query(transactionBody(migration.sql));
      await client.query(
        `INSERT INTO public.dop_schema_migration_ledger
           (version,filename,sha256,execution_mode,git_commit,applied_by,evidence_note)
         VALUES ($1,$2,$3,'applied',$4,current_user,$5)`,
        [migration.version, migration.filename, migration.sha256, commit,
          "Applied transactionally by the checked-in migration ledger runner."],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function baselineMigrations(pool: Pool, migrations: MigrationFile[], commit: string): Promise<void> {
  if (process.env.DOP_MIGRATION_BASELINE_CONFIRMED !== "true") {
    throw new Error("DOP_MIGRATION_BASELINE_CONFIRMED=true is required for a historical baseline");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!await hasLedger(client)) throw new Error("migration ledger is not installed");
    for (const migration of migrations) {
      const existing = await ledgerRow(client, migration.version);
      if (existing) {
        if (existing.sha256 !== migration.sha256 || existing.filename !== migration.filename) {
          throw new Error(`checksum drift for migration ${migration.version}`);
        }
        continue;
      }
      await client.query(
        `INSERT INTO public.dop_schema_migration_ledger
           (version,filename,sha256,execution_mode,git_commit,applied_by,evidence_note)
         VALUES ($1,$2,$3,'baseline_verified',$4,current_user,$5)`,
        [migration.version, migration.filename, migration.sha256, commit,
          "Historical migration attested after full schema, RLS and UAT regression at the M40.1 head."],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function verifyLedger(
  pool: Pool,
  migrations: MigrationFile[],
  rejectUnexpected: boolean,
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    if (!await hasLedger(client)) throw new Error("migration ledger is not installed");
    const result = await client.query<{
      version: string; filename: string; sha256: string; execution_mode: string; git_commit: string; applied_at: Date | string;
    }>(`SELECT version,filename,sha256,execution_mode,git_commit,applied_at
          FROM public.dop_schema_migration_ledger ORDER BY version`);
    const expected = new Map(migrations.map((migration) => [migration.version, migration]));
    const mismatches = result.rows.filter((row) => {
      const file = expected.get(row.version);
      return file && (file.filename !== row.filename || file.sha256 !== row.sha256);
    });
    const missing = migrations.filter((file) => !result.rows.some((row) => row.version === file.version));
    const unexpected = rejectUnexpected ? result.rows.filter((row) => !expected.has(row.version)) : [];
    if (mismatches.length || missing.length || unexpected.length) {
      throw new Error(
        `migration ledger verification failed: ${mismatches.length} mismatches, ${missing.length} missing, ${unexpected.length} unexpected`,
      );
    }
    return {
      ledgerVerified: true,
      ledgerRowCount: result.rows.length,
      selectedFileCount: migrations.length,
      firstVersion: result.rows[0]?.version ?? null,
      lastVersion: result.rows.at(-1)?.version ?? null,
      appliedCount: result.rows.filter((row) => row.execution_mode === "applied").length,
      baselineVerifiedCount: result.rows.filter((row) => row.execution_mode === "baseline_verified").length,
      commits: [...new Set(result.rows.map((row) => row.git_commit))],
    };
  } finally {
    client.release();
  }
}

async function hasLedger(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ relation: string | null }>("SELECT to_regclass('public.dop_schema_migration_ledger')::text AS relation");
  return result.rows[0]?.relation === "dop_schema_migration_ledger";
}

async function ledgerRow(client: PoolClient, version: string): Promise<{ filename: string; sha256: string } | null> {
  const result = await client.query<{ filename: string; sha256: string }>(
    "SELECT filename,sha256 FROM public.dop_schema_migration_ledger WHERE version=$1", [version],
  );
  return result.rows[0] ?? null;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function transactionBody(sql: string): string {
  const withoutBegin = sql.replace(/^\s*BEGIN\s*;\s*/i, "");
  const withoutCommit = withoutBegin.replace(/\s*COMMIT\s*;\s*$/i, "");
  if (withoutBegin === sql || withoutCommit === withoutBegin) {
    throw new Error("migration must have one outer BEGIN/COMMIT boundary");
  }
  return withoutCommit;
}
