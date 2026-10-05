import { describe, expect, it } from "vitest";
import { compareValues } from "../src/adapters/postgres/postgres-ops-work-package-repository.js";

describe("Work Package definition comparison", () => {
  it("reports stable nested paths for changed, added and removed fields", () => {
    const result = compareValues(
      {
        workflow: { frequency: "monthly", legacy: true },
        requirements: [{ code: "bank.minimum", minimumCount: 1 }],
      },
      {
        workflow: { frequency: "quarterly", safety: "approval" },
        requirements: [{ code: "bank.minimum", minimumCount: 3 }, { code: "invoice.minimum" }],
      },
    );
    expect(result).toEqual(expect.arrayContaining([
      { path: "workflow.frequency", before: "monthly", after: "quarterly", kind: "changed" },
      { path: "workflow.legacy", before: true, after: undefined, kind: "removed" },
      { path: "workflow.safety", before: undefined, after: "approval", kind: "added" },
      { path: "requirements[0].minimumCount", before: 1, after: 3, kind: "changed" },
      { path: "requirements[1]", before: undefined, after: { code: "invoice.minimum" }, kind: "added" },
    ]));
  });

  it("returns no differences for an identical immutable definition", () => {
    const definition = { subjectDefaults: { status: "active" }, requirements: [] };
    expect(compareValues(definition, structuredClone(definition))).toEqual([]);
  });
});
