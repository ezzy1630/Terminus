/**
 * @terminus/public-client — Generated-style TypeScript client for the public API.
 *
 * Per SPEC §32.5: A client reconnects by authenticating, fetching the
 * task/session snapshot, resuming events from the last durable cursor,
 * reconciling pending local UI actions by idempotency key, rendering active
 * approvals and jobs, and attaching to desired streams.
 */
import type {
  ClientHello,
  ServerHello,
  WorkspaceSnapshot,
  SessionSnapshot,
  TaskSnapshot,
  TurnSnapshot,
  ContextManifestSnapshot,
  ApprovalSnapshot,
  ToolSnapshot,
  AgentSnapshot,
  MemoryClaimSnapshot,
  EvalRunSnapshot,
  ConfigurationSnapshot,
  PolicySnapshot,
  SseEvent,
} from "@terminus/public-api";
import {
  createSseDecoder,
  IDEMPOTENCY_HEADER,
  requireIdempotency,
  V2_ENDPOINTS,
  type V2EndpointName,
} from "@terminus/public-api";
import type { z } from "zod";

type V2Response<Name extends V2EndpointName> = ReturnType<
  (typeof V2_ENDPOINTS)[Name]["response"]["parse"]
>;
type V2Request<Name extends V2EndpointName> = z.input<
  (typeof V2_ENDPOINTS)[Name]["request"]
>;

interface RuntimeSchema<Output> {
  readonly parse: (input: unknown) => Output;
}

export interface FetchImplementation {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface MutationRequestOptions {
  /** Stable key for the logical mutation, reused when that mutation is retried. */
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal | null;
}

export interface TerminusClientConfig {
  /** Base URL of the Terminus control plane. Use "" for same-origin. */
  baseUrl: string;
  /** Optional XTransformPort query parameter for gateway routing. */
  xformPort?: number;
  /** Authentication token (Terminus local token). */
  token?: string;
  /** Fetch implementation (defaults to global fetch). */
  fetchImpl?: FetchImplementation;
}

export class TerminusClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly headers: Record<string, string>;

  constructor(config: TerminusClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this._xformPort = config.xformPort ?? null;
    this.headers = {
      "content-type": "application/json",
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    };
  }

  private url(path: string, query?: Record<string, string | number | boolean | null | undefined>): string {
    const q = new URLSearchParams();
    if (this.xformPort !== null) q.set("XTransformPort", String(this.xformPort));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null) q.set(k, String(v));
      }
    }
    const qs = q.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  private get xformPort(): number | null {
    // Read from constructor config via closure
    return this._xformPort;
  }

  private _xformPort: number | null = null;

  /** Set the XTransformPort for gateway routing (mini-services). */
  withXformPort(port: number | null): this {
    this._xformPort = port;
    return this;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown | undefined;
      query?: Record<string, string | number | boolean | null | undefined> | undefined;
      idempotencyKey?: string | undefined;
      signal?: AbortSignal | null | undefined;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...this.headers };
    if (requireIdempotency(method)) {
      const idempotencyKey = opts.idempotencyKey;
      if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
        throw new TypeError(`${IDEMPOTENCY_HEADER} must be a non-empty string for ${method}`);
      }
      headers[IDEMPOTENCY_HEADER] = idempotencyKey;
    }
    const init: RequestInit = {
      method,
      headers,
      body: opts.body === undefined ? null : JSON.stringify(opts.body),
    };
    if (opts.signal) init.signal = opts.signal;
    const res = await this.fetchImpl(this.url(path, opts.query), init);
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // ignore
      }
      const message =
        body && typeof body === "object" && "error" in body && body.error &&
        typeof body.error === "object" && "message" in body.error
          ? String((body.error as { message: unknown }).message)
          : `HTTP ${res.status}`;
      throw new TerminusApiError(res.status, message, body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Validate both halves of the public v2 boundary. */
  private async requestV2<Name extends V2EndpointName>(
    name: Name,
    path: string,
    input: unknown,
    opts: {
      query?: Record<string, string | number | boolean | null | undefined> | undefined;
      idempotencyKey?: string | undefined;
      signal?: AbortSignal | null | undefined;
    } = {},
  ): Promise<V2Response<Name>> {
    const endpoint = V2_ENDPOINTS[name];
    const requestSchema = endpoint.request as RuntimeSchema<unknown>;
    const responseSchema = endpoint.response as RuntimeSchema<V2Response<Name>>;
    const parsedInput = requestSchema.parse(input);
    const raw = await this.request<unknown>(endpoint.method, path, {
      ...(endpoint.method === "GET" ? {} : { body: parsedInput }),
      query: opts.query,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
    return responseSchema.parse(raw);
  }

  // ────────────────────────── /system ───────────────────────────────────

  async health(signal?: AbortSignal | null): Promise<{
    status: "ok" | "degraded" | "down";
    version: string;
    build_commit: string;
    instance_id: string;
    uptime_seconds: number;
    ready: boolean;
    kernel?: {
      status?: string;
      ready?: boolean;
      enforcement_report?: {
        status?: string;
        enforced?: string[];
        unsupported?: string[];
      };
    };
  }> {
    return this.request("GET", "/v1/system/health", { signal });
  }

  async initialize(hello: ClientHello, options: MutationRequestOptions): Promise<ServerHello> {
    return this.request("POST", "/v1/system/initialize", { body: hello, ...options });
  }

  // ────────────────────────── /workspaces ──────────────────────────────

  async openWorkspace(
    input: { root_uri: string; kind?: string; trust?: string; policy_profile_id?: string },
    options: MutationRequestOptions,
  ): Promise<WorkspaceSnapshot> {
    return this.request("POST", "/v1/workspaces/open", { body: input, ...options });
  }

  async getWorkspace(id: string, signal?: AbortSignal | null): Promise<WorkspaceSnapshot> {
    return this.request("GET", `/v1/workspaces/${encodeURIComponent(id)}`, { signal });
  }

  // ────────────────────────── /sessions ────────────────────────────────

  async createSession(
    input: { workspace_id: string; title: string; default_model_profile?: string; default_permission_profile?: string },
    options: MutationRequestOptions,
  ): Promise<SessionSnapshot> {
    return this.request("POST", "/v1/sessions", { body: input, ...options });
  }

  async listSessions(signal?: AbortSignal | null): Promise<{ sessions: SessionSnapshot[] }> {
    return this.request("GET", "/v1/sessions", { signal });
  }

  async getSession(id: string, signal?: AbortSignal | null): Promise<SessionSnapshot> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}`, { signal });
  }

  async pauseSession(id: string, options: MutationRequestOptions): Promise<SessionSnapshot> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(id)}/pause`, options);
  }

  // ────────────────────────── /threads ─────────────────────────────────

  async createThread(
    input: { session_id: string; parent_thread_id?: string | null },
    options: MutationRequestOptions,
  ): Promise<{ id: string; session_id: string; created_at: string }> {
    return this.request("POST", "/v1/threads", { body: input, ...options });
  }

  // ────────────────────────── /tasks ───────────────────────────────────

  async createTask(
    input: {
      session_id: string;
      thread_id: string;
      objective: string;
      non_goals?: string[];
      acceptance_criteria?: Array<{ id: string; statement: string; verification_hint?: string | null; required?: boolean }>;
      allowed_scope?: { read_paths?: string[]; write_paths?: string[]; external_systems?: string[] };
      risk_class?: "low" | "normal" | "high" | "critical";
    },
    options: MutationRequestOptions,
  ): Promise<TaskSnapshot> {
    return this.request("POST", "/v1/tasks", { body: input, ...options });
  }

  async listSessionTasks(
    sessionId: string,
    signal?: AbortSignal | null,
  ): Promise<{ tasks: TaskSnapshot[] }> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`, { signal });
  }

  async startTask(
    id: string,
    options: MutationRequestOptions,
  ): Promise<{
    task_id: string;
    status: string;
    event_cursor: string;
    links: { events: string; task: string };
  }> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(id)}/start`, options);
  }

  async cancelTask(
    id: string,
    options: MutationRequestOptions & { readonly reason?: string | null },
  ): Promise<TaskSnapshot> {
    const { reason, ...requestOptions } = options;
    return this.request("POST", `/v1/tasks/${encodeURIComponent(id)}/cancel`, {
      body: { reason },
      ...requestOptions,
    });
  }

  // ────────────────────────── /turns ───────────────────────────────────

  async startTurn(
    input: { thread_id: string; task_id: string; user_input: string },
    options: MutationRequestOptions,
  ): Promise<TurnSnapshot> {
    return this.request("POST", "/v1/turns", { body: input, ...options });
  }

  async interruptTurn(id: string, options: MutationRequestOptions): Promise<TurnSnapshot> {
    return this.request("POST", `/v1/turns/${encodeURIComponent(id)}/interrupt`, options);
  }

  // ────────────────────────── /context ─────────────────────────────────

  async getContextManifest(id: string, signal?: AbortSignal | null): Promise<ContextManifestSnapshot> {
    return this.request("GET", `/v1/context/manifests/${encodeURIComponent(id)}`, { signal });
  }

  // ────────────────────────── /artifacts ───────────────────────────────

  async getArtifact(hash: string, taskId: string, signal?: AbortSignal | null): Promise<Uint8Array> {
    const init: RequestInit = { headers: this.headers };
    if (signal) init.signal = signal;
    const query = new URLSearchParams({ task_id: taskId });
    const res = await this.fetchImpl(
      this.url(`/v1/artifacts/${encodeURIComponent(hash)}?${query.toString()}`),
      init,
    );
    if (!res.ok) throw new TerminusApiError(res.status, `HTTP ${res.status}`, null);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  // ────────────────────────── /approvals ───────────────────────────────

  /**
   * Resolve a pending approval. Accepts both the canonical domain names
   * (`allow_for_action`, `allow_for_task`, `deny_and_add_task_rule`) and
   * the legacy aliases (`allow_exact`, `allow_task_scope`, `deny_and_rule`).
   * The server normalizes aliases to canonical names before persisting.
   */
  async resolveApproval(
    id: string,
    operationHash: string,
    decision:
      | "allow_once"
      | "allow_for_action"
      | "allow_for_task"
      | "allow_exact"
      | "allow_task_scope"
      | "deny_once"
      | "deny_and_add_task_rule"
      | "deny_and_rule"
      | "stop_task",
    options: MutationRequestOptions & { readonly rationale?: string | null },
  ): Promise<ApprovalSnapshot> {
    const { rationale, ...requestOptions } = options;
    return this.request("POST", `/v1/approvals/${encodeURIComponent(id)}/resolve`, {
      body: { operation_hash: operationHash, decision, rationale },
      ...requestOptions,
    });
  }

  async listApprovals(signal?: AbortSignal | null): Promise<{ approvals: ApprovalSnapshot[] }> {
    return this.request("GET", "/v1/approvals", { signal });
  }

  // ────────────────────────── /jobs ────────────────────────────────────

  async getJob(
    id: string,
    signal?: AbortSignal | null,
  ): Promise<{ id: string; state: string; started_at: string | null; settled_at: string | null; output_cursor: number }> {
    return this.request("GET", `/v1/jobs/${encodeURIComponent(id)}`, { signal });
  }

  async stopJob(
    id: string,
    options: MutationRequestOptions & { readonly reason?: string | null },
  ): Promise<{ id: string; state: string }> {
    const { reason, ...requestOptions } = options;
    return this.request("POST", `/v1/jobs/${encodeURIComponent(id)}/stop`, {
      body: { reason },
      ...requestOptions,
    });
  }

  // ────────────────────────── /events (SSE) ────────────────────────────

  /**
   * Subscribe to the event stream. Returns an async iterator of parsed SSE
   * events. Reconnect with `Last-Event-ID` if the connection drops.
   *
   * Per SPEC §30.6: clients reconnect with Last-Event-ID or an explicit
   * cursor. The server replays retained events in order. If the cursor has
   * expired, the server returns CURSOR_EXPIRED plus the resource snapshot
   * endpoint needed to resynchronize.
   */
  async *subscribeEvents(
    opts: { cursor?: string | null; task_id?: string | null; session_id?: string | null; signal?: AbortSignal | null } = {},
  ): AsyncIterable<SseEvent> {
    const url = this.url("/v1/events", {
      cursor: opts.cursor,
      task_id: opts.task_id,
      session_id: opts.session_id,
    });
    const headers: Record<string, string> = { ...this.headers, accept: "text/event-stream" };
    if (opts.cursor !== undefined && opts.cursor !== null) headers["last-event-id"] = opts.cursor;
    const init: RequestInit = { headers };
    if (opts.signal) init.signal = opts.signal;
    const res = await this.fetchImpl(url, init);
    if (!res.ok || !res.body) {
      throw new TerminusApiError(res.status, `SSE failed: HTTP ${res.status}`, null);
    }
    const reader = res.body.getReader();
    const decoder = createSseDecoder();
    const decoder_ = new TextDecoder();
    try {
      let eof = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          eof = true;
          break;
        }
        const text = decoder_.decode(value, { stream: true });
        for (const ev of decoder.feed(text)) {
          yield ev;
        }
      }
      if (eof) {
        const text = decoder_.decode();
        for (const ev of decoder.feed(text)) {
          yield ev;
        }
        decoder.finish();
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ────────────────────────── /tools ───────────────────────────────────

  async listTools(
    opts: {
      trust_level?: "builtin" | "first_party" | "verified_third_party" | "untrusted";
      include_deprecated?: boolean;
    } = {},
    signal?: AbortSignal | null,
  ): Promise<{ tools: ToolSnapshot[]; next_cursor: string | null }> {
    return this.request("GET", "/v1/tools", {
      query: {
        trust_level: opts.trust_level ?? null,
        include_deprecated: opts.include_deprecated ?? false,
      },
      signal,
    });
  }

  // ────────────────────────── /agents ──────────────────────────────────

  async listAgents(
    opts: { enabled_only?: boolean } = {},
    signal?: AbortSignal | null,
  ): Promise<{ agents: AgentSnapshot[] }> {
    return this.request("GET", "/v1/agents", {
      query: { enabled_only: opts.enabled_only ?? true },
      signal,
    });
  }

  // ────────────────────────── /memory ──────────────────────────────────

  async listMemory(
    opts: {
      status?: "candidate" | "active" | "disputed" | "expired" | "rejected";
      kind?:
        | "fact"
        | "convention"
        | "preference"
        | "pitfall"
        | "command"
        | "architecture"
        | "procedure"
        | "failure_resolution";
    } = {},
    signal?: AbortSignal | null,
  ): Promise<{ claims: MemoryClaimSnapshot[]; next_cursor: string | null }> {
    return this.request("GET", "/v1/memory", {
      query: { status: opts.status ?? null, kind: opts.kind ?? null },
      signal,
    });
  }

  // ────────────────────────── /evals ───────────────────────────────────

  async listEvals(
    opts: { suite?: string; harness?: string; since?: string } = {},
    signal?: AbortSignal | null,
  ): Promise<{ runs: EvalRunSnapshot[]; next_cursor: string | null }> {
    return this.request("GET", "/v1/evals", {
      query: { suite: opts.suite ?? null, harness: opts.harness ?? null, since: opts.since ?? null },
      signal,
    });
  }

  // ────────────────────────── /configuration ───────────────────────────

  async listConfiguration(
    opts: {
      kind?: "model_profile" | "permission_profile" | "policy_profile" | "runtime_profile";
    } = {},
    signal?: AbortSignal | null,
  ): Promise<{ configurations: ConfigurationSnapshot[] }> {
    return this.request("GET", "/v1/configuration", {
      query: { kind: opts.kind ?? null },
      signal,
    });
  }

  // ────────────────────────── /policies ────────────────────────────────

  async listPolicies(
    opts: { profile_id?: string; enabled_only?: boolean } = {},
    signal?: AbortSignal | null,
  ): Promise<{ policies: PolicySnapshot[] }> {
    return this.request("GET", "/v1/policies", {
      query: { profile_id: opts.profile_id ?? null, enabled_only: opts.enabled_only ?? true },
      signal,
    });
  }

  // ────────────────────────── /workflows (Phase 7) ───────────────────────

  async compileWorkflow(
    input: {
      source: string;
      sourceKind?: "skill_markdown" | "json_ir" | "prose_spec";
      sourcePath?: string;
      taskId?: string;
      authorityCeiling?: string[];
      mandatorySteps?: string[];
      strictMode?: boolean;
    },
    options: MutationRequestOptions,
  ): Promise<{ workflow: unknown; report: Record<string, unknown> }> {
    return this.request("POST", "/v2/workflows/compile", { body: input, ...options });
  }

  async validateWorkflow(
    input: {
      nodes: unknown[];
      edges: unknown[];
      authorityCeiling?: string[];
      mandatorySteps?: string[];
      strictMode?: boolean;
    },
    options: MutationRequestOptions,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v2/workflows/validate", { body: input, ...options });
  }

  async getWorkflowDag(
    id: string,
    signal?: AbortSignal | null,
  ): Promise<{ workflowId: string; nodes: Array<{ id: string; kind: string; owner: string; effectClass: string | null }>; edges: Array<{ sourceNodeId: string; targetNodeId: string; condition: string | null }> }> {
    return this.request("GET", `/v2/workflows/${encodeURIComponent(id)}/dag`, { signal });
  }

  async getWorkflowWitnessPaths(
    id: string,
    signal?: AbortSignal | null,
  ): Promise<{ workflowId: string; witnessPaths: Array<{ pathId: string; nodeIds: string[]; coversMandatorySteps: string[] }> }> {
    return this.request("GET", `/v2/workflows/${encodeURIComponent(id)}/witness-paths`, { signal });
  }

  // ────────────────────────── /models & /orchestration (Phase 8) ────────────

  async listModelProfilesV2(
    opts: V2Request<"ListModelProfilesV2"> = undefined,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"ListModelProfilesV2">> {
    return this.requestV2("ListModelProfilesV2", "/v2/models/profiles", opts, {
      query: {
        adapterRef: opts?.adapterRef ?? null,
        confidentiality: opts?.confidentiality ?? null,
      },
      signal,
    });
  }

  async getModelProfileV2(
    id: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"GetModelProfileV2">> {
    return this.requestV2(
      "GetModelProfileV2",
      `/v2/models/profiles/${encodeURIComponent(id)}`,
      undefined,
      { signal },
    );
  }

  async routeModelStageV2(
    input: V2Request<"RouteModelStageV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"RouteModelStageV2">> {
    return this.requestV2("RouteModelStageV2", "/v2/models/route", input, options);
  }

  async updateModelPosteriorV2(
    input: V2Request<"UpdateModelPosteriorV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"UpdateModelPosteriorV2">> {
    return this.requestV2(
      "UpdateModelPosteriorV2",
      "/v2/models/posterior/update",
      input,
      options,
    );
  }

  async getModelPosteriorV2(
    modelKey: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"GetModelPosteriorV2">> {
    return this.requestV2(
      "GetModelPosteriorV2",
      `/v2/models/posterior/${encodeURIComponent(modelKey)}`,
      undefined,
      { signal },
    );
  }

  async scheduleEVWorkerV2(
    input: V2Request<"ScheduleEVWorkerV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"ScheduleEVWorkerV2">> {
    return this.requestV2("ScheduleEVWorkerV2", "/v2/orchestration/ev-schedule", input, options);
  }

  async checkStagnationV2(
    input: V2Request<"CheckStagnationV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"CheckStagnationV2">> {
    return this.requestV2("CheckStagnationV2", "/v2/orchestration/stagnation/check", input, options);
  }

  async evaluateCleanReviewV2(
    input: V2Request<"EvaluateCleanReviewV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"EvaluateCleanReviewV2">> {
    return this.requestV2(
      "EvaluateCleanReviewV2",
      "/v2/orchestration/review/clean",
      input,
      options,
    );
  }

  // ────────────────────────── Phase 9: Cockpit, Attention & Interventions ──────

  async getTaskV2(
    taskId: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"GetTaskV2">> {
    return this.requestV2(
      "GetTaskV2",
      `/v2/tasks/${encodeURIComponent(taskId)}`,
      { id: taskId },
      { signal },
    );
  }

  async getTaskConversationContextV2(
    taskId: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"GetTaskConversationContextV2">> {
    return this.requestV2(
      "GetTaskConversationContextV2",
      `/v2/tasks/${encodeURIComponent(taskId)}/conversation-context`,
      { id: taskId },
      { signal },
    );
  }

  async attachTaskConversationContextV2(
    taskId: string,
    input: Omit<V2Request<"AttachTaskConversationContextV2">, "id">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"AttachTaskConversationContextV2">> {
    return this.requestV2(
      "AttachTaskConversationContextV2",
      `/v2/tasks/${encodeURIComponent(taskId)}/conversation-context`,
      { id: taskId, ...input },
      options,
    );
  }

  async getTaskBudgetV2(
    taskId: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"GetTaskBudgetV2">> {
    return this.requestV2(
      "GetTaskBudgetV2",
      `/v2/tasks/${encodeURIComponent(taskId)}/budget`,
      { id: taskId },
      { signal },
    );
  }

  async listOrganizationsV2(signal?: AbortSignal | null): Promise<V2Response<"ListOrganizationsV2">> {
    return this.requestV2("ListOrganizationsV2", "/v2/organizations", undefined, { signal });
  }

  async listDepartmentsV2(
    organizationId?: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"ListDepartmentsV2">> {
    const input = organizationId === undefined ? undefined : { organizationId };
    return this.requestV2("ListDepartmentsV2", "/v2/departments", input, {
      query: { organizationId },
      signal,
    });
  }

  async listOperatorsV2(
    departmentId?: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"ListOperatorsV2">> {
    const input = departmentId === undefined ? undefined : { departmentId };
    return this.requestV2("ListOperatorsV2", "/v2/operators", input, {
      query: { departmentId },
      signal,
    });
  }

  async listAgentRoomsV2(
    departmentId?: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"ListAgentRoomsV2">> {
    const input = departmentId === undefined ? undefined : { departmentId };
    return this.requestV2("ListAgentRoomsV2", "/v2/agent-rooms", input, {
      query: { departmentId },
      signal,
    });
  }

  async listCapabilityDirectoryV2(
    signal?: AbortSignal | null,
  ): Promise<V2Response<"ListCapabilityDirectoryV2">> {
    return this.requestV2("ListCapabilityDirectoryV2", "/v2/capabilities/directory", undefined, { signal });
  }

  async resolveCapabilityV2(
    input: {
      capabilityId: string;
      category?: string;
      resourceDomain?: string;
      requiredAuthority?: string[];
    },
    options: MutationRequestOptions,
  ): Promise<V2Response<"ResolveCapabilityV2">> {
    return this.requestV2("ResolveCapabilityV2", "/v2/capabilities/resolve", input, options);
  }

  async assessTaskAttentionV2(
    taskId: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"AssessTaskAttentionV2">> {
    return this.requestV2(
      "AssessTaskAttentionV2",
      `/v2/attention/assess/${encodeURIComponent(taskId)}`,
      undefined,
      { signal },
    );
  }

  async listMaterialQuestionsV2(
    taskId?: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"ListMaterialQuestionsV2">> {
    const input = taskId === undefined ? undefined : { taskId };
    return this.requestV2("ListMaterialQuestionsV2", "/v2/attention/questions", input, {
      query: { taskId },
      signal,
    });
  }

  async askMaterialQuestionV2(
    input: V2Request<"AskMaterialQuestionV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"AskMaterialQuestionV2">> {
    return this.requestV2("AskMaterialQuestionV2", "/v2/attention/questions", input, options);
  }

  async resolveMaterialQuestionV2(
    questionId: string,
    selectedOption: string,
    options: MutationRequestOptions,
  ): Promise<V2Response<"ResolveMaterialQuestionV2">> {
    return this.requestV2(
      "ResolveMaterialQuestionV2",
      `/v2/attention/questions/${encodeURIComponent(questionId)}/resolve`,
      { id: questionId, selectedOption },
      options,
    );
  }

  async proposeInterventionV2(
    input: V2Request<"ProposeInterventionV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"ProposeInterventionV2">> {
    return this.requestV2("ProposeInterventionV2", "/v2/interventions", input, options);
  }

  async applyInterventionV2(
    interventionId: string,
    options: MutationRequestOptions,
  ): Promise<V2Response<"ApplyInterventionV2">> {
    return this.requestV2(
      "ApplyInterventionV2",
      `/v2/interventions/${encodeURIComponent(interventionId)}/apply`,
      { id: interventionId },
      options,
    );
  }

  async listInterventionsV2(
    taskId?: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"ListInterventionsV2">> {
    const input = taskId === undefined ? undefined : { taskId };
    return this.requestV2("ListInterventionsV2", "/v2/interventions", input, {
      query: { taskId },
      signal,
    });
  }

  async getCausalTraceV2(
    taskId: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"GetCausalTraceV2">> {
    return this.requestV2(
      "GetCausalTraceV2",
      `/v2/replay/traces/${encodeURIComponent(taskId)}`,
      undefined,
      { signal },
    );
  }

  async createCausalTraceV2(
    input: V2Request<"CreateCausalTraceV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"CreateCausalTraceV2">> {
    return this.requestV2("CreateCausalTraceV2", "/v2/replay/traces", input, options);
  }

  async recordCausalStepV2(
    input: V2Request<"RecordCausalStepV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"RecordCausalStepV2">> {
    return this.requestV2("RecordCausalStepV2", "/v2/replay/steps", input, options);
  }

  async diagnoseCausalOmissionsV2(
    input: V2Request<"DiagnoseCausalOmissionsV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"DiagnoseCausalOmissionsV2">> {
    return this.requestV2(
      "DiagnoseCausalOmissionsV2",
      `/v2/replay/traces/${encodeURIComponent(input.traceId)}/diagnose`,
      input,
      options,
    );
  }

  async runCounterfactualV2(
    input: V2Request<"RunCounterfactualV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"RunCounterfactualV2">> {
    return this.requestV2("RunCounterfactualV2", "/v2/replay/counterfactual", input, options);
  }

  async getMobileSessionV2(
    taskId: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"GetMobileSessionV2">> {
    return this.requestV2(
      "GetMobileSessionV2",
      `/v2/mobile/sessions/${encodeURIComponent(taskId)}`,
      undefined,
      { signal },
    );
  }

  async executeMobileActionV2(
    input: {
      taskId: string;
      action: "pause" | "resume" | "approve_effect" | "terminate" | "request_review";
      effectId?: string;
      rationale?: string;
    },
    options: MutationRequestOptions,
  ): Promise<V2Response<"ExecuteMobileActionV2">> {
    return this.requestV2(
      "ExecuteMobileActionV2",
      `/v2/mobile/sessions/${encodeURIComponent(input.taskId)}/action`,
      input,
      options,
    );
  }

  async syncAcpContextV2(
    input: {
      workspaceRootUri: string;
      activeFileUri: string | null;
      selectedRange: { startLine: number; startCol: number; endLine: number; endCol: number } | null;
      diagnostics: Array<{ fileUri: string; line: number; severity: string; message: string }>;
      openEditorUris: string[];
    },
    options: MutationRequestOptions,
  ): Promise<V2Response<"SyncAcpContextV2">> {
    return this.requestV2("SyncAcpContextV2", "/v2/ide/context-sync", input, options);
  }

  // ────────────────────────── Phase 10: Computer Use & Agency ───────────────────

  async createUiObservationV2(
    input: V2Request<"CreateUiObservationV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"CreateUiObservationV2">> {
    return this.requestV2("CreateUiObservationV2", "/v2/computer/observe", input, options);
  }

  async getUiObservationV2(
    id: string,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"GetUiObservationV2">> {
    return this.requestV2(
      "GetUiObservationV2",
      `/v2/computer/observations/${encodeURIComponent(id)}`,
      { id },
      { signal },
    );
  }

  async verifyUiTargetV2(
    input: V2Request<"VerifyUiTargetV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"VerifyUiTargetV2">> {
    return this.requestV2("VerifyUiTargetV2", "/v2/computer/verify-target", input, options);
  }

  async dispatchComputerActionV2(
    input: V2Request<"DispatchComputerActionV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"DispatchComputerActionV2">> {
    return this.requestV2("DispatchComputerActionV2", "/v2/computer/action", input, options);
  }

  async recordUiEvidenceV2(
    input: V2Request<"RecordUiEvidenceV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"RecordUiEvidenceV2">> {
    return this.requestV2("RecordUiEvidenceV2", "/v2/computer/evidence", input, options);
  }

  async listComputerPoolsV2(
    signal?: AbortSignal | null,
  ): Promise<V2Response<"ListComputerPoolsV2">> {
    return this.requestV2("ListComputerPoolsV2", "/v2/computer/pools", {}, { signal });
  }

  async acquirePoolLeaseV2(
    poolId: string,
    input: { taskId: string; workerId: string; ttlMs?: number },
    options: MutationRequestOptions,
  ): Promise<V2Response<"AcquirePoolLeaseV2">> {
    return this.requestV2(
      "AcquirePoolLeaseV2",
      `/v2/computer/pools/${encodeURIComponent(poolId)}/lease`,
      { poolId, ...input },
      options,
    );
  }

  async releasePoolLeaseV2(
    poolId: string,
    leaseId: string,
    options: MutationRequestOptions,
  ): Promise<V2Response<"ReleasePoolLeaseV2">> {
    return this.requestV2(
      "ReleasePoolLeaseV2",
      `/v2/computer/pools/${encodeURIComponent(poolId)}/leases/${encodeURIComponent(leaseId)}/release`,
      { poolId, leaseId },
      options,
    );
  }

  async initiateHumanTakeoverV2(
    input: V2Request<"InitiateHumanTakeoverV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"InitiateHumanTakeoverV2">> {
    return this.requestV2("InitiateHumanTakeoverV2", "/v2/computer/takeover", input, options);
  }

  async resumeFromTakeoverV2(
    takeoverId: string,
    input: { newObservationId: string },
    options: MutationRequestOptions,
  ): Promise<V2Response<"ResumeFromTakeoverV2">> {
    return this.requestV2(
      "ResumeFromTakeoverV2",
      `/v2/computer/takeover/${encodeURIComponent(takeoverId)}/resume`,
      { takeoverId, ...input },
      options,
    );
  }

  async evaluateDataFlowV2(
    input: V2Request<"EvaluateDataFlowV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"EvaluateDataFlowV2">> {
    return this.requestV2("EvaluateDataFlowV2", "/v2/data-flow/evaluate", input, options);
  }

  async quarantineDownloadV2(
    input: V2Request<"QuarantineDownloadV2">,
    options: MutationRequestOptions,
  ): Promise<V2Response<"QuarantineDownloadV2">> {
    return this.requestV2("QuarantineDownloadV2", "/v2/data-flow/quarantine", input, options);
  }

  async reconcileSubmitV2(
    input: V2Request<"ReconcileSubmitV2">,
    signal?: AbortSignal | null,
  ): Promise<V2Response<"ReconcileSubmitV2">> {
    return this.requestV2("ReconcileSubmitV2", "/v2/computer/reconcile-submit", input, {
      idempotencyKey: input.semanticIdempotencyKey,
      signal,
    });
  }

  async listConnectorsV2(signal?: AbortSignal | null): Promise<V2Response<"ListConnectorsV2">> {
    return this.requestV2("ListConnectorsV2", "/v2/connectors", {}, { signal });
  }

  async executeConnectorCallV2(
    connectorId: string,
    input: {
      intentId: string;
      taskId: string;
      operation: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      parameters: Record<string, unknown>;
      idempotencyKey: string;
      authorizationId: string;
      effectClass:
        | "read_only"
        | "bufferable_local"
        | "reversible_external"
        | "compensable_external"
        | "irreversible"
        | "unknown_semantics";
    },
    signal?: AbortSignal | null,
  ): Promise<V2Response<"ExecuteConnectorCallV2">> {
    return this.requestV2(
      "ExecuteConnectorCallV2",
      `/v2/connectors/${encodeURIComponent(connectorId)}/call`,
      { connectorId, ...input },
      { idempotencyKey: input.idempotencyKey, signal },
    );
  }

  async startIncidentTaskV2(
    input: { profileId: string; taskId: string; initialDiagnostics: string[] },
    options: MutationRequestOptions,
  ): Promise<V2Response<"StartIncidentTaskV2">> {
    return this.requestV2("StartIncidentTaskV2", "/v2/profiles/incident/start", input, options);
  }

  async startResearchTaskV2(
    input: { profileId: string; taskId: string },
    options: MutationRequestOptions,
  ): Promise<V2Response<"StartResearchTaskV2">> {
    return this.requestV2("StartResearchTaskV2", "/v2/profiles/research/start", input, options);
  }
}

export class TerminusApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "TerminusApiError";
  }
}

/** @deprecated Use `TerminusClientConfig`. Removed after the identity migration window. */
export type ForgeClientConfig = TerminusClientConfig;
/** @deprecated Use `TerminusClient`. Removed after the identity migration window. */
export { TerminusClient as ForgeClient };
/** @deprecated Use `TerminusApiError`. Removed after the identity migration window. */
export { TerminusApiError as ForgeApiError };

export * from "./projection.js";
export { fixtureEvent, PUBLIC_CLIENT_EVENT_FIXTURES } from "./projection-fixtures.js";
