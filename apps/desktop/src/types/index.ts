/**
 * Forge Desktop — Type definitions.
 *
 * Per SPEC §30.4 and §32: API responses use snake_case JSON. These types
 * mirror the control-plane (mini-services/forge-control) wire format
 * exactly. All boundaries use `unknown` + decoding (see lib/api.ts).
 *
 * Per SPEC §7.2: Task statuses are minimal semantic states (working,
 * queued, waiting, needs_approval, needs_review, failed, interrupted,
 * done). The control plane returns domain enums (PENDING, ACTIVE,
 * COMPLETED, …) which we normalize to the UI-facing kind via
 * `normalizeTaskStatus()`.
 */
export type Theme = "system" | "light" | "dark";
export type Density = "spacious" | "compact";

// ────────────────────────── /system ────────────────────────────────────────

export interface KernelHealthSummary {
  status: string;
  ready: boolean;
  enforcement_report?: {
    backend_id?: string;
    degraded?: string[];
    enforced?: string[];
    notes?: string[];
  };
  supported_backends?: string[];
  instance_id?: string;
  version?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  version: string;
  build_commit: string;
  instance_id: string;
  uptime_seconds: number;
  ready: boolean;
  kernel?: KernelHealthSummary;
}

// ────────────────────────── /workspaces ────────────────────────────────────

export type WorkspaceKind =
  | "local_git"
  | "local_directory"
  | "container"
  | "microvm"
  | "remote";

export type WorkspaceTrust = "trusted" | "untrusted" | "restricted";

export interface WorkspaceSnapshot {
  id: string;
  kind: WorkspaceKind;
  root_uri: string;
  canonical_root: string;
  trust: WorkspaceTrust;
  policy_profile_id: string;
  created_at: string;
  last_opened_at: string;
}

// ────────────────────────── /sessions ──────────────────────────────────────

export type SessionStatus = "active" | "paused" | "archived" | "deleted";

export interface Session {
  id: string;
  workspace_id: string;
  /** Not always present in list responses. */
  owner_principal?: string;
  title: string;
  status: SessionStatus;
  default_model_profile?: string;
  default_permission_profile?: string;
  active_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionListResponse {
  sessions: Session[];
}

export interface CreateSessionInput {
  workspace_id: string;
  title: string;
  default_model_profile?: string;
  default_permission_profile?: string;
}

// ────────────────────────── /tasks ─────────────────────────────────────────

/**
 * Domain task status as returned by the control plane. Lowercase in DB
 * schema; events use the same strings. We normalize to a UI kind.
 */
export type TaskDomainStatus =
  | "PENDING"
  | "ACTIVE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED"
  | "NEEDS_APPROVAL"
  | "NEEDS_REVIEW"
  | "QUEUED"
  | "WAITING"
  | string;

export type TaskPhase = string;

export interface TaskContract {
  version: number;
  objective: string;
  non_goals: string[];
  allowed_scope: {
    read_paths: string[];
    write_paths: string[];
    external_systems: string[];
  };
}

export interface Task {
  id: string;
  session_id: string;
  thread_id: string;
  status: TaskDomainStatus;
  phase: TaskPhase;
  active_contract_version: number;
  risk_class: "low" | "normal" | "high" | "critical";
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  contract?: TaskContract | null;
}

export interface TaskListResponse {
  tasks: Task[];
}

export interface CreateTaskInput {
  session_id: string;
  thread_id: string;
  objective: string;
  non_goals?: string[];
  acceptance_criteria?: Array<{
    id: string;
    statement: string;
    verification_hint?: string | null;
    required?: boolean;
  }>;
  allowed_scope?: {
    read_paths?: string[];
    write_paths?: string[];
    external_systems?: string[];
  };
  risk_class?: "low" | "normal" | "high" | "critical";
}

export interface StartTaskResponse {
  task_id: string;
  status: string;
  event_cursor: string;
  links: { events: string; task: string };
}

// ────────────────────────── /turns ─────────────────────────────────────────

export interface Turn {
  id: string;
  thread_id: string;
  task_id: string | null;
  sequence: number;
  state: string;
  initiating_actor: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface StartTurnInput {
  thread_id: string;
  task_id: string;
  user_input: string;
}

// ────────────────────────── /events (SSE) ──────────────────────────────────

/**
 * A single decoded SSE event from the control plane. `data` is the raw
 * payload string (already-parsed via JSON.parse at the boundary).
 */
export interface ForgeSseEvent {
  id: string;
  event: string;
  data: string;
}

export interface SubscribeEventsOptions {
  cursor?: string | null;
  task_id?: string | null;
  session_id?: string | null;
  signal?: AbortSignal | null;
}

// ────────────────────────── /approvals ─────────────────────────────────────

export type ApprovalStatus =
  | "pending"
  | "allowed"
  | "denied"
  | "expired"
  | "revoked";

export interface Approval {
  id: string;
  task_id: string;
  operation_hash: string;
  status: ApprovalStatus;
  risk: string;
  requested_at: string;
  resolved_at: string | null;
  rationale: string | null;
}

export type ApprovalDecision =
  | "allow_once"
  | "allow_for_action"
  | "allow_for_task"
  | "deny_once"
  | "deny_and_add_task_rule"
  | "stop_task";

// ────────────────────────── Semantic event payload ─────────────────────────
// The control plane emits typed events like task.created, turn.started,
// tool.proposed, etc. We don't enumerate every payload shape — instead
// the consumer switches on `event` and decodes the unknown payload with
// the relevant type guard. See Conversation/Inspector for usage.

export interface EventEnvelope {
  /** SSE event id (durable cursor). */
  id: string;
  /** SSE event name (e.g. "task.created"). */
  type: string;
  /** Parsed JSON payload. */
  payload: unknown;
}

// ────────────────────────── UI-facing status ───────────────────────────────

/**
 * Per SPEC §7.2 — the eight minimal semantic task states used by the UI.
 * `unknown` covers statuses we don't recognize yet (defensive).
 */
export type TaskStatusKind =
  | "working"
  | "queued"
  | "waiting"
  | "needs_approval"
  | "needs_review"
  | "failed"
  | "interrupted"
  | "done"
  | "unknown";

// ────────────────────────── Composer ───────────────────────────────────────

export type ComposerSendMode = "send" | "steer" | "queue" | "stop";

export type AccessLevel = "read_only" | "local_dev" | "trusted" | "elevated";

export interface DraftAttachments {
  /** Object URLs for pasted/dragged images. */
  images: string[];
  /** Absolute or workspace-relative file paths. */
  files: string[];
}

// ────────────────────────── Conversation feed ──────────────────────────────

export type MessageRole = "user" | "agent";

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  /** Markdown-ish text. */
  content: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Set on streaming agent messages. */
  streaming?: boolean;
}

export type ActivityBlockStatus =
  | "working"
  | "done"
  | "failed"
  | "waiting"
  | "interrupted";

export interface ActivityEntry {
  /** Tool id or human label like "read", "exec", "patch". */
  tool: string;
  /** Short summary, e.g. "src/index.ts" or "npm run build". */
  summary: string;
  /** Optional detail block (command output, file diff, etc.). */
  detail?: string;
  /** ISO timestamp. */
  at: string;
}

export interface ActivityBlock {
  id: string;
  /** Heading like "Explored codebase". */
  title: string;
  /** Right-aligned metric like "12 files". */
  metric?: string;
  status: ActivityBlockStatus;
  entries: ActivityEntry[];
}

// ────────────────────────── Forge Desktop bridge ───────────────────────────
// Exposed by Electron preload (electron/preload.ts).

export interface ForgeDesktopBridge {
  apiBase: string;
  gateway: string;
  token: string;
  platform: string;
  isMac: boolean;
  notify: (title: string, body: string) => Promise<unknown>;
  windowMinimize: () => Promise<unknown>;
  windowMaximize: () => Promise<unknown>;
  windowClose: () => Promise<unknown>;
  getTheme: () => Promise<unknown>;
  setTheme: (theme: Theme) => Promise<unknown>;
}

declare global {
  interface Window {
    forgeDesktop?: ForgeDesktopBridge;
  }
}
