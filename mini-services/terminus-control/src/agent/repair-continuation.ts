import type { TurnRequestBudget } from "./turn-request-budget.js";

/** Durable routing/configuration that a repair continuation must not change. */
export interface RepairContinuationPins {
  readonly selectedModel: string | null;
  readonly selectedReasoningEffort: string | null;
  readonly selectedProviderAccountId: string | null;
  readonly requestedBudgetJson: string | null;
}

export interface RepairParentBudgetLedger {
  readonly stepsUsed: number;
  readonly maxSteps: number;
  readonly tokensUsed: bigint;
  readonly maxTokens: bigint | null;
  readonly costMicros: bigint;
  readonly maxCostMicros: bigint | null;
}

export type RemainingRepairBudget =
  | { readonly kind: "available"; readonly budget: TurnRequestBudget }
  | { readonly kind: "exhausted"; readonly dimension: "steps" | "tokens" | "cost" };

/**
 * A repair is part of the same bounded run. Give it only the unused portion
 * of its parent's effective ledger; never mint a fresh copy of the original
 * ceiling. Because every repair persists this remainder, the calculation is
 * recursive without needing a second task-level accounting authority.
 */
export function remainingRepairBudget(ledger: RepairParentBudgetLedger): RemainingRepairBudget {
  const maxSteps = ledger.maxSteps - ledger.stepsUsed;
  if (maxSteps <= 0) return { kind: "exhausted", dimension: "steps" };

  const maxTokens = ledger.maxTokens === null ? null : ledger.maxTokens - ledger.tokensUsed;
  if (maxTokens !== null && maxTokens <= 0n) return { kind: "exhausted", dimension: "tokens" };

  const maxCostMicros = ledger.maxCostMicros === null
    ? null
    : ledger.maxCostMicros - ledger.costMicros;
  if (maxCostMicros !== null && maxCostMicros <= 0n) {
    return { kind: "exhausted", dimension: "cost" };
  }

  return {
    kind: "available",
    budget: { maxSteps, maxTokens, maxCostMicros },
  };
}

/** Name every changed pin so recovery errors are actionable and fail closed. */
export function repairPinMismatches(
  expected: RepairContinuationPins,
  actual: RepairContinuationPins,
): readonly (keyof RepairContinuationPins)[] {
  return (Object.keys(expected) as Array<keyof RepairContinuationPins>)
    .filter((field) => expected[field] !== actual[field]);
}
