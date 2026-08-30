import { describe, expect, test } from "bun:test";
import {
  CLAUDE_5_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_CEILING,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REASONING_RESERVE_TOKENS,
  FAMILY_MAX_OUTPUT_TOKENS,
  GPT_5_6_CONTEXT_HARD_CAP,
  normalizeModelId,
  resolveMaxOutputTokens,
  resolveModelFamily,
  resolveReasoningReserveTokens,
  resolveTestedSafeContextTokens,
} from "./model_family.js";

describe("model family resolution", () => {
  test("recognises the GPT-5.6 tiers and their aliases", () => {
    for (const id of [
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "openai/gpt-5.6-sol",
      "GPT-5.6-Sol",
    ]) {
      expect(resolveModelFamily(id)).toBe("gpt-5.6");
    }
  });

  test("recognises the Claude 5 tiers without swallowing 4.5", () => {
    for (const id of [
      "claude-opus-5",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-mythos-5",
      "anthropic/claude-opus-5",
    ]) {
      expect(resolveModelFamily(id)).toBe("claude-5");
    }
    // `-4-5` is the fifth minor of Claude 4, not Claude 5.
    for (const id of ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5", "claude-opus-4-8"]) {
      expect(resolveModelFamily(id)).toBe("other");
    }
  });

  test("falls through to the conservative branch for anything else", () => {
    for (const id of ["gpt-4o", "o3-mini", "big-pickle", "deepseek-v4-flash-free", ""]) {
      expect(resolveModelFamily(id)).toBe("other");
    }
  });

  test("strips a routing prefix before matching", () => {
    expect(normalizeModelId("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(normalizeModelId("  Claude-Opus-5 ")).toBe("claude-opus-5");
    expect(normalizeModelId("gpt-4o")).toBe("gpt-4o");
  });
});

describe("tested-safe context ceilings", () => {
  test("caps GPT-5.6 at the 272K billing cliff, whatever the catalogue advertises", () => {
    // Advertised 1,050,000; billed 2x input / 1.5x output past 272,000.
    expect(resolveTestedSafeContextTokens({ modelId: "gpt-5.6-sol", contextTokens: 1_050_000 }))
      .toBe(GPT_5_6_CONTEXT_HARD_CAP);
    // A catalogue that reports nothing (the Codex `/models` document) still
    // gets the family ceiling rather than zero.
    expect(resolveTestedSafeContextTokens({ modelId: "gpt-5.6-terra", contextTokens: 0 }))
      .toBe(GPT_5_6_CONTEXT_HARD_CAP);
    // A smaller advertised window wins over the cap.
    expect(resolveTestedSafeContextTokens({ modelId: "gpt-5.6-luna", contextTokens: 128_000 }))
      .toBe(128_000);
  });

  test("gives Claude 5 its whole catalogue window", () => {
    expect(resolveTestedSafeContextTokens({ modelId: "claude-opus-5", contextTokens: 1_000_000 }))
      .toBe(1_000_000);
    expect(resolveTestedSafeContextTokens({ modelId: "claude-fable-5", contextTokens: 0 }))
      .toBe(CLAUDE_5_CONTEXT_TOKENS);
  });

  test("caps every other model at 200k and leaves an unknown window unknown", () => {
    expect(resolveTestedSafeContextTokens({ modelId: "gpt-4o", contextTokens: 128_000 })).toBe(128_000);
    expect(resolveTestedSafeContextTokens({ modelId: "nemotron-3-ultra-free", contextTokens: 1_000_000 }))
      .toBe(DEFAULT_CONTEXT_CEILING);
    expect(resolveTestedSafeContextTokens({ modelId: "mystery", contextTokens: 0 })).toBe(0);
  });

  test("replaces the old blanket 32,768 clamp", () => {
    // The regression this resolver exists to prevent: a 1M-context model
    // driven with 3% of its window.
    for (const id of ["gpt-5.6-sol", "claude-opus-5"]) {
      expect(resolveTestedSafeContextTokens({ modelId: id, contextTokens: 1_000_000 }))
        .toBeGreaterThan(32_768);
    }
  });
});

describe("max output tokens", () => {
  test("both current families answer 128k", () => {
    expect(resolveMaxOutputTokens({ modelId: "gpt-5.6-sol", outputTokens: 128_000 }))
      .toBe(FAMILY_MAX_OUTPUT_TOKENS);
    // The Codex catalogue reports no output limit at all.
    expect(resolveMaxOutputTokens({ modelId: "gpt-5.6-sol", outputTokens: 0 }))
      .toBe(FAMILY_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ modelId: "claude-opus-5", outputTokens: 0 }))
      .toBe(FAMILY_MAX_OUTPUT_TOKENS);
  });

  test("takes the catalogue's own number for anything else", () => {
    expect(resolveMaxOutputTokens({ modelId: "gpt-4o", outputTokens: 16_384 })).toBe(16_384);
    expect(resolveMaxOutputTokens({ modelId: "mystery", outputTokens: 0 })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("never returns the 1024 that truncated every real patch", () => {
    for (const id of ["gpt-5.6-sol", "claude-opus-5", "gpt-4o", "mystery"]) {
      expect(resolveMaxOutputTokens({ modelId: id, outputTokens: 0 })).toBeGreaterThan(1_024);
    }
  });
});

describe("reasoning reserve", () => {
  test("scales with the effort the user chose", () => {
    expect(resolveReasoningReserveTokens("low")).toBe(4_096);
    expect(resolveReasoningReserveTokens("medium")).toBe(16_384);
    expect(resolveReasoningReserveTokens("high")).toBe(32_768);
    expect(resolveReasoningReserveTokens("max")).toBe(65_536);
  });

  test("takes the middle rung when the user chose nothing", () => {
    expect(resolveReasoningReserveTokens(null)).toBe(DEFAULT_REASONING_RESERVE_TOKENS);
    expect(resolveReasoningReserveTokens(undefined)).toBe(DEFAULT_REASONING_RESERVE_TOKENS);
  });

  test("is never zero — the old value that switched reasoning off entirely", () => {
    for (const effort of ["low", "medium", "high", "max", null] as const) {
      expect(resolveReasoningReserveTokens(effort)).toBeGreaterThan(0);
    }
  });
});
