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
 *   - Only tasks that want a human count (see `lifecycleNeedsAttention`);
 *     an agent running normally is not an interruption.
 *   - A task is announced on the transition into needing attention, once.
 *     Whatever was already waiting when the app opened is not news, and a
 *     focused window does not need to be told what it is displaying.
 */
import { useEffect, useMemo, useRef } from "react";

import { useTerminusStore } from "./use-terminus";
import { lifecycleFromTask, lifecycleLabel, lifecycleNeedsAttention, taskTitle } from "../lib/task-lifecycle";
import type { Task } from "../types";

interface AttentionItem {
  readonly id: string;
  readonly title: string;
  readonly label: string;
}

function attentionItems(tasksBySession: Record<string, Task[]>): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const tasks of Object.values(tasksBySession)) {
    for (const task of tasks) {
      const lifecycle = lifecycleFromTask(task);
      if (!lifecycleNeedsAttention(lifecycle)) continue;
      items.push({ id: task.id, title: taskTitle(task), label: lifecycleLabel(lifecycle) });
    }
  }
  return items;
}

export function useNativeAttention(onOpenTask: (taskId: string) => void): void {
  const tasksBySession = useTerminusStore((state) => state.tasksBySession);
  const items = useMemo(() => attentionItems(tasksBySession), [tasksBySession]);

  // null until the first pass, which establishes the baseline rather than
  // announcing it.
  const announcedRef = useRef<Set<string> | null>(null);
  const badgeRef = useRef<number | null>(null);

  useEffect(() => {
    if (badgeRef.current === items.length) return;
    badgeRef.current = items.length;
    void window.terminusDesktop?.setAttentionCount?.(items.length);
  }, [items.length]);

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

  useEffect(() => {
    const subscribe = window.terminusDesktop?.onOpenTask;
    if (!subscribe) return;
    return subscribe(onOpenTask);
  }, [onOpenTask]);
}
