import { describe, expect, test } from "bun:test";
import {
  attemptCostMicros,
  sumAttemptCostMicros,
  sumUsageWire,
  turnStopReason,
  usageWire,
} from "./turn-usage.js";

/** The exact shape `completeAttempt` writes: bigints rendered as strings. */
function recorded(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    inputTokens: "12000",
    cachedInputTokens: "9000",
    cacheWriteTokens: "500",
    outputTokens: "800",
    reasoningTokens: "300",
    toolSchemaTokens: "1200",
    latencyMs: 4200,
    timeToFirstTokenMs: 610,
    ...overrides,
  });
}

describe("per-attempt usage projection", () => {
  test("projects the recorded column under wire names", () => {
    expect(usageWire(recorded())).toEqual({
      input_tokens: "12000",
      cached_input_tokens: "9000",
      cache_write_tokens: "500",
      output_tokens: "800",
      reasoning_tokens: "300",
      tool_schema_tokens: "1200",
      latency_ms: 4200,
      time_to_first_token_ms: 610,
    });
  });

  test("older rows that stored plain numbers read the same", () => {
    expect(usageWire(recorded({ inputTokens: 12_000 })).input_tokens).toBe("12000");
  });

  test("a missing, unreadable or nonsense column reads as zero, never as a guess", () => {
    for (const column of [null, undefined, "", "{not json", "[]", '"text"']) {
      expect(usageWire(column).input_tokens).toBe("0");
      expect(usageWire(column).latency_ms).toBeNull();
    }
    // A negative or fractional count is corruption, not a small number.
    expect(usageWire(recorded({ outputTokens: -5 })).output_tokens).toBe("0");
    expect(usageWire(recorded({ outputTokens: 1.5 })).output_tokens).toBe("0");
    // Never measured is null, which is not the same as measured at zero.
    expect(usageWire(recorded({ timeToFirstTokenMs: null })).time_to_first_token_ms).toBeNull();
    expect(usageWire(recorded({ timeToFirstTokenMs: 0 })).time_to_first_token_ms).toBe(0);
  });
});

describe("turn-level usage", () => {
  test("tokens add; time-to-first-token is the first one measured", () => {
    const summed = sumUsageWire([
      usageWire(recorded({ timeToFirstTokenMs: null, latencyMs: 1_000 })),
      usageWire(recorded({ timeToFirstTokenMs: 610, latencyMs: 2_000 })),
    ]);
    expect(summed.input_tokens).toBe("24000");
    expect(summed.output_tokens).toBe("1600");
    // Latency is time spent waiting across the turn, so it adds.
    expect(summed.latency_ms).toBe(3_000);
    // TTFT is a property of one dispatch; summing it would be meaningless.
    // The first attempt that actually measured one is reported — discarding a
    // real measurement because an earlier attempt reported none would be worse.
    expect(summed.time_to_first_token_ms).toBe(610);
    expect(sumUsageWire([]).time_to_first_token_ms).toBeNull();
    expect(sumUsageWire([usageWire(recorded({ timeToFirstTokenMs: null }))]).time_to_first_token_ms)
      .toBeNull();
  });

  test("a turn with no attempts sums to zero with nothing measured", () => {
    expect(sumUsageWire([])).toEqual({
      input_tokens: "0",
      cached_input_tokens: "0",
      cache_write_tokens: "0",
      output_tokens: "0",
      reasoning_tokens: "0",
      tool_schema_tokens: "0",
      latency_ms: null,
      time_to_first_token_ms: null,
    });
  });

  test("token totals stay exact past 2^53", () => {
    const huge = usageWire(JSON.stringify({ inputTokens: "9007199254740993" }));
    expect(sumUsageWire([huge, huge]).input_tokens).toBe("18014398509481986");
  });
});

describe("turn-level cost", () => {
  test("provider-reported spend wins over the computed estimate", () => {
    expect(attemptCostMicros({
      providerReportedCostMicros: 900n,
      computedCostMicros: 1_000n,
      costSource: "provider_reported",
    })).toBe(900n);
    expect(attemptCostMicros({
      providerReportedCostMicros: null,
      computedCostMicros: 1_000n,
      costSource: "admitted_economics",
    })).toBe(1_000n);
  });

  test("an unknown price is null, because a turn that cost something unknown did not cost nothing", () => {
    expect(attemptCostMicros({
      providerReportedCostMicros: null,
      computedCostMicros: null,
      costSource: "unavailable",
    })).toBeNull();
    expect(sumAttemptCostMicros([
      { providerReportedCostMicros: null, computedCostMicros: null, costSource: "unavailable" },
    ])).toBeNull();
  });

  test("priced attempts sum; unpriced ones are skipped rather than counted as zero", () => {
    expect(sumAttemptCostMicros([
      { providerReportedCostMicros: null, computedCostMicros: 400n, costSource: "admitted_economics" },
      { providerReportedCostMicros: null, computedCostMicros: null, costSource: "unavailable" },
      { providerReportedCostMicros: 100n, computedCostMicros: 999n, costSource: "provider_reported" },
    ])).toBe(500n);
  });
});

describe("turn stop reason", () => {
  test("a terminal error dominates the provider's finish reason", () => {
    // A turn that ended for budget_exhausted is not described by "stop".
    expect(turnStopReason({
      state: "BUDGET_EXHAUSTED",
      terminalError: { reason: "budget_exhausted" },
      lastFinishReason: "tool_use",
    })).toBe("budget_exhausted");
  });

  test("a completed turn with no recorded finish reason still says it stopped", () => {
    expect(turnStopReason({ state: "COMPLETED", terminalError: null, lastFinishReason: null })).toBe("stop");
    expect(turnStopReason({ state: "COMPLETED", terminalError: null, lastFinishReason: "refusal" })).toBe("refusal");
  });

  test("a turn still running reports nothing rather than a plausible default", () => {
    expect(turnStopReason({ state: "PROVIDER_RUNNING", terminalError: null, lastFinishReason: null })).toBeNull();
    expect(turnStopReason({ state: "TOOL_SETTLEMENT", terminalError: {}, lastFinishReason: null })).toBeNull();
  });
});
