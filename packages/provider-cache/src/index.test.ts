import { describe, expect, test } from "bun:test";
import type { ContentHash, Micros, ModelKey, TokenCount } from "@terminus/domain";
import { micros } from "@terminus/domain";
import type { UsageRecord } from "@terminus/provider-core";
import {
  CacheRecorder,
  analyzeCacheExperiment,
  computeCacheEconomics,
  usageToCacheEvents,
} from "./index.js";

const MODEL = "provider/model" as ModelKey;
const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ContentHash;

function recorder(overrides: Partial<ConstructorParameters<typeof CacheRecorder>[0]> = {}): CacheRecorder {
  return new CacheRecorder({
    manifestId: "manifest-1",
    providerId: "provider",
    model: MODEL,
    predictedCachedTokens: 600n as TokenCount,
    inputTokens: 1_000n as TokenCount,
    eligibleInputTokens: 800n as TokenCount,
    pricing: {
      inputMicrosPerMillion: micros(2_000_000),
      cachedInputMicrosPerMillion: micros(500_000),
      cacheWriteMicrosPerMillion: micros(100_000),
    },
    ...overrides,
  });
}

describe("provider cache accounting", () => {
  test("records token-weighted reads, hits, misses, drift, and economics", () => {
    const r = recorder({ usageSemantics: "hit_tokens" });
    r.recordHit(600n as TokenCount);
    r.recordMiss(1, HASH, 200n as TokenCount, "prefix_changed", "contract");

    const observation = r.finalize();

    expect(observation.cacheHitTokens).toBe(600n as TokenCount);
    expect(observation.cacheMissTokens).toBe(200n as TokenCount);
    expect(observation.tokenWeightedHitRate).toBe(0.75);
    expect(observation.cacheReadRate).toBe(0.6);
    expect(observation.firstMissReason).toBe("prefix_changed");
    expect(observation.firstDifferingFragmentId).toBe("contract");
    expect(observation.firstDriftReason).toBe("prefix_changed");
    expect(observation.providerReportedCacheSavingsMicros).toBeNull();
    expect(observation.stablePrefixPreserved).toBe(false);
    expect(observation.economics?.effectiveInputCostMicros).toBe(1_100n as Micros);
    expect(observation.economics?.cacheSavingsMicros).toBe(900n as Micros);
  });

  test("retains provider-reported cache savings separately from computed economics", () => {
    const observation = recorder({
      providerReportedCacheSavingsMicros: micros(777),
    }).finalize();

    expect(observation.providerReportedCacheSavingsMicros).toBe(777n as Micros);
    expect(observation.economics?.cacheSavingsMicros).toBe(0n as Micros);
  });

  test("does not infer cache hits from an opaque usage field", () => {
    const usage: UsageRecord = {
      inputTokens: 1_000n as TokenCount,
      cachedInputTokens: 600n as TokenCount,
      cacheWriteTokens: 0n as TokenCount,
      outputTokens: 0n as TokenCount,
      reasoningTokens: 0n as TokenCount,
      toolSchemaTokens: 0n as TokenCount,
      latencyMs: 10,
      timeToFirstTokenMs: 3,
    };
    const events = usageToCacheEvents(usage);

    expect(events.cacheReads).toBe(600n as TokenCount);
    expect(events.cacheHits).toBe(0n as TokenCount);
    expect(events.usageSemantics).toBe("unknown");
    expect(usageToCacheEvents(usage, "hit_tokens").cacheHits).toBe(600n as TokenCount);
    expect(usageToCacheEvents(usage, "hit_tokens").cacheReads).toBe(0n as TokenCount);
  });

  test("requires complete token/economics evidence before promotion", () => {
    const r = recorder({
      inputTokens: null,
      eligibleInputTokens: null,
      pricing: null,
    });
    r.recordHit(600n as TokenCount);
    const observation = r.finalize();
    expect(computeCacheEconomics(observation, {
      inputMicrosPerMillion: micros(2_000_000),
      cachedInputMicrosPerMillion: micros(500_000),
    })).toBeNull();

    const result = analyzeCacheExperiment({
      explicitBreakpoints: false,
      minCacheableTokens: 256,
      toolOrderOptimization: false,
    }, [observation]);
    expect(result.economicsComplete).toBe(false);
    expect(result.recommendation).toBe("retain_experimental");
  });
});
