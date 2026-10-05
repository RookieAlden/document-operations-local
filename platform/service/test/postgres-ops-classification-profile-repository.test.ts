import { describe, expect, it } from "vitest";
import { compareClassificationProfileDefinitions } from "../src/adapters/postgres/postgres-ops-classification-profile-repository.js";

describe("Classification Profile definition comparison", () => {
  it("reports label policy and extraction field changes with stable paths", () => {
    const result = compareClassificationProfileDefinitions(
      { labels: [{ code: "bank_statement", policy: { minimumConfidence: 0.8 }, extractionFields: [] }] },
      { labels: [{ code: "bank_statement", policy: { minimumConfidence: 0.9 }, extractionFields: [{ key: "account_number" }] }, { code: "compliance_certificate" }] },
    );
    expect(result).toEqual(expect.arrayContaining([
      { path: "labels[0].policy.minimumConfidence", before: 0.8, after: 0.9, kind: "changed" },
      { path: "labels[0].extractionFields[0]", before: undefined, after: { key: "account_number" }, kind: "added" },
      { path: "labels[1]", before: undefined, after: { code: "compliance_certificate" }, kind: "added" },
    ]));
  });

  it("returns no differences for an identical governed definition", () => {
    const definition = { environment: "DEV", unknownDocumentRoute: "review_required", labels: [] };
    expect(compareClassificationProfileDefinitions(definition, structuredClone(definition))).toEqual([]);
  });
});
