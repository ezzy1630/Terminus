/**
 * Provider-neutral, replayable metrics for the bounded verification-repair
 * loop. This module only reduces durable facts; it performs no I/O and never
 * invents usage or cost when the provider did not record them.
 */

export const REPAIR_METRICS_SCHEMA_VERSION = "terminus.repair-metrics.v1" as const;

export type RepairOutcomeClass =
  | "first_proposal_success"
  | "repair_success"
  | "failed_verification"
  | "blocked"
  | "budget_exhausted"
  | "user_action_required"
  | "aborted"
  | "unknown";

export interface RepairAttemptMetricInput {
  readonly attemptNumber: number;
  readonly state: string;
  readonly failureSignatures: readonly string[];
  readonly terminalReason: string | null;
}

export interface RepairProviderAttemptMetricInput {
  /** Decimal string from the provider-attempt usage record, if observed. */
  readonly inputTokens: string | null;
  /** Decimal string from the provider-attempt usage record, if observed. */
  readonly outputTokens: string | null;
  /** Decimal micros from a trusted provider cost record, if observed. */
  readonly costMicros: string | null;
}

export interface RepairTurnMetricInput {
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
}

export interface RepairMetricsInput {
  readonly taskStatus: string;
  /** The normalized task terminal reason, not a raw error or prompt. */
  readonly terminalReason: string | null;
  /** True only after the durable completion admission transaction commits. */
  readonly completionAdmissionCommitted: boolean;
  /** Result of the final required-predicate evaluation, when observed. */
  readonly finalRequiredPredicatesPassed: boolean | null;
  readonly repairAttempts: readonly RepairAttemptMetricInput[];
  /** Provider attempts belonging to admitted repair turns only. */
  readonly repairProviderAttempts: readonly RepairProviderAttemptMetricInput[];
  /** Whole-turn wall-clock durations, including tool and context overhead. */
  readonly repairTurns: readonly RepairTurnMetricInput[];
  /** Optional evaluator label used to measure classification accuracy. */
  readonly expectedOutcomeClass?: RepairOutcomeClass | null;
}

export interface RepairUsageDelta {
  /** Null means at least one required provider usage value was unavailable. */
  readonly additionalInputTokens: string | null;
  /** Null means at least one required provider usage value was unavailable. */
  readonly additionalOutputTokens: string | null;
  /** Null means no trusted cost record was available for a repair attempt. */
  readonly additionalCostMicros: string | null;
  /** Null means at least one repair provider duration was unavailable. */
  readonly additionalDurationMs: number | null;
}

export interface RepairMetricsRecord {
  readonly schemaVersion: typeof REPAIR_METRICS_SCHEMA_VERSION;
  readonly firstProposalVerifiedSuccess: boolean | null;
  readonly repairSuccess: boolean | null;
  readonly repairAttemptCount: number;
  readonly repeatedFailure: boolean;
  readonly repeatedFailureCount: number;
  readonly falsePositiveCompletion: boolean | null;
  readonly outcomeClass: RepairOutcomeClass;
  readonly stopReason: string | null;
  readonly classificationCorrect: boolean | null;
  readonly usage: RepairUsageDelta;
}

const COMPLETED_STATUSES = new Set(["COMPLETED"]);

function normalizedSet(signatures: readonly string[]): string {
  return JSON.stringify([...new Set(signatures)].sort());
}

function repeatedFailureCount(
  attempts: readonly RepairAttemptMetricInput[],
  terminalReason: string | null,
): number {
  const seen = new Set<string>();
  let repeated = terminalReason === "no_progress_repeated_failure" ? 1 : 0;
  for (const attempt of attempts) {
    const signatureSet = normalizedSet(attempt.failureSignatures);
    if (signatureSet === "[]") continue;
    if (seen.has(signatureSet)) repeated += 1;
    seen.add(signatureSet);
  }
  return repeated;
}

function outcomeClass(input: RepairMetricsInput): RepairOutcomeClass {
  if (COMPLETED_STATUSES.has(input.taskStatus)) {
    if (input.completionAdmissionCommitted && input.finalRequiredPredicatesPassed === true) {
      return input.repairAttempts.length > 0 ? "repair_success" : "first_proposal_success";
    }
    return "unknown";
  }
  if (input.terminalReason === "repair_budget_exhausted") return "budget_exhausted";
  if (input.terminalReason === "requires_user_authority") return "user_action_required";
  if (input.taskStatus === "ABORTED" || input.terminalReason === "repair_parent_aborted") return "aborted";
  if (input.taskStatus === "BLOCKED") return "blocked";
  if (input.taskStatus === "FAILED_VERIFICATION") return "failed_verification";
  return "unknown";
}

function decimal(value: string | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function sumDecimals(
  values: readonly (string | null)[],
  noValues: string | null,
): string | null {
  if (values.length === 0) return noValues;
  let total = 0n;
  for (const value of values) {
    const parsed = decimal(value);
    if (parsed === null) return null;
    total += parsed;
  }
  return total.toString();
}

function durationMs(
  turns: readonly RepairTurnMetricInput[],
  noValues: number | null,
): number | null {
  if (turns.length === 0) return noValues;
  let total = 0;
  for (const turn of turns) {
    if (turn.startedAtMs === null || turn.completedAtMs === null) return null;
    const duration = turn.completedAtMs - turn.startedAtMs;
    if (!Number.isSafeInteger(duration) || duration < 0) return null;
    total += duration;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function usageDelta(input: RepairMetricsInput): RepairUsageDelta {
  const noRepairValues = input.repairAttempts.length === 0;
  return {
    additionalInputTokens: sumDecimals(
      input.repairProviderAttempts.map((attempt) => attempt.inputTokens),
      noRepairValues ? "0" : null,
    ),
    additionalOutputTokens: sumDecimals(
      input.repairProviderAttempts.map((attempt) => attempt.outputTokens),
      noRepairValues ? "0" : null,
    ),
    additionalCostMicros: sumDecimals(
      input.repairProviderAttempts.map((attempt) => attempt.costMicros),
      noRepairValues ? "0" : null,
    ),
    additionalDurationMs: durationMs(input.repairTurns, noRepairValues ? 0 : null),
  };
}

/** Derive one privacy-safe metric record from durable repair facts. */
export function deriveRepairMetrics(input: RepairMetricsInput): RepairMetricsRecord {
  const outcome = outcomeClass(input);
  const repeatedCount = repeatedFailureCount(input.repairAttempts, input.terminalReason);
  const firstProposalVerifiedSuccess = input.finalRequiredPredicatesPassed === null
    ? null
    : input.repairAttempts.length === 0 && input.finalRequiredPredicatesPassed;
  const repairSuccess = input.finalRequiredPredicatesPassed === null
    ? null
    : input.repairAttempts.length > 0
      && input.completionAdmissionCommitted
      && input.finalRequiredPredicatesPassed;
  const falsePositiveCompletion = input.completionAdmissionCommitted
    ? input.finalRequiredPredicatesPassed === null ? null : !input.finalRequiredPredicatesPassed
    : false;
  const expected = input.expectedOutcomeClass ?? null;
  return {
    schemaVersion: REPAIR_METRICS_SCHEMA_VERSION,
    firstProposalVerifiedSuccess,
    repairSuccess,
    repairAttemptCount: input.repairAttempts.length,
    repeatedFailure: repeatedCount > 0,
    repeatedFailureCount: repeatedCount,
    falsePositiveCompletion,
    outcomeClass: outcome,
    stopReason: input.terminalReason,
    classificationCorrect: expected === null || outcome === "unknown" ? null : outcome === expected,
    usage: usageDelta(input),
  };
}
