/**
 * @terminus/model-router — Empirical Performance Posterior.
 *
 * Per SPEC §26.4: The router updates cost, latency, tool reliability, and cohort
 * performance posteriors from verified task executions using conjugate Bayesian updates.
 */
import type { ModelCohortPosterior, Rfc3339Timestamp } from "@terminus/domain";
import { modelCohortPosteriorSchema, nowTimestamp } from "@terminus/domain";
import {
  hasCompleteRouterProviderReceipt,
  isVerifiedRouterOutcome,
  routerProviderReceiptSchema,
  routerOutcomeRecordSchema,
  type RouterOutcomeRecord,
  type RouterProviderReceipt,
} from "./outcomes.js";

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
  /** Optional identity fields used for durable, idempotent telemetry. */
  readonly outcomeId?: string;
  readonly taskId?: string;
  readonly cohort?: string;
  readonly qualityScore?: number | null;
  readonly verified?: boolean;
  readonly providerReceipt?: RouterProviderReceipt | null;
  readonly verificationArtifactRef?: string | null;
}

export interface VerifiedExecutionObservation extends ExecutionObservation {
  readonly outcomeId: string;
  readonly taskId: string;
  readonly cohort: string;
  readonly qualityScore: number | null;
  readonly verified: true;
  readonly providerReceipt: RouterProviderReceipt;
  readonly verificationArtifactRef: string;
}

export type CalibrationStatus = "prior" | "observed_telemetry" | "verified_outcomes";

export interface CostCalibration {
  readonly sampleCount: number;
  readonly meanMicros: bigint | null;
  /** One-standard-error estimate; null when no finite numeric estimate exists. */
  readonly uncertaintyMicros: bigint | null;
  /** Conservative mean plus one uncertainty unit. */
  readonly upperBoundMicros: bigint | null;
}

export interface ExpectedModelMetrics {
  readonly expectedToolReliability: number;
  readonly expectedStructuredSuccess: number;
  readonly expectedEditSuccess: number;
  readonly expectedLatencyMs: number;
  readonly expectedCostMicros: bigint;
  readonly expectedCacheHitRate: number;
  /** 1 for an unseen model; approaches zero as verified samples accumulate. */
  readonly uncertainty: number;
  /** Conservative cost and latency uncertainty for promotion/economics gates. */
  readonly costUncertaintyMicros: bigint | null;
  readonly costUpperBoundMicros: bigint | null;
  readonly latencyUncertaintyMs: number | null;
  readonly verifiedSampleCount: number;
  readonly calibrationStatus: CalibrationStatus;
}

interface RunningCostMoments {
  readonly count: number;
  readonly mean: number;
  readonly m2: number;
}

export class PosteriorTracker {
  private readonly posteriors = new Map<string, ModelCohortPosterior>();
  private readonly costMoments = new Map<string, RunningCostMoments>();
  private readonly verifiedSampleCounts = new Map<string, number>();
  private readonly recordedOutcomeIds = new Set<string>();

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
    validateObservation(obs);
    if (obs.outcomeId !== undefined && this.recordedOutcomeIds.has(obs.outcomeId)) {
      return this.getOrCreate(obs.modelKey);
    }
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
    if (obs.outcomeId !== undefined) this.recordedOutcomeIds.add(obs.outcomeId);
    recordCostObservation(this.costMoments, obs.modelKey, obs.costMicros);
    if (obs.verified === true) {
      this.verifiedSampleCounts.set(obs.modelKey, (this.verifiedSampleCounts.get(obs.modelKey) ?? 0) + 1);
    }
    return validated;
  }

  /** Record an observation only after its provider receipt and artifact pass verification. */
  recordVerifiedObservation(obs: VerifiedExecutionObservation): ModelCohortPosterior {
    const receipt = routerProviderReceiptSchema.safeParse(obs.providerReceipt);
    if (!receipt.success || !receipt.data.verified || receipt.data.model !== obs.modelKey) {
      throw new Error(`verified observation '${obs.outcomeId}' has an incomplete provider receipt`);
    }
    if (obs.verificationArtifactRef.trim().length === 0) {
      throw new Error(`verified observation '${obs.outcomeId}' requires a verification artifact`);
    }
    return this.recordObservation({ ...obs, verified: true });
  }

  /** Convert and record a durable outcome record after schema and provenance checks. */
  recordVerifiedOutcome(record: RouterOutcomeRecord): ModelCohortPosterior {
    const validated = routerOutcomeRecordSchema.parse(record) as unknown as RouterOutcomeRecord;
    if (!isVerifiedRouterOutcome(validated)) {
      throw new Error(`router outcome '${validated.outcomeId}' is not independently verified`);
    }
    const providerReceipt = validated.providerReceipt;
    const verificationArtifactRef = validated.verificationArtifactRef;
    if (providerReceipt === null || verificationArtifactRef === null) {
      throw new Error(`router outcome '${validated.outcomeId}' is missing verification provenance`);
    }
    return this.recordVerifiedObservation({
      modelKey: validated.modelKey,
      toolCallsSucceeded: validated.toolCallsSucceeded,
      toolCallsFailed: validated.toolCallsFailed,
      structuredOutputSucceeded: validated.structuredOutputSucceeded,
      editCohortSucceeded: validated.editCohortSucceeded,
      latencyMs: validated.latencyMs,
      costMicros: validated.costMicros,
      cacheHitRate: validated.cacheHitRate ?? 0,
      timestamp: validated.recordedAt,
      outcomeId: validated.outcomeId,
      taskId: validated.taskId,
      cohort: validated.cohort,
      qualityScore: validated.qualityScore,
      verified: true,
      providerReceipt,
      verificationArtifactRef,
    });
  }

  /**
   * Compute expected value metrics from the posterior for scoring.
   */
  getExpectedMetrics(modelKey: string): ExpectedModelMetrics {
    const p = this.getOrCreate(modelKey);
    return expectedMetrics(p, this);
  }

  /** Read posterior metrics without creating state for an unseen model. */
  getExpectedMetricsIfObserved(modelKey: string): ReturnType<PosteriorTracker["getExpectedMetrics"]> | null {
    const p = this.posteriors.get(modelKey);
    return p === undefined ? null : expectedMetrics(p, this);
  }

  /** Whether verified observations have been recorded for this model. */
  hasObserved(modelKey: string): boolean {
    return (this.posteriors.get(modelKey)?.sampleCount ?? 0) > 0;
  }

  /** Export all recorded posteriors. */
  exportAll(): readonly ModelCohortPosterior[] {
    return Array.from(this.posteriors.values());
  }

  /** Read conservative calibration statistics without mutating the posterior. */
  getCalibration(modelKey: string): CostCalibration {
    const state = this.costMoments.get(modelKey);
    if (state === undefined) {
      return { sampleCount: 0, meanMicros: null, uncertaintyMicros: null, upperBoundMicros: null };
    }
    const meanMicros = safeMicros(state.mean);
    const uncertainty = state.count === 1
      ? state.mean
      : Math.sqrt(Math.max(0, state.m2 / Math.max(1, state.count - 1)) / state.count);
    const uncertaintyMicros = safeMicros(uncertainty);
    const upperBoundMicros = meanMicros === null || uncertaintyMicros === null
      ? null
      : (meanMicros + uncertaintyMicros) as bigint;
    return { sampleCount: state.count, meanMicros, uncertaintyMicros, upperBoundMicros };
  }

  getVerifiedSampleCount(modelKey: string): number {
    return this.verifiedSampleCounts.get(modelKey) ?? 0;
  }
}

function expectedMetrics(p: ModelCohortPosterior, tracker: PosteriorTracker): ExpectedModelMetrics {
  const calibration = tracker.getCalibration(p.modelKey);
  const verifiedSampleCount = tracker.getVerifiedSampleCount(p.modelKey);
  const expectedLatencyMs = Math.exp(p.latencyLogMean + p.latencyLogVariance / 2);
  return {
    expectedToolReliability: p.toolCallAlpha / (p.toolCallAlpha + p.toolCallBeta),
    expectedStructuredSuccess: p.structuredOutputAlpha / (p.structuredOutputAlpha + p.structuredOutputBeta),
    expectedEditSuccess: p.editCohortAlpha / (p.editCohortAlpha + p.editCohortBeta),
    expectedLatencyMs,
    expectedCostMicros: p.observedCostMicros,
    expectedCacheHitRate: p.observedCacheHitRate,
    uncertainty: 1 / Math.sqrt(p.sampleCount + 1),
    costUncertaintyMicros: calibration.uncertaintyMicros,
    costUpperBoundMicros: calibration.upperBoundMicros,
    latencyUncertaintyMs: p.sampleCount > 0
      ? expectedLatencyMs * Math.sqrt(Math.max(0, p.latencyLogVariance)) / Math.sqrt(p.sampleCount)
      : null,
    verifiedSampleCount,
    calibrationStatus: verifiedSampleCount > 0
      ? "verified_outcomes"
      : p.sampleCount > 0
        ? "observed_telemetry"
        : "prior",
  };
}

function validateObservation(obs: ExecutionObservation): void {
  if (obs.modelKey.trim().length === 0) throw new Error("modelKey is required for a router observation");
  if (!Number.isSafeInteger(obs.toolCallsSucceeded) || obs.toolCallsSucceeded < 0) {
    throw new RangeError("toolCallsSucceeded must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(obs.toolCallsFailed) || obs.toolCallsFailed < 0) {
    throw new RangeError("toolCallsFailed must be a non-negative safe integer");
  }
  if (!Number.isFinite(obs.latencyMs) || obs.latencyMs < 0) throw new RangeError("latencyMs must be finite and non-negative");
  if (obs.costMicros < 0n) throw new RangeError("costMicros must be non-negative");
  if (!Number.isFinite(obs.cacheHitRate) || obs.cacheHitRate < 0 || obs.cacheHitRate > 1) {
    throw new RangeError("cacheHitRate must be between 0 and 1");
  }
  if (obs.qualityScore !== undefined && obs.qualityScore !== null
    && (!Number.isFinite(obs.qualityScore) || obs.qualityScore < 0 || obs.qualityScore > 1)) {
    throw new RangeError("qualityScore must be between 0 and 1");
  }
}

function recordCostObservation(
  costMoments: Map<string, RunningCostMoments>,
  modelKey: string,
  costMicros: bigint,
): void {
  const numericCost = Number(costMicros);
  if (!Number.isSafeInteger(numericCost) || numericCost < 0) return;
  const previous = costMoments.get(modelKey);
  if (previous === undefined) {
    costMoments.set(modelKey, { count: 1, mean: numericCost, m2: 0 });
    return;
  }
  const count = previous.count + 1;
  const delta = numericCost - previous.mean;
  const mean = previous.mean + delta / count;
  const m2 = previous.m2 + delta * (numericCost - mean);
  costMoments.set(modelKey, { count, mean, m2 });
}

function safeMicros(value: number): bigint | null {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
  return BigInt(Math.ceil(value));
}
