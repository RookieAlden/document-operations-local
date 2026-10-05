import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContractValidator } from "../src/contracts/json-schema-validator.js";
import {
  IndustryPackageError,
  loadIndustryPackage,
  validateIndustryPackageReferences,
} from "../src/config/load-industry-package.js";

function readJson(relativeUrl: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8"));
}

describe("versioned contracts", () => {
  const validator = new ContractValidator();

  it("accepts the accounting industry package example", () => {
    const input = readJson("../../config/examples/accounting-monthly-v1.json");
    expect(validator.validateIndustryPackage(input)).toMatchObject({ ok: true });
  });

  it("accepts the canonical submission fixture", () => {
    const input = readJson("../../tests/fixtures/accounting-submission-valid.json");
    expect(validator.validateSubmission(input)).toMatchObject({ ok: true });
  });

  it("requires a policy key when a canonical submission claims real data", () => {
    const input = readJson("../../tests/fixtures/accounting-submission-valid.json") as Record<string, unknown>;
    input.environment = "PROD";
    input.data_classification = { mode: "real_data" };
    expect(validator.validateSubmission(input)).toMatchObject({ ok: false });
    input.data_classification = {
      mode: "real_data",
      production_admission_policy_key: "prod.blue-peak.2026-q3",
    };
    expect(validator.validateSubmission(input)).toMatchObject({ ok: true });
  });

  it("accepts a canonical classification result", () => {
    expect(validator.validateClassificationResult({
      schema_version: "1.0",
      predicted_document_type_code: "bank_statement",
      confidence: 0.9,
      reason: "Statement period and transaction table are visible.",
      detected_subject_references: ["DEV-CLIENT-001"],
      detected_period: "2026-07",
      quality_flags: [],
      conflict_flags: [],
      extracted_fields: { closing_balance: 1250.5 },
      evidence: [{ label: "period", value: "July 2026", page: 1 }],
    })).toMatchObject({ ok: true });
  });

  it("rejects unsafe package settings", () => {
    const input = readJson("../../config/examples/accounting-monthly-v1.json") as Record<string, unknown>;
    input.notifications = {
      external_messages_require_approval: false,
      send_from: "personal_mailbox",
      recipient_source: "hardcoded",
      dev_recipient_policy: "anyone",
    };
    expect(validator.validateIndustryPackage(input)).toMatchObject({ ok: false });
  });

  it("loads a frozen package with a stable definition hash", () => {
    const path = fileURLToPath(new URL("../../config/examples/accounting-monthly-v1.json", import.meta.url));
    const first = loadIndustryPackage(path, validator);
    const second = loadIndustryPackage(path, validator);

    expect(first.definition.package_key).toBe("accounting.monthly");
    expect(first.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.definitionHash).toBe(second.definitionHash);
    expect(Object.isFrozen(first.definition)).toBe(true);
  });

  it("rejects requirements that reference an unknown document type", () => {
    const input = readJson("../../config/examples/accounting-monthly-v1.json") as {
      requirement_profile: { requirements: Array<{ document_type_code: string }> };
    };
    input.requirement_profile.requirements[0]!.document_type_code = "unknown_type";
    const structurallyValid = validator.validateIndustryPackage(input);
    expect(structurallyValid.ok).toBe(true);
    if (!structurallyValid.ok) {
      throw new Error("fixture should be structurally valid");
    }

    expect(() => validateIndustryPackageReferences(structurallyValid.value)).toThrow(IndustryPackageError);
  });
});
