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
import { subscribeEventsV2 } from "../lib/api-v2";
import { attentionReason, countsTowardBadge, taskIsUnread } from "../lib/attention";
import { lifecycleLabel, taskTitle } from "../lib/task-lifecycle";
import { displayLifecycleWith, type TurnActivity } from "../lib/turn-activity";
import type { Task } from "../types";

const WORKSPACE_REFRESH_DELAY_MS = 200;
const WORKSPACE_RECONNECT_BASE_MS = 500;
const WORKSPACE_RECONNECT_MAX_MS = 30_000;

/**
 * Keep the portfolio current even when no task transcript is open.
 *
 * Transcript streams remain task-scoped because they carry high-volume turn
 * detail. This lightweight V2 stream observes only task and question changes,
 * then reconciles the bounded sidebar snapshot through the ordinary reads.
 */
export function useWorkspaceEventRefresh(): void {
  useEffect(() => {
    let disposed = false;
    let reconnectAttempts = 0;
    let cursor: string | null = null;
    let refreshTimer: number | null = null;
    let reconnectTimer: number | null = null;
    let stream: ReturnType<typeof subscribeEventsV2> | null = null;

    const scheduleRefresh = (): void => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void useTerminusStore.getState().refreshAll();
      }, WORKSPACE_REFRESH_DELAY_MS);
    };

    const connect = (): void => {
      if (disposed) return;
      stream = subscribeEventsV2({ cursor });
      stream.addEventListener("open", () => {
        reconnectAttempts = 0;
      });
      stream.addEventListener("message", (event) => {
        cursor = event.eventId;
        if (event.aggregateType === "task" || event.eventType.startsWith("question.")) {
          scheduleRefresh();
        }
      });
      stream.addEventListener("error", () => {
        if (disposed || reconnectTimer !== null) return;
        cursor = stream?.lastEventId ?? cursor;
        stream?.close();
        reconnectAttempts += 1;
        const delay = Math.min(
          WORKSPACE_RECONNECT_MAX_MS,
          WORKSPACE_RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempts - 1, 6),
        );
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      stream?.close();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
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
