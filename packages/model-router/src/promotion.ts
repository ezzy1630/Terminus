/**
 * Paired router-promotion evidence.
 *
 * The router is deterministic and default-off.  This module only evaluates
 * immutable baseline/candidate outcome records; it never changes routing
 * weights or enables a model.  Missing telemetry is blocked (unknown), while
 * measured quality, latency, or cost regressions are explicit failures.
 */
import { z } from "zod";
import {
  hasCompleteRouterProviderReceipt,
  isVerifiedRouterOutcome,
  routerOutcomeRecordSchema,
  type RouterOutcomeRecord,
} from "./outcomes.js";

export type RouterPromotionDecision = "promote" | "retain_experimental" | "rollback";
export type RouterPromotionGateStatus = "pass" | "fail" | "blocked";

export interface RouterPromotionPolicy {
  readonly minimumPairs: number;
  readonly noninferiorityMargin: number;
  readonly maxP50LatencyRegressionMs: number;
  readonly maxP95LatencyRegressionMs: number;
  readonly maxLatencyRegressionPercent: number;
  readonly maxCostRegressionPercent: number;
  readonly requireProviderReceipts: boolean;
  readonly requireIndependentVerification: boolean;
  readonly requireHoldout: boolean;
}

export const DEFAULT_ROUTER_PROMOTION_POLICY: RouterPromotionPolicy = Object.freeze({
  minimumPairs: 20,
  noninferiorityMargin: 0.05,
  maxP50LatencyRegressionMs: 0,
  maxP95LatencyRegressionMs: 0,
  maxLatencyRegressionPercent: 0.05,
  maxCostRegressionPercent: 0,
  requireProviderReceipts: true,
  requireIndependentVerification: true,
  requireHoldout: true,
});

export interface RouterPromotionInput {
  readonly experimentId: string;
  readonly cohort: string;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly baseline: readonly RouterOutcomeRecord[];
  readonly candidate: readonly RouterOutcomeRecord[];
  readonly evidenceId?: string;
  readonly holdoutComplete?: boolean;
  /** Optional independently computed lower confidence bound for quality delta. */
  readonly qualityDeltaLowerBound?: number | null;
  readonly policy?: Partial<RouterPromotionPolicy>;
}

export interface RouterPromotionGate {
  readonly name:
  | "evidence_identity"
  | "cohort"
  | "paired_quality"
  | "latency"
  | "cost"
  | "provider_receipts"
  | "verification"
  | "holdout";
  readonly status: RouterPromotionGateStatus;
  readonly reason: string;
}

export interface RouterQualitySummary {
  readonly baselineMean: number | null;
  readonly candidateMean: number | null;
  readonly meanDelta: number | null;
  readonly lowerBound: number | null;
  readonly lowerBoundSource: "provided" | "paired_minimum" | "unavailable";
  readonly noninferiorityMargin: number;
  readonly noninferior: boolean;
}

export interface RouterLatencySummary {
  readonly baselineP50Ms: number | null;
  readonly candidateP50Ms: number | null;
  readonly baselineP95Ms: number | null;
  readonly candidateP95Ms: number | null;
  readonly p50DeltaMs: number | null;
  readonly p95DeltaMs: number | null;
}

export interface RouterPromotionEvidence {
  readonly schemaVersion: "terminus.routing.promotion.v1";
  readonly evidenceId: string | null;
  readonly experimentId: string;
  readonly cohort: string;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly pairCount: number;
  readonly baselineOutcomeIds: readonly string[];
  readonly candidateOutcomeIds: readonly string[];
  readonly quality: RouterQualitySummary;
  readonly latency: RouterLatencySummary;
  readonly costMicros: {
    readonly baseline: string | null;
    readonly candidate: string | null;
    readonly deltaPercent: number | null;
  };
  readonly gates: readonly RouterPromotionGate[];
  readonly blockingReasons: readonly string[];
  readonly promotionEligible: boolean;
  /** Advisory evidence only; no serving or default mutation occurs here. */
  readonly shadowOnly: true;
  readonly defaultEnabled: false;
  readonly decision: RouterPromotionDecision;
  readonly generatedAt: string;
}

export const routerPromotionEvidenceSchema = z.object({
  schemaVersion: z.literal("terminus.routing.promotion.v1"),
  evidenceId: z.string().nullable(),
  experimentId: z.string().min(1),
  cohort: z.string().min(1),
  baselineVersion: z.string().min(1),
  candidateVersion: z.string().min(1),
  pairCount: z.number().int().nonnegative(),
  baselineOutcomeIds: z.array(z.string().min(1)),
  candidateOutcomeIds: z.array(z.string().min(1)),
  quality: z.object({
    baselineMean: z.number().nullable(),
    candidateMean: z.number().nullable(),
    meanDelta: z.number().nullable(),
    lowerBound: z.number().nullable(),
    lowerBoundSource: z.enum(["provided", "paired_minimum", "unavailable"]),
    noninferiorityMargin: z.number().nonnegative(),
    noninferior: z.boolean(),
  }).strict(),
  latency: z.object({
    baselineP50Ms: z.number().nullable(),
    candidateP50Ms: z.number().nullable(),
    baselineP95Ms: z.number().nullable(),
    candidateP95Ms: z.number().nullable(),
    p50DeltaMs: z.number().nullable(),
    p95DeltaMs: z.number().nullable(),
  }).strict(),
  costMicros: z.object({
    baseline: z.string().nullable(),
    candidate: z.string().nullable(),
    deltaPercent: z.number().nullable(),
  }).strict(),
  gates: z.array(z.object({
    name: z.enum([
      "evidence_identity",
      "cohort",
      "paired_quality",
      "latency",
      "cost",
      "provider_receipts",
      "verification",
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

export function evaluateRouterPromotion(input: RouterPromotionInput): RouterPromotionEvidence {
  const policy = normalizePolicy(input.policy);
  const gates: RouterPromotionGate[] = [];
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

  const baselineByPair = indexOutcomes(input.baseline, "baseline", input.cohort, issues);
  const candidateByPair = indexOutcomes(input.candidate, "candidate", input.cohort, issues);
  const pairIds = [...baselineByPair.keys()]
    .filter((pairId) => candidateByPair.has(pairId))
    .filter((pairId) => baselineByPair.get(pairId)!.taskId === candidateByPair.get(pairId)!.taskId)
    .sort();
  const pairs = pairIds.map((pairId) => ({
    baseline: baselineByPair.get(pairId)!,
    candidate: candidateByPair.get(pairId)!,
  }));
  const pairCount = pairs.length;
  const cohortIssues = issues.some((issue) => issue.startsWith("duplicate") || issue.includes("cohort mismatch") || issue.includes("task mismatch"));
  const cohortPass = pairCount >= policy.minimumPairs && !cohortIssues;
  addGate(
    gates,
    "cohort",
    cohortPass ? "pass" : "blocked",
    cohortPass
      ? `${pairCount} exact task-paired outcomes meet minimum ${policy.minimumPairs}`
      : `${pairCount} exact task-paired outcomes available; minimum is ${policy.minimumPairs}`,
  );
  if (!cohortPass) issues.push(`cohort requires ${policy.minimumPairs} exact task pairs`);

  const qualityDeltas = pairs
    .filter((pair) => pair.baseline.qualityScore !== null && pair.candidate.qualityScore !== null)
    .map((pair) => pair.candidate.qualityScore! - pair.baseline.qualityScore!);
  const quality = summarizeQuality(pairs, qualityDeltas, input.qualityDeltaLowerBound, policy.noninferiorityMargin);
  const qualityPass = quality.meanDelta !== null && quality.noninferior;
  addGate(
    gates,
    "paired_quality",
    qualityPass ? "pass" : qualityDeltas.length === 0 ? "blocked" : "fail",
    qualityPass
      ? `paired quality delta ${quality.meanDelta!.toFixed(4)} is non-inferior`
      : qualityDeltas.length === 0
        ? "paired independently scored quality outcomes are required"
        : `paired quality lower bound ${quality.lowerBound?.toFixed(4) ?? "unavailable"} violates margin -${policy.noninferiorityMargin.toFixed(4)}`,
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
        ? "paired latency outcomes are required"
        : `latency regression exceeds guardrail (p50 ${latencies.p50DeltaMs.toFixed(2)}ms, p95 ${latencies.p95DeltaMs.toFixed(2)}ms)`,
  );

  const receiptPass = !policy.requireProviderReceipts
    || pairs.length > 0 && pairs.every((pair) => hasCompleteRouterProviderReceipt(pair.baseline) && hasCompleteRouterProviderReceipt(pair.candidate));
  addGate(
    gates,
    "provider_receipts",
    receiptPass ? "pass" : "blocked",
    receiptPass ? "all paired outcomes have verified opaque provider receipts" : "complete verified provider receipts are required for every pair",
  );

  const verificationPass = !policy.requireIndependentVerification
    || pairs.length > 0 && pairs.every((pair) => isVerifiedRouterOutcome(pair.baseline) && isVerifiedRouterOutcome(pair.candidate));
  addGate(
    gates,
    "verification",
    verificationPass ? "pass" : "blocked",
    verificationPass ? "all paired outcomes have immutable verification provenance" : "independent verification is required for every pair",
  );

  const cost = summarizeCost(pairs);
  const costPass = cost.deltaPercent !== null && cost.deltaPercent <= policy.maxCostRegressionPercent;
  addGate(
    gates,
    "cost",
    costPass ? "pass" : cost.deltaPercent === null ? "blocked" : "fail",
    costPass
      ? `cost delta ${cost.deltaPercent.toFixed(2)}% is within the guardrail`
      : cost.deltaPercent === null
        ? "paired cost outcomes are required"
        : `cost delta ${cost.deltaPercent.toFixed(2)}% exceeds ${policy.maxCostRegressionPercent.toFixed(2)}%`,
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
  const decision: RouterPromotionDecision = promotionEligible
    ? "promote"
    : hasMeasuredFailure ? "rollback" : "retain_experimental";
  const evidence: RouterPromotionEvidence = {
    schemaVersion: "terminus.routing.promotion.v1",
    evidenceId: nonEmpty(input.evidenceId) ? input.evidenceId! : null,
    experimentId: input.experimentId,
    cohort: input.cohort,
    baselineVersion: input.baselineVersion,
    candidateVersion: input.candidateVersion,
    pairCount,
    baselineOutcomeIds: pairs.map((pair) => pair.baseline.outcomeId),
    candidateOutcomeIds: pairs.map((pair) => pair.candidate.outcomeId),
    quality,
    latency: latencies,
    costMicros: cost,
    gates,
    blockingReasons,
    promotionEligible,
    shadowOnly: true,
    defaultEnabled: false,
    decision,
    generatedAt: new Date().toISOString(),
  };
  return routerPromotionEvidenceSchema.parse(evidence) as unknown as RouterPromotionEvidence;
}

/** Alias using the terminology in the routing plan. */
export const evaluateRoutingPromotion = evaluateRouterPromotion;

export class RouterPromotionGateEvaluator {
  constructor(private readonly policy: Partial<RouterPromotionPolicy> = {}) {}

  evaluate(input: Omit<RouterPromotionInput, "policy">): RouterPromotionEvidence {
    return evaluateRouterPromotion({ ...input, policy: this.policy });
  }
}

function normalizePolicy(input: Partial<RouterPromotionPolicy> | undefined): RouterPromotionPolicy {
  const minimumPairs = input?.minimumPairs ?? DEFAULT_ROUTER_PROMOTION_POLICY.minimumPairs;
  const policy: RouterPromotionPolicy = {
    minimumPairs,
    noninferiorityMargin: input?.noninferiorityMargin ?? DEFAULT_ROUTER_PROMOTION_POLICY.noninferiorityMargin,
    maxP50LatencyRegressionMs: input?.maxP50LatencyRegressionMs ?? DEFAULT_ROUTER_PROMOTION_POLICY.maxP50LatencyRegressionMs,
    maxP95LatencyRegressionMs: input?.maxP95LatencyRegressionMs ?? DEFAULT_ROUTER_PROMOTION_POLICY.maxP95LatencyRegressionMs,
    maxLatencyRegressionPercent: input?.maxLatencyRegressionPercent ?? DEFAULT_ROUTER_PROMOTION_POLICY.maxLatencyRegressionPercent,
    maxCostRegressionPercent: input?.maxCostRegressionPercent ?? DEFAULT_ROUTER_PROMOTION_POLICY.maxCostRegressionPercent,
    requireProviderReceipts: input?.requireProviderReceipts ?? DEFAULT_ROUTER_PROMOTION_POLICY.requireProviderReceipts,
    requireIndependentVerification: input?.requireIndependentVerification ?? DEFAULT_ROUTER_PROMOTION_POLICY.requireIndependentVerification,
    requireHoldout: input?.requireHoldout ?? DEFAULT_ROUTER_PROMOTION_POLICY.requireHoldout,
  };
  if (!Number.isSafeInteger(policy.minimumPairs) || policy.minimumPairs <= 0) {
    throw new RangeError("router promotion minimumPairs must be a positive safe integer");
  }
  for (const [name, value] of Object.entries({
    noninferiorityMargin: policy.noninferiorityMargin,
    maxP50LatencyRegressionMs: policy.maxP50LatencyRegressionMs,
    maxP95LatencyRegressionMs: policy.maxP95LatencyRegressionMs,
    maxLatencyRegressionPercent: policy.maxLatencyRegressionPercent,
    maxCostRegressionPercent: policy.maxCostRegressionPercent,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`router promotion ${name} must be finite and non-negative`);
  }
  return policy;
}

function indexOutcomes(
  records: readonly RouterOutcomeRecord[],
  side: "baseline" | "candidate",
  cohort: string,
  issues: string[],
): Map<string, RouterOutcomeRecord> {
  const result = new Map<string, RouterOutcomeRecord>();
  for (const record of records) {
    const validated = routerOutcomeRecordSchema.safeParse(record);
    if (!validated.success) {
      issues.push(`${side} outcome ${record.outcomeId} is not a valid durable record`);
      continue;
    }
    const normalized = validated.data as unknown as RouterOutcomeRecord;
    if (normalized.cohort !== cohort) issues.push(`${side} outcome ${normalized.outcomeId} has a cohort mismatch`);
    if (normalized.assignment !== side) issues.push(`${side} outcome ${normalized.outcomeId} has assignment '${normalized.assignment}'`);
    if (result.has(normalized.pairId)) {
      issues.push(`duplicate ${side} pair ${normalized.pairId}`);
      continue;
    }
    result.set(normalized.pairId, normalized);
  }
  return result;
}

function summarizeQuality(
  pairs: readonly { baseline: RouterOutcomeRecord; candidate: RouterOutcomeRecord }[],
  deltas: readonly number[],
  suppliedLowerBound: number | null | undefined,
  margin: number,
): RouterQualitySummary {
  const baseline = pairs.map((pair) => pair.baseline.qualityScore).filter((value): value is number => value !== null);
  const candidate = pairs.map((pair) => pair.candidate.qualityScore).filter((value): value is number => value !== null);
  const meanDelta = deltas.length === 0 ? null : average(deltas);
  const lowerBound = suppliedLowerBound ?? (deltas.length === 0 ? null : Math.min(...deltas));
  const lowerBoundSource: RouterQualitySummary["lowerBoundSource"] = suppliedLowerBound !== undefined && suppliedLowerBound !== null
    ? "provided"
    : deltas.length === 0 ? "unavailable" : "paired_minimum";
  return {
    baselineMean: baseline.length === 0 ? null : average(baseline),
    candidateMean: candidate.length === 0 ? null : average(candidate),
    meanDelta,
    lowerBound,
    lowerBoundSource,
    noninferiorityMargin: margin,
    noninferior: lowerBound !== null && lowerBound >= -margin,
  };
}

function summarizeLatency(
  pairs: readonly { baseline: RouterOutcomeRecord; candidate: RouterOutcomeRecord }[],
): RouterLatencySummary {
  const baseline = pairs.map((pair) => pair.baseline.latencyMs);
  const candidate = pairs.map((pair) => pair.candidate.latencyMs);
  if (baseline.length === 0 || !baseline.every(Number.isFinite) || !candidate.every(Number.isFinite)) {
    return {
      baselineP50Ms: null,
      candidateP50Ms: null,
      baselineP95Ms: null,
      candidateP95Ms: null,
      p50DeltaMs: null,
      p95DeltaMs: null,
    };
  }
  const baselineP50Ms = percentile(baseline, 0.5);
  const candidateP50Ms = percentile(candidate, 0.5);
  const baselineP95Ms = percentile(baseline, 0.95);
  const candidateP95Ms = percentile(candidate, 0.95);
  return {
    baselineP50Ms,
    candidateP50Ms,
    baselineP95Ms,
    candidateP95Ms,
    p50DeltaMs: candidateP50Ms - baselineP50Ms,
    p95DeltaMs: candidateP95Ms - baselineP95Ms,
  };
}

function latencyWithinPolicy(summary: RouterLatencySummary, policy: RouterPromotionPolicy): boolean {
  if (summary.p50DeltaMs === null || summary.p95DeltaMs === null || summary.baselineP50Ms === null || summary.baselineP95Ms === null) return false;
  const p50Allowed = policy.maxP50LatencyRegressionMs + summary.baselineP50Ms * policy.maxLatencyRegressionPercent;
  const p95Allowed = policy.maxP95LatencyRegressionMs + summary.baselineP95Ms * policy.maxLatencyRegressionPercent;
  return summary.p50DeltaMs <= p50Allowed && summary.p95DeltaMs <= p95Allowed;
}

function summarizeCost(
  pairs: readonly { baseline: RouterOutcomeRecord; candidate: RouterOutcomeRecord }[],
): RouterPromotionEvidence["costMicros"] {
  if (pairs.length === 0) return { baseline: null, candidate: null, deltaPercent: null };
  const baseline = pairs.reduce((sum, pair) => sum + pair.baseline.costMicros, 0n);
  const candidate = pairs.reduce((sum, pair) => sum + pair.candidate.costMicros, 0n);
  const deltaPercent = baseline === 0n
    ? candidate === 0n ? 0 : Number.MAX_VALUE
    : Number(candidate - baseline) / Number(baseline) * 100;
  return { baseline: baseline.toString(), candidate: candidate.toString(), deltaPercent };
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(quantile * ordered.length) - 1));
  return ordered[index]!;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function addGate(
  gates: RouterPromotionGate[],
  name: RouterPromotionGate["name"],
  status: RouterPromotionGateStatus,
  reason: string,
): void {
  gates.push({ name, status, reason });
}
