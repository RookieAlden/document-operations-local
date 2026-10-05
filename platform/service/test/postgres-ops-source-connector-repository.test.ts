import { describe, expect, it } from "vitest";
import { compareSourceConnectorDefinitions } from "../src/adapters/postgres/postgres-ops-source-connector-repository.js";

describe("source connector definition comparison", () => {
  it("reports exact capability, secret reference and fixture changes", () => {
    const before = {
      capabilities: ["documents"],
      credentialReference: { provider: "railway", reference: "railway://secret/FORM_TOKEN" },
      testFixtures: [{ fixtureKey: "a", filename: "a.pdf" }],
    };
    const after = {
      capabilities: ["documents", "metadata"],
      credentialReference: { provider: "external_vault", reference: "vault://dop/form-token" },
      testFixtures: [{ fixtureKey: "a", filename: "b.pdf" }],
    };
    expect(compareSourceConnectorDefinitions(before, after).map((item) => item.path)).toEqual([
      "capabilities[1]",
      "credentialReference.provider",
      "credentialReference.reference",
      "testFixtures[0].filename",
    ]);
  });
});
