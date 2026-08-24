/**
 * Terminus Desktop — Terminus control-plane API client.
 *
 * Per the task contract: a small fetch-based wrapper that talks to the
 * Terminus control plane at http://127.0.0.1:3050 with the bearer token
 * supplied through the Electron preload bridge or explicit client config.
 * No fallback credential is embedded. The methods are:
 *
 *   health()
 *   listSessions()
 *   createSession(input)
 *   listTasks(sessionId)
 *   createTask(input)
 *   startTask(taskId)
 *   startTurn(input)
 *   getTask(taskId)
 *   subscribeEvents(opts) — returns a TerminusEventStream (EventSource-like)
 *
 * Per SPEC §30.4: every non-2xx response carries a structured error
 * envelope `{ error: { code, message, retryable, category, … } }`. We
 * surface that as `TerminusApiError`.
 *
 * Per SPEC §30.6: SSE reconnects with `Last-Event-ID` / cursor. The
 * browser's native EventSource cannot send `Authorization` headers, so
 * we use fetch + ReadableStream + the SSE decoder from @terminus/public-api
 * and expose an EventSource-like surface (onopen/onmessage/onerror +
 * addEventListener/removeEventListener + close).
 *
 * Per the TypeScript constraints: strict mode, no `any`, all responses
 * typed, `unknown` at boundaries. JSON responses are typed via `as T`
 * after status check — full zod decoding can be layered later without
 * changing call sites.
 */
import {
  ApprovalBindingV1,
  ApprovalDisplay,
  createSseDecoder,
  IDEMPOTENCY_HEADER,
  requireIdempotency,
} from "@terminus/public-api";
import type { MutationRequestOptions } from "@terminus/public-client";
import type {
  Approval,
  ApprovalDecision,
  ApprovalListResponse,
  ApprovalSummary,
  ApprovalStatus,
  ArtifactSummary,
  CreateSessionInput,
  CreateTaskInput,
  OpenWorkspaceInput,
  SandboxReport,
  TaskArtifactsPage,
  TerminusSseEvent,
  HealthResponse,
  GatewayProviderConfiguration,
  GatewayProviderConfigurationResponse,
  GatewayProviderConfigurationUpdate,
  ProviderConfiguration,
  ProviderConfigurationResponse,
  ProviderConfigurationUpdate,
  Session,
  SessionListResponse,
  StartTaskResponse,
  StartTurnInput,
  SubscribeEventsOptions,
  Task,
  TaskContract,
  TaskDomainStatus,
  TaskListResponse,
  Turn,
  WorkspaceSnapshot,
} from "../types";

// ────────────────────────── Configuration ──────────────────────────────────

export type { MutationRequestOptions };

/**
 * Create a collision-resistant identity for one user-visible mutation.
 * Callers retain the returned value until that logical operation either
 * settles or its input changes, so a transport retry cannot duplicate work.
 */
export function createIdempotencyKey(scope: string): string {
  const normalizedScope = scope
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .slice(0, 64) || "mutation";
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi) {
    throw new Error("secure randomness is unavailable; mutation was not sent");
  }
  const id = typeof cryptoApi.randomUUID === "function"
    ? cryptoApi.randomUUID()
    : (() => {
        const bytes = new Uint8Array(16);
        cryptoApi.getRandomValues(bytes);
        bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
        bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
        return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
      })();
  return `${normalizedScope}:${id}`;
}

/**
 * Resolve API base + token. Electron exposes only the base URL; its main
 * process injects the control capability for configured Terminus origins so
 * reusable bearer bytes never enter page JavaScript. Plain Vite development
 * may use an explicitly configured VITE_TERMINUS_TOKEN.
 */
function resolveApiBase(): string {
  if (typeof window !== "undefined" && window.terminusDesktop?.apiBase) {
    return window.terminusDesktop.apiBase;
  }
  const env = (import.meta.env.VITE_TERMINUS_API_BASE as string | undefined) ?? null;
  return env ?? "http://127.0.0.1:3050";
}

function resolveApiToken(): string {
  if (typeof window !== "undefined" && window.terminusDesktop) return "";
  const env = (import.meta.env.VITE_TERMINUS_TOKEN as string | undefined) ?? null;
  // No hardcoded dev-token fallback: production control planes reject the
  // well-known token, and a baked-in constant would ship a bearer credential
  // inside the bundle. Operators set VITE_TERMINUS_TOKEN / TERMINUS_TOKEN.
  return env ?? "";
}

// ────────────────────────── Errors ─────────────────────────────────────────

export interface TerminusErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
  category: string;
  details?: Record<string, unknown>;
  suggested_action?: string | null;
  trace_id?: string | null;
}

export class TerminusApiError extends Error {
  readonly status: number;
  readonly envelope: TerminusErrorEnvelope | null;

  constructor(status: number, message: string, envelope: TerminusErrorEnvelope | null) {
    super(message);
    this.name = "TerminusApiError";
    this.status = status;
    this.envelope = envelope;
  }
}

export function networkUnavailableError(detail: string): TerminusApiError {
  const message = "Terminus is offline. Check the local service, then retry.";
  return new TerminusApiError(0, message, {
    code: "NETWORK_UNAVAILABLE",
    message,
    retryable: true,
    category: "network",
    details: { cause: detail },
    suggested_action: "Retry after the local service is available.",
    trace_id: null,
  });
}

const APPROVAL_STATUSES = ["pending", "allowed", "denied", "expired", "revoked"] as const;
const SANDBOX_STATUSES = ["enforced", "degraded", "unsupported"] as const;
const SESSION_STATUSES = ["active", "paused", "archived", "deleted"] as const;
const TASK_RISK_CLASSES = ["low", "normal", "high", "critical"] as const;
const APPROVAL_DECISIONS = [
  "allow_once",
  "allow_for_action",
  "allow_for_task",
  "deny_once",
  "deny_and_add_task_rule",
  "stop_task",
] as const satisfies readonly ApprovalDecision[];
const TASK_STATUSES = [
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
] as const satisfies readonly TaskDomainStatus[];
const COLLECTION_PAGE_LIMIT = 200;
export const MAX_REST_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface CollectionPageOptions {
  cursor?: string | null;
  signal?: AbortSignal | null;
}

function responseObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TerminusApiError(502, `${what} response was not an object`, null);
  }
  return value as Record<string, unknown>;
}

function responseString(value: unknown, what: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TerminusApiError(502, `${what} was not a ${allowEmpty ? "string" : "non-empty string"}`, null);
  }
  return value;
}

function responseBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    throw new TerminusApiError(502, `${what} was not a boolean`, null);
  }
  return value;
}


function responseNonNegativeNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TerminusApiError(502, `${what} was not a non-negative finite number`, null);
  }
  return value;
}

function responseNullableString(value: unknown, what: string): string | null {
  return value === null ? null : responseString(value, what);
}

const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function responseTimestamp(value: unknown, what: string): string {
  const timestamp = responseString(value, what);
  if (!RFC3339_TIMESTAMP.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new TerminusApiError(502, `${what} was not a valid RFC3339 timestamp`, null);
  }
  return timestamp;
}

function responseNullableTimestamp(value: unknown, what: string): string | null {
  return value === null ? null : responseTimestamp(value, what);
}

function responseOptionalString(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : responseString(value, what);
}

function responseStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TerminusApiError(502, `${what} was not a string array`, null);
  }
  return [...value];
}

function responseOptionalStringArray(value: unknown, what: string): string[] | undefined {
  return value === undefined ? undefined : responseStringArray(value, what);
}

/** Read a REST body without allowing an unbounded response into memory. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes = MAX_REST_RESPONSE_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel("REST response byte limit exceeded");
        } catch {
          // The producer may already have closed while the limit was detected.
        }
        throw new TerminusApiError(
          502,
          `REST response exceeded the ${maxBytes}-byte limit; no response content was admitted`,
          null,
        );
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

function responseNonNegativeInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TerminusApiError(502, `${what} was not a non-negative safe integer`, null);
  }
  return value;
}

function decodeSession(value: unknown): Session {
  const session = responseObject(value, "session");
  return {
    id: responseString(session.id, "session.id"),
    workspace_id: responseString(session.workspace_id, "session.workspace_id"),
    owner_principal: responseOptionalString(session.owner_principal, "session.owner_principal"),
    title: responseString(session.title, "session.title", true),
    status: responseEnum(session.status, SESSION_STATUSES, "session.status"),
    default_model_profile: responseOptionalString(session.default_model_profile, "session.default_model_profile"),
    default_permission_profile: responseOptionalString(session.default_permission_profile, "session.default_permission_profile"),
    active_thread_id: responseNullableString(session.active_thread_id, "session.active_thread_id"),
    created_at: responseTimestamp(session.created_at, "session.created_at"),
    updated_at: responseTimestamp(session.updated_at, "session.updated_at"),
  };
}

const WORKSPACE_KINDS = ["local_git", "local_directory", "container", "microvm", "remote"] as const;
const WORKSPACE_TRUST_LEVELS = ["trusted", "untrusted", "restricted"] as const;

function decodeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  const workspace = responseObject(value, "workspace");
  return {
    id: responseString(workspace.id, "workspace.id"),
    kind: responseEnum(workspace.kind, WORKSPACE_KINDS, "workspace.kind"),
    root_uri: responseString(workspace.root_uri, "workspace.root_uri"),
    canonical_root: responseString(workspace.canonical_root, "workspace.canonical_root"),
    trust: responseEnum(workspace.trust, WORKSPACE_TRUST_LEVELS, "workspace.trust"),
    policy_profile_id: responseString(workspace.policy_profile_id, "workspace.policy_profile_id"),
    created_at: responseTimestamp(workspace.created_at, "workspace.created_at"),
    last_opened_at: responseTimestamp(workspace.last_opened_at, "workspace.last_opened_at"),
  };
}

function decodeHealthResponse(value: unknown): HealthResponse {
  const health = responseObject(value, "health");
  const kernelValue = health.kernel;
  let kernel: HealthResponse["kernel"];
  if (kernelValue !== undefined && kernelValue !== null) {
    const rawKernel = responseObject(kernelValue, "health.kernel");
    const rawReport = rawKernel.enforcement_report;
    // The current control plane reports the provider-neutral kernel state as
    // `state`; previous versions exposed `status` plus an explicit `ready`.
    // Decode both during the rolling compatibility window.
    const kernelStatus = responseString(rawKernel.status ?? rawKernel.state, "health.kernel.status");
    kernel = {
      status: kernelStatus,
      ready: rawKernel.ready === undefined
        ? kernelStatus === "ok" || kernelStatus === "ready"
        : responseBoolean(rawKernel.ready, "health.kernel.ready"),
      enforcement_report: rawReport === undefined
        ? undefined
        : (() => {
            const report = responseObject(rawReport, "health.kernel.enforcement_report");
            return {
              backend_id: responseOptionalString(report.backend_id, "health.kernel.enforcement_report.backend_id"),
              degraded: responseOptionalStringArray(report.degraded, "health.kernel.enforcement_report.degraded"),
              enforced: responseOptionalStringArray(report.enforced, "health.kernel.enforcement_report.enforced"),
              notes: responseOptionalStringArray(report.notes, "health.kernel.enforcement_report.notes"),
            };
          })(),
      supported_backends: responseOptionalStringArray(rawKernel.supported_backends, "health.kernel.supported_backends"),
      instance_id: responseOptionalString(rawKernel.instance_id, "health.kernel.instance_id"),
      version: responseOptionalString(rawKernel.version, "health.kernel.version"),
    };
  }
  return {
    status: responseEnum(health.status, ["ok", "degraded", "down"] as const, "health.status"),
    version: responseString(health.version, "health.version"),
    build_commit: responseString(health.build_commit, "health.build_commit"),
    instance_id: responseString(health.instance_id, "health.instance_id"),
    uptime_seconds: responseNonNegativeNumber(health.uptime_seconds, "health.uptime_seconds"),
    ready: responseBoolean(health.ready, "health.ready"),
    kernel,
  };
}

const GATEWAY_DEPLOYMENTS = ["zen", "go"] as const;
const GATEWAY_PROTOCOLS = ["chat_completions", "responses", "messages"] as const;

function decodeGatewayProviderConfigurationResponse(
  value: unknown,
): GatewayProviderConfigurationResponse {
  const root = responseObject(value, "gateway provider configuration");
  const configured = responseBoolean(root.configured, "gateway provider configuration.configured");
  if (root.configuration === null) {
    if (configured) {
      throw new TerminusApiError(502, "gateway provider configuration marked configured without a row", null);
    }
    return { configured: false, configuration: null };
  }
  if (!configured) {
    throw new TerminusApiError(502, "gateway provider configuration marked unconfigured with a row", null);
  }
  const row = responseObject(root.configuration, "gateway provider configuration.configuration");
  const configuration: GatewayProviderConfiguration = {
    deployment: responseEnum(row.deployment, GATEWAY_DEPLOYMENTS, "gateway provider configuration.deployment"),
    protocol: responseEnum(row.protocol, GATEWAY_PROTOCOLS, "gateway provider configuration.protocol"),
    model: responseString(row.model, "gateway provider configuration.model"),
    tools_enabled: responseBoolean(row.tools_enabled, "gateway provider configuration.tools_enabled"),
    free_model: responseBoolean(row.free_model, "gateway provider configuration.free_model"),
    workspace_access: responseBoolean(row.workspace_access, "gateway provider configuration.workspace_access"),
    credential_configured: responseBoolean(row.credential_configured, "gateway provider configuration.credential_configured"),
    revision: responseNonNegativeInteger(row.revision, "gateway provider configuration.revision"),
    updated_by: responseString(row.updated_by, "gateway provider configuration.updated_by"),
    created_at: responseTimestamp(row.created_at, "gateway provider configuration.created_at"),
    updated_at: responseTimestamp(row.updated_at, "gateway provider configuration.updated_at"),
  };
  return { configured: true, configuration };
}

function decodeTask(value: unknown): Task {
  const task = responseObject(value, "task");
  const contract = decodeTaskContract(task.contract);
  return {
    id: responseString(task.id, "task.id"),
    session_id: responseString(task.session_id, "task.session_id"),
    thread_id: responseString(task.thread_id, "task.thread_id"),
    status: responseEnum(task.status, TASK_STATUSES, "task.status"),
    phase: responseString(task.phase, "task.phase"),
    active_contract_version: responseNonNegativeInteger(task.active_contract_version, "task.active_contract_version"),
    risk_class: responseEnum(task.risk_class, TASK_RISK_CLASSES, "task.risk_class"),
    created_at: responseTimestamp(task.created_at, "task.created_at"),
    updated_at: responseTimestamp(task.updated_at, "task.updated_at"),
    completed_at: responseNullableTimestamp(task.completed_at, "task.completed_at"),
    terminal_reason: task.terminal_reason === undefined || task.terminal_reason === null
      ? null
      : responseObject(task.terminal_reason, "task.terminal_reason"),
    contract,
  };
}

function decodeStartTaskResponse(value: unknown): StartTaskResponse {
  const response = responseObject(value, "start task");
  const links = responseObject(response.links, "start task.links");
  return {
    task_id: responseString(response.task_id, "start task.task_id"),
    status: responseString(response.status, "start task.status"),
    event_cursor: responseString(response.event_cursor, "start task.event_cursor"),
    links: {
      events: responseString(links.events, "start task.links.events"),
      task: responseString(links.task, "start task.links.task"),
    },
  };
}

function decodeTurn(value: unknown): Turn {
  const turn = responseObject(value, "turn");
  return {
    id: responseString(turn.id, "turn.id"),
    thread_id: responseString(turn.thread_id, "turn.thread_id"),
    task_id: responseNullableString(turn.task_id, "turn.task_id"),
    sequence: responseNonNegativeInteger(turn.sequence, "turn.sequence"),
    state: responseString(turn.state, "turn.state"),
    initiating_actor: responseString(turn.initiating_actor, "turn.initiating_actor"),
    started_at: responseNullableTimestamp(turn.started_at, "turn.started_at"),
    completed_at: responseNullableTimestamp(turn.completed_at, "turn.completed_at"),
  };
}

function decodeTaskContract(value: unknown): TaskContract | null {
  if (value === null) return null;
  const contract = responseObject(value, "task.contract");
  const scope = responseObject(contract.allowed_scope, "task.contract.allowed_scope");
  return {
    version: responseNonNegativeInteger(contract.version, "task.contract.version"),
    objective: responseString(contract.objective, "task.contract.objective"),
    non_goals: responseStringArray(contract.non_goals, "task.contract.non_goals"),
    allowed_scope: {
      read_paths: responseStringArray(scope.read_paths, "task.contract.allowed_scope.read_paths"),
      write_paths: responseStringArray(scope.write_paths, "task.contract.allowed_scope.write_paths"),
      external_systems: responseStringArray(scope.external_systems, "task.contract.allowed_scope.external_systems"),
    },
  };
}

interface DecodedCollectionPage<T> {
  readonly items: T[];
  readonly total: number;
  readonly nextCursor: string | null;
}

function assertScopedResponse<T>(
  value: T,
  actualScope: string,
  expectedScope: string,
  resource: string,
): T {
  if (actualScope !== expectedScope) {
    throw new TerminusApiError(
      502,
      `${resource} response crossed the requested scope: expected ${expectedScope}, received ${actualScope}`,
      null,
    );
  }
  return value;
}

function assertScopedCollection<T>(
  values: readonly T[],
  expectedScope: string,
  scopeOf: (value: T) => string,
  resource: string,
): T[] {
  return values.map((value) => assertScopedResponse(value, scopeOf(value), expectedScope, resource));
}

function decodeCollectionPage<T>(
  value: unknown,
  field: string,
  decodeItem: (item: unknown) => T,
): DecodedCollectionPage<T> {
  const page = responseObject(value, `${field} page`);
  const items = page[field];
  if (!Array.isArray(items)) {
    throw new TerminusApiError(502, `${field} page.${field} was not an array`, null);
  }
  const nextCursor = responseNullableString(page.next_cursor, `${field} page.next_cursor`);
  if (nextCursor !== null && !/^[a-zA-Z0-9._:-]{1,255}$/.test(nextCursor)) {
    throw new TerminusApiError(502, `${field} page.next_cursor was not a valid opaque cursor`, null);
  }
  return {
    items: items.map(decodeItem),
    total: responseNonNegativeInteger(page.total, `${field} page.total`),
    nextCursor,
  };
}

function responseEnum<const T extends readonly string[]>(value: unknown, values: T, what: string): T[number] {
  if (typeof value !== "string" || !values.some((candidate) => candidate === value)) {
    throw new TerminusApiError(502, `${what} contained unsupported value '${String(value)}'`, null);
  }
  return value as T[number];
}

function decodeApprovalSummary(value: unknown): ApprovalSummary {
  const approval = responseObject(value, "approval");
  const binding = ApprovalBindingV1.nullable().safeParse(approval.binding);
  const display = ApprovalDisplay.nullable().safeParse(approval.display);
  if (!binding.success) throw new TerminusApiError(502, "approval.binding was invalid", null);
  if (!display.success) throw new TerminusApiError(502, "approval.display was invalid", null);
  return {
    id: responseString(approval.id, "approval.id"),
    task_id: responseString(approval.task_id, "approval.task_id"),
    operation_hash: responseString(approval.operation_hash, "approval.operation_hash"),
    binding: binding.data,
    display: display.data,
    status: responseEnum(approval.status, APPROVAL_STATUSES, "approval.status") satisfies ApprovalStatus,
    decision: approval.decision === null
      ? null
      : responseEnum(approval.decision, APPROVAL_DECISIONS, "approval.decision"),
    supported_decisions: responseStringArray(approval.supported_decisions, "approval.supported_decisions").map(
      (decision, index) => responseEnum(decision, APPROVAL_DECISIONS, `approval.supported_decisions[${index}]`),
    ),
    risk: responseString(approval.risk, "approval.risk"),
    scope: responseStringArray(approval.scope, "approval.scope"),
    use_limit: responseNonNegativeInteger(approval.use_limit, "approval.use_limit"),
    use_count: responseNonNegativeInteger(approval.use_count, "approval.use_count"),
    expires_at: responseNullableTimestamp(approval.expires_at, "approval.expires_at"),
    requested_at: responseTimestamp(approval.requested_at, "approval.requested_at"),
    resolved_at: responseNullableTimestamp(approval.resolved_at, "approval.resolved_at"),
    rationale: responseNullableString(approval.rationale, "approval.rationale"),
  };
}

function decodeSandboxReport(value: unknown): SandboxReport {
  const report = responseObject(value, "sandbox report");
  return {
    profile_id: report.profile_id === undefined ? undefined : responseString(report.profile_id, "sandbox report.profile_id"),
    backend_id: responseString(report.backend_id, "sandbox report.backend_id"),
    status: responseEnum(report.status, SANDBOX_STATUSES, "sandbox report.status"),
    enforced: responseStringArray(report.enforced, "sandbox report.enforced"),
    degraded: responseStringArray(report.degraded, "sandbox report.degraded"),
    unsupported: responseStringArray(report.unsupported, "sandbox report.unsupported"),
    notes: responseStringArray(report.notes, "sandbox report.notes"),
  };
}

function decodeArtifactSummary(value: unknown): ArtifactSummary {
  const artifact = responseObject(value, "artifact summary");
  return {
    hash: responseString(artifact.hash, "artifact.hash"),
    purpose: responseString(artifact.purpose, "artifact.purpose"),
    media_type: responseString(artifact.media_type, "artifact.media_type"),
    size_bytes: artifact.size_bytes === null
      ? null
      : responseNonNegativeInteger(artifact.size_bytes, "artifact.size_bytes"),
  };
}

function decodeTaskArtifactsPage(value: unknown): TaskArtifactsPage {
  const page = responseObject(value, "task artifact page");
  if (!Array.isArray(page.artifacts)) {
    throw new TerminusApiError(502, "task artifact page.artifacts was not an array", null);
  }
  const total = responseNonNegativeInteger(page.total, "task artifact page.total");
  const nextCursorValue = responseNullableString(page.next_cursor, "task artifact page.next_cursor");
  if (nextCursorValue !== null && !/^(0|[1-9]\d*)$/.test(nextCursorValue)) {
    throw new TerminusApiError(502, "task artifact page.next_cursor was not a numeric offset", null);
  }
  const nextCursor = nextCursorValue === null ? null : Number(nextCursorValue);
  if (nextCursor !== null && !Number.isSafeInteger(nextCursor)) {
    throw new TerminusApiError(502, "task artifact page.next_cursor exceeded the safe offset range", null);
  }
  const artifacts = page.artifacts.map(decodeArtifactSummary);
  if (artifacts.length > total) {
    throw new TerminusApiError(502, "task artifact page contained more rows than its total", null);
  }
  return {
    task_id: responseString(page.task_id, "task artifact page.task_id"),
    artifacts,
    total,
    next_cursor: nextCursorValue,
  };
}

// ────────────────────────── Client ─────────────────────────────────────────

export class TerminusApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string = resolveApiBase(), token: string = resolveApiToken()) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  /** Construct a full URL with optional query parameters. */
  url(path: string, query?: Record<string, string | null | undefined>): string {
    const q = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null) q.set(k, v);
      }
    }
    const qs = q.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  /**
   * Build a request-headers object. Public so the SSE stream (which
   * lives outside the class) can reuse the same auth headers as the
   * REST client. Mirrors the private {@link headers} method.
   */
  buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return this.headers(extra);
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    opts: {
      body?: unknown;
      query?: Record<string, string | null | undefined>;
      idempotencyKey?: string;
      signal?: AbortSignal | null;
    } = {},
  ): Promise<T> {
    const headers = this.headers();
    if (requireIdempotency(method)) {
      const key = opts.idempotencyKey;
      if (typeof key !== "string" || key.trim().length === 0) {
        throw new TypeError(`${IDEMPOTENCY_HEADER} must be a non-empty string for ${method}`);
      }
      headers[IDEMPOTENCY_HEADER] = key;
    }
    const init: RequestInit = {
      method,
      headers,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;

    let res: Response;
    try {
      res = await fetch(this.url(path, opts.query), init);
    } catch (err) {
      // Network error (control plane offline, CORS, etc.).
      const msg = err instanceof Error ? err.message : String(err);
      throw networkUnavailableError(msg);
    }

    if (res.status === 204) return undefined as T;

    if (!res.ok) {
      let envelope: TerminusErrorEnvelope | null = null;
      try {
        const text = await readBoundedResponseText(res);
        if (text.length === 0) throw new Error("empty error body");
        const body = JSON.parse(text) as unknown;
        if (body && typeof body === "object" && "error" in body) {
          const err = (body as { error: unknown }).error;
          if (err && typeof err === "object") {
            const e = err as Record<string, unknown>;
            envelope = {
              code: String(e.code ?? "UNKNOWN"),
              message: String(e.message ?? `HTTP ${res.status}`),
              retryable: Boolean(e.retryable ?? false),
              category: String(e.category ?? "internal"),
              details:
                e.details && typeof e.details === "object"
                  ? (e.details as Record<string, unknown>)
                  : undefined,
              suggested_action:
                typeof e.suggested_action === "string" ? e.suggested_action : null,
              trace_id: typeof e.trace_id === "string" ? e.trace_id : null,
            };
          }
        }
      } catch (err) {
        if (err instanceof TerminusApiError) throw err;
        // ignore JSON parse failure
      }
      const msg = envelope?.message ?? `HTTP ${res.status}`;
      throw new TerminusApiError(res.status, msg, envelope);
    }

    // Empty body — let caller decide.
    const text = await readBoundedResponseText(res);
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Non-JSON response.
      return text as unknown as T;
    }
  }

  private async listCollectionPage<T>(
    path: string,
    field: string,
    decodeItem: (item: unknown) => T,
    query: Record<string, string | null | undefined>,
    options: CollectionPageOptions,
  ): Promise<DecodedCollectionPage<T>> {
    const cursor = options.cursor ?? null;
    const value: unknown = await this.request<unknown>("GET", path, {
      query: { ...query, cursor, limit: String(COLLECTION_PAGE_LIMIT) },
      signal: options.signal,
    });
    const page = decodeCollectionPage(value, field, decodeItem);
    if (page.nextCursor !== null && (page.items.length === 0 || page.nextCursor === cursor)) {
      throw new TerminusApiError(502, `${field} pagination did not advance from cursor ${page.nextCursor}`, null);
    }
    return page;
  }

  // ────────────────────────── /system ───────────────────────────────────

  async health(signal?: AbortSignal | null): Promise<HealthResponse> {
    return decodeHealthResponse(await this.request<unknown>("GET", "/v1/system/health", { signal }));
  }

  /**
   * Models a provider currently offers.
   *
   * Terminus does not carry a model list. The control plane asks the
   * configured adapter and returns a provider-neutral inventory, so the
   * composer never has to know which harness is behind it.
   *
   * The route is optional by design: a control plane that does not implement
   * it answers 404, which the caller renders as "no provider has reported
   * models" rather than an error the operator cannot act on.
   */
  async listProviderModels(
    signal?: AbortSignal | null,
  ): Promise<{ providers: unknown; models: unknown; error: unknown }> {
    try {
      const raw = responseObject(
        await this.request<unknown>("GET", "/v1/provider-models", { signal }),
        "provider models",
      );
      return { providers: raw.providers, models: raw.models, error: raw.error };
    } catch (error) {
      if (error instanceof TerminusApiError && error.status === 404) {
        return {
          providers: [],
          models: [],
          error: "This control plane does not report a model inventory.",
        };
      }
      throw error;
    }
  }

  async getProviderConfiguration(signal?: AbortSignal | null): Promise<ProviderConfigurationResponse> {
    const raw = responseObject(await this.request<unknown>("GET", "/v1/provider-config", { signal }), "provider configuration");
    const configured = responseBoolean(raw.configured, "provider configuration.configured");
    const configuration = raw.configuration;
    if (configuration === null) {
      if (configured) throw new TerminusApiError(502, "provider configuration marked configured without a row", null);
      return { configured: false, configuration: null };
    }
    const row = responseObject(configuration, "provider configuration.configuration");
    const decoded: ProviderConfiguration = {
      program: responseString(row.program, "provider configuration.program"),
      args: responseStringArray(row.args, "provider configuration.args"),
      model: responseString(row.model, "provider configuration.model"),
      timeout_seconds: responseNonNegativeInteger(row.timeout_seconds, "provider configuration.timeout_seconds"),
      tools_enabled: responseBoolean(row.tools_enabled, "provider configuration.tools_enabled"),
      revision: responseNonNegativeInteger(row.revision, "provider configuration.revision"),
      updated_by: responseString(row.updated_by, "provider configuration.updated_by"),
      created_at: responseString(row.created_at, "provider configuration.created_at"),
      updated_at: responseString(row.updated_at, "provider configuration.updated_at"),
    };
    if (!configured) throw new TerminusApiError(502, "provider configuration marked unconfigured with a row", null);
    return { configured, configuration: decoded };
  }

  async putProviderConfiguration(
    input: ProviderConfigurationUpdate,
    options: MutationRequestOptions,
  ): Promise<ProviderConfigurationResponse> {
    const raw = responseObject(await this.request<unknown>("PUT", "/v1/provider-config", { body: input, ...options }), "provider configuration");
    const configured = responseBoolean(raw.configured, "provider configuration.configured");
    const configuration = raw.configuration;
    if (!configured || configuration === null) throw new TerminusApiError(502, "provider configuration update returned no configuration", null);
    const row = responseObject(configuration, "provider configuration.configuration");
    return {
      configured: true,
      configuration: {
        program: responseString(row.program, "provider configuration.program"),
        args: responseStringArray(row.args, "provider configuration.args"),
        model: responseString(row.model, "provider configuration.model"),
        timeout_seconds: responseNonNegativeInteger(row.timeout_seconds, "provider configuration.timeout_seconds"),
        tools_enabled: responseBoolean(row.tools_enabled, "provider configuration.tools_enabled"),
        revision: responseNonNegativeInteger(row.revision, "provider configuration.revision"),
        updated_by: responseString(row.updated_by, "provider configuration.updated_by"),
        created_at: responseString(row.created_at, "provider configuration.created_at"),
        updated_at: responseString(row.updated_at, "provider configuration.updated_at"),
      },
    };
  }

  async getGatewayProviderConfiguration(
    signal?: AbortSignal | null,
  ): Promise<GatewayProviderConfigurationResponse> {
    return decodeGatewayProviderConfigurationResponse(
      await this.request<unknown>("GET", "/v1/gateway-provider-config", { signal }),
    );
  }

  async putGatewayProviderConfiguration(
    input: GatewayProviderConfigurationUpdate,
    options: MutationRequestOptions,
  ): Promise<GatewayProviderConfigurationResponse> {
    return decodeGatewayProviderConfigurationResponse(
      await this.request<unknown>("PUT", "/v1/gateway-provider-config", { body: input, ...options }),
    );
  }

  async deleteGatewayProviderConfiguration(
    expectedRevision: number,
    options: MutationRequestOptions,
  ): Promise<GatewayProviderConfigurationResponse> {
    return decodeGatewayProviderConfigurationResponse(
      await this.request<unknown>("DELETE", "/v1/gateway-provider-config", {
        body: { expected_revision: expectedRevision },
        ...options,
      }),
    );
  }

  // ────────────────────────── /workspaces ───────────────────────────────

  async openWorkspace(input: OpenWorkspaceInput, options: MutationRequestOptions): Promise<WorkspaceSnapshot> {
    const workspace = decodeWorkspaceSnapshot(await this.request<unknown>("POST", "/v1/workspaces/open", { body: input, ...options }));
    assertScopedResponse(workspace, workspace.root_uri, input.root_uri, "workspace open");
    if (input.kind !== undefined) assertScopedResponse(workspace, workspace.kind, input.kind, "workspace open");
    if (input.trust !== undefined) assertScopedResponse(workspace, workspace.trust, input.trust, "workspace open");
    if (input.policy_profile_id !== undefined) {
      assertScopedResponse(workspace, workspace.policy_profile_id, input.policy_profile_id, "workspace open");
    }
    return workspace;
  }

  // ────────────────────────── /sessions ─────────────────────────────────

  async listSessions(options: CollectionPageOptions = {}): Promise<SessionListResponse> {
    const page = await this.listCollectionPage("/v1/sessions", "sessions", decodeSession, {}, options);
    const sessions = page.items;
    sessions.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
    return {
      sessions,
      total: page.total,
      next_cursor: page.nextCursor,
      truncation: { occurred: page.nextCursor !== null, continuation: page.nextCursor },
    };
  }

  async createSession(input: CreateSessionInput, options: MutationRequestOptions): Promise<Session> {
    const session = decodeSession(await this.request<unknown>("POST", "/v1/sessions", { body: input, ...options }));
    return assertScopedResponse(session, session.workspace_id, input.workspace_id, "session creation");
  }

  async getSession(sessionId: string, signal?: AbortSignal | null): Promise<Session> {
    const session = decodeSession(await this.request<unknown>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      { signal },
    ));
    return assertScopedResponse(session, session.id, sessionId, "session detail");
  }

  // ────────────────────────── /tasks ────────────────────────────────────

  async listTasks(sessionId: string, options: CollectionPageOptions = {}): Promise<TaskListResponse> {
    const page = await this.listCollectionPage(
      `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`,
      "tasks",
      decodeTask,
      {},
      options,
    );
    const tasks = assertScopedCollection(page.items, sessionId, (task) => task.session_id, "task list");
    tasks.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
    return {
      tasks,
      total: page.total,
      next_cursor: page.nextCursor,
      truncation: { occurred: page.nextCursor !== null, continuation: page.nextCursor },
    };
  }

  async createTask(input: CreateTaskInput, options: MutationRequestOptions): Promise<Task> {
    const task = decodeTask(await this.request<unknown>("POST", "/v1/tasks", { body: input, ...options }));
    assertScopedResponse(task, task.session_id, input.session_id, "task creation");
    return assertScopedResponse(task, task.thread_id, input.thread_id, "task creation");
  }

  async startTask(taskId: string, options: MutationRequestOptions): Promise<StartTaskResponse> {
    const response = decodeStartTaskResponse(await this.request<unknown>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/start`, options));
    return assertScopedResponse(response, response.task_id, taskId, "task start");
  }

  async getTask(taskId: string, signal?: AbortSignal | null): Promise<Task> {
    const task = decodeTask(await this.request<unknown>("GET", `/v1/tasks/${encodeURIComponent(taskId)}`, { signal }));
    return assertScopedResponse(task, task.id, taskId, "task detail");
  }

  async cancelTask(taskId: string, options: MutationRequestOptions, reason?: string | null): Promise<Task> {
    const task = decodeTask(await this.request<unknown>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      body: { reason: reason ?? null },
      ...options,
    }));
    return assertScopedResponse(task, task.id, taskId, "task cancellation");
  }

  // ────────────────────────── /turns ────────────────────────────────────

  async startTurn(input: StartTurnInput, options: MutationRequestOptions): Promise<Turn> {
    const turn = decodeTurn(await this.request<unknown>("POST", "/v1/turns", { body: input, ...options }));
    assertScopedResponse(turn, turn.thread_id, input.thread_id, "turn creation");
    return assertScopedResponse(turn, turn.task_id ?? "", input.task_id, "turn creation");
  }

  async interruptTurn(turnId: string, options: MutationRequestOptions, reason?: string | null): Promise<Turn> {
    const turn = decodeTurn(await this.request<unknown>("POST", `/v1/turns/${encodeURIComponent(turnId)}/interrupt`, {
      body: { reason: reason ?? null },
      ...options,
    }));
    return assertScopedResponse(turn, turn.id, turnId, "turn interruption");
  }

  // ────────────────────────── /approvals ────────────────────────────────

  resolveApproval(
    approvalId: string,
    operationHash: string,
    decision: ApprovalDecision,
    options: MutationRequestOptions,
    rationale?: string | null,
  ): Promise<Approval> {
    return (async () => {
      const approval = decodeApprovalSummary(await this.request<unknown>("POST", `/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      body: { operation_hash: operationHash, decision, rationale: rationale ?? null },
      ...options,
      }));
      assertScopedResponse(approval, approval.id, approvalId, "approval resolution");
      assertScopedResponse(approval, approval.operation_hash, operationHash, "approval resolution");
      if (approval.binding !== null) {
        assertScopedResponse(approval, approval.binding.task_id, approval.task_id, "approval resolution binding");
      }
      const expectedStatus = decision.startsWith("allow") ? "allowed" : "denied";
      assertScopedResponse(approval, approval.status, expectedStatus, "approval resolution status");
      if (approval.decision !== null) {
        assertScopedResponse(approval, approval.decision, decision, "approval resolution decision");
      }
      return approval;
    })();
  }

  /** Pending approvals (server-side source of truth; survives missed SSE events). */
  async listApprovals(
    taskId?: string | null,
    options: CollectionPageOptions = {},
  ): Promise<ApprovalListResponse> {
    const page = await this.listCollectionPage(
      "/v1/approvals",
      "approvals",
      decodeApprovalSummary,
      { task_id: taskId ?? null },
      options,
    );
    const approvals = taskId === null || taskId === undefined
      ? page.items
      : assertScopedCollection(page.items, taskId, (approval) => approval.task_id, "approval list");
    for (const approval of approvals) {
      if (approval.status !== "pending") {
        throw new TerminusApiError(
          502,
          `approval list contained a non-pending row (${approval.id}:${approval.status}); no approval state was admitted`,
          null,
        );
      }
    }
    approvals.sort((left, right) => right.requested_at.localeCompare(left.requested_at) || left.id.localeCompare(right.id));
    return {
      approvals,
      total: page.total,
      next_cursor: page.nextCursor,
      truncation: { occurred: page.nextCursor !== null, continuation: page.nextCursor },
    };
  }

  // ────────────────────────── /sandbox ──────────────────────────────────

  /**
   * Live kernel sandbox enforcement report. `profileId` is optional — the
   * kernel reports on its default profile when omitted.
   */
  async getSandboxReport(profileId?: string | null, signal?: AbortSignal | null): Promise<SandboxReport> {
    const value = await this.request<unknown>("GET", "/v1/sandbox/report", {
      query: { profile_id: profileId ?? null },
      signal,
    });
    const report = decodeSandboxReport(value);
    if (profileId !== null && profileId !== undefined) {
      if (report.profile_id === undefined) {
        throw new TerminusApiError(502, "sandbox report omitted the requested profile scope", null);
      }
      return assertScopedResponse(report, report.profile_id, profileId, "sandbox report");
    }
    return report;
  }

  // ────────────────────────── /tasks/:id/artifacts ──────────────────────

  async listTaskArtifacts(
    taskId: string,
    cursor?: string | null,
    signal?: AbortSignal | null,
  ): Promise<TaskArtifactsPage> {
    // The server's continuation token is the next offset (`skip`).
    if (cursor !== null && cursor !== undefined && !/^(0|[1-9]\d*)$/.test(cursor)) {
      throw new TerminusApiError(400, "task artifact cursor was not a numeric offset", null);
    }
    const skip = cursor ?? null;
    const skipOffset = skip === null ? 0 : Number(skip);
    if (!Number.isSafeInteger(skipOffset)) {
      throw new TerminusApiError(400, "task artifact cursor exceeded the safe offset range", null);
    }
    const value = await this.request<unknown>("GET", `/v1/tasks/${encodeURIComponent(taskId)}/artifacts`, {
      query: { skip },
      signal,
    });
    const page = decodeTaskArtifactsPage(value);
    const scopedPage = assertScopedResponse(page, page.task_id, taskId, "task artifact page");
    const consumed = skipOffset + scopedPage.artifacts.length;
    if (consumed > scopedPage.total) {
      throw new TerminusApiError(502, "task artifact page exceeded its declared total", null);
    }
    if (scopedPage.next_cursor !== null) {
      const nextOffset = Number(scopedPage.next_cursor);
      if (nextOffset !== consumed || nextOffset <= skipOffset) {
        throw new TerminusApiError(502, "task artifact page returned a non-advancing continuation", null);
      }
    } else if (consumed < scopedPage.total) {
      throw new TerminusApiError(502, "task artifact page omitted a continuation before its declared total", null);
    }
    return scopedPage;
  }

  /**
   * Fetch artifact content with a hard byte cap. Per the bounded-output
   * contract the response states explicitly when truncation occurred —
   * callers must surface `truncated` and reference the full artifact hash
   * rather than presenting a silent prefix.
   */
  async getArtifactText(
    hash: string,
    taskId: string,
    maxBytes = 256 * 1024,
    signal?: AbortSignal | null,
  ): Promise<{ text: string; truncated: boolean; totalBytes: number | null }> {
    const bare = hash.replace(/^sha256:/, "");
    let res: Response;
    try {
      const query = new URLSearchParams({ task_id: taskId });
      res = await fetch(this.url(`/v1/artifacts/${encodeURIComponent(bare)}?${query.toString()}`), {
        method: "GET",
        headers: { accept: "*/*", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw networkUnavailableError(msg);
    }
    if (!res.ok) throw new TerminusApiError(res.status, `artifact fetch failed: HTTP ${res.status}`, null);

    const contentLength = Number(res.headers.get("content-length"));
    const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;

    let bytes = new Uint8Array(0);
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (bytes.length + value.length > maxBytes) {
            const remaining = maxBytes - bytes.length;
            if (remaining > 0) {
              const merged = new Uint8Array(maxBytes);
              merged.set(bytes, 0);
              merged.set(value.subarray(0, remaining), bytes.length);
              bytes = merged;
            }
            truncated = true;
            break;
          }
          const merged = new Uint8Array(bytes.length + value.length);
          merged.set(bytes, 0);
          merged.set(value, bytes.length);
          bytes = merged;
        }
      } finally {
        try {
          // Cancel while this reader still owns the stream. Releasing first
          // makes cancellation invalid and can leave a large response flowing
          // after the bounded preview has enough bytes.
          if (truncated) await reader.cancel("artifact preview byte cap reached");
        } catch {
          // The producer may already have closed between read and cancel.
        } finally {
          reader.releaseLock();
        }
      }
    }
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), truncated, totalBytes };
  }
}

// ────────────────────────── SSE stream ─────────────────────────────────────
//
// The browser's native EventSource cannot set custom headers (so no
// `Authorization: Bearer …`). The control plane requires bearer auth on
// `/v1/events`, so we use fetch + a streaming reader + the SSE decoder
// from @terminus/public-api, and surface an EventSource-like object.

export type TerminusEventStreamHandler = (event: TerminusSseEvent) => void;

export interface TerminusEventStream {
  readonly readyState: 0 | 1 | 2 | 3;
  /** Register a listener. Returns an unsubscribe function. */
  addEventListener(type: "message" | "open" | "error", handler: TerminusEventStreamHandler | (() => void)): () => void;
  /** Close the stream. Safe to call multiple times. */
  close(): void;
  /** Last received event id (durable cursor). */
  lastEventId: string | null;
}

class FetchEventStream implements TerminusEventStream {
  readyState: 0 | 1 | 2 | 3 = 0;
  lastEventId: string | null = null;
  private readonly listeners = new Map<string, Set<TerminusEventStreamHandler | (() => void)>>();
  private readonly abort: AbortController;
  private readonly cursor: string | null;
  private readonly taskId: string | null;
  private readonly sessionId: string | null;
  private readonly client: TerminusApiClient;
  private closed = false;
  private errorEmitted = false;

  constructor(client: TerminusApiClient, opts: SubscribeEventsOptions) {
    this.client = client;
    this.cursor = opts.cursor ?? null;
    this.taskId = opts.task_id ?? null;
    this.sessionId = opts.session_id ?? null;
    this.abort = new AbortController();
    if (opts.signal) {
      // An owner abort is an intentional close, not a transport failure.
      opts.signal.addEventListener("abort", () => this.close(), { once: true });
    }
    void this.run();
  }

  addEventListener(
    type: "message" | "open" | "error",
    handler: TerminusEventStreamHandler | (() => void),
  ): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 2;
    this.abort.abort();
  }

  private emit(type: "message", ev: TerminusSseEvent): void;
  private emit(type: "open" | "error"): void;
  private emit(type: "message" | "open" | "error", ev?: TerminusSseEvent): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const h of set) {
      try {
        if (type === "message") (h as TerminusEventStreamHandler)(ev as TerminusSseEvent);
        else (h as () => void)();
      } catch {
        // Listener errors must not break the stream.
      }
    }
  }

  private fail(): void {
    if (this.closed || this.errorEmitted) return;
    this.errorEmitted = true;
    this.readyState = 3;
    this.emit("error");
  }

  private async run(): Promise<void> {
    const url = this.client.url("/v1/events", {
      cursor: this.cursor,
      task_id: this.taskId,
      session_id: this.sessionId,
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: this.client.buildHeaders({ accept: "text/event-stream" }),
        signal: this.abort.signal,
      });
    } catch (err) {
      if (this.closed) return;
      this.fail();
      return;
    }

    if (!res.ok || !res.body) {
      this.fail();
      return;
    }

    this.readyState = 1;
    this.emit("open");

    const reader = res.body.getReader();
    const decoder = createSseDecoder();
    const textDecoder = new TextDecoder();
    const dispatchEvents = (events: ReturnType<typeof decoder.feed>): void => {
      for (const ev of events) {
        // Heartbeat comments produce empty events — skip them.
        if (!ev.event && (!ev.data || ev.data.startsWith(":heartbeat"))) continue;
        if (ev.id) this.lastEventId = ev.id;
        // Normalize event name: SSE may use the default "message" event.
        const named: TerminusSseEvent = {
          id: ev.id,
          event: ev.event || "message",
          data: ev.data,
        };
        this.emit("message", named);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = textDecoder.decode(value, { stream: true });
        dispatchEvents(decoder.feed(text));
      }
      dispatchEvents(decoder.feed(textDecoder.decode()));
      decoder.finish();
      // A server-side EOF without an owner close is a lost connection. The
      // consumer must reconnect from `lastEventId` rather than stay green.
      this.fail();
    } catch {
      // Network interruption / abort. If aborted by user, readyState is
      // already 2 (closed). Otherwise it's an unexpected drop.
      this.fail();
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      if (!this.closed && !this.errorEmitted) this.fail();
    }
  }
}

// ────────────────────────── Public singleton ───────────────────────────────

export const api = new TerminusApiClient();

/**
 * Subscribe to the SSE event stream. Returns an EventSource-like
 * `TerminusEventStream` whose `addEventListener("message", …)` callback
 * receives decoded `{ id, event, data }` payloads. Reconnect is the
 * caller's responsibility — pass `cursor: stream.lastEventId` on retry.
 *
 * Per the task contract: "subscribeEvents(taskId?) (returns EventSource)".
 * We return a small wrapper that matches the EventSource surface used
 * by Terminus Desktop, because the native EventSource cannot send the
 * `Authorization: Bearer` header the control plane requires.
 */
export function subscribeEvents(opts: SubscribeEventsOptions = {}): TerminusEventStream {
  return new FetchEventStream(api, opts);
}

/** Variant accepting the legacy single-argument form: `subscribeEvents(taskId?)`. */
export function subscribeTaskEvents(taskId: string | null): TerminusEventStream {
  return subscribeEvents({ task_id: taskId });
}
