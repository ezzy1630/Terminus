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
import { useMemo } from "react";
import { api, TerminusApiError, subscribeEvents, type TerminusEventStream } from "../lib/api";
import { mergePendingApprovals, pendingApprovalFromServerRow, derivePendingApprovals, type PendingApproval } from "../lib/task-surface";
import { sessionLatency } from "../lib/session-latency";
import type {
  TerminusSseEvent,
  HealthResponse,
  Session,
  Task,
  TaskDomainStatus,
  TaskStatusKind,
} from "../types";

const MAX_EVENTS_PER_TASK = 2000;
export const MAX_EVENT_BYTES_PER_TASK = 4 * 1024 * 1024;
export const MAX_EVENT_BYTES_GLOBAL = 32 * 1024 * 1024;
export const MAX_PENDING_EVENT_BYTES_GLOBAL = 2 * 1024 * 1024;
export const MAX_PRESENTATION_EVENT_CHARS = 128 * 1024;
export const PRESENTATION_REJECTION_KEY = "terminus_presentation_rejection";
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const EVENT_BATCH_MS = 50;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let streamGeneration = 0;
let sessionsRequestGeneration = 0;
let sessionsPageRequestGeneration = 0;
const taskListRequestGenerationBySession = new Map<string, number>();
const taskPageRequestGenerationBySession = new Map<string, number>();
const taskRequestGenerationById = new Map<string, number>();
const approvalRequestGenerationByTask = new Map<string, number>();
const approvalPageRequestGenerationByTask = new Map<string, number>();
interface PendingPresentationEvent {
  readonly event: TerminusSseEvent;
  readonly bytes: number;
}
const pendingEventsByTask = new Map<string, PendingPresentationEvent[]>();
const pendingEventBytesByTask = new Map<string, number>();
const resumeCursorByTask = new Map<string, string>();
let pendingEventBytesGlobal = 0;
const pendingEventDropsByTask = new Map<string, { count: number; throughCursor: string | null }>();
const pendingApprovalRefreshTasks = new Set<string>();
const eventIdsByTask = new Map<string, Set<string>>();
let eventFlushScheduled = false;
const EVENT_TEXT_ENCODER = new TextEncoder();

/** Exact retained UTF-8 presentation cost for one bounded SSE envelope. */
export function presentationEventByteLength(event: TerminusSseEvent): number {
  return EVENT_TEXT_ENCODER.encode(event.id).byteLength
    + EVENT_TEXT_ENCODER.encode(event.event).byteLength
    + EVENT_TEXT_ENCODER.encode(event.data).byteLength;
}

function notePendingEventDrop(taskId: string, event: TerminusSseEvent): void {
  const prior = pendingEventDropsByTask.get(taskId);
  pendingEventDropsByTask.set(taskId, {
    count: (prior?.count ?? 0) + 1,
    throughCursor: event.id || prior?.throughCursor || null,
  });
  if (event.id) eventIdsByTask.get(taskId)?.delete(event.id);
}

function dropOldestPendingEvent(taskId: string): boolean {
  const queue = pendingEventsByTask.get(taskId);
  const dropped = queue?.shift();
  if (!dropped) return false;
  const nextTaskBytes = Math.max(0, (pendingEventBytesByTask.get(taskId) ?? 0) - dropped.bytes);
  pendingEventBytesGlobal = Math.max(0, pendingEventBytesGlobal - dropped.bytes);
  if (queue && queue.length > 0) {
    pendingEventBytesByTask.set(taskId, nextTaskBytes);
  } else {
    pendingEventsByTask.delete(taskId);
    pendingEventBytesByTask.delete(taskId);
  }
  notePendingEventDrop(taskId, dropped.event);
  return true;
}

function nextKeyedGeneration(generations: Map<string, number>, key: string): number {
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return next;
}

function isCurrentKeyedGeneration(
  generations: Map<string, number>,
  key: string,
  generation: number,
): boolean {
  return generations.get(key) === generation;
}

/**
 * Keep untrusted SSE payloads out of renderer state when they exceed the
 * presentation budget. The cursor and event kind remain intact so replay,
 * approval reconciliation, and terminal task transitions still advance.
 */
export function boundPresentationEvent(ev: TerminusSseEvent): TerminusSseEvent {
  if (ev.data.length <= MAX_PRESENTATION_EVENT_CHARS) return ev;
  return {
    ...ev,
    data: JSON.stringify({
      [PRESENTATION_REJECTION_KEY]: {
        reason: "event_payload_too_large",
        source_event: ev.event,
        character_count: ev.data.length,
        limit: MAX_PRESENTATION_EVENT_CHARS,
      },
    }),
  };
}

const TASK_DOMAIN_STATUSES: ReadonlySet<string> = new Set([
  "DRAFT", "ACTIVE", "NEEDS_USER_DECISION", "BLOCKED", "VERIFYING", "COMPLETED",
  "FAILED", "FAILED_VERIFICATION", "BUDGET_EXHAUSTED", "POLICY_DENIED", "ABORTED",
]);

function isTaskDomainStatus(value: unknown): value is TaskDomainStatus {
  return typeof value === "string" && TASK_DOMAIN_STATUSES.has(value);
}

export interface EventHistoryBoundary {
  readonly reason: "bounded_window" | "global_lru" | "cursor_expired";
  readonly omittedCount: number | null;
  readonly droppedThroughCursor: string | null;
  readonly continuationCursor: string | null;
  readonly snapshotUrl: string | null;
  readonly reconciliation: "pending" | "ready" | "error";
  readonly error: string | null;
  readonly globalEvictedCount?: number;
}

export interface ResourceFreshness {
  readonly status: "idle" | "loading" | "ready" | "stale" | "error";
  readonly error: string | null;
}

export interface CollectionPageState {
  readonly nextCursor: string | null;
  readonly total: number | null;
  readonly loadingMore: boolean;
  readonly error: string | null;
}

function initialCollectionPage(): CollectionPageState {
  return { nextCursor: null, total: null, loadingMore: false, error: null };
}

function mergeById<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  compare: (left: T, right: T) => number,
): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return Array.from(byId.values()).sort(compare);
}

function collectionPageIsComplete(
  loadedCount: number,
  nextCursor: string | null,
  total: number | null,
): boolean {
  return nextCursor === null && (total === null || loadedCount >= total);
}

const compareSessions = (left: Session, right: Session): number =>
  right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id);
const compareTasks = (left: Task, right: Task): number =>
  right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id);
const compareApprovals = (left: PendingApproval, right: PendingApproval): number =>
  (right.requestedAt ?? "").localeCompare(left.requestedAt ?? "") || left.id.localeCompare(right.id);

function settleCursorBoundary(
  boundaries: Record<string, EventHistoryBoundary>,
  taskId: string,
  reconciliation: "ready" | "error",
  error: string | null,
): Record<string, EventHistoryBoundary> {
  const boundary = boundaries[taskId];
  if (!boundary || boundary.reason !== "cursor_expired" || boundary.reconciliation !== "pending") {
    return boundaries;
  }
  return {
    ...boundaries,
    [taskId]: { ...boundary, reconciliation, error },
  };
}

function omitTaskKeys<T>(record: Record<string, T>, taskIds: readonly string[]): Record<string, T> {
  if (taskIds.length === 0) return record;
  const next = { ...record };
  for (const taskId of taskIds) delete next[taskId];
  return next;
}

function clearTaskRuntimeCaches(taskId: string): void {
  const pendingBytes = pendingEventBytesByTask.get(taskId) ?? 0;
  pendingEventBytesGlobal = Math.max(0, pendingEventBytesGlobal - pendingBytes);
  pendingEventsByTask.delete(taskId);
  pendingEventBytesByTask.delete(taskId);
  pendingEventDropsByTask.delete(taskId);
  pendingApprovalRefreshTasks.delete(taskId);
  eventIdsByTask.delete(taskId);
  resumeCursorByTask.delete(taskId);
}

// ────────────────────────── Status normalization ───────────────────────────

export function normalizeTaskStatus(status: string): TaskStatusKind {
  const s = status.toLowerCase();
  if (s === "active" || s === "running" || s === "verifying" || s === "provider_running") return "working";
  if (s === "draft" || s === "pending" || s === "queued") return "queued";
  if (s === "needs_user_decision" || s === "waiting" || s === "blocked") return "waiting";
  if (s === "needs_approval" || s === "approval_required") return "needs_approval";
  if (s === "needs_review" || s === "review_required") return "needs_review";
  if (s === "failed" || s === "failed_verification" || s === "budget_exhausted" || s === "policy_denied" || s === "error") return "failed";
  if (s === "aborted" || s === "interrupted" || s === "cancelled" || s === "canceled") return "interrupted";
  if (s === "completed" || s === "done" || s === "success") return "done";
  return "unknown";
}

// ────────────────────────── Pinned tasks ───────────────────────────────────

const PINS_KEY = "terminus-desktop.pinned-tasks.v1";
const DRAFTS_KEY = "terminus-desktop.drafts.v1";
const MAX_PINNED_TASKS = 50;
const PIN_HYDRATION_CONCURRENCY = 4;
export const MAX_DRAFT_BYTES = 16 * 1024;
const MAX_DRAFT_COUNT = 100;
const MAX_DRAFT_BYTES_TOTAL = 512 * 1024;
const MAX_SESSION_DRAFT_COUNT = 25;
const MAX_SESSION_DRAFT_BYTES_TOTAL = 256 * 1024;
const UTF8_ENCODER = new TextEncoder();

export interface DraftPersistenceState {
  readonly status: "saved" | "session_only" | "rejected";
  readonly error: string | null;
}

interface DraftHydrationState {
  readonly drafts: Record<string, string>;
  readonly error: string | null;
}

export function draftByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).byteLength;
}

export function validateDraftCollection(drafts: Record<string, string>): string | null {
  const entries = Object.entries(drafts);
  if (entries.length > MAX_DRAFT_COUNT) return `Only ${MAX_DRAFT_COUNT} local drafts can be retained.`;
  let totalBytes = 0;
  for (const [taskId, text] of entries) {
    if (taskId.length === 0) return "A local draft had an empty task identity.";
    const bytes = draftByteLength(text);
    if (bytes > MAX_DRAFT_BYTES) {
      return `A draft exceeded the ${MAX_DRAFT_BYTES}-byte local limit.`;
    }
    totalBytes += bytes;
    if (totalBytes > MAX_DRAFT_BYTES_TOTAL) {
      return `Local drafts exceeded the ${MAX_DRAFT_BYTES_TOTAL}-byte aggregate limit.`;
    }
  }
  return null;
}

function validateSessionDraftCollection(drafts: Record<string, string>): string | null {
  const entries = Object.entries(drafts);
  if (entries.length > MAX_SESSION_DRAFT_COUNT) {
    return `Only ${MAX_SESSION_DRAFT_COUNT} additional session-only drafts can be retained.`;
  }
  let totalBytes = 0;
  for (const text of Object.values(drafts)) {
    const bytes = draftByteLength(text);
    if (bytes > MAX_DRAFT_BYTES) return `A session-only draft exceeded ${MAX_DRAFT_BYTES} bytes.`;
    totalBytes += bytes;
    if (totalBytes > MAX_SESSION_DRAFT_BYTES_TOTAL) {
      return `Session-only drafts exceeded ${MAX_SESSION_DRAFT_BYTES_TOTAL} bytes.`;
    }
  }
  return null;
}

function draftStorageError(error: unknown, action: "read" | "write"): string {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return "Local draft storage is full.";
  }
  return action === "read"
    ? "Saved drafts could not be read from local storage."
    : "This draft is only available until this window closes because local storage is unavailable.";
}

function readDrafts(): DraftHydrationState {
  if (typeof window === "undefined") return { drafts: {}, error: "Local draft storage is unavailable." };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { drafts: {}, error: "Saved drafts had an invalid local format and were not admitted." };
    }
    const entries = Object.entries(parsed);
    if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
      return { drafts: {}, error: "Saved drafts had an invalid local format and were not admitted." };
    }
    const drafts = Object.fromEntries(entries);
    const validationError = validateDraftCollection(drafts);
    return validationError
      ? { drafts: {}, error: validationError }
      : { drafts, error: null };
  } catch (error) {
    return { drafts: {}, error: draftStorageError(error, "read") };
  }
}

function writeDrafts(drafts: Record<string, string>): DraftPersistenceState {
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    return { status: "saved", error: null };
  } catch (error) {
    return { status: "session_only", error: draftStorageError(error, "write") };
  }
}

const hydratedDrafts = readDrafts();

interface PinHydrationState {
  readonly pins: Set<string>;
  readonly error: string | null;
}

function readPins(): PinHydrationState {
  if (typeof window === "undefined") return { pins: new Set(), error: "Local pin storage is unavailable." };
  try {
    const raw = window.localStorage.getItem(PINS_KEY);
    if (!raw) return { pins: new Set(), error: null };
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value): value is string => typeof value === "string" && value.length > 0)) {
      return { pins: new Set(), error: "Saved pins had an invalid local format and were not admitted." };
    }
    const pins = new Set(parsed);
    if (pins.size > MAX_PINNED_TASKS) {
      return { pins: new Set(), error: `Saved pins exceeded the ${MAX_PINNED_TASKS}-task local limit and were not admitted.` };
    }
    return { pins, error: null };
  } catch {
    return { pins: new Set(), error: "Saved pins could not be read from local storage." };
  }
}

function writePins(pins: Set<string>): string | null {
  if (typeof window === "undefined") return "Local pin storage is unavailable.";
  try {
    window.localStorage.setItem(PINS_KEY, JSON.stringify([...pins]));
    return null;
  } catch {
    return "Pin changes are only available until this window closes because local storage is unavailable.";
  }
}

const hydratedPins = readPins();

// ────────────────────────── Store shape ────────────────────────────────────

interface TerminusState {
  // Connection status.
  healthReady: boolean;
  healthStatus: "unknown" | "ready" | "degraded" | "offline";
  healthDetail: string | null;
  lastError: string | null;
  streamState: "idle" | "connecting" | "connected" | "reconnecting";

  // Sessions + tasks (per-session list).
  sessions: Session[];
  /** sessionId → tasks (most recently updated first). */
  tasksBySession: Record<string, Task[]>;
  /** taskId → task (denormalized for O(1) lookup). */
  taskById: Record<string, Task>;
  sessionsFreshness: ResourceFreshness;
  taskListFreshnessBySession: Record<string, ResourceFreshness>;
  taskFreshnessById: Record<string, ResourceFreshness>;
  sessionsPage: CollectionPageState;
  taskPagesBySession: Record<string, CollectionPageState>;

  // Selection.
  selectedSessionId: string | null;
  selectedTaskId: string | null;

  // Pinned tasks.
  pinnedTaskIds: Set<string>;
  pinPersistenceError: string | null;

  // Drafts per task (Composer spec: "Preserve drafts per task").
  draftsByTask: Record<string, string>;
  /** Drafts retained only in this renderer when the durable collection is full. */
  sessionDraftsByTask: Record<string, string>;
  draftPersistenceByTask: Record<string, DraftPersistenceState>;
  draftStorageError: string | null;

  // Events per task (capped). Each entry is the raw SSE event.
  eventsByTask: Record<string, TerminusSseEvent[]>;
  /** Retained UTF-8 presentation bytes, kept in lockstep with eventsByTask. */
  eventBytesByTask: Record<string, number>;
  /** Monotonic recency used for deterministic inactive-task eviction. */
  eventLruTickByTask: Record<string, number>;
  eventLruClock: number;
  /** Latest accepted server cursor, independent of the presentation window. */
  resumeCursorByTask: Record<string, string>;
  /** Explicit boundary metadata for the bounded presentation event window. */
  eventHistoryByTask: Record<string, EventHistoryBoundary>;

  // Server-side pending approvals per task, reconciled from GET /v1/approvals
  // and merged with event-derived entries at render time.
  approvalsByTask: Record<string, PendingApproval[]>;
  approvalFreshnessByTask: Record<string, { status: "loading" | "ready" | "stale" | "error"; error: string | null }>;
  approvalPagesByTask: Record<string, CollectionPageState>;

  // Loading flags.
  loadingSessions: boolean;
  loadingTasksFor: string | null;

  // Actions.
  refreshAll: () => Promise<void>;
  refreshPinnedTasks: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  refreshTasks: (sessionId: string) => Promise<void>;
  loadMoreTasks: (sessionId: string) => Promise<void>;
  refreshTask: (taskId: string) => Promise<void>;
  selectSession: (sessionId: string | null) => void;
  selectTask: (taskId: string | null, cursor?: string | null) => void;
  refreshApprovals: (taskId: string) => Promise<void>;
  loadMoreApprovals: (taskId: string) => Promise<void>;
  acknowledgeApprovalResolution: (taskId: string, approvalId: string) => void;
  togglePin: (taskId: string) => void;
  setDraft: (taskId: string, text: string, source?: "external" | "composer") => DraftPersistenceState;
  clearDraft: (taskId: string) => void;
  retryDraftPersistence: (taskId: string) => DraftPersistenceState;
  retryDraftHydration: () => DraftPersistenceState;
  resetDraftStorage: () => DraftPersistenceState;

  /** Internal: attach SSE stream to selected task. */
  _stream: TerminusEventStream | null;
  _attachStream: (taskId: string | null, initialCursor?: string | null) => void;
  /** Returns false when the event id was already accepted for this task. */
  _appendEvent: (taskId: string, ev: TerminusSseEvent) => boolean;
  _updateTaskFromEvent: (ev: TerminusSseEvent, streamTaskId?: string) => void;
}

export const useTerminusStore = create<TerminusState>((set, get) => ({
  healthReady: false,
  healthStatus: "unknown",
  healthDetail: null,
  lastError: null,
  streamState: "idle",

  sessions: [],
  tasksBySession: {},
  taskById: {},
  sessionsFreshness: { status: "idle", error: null },
  taskListFreshnessBySession: {},
  taskFreshnessById: {},
  sessionsPage: initialCollectionPage(),
  taskPagesBySession: {},

  selectedSessionId: null,
  selectedTaskId: null,

  pinnedTaskIds: hydratedPins.pins,
  pinPersistenceError: hydratedPins.error,

  draftsByTask: hydratedDrafts.drafts,
  sessionDraftsByTask: {},
  draftPersistenceByTask: {},
  draftStorageError: hydratedDrafts.error,
  eventsByTask: {},
  eventBytesByTask: {},
  eventLruTickByTask: {},
  eventLruClock: 0,
  resumeCursorByTask: {},
  eventHistoryByTask: {},
  approvalsByTask: {},
  approvalFreshnessByTask: {},
  approvalPagesByTask: {},

  loadingSessions: false,
  loadingTasksFor: null,

  _stream: null,

  refreshAll: async () => {
    await get().refreshSessions();
    const sessId = get().selectedSessionId;
    if (sessId) await get().refreshTasks(sessId);
    await get().refreshPinnedTasks();
    const taskId = get().selectedTaskId;
    if (taskId) await Promise.all([get().refreshTask(taskId), get().refreshApprovals(taskId)]);
  },

  refreshPinnedTasks: async () => {
    const taskIds = [...get().pinnedTaskIds].filter((taskId) => taskId !== get().selectedTaskId);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < taskIds.length) {
        const index = nextIndex;
        nextIndex += 1;
        const taskId = taskIds[index];
        if (!taskId || taskId === get().selectedTaskId || !get().pinnedTaskIds.has(taskId)) continue;
        await get().refreshTask(taskId);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PIN_HYDRATION_CONCURRENCY, taskIds.length) }, () => worker()),
    );
  },

  refreshSessions: async () => {
    const requestGeneration = ++sessionsRequestGeneration;
    sessionsPageRequestGeneration += 1;
    const isCurrent = (): boolean => sessionsRequestGeneration === requestGeneration;
    set((state) => ({
      loadingSessions: true,
      lastError: null,
      sessionsFreshness: { status: "loading", error: null },
      sessionsPage: {
        ...state.sessionsPage,
        nextCursor: null,
        loadingMore: false,
        error: null,
      },
    }));
    try {
      const health: HealthResponse = await api.health();
      if (!isCurrent()) return;
      const kernelState = health.kernel?.status ?? health.status;
      set({
        healthReady: health.ready,
        healthStatus: health.ready ? "ready" : "degraded",
        healthDetail: health.ready ? null : `kernel status ${kernelState}`,
      });
    } catch (err) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : "health check failed";
      set({ healthReady: false, healthStatus: "offline", healthDetail: message, lastError: message });
    }
    try {
      const res = await api.listSessions();
      if (!isCurrent()) return;
      let selectionInvalidated = false;
      const removedTaskIds: string[] = [];
      set((state) => {
        const partialPage = !collectionPageIsComplete(
          res.sessions.length,
          res.next_cursor,
          res.total,
        );
        const protectedSessionIds = new Set<string>();
        if (state.selectedSessionId) protectedSessionIds.add(state.selectedSessionId);
        const selectedTask = state.selectedTaskId ? state.taskById[state.selectedTaskId] : undefined;
        if (state.selectedTaskId && !selectedTask) selectionInvalidated = true;
        if (selectedTask) protectedSessionIds.add(selectedTask.session_id);
        for (const [sessionId, sessionTasks] of Object.entries(state.tasksBySession)) {
          if (sessionTasks.some((task) => state.pinnedTaskIds.has(task.id))) protectedSessionIds.add(sessionId);
        }
        const firstPageIds = new Set(res.sessions.map((session) => session.id));
        const protectedContinuationSessions = partialPage
          ? state.sessions.filter((session) => protectedSessionIds.has(session.id) && !firstPageIds.has(session.id))
          : [];
        // A first-page refresh is authoritative for that page, not for rows
        // behind its continuation cursor. Retain selected and pinned
        // continuation entities so refresh cannot eject active work or pins.
        const sessions = protectedContinuationSessions.length > 0
          ? mergeById(res.sessions, protectedContinuationSessions, compareSessions)
          : res.sessions;
        const sessionIds = new Set(sessions.map((session) => session.id));
        const selectedTaskSessionId = selectedTask && sessionIds.has(selectedTask.session_id)
          ? selectedTask.session_id
          : null;
        const nextSelectedSessionId = selectedTaskSessionId
          ?? (state.selectedSessionId && sessionIds.has(state.selectedSessionId)
          ? state.selectedSessionId
          : sessions[0]?.id ?? null);
        const tasksBySession = { ...state.tasksBySession };
        const taskById = { ...state.taskById };
        for (const previousSession of state.sessions) {
          if (!sessionIds.has(previousSession.id)) {
            for (const task of tasksBySession[previousSession.id] ?? []) {
              if (state.selectedTaskId === task.id) selectionInvalidated = true;
              removedTaskIds.push(task.id);
              delete taskById[task.id];
              nextKeyedGeneration(taskRequestGenerationById, task.id);
              nextKeyedGeneration(approvalRequestGenerationByTask, task.id);
              nextKeyedGeneration(approvalPageRequestGenerationByTask, task.id);
            }
            delete tasksBySession[previousSession.id];
            nextKeyedGeneration(taskListRequestGenerationBySession, previousSession.id);
            nextKeyedGeneration(taskPageRequestGenerationBySession, previousSession.id);
          }
        }

        return {
          sessions,
          tasksBySession,
          taskById,
          taskFreshnessById: omitTaskKeys(state.taskFreshnessById, removedTaskIds),
          eventsByTask: omitTaskKeys(state.eventsByTask, removedTaskIds),
          eventBytesByTask: omitTaskKeys(state.eventBytesByTask, removedTaskIds),
          eventLruTickByTask: omitTaskKeys(state.eventLruTickByTask, removedTaskIds),
          resumeCursorByTask: omitTaskKeys(state.resumeCursorByTask, removedTaskIds),
          eventHistoryByTask: omitTaskKeys(state.eventHistoryByTask, removedTaskIds),
          approvalsByTask: omitTaskKeys(state.approvalsByTask, removedTaskIds),
          approvalFreshnessByTask: omitTaskKeys(state.approvalFreshnessByTask, removedTaskIds),
          approvalPagesByTask: omitTaskKeys(state.approvalPagesByTask, removedTaskIds),
          selectedSessionId: nextSelectedSessionId,
          selectedTaskId: selectionInvalidated ? null : state.selectedTaskId,
          loadingSessions: false,
          sessionsFreshness: { status: "ready", error: null },
          sessionsPage: {
            nextCursor: res.next_cursor,
            total: res.total,
            loadingMore: false,
            error: null,
          },
        };
      });
      for (const taskId of removedTaskIds) clearTaskRuntimeCaches(taskId);
      if (selectionInvalidated) get()._attachStream(null);
    } catch (err) {
      if (!isCurrent()) return;
      const msg = err instanceof TerminusApiError ? err.message : err instanceof Error ? err.message : "list sessions failed";
      set((state) => ({
        loadingSessions: false,
        lastError: msg,
        sessionsFreshness: {
          status: state.sessions.length > 0 ? "stale" : "error",
          error: msg,
        },
        sessionsPage: { ...state.sessionsPage, loadingMore: false, error: msg },
      }));
    }
  },

  loadMoreSessions: async () => {
    const cursor = get().sessionsPage.nextCursor;
    if (!cursor || get().sessionsPage.loadingMore) return;
    const requestGeneration = ++sessionsPageRequestGeneration;
    const isCurrent = (): boolean => sessionsPageRequestGeneration === requestGeneration;
    set((state) => ({
      sessionsPage: { ...state.sessionsPage, loadingMore: true, error: null },
    }));
    try {
      const res = await api.listSessions({ cursor });
      if (!isCurrent()) return;
      set((state) => ({
        sessions: mergeById(state.sessions, res.sessions, compareSessions),
        sessionsPage: {
          nextCursor: res.next_cursor,
          total: res.total,
          loadingMore: false,
          error: null,
        },
      }));
    } catch (error: unknown) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : "Could not load more projects";
      set((state) => ({
        sessionsPage: { ...state.sessionsPage, loadingMore: false, error: message },
      }));
    }
  },

  refreshTasks: async (sessionId: string) => {
    const requestGeneration = nextKeyedGeneration(taskListRequestGenerationBySession, sessionId);
    nextKeyedGeneration(taskPageRequestGenerationBySession, sessionId);
    const isCurrent = (): boolean => isCurrentKeyedGeneration(
      taskListRequestGenerationBySession,
      sessionId,
      requestGeneration,
    );
    set((state) => ({
      loadingTasksFor: sessionId,
      taskListFreshnessBySession: {
        ...state.taskListFreshnessBySession,
        [sessionId]: { status: "loading", error: null },
      },
      taskPagesBySession: {
        ...state.taskPagesBySession,
        [sessionId]: {
          ...(state.taskPagesBySession[sessionId] ?? initialCollectionPage()),
          nextCursor: null,
          loadingMore: false,
          error: null,
        },
      },
    }));
    try {
      const res = await api.listTasks(sessionId);
      if (!isCurrent()) return;
      const tasks = res.tasks;
      let removedSelectedTask = false;
      const removedTaskIds: string[] = [];
      set((state) => {
        const priorTasks = state.tasksBySession[sessionId] ?? [];
        const partialPage = !collectionPageIsComplete(
          tasks.length,
          res.next_cursor,
          res.total,
        );
        const firstPageTaskIds = new Set(tasks.map((task) => task.id));
        const protectedContinuationTasks = partialPage
          ? priorTasks.filter((task) =>
              !firstPageTaskIds.has(task.id)
              && (task.id === state.selectedTaskId || state.pinnedTaskIds.has(task.id)))
          : [];
        const visibleTasks = protectedContinuationTasks.length > 0
          ? mergeById(tasks, protectedContinuationTasks, compareTasks)
          : tasks;
        const nextTaskIds = new Set(visibleTasks.map((task) => task.id));
        const taskById = { ...state.taskById };
        for (const previousTask of priorTasks) {
          if (!nextTaskIds.has(previousTask.id)) {
            removedTaskIds.push(previousTask.id);
            delete taskById[previousTask.id];
            nextKeyedGeneration(taskRequestGenerationById, previousTask.id);
            nextKeyedGeneration(approvalRequestGenerationByTask, previousTask.id);
            nextKeyedGeneration(approvalPageRequestGenerationByTask, previousTask.id);
            if (state.selectedTaskId === previousTask.id) removedSelectedTask = true;
          }
        }
        for (const task of visibleTasks) taskById[task.id] = task;
        return {
          tasksBySession: { ...state.tasksBySession, [sessionId]: visibleTasks },
          taskById,
          taskFreshnessById: omitTaskKeys(state.taskFreshnessById, removedTaskIds),
          eventsByTask: omitTaskKeys(state.eventsByTask, removedTaskIds),
          eventBytesByTask: omitTaskKeys(state.eventBytesByTask, removedTaskIds),
          eventLruTickByTask: omitTaskKeys(state.eventLruTickByTask, removedTaskIds),
          resumeCursorByTask: omitTaskKeys(state.resumeCursorByTask, removedTaskIds),
          eventHistoryByTask: omitTaskKeys(state.eventHistoryByTask, removedTaskIds),
          approvalsByTask: omitTaskKeys(state.approvalsByTask, removedTaskIds),
          approvalFreshnessByTask: omitTaskKeys(state.approvalFreshnessByTask, removedTaskIds),
          approvalPagesByTask: omitTaskKeys(state.approvalPagesByTask, removedTaskIds),
          selectedTaskId: removedSelectedTask ? null : state.selectedTaskId,
          loadingTasksFor: state.loadingTasksFor === sessionId ? null : state.loadingTasksFor,
          taskListFreshnessBySession: {
            ...state.taskListFreshnessBySession,
            [sessionId]: { status: "ready", error: null },
          },
          taskPagesBySession: {
            ...state.taskPagesBySession,
            [sessionId]: {
              nextCursor: res.next_cursor,
              total: res.total,
              loadingMore: false,
              error: null,
            },
          },
        };
      });
      for (const taskId of removedTaskIds) clearTaskRuntimeCaches(taskId);
      if (removedSelectedTask) get()._attachStream(null);
    } catch (err) {
      if (!isCurrent()) return;
      const msg = err instanceof TerminusApiError ? err.message : err instanceof Error ? err.message : "list tasks failed";
      set((state) => ({
        loadingTasksFor: state.loadingTasksFor === sessionId ? null : state.loadingTasksFor,
        lastError: msg,
        taskListFreshnessBySession: {
          ...state.taskListFreshnessBySession,
          [sessionId]: {
            status: (state.tasksBySession[sessionId]?.length ?? 0) > 0 ? "stale" : "error",
            error: msg,
          },
        },
        taskPagesBySession: {
          ...state.taskPagesBySession,
          [sessionId]: {
            ...(state.taskPagesBySession[sessionId] ?? initialCollectionPage()),
            loadingMore: false,
            error: msg,
          },
        },
      }));
    }
  },

  loadMoreTasks: async (sessionId: string) => {
    const page = get().taskPagesBySession[sessionId];
    if (!page || !page.nextCursor || page.loadingMore) return;
    const cursor = page.nextCursor;
    const requestGeneration = nextKeyedGeneration(taskPageRequestGenerationBySession, sessionId);
    const isCurrent = (): boolean => isCurrentKeyedGeneration(
      taskPageRequestGenerationBySession,
      sessionId,
      requestGeneration,
    );
    set((state) => ({
      taskPagesBySession: {
        ...state.taskPagesBySession,
        [sessionId]: { ...page, loadingMore: true, error: null },
      },
    }));
    try {
      const res = await api.listTasks(sessionId, { cursor });
      if (!isCurrent()) return;
      set((state) => {
        const tasks = mergeById(state.tasksBySession[sessionId] ?? [], res.tasks, compareTasks);
        const taskById = { ...state.taskById };
        for (const task of tasks) taskById[task.id] = task;
        return {
          tasksBySession: { ...state.tasksBySession, [sessionId]: tasks },
          taskById,
          taskPagesBySession: {
            ...state.taskPagesBySession,
            [sessionId]: {
              nextCursor: res.next_cursor,
              total: res.total,
              loadingMore: false,
              error: null,
            },
          },
        };
      });
    } catch (error: unknown) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : "Could not load more tasks";
      set((state) => ({
        taskPagesBySession: {
          ...state.taskPagesBySession,
          [sessionId]: {
            ...(state.taskPagesBySession[sessionId] ?? initialCollectionPage()),
            loadingMore: false,
            error: message,
          },
        },
      }));
    }
  },

  refreshTask: async (taskId: string) => {
    const requestGeneration = nextKeyedGeneration(taskRequestGenerationById, taskId);
    const isCurrent = (): boolean => isCurrentKeyedGeneration(
      taskRequestGenerationById,
      taskId,
      requestGeneration,
    );
    set((state) => ({
      taskFreshnessById: {
        ...state.taskFreshnessById,
        [taskId]: { status: "loading", error: null },
      },
    }));
    try {
      const task = await api.getTask(taskId);
      if (!isCurrent()) return;
      let ownerSession = get().sessions.find((session) => session.id === task.session_id) ?? null;
      if (!ownerSession) {
        try {
          ownerSession = await api.getSession(task.session_id);
        } catch {
          // The task remains useful in the Pinned section even if its owner
          // session cannot be hydrated yet. A later sessions refresh retries.
        }
      }
      if (!isCurrent()) return;
      set((state) => {
        const approvalsReady = state.approvalFreshnessByTask[taskId]?.status === "ready";
        return {
          sessions: ownerSession
            ? mergeById(state.sessions, [ownerSession], compareSessions)
            : state.sessions,
          taskById: { ...state.taskById, [task.id]: task },
          ...(state.selectedTaskId === task.id ? { selectedSessionId: task.session_id } : {}),
          tasksBySession: {
            ...state.tasksBySession,
            [task.session_id]: mergeById(state.tasksBySession[task.session_id] ?? [], [task], compareTasks),
          },
          taskFreshnessById: {
            ...state.taskFreshnessById,
            [taskId]: { status: "ready", error: null },
          },
          eventHistoryByTask: approvalsReady
            ? settleCursorBoundary(state.eventHistoryByTask, taskId, "ready", null)
            : state.eventHistoryByTask,
        };
      });
    } catch (err) {
      if (!isCurrent()) return;
      const msg = err instanceof TerminusApiError ? err.message : err instanceof Error ? err.message : "get task failed";
      const missingPinnedTask = err instanceof TerminusApiError
        && err.status === 404
        && get().pinnedTaskIds.has(taskId);
      if (missingPinnedTask) {
        const pins = new Set(get().pinnedTaskIds);
        pins.delete(taskId);
        const pinPersistenceError = writePins(pins);
        const wasSelected = get().selectedTaskId === taskId;
        set((state) => ({
          pinnedTaskIds: pins,
          pinPersistenceError,
          selectedTaskId: wasSelected ? null : state.selectedTaskId,
          taskFreshnessById: omitTaskKeys(state.taskFreshnessById, [taskId]),
          lastError: msg,
        }));
        if (wasSelected) get()._attachStream(null);
        return;
      }
      set((state) => ({
        lastError: msg,
        taskFreshnessById: {
          ...state.taskFreshnessById,
          [taskId]: {
            status: state.taskById[taskId] ? "stale" : "error",
            error: msg,
          },
        },
        eventHistoryByTask: settleCursorBoundary(state.eventHistoryByTask, taskId, "error", msg),
      }));
    }
  },

  selectSession: (sessionId) => {
    if (sessionId === get().selectedSessionId) {
      if (sessionId) void get().refreshTasks(sessionId);
      return;
    }
    set({ selectedSessionId: sessionId, selectedTaskId: null });
    // Detach stream when session changes.
    get()._attachStream(null);
    if (sessionId) void get().refreshTasks(sessionId);
  },

  selectTask: (taskId, cursor = null) => {
    const selected = taskId ? get().taskById[taskId] : undefined;
    set((state) => {
      const nextClock = taskId ? state.eventLruClock + 1 : state.eventLruClock;
      return {
        selectedTaskId: taskId,
        ...(selected ? { selectedSessionId: selected.session_id } : {}),
        ...(taskId ? {
          taskFreshnessById: {
            ...state.taskFreshnessById,
            [taskId]: { status: "loading", error: null },
          },
          eventLruClock: nextClock,
          eventLruTickByTask: {
            ...state.eventLruTickByTask,
            [taskId]: nextClock,
          },
        } : {}),
      };
    });
    if (taskId) {
      void get().refreshTask(taskId);
      void get().refreshApprovals(taskId);
    }
    get()._attachStream(taskId, cursor);
  },

  /**
   * Reconcile pending approvals from the control plane. SSE events carry
   * rich context but can be missed across reconnects; the server list is
   * the existence source of truth. Event-derived detail is merged at
   * render time (see mergePendingApprovals).
   */
  refreshApprovals: async (taskId) => {
    const requestGeneration = nextKeyedGeneration(approvalRequestGenerationByTask, taskId);
    nextKeyedGeneration(approvalPageRequestGenerationByTask, taskId);
    const isCurrent = (): boolean => isCurrentKeyedGeneration(
      approvalRequestGenerationByTask,
      taskId,
      requestGeneration,
    );
    set((state) => ({
      approvalFreshnessByTask: {
        ...state.approvalFreshnessByTask,
        [taskId]: { status: "loading", error: null },
      },
      approvalPagesByTask: {
        ...state.approvalPagesByTask,
        [taskId]: {
          ...(state.approvalPagesByTask[taskId] ?? initialCollectionPage()),
          nextCursor: null,
          loadingMore: false,
          error: null,
        },
      },
    }));
    try {
      const res = await api.listApprovals(taskId);
      if (!isCurrent()) return;
      const server = res.approvals.map(pendingApprovalFromServerRow);
      set((state) => {
        return {
          approvalsByTask: {
            ...state.approvalsByTask,
            [taskId]: server,
          },
          approvalFreshnessByTask: {
            ...state.approvalFreshnessByTask,
            [taskId]: { status: "ready", error: null },
          },
          approvalPagesByTask: {
            ...state.approvalPagesByTask,
            [taskId]: {
              nextCursor: res.next_cursor,
              total: res.total,
              loadingMore: false,
              error: null,
            },
          },
          eventHistoryByTask: state.taskFreshnessById[taskId]?.status === "ready"
            ? settleCursorBoundary(state.eventHistoryByTask, taskId, "ready", null)
            : state.eventHistoryByTask,
        };
      });
    } catch (error: unknown) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : "Approval reconciliation failed";
      set((state) => {
        const hasConfirmedSnapshot = Object.prototype.hasOwnProperty.call(state.approvalsByTask, taskId);
        return {
          approvalFreshnessByTask: {
            ...state.approvalFreshnessByTask,
            [taskId]: { status: hasConfirmedSnapshot ? "stale" : "error", error: message },
          },
          approvalPagesByTask: {
            ...state.approvalPagesByTask,
            [taskId]: {
              ...(state.approvalPagesByTask[taskId] ?? initialCollectionPage()),
              loadingMore: false,
              error: message,
            },
          },
          eventHistoryByTask: settleCursorBoundary(state.eventHistoryByTask, taskId, "error", message),
        };
      });
    }
  },

  loadMoreApprovals: async (taskId) => {
    const page = get().approvalPagesByTask[taskId];
    if (!page || !page.nextCursor || page.loadingMore) return;
    const cursor = page.nextCursor;
    const requestGeneration = nextKeyedGeneration(approvalPageRequestGenerationByTask, taskId);
    const isCurrent = (): boolean => isCurrentKeyedGeneration(
      approvalPageRequestGenerationByTask,
      taskId,
      requestGeneration,
    );
    set((state) => ({
      approvalPagesByTask: {
        ...state.approvalPagesByTask,
        [taskId]: { ...page, loadingMore: true, error: null },
      },
    }));
    try {
      const res = await api.listApprovals(taskId, { cursor });
      if (!isCurrent()) return;
      const server = res.approvals.map(pendingApprovalFromServerRow);
      set((state) => ({
        approvalsByTask: {
          ...state.approvalsByTask,
          [taskId]: mergeById(state.approvalsByTask[taskId] ?? [], server, compareApprovals),
        },
        approvalPagesByTask: {
          ...state.approvalPagesByTask,
          [taskId]: {
            nextCursor: res.next_cursor,
            total: res.total,
            loadingMore: false,
            error: null,
          },
        },
      }));
    } catch (error: unknown) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : "Could not load more approvals";
      set((state) => ({
        approvalPagesByTask: {
          ...state.approvalPagesByTask,
          [taskId]: {
            ...(state.approvalPagesByTask[taskId] ?? initialCollectionPage()),
            loadingMore: false,
            error: message,
          },
        },
      }));
    }
  },

  acknowledgeApprovalResolution: (taskId, approvalId) => {
    set((state) => ({
      approvalsByTask: {
        ...state.approvalsByTask,
        [taskId]: (state.approvalsByTask[taskId] ?? []).filter((approval) => approval.id !== approvalId),
      },
    }));
    void get().refreshApprovals(taskId);
  },

  togglePin: (taskId) => {
    const pins = new Set(get().pinnedTaskIds);
    if (pins.has(taskId)) {
      pins.delete(taskId);
    } else {
      if (pins.size >= MAX_PINNED_TASKS) {
        set({ pinPersistenceError: `Only ${MAX_PINNED_TASKS} tasks can be pinned locally.` });
        return;
      }
      pins.add(taskId);
    }
    const pinPersistenceError = writePins(pins);
    set({ pinnedTaskIds: pins, pinPersistenceError });
  },

  setDraft: (taskId, text, source = "external") => {
    let outcome: DraftPersistenceState = { status: "rejected", error: "Draft update was not admitted." };
    set((state) => {
      const draftsByTask = { ...state.draftsByTask };
      if (text.length === 0) delete draftsByTask[taskId];
      else draftsByTask[taskId] = text;
      const validationError = validateDraftCollection(draftsByTask);
      if (validationError) {
        const sessionDraftsByTask = { ...state.sessionDraftsByTask };
        if (text.length === 0) delete sessionDraftsByTask[taskId];
        else sessionDraftsByTask[taskId] = text;
        const sessionValidationError = validateSessionDraftCollection(sessionDraftsByTask);
        outcome = sessionValidationError
          ? { status: "rejected", error: `${validationError} ${sessionValidationError}` }
          : {
              status: "session_only",
              error: `${validationError} This draft is retained per task until this window closes.`,
            };
        return {
          draftPersistenceByTask: {
            ...state.draftPersistenceByTask,
            [taskId]: outcome,
          },
          ...(sessionValidationError ? {} : { sessionDraftsByTask }),
          draftStorageError: outcome.error,
        };
      }
      outcome = writeDrafts(draftsByTask);
      const sessionDraftsByTask = { ...state.sessionDraftsByTask };
      delete sessionDraftsByTask[taskId];
      const draftPersistenceByTask = { ...state.draftPersistenceByTask };
      if (outcome.status === "saved") {
        for (const id of Object.keys(draftsByTask)) {
          if (draftPersistenceByTask[id]?.status === "session_only") {
            draftPersistenceByTask[id] = { status: "saved", error: null };
          }
        }
      }
      draftPersistenceByTask[taskId] = outcome;
      return {
        draftsByTask,
        sessionDraftsByTask,
        draftPersistenceByTask,
        draftStorageError: outcome.status === "saved" ? null : outcome.error,
      };
    });
    if (outcome.status !== "rejected" && source === "external" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("terminus:replace-draft", {
        detail: { taskId, text },
      }));
    }
    return outcome;
  },

  clearDraft: (taskId) => {
    set((state) => {
      const next = { ...state.draftsByTask };
      const sessionDraftsByTask = { ...state.sessionDraftsByTask };
      delete next[taskId];
      delete sessionDraftsByTask[taskId];
      const outcome = writeDrafts(next);
      const draftPersistenceByTask = { ...state.draftPersistenceByTask };
      if (outcome.status === "saved") delete draftPersistenceByTask[taskId];
      else draftPersistenceByTask[taskId] = outcome;
      return {
        draftsByTask: next,
        sessionDraftsByTask,
        draftPersistenceByTask,
        draftStorageError: outcome.status === "saved" ? null : outcome.error,
      };
    });
  },

  retryDraftPersistence: (taskId) => {
    let outcome: DraftPersistenceState = { status: "rejected", error: "Draft retry was not admitted." };
    set((state) => {
      const combinedDrafts = { ...state.draftsByTask, ...state.sessionDraftsByTask };
      const validationError = validateDraftCollection(combinedDrafts);
      outcome = validationError
        ? { status: "session_only", error: `${validationError} Session-only drafts remain available in this window.` }
        : writeDrafts(combinedDrafts);
      const draftPersistenceByTask = { ...state.draftPersistenceByTask };
      if (outcome.status === "saved") {
        for (const id of Object.keys(combinedDrafts)) {
          draftPersistenceByTask[id] = { status: "saved", error: null };
        }
        if (!(taskId in combinedDrafts)) delete draftPersistenceByTask[taskId];
      } else {
        draftPersistenceByTask[taskId] = outcome;
      }
      return {
        ...(outcome.status === "saved"
          ? { draftsByTask: combinedDrafts, sessionDraftsByTask: {} }
          : {}),
        draftPersistenceByTask,
        draftStorageError: outcome.status === "saved" ? null : outcome.error,
      };
    });
    return outcome;
  },

  retryDraftHydration: () => {
    const hydration = readDrafts();
    if (hydration.error) {
      const outcome: DraftPersistenceState = { status: "session_only", error: hydration.error };
      set({ draftStorageError: hydration.error });
      return outcome;
    }
    let outcome: DraftPersistenceState = { status: "saved", error: null };
    set((state) => {
      const draftsByTask = { ...hydration.drafts, ...state.draftsByTask };
      const validationError = validateDraftCollection(draftsByTask);
      if (validationError) {
        outcome = { status: "rejected", error: validationError };
        return { draftStorageError: validationError };
      }
      const draftPersistenceByTask = { ...state.draftPersistenceByTask };
      for (const taskId of Object.keys(hydration.drafts)) {
        if (!draftPersistenceByTask[taskId]) {
          draftPersistenceByTask[taskId] = { status: "saved", error: null };
        }
      }
      return { draftsByTask, draftPersistenceByTask, draftStorageError: null };
    });
    return outcome;
  },

  resetDraftStorage: () => {
    let outcome: DraftPersistenceState = { status: "session_only", error: "Local draft storage is unavailable." };
    set((state) => {
      const combinedDrafts = { ...state.draftsByTask, ...state.sessionDraftsByTask };
      const validationError = validateDraftCollection(combinedDrafts);
      outcome = validationError
        ? { status: "session_only", error: `${validationError} Session-only drafts remain available in this window.` }
        : writeDrafts(combinedDrafts);
      return {
        ...(outcome.status === "saved"
          ? { draftsByTask: combinedDrafts, sessionDraftsByTask: {} }
          : {}),
        draftStorageError: outcome.error,
      };
    });
    return outcome;
  },

  _appendEvent: (taskId, ev) => {
    const presentationEvent = boundPresentationEvent(ev);
    const presentationBytes = presentationEventByteLength(presentationEvent);
    let seen = eventIdsByTask.get(taskId);
    if (!seen) {
      seen = new Set((get().eventsByTask[taskId] ?? []).map((event) => event.id).filter(Boolean));
      eventIdsByTask.set(taskId, seen);
    }
    if (presentationEvent.id && seen.has(presentationEvent.id)) return false;
    if (presentationEvent.id) {
      seen.add(presentationEvent.id);
      resumeCursorByTask.set(taskId, presentationEvent.id);
    }
    const queue = pendingEventsByTask.get(taskId) ?? [];
    queue.push({ event: presentationEvent, bytes: presentationBytes });
    pendingEventsByTask.set(taskId, queue);
    pendingEventBytesByTask.set(taskId, (pendingEventBytesByTask.get(taskId) ?? 0) + presentationBytes);
    pendingEventBytesGlobal += presentationBytes;
    if (presentationEvent.event === "approval.requested" || presentationEvent.event === "approval.resolved") {
      pendingApprovalRefreshTasks.add(taskId);
    }
    while (
      queue.length > MAX_EVENTS_PER_TASK
      || (pendingEventBytesByTask.get(taskId) ?? 0) > MAX_EVENT_BYTES_PER_TASK
    ) {
      if (!dropOldestPendingEvent(taskId)) break;
    }
    while (pendingEventBytesGlobal > MAX_PENDING_EVENT_BYTES_GLOBAL) {
      const selectedTaskId = get().selectedTaskId;
      const evictionTaskId = [...pendingEventsByTask.keys()]
        .sort((left, right) => {
          if (left === selectedTaskId && right !== selectedTaskId) return 1;
          if (right === selectedTaskId && left !== selectedTaskId) return -1;
          return left.localeCompare(right);
        })[0];
      if (!evictionTaskId || !dropOldestPendingEvent(evictionTaskId)) break;
    }
    if (eventFlushScheduled) return true;
    eventFlushScheduled = true;
    const flush = (): void => {
      eventFlushScheduled = false;
      const batchTaskIds = new Set([
        ...pendingEventsByTask.keys(),
        ...pendingEventDropsByTask.keys(),
      ]);
      const batches = [...batchTaskIds].map((queuedTaskId) => [
        queuedTaskId,
        pendingEventsByTask.get(queuedTaskId) ?? [],
      ] as const);
      pendingEventsByTask.clear();
      pendingEventBytesByTask.clear();
      pendingEventBytesGlobal = 0;
      const pendingDrops = new Map(pendingEventDropsByTask);
      pendingEventDropsByTask.clear();
      const approvalTasks = new Set(pendingApprovalRefreshTasks);
      pendingApprovalRefreshTasks.clear();
      set((state) => {
        const eventsByTask = { ...state.eventsByTask };
        const eventBytesByTask = { ...state.eventBytesByTask };
        const eventLruTickByTask = { ...state.eventLruTickByTask };
        const retainedResumeCursorByTask = { ...state.resumeCursorByTask };
        let eventLruClock = state.eventLruClock;
        let eventHistoryByTask = state.eventHistoryByTask;
        for (const [queuedTaskId, batch] of batches) {
          const existing = eventsByTask[queuedTaskId] ?? [];
          const combined = [...existing, ...batch.map((entry) => entry.event)];
          const combinedEventBytes = [
            ...existing.map((event) => presentationEventByteLength(event)),
            ...batch.map((entry) => entry.bytes),
          ];
          let retainedStart = Math.max(0, combined.length - MAX_EVENTS_PER_TASK);
          let retainedBytes = combinedEventBytes
            .slice(retainedStart)
            .reduce((total, bytes) => total + bytes, 0);
          while (retainedBytes > MAX_EVENT_BYTES_PER_TASK && retainedStart < combined.length) {
            retainedBytes -= combinedEventBytes[retainedStart] ?? 0;
            retainedStart += 1;
          }
          const dropped = retainedStart > 0 ? combined.slice(0, retainedStart) : [];
          const next = retainedStart > 0 ? combined.slice(retainedStart) : combined;
          eventsByTask[queuedTaskId] = next;
          eventBytesByTask[queuedTaskId] = retainedBytes;
          eventLruClock += 1;
          eventLruTickByTask[queuedTaskId] = eventLruClock;
          const resumeCursor = resumeCursorByTask.get(queuedTaskId);
          if (resumeCursor) retainedResumeCursorByTask[queuedTaskId] = resumeCursor;
          const pendingDrop = pendingDrops.get(queuedTaskId);
          if (dropped.length === 0 && !pendingDrop) continue;
          const seenIds = eventIdsByTask.get(queuedTaskId);
          for (const event of dropped) if (event.id) seenIds?.delete(event.id);
          const prior = state.eventHistoryByTask[queuedTaskId];
          const droppedThroughCursor = dropped[dropped.length - 1]?.id
            ?? pendingDrop?.throughCursor
            ?? prior?.droppedThroughCursor
            ?? null;
          const boundary: EventHistoryBoundary = prior?.reason === "cursor_expired"
            ? {
                ...prior,
                droppedThroughCursor,
                continuationCursor: next[0]?.id ?? null,
              }
            : {
                reason: "bounded_window",
                omittedCount: (prior?.omittedCount ?? 0) + dropped.length + (pendingDrop?.count ?? 0),
                droppedThroughCursor,
                continuationCursor: next[0]?.id ?? null,
                snapshotUrl: `/v1/tasks/${encodeURIComponent(queuedTaskId)}`,
                reconciliation: "ready",
                error: null,
                globalEvictedCount: prior?.globalEvictedCount ?? 0,
              };
          if (eventHistoryByTask === state.eventHistoryByTask) eventHistoryByTask = { ...state.eventHistoryByTask };
          eventHistoryByTask[queuedTaskId] = boundary;
        }

        for (const [retainedTaskId, retainedEvents] of Object.entries(eventsByTask)) {
          if (eventBytesByTask[retainedTaskId] === undefined) {
            eventBytesByTask[retainedTaskId] = retainedEvents.reduce(
              (taskTotal, event) => taskTotal + presentationEventByteLength(event),
              0,
            );
          }
        }
        let retainedBytesGlobal = Object.keys(eventsByTask).reduce(
          (total, retainedTaskId) => total + (eventBytesByTask[retainedTaskId] ?? 0),
          0,
        );
        const inactiveTasksByRecency = Object.keys(eventsByTask)
          .filter((retainedTaskId) => retainedTaskId !== state.selectedTaskId && (eventsByTask[retainedTaskId]?.length ?? 0) > 0)
          .sort((left, right) =>
            (eventLruTickByTask[left] ?? 0) - (eventLruTickByTask[right] ?? 0)
            || left.localeCompare(right));
        for (const evictedTaskId of inactiveTasksByRecency) {
          if (retainedBytesGlobal <= MAX_EVENT_BYTES_GLOBAL) break;
          const evicted = eventsByTask[evictedTaskId] ?? [];
          const evictedBytes = eventBytesByTask[evictedTaskId]
            ?? evicted.reduce((total, event) => total + presentationEventByteLength(event), 0);
          retainedBytesGlobal = Math.max(0, retainedBytesGlobal - evictedBytes);
          eventsByTask[evictedTaskId] = [];
          eventBytesByTask[evictedTaskId] = 0;
          eventIdsByTask.set(evictedTaskId, new Set());
          const prior = eventHistoryByTask[evictedTaskId];
          const globalEvictedCount = (prior?.globalEvictedCount ?? 0) + evicted.length;
          const boundary: EventHistoryBoundary = prior?.reason === "cursor_expired"
            ? { ...prior, continuationCursor: null, globalEvictedCount }
            : {
                reason: "global_lru",
                omittedCount: (prior?.omittedCount ?? 0) + evicted.length,
                droppedThroughCursor: evicted[evicted.length - 1]?.id ?? prior?.droppedThroughCursor ?? null,
                continuationCursor: null,
                snapshotUrl: `/v1/tasks/${encodeURIComponent(evictedTaskId)}`,
                reconciliation: "ready",
                error: null,
                globalEvictedCount,
              };
          if (eventHistoryByTask === state.eventHistoryByTask) eventHistoryByTask = { ...state.eventHistoryByTask };
          eventHistoryByTask[evictedTaskId] = boundary;
        }
        return {
          eventsByTask,
          eventBytesByTask,
          eventLruTickByTask,
          eventLruClock,
          resumeCursorByTask: retainedResumeCursorByTask,
          eventHistoryByTask,
        };
      });
      for (const approvalTaskId of approvalTasks) void get().refreshApprovals(approvalTaskId);
    };
    // SSE ingestion is not visual work. A bounded timer continues to make
    // progress when Electron throttles animation frames in the background.
    setTimeout(flush, EVENT_BATCH_MS);
    return true;
  },

  _updateTaskFromEvent: (ev, streamTaskId) => {
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
    const explicitTaskId = typeof p.task_id === "string"
      ? p.task_id
      : typeof p.id === "string"
        ? p.id
        : null;
    // The stream subscription is task-scoped. A payload claiming another
    // task is poisoned or buggy input, never authority to mutate that task.
    if (streamTaskId && explicitTaskId && explicitTaskId !== streamTaskId) return;
    const taskId = streamTaskId ?? explicitTaskId;
    if (!taskId) return;
    const eventStatus = (() => {
      switch (ev.event) {
        case "task.completed": return "COMPLETED";
        case "task.failed": return "FAILED";
        case "task.interrupted": return "ABORTED";
        case "task.aborted": return "ABORTED";
        default: return null;
      }
    })();
    const status = isTaskDomainStatus(p.status) ? p.status : eventStatus;
    const phase = typeof p.phase === "string" ? p.phase : null;
    set((state) => {
      const existing = state.taskById[taskId];
      if (!existing) return {};
      const updated: Task = {
        ...existing,
        status: status ?? existing.status,
        phase: phase ?? existing.phase,
        terminal_reason: ev.event === "task.blocked" && typeof p.reason === "string"
          ? {
              reason: p.reason,
              ...(typeof p.error === "string" ? { error: p.error } : {}),
            }
          : existing.terminal_reason,
        updated_at: new Date().toISOString(),
      };
      const tasks = state.tasksBySession[updated.session_id] ?? [];
      return {
        taskById: { ...state.taskById, [taskId]: updated },
        tasksBySession: {
          ...state.tasksBySession,
          [updated.session_id]: tasks.map((task) => task.id === taskId ? updated : task),
        },
      };
    });
  },

  _attachStream: (taskId, initialCursor = null) => {
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
    let resumeCursor = resumeCursorByTask.get(taskId)
      ?? get().resumeCursorByTask[taskId]
      ?? initialCursor;

    const connect = (): void => {
      if (generation !== streamGeneration || get().selectedTaskId !== taskId) return;
      const events = get().eventsByTask[taskId] ?? [];
      const cursor = events.length > 0 ? (events[events.length - 1]?.id ?? resumeCursor) : resumeCursor;
      const stream = subscribeEvents({ task_id: taskId, cursor });
      set({ _stream: stream, streamState: attempts > 0 ? "reconnecting" : "connecting" });
      stream.addEventListener("open", () => {
        if (generation !== streamGeneration) return;
        attempts = 0;
        set({ streamState: "connected", lastError: null });
      });
      stream.addEventListener("message", (ev) => {
        if (generation !== streamGeneration) return;
        // R12: close any pending time-to-first-event sample for this task.
        try {
          sessionLatency.observeStreamEvent(taskId, ev.event);
        } catch {
          // Instrumentation must never break streaming.
        }
        if (ev.event === "cursor_expired") {
          let payload: unknown = null;
          try {
            payload = JSON.parse(ev.data) as unknown;
          } catch {
            // The reconciliation below is still required even if diagnostics
            // were malformed; never treat the old event tail as complete.
          }
          const record = payload && typeof payload === "object" && !Array.isArray(payload)
            ? payload as Record<string, unknown>
            : {};
          const requestedCursor = typeof record.cursor === "string" ? record.cursor : cursor;
          const oldestCursor = typeof record.oldest_retained_event_id === "string"
            ? record.oldest_retained_event_id
            : null;
          resumeCursor = oldestCursor ?? ev.id ?? null;
          if (resumeCursor) resumeCursorByTask.set(taskId, resumeCursor);
          else resumeCursorByTask.delete(taskId);
          pendingEventBytesGlobal = Math.max(
            0,
            pendingEventBytesGlobal - (pendingEventBytesByTask.get(taskId) ?? 0),
          );
          pendingEventsByTask.delete(taskId);
          pendingEventBytesByTask.delete(taskId);
          pendingEventDropsByTask.delete(taskId);
          pendingApprovalRefreshTasks.delete(taskId);
          eventIdsByTask.set(taskId, new Set());
          const expectedSnapshotUrl = `/v1/tasks/${encodeURIComponent(taskId)}`;
          const snapshotUrl = record.snapshot_url === expectedSnapshotUrl ? expectedSnapshotUrl : null;
          set((state) => {
            const eventLruTickByTask = { ...state.eventLruTickByTask };
            delete eventLruTickByTask[taskId];
            const retainedResumeCursorByTask = { ...state.resumeCursorByTask };
            if (resumeCursor) retainedResumeCursorByTask[taskId] = resumeCursor;
            else delete retainedResumeCursorByTask[taskId];
            return {
              eventsByTask: { ...state.eventsByTask, [taskId]: [] },
              eventBytesByTask: { ...state.eventBytesByTask, [taskId]: 0 },
              eventLruTickByTask,
              resumeCursorByTask: retainedResumeCursorByTask,
              eventHistoryByTask: {
                ...state.eventHistoryByTask,
                [taskId]: {
                  reason: "cursor_expired",
                  omittedCount: null,
                  droppedThroughCursor: requestedCursor ?? null,
                  continuationCursor: oldestCursor,
                  snapshotUrl,
                  reconciliation: "pending",
                  error: null,
                  globalEvictedCount: 0,
                },
              },
            };
          });
          // Snapshot actions carry their own per-resource generations. Older
          // cursor reconciliation cannot overwrite a newer manual refresh,
          // and the second successful resource settles the pending boundary.
          void Promise.all([get().refreshTask(taskId), get().refreshApprovals(taskId)]);
          return;
        }
        const presentationEvent = boundPresentationEvent(ev);
        const accepted = get()._appendEvent(taskId, presentationEvent);
        const acceptedCursor = resumeCursorByTask.get(taskId);
        if (acceptedCursor) resumeCursor = acceptedCursor;
        if (accepted) get()._updateTaskFromEvent(presentationEvent, taskId);
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

/** Explicit truncation/cursor-expiry state for the selected event window. */
export function useSelectedTaskEventHistory(): EventHistoryBoundary | null {
  const id = useTerminusStore((s) => s.selectedTaskId);
  return useTerminusStore((s) => (id ? s.eventHistoryByTask[id] : undefined) ?? null);
}

const EMPTY_APPROVALS: PendingApproval[] = [];

/**
 * Merged pending approvals for the selected task: server snapshot ∪
 * event-derived entries, deduplicated by approval id.
 */
export function useSelectedTaskApprovals(): {
  approvals: PendingApproval[];
  status: "loading" | "ready" | "stale" | "error";
  error: string | null;
  page: CollectionPageState;
} {
  const id = useTerminusStore((s) => s.selectedTaskId);
  const stored = useTerminusStore((s) => (id ? s.approvalsByTask[id] : undefined) ?? EMPTY_APPROVALS);
  const events = useTerminusStore((s) => (id ? s.eventsByTask[id] : undefined) ?? EMPTY_EVENTS);
  const freshness = useTerminusStore((s) => id ? s.approvalFreshnessByTask[id] : undefined);
  const page = useTerminusStore((s) => id ? s.approvalPagesByTask[id] : undefined);
  const approvals = useMemo(
    () => freshness?.status === "ready"
      ? stored
      : mergePendingApprovals(stored, derivePendingApprovals(events)),
    [events, freshness?.status, stored],
  );
  return {
    approvals,
    status: freshness?.status ?? "loading",
    error: freshness?.error ?? null,
    page: page ?? initialCollectionPage(),
  };
}
