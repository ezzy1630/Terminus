/**
 * Provider-neutral projections for public-client consumers.
 *
 * These helpers deliberately do not own transport, persistence, or UI state.
 * They turn the public SSE contract into bounded presentation data while
 * preserving the server cursor and making loss/reconciliation explicit.
 */
import type { ApprovalSnapshot, SseEvent } from "@terminus/public-api";

export type ClientEventTone = "default" | "muted" | "good" | "warn" | "danger" | "accent";
export type ClientEventPresentation = "user" | "agent" | "tool" | "system";

export interface ClientEventProjection {
  readonly id: string;
  readonly cursor: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: string;
  readonly time: string;
  readonly tone: ClientEventTone;
  readonly presentation: ClientEventPresentation;
}

export type TimelineProjection = ClientEventProjection;

export type ClientTaskDomainStatus =
  | "DRAFT"
  | "ACTIVE"
  | "NEEDS_USER_DECISION"
  | "BLOCKED"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "FAILED_VERIFICATION"
  | "BUDGET_EXHAUSTED"
  | "POLICY_DENIED"
  | "ABORTED";

export type ClientTaskStatusKind =
  | "working"
  | "queued"
  | "waiting"
  | "needs_approval"
  | "needs_review"
  | "failed"
  | "interrupted"
  | "done"
  | "unknown";

export interface TaskEventProjection {
  readonly taskId: string;
  readonly status: ClientTaskDomainStatus | null;
  readonly phase: string | null;
  readonly terminalReason: Record<string, unknown> | null;
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

export const DEFAULT_PRESENTATION_EVENT_MAX_CHARS = 128 * 1024;
export const PRESENTATION_REJECTION_KEY = "terminus_presentation_rejection";

const DEFAULT_TUI_MAX_ITEMS = 500;
const DEFAULT_TUI_MAX_SEEN_IDS = 1_000;
const TASK_DOMAIN_STATUSES: ReadonlySet<string> = new Set([
  "DRAFT",
  "ACTIVE",
  "NEEDS_USER_DECISION",
  "BLOCKED",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "FAILED_VERIFICATION",
  "BUDGET_EXHAUSTED",
  "POLICY_DENIED",
  "ABORTED",
]);

function eventPayload(event: SseEvent): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(event.data);
    return recordFrom(value);
  } catch {
    return null;
  }
}

function recordFrom(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function stringField(
  record: Readonly<Record<string, unknown>> | null,
  ...keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function stringArrayField(
  record: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    if (strings.length > 0) return strings;
  }
  return undefined;
}

function conciseJson(value: unknown): string | null {
  const record = recordFrom(value);
  if (!record) return null;
  for (const key of ["message", "summary", "status", "phase", "reason", "error", "objective", "command", "path"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

function eventTone(event: string): ClientEventTone {
  const value = event.toLowerCase();
  if (value.includes("fail") || value.includes("error") || value.includes("denied")) return "danger";
  if (value.includes("approval") || value.includes("attention") || value.includes("wait")) return "warn";
  if (value.includes("complete") || value.includes("verified") || value.includes("allowed")) return "good";
  if (value.includes("start") || value.includes("task") || value.includes("turn")) return "accent";
  return "default";
}

function eventPresentation(event: string): ClientEventPresentation {
  if (event === "turn.started") return "user";
  if (event === "turn.provider_running" || event === "turn.completed" || event.startsWith("response.")) return "agent";
  if (event.startsWith("tool.")) return "tool";
  return "system";
}

function eventSummary(event: string, parsed: unknown, raw: string): string {
  const record = recordFrom(parsed);
  if (event === "turn.started") return stringField(record, "user_input", "message") ?? "Turn started";
  if (event === "turn.provider_running") return stringField(record, "delta", "response", "summary") ?? "Agent is working";
  if (event === "turn.completed") return stringField(record, "summary", "response", "message") ?? "Turn completed";
  if (event.startsWith("tool.")) {
    const tool = stringField(record, "tool", "toolId", "tool_id") ?? "tool";
    const detail = stringField(record, "args_summary", "summary", "command", "path", "result_status", "status");
    return detail ? `${tool} · ${detail}` : tool;
  }
  return conciseJson(parsed) ?? (raw.trim() || event);
}

/** Stable identity used for deduplication when a producer omitted an id. */
export function eventIdentity(event: Pick<SseEvent, "id" | "event" | "data">): string {
  return event.id || `${event.event}:${event.data}`;
}

/** Convert one untrusted public event into bounded, renderable timeline data. */
export function projectEvent(event: SseEvent, now = new Date()): ClientEventProjection {
  const bounded = boundPresentationEvent(event);
  const parsed = eventPayload(bounded);
  const timestamp = Number.isFinite(now.getTime()) ? now.toISOString() : new Date(0).toISOString();
  return {
    id: eventIdentity(bounded),
    cursor: bounded.id,
    kind: bounded.event || "message",
    summary: eventSummary(bounded.event, parsed, bounded.data),
    detail: bounded.data,
    time: timestamp,
    tone: eventTone(bounded.event),
    presentation: eventPresentation(bounded.event),
  };
}

export function timelineItemFromEvent(event: SseEvent, now = new Date()): ClientEventProjection {
  return projectEvent(event, now);
}

/**
 * Bound only the presentation payload. The id and event name remain intact so
 * consumers can advance the durable cursor and reconcile terminal state.
 */
export function boundPresentationEvent(
  event: SseEvent,
  maxChars = DEFAULT_PRESENTATION_EVENT_MAX_CHARS,
): SseEvent {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new RangeError("maxChars must be a positive safe integer");
  }
  if (event.data.length <= maxChars) return event;
  return {
    ...event,
    data: JSON.stringify({
      [PRESENTATION_REJECTION_KEY]: {
        reason: "event_payload_too_large",
        source_event: event.event,
        character_count: event.data.length,
        limit: maxChars,
      },
    }),
  };
}

/** Exact UTF-8 presentation cost for one event envelope. */
const EVENT_TEXT_ENCODER = new TextEncoder();

export function eventByteLength(event: Pick<SseEvent, "id" | "event" | "data">): number {
  const encoder = EVENT_TEXT_ENCODER;
  return encoder.encode(event.id).byteLength
    + encoder.encode(event.event).byteLength
    + encoder.encode(event.data).byteLength;
}

export const presentationEventByteLength = eventByteLength;

export interface EventWindowState {
  readonly events: readonly SseEvent[];
  readonly eventBytes: number;
  readonly seenEventIds: ReadonlySet<string>;
  readonly cursor: string | null;
  readonly boundary: EventHistoryBoundary | null;
}

export interface EventWindowOptions {
  readonly maxEvents: number;
  readonly maxBytes?: number;
  readonly snapshotUrl?: string | null;
  readonly maxSeenEventIds?: number;
}

export interface EventWindowResult extends EventWindowState {
  readonly accepted: boolean;
  readonly dropped: readonly SseEvent[];
}

function validateWindowOptions(options: EventWindowOptions): void {
  if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents <= 0) {
    throw new RangeError("maxEvents must be a positive safe integer");
  }
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (options.maxSeenEventIds !== undefined && (!Number.isSafeInteger(options.maxSeenEventIds) || options.maxSeenEventIds <= 0)) {
    throw new RangeError("maxSeenEventIds must be a positive safe integer");
  }
}

/**
 * Retain the newest unique events under count and UTF-8 byte limits.
 * `cursor` advances for every newly accepted event, including an event later
 * omitted from the presentation window; it is a replay cursor, not a view
 * cursor. A prior cursor-expiry boundary stays visible until reconciliation.
 */
export function retainEventWindow(
  state: EventWindowState,
  incoming: readonly SseEvent[],
  options: EventWindowOptions,
): EventWindowResult {
  validateWindowOptions(options);
  const seen = new Set(state.seenEventIds);
  const acceptedEvents: SseEvent[] = [];
  let cursor = state.cursor;
  for (const event of incoming) {
    const identity = eventIdentity(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    acceptedEvents.push(event);
    if (event.id) cursor = event.id;
  }
  if (acceptedEvents.length === 0) {
    return {
      ...state,
      seenEventIds: seen,
      cursor,
      accepted: false,
      dropped: [],
    };
  }

  const combined = [...state.events, ...acceptedEvents];
  const bytes = combined.map(eventByteLength);
  let retainedStart = Math.max(0, combined.length - options.maxEvents);
  let retainedBytes = bytes.slice(retainedStart).reduce((total, value) => total + value, 0);
  while (options.maxBytes !== undefined && retainedBytes > options.maxBytes && retainedStart < combined.length) {
    retainedBytes -= bytes[retainedStart] ?? 0;
    retainedStart += 1;
  }
  const dropped = combined.slice(0, retainedStart);
  const events = combined.slice(retainedStart);
  for (const event of dropped) seen.delete(eventIdentity(event));

  const maxSeenEventIds = options.maxSeenEventIds ?? Number.MAX_SAFE_INTEGER;
  if (seen.size > maxSeenEventIds) {
    const retainedIds = new Set(events.map(eventIdentity));
    const newestIdentities = [...acceptedEvents].reverse().map(eventIdentity);
    for (const identity of newestIdentities) {
      if (retainedIds.has(identity)) continue;
      retainedIds.add(identity);
      if (retainedIds.size >= maxSeenEventIds) break;
    }
    seen.clear();
    for (const identity of retainedIds) seen.add(identity);
  }

  let boundary = state.boundary;
  if (dropped.length > 0) {
    const droppedThroughCursor = dropped[dropped.length - 1]?.id
      ?? state.boundary?.droppedThroughCursor
      ?? null;
    const continuationCursor = events[0]?.id ?? null;
    boundary = state.boundary?.reason === "cursor_expired"
      ? {
          ...state.boundary,
          droppedThroughCursor,
          continuationCursor,
        }
      : {
          reason: "bounded_window",
          omittedCount: (state.boundary?.omittedCount ?? 0) + dropped.length,
          droppedThroughCursor,
          continuationCursor,
          snapshotUrl: options.snapshotUrl ?? null,
          reconciliation: "ready",
          error: null,
          globalEvictedCount: state.boundary?.globalEvictedCount ?? 0,
        };
  }
  return {
    events,
    eventBytes: retainedBytes,
    seenEventIds: seen,
    cursor,
    boundary,
    accepted: true,
    dropped,
  };
}

export interface ProjectedEventWindowState {
  readonly items: readonly ClientEventProjection[];
  readonly seenEventIds: ReadonlySet<string>;
  readonly cursor: string | null;
}

export interface ProjectedEventWindowResult extends ProjectedEventWindowState {
  readonly accepted: boolean;
}

/** Shared TUI/desktop-friendly projection window for timeline surfaces. */
export function appendProjectedEvent(
  state: ProjectedEventWindowState,
  event: SseEvent,
  options: { readonly maxItems?: number; readonly maxSeenEventIds?: number; readonly now?: Date } = {},
): ProjectedEventWindowResult {
  const maxItems = options.maxItems ?? DEFAULT_TUI_MAX_ITEMS;
  const maxSeenEventIds = options.maxSeenEventIds ?? DEFAULT_TUI_MAX_SEEN_IDS;
  if (!Number.isSafeInteger(maxItems) || maxItems <= 0) throw new RangeError("maxItems must be a positive safe integer");
  if (!Number.isSafeInteger(maxSeenEventIds) || maxSeenEventIds <= 0) throw new RangeError("maxSeenEventIds must be a positive safe integer");
  const bounded = boundPresentationEvent(event);
  const identity = eventIdentity(bounded);
  if (state.seenEventIds.has(identity)) {
    return { ...state, accepted: false };
  }
  const seen = new Set(state.seenEventIds);
  seen.add(identity);
  const items = [...state.items, projectEvent(bounded, options.now)];
  const retained = items.length > maxItems ? items.slice(items.length - maxItems) : items;
  if (seen.size > maxSeenEventIds) {
    seen.clear();
    for (const item of retained) seen.add(item.id);
  }
  return {
    items: retained,
    seenEventIds: seen,
    cursor: event.id || state.cursor,
    accepted: true,
  };
}

/** Normalize wire/domain task statuses into the stable client vocabulary. */
export function normalizeTaskStatus(status: string): ClientTaskStatusKind {
  const value = status.toLowerCase();
  if (value === "active" || value === "running" || value === "verifying" || value === "provider_running") return "working";
  if (value === "draft" || value === "pending" || value === "queued") return "queued";
  if (value === "needs_user_decision" || value === "waiting" || value === "blocked") return "waiting";
  if (value === "needs_approval" || value === "approval_required") return "needs_approval";
  if (value === "needs_review" || value === "review_required") return "needs_review";
  if (value === "failed" || value === "failed_verification" || value === "budget_exhausted" || value === "policy_denied" || value === "error") return "failed";
  if (value === "aborted" || value === "interrupted" || value === "cancelled" || value === "canceled") return "interrupted";
  if (value === "completed" || value === "done" || value === "success") return "done";
  return "unknown";
}

function isTaskDomainStatus(value: unknown): value is ClientTaskDomainStatus {
  return typeof value === "string" && TASK_DOMAIN_STATUSES.has(value);
}

/** Project task state transitions without allowing a stream payload to cross task scope. */
export function projectTaskEvent(event: SseEvent, streamTaskId?: string): TaskEventProjection | null {
  if (!event.event.startsWith("task.")) return null;
  const payload = eventPayload(event);
  if (!payload) return null;
  const explicitTaskId = stringField(payload, "task_id", "id");
  if (streamTaskId && explicitTaskId && explicitTaskId !== streamTaskId) return null;
  const taskId = streamTaskId ?? explicitTaskId;
  if (!taskId) return null;
  const eventStatus: ClientTaskDomainStatus | null = event.event === "task.completed"
    ? "COMPLETED"
    : event.event === "task.failed"
      ? "FAILED"
      : event.event === "task.interrupted" || event.event === "task.aborted"
        ? "ABORTED"
        : null;
  const terminalReason = event.event === "task.blocked" && typeof payload.reason === "string"
    ? {
        reason: payload.reason,
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      }
    : null;
  return {
    taskId,
    status: isTaskDomainStatus(payload.status) ? payload.status : eventStatus,
    phase: typeof payload.phase === "string" ? payload.phase : null,
    terminalReason,
  };
}

export interface CursorExpiredProjection {
  readonly requestedCursor: string | null;
  readonly oldestRetainedEventId: string | null;
  readonly resumeCursor: string | null;
  readonly snapshotUrl: string | null;
  readonly boundary: EventHistoryBoundary;
}

/** Interpret the public cursor-expiry event without trusting arbitrary URLs. */
export function projectCursorExpiredEvent(
  event: SseEvent,
  taskId: string,
  fallbackCursor: string | null = null,
): CursorExpiredProjection | null {
  if (event.event !== "cursor_expired") return null;
  const payload = eventPayload(event);
  const requestedCursor = stringField(payload, "cursor") ?? fallbackCursor;
  const oldestRetainedEventId = stringField(payload, "oldest_retained_event_id", "oldestRetainedEventId");
  const resumeCursor = oldestRetainedEventId ?? (event.id || null);
  const expectedSnapshotUrl = `/v1/tasks/${encodeURIComponent(taskId)}`;
  const snapshotUrl = stringField(payload, "snapshot_url", "snapshotUrl") === expectedSnapshotUrl
    ? expectedSnapshotUrl
    : null;
  return {
    requestedCursor,
    oldestRetainedEventId,
    resumeCursor,
    snapshotUrl,
    boundary: {
      reason: "cursor_expired",
      omittedCount: null,
      droppedThroughCursor: requestedCursor,
      continuationCursor: oldestRetainedEventId,
      snapshotUrl,
      reconciliation: "pending",
      error: null,
      globalEvictedCount: 0,
    },
  };
}

export interface PendingApproval {
  id: string;
  action: string;
  risk: "low" | "normal" | "high" | "critical" | "unknown";
  reversibility?: string;
  operationHash?: string;
  operation?: string;
  reason?: string;
  scope?: string[];
  environment?: string;
  requestedAt?: string;
  expiresAt?: string;
  canPersist: boolean;
  supportedDecisions: ApprovalSnapshot["supported_decisions"];
  authorizationReady: boolean;
}

export interface SubagentActivity {
  id: string;
  role: string;
  state: "working" | "done" | "failed";
  worktreeId?: string;
}

export interface VerificationActivity {
  id: string;
  state: "passed" | "failed" | "running";
  detail: string;
}

export interface ComputerUseActivity {
  active: boolean;
  paused: boolean;
}

function approvalRisk(value: string | null): PendingApproval["risk"] {
  return value === "low" || value === "normal" || value === "high" || value === "critical" ? value : "unknown";
}

/** Short, stable display label for an operation hash when no plain-language summary exists. */
export function operationLabel(operationHash: string): string {
  const short = operationHash.length > 14 ? `${operationHash.slice(0, 13)}…` : operationHash;
  return `Pending effect ${short}`;
}

/** Project the authoritative approval snapshot into a deny-safe presentation model. */
export function pendingApprovalFromServerRow(row: ApprovalSnapshot): PendingApproval {
  const binding = row.binding;
  const display = row.display;
  const expiryMatches = binding?.expires_at === row.expires_at;
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : null;
  const unexpired = expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > Date.now());
  const risk = approvalRisk(row.risk);
  const authorizationReady = Boolean(
    binding
      && display
      && binding.task_id === row.task_id
      && binding.exact_action === display.exact_action
      && binding.use_limit === row.use_limit
      && expiryMatches
      && unexpired
      && row.scope.length > 0
      && risk !== "unknown",
  );
  return {
    id: row.id,
    action: display?.summary ?? operationLabel(row.operation_hash),
    risk,
    ...(display?.reversibility ? { reversibility: display.reversibility } : {}),
    operationHash: row.operation_hash,
    ...(display?.exact_action ? { operation: display.exact_action } : {}),
    ...(display?.reason ? { reason: display.reason } : {}),
    ...(row.scope.length > 0 ? { scope: row.scope } : {}),
    ...(display?.environment ? { environment: display.environment } : {}),
    requestedAt: row.requested_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    canPersist: row.use_limit > 1,
    supportedDecisions: row.supported_decisions,
    authorizationReady,
  };
}

/** Merge server authority with event context without widening authorization. */
export function mergePendingApprovals(server: PendingApproval[], derived: PendingApproval[]): PendingApproval[] {
  const byId = new Map<string, PendingApproval>();
  for (const entry of server) byId.set(entry.id, entry);
  for (const entry of derived) {
    const current = byId.get(entry.id);
    if (!current) {
      byId.set(entry.id, { ...entry, canPersist: false, authorizationReady: false });
      continue;
    }
    const operationMatches = Boolean(current.operationHash && entry.operationHash && current.operationHash === entry.operationHash);
    if (!operationMatches || current.authorizationReady) continue;
    const next: PendingApproval = {
      ...current,
      action: entry.action,
      risk: entry.risk === "unknown" ? current.risk : entry.risk,
      canPersist: current.canPersist && entry.canPersist,
      authorizationReady: false,
    };
    if (entry.reversibility !== undefined) next.reversibility = entry.reversibility;
    if (entry.operation !== undefined) next.operation = entry.operation;
    if (entry.reason !== undefined) next.reason = entry.reason;
    if (entry.scope !== undefined) next.scope = entry.scope;
    if (entry.environment !== undefined) next.environment = entry.environment;
    if (entry.requestedAt !== undefined) next.requestedAt = entry.requestedAt;
    byId.set(entry.id, next);
  }
  return [...byId.values()];
}

export function derivePendingApprovals(events: SseEvent[]): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();
  for (const event of events) {
    const payload = eventPayload(event);
    if (!payload) continue;
    if (event.event === "approval.requested") {
      const id = stringField(payload, "approval_id", "approvalId");
      if (!id) continue;
      const operationHash = stringField(payload, "operation_hash", "operationHash");
      const operation = stringField(payload, "operation", "command", "exact_operation", "exactOperation");
      const approval: PendingApproval = {
        id,
        action: stringField(payload, "operation_summary", "operationSummary")
          ?? (operationHash ? operationLabel(operationHash) : "Approval details unavailable"),
        risk: approvalRisk(stringField(payload, "risk")),
        canPersist: typeof payload.use_limit === "number"
          ? payload.use_limit > 1
          : payload.can_persist === true || payload.canPersist === true,
        supportedDecisions: ["deny_once"],
        authorizationReady: false,
      };
      const reversibility = stringField(payload, "reversibility");
      if (reversibility) approval.reversibility = reversibility;
      if (operationHash) approval.operationHash = operationHash;
      if (operation) approval.operation = operation;
      const reason = stringField(payload, "reason", "rationale", "why_required", "whyRequired");
      if (reason) approval.reason = reason;
      const scope = stringArrayField(payload, "scope", "affected_paths", "affectedPaths");
      if (scope) approval.scope = scope;
      const environment = stringField(payload, "environment", "affected_environment", "affectedEnvironment");
      if (environment) approval.environment = environment;
      const requestedAt = stringField(payload, "requested_at", "requestedAt");
      if (requestedAt) approval.requestedAt = requestedAt;
      const expiresAt = stringField(payload, "expires_at", "expiresAt");
      if (expiresAt) approval.expiresAt = expiresAt;
      pending.set(id, approval);
    }
    if (event.event === "approval.resolved") {
      const id = stringField(payload, "approval_id", "approvalId");
      if (id) pending.delete(id);
    }
  }
  return [...pending.values()];
}

export function deriveSubagentActivity(events: SseEvent[]): SubagentActivity[] {
  const agents = new Map<string, SubagentActivity>();
  for (const event of events) {
    const payload = eventPayload(event);
    if (!payload) continue;
    if (event.event === "agent.spawned") {
      const id = stringField(payload, "agent_id", "agentId");
      if (!id) continue;
      const activity: SubagentActivity = { id, role: stringField(payload, "role") ?? "Delegated task", state: "working" };
      const worktreeId = stringField(payload, "worktree_id", "worktreeId");
      if (worktreeId) activity.worktreeId = worktreeId;
      agents.set(id, activity);
    }
    if (event.event === "agent.completed") {
      const id = stringField(payload, "agent_id", "agentId");
      const current = id ? agents.get(id) : undefined;
      if (!id || !current) continue;
      const status = stringField(payload, "status")?.toLowerCase() ?? "";
      agents.set(id, { ...current, state: status.includes("fail") ? "failed" : "done" });
    }
  }
  return [...agents.values()];
}

export function deriveVerificationActivity(events: SseEvent[]): VerificationActivity[] {
  const activity: VerificationActivity[] = [];
  for (const event of events) {
    const payload = eventPayload(event);
    if (!payload) continue;
    if (event.event === "verification.node_passed") {
      activity.push({ id: event.id, state: "passed", detail: stringField(payload, "node_id", "nodeId") ?? "Verification check" });
    } else if (event.event === "verification.node_failed") {
      const node = stringField(payload, "node_id", "nodeId") ?? "Verification check";
      const reason = stringField(payload, "reason");
      activity.push({ id: event.id, state: "failed", detail: reason ? `${node}: ${reason}` : node });
    } else if (event.event === "verification.plan_completed") {
      const status = stringField(payload, "status")?.toLowerCase();
      const passed = payload.passed === true || status === "all_passed" || status === "passed";
      activity.push({ id: event.id, state: passed ? "passed" : "failed", detail: passed ? "Verification plan passed" : "Verification plan failed" });
    }
  }
  return activity;
}

export function deriveComputerUseActivity(events: SseEvent[]): ComputerUseActivity {
  let active = false;
  let paused = false;
  for (const event of events) {
    if (event.event === "computer_use.started" || event.event === "computer-use.started") {
      active = true;
      paused = false;
    } else if (event.event === "computer_use.paused" || event.event === "computer-use.paused") {
      if (active) paused = true;
    } else if (event.event === "computer_use.resumed" || event.event === "computer-use.resumed") {
      if (active) paused = false;
    } else if (
      event.event === "computer_use.stopped"
      || event.event === "computer-use.stopped"
      || event.event === "computer_use.completed"
      || event.event === "computer-use.completed"
    ) {
      active = false;
      paused = false;
    }
  }
  return { active, paused };
}

/** Extract only explicit unified diff evidence from patch tool events. */
export function extractUnifiedDiffs(events: SseEvent[]): string[] {
  const diffs = new Set<string>();
  for (const event of events) {
    if (event.event !== "tool.proposed" && event.event !== "tool.settled") continue;
    const payload = eventPayload(event);
    if (!payload) continue;
    const nested = [payload, payload.args, payload.result].filter(
      (value): value is Readonly<Record<string, unknown>> => value !== null && typeof value === "object" && !Array.isArray(value),
    );
    for (const value of nested) {
      for (const field of ["diff", "patch", "unified_diff"]) {
        const candidate = stringField(value, field);
        if (candidate?.includes("diff --git ")) diffs.add(candidate);
      }
    }
  }
  return [...diffs];
}
