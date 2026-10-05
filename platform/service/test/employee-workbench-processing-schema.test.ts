import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function sql(path: string) { return await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8"); }

describe("M47 employee processing database boundary", () => {
  it("stores formal task fields and keeps completion atomic and replay-safe", async () => {
    const migration = await sql("../../database/migrations/060_employee_workbench_processing_loop.sql");
    for (const column of ["name text", "instructions text", "completion_criteria text"]) expect(migration).toContain(column);
    expect(migration).toContain("scope='case.complete'");
    expect(migration).toContain("task_key='case-handoff|'");
    expect(migration).toContain("status='published'");
    expect(migration).toContain("actor_type IN ('staff','manager','admin')");
    expect(migration).toContain("case_row.config_snapshot @> '{\"synthetic_only\":true}'::jsonb");
    expect(migration).toContain("'externalCallCount',0");
    expect(migration).toContain("dop_workbench_publish_client_question");
    expect(migration).toContain("dop_workbench_resolve_client_question");
    expect(migration).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)/i);
  });

  it("permits daily staff exclusion but reserves reopening accepted files and protects closed Cases", async () => {
    const repository = await sql("../src/adapters/postgres/postgres-ops-review-repository.ts");
    expect(repository).toContain('request.action === "reopen" && staff && document.status !== "excluded"');
    expect(repository).toContain('reason: "case_closed"');
    const migration = await sql("../../database/migrations/064_m48_employee_exclusion_case_lock.sql");
    expect(migration).toContain('c.organization_id=org_id');
    expect(migration).toContain('organization_id=org_id AND status=\'active\'');
    expect(migration).toContain('FOR UPDATE OF c');
    expect(migration).toContain('FROM PUBLIC');
    expect(migration).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)/i);
  });
});
