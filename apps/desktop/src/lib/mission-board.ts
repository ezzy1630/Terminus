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
  lifecycleIsTerminal,
  lifecycleLabel,
  lifecycleNeedsAttention,
  type BoardColumnId,
  type TaskLifecycle,
} from "./task-lifecycle";
import { primaryBudgetMetric, type BudgetTone } from "./task-budget";
import { compactDuration } from "./time";
import { displayLifecycleWith, type TurnActivity } from "./turn-activity";
import type { Task } from "../types";
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
  return domainTask === undefined
    ? lifecycleFromV2Status(task.status)
    : displayLifecycleWith(domainTask, activity);
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
 * column exists to do. Terminal work is exempt: a stale question against a task
 * that already finished must not drag it back out of Done.
 */
export function boardColumnForTaskPlacement(
  lifecycle: TaskLifecycle,
  hasPendingQuestion: boolean,
): MissionBoardPlacement {
  if (hasPendingQuestion && !lifecycleIsTerminal(lifecycle)) return "needs_you";
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

// ─────────────────────────── Why it needs you ──────────────────────────────

/**
 * The distinct obligations a task can put on a human. They are separated
 * because the human response to each is different: an answer, a decision, a
 * budget, a read. Collapsing them — which is what a single "needs attention"
 * boolean does — leaves a column of identical dots that has to be opened one
 * card at a time to be triaged at all.
 */
export type AttentionKind =
  | "question"
  | "approval"
  | "policy"
  | "budget"
  | "failure"
  | "blocked"
  | "resource"
  | "paused";

export interface AttentionReason {
  kind: AttentionKind;
  /**
   * Sort key inside the Needs you column; lower comes first. Ordered by how
   * cheaply the human can discharge the obligation, so working the column from
   * the top clears the most work per minute of attention.
   */
  rank: number;
  /** What is owed, in the fewest words that stay true. */
  label: string;
  /** The specific thing, when the control plane named one. */
  detail: string | null;
}

/**
 * Two tones, because there are two situations: something is broken, or
 * something is waiting on you. A board that paints both in the same red — which
 * is what a single attention dot does — makes a question you can answer in one
 * click look exactly like a task that has already burned its budget.
 */
export function attentionTone(kind: AttentionKind): "error" | "warning" {
  return kind === "failure" || kind === "policy" || kind === "budget" ? "error" : "warning";
}

/** A card has one line for this. Anything longer is clipped rather than wrapped. */
const MAX_ATTENTION_DETAIL_CHARS = 96;

/**
 * The short form of a `terminal_reason`.
 *
 * `terminalReasonText` in Conversation.tsx builds the full sentence for the
 * transcript and runs to 512 characters. This reads the same
 * `{ code, message, reason }` shape the control plane writes, keeps only the
 * most specific field, and clips it to a card width. Deliberately not a call
 * into the transcript helper: the board would then pull the whole conversation
 * module into its bundle to format one string.
 */
function failureDetail(reason: Record<string, unknown> | null | undefined): string | null {
  if (!reason) return null;
  const read = (key: string): string | null => {
    const value = reason[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };
  const text = read("message") ?? read("reason") ?? read("code");
  if (text === null) return null;
  return text.length > MAX_ATTENTION_DETAIL_CHARS
    ? `${text.slice(0, MAX_ATTENTION_DETAIL_CHARS - 1)}…`
    : text;
}

/**
 * Why this task wants a human, or null when it does not.
 *
 * The stored domain status is consulted before the v2 status because it is the
 * finer vocabulary: `BUDGET_EXHAUSTED` and `POLICY_DENIED` are both projected
 * into a single v2 `FAILED`, and they are not the same instruction to a person
 * — one wants a budget, the other wants a decision.
 *
 * `review` returns null on purpose. The Review column header already says the
 * changes are ready to read, and a per-card chip repeating its own column is
 * the same restatement-in-a-second-alphabet the board removed elsewhere.
 */
export function attentionReason(
  task: TaskV2Snapshot,
  lifecycle: TaskLifecycle,
  domainTask: Task | undefined,
  questions: readonly MaterialQuestionSnapshot[],
): AttentionReason | null {
  const question = questions.find(
    (candidate) => candidate.taskId === task.id && candidate.status === "PENDING",
  );
  // Checked before the lifecycle gate: a question raised mid-run is still an
  // obligation, and the task's lifecycle is "working" while it waits.
  if (question && !lifecycleIsTerminal(lifecycle)) {
    return { kind: "question", rank: 0, label: "Answer this", detail: question.questionText };
  }
  if (lifecycle === "review" || !lifecycleNeedsAttention(lifecycle)) return null;

  switch (domainTask?.status) {
    case "POLICY_DENIED":
      return { kind: "policy", rank: 2, label: "Policy denied", detail: failureDetail(domainTask.terminal_reason) };
    case "BUDGET_EXHAUSTED":
      return { kind: "budget", rank: 3, label: "Out of budget", detail: failureDetail(domainTask.terminal_reason) };
    case "FAILED_VERIFICATION":
      return { kind: "failure", rank: 4, label: "Verification failed", detail: failureDetail(domainTask.terminal_reason) };
    case "FAILED":
      return { kind: "failure", rank: 4, label: "Failed", detail: failureDetail(domainTask.terminal_reason) };
    default:
      break;
  }

  switch (task.status) {
    case "WAITING_USER":
      return { kind: "question", rank: 0, label: "Waiting on your answer", detail: null };
    case "WAITING_AUTH":
      return { kind: "approval", rank: 1, label: "Approve or deny", detail: null };
    case "FAILED":
      return { kind: "failure", rank: 4, label: "Failed", detail: failureDetail(domainTask?.terminal_reason) };
    case "BLOCKED":
      return { kind: "blocked", rank: 5, label: "Blocked", detail: null };
    case "WAITING_RESOURCE":
      return { kind: "resource", rank: 6, label: "Waiting on a resource", detail: null };
    case "PAUSED":
      return { kind: "paused", rank: 7, label: "Paused", detail: null };
    default:
      // The lifecycle says a human is wanted and neither status says why. Say
      // the lifecycle rather than inventing a reason.
      return { kind: "blocked", rank: 5, label: lifecycleLabel(lifecycle), detail: null };
  }
}

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
