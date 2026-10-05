import { describe, expect, it } from "vitest";
import { manifestDiff, validateManifest } from "../src/adapters/postgres/postgres-ops-configuration-repository.js";
import type { WorkConfigurationManifest } from "../src/ports/ops-configuration-repository.js";

const baseline: WorkConfigurationManifest = {
  subject: {
    displayName: "Synthetic Client Limited", subjectType: "accounting_client", status: "active",
    primaryContactActorId: null, attributes: { frequency: "monthly", synthetic: true },
  },
  workflow: { frequency: "monthly", external_messages_require_approval: true },
  requirements: [{ code: "bank.minimum", documentTypeCode: "bank_statement", minimumCount: 1, maximumCount: null, acceptanceRule: {} }],
};

describe("work configuration validation and differences", () => {
  it("accepts a complete generic manifest and reports no changes against its base", () => {
    expect(validateManifest(baseline, ["bank_statement"])).toEqual([]);
    expect(manifestDiff(baseline, structuredClone(baseline))).toEqual(["与基准版本相同"]);
  });

  it("reports structural changes without depending on accounting-only fields", () => {
    const changed = structuredClone(baseline);
    changed.subject.status = "paused";
    changed.requirements[0]!.minimumCount = 2;
    changed.requirements.push({ code: "invoice.minimum", documentTypeCode: "invoice", minimumCount: 4, maximumCount: 20, acceptanceRule: {} });
    expect(manifestDiff(baseline, changed)).toEqual(["客户状态", "新增 1 项资料要求", "修改 1 项资料要求"]);
  });

  it("rejects duplicate document types, unknown references and invalid count ranges", () => {
    const invalid = structuredClone(baseline);
    invalid.requirements.push({ code: "bank.extra", documentTypeCode: "bank_statement", minimumCount: 5, maximumCount: 2, acceptanceRule: {} });
    expect(validateManifest(invalid, ["bank_statement"])).toContain("资料类型 bank_statement 不能重复");
    expect(validateManifest(invalid, ["bank_statement"])).toContain("bank.extra 的数量范围无效");
    invalid.requirements[1]!.documentTypeCode = "unknown";
    expect(validateManifest(invalid, ["bank_statement"])).toContain("资料类型 unknown 不存在或未启用");
  });
});
