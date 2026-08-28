/**
 * @terminus/model-router — Empirical Performance Posterior.
 *
 * Per SPEC §26.4: The router updates cost, latency, tool reliability, and cohort
 * performance posteriors from verified task executions using conjugate Bayesian updates.
 */
import type { ModelCohortPosterior, Rfc3339Timestamp } from "@terminus/domain";
import { modelCohortPosteriorSchema, nowTimestamp } from "@terminus/domain";

export interface ExecutionObservation {
  readonly modelKey: string;
  readonly toolCallsSucceeded: number;
  readonly toolCallsFailed: number;
  readonly structuredOutputSucceeded: boolean;
  readonly editCohortSucceeded: boolean;
  readonly latencyMs: number;
  readonly costMicros: bigint;
  readonly cacheHitRate: number;
  readonly timestamp?: Rfc3339Timestamp;
}

export class PosteriorTracker {
  private readonly posteriors = new Map<string, ModelCohortPosterior>();

  constructor(initialPosteriors: readonly ModelCohortPosterior[] = []) {
    for (const post of initialPosteriors) {
      this.posteriors.set(post.modelKey, modelCohortPosteriorSchema.parse(post) as unknown as ModelCohortPosterior);
    }
  }

  /**
   * Get or initialize a neutral prior for a modelKey.
   */
  getOrCreate(modelKey: string): ModelCohortPosterior {
    let post = this.posteriors.get(modelKey);
    if (!post) {
      post = {
        modelKey,
        // Unknown models start neutral, not optimistic. A model must earn
        // routing confidence from verified observations.
        toolCallAlpha: 1.0,
        toolCallBeta: 1.0,
        structuredOutputAlpha: 1.0,
        structuredOutputBeta: 1.0,
        editCohortAlpha: 1.0,
        editCohortBeta: 1.0,
        latencyLogMean: Math.log(1000), // Prior: 1000ms
        latencyLogVariance: 0.5,
        observedCostMicros: 0n,
        observedCacheHitRate: 0.0,
        sampleCount: 0,
        lastUpdated: nowTimestamp(),
      };
      this.posteriors.set(modelKey, post);
    }
    return post;
  }

  /**
   * Update the posterior distribution from execution telemetry.
   */
  recordObservation(obs: ExecutionObservation): ModelCohortPosterior {
    const current = this.getOrCreate(obs.modelKey);
    const n = current.sampleCount + 1;

    // Beta-Binomial updates for discrete success rates
    const toolCallAlpha = current.toolCallAlpha + obs.toolCallsSucceeded;
    const toolCallBeta = current.toolCallBeta + obs.toolCallsFailed;

    const structuredOutputAlpha = current.structuredOutputAlpha + (obs.structuredOutputSucceeded ? 1 : 0);
    const structuredOutputBeta = current.structuredOutputBeta + (obs.structuredOutputSucceeded ? 0 : 1);

    const editCohortAlpha = current.editCohortAlpha + (obs.editCohortSucceeded ? 1 : 0);
    const editCohortBeta = current.editCohortBeta + (obs.editCohortSucceeded ? 0 : 1);

    // Online Log-Normal Bayesian update for latency
    const logLatency = Math.log(Math.max(1, obs.latencyMs));
    const delta = logLatency - current.latencyLogMean;
    const latencyLogMean = current.latencyLogMean + delta / n;
    const delta2 = logLatency - latencyLogMean;
    const latencyLogVariance = n > 1
      ? (current.latencyLogVariance * (n - 1) + delta * delta2) / n
      : current.latencyLogVariance;

    // Running averages for cost and cache hit rate
    const observedCostMicros = (current.observedCostMicros * BigInt(current.sampleCount) + obs.costMicros) / BigInt(n);
    const observedCacheHitRate = (current.observedCacheHitRate * current.sampleCount + obs.cacheHitRate) / n;

    const updated: ModelCohortPosterior = {
      modelKey: obs.modelKey,
      toolCallAlpha,
      toolCallBeta,
      structuredOutputAlpha,
      structuredOutputBeta,
      editCohortAlpha,
      editCohortBeta,
      latencyLogMean,
      latencyLogVariance: Math.max(0.01, latencyLogVariance),
      observedCostMicros,
      observedCacheHitRate: Math.max(0, Math.min(1, observedCacheHitRate)),
      sampleCount: n,
      lastUpdated: obs.timestamp ?? nowTimestamp(),
    };

    const validated = modelCohortPosteriorSchema.parse(updated) as unknown as ModelCohortPosterior;
    this.posteriors.set(obs.modelKey, validated);
    return validated;
  }

  /**
   * Compute expected value metrics from the posterior for scoring.
   */
  getExpectedMetrics(modelKey: string): {
    readonly expectedToolReliability: number;
    readonly expectedStructuredSuccess: number;
    readonly expectedEditSuccess: number;
    readonly expectedLatencyMs: number;
    readonly expectedCostMicros: bigint;
    readonly expectedCacheHitRate: number;
    /** 1 for an unseen model; approaches zero as verified samples accumulate. */
    readonly uncertainty: number;
  } {
    const p = this.getOrCreate(modelKey);
    return expectedMetrics(p);
  }

  /** Read posterior metrics without creating state for an unseen model. */
  getExpectedMetricsIfObserved(modelKey: string): ReturnType<PosteriorTracker["getExpectedMetrics"]> | null {
    const p = this.posteriors.get(modelKey);
    return p === undefined ? null : expectedMetrics(p);
  }

  /** Whether verified observations have been recorded for this model. */
  hasObserved(modelKey: string): boolean {
    return (this.posteriors.get(modelKey)?.sampleCount ?? 0) > 0;
  }

  /** Export all recorded posteriors. */
  exportAll(): readonly ModelCohortPosterior[] {
    return Array.from(this.posteriors.values());
  }
}

function expectedMetrics(p: ModelCohortPosterior): {
  readonly expectedToolReliability: number;
  readonly expectedStructuredSuccess: number;
  readonly expectedEditSuccess: number;
  readonly expectedLatencyMs: number;
  readonly expectedCostMicros: bigint;
  readonly expectedCacheHitRate: number;
  readonly uncertainty: number;
} {
  return {
    expectedToolReliability: p.toolCallAlpha / (p.toolCallAlpha + p.toolCallBeta),
    expectedStructuredSuccess: p.structuredOutputAlpha / (p.structuredOutputAlpha + p.structuredOutputBeta),
    expectedEditSuccess: p.editCohortAlpha / (p.editCohortAlpha + p.editCohortBeta),
    expectedLatencyMs: Math.exp(p.latencyLogMean + p.latencyLogVariance / 2),
    expectedCostMicros: p.observedCostMicros,
    expectedCacheHitRate: p.observedCacheHitRate,
    uncertainty: 1 / Math.sqrt(p.sampleCount + 1),
  };
}
