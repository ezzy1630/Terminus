/**
 * Cache promotion evidence and guardrails.
 *
 * Cache telemetry is useful before it is trustworthy.  This module keeps the
 * evidence boundary explicit: a candidate is compared with a task/seed-paired
 * baseline, every quality and economics fact is checked, and incomplete
 * evidence remains experimental.  Nothing here changes the serving default.
 */
import { z } from "zod";
import type { CacheObservationRecord } from "@terminus/provider-core";

export type CachePromotionDecision =
  | "promote"
  | "retain_experimental"
  | "rollback";

export type CachePromotionGateStatus = "pass" | "fail" | "blocked";

/** Opaque provider receipt fields needed for accounting and provenance only. */
export interface CacheProviderReceipt {
  readonly receiptId: string;
  readonly providerId: string;
  readonly model: string;
  readonly artifactRef: string;
  readonly verified: boolean;
}

export const cacheProviderReceiptSchema = z.object({
  receiptId: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  artifactRef: z.string().trim().min(1),
  verified: z.boolean(),
}).strict();

/** One execution in a paired baseline/candidate cache experiment. */
export interface CachePromotionTrial {
  readonly pairId: string;
  readonly cohort: string;
  readonly taskId?: string;
  readonly seed?: number;
  readonly observation: CacheObservationRecord;
  /** Independently verified quality score, normalized to [0, 1]. */
  readonly qualityScore: number | null;
  /** End-to-end latency for the same measured boundary in both arms. */
  readonly latencyMs: number | null;
  readonly providerReceipt: CacheProviderReceipt | null;
  readonly independentlyVerified: boolean;
}

export interface CachePromotionPolicy {
  /** Minimum exact baseline/candidate pairs required for promotion. */
  readonly minimumPairs: number;
  /** Alias accepted at config boundaries for release terminology. */
  readonly minimumCohort?: number;
  /** Candidate quality may be lower only within this paired margin. */
  readonly noninferiorityMargin: number;
  /** Maximum absolute p50 latency regression allowed. */
  readonly maxP50LatencyRegressionMs: number;
  /** Maximum absolute p95 latency regression allowed. */
  readonly maxP95LatencyRegressionMs: number;
  /** Maximum relative p50/p95 latency regression allowed. */
  readonly maxLatencyRegressionPercent: number;
  /** Maximum relative effective input cost regression allowed. */
  readonly maxCostRegressionPercent: number;
  /** Require an observed cache metric improvement, not just complete data. */
  readonly requireCacheImprovement: boolean;
  readonly requireProviderReceipts: boolean;
  readonly requireIndependentVerification: boolean;
  readonly requireEconomics: boolean;
  readonly requireStablePrefix: boolean;
  readonly requireHoldout: boolean;
}

export const DEFAULT_CACHE_PROMOTION_POLICY: CachePromotionPolicy = Object.freeze({
  minimumPairs: 20,
  noninferiorityMargin: 0.05,
  maxP50LatencyRegressionMs: 0,
  maxP95LatencyRegressionMs: 0,
  maxLatencyRegressionPercent: 0.05,
  maxCostRegressionPercent: 0,
  requireCacheImprovement: true,
  requireProviderReceipts: true,
  requireIndependentVerification: true,
  requireEconomics: true,
  requireStablePrefix: true,
  requireHoldout: true,
});

export interface CachePromotionInput {
  readonly experimentId: string;
  readonly cohort: string;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly baseline: readonly CachePromotionTrial[];
  readonly candidate: readonly CachePromotionTrial[];
  /** Stable evidence identity issued by the evaluation/persistence layer. */
  readonly evidenceId?: string;
  /** True only when the required release holdout partition was evaluated. */
  readonly holdoutComplete?: boolean;
  /** Optional confidence lower bound on the paired quality delta. */
  readonly qualityDeltaLowerBound?: number | null;
  readonly policy?: Partial<CachePromotionPolicy>;
}

export interface CachePromotionGate {
  readonly name:
  | "evidence_identity"
  | "cohort"
  | "paired_quality"
  | "cache_improvement"
  | "latency"
  | "cost"
  | "provider_receipts"
  | "verification"
  | "economics"
  | "stable_prefix"
  | "holdout";
  readonly status: CachePromotionGateStatus;
  readonly reason: string;
}

export interface CacheQualitySummary {
  readonly baselineMean: number | null;
  readonly candidateMean: number | null;
  readonly meanDelta: number | null;
  readonly lowerBound: number | null;
  readonly lowerBoundSource: "provided" | "paired_minimum" | "unavailable";
  readonly noninferiorityMargin: number;
  readonly noninferior: boolean;
}

export interface CacheLatencySummary {
  readonly baselineP50Ms: number | null;
  readonly candidateP50Ms: number | null;
  readonly baselineP95Ms: number | null;
  readonly candidateP95Ms: number | null;
  readonly p50DeltaMs: number | null;
  readonly p95DeltaMs: number | null;
}

export interface CachePromotionEvidence {
  readonly schemaVersion: "terminus.cache-promotion.v1";
  readonly evidenceId: string | null;
  readonly experimentId: string;
  readonly cohort: string;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly pairCount: number;
  readonly baselineObservationIds: readonly string[];
  readonly candidateObservationIds: readonly string[];
  readonly quality: CacheQualitySummary;
  readonly cacheHitRate: {
    readonly baseline: number | null;
    readonly candidate: number | null;
    readonly delta: number | null;
  };
  readonly latency: CacheLatencySummary;
  readonly effectiveInputCostMicros: {
    readonly baseline: string | null;
    readonly candidate: string | null;
    readonly deltaPercent: number | null;
  };
  readonly gates: readonly CachePromotionGate[];
  readonly blockingReasons: readonly string[];
  readonly promotionEligible: boolean;
  /** Promotion evidence is advisory; serving remains explicitly disabled. */
  readonly shadowOnly: true;
  readonly defaultEnabled: false;
  readonly decision: CachePromotionDecision;
  readonly generatedAt: string;
}

export const cachePromotionEvidenceSchema = z.object({
  schemaVersion: z.literal("terminus.cache-promotion.v1"),
  evidenceId: z.string().nullable(),
  experimentId: z.string().min(1),
  cohort: z.string().min(1),
  baselineVersion: z.string().min(1),
  candidateVersion: z.string().min(1),
  pairCount: z.number().int().nonnegative(),
  baselineObservationIds: z.array(z.string().min(1)),
  candidateObservationIds: z.array(z.string().min(1)),
  quality: z.object({
    baselineMean: z.number().nullable(),
    candidateMean: z.number().nullable(),
    meanDelta: z.number().nullable(),
    lowerBound: z.number().nullable(),
    lowerBoundSource: z.enum(["provided", "paired_minimum", "unavailable"]),
    noninferiorityMargin: z.number().nonnegative(),
    noninferior: z.boolean(),
  }).strict(),
  cacheHitRate: z.object({
    baseline: z.number().nullable(),
    candidate: z.number().nullable(),
    delta: z.number().nullable(),
  }).strict(),
  latency: z.object({
    baselineP50Ms: z.number().nullable(),
    candidateP50Ms: z.number().nullable(),
    baselineP95Ms: z.number().nullable(),
    candidateP95Ms: z.number().nullable(),
    p50DeltaMs: z.number().nullable(),
    p95DeltaMs: z.number().nullable(),
  }).strict(),
  effectiveInputCostMicros: z.object({
    baseline: z.string().nullable(),
    candidate: z.string().nullable(),
    deltaPercent: z.number().nullable(),
  }).strict(),
  gates: z.array(z.object({
    name: z.enum([
      "evidence_identity",
      "cohort",
      "paired_quality",
      "cache_improvement",
      "latency",
      "cost",
      "provider_receipts",
      "verification",
      "economics",
      "stable_prefix",
      "holdout",
    ]),
    status: z.enum(["pass", "fail", "blocked"]),
    reason: z.string().min(1),
  }).strict()),
  blockingReasons: z.array(z.string().min(1)),
  promotionEligible: z.boolean(),
  shadowOnly: z.literal(true),
  defaultEnabled: z.literal(false),
  decision: z.enum(["promote", "retain_experimental", "rollback"]),
  generatedAt: z.string().min(1),
}).strict();

/** Evaluate paired cache evidence without enabling a serving path. */
export function evaluateCachePromotion(input: CachePromotionInput): CachePromotionEvidence {
  const policy = normalizePolicy(input.policy);
  const gates: CachePromotionGate[] = [];
  const issues: string[] = [];

  const identityValid = nonEmpty(input.evidenceId)
    && nonEmpty(input.experimentId)
    && nonEmpty(input.cohort)
    && nonEmpty(input.baselineVersion)
    && nonEmpty(input.candidateVersion);
  addGate(
    gates,
    "evidence_identity",
    identityValid ? "pass" : "blocked",
    identityValid
      ? "experiment and evidence identities are present"
      : "explicit experiment, version, and evidence identities are required",
  );
  if (!identityValid) issues.push("missing explicit experiment/evidence identity");

  const baselineByPair = indexTrials(input.baseline, "baseline", input.cohort, issues);
  const candidateByPair = indexTrials(input.candidate, "candidate", input.cohort, issues);
  const pairIds = [...baselineByPair.keys()]
    .filter((pairId) => candidateByPair.has(pairId))
    .sort();
  const pairCount = pairIds.length;
  const cohortPass = pairCount >= policy.minimumPairs && issues.every((issue) => !issue.startsWith("duplicate") && !issue.includes("cohort mismatch"));
  addGate(
    gates,
    "cohort",
    cohortPass ? "pass" : "blocked",
    cohortPass
      ? `${pairCount} exact paired trials meet minimum ${policy.minimumPairs}`
      : `${pairCount} exact paired trials available; minimum is ${policy.minimumPairs}`,
  );
  if (!cohortPass) issues.push(`cohort requires ${policy.minimumPairs} exact pairs`);

  const pairs = pairIds.map((pairId) => ({
    baseline: baselineByPair.get(pairId)!,
    candidate: candidateByPair.get(pairId)!,
  }));

  const qualityDeltas = pairs
    .filter((pair) => pair.baseline.qualityScore !== null && pair.candidate.qualityScore !== null)
    .map((pair) => pair.candidate.qualityScore! - pair.baseline.qualityScore!);
  const quality = summarizeQuality(
    pairs,
    qualityDeltas,
    input.qualityDeltaLowerBound,
    policy.noninferiorityMargin,
  );
  const qualityPass = quality.noninferior && quality.meanDelta !== null;
  addGate(
    gates,
    "paired_quality",
    qualityPass ? "pass" : qualityDeltas.length === 0 ? "blocked" : "fail",
    qualityPass
      ? `paired quality delta ${quality.meanDelta!.toFixed(4)} is non-inferior`
      : qualityDeltas.length === 0
        ? "paired independently verified quality scores are required"
        : `paired quality lower bound ${quality.lowerBound?.toFixed(4) ?? "unavailable"} violates margin -${policy.noninferiorityMargin.toFixed(4)}`,
  );

  const baselineCacheRate = average(pairs.map((pair) => pair.baseline.observation.tokenWeightedHitRate));
  const candidateCacheRate = average(pairs.map((pair) => pair.candidate.observation.tokenWeightedHitRate));
  const cacheDelta = baselineCacheRate !== null && candidateCacheRate !== null
    ? candidateCacheRate - baselineCacheRate
    : null;
  const cachePass = !policy.requireCacheImprovement
    ? baselineCacheRate !== null && candidateCacheRate !== null
    : cacheDelta !== null && cacheDelta > 0;
  addGate(
    gates,
    "cache_improvement",
    cachePass ? "pass" : baselineCacheRate === null || candidateCacheRate === null ? "blocked" : "fail",
    cachePass
      ? `token-weighted cache hit rate improved by ${cacheDelta!.toFixed(4)}`
      : baselineCacheRate === null || candidateCacheRate === null
        ? "paired cache hit-rate observations are required"
        : "candidate cache hit rate did not improve over baseline",
  );

  const latencies = summarizeLatency(pairs);
  const latencyPass = latencyWithinPolicy(latencies, policy);
  addGate(
    gates,
    "latency",
    latencyPass ? "pass" : latencies.p50DeltaMs === null || latencies.p95DeltaMs === null ? "blocked" : "fail",
    latencyPass
      ? "p50 and p95 latency remain within the configured guardrails"
      : latencies.p50DeltaMs === null || latencies.p95DeltaMs === null
        ? "paired latency observations are required"
        : `latency regression exceeds the configured guardrail (p50 ${latencies.p50DeltaMs.toFixed(2)}ms, p95 ${latencies.p95DeltaMs.toFixed(2)}ms)`,
  );

  const receiptPass = !policy.requireProviderReceipts
    || pairs.length > 0 && pairs.every((pair) => completeReceipt(pair.baseline) && completeReceipt(pair.candidate));
  addGate(
    gates,
    "provider_receipts",
    receiptPass ? "pass" : "blocked",
    receiptPass ? "all paired trials have verified opaque provider receipts" : "complete verified provider receipts are required for every pair",
  );

  const verificationPass = !policy.requireIndependentVerification
    || pairs.length > 0 && pairs.every((pair) => pair.baseline.independentlyVerified && pair.candidate.independentlyVerified);
  addGate(
    gates,
    "verification",
    verificationPass ? "pass" : "blocked",
    verificationPass ? "all paired quality records are independently verified" : "independent verification is required for every pair",
  );

  const economicsPass = !policy.requireEconomics || pairs.length > 0 && pairs.every((pair) => economicsComplete(pair.baseline) && economicsComplete(pair.candidate));
  addGate(
    gates,
    "economics",
    economicsPass ? "pass" : "blocked",
    economicsPass ? "all paired trials have explicit input economics" : "input tokens and explicit cache economics are required for every pair",
  );

  const stablePrefixPass = !policy.requireStablePrefix || pairs.length > 0 && pairs.every((pair) => pair.baseline.observation.stablePrefixPreserved && pair.candidate.observation.stablePrefixPreserved);
  addGate(
    gates,
    "stable_prefix",
    stablePrefixPass ? "pass" : pairs.length === 0 ? "blocked" : "fail",
    stablePrefixPass ? "stable prefixes were preserved for every paired trial" : "stable-prefix drift was observed in a paired trial",
  );

  const cost = summarizeCost(pairs);
  const costPass = cost.deltaPercent !== null && cost.deltaPercent <= policy.maxCostRegressionPercent;
  addGate(
    gates,
    "cost",
    costPass ? "pass" : cost.deltaPercent === null ? "blocked" : "fail",
    costPass
      ? `effective input cost delta ${cost.deltaPercent.toFixed(2)}% is within the guardrail`
      : cost.deltaPercent === null
        ? "paired effective input economics are required"
        : `effective input cost delta ${cost.deltaPercent.toFixed(2)}% exceeds ${policy.maxCostRegressionPercent.toFixed(2)}%`,
  );

  const holdoutPass = !policy.requireHoldout || input.holdoutComplete === true;
  addGate(
    gates,
    "holdout",
    holdoutPass ? "pass" : "blocked",
    holdoutPass ? "required holdout partition is complete" : "release holdout evidence is required",
  );

  const blockingReasons = [
    ...issues,
    ...gates.filter((gate) => gate.status !== "pass").map((gate) => `${gate.name}: ${gate.reason}`),
  ];
  const promotionEligible = gates.every((gate) => gate.status === "pass");
  const hasMeasuredFailure = gates.some((gate) => gate.status === "fail");
  const decision: CachePromotionDecision = promotionEligible
    ? "promote"
    : hasMeasuredFailure
      ? "rollback"
      : "retain_experimental";

  const evidence: CachePromotionEvidence = {
    schemaVersion: "terminus.cache-promotion.v1",
    evidenceId: nonEmpty(input.evidenceId) ? input.evidenceId! : null,
    experimentId: input.experimentId,
    cohort: input.cohort,
    baselineVersion: input.baselineVersion,
    candidateVersion: input.candidateVersion,
    pairCount,
    baselineObservationIds: pairs.map((pair) => pair.baseline.observation.manifestId),
    candidateObservationIds: pairs.map((pair) => pair.candidate.observation.manifestId),
    quality,
    cacheHitRate: {
      baseline: baselineCacheRate,
      candidate: candidateCacheRate,
      delta: cacheDelta,
    },
    latency: latencies,
    effectiveInputCostMicros: cost,
    gates,
    blockingReasons,
    promotionEligible,
    shadowOnly: true,
    defaultEnabled: false,
    decision,
    generatedAt: new Date().toISOString(),
  };
  return cachePromotionEvidenceSchema.parse(evidence) as unknown as CachePromotionEvidence;
}

/** Object facade useful at composition roots that pin a policy instance. */
export class CachePromotionGateEvaluator {
  constructor(private readonly policy: Partial<CachePromotionPolicy> = {}) {}

  evaluate(input: Omit<CachePromotionInput, "policy">): CachePromotionEvidence {
    return evaluateCachePromotion({ ...input, policy: this.policy });
  }
}

function normalizePolicy(input: Partial<CachePromotionPolicy> | undefined): CachePromotionPolicy {
  const minimumPairs = input?.minimumCohort ?? input?.minimumPairs ?? DEFAULT_CACHE_PROMOTION_POLICY.minimumPairs;
  if (!Number.isSafeInteger(minimumPairs) || minimumPairs <= 0) {
    throw new RangeError("cache promotion minimumPairs must be a positive safe integer");
  }
  const policy: CachePromotionPolicy = {
    minimumPairs,
    minimumCohort: minimumPairs,
    noninferiorityMargin: input?.noninferiorityMargin ?? DEFAULT_CACHE_PROMOTION_POLICY.noninferiorityMargin,
    maxP50LatencyRegressionMs: input?.maxP50LatencyRegressionMs ?? DEFAULT_CACHE_PROMOTION_POLICY.maxP50LatencyRegressionMs,
    maxP95LatencyRegressionMs: input?.maxP95LatencyRegressionMs ?? DEFAULT_CACHE_PROMOTION_POLICY.maxP95LatencyRegressionMs,
    maxLatencyRegressionPercent: input?.maxLatencyRegressionPercent ?? DEFAULT_CACHE_PROMOTION_POLICY.maxLatencyRegressionPercent,
    maxCostRegressionPercent: input?.maxCostRegressionPercent ?? DEFAULT_CACHE_PROMOTION_POLICY.maxCostRegressionPercent,
    requireCacheImprovement: input?.requireCacheImprovement ?? DEFAULT_CACHE_PROMOTION_POLICY.requireCacheImprovement,
    requireProviderReceipts: input?.requireProviderReceipts ?? DEFAULT_CACHE_PROMOTION_POLICY.requireProviderReceipts,
    requireIndependentVerification: input?.requireIndependentVerification ?? DEFAULT_CACHE_PROMOTION_POLICY.requireIndependentVerification,
    requireEconomics: input?.requireEconomics ?? DEFAULT_CACHE_PROMOTION_POLICY.requireEconomics,
    requireStablePrefix: input?.requireStablePrefix ?? DEFAULT_CACHE_PROMOTION_POLICY.requireStablePrefix,
    requireHoldout: input?.requireHoldout ?? DEFAULT_CACHE_PROMOTION_POLICY.requireHoldout,
  };
  for (const [name, value] of Object.entries({
    noninferiorityMargin: policy.noninferiorityMargin,
    maxP50LatencyRegressionMs: policy.maxP50LatencyRegressionMs,
    maxP95LatencyRegressionMs: policy.maxP95LatencyRegressionMs,
    maxLatencyRegressionPercent: policy.maxLatencyRegressionPercent,
    maxCostRegressionPercent: policy.maxCostRegressionPercent,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`cache promotion ${name} must be finite and non-negative`);
  }
  return policy;
}

function indexTrials(
  trials: readonly CachePromotionTrial[],
  side: "baseline" | "candidate",
  cohort: string,
  issues: string[],
): Map<string, CachePromotionTrial> {
  const result = new Map<string, CachePromotionTrial>();
  for (const trial of trials) {
    if (!nonEmpty(trial.pairId)) {
      issues.push(`${side} trial has an empty pair id`);
      continue;
    }
    if (trial.cohort !== cohort) {
      issues.push(`${side} trial ${trial.pairId} has a cohort mismatch`);
    }
    if (result.has(trial.pairId)) {
      issues.push(`duplicate ${side} pair ${trial.pairId}`);
      continue;
    }
    result.set(trial.pairId, trial);
  }
  return result;
}

function summarizeQuality(
  pairs: readonly { baseline: CachePromotionTrial; candidate: CachePromotionTrial }[],
  deltas: readonly number[],
  suppliedLowerBound: number | null | undefined,
  margin: number,
): CacheQualitySummary {
  const baseline = pairs.map((pair) => pair.baseline.qualityScore).filter((value): value is number => value !== null);
  const candidate = pairs.map((pair) => pair.candidate.qualityScore).filter((value): value is number => value !== null);
  const meanDelta = deltas.length === 0 ? null : averageNumbers(deltas);
  const lowerBound = suppliedLowerBound ?? (deltas.length === 0 ? null : Math.min(...deltas));
  const source: CacheQualitySummary["lowerBoundSource"] = suppliedLowerBound !== undefined && suppliedLowerBound !== null
    ? "provided"
    : deltas.length === 0 ? "unavailable" : "paired_minimum";
  return {
    baselineMean: baseline.length === 0 ? null : averageNumbers(baseline),
    candidateMean: candidate.length === 0 ? null : averageNumbers(candidate),
    meanDelta,
    lowerBound,
    lowerBoundSource: source,
    noninferiorityMargin: margin,
    noninferior: lowerBound !== null && lowerBound >= -margin,
  };
}

function summarizeLatency(
  pairs: readonly { baseline: CachePromotionTrial; candidate: CachePromotionTrial }[],
): CacheLatencySummary {
  const baseline = pairs.map((pair) => pair.baseline.latencyMs);
  const candidate = pairs.map((pair) => pair.candidate.latencyMs);
  const baselineKnown = baseline.every((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  const candidateKnown = candidate.every((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  if (!baselineKnown || !candidateKnown || baseline.length === 0) {
    return {
      baselineP50Ms: null,
      candidateP50Ms: null,
      baselineP95Ms: null,
      candidateP95Ms: null,
      p50DeltaMs: null,
      p95DeltaMs: null,
    };
  }
  const baselineValues = baseline as number[];
  const candidateValues = candidate as number[];
  const baselineP50Ms = percentile(baselineValues, 0.5);
  const candidateP50Ms = percentile(candidateValues, 0.5);
  const baselineP95Ms = percentile(baselineValues, 0.95);
  const candidateP95Ms = percentile(candidateValues, 0.95);
  return {
    baselineP50Ms,
    candidateP50Ms,
    baselineP95Ms,
    candidateP95Ms,
    p50DeltaMs: candidateP50Ms - baselineP50Ms,
    p95DeltaMs: candidateP95Ms - baselineP95Ms,
  };
}

function latencyWithinPolicy(summary: CacheLatencySummary, policy: CachePromotionPolicy): boolean {
  if (summary.p50DeltaMs === null || summary.p95DeltaMs === null || summary.baselineP50Ms === null || summary.baselineP95Ms === null) return false;
  const p50Allowed = policy.maxP50LatencyRegressionMs + summary.baselineP50Ms * policy.maxLatencyRegressionPercent;
  const p95Allowed = policy.maxP95LatencyRegressionMs + summary.baselineP95Ms * policy.maxLatencyRegressionPercent;
  return summary.p50DeltaMs <= p50Allowed && summary.p95DeltaMs <= p95Allowed;
}

function summarizeCost(
  pairs: readonly { baseline: CachePromotionTrial; candidate: CachePromotionTrial }[],
): CachePromotionEvidence["effectiveInputCostMicros"] {
  const baseline = pairs.map((pair) => pair.baseline.observation.economics?.effectiveInputCostMicros ?? null);
  const candidate = pairs.map((pair) => pair.candidate.observation.economics?.effectiveInputCostMicros ?? null);
  if (baseline.some((value) => value === null) || candidate.some((value) => value === null) || baseline.length === 0) {
    return { baseline: null, candidate: null, deltaPercent: null };
  }
  const baselineTotal = baseline.reduce((sum, value) => sum + value!, 0n);
  const candidateTotal = candidate.reduce((sum, value) => sum + value!, 0n);
  const deltaPercent = baselineTotal === 0n
    ? candidateTotal === 0n ? 0 : Number.MAX_VALUE
    : (Number(candidateTotal - baselineTotal) / Number(baselineTotal)) * 100;
  return {
    baseline: baselineTotal.toString(),
    candidate: candidateTotal.toString(),
    deltaPercent,
  };
}

function completeReceipt(trial: CachePromotionTrial): boolean {
  const parsed = trial.providerReceipt === null
    ? null
    : cacheProviderReceiptSchema.safeParse(trial.providerReceipt);
  return parsed?.success === true
    && trial.providerReceipt!.verified
    && trial.providerReceipt!.providerId === trial.observation.providerId
    && trial.providerReceipt!.model === trial.observation.model;
}

function economicsComplete(trial: CachePromotionTrial): boolean {
  return trial.observation.inputTokens !== null
    && trial.observation.economics !== null;
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(quantile * ordered.length) - 1));
  return ordered[index]!;
}

function average(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return known.length === 0 ? null : averageNumbers(known);
}

function averageNumbers(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function addGate(
  gates: CachePromotionGate[],
  name: CachePromotionGate["name"],
  status: CachePromotionGateStatus,
  reason: string,
): void {
  gates.push({ name, status, reason });
}
