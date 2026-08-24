import type {
  MaterialQuestionSnapshot,
  TaskV2Snapshot,
  TaskV2Status,
} from "../types/v2";

export const MISSION_BOARD_COLUMNS = [
  { id: "running", label: "Running", description: "Currently executing tasks and active agent turns." },
  { id: "waiting_for_review", label: "Waiting for review", description: "Tasks waiting for user review, approval, or verification." },
  { id: "done", label: "Done", description: "Completed work with admitted evidence." },
] as const;

export type MissionBoardColumnId = (typeof MISSION_BOARD_COLUMNS)[number]["id"];
export type MissionBoardPlacement = MissionBoardColumnId | "closed";

const attentionStatuses = new Set<TaskV2Status>([
  "WAITING_USER",
  "WAITING_AUTH",
  "BLOCKED",
  "FAILED",
]);

export function boardColumnForStatus(status: TaskV2Status): MissionBoardPlacement {
  switch (status) {
    case "DRAFT":
    case "READY":
    case "RUNNING":
    case "PAUSED":
      return "running";
    case "WAITING_USER":
    case "WAITING_AUTH":
    case "WAITING_RESOURCE":
    case "VERIFYING":
    case "BLOCKED":
    case "FAILED":
      return "waiting_for_review";
    case "COMPLETED":
      return "done";
    case "PARTIAL":
    case "CANCELLED":
      return "closed";
  }
}

/**
 * Board columns are a projection. A drop may only request a transition the
 * canonical V2 state machine already admits. Completion remains evidence-only.
 */
export function boardTransitionForDrop(
  status: TaskV2Status,
  destination: MissionBoardColumnId,
): TaskV2Status | null {
  if ((status === "DRAFT" || status === "READY") && destination === "running") return "RUNNING";
  if (status === "RUNNING" && destination === "waiting_for_review") return "VERIFYING";
  if ((status === "VERIFYING" || status === "PAUSED" || status === "BLOCKED") && destination === "running") return "RUNNING";
  return null;
}

export function taskNeedsAttention(
  task: TaskV2Snapshot,
  questions: readonly MaterialQuestionSnapshot[],
): boolean {
  return attentionStatuses.has(task.status)
    || questions.some((question) => question.taskId === task.id && question.status === "PENDING");
}

export function taskStatusLabel(status: TaskV2Status): string {
  switch (status) {
    case "DRAFT": return "Draft";
    case "READY": return "Ready";
    case "RUNNING": return "Working";
    case "WAITING_USER": return "Waiting for you";
    case "WAITING_AUTH": return "Approval required";
    case "WAITING_RESOURCE": return "Waiting for resource";
    case "PAUSED": return "Paused";
    case "VERIFYING": return "Verifying";
    case "COMPLETED": return "Verified";
    case "PARTIAL": return "Partially complete";
    case "BLOCKED": return "Blocked";
    case "CANCELLED": return "Cancelled";
    case "FAILED": return "Failed";
  }
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
        { label: "Send to Review", targetStatus: "VERIFYING" },
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
