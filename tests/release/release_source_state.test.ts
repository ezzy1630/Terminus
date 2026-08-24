import { describe, expect, test } from "bun:test";
import {
  type ReleaseSourceSnapshot,
  validateReleaseSource,
} from "../../scripts/verify-release-source.ts";
import { sourceIdentityCheck } from "../../scripts/m12-exit-gate.ts";

const HEAD = "a".repeat(40);

function snapshot(overrides: Partial<ReleaseSourceSnapshot> = {}): ReleaseSourceSnapshot {
  return {
    expectedCommit: HEAD,
    actualCommit: HEAD,
    clean: true,
    ...overrides,
  };
}

describe("release source identity", () => {
  test("accepts a clean checkout at the exact candidate commit", () => {
    expect(validateReleaseSource(snapshot())).toEqual([]);
  });

  test("rejects evidence generated from a dirty working tree", () => {
    const errors = validateReleaseSource(snapshot({ clean: false }));
    expect(errors).toContain(
      "working tree is dirty; commit or isolate the candidate before producing commit-bound release evidence",
    );
    expect(sourceIdentityCheck(snapshot({ clean: false })).status).toBe("invalid");
  });

  test("rejects a checkout that differs from the declared release commit", () => {
    const errors = validateReleaseSource(snapshot({ actualCommit: "b".repeat(40) }));
    expect(errors.some((error) => error.includes("does not match release commit"))).toBe(true);
  });
});
