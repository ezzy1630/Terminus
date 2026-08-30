import { describe, expect, test } from "bun:test";
import {
  attenuateScoutAuthority,
  buildCleanReview,
  subagentEnabled,
  validateScoutResult,
} from "./subagents.js";

describe("subagent feature gates", () => {
  test("default OFF — children are conditional modules", () => {
    expect(subagentEnabled("scout", {})).toBe(false);
    expect(subagentEnabled("reviewer", {})).toBe(false);
  });

  test("explicit '1' enables; other values do not", () => {
    expect(subagentEnabled("scout", { TERMINUS_ENABLE_SCOUT: "1" })).toBe(true);
    expect(subagentEnabled("scout", { TERMINUS_ENABLE_SCOUT: "true" })).toBe(false);
  });
});

describe("validateScoutResult", () => {
  const base = {
    status: "completed",
    claims: ["auth lives in src/auth.ts"],
    evidenceRefs: ["workspace://src/auth.ts"],
    filesInspected: ["src/auth.ts"],
    filesChanged: [],
    testsRun: [],
    remainingRisks: [],
    costMicros: 1_500n,
    tokens: 9_000n,
    wallTimeMs: 4_200,
  };

  test("accepts a well-formed read-only result", () => {
    expect(validateScoutResult(base).claims.length).toBe(1);
  });

  test("rejects a scout that claims workspace mutations", () => {
    expect(() =>
      validateScoutResult({ ...base, filesChanged: ["src/auth.ts"] }),
    ).toThrow();
  });

  test("rejects a success-shaped empty result", () => {
    expect(() => validateScoutResult({ ...base, claims: [], evidenceRefs: [], filesInspected: [] })).toThrow();
  });

  test("rejects negative or unknown accounting fields", () => {
    expect(() => validateScoutResult({ ...base, costMicros: -1 })).toThrow();
    expect(() => validateScoutResult({ ...base, unexpected: true })).toThrow();
  });
});

describe("scout authority attenuation", () => {
  test("keeps only read/search tools and covered paths", () => {
    const authority = attenuateScoutAuthority({
      parentTaskId: "task-1",
      delegationId: "delegation-1",
      parentAllowedTools: ["read", "grep", "patch"],
      parentReadPaths: ["src/**"],
      requestedReadPaths: ["src/auth.ts"],
    });
    expect(authority.allowedTools).toEqual(["read", "grep"]);
    expect(authority.allowedWritePaths).toEqual([]);
  });

  test("fails closed when child asks outside the parent scope", () => {
    expect(() => attenuateScoutAuthority({
      parentTaskId: "task-1",
      delegationId: "delegation-1",
      parentAllowedTools: ["read"],
      parentReadPaths: ["src/**"],
      requestedReadPaths: ["tests/**"],
    })).toThrow();
  });
});

describe("buildCleanReview", () => {
  test("strips actor context and includes contract + diff only", () => {
    const verdict = buildCleanReview({
      contract: {
        mission: "fix the bug",
        acceptance: [{ id: "ac1", statement: "tests pass" }],
        scope: { readPaths: ["**"], writePaths: ["src/**"] },
      } as never,
      candidateDiff: "--- a/src/x.ts\n+++ b/src/x.ts\n",
      changedFiles: ["src/x.ts"],
    });
    expect(verdict.systemPrompt).toContain("no merge authority");
    expect(JSON.stringify(verdict.contextPayload)).toContain("fix the bug");
    expect(JSON.stringify(verdict.contextPayload)).not.toContain("chain of thought");
  });
});
