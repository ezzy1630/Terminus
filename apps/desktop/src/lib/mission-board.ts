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
  lifecycleLabel,
  lifecycleNeedsAttention,
  type BoardColumnId,
} from "./task-lifecycle";
import type {
  MaterialQuestionSnapshot,
  TaskV2Snapshot,
  TaskV2Status,
} from "../types/v2";

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

export function taskNeedsAttention(
  task: TaskV2Snapshot,
  questions: readonly MaterialQuestionSnapshot[],
): boolean {
  return lifecycleNeedsAttention(lifecycleFromV2Status(task.status))
    || questions.some((question) => question.taskId === task.id && question.status === "PENDING");
}

export function taskStatusLabel(status: TaskV2Status): string {
  return lifecycleLabel(lifecycleFromV2Status(status));
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
