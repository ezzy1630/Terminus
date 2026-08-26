/**
 * Cache-integrity telemetry (R7, harness critical path).
 *
 * Prompt-cache hits are the dominant lever on multi-turn cost and latency.
 * The renderer predicts how much of the stable prefix should be cached
 * (`rendered.predictedCachedTokens`); the provider reports what actually hit
 * (`usage.cachedInputTokens`). A large gap means something mutated the
 * prefix — the #1 silent cost killer documented across Hermes/Claude Code
 * cache guidance.
 *
 * This module turns the gap into an explicit, gate-able signal:
 *  - per-attempt read ratio (actual/predicted, null when nothing predicted);
 *  - a rolling consecutive-low-miss detector so one cold attempt does not
 *    trip the alarm but a systematic prefix mutation does.
 */

export const DEFAULT_CACHE_RATIO_THRESHOLD = 0.7;
export const DEFAULT_CONSECUTIVE_LOW_ATTEMPTS = 2;

export function cacheReadRatio(
  predictedCachedTokens: bigint,
  actualReadTokens: bigint,
): number | null {
  if (predictedCachedTokens <= 0n) return null;
  return Number(actualReadTokens) / Number(predictedCachedTokens);
}

export interface CacheAttemptRecord {
  readonly attemptId: string;
  readonly predictedCachedTokens: bigint;
  readonly actualReadTokens: bigint;
  readonly ratio: number | null;
}

export interface CacheMonitorStatus {
  readonly attempts: number;
  readonly consecutiveLowMisses: number;
  /** Non-null when the detector currently fires. */
  readonly warning: string | null;
  readonly averageRatio: number | null;
}

export class CacheRatioMonitor {
  private readonly records: CacheAttemptRecord[] = [];
  private consecutiveLow = 0;

  constructor(
    private readonly threshold = DEFAULT_CACHE_RATIO_THRESHOLD,
    private readonly alertAfterConsecutiveLow = DEFAULT_CONSECUTIVE_LOW_ATTEMPTS,
  ) {}

  record(attemptId: string, predictedCachedTokens: bigint, actualReadTokens: bigint): CacheAttemptRecord {
    const record: CacheAttemptRecord = {
      attemptId,
      predictedCachedTokens,
      actualReadTokens,
      ratio: cacheReadRatio(predictedCachedTokens, actualReadTokens),
    };
    this.records.push(record);
    if (record.ratio === null) {
      // Nothing was predicted to be cached (cold prefix, first attempt);
      // do not treat as a miss.
      return record;
    }
    if (record.ratio < this.threshold) {
      this.consecutiveLow += 1;
    } else {
      this.consecutiveLow = 0;
    }
    return record;
  }

  status(): CacheMonitorStatus {
    const ratios = this.records
      .map((record) => record.ratio)
      .filter((ratio): ratio is number => ratio !== null);
    const averageRatio = ratios.length === 0
      ? null
      : ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
    const warning = this.consecutiveLow >= this.alertAfterConsecutiveLow
      ? `prompt-cache read ratio fell below ${this.threshold} on ${this.consecutiveLow} consecutive attempts — inspect the stable prefix for mutations`
      : null;
    return {
      attempts: this.records.length,
      consecutiveLowMisses: this.consecutiveLow,
      warning,
      averageRatio,
    };
  }

  /** Serializable snapshot for evidence artifacts and release reports. */
  snapshot(): {
    attempts: number;
    averageRatio: number | null;
    lowAttempts: number;
    threshold: number;
    records: readonly { attemptId: string; predicted: string; actual: string; ratio: number | null }[];
  } {
    return {
      attempts: this.records.length,
      averageRatio: this.status().averageRatio,
      lowAttempts: this.records.filter((record) => record.ratio !== null && record.ratio < this.threshold).length,
      threshold: this.threshold,
      records: this.records.map((record) => ({
        attemptId: record.attemptId,
        predicted: record.predictedCachedTokens.toString(),
        actual: record.actualReadTokens.toString(),
        ratio: record.ratio,
      })),
    };
  }

  reset(): void {
    this.records.length = 0;
    this.consecutiveLow = 0;
  }
}
