export const ONE_SIDED_95_Z = 1.6448536269514722;
export const CLASSIFICATION_QUALITY_SCORER_VERSION = "2.0";

export type ClassificationRiskStratum =
  | "routine"
  | "high_risk_type"
  | "wrong_subject"
  | "wrong_period"
  | "unknown_type"
  | "critical_conflict"
  | "low_quality";

export interface ClassificationQualityObservation {
  sampleId: string;
  familyId: string;
  expectedDocumentTypeCode: string;
  actualDocumentTypeCode: string | null;
  expectedRoute: "accepted" | "review_required";
  actualRoute: "accepted" | "review_required" | "failed_closed";
  riskStratum: ClassificationRiskStratum;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ClassificationQualityPolicy {
  confidenceLevel: 0.95;
  minimumAutoAcceptPrecisionLowerBound: number;
  minimumIndependentFamilies: number;
  highRiskDocumentTypeCodes: string[];
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  monthlyProviderLimitUsd: number;
  applicationCircuitBreakerUsd: number;
}

export interface ClassificationTypeQualityResult {
  documentTypeCode: string;
  independentFamilies: number;
  autoAcceptedFamilies: number;
  correctlyAutoAcceptedFamilies: number;
  falseAcceptedFamilies: number;
  reviewedFamilies: number;
  precision: number | null;
  precisionOneSided95LowerBound: number;
  reviewRate: number;
  highRisk: boolean;
  autoAcceptEligible: boolean;
  decisionReasons: string[];
}

export interface ClassificationQualityReport {
  physicalObservations: number;
  independentFamilies: number;
  nearDuplicateObservationsExcluded: number;
  unsafeAutoAcceptFamilies: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  latencyMs: { minimum: number; median: number; p95: number; maximum: number };
  byDocumentType: ClassificationTypeQualityResult[];
  certifiedAutoAcceptDocumentTypeCodes: string[];
  passed: boolean;
}

const unsafeStrata = new Set<ClassificationRiskStratum>([
  "wrong_subject", "wrong_period", "unknown_type", "critical_conflict", "low_quality",
]);

/**
 * Produces a family-deduplicated quality decision. Multiple physical variants
 * with the same familyId are one independent statistical observation, and the
 * family fails closed if any variant is unsafe or incorrect.
 */
export function evaluateClassificationQuality(
  observations: ClassificationQualityObservation[],
  policy: ClassificationQualityPolicy,
): ClassificationQualityReport {
  validatePolicy(policy);
  if (observations.length === 0) throw new Error("quality_observations_required");
  observations.forEach(validateObservation);

  const families = new Map<string, ClassificationQualityObservation[]>();
  for (const observation of observations) {
    const family = families.get(observation.familyId) ?? [];
    if (family.some((item) => item.expectedDocumentTypeCode !== observation.expectedDocumentTypeCode ||
      item.riskStratum !== observation.riskStratum)) {
      throw new Error(`classification_family_definition_conflict:${observation.familyId}`);
    }
    family.push(observation);
    families.set(observation.familyId, family);
  }

  const familyRows = [...families.values()].map((variants) => {
    // Manifests place the pre-declared canonical observation first. Physical
    // variants remain auditable but cannot alter or inflate the statistical
    // vote for their content family.
    const canonical = variants[0]!;
    const autoAccepted = canonical.actualRoute === "accepted";
    const unsafe = unsafeStrata.has(canonical.riskStratum);
    return {
      type: canonical.expectedDocumentTypeCode,
      risk: canonical.riskStratum,
      autoAccepted,
      correctAutoAccept: autoAccepted && canonical.actualDocumentTypeCode === canonical.expectedDocumentTypeCode && !unsafe,
      falseAccepted: autoAccepted && (canonical.actualDocumentTypeCode !== canonical.expectedDocumentTypeCode || unsafe),
      reviewed: !autoAccepted,
    };
  });

  const documentTypes = [...new Set(familyRows.map((item) => item.type))].sort();
  const byDocumentType = documentTypes.map((documentTypeCode): ClassificationTypeQualityResult => {
    const rows = familyRows.filter((item) => item.type === documentTypeCode);
    const autoAcceptedFamilies = rows.filter((item) => item.autoAccepted).length;
    const correctlyAutoAcceptedFamilies = rows.filter((item) => item.correctAutoAccept).length;
    const falseAcceptedFamilies = rows.filter((item) => item.falseAccepted).length;
    const reviewedFamilies = rows.filter((item) => item.reviewed).length;
    const precision = autoAcceptedFamilies > 0
      ? correctlyAutoAcceptedFamilies / autoAcceptedFamilies
      : null;
    const lowerBound = autoAcceptedFamilies > 0
      ? wilsonOneSidedLowerBound(correctlyAutoAcceptedFamilies, autoAcceptedFamilies)
      : 0;
    const highRisk = policy.highRiskDocumentTypeCodes.includes(documentTypeCode);
    const reasons: string[] = [];
    if (highRisk) reasons.push("high_risk_type_requires_human");
    if (rows.length < policy.minimumIndependentFamilies) reasons.push("insufficient_independent_families");
    if (autoAcceptedFamilies === 0) reasons.push("no_auto_accept_observations");
    if (falseAcceptedFamilies > 0) reasons.push("false_acceptance_detected");
    if (lowerBound < policy.minimumAutoAcceptPrecisionLowerBound) {
      reasons.push("precision_lower_bound_below_target");
    }
    return {
      documentTypeCode,
      independentFamilies: rows.length,
      autoAcceptedFamilies,
      correctlyAutoAcceptedFamilies,
      falseAcceptedFamilies,
      reviewedFamilies,
      precision,
      precisionOneSided95LowerBound: lowerBound,
      reviewRate: reviewedFamilies / rows.length,
      highRisk,
      autoAcceptEligible: reasons.length === 0,
      decisionReasons: reasons,
    };
  });

  const totalInputTokens = observations.reduce((sum, item) => sum + item.inputTokens, 0);
  const totalOutputTokens = observations.reduce((sum, item) => sum + item.outputTokens, 0);
  const estimatedCostUsd = estimateClassificationCostUsd(
    totalInputTokens,
    totalOutputTokens,
    policy.inputUsdPerMillionTokens,
    policy.outputUsdPerMillionTokens,
  );
  const latencies = observations.map((item) => item.latencyMs).sort((a, b) => a - b);
  const unsafeAutoAcceptFamilies = familyRows.filter((item) => unsafeStrata.has(item.risk) && item.autoAccepted).length;
  const certified = byDocumentType.filter((item) => item.autoAcceptEligible).map((item) => item.documentTypeCode);
  return {
    physicalObservations: observations.length,
    independentFamilies: families.size,
    nearDuplicateObservationsExcluded: observations.length - families.size,
    unsafeAutoAcceptFamilies,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd,
    latencyMs: {
      minimum: latencies[0]!,
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      maximum: latencies[latencies.length - 1]!,
    },
    byDocumentType,
    certifiedAutoAcceptDocumentTypeCodes: certified,
    passed: certified.length > 0 && unsafeAutoAcceptFamilies === 0 &&
      estimatedCostUsd <= policy.applicationCircuitBreakerUsd,
  };
}

export function wilsonOneSidedLowerBound(successes: number, trials: number): number {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials < 1 || successes < 0 || successes > trials) {
    throw new Error("invalid_binomial_observation");
  }
  const z2 = ONE_SIDED_95_Z ** 2;
  const proportion = successes / trials;
  const centre = proportion + z2 / (2 * trials);
  const spread = ONE_SIDED_95_Z * Math.sqrt(
    (proportion * (1 - proportion) + z2 / (4 * trials)) / trials,
  );
  return Math.max(0, (centre - spread) / (1 + z2 / trials));
}

export function estimateClassificationCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputUsdPerMillionTokens: number,
  outputUsdPerMillionTokens: number,
): number {
  for (const value of [inputTokens, outputTokens, inputUsdPerMillionTokens, outputUsdPerMillionTokens]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid_cost_input");
  }
  return (inputTokens * inputUsdPerMillionTokens + outputTokens * outputUsdPerMillionTokens) / 1_000_000;
}

export function assertClassificationBudgetAvailable(
  accruedEstimatedCostUsd: number,
  reservedNextCallUsd: number,
  policy: Pick<ClassificationQualityPolicy, "applicationCircuitBreakerUsd" | "monthlyProviderLimitUsd">,
): void {
  if (policy.applicationCircuitBreakerUsd > policy.monthlyProviderLimitUsd ||
      accruedEstimatedCostUsd + reservedNextCallUsd > policy.applicationCircuitBreakerUsd) {
    throw new Error("classification_evaluation_budget_circuit_open");
  }
}

function percentile(sorted: number[], value: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1));
  return sorted[index]!;
}

function validatePolicy(policy: ClassificationQualityPolicy): void {
  if (policy.confidenceLevel !== 0.95 || policy.minimumAutoAcceptPrecisionLowerBound <= 0 ||
      policy.minimumAutoAcceptPrecisionLowerBound > 1 || policy.minimumIndependentFamilies < 1 ||
      !Number.isInteger(policy.minimumIndependentFamilies) || policy.applicationCircuitBreakerUsd <= 0 ||
      policy.monthlyProviderLimitUsd <= 0 || policy.applicationCircuitBreakerUsd > policy.monthlyProviderLimitUsd) {
    throw new Error("invalid_classification_quality_policy");
  }
}

function validateObservation(observation: ClassificationQualityObservation): void {
  if (!observation.sampleId.trim() || !observation.familyId.trim() ||
      !observation.expectedDocumentTypeCode.trim() || observation.inputTokens < 0 ||
      observation.outputTokens < 0 || observation.latencyMs < 0) {
    throw new Error("invalid_classification_quality_observation");
  }
}
