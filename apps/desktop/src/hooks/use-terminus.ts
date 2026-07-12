/**
 * Terminus Desktop — Sessions/tasks store + SSE wiring.
 *
 * This hook is the single source of truth for sidebar + conversation
 * state. It loads sessions + tasks, tracks which task is currently
 * selected, and attaches an SSE stream to the active task so the
 * conversation feed updates in real time without re-rendering the
 * whole app per token (per SPEC §25.1 "Batch streaming updates" and
 * "Avoid rerendering the full conversation per token").
 *
 * Per SPEC §25.1: "Prefer event-driven updates. Avoid constant polling."
 *
 * The store is intentionally small: we keep last-known snapshots and
 * an ordered event log per task (capped to avoid unbounded growth).
 * Conversation decoding (turning events into Message/ActivityBlock
 * objects) happens in the component layer — see Conversation.tsx.
 */
import { create } from "zustand";
import { api, TerminusApiError, subscribeEvents, type TerminusEventStream } from "../lib/api";
import type {
  TerminusSseEvent,
  Session,
  Task,
  TaskStatusKind,
} from "../types";

const MAX_EVENTS_PER_TASK = 2000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let streamGeneration = 0;

// ────────────────────────── Status normalization ───────────────────────────

export function normalizeTaskStatus(status: string): TaskStatusKind {
  const s = status.toLowerCase();
  if (s === "active" || s === "running" || s === "verifying" || s === "provider_running") return "working";
  if (s === "pending" && s.length > 0) return "queued";
  if (s === "queued") return "queued";
  if (s === "waiting" || s === "blocked") return "waiting";
  if (s === "needs_approval" || s === "approval_required") return "needs_approval";
  if (s === "needs_review" || s === "review_required") return "needs_review";
  if (s === "failed" || s === "error") return "failed";
  if (s === "interrupted" || s === "cancelled" || s === "canceled") return "interrupted";
  if (s === "completed" || s === "done" || s === "success") return "done";
  return "unknown";
}

// ────────────────────────── Pinned tasks ───────────────────────────────────

const PINS_KEY = "terminus-desktop.pinned-tasks.v1";

function readPins(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(PINS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    // ignore
  }
  return new Set();
}

function writePins(pins: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PINS_KEY, JSON.stringify([...pins]));
  } catch {
    // ignore
  }
}

// ────────────────────────── Store shape ────────────────────────────────────

interface TerminusState {
  // Connection status.
  healthReady: boolean;
  lastError: string | null;
  streamState: "idle" | "connecting" | "connected" | "reconnecting";

  // Sessions + tasks (per-session list).
  sessions: Session[];
  /** sessionId → tasks (most recently updated first). */
  tasksBySession: Record<string, Task[]>;
  /** taskId → task (denormalized for O(1) lookup). */
  taskById: Record<string, Task>;

  // Selection.
  selectedSessionId: string | null;
  selectedTaskId: string | null;

  // Pinned tasks.
  pinnedTaskIds: Set<string>;

  // Drafts per task (Composer spec: "Preserve drafts per task").
  draftsByTask: Record<string, string>;

  // Events per task (capped). Each entry is the raw SSE event.
  eventsByTask: Record<string, TerminusSseEvent[]>;

  // Loading flags.
  loadingSessions: boolean;
  loadingTasksFor: string | null;

  // Actions.
  refreshAll: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshTasks: (sessionId: string) => Promise<void>;
  selectSession: (sessionId: string | null) => void;
  selectTask: (taskId: string | null) => void;
  togglePin: (taskId: string) => void;
  setDraft: (taskId: string, text: string) => void;
  clearDraft: (taskId: string) => void;

  /** Internal: attach SSE stream to selected task. */
  _stream: TerminusEventStream | null;
  _attachStream: (taskId: string | null) => void;
  _appendEvent: (taskId: string, ev: TerminusSseEvent) => void;
  _updateTaskFromEvent: (ev: TerminusSseEvent) => void;
}

export const useTerminusStore = create<TerminusState>((set, get) => ({
  healthReady: false,
  lastError: null,
  streamState: "idle",

  sessions: [],
  tasksBySession: {},
  taskById: {},

  selectedSessionId: null,
  selectedTaskId: null,

  pinnedTaskIds: readPins(),

  draftsByTask: {},
  eventsByTask: {},

  loadingSessions: false,
  loadingTasksFor: null,

  _stream: null,

  refreshAll: async () => {
    await Promise.all([get().refreshSessions()]);
    const sessId = get().selectedSessionId;
    if (sessId) await get().refreshTasks(sessId);
  },

  refreshSessions: async () => {
    set({ loadingSessions: true, lastError: null });
    try {
      const health = await api.health();
      set({ healthReady: health.ready });
    } catch (err) {
      set({ healthReady: false, lastError: err instanceof Error ? err.message : "health check failed" });
    }
    try {
      const res = await api.listSessions();
      set({ sessions: res.sessions, loadingSessions: false });
      // Auto-select the first session if none is selected.
      if (!get().selectedSessionId && res.sessions.length > 0) {
        const first = res.sessions[0];
        if (first) {
          set({ selectedSessionId: first.id });
          void get().refreshTasks(first.id);
        }
      }
    } catch (err) {
      const msg = err instanceof TerminusApiError ? err.message : err instanceof Error ? err.message : "list sessions failed";
      set({ loadingSessions: false, lastError: msg });
    }
  },

  refreshTasks: async (sessionId: string) => {
    set({ loadingTasksFor: sessionId });
    try {
      const res = await api.listTasks(sessionId);
      const tasks = res.tasks;
      set((state) => ({
        tasksBySession: { ...state.tasksBySession, [sessionId]: tasks },
        taskById: { ...state.taskById, ...Object.fromEntries(tasks.map((t) => [t.id, t])) },
        loadingTasksFor: null,
      }));
    } catch (err) {
      const msg = err instanceof TerminusApiError ? err.message : err instanceof Error ? err.message : "list tasks failed";
      set({ loadingTasksFor: null, lastError: msg });
    }
  },

  selectSession: (sessionId) => {
    set({ selectedSessionId: sessionId, selectedTaskId: null });
    // Detach stream when session changes.
    get()._attachStream(null);
    if (sessionId) void get().refreshTasks(sessionId);
  },

  selectTask: (taskId) => {
    set({ selectedTaskId: taskId });
    get()._attachStream(taskId);
  },

  togglePin: (taskId) => {
    const pins = new Set(get().pinnedTaskIds);
    if (pins.has(taskId)) pins.delete(taskId);
    else pins.add(taskId);
    set({ pinnedTaskIds: pins });
    writePins(pins);
  },

  setDraft: (taskId, text) => {
    set((state) => ({ draftsByTask: { ...state.draftsByTask, [taskId]: text } }));
  },

  clearDraft: (taskId) => {
    set((state) => {
      const next = { ...state.draftsByTask };
      delete next[taskId];
      return { draftsByTask: next };
    });
  },

  _appendEvent: (taskId, ev) => {
    set((state) => {
      const existing = state.eventsByTask[taskId] ?? [];
      const next = existing.length >= MAX_EVENTS_PER_TASK
        ? [...existing.slice(existing.length - MAX_EVENTS_PER_TASK + 1), ev]
        : [...existing, ev];
      return { eventsByTask: { ...state.eventsByTask, [taskId]: next } };
    });
  },

  _updateTaskFromEvent: (ev) => {
    // Update task status from task.* events.
    if (!ev.event.startsWith("task.")) return;
    let payload: unknown;
    try {
      payload = JSON.parse(ev.data) as unknown;
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    const taskId = typeof p.task_id === "string" ? p.task_id : typeof p.id === "string" ? p.id : null;
    if (!taskId) return;
    const status = typeof p.status === "string" ? p.status : null;
    const phase = typeof p.phase === "string" ? p.phase : null;
    set((state) => {
      const existing = state.taskById[taskId];
      if (!existing) return {};
      const updated: Task = {
        ...existing,
        status: status ?? existing.status,
        phase: phase ?? existing.phase,
        updated_at: new Date().toISOString(),
      };
      return { taskById: { ...state.taskById, [taskId]: updated } };
    });
  },

  _attachStream: (taskId) => {
    streamGeneration += 1;
    const generation = streamGeneration;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const existing = get()._stream;
    if (existing) {
      existing.close();
      set({ _stream: null, streamState: "idle" });
    }
    if (!taskId) return;
    let attempts = 0;

    const connect = (): void => {
      if (generation !== streamGeneration || get().selectedTaskId !== taskId) return;
      const events = get().eventsByTask[taskId] ?? [];
      const cursor = events.length > 0 ? (events[events.length - 1]?.id ?? null) : null;
      const stream = subscribeEvents({ task_id: taskId, cursor });
      set({ _stream: stream, streamState: attempts > 0 ? "reconnecting" : "connecting" });
      stream.addEventListener("open", () => {
        if (generation !== streamGeneration) return;
        attempts = 0;
        set({ streamState: "connected", lastError: null });
      });
      stream.addEventListener("message", (ev) => {
        if (generation !== streamGeneration) return;
        get()._appendEvent(taskId, ev);
        get()._updateTaskFromEvent(ev);
      });
      stream.addEventListener("error", () => {
        if (generation !== streamGeneration || reconnectTimer) return;
        attempts += 1;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempts - 1, 5));
        set({ streamState: "reconnecting", lastError: "Live updates interrupted. Reconnecting…" });
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      });
    };

    connect();
  },
}));

// ────────────────────────── Convenience hooks ──────────────────────────────

// Zustand's useSyncExternalStore integration requires selector snapshots to
// remain referentially stable when the underlying value is unchanged. Reusing
// these empty collections avoids a render loop before a session/task exists.
const EMPTY_TASKS: Task[] = [];
const EMPTY_EVENTS: TerminusSseEvent[] = [];

/** Tasks for the currently selected session. */
export function useSelectedSessionTasks(): Task[] {
  const sessionId = useTerminusStore((s) => s.selectedSessionId);
  const tasks = useTerminusStore((s) => (sessionId ? s.tasksBySession[sessionId] : undefined) ?? EMPTY_TASKS);
  return tasks;
}

/** Pinned tasks (resolved from ids → Task objects). */
export function usePinnedTasks(): Task[] {
  const pins = useTerminusStore((s) => s.pinnedTaskIds);
  const taskById = useTerminusStore((s) => s.taskById);
  const out: Task[] = [];
  for (const id of pins) {
    const t = taskById[id];
    if (t) out.push(t);
  }
  return out;
}

/** Currently selected task object. */
export function useSelectedTask(): Task | null {
  const id = useTerminusStore((s) => s.selectedTaskId);
  const task = useTerminusStore((s) => (id ? s.taskById[id] : undefined) ?? null);
  return task;
}

/** Events for the currently selected task. */
export function useSelectedTaskEvents(): TerminusSseEvent[] {
  const id = useTerminusStore((s) => s.selectedTaskId);
  const events = useTerminusStore((s) => (id ? s.eventsByTask[id] : undefined) ?? EMPTY_EVENTS);
  return events;
}
