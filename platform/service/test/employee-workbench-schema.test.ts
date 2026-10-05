import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function sql(path: string) { return await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8"); }

describe("M46 employee workbench database boundary", () => {
  it("keeps staff writes behind atomic security-definer commands and RLS", async () => {
    const migration = await sql("../../database/migrations/059_employee_workbench_client_case_start.sql");
    expect(migration).toContain("CREATE TABLE public.workbench_client_case_commands");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("actor_type IN ('staff','manager','admin')");
    expect(migration).toContain("settings->>'data_classification' <> 'synthetic_only'");
    expect(migration).toContain("subject_row.attributes @> '{\"synthetic\":true}'::jsonb");
    expect(migration).toContain("case_row.config_snapshot @> '{\"synthetic_only\":true}'::jsonb");
    expect(migration).toContain("'Workbench.ClientCaseCreated'");
    expect(migration).toContain("'external_calls',0");
    expect(migration).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)/i);
  });

  it("keeps the live regression rollback-only while proving recovery, invitation and the preserved ABC Case", async () => {
    const verification = await sql("../../database/verification/059_employee_workbench_client_case_start_regression.sql");
    expect(verification.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    expect(verification).toContain("quarterly_period_invalid");
    expect(verification).toContain("idempotency_key_reused");
    expect(verification).toContain("dop_workbench_issue_case_invitation");
    expect(verification).toContain("abc-xinghe-demo-001");
    expect(verification).toContain("'externalSends',0");
    expect(verification).toContain("'persistentSideEffects',0");
  });

  it("provisions one auditable staff identity and keeps a governed deactivation path", async () => {
    const provision = await sql("../../database/operations/uat/003_provision_m46_employee_test_actor.sql");
    const deactivate = await sql("../../database/operations/uat/004_deactivate_m46_employee_test_actor.sql");
    expect(provision).toContain("actor_type='staff'");
    expect(provision).toContain("'Identity.ActorProvisioned'");
    expect(provision).toContain("'advanced_ops_access',false");
    expect(provision).not.toContain("INSERT INTO auth.users");
    expect(deactivate).toContain("dop_change_actor_access");
    expect(deactivate).toContain("'deactivate'");
  });
});
