/**
 * Terminus Desktop — Dock badge and native notifications.
 *
 * Agents work for minutes at a time, so the app is usually behind something
 * else when it finally needs a decision. The preload bridge has always
 * exposed `notify`, and nothing in the renderer ever called it; the Dock icon
 * never showed a count at all. A task blocked on an approval was therefore
 * invisible unless the window happened to be on screen.
 *
 * Two rules keep this from becoming noise:
 *   - Only tasks that want a human count; an agent running normally is not an
 *     interruption.
 *   - A task is announced on the transition into needing attention, once.
 *     Whatever was already waiting when the app opened is not news, and a
 *     focused window does not need to be told what it is displaying.
 *
 * Notifications and the badge deliberately read different things. A
 * notification fires on a *transition* — it is an event, and reading the task
 * later cannot un-happen it. The badge is a *standing count*, so it tracks the
 * same clearable set the sidebar queue shows; see `badgeCount` below for why
 * the old status-only count could never reach zero.
 */
import { useEffect, useMemo, useRef } from "react";

import { useTerminusStore } from "./use-terminus";
import { useTaskReadStore } from "./use-task-read";
import { subscribeEvents } from "../lib/api";
import { subscribeEventsV2 } from "../lib/api-v2";
import { attentionReason, countsTowardBadge, taskIsUnread } from "../lib/attention";
import { lifecycleLabel, taskTitle } from "../lib/task-lifecycle";
import { displayLifecycleWith, type TurnActivity } from "../lib/turn-activity";
import type { Task } from "../types";
import type { ArpV2EventEnvelope } from "../types/v2";

const WORKSPACE_REFRESH_DELAY_MS = 200;
const WORKSPACE_RECONNECT_BASE_MS = 500;
const WORKSPACE_RECONNECT_MAX_MS = 30_000;

/** V1 boundaries that can change whether a task belongs in Priority. */
const WORKSPACE_ACTIVITY_EVENTS = new Set([
  "turn.started",
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
  "turn.recovery_reconciled",
  "task.turn_failed",
]);

/**
 * Resolve the task whose sidebar projection may have changed.
 *
 * Task events identify it directly. Question events identify their own
 * aggregate, so their task is carried in `correlationId` instead.
 */
export function workspaceTaskIdForEvent(event: ArpV2EventEnvelope): string | null {
  if (event.aggregateType === "task") return event.aggregateId || null;
  if (event.eventType.startsWith("question.")) return event.correlationId || null;
  return null;
}

function eventNeedsWorkspaceRefresh(event: ArpV2EventEnvelope): boolean {
  return event.aggregateType === "task"
    || event.eventType.startsWith("question.");
}

/**
 * Keep the portfolio current even when no task transcript is open.
 *
 * Transcript streams remain task-scoped because they carry high-volume turn
 * detail. V2 task/question events carry enough identity for a targeted detail
 * read. Turn lifecycle is still emitted on V1, whose terminal payload does not
 * carry a task id, so that low-volume boundary reconciles the bounded workspace
 * snapshot. Provider deltas and tool events never trigger sidebar traffic.
 */
export function useWorkspaceEventRefresh(): void {
  useEffect(() => {
    let disposed = false;
    let v1ReconnectAttempts = 0;
    let v2ReconnectAttempts = 0;
    let v1Cursor: string | null = null;
    let v2Cursor: string | null = null;
    let refreshTimer: number | null = null;
    let v1ReconnectTimer: number | null = null;
    let v2ReconnectTimer: number | null = null;
    let v1Stream: ReturnType<typeof subscribeEvents> | null = null;
    let v2Stream: ReturnType<typeof subscribeEventsV2> | null = null;
    const pendingTaskIds = new Set<string>();
    let needsFullRefresh = false;

    const scheduleFlush = (): void => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        const taskIds = [...pendingTaskIds];
        pendingTaskIds.clear();
        if (needsFullRefresh) {
          needsFullRefresh = false;
          void useTerminusStore.getState().refreshAll();
          return;
        }
        const { refreshTask } = useTerminusStore.getState();
        void Promise.all(taskIds.map((taskId) => refreshTask(taskId)));
      }, WORKSPACE_REFRESH_DELAY_MS);
    };

    const scheduleTaskRefresh = (taskId: string | null): void => {
      if (taskId === null) needsFullRefresh = true;
      else pendingTaskIds.add(taskId);
      scheduleFlush();
    };

    const scheduleFullRefresh = (): void => {
      needsFullRefresh = true;
      scheduleFlush();
    };

    const connectV2 = (): void => {
      if (disposed) return;
      v2Stream = subscribeEventsV2({ cursor: v2Cursor });
      v2Stream.addEventListener("open", () => {
        v2ReconnectAttempts = 0;
      });
      v2Stream.addEventListener("message", (event) => {
        v2Cursor = event.eventId;
        if (eventNeedsWorkspaceRefresh(event)) scheduleTaskRefresh(workspaceTaskIdForEvent(event));
      });
      v2Stream.addEventListener("error", () => {
        if (disposed || v2ReconnectTimer !== null) return;
        v2Cursor = v2Stream?.lastEventId ?? v2Cursor;
        v2Stream?.close();
        v2ReconnectAttempts += 1;
        const delay = Math.min(
          WORKSPACE_RECONNECT_MAX_MS,
          WORKSPACE_RECONNECT_BASE_MS * 2 ** Math.min(v2ReconnectAttempts - 1, 6),
        );
        v2ReconnectTimer = window.setTimeout(() => {
          v2ReconnectTimer = null;
          connectV2();
        }, delay);
      });
    };

    const connectV1 = (): void => {
      if (disposed) return;
      v1Stream = subscribeEvents({ cursor: v1Cursor });
      v1Stream.addEventListener("open", () => {
        v1ReconnectAttempts = 0;
      });
      v1Stream.addEventListener("message", (event) => {
        v1Cursor = event.id || v1Cursor;
        if (WORKSPACE_ACTIVITY_EVENTS.has(event.event)) scheduleFullRefresh();
      });
      v1Stream.addEventListener("error", () => {
        if (disposed || v1ReconnectTimer !== null) return;
        v1Cursor = v1Stream?.lastEventId ?? v1Cursor;
        v1Stream?.close();
        v1ReconnectAttempts += 1;
        const delay = Math.min(
          WORKSPACE_RECONNECT_MAX_MS,
          WORKSPACE_RECONNECT_BASE_MS * 2 ** Math.min(v1ReconnectAttempts - 1, 6),
        );
        v1ReconnectTimer = window.setTimeout(() => {
          v1ReconnectTimer = null;
          connectV1();
        }, delay);
      });
    };

    connectV1();
    connectV2();
    return () => {
      disposed = true;
      v1Stream?.close();
      v2Stream?.close();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (v1ReconnectTimer !== null) window.clearTimeout(v1ReconnectTimer);
      if (v2ReconnectTimer !== null) window.clearTimeout(v2ReconnectTimer);
    };
  }, []);
}

export interface AttentionItem {
  readonly id: string;
  readonly title: string;
  readonly label: string;
}

/**
 * Tasks that just finished, for the "it's done" notification.
 *
 * A completed run is the other thing worth interrupting for: the operator
 * started it and went elsewhere precisely because it takes minutes. Only the
 * transition is announced, so reopening the app does not replay every task
 * that finished while it was closed.
 */
export function completedItems(
  tasksBySession: Record<string, Task[]>,
  runActivityByTask: Record<string, TurnActivity>,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const tasks of Object.values(tasksBySession)) {
    for (const task of tasks) {
      const lifecycle = displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown");
      if (lifecycle !== "done") continue;
      items.push({ id: task.id, title: taskTitle(task), label: lifecycleLabel(lifecycle) });
    }
  }
  return items;
}

/**
 * The tasks that want a human, in the one vocabulary every surface uses.
 *
 * `lib/attention.ts` is that vocabulary, so the Dock badge, the rail's queue
 * and the board's Needs you column are literally the same computation. They
 * used to be three separate predicates, which meant the badge could say "3"
 * while the surface it pointed at said "nothing needs attention".
 *
 * The label is the *reason*, not the lifecycle. "Answer this" and "Out of
 * budget" tell someone glancing at a notification whether it is worth
 * switching windows for; "Needs you" makes them switch to find out.
 */
export function attentionItems(
  tasksBySession: Record<string, Task[]>,
  runActivityByTask: Record<string, TurnActivity>,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const tasks of Object.values(tasksBySession)) {
    for (const task of tasks) {
      const lifecycle = displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown");
      const reason = attentionReason({ lifecycle, domainTask: task });
      if (reason === null) continue;
      items.push({ id: task.id, title: taskTitle(task), label: reason.label });
    }
  }
  return items;
}

export function useNativeAttention(onOpenTask: (taskId: string) => void): void {
  useWorkspaceEventRefresh();
  const tasksBySession = useTerminusStore((state) => state.tasksBySession);
  const runActivityByTask = useTerminusStore((state) => state.runActivityByTask);
  const seenAtByTask = useTaskReadStore((state) => state.seenAtByTask);
  const items = useMemo(
    () => attentionItems(tasksBySession, runActivityByTask),
    [runActivityByTask, tasksBySession],
  );
  const completed = useMemo(
    () => completedItems(tasksBySession, runActivityByTask),
    [runActivityByTask, tasksBySession],
  );

  // null until the first pass, which establishes the baseline rather than
  // announcing it.
  const announcedRef = useRef<Set<string> | null>(null);
  const badgeRef = useRef<number | null>(null);

  /**
   * What the Dock shows.
   *
   * Deliberately not `items.length`. That counted every task in an attention
   * state for as long as it stayed in one, so a task that failed on Tuesday
   * still contributed to the badge on Friday and the number could not be
   * driven to zero by any action short of deleting the task. The badge now
   * counts the same thing the sidebar's queue does — blocked work, plus
   * outcomes that have not been read — so clearing the rail clears the Dock.
   */
  const badgeCount = useMemo(() => {
    let count = 0;
    for (const tasks of Object.values(tasksBySession)) {
      for (const task of tasks) {
        const lifecycle = displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown");
        const updatedAt = task.updated_at || task.created_at;
        // Blocked work, plus outcomes nobody has read — the same two things
        // the rail marks, defined once in lib/attention.ts so the Dock and the
        // rail cannot end up counting different sets.
        if (countsTowardBadge(
          lifecycle,
          attentionReason({ lifecycle, domainTask: task }),
          taskIsUnread(updatedAt, seenAtByTask[task.id]),
        )) count += 1;
      }
    }
    return count;
  }, [runActivityByTask, seenAtByTask, tasksBySession]);

  useEffect(() => {
    if (badgeRef.current === badgeCount) return;
    badgeRef.current = badgeCount;
    void window.terminusDesktop?.setAttentionCount?.(badgeCount);
  }, [badgeCount]);

  useEffect(() => {
    const previous = announcedRef.current;
    // A task that stopped needing attention may legitimately need it again.
    announcedRef.current = new Set(items.map((item) => item.id));
    if (previous === null) return;
    if (document.hasFocus()) return;
    const notify = window.terminusDesktop?.notify;
    if (!notify) return;
    for (const item of items) {
      if (previous.has(item.id)) continue;
      void notify(item.label, item.title, item.id);
    }
  }, [items]);

  // Finishing is news too. Only announcing failures and blocks meant the
  // successful case — the one the operator is actually waiting on — was the
  // only outcome the app never mentioned.
  const announcedDoneRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const previous = announcedDoneRef.current;
    announcedDoneRef.current = new Set(completed.map((item) => item.id));
    if (previous === null) return;
    if (document.hasFocus()) return;
    const notify = window.terminusDesktop?.notify;
    if (!notify) return;
    for (const item of completed) {
      if (previous.has(item.id)) continue;
      void notify(item.label, item.title, item.id);
    }
  }, [completed]);

  useEffect(() => {
    const subscribe = window.terminusDesktop?.onOpenTask;
    if (!subscribe) return;
    return subscribe(onOpenTask);
  }, [onOpenTask]);
}
