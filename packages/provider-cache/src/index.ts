/**
 * @terminus/provider-cache — cache observation recording (§38.9).
 *
 * Records cache read/write/hit/miss events, detects stable-prefix drift,
 * computes cache hit rates. Pure functions — no network I/O.
 */
import type { ContentHash, Micros, ModelKey, Rfc3339Timestamp, TokenCount } from "@terminus/domain";
import type { UsageRecord } from "@terminus/provider-core";
import type {
  CacheEconomicsObservation,
  CacheEventKind,
  CacheEventSource,
  CacheEvent,
  CacheMissReason,
  CacheObservationOptions,
  CacheObservationRecord,
  CacheUsageSemantics,
} from "@terminus/provider-core";
import { computeCacheObservation } from "@terminus/provider-core";

export { computeCacheObservation };
export type {
  CacheEconomicsObservation,
  CacheEventKind,
  CacheEventSource,
  CacheEvent,
  CacheMissReason,
  CacheObservationOptions,
  CacheObservationRecord,
  CacheUsageSemantics,
};

// ────────────────────────── Cache recording pipeline ─────────────────────────

export interface CacheRecordingOpts {
  readonly manifestId: string;
  readonly providerId: string;
  readonly model: ModelKey;
  readonly predictedCachedTokens: TokenCount;
  readonly eligibleInputTokens?: TokenCount | null;
  readonly inputTokens?: TokenCount | null;
  readonly usageSemantics?: CacheUsageSemantics;
  readonly pricing?: CachePricing | null;
  readonly providerReportedCostMicros?: Micros | null;
  readonly providerReportedCacheSavingsMicros?: Micros | null;
  readonly computedCostMicros?: Micros | null;
  readonly timeToFirstTokenMs?: number | null;
}

/**
 * Accumulates cache events during a provider stream, then computes the
 * observation record. Use `recordCacheEvent` for each SSE cache event,
 * then `finalizeCacheRecord` at stream end.
 */
export class CacheRecorder {
  private readonly events: CacheEvent[] = [];
  private readonly opts: CacheRecordingOpts;

  constructor(opts: CacheRecordingOpts) {
    this.opts = opts;
  }

  /** Record a cache read (tokens read from provider cache). */
  recordRead(tokens: TokenCount): void {
    this.events.push({
      kind: "read",
      tokens,
      breakpointIndex: null,
      stablePrefixHash: null,
      occurredAt: new Date().toISOString(),
      source: "provider_event",
    });
  }

  /** Record a cache write (tokens written to provider cache). */
  recordWrite(tokens: TokenCount): void {
    this.events.push({
      kind: "write",
      tokens,
      breakpointIndex: null,
      stablePrefixHash: null,
      occurredAt: new Date().toISOString(),
      source: "provider_event",
    });
  }

  /** Record a cache hit (tokens served from cache). */
  recordHit(tokens: TokenCount): void {
    this.events.push({
      kind: "hit",
      tokens,
      breakpointIndex: null,
      stablePrefixHash: null,
      occurredAt: new Date().toISOString(),
      source: "provider_event",
    });
  }

  /** Record a cache miss with optional prefix drift info. */
  recordMiss(
    breakpointIndex: number | null,
    stablePrefixHash: ContentHash | null,
    tokens: TokenCount = 0n as TokenCount,
    missReason: CacheMissReason = "unknown",
    firstDifferingFragmentId: string | null = null,
  ): void {
    this.events.push({
      kind: "miss",
      tokens,
      breakpointIndex,
      stablePrefixHash,
      occurredAt: new Date().toISOString(),
      missReason,
      firstDifferingFragmentId,
      source: "provider_event",
    });
  }

  /** Finalize and return the observation record. */
  finalize(): CacheObservationRecord {
    const observation = computeCacheObservation(
      this.opts.manifestId,
      this.opts.providerId,
      this.opts.model,
      this.events,
      this.opts.predictedCachedTokens,
      {
        eligibleInputTokens: this.opts.eligibleInputTokens ?? null,
        inputTokens: this.opts.inputTokens ?? null,
        usageSemantics: this.opts.usageSemantics ?? "unknown",
        providerReportedCostMicros: this.opts.providerReportedCostMicros ?? null,
        providerReportedCacheSavingsMicros: this.opts.providerReportedCacheSavingsMicros ?? null,
        computedCostMicros: this.opts.computedCostMicros ?? null,
        timeToFirstTokenMs: this.opts.timeToFirstTokenMs ?? null,
      },
    );
    const economics = this.opts.pricing === undefined || this.opts.pricing === null
      ? null
      : computeCacheEconomics(observation, this.opts.pricing);
    return economics === null ? observation : { ...observation, economics };
  }

  /** Current event count (for testing). */
  get eventCount(): number {
    return this.events.length;
  }
}

// ────────────────────────── Cache experiment utilities ───────────────────────

export interface CacheExperimentConfig {
  /** Whether to use explicit breakpoints in this experiment. */
  readonly explicitBreakpoints: boolean;
  /** Minimum tokens before a cache breakpoint. */
  readonly minCacheableTokens: number;
  /** Whether to reorder tools to maximize cache hits. */
  readonly toolOrderOptimization: boolean;
}

export interface CacheExperimentResult {
  readonly config: CacheExperimentConfig;
  readonly observations: readonly CacheObservationRecord[];
  readonly aggregateHitRate: number;
  readonly aggregateTokenWeightedHitRate: number | null;
  readonly aggregateCacheReadRate: number | null;
  readonly aggregateWriteTokens: TokenCount;
  readonly aggregateReadTokens: TokenCount;
  readonly aggregateHitTokens: TokenCount;
  readonly aggregateMissTokens: TokenCount;
  readonly aggregateCacheSavingsMicros: Micros | null;
  readonly aggregateEffectiveInputCostMicros: Micros | null;
  readonly economicsComplete: boolean;
  readonly stablePrefixDriftCount: number;
  readonly recommendation: "promote" | "retain_experimental" | "rollback";
}

/**
 * Aggregate multiple cache observation records into an experiment result.
 * Used by the evaluation laboratory to decide whether a cache configuration
 * should be promoted.
 */
export function analyzeCacheExperiment(
  config: CacheExperimentConfig,
  observations: readonly CacheObservationRecord[],
): CacheExperimentResult {
  if (observations.length === 0) {
    return {
      config,
      observations: [],
      aggregateHitRate: 0,
      aggregateTokenWeightedHitRate: null,
      aggregateCacheReadRate: null,
      aggregateWriteTokens: 0n as TokenCount,
      aggregateReadTokens: 0n as TokenCount,
      aggregateHitTokens: 0n as TokenCount,
      aggregateMissTokens: 0n as TokenCount,
      aggregateCacheSavingsMicros: null,
      aggregateEffectiveInputCostMicros: null,
      economicsComplete: false,
      stablePrefixDriftCount: 0,
      recommendation: "retain_experimental",
    };
  }
  let totalHits = 0;
  let totalEvents = 0;
  let totalWrites = 0n as TokenCount;
  let totalReads = 0n as TokenCount;
  let totalHitTokens = 0n as TokenCount;
  let totalMissTokens = 0n as TokenCount;
  let totalEligibleTokens = 0n as TokenCount;
  let totalInputTokens = 0n as TokenCount;
  let allEligibleKnown = true;
  let allInputKnown = true;
  let driftCount = 0;
  for (const o of observations) {
    totalHits += o.events.filter((e) => e.kind === "hit").length;
    totalEvents += o.events.length;
    totalWrites = (totalWrites + o.cacheWriteTokensObserved) as TokenCount;
    totalReads = (totalReads + o.observedCachedTokens) as TokenCount;
    totalHitTokens = (totalHitTokens + o.cacheHitTokens) as TokenCount;
    totalMissTokens = (totalMissTokens + o.cacheMissTokens) as TokenCount;
    if (o.eligibleInputTokens === null) allEligibleKnown = false;
    else totalEligibleTokens = (totalEligibleTokens + o.eligibleInputTokens) as TokenCount;
    if (o.inputTokens === null) allInputKnown = false;
    else totalInputTokens = (totalInputTokens + o.inputTokens) as TokenCount;
    if (!o.stablePrefixPreserved) driftCount++;
  }
  const hitRate = totalEvents > 0 ? totalHits / totalEvents : 0;
  const tokenDenominator = totalHitTokens + totalMissTokens;
  const tokenWeightedHitRate = tokenDenominator > 0n
    ? Number(totalHitTokens) / Number(tokenDenominator)
    : allEligibleKnown && totalEligibleTokens > 0n
      ? Number(totalHitTokens) / Number(totalEligibleTokens)
      : null;
  const cacheReadRate = allInputKnown && totalInputTokens > 0n
    ? Number(totalReads) / Number(totalInputTokens)
    : null;
  const economics = observations.map((observation) => observation.economics);
  const economicsComplete = economics.every((item) => item !== null);
  const aggregateCacheSavingsMicros = economicsComplete
    ? economics.reduce((sum, item) => (sum + (item?.cacheSavingsMicros ?? 0n)) as Micros, 0n as Micros)
    : null;
  const aggregateEffectiveInputCostMicros = economicsComplete
    ? economics.reduce((sum, item) => (sum + (item?.effectiveInputCostMicros ?? 0n)) as Micros, 0n as Micros)
    : null;
  const recommendation: CacheExperimentResult["recommendation"] =
    economicsComplete
      && tokenWeightedHitRate !== null
      && tokenWeightedHitRate >= 0.5
      && driftCount <= observations.length * 0.1
      ? "promote"
      : tokenWeightedHitRate !== null && tokenWeightedHitRate >= 0.2
        ? "retain_experimental"
        : "rollback";
  return {
    config,
    observations,
    aggregateHitRate: hitRate,
    aggregateTokenWeightedHitRate: tokenWeightedHitRate,
    aggregateCacheReadRate: cacheReadRate,
    aggregateWriteTokens: totalWrites,
    aggregateReadTokens: totalReads,
    aggregateHitTokens: totalHitTokens,
    aggregateMissTokens: totalMissTokens,
    aggregateCacheSavingsMicros,
    aggregateEffectiveInputCostMicros,
    economicsComplete,
    stablePrefixDriftCount: driftCount,
    recommendation,
  };
}

/** Extract cache metrics from a usage record for observation. */
export function usageToCacheEvents(
  usage: UsageRecord,
  usageSemantics: CacheUsageSemantics = "unknown",
): {
  readonly cacheReads: TokenCount;
  readonly cacheWrites: TokenCount;
  readonly cacheHits: TokenCount;
  readonly usageSemantics: CacheUsageSemantics;
} {
  return {
    cacheReads: usageSemantics === "hit_tokens" ? 0n as TokenCount : usage.cachedInputTokens,
    cacheWrites: usage.cacheWriteTokens,
    // Usage alone does not establish that every cached token was a hit. The
    // adapter must explicitly declare its semantics before recording hits.
    cacheHits: usageSemantics === "hit_tokens" || usageSemantics === "read_and_hit_tokens"
      ? usage.cachedInputTokens
      : 0n as TokenCount,
    usageSemantics,
  };
}

/** Provider pricing used only for explicit cache-economics accounting. */
export interface CachePricing {
  readonly inputMicrosPerMillion: Micros;
  readonly cachedInputMicrosPerMillion: Micros;
  readonly cacheWriteMicrosPerMillion?: Micros;
}

export type CacheEconomicsResult = CacheEconomicsObservation;

/**
 * Compute provider-specific input economics from token-weighted observation
 * fields. No savings are inferred when the provider did not report an input
 * denominator or pricing was not supplied.
 */
export function computeCacheEconomics(
  observation: CacheObservationRecord,
  pricing: CachePricing,
): CacheEconomicsResult | null {
  if (observation.inputTokens === null) return null;
  const million = 1_000_000n;
  const uncachedTokens = observation.inputTokens > observation.observedCachedTokens
    ? observation.inputTokens - observation.observedCachedTokens
    : 0n;
  const cacheReadCostMicros = (
    observation.observedCachedTokens * pricing.cachedInputMicrosPerMillion + million / 2n
  ) / million;
  const cacheWriteCostMicros = (
    observation.cacheWriteTokensObserved * (pricing.cacheWriteMicrosPerMillion ?? 0n) + million / 2n
  ) / million;
  const uncachedInputCostMicros = (
    uncachedTokens * pricing.inputMicrosPerMillion + million / 2n
  ) / million;
  const effectiveInputCostMicros = (
    uncachedInputCostMicros + cacheReadCostMicros + cacheWriteCostMicros
  ) as Micros;
  const baselineInputCostMicros = (
    observation.inputTokens * pricing.inputMicrosPerMillion + million / 2n
  ) / million;
  return {
    cacheReadCostMicros: cacheReadCostMicros as Micros,
    cacheWriteCostMicros: cacheWriteCostMicros as Micros,
    uncachedInputCostMicros: uncachedInputCostMicros as Micros,
    effectiveInputCostMicros,
    cacheSavingsMicros: (baselineInputCostMicros - effectiveInputCostMicros) as Micros,
  };
}
