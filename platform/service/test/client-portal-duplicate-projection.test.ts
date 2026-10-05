import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("M45.2 client portal duplicate projection migration", () => {
  it("projects checklist counts and duplicate labels from the latest completeness assessment", async () => {
    const migrationPath = fileURLToPath(new URL(
      "../../database/migrations/056_client_portal_acknowledged_duplicate_projection.sql",
      import.meta.url,
    ));
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("latest_match_assessment_id");
    expect(sql).toContain("m.assessment_id=latest_match_assessment_id");
    expect(sql).toContain("m.match_status='matched' AND m.counts_toward_minimum");
    expect(sql).toContain("latest_match.match_status='duplicate'");
    expect(sql).toContain("'duplicate_not_counted'");
    expect(sql).toContain("d.status='excluded' THEN 'not_counted'");
  });
});
