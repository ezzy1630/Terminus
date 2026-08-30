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

// ────────────────────────── /provider-accounts ─────────────────────────────

/**
 * A credential Terminus can route a turn with.
 *
 * These are *discovered*, not entered here: the control plane reads the
 * credential stores the operator's own CLIs already keep (the OpenCode auth
 * store, the Codex/ChatGPT login) and records one account per usable
 * credential. The desktop never sees credential material — only the metadata
 * below — and offers exactly two actions per row: make it the default, or
 * disconnect it.
 *
 * Nothing in this client invents an account. An empty list means the control
 * plane found no credential, which is a state the UI states plainly rather
 * than papering over with a plausible-looking provider.
 */
export type ProviderAccountAuthKind = "api" | "oauth" | "wellknown" | "chatgpt" | "anonymous";

/**
 * `unsupported` is not an error: the credential is real and stored, but this
 * build has no transport for the provider's SDK. It stays listed, with the
 * reason, so a missing model reads as an explained gap rather than a bug.
 */
export type ProviderAccountStatus =
  | "connected"
  | "expired"
  | "error"
  | "unsupported"
  | "disconnected";

/** How a turn on this account is paid for. `paid` prices per model, not here. */
export type ProviderAccountBilling = "subscription" | "free" | "paid" | "unknown";

/** Non-secret facts the credential carried. Never tokens. */
export interface ProviderAccountMetadata {
  account_id?: string;
  plan_type?: string;
  email?: string;
}

export interface ProviderAccount {
  id: string;
  /** `opencode:<providerID>` | `codex-chatgpt` | `zen`. Stable, and the row key. */
  source: string;
  display_name: string;
  /** models.dev provider id the catalogue is read from. */
  vendor_id: string;
  auth_kind: ProviderAccountAuthKind;
  status: ProviderAccountStatus;
  /** Why it is in that status, in the control plane's own words. */
  status_detail: string;
  billing: ProviderAccountBilling;
  host: string;
  protocol: GatewayProtocol;
  is_default: boolean;
  model_count: number;
  metadata: ProviderAccountMetadata;
  discovered_at: string;
  last_verified_at: string | null;
  /** When the credential stops working. Null when it does not expire. */
  expires_at: string | null;
  /** Guards Set default and Disconnect against a concurrent change. */
  revision: number;
  /** Non-secret credential identity used for explicit reconnect confirmation. */
  credential_fingerprint?: string;
}

/** What the last credential-store sweep found, and what is installed to sweep. */
export interface ProviderAccountDiscovery {
  last_run_at: string | null;
  /**
   * Credential-store CLIs found on PATH, by short name: `"codex"`, and the
   * OpenCode CLI under its own lowercase name.
   *
   * A list rather than one boolean per tool on purpose: the per-tool field
   * names would have carried a vendor name with a separator attached, which
   * the repository's standalone check rejects in built assets, and a list
   * extends to a third store without another wire field.
   */
  installed_tools: string[];
  /** Store-level problems (bad permissions, unparseable file), verbatim. */
  warnings: string[];
}

export interface ProviderAccountsResponse {
  accounts: ProviderAccount[];
  discovery: ProviderAccountDiscovery;
  /**
   * Client-side, not on the wire: false when this control plane answers 404
   * for the route. The section then says so instead of claiming the operator
   * has no credentials at all.
   */
  supported: boolean;
}

export interface ProviderAccountDiscoveryResponse extends ProviderAccountsResponse {
  /** Account ids created or re-imported by this sweep. */
  imported: string[];
}

// ───────────────────── External Codex subscription lane ────────────────────

/**
 * Codex subscription state is intentionally separate from native providers.
 * `external_harness` is a wire-level honesty marker: Codex owns this loop,
 * and these models must never be offered by Terminus' native picker.
 */
export type CodexLaneState =
  | "not_started"
  | "starting"
  | "ready"
  | "running"
  | "exited"
  | "expired"
  | "unknown_settlement"
  | "stopped";

export interface CodexLaneStatus {
  available: boolean;
  state: CodexLaneState;
  external_harness: "codex";
  protocol: string;
  executable: "codex";
  job_id: string | null;
  reason: string | null;
  persisted_thread_id: string | null;
  persisted_state: string | null;
  persisted_updated_at: string | null;
}

export interface CodexLaneAccount {
  type: string | null;
  email: string | null;
  plan_type: string | null;
  requires_openai_auth: boolean;
}

export interface CodexLaneModel {
  id: string;
  model: string | null;
  display_name: string | null;
  reasoning_efforts: string[];
  default_reasoning_effort: string | null;
  hidden: boolean;
}

export interface CodexLaneAccountResponse {
  external_harness: "codex";
  account: CodexLaneAccount;
}

export interface CodexLaneModelsResponse {
  external_harness: "codex";
  models: CodexLaneModel[];
}

export interface CodexLaneIdentity {
  session_id: string;
  workspace_id: string;
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

/** Reasoning depth, as the control plane spells it. */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

/**
 * How much a session's tasks may do without stopping to ask.
 *
 * Three levels, named by the control plane, not by this client. `Session`'s
 * own field stays a plain `string` on purpose — a deployment may still be
 * holding a legacy value such as `secure-local-default`, and a response that
 * fails to decode is worse than one this client has to interpret. Writes are
 * narrowed to the three ids because there is no reason to send anything else.
 */
export type PermissionProfileId = "full-access" | "auto" | "ask";

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
  /**
   * The workspace this session opens, as a `file://` URI. The client had no
   * path for a project at all, which is why the sidebar could show two rows
   * called "Terminus" with nothing to tell them apart.
   *
   * Optional so the client works against a control plane that predates it.
   */
  workspace_root_uri?: string;
  /** Bare model id the session routes turns to by default. */
  default_model?: string | null;
  default_reasoning_effort?: ReasoningEffort | null;
  /**
   * Which connected account {@link default_model} belongs to.
   *
   * A bare model id stopped being enough the moment two accounts could offer
   * the same one — the same `grok-code` reachable through two different keys
   * bills to two different places. The account is the routing decision; the
   * model is a choice within it.
   */
  default_provider_account_id?: string | null;
}

/** Fields `PATCH /v1/sessions/:id` accepts. */
export interface SessionUpdateInput {
  default_model?: string | null;
  default_reasoning_effort?: ReasoningEffort | null;
  default_permission_profile?: PermissionProfileId;
  /** Null clears the pin and lets the control plane's default account decide. */
  default_provider_account_id?: string | null;
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

/**
 * The workspace paths a task's contract authorizes. The control plane checks
 * every kernel capability request against these, and the initial contract
 * sets `mayExpandScope: false` — so a task created without a scope can never
 * touch its workspace at all.
 */
export interface TaskAllowedScope {
  read_paths: string[];
  write_paths: string[];
  external_systems: string[];
}

export interface TaskContract {
  version: number;
  objective: string;
  non_goals: string[];
  allowed_scope: TaskAllowedScope;
}

/**
 * The turn a client would interrupt to stop work without ending the task.
 *
 * The detail route reports all four fields. The list route reports a narrower
 * `{ id, state }`, so `sequence` and `started_at` are optional: requiring them
 * would make one narrow row reject the whole task list and empty the sidebar.
 */
export interface TaskActiveTurn {
  id: string;
  sequence?: number;
  state: string;
  started_at?: string | null;
}

/**
 * What this task has spent and how much room is left.
 *
 * Token and cost counters arrive as decimal strings because they exceed the
 * safe integer range in the general case; they are parsed at the presentation
 * boundary, not here.
 */
export interface TaskBudgetLedger {
  steps_used: number;
  max_steps: number;
  tokens_used: string;
  input_tokens: string;
  output_tokens: string;
  reasoning_tokens: string;
  cached_input_tokens: string;
  max_tokens: string | null;
  cost_micros: string;
  max_cost_micros: string | null;
  /** Tokens still available in the model's context window, when known. */
  context_headroom_tokens: string | null;
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
  /**
   * `null` means the response reported no running turn; `undefined` means the
   * response does not carry the field at all. The list route omits both of
   * these, so the distinction is what keeps a list refresh from blanking what
   * the detail route already established.
   */
  active_turn?: TaskActiveTurn | null;
  budget_ledger?: TaskBudgetLedger | null;
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
  /**
   * The model this turn routes to — a bare discovered model id, not a provider
   * profile. Omitted when the composer has nothing selected, in which case the
   * control plane falls back to the session default.
   *
   * Before this existed the picker wrote the *global* gateway configuration
   * row on every choice, so changing the model for one turn changed it for
   * every session and every concurrent run.
   */
  model?: string;
  reasoning_effort?: ReasoningEffort;
  /**
   * The connected account this turn bills to and authenticates as.
   *
   * Sent alongside `model` because the model id alone does not name a route:
   * the control plane resolves turn account → session default account → the
   * default account, and never silently falls through to a different one.
   */
  provider_account_id?: string;
}

/**
 * What `POST /v1/turns/:id/steer` returns.
 *
 * Steering does not create a turn — it appends a model-visible episode the
 * running turn picks up at its next stop boundary — so the receipt names the
 * episode, not a new turn.
 */
export interface SteerReceipt {
  episode_id: string;
  sequence: number;
  turn_id: string;
  turn_state: string;
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

/**
 * One page of a task's durable transcript.
 *
 * `events` carry the same `{id, event, data}` shape as the live SSE stream, so
 * the same decoder serves replay and tail. The default page is the *tail* of
 * the conversation, because that is where a reader starts; `earlier_cursor`
 * walks backwards from there.
 */
export interface TaskTranscriptPage {
  task_id: string;
  events: TerminusSseEvent[];
  total: number;
  /** Attach the live stream here so replay and tail meet exactly once. */
  next_cursor: string | null;
  /** Request the preceding page with this; null once the start is reached. */
  earlier_cursor: string | null;
  truncation: { occurred: boolean; continuation: string | null };
}

/**
 * The task's working tree against HEAD, produced by the kernel running git in
 * the workspace (GET /v1/tasks/:id/diff). This is what the agent actually
 * changed — as opposed to patch text scraped out of tool events, which is only
 * what it *said* it changed, and only for the events still in the window.
 */
export interface TaskWorkspaceDiff {
  task_id: string;
  workspace_id: string;
  /** False when the workspace is not a git repository; `diff` is then empty. */
  git_available: boolean;
  diff: string;
  diff_truncated: boolean;
  untracked_files: string[];
  exit_code: number;
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
 * The UI-facing task vocabulary now lives in `lib/task-lifecycle.ts` as
 * `TaskLifecycle`, shared by the sidebar, the board, the palette and the title
 * bar. It used to be duplicated here as `TaskStatusKind` under a citation of
 * "SPEC §7.2", which is in fact "Core primitives" and defines no task states;
 * the normative domain state machine is SPEC §28.3 and that is what
 * `lifecycleFromDomainStatus()` reads.
 */

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
  /**
   * The model the control plane reported for this turn (`turn.profile_selected`
   * → `model_key`). Absent means the runtime did not say — never a guess from
   * whatever the composer's picker happens to be showing now.
   */
  model?: string;
}

/**
 * A turn's visible thinking. These are the real control-plane phases between
 * `turn.started` and `turn.completed` — the app previously discarded all of
 * them, so the gap between sending and the first token showed nothing at all.
 */
export type ReasoningPhaseKind =
  | "context_compiling"
  | "provider_running"
  | "tool_settlement"
  | "response_validating"
  | "verifying"
  | "repairing"
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
  /**
   * The model's own reasoning, when the provider returned any and the turn
   * settled with it. Never synthesised — absent means the provider reported
   * none, not that the UI dropped it.
   */
  text?: string;
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
  /**
   * Structured terminal outcome, present only for settlement. `denied` is
   * separate from `failed` because a policy refusal is a decision someone can
   * act on, not a fault — and a group of them must not read as "Explored
   * codebase".
   */
  outcome?: "succeeded" | "failed" | "denied" | "unknown";
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
  /**
   * The prompt that produced this block, present only on a failed turn whose
   * input the client actually holds. A failed turn now leaves the task ACTIVE
   * and steerable, so "try that again" is one turn, not a new task — but only
   * when there is something exact to resend. A paraphrase would be worse than
   * no button.
   */
  retryInput?: string;
}

// ────────────────────────── Terminus Desktop bridge ───────────────────────────
// The preload bridge is declared once, on `Window`, in `src/types/global.d.ts`.
// A second hand-maintained copy lived here and had already drifted: it still
// declared `platform`, `windowMinimize` and `windowMaximize` (all removed from
// the preload) and typed `apiBase` as a plain string when the shell can fail
// to resolve one. Two declarations of one contract is one too many.
