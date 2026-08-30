import {
  deriveSubagentActivity,
  deriveVerificationActivity,
  extractUnifiedDiffs,
  projectEvent,
} from "./task-surface";
import { lifecycleLabel, lifecycleNeedsAttention, type TaskLifecycle } from "./task-lifecycle";
import { displayLifecycle, taskRunIsActive } from "./turn-activity";
import type { Task, TerminusSseEvent } from "../types";

export interface TaskChangePresentation {
  files: number;
  additions: number;
  deletions: number;
  source: "workspace" | "proposed";
}

export interface TaskVerificationPresentation {
  passed: number;
  failed: number;
  skipped: number;
  running: number;
  total: number;
}

export interface TaskPresentation {
  objective: string;
  lifecycle: TaskLifecycle;
  stateLabel: string;
  currentDetail: string | null;
  elapsedSeconds: number | null;
  runActive: boolean;
  needsAttention: boolean;
  changes: TaskChangePresentation | null;
  verification: TaskVerificationPresentation | null;
  activeSubagents: number;
  totalSubagents: number;
}

export interface TaskPresentationInput {
  task: Task;
  events: readonly TerminusSseEvent[];
  /**
   * The authoritative working-tree diff when the caller has loaded it. An
   * empty string deliberately falls back to event-published patches, matching
   * the review and details surfaces for proposed but unapplied changes.
   */
  workspaceDiff?: string | null;
  untrackedFiles?: readonly string[];
  pendingApprovalCount?: number;
  now?: Date;
}

const DETAIL_BY_EVENT: Readonly<Record<string, string>> = {
  "turn.context_compiling": "Reading project context",
  "turn.provider_running": "Working through the request",
  "turn.verifying": "Running verification",
  "turn.finalizing": "Preparing the result",
  "turn.repairing": "Repairing the failed check",
  "turn.repair_pending": "Preparing a repair",
  "turn.steering_queued": "Applying your correction",
  "verification.node_passed": "Running verification",
  "verification.node_failed": "Reviewing a failed check",
  "verification.no_runnable_checks": "Verification unavailable",
  "agent.spawned": "Delegating focused work",
};

const DETAIL_EVENT_PREFIXES = ["tool.", "verification.", "agent."] as const;

function recordFromJson(value: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : null;
  } catch {
    return null;
  }
}

function stringField(record: Readonly<Record<string, unknown>> | null, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function sentenceCase(value: string): string {
  if (value.length === 0) return value;
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function toolDetail(event: TerminusSseEvent): string | null {
  const payload = recordFromJson(event.data);
  const nested = payload?.args;
  const args = nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Readonly<Record<string, unknown>>
    : null;
  const command = stringField(payload, "command", "args_summary", "summary")
    ?? stringField(args, "command", "path");
  const tool = stringField(payload, "tool", "tool_id", "toolId");

  if (command) return event.event === "tool.settled" ? `Finished ${command}` : `Running ${command}`;
  if (tool) return event.event === "tool.settled" ? `Finished ${tool}` : `Using ${tool}`;
  return event.event === "tool.settled" ? "Finished a tool step" : "Running a tool step";
}

function lifecycleDetail(lifecycle: TaskLifecycle): string | null {
  switch (lifecycle) {
    case "planning": return "Planning the work";
    case "working": return "Working on the task";
    case "verifying": return "Running verification";
    case "review": return "Changes are ready to review";
    case "needs_you": return "Waiting for your decision";
    case "failed": return "The task could not continue";
    case "done": return "Work completed";
    case "cancelled": return "The run was stopped";
    case "queued": return "Waiting to start";
    case "idle": return null;
    case "unknown": return "Waiting for an authoritative update";
  }
}

function latestCurrentDetail(
  events: readonly TerminusSseEvent[],
  lifecycle: TaskLifecycle,
  runActive: boolean,
): string | null {
  // Phase and tool events describe a live run. Once it settles they are
  // history, not current state; reusing the last one produced contradictions
  // such as “Ready · Preparing the result”.
  if (!runActive) return lifecycleDetail(lifecycle);

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const fixed = DETAIL_BY_EVENT[event.event];
    if (fixed) return fixed;
    if (event.event.startsWith("tool.")) return toolDetail(event);
    if (DETAIL_EVENT_PREFIXES.some((prefix) => event.event.startsWith(prefix))) {
      const projected = projectEvent(event);
      if (projected.summary.trim().length > 0) return sentenceCase(projected.summary);
    }
  }

  return lifecycleDetail(lifecycle);
}

function countUnifiedDiffs(diffs: readonly string[], untrackedFiles: readonly string[] = []): Omit<TaskChangePresentation, "source"> {
  let additions = 0;
  let deletions = 0;
  const files = new Set(untrackedFiles);

  for (const diff of diffs) {
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git ")) {
        const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        const path = match?.[2] ?? match?.[1];
        if (path) files.add(path);
      } else if (line.startsWith("+++ ")) {
        const path = line.slice(4).trim().replace(/^b\//, "");
        if (path.length > 0 && path !== "/dev/null") files.add(path);
      } else if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-") && !line.startsWith("--- ")) {
        deletions += 1;
      }
    }
  }

  return { files: files.size, additions, deletions };
}

function deriveChanges(input: TaskPresentationInput): TaskChangePresentation | null {
  const proposed = extractUnifiedDiffs([...input.events]);
  if (input.workspaceDiff && input.workspaceDiff.trim().length > 0) {
    const stats = countUnifiedDiffs([input.workspaceDiff], input.untrackedFiles);
    return { ...stats, source: "workspace" };
  }
  if (proposed.length > 0) {
    const stats = countUnifiedDiffs(proposed);
    if (stats.files > 0 || stats.additions > 0 || stats.deletions > 0) {
      return { ...stats, source: "proposed" };
    }
  }
  if ((input.untrackedFiles?.length ?? 0) > 0) {
    const stats = countUnifiedDiffs([], input.untrackedFiles);
    return { ...stats, source: "workspace" };
  }
  return null;
}

function deriveVerification(events: readonly TerminusSseEvent[]): TaskVerificationPresentation | null {
  const activity = deriveVerificationActivity([...events]);
  if (activity.length === 0) return null;
  const nodeActivity = activity.filter((item) => !item.detail.startsWith("Verification plan "));
  const counted = nodeActivity.length > 0 ? nodeActivity : activity.slice(-1);
  const passed = counted.filter((item) => item.state === "passed").length;
  const failed = counted.filter((item) => item.state === "failed").length;
  const skipped = counted.filter((item) => item.state === "skipped").length;
  const running = counted.filter((item) => item.state === "running").length;
  return { passed, failed, skipped, running, total: counted.length };
}

function activeTurnStartedAt(task: Task, events: readonly TerminusSseEvent[]): number | null {
  const snapshot = task.active_turn?.started_at;
  if (snapshot) {
    const parsed = Date.parse(snapshot);
    if (Number.isFinite(parsed)) return parsed;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.event !== "turn.started") continue;
    const payload = recordFromJson(event.data);
    const startedAt = stringField(payload, "started_at", "startedAt");
    if (!startedAt) return null;
    const parsed = Date.parse(startedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function presentTask(input: TaskPresentationInput): TaskPresentation {
  const { task, events } = input;
  const lifecycle = displayLifecycle(task, events);
  const runActive = taskRunIsActive(task, events);
  const verification = deriveVerification(events);
  const subagents = deriveSubagentActivity([...events]);
  const startedAt = runActive ? activeTurnStartedAt(task, events) : null;
  const now = input.now?.getTime() ?? Date.now();
  const elapsedSeconds = startedAt === null || !Number.isFinite(now)
    ? null
    : Math.max(0, Math.floor((now - startedAt) / 1_000));
  const currentDetail = input.pendingApprovalCount && input.pendingApprovalCount > 0
    ? "Permission required"
    : latestCurrentDetail(events, lifecycle, runActive);

  return {
    objective: task.contract?.objective?.trim() || "Untitled task",
    lifecycle,
    stateLabel: lifecycleLabel(lifecycle),
    currentDetail,
    elapsedSeconds,
    runActive,
    needsAttention: lifecycleNeedsAttention(lifecycle) || (input.pendingApprovalCount ?? 0) > 0,
    changes: deriveChanges(input),
    verification,
    activeSubagents: subagents.filter((agent) => agent.state === "working").length,
    totalSubagents: subagents.length,
  };
}

export function formatElapsedTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes === 0) return `${remaining}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${remaining.toString().padStart(2, "0")}s`;
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}
