import { describe, expect, test } from "bun:test";
import type { ModelKey, TokenCount } from "@terminus/domain";
import type { UsageRecord } from "@terminus/provider-core";
import {
  CalibratedModelTokenizer,
  MESSAGE_ENVELOPE_TOKENS,
  PROSE_BYTES_PER_TOKEN,
  STRUCTURED_BYTES_PER_TOKEN,
  STRUCTURED_DENSITY_THRESHOLD,
  estimateMessageTokens,
  observeAttemptUsage,
  processCalibrationSeed,
  promptTokensFromUsage,
  resetProcessCalibration,
  resolveTokenizer,
  structuralDensity,
  type TokenizerBinding,
} from "./tokenizer.js";
import calibrationFixture from "./tokenizer-calibration.fixture.json" with { type: "json" };

const MODEL = "openai/test-model" as ModelKey;

function usage(inputTokens: number): UsageRecord {
  return {
    inputTokens: BigInt(inputTokens) as TokenCount,
    cachedInputTokens: 7n as TokenCount,
    cacheWriteTokens: 3n as TokenCount,
    outputTokens: 11n as TokenCount,
    reasoningTokens: 5n as TokenCount,
    toolSchemaTokens: 2n as TokenCount,
    latencyMs: 10,
    timeToFirstTokenMs: null,
  };
}

describe("calibrated token estimator", () => {
  test("marks the built-in fallback degraded instead of claiming provider accuracy", () => {
    const estimator = resolveTokenizer("openai", MODEL);
    const estimate = estimator.estimateText("const value = 1;");

    expect(estimate.source).toBe("explicit_fallback");
    expect(estimate.calibrationStatus).toBe("degraded");
    expect(estimator.calibration.bindingId).toBeNull();
    expect(estimator.calibration.reason).toContain("provider usage sample");
  });

  test("updates a fallback profile from provider usage and reports calibration state", () => {
    const estimator = new CalibratedModelTokenizer("openai", MODEL);

    estimator.observeUsage("manifest-1", 100, usage(120));
    estimator.observeUsage("manifest-2", 100, usage(120));
    const reconciled = estimator.observeUsage("manifest-3", 100, usage(120));

    expect(estimator.calibration.sampleCount).toBe(3);
    expect(estimator.calibration.scale).toBeCloseTo(1.2, 5);
    expect(estimator.calibration.status).toBe("calibrated");
    expect(reconciled.calibrationStatus).toBe("calibrated");
    expect(reconciled.cachedTokensObserved).toBe(7);
    expect(reconciled.cacheWriteTokensObserved).toBe(3);
    expect(reconciled.toolSchemaTokensObserved).toBe(2);
    expect(estimator.estimateText("abcd").source).toBe("observed_calibration");
  });

  test("keeps calibration degraded when provider usage is unavailable", () => {
    const estimator = new CalibratedModelTokenizer("openai", MODEL);
    const reconciled = estimator.observeUsage(
      "manifest-missing-usage",
      100,
      usage(0),
      { usageAvailable: false },
    );

    expect(reconciled.observedUsageAvailable).toBe(false);
    expect(reconciled.calibrationStatus).toBe("degraded");
    expect(estimator.calibration.sampleCount).toBe(0);
  });

  test("reports degraded calibration when observed error stays above the policy bound", () => {
    const estimator = new CalibratedModelTokenizer("openai", MODEL);

    estimator.observeUsage("manifest-high-error-1", 100, usage(200));
    estimator.observeUsage("manifest-high-error-2", 100, usage(400));
    const reconciled = estimator.observeUsage("manifest-high-error-3", 100, usage(100));

    expect(estimator.calibration.sampleCount).toBe(3);
    expect(estimator.calibration.status).toBe("degraded");
    expect(estimator.calibration.meanAbsolutePercentageError).toBeGreaterThan(15);
    expect(reconciled.calibrationReason).toContain("exceeds");
  });

  test("accepts an explicit binding without importing a provider SDK", () => {
    const binding: TokenizerBinding = {
      bindingId: "test-tokenizer",
      bindingVersion: "2026-08-24",
      providerId: "openai",
      modelKey: MODEL,
      estimateTextTokens: () => 9,
    };
    const estimator = resolveTokenizer("openai", MODEL, { binding });

    expect(estimator.calibration.status).toBe("calibrated");
    expect(estimator.calibration.bindingId).toBe("test-tokenizer");
    expect(estimator.estimateText("anything")).toMatchObject({
      tokens: 9,
      source: "verified_binding",
      calibrationStatus: "calibrated",
    });
  });
});

// ────────────────────────── Calibration against live usage ──────────────────

interface CalibrationMessage {
  readonly bytes: number;
  readonly structuralDensity: number;
}

interface CalibrationSample {
  readonly model: string;
  readonly observedInputTokens: number;
  readonly messages: readonly CalibrationMessage[];
  readonly toolSchemaBytes: number;
  readonly toolSchemaStructuralDensity: number;
  readonly toolCount: number;
}

/**
 * 34 real provider attempts captured from this checkout's
 * `.terminus-dev/control.db` on 2026-08-29: the byte profile of every message
 * in the rendered request beside the provider's own `inputTokens`.
 */
const CALIBRATION_FIXTURE = calibrationFixture as {
  readonly samples: readonly CalibrationSample[];
};

/** Predict a whole request under a given bytes-per-token model. */
function predictRequest(
  sample: CalibrationSample,
  options: {
    readonly prose: number;
    readonly structured: number;
    readonly threshold: number;
    readonly perMessage: number;
    readonly includeTools: boolean;
  },
): number {
  const rate = (density: number): number =>
    density > options.threshold ? options.structured : options.prose;
  let total = 0;
  for (const message of sample.messages) {
    if (message.bytes > 0) {
      total += Math.max(1, Math.ceil(message.bytes / rate(message.structuralDensity)));
    }
    total += options.perMessage;
  }
  if (options.includeTools && sample.toolSchemaBytes > 0) {
    total += Math.max(
      1,
      Math.ceil(sample.toolSchemaBytes / rate(sample.toolSchemaStructuralDensity)),
    ) + 2 * sample.toolCount;
  }
  return total;
}

function errorStatistics(
  predict: (sample: CalibrationSample) => number,
): { readonly meanSignedPercent: number; readonly meanAbsolutePercent: number; readonly maxAbsolutePercent: number } {
  const errors = CALIBRATION_FIXTURE.samples.map((sample) =>
    (predict(sample) - sample.observedInputTokens) / sample.observedInputTokens * 100);
  const absolute = errors.map((value) => Math.abs(value));
  return {
    meanSignedPercent: errors.reduce((sum, value) => sum + value, 0) / errors.length,
    meanAbsolutePercent: absolute.reduce((sum, value) => sum + value, 0) / absolute.length,
    maxAbsolutePercent: Math.max(...absolute),
  };
}

describe("token estimator calibration (live provider usage)", () => {
  test("fixture carries real attempts, not synthetic rows", () => {
    expect(CALIBRATION_FIXTURE.samples.length).toBeGreaterThanOrEqual(30);
    for (const sample of CALIBRATION_FIXTURE.samples) {
      expect(sample.observedInputTokens).toBeGreaterThan(0);
      expect(sample.messages.length).toBeGreaterThan(0);
    }
  });

  test("the shipped constants predict live token counts within 10% MAPE", () => {
    const statistics = errorStatistics((sample) => predictRequest(sample, {
      prose: PROSE_BYTES_PER_TOKEN,
      structured: STRUCTURED_BYTES_PER_TOKEN,
      threshold: STRUCTURED_DENSITY_THRESHOLD,
      perMessage: MESSAGE_ENVELOPE_TOKENS,
      includeTools: true,
    }));
    // Measured 2026-08-29 over the 34 live attempts: mean -3.5%, MAPE 6.6%,
    // max 22.0% (the max is nemotron-3-ultra, whose tokenizer is denser than
    // the OpenAI-family models the constants are centred on).
    expect(statistics.meanAbsolutePercent).toBeLessThan(10);
    expect(Math.abs(statistics.meanSignedPercent)).toBeLessThan(6);
    expect(statistics.maxAbsolutePercent).toBeLessThan(25);
  });

  test("beats the uncalibrated bytes/4 text-only estimator it replaces", () => {
    const legacy = errorStatistics((sample) => sample.messages.reduce(
      (sum, message) => sum + (message.bytes === 0 ? 0 : Math.max(1, Math.ceil(message.bytes / 4))),
      0,
    ));
    const calibrated = errorStatistics((sample) => predictRequest(sample, {
      prose: PROSE_BYTES_PER_TOKEN,
      structured: STRUCTURED_BYTES_PER_TOKEN,
      threshold: STRUCTURED_DENSITY_THRESHOLD,
      perMessage: MESSAGE_ENVELOPE_TOKENS,
      includeTools: true,
    }));
    // The legacy estimator under-counted by ~46% on exactly these requests.
    expect(legacy.meanSignedPercent).toBeLessThan(-40);
    expect(calibrated.meanAbsolutePercent).toBeLessThan(legacy.meanAbsolutePercent / 4);
  });

  test("classifies JSON envelopes as structured and prose as prose", () => {
    const toolResult = JSON.stringify({
      protocol: "terminus.tool-result.v1",
      provider_call_id: "call_1",
      result: { status: "ok", summary: "read 40 lines", data: { lines: 40 } },
    });
    expect(structuralDensity(toolResult)).toBeGreaterThan(STRUCTURED_DENSITY_THRESHOLD);
    const prose = "Read the file before editing it, then run the narrowest check that proves the change landed.";
    expect(structuralDensity(prose)).toBeLessThan(STRUCTURED_DENSITY_THRESHOLD);
  });

  test("a fragment estimate includes the per-message chat-template envelope", () => {
    const estimator = resolveTokenizer("openai", MODEL);
    const text = "a".repeat(360);
    const breakdown = estimator.estimateFragmentTokens({ textContent: text } as never);
    expect(breakdown.templateTokens).toBe(MESSAGE_ENVELOPE_TOKENS);
    expect(breakdown.totalTokens).toBe(breakdown.textTokens + MESSAGE_ENVELOPE_TOKENS);
    expect(estimateMessageTokens(estimator, text)).toBe(breakdown.totalTokens);
  });
});

describe("estimator feedback actually closes the loop", () => {
  const FEEDBACK_MODEL = "gpt-5.6-sol" as ModelKey;
  const CLAUDE_MODEL = "claude-opus-5" as ModelKey;

  function attemptUsage(overrides: {
    readonly inputTokens?: bigint;
    readonly cachedInputTokens?: bigint;
    readonly cacheWriteTokens?: bigint;
  } = {}): UsageRecord {
    return {
      ...usage(0),
      inputTokens: (overrides.inputTokens ?? 0n) as TokenCount,
      cachedInputTokens: (overrides.cachedInputTokens ?? 0n) as TokenCount,
      cacheWriteTokens: (overrides.cacheWriteTokens ?? 0n) as TokenCount,
    };
  }

  test("prompt size is read the way each vendor reports it", () => {
    // OpenAI: input_tokens is the total; cached_tokens is a subset of it.
    expect(promptTokensFromUsage("openai", attemptUsage({
      inputTokens: 1_000n, cachedInputTokens: 800n,
    }))).toBe(1_000);
    // Anthropic: input_tokens is the uncached remainder only.
    expect(promptTokensFromUsage("anthropic", attemptUsage({
      inputTokens: 200n, cachedInputTokens: 800n, cacheWriteTokens: 100n,
    }))).toBe(1_100);
    // Taking the raw field here would teach the estimator that a well-cached
    // Anthropic prompt is a fifth of its real size.
    expect(promptTokensFromUsage("anthropic", attemptUsage({
      inputTokens: 200n, cachedInputTokens: 800n, cacheWriteTokens: 100n,
    }))).not.toBe(200);
  });

  test("an observation survives into the next tokenizer this process resolves", () => {
    resetProcessCalibration();
    // The bug: resolveTokenizer mints a new estimator every call, so a sample
    // recorded on one instance was discarded before anything could read it.
    expect(resolveTokenizer("openai", FEEDBACK_MODEL).calibration.sampleCount).toBe(0);

    for (let sample = 0; sample < 3; sample += 1) {
      const reconciled = observeAttemptUsage({
        providerId: "openai",
        modelKey: FEEDBACK_MODEL,
        manifestId: `manifest-${sample}`,
        predictedPromptTokens: 1_000,
        usage: attemptUsage({ inputTokens: 1_200n }),
      });
      expect(reconciled?.observedTokens).toBe(1_200);
    }

    const next = resolveTokenizer("openai", FEEDBACK_MODEL);
    expect(next.calibration.sampleCount).toBe(3);
    expect(next.calibration.scale).toBeCloseTo(1.2, 5);
    expect(next.calibration.status).toBe("calibrated");
    expect(next.calibration.source).toBe("observed_usage");
    // …and the estimate itself moved: the whole point of learning the scale.
    expect(next.estimateText("const value = 1;").tokens)
      .toBeGreaterThan(resolveTokenizer("openai", "unseen-model" as ModelKey).estimateText("const value = 1;").tokens);
    resetProcessCalibration();
  });

  test("calibration is keyed per provider and model, never shared", () => {
    resetProcessCalibration();
    observeAttemptUsage({
      providerId: "openai",
      modelKey: FEEDBACK_MODEL,
      manifestId: "manifest-a",
      predictedPromptTokens: 1_000,
      usage: attemptUsage({ inputTokens: 1_500n }),
    });
    expect(processCalibrationSeed("openai", FEEDBACK_MODEL)?.sampleCount).toBe(1);
    expect(processCalibrationSeed("anthropic", CLAUDE_MODEL)).toBeUndefined();
    expect(resolveTokenizer("anthropic", CLAUDE_MODEL).calibration.sampleCount).toBe(0);
    resetProcessCalibration();
  });

  test("nothing to learn from is reported as such instead of poisoning the scale", () => {
    resetProcessCalibration();
    const base = {
      providerId: "openai",
      modelKey: FEEDBACK_MODEL,
      manifestId: "manifest-empty",
      usage: attemptUsage({ inputTokens: 1_200n }),
    };
    expect(observeAttemptUsage({ ...base, predictedPromptTokens: 0 })).toBeNull();
    expect(observeAttemptUsage({ ...base, predictedPromptTokens: Number.NaN })).toBeNull();
    expect(observeAttemptUsage({
      ...base,
      predictedPromptTokens: 1_000,
      usage: attemptUsage({ inputTokens: 0n }),
    })).toBeNull();
    expect(processCalibrationSeed("openai", FEEDBACK_MODEL)).toBeUndefined();
    resetProcessCalibration();
  });

  test("an explicit seed still wins over the process registry", () => {
    resetProcessCalibration();
    observeAttemptUsage({
      providerId: "openai",
      modelKey: FEEDBACK_MODEL,
      manifestId: "manifest-a",
      predictedPromptTokens: 1_000,
      usage: attemptUsage({ inputTokens: 2_000n }),
    });
    const pinned = resolveTokenizer("openai", FEEDBACK_MODEL, { calibration: { sampleCount: 9, scale: 1 } });
    expect(pinned.calibration.sampleCount).toBe(9);
    expect(pinned.calibration.scale).toBe(1);
    resetProcessCalibration();
  });
});
