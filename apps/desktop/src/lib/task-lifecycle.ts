/**
 * Terminus Desktop — the one task-status vocabulary.
 *
 * Before this module the client carried two parallel status systems that
 * disagreed on screen: the sidebar read the SPEC §28.3 domain status through
 * `normalizeTaskStatus()` and rendered "Queued", while the board read
 * `TaskV2Snapshot.status` and rendered the same task under "Running".
 *
 * The control plane stores exactly one status per task, in the SPEC §28.3
 * vocabulary (`prisma/schema.prisma` `Task.status`). The ARP v2 status is a
 * lossy projection of it (`v1TaskStatusToV2` in the control plane collapses
 * FAILED / FAILED_VERIFICATION / BUDGET_EXHAUSTED / POLICY_DENIED into a
 * single FAILED, and falls back to BLOCKED for anything unrecognised). So the
 * stored domain status is canonical here, the v2 status is a second-class
 * input, and both land in one `TaskLifecycle` that every surface renders.
 *
 * Lifecycle is *where the work is*. Attention is *whether it wants a human*.
 * They are deliberately separate: a failed task and a task waiting on approval
 * occupy different lifecycle states but both demand attention.
 */

/**
 * The user-facing task states. Ordered as work flows through them, so
 * `TASK_LIFECYCLE.indexOf()` is a usable sort key for boards and lists.
 */
export const TASK_LIFECYCLE = [
  "queued",
  "planning",
  "working",
  "needs_you",
  "verifying",
  "review",
  "done",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type TaskLifecycle = (typeof TASK_LIFECYCLE)[number];

export type LifecycleTone = "neutral" | "info" | "warning" | "error" | "success";

/**
 * SPEC §28.3 task phases. `phase` refines an ACTIVE task into planning /
 * working / verifying / review; no other status consults it.
 */
const PLANNING_PHASES = new Set(["INTAKE", "CONTRACT", "DISCOVER", "PLAN"]);

/**
 * Canonical mapping: SPEC §28.3 domain status (+ optional phase) → lifecycle.
 * This is the only place a stored status is interpreted.
 */
export function lifecycleFromDomainStatus(status: string, phase?: string | null): TaskLifecycle {
  switch (status.toUpperCase()) {
    case "DRAFT":
      return "queued";
    case "ACTIVE":
      return activeLifecycleForPhase(phase);
    case "NEEDS_USER_DECISION":
    case "BLOCKED":
      return "needs_you";
    case "VERIFYING":
      return "verifying";
    case "COMPLETED":
      return "done";
    case "ABORTED":
      return "cancelled";
    case "FAILED":
    case "FAILED_VERIFICATION":
    case "BUDGET_EXHAUSTED":
    case "POLICY_DENIED":
      return "failed";
    default:
      return "unknown";
  }
}

/**
 * An ACTIVE task is doing something specific. Phase says what. An unrecognised
 * or absent phase reports "working" rather than "unknown": the task is
 * demonstrably running, and claiming otherwise would be less accurate.
 */
function activeLifecycleForPhase(phase?: string | null): TaskLifecycle {
  if (typeof phase !== "string" || phase.length === 0) return "working";
  const value = phase.toUpperCase();
  if (PLANNING_PHASES.has(value)) return "planning";
  if (value === "VERIFY") return "verifying";
  if (value === "REVIEW") return "review";
  return "working";
}

/**
 * ARP v2 status → lifecycle. v2 carries no phase, so this is coarser than the
 * domain path by construction: RUNNING cannot be split into planning/working.
 * Prefer `lifecycleFromDomainStatus` whenever the domain record is available.
 */
export function lifecycleFromV2Status(status: string): TaskLifecycle {
  switch (status.toUpperCase()) {
    case "DRAFT":
    case "READY":
      return "queued";
    case "RUNNING":
      return "working";
    case "WAITING_USER":
    case "WAITING_AUTH":
    case "WAITING_RESOURCE":
    case "PAUSED":
    case "BLOCKED":
      return "needs_you";
    case "VERIFYING":
      return "verifying";
    case "PARTIAL":
      // Partially complete is a human judgement call, not a failure.
      return "review";
    case "COMPLETED":
      return "done";
    case "CANCELLED":
      return "cancelled";
    case "FAILED":
      return "failed";
    default:
      return "unknown";
  }
}

/** Convenience for the common `{ status, phase }` shape of a domain task. */
export function lifecycleFromTask(
  task: { readonly status: string; readonly phase?: string | null } | null | undefined,
): TaskLifecycle {
  if (!task) return "unknown";
  return lifecycleFromDomainStatus(task.status, task.phase ?? null);
}

export function lifecycleLabel(lifecycle: TaskLifecycle): string {
  switch (lifecycle) {
    case "queued": return "Queued";
    case "planning": return "Planning";
    case "working": return "Working";
    case "needs_you": return "Needs you";
    case "verifying": return "Verifying";
    case "review": return "Ready for review";
    case "done": return "Done";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "unknown": return "Pending";
  }
}

/**
 * Short form for dense rows where the full label would truncate. Only differs
 * where the long label is genuinely too wide for a sidebar row.
 */
export function lifecycleShortLabel(lifecycle: TaskLifecycle): string {
  return lifecycle === "review" ? "Review" : lifecycleLabel(lifecycle);
}

export function lifecycleTone(lifecycle: TaskLifecycle): LifecycleTone {
  switch (lifecycle) {
    case "planning":
    case "working":
    case "verifying":
      return "info";
    case "needs_you":
      return "warning";
    case "review":
      return "success";
    case "failed":
      return "error";
    case "queued":
    case "done":
    case "cancelled":
    case "unknown":
      return "neutral";
  }
}

/**
 * Does this task want a human right now? Drives the attention inbox, the
 * sidebar badge, the Dock badge, and native notifications.
 *
 * Deliberately excludes `working` and `verifying`: agents running normally are
 * not a problem to be solved. Interruptions are.
 */
export function lifecycleNeedsAttention(lifecycle: TaskLifecycle): boolean {
  return lifecycle === "needs_you" || lifecycle === "failed" || lifecycle === "review";
}

/** The agent is doing work of its own accord and no human is blocking it. */
export function lifecycleIsActive(lifecycle: TaskLifecycle): boolean {
  return lifecycle === "planning" || lifecycle === "working" || lifecycle === "verifying";
}

/** No further transition will occur without a new user action. */
export function lifecycleIsTerminal(lifecycle: TaskLifecycle): boolean {
  return lifecycle === "done" || lifecycle === "failed" || lifecycle === "cancelled";
}

// ────────────────────────── Board projection ───────────────────────────────

/**
 * Five columns, per the agreed information architecture. `needs_you` is the
 * bottleneck column and carries failures too: to a human, "answer this
 * question" and "this failed three times" are the same instruction.
 */
export const BOARD_COLUMNS = [
  { id: "queued", label: "Queued", description: "Accepted, not started." },
  { id: "working", label: "Working", description: "The agent is making progress unattended." },
  { id: "needs_you", label: "Needs you", description: "Blocked on a decision, an approval, or a failure." },
  { id: "review", label: "Review", description: "Changes are ready to read." },
  { id: "done", label: "Done", description: "Finished. Auto-archives after a day." },
] as const;

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]["id"];

export function boardColumnForLifecycle(lifecycle: TaskLifecycle): BoardColumnId {
  switch (lifecycle) {
    case "queued":
    case "unknown":
      return "queued";
    case "planning":
    case "working":
    case "verifying":
      return "working";
    case "needs_you":
    case "failed":
      return "needs_you";
    case "review":
      return "review";
    case "done":
    case "cancelled":
      return "done";
  }
}

/** Stable ordering for lists that mix lifecycles. */
export function lifecycleOrder(lifecycle: TaskLifecycle): number {
  return TASK_LIFECYCLE.indexOf(lifecycle);
}

/**
 * A short, human name for a task: the first line of its contract objective,
 * or a short id when the contract has not been written yet. Every surface
 * that lists tasks — sidebar, board, notifications — uses this one.
 */
export function taskTitle(task: { readonly id: string; readonly contract?: { objective?: string } | null }): string {
  const objective = task.contract?.objective?.trim();
  if (objective && objective.length > 0) {
    const firstLine = objective.split("\n")[0] ?? objective;
    return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  }
  return task.id.slice(0, 8);
}
