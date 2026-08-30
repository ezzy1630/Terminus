import { describe, expect, test } from "bun:test";
import type { ContextBudget } from "@terminus/context-ir";
import type { TokenCount } from "@terminus/domain";
import {
  ADAPTIVE_COMPACTION_POLICY_VERSION,
  LEGACY_COMPACT_THRESHOLD_BYTES,
  LEGACY_KEEP_RECENT_BYTES,
  LEGACY_SUMMARY_CHUNK_CHARS,
  MAX_COMPACTION_TRANSCRIPT_CHARS,
  resolveAdaptiveCompactionMode,
  TurnCompactionFailureGuard,
  conservativeCompactionTextTokens,
  deriveCompactionPolicy,
} from "./compaction-policy.js";

function tokens(value: number): TokenCount {
  return BigInt(value) as TokenCount;
}

function budget(input: {
  readonly hardInputLimit: number;
  readonly optionalContextTarget: number;
}): ContextBudget {
  return {
    modelAdvertisedTokens: tokens(input.hardInputLimit),
    testedSafeTokens: tokens(input.hardInputLimit),
    protocolOverheadTokens: tokens(128),
    exactContextTokens: tokens(0),
    optionalContextTarget: tokens(input.optionalContextTarget),
    expectedToolResultReserve: tokens(512),
    outputReserve: tokens(4_096),
    reasoningReserve: tokens(2_048),
    recoveryMargin: tokens(256),
    hardInputLimit: tokens(input.hardInputLimit),
    hardCostMicros: 1_000_000n,
  };
}

describe("provider-budgeted compaction policy", () => {
  test("keeps the exact fixed byte control arm by default", () => {
    const decision = deriveCompactionPolicy(budget({
      hardInputLimit: 32_000,
      optionalContextTarget: 12_000,
    }));
    expect(decision).toMatchObject({
      policyVersion: "terminus.fixed-compaction.v1",
      assignment: "control",
      source: "legacy_fixed",
      compactionEnabled: true,
      compactThresholdTokens: LEGACY_COMPACT_THRESHOLD_BYTES,
      keepRecentTokens: LEGACY_KEEP_RECENT_BYTES,
      maxTranscriptChunkTokens: undefined,
      maxTranscriptChunkChars: LEGACY_SUMMARY_CHUNK_CHARS,
    });
  });

  test("accepts only the explicit adaptive opt-in", () => {
    expect(resolveAdaptiveCompactionMode(undefined)).toBe("control");
    expect(resolveAdaptiveCompactionMode("1")).toBe("adaptive");
    expect(() => resolveAdaptiveCompactionMode("0")).toThrow("TERMINUS_EXPERIMENTAL_ADAPTIVE_COMPACTION");
    expect(() => resolveAdaptiveCompactionMode("true")).toThrow("received 'true'");
  });

  test("suppresses only the exact failed source, anchor, and policy fingerprint", () => {
    const guard = new TurnCompactionFailureGuard();
    expect(guard.shouldSuppress("sha256:first")).toBe(false);
    guard.recordFailure("sha256:first");
    expect(guard.shouldSuppress("sha256:first")).toBe(true);
    expect(guard.shouldSuppress("sha256:changed-source")).toBe(false);
  });

  test("derates calibrated estimates and uses a byte upper bound while degraded", () => {
    const calibrated = conservativeCompactionTextTokens({
      estimateTextTokens: () => 100,
      calibration: {
        source: "observed_usage",
        status: "calibrated",
        maximumAbsolutePercentageError: 25,
      },
    }, "text");
    const degraded = conservativeCompactionTextTokens({
      estimateTextTokens: () => 1,
      calibration: {
        source: "explicit_fallback",
        status: "degraded",
        maximumAbsolutePercentageError: null,
      },
    }, "界");
    const bound = conservativeCompactionTextTokens({
      estimateTextTokens: () => 7,
      calibration: {
        source: "verified_binding",
        status: "calibrated",
        maximumAbsolutePercentageError: null,
      },
    }, "界");

    expect(calibrated).toBe(125);
    expect(degraded).toBe(3);
    expect(bound).toBe(7);
  });

  test("scales the trigger and recent tail with a small model window", () => {
    const decision = deriveCompactionPolicy(budget({
      hardInputLimit: 32_000,
      optionalContextTarget: 12_000,
    }), { mode: "adaptive" });

    expect(decision).toEqual({
      policyVersion: ADAPTIVE_COMPACTION_POLICY_VERSION,
      assignment: "adaptive",
      source: "provider_budget",
      compactionEnabled: true,
      compactThresholdTokens: 9_000,
      keepRecentTokens: 3_000,
      summaryHardInputLimitTokens: 32_000,
      summaryReservedInputTokens: 2_000,
      maxTranscriptChunkTokens: 30_000,
      maxTranscriptChunkChars: 90_000,
    });
  });

  test("retains more exact history for a larger safe window without unbounded summary chunks", () => {
    const medium = deriveCompactionPolicy(budget({
      hardInputLimit: 200_000,
      optionalContextTarget: 120_000,
    }), { mode: "adaptive" });
    const large = deriveCompactionPolicy(budget({
      hardInputLimit: 1_000_000,
      optionalContextTarget: 800_000,
    }), { mode: "adaptive" });

    expect(medium.compactThresholdTokens).toBe(90_000);
    expect(medium.keepRecentTokens).toBe(30_000);
    expect(large.compactThresholdTokens).toBe(600_000);
    expect(large.keepRecentTokens).toBe(32_000);
    expect(large.maxTranscriptChunkChars).toBe(MAX_COMPACTION_TRANSCRIPT_CHARS);
  });

  test("makes the previous constants an explicit fallback when the model budget is unavailable", () => {
    const decision = deriveCompactionPolicy(budget({
      hardInputLimit: 0,
      optionalContextTarget: 0,
    }), { mode: "adaptive" });

    expect(decision.source).toBe("fallback_unavailable_budget");
    expect(decision.assignment).toBe("control");
    expect(decision.compactionEnabled).toBe(true);
    expect(decision.compactThresholdTokens).toBe(LEGACY_COMPACT_THRESHOLD_BYTES);
    expect(decision.keepRecentTokens).toBe(LEGACY_KEEP_RECENT_BYTES);
    expect(decision.maxTranscriptChunkChars).toBe(MAX_COMPACTION_TRANSCRIPT_CHARS);
  });

  test("distinguishes a known exhausted optional budget from unavailable capacity", () => {
    const decision = deriveCompactionPolicy(budget({
      hardInputLimit: 32_000,
      optionalContextTarget: 0,
    }), { mode: "adaptive" });

    expect(decision.source).toBe("fallback_unavailable_budget");
    expect(decision.assignment).toBe("control");
    expect(decision.compactionEnabled).toBe(true);
    expect(decision.compactThresholdTokens).toBe(LEGACY_COMPACT_THRESHOLD_BYTES);
    expect(decision.keepRecentTokens).toBe(LEGACY_KEEP_RECENT_BYTES);
    expect(decision.maxTranscriptChunkChars).toBe(LEGACY_SUMMARY_CHUNK_CHARS);
  });

  test("keeps the baseline history window and disables compaction while tokenizer calibration is degraded", () => {
    const decision = deriveCompactionPolicy(
      budget({ hardInputLimit: 8_192, optionalContextTarget: 1_280 }),
      { mode: "adaptive", tokenizerStatus: "degraded" },
    );

    expect(decision.source).toBe("fallback_unverified_tokenizer");
    expect(decision.assignment).toBe("control");
    expect(decision.compactionEnabled).toBe(true);
    expect(decision.compactThresholdTokens).toBe(LEGACY_COMPACT_THRESHOLD_BYTES);
    expect(decision.keepRecentTokens).toBe(LEGACY_KEEP_RECENT_BYTES);
    expect(decision.maxTranscriptChunkChars).toBe(LEGACY_SUMMARY_CHUNK_CHARS);
  });

  test("reserves the measured obligation anchor before sizing a source chunk", () => {
    const decision = deriveCompactionPolicy(
      budget({ hardInputLimit: 32_000, optionalContextTarget: 12_000 }),
      { mode: "adaptive", summaryReservedInputTokens: 31_000 },
    );

    expect(decision.summaryReservedInputTokens).toBe(31_000);
    expect(decision.maxTranscriptChunkTokens).toBe(1_000);
    expect(decision.maxTranscriptChunkChars).toBe(3_000);
  });

  test("disables compaction when the obligation anchor consumes the summary model input", () => {
    const decision = deriveCompactionPolicy(
      budget({ hardInputLimit: 32_000, optionalContextTarget: 12_000 }),
      { mode: "adaptive", summaryReservedInputTokens: 32_000 },
    );

    expect(decision.source).toBe("provider_summary_budget_exhausted");
    expect(decision.compactionEnabled).toBe(false);
    expect(decision.compactThresholdTokens).toBe(0);
    expect(decision.keepRecentTokens).toBe(0);
    expect(decision.maxTranscriptChunkTokens).toBe(1);
  });

  test("rejects token counts that cannot be represented safely by the live planner", () => {
    const unsafe = {
      ...budget({ hardInputLimit: 32_000, optionalContextTarget: 12_000 }),
      optionalContextTarget: BigInt(Number.MAX_SAFE_INTEGER) + 1n as TokenCount,
    };
    expect(() => deriveCompactionPolicy(unsafe)).toThrow("optionalContextTarget");
    expect(() => deriveCompactionPolicy(
      budget({ hardInputLimit: 32_000, optionalContextTarget: 12_000 }),
      { mode: "adaptive", summaryReservedInputTokens: -1 },
    )).toThrow("summaryReservedInputTokens");
  });
});
