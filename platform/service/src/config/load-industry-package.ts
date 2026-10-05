import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ContractValidator, type IndustryPackage } from "../contracts/json-schema-validator.js";

export interface LoadedIndustryPackage {
  definition: Readonly<IndustryPackage>;
  definitionHash: string;
}

export class IndustryPackageError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid industry package: ${problems.join("; ")}`);
    this.name = "IndustryPackageError";
  }
}

export function loadIndustryPackage(
  filePath: string,
  validator = new ContractValidator(),
): LoadedIndustryPackage {
  const input = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const result = validator.validateIndustryPackage(input);
  if (!result.ok) {
    throw new IndustryPackageError(
      result.errors.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`),
    );
  }

  validateIndustryPackageReferences(result.value);
  const canonical = canonicalJson(result.value);
  return {
    definition: deepFreeze(result.value),
    definitionHash: createHash("sha256").update(canonical).digest("hex"),
  };
}

export function validateIndustryPackageReferences(definition: IndustryPackage): void {
  const problems: string[] = [];
  const codes = new Set<string>();
  for (const documentType of definition.document_types) {
    if (codes.has(documentType.code)) {
      problems.push(`duplicate document type code: ${documentType.code}`);
    }
    codes.add(documentType.code);
  }

  const requirementCodes = new Set<string>();
  for (const requirement of definition.requirement_profile.requirements) {
    if (requirementCodes.has(requirement.requirement_code)) {
      problems.push(`duplicate requirement code: ${requirement.requirement_code}`);
    }
    requirementCodes.add(requirement.requirement_code);
    if (!codes.has(requirement.document_type_code)) {
      problems.push(`unknown document type in requirement: ${requirement.document_type_code}`);
    }
    if (requirement.maximum_count != null && requirement.maximum_count < requirement.minimum_count) {
      problems.push(`maximum_count is below minimum_count: ${requirement.requirement_code}`);
    }
  }

  if (problems.length > 0) {
    throw new IndustryPackageError(problems);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
