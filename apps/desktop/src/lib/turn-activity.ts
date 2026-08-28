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
import type { Task, TerminusSseEvent } from "../types";

/** Turn events that mean a run is in flight from here on. */
const TURN_RUNNING_EVENTS = new Set([
  "turn.started",
  "turn.context_compiling",
  "turn.tool_settlement",
  "turn.verifying",
  "turn.finalizing",
  "turn.repairing",
  "turn.repair_pending",
  "turn.profile_selected",
]);

/**
 * Turn events that end a run. `turn.blocked` and `turn.needs_user_input` are
 * deliberately here: the agent is not working, it is waiting for the user, and
 * a Stop button that stays lit through that is a lie.
 */
const TURN_SETTLED_EVENTS = new Set([
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
  if (!task) return false;
  const fromEvents = turnActivityFromEvents(events);
  if (fromEvents !== "unknown") return fromEvents === "running";
  return (task.active_turn ?? null) !== null;
}
