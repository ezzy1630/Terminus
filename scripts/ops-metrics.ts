import type { RepairOutcomeClass } from "@terminus/verification";

export const REPAIR_METRICS_AGGREGATE_SCHEMA_VERSION =
  "terminus.repair-metrics.aggregate.v1" as const;

const OUTCOME_CLASSES = [
  "first_proposal_success",
  "repair_success",
  "failed_verification",
  "blocked",
  "budget_exhausted",
  "user_action_required",
  "aborted",
  "unknown",
] as const satisfies readonly RepairOutcomeClass[];

export interface RepairMetricsAggregateInput {
  readonly firstProposalVerifiedSuccess: boolean | null;
  readonly repairSuccess: boolean | null;
  readonly repairAttemptCount: number;
  readonly repeatedFailure: boolean;
  readonly falsePositiveCompletion: boolean | null;
  readonly outcomeClass: RepairOutcomeClass;
  readonly classificationCorrect: boolean | null;
  readonly usage: {
    readonly additionalInputTokens: string | null;
    readonly additionalOutputTokens: string | null;
    readonly additionalCostMicros: string | null;
    readonly additionalDurationMs: number | null;
  };
}

export interface RepairMetricsAggregate {
  readonly schemaVersion: typeof REPAIR_METRICS_AGGREGATE_SCHEMA_VERSION;
  readonly tasksObserved: number;
  readonly tasksWithRepairs: number;
  readonly repairAttemptCount: number;
  readonly firstProposalVerifiedSuccess: number;
  readonly repairSuccess: number;
  readonly repeatedFailure: number;
  readonly falsePositiveCompletion: number;
  readonly outcomeCounts: Readonly<Record<RepairOutcomeClass, number>>;
  readonly classificationCorrect: number;
  readonly classificationObserved: number;
  readonly usage: {
    readonly additionalInputTokens: string | null;
    readonly additionalOutputTokens: string | null;
    readonly additionalCostMicros: string | null;
    readonly additionalDurationMs: number | null;
  };
  readonly missingUsage: {
    readonly inputTokenTasks: number;
    readonly outputTokenTasks: number;
    readonly costTasks: number;
    readonly durationTasks: number;
  };
}

function emptyOutcomeCounts(): Record<RepairOutcomeClass, number> {
  const counts = {} as Record<RepairOutcomeClass, number>;
  for (const outcome of OUTCOME_CLASSES) counts[outcome] = 0;
  return counts;
}

function addSafe(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} exceeded safe integer range`);
  return result;
}

function decimal(value: string): bigint | null {
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

function sumDecimal(
  inputs: readonly RepairMetricsAggregateInput[],
  select: (input: RepairMetricsAggregateInput) => string | null,
  noRepairValue: string | null,
): { readonly value: string | null; readonly missing: number } {
  let total = 0n;
  let missing = 0;
  for (const input of inputs) {
    if (input.repairAttemptCount === 0) continue;
    const value = select(input);
    if (value === null) {
      missing += 1;
      continue;
    }
    const parsed = decimal(value);
    if (parsed === null) {
      missing += 1;
      continue;
    }
    total += parsed;
  }
  const hasRepairs = inputs.some((input) => input.repairAttemptCount > 0);
  return {
    value: missing > 0 ? null : hasRepairs ? total.toString() : noRepairValue,
    missing,
  };
}

function sumDuration(
  inputs: readonly RepairMetricsAggregateInput[],
  noRepairValue: number | null,
): { readonly value: number | null; readonly missing: number } {
  let total = 0;
  let missing = 0;
  for (const input of inputs) {
    if (input.repairAttemptCount === 0) continue;
    const duration = input.usage.additionalDurationMs;
    if (duration === null || !Number.isSafeInteger(duration) || duration < 0) {
      missing += 1;
      continue;
    }
    total = addSafe(total, duration, "repair duration");
  }
  const hasRepairs = inputs.some((input) => input.repairAttemptCount > 0);
  return {
    value: missing > 0 ? null : hasRepairs ? total : noRepairValue,
    missing,
  };
}

/** Aggregate privacy-safe repair records without I/O or floating-point loss. */
export function aggregateRepairMetrics(
  inputs: readonly RepairMetricsAggregateInput[],
): RepairMetricsAggregate {
  const outcomeCounts = emptyOutcomeCounts();
  let repairAttemptCount = 0;
  let tasksWithRepairs = 0;
  let firstProposalVerifiedSuccess = 0;
  let repairSuccess = 0;
  let repeatedFailure = 0;
  let falsePositiveCompletion = 0;
  let classificationCorrect = 0;
  let classificationObserved = 0;

  for (const input of inputs) {
    repairAttemptCount = addSafe(repairAttemptCount, input.repairAttemptCount, "repair attempt count");
    if (input.repairAttemptCount > 0) tasksWithRepairs += 1;
    if (input.firstProposalVerifiedSuccess === true) firstProposalVerifiedSuccess += 1;
    if (input.repairSuccess === true) repairSuccess += 1;
    if (input.repeatedFailure) repeatedFailure += 1;
    if (input.falsePositiveCompletion === true) falsePositiveCompletion += 1;
    outcomeCounts[input.outcomeClass] += 1;
    if (input.classificationCorrect !== null) {
      classificationObserved += 1;
      if (input.classificationCorrect) classificationCorrect += 1;
    }
  }

  const inputTokens = sumDecimal(
    inputs,
    (input) => input.usage.additionalInputTokens,
    inputs.length === 0 ? null : "0",
  );
  const outputTokens = sumDecimal(
    inputs,
    (input) => input.usage.additionalOutputTokens,
    inputs.length === 0 ? null : "0",
  );
  const costMicros = sumDecimal(
    inputs,
    (input) => input.usage.additionalCostMicros,
    inputs.length === 0 ? null : "0",
  );
  const durationMs = sumDuration(inputs, inputs.length === 0 ? null : 0);

  return {
    schemaVersion: REPAIR_METRICS_AGGREGATE_SCHEMA_VERSION,
    tasksObserved: inputs.length,
    tasksWithRepairs,
    repairAttemptCount,
    firstProposalVerifiedSuccess,
    repairSuccess,
    repeatedFailure,
    falsePositiveCompletion,
    outcomeCounts,
    classificationCorrect,
    classificationObserved,
    usage: {
      additionalInputTokens: inputTokens.value,
      additionalOutputTokens: outputTokens.value,
      additionalCostMicros: costMicros.value,
      additionalDurationMs: durationMs.value,
    },
    missingUsage: {
      inputTokenTasks: inputTokens.missing,
      outputTokenTasks: outputTokens.missing,
      costTasks: costMicros.missing,
      durationTasks: durationMs.missing,
    },
  };
}
