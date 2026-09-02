import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  runVerificationCalibration,
  validateCalibrationCatalog,
  type VerificationCalibrationCatalog,
} from "./calibration.js";

describe("verification calibration catalog", () => {
  let catalog: VerificationCalibrationCatalog;

  beforeAll(async () => {
    const yamlPath = resolve(import.meta.dir, "../../../evals/verification-calibration.yaml");
    const rawText = await Bun.file(yamlPath).text();
    const parsed = Bun.YAML.parse(rawText);
    catalog = validateCalibrationCatalog(parsed);
  });

  test("validates calibration catalog schema and cases", () => {
    expect(catalog.schema_version).toBe(1);
    expect(catalog.cases.length).toBe(8);

    const ids = catalog.cases.map((c) => c.id);
    expect(ids).toContain("unchanged-observable-answer");
    expect(ids).toContain("isolated-doc-update");
    expect(ids).toContain("ordinary-code-correct");
    expect(ids).toContain("ordinary-code-wrong");
    expect(ids).toContain("stale-evidence");
    expect(ids).toContain("missing-evidence");
    expect(ids).toContain("irrelevant-evidence");
    expect(ids).toContain("security-change");
  });

  test("runs known-outcome calibration with zero false completions and zero false blocks", () => {
    const report = runVerificationCalibration(catalog);

    expect(report.passed).toBe(true);
    expect(report.totalCases).toBe(8);
    expect(report.passedCases).toBe(8);
    expect(report.failedCases).toBe(0);
    expect(report.falseCompletions).toBe(0);
    expect(report.falseBlocks).toBe(0);
    expect(report.falseCompletionRate).toBe(0);
    expect(report.falseBlockRate).toBe(0);

    expect(report.tierDistribution[0]).toBe(1);
    expect(report.tierDistribution[1]).toBe(1);
    expect(report.tierDistribution[2]).toBe(5);
    expect(report.tierDistribution[3]).toBe(1);
  });
});
