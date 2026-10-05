import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function sql(relativePath: string): Promise<string> {
  return await readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("synthetic Case entry eligibility repair", () => {
  it("propagates only the explicit JSON boolean Subject boundary into new Cases", async () => {
    const migration = await sql("../../database/migrations/058_propagate_synthetic_case_boundary.sql");

    expect(migration).toContain(`subject.attributes @> '{"synthetic":true}'::jsonb`);
    expect(migration).toContain("THEN jsonb_build_object('synthetic_only', true)");
    expect(migration).toContain("ELSE '{}'::jsonb");
    expect(migration).toContain("'synthetic_boundary_source', 'subject.attributes.synthetic_json_boolean'");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.dop_create_case_from_configuration");
  });

  it("backfills only the exact empty ABC Xinghe UAT Case and appends an audit event", async () => {
    const operation = await sql("../../database/operations/uat/002_backfill_abc_xinghe_2026_q4_synthetic_marker.sql");

    expect(operation).toContain("subject_key = 'abc-xinghe-demo-001'");
    expect(operation).toContain("subject_row.display_name <> 'ABC 星河咨询有限公司'");
    expect(operation).toContain("c.period_start = DATE '2026-10-01'");
    expect(operation).toContain("c.period_end = DATE '2026-12-31'");
    expect(operation).toContain("related_submissions <> 0 OR related_documents <> 0 OR related_invitations <> 0");
    expect(operation).toContain("'Case.SyntheticMarkerBackfilled'");
    expect(operation).toContain("'invitationCreated', false");
    expect(operation).toContain("'fileUploaded', false");
  });

  it("keeps the end-to-end regression rollback-only and checks the negative boundary", async () => {
    const verification = await sql("../../database/verification/058_synthetic_case_entry_eligibility_regression.sql");

    expect(verification.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    expect(verification).toContain("dop_onboard_subject_from_package");
    expect(verification).toContain("dop_transition_configuration_release");
    expect(verification).toContain("dop_create_case_from_configuration");
    expect(verification).toContain("dop_issue_demo_case_invitation");
    expect(verification).toContain("'eligibleForClientEntry', true");
    expect(verification).toContain("'nonSyntheticFailedClosed', true");
    expect(verification).toContain("'persistentSideEffects', 0");
  });
});
