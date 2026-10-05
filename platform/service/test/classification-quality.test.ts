import { describe, expect, it } from "vitest";
import {
  assertClassificationBudgetAvailable,
  evaluateClassificationQuality,
  wilsonOneSidedLowerBound,
  type ClassificationQualityObservation,
  type ClassificationQualityPolicy,
} from "../src/domain/classification-quality.js";

const policy: ClassificationQualityPolicy = {
  confidenceLevel: 0.95,
  minimumAutoAcceptPrecisionLowerBound: 0.95,
  minimumIndependentFamilies: 60,
  highRiskDocumentTypeCodes: ["invoice", "expense_receipt", "contractor_statement"],
  inputUsdPerMillionTokens: 5,
  outputUsdPerMillionTokens: 30,
  monthlyProviderLimitUsd: 3,
  applicationCircuitBreakerUsd: 2.5,
};

function observation(overrides: Partial<ClassificationQualityObservation> = {}): ClassificationQualityObservation {
  return {
    sampleId: "sample-1", familyId: "family-1", expectedDocumentTypeCode: "bank_statement",
    actualDocumentTypeCode: "bank_statement", expectedRoute: "accepted", actualRoute: "accepted",
    riskStratum: "routine", inputTokens: 1000, outputTokens: 100, latencyMs: 1000,
    ...overrides,
  };
}

describe("classification quality gate", () => {
  it("certifies sixty independent perfect routine families at the one-sided 95% target", () => {
    const observations = Array.from({ length: 60 }, (_, index) => observation({
      sampleId: `sample-${index}`, familyId: `family-${index}`, latencyMs: 1000 + index,
    }));
    const report = evaluateClassificationQuality(observations, policy);
    expect(report.passed).toBe(true);
    expect(report.certifiedAutoAcceptDocumentTypeCodes).toEqual(["bank_statement"]);
    expect(report.byDocumentType[0]?.precisionOneSided95LowerBound).toBeGreaterThanOrEqual(0.95);
  });

  it("does not let physical near-duplicates inflate the independent denominator", () => {
    const observations = Array.from({ length: 60 }, (_, index) => observation({
      sampleId: `sample-${index}`, familyId: `family-${index}`,
    }));
    observations.push(observation({ sampleId: "variant-a", familyId: "family-0",
      expectedRoute: "review_required", actualRoute: "review_required" }));
    observations.push(observation({ sampleId: "variant-b", familyId: "family-0",
      expectedRoute: "review_required", actualRoute: "review_required" }));
    const report = evaluateClassificationQuality(observations, policy);
    expect(report.physicalObservations).toBe(62);
    expect(report.independentFamilies).toBe(60);
    expect(report.nearDuplicateObservationsExcluded).toBe(2);
    expect(report.certifiedAutoAcceptDocumentTypeCodes).toEqual(["bank_statement"]);
  });

  it("fails the global gate on any unsafe auto-accept", () => {
    const observations = [observation({
      riskStratum: "wrong_subject", expectedRoute: "review_required", actualRoute: "accepted",
    })];
    const report = evaluateClassificationQuality(observations, policy);
    expect(report.passed).toBe(false);
    expect(report.unsafeAutoAcceptFamilies).toBe(1);
    expect(report.certifiedAutoAcceptDocumentTypeCodes).toEqual([]);
  });

  it("treats low-quality auto-acceptance as an unsafe family", () => {
    const report = evaluateClassificationQuality([observation({
      riskStratum: "low_quality", expectedRoute: "review_required", actualRoute: "accepted",
    })], policy);
    expect(report.passed).toBe(false);
    expect(report.unsafeAutoAcceptFamilies).toBe(1);
  });

  it("keeps high-risk and statistically insufficient types human-only", () => {
    const report = evaluateClassificationQuality([
      observation({ expectedDocumentTypeCode: "invoice", actualDocumentTypeCode: "invoice" }),
    ], policy);
    expect(report.byDocumentType[0]?.autoAcceptEligible).toBe(false);
    expect(report.byDocumentType[0]?.decisionReasons).toContain("high_risk_type_requires_human");
    expect(report.byDocumentType[0]?.decisionReasons).toContain("insufficient_independent_families");
  });

  it("uses a one-sided 95% Wilson bound and opens the application breaker before the provider limit", () => {
    expect(wilsonOneSidedLowerBound(60, 60)).toBeGreaterThanOrEqual(0.95);
    expect(wilsonOneSidedLowerBound(50, 50)).toBeLessThan(0.95);
    expect(() => assertClassificationBudgetAvailable(2.4, 0.11, policy))
      .toThrow("classification_evaluation_budget_circuit_open");
    expect(() => assertClassificationBudgetAvailable(2.2, 0.11, policy)).not.toThrow();
  });
});
