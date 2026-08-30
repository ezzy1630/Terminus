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
  ProviderAccount,
  ProviderAccountDiscovery,
  ProviderAccountDiscoveryResponse,
  ProviderAccountMetadata,
  ProviderAccountsResponse,
  OpenCodeStoreStatus,
  CodexLaneAccountResponse,
  CodexLaneEventsResponse,
  CodexLaneEvent,
  CodexLaneIdentity,
  CodexLaneModel,
  CodexLaneModelsResponse,
  CodexLaneStatus,
  ProviderConfiguration,
  ProviderConfigurationResponse,
  ProviderConfigurationUpdate,
  ReasoningEffort,
  Session,
  SessionListResponse,
  SessionUpdateInput,
  StartTaskResponse,
  StartTurnInput,
  SubscribeEventsOptions,
  Task,
  TaskActiveTurn,
  TaskBudgetLedger,
  TaskContract,
  TaskDomainStatus,
  TaskListResponse,
  TaskTranscriptPage,
  TaskWorkspaceDiff,
  SteerReceipt,
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
/**
 * Where the control plane is, and why we might not know.
 *
 * Inside Electron the shell resolves an approved control origin and hands it
 * over; when it cannot, `apiBase` is null and `apiBaseError` says why. The old
 * code fell through to `http://127.0.0.1:3050` in that case, so a shell that
 * had explicitly refused to name an origin was silently second-guessed by the
 * renderer — and the user saw connection failures against an address nobody
 * chose instead of the reason the shell gave.
 *
 * The localhost fallback survives only for the plain-browser dev build, where
 * there is no shell to ask.
 */
export interface ApiBaseResolution {
  baseUrl: string;
  error: string | null;
}

export function resolveApiBase(): ApiBaseResolution {
  const bridge = typeof window !== "undefined" ? window.terminusDesktop : undefined;
  if (bridge) {
    if (bridge.apiBase) return { baseUrl: bridge.apiBase, error: null };
    return {
      baseUrl: "",
      error: bridge.apiBaseError
        ?? "The desktop shell could not resolve an approved control-plane address.",
    };
  }
  const env = (import.meta.env.VITE_TERMINUS_API_BASE as string | undefined) ?? null;
  return { baseUrl: env ?? "http://127.0.0.1:3050", error: null };
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

/** A signed integer: process exit codes are legitimately negative. */
function responseInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TerminusApiError(502, `${what} was not a safe integer`, null);
  }
  return value;
}

function responseNonNegativeInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TerminusApiError(502, `${what} was not a non-negative safe integer`, null);
  }
  return value;
}

const REASONING_EFFORTS = ["low", "medium", "high", "max"] as const;

/**
 * Fields the control plane may or may not serve yet.
 *
 * `undefined` means "this response did not carry it"; `null` means "carried,
 * and empty". Decoding them strictly would make a client that knows about them
 * reject every response from a control plane that does not.
 */
function decodeOptionalEffort(value: unknown, what: string): ReasoningEffort | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return responseEnum(value, REASONING_EFFORTS, what);
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
    ...(session.workspace_root_uri === undefined
      ? {}
      : { workspace_root_uri: responseString(session.workspace_root_uri, "session.workspace_root_uri") }),
    ...(session.default_model === undefined
      ? {}
      : { default_model: responseNullableString(session.default_model, "session.default_model") }),
    ...(session.default_reasoning_effort === undefined
      ? {}
      : { default_reasoning_effort: decodeOptionalEffort(session.default_reasoning_effort, "session.default_reasoning_effort") ?? null }),
    ...(session.default_provider_account_id === undefined
      ? {}
      : { default_provider_account_id: responseNullableString(session.default_provider_account_id, "session.default_provider_account_id") }),
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
    privacy_terms_admitted: responseBoolean(row.privacy_terms_admitted, "gateway provider configuration.privacy_terms_admitted"),
    privacy_terms_version: responseNullableString(row.privacy_terms_version, "gateway provider configuration.privacy_terms_version"),
    credential_configured: responseBoolean(row.credential_configured, "gateway provider configuration.credential_configured"),
    revision: responseNonNegativeInteger(row.revision, "gateway provider configuration.revision"),
    updated_by: responseString(row.updated_by, "gateway provider configuration.updated_by"),
    created_at: responseTimestamp(row.created_at, "gateway provider configuration.created_at"),
    updated_at: responseTimestamp(row.updated_at, "gateway provider configuration.updated_at"),
  };
  return { configured: true, configuration };
}

const PROVIDER_ACCOUNT_AUTH_KINDS = ["api", "oauth", "wellknown", "chatgpt", "anonymous"] as const;
const PROVIDER_ACCOUNT_STATUSES = ["connected", "expired", "error", "unsupported", "disconnected"] as const;
const PROVIDER_ACCOUNT_BILLINGS = ["subscription", "free", "paid", "unknown"] as const;
const OPENCODE_STORE_STATUSES = ["available", "missing", "rejected", "unavailable"] as const;
const CREDENTIAL_FINGERPRINT = /^[0-9a-f]{64}$/;
const CATALOG_DIGEST = /^sha256:[0-9a-f]{64}$/;

function responseCredentialFingerprint(value: unknown, what: string): string {
  const fingerprint = responseString(value, what, true);
  if (fingerprint !== "" && !CREDENTIAL_FINGERPRINT.test(fingerprint)) {
    throw new TerminusApiError(502, `${what} was not a 64-character lowercase hexadecimal fingerprint`, null);
  }
  return fingerprint;
}

function responseConnectionDestination(value: unknown, what: string): string {
  const destination = responseString(value, what, true);
  if (destination === "") return destination;
  let parsed: URL;
  try {
    parsed = new URL(destination);
  } catch {
    throw new TerminusApiError(502, `${what} was not a valid canonical HTTPS URL`, null);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.href !== destination
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new TerminusApiError(502, `${what} was not a valid canonical HTTPS URL`, null);
  }
  return destination;
}

function responseCatalogDigest(value: unknown, what: string): string {
  const digest = responseString(value, what, true);
  if (digest !== "" && !CATALOG_DIGEST.test(digest)) {
    throw new TerminusApiError(502, `${what} was not a sha256 catalog digest`, null);
  }
  return digest;
}

/**
 * Non-secret metadata only.
 *
 * Decoded field by field rather than passed through, so a control plane that
 * one day widened this object could not carry anything unexpected into the
 * renderer — and so a stray token-shaped field would be dropped here rather
 * than rendered in Settings.
 */
function decodeProviderAccountMetadata(value: unknown): ProviderAccountMetadata {
  if (value === undefined || value === null) return {};
  const metadata = responseObject(value, "provider account.metadata");
  return {
    ...(metadata.account_id === undefined ? {} : { account_id: responseString(metadata.account_id, "provider account.metadata.account_id", true) }),
    ...(metadata.plan_type === undefined ? {} : { plan_type: responseString(metadata.plan_type, "provider account.metadata.plan_type", true) }),
    ...(metadata.email === undefined ? {} : { email: responseString(metadata.email, "provider account.metadata.email", true) }),
  };
}

function decodeProviderAccount(value: unknown): ProviderAccount {
  const account = responseObject(value, "provider account");
  return {
    id: responseString(account.id, "provider account.id"),
    source: responseString(account.source, "provider account.source"),
    display_name: responseString(account.display_name, "provider account.display_name"),
    vendor_id: responseString(account.vendor_id, "provider account.vendor_id", true),
    auth_kind: responseEnum(account.auth_kind, PROVIDER_ACCOUNT_AUTH_KINDS, "provider account.auth_kind"),
    status: responseEnum(account.status, PROVIDER_ACCOUNT_STATUSES, "provider account.status"),
    status_detail: responseString(account.status_detail ?? "", "provider account.status_detail", true),
    billing: responseEnum(account.billing, PROVIDER_ACCOUNT_BILLINGS, "provider account.billing"),
    host: responseString(account.host, "provider account.host", true),
    protocol: responseEnum(account.protocol, GATEWAY_PROTOCOLS, "provider account.protocol"),
    is_default: responseBoolean(account.is_default, "provider account.is_default"),
    model_count: responseNonNegativeInteger(account.model_count, "provider account.model_count"),
    metadata: decodeProviderAccountMetadata(account.metadata),
    discovered_at: responseTimestamp(account.discovered_at, "provider account.discovered_at"),
    // Absent and null both mean "never", and a client that rejected the
    // absent form would refuse every response from a control plane that
    // simply omits empty fields.
    last_verified_at: responseNullableTimestamp(account.last_verified_at ?? null, "provider account.last_verified_at"),
    expires_at: responseNullableTimestamp(account.expires_at ?? null, "provider account.expires_at"),
    revision: responseNonNegativeInteger(account.revision, "provider account.revision"),
    credential_fingerprint: responseCredentialFingerprint(account.credential_fingerprint ?? "", "provider account.credential_fingerprint"),
    connection_destination: responseConnectionDestination(account.connection_destination ?? "", "provider account.connection_destination"),
    catalog_digest: responseCatalogDigest(account.catalog_digest ?? "", "provider account.catalog_digest"),
  };
}

function decodeProviderAccountDiscovery(value: unknown): ProviderAccountDiscovery {
  const discovery = responseObject(value ?? {}, "provider account discovery");
  return {
    last_run_at: responseNullableTimestamp(discovery.last_run_at ?? null, "provider account discovery.last_run_at"),
    installed_tools: responseStringArray(discovery.installed_tools ?? [], "provider account discovery.installed_tools"),
    opencode_store_status: discovery.opencode_store_status === undefined || discovery.opencode_store_status === null
      ? null
      : responseEnum(discovery.opencode_store_status, OPENCODE_STORE_STATUSES, "provider account discovery.opencode_store_status") as OpenCodeStoreStatus,
    warnings: responseStringArray(discovery.warnings ?? [], "provider account discovery.warnings"),
  };
}

function decodeProviderAccountsResponse(value: unknown, what: string): ProviderAccountsResponse {
  const root = responseObject(value, what);
  const accounts = root.accounts;
  if (!Array.isArray(accounts)) {
    throw new TerminusApiError(502, `${what}.accounts was not an array`, null);
  }
  return {
    accounts: accounts.map(decodeProviderAccount),
    discovery: decodeProviderAccountDiscovery(root.discovery),
    supported: true,
  };
}

/**
 * Counters wide enough to exceed the safe integer range arrive as decimal
 * strings. Anything else — including a number, which a future control plane
 * could start sending — is rejected rather than coerced, so a silent precision
 * loss can never reach a budget readout.
 */
function responseDecimalString(value: unknown, what: string): string {
  const decimal = responseString(value, what);
  if (!/^\d+$/.test(decimal)) {
    throw new TerminusApiError(502, `${what} was not a non-negative decimal string`, null);
  }
  return decimal;
}

function responseNullableDecimalString(value: unknown, what: string): string | null {
  return value === undefined || value === null ? null : responseDecimalString(value, what);
}

/**
 * Both of these are additive fields on the task detail route. A control plane
 * that predates them omits them entirely, which must read as "not running" and
 * "no ledger" rather than as a decode failure that blanks the whole task.
 */
function decodeTaskActiveTurn(value: unknown): TaskActiveTurn | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const turn = responseObject(value, "task.active_turn");
  // The list route reports `{ id, state }` only. Demanding the detail route's
  // full shape here would reject the entire page over a field the narrower
  // response was never going to send.
  return {
    id: responseString(turn.id, "task.active_turn.id"),
    ...(turn.sequence === undefined || turn.sequence === null
      ? {}
      : { sequence: responseNonNegativeInteger(turn.sequence, "task.active_turn.sequence") }),
    state: responseString(turn.state, "task.active_turn.state"),
    ...(turn.started_at === undefined
      ? {}
      : { started_at: responseNullableTimestamp(turn.started_at, "task.active_turn.started_at") }),
  };
}

function decodeTaskBudgetLedger(value: unknown): TaskBudgetLedger | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const ledger = responseObject(value, "task.budget_ledger");
  return {
    steps_used: responseNonNegativeInteger(ledger.steps_used, "task.budget_ledger.steps_used"),
    max_steps: responseNonNegativeInteger(ledger.max_steps, "task.budget_ledger.max_steps"),
    tokens_used: responseDecimalString(ledger.tokens_used, "task.budget_ledger.tokens_used"),
    input_tokens: responseDecimalString(ledger.input_tokens, "task.budget_ledger.input_tokens"),
    output_tokens: responseDecimalString(ledger.output_tokens, "task.budget_ledger.output_tokens"),
    reasoning_tokens: responseDecimalString(ledger.reasoning_tokens, "task.budget_ledger.reasoning_tokens"),
    cached_input_tokens: responseDecimalString(ledger.cached_input_tokens, "task.budget_ledger.cached_input_tokens"),
    max_tokens: responseNullableDecimalString(ledger.max_tokens, "task.budget_ledger.max_tokens"),
    cost_micros: responseDecimalString(ledger.cost_micros, "task.budget_ledger.cost_micros"),
    max_cost_micros: responseNullableDecimalString(ledger.max_cost_micros, "task.budget_ledger.max_cost_micros"),
    context_headroom_tokens: responseNullableDecimalString(
      ledger.context_headroom_tokens,
      "task.budget_ledger.context_headroom_tokens",
    ),
  };
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
    active_turn: decodeTaskActiveTurn(task.active_turn),
    budget_ledger: decodeTaskBudgetLedger(task.budget_ledger),
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

function decodeSteerReceipt(value: unknown): SteerReceipt {
  const receipt = responseObject(value, "steer receipt");
  return {
    episode_id: responseString(receipt.episode_id, "steer receipt.episode_id"),
    sequence: responseNonNegativeInteger(receipt.sequence, "steer receipt.sequence"),
    turn_id: responseString(receipt.turn_id, "steer receipt.turn_id"),
    turn_state: responseString(receipt.turn_state, "steer receipt.turn_state"),
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

  /** Why there is no base URL, when there is none. Surfaced, never guessed. */
  readonly baseUrlError: string | null;

  constructor(baseUrl?: string, token: string = resolveApiToken()) {
    const resolved = baseUrl === undefined ? resolveApiBase() : { baseUrl, error: null };
    this.baseUrl = resolved.baseUrl.replace(/\/+$/, "");
    this.baseUrlError = resolved.error;
    this.token = token;
  }

  /**
   * Fail before touching the network when no address was ever resolved.
   *
   * Every path out of this client goes through here, including the SSE stream,
   * so the shell's reason reaches the connection banner instead of a fetch
   * error against an empty URL.
   */
  assertBaseUrl(): void {
    if (this.baseUrlError === null) return;
    throw new TerminusApiError(0, this.baseUrlError, {
      code: "API_BASE_UNAVAILABLE",
      message: this.baseUrlError,
      retryable: false,
      category: "configuration",
    });
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
    this.assertBaseUrl();
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

  // ─────────────────── /provider-accounts ───────────────────────────────

  /**
   * The credentials Terminus can currently route with.
   *
   * These are discovered from the operator's own credential stores, so the
   * list is a *report*, never a configuration this client authored. As with
   * the model inventory, a control plane that does not implement the route
   * answers 404 and the caller renders "this build does not report connected
   * accounts" instead of an empty list that reads like "you have none".
   */
  async listProviderAccounts(signal?: AbortSignal | null): Promise<ProviderAccountsResponse> {
    try {
      return decodeProviderAccountsResponse(
        await this.request<unknown>("GET", "/v1/provider-accounts", { signal }),
        "provider accounts",
      );
    } catch (error) {
      if (error instanceof TerminusApiError && error.status === 404) {
        return {
          accounts: [],
          discovery: { last_run_at: null, installed_tools: [], opencode_store_status: null, warnings: [] },
          supported: false,
        };
      }
      throw error;
    }
  }

  /**
   * Sweep the credential stores again.
   *
   * The control plane already does this at startup; this is the "I just signed
   * in to Codex in another window" button. `imported` names the accounts the
   * sweep created or re-imported, which is what the first-launch notice
   * counts.
   */
  async discoverProviderAccounts(options: MutationRequestOptions): Promise<ProviderAccountDiscoveryResponse> {
    const raw = await this.request<unknown>("POST", "/v1/provider-accounts/discover", { ...options });
    const decoded = decodeProviderAccountsResponse(raw, "provider account discovery");
    const root = responseObject(raw, "provider account discovery");
    return {
      ...decoded,
      imported: responseStringArray(root.imported ?? [], "provider account discovery.imported"),
    };
  }

  /**
   * Forget an account and delete the credential it copied into the keyring.
   *
   * `expectedRevision` is not ceremony: discovery runs on its own schedule and
   * can re-import an account between the render and the click, and deleting a
   * credential the operator did not mean to delete is not recoverable from
   * this app.
   */
  async disconnectProviderAccount(
    accountId: string,
    expectedRevision: number,
    options: MutationRequestOptions,
  ): Promise<void> {
    await this.request<unknown>("DELETE", `/v1/provider-accounts/${encodeURIComponent(accountId)}`, {
      body: { expected_revision: expectedRevision },
      ...options,
    });
  }

  /** Make this the account every turn uses when nothing more specific applies. */
  async setDefaultProviderAccount(
    accountId: string,
    expectedRevision: number,
    options: MutationRequestOptions,
  ): Promise<void> {
    await this.request<unknown>("PUT", `/v1/provider-accounts/${encodeURIComponent(accountId)}/default`, {
      body: { expected_revision: expectedRevision },
      ...options,
    });
  }

  /** Explicitly copy a discovered OpenCode API key into the kernel keyring. */
  async connectProviderAccount(
    accountId: string,
    expectedRevision: number,
    expectedFingerprint: string,
    expectedDestination: string,
    expectedCatalogDigest: string,
    options: MutationRequestOptions,
  ): Promise<ProviderAccountsResponse> {
    return decodeProviderAccountsResponse(await this.request<unknown>("POST", `/v1/provider-accounts/${encodeURIComponent(accountId)}/connect`, {
      body: {
        expected_revision: expectedRevision,
        expected_fingerprint: expectedFingerprint,
        expected_destination: expectedDestination,
        expected_catalog_digest: expectedCatalogDigest,
        consent: true,
      },
      ...options,
    }), "provider account connection");
  }

  // ───────────────────── External Codex subscription lane ────────────────

  /** Codex owns this loop; its status is never folded into native providers. */
  async getCodexLaneStatus(identity: CodexLaneIdentity, signal?: AbortSignal | null): Promise<CodexLaneStatus> {
    const raw = responseObject(await this.request<unknown>("GET", "/v1/external/codex/status", {
      query: { session_id: identity.session_id, workspace_id: identity.workspace_id },
      signal,
    }), "Codex lane status");
    return {
      available: responseBoolean(raw.available, "Codex lane status.available"),
      state: responseString(raw.state, "Codex lane status.state") as CodexLaneStatus["state"],
      external_harness: responseString(raw.external_harness, "Codex lane status.external_harness") as "codex",
      protocol: responseString(raw.protocol, "Codex lane status.protocol"),
      executable: responseString(raw.executable, "Codex lane status.executable") as "codex",
      job_id: responseNullableString(raw.job_id, "Codex lane status.job_id"),
      reason: responseNullableString(raw.reason, "Codex lane status.reason"),
      persisted_thread_id: responseNullableString(raw.persisted_thread_id, "Codex lane status.persisted_thread_id"),
      persisted_state: responseNullableString(raw.persisted_state, "Codex lane status.persisted_state"),
      persisted_updated_at: responseNullableString(raw.persisted_updated_at, "Codex lane status.persisted_updated_at"),
    };
  }

  async getCodexLaneAccount(identity: CodexLaneIdentity, signal?: AbortSignal | null): Promise<CodexLaneAccountResponse> {
    const raw = responseObject(await this.request<unknown>("GET", "/v1/external/codex/account", { query: { session_id: identity.session_id, workspace_id: identity.workspace_id }, signal }), "Codex lane account");
    const account = responseObject(raw.account, "Codex lane account.account");
    return {
      external_harness: responseString(raw.external_harness, "Codex lane account.external_harness") as "codex",
      account: {
        type: responseNullableString(account.type, "Codex lane account.type"),
        email: responseNullableString(account.email, "Codex lane account.email"),
        plan_type: responseNullableString(account.plan_type, "Codex lane account.plan_type"),
        requires_openai_auth: responseBoolean(account.requires_openai_auth, "Codex lane account.requires_openai_auth"),
      },
    };
  }

  async getCodexLaneModels(identity: CodexLaneIdentity, signal?: AbortSignal | null): Promise<CodexLaneModelsResponse> {
    const raw = responseObject(await this.request<unknown>("GET", "/v1/external/codex/models", { query: { session_id: identity.session_id, workspace_id: identity.workspace_id }, signal }), "Codex lane models");
    const models = raw.models;
    if (!Array.isArray(models)) throw new TerminusApiError(502, "Codex lane models.models was not an array", null);
    return {
      external_harness: responseString(raw.external_harness, "Codex lane models.external_harness") as "codex",
      models: models.map((entry, index): CodexLaneModel => {
        const model = responseObject(entry, `Codex lane models.models[${index}]`);
        return {
          id: responseString(model.id, `Codex lane models.models[${index}].id`),
          model: responseNullableString(model.model, `Codex lane models.models[${index}].model`),
          display_name: responseNullableString(model.display_name, `Codex lane models.models[${index}].display_name`),
          reasoning_efforts: responseStringArray(model.reasoning_efforts, `Codex lane models.models[${index}].reasoning_efforts`),
          default_reasoning_effort: responseNullableString(model.default_reasoning_effort, `Codex lane models.models[${index}].default_reasoning_effort`),
          hidden: responseBoolean(model.hidden, `Codex lane models.models[${index}].hidden`),
        };
      }),
    };
  }

  /** Read only the bounded external transcript ring; it never starts Codex. */
  async getCodexLaneEvents(
    identity: CodexLaneIdentity,
    cursor: string | null = null,
    signal?: AbortSignal | null,
  ): Promise<CodexLaneEventsResponse> {
    const raw = responseObject(await this.request<unknown>("GET", "/v1/external/codex/events", {
      query: { session_id: identity.session_id, workspace_id: identity.workspace_id, cursor },
      signal,
    }), "Codex lane events");
    const events = raw.events;
    if (!Array.isArray(events)) throw new TerminusApiError(502, "Codex lane events.events was not an array", null);
    return {
      external_harness: responseString(raw.external_harness, "Codex lane events.external_harness") as "codex",
      events: events.map((entry, index): CodexLaneEvent => {
        const event = responseObject(entry, `Codex lane events.events[${index}]`);
        return {
          cursor: responseString(event.cursor, `Codex lane events.events[${index}].cursor`),
          sequence: responseNonNegativeInteger(event.sequence, `Codex lane events.events[${index}].sequence`),
          kind: responseString(event.kind, `Codex lane events.events[${index}].kind`),
          text: responseNullableString(event.text, `Codex lane events.events[${index}].text`),
        };
      }),
      next_cursor: responseString(raw.next_cursor, "Codex lane events.next_cursor"),
      cursor_expired: responseBoolean(raw.cursor_expired, "Codex lane events.cursor_expired"),
      ...(raw.cursor_expired_signal === undefined || raw.cursor_expired_signal === null
        ? {}
        : { cursor_expired_signal: responseString(raw.cursor_expired_signal, "Codex lane events.cursor_expired_signal") }),
    };
  }

  async startCodexLaneThread(
    input: CodexLaneIdentity & { model?: string; cwd?: string },
    options: MutationRequestOptions,
  ): Promise<{ thread_id: string; external_harness: "codex" }> {
    const raw = responseObject(await this.request<unknown>("POST", "/v1/external/codex/thread/start", { body: input, ...options }), "Codex lane thread start");
    return {
      thread_id: responseString(raw.thread_id, "Codex lane thread start.thread_id"),
      external_harness: responseString(raw.external_harness, "Codex lane thread start.external_harness") as "codex",
    };
  }

  async resumeCodexLaneThread(
    input: CodexLaneIdentity & { thread_id: string },
    options: MutationRequestOptions,
  ): Promise<{ thread_id: string; external_harness: "codex" }> {
    const raw = responseObject(await this.request<unknown>("POST", "/v1/external/codex/thread/resume", { body: input, ...options }), "Codex lane thread resume");
    return {
      thread_id: responseString(raw.thread_id, "Codex lane thread resume.thread_id"),
      external_harness: responseString(raw.external_harness, "Codex lane thread resume.external_harness") as "codex",
    };
  }

  async startCodexLaneTurn(
    input: CodexLaneIdentity & { thread_id: string; text: string; model?: string; effort?: string },
    options: MutationRequestOptions,
  ): Promise<{ thread_id: string; turn_id: string; external_harness: "codex" }> {
    const raw = responseObject(await this.request<unknown>("POST", "/v1/external/codex/turn/start", { body: input, ...options }), "Codex lane turn start");
    return {
      thread_id: responseString(raw.thread_id, "Codex lane turn start.thread_id"),
      turn_id: responseString(raw.turn_id, "Codex lane turn start.turn_id"),
      external_harness: responseString(raw.external_harness, "Codex lane turn start.external_harness") as "codex",
    };
  }

  async interruptCodexLaneTurn(
    input: CodexLaneIdentity & { thread_id: string; turn_id: string },
    options: MutationRequestOptions,
  ): Promise<{ interrupted: true; external_harness: "codex" }> {
    const raw = responseObject(await this.request<unknown>("POST", "/v1/external/codex/turn/interrupt", { body: input, ...options }), "Codex lane turn interrupt");
    if (raw.interrupted !== true) throw new TerminusApiError(502, "Codex lane turn interrupt did not confirm interruption", null);
    return { interrupted: true, external_harness: responseString(raw.external_harness, "Codex lane turn interrupt.external_harness") as "codex" };
  }

  async stopCodexLane(
    input: CodexLaneIdentity & { reason?: string },
    options: MutationRequestOptions,
  ): Promise<{ stopped: true; external_harness: "codex" }> {
    const raw = responseObject(await this.request<unknown>("POST", "/v1/external/codex/stop", { body: input, ...options }), "Codex lane stop");
    if (raw.stopped !== true) throw new TerminusApiError(502, "Codex lane stop did not confirm stopping", null);
    return { stopped: true, external_harness: responseString(raw.external_harness, "Codex lane stop.external_harness") as "codex" };
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

  /**
   * Change a session's defaults.
   *
   * This is where a model choice lands. It used to be written to the *global*
   * gateway provider configuration, a single row with no session and no
   * provider field, so choosing a model in one project changed it for every
   * project and every run already in flight.
   */
  async updateSession(
    sessionId: string,
    patch: SessionUpdateInput,
    options: MutationRequestOptions,
  ): Promise<Session> {
    const session = decodeSession(await this.request<unknown>(
      "PATCH",
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      { body: patch, ...options },
    ));
    return assertScopedResponse(session, session.id, sessionId, "session update");
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

  /**
   * Replay a task's durable transcript.
   *
   * `subscribeEvents` is a live tail: opened without a cursor it delivers only
   * what happens next, which is why reopening a finished task used to show an
   * empty conversation. This reads the stored events instead — the most recent
   * page first — and returns the cursor to attach the tail at, so replay and
   * stream meet exactly once.
   */
  async getTaskTranscript(
    taskId: string,
    options: { before?: string | null; limit?: number; signal?: AbortSignal | null } = {},
  ): Promise<TaskTranscriptPage> {
    const query = new URLSearchParams();
    if (options.before) query.set("before", options.before);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const page = responseObject(
      await this.request<unknown>("GET", `/v1/tasks/${encodeURIComponent(taskId)}/transcript${suffix}`, {
        signal: options.signal,
      }),
      "task transcript",
    );
    const rawEvents = page.events;
    if (!Array.isArray(rawEvents)) {
      throw new TerminusApiError(502, "task transcript.events was not an array", null);
    }
    const truncation = responseObject(page.truncation, "task transcript.truncation");
    const transcript: TaskTranscriptPage = {
      task_id: responseString(page.task_id, "task transcript.task_id"),
      events: rawEvents.map((entry, index) => {
        const event = responseObject(entry, `task transcript.events[${index}]`);
        return {
          id: responseString(event.id, `task transcript.events[${index}].id`),
          event: responseString(event.event, `task transcript.events[${index}].event`),
          data: responseString(event.data, `task transcript.events[${index}].data`, true),
        };
      }),
      total: responseNonNegativeInteger(page.total, "task transcript.total"),
      next_cursor: responseNullableString(page.next_cursor, "task transcript.next_cursor"),
      earlier_cursor: responseNullableString(page.earlier_cursor ?? null, "task transcript.earlier_cursor"),
      truncation: {
        occurred: responseBoolean(truncation.occurred, "task transcript.truncation.occurred"),
        continuation: responseNullableString(truncation.continuation, "task transcript.truncation.continuation"),
      },
    };
    return assertScopedResponse(transcript, transcript.task_id, taskId, "task transcript");
  }

  /**
   * The task's uncommitted working tree, diffed against HEAD by the kernel.
   *
   * The review pane used to reconstruct changes from patch text embedded in
   * tool events, which shows what the agent reported rather than what the
   * workspace holds, and shows nothing at all once those events fall out of
   * the retained window.
   */
  async getTaskDiff(taskId: string, signal?: AbortSignal | null): Promise<TaskWorkspaceDiff> {
    const body = responseObject(
      await this.request<unknown>("GET", `/v1/tasks/${encodeURIComponent(taskId)}/diff`, { signal }),
      "task diff",
    );
    const untracked = body.untracked_files;
    if (!Array.isArray(untracked)) {
      throw new TerminusApiError(502, "task diff.untracked_files was not an array", null);
    }
    const diff: TaskWorkspaceDiff = {
      task_id: responseString(body.task_id, "task diff.task_id"),
      workspace_id: responseString(body.workspace_id, "task diff.workspace_id"),
      git_available: responseBoolean(body.git_available, "task diff.git_available"),
      diff: responseString(body.diff, "task diff.diff", true),
      diff_truncated: responseBoolean(body.diff_truncated, "task diff.diff_truncated"),
      untracked_files: untracked.map((entry, index) =>
        responseString(entry, `task diff.untracked_files[${index}]`)),
      exit_code: responseInteger(body.exit_code, "task diff.exit_code"),
    };
    return assertScopedResponse(diff, diff.task_id, taskId, "task diff");
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

  /**
   * One turn's current state.
   *
   * Read when a task claims a running turn but the event stream has said
   * nothing for a long time. That combination means either a genuinely slow
   * provider call or a run that ended without its terminal event reaching this
   * client, and only the turn record can tell the two apart.
   */
  async getTurn(turnId: string, signal?: AbortSignal | null): Promise<Turn> {
    const turn = decodeTurn(await this.request<unknown>(
      "GET",
      `/v1/turns/${encodeURIComponent(turnId)}`,
      { signal },
    ));
    return assertScopedResponse(turn, turn.id, turnId, "turn detail");
  }

  /**
   * Steer a turn that is already running.
   *
   * The desktop client used to hold this text in a local queue and post it as
   * a *new* turn once the current one ended, which is not steering: the model
   * finished the wrong work first and only then read the correction. This
   * appends a model-visible episode the running turn drains at its next stop
   * boundary. A 409 means the turn settled in the meantime — the caller falls
   * back to the queue then, and only then.
   */
  async steerTurn(
    turnId: string,
    input: { message: string },
    options: MutationRequestOptions,
  ): Promise<SteerReceipt> {
    const receipt = decodeSteerReceipt(await this.request<unknown>(
      "POST",
      `/v1/turns/${encodeURIComponent(turnId)}/steer`,
      { body: input, ...options },
    ));
    return assertScopedResponse(receipt, receipt.turn_id, turnId, "turn steering");
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
  /**
   * Why the stream failed, in the words of whatever refused it.
   *
   * A `401` from an expired token and a DNS failure are different problems
   * with different fixes; both used to reach the UI as "Live updates
   * interrupted", which is a description of the symptom and nothing else.
   */
  readonly lastError: string | null;
}

class FetchEventStream implements TerminusEventStream {
  readyState: 0 | 1 | 2 | 3 = 0;
  lastEventId: string | null = null;
  lastError: string | null = null;
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

  private fail(reason?: string): void {
    if (this.closed || this.errorEmitted) return;
    this.errorEmitted = true;
    this.readyState = 3;
    if (reason) this.lastError = reason;
    this.emit("error");
  }

  private async run(): Promise<void> {
    try {
      this.client.assertBaseUrl();
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error.message : "no control-plane address is available");
      return;
    }
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
      this.fail(err instanceof Error ? err.message : "the event stream could not be opened");
      return;
    }

    if (!res.ok) {
      // The status is the whole diagnosis: 401 means credentials, 404 means a
      // route that moved, 503 means a control plane that has not started.
      this.fail(`the event stream was refused with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
      return;
    }
    if (!res.body) {
      this.fail("the event stream returned no body");
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
      this.fail("the control plane closed the event stream");
    } catch (err: unknown) {
      // Network interruption / abort. If aborted by user, readyState is
      // already 2 (closed). Otherwise it's an unexpected drop.
      this.fail(err instanceof Error ? err.message : "the event stream dropped");
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
