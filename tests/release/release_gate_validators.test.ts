import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  checkCacheTelemetry,
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
        candidate_commit: "b".repeat(40),
        release_version: "0.1.0",
        generatedAt: "2020-01-01T00:00:00.000Z",
      },
      {
        expectedCommit: HEAD,
        expectedVersion: "0.1.0",
        freshSinceMs: Date.parse("2025-01-01T00:00:00.000Z"),
      },
    );

    expect(errors.some((error) => error.includes("candidate commit binding does not match"))).toBe(true);
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

  test("allows fixture eval evidence only for the explicit local M12 option", () => {
    const errors = validateEvidencePayload(
      "eval-release",
      {
        status: "fixture_pass",
        pass: true,
        generatedAt: "2026-08-22T00:00:00.000Z",
      },
      { allowFixtureEvidence: true },
    );

    expect(errors).toEqual([]);
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

  test("rejects unchecked approval strings", () => {
    const matrix = {
      commit: HEAD,
      supported_platforms: [],
      unverified_or_degraded_platforms: [],
      platforms: {},
    };
    const errors = validateDecision(
      {
        release: {
          version: "0.1.0",
          commit: HEAD,
          supported_platforms: [],
          known_limitations: [],
          signatures: {
            release_owner: "approved",
            security_owner: "approved",
            protocol_owner: "approved",
            evaluation_owner: "approved",
          },
        },
      },
      HEAD,
      matrix,
      { expectedVersion: "0.1.0" },
    );

    expect(errors.filter((error) => error.includes("verified approval record"))).toHaveLength(4);
  });
});

describe("R7 cache telemetry gate", () => {
  function withTelemetry(value: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "cache-telemetry-"));
    const path = join(dir, "cache-telemetry.json");
    writeFileSync(path, JSON.stringify(value), "utf8");
    return path;
  }

  test("missing telemetry is pending, not failing", () => {
    const check = checkCacheTelemetry({}, join(mkdtempSync(join(tmpdir(), "cache-telemetry-")), "absent.json"));
    expect(check.status).toBe("missing");
    expect(check.errors ?? []).toHaveLength(0);
  });

  test("no_data is explicit pending live telemetry and does not fail", () => {
    const path = withTelemetry({ status: "no_data", threshold: 0.7, attemptsObserved: 0 });
    const check = checkCacheTelemetry({}, path);
    expect(check.status).toBe("pending_live_telemetry");
    expect(check.errors ?? []).toHaveLength(0);
  });

  test("measured above threshold passes", () => {
    const path = withTelemetry({ status: "measured", threshold: 0.7, averageRatio: 0.93, attemptsObserved: 12 });
    const check = checkCacheTelemetry({}, path);
    expect(check.status).toBe("present");
    expect(check.detail).toMatch(/0\.93/);
  });

  test("measured below threshold fails closed", () => {
    const path = withTelemetry({ status: "measured_below_threshold", threshold: 0.7, averageRatio: 0.41 });
    const check = checkCacheTelemetry({}, path);
    expect(check.status).toBe("invalid");
    expect((check.errors ?? []).join("; ")).toMatch(/below threshold/);
  });

  test("unknown status is invalid", () => {
    const path = withTelemetry({ status: "vibes" });
    const check = checkCacheTelemetry({}, path);
    expect(check.status).toBe("invalid");
    rmSync(path, { force: true });
  });
});
