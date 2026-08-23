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
import { createSseDecoder, IDEMPOTENCY_HEADER, requireIdempotency } from "@terminus/public-api";

export interface ForgeClientConfig {
  /** Base URL of the Terminus control plane. Use "" for same-origin. */
  baseUrl: string;
  /** Optional XTransformPort query parameter for gateway routing. */
  xformPort?: number;
  /** Authentication token (Terminus local token). */
  token?: string;
  /** Fetch implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export class ForgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(config: ForgeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
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
    if (requireIdempotency(method) && opts.idempotencyKey) {
      headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;
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
      throw new ForgeApiError(res.status, message, body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ────────────────────────── /system ───────────────────────────────────

  async health(signal?: AbortSignal | null): Promise<{
    status: "ok" | "degraded" | "down";
    version: string;
    build_commit: string;
    instance_id: string;
    uptime_seconds: number;
    ready: boolean;
  }> {
    return this.request("GET", "/v1/system/health", { signal });
  }

  async initialize(hello: ClientHello, signal?: AbortSignal | null): Promise<ServerHello> {
    return this.request("POST", "/v1/system/initialize", { body: hello, signal });
  }

  // ────────────────────────── /workspaces ──────────────────────────────

  async openWorkspace(
    input: { root_uri: string; kind?: string; trust?: string; policy_profile_id?: string },
    idempotencyKey?: string,
    signal?: AbortSignal | null,
  ): Promise<WorkspaceSnapshot> {
    return this.request("POST", "/v1/workspaces/open", { body: input, idempotencyKey, signal });
  }

  async getWorkspace(id: string, signal?: AbortSignal | null): Promise<WorkspaceSnapshot> {
    return this.request("GET", `/v1/workspaces/${encodeURIComponent(id)}`, { signal });
  }

  // ────────────────────────── /sessions ────────────────────────────────

  async createSession(
    input: { workspace_id: string; title: string; default_model_profile?: string; default_permission_profile?: string },
    idempotencyKey?: string,
    signal?: AbortSignal | null,
  ): Promise<SessionSnapshot> {
    return this.request("POST", "/v1/sessions", { body: input, idempotencyKey, signal });
  }

  async getSession(id: string, signal?: AbortSignal | null): Promise<SessionSnapshot> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}`, { signal });
  }

  async pauseSession(id: string, signal?: AbortSignal | null): Promise<SessionSnapshot> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(id)}/pause`, { signal });
  }

  // ────────────────────────── /threads ─────────────────────────────────

  async createThread(
    input: { session_id: string; parent_thread_id?: string | null },
    idempotencyKey?: string,
    signal?: AbortSignal | null,
  ): Promise<{ id: string; session_id: string; created_at: string }> {
    return this.request("POST", "/v1/threads", { body: input, idempotencyKey, signal });
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
    idempotencyKey?: string,
    signal?: AbortSignal | null,
  ): Promise<TaskSnapshot> {
    return this.request("POST", "/v1/tasks", { body: input, idempotencyKey, signal });
  }

  async startTask(
    id: string,
    idempotencyKey?: string,
    signal?: AbortSignal | null,
  ): Promise<{
    task_id: string;
    status: string;
    event_cursor: string;
    links: { events: string; task: string };
  }> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(id)}/start`, { idempotencyKey, signal });
  }

  async cancelTask(id: string, reason?: string | null, signal?: AbortSignal | null): Promise<TaskSnapshot> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(id)}/cancel`, { body: { reason }, signal });
  }

  // ────────────────────────── /turns ───────────────────────────────────

  async startTurn(
    input: { thread_id: string; task_id: string; user_input: string },
    idempotencyKey?: string,
    signal?: AbortSignal | null,
  ): Promise<TurnSnapshot> {
    return this.request("POST", "/v1/turns", { body: input, idempotencyKey, signal });
  }

  async interruptTurn(id: string, signal?: AbortSignal | null): Promise<TurnSnapshot> {
    return this.request("POST", `/v1/turns/${encodeURIComponent(id)}/interrupt`, { signal });
  }

  // ────────────────────────── /context ─────────────────────────────────

  async getContextManifest(id: string, signal?: AbortSignal | null): Promise<ContextManifestSnapshot> {
    return this.request("GET", `/v1/context/manifests/${encodeURIComponent(id)}`, { signal });
  }

  // ────────────────────────── /artifacts ───────────────────────────────

  async getArtifact(hash: string, signal?: AbortSignal | null): Promise<Uint8Array> {
    const init: RequestInit = { headers: this.headers };
    if (signal) init.signal = signal;
    const res = await this.fetchImpl(this.url(`/v1/artifacts/${encodeURIComponent(hash)}`), init);
    if (!res.ok) throw new ForgeApiError(res.status, `HTTP ${res.status}`, null);
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
    rationale?: string | null,
    signal?: AbortSignal | null,
  ): Promise<ApprovalSnapshot> {
    return this.request("POST", `/v1/approvals/${encodeURIComponent(id)}/resolve`, {
      body: { decision, rationale },
      signal,
    });
  }

  // ────────────────────────── /jobs ────────────────────────────────────

  async getJob(
    id: string,
    signal?: AbortSignal | null,
  ): Promise<{ id: string; state: string; started_at: string | null; settled_at: string | null; output_cursor: number }> {
    return this.request("GET", `/v1/jobs/${encodeURIComponent(id)}`, { signal });
  }

  async stopJob(id: string, reason?: string | null, signal?: AbortSignal | null): Promise<{ id: string; state: string }> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(id)}/stop`, { body: { reason }, signal });
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
    const init: RequestInit = { headers: { ...this.headers, accept: "text/event-stream" } };
    if (opts.signal) init.signal = opts.signal;
    const res = await this.fetchImpl(url, init);
    if (!res.ok || !res.body) {
      throw new ForgeApiError(res.status, `SSE failed: HTTP ${res.status}`, null);
    }
    const reader = res.body.getReader();
    const decoder = createSseDecoder();
    const decoder_ = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder_.decode(value, { stream: true });
        for (const ev of decoder.feed(text)) {
          yield ev;
        }
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
    idempotencyKey?: string,
    signal?: AbortSignal | null,
  ): Promise<{ workflow: unknown; report: Record<string, unknown> }> {
    return this.request("POST", "/v2/workflows/compile", { body: input, idempotencyKey, signal });
  }

  async validateWorkflow(
    input: {
      nodes: unknown[];
      edges: unknown[];
      authorityCeiling?: string[];
      mandatorySteps?: string[];
      strictMode?: boolean;
    },
    idempotencyKey?: string,
    signal?: AbortSignal | null,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v2/workflows/validate", { body: input, idempotencyKey, signal });
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
    opts: { providerId?: string; confidentiality?: string } = {},
    signal?: AbortSignal | null,
  ): Promise<{ profiles: unknown[] }> {
    return this.request("GET", "/v2/models/profiles", {
      query: { providerId: opts.providerId ?? null, confidentiality: opts.confidentiality ?? null },
      signal,
    });
  }

  async getModelProfileV2(id: string, signal?: AbortSignal | null): Promise<unknown> {
    return this.request("GET", `/v2/models/profiles/${encodeURIComponent(id)}`, { signal });
  }

  async routeModelStageV2(
    input: {
      stage: "classifier" | "implementer" | "reviewer" | "specialist" | "vision" | "local_safe";
      confidentiality?: "public" | "workspace" | "secret_adjacent" | "secret";
      allowedProviders?: string[];
      implementerProviderId?: string | null;
      requireOffline?: boolean;
    },
    signal?: AbortSignal | null,
  ): Promise<unknown> {
    return this.request("POST", "/v2/models/route", { body: input, signal });
  }

  async updateModelPosteriorV2(
    input: {
      modelKey: string;
      toolCallsSucceeded: number;
      toolCallsFailed: number;
      structuredOutputSucceeded: boolean;
      editCohortSucceeded: boolean;
      latencyMs: number;
      costMicros: bigint;
      cacheHitRate: number;
    },
    signal?: AbortSignal | null,
  ): Promise<unknown> {
    return this.request("POST", "/v2/models/posterior/update", { body: input, signal });
  }

  async getModelPosteriorV2(modelKey: string, signal?: AbortSignal | null): Promise<unknown> {
    return this.request("GET", `/v2/models/posterior/${encodeURIComponent(modelKey)}`, { signal });
  }

  async scheduleEVWorkerV2(
    input: {
      parentTaskId: string;
      candidateObjective: string;
      separability: number;
      likelyFileOverlap: number;
      isWriteWork: boolean;
      currentUncertainty: number;
      contextPressure: number;
      riskClass: "low" | "medium" | "high" | "critical";
      budgetRemainingRatio: number;
      activeWorkerCount: number;
    },
    signal?: AbortSignal | null,
  ): Promise<unknown> {
    return this.request("POST", "/v2/orchestration/ev-schedule", { body: input, signal });
  }

  async checkStagnationV2(
    input: { taskId: string; observations?: unknown[] },
    signal?: AbortSignal | null,
  ): Promise<unknown> {
    return this.request("POST", "/v2/orchestration/stagnation/check", { body: input, signal });
  }

  async evaluateCleanReviewV2(
    input: {
      taskId: string;
      reviewerProviderId: string;
      implementerProviderId: string;
      findings?: unknown[];
    },
    signal?: AbortSignal | null,
  ): Promise<unknown> {
    return this.request("POST", "/v2/orchestration/review/clean", { body: input, signal });
  }
}


export class ForgeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ForgeApiError";
  }
}
