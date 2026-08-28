import type {
  ApprovalSnapshot,
  ContextManifestSnapshot,
  SessionSnapshot,
  SseEvent,
  TaskSnapshot,
  TaskV2Snapshot,
} from "@terminus/public-api";
import { appendProjectedEvent, projectEvent } from "@terminus/public-client";
import type {
  ClientEventPresentation,
  ClientEventProjection,
  ClientEventTone,
} from "@terminus/public-client";

export type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";
export type FocusArea = "sessions" | "tasks" | "timeline" | "composer";
export type Tone = ClientEventTone;
export type TimelinePresentation = ClientEventPresentation;

export interface HealthSnapshot {
  readonly status: "ok" | "degraded" | "down";
  readonly version: string;
  readonly ready: boolean;
}

export type TimelineItem = ClientEventProjection;

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

export function timelineItemFromEvent(event: SseEvent, now = new Date()): TimelineItem {
  return projectEvent(event, now);
}

export function appendEvent(state: TuiState, event: SseEvent, now?: Date): TuiState {
  const next = appendProjectedEvent(
    { items: state.timeline, seenEventIds: state.seenEventIds, cursor: state.lastCursor },
    event,
    now === undefined ? {} : { now },
  );
  if (!next.accepted) return state;
  return {
    ...state,
    timeline: next.items,
    seenEventIds: next.seenEventIds,
    lastCursor: next.cursor,
    selectedTimeline: Math.max(0, next.items.length - 1),
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
