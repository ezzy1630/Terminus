import { describe, expect, test } from "bun:test";
import type { Micros, TokenCount } from "@terminus/domain";
import { computeCost, computeExactCostMicros, type ProviderEconomics, type UsageRecord } from "./index.js";

const economics: ProviderEconomics = {
  inputMicrosPerMillion: 3_000_000n as Micros,
  cachedInputMicrosPerMillion: 750_000n as Micros,
  outputMicrosPerMillion: 15_000_000n as Micros,
  reasoningAccounting: true,
};

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    inputTokens: 1_000_000n as TokenCount,
    cachedInputTokens: 400_000n as TokenCount,
    cacheWriteTokens: 0n as TokenCount,
    outputTokens: 100_000n as TokenCount,
    reasoningTokens: 10n as TokenCount,
    toolSchemaTokens: 0n as TokenCount,
    latencyMs: 0,
    timeToFirstTokenMs: null,
    ...overrides,
  };
}

describe("provider cost accounting", () => {
  test("computes exact costs without converting token counts to Number", () => {
    const exact = computeExactCostMicros(
      usage({
        inputTokens: 9_007_199_254_740_993n as TokenCount,
        cachedInputTokens: 0n as TokenCount,
        outputTokens: 0n as TokenCount,
        reasoningTokens: 0n as TokenCount,
      }),
      {
        inputMicrosPerMillion: 1_000_000n as Micros,
        cachedInputMicrosPerMillion: 0n as Micros,
        outputMicrosPerMillion: 0n as Micros,
        reasoningAccounting: false,
      },
    );

    expect(exact).toBe(9_007_199_254_740_993n as Micros);
  });

  test("charges cached input at the cached rate instead of double-counting it", () => {
    const cost = computeCost({
      usage: usage(),
      economics,
      providerReportedCostMicros: null,
    });

    expect(cost.inputMicros).toBe(1_800_000n as Micros);
    expect(cost.cachedInputMicros).toBe(300_000n as Micros);
    expect(cost.outputMicros).toBe(1_500_000n as Micros);
    expect(cost.reasoningMicros).toBe(150n as Micros);
    expect(cost.computedCostMicros).toBe(3_600_150n as Micros);
  });

  test("detects large-value accounting anomalies without lossy comparisons", () => {
    const computed = computeExactCostMicros(usage({
      inputTokens: 9_007_199_254_740_993n as TokenCount,
      cachedInputTokens: 0n as TokenCount,
      outputTokens: 0n as TokenCount,
      reasoningTokens: 0n as TokenCount,
    }), { ...economics, inputMicrosPerMillion: 1n as Micros });
    const record = computeCost({
      usage: usage({
        inputTokens: 9_007_199_254_740_993n as TokenCount,
        cachedInputTokens: 0n as TokenCount,
        outputTokens: 0n as TokenCount,
        reasoningTokens: 0n as TokenCount,
      }),
      economics: { ...economics, inputMicrosPerMillion: 1n as Micros },
      providerReportedCostMicros: (computed * 2n) as Micros,
    });

    expect(record.anomaly).toBe(true);
    expect(record.anomalyReason).toContain(computed.toString());
  });
});
