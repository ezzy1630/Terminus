import type { ProviderToolCallChunk } from "@terminus/provider-core";
import type { OperationObservation } from "./loop-contracts.js";

/**
 * Adaptive turn budget (deep-audit Rank 2).
 *
 * Replaces the fixed four-cycle ceiling with explicit budgets:
 * - a step budget (provider attempts) with a HARD safety maximum;
 * - a wall-clock deadline;
 * - stagnation detection over normalized tool operations, so repeating the
 *   same failing operation without a changed hypothesis stops early instead
 *   of burning the full budget.
 *
 * The hard maximum is not presented as an invariant: it is a safety stop
 * that the adaptive budget may approach but never exceed.
 */

export const HARD_MAX_STEPS = 24;

export interface TurnBudgetOptions {
  /** Soft step budget; the loop stops when exhausted. Must be <= hardMaxSteps. */
  readonly maxSteps?: number;
  /** Absolute safety maximum; exceeding it is a programming error. */
  readonly hardMaxSteps?: number;
  /** Wall-clock deadline for the whole turn in milliseconds. */
  readonly wallClockMs?: number;
  /**
   * A step is stagnant after this many repeats of the same operation hash
   * with no workspace-changing call in between.
   */
  readonly stagnationRepeatLimit?: number;
  /** Hard model-token budget for this turn, including all recorded usage. */
  readonly maxTokens?: bigint;
  /** Hard provider-cost budget for this turn. */
  readonly maxCostMicros?: bigint;
  /** Context tokens still available to the next attempt. */
  readonly contextHeadroomTokens?: bigint;
  /** Tokens reserved for the independent final verification request. */
  readonly finalVerificationReserveTokens?: bigint;
  /** Cost reserved for the independent final verification request. */
  readonly finalVerificationReserveCostMicros?: bigint;
  /** Minimum deterministic expected value for another attempt. */
  readonly minExpectedValue?: number;
  readonly now?: () => number;
}

export type BudgetStopReason =
  | "steps_exhausted"
  | "hard_max_exceeded"
  | "wall_clock_exceeded"
  | "stagnation_detected"
  | "cancelled"
  | "token_budget_exhausted"
  | "cost_budget_exhausted"
  | "context_headroom_exhausted"
  | "expected_value_too_low";

export interface TurnBudgetDecision {
  readonly allowed: boolean;
  readonly reason: BudgetStopReason | null;
}

/**
 * Effect facts needed before a provider batch can be executed safely.
 *
 * `sideEffectClass` is intentionally retained as a string: provider/tool
 * contracts may introduce a narrower class without making the loop import a
 * provider-specific union. The remaining fields describe concurrency and
 * cache boundaries, not the tool's user-visible result.
 */
export type OperationConsistency = "workspace_snapshot" | "live" | "eventual";

export interface OperationEffectMetadata {
  readonly sideEffectClass: string;
  /** A stable snapshot identity; null means that concurrent execution is unsafe. */
  readonly workspaceSnapshot: string | null;
  readonly externalNetwork: boolean;
  /** Operations sharing an affinity key must remain ordered. */
  readonly processAffinity: string | null;
  readonly consistency: OperationConsistency;
  readonly rateLimitGroup: string | null;
  readonly cacheable: boolean;
  /** Expected wall-clock latency used by schedulers and audit readers. */
  readonly expectedLatencyMs: number;
  /** Expected model-visible output size before projection. */
  readonly expectedOutputBytes: number;
}

export interface ToolExecutionBatch {
  readonly calls: readonly ProviderToolCallChunk[];
  readonly parallel: boolean;
  readonly consistency: OperationConsistency | null;
  readonly reason:
    | "read_snapshot"
    | "read_serial"
    | "effect_serial";
}

interface LegacyOperationRecord {
  hash: string;
  mutatesWorkspace: boolean;
}

export interface OperationProgressAnalysis {
  readonly progressed: boolean;
  readonly noOp: boolean;
  readonly repeatedFailure: boolean;
  readonly oscillating: boolean;
  readonly failureClass: string | null;
  readonly recommendedRecovery: readonly ProgressRecoveryAction[];
  readonly reason:
    | "new_operation"
    | "workspace_changed"
    | "verification_changed"
    | "result_changed"
    | "no_op"
    | "repeated_failure"
    | "oscillation";
}

export type ProgressRecoveryAction =
  | "change_hypothesis"
  | "inspect_evidence"
  | "rollback"
  | "stop";

export interface BudgetUsage {
  readonly inputTokens?: bigint | undefined;
  readonly cachedInputTokens?: bigint | undefined;
  readonly cacheWriteTokens?: bigint | undefined;
  readonly outputTokens?: bigint | undefined;
  readonly reasoningTokens?: bigint | undefined;
  readonly toolSchemaTokens?: bigint | undefined;
  readonly costMicros?: bigint | undefined;
}

export interface BudgetEvidenceState {
  readonly outstandingCriteria: number;
  readonly satisfiedCriteria: number;
  readonly verificationFailures: number;
  readonly repairAttempts: number;
  readonly evidenceCoverage: number;
  readonly expectedValue: number | null;
  readonly reliability: number | null;
  readonly providerReliability: number | null;
  readonly toolReliability: number | null;
}

export interface BudgetLedgerSnapshot {
  readonly stepsUsed: number;
  readonly maxSteps: number;
  readonly hardMaxSteps: number;
  readonly tokensUsed: bigint;
  /** Provider-reported dimensions are retained without folding cache reads into input twice. */
  readonly usage: {
    readonly inputTokens: bigint;
    readonly cachedInputTokens: bigint;
    readonly cacheWriteTokens: bigint;
    readonly outputTokens: bigint;
    readonly reasoningTokens: bigint;
    readonly toolSchemaTokens: bigint;
  };
  readonly maxTokens: bigint | null;
  readonly costMicros: bigint;
  readonly maxCostMicros: bigint | null;
  readonly contextHeadroomTokens: bigint | null;
  readonly finalVerificationReserveTokens: bigint;
  readonly finalVerificationReserveCostMicros: bigint;
  readonly evidence: BudgetEvidenceState;
  readonly lastProgress: OperationProgressAnalysis | null;
}

/** Classify whether a tool call can mutate the workspace or process state. */
export function toolCallIsReadOnly(
  sideEffectClassOf: (toolName: string) => string,
  call: ProviderToolCallChunk,
): boolean {
  return sideEffectClassOf(call.toolName) === "read";
}

/**
 * Plan execution order for the tool calls of one provider response.
 *
 * Read-only/search calls run concurrently; overlapping writes serialize in
 * provider order behind all prior reads. The returned batches preserve
 * provider order overall so results can be restored deterministically, and
 * guarantee a write never observes an unordered concurrent write.
 */
export function planToolBatches(
  calls: readonly ProviderToolCallChunk[],
  isReadOnly: (call: ProviderToolCallChunk) => boolean,
  effectMetadataOf?: (call: ProviderToolCallChunk) => OperationEffectMetadata,
): ReadonlyArray<ReadonlyArray<ProviderToolCallChunk>> {
  return planToolExecution(calls, (call) => {
    if (effectMetadataOf !== undefined) return effectMetadataOf(call);
    return {
      sideEffectClass: isReadOnly(call) ? "read" : "effect",
      // The legacy callback carries no snapshot identity. Preserve the old
      // behaviour for pure reads while keeping effects serial.
      workspaceSnapshot: isReadOnly(call) ? "legacy-read" : null,
      externalNetwork: false,
      processAffinity: null,
      consistency: isReadOnly(call) ? "workspace_snapshot" : "live",
      rateLimitGroup: null,
      cacheable: isReadOnly(call),
      expectedLatencyMs: isReadOnly(call) ? 250 : 30_000,
      expectedOutputBytes: 32 * 1_024,
    };
  }).map((batch) => batch.calls);
}

/**
 * Produce an auditable execution plan. Parallelism is granted only to a
 * contiguous group of pure reads against one known snapshot. All other calls
 * are serialized in provider order, which is the safe default for unknown
 * process, network, and consistency semantics.
 */
export function planToolExecution(
  calls: readonly ProviderToolCallChunk[],
  effectMetadataOf: (call: ProviderToolCallChunk) => OperationEffectMetadata,
): readonly ToolExecutionBatch[] {
  const batches: ToolExecutionBatch[] = [];
  let pendingReads: { call: ProviderToolCallChunk; metadata: OperationEffectMetadata }[] = [];
  const flushReads = (): void => {
    if (pendingReads.length === 0) return;
    const first = pendingReads[0]!.metadata;
    const parallel = pendingReads.length > 1;
    batches.push({
      calls: pendingReads.map(({ call }) => call),
      parallel,
      consistency: first.consistency,
      reason: parallel ? "read_snapshot" : "read_serial",
    });
    pendingReads = [];
  };
  for (const call of calls) {
    const metadata = effectMetadataOf(call);
    const canShareSnapshot = metadata.sideEffectClass === "read"
      && metadata.workspaceSnapshot !== null
      && !metadata.externalNetwork
      && metadata.processAffinity === null
      && metadata.consistency === "workspace_snapshot";
    if (canShareSnapshot) {
      const previous = pendingReads[0]?.metadata;
      if (
        previous !== undefined
        && (previous.workspaceSnapshot !== metadata.workspaceSnapshot
          || previous.consistency !== metadata.consistency)
      ) {
        flushReads();
      }
      pendingReads.push({ call, metadata });
      continue;
    }
    flushReads();
    batches.push({
      calls: [call],
      parallel: false,
      consistency: metadata.consistency,
      reason: "effect_serial",
    });
  }
  flushReads();
  return batches;
}

export class TurnBudget {
  private stepsUsed = 0;
  private readonly operationHistory: LegacyOperationRecord[] = [];
  private readonly observationHistory: OperationObservation[] = [];
  private readonly maxSteps: number;
  private readonly hardMaxSteps: number;
  private readonly startedAtMs: number;
  private readonly wallClockMs: number | null;
  private readonly stagnationRepeatLimit: number;
  private readonly maxTokens: bigint | null;
  private readonly maxCostMicros: bigint | null;
  private readonly contextHeadroomTokens: bigint | null;
  private readonly finalVerificationReserveTokens: bigint;
  private readonly finalVerificationReserveCostMicros: bigint;
  private readonly minExpectedValue: number | null;
  private readonly now: () => number;
  private tokensUsed = 0n;
  private usage = {
    inputTokens: 0n,
    cachedInputTokens: 0n,
    cacheWriteTokens: 0n,
    outputTokens: 0n,
    reasoningTokens: 0n,
    toolSchemaTokens: 0n,
  };
  private costMicros = 0n;
  private contextHeadroomRemaining: bigint | null;
  private evidence: BudgetEvidenceState = {
    outstandingCriteria: 0,
    satisfiedCriteria: 0,
    verificationFailures: 0,
    repairAttempts: 0,
    evidenceCoverage: 0,
    expectedValue: null,
    reliability: null,
    providerReliability: null,
    toolReliability: null,
  };
  private nonProgressRun = 0;
  private lastProgress: OperationProgressAnalysis | null = null;
  private cancelled = false;

  constructor(options: TurnBudgetOptions = {}) {
    this.now = options.now ?? Date.now;
    this.hardMaxSteps = options.hardMaxSteps ?? HARD_MAX_STEPS;
    this.maxSteps = Math.min(
      options.maxSteps ?? this.hardMaxSteps,
      this.hardMaxSteps,
    );
    this.startedAtMs = this.now();
    this.wallClockMs = options.wallClockMs ?? null;
    this.stagnationRepeatLimit = options.stagnationRepeatLimit ?? 3;
    this.maxTokens = options.maxTokens ?? null;
    this.maxCostMicros = options.maxCostMicros ?? null;
    this.contextHeadroomTokens = options.contextHeadroomTokens ?? null;
    this.contextHeadroomRemaining = this.contextHeadroomTokens;
    this.finalVerificationReserveTokens = options.finalVerificationReserveTokens ?? 0n;
    this.finalVerificationReserveCostMicros = options.finalVerificationReserveCostMicros ?? 0n;
    this.minExpectedValue = options.minExpectedValue ?? null;
    if (this.maxSteps < 0 || this.hardMaxSteps < 0 || this.maxSteps > this.hardMaxSteps) {
      throw new Error("maxSteps must be non-negative and no greater than hardMaxSteps");
    }
    if (this.stagnationRepeatLimit < 1 || !Number.isInteger(this.stagnationRepeatLimit)) {
      throw new Error("stagnationRepeatLimit must be a positive integer");
    }
    if (this.minExpectedValue !== null && (!Number.isFinite(this.minExpectedValue) || this.minExpectedValue < 0)) {
      throw new Error("minExpectedValue must be a finite non-negative number");
    }
    for (const [label, value] of [
      ["maxTokens", this.maxTokens],
      ["maxCostMicros", this.maxCostMicros],
      ["contextHeadroomTokens", this.contextHeadroomTokens],
      ["finalVerificationReserveTokens", this.finalVerificationReserveTokens],
      ["finalVerificationReserveCostMicros", this.finalVerificationReserveCostMicros],
    ] as const) {
      if (value !== null && value < 0n) throw new Error(`${label} must be non-negative`);
    }
  }

  /** Record one provider attempt (a step). */
  recordStep(): void {
    this.stepsUsed += 1;
  }

  /** Record one settled tool operation for stagnation analysis. */
  recordOperation(operationHash: string, mutatesWorkspace: boolean): void {
    if (mutatesWorkspace) {
      // A workspace mutation invalidates prior repetition analysis: the
      // world changed, so identical-looking follow-ups are new hypotheses.
      this.operationHistory.length = 0;
      return;
    }
    this.operationHistory.push({ hash: operationHash, mutatesWorkspace });
    if (this.operationHistory.length > 64) this.operationHistory.shift();
  }

  /**
   * Record the richer observation used by semantic progress detection. The
   * legacy overload above remains for older composition roots; once a typed
   * observation arrives it owns the stagnation stream and legacy entries no
   * longer affect decisions.
   */
  recordObservation(observation: OperationObservation): OperationProgressAnalysis {
    this.operationHistory.length = 0;
    const previous = this.observationHistory[this.observationHistory.length - 1] ?? null;
    const workspaceChanged = observation.workspaceRevisionBefore !== observation.workspaceRevisionAfter
      && (observation.workspaceRevisionBefore !== null || observation.workspaceRevisionAfter !== null);
    const verificationChanged = previous !== null
      && observation.verificationDelta !== previous.verificationDelta;
    const resultChanged = previous !== null && observation.resultHash !== previous.resultHash;
    const sameSemantic = previous !== null
      && observation.semanticFingerprint === previous.semanticFingerprint;
    const failureClass = operationFailureClass(observation);
    const repeatedFailure = previous !== null
      && failureClass !== null
      && failureClass === operationFailureClass(previous)
      && !workspaceChanged
      && !verificationChanged;
    const historyLength = this.observationHistory.length;
    const oscillating = historyLength >= 3
      && this.observationHistory[historyLength - 3]!.semanticFingerprint === this.observationHistory[historyLength - 1]!.semanticFingerprint
      && this.observationHistory[historyLength - 2]!.semanticFingerprint === observation.semanticFingerprint
      && this.observationHistory[historyLength - 3]!.semanticFingerprint !== observation.semanticFingerprint
      && !workspaceChanged
      && !verificationChanged;
    const noOp = sameSemantic && !workspaceChanged && !verificationChanged && !resultChanged;
    const progressed = workspaceChanged || verificationChanged || (!noOp && !repeatedFailure && !oscillating);
    const reason: OperationProgressAnalysis["reason"] = workspaceChanged
      ? "workspace_changed"
      : verificationChanged
        ? "verification_changed"
        : oscillating
          ? "oscillation"
          : repeatedFailure
            ? "repeated_failure"
            : noOp
              ? "no_op"
              : resultChanged
                ? "result_changed"
                : "new_operation";
    const analysis: OperationProgressAnalysis = {
      progressed,
      noOp,
      repeatedFailure,
      oscillating,
      failureClass,
      recommendedRecovery: progressed
        ? []
        : ["change_hypothesis", "inspect_evidence", "rollback", "stop"],
      reason,
    };
    this.lastProgress = analysis;
    this.nonProgressRun = progressed ? 0 : this.nonProgressRun + 1;
    this.observationHistory.push(observation);
    if (this.observationHistory.length > 128) this.observationHistory.shift();
    return analysis;
  }

  /** Record provider usage and cost without allowing negative accounting. */
  recordUsage(usage: BudgetUsage): void {
    const values = {
      inputTokens: usage.inputTokens ?? 0n,
      cachedInputTokens: usage.cachedInputTokens ?? 0n,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0n,
      outputTokens: usage.outputTokens ?? 0n,
      reasoningTokens: usage.reasoningTokens ?? 0n,
      toolSchemaTokens: usage.toolSchemaTokens ?? 0n,
    };
    for (const value of Object.values(values)) {
      if (value < 0n) throw new Error("budget token usage cannot be negative");
    }
    this.usage = {
      inputTokens: this.usage.inputTokens + values.inputTokens,
      cachedInputTokens: this.usage.cachedInputTokens + values.cachedInputTokens,
      cacheWriteTokens: this.usage.cacheWriteTokens + values.cacheWriteTokens,
      outputTokens: this.usage.outputTokens + values.outputTokens,
      reasoningTokens: this.usage.reasoningTokens + values.reasoningTokens,
      toolSchemaTokens: this.usage.toolSchemaTokens + values.toolSchemaTokens,
    };
    // inputTokens is already the provider's complete input dimension. A
    // cached-input count is a subset for cost/accounting purposes, not an
    // additional token stream. Cache writes are reported separately by some
    // providers and therefore add to the total when present.
    this.tokensUsed += values.inputTokens
      + values.cacheWriteTokens
      + values.outputTokens
      + values.reasoningTokens
      + values.toolSchemaTokens;
    if (usage.costMicros !== undefined) {
      if (usage.costMicros < 0n) throw new Error("budget cost cannot be negative");
      this.costMicros += usage.costMicros;
    }
  }

  /** Account for the input context consumed by an attempt. */
  recordContextUsage(tokens: bigint): void {
    if (tokens < 0n) throw new Error("context usage cannot be negative");
    if (this.contextHeadroomRemaining === null) return;
    this.contextHeadroomRemaining = tokens >= this.contextHeadroomRemaining
      ? 0n
      : this.contextHeadroomRemaining - tokens;
  }

  /** Record verifier state used for deterministic expected-value decisions. */
  recordEvidence(state: Partial<BudgetEvidenceState>): void {
    const next: BudgetEvidenceState = {
      outstandingCriteria: state.outstandingCriteria ?? this.evidence.outstandingCriteria,
      satisfiedCriteria: state.satisfiedCriteria ?? this.evidence.satisfiedCriteria,
      verificationFailures: state.verificationFailures ?? this.evidence.verificationFailures,
      repairAttempts: state.repairAttempts ?? this.evidence.repairAttempts,
      evidenceCoverage: state.evidenceCoverage ?? this.evidence.evidenceCoverage,
      expectedValue: state.expectedValue === undefined ? this.evidence.expectedValue : state.expectedValue,
      reliability: state.reliability === undefined ? this.evidence.reliability : state.reliability,
      providerReliability: state.providerReliability === undefined
        ? this.evidence.providerReliability
        : state.providerReliability,
      toolReliability: state.toolReliability === undefined
        ? this.evidence.toolReliability
        : state.toolReliability,
    };
    if (next.outstandingCriteria < 0 || next.satisfiedCriteria < 0 || next.verificationFailures < 0) {
      throw new Error("budget evidence counts cannot be negative");
    }
    if (next.evidenceCoverage < 0 || next.evidenceCoverage > 1) {
      throw new Error("budget evidenceCoverage must be between 0 and 1");
    }
    if (next.expectedValue !== null && (!Number.isFinite(next.expectedValue) || next.expectedValue < 0)) {
      throw new Error("budget expectedValue must be finite and non-negative");
    }
    if (next.reliability !== null && (!Number.isFinite(next.reliability) || next.reliability < 0 || next.reliability > 1)) {
      throw new Error("budget reliability must be between 0 and 1");
    }
    if (next.providerReliability !== null && (!Number.isFinite(next.providerReliability) || next.providerReliability < 0 || next.providerReliability > 1)) {
      throw new Error("budget providerReliability must be between 0 and 1");
    }
    if (next.toolReliability !== null && (!Number.isFinite(next.toolReliability) || next.toolReliability < 0 || next.toolReliability > 1)) {
      throw new Error("budget toolReliability must be between 0 and 1");
    }
    this.evidence = next;
  }

  /** Most repeated consecutive read-only operation count. */
  stagnationRun(): number {
    if (this.observationHistory.length > 0) return this.nonProgressRun;
    if (this.operationHistory.length === 0) return 0;
    const last = this.operationHistory[this.operationHistory.length - 1]!;
    let run = 0;
    for (let i = this.operationHistory.length - 1; i >= 0; i -= 1) {
      if (this.operationHistory[i]!.hash !== last.hash) break;
      run += 1;
    }
    return run;
  }

  cancel(): void {
    this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get steps(): number {
    return this.stepsUsed;
  }

  get ledger(): BudgetLedgerSnapshot {
    return {
      stepsUsed: this.stepsUsed,
      maxSteps: this.maxSteps,
      hardMaxSteps: this.hardMaxSteps,
      tokensUsed: this.tokensUsed,
      usage: this.usage,
      maxTokens: this.maxTokens,
      costMicros: this.costMicros,
      maxCostMicros: this.maxCostMicros,
      contextHeadroomTokens: this.contextHeadroomRemaining,
      finalVerificationReserveTokens: this.finalVerificationReserveTokens,
      finalVerificationReserveCostMicros: this.finalVerificationReserveCostMicros,
      evidence: this.evidence,
      lastProgress: this.lastProgress,
    };
  }

  get latestProgress(): OperationProgressAnalysis | null {
    return this.lastProgress;
  }

  /** Whether another provider attempt may start now. */
  canStartStep(): TurnBudgetDecision {
    if (this.cancelled) return { allowed: false, reason: "cancelled" };
    if (this.stepsUsed >= this.maxSteps) {
      return {
        allowed: false,
        reason:
          this.stepsUsed > this.hardMaxSteps
            ? "hard_max_exceeded"
            : "steps_exhausted",
      };
    }
    if (
      this.wallClockMs !== null &&
      this.now() - this.startedAtMs >= this.wallClockMs
    ) {
      return { allowed: false, reason: "wall_clock_exceeded" };
    }
    if (this.maxTokens !== null && this.tokensUsed + this.finalVerificationReserveTokens >= this.maxTokens) {
      return { allowed: false, reason: "token_budget_exhausted" };
    }
    if (this.maxCostMicros !== null && this.costMicros + this.finalVerificationReserveCostMicros >= this.maxCostMicros) {
      return { allowed: false, reason: "cost_budget_exhausted" };
    }
    if (
      this.contextHeadroomRemaining !== null
      && this.contextHeadroomRemaining <= this.finalVerificationReserveTokens
    ) {
      return { allowed: false, reason: "context_headroom_exhausted" };
    }
    if (
      this.minExpectedValue !== null
      && this.evidence.expectedValue !== null
      && this.evidence.expectedValue < this.minExpectedValue
      && this.evidence.outstandingCriteria > 0
    ) {
      return { allowed: false, reason: "expected_value_too_low" };
    }
    return { allowed: true, reason: null };
  }

  /** Whether the current operation stream looks stagnant. */
  isStagnant(): boolean {
    return this.observationHistory.length > 0
      ? this.nonProgressRun >= this.stagnationRepeatLimit
      : this.stagnationRun() >= this.stagnationRepeatLimit;
  }
}

function operationFailureClass(observation: OperationObservation): string | null {
  if (observation.status === "success" || observation.status === "partial") return null;
  return observation.errorClass ?? observation.errorCode ?? observation.status;
}
