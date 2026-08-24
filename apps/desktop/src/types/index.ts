/**
 * Terminus Desktop — Type definitions.
 *
 * Per SPEC §30.4 and §32: API responses use snake_case JSON. These types
 * mirror the control-plane (mini-services/terminus-control) wire format
 * exactly. All boundaries use `unknown` + decoding (see lib/api.ts).
 *
 * Per SPEC §7.2: Task statuses are minimal semantic states (working,
 * queued, waiting, needs_approval, needs_review, failed, interrupted,
 * done). The control plane returns domain enums (PENDING, ACTIVE,
 * COMPLETED, …) which we normalize to the UI-facing kind via
 * `normalizeTaskStatus()`.
 */
import type { ApprovalBindingV1, ApprovalDisplay } from "@terminus/public-api";
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

export interface ProviderConfiguration {
  program: string;
  args: string[];
  model: string;
  timeout_seconds: number;
  tools_enabled: boolean;
  revision: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderConfigurationUpdate {
  program: string;
  args: string[];
  model: string;
  timeout_seconds: number;
  tools_enabled: boolean;
  expected_revision: number;
}

export interface ProviderConfigurationResponse {
  configured: boolean;
  configuration: ProviderConfiguration | null;
}

export type GatewayDeployment = "zen" | "go";
export type GatewayProtocol = "chat_completions" | "responses" | "messages";

export const GATEWAY_PRIVACY_TERMS_VERSIONS: Record<GatewayDeployment, string> = {
  zen: "opencode-zen-privacy-v1",
  go: "opencode-go-privacy-v1",
};

export interface GatewayProviderConfiguration {
  deployment: GatewayDeployment;
  protocol: GatewayProtocol;
  model: string;
  tools_enabled: boolean;
  free_model: boolean;
  workspace_access: boolean;
  privacy_terms_admitted: boolean;
  privacy_terms_version: string | null;
  credential_configured: boolean;
  revision: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface GatewayProviderConfigurationUpdate {
  deployment: GatewayDeployment;
  protocol: GatewayProtocol;
  model: string;
  tools_enabled: boolean;
  free_model: boolean;
  workspace_access: boolean;
  privacy_terms_admitted: boolean;
  privacy_terms_version: string | null;
  credential?: string;
  expected_revision: number;
}

export interface GatewayProviderConfigurationResponse {
  configured: boolean;
  configuration: GatewayProviderConfiguration | null;
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

export interface OpenWorkspaceInput {
  root_uri: string;
  kind?: WorkspaceKind;
  trust?: WorkspaceTrust;
  policy_profile_id?: string;
}

// ────────────────────────── /sessions ──────────────────────────────────────

export type SessionStatus = "active" | "paused" | "archived" | "deleted";

export interface CollectionTruncation {
  occurred: boolean;
  continuation: string | null;
}

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
  total: number;
  next_cursor: string | null;
  truncation: CollectionTruncation;
}

export interface CreateSessionInput {
  workspace_id: string;
  title: string;
  default_model_profile?: string;
  default_permission_profile?: string;
}

// ────────────────────────── /tasks ─────────────────────────────────────────

/** Canonical task state machine from SPEC section 28.3. */
export type TaskDomainStatus =
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
  terminal_reason: Record<string, unknown> | null;
  contract: TaskContract | null;
}

export interface TaskListResponse {
  tasks: Task[];
  total: number;
  next_cursor: string | null;
  truncation: CollectionTruncation;
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
export interface TerminusSseEvent {
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
  binding: ApprovalBindingV1 | null;
  display: ApprovalDisplay | null;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  supported_decisions: ApprovalDecision[];
  risk: string;
  scope: string[];
  use_limit: number;
  use_count: number;
  expires_at: string | null;
  requested_at: string;
  resolved_at: string | null;
  rationale: string | null;
}

/**
 * Decoded row from GET /v1/approvals (the control plane parses the stored
 * risk/scope JSON before sending).
 */
export interface ApprovalSummary {
  id: string;
  task_id: string;
  operation_hash: string;
  binding: ApprovalBindingV1 | null;
  display: ApprovalDisplay | null;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  supported_decisions: ApprovalDecision[];
  risk: string;
  scope: string[];
  use_limit: number;
  use_count: number;
  expires_at: string | null;
  requested_at: string;
  resolved_at: string | null;
  rationale: string | null;
}

export interface ApprovalListResponse {
  approvals: ApprovalSummary[];
  total: number;
  next_cursor: string | null;
  truncation: CollectionTruncation;
}

// ────────────────────────── /sandbox ───────────────────────────────────────

/** Kernel sandbox enforcement report (SPEC §13.4). The UI must render degraded controls honestly. */
export interface SandboxReport {
  /** Present when a profile was explicitly requested. */
  profile_id?: string;
  backend_id: string;
  status: "enforced" | "degraded" | "unsupported";
  enforced: string[];
  degraded: string[];
  unsupported: string[];
  notes: string[];
}

// ────────────────────────── /tasks/:id/artifacts ───────────────────────────

export interface ArtifactSummary {
  /** CAS address, e.g. `sha256:<hex>` (or a verbatim non-CAS URI). */
  hash: string;
  purpose: string;
  media_type: string;
  size_bytes: number | null;
}

export interface TaskArtifactsPage {
  task_id: string;
  artifacts: ArtifactSummary[];
  total: number;
  /** Opaque continuation token (next skip offset); null on the last page. */
  next_cursor: string | null;
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

/**
 * A turn's visible thinking. These are the real control-plane phases between
 * `turn.started` and `turn.completed` — the app previously discarded all of
 * them, so the gap between sending and the first token showed nothing at all.
 */
export type ReasoningPhaseKind =
  | "context_compiling"
  | "provider_running"
  | "response_validating"
  | "finalizing";

export interface ReasoningPhase {
  kind: ReasoningPhaseKind;
  /** ISO timestamp the phase was entered. */
  at: string;
}

export interface ReasoningBlock {
  id: string;
  phases: ReasoningPhase[];
  startedAt: string;
  /** Null while the turn is still running. */
  endedAt: string | null;
}

export type ActivityBlockStatus =
  | "working"
  | "done"
  | "failed"
  | "waiting"
  | "interrupted"
  | "unknown";

export interface ActivityEntry {
  /** Tool id or human label like "read", "exec", "patch". */
  tool: string;
  /** Short summary, e.g. "src/index.ts" or "npm run build". */
  summary: string;
  /** Optional detail block (command output, file diff, etc.). */
  detail?: string;
  /** ISO timestamp. */
  at: string;
  /** Authoritative protocol phase; never inferred from display text. */
  phase: "proposed" | "authorized" | "settled";
  /** Structured terminal outcome, present only for settlement. */
  outcome?: "succeeded" | "failed" | "unknown";
  /** Durable operation identity used to correlate phases when supplied. */
  operationId?: string;
}

export interface ActivityBlock {
  id: string;
  /** Heading like "Explored codebase". */
  title: string;
  /** Metric like "12 files", rendered next to the title. */
  metric?: string;
  status: ActivityBlockStatus;
  entries: ActivityEntry[];
}

// ────────────────────────── Terminus Desktop bridge ───────────────────────────
// Exposed by Electron preload (electron/preload.ts). The runtime `window`
// augmentation lives in `src/types/global.d.ts`; the interface here is for
// code that imports the typed shape directly.

export interface TerminusDesktopBridge {
  apiBase: string;
  platform: string;
  isMac: boolean;
  notify: (title: string, body: string) => Promise<unknown>;
  windowMinimize: () => Promise<unknown>;
  windowMaximize: () => Promise<unknown>;
  windowClose: () => Promise<unknown>;
  getTheme: () => Promise<"system" | "light" | "dark">;
  setTheme: (theme: Theme) => Promise<"system" | "light" | "dark">;
}
