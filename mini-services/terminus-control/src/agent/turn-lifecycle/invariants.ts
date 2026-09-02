/**
 * Invariant enforcement for the deterministic turn lifecycle.
 *
 * Each invariant is a pure predicate over the reduced state plus the durable
 * event history that produced it. The executor runs every check after each
 * applied event; a violation fails the schedule that produced it instead of
 * hiding until an assembled test or production incident surfaces it.
 */

import {
  isTerminalPhase,
  recoverableCommands,
  type LifecycleEvent,
  type LifecycleState,
  LIVENESS_CRITICAL_PHASES,
} from "./model.js";

export interface InvariantViolation {
  readonly invariant: string;
  readonly detail: string;
}

export type InvariantCheck = (
  state: LifecycleState,
  events: readonly LifecycleEvent[],
) => InvariantViolation | null;

/** At most one active provider attempt per accepted turn. */
export const atMostOneActiveAttempt: InvariantCheck = (state) => {
  if (state.activeAttemptId === null) {
    const unsettled = state.attempts.filter((attempt) => !attempt.settled);
    // A terminal turn legitimately carries unsettled attempt rows: the
    // terminal record is the explicit recovery outcome for them.
    if (unsettled.length > 0 && !isTerminalPhase(state.phase)) {
      return {
        invariant: "at_most_one_active_attempt",
        detail: `no active attempt but unsettled attempt rows remain: ${unsettled.map((attempt) => attempt.attemptId).join(",")}`,
      };
    }
    return null;
  }
  const duplicates = state.attempts.filter(
    (attempt) => attempt.attemptId === state.activeAttemptId && attempt.settled,
  );
  if (duplicates.length > 0) {
    return {
      invariant: "at_most_one_active_attempt",
      detail: `attempt ${state.activeAttemptId} is both active and settled`,
    };
  }
  return null;
};

/** Every accepted provider result is settled or explicitly recoverable. */
export const acceptedResultsRecoverable: InvariantCheck = (state) => {
  const accepted = state.attempts.length;
  const settled = state.attempts.filter((attempt) => attempt.settled).length;
  if (accepted === settled) return null;
  // A terminal turn settles every obligation through its terminal record.
  if (isTerminalPhase(state.phase)) return null;
  // An explicit waiting reason (writer lease) is itself the recovery record:
  // restoration re-derives the settle command.
  if (state.waitReason !== null) return null;
  // An unsettled attempt is recoverable while the model can derive the
  // durable work that will settle it (re-delivery of the outcome).
  if (recoverableCommands(state).length > 0) return null;
  return {
    invariant: "accepted_results_recoverable",
    detail: `attempt count ${accepted} settled count ${settled} in phase ${state.phase} without a derivable recovery command`,
  };
};

/** Every authorized tool call gets exactly one logical settlement. */
export const exactlyOneSettlementPerToolCall: InvariantCheck = (state) => {
  const ids = state.toolCalls.map((call) => call.toolCallId);
  if (new Set(ids).size !== ids.length) {
    return {
      invariant: "exactly_one_settlement_per_tool_call",
      detail: `duplicate tool call ids authorized: ${ids.join(",")}`,
    };
  }
  return null;
};

/** Mutating tool settlement records a workspace revision. */
export const mutatingSettlementRecordsRevision: InvariantCheck = (state) => {
  for (const call of state.toolCalls) {
    if (call.settlement === undefined) continue;
    if (call.settlement.mutatesWorkspace && call.settlement.workspaceRevision === null) {
      return {
        invariant: "mutating_settlement_records_revision",
        detail: `mutating settlement of ${call.toolCallId} has no workspace revision`,
      };
    }
  }
  return null;
};

/** Every durable transition is justified by an event, never an in-memory callback. */
// skipcq: JS-R1005, JS-0067
export const transitionsAreEventSourced: InvariantCheck = (state, events) => {
  if (events.length === 0) return null;
  const last = events[events.length - 1]!;
  const justified = state.phase !== "ADMITTED";
  if (!justified) return null;
  if (isTerminalPhase(state.phase) && state.terminalReason === null) {
    return {
      invariant: "transitions_are_event_sourced",
      detail: `terminal phase ${state.phase} has no recorded reason`,
    };
  }
  if (last.turnId !== state.turnId) {
    return {
      invariant: "transitions_are_event_sourced",
      detail: `latest event belongs to turn ${last.turnId}, state belongs to ${state.turnId}`,
    };
  }
  return null;
};

/**
 * Active states always expose a recoverable pending command, a deadline, or
 * an explicit waiting reason.
 */
// skipcq: JS-R1005, JS-0067
export const activeStatesAreRecoverable: InvariantCheck = (state) => {
  if (isTerminalPhase(state.phase)) return null;
  if (
    state.pendingCommand !== null
    || state.deadline !== null
    || state.waitReason !== null
    || recoverableCommands(state).length > 0
  ) {
    return null;
  }
  return {
    invariant: "active_states_are_recoverable",
    detail: `phase ${state.phase} exposes no pending command, deadline, or waiting reason`,
  };
};

/** Accepted observations cannot disappear from the next provider context. */
export const observationsNeverRegress: InvariantCheck = (state, events) => {
  // Count one observation per distinct settled attempt: a re-delivered
  // settlement must not inflate the accepted set.
  const attemptsWithObservation = new Set<string>();
  for (const event of events) {
    if (event.type === "ProviderAttemptSettled" && event.observation !== null) {
      attemptsWithObservation.add(event.attemptId);
    }
  }
  const accepted = attemptsWithObservation.size;
  if (state.observationsThrough + state.pendingObservations.length < accepted) {
    return {
      invariant: "observations_never_regress",
      detail: `accepted observations ${accepted} exceed compiled ${state.observationsThrough} + pending ${state.pendingObservations.length}`,
    };
  }
  return null;
};

/** Context generations advance monotonically. */
export const generationsMonotonic: InvariantCheck = (_state, events) => {
  let previous = -1;
  for (const event of events) {
    if (event.type !== "ContextCompiled") continue;
    if (event.generation === previous) continue;
    if (event.generation < previous) {
      return {
        invariant: "generations_monotonic",
        detail: `generation ${event.generation} does not advance beyond ${previous}`,
      };
    }
    previous = event.generation;
  }
  return null;
};

/**
 * Liveness: no valid schedule can leave the turn permanently in one of the
 * critical phases. Checked by the permutation harness, which proves that a
 * RecoveryRequested event always derives a re-driving command for each.
 */
export const criticalPhasesAlwaysRecoverable: InvariantCheck = (state) => {
  if (!(LIVENESS_CRITICAL_PHASES as readonly string[]).includes(state.phase)) return null;
  if (state.waitReason === "writer_lease_lost") return null;
  if (state.pendingCommand !== null || recoverableCommands(state).length > 0) return null;
  return {
    invariant: "critical_phases_always_recoverable",
    detail: `turn is in ${state.phase} with no pending command and no waiting reason`,
  };
};

export const LIFECYCLE_INVARIANTS: readonly InvariantCheck[] = [
  atMostOneActiveAttempt,
  acceptedResultsRecoverable,
  exactlyOneSettlementPerToolCall,
  mutatingSettlementRecordsRevision,
  transitionsAreEventSourced,
  activeStatesAreRecoverable,
  observationsNeverRegress,
  generationsMonotonic,
  criticalPhasesAlwaysRecoverable,
];

/** Run every invariant; return the first violation, if any. */
export const checkInvariants = (
  state: LifecycleState,
  events: readonly LifecycleEvent[],
): InvariantViolation | null => {
  for (const check of LIFECYCLE_INVARIANTS) {
    const violation = check(state, events);
    if (violation !== null) return violation;
  }
  return null;
};
