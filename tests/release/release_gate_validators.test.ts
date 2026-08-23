import { describe, expect, test } from "bun:test";
import {
  validateDecision,
  validateEvidencePayload,
  validateMatrix,
} from "../../scripts/m12-exit-gate.ts";

const HEAD = "a".repeat(40);

describe("release gate validators", () => {
  test("rejects stale and wrong-HEAD evidence", () => {
    const errors = validateEvidencePayload(
      "eval-release",
      {
        status: "passed",
        commit: "b".repeat(40),
        generatedAt: "2020-01-01T00:00:00.000Z",
      },
      { expectedCommit: HEAD, freshSinceMs: Date.parse("2025-01-01T00:00:00.000Z") },
    );

    expect(errors.some((error) => error.includes("does not match HEAD"))).toBe(true);
    expect(errors.some((error) => error.includes("is stale"))).toBe(true);
  });

  test("rejects unsigned and fixture evidence", () => {
    const errors = validateEvidencePayload("eval-release", {
      status: "fixture_pass",
      generatedAt: "2026-08-22T00:00:00.000Z",
      signature: { status: "unsigned-local" },
    });

    expect(errors.some((error) => error.includes("fixture evidence"))).toBe(true);
    expect(errors.some((error) => error.includes("unsigned evidence"))).toBe(true);
    expect(errors.some((error) => error.includes("signature"))).toBe(true);
  });

  test("rejects contradictory platform and decision artifacts", () => {
    const matrix = {
      commit: HEAD,
      supported_platforms: ["linux-x86_64"],
      unverified_or_degraded_platforms: ["macos-arm64"],
      platforms: {
        "linux-x86_64": { status: "requires_ci", basis: "missing", evidence: null },
        "macos-arm64": { status: "degraded_declared", basis: "degraded", evidence: null },
      },
    };
    const matrixErrors = validateMatrix(matrix, HEAD);
    expect(matrixErrors.some((error) => error.includes("claimed supported"))).toBe(true);

    const decisionErrors = validateDecision(
      {
        release: {
          commit: "b".repeat(40),
          supported_platforms: [],
          known_limitations: [],
          signatures: {},
        },
      },
      HEAD,
      matrix,
    );
    expect(decisionErrors.some((error) => error.includes("does not match HEAD"))).toBe(true);
    expect(decisionErrors.some((error) => error.includes("contradict"))).toBe(true);
    expect(decisionErrors.some((error) => error.includes("unsigned"))).toBe(true);
  });
});
