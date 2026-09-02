/**
 * Convergent failure settlement for active agent turns.
 *
 * Reference-loop contract: every accepted turn settles terminally, or — when
 * the settlement write itself cannot be proven — leaves a durable
 * recovery record so a later pass converges the turn. Nothing may rethrow a
 * settlement fault out of `agentLoop`, because the only trap around that
 * promise logs and discards it, stranding an active turn in
 * CONTEXT_COMPILING until a restart.
 *
 * Pure module: no I/O, no provider coupling. The composition root supplies
 * the row readers/writers and emits the semantic events.
 */

/** Non-terminal turn states the failure path can be entered from. */
export const ACTIVE_TURN_STATES = [
  "PENDING",
  "CONTEXT_COMPILING",
  "PROVIDER_RUNNING",
  "RESPONSE_VALIDATING",
  "TOOL_SETTLEMENT",
  "VERIFYING",
  "REPAIRING",
  "FINALIZING",
  "REPAIR_PENDING",
  "VERIFIED",
] as const;

export type ActiveTurnState = (typeof ACTIVE_TURN_STATES)[number];

/** The durable recovery marker left when settlement cannot be proven. */
export interface TurnRecoveryMarker {
  readonly reason: "failure_settlement_unproven";
  readonly code: string;
  readonly previous_state: string;
  readonly recovery: "settle_or_retry";
  readonly retryable: true;
  readonly details: string | null;
}

/**
 * Decide the settlement update for one terminal attempt.
 *
 * CAS semantics: the update applies only when the row is still in the exact
 * state the settlement decision was made from. A count of 0 is a lost race
 * (interrupt/abort/recovery won), never a success signal.
 */
export function terminalSettlementUpdate(input: {
  readonly expectedState: string;
  readonly terminalState: string;
  readonly terminalErrorJson: string;
}): {
  readonly whereState: string;
  readonly data: { readonly terminalState: string; readonly terminalErrorJson: string };
} {
  return {
    whereState: input.expectedState,
    data: {
      terminalState: input.terminalState,
      terminalErrorJson: input.terminalErrorJson,
    },
  };
}

/**
 * Interpret the outcome of the terminal CAS write.
 *
 * - `count === 1`: the write won; the turn is settled.
 * - `count === 0`: someone else moved the row. That is convergence, not
 *   failure — the winner settled the turn.
 */
export function interpretTerminalCas(count: number): "won" | "lost_race_converged" {
  return count === 1 ? "won" : "lost_race_converged";
}

/**
 * Interpret the outcome of the idempotent recovery-marker write.
 *
 * The marker is keyed to the exact previous state, so two racing writers can
 * both "win" the same idempotent insert shape; anything but exactly one row
 * is reported for an explicit durable reconciliation event.
 */
export function interpretRecoveryMarkerWrite(
  count: number,
): "recorded" | "already_recorded" | "needs_durable_reconciliation" {
  if (count === 1) return "recorded";
  if (count === 0) return "already_recorded";
  return "needs_durable_reconciliation";
}

/**
 * Whether a settlement fault leaves the loop provably unable to record the
 * turn's outcome. When the fault is the fenced writer lease the whole
 * process is being terminated anyway; anything else must produce a durable
 * recovery record inside the same catch block.
 */
export function settlementFaultIsTerminalProcessFault(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "ControlWriterFencedError";
}

export interface RecoveryPlan {
  readonly marker: TurnRecoveryMarker;
  readonly rethrow: false;
}

/**
 * The catch-block plan: never rethrow; record recovery.
 */
export function planRecoveryAfterSettlementFault(input: {
  readonly previousState: string;
  readonly code: string;
  readonly details: string | null;
}): RecoveryPlan {
  return {
    marker: {
      reason: "failure_settlement_unproven",
      code: input.code,
      previous_state: input.previousState,
      recovery: "settle_or_retry",
      retryable: true,
      details: input.details,
    },
    rethrow: false,
  };
}
