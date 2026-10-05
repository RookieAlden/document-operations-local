import { contentHash, datasetFingerprint, normalizeChallengeContent, type ChallengeDataset, type ChallengeObservation, type ChallengeSample } from "./classification-challenge.js";
/** Intentionally imperfect, hand-countable software fixture. Never a model result. */
export function handCalculatedScoreFixture(): { dataset: ChallengeDataset; observations: ChallengeObservation[] } {
  const samples: ChallengeSample[] = [];
  const observations: ChallengeObservation[] = [];
  function add(id: string, expected: ChallengeSample["expected"], result: ChallengeObservation["result"], familyId = id) {
    const content = `SYNTHETIC SCORER UNIT FIXTURE ${id}`;
    const sample: ChallengeSample = { sampleId: id, familyId, templateGroup: familyId, scenario: `Hand-calculated scorer behavior: ${familyId}`, normalizedContentHash: contentHash(normalizeChallengeContent(content)), split: "development", stratum: expected.outcome === "classified" ? "normal" : expected.outcome === "unknown" ? "unknown" : "mixed", content, contentHash: contentHash(content), expected };
    samples.push(sample); observations.push({ sampleId: id, contentHash: sample.contentHash, result });
  }
  const known: ChallengeSample["expected"] = { outcome: "classified", type: "bank_statement", reason: null, route: "accepted", conflictFlags: [] };
  const unknown: ChallengeSample["expected"] = { outcome: "unknown", type: null, reason: "outside_allowed_types", route: "review_required", conflictFlags: [] };
  const mixed: ChallengeSample["expected"] = { outcome: "insufficient_evidence", type: null, reason: "mixed_document", route: "review_required", conflictFlags: ["subject_conflict"] };
  add("wrong-type-but-safe", known, { kind: "classification", outcome: "classified", type: "invoice", reason: null, route: "review_required", conflictFlags: [] });
  add("forced-unknown", unknown, { kind: "classification", outcome: "classified", type: "invoice", reason: null, route: "review_required", conflictFlags: [] });
  add("normal-false-abstention", known, { kind: "classification", outcome: "insufficient_evidence", type: null, reason: "ambiguous", route: "review_required", conflictFlags: [] });
  add("refusal", known, { kind: "technical_failure", error: "provider_refusal", route: "failed_closed" });
  add("provider-failure", unknown, { kind: "technical_failure", error: "provider_error", route: "failed_closed" });
  add("variant-correct", known, { kind: "classification", ...known }, "same-family");
  add("variant-incorrect", known, { kind: "classification", ...known, type: "invoice" }, "same-family");
  add("mixed-correct", mixed, { kind: "classification", ...mixed });
  const dataset: ChallengeDataset = { version: "hand-calculated-software-fixture-1.1", seed: "fixed", evidenceKind: "synthetic_content_not_model_results", datasetHash: "", samples };
  dataset.datasetHash = datasetFingerprint(dataset);
  return { dataset, observations };
}
