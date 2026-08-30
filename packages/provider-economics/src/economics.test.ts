import { describe, test, expect } from "bun:test";
import type { Micros, TokenCount } from "@terminus/domain";
import type { ProviderEconomics } from "@terminus/provider-core";
import { estimateCostMicros } from "./index";

const ECONOMICS: ProviderEconomics = {
  inputMicrosPerMillion: 1_000_000n as Micros, // $1 per million
  cachedInputMicrosPerMillion: 100_000n as Micros,
  outputMicrosPerMillion: 2_000_000n as Micros,
  reasoningAccounting: false,
};

const tokens = (n: number): TokenCount => n as unknown as TokenCount;

describe("estimateCostMicros", () => {
  test("computes split input/cached/output cost", () => {
    // 1M prompt with 400k cached: 600k fresh + 400k cached + 100k out.
    const micros = estimateCostMicros(
      {
        promptTokens: tokens(1_000_000),
        predictedOutputTokens: tokens(100_000),
        predictedReasoningTokens: tokens(0),
        predictedCachedTokens: tokens(400_000),
      },
      ECONOMICS,
    );
    expect(micros).toBe((600_000n + 40_000n + 200_000n) as Micros);
  });

  test("never returns a negative estimate when cached exceeds prompt", () => {
    const micros = estimateCostMicros(
      {
        promptTokens: tokens(1_000),
        predictedOutputTokens: tokens(0),
        predictedReasoningTokens: tokens(0),
        predictedCachedTokens: tokens(5_000),
      },
      ECONOMICS,
    );
    // Cached is clamped to the prompt size: full prompt at cached rate.
    expect(micros > 0n).toBe(true);
    expect(micros).toBe(100n as Micros);
  });

  test("includes observed cache writes when reconciling actual spend", () => {
    const micros = estimateCostMicros(
      {
        promptTokens: tokens(1_000_000),
        predictedOutputTokens: tokens(0),
        predictedReasoningTokens: tokens(0),
        predictedCachedTokens: tokens(200_000),
        cacheWriteTokens: tokens(300_000),
      },
      {
        ...ECONOMICS,
        cacheWriteMicrosPerMillion: 1_250_000n as Micros,
      },
    );

    expect(micros).toBe(895_000n as Micros);
  });
});
