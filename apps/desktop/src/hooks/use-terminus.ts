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
import { useEffect, useMemo, useRef } from "react";
import { api, createIdempotencyKey, TerminusApiError, subscribeEvents, type TerminusEventStream } from "../lib/api";
import { mergePendingApprovals, pendingApprovalFromServerRow, derivePendingApprovals, type PendingApproval } from "../lib/task-surface";
import { TURN_SETTLED_EVENTS, turnActivityFromEvents, type TurnActivity } from "../lib/turn-activity";
import { sessionLatency } from "../lib/session-latency";
import {
  deriveProjectTitle,
  isAbsoluteLocalPath,
  noteRecentProject,
  projectPathToUri,
  sameProjectRoot,
} from "../lib/projects";
import {
  boundPresentationEvent as boundClientPresentationEvent,
  DEFAULT_PRESENTATION_EVENT_MAX_CHARS,
  eventIdentity,
  eventByteLength,
  normalizeTaskStatus as normalizeClientTaskStatus,
  projectCursorExpiredEvent,
  projectTaskEvent,
  retainEventWindow,
} from "@terminus/public-client";
import type { EventHistoryBoundary } from "@terminus/public-client";
import type {
  TerminusSseEvent,
  HealthResponse,
  Session,
  SessionUpdateInput,
  Task,
  WorkspaceKind,
  WorkspaceSnapshot,
} from "../types";

const MAX_EVENTS_PER_TASK = 2000;
export const MAX_EVENT_BYTES_PER_TASK = 4 * 1024 * 1024;
export const MAX_EVENT_BYTES_GLOBAL = 32 * 1024 * 1024;
export const MAX_PENDING_EVENT_BYTES_GLOBAL = 2 * 1024 * 1024;
export const MAX_PRESENTATION_EVENT_CHARS = DEFAULT_PRESENTATION_EVENT_MAX_CHARS;
export const PRESENTATION_REJECTION_KEY = "terminus_presentation_rejection";
/**
 * How much of a long conversation to replay on open. The presentation window
 * holds 2000 events, so asking for more would only fill it and evict the
 * oldest again; "load earlier" pages backwards from there on demand.
 */
const TRANSCRIPT_PAGE_EVENTS = 500;
/**
 * Replay reads the database directly and answers in about a millisecond, but
 * it must never be able to hold the live stream hostage: on timeout the stream
 * attaches anyway, with the transcript marked incomplete rather than absent.
 */
const TRANSCRIPT_REPLAY_TIMEOUT_MS = 6_000;

export interface TranscriptReplayState {
  status: "loading" | "ready" | "error";
  /** Cursor for the page before what is loaded; null once the start is reached. */
  earlierCursor: string | null;
  loadingEarlier: boolean;
  /** Events the control plane holds for this task, including ones not replayed. */
  total: number;
  error: string | null;
}

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
const transcriptRequestGenerationByTask = new Map<string, number>();
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
/**
 * When this client last accepted an event for a task, in epoch milliseconds.
 *
 * The watchdog below reads it. A task whose snapshot claims a running turn but
 * whose stream has said nothing for a minute is the shape of every phantom
 * "Working" spinner in the app: the run ended and its terminal event was
 * dropped by an eviction, a cursor expiry, or a control-plane restart.
 */
const lastEventAtByTask = new Map<string, number>();
/** Pending debounced `refreshTask` calls, keyed by task. */
const settledRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * A terminal event and the snapshot that reflects it do not arrive together.
 * Coalesce the burst of turn/task terminal events one run produces into a
 * single detail fetch instead of one per event.
 */
const TURN_SETTLED_REFRESH_DEBOUNCE_MS = 400;
/** How long a claimed-running turn may go silent before the client asks. */
export const STUCK_TURN_SILENCE_MS = 60_000;
/** How often the watchdog looks. Cheap: it only fires after the silence above. */
export const STUCK_TURN_CHECK_MS = 15_000;
/**
 * Turn states the control plane treats as immutable — the run is over. Taken
 * from its own `immutableTurnStates` list.
 */
const SETTLED_TURN_STATES = new Set([
  "COMPLETED",
  "INTERRUPTED",
  "FAILED",
  "BUDGET_EXHAUSTED",
  "POLICY_DENIED",
  "BLOCKED",
  "USER_ACTION_REQUIRED",
  "REPAIR_PENDING",
  "VERIFIED",
  "ABORTED",
]);
/** Exact retained UTF-8 presentation cost for one bounded SSE envelope. */
export const presentationEventByteLength = eventByteLength;

function notePendingEventDrop(taskId: string, event: TerminusSseEvent): void {
  const prior = pendingEventDropsByTask.get(taskId);
  pendingEventDropsByTask.set(taskId, {
    count: (prior?.count ?? 0) + 1,
    throughCursor: event.id || prior?.throughCursor || null,
  });
  eventIdsByTask.get(taskId)?.delete(eventIdentity(event));
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
export const boundPresentationEvent = boundClientPresentationEvent;

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
/**
 * Carry detail-only fields forward.
 *
 * `active_turn` and `budget_ledger` come from `GET /v1/tasks/:id`; the list
 * route omits them. Replacing a row wholesale on a list refresh would blank
 * both, and the composer reads `active_turn` to decide whether a run is in
 * flight — so a routine sidebar refresh would make a running task look idle.
 * `undefined` means "this response did not report it"; `null` means "reported,
 * and there is none".
 */
function reconcileTask(previous: Task | undefined, next: Task): Task {
  if (previous === undefined) return next;
  return {
    ...next,
    active_turn: next.active_turn === undefined ? previous.active_turn : next.active_turn,
    budget_ledger: next.budget_ledger === undefined ? previous.budget_ledger : next.budget_ledger,
  };
}

function mergeTasks(current: readonly Task[], incoming: readonly Task[]): Task[] {
  const byId = new Map(current.map((task) => [task.id, task]));
  for (const task of incoming) byId.set(task.id, reconcileTask(byId.get(task.id), task));
  return Array.from(byId.values()).sort(compareTasks);
}

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
  lastEventAtByTask.delete(taskId);
  const settledTimer = settledRefreshTimers.get(taskId);
  if (settledTimer) {
    clearTimeout(settledTimer);
    settledRefreshTimers.delete(taskId);
  }
}

// ────────────────────────── Status normalization ───────────────────────────

export const normalizeTaskStatus = normalizeClientTaskStatus;

// ────────────────────────── Pinned tasks ───────────────────────────────────

const PINS_KEY = "terminus-desktop.pinned-tasks.v1";
/**
 * The project the operator was last in.
 *
 * Without this, every launch dropped into `sessions[0]` — the most recently
 * updated project, which is not the same thing as the one you were working in
 * and changes under you whenever a background run touches something else.
 */
const LAST_SESSION_KEY = "terminus-desktop.last-session.v1";
const DRAFTS_KEY = "terminus-desktop.drafts.v1";
const MAX_PINNED_TASKS = 50;
const PIN_HYDRATION_CONCURRENCY = 4;
/** How long the liveness probe may hang before the UI calls the plane degraded. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;
/** First retry delay after a failed probe. Doubles up to the ceiling below. */
export const HEALTH_RETRY_MIN_MS = 1_000;
export const HEALTH_RETRY_MAX_MS = 30_000;
/** How often a healthy control plane is re-checked. */
export const HEALTH_HEARTBEAT_MS = 60_000;
const SESSION_TASK_HYDRATION_CONCURRENCY = 4;
/** How many spaces get their tasks hydrated up front, most recent first. */
const MAX_HYDRATED_SESSIONS = 12;
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

  /**
   * Messages that could not be delivered to a running turn.
   *
   * Steering a live turn is a real request now (`POST /v1/turns/:id/steer`),
   * so this is the fallback, not the normal path: it holds text the control
   * plane refused because the turn settled mid-flight, and sends it as a new
   * turn once the task is idle. Anything held here is a message the user
   * believes they sent, so it is never dropped silently.
   */
  queuedSteerByTask: Record<string, string>;
  /**
   * When each queued message was accepted, in epoch milliseconds.
   *
   * A queue that never drains is indistinguishable from a delivered message
   * unless someone is watching the clock. The composer watches this one and,
   * past 30 seconds, re-reads the task and offers to send it anyway.
   */
  queuedSteerAtByTask: Record<string, number>;

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
  /**
   * What each task's live event tail last said about a run, kept here rather
   * than recomputed per render. The sidebar, the board and the Dock badge all
   * ask "is this task actually working" for every loaded task; deriving it from
   * `eventsByTask` would re-rank the whole navigation tree on every 50 ms SSE
   * batch. This changes only when the answer does.
   */
  runActivityByTask: Record<string, TurnActivity>;
  /** Explicit boundary metadata for the bounded presentation event window. */
  eventHistoryByTask: Record<string, EventHistoryBoundary>;
  /**
   * Replay of a task's durable transcript.
   *
   * Opening a task that already ran used to show an empty conversation: the
   * SSE stream is a live tail, so without a cursor it delivers only what
   * happens next, and the events were sitting unread in `semantic_events`.
   */
  transcriptByTask: Record<string, TranscriptReplayState>;

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
  refreshVisibleSessionTasks: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  refreshTasks: (sessionId: string) => Promise<void>;
  loadMoreTasks: (sessionId: string) => Promise<void>;
  refreshTask: (taskId: string) => Promise<void>;
  /**
   * Write a project's turn defaults. Applied locally first so the picker moves
   * on click, reverted and rethrown when the control plane refuses.
   */
  patchSessionDefaults: (sessionId: string, patch: SessionUpdateInput) => Promise<void>;
  /**
   * Ask the control plane what a claimed-running turn is actually doing, and
   * re-read the task when it turns out to have finished. The escape hatch for
   * a terminal event this client never received.
   */
  reconcileActiveTurn: (taskId: string) => Promise<void>;
  /** Replay the durable transcript, then attach the live stream after it. */
  hydrateTranscript: (taskId: string) => Promise<void>;
  /** Fetch the page of events preceding what is already replayed. */
  loadEarlierTranscript: (taskId: string) => Promise<void>;
  /**
   * Interrupt the task's in-flight turn, leaving the task steerable. Resolves
   * to an error message, or null on success.
   */
  stopTask: (taskId: string) => Promise<string | null>;
  /** End the task outright. Resolves to an error message, or null on success. */
  cancelTask: (taskId: string) => Promise<string | null>;
  selectSession: (sessionId: string | null) => void;
  /**
   * Open a local directory as a project, or select the one already open on it.
   *
   * Resolves to the session id. Opening the same path twice used to create a
   * second session against the same workspace, so the sidebar grew duplicate
   * rows that could never be told apart.
   */
  openProjectPath: (path: string) => Promise<string>;
  selectTask: (taskId: string | null, cursor?: string | null) => void;
  refreshApprovals: (taskId: string) => Promise<void>;
  loadMoreApprovals: (taskId: string) => Promise<void>;
  acknowledgeApprovalResolution: (taskId: string, approvalId: string) => void;
  togglePin: (taskId: string) => void;
  /** Hold `text` until the task's active turn settles. Replaces any prior queue. */
  queueSteer: (taskId: string, text: string) => void;
  clearQueuedSteer: (taskId: string) => void;
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

function readLastSessionId(): string | null {
  try {
    const value = window.localStorage.getItem(LAST_SESSION_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeLastSessionId(sessionId: string | null): void {
  try {
    if (sessionId === null) window.localStorage.removeItem(LAST_SESSION_KEY);
    else window.localStorage.setItem(LAST_SESSION_KEY, sessionId);
  } catch {
    // Blocked storage costs the restore, not the session.
  }
}

type HealthSetter = (partial: Partial<TerminusState>) => void;

/**
 * Bounded liveness probe, run alongside the session fetch rather than ahead of
 * it. A control plane that stops answering health degrades the status
 * indicator; it does not empty the sidebar.
 */
async function probeHealth(set: HealthSetter, isCurrent: () => boolean): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const health: HealthResponse = await api.health(controller.signal);
    if (!isCurrent()) return;
    const kernelState = health.kernel?.status ?? health.status;
    set({
      healthReady: health.ready,
      healthStatus: health.ready ? "ready" : "degraded",
      healthDetail: health.ready ? null : `kernel status ${kernelState}`,
    });
  } catch (err) {
    if (!isCurrent()) return;
    const timedOut = controller.signal.aborted;
    // A hung probe means a degraded control plane, not an offline one: the
    // rest of the API is usually still answering.
    set({
      healthReady: false,
      healthStatus: timedOut ? "degraded" : "offline",
      healthDetail: timedOut
        ? `health check did not answer within ${Math.round(HEALTH_PROBE_TIMEOUT_MS / 1000)}s`
        : err instanceof Error ? err.message : "health check failed",
    });
  } finally {
    clearTimeout(timer);
  }
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
  queuedSteerByTask: {},
  queuedSteerAtByTask: {},
  transcriptByTask: {},
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
  runActivityByTask: {},
  eventHistoryByTask: {},
  approvalsByTask: {},
  approvalFreshnessByTask: {},
  approvalPagesByTask: {},

  loadingSessions: false,
  loadingTasksFor: null,

  _stream: null,

  refreshAll: async () => {
    /*
     * Boot used to be five round trips end to end, each waiting on the one
     * before it, so the window stayed empty for the sum of every request
     * rather than the slowest one.
     *
     * Only two of them actually depend on anything. The pinned tasks and the
     * selected task are addressed by id from state we restored before any
     * request went out, so they can leave immediately. The session-derived
     * work is the only part that has to wait for the session list, and once
     * it has it the two halves fan out together: `refreshVisibleSessionTasks`
     * deliberately skips the selected space, so it never races the call that
     * loads it. Each of these already reports its own failure into freshness
     * state rather than throwing, so one slow space cannot strand the rest.
     */
    const selectedTaskId = get().selectedTaskId;
    const pending: Promise<unknown>[] = [get().refreshPinnedTasks()];
    if (selectedTaskId) {
      pending.push(get().refreshTask(selectedTaskId), get().refreshApprovals(selectedTaskId));
    }
    pending.push(get().refreshSessions().then(async () => {
      // Read the selection *after* the list settles: an empty selection is
      // resolved to a real space while the sessions request is in flight.
      const sessId = get().selectedSessionId;
      await Promise.all([
        sessId ? get().refreshTasks(sessId) : Promise.resolve(),
        // Work started in another space has to be visible without clicking
        // into it, otherwise the sidebar counts and the attention badge only
        // ever describe whichever space happens to be open.
        get().refreshVisibleSessionTasks(),
      ]);
    }));
    await Promise.all(pending);
  },

  refreshVisibleSessionTasks: async () => {
    const selectedSessionId = get().selectedSessionId;
    // Bounded on both axes: the most recently touched spaces only, a few at a
    // time. Opening thirty projects must not fan out thirty parallel requests.
    const sessionIds = [...get().sessions]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))
      .slice(0, MAX_HYDRATED_SESSIONS)
      .map((session) => session.id)
      .filter((sessionId) => sessionId !== selectedSessionId);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < sessionIds.length) {
        const index = nextIndex;
        nextIndex += 1;
        const sessionId = sessionIds[index];
        if (!sessionId) continue;
        await get().refreshTasks(sessionId);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(SESSION_TASK_HYDRATION_CONCURRENCY, sessionIds.length) },
        () => worker(),
      ),
    );
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
    // A liveness probe must never gate the data the sidebar needs, and it must
    // be bounded. `/v1/system/health` reports writer state, so it stops
    // answering while a turn holds the writer lease — awaiting it first left
    // the app on "Starting Terminus" with an empty sidebar for the whole
    // duration of a run, even though every other endpoint answered in ~1ms.
    void probeHealth(set, isCurrent);
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
        const rememberedSessionId = readLastSessionId();
        const nextSelectedSessionId = selectedTaskSessionId
          ?? (state.selectedSessionId && sessionIds.has(state.selectedSessionId)
            ? state.selectedSessionId
            : rememberedSessionId && sessionIds.has(rememberedSessionId)
              ? rememberedSessionId
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
          queuedSteerByTask: omitTaskKeys(state.queuedSteerByTask, removedTaskIds),
          queuedSteerAtByTask: omitTaskKeys(state.queuedSteerAtByTask, removedTaskIds),
          eventsByTask: omitTaskKeys(state.eventsByTask, removedTaskIds),
          eventBytesByTask: omitTaskKeys(state.eventBytesByTask, removedTaskIds),
          eventLruTickByTask: omitTaskKeys(state.eventLruTickByTask, removedTaskIds),
          resumeCursorByTask: omitTaskKeys(state.resumeCursorByTask, removedTaskIds),
          runActivityByTask: omitTaskKeys(state.runActivityByTask, removedTaskIds),
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
        const reconciled = visibleTasks.map((task) => reconcileTask(taskById[task.id], task));
        for (const task of reconciled) taskById[task.id] = task;
        return {
          tasksBySession: { ...state.tasksBySession, [sessionId]: reconciled },
          taskById,
          taskFreshnessById: omitTaskKeys(state.taskFreshnessById, removedTaskIds),
          queuedSteerByTask: omitTaskKeys(state.queuedSteerByTask, removedTaskIds),
          queuedSteerAtByTask: omitTaskKeys(state.queuedSteerAtByTask, removedTaskIds),
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
        const tasks = mergeTasks(state.tasksBySession[sessionId] ?? [], res.tasks);
        const taskById = { ...state.taskById };
        for (const task of tasks) taskById[task.id] = reconcileTask(taskById[task.id], task);
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

  /**
   * Stop the run without ending the task.
   *
   * Stopping interrupts the active turn; it does not cancel the task. Those
   * are different intentions and `POST /v1/tasks/:id/cancel` only expresses
   * the second: it drives the task to ABORTED, which is terminal, so the
   * composer then refuses further input and the user cannot say "not like
   * that, try this" — the single most common thing to want after pressing
   * stop. `POST /v1/turns/:id/interrupt` aborts the turn and leaves the task
   * ACTIVE and steerable.
   *
   * The active turn id comes from the task snapshot rather than the event
   * stream, so this works for a task that was already running when the window
   * opened. The snapshot is re-read first because a turn that has settled
   * since the last refresh is not interruptible and saying so beats sending a
   * request that can only 409.
   */
  stopTask: async (taskId: string) => {
    try {
      const task = await api.getTask(taskId);
      const activeTurn = task.active_turn ?? null;
      if (activeTurn === null) {
        // Not an error state: the run this stop was aimed at has already
        // finished. Reflecting the settled task is the honest response.
        set((state) => ({
          taskById: { ...state.taskById, [task.id]: reconcileTask(state.taskById[task.id], task) },
          tasksBySession: {
            ...state.tasksBySession,
            [task.session_id]: mergeTasks(state.tasksBySession[task.session_id] ?? [], [task]),
          },
        }));
        return null;
      }
      await api.interruptTurn(
        activeTurn.id,
        { idempotencyKey: createIdempotencyKey("turn-interrupt") },
        "user_stopped",
      );
      await get().refreshTask(taskId);
      return null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Stop failed.";
      set({ lastError: message });
      return message;
    }
  },

  /**
   * End the task.
   *
   * `api.cancelTask` is deliberate: it is the only client method that reaches
   * the control plane's `abortActiveTurn` for every in-flight turn *and*
   * drives the task terminal. The v2 `transitionTask(..., "CANCELLED")` path
   * writes the snapshot and projects the v1 status without signalling the
   * running loop, so the agent keeps working on a task the board has already
   * marked cancelled.
   */
  cancelTask: async (taskId: string) => {
    try {
      await api.cancelTask(taskId, { idempotencyKey: createIdempotencyKey("task-cancel") }, "user_cancelled");
      await get().refreshTask(taskId);
      return null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Cancel failed.";
      set({ lastError: message });
      return message;
    }
  },

  /**
   * Replay the durable transcript, then attach the live stream immediately
   * after the last replayed event.
   *
   * Order matters. Attaching first and replaying second would append older
   * events after newer ones, because the presentation window is append-only.
   * Replaying first and attaching at `next_cursor` means the control plane
   * delivers everything that happened during the replay, so the two meet
   * exactly once with no gap and no duplicate.
   */
  hydrateTranscript: async (taskId: string) => {
    const requestGeneration = nextKeyedGeneration(transcriptRequestGenerationByTask, taskId);
    const isCurrent = (): boolean => isCurrentKeyedGeneration(
      transcriptRequestGenerationByTask,
      taskId,
      requestGeneration,
    );
    set((state) => ({
      transcriptByTask: {
        ...state.transcriptByTask,
        [taskId]: {
          status: "loading",
          earlierCursor: null,
          loadingEarlier: false,
          total: state.transcriptByTask[taskId]?.total ?? 0,
          error: null,
        },
      },
    }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIPT_REPLAY_TIMEOUT_MS);
    try {
      const page = await api.getTaskTranscript(taskId, {
        limit: TRANSCRIPT_PAGE_EVENTS,
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      for (const event of page.events) get()._appendEvent(taskId, event);
      set((state) => ({
        transcriptByTask: {
          ...state.transcriptByTask,
          [taskId]: {
            status: "ready",
            earlierCursor: page.earlier_cursor,
            loadingEarlier: false,
            total: page.total,
            error: null,
          },
        },
      }));
      get()._attachStream(taskId, page.next_cursor);
    } catch (error: unknown) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : "The conversation could not be loaded.";
      set((state) => ({
        transcriptByTask: {
          ...state.transcriptByTask,
          [taskId]: {
            status: "error",
            earlierCursor: null,
            loadingEarlier: false,
            total: state.transcriptByTask[taskId]?.total ?? 0,
            error: message,
          },
        },
      }));
      // Live updates matter more than history. Attach without a cursor rather
      // than leaving the task with no stream at all.
      get()._attachStream(taskId, null);
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Page backwards through the transcript.
   *
   * Earlier events are prepended, because they belong before what is already
   * on screen — unlike every other write to the event window, which appends.
   */
  loadEarlierTranscript: async (taskId: string) => {
    const current = get().transcriptByTask[taskId];
    if (!current || current.earlierCursor === null || current.loadingEarlier) return;
    const cursor = current.earlierCursor;
    set((state) => ({
      transcriptByTask: {
        ...state.transcriptByTask,
        [taskId]: { ...(state.transcriptByTask[taskId] ?? current), loadingEarlier: true, error: null },
      },
    }));
    try {
      const page = await api.getTaskTranscript(taskId, {
        before: cursor,
        limit: TRANSCRIPT_PAGE_EVENTS,
      });
      set((state) => {
        const seen = new Set((state.eventsByTask[taskId] ?? []).map((event) => event.id));
        const earlier = page.events
          .filter((event) => !seen.has(event.id))
          .map((event) => boundPresentationEvent(event));
        const existing = state.eventsByTask[taskId] ?? [];
        const merged = [...earlier, ...existing];
        const bytes = merged.reduce((total, event) => total + presentationEventByteLength(event), 0);
        eventIdsByTask.set(taskId, new Set(merged.map((event) => event.id)));
        return {
          eventsByTask: { ...state.eventsByTask, [taskId]: merged },
          eventBytesByTask: { ...state.eventBytesByTask, [taskId]: bytes },
          transcriptByTask: {
            ...state.transcriptByTask,
            [taskId]: {
              status: "ready",
              earlierCursor: page.earlier_cursor,
              loadingEarlier: false,
              total: page.total,
              error: null,
            },
          },
        };
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Earlier messages could not be loaded.";
      set((state) => ({
        transcriptByTask: {
          ...state.transcriptByTask,
          [taskId]: {
            ...(state.transcriptByTask[taskId] ?? current),
            loadingEarlier: false,
            error: message,
          },
        },
      }));
    }
  },

  queueSteer: (taskId: string, text: string) => {
    set((state) => ({
      queuedSteerByTask: { ...state.queuedSteerByTask, [taskId]: text },
      queuedSteerAtByTask: { ...state.queuedSteerAtByTask, [taskId]: Date.now() },
    }));
  },

  clearQueuedSteer: (taskId: string) => {
    set((state) => {
      if (state.queuedSteerByTask[taskId] === undefined) return {};
      const queuedSteerByTask = { ...state.queuedSteerByTask };
      delete queuedSteerByTask[taskId];
      const queuedSteerAtByTask = { ...state.queuedSteerAtByTask };
      delete queuedSteerAtByTask[taskId];
      return { queuedSteerByTask, queuedSteerAtByTask };
    });
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
          taskById: { ...state.taskById, [task.id]: reconcileTask(state.taskById[task.id], task) },
          ...(state.selectedTaskId === task.id ? { selectedSessionId: task.session_id } : {}),
          tasksBySession: {
            ...state.tasksBySession,
            [task.session_id]: mergeTasks(state.tasksBySession[task.session_id] ?? [], [task]),
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

  /**
   * Store a project's default model or reasoning depth.
   *
   * Applied locally first so the picker answers immediately, and rolled back if
   * the control plane refuses — a picker showing a default the server does not
   * hold is worse than one that admits the write failed.
   */
  patchSessionDefaults: async (sessionId: string, patch: SessionUpdateInput) => {
    const previous = get().sessions.find((session) => session.id === sessionId);
    if (!previous) throw new Error("That project is not loaded.");
    const applyLocally = (next: Session): void => {
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === sessionId ? next : session),
      }));
    };
    applyLocally({ ...previous, ...patch });
    try {
      applyLocally(await api.updateSession(sessionId, patch, {
        idempotencyKey: createIdempotencyKey(`session-defaults:${sessionId}`),
      }));
    } catch (error: unknown) {
      // Leaving the optimistic value in place would make the picker claim a
      // default the control plane does not hold.
      applyLocally(previous);
      throw error;
    }
  },

  /**
   * The escape hatch for a run whose ending never reached this client.
   *
   * Events are lost for ordinary reasons — the presentation window evicts, a
   * cursor expires, the control plane restarts mid-turn — and every one of them
   * leaves `active_turn` pointing at a turn that finished. Reading the turn is
   * the cheapest authoritative answer; the task detail then clears the pointer.
   */
  reconcileActiveTurn: async (taskId: string) => {
    const activeTurn = get().taskById[taskId]?.active_turn ?? null;
    if (!activeTurn) return;
    // Whatever happens next, do not ask again for another silence window.
    lastEventAtByTask.set(taskId, Date.now());
    try {
      const turn = await api.getTurn(activeTurn.id);
      if (!SETTLED_TURN_STATES.has(turn.state.toUpperCase())) return;
    } catch (error: unknown) {
      // A turn the control plane no longer has is settled by definition; any
      // other failure is reported through the task refresh below.
      if (!(error instanceof TerminusApiError) || error.status !== 404) {
        set({ lastError: error instanceof Error ? error.message : "turn state check failed" });
      }
    }
    await get().refreshTask(taskId);
  },

  openProjectPath: async (path: string) => {
    const trimmed = path.trim();
    if (!isAbsoluteLocalPath(trimmed)) {
      throw new Error("Choose an absolute local directory.");
    }
    // The shell can stat the path; the renderer cannot. When it answers, its
    // canonical path is the one used, so `/tmp` and `/private/tmp` do not
    // become two projects.
    let isGit: boolean | null = null;
    let root = trimmed;
    const validate = window.terminusDesktop?.validateDirectory;
    if (validate) {
      const verdict = await validate(trimmed);
      if (!verdict.ok) throw new Error(`${trimmed} is not a directory this app can open.`);
      if (verdict.canonicalPath) root = verdict.canonicalPath;
      isGit = verdict.isGit;
    }
    const rootUri = projectPathToUri(root);

    const existing = get().sessions.find((session) => sameProjectRoot(session.workspace_root_uri, rootUri));
    if (existing) {
      get().selectSession(existing.id);
      void noteRecentProject(root);
      return existing.id;
    }

    // A repository and a plain directory are different workspace kinds and the
    // control plane refuses to re-identify one as the other. When the shell
    // cannot say which it is, try the repository reading first and let the
    // conflict correct it.
    const kinds: readonly WorkspaceKind[] = isGit === null
      ? ["local_git", "local_directory"]
      : isGit ? ["local_git"] : ["local_directory"];
    const operationKey = createIdempotencyKey(`open-project:${rootUri}`);
    let workspace: WorkspaceSnapshot | null = null;
    let lastError: unknown = null;
    for (const kind of kinds) {
      try {
        workspace = await api.openWorkspace(
          { root_uri: rootUri, kind, trust: "untrusted" },
          { idempotencyKey: `${operationKey}:${kind}` },
        );
        break;
      } catch (error: unknown) {
        lastError = error;
        const identityConflict = error instanceof TerminusApiError
          && error.status === 409
          && error.envelope?.code === "WORKSPACE_IDENTITY_CONFLICT";
        if (!identityConflict) throw error;
      }
    }
    if (!workspace) throw lastError instanceof Error ? lastError : new Error("The workspace could not be opened.");

    await get().refreshSessions();
    const openWorkspaceId = workspace.id;
    const alreadyOpen = get().sessions.find((session) => session.workspace_id === openWorkspaceId);
    const session = alreadyOpen ?? await api.createSession(
      { workspace_id: openWorkspaceId, title: deriveProjectTitle(root) || "Untitled project" },
      { idempotencyKey: `${operationKey}:session` },
    );
    if (!alreadyOpen) await get().refreshSessions();
    get().selectSession(session.id);
    void noteRecentProject(root);
    return session.id;
  },

  selectSession: (sessionId) => {
    writeLastSessionId(sessionId);
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
    if (!taskId) {
      get()._attachStream(null, null);
      return;
    }
    void get().refreshTask(taskId);
    void get().refreshApprovals(taskId);
    if (cursor !== null) {
      // The caller just created this task and holds its activation cursor;
      // there is no history to replay and the control plane will deliver
      // everything from that point.
      set((state) => ({
        transcriptByTask: {
          ...state.transcriptByTask,
          [taskId]: { status: "ready", earlierCursor: null, loadingEarlier: false, total: 0, error: null },
        },
      }));
      get()._attachStream(taskId, cursor);
      return;
    }
    void get().hydrateTranscript(taskId);
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
      seen = new Set((get().eventsByTask[taskId] ?? []).map(eventIdentity));
      eventIdsByTask.set(taskId, seen);
    }
    const identity = eventIdentity(presentationEvent);
    if (seen.has(identity)) return false;
    seen.add(identity);
    lastEventAtByTask.set(taskId, Date.now());
    if (presentationEvent.id) {
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
      /*
       * What this batch said about each task's run, and which tasks just
       * settled one.
       *
       * A terminal turn event is the moment the snapshot behind it goes stale:
       * `projectTaskEvent` ignores `turn.*` entirely, so `active_turn` was
       * carried forward forever and the composer kept offering "Steer" for a
       * run that had ended minutes earlier.
       */
      const batchActivity = new Map<string, TurnActivity>();
      const settledTaskIds = new Set<string>();
      for (const [queuedTaskId, batch] of batches) {
        const activity = turnActivityFromEvents(batch.map((entry) => entry.event));
        if (activity !== "unknown") batchActivity.set(queuedTaskId, activity);
        if (batch.some((entry) => TURN_SETTLED_EVENTS.has(entry.event.event))) {
          settledTaskIds.add(queuedTaskId);
        }
      }
      set((state) => {
        const eventsByTask = { ...state.eventsByTask };
        const eventBytesByTask = { ...state.eventBytesByTask };
        const eventLruTickByTask = { ...state.eventLruTickByTask };
        const retainedResumeCursorByTask = { ...state.resumeCursorByTask };
        let eventLruClock = state.eventLruClock;
        let eventHistoryByTask = state.eventHistoryByTask;
        for (const [queuedTaskId, batch] of batches) {
          const existing = eventsByTask[queuedTaskId] ?? [];
          const prior = state.eventHistoryByTask[queuedTaskId] ?? null;
          const retained = retainEventWindow(
            {
              events: existing,
              eventBytes: eventBytesByTask[queuedTaskId]
                ?? existing.reduce((total, event) => total + presentationEventByteLength(event), 0),
              /*
               * Derived from the retained window itself, deliberately, and not
               * from the `eventIdsByTask` set that `_appendEvent` maintains.
               *
               * That set is not authoritative: `hydrateTranscript` and cursor
               * reconciliation both replace `eventsByTask` wholesale without
               * touching it. Reusing it saves one walk of the window per flush
               * and costs correctness — stale identities make genuinely new
               * events look like duplicates and the transcript silently stays
               * empty. Rebuilding here is what re-syncs the two, and at ~0.03ms
               * per flush it is 4% of what measuring the window used to cost.
               */
              seenEventIds: new Set(existing.map(eventIdentity)),
              cursor: state.resumeCursorByTask[queuedTaskId] ?? null,
              boundary: prior,
            },
            batch.map((entry) => entry.event),
            {
              maxEvents: MAX_EVENTS_PER_TASK,
              maxBytes: MAX_EVENT_BYTES_PER_TASK,
              snapshotUrl: `/v1/tasks/${encodeURIComponent(queuedTaskId)}`,
            },
          );
          // `retainEventWindow` already returns freshly sliced arrays and a set
          // it built for this call, so copying them again was three more walks
          // of the whole window per flush for no isolation we did not have.
          // When nothing was accepted it returns the *same* events array, and
          // adopting it keeps the reference stable so subscribers see no change.
          const next = retained.events as TerminusSseEvent[];
          const dropped = retained.dropped;
          eventsByTask[queuedTaskId] = next;
          eventBytesByTask[queuedTaskId] = retained.eventBytes;
          eventIdsByTask.set(queuedTaskId, retained.seenEventIds as Set<string>);
          eventLruClock += 1;
          eventLruTickByTask[queuedTaskId] = eventLruClock;
          const resumeCursor = resumeCursorByTask.get(queuedTaskId);
          if (resumeCursor) retainedResumeCursorByTask[queuedTaskId] = resumeCursor;
          const pendingDrop = pendingDrops.get(queuedTaskId);
          if (dropped.length === 0 && !pendingDrop) continue;
          const droppedThroughCursor = dropped[dropped.length - 1]?.id
            ?? pendingDrop?.throughCursor
            ?? prior?.droppedThroughCursor
            ?? null;
          const retainedBoundary = retained.boundary;
          const boundary: EventHistoryBoundary = retainedBoundary?.reason === "cursor_expired"
            ? {
                ...retainedBoundary,
                droppedThroughCursor,
                continuationCursor: next[0]?.id ?? null,
              }
            : {
                reason: "bounded_window",
                omittedCount: (retainedBoundary?.omittedCount ?? 0) + (pendingDrop?.count ?? 0),
                droppedThroughCursor,
                continuationCursor: next[0]?.id ?? null,
                snapshotUrl: `/v1/tasks/${encodeURIComponent(queuedTaskId)}`,
                reconciliation: "ready",
                error: null,
                globalEvictedCount: retainedBoundary?.globalEvictedCount ?? 0,
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
        let runActivityByTask = state.runActivityByTask;
        for (const [activityTaskId, activity] of batchActivity) {
          if (runActivityByTask[activityTaskId] === activity) continue;
          if (runActivityByTask === state.runActivityByTask) runActivityByTask = { ...state.runActivityByTask };
          runActivityByTask[activityTaskId] = activity;
        }
        return {
          eventsByTask,
          eventBytesByTask,
          eventLruTickByTask,
          eventLruClock,
          resumeCursorByTask: retainedResumeCursorByTask,
          runActivityByTask,
          eventHistoryByTask,
        };
      });
      for (const approvalTaskId of approvalTasks) void get().refreshApprovals(approvalTaskId);
      for (const settledTaskId of settledTaskIds) {
        const existingTimer = settledRefreshTimers.get(settledTaskId);
        if (existingTimer) clearTimeout(existingTimer);
        settledRefreshTimers.set(settledTaskId, setTimeout(() => {
          settledRefreshTimers.delete(settledTaskId);
          void get().refreshTask(settledTaskId);
        }, TURN_SETTLED_REFRESH_DEBOUNCE_MS));
      }
    };
    // SSE ingestion is not visual work. A bounded timer continues to make
    // progress when Electron throttles animation frames in the background.
    setTimeout(flush, EVENT_BATCH_MS);
    return true;
  },

  _updateTaskFromEvent: (ev, streamTaskId) => {
    const projection = projectTaskEvent(ev, streamTaskId);
    if (!projection) return;
    const { taskId, status, phase, terminalReason } = projection;
    set((state) => {
      const existing = state.taskById[taskId];
      // Returning a fresh `{}` here still counts as a state change to zustand,
      // which then wakes every subscriber in the app to re-run its selector for
      // an event about a task we are not even holding. Returning the current
      // state is identity-equal, so the notification is skipped entirely.
      if (!existing) return state;
      const nextStatus = status ?? existing.status;
      const nextPhase = phase ?? existing.phase;
      const nextTerminalReason = terminalReason ?? existing.terminal_reason;
      // A stream re-announcing the state a task is already in must not clone
      // `taskById` and re-map the session's task array: those new identities
      // re-render every task list and header for no visible difference.
      if (
        nextStatus === existing.status
        && nextPhase === existing.phase
        && nextTerminalReason === existing.terminal_reason
      ) {
        return state;
      }
      const updated: Task = {
        ...existing,
        status: nextStatus,
        phase: nextPhase,
        terminal_reason: nextTerminalReason,
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
        const cursorExpiry = projectCursorExpiredEvent(ev, taskId, cursor);
        if (cursorExpiry) {
          // Reconciliation is required even when the diagnostic payload is
          // malformed; never treat the old event tail as complete.
          resumeCursor = cursorExpiry.resumeCursor;
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
          set((state) => {
            const eventLruTickByTask = { ...state.eventLruTickByTask };
            delete eventLruTickByTask[taskId];
            const retainedResumeCursorByTask = { ...state.resumeCursorByTask };
            if (resumeCursor) retainedResumeCursorByTask[taskId] = resumeCursor;
            else delete retainedResumeCursorByTask[taskId];
            const runActivityByTask = { ...state.runActivityByTask };
            // The window was just emptied, so the tail no longer says anything
            // about the run. The task snapshot fetched below is the authority
            // again until the next event arrives.
            delete runActivityByTask[taskId];
            return {
              eventsByTask: { ...state.eventsByTask, [taskId]: [] },
              eventBytesByTask: { ...state.eventBytesByTask, [taskId]: 0 },
              eventLruTickByTask,
              resumeCursorByTask: retainedResumeCursorByTask,
              runActivityByTask,
              eventHistoryByTask: {
                ...state.eventHistoryByTask,
                [taskId]: cursorExpiry.boundary,
              },
            };
          });
          // Snapshot actions carry their own per-resource generations. Older
          // cursor reconciliation cannot overwrite a newer manual refresh,
          // and the second successful resource settles the pending boundary.
          void Promise.all([get().refreshTask(taskId), get().refreshApprovals(taskId)]);
          // The window was just emptied. Replaying the durable transcript
          // refills it and re-attaches the stream at the replayed tail, which
          // is the difference between "we lost your history" and a two-second
          // reload the user never notices.
          void get().hydrateTranscript(taskId);
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
        // Keep the transport's own words. "Interrupted" alone told the user
        // nothing they could act on; an HTTP status tells them whether to
        // check credentials, the route, or whether the service is up at all.
        const reason = stream.lastError;
        set({
          streamState: "reconnecting",
          lastError: reason
            ? `Live updates interrupted — ${reason}. Reconnecting…`
            : "Live updates interrupted. Reconnecting…",
        });
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

/**
 * What each loaded task's event tail last said about a run.
 *
 * Pass a row's entry to `displayLifecycleWith` / `taskRunIsActiveWith`. This is
 * the map, not the events, precisely so a streaming turn does not re-render
 * every list that shows a status glyph.
 */
export function useRunActivityByTask(): Record<string, TurnActivity> {
  return useTerminusStore((s) => s.runActivityByTask);
}

/** The selected task's run activity, for surfaces that only render one task. */
export function useSelectedTaskRunActivity(): TurnActivity {
  const id = useTerminusStore((s) => s.selectedTaskId);
  return useTerminusStore((s) => (id ? s.runActivityByTask[id] : undefined) ?? "unknown");
}

/**
 * Catch a run that ended without telling this client.
 *
 * Events are lost for ordinary reasons — window eviction, cursor expiry, a
 * control-plane restart mid-turn — and every one of them strands a task on
 * "Working" with a spinner that never stops. When a task claims a running turn
 * and its stream has said nothing for a minute, ask what the turn is doing.
 *
 * Mounted once, by the app shell.
 */
export function useTurnWatchdog(): void {
  useEffect(() => {
    const timer = setInterval(() => {
      const state = useTerminusStore.getState();
      const taskId = state.selectedTaskId;
      if (taskId === null) return;
      if (!state.taskById[taskId]?.active_turn) return;
      const silentFor = Date.now() - (lastEventAtByTask.get(taskId) ?? 0);
      if (silentFor < STUCK_TURN_SILENCE_MS) return;
      void state.reconcileActiveTurn(taskId);
    }, STUCK_TURN_CHECK_MS);
    return () => clearInterval(timer);
  }, []);
}

/**
 * Keep asking whether the control plane is there.
 *
 * The probe used to run exactly once, inside `refreshSessions`. A client that
 * started before the control plane did therefore said "Terminus is still
 * starting" until something else happened to refresh — often forever. This
 * retries quickly while it is down (1s, doubling to 30s) and settles into a
 * one-minute heartbeat once it answers, so recovery is noticed without
 * hammering a service that is already struggling.
 *
 * Mounted once, by the app shell.
 */
export function useHealthMonitor(): void {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = HEALTH_RETRY_MIN_MS;
    const isCurrent = (): boolean => !cancelled;
    const tick = async (): Promise<void> => {
      await probeHealth((partial) => useTerminusStore.setState(partial), isCurrent);
      if (cancelled) return;
      const ready = useTerminusStore.getState().healthStatus === "ready";
      if (ready) backoff = HEALTH_RETRY_MIN_MS;
      const delay = ready ? HEALTH_HEARTBEAT_MS : backoff;
      if (!ready) backoff = Math.min(backoff * 2, HEALTH_RETRY_MAX_MS);
      timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}

/** Pinned tasks (resolved from ids → Task objects). */
/**
 * Hold a list's identity steady while its members are unchanged.
 *
 * `taskById` gets a new identity whenever any task anywhere is refreshed, so a
 * list derived from it was rebuilt — and handed back as a new array — on every
 * unrelated task update. Downstream that array is a `useMemo` dependency and a
 * prop to memoised rows, so a new identity re-renders the whole list for data
 * that did not move. Comparing members is O(pins) and turns "something changed
 * somewhere" back into "these pins changed".
 */
function useStableList<T>(next: readonly T[]): T[] {
  const held = useRef<readonly T[]>(next);
  const previous = held.current;
  if (
    previous !== next
    && (previous.length !== next.length || next.some((value, index) => previous[index] !== value))
  ) {
    held.current = next;
  }
  return held.current as T[];
}

export function usePinnedTasks(): Task[] {
  const pins = useTerminusStore((s) => s.pinnedTaskIds);
  const taskById = useTerminusStore((s) => s.taskById);
  const pinned = useMemo(() => {
    const out: Task[] = [];
    for (const id of pins) {
      const t = taskById[id];
      if (t) out.push(t);
    }
    return out;
  }, [pins, taskById]);
  return useStableList(pinned);
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

/** Durable-transcript replay state for the selected task. */
export function useSelectedTaskTranscript(): TranscriptReplayState | null {
  const id = useTerminusStore((s) => s.selectedTaskId);
  return useTerminusStore((s) => (id ? s.transcriptByTask[id] : undefined) ?? null);
}

/** Explicit truncation/cursor-expiry state for the selected event window. */
export function useSelectedTaskEventHistory(): EventHistoryBoundary | null {
  const id = useTerminusStore((s) => s.selectedTaskId);
  return useTerminusStore((s) => (id ? s.eventHistoryByTask[id] : undefined) ?? null);
}

const EMPTY_APPROVALS: PendingApproval[] = [];
/** Shared "no page loaded yet" value, so the empty case keeps one identity. */
const EMPTY_COLLECTION_PAGE: CollectionPageState = Object.freeze(initialCollectionPage());

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
  // Both the object literal and `initialCollectionPage()` minted a new identity
  // on every render, so two consumers (Conversation and Inspector) re-rendered
  // on every 50ms flush even when no approval had changed.
  return useMemo(
    () => ({
      approvals,
      status: freshness?.status ?? "loading",
      error: freshness?.error ?? null,
      page: page ?? EMPTY_COLLECTION_PAGE,
    }),
    [approvals, freshness?.status, freshness?.error, page],
  );
}
