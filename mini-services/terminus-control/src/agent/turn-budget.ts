import type { ProviderToolCallChunk } from "@terminus/provider-core";

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
  readonly now?: () => number;
}

export type BudgetStopReason =
  | "steps_exhausted"
  | "hard_max_exceeded"
  | "wall_clock_exceeded"
  | "stagnation_detected"
  | "cancelled";

export interface TurnBudgetDecision {
  readonly allowed: boolean;
  readonly reason: BudgetStopReason | null;
}

interface OperationRecord {
  hash: string;
  mutatesWorkspace: boolean;
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
): ReadonlyArray<ReadonlyArray<ProviderToolCallChunk>> {
  const batches: ProviderToolCallChunk[][] = [];
  let pendingWrites: ProviderToolCallChunk[] = [];
  const flushWrites = (): void => {
    if (pendingWrites.length > 0) {
      // Writes execute one at a time, in provider order.
      for (const write of pendingWrites) batches.push([write]);
      pendingWrites = [];
    }
  };
  for (const call of calls) {
    if (isReadOnly(call)) {
      flushWrites();
      if (
        batches.length === 0 ||
        !batches[batches.length - 1]?.every((c) => isReadOnly(c))
      ) {
        batches.push([call]);
      } else {
        batches[batches.length - 1]!.push(call);
      }
    } else {
      pendingWrites.push(call);
    }
  }
  flushWrites();
  return batches;
}

export class TurnBudget {
  private stepsUsed = 0;
  private readonly operationHistory: OperationRecord[] = [];
  private readonly maxSteps: number;
  private readonly hardMaxSteps: number;
  private readonly startedAtMs: number;
  private readonly wallClockMs: number | null;
  private readonly stagnationRepeatLimit: number;
  private readonly now: () => number;
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
    this.stagnationRepeatLimit = options.stagnationRepeatLimit ?? 2;
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

  /** Most repeated consecutive read-only operation count. */
  stagnationRun(): number {
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
    return { allowed: true, reason: null };
  }

  /** Whether the current operation stream looks stagnant. */
  isStagnant(): boolean {
    return this.stagnationRun() >= this.stagnationRepeatLimit;
  }
}
