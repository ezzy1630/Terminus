/**
 * Is a turn running right now?
 *
 * Two sources answer this and neither is sufficient alone:
 *
 *   - The task snapshot's `active_turn` is authoritative and survives a
 *     reload, but it is only as fresh as the last `GET /v1/tasks/:id`.
 *   - The event stream is live to the millisecond, but a task opened from the
 *     sidebar has no events until something happens.
 *
 * So the stream wins when it has said anything about a turn, and the snapshot
 * answers otherwise. This matters because three controls read it: Stop is
 * offered only while a run is in flight, the composer queues instead of
 * sending while one is (the control plane rejects a second concurrent turn
 * with `TASK_TURN_ALREADY_ACTIVE`), and the activity indicator claims work is
 * happening.
 */
import { lifecycleFromTask, type TaskLifecycle } from "./task-lifecycle";
import type { Task, TerminusSseEvent } from "../types";

/** Turn events that mean a run is in flight from here on. */
const TURN_RUNNING_EVENTS = new Set([
  "turn.started",
  "turn.context_compiling",
  // The provider is streaming its reply right now. This is the loudest
  // possible evidence that a run is in flight, and it was the one event the
  // client did not read.
  "turn.provider_text_delta",
  "turn.tool_settlement",
  "turn.verifying",
  "turn.finalizing",
  "turn.repairing",
  "turn.repair_pending",
  "turn.profile_selected",
  "turn.steering_queued",
  "turn.output_truncated",
  "turn.recovery_reconciled",
]);

/**
 * Turn events that end a run. `turn.blocked` and `turn.needs_user_input` are
 * deliberately here: the agent is not working, it is waiting for the user, and
 * a Stop button that stays lit through that is a lie.
 */
export const TURN_SETTLED_EVENTS = new Set([
  "turn.completed",
  "turn.aborted",
  "turn.failed",
  "turn.interrupted",
  "turn.superseded",
  "turn.blocked",
  "turn.needs_user_input",
  "turn.budget_exhausted",
  "turn.policy_denied",
  "turn.recovery_failed",
  "turn.recovery_interrupted",
  /*
   * A turn failed and the task stayed ACTIVE.
   *
   * Emitted at task level, so it does not appear in the turn-event vocabulary
   * above — but it is exactly as much an end of the run, and treating it as
   * anything else leaves a spinner on a task the operator can already steer.
   */
  "task.turn_failed",
]);

/**
 * Task events that end every run underneath them, whatever the last turn event
 * said. A cancelled task has no in-flight turn even if its last turn event was
 * `turn.started` and the abort event was dropped from the presentation window.
 */
const TASK_SETTLED_EVENTS = new Set([
  "task.aborted",
  "task.cancelled",
  "task.failed",
]);

export type TurnActivity = "running" | "settled" | "unknown";

/** What the event tail says, ignoring the snapshot. Exported for tests. */
export function turnActivityFromEvents(events: readonly TerminusSseEvent[]): TurnActivity {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.event ?? "";
    if (TASK_SETTLED_EVENTS.has(type)) return "settled";
    if (TURN_SETTLED_EVENTS.has(type)) return "settled";
    if (TURN_RUNNING_EVENTS.has(type)) return "running";
  }
  return "unknown";
}

/**
 * Whether a run is in flight for `task`, given everything currently known.
 * A task with no events and no reported `active_turn` reads as not running,
 * which is the safe default: it offers no Stop and queues nothing.
 */
export function taskRunIsActive(
  task: Task | null | undefined,
  events: readonly TerminusSseEvent[],
): boolean {
  return taskRunIsActiveWith(task, turnActivityFromEvents(events));
}

/**
 * The same question, answered from an already-computed activity.
 *
 * The sidebar, the board and the Dock badge each ask about every loaded task.
 * Re-scanning every task's event tail on every 50 ms SSE batch would make an
 * incidental token re-rank the whole navigation tree, so the store keeps one
 * `TurnActivity` per task (`runActivityByTask`) that only changes when the
 * answer does, and those surfaces pass it in here.
 */
export function taskRunIsActiveWith(
  task: Task | null | undefined,
  activity: TurnActivity,
): boolean {
  if (!task) return false;
  if (activity !== "unknown") return activity === "running";
  return (task.active_turn ?? null) !== null;
}

/**
 * What a task should *say* it is doing.
 *
 * The stored status cannot answer this. `ACTIVE` is the control plane's steady
 * state — it is what a task is between turns, not only during one — so reading
 * it literally made every task in the sidebar, the title bar, the board and the
 * Dock claim to be working, complete with a spinner, forever. The only thing
 * that knows whether work is happening is the run itself, which is exactly what
 * `taskRunIsActive` answers.
 *
 * Every surface that renders a task's state goes through here. `lifecycleFromTask`
 * remains the right call only where the stored status is the subject (an audit
 * view, a status filter over the domain enum).
 */
export function displayLifecycle(
  task: Task | null | undefined,
  events: readonly TerminusSseEvent[],
): TaskLifecycle {
  return displayLifecycleWith(task, turnActivityFromEvents(events));
}

/** `displayLifecycle` against an already-computed activity. See `taskRunIsActiveWith`. */
export function displayLifecycleWith(
  task: Task | null | undefined,
  activity: TurnActivity,
): TaskLifecycle {
  const stored = lifecycleFromTask(task);
  // Only the two "the agent is moving on its own" states can be wrong this way.
  // needs_you, review, failed and the terminal states are claims about the task,
  // not about a turn, and stand whether or not one is in flight.
  if (stored !== "working" && stored !== "planning") return stored;
  return taskRunIsActiveWith(task, activity) ? stored : "idle";
}

/**
 * Turn events the conversation reducer deliberately does not render, and why.
 *
 * Every `turn.*` event the control plane emits must either have a case in
 * `decodeFeed` or appear here — `tests/client-projection-parity.test.ts`
 * enforces that against the control plane's own source, so a new event type
 * cannot be silently dropped on the floor the way `turn.provider_text_delta`
 * was.
 */
export const IGNORED_TURN_EVENTS: Readonly<Record<string, string>> = {
  "turn.observed_sources_seeded": "Internal stale-write protection restored observations from durable history. It changes no user-visible task state or transcript content.",
  "turn.recovery_reconciled": "Internal state repair after an interruption. The turn resumes from the phase it was already in, so the feed has nothing new to say.",
  "turn.verification_not_applicable": "A turn that mutated nothing has nothing to verify. Reporting the absence of a check nobody asked for is noise; the reply itself is the outcome.",
};
