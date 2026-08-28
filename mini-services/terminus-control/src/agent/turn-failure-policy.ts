/**
 * What a terminal turn state means for its task (H8).
 *
 * A turn is one attempt. A task is the user's standing request. Flattening
 * "this attempt failed" into "the task failed" is what made every provider
 * hiccup terminate the conversation: the task left ACTIVE, `POST /v1/turns`
 * started returning 409, and the only recovery was creating a new task.
 *
 * Only two things end a task here:
 *   - the user cancelled it (ABORTED);
 *   - a hard budget or policy stop says it cannot continue.
 *
 * Everything else — provider faults, tool errors, ambiguous settlements,
 * verification failures inside the turn — returns the task to the actor with
 * no live turn, so the user can retry, steer, or redirect.
 */

/** Terminal turn states the control plane can settle a turn into. */
export type TerminalTurnState =
  | "ABORTED"
  | "BUDGET_EXHAUSTED"
  | "POLICY_DENIED"
  | "BLOCKED"
  | "USER_ACTION_REQUIRED"
  | "INTERRUPTED"
  | "FAILED";

export interface TurnFailureDisposition {
  /**
   * The status the task must take, or `null` when the task keeps running.
   * `null` is the common case and is not an omission.
   */
  readonly taskStatus:
    | "ABORTED"
    | "BUDGET_EXHAUSTED"
    | "POLICY_DENIED"
    | "BLOCKED"
    | "NEEDS_USER_DECISION"
    | null;
  /** True when `POST /v1/turns` must still be accepted for this task. */
  readonly taskRemainsSteerable: boolean;
  /** Semantic event describing the task-level consequence. */
  readonly taskEventType: "task.failed" | "task.blocked" | "task.turn_failed";
}

/**
 * Task statuses from which `POST /v1/turns` is accepted. Kept next to the
 * disposition so the two can never drift apart.
 */
export const STEERABLE_TASK_STATUSES: readonly string[] = [
  "ACTIVE",
  "NEEDS_USER_DECISION",
  "BLOCKED",
];

export function turnFailureDisposition(
  terminalTurnState: TerminalTurnState,
): TurnFailureDisposition {
  switch (terminalTurnState) {
    case "ABORTED":
      // User-initiated. The task is done because the user said so.
      return { taskStatus: "ABORTED", taskRemainsSteerable: false, taskEventType: "task.failed" };
    case "BUDGET_EXHAUSTED":
      return { taskStatus: "BUDGET_EXHAUSTED", taskRemainsSteerable: false, taskEventType: "task.failed" };
    case "POLICY_DENIED":
      return { taskStatus: "POLICY_DENIED", taskRemainsSteerable: false, taskEventType: "task.failed" };
    case "BLOCKED":
      // The agent needs something it cannot obtain itself; still steerable.
      return { taskStatus: "BLOCKED", taskRemainsSteerable: true, taskEventType: "task.blocked" };
    case "USER_ACTION_REQUIRED":
      return { taskStatus: "NEEDS_USER_DECISION", taskRemainsSteerable: true, taskEventType: "task.blocked" };
    case "INTERRUPTED":
    case "FAILED":
      // The attempt died. The request did not.
      return { taskStatus: null, taskRemainsSteerable: true, taskEventType: "task.turn_failed" };
  }
}

// ─────────────────────── Restart recovery (H5) ──────────────────────────────

/** The reason recorded on every turn orphaned by a control-plane restart. */
export const CONTROL_PLANE_RESTARTED = "control_plane_restarted";

export interface RestartedTurnSettlement {
  readonly turnState: "FAILED";
  readonly code: "CONTROL_PLANE_RESTARTED";
  readonly category: "transport";
  readonly reason: typeof CONTROL_PLANE_RESTARTED;
  readonly message: string;
  readonly retryable: true;
  readonly details: { readonly previous_state: string };
}

/**
 * A turn the control plane was executing when it stopped cannot be resumed:
 * its provider attempt, tool settlements, and context epoch are gone.
 * Re-running the agent loop would duplicate provider spend and re-propose
 * effects, so the turn is settled terminally with an explicit cause.
 */
export function restartedTurnSettlement(previousState: string): RestartedTurnSettlement {
  return {
    turnState: "FAILED",
    code: "CONTROL_PLANE_RESTARTED",
    category: "transport",
    reason: CONTROL_PLANE_RESTARTED,
    message: `The control plane restarted while this turn was ${previousState}. Its provider attempt and tool settlements did not survive; send the request again.`,
    retryable: true,
    details: { previous_state: previousState },
  };
}

export interface RestartedTaskDisposition {
  /** The status to write, or `null` when the row is already correct. */
  readonly nextStatus: "ACTIVE" | null;
  /** Always null after a restart: no turn survives the process. */
  readonly activeTurn: null;
}

/**
 * What a task looks like after restart recovery.
 *
 * - ACTIVE with no live turn (including a task with zero turns, the shape that
 *   made recovery blind) is already correct: it is idle and steerable.
 * - VERIFYING with no live turn cannot advance on its own and is not
 *   steerable, so it returns to ACTIVE.
 * - Anything with a live turn, or already terminal, is left alone.
 */
export function restartedTaskDisposition(input: {
  readonly status: string;
  readonly hasLiveTurn: boolean;
}): RestartedTaskDisposition {
  if (input.hasLiveTurn) return { nextStatus: null, activeTurn: null };
  if (input.status === "VERIFYING") return { nextStatus: "ACTIVE", activeTurn: null };
  return { nextStatus: null, activeTurn: null };
}
