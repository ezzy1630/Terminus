import type {
  ApprovalSnapshot,
  ContextManifestSnapshot,
  SessionSnapshot,
  SseEvent,
  TaskSnapshot,
  TaskV2Snapshot,
} from "@terminus/public-api";

export type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";
export type FocusArea = "sessions" | "tasks" | "timeline" | "composer";
export type Tone = "default" | "muted" | "good" | "warn" | "danger" | "accent";
export type TimelinePresentation = "user" | "agent" | "tool" | "system";

export interface HealthSnapshot {
  readonly status: "ok" | "degraded" | "down";
  readonly version: string;
  readonly ready: boolean;
}

export interface TimelineItem {
  readonly id: string;
  readonly cursor: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: string;
  readonly time: string;
  readonly tone: Tone;
  readonly presentation: TimelinePresentation;
}

export interface MaterialQuestionView {
  readonly id: string;
  readonly taskId: string;
  readonly trigger: string;
  readonly questionText: string;
  readonly consequenceMatrix: Readonly<Record<string, string>>;
  readonly options: readonly string[];
  readonly status: "PENDING" | "ANSWERED" | "DISMISSED";
  readonly suggestedOption: string | null;
  readonly selectedOption: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface InterventionView {
  readonly id: string;
  readonly taskId: string;
  readonly verb: string;
  readonly rationale: string;
  readonly status: "PROPOSED" | "APPLIED" | "REJECTED";
  readonly timestamp: string;
}

export interface AttentionView {
  readonly requiresAttention: boolean;
  readonly urgency: "LOW" | "NORMAL" | "HIGH" | "BLOCKING";
  readonly reason: string;
}

export interface NewTaskDraft {
  readonly workspaceUri: string;
  readonly sessionTitle: string;
  readonly objective: string;
  readonly firstMessage: string;
  readonly field: 0 | 1 | 2 | 3;
}

export type ChoiceModal =
  | { readonly kind: "approval"; readonly selected: number }
  | { readonly kind: "question"; readonly selected: number };

export interface TextModal {
  readonly kind: "help" | "inspect" | "palette" | "confirm";
  readonly title: string;
  readonly body: readonly string[];
  readonly input: string;
  readonly scroll: number;
  readonly confirmAction?: "cancel_task" | "stop_job";
  readonly confirmTarget?: string;
}

export interface NewTaskModal {
  readonly kind: "new_task";
  readonly draft: NewTaskDraft;
}

export type Modal = ChoiceModal | TextModal | NewTaskModal;

export interface TuiState {
  readonly connection: ConnectionState;
  readonly health: HealthSnapshot | null;
  readonly sessions: readonly SessionSnapshot[];
  readonly tasks: readonly TaskSnapshot[];
  readonly selectedSession: number;
  readonly selectedTask: number;
  readonly selectedTimeline: number;
  readonly focus: FocusArea;
  readonly timeline: readonly TimelineItem[];
  readonly seenEventIds: ReadonlySet<string>;
  readonly lastCursor: string | null;
  readonly approvals: readonly ApprovalSnapshot[];
  readonly questions: readonly MaterialQuestionView[];
  readonly interventions: readonly InterventionView[];
  readonly taskV2: TaskV2Snapshot | null;
  readonly attention: AttentionView | null;
  readonly contextManifest: ContextManifestSnapshot | null;
  readonly artifactPreview: readonly string[] | null;
  readonly composer: string;
  readonly composerCursor: number;
  readonly composerHistory: readonly string[];
  readonly composerHistoryIndex: number | null;
  readonly commandSelection: number;
  readonly sidebarOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly modal: Modal | null;
  readonly notice: { readonly message: string; readonly tone: Tone } | null;
  readonly busy: string | null;
  readonly timelineScroll: number;
}

export function initialState(): TuiState {
  return {
    connection: "connecting",
    health: null,
    sessions: [],
    tasks: [],
    selectedSession: 0,
    selectedTask: 0,
    selectedTimeline: 0,
    focus: "timeline",
    timeline: [],
    seenEventIds: new Set(),
    lastCursor: null,
    approvals: [],
    questions: [],
    interventions: [],
    taskV2: null,
    attention: null,
    contextManifest: null,
    artifactPreview: null,
    composer: "",
    composerCursor: 0,
    composerHistory: [],
    composerHistoryIndex: null,
    commandSelection: 0,
    sidebarOpen: true,
    inspectorOpen: false,
    modal: null,
    notice: null,
    busy: null,
    timelineScroll: 0,
  };
}

export function selectedSession(state: TuiState): SessionSnapshot | null {
  return state.sessions[state.selectedSession] ?? null;
}

export function selectedTask(state: TuiState): TaskSnapshot | null {
  return state.tasks[state.selectedTask] ?? null;
}

export function pendingApprovals(state: TuiState): readonly ApprovalSnapshot[] {
  const task = selectedTask(state);
  return state.approvals.filter(
    (approval) => approval.status === "pending" && (task === null || approval.task_id === task.id),
  );
}

export function pendingQuestions(state: TuiState): readonly MaterialQuestionView[] {
  const task = selectedTask(state);
  return state.questions.filter(
    (question) => question.status === "PENDING" && (task === null || question.taskId === task.id),
  );
}

function eventTone(event: string): Tone {
  const value = event.toLowerCase();
  if (value.includes("fail") || value.includes("error") || value.includes("denied")) return "danger";
  if (value.includes("approval") || value.includes("attention") || value.includes("wait")) return "warn";
  if (value.includes("complete") || value.includes("verified") || value.includes("allowed")) return "good";
  if (value.includes("start") || value.includes("task") || value.includes("turn")) return "accent";
  return "default";
}

function conciseJson(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "summary", "status", "phase", "reason", "error", "objective", "command", "path"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

function recordFrom(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function stringField(record: Readonly<Record<string, unknown>> | null, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function eventPresentation(event: string): TimelinePresentation {
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

export function timelineItemFromEvent(event: SseEvent, now = new Date()): TimelineItem {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    parsed = null;
  }
  const summary = eventSummary(event.event, parsed, event.data);
  return {
    id: event.id || `${event.event}:${event.data}`,
    cursor: event.id,
    kind: event.event || "message",
    summary,
    detail: event.data,
    time: now.toISOString(),
    tone: eventTone(event.event),
    presentation: eventPresentation(event.event),
  };
}

export function appendEvent(state: TuiState, event: SseEvent, now?: Date): TuiState {
  const id = event.id || `${event.event}:${event.data}`;
  if (state.seenEventIds.has(id)) return state;
  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(id);
  const timeline = [...state.timeline, timelineItemFromEvent(event, now)];
  const retained = timeline.length > 500 ? timeline.slice(timeline.length - 500) : timeline;
  if (seenEventIds.size > 1_000) {
    const retainedIds = new Set(retained.map((item) => item.id));
    return {
      ...state,
      timeline: retained,
      seenEventIds: retainedIds,
      lastCursor: event.id || state.lastCursor,
      selectedTimeline: Math.max(0, retained.length - 1),
      timelineScroll: 0,
    };
  }
  return {
    ...state,
    timeline: retained,
    seenEventIds,
    lastCursor: event.id || state.lastCursor,
    selectedTimeline: Math.max(0, retained.length - 1),
    timelineScroll: 0,
  };
}

export function moveSelection(state: TuiState, delta: number): TuiState {
  if (state.modal?.kind === "approval" || state.modal?.kind === "question") {
    const choices = state.modal.kind === "approval"
      ? pendingApprovals(state)[0]?.supported_decisions.length ?? 0
      : pendingQuestions(state)[0]?.options.length ?? 0;
    const selected = clamp(state.modal.selected + delta, 0, Math.max(0, choices - 1));
    return { ...state, modal: { ...state.modal, selected } };
  }
  if (state.focus === "sessions") {
    return { ...state, selectedSession: clamp(state.selectedSession + delta, 0, state.sessions.length - 1) };
  }
  if (state.focus === "tasks") {
    return { ...state, selectedTask: clamp(state.selectedTask + delta, 0, state.tasks.length - 1) };
  }
  if (state.focus === "timeline") {
    return {
      ...state,
      selectedTimeline: clamp(state.selectedTimeline + delta, 0, state.timeline.length - 1),
      timelineScroll: Math.max(0, state.timelineScroll - delta),
    };
  }
  return state;
}

export function cycleFocus(state: TuiState, backwards = false): TuiState {
  const order: readonly FocusArea[] = ["sessions", "tasks", "timeline", "composer"];
  const current = Math.max(0, order.indexOf(state.focus));
  const offset = backwards ? order.length - 1 : 1;
  return { ...state, focus: order[(current + offset) % order.length] ?? "timeline" };
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}
