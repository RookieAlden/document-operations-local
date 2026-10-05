import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface EvaluationManifest {
  environment: string;
  data_classification: string;
  allowed_document_type_codes: string[];
  fixtures: Array<{
    fixture_id: string;
    path: string;
    sha256: string;
    expected_document_type_code: string;
    subject_display_name: string;
  }>;
}

describe("classification evaluation fixtures", () => {
  const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const manifestPath = fileURLToPath(new URL(
    "../../tests/fixtures/classification-evaluation-manifest.json",
    import.meta.url,
  ));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as EvaluationManifest;

  it("contains only explicitly synthetic DEV fixtures with allowed expected types", () => {
    expect(manifest.environment).toBe("DEV");
    expect(manifest.data_classification).toBe("synthetic_only");
    expect(manifest.fixtures).toHaveLength(14);
    for (const fixture of manifest.fixtures) {
      expect(manifest.allowed_document_type_codes).toContain(fixture.expected_document_type_code);
      expect(fixture.subject_display_name.length).toBeGreaterThan(3);
      expect(fixture.fixture_id).not.toContain("dev-client-004");
    }
  });

  it("pins every generated file by SHA-256", () => {
    for (const fixture of manifest.fixtures) {
      const path = `${workspaceRoot}${fixture.path}`;
      expect(existsSync(path), path).toBe(true);
      const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(actual, fixture.fixture_id).toBe(fixture.sha256);
    }
  });
});
