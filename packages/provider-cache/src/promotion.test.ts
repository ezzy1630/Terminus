import { describe, expect, test } from "bun:test";
import type { ModelKey, TokenCount } from "@terminus/domain";
import { micros } from "@terminus/domain";
import {
  CacheRecorder,
  analyzeCacheExperiment,
  evaluateCachePromotion,
  type CachePromotionTrial,
} from "./index.js";

const MODEL = "provider/model" as ModelKey;

function observation(id: string, hitTokens: bigint) {
  const recorder = new CacheRecorder({
    manifestId: id,
    providerId: "provider",
    model: MODEL,
    predictedCachedTokens: hitTokens as TokenCount,
    inputTokens: 1_000n as TokenCount,
    eligibleInputTokens: 800n as TokenCount,
    pricing: {
      inputMicrosPerMillion: micros(2_000_000),
      cachedInputMicrosPerMillion: micros(500_000),
      cacheWriteMicrosPerMillion: micros(100_000),
    },
  });
  recorder.recordHit(hitTokens as TokenCount);
  if (hitTokens < 800n) recorder.recordMiss(null, null, (800n - hitTokens) as TokenCount);
  return recorder.finalize();
}

function trial(
  pairId: string,
  side: "baseline" | "candidate",
  qualityScore = 0.8,
  latencyMs = 100,
  hitTokens = side === "baseline" ? 600n : 800n,
): CachePromotionTrial {
  const record = observation(`${side}-${pairId}`, hitTokens);
  return {
    pairId,
    cohort: "small-bugfix",
    taskId: `task-${pairId}`,
    observation: record,
    qualityScore,
    latencyMs,
    providerReceipt: {
      receiptId: `receipt-${side}-${pairId}`,
      providerId: "provider",
      model: MODEL,
      artifactRef: `artifact://${side}-${pairId}`,
      verified: true,
    },
    independentlyVerified: true,
  };
}

describe("cache promotion guardrails", () => {
  test("does not promote a single cache observation", () => {
    const result = analyzeCacheExperiment({
      explicitBreakpoints: false,
      minCacheableTokens: 256,
      toolOrderOptimization: false,
    }, [observation("single", 800n)]);

    expect(result.minimumCohort).toBe(20);
    expect(result.cohortComplete).toBe(false);
    expect(result.recommendation).toBe("retain_experimental");
  });

  test("blocks promotion until the exact minimum paired cohort is present", () => {
    const result = evaluateCachePromotion({
      experimentId: "cache-layout-v2",
      cohort: "small-bugfix",
      baselineVersion: "baseline-v1",
      candidateVersion: "candidate-v2",
      evidenceId: "evidence-1",
      baseline: [trial("pair-1", "baseline")],
      candidate: [trial("pair-1", "candidate")],
      holdoutComplete: true,
    });

    expect(result.promotionEligible).toBe(false);
    expect(result.decision).toBe("retain_experimental");
    expect(result.gates.find((gate) => gate.name === "cohort")?.status).toBe("blocked");
    expect(result.shadowOnly).toBe(true);
    expect(result.defaultEnabled).toBe(false);
  });

  test("promotes only complete paired evidence and remains shadow-only", () => {
    const baseline = [trial("pair-1", "baseline"), trial("pair-2", "baseline")];
    const candidate = [trial("pair-1", "candidate"), trial("pair-2", "candidate")];
    const result = evaluateCachePromotion({
      experimentId: "cache-layout-v2",
      cohort: "small-bugfix",
      baselineVersion: "baseline-v1",
      candidateVersion: "candidate-v2",
      evidenceId: "evidence-2",
      baseline,
      candidate,
      holdoutComplete: true,
      policy: { minimumPairs: 2 },
    });

    expect(result.promotionEligible).toBe(true);
    expect(result.decision).toBe("promote");
    expect(result.cacheHitRate.delta).toBeGreaterThan(0);
    expect(result.effectiveInputCostMicros.deltaPercent).toBeLessThan(0);
    expect(result.shadowOnly).toBe(true);
    expect(result.defaultEnabled).toBe(false);
  });

  test("rolls back measured quality and latency regressions", () => {
    const result = evaluateCachePromotion({
      experimentId: "cache-layout-v2",
      cohort: "small-bugfix",
      baselineVersion: "baseline-v1",
      candidateVersion: "candidate-v2",
      evidenceId: "evidence-3",
      baseline: [trial("pair-1", "baseline"), trial("pair-2", "baseline")],
      candidate: [
        trial("pair-1", "candidate", 0.5, 250),
        trial("pair-2", "candidate", 0.5, 250),
      ],
      holdoutComplete: true,
      policy: { minimumPairs: 2 },
    });

    expect(result.promotionEligible).toBe(false);
    expect(result.decision).toBe("rollback");
    expect(result.gates.find((gate) => gate.name === "paired_quality")?.status).toBe("fail");
    expect(result.gates.find((gate) => gate.name === "latency")?.status).toBe("fail");
  });
});
