/**
 * Terminus Desktop — what the operator has actually looked at.
 *
 * The rail had no idea. The queue was a pure function of task status,
 * so a task that failed on Tuesday was still in the queue on Friday, having
 * been read, understood and consciously left alone three times. A count that
 * cannot reach zero is not a queue, it is a permanent decoration, and the
 * first thing anyone does with one is stop reading it.
 *
 * The missing half is trivial and standard: remember which version of a task
 * was last seen. A task is unread when it has changed since — the mail model,
 * and it handles the case a boolean cannot, which is a task you read and which
 * then moved again.
 *
 * What this deliberately does NOT do is let reading resolve work. A task
 * blocked on a human stays in the queue after you read it, because reading an
 * approval prompt does not grant the approval. Only outcomes settle. See
 * `taskShelf` in lib/attention.ts for that split.
 */
import { useEffect } from "react";
import { create } from "zustand";

const STORAGE_KEY = "terminus-desktop.task-seen.v1";

/**
 * How many tasks are remembered.
 *
 * Entries are keyed by task id and nothing deletes them, so the map would grow
 * for the life of the install. When it overflows, the oldest *seen* entries go
 * first: a task read months ago going unread again costs one stale row in the
 * inbox, which is the cheapest possible failure here.
 */
const MAX_REMEMBERED = 500;

function readPersisted(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [taskId, seenAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof seenAt === "string") out[taskId] = seenAt;
    }
    return out;
  } catch {
    return {};
  }
}

/** Newest-seen first, capped. */
function prune(entries: Record<string, string>): Record<string, string> {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_REMEMBERED) return entries;
  const kept = keys
    .sort((left, right) => (entries[right] ?? "").localeCompare(entries[left] ?? ""))
    .slice(0, MAX_REMEMBERED);
  const out: Record<string, string> = {};
  for (const key of kept) {
    const value = entries[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function writePersisted(entries: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // A full or blocked storage costs read state, nothing else. The inbox
    // reappears with everything unread, which is noisy but never wrong.
  }
}

interface TaskReadState {
  /** Task id → the `updated_at` that was last read. */
  seenAtByTask: Record<string, string>;
  /** Record that this exact version of the task has been seen. */
  markRead: (taskId: string, updatedAt: string) => void;
  /**
   * Put a task back in the queue. The automatic transition out of Priority has
   * to be reversible, or reading a row by accident silently loses it.
   */
  markUnread: (taskId: string) => void;
  /** Clear a whole group at once, for "Mark all as read". */
  markManyRead: (entries: ReadonlyArray<{ readonly id: string; readonly updatedAt: string }>) => void;
}

export const useTaskReadStore = create<TaskReadState>((set, get) => ({
  seenAtByTask: readPersisted(),
  markRead: (taskId, updatedAt) => {
    if (get().seenAtByTask[taskId] === updatedAt) return;
    const next = prune({ ...get().seenAtByTask, [taskId]: updatedAt });
    set({ seenAtByTask: next });
    writePersisted(next);
  },
  markUnread: (taskId) => {
    if (get().seenAtByTask[taskId] === undefined) return;
    const next = { ...get().seenAtByTask };
    delete next[taskId];
    set({ seenAtByTask: next });
    writePersisted(next);
  },
  markManyRead: (entries) => {
    const current = get().seenAtByTask;
    let changed = false;
    const next = { ...current };
    for (const entry of entries) {
      if (next[entry.id] === entry.updatedAt) continue;
      next[entry.id] = entry.updatedAt;
      changed = true;
    }
    if (!changed) return;
    const pruned = prune(next);
    set({ seenAtByTask: pruned });
    writePersisted(pruned);
  },
}));

/**
 * Keep the open task read while it is open.
 *
 * Marking on selection alone is not enough: a task the operator is watching
 * finishes under their eyes, its `updated_at` moves, and it would pop back
 * into Priority while being read. So this re-marks on every change to the
 * selected task — but only while the window has focus, because a task that
 * completed behind a full-screen editor genuinely has not been seen.
 */
export function useMarkSelectedTaskRead(
  taskId: string | null,
  updatedAt: string | null | undefined,
): void {
  const markRead = useTaskReadStore((state) => state.markRead);
  useEffect(() => {
    if (!taskId || !updatedAt) return;
    if (typeof document !== "undefined" && !document.hasFocus()) {
      // Catch up when the operator comes back to the window.
      const onFocus = (): void => markRead(taskId, updatedAt);
      window.addEventListener("focus", onFocus);
      return () => window.removeEventListener("focus", onFocus);
    }
    markRead(taskId, updatedAt);
    return undefined;
  }, [markRead, taskId, updatedAt]);
}
