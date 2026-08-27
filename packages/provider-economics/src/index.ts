/**
 * @terminus/provider-economics — budget enforcement, cost reconciliation,
 * fallback observation, and partial stream settlement (§38.14, §38.5, §38.12).
 *
 * Pure logic over @terminus/provider-core types. No network I/O.
 * Uses Jane Street style: strong types, no `any`, decode `unknown` at
 * boundaries, clear invariants, small composable functions.
 */
import { z } from "zod";
import type {
  Micros,
  TokenCount,
  ModelKey,
  ConfidentialityLabel,
} from "@terminus/domain";
import type {
  UsageRecord,
  ProviderEconomics,
  ReconciliationReport,
  FallbackObservation,
  PartialStreamResult,
  BudgetLimits,
  BudgetState,
  BudgetCheckResult,
  ProviderResponseChunk,
  CostRecord,
  ConfidentialityPolicy,
} from "@terminus/provider-core";
import {
  checkBudget,
  reconcileCost,
  computeCost,
  computeExactCostMicros,
} from "@terminus/provider-core";
import { settlePartialStream, validateFallbackPolicy } from "@terminus/provider-core";

export type {
  ReconciliationReport,
  FallbackObservation,
  PartialStreamResult,
  BudgetLimits,
  BudgetState,
  BudgetCheckResult,
  CostRecord,
};

export { checkBudget, reconcileCost, settlePartialStream, validateFallbackPolicy };
export { computeExactCostMicros };

// ────────────────────────── Budget guard (§38.14) ────────────────────────────

export interface CostEstimateInput {
  readonly promptTokens: TokenCount;
  readonly predictedOutputTokens: TokenCount;
  readonly predictedReasoningTokens: TokenCount;
  readonly predictedCachedTokens: TokenCount;
}

export function estimateCostMicros(
  input: CostEstimateInput,
  economics: ProviderEconomics,
): Micros {
  // Cached tokens are a subset of the prompt. An inconsistent caller that
  // reports cached > prompt must not produce a negative input cost, which
  // would deflate budgets through checkBudget/recordSpend.
  const cachedTokens = input.predictedCachedTokens > input.promptTokens
    ? input.promptTokens
    : input.predictedCachedTokens;
  return computeExactCostMicros({
    inputTokens: input.promptTokens,
    cachedInputTokens: cachedTokens,
    cacheWriteTokens: 0n as TokenCount,
    outputTokens: input.predictedOutputTokens,
    reasoningTokens: input.predictedReasoningTokens,
    toolSchemaTokens: 0n as TokenCount,
    latencyMs: 0,
    timeToFirstTokenMs: null,
  }, economics);
}

/**
 * Guard that enforces request/task/session budgets BEFORE a provider send.
 * Pure function — callers supply current state and limits.
 */
export class BudgetGuard {
  constructor(
    private readonly limits: BudgetLimits,
    private state: BudgetState,
  ) {}

  /** Check whether a provider call at estimated cost can proceed. */
  check(estimatedCostMicros: Micros): BudgetCheckResult {
    return checkBudget(this.limits, this.state, estimatedCostMicros);
  }

  /** Record spend after a successful provider call. */
  recordSpend(actualCostMicros: Micros): void {
    this.state = {
      requestSpent: (this.state.requestSpent + actualCostMicros) as Micros,
      taskSpent: (this.state.taskSpent + actualCostMicros) as Micros,
      sessionSpent: (this.state.sessionSpent + actualCostMicros) as Micros,
    };
  }

  /** Current budget state snapshot. */
  snapshot(): BudgetState {
    return { ...this.state };
  }

  /** Reset request-level budget (e.g., between turns). */
  resetRequest(): void {
    this.state = { ...this.state, requestSpent: 0n as Micros };
  }

  /** Remaining budget per scope. */
  remaining(): { readonly request: Micros; readonly task: Micros; readonly session: Micros } {
    return {
      request: (this.limits.requestMicros - this.state.requestSpent) as Micros,
      task: (this.limits.taskMicros - this.state.taskSpent) as Micros,
      session: (this.limits.sessionMicros - this.state.sessionSpent) as Micros,
    };
  }
}

// ────────────────────────── Cost reconciler (§38.14) ─────────────────────────

/**
 * Accumulates provider usage observations and reconciles them against
 * predicted costs and provider economics. Produces ReconciliationReports
 * suitable for cost audit trails.
 */
export class CostReconciler {
  private readonly reports: ReconciliationReport[] = [];

  /** Reconcile a single provider attempt. */
  reconcile(
    manifestId: string,
    providerId: string,
    model: ModelKey,
    usage: UsageRecord,
    economics: ProviderEconomics,
    predictedCostMicros: Micros,
    providerReportedCostMicros: Micros | null,
  ): ReconciliationReport {
    const report = reconcileCost(
      manifestId,
      providerId,
      model,
      usage,
      economics,
      predictedCostMicros,
      providerReportedCostMicros,
    );
    this.reports.push(report);
    return report;
  }

  /** All reconciliation reports for this session. */
  allReports(): readonly ReconciliationReport[] {
    return this.reports;
  }

  /** Detect anomalies across all reports. */
  anomalies(): readonly ReconciliationReport[] {
    return this.reports.filter((r) => r.anomaly);
  }

  /** Total observed cost across all reconciled attempts. */
  totalObservedCost(): Micros {
    return this.reports.reduce(
      (sum, r) => (sum + r.observedCostMicros) as Micros,
      0n as Micros,
    );
  }

  /** Total delta (predicted - observed) across all attempts. */
  totalDelta(): Micros {
    return this.reports.reduce(
      (sum, r) => (sum + r.deltaMicros) as Micros,
      0n as Micros,
    );
  }

  /** Mean absolute percentage error across non-zero predictions. */
  mape(): number | null {
    const nonZero = this.reports.filter((r) => r.predictedCostMicros > 0n);
    if (nonZero.length === 0) return null;
    const sumAbsPct = nonZero.reduce((sum, r) => {
      const pct = Math.abs(Number(r.deltaMicros)) / Number(r.predictedCostMicros);
      return sum + pct;
    }, 0);
    return sumAbsPct / nonZero.length;
  }
}

// ────────────────────────── Fallback observer (§38.5) ────────────────────────

/**
 * Records every fallback event with full observability: cost/latency/
 * continuation/cache impact plus policy compliance check.
 */
export class FallbackObserver {
  private readonly observations: FallbackObservation[] = [];

  record(
    originalProvider: string,
    originalModel: ModelKey,
    fallbackProvider: string,
    fallbackModel: ModelKey,
    reason: string,
    opts: {
      readonly continuationLost: boolean;
      readonly cacheLost: boolean;
      readonly costImpactMicros: Micros;
      readonly latencyImpactMs: number;
      readonly userConsentRequired: boolean;
    },
    confidentialityPolicy: ConfidentialityPolicy,
    confidentiality: ConfidentialityLabel,
  ): FallbackObservation {
    const policyCheck = validateFallbackPolicy(
      {
        originalProvider,
        originalModel,
        fallbackProvider,
        fallbackModel,
        reason,
        continuationLost: opts.continuationLost,
        cacheLost: opts.cacheLost,
        costImpactMicros: opts.costImpactMicros,
        latencyImpactMs: opts.latencyImpactMs,
        userConsentRequired: opts.userConsentRequired,
        policyCompliant: true,
        policyCheckReason: null,
        occurredAt: "",
      },
      confidentialityPolicy,
      confidentiality,
    );
    const observation: FallbackObservation = {
      originalProvider,
      originalModel,
      fallbackProvider,
      fallbackModel,
      reason,
      continuationLost: opts.continuationLost,
      cacheLost: opts.cacheLost,
      costImpactMicros: opts.costImpactMicros,
      latencyImpactMs: opts.latencyImpactMs,
      userConsentRequired: opts.userConsentRequired,
      policyCompliant: policyCheck.compliant,
      policyCheckReason: policyCheck.reason,
      occurredAt: new Date().toISOString(),
    };
    this.observations.push(observation);
    return observation;
  }

  all(): readonly FallbackObservation[] {
    return this.observations;
  }

  /** Returns fallback events that were policy-compliant. */
  compliant(): readonly FallbackObservation[] {
    return this.observations.filter((o) => o.policyCompliant);
  }

  /** Returns fallback events that violated policy. */
  violations(): readonly FallbackObservation[] {
    return this.observations.filter((o) => !o.policyCompliant);
  }

  /** Total cost impact of all fallbacks. */
  totalCostImpact(): Micros {
    return this.observations.reduce(
      (sum, o) => (sum + o.costImpactMicros) as Micros,
      0n as Micros,
    );
  }
}

// ────────────────────────── Partial stream settler (§38.12) ──────────────────

/**
 * Handles cancellation of in-flight provider streams. Computes partial
 * results: text received so far, tool calls initiated, cost accrued,
 * and whether continuation is possible.
 */
export class PartialStreamSettler {
  private result: PartialStreamResult | null = null;

  /**
   * Settle a partial stream. Call when a provider stream is cancelled
   * (user abort, timeout, budget exhausted, policy denied, or error).
   */
  settle(
    chunks: readonly ProviderResponseChunk[],
    cancellationReason: PartialStreamResult["cancellationReason"],
    economics: ProviderEconomics,
  ): PartialStreamResult {
    this.result = settlePartialStream(chunks, cancellationReason, economics);
    return this.result;
  }

  /** The settled partial result, or null if not yet settled. */
  settled(): PartialStreamResult | null {
    return this.result;
  }

  /** Whether the partial result can be continued (no tool calls in flight). */
  canContinue(): boolean {
    return this.result?.continuationPossible ?? false;
  }
}

// ────────────────────────── Zod schemas for validation ───────────────────────

export const budgetLimitsSchema = z.object({
  requestMicros: z.bigint().min(0n),
  taskMicros: z.bigint().min(0n),
  sessionMicros: z.bigint().min(0n),
});

export const budgetStateSchema = z.object({
  requestSpent: z.bigint().min(0n),
  taskSpent: z.bigint().min(0n),
  sessionSpent: z.bigint().min(0n),
});

export const costEstimateInputSchema = z.object({
  promptTokens: z.bigint().min(0n),
  predictedOutputTokens: z.bigint().min(0n),
  predictedReasoningTokens: z.bigint().min(0n),
  predictedCachedTokens: z.bigint().min(0n),
});
