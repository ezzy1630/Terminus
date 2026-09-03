export const REPAIR_ATTEMPT_TERMINAL_STATES = [
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "ABORTED",
  "SUPERSEDED",
] as const;

export const REPAIR_ATTEMPT_ACTIVE_STATES = ["PENDING", "ADMITTED", "RUNNING"] as const;

export type RepairAttemptTerminalState = (typeof REPAIR_ATTEMPT_TERMINAL_STATES)[number];

export interface RepairLeaseSnapshot {
  readonly ownerInstance: string;
  readonly fencingToken: number;
  readonly expiresAt: Date;
}

export type RepairAttemptClaimDecision =
  | { readonly claimable: true; readonly fencingToken: number }
  | {
      readonly claimable: false;
      readonly reason:
        | "terminal"
        | "missing_continuation"
        | "lease_held"
        | "lease_held_by_current_owner";
    };

export const repairAttemptLeaseKey = (attemptId: string): string =>
  `terminus-repair-attempt:${attemptId}`;

export const isRepairAttemptTerminal = (state: string): state is RepairAttemptTerminalState =>
  REPAIR_ATTEMPT_TERMINAL_STATES.includes(state as RepairAttemptTerminalState);

export const isRepairAttemptActive = (state: string): boolean =>
  REPAIR_ATTEMPT_ACTIVE_STATES.includes(state as (typeof REPAIR_ATTEMPT_ACTIVE_STATES)[number]);

export const shouldDeferRepairParentRecovery = (input: {
  readonly turnState: string;
  readonly hasActiveAttempt: boolean;
  readonly hasContinuation: boolean;
}): boolean => input.turnState === "VERIFYING" && input.hasActiveAttempt && !input.hasContinuation;

/**
 * Decide whether a persisted repair continuation may be claimed. A live lease
 * always wins, including one owned by this process: that prevents a duplicate
 * scheduler pass from starting a second agent loop before the in-process run
 * registry has been updated.
 */
export const decideRepairAttemptClaim = (input: {
  readonly state: string;
  readonly repairTurnId: string | null;
  readonly lease: RepairLeaseSnapshot | null;
  readonly ownerInstance: string;
  readonly now: Date;
}): RepairAttemptClaimDecision => {
  if (isRepairAttemptTerminal(input.state)) return { claimable: false, reason: "terminal" };
  if (input.repairTurnId === null) {
    return { claimable: false, reason: "missing_continuation" };
  }
  if (input.lease !== null && input.lease.expiresAt > input.now) {
    return {
      claimable: false,
      reason: input.lease.ownerInstance === input.ownerInstance
        ? "lease_held_by_current_owner"
        : "lease_held",
    };
  }
  return {
    claimable: true,
    fencingToken: (input.lease?.fencingToken ?? 0) + 1,
  };
};

export const repairAttemptStateForTurn = (input: {
  readonly turnState: string;
  readonly taskStatus: string | null;
  readonly hasSuccess: boolean;
  readonly hasNextAttempt: boolean;
}): { readonly state: RepairAttemptTerminalState; readonly reason: string } => {
  if (input.hasSuccess || input.turnState === "COMPLETED" || input.taskStatus === "COMPLETED") {
    return { state: "SUCCEEDED", reason: "repair_turn_completed" };
  }
  if (input.hasNextAttempt) {
    return { state: "SUPERSEDED", reason: "superseded_by_next_repair_attempt" };
  }
  if (input.taskStatus === "BLOCKED" || input.turnState === "BLOCKED") {
    return { state: "BLOCKED", reason: "repair_turn_blocked" };
  }
  if (input.taskStatus === "ABORTED" || input.turnState === "ABORTED") {
    return { state: "ABORTED", reason: "repair_turn_aborted" };
  }
  return { state: "FAILED", reason: "repair_turn_terminal_without_completion" };
};
