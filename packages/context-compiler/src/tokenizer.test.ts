import { describe, expect, test } from "bun:test";
import type { ModelKey, TokenCount } from "@terminus/domain";
import type { UsageRecord } from "@terminus/provider-core";
import {
  CalibratedModelTokenizer,
  resolveTokenizer,
  type TokenizerBinding,
} from "./tokenizer.js";

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
