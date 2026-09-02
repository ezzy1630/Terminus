import { describe, expect, test } from "bun:test";
import {
  MODEL_PROFILE_CHECK_IDS,
  buildModelProfileConformanceReport,
  runModelProfileExitGate,
  validateModelProfileConformanceReport,
  type ConformanceEvidenceClass,
  type ModelProfileCheckStatus,
} from "./model-profile.js";

function report(
  evidenceClass: ConformanceEvidenceClass = "external_live",
  status: ModelProfileCheckStatus = "passed",
) {
  return buildModelProfileConformanceReport({
    providerId: "openai",
    modelSnapshot: "gpt-test-2026-09-01",
    apiVersion: "responses-v1",
    profileId: "openai/gpt-test@responses-v1",
    profileVersion: "1",
    evidenceClass,
    testedAt: "2026-09-02T00:00:00Z",
    terminusCommit: "a".repeat(40),
    checks: MODEL_PROFILE_CHECK_IDS.map((checkId) => ({
      checkId,
      status,
      artifactRef: `artifact://sha256/${"b".repeat(64)}#${checkId}`,
      diagnostic: status === "passed" ? null : "observed mismatch",
    })),
  });
}

describe("versioned model-profile conformance", () => {
  test("requires every check and immutable evidence reference", () => {
    expect(() => buildModelProfileConformanceReport({
      providerId: "openai",
      modelSnapshot: "snapshot",
      apiVersion: "api",
      profileId: "profile",
      profileVersion: "1",
      evidenceClass: "external_live",
      testedAt: "2026-09-02T00:00:00Z",
      terminusCommit: "a".repeat(40),
      checks: [],
    })).toThrow("missing model-profile checks");
  });

  test("live gate rejects deterministic-only evidence", () => {
    const gate = runModelProfileExitGate({
      expectedProfileIds: ["openai/gpt-test@responses-v1"],
      requiredEvidenceClass: "external_live",
      reports: [report("deterministic_adapter")],
    });
    expect(gate.passed).toBe(false);
    expect(gate.failures).toContain(
      "openai/gpt-test@responses-v1: requires external_live evidence",
    );
  });

  test("passes one complete live report for each expected profile", () => {
    expect(runModelProfileExitGate({
      expectedProfileIds: ["openai/gpt-test@responses-v1"],
      requiredEvidenceClass: "external_live",
      reports: [report()],
    }).passed).toBe(true);
  });

  test("blocked checks remain a failed profile", () => {
    const blocked = report("external_live", "blocked");
    expect(blocked.passed).toBe(false);
  });

  test("rejects mutable or non-content-addressed artifact reference", () => {
    expect(() => buildModelProfileConformanceReport({
      providerId: "openai",
      modelSnapshot: "snapshot",
      apiVersion: "api",
      profileId: "profile",
      profileVersion: "1",
      evidenceClass: "external_live",
      testedAt: "2026-09-02T00:00:00Z",
      terminusCommit: "a".repeat(40),
      checks: MODEL_PROFILE_CHECK_IDS.map((checkId) => ({
        checkId,
        status: "passed",
        artifactRef: "not-a-valid-sha256-reference",
        diagnostic: null,
      })),
    })).toThrow("must be an immutable content-addressed artifact reference");
  });

  test("validateModelProfileConformanceReport parses valid and rejects malformed objects", () => {
    const valid = report();
    const validated = validateModelProfileConformanceReport(JSON.parse(JSON.stringify(valid)));
    expect(validated.profileId).toBe(valid.profileId);
    expect(() => validateModelProfileConformanceReport(null)).toThrow();
    expect(() => validateModelProfileConformanceReport({ schemaVersion: 99 })).toThrow();
  });
});
