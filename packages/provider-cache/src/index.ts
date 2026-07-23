/**
 * @terminus/provider-cache — cache observation recording (§38.9).
 *
 * Records cache read/write/hit/miss events, detects stable-prefix drift,
 * computes cache hit rates. Pure functions — no network I/O.
 */
import type { ModelKey, ContentHash, TokenCount, Rfc3339Timestamp } from "@terminus/domain";
import type { UsageRecord } from "@terminus/provider-core";
import type { CacheEvent, CacheObservationRecord } from "@terminus/provider-core";
import { computeCacheObservation } from "@terminus/provider-core";

export { computeCacheObservation };
export type { CacheEvent, CacheObservationRecord };

// ────────────────────────── Cache recording pipeline ─────────────────────────

export interface CacheRecordingOpts {
  readonly manifestId: string;
  readonly providerId: string;
  readonly model: ModelKey;
  readonly predictedCachedTokens: TokenCount;
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
    });
  }

  /** Record a cache miss with optional prefix drift info. */
  recordMiss(
    breakpointIndex: number | null,
    stablePrefixHash: ContentHash | null,
  ): void {
    this.events.push({
      kind: "miss",
      tokens: 0n as TokenCount,
      breakpointIndex,
      stablePrefixHash,
      occurredAt: new Date().toISOString(),
    });
  }

  /** Finalize and return the observation record. */
  finalize(): CacheObservationRecord {
    return computeCacheObservation(
      this.opts.manifestId,
      this.opts.providerId,
      this.opts.model,
      this.events,
      this.opts.predictedCachedTokens,
    );
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
  readonly aggregateWriteTokens: TokenCount;
  readonly aggregateReadTokens: TokenCount;
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
      aggregateWriteTokens: 0n as TokenCount,
      aggregateReadTokens: 0n as TokenCount,
      stablePrefixDriftCount: 0,
      recommendation: "retain_experimental",
    };
  }
  let totalHits = 0;
  let totalEvents = 0;
  let totalWrites = 0n as TokenCount;
  let totalReads = 0n as TokenCount;
  let driftCount = 0;
  for (const o of observations) {
    totalHits += o.events.filter((e) => e.kind === "hit").length;
    totalEvents += o.events.length;
    totalWrites = (totalWrites + o.cacheWriteTokensObserved) as TokenCount;
    totalReads = (totalReads + o.observedCachedTokens) as TokenCount;
    if (!o.stablePrefixPreserved) driftCount++;
  }
  const hitRate = totalEvents > 0 ? totalHits / totalEvents : 0;
  const recommendation: CacheExperimentResult["recommendation"] =
    hitRate >= 0.5 && driftCount <= observations.length * 0.1
      ? "promote"
      : hitRate >= 0.2
        ? "retain_experimental"
        : "rollback";
  return {
    config,
    observations,
    aggregateHitRate: hitRate,
    aggregateWriteTokens: totalWrites,
    aggregateReadTokens: totalReads,
    stablePrefixDriftCount: driftCount,
    recommendation,
  };
}

/** Extract cache metrics from a usage record for observation. */
export function usageToCacheEvents(usage: UsageRecord): {
  readonly cacheReads: TokenCount;
  readonly cacheWrites: TokenCount;
  readonly cacheHits: TokenCount;
} {
  return {
    cacheReads: usage.cachedInputTokens,
    cacheWrites: usage.cacheWriteTokens,
    cacheHits: usage.cachedInputTokens, // Provider treats cached reads as hits.
  };
}
