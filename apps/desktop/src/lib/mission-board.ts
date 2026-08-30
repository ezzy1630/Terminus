/**
 * Board projection.
 *
 * Every status question here now delegates to `lib/task-lifecycle.ts`. The
 * board used to own a second status vocabulary, which is how a freshly created
 * task could sit under "Running" on this surface while the sidebar called the
 * same task "Queued": `DRAFT` and `READY` were both mapped into the running
 * column. Columns are derived from the lifecycle so that cannot recur.
 */
import {
  BOARD_COLUMNS,
  boardColumnForLifecycle,
  lifecycleFromV2Status,
  lifecycleIsActive,
  lifecycleLabel,
  type BoardColumnId,
  type TaskLifecycle,
} from "./task-lifecycle";
import { primaryBudgetMetric, type BudgetTone } from "./task-budget";
import { compactDuration } from "./time";
import { displayLifecycleWith, type TurnActivity } from "./turn-activity";
import type { Task } from "../types";
import type { TaskV2Snapshot, TaskV2Status } from "../types/v2";

export const MISSION_BOARD_COLUMNS = BOARD_COLUMNS;

export type MissionBoardColumnId = BoardColumnId;

/**
 * Retained as a name because the board renders it, but there is no longer an
 * off-board placement: work that used to fall into a hidden "closed" bucket
 * (CANCELLED, PARTIAL) now lands in Done and Review respectively, where a
 * human can still see it.
 */
export type MissionBoardPlacement = MissionBoardColumnId;

export function boardColumnForStatus(status: TaskV2Status): MissionBoardPlacement {
  return boardColumnForLifecycle(lifecycleFromV2Status(status));
}

/**
 * What a board card should say a task is doing.
 *
 * The v2 snapshot has no notion of a turn, so `RUNNING` is what it reports for
 * as long as the task is alive — every card on the board claimed to be working.
 * The v1 record and its event tail know whether a run is actually in flight, so
 * they win when the task is loaded; the v2 status is the fallback for a task the
 * v1 store has not seen.
 */
export function boardLifecycle(
  task: TaskV2Snapshot,
  domainTask: Task | undefined,
  activity: TurnActivity,
): TaskLifecycle {
  if (domainTask !== undefined) return displayLifecycleWith(domainTask, activity);
  // V2 RUNNING means the durable task is active, not that a turn is currently
  // executing. Without the v1 turn record, idle is the only honest projection.
  return task.status === "RUNNING" ? "idle" : lifecycleFromV2Status(task.status);
}

export function boardColumnForTaskLifecycle(lifecycle: TaskLifecycle): MissionBoardPlacement {
  return boardColumnForLifecycle(lifecycle);
}

/**
 * Where a card actually sits.
 *
 * A pending material question outranks the lifecycle. The agent may well still
 * be running — it usually is, that is why it stopped to ask — but the thing a
 * human owes is already on the table, and a board whose Needs you column is
 * not the complete list of what needs the human has given up the one job the
 * column exists to do.
 *
 * `needsYou` is `attentionReason(...) !== null` and nothing else, so the
 * column, the header count, the attention filter and the sidebar queue are the
 * same predicate rather than four that agree by convention. Terminal work is
 * exempt there rather than here: a stale question against a task that already
 * finished must not drag it back out of Done.
 */
export function boardColumnForTaskPlacement(
  lifecycle: TaskLifecycle,
  needsYou: boolean,
): MissionBoardPlacement {
  if (needsYou) return "needs_you";
  return boardColumnForLifecycle(lifecycle);
}

/**
 * Board columns are a projection. A drop may only request a transition the
 * canonical V2 state machine already admits.
 *
 * Only Working accepts drops, because it is the only column a human can move a
 * task into by deciding to. The others are observations:
 *
 * - `queued` — DRAFT and READY share it, so a drop moves nothing.
 * - `needs_you` — attention is observed, never assigned.
 * - `review` — reached by the agent finishing verification. There is no
 *   transition that means "a human should read this now"; the nearest status,
 *   VERIFYING, is unattended agent work and lands back in Working, so offering
 *   the drop would bounce the card straight out of the column it was dropped in.
 * - `done` — completion requires admitted evidence.
 */
export function boardTransitionForDrop(
  status: TaskV2Status,
  destination: MissionBoardColumnId,
): TaskV2Status | null {
  if (destination !== "working") return null;
  if (status === "READY" || status === "VERIFYING" || status === "PAUSED" || status === "BLOCKED") {
    return "RUNNING";
  }
  return null;
}

export function taskStatusLabel(status: TaskV2Status): string {
  return lifecycleLabel(lifecycleFromV2Status(status));
}

// ─────────────────────────── Why it needs you ──────────────────────────────

/**
 * The board no longer owns an attention vocabulary. `lib/attention.ts` is the
 * single definition every surface reads — the rail's queue, the Dock badge,
 * the notifications and this column — so the number in the header and the
 * number in the sidebar cannot describe two different sets of tasks.
 *
 * Re-exported rather than re-imported at each call site because the board
 * already imports from here, and one module boundary is easier to keep honest
 * than eleven import lines.
 */
export {
  attentionReason,
  attentionTone,
  pendingQuestionFor,
  type AttentionKind,
  type AttentionReason,
} from "./attention";

// ──────────────────────────── Card evidence ────────────────────────────────

/**
 * The runtime facts a card can state on its own authority.
 *
 * Both come from the v1 detail route, which the sidebar and the task surface
 * populate as tasks are opened — the list route omits them. A field the client
 * has not been told stays null and is not rendered, rather than being shown as
 * a zero: a card claiming "$0.00" on a task whose ledger simply has not loaded
 * would be the board asserting something it does not know.
 */
export interface TaskEvidence {
  /** How long the in-flight run has been going. Null when nothing is running. */
  elapsed: string | null;
  /** The one budget number worth a card's width, and how pressing it is. */
  budget: { value: string; tone: BudgetTone } | null;
}

export function taskEvidence(
  domainTask: Task | undefined,
  lifecycle: TaskLifecycle,
  nowMs: number,
): TaskEvidence {
  const startedAt = domainTask?.active_turn?.started_at ?? null;
  const elapsed = lifecycleIsActive(lifecycle) && startedAt !== null
    ? compactDuration(startedAt, nowMs)
    : null;
  const metric = primaryBudgetMetric(domainTask?.budget_ledger);
  return {
    elapsed,
    // A metric that is neither pressing nor spent says nothing a person acts
    // on, so a task that has burned no cost yet stays silent.
    budget: metric === null || metric.value === "$0.00" ? null : { value: metric.value, tone: metric.tone },
  };
}

export function directTaskActions(task: TaskV2Snapshot): ReadonlyArray<{
  label: string;
  targetStatus: TaskV2Status;
  destructive?: boolean;
}> {
  switch (task.status) {
    case "DRAFT":
      return [
        { label: "Move to Ready", targetStatus: "READY" },
        { label: "Cancel", targetStatus: "CANCELLED", destructive: true },
      ];
    case "READY":
      return [
        { label: "Start", targetStatus: "RUNNING" },
        { label: "Cancel", targetStatus: "CANCELLED", destructive: true },
      ];
    case "RUNNING":
      return [
        { label: "Pause", targetStatus: "PAUSED" },
        { label: "Verify now", targetStatus: "VERIFYING" },
        { label: "Cancel", targetStatus: "CANCELLED", destructive: true },
      ];
    case "PAUSED":
    case "BLOCKED":
      return [
        { label: "Resume", targetStatus: "RUNNING" },
        { label: "Cancel", targetStatus: "CANCELLED", destructive: true },
      ];
    case "WAITING_USER":
    case "WAITING_AUTH":
    case "WAITING_RESOURCE":
      return [{ label: "Cancel", targetStatus: "CANCELLED", destructive: true }];
    case "VERIFYING":
      return [
        { label: "Return to Active", targetStatus: "RUNNING" },
        { label: "Cancel", targetStatus: "CANCELLED", destructive: true },
      ];
    case "COMPLETED":
    case "PARTIAL":
    case "CANCELLED":
    case "FAILED":
      return [];
  }
}
