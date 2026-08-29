/**
 * Terminus Desktop — the one definition of "needs you".
 *
 * Three surfaces used to answer the same question with three different
 * predicates and three different names:
 *
 *   sidebar strip   "Needs attention"   needs_you ∪ unread outcomes
 *   kanban column   "Needs you"         lifecycle + pending question + policy…
 *   modal           "Attention center"  needs_you | failed | review
 *
 * Those are genuinely different sets, so the counts on screen could disagree
 * about one task at one moment — which is the fastest way to teach an operator
 * that none of the three numbers is worth reading. This module is now the only
 * place any of them is computed.
 *
 * Two concepts live here, and they are deliberately different *kinds* of
 * thing — which is the distinction the old model got wrong in both directions:
 *
 *   - **Needs you** is a *state*. The task is blocked on a human, or it
 *     failed. Reading it changes nothing; only answering does.
 *     `attentionReason()` says *why*, because "answer a question", "approve an
 *     effect", "raise the budget" and "read a stack trace" are four different
 *     instructions, and a list of identical dots collapses them into one.
 *   - **Unread** is an *attribute*. It says nobody has looked yet, and it is
 *     orthogonal to the state: a task that needs you is almost certainly also
 *     unread, and a task that finished quietly can be either.
 *
 * So they must not be siblings. Merging them into one shelf produced a queue
 * that could never be emptied — and a queue that is always full is a queue
 * nobody reads. Listing them as two shelves was no better: it asked the reader
 * to file "blocked and unread" under one of two headings that were both true.
 *
 * Unread is therefore not a shelf at all. It is a mark on the row, in the
 * mail-app sense, and it appears wherever the row appears.
 */
import {
  lifecycleIsActive,
  lifecycleIsTerminal,
  lifecycleLabel,
  lifecycleNeedsAttention,
  type TaskLifecycle,
} from "./task-lifecycle";
import type { Task } from "../types";
import type { MaterialQuestionSnapshot, TaskV2Status } from "../types/v2";

/**
 * The one user-facing name. Second person, because it names who is being
 * asked; "Needs attention" says the same thing while leaving out the only
 * detail that makes it actionable.
 */
export const ATTENTION_LABEL = "Needs you";

// ─────────────────────────── Why it needs you ──────────────────────────────

/**
 * The distinct obligations a task can put on a human. Separated because the
 * human response to each differs: an answer, a decision, a budget, a read.
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
  readonly kind: AttentionKind;
  /**
   * Sort key inside the queue; lower comes first. Ordered by how cheaply the
   * human can discharge the obligation, so working the list from the top
   * clears the most work per minute of attention.
   */
  readonly rank: number;
  /** What is owed, in the fewest words that stay true. */
  readonly label: string;
  /** The specific thing, when the control plane named one. */
  readonly detail: string | null;
}

/**
 * Two tones, because there are two situations: something is broken, or
 * something is waiting on you. Painting both the same red makes a question you
 * can answer in one click look like a task that has burned its budget.
 */
export function attentionTone(kind: AttentionKind): "error" | "warning" {
  return kind === "failure" || kind === "policy" || kind === "budget" ? "error" : "warning";
}

/** A row has one line for this. Anything longer is clipped rather than wrapped. */
const MAX_ATTENTION_DETAIL_CHARS = 96;

/**
 * The short form of a `terminal_reason`.
 *
 * `terminalReasonText` in Conversation.tsx builds the full sentence for the
 * transcript and runs to 512 characters. This reads the same
 * `{ code, message, reason }` shape and clips it to a row width. Deliberately
 * not a call into the transcript helper: the sidebar would then pull the whole
 * conversation module into its bundle to format one string.
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
 * Everything the predicate can consult, all of it optional except the
 * lifecycle.
 *
 * The two surfaces that ask hold different halves of the truth: the rail has
 * the v1 domain record and no v2 snapshot, the board has both plus the
 * question list. One input shape with optional members lets them share the
 * answer rather than each deriving their own from what they happen to have.
 */
export interface AttentionInput {
  /** The lifecycle the surface is already rendering. */
  readonly lifecycle: TaskLifecycle;
  /** The v1 record, when the store has it. The finer vocabulary of the two. */
  readonly domainTask?: Task | null | undefined;
  /** The v2 status, when the surface holds a snapshot. */
  readonly v2Status?: TaskV2Status | null | undefined;
  /** The pending material question for this task, when one exists. */
  readonly question?: { readonly questionText: string } | null | undefined;
}

/**
 * Why this task wants a human, or null when it does not.
 *
 * The stored domain status is consulted before the v2 status because it is the
 * finer vocabulary: `BUDGET_EXHAUSTED` and `POLICY_DENIED` are both projected
 * into a single v2 `FAILED`, and they are not the same instruction to a person
 * — one wants a budget, the other wants a decision.
 *
 * `review` returns null on purpose. Changes being ready to read is an outcome,
 * not an obligation: it clears by reading, which is what {@link taskShelf}
 * files it under.
 */
export function attentionReason({
  lifecycle,
  domainTask,
  v2Status,
  question,
}: AttentionInput): AttentionReason | null {
  // Checked before the lifecycle gate: a question raised mid-run is already an
  // obligation, and the task's lifecycle is "working" while it waits.
  if (question && !lifecycleIsTerminal(lifecycle)) {
    return { kind: "question", rank: 0, label: "Answer this", detail: question.questionText };
  }
  if (lifecycle === "review" || !lifecycleNeedsAttention(lifecycle)) return null;

  switch (domainTask?.status) {
    case "NEEDS_USER_DECISION":
      return { kind: "question", rank: 0, label: "Waiting on your answer", detail: null };
    case "POLICY_DENIED":
      return { kind: "policy", rank: 2, label: "Policy denied", detail: failureDetail(domainTask.terminal_reason) };
    case "BUDGET_EXHAUSTED":
      return { kind: "budget", rank: 3, label: "Out of budget", detail: failureDetail(domainTask.terminal_reason) };
    case "FAILED_VERIFICATION":
      return { kind: "failure", rank: 4, label: "Verification failed", detail: failureDetail(domainTask.terminal_reason) };
    case "FAILED":
      return { kind: "failure", rank: 4, label: "Failed", detail: failureDetail(domainTask.terminal_reason) };
    case "BLOCKED":
      return { kind: "blocked", rank: 5, label: "Blocked", detail: null };
    default:
      break;
  }

  switch (v2Status) {
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

/** The pending question for a task, or null. One place, so the board, the
 *  inspector and the predicate cannot disagree about what "pending" means. */
export function pendingQuestionFor(
  taskId: string,
  questions: readonly MaterialQuestionSnapshot[],
): MaterialQuestionSnapshot | null {
  return questions.find(
    (question) => question.taskId === taskId && question.status === "PENDING",
  ) ?? null;
}

// ─────────────────────────────── Shelves ───────────────────────────────────

/**
 * Which shelf a task belongs on: what the work is *doing*, and nothing else.
 *
 * Read-state is not part of this. A finished task that nobody has opened is
 * still a finished task — it belongs under the day it finished, wearing an
 * unread mark, not hoisted into a queue beside a policy denial. Sorting by
 * "has anyone looked at this" is what made the top of the rail unreadable:
 * the loudest region of the column filled with work that was merely new.
 */
export type TaskShelf = "needs_you" | "working" | "settled";

/** The outcomes — states that are a report rather than a request. */
export function lifecycleIsOutcome(lifecycle: TaskLifecycle): boolean {
  return lifecycle === "done"
    || lifecycle === "failed"
    || lifecycle === "cancelled"
    || lifecycle === "review";
}

export function taskShelf(
  lifecycle: TaskLifecycle,
  reason: AttentionReason | null,
): TaskShelf {
  if (reason !== null) return "needs_you";
  if (lifecycleIsActive(lifecycle)) return "working";
  return "settled";
}

/**
 * What the Dock badge counts, and the one number the rail can be emptied to.
 *
 * Blocked work plus outcomes nobody has read — the two things a person still
 * owes the app. Running work is excluded: an agent working normally is not an
 * interruption, and a badge that counts it never returns to zero in a workday.
 */
export function countsTowardBadge(
  lifecycle: TaskLifecycle,
  reason: AttentionReason | null,
  unread: boolean,
): boolean {
  if (reason !== null) return true;
  return unread && lifecycleIsOutcome(lifecycle);
}

/**
 * Has the task moved since it was last read?
 *
 * Timestamps are compared as strings, which is how the store already sorts
 * them: the control plane emits ISO-8601 UTC, whose lexical and chronological
 * orders agree.
 */
export function taskIsUnread(updatedAt: string, seenAt: string | undefined): boolean {
  if (seenAt === undefined) return true;
  return updatedAt > seenAt;
}

/**
 * Whether a list needs to say which project each row belongs to.
 *
 * The trailing project label costs about 40% of a row's width in a 256px rail,
 * and it buys nothing when every row in the list is from the same project — it
 * is then one word repeated down the column, truncating the titles that are
 * actually being scanned. Ask the list, not the workspace: a workspace with
 * six projects can easily have a section whose four rows are all from one.
 */
export function spansMultipleProjects(sessionIds: Iterable<string>): boolean {
  let first: string | undefined;
  for (const sessionId of sessionIds) {
    if (first === undefined) first = sessionId;
    else if (sessionId !== first) return true;
  }
  return false;
}
