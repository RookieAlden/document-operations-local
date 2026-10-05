import { describe, expect, it } from "vitest";
import { compareClassifierReleaseDefinitions } from "../src/adapters/postgres/postgres-ops-classifier-release-repository.js";

describe("classifier release definition comparison", () => {
  it("reports exact nested Prompt, model and evaluation-case changes", () => {
    const before = { model: "gpt-5.6", promptInstructions: "v1", requestPolicy: { reasoningEffort: "low" }, cases: [{ key: "a" }] };
    const after = { model: "gpt-5.6-snapshot", promptInstructions: "v2", requestPolicy: { reasoningEffort: "medium" }, cases: [{ key: "a" }, { key: "b" }] };
    expect(compareClassifierReleaseDefinitions(before, after).map((item) => item.path)).toEqual([
      "cases[1]", "model", "promptInstructions", "requestPolicy.reasoningEffort",
    ]);
  });
});
