/**
 * Forge Desktop — Forge control-plane API client.
 *
 * Per the task contract: a small fetch-based wrapper that talks to the
 * Forge control plane at http://127.0.0.1:3050 with bearer token
 * `forge-control-dev-token`. The methods are:
 *
 *   health()
 *   listSessions()
 *   createSession(input)
 *   listTasks(sessionId)
 *   createTask(input)
 *   startTask(taskId)
 *   startTurn(input)
 *   getTask(taskId)
 *   subscribeEvents(opts) — returns a ForgeEventStream (EventSource-like)
 *
 * Per SPEC §30.4: every non-2xx response carries a structured error
 * envelope `{ error: { code, message, retryable, category, … } }`. We
 * surface that as `ForgeApiError`.
 *
 * Per SPEC §30.6: SSE reconnects with `Last-Event-ID` / cursor. The
 * browser's native EventSource cannot send `Authorization` headers, so
 * we use fetch + ReadableStream + the SSE decoder from @forge/public-api
 * and expose an EventSource-like surface (onopen/onmessage/onerror +
 * addEventListener/removeEventListener + close).
 *
 * Per the TypeScript constraints: strict mode, no `any`, all responses
 * typed, `unknown` at boundaries. JSON responses are typed via `as T`
 * after status check — full zod decoding can be layered later without
 * changing call sites.
 */
import { createSseDecoder } from "@forge/public-api";
import type {
  Approval,
  ApprovalDecision,
  CreateSessionInput,
  CreateTaskInput,
  ForgeSseEvent,
  HealthResponse,
  Session,
  SessionListResponse,
  StartTaskResponse,
  StartTurnInput,
  SubscribeEventsOptions,
  Task,
  TaskListResponse,
  Turn,
} from "../types";

// ────────────────────────── Configuration ──────────────────────────────────

/**
 * Resolve API base + token. In Electron, the preload exposes these via
 * `window.forgeDesktop`. In a plain browser (Vite dev), we fall back to
 * env vars injected by Vite or to documented defaults.
 */
function resolveApiBase(): string {
  if (typeof window !== "undefined" && window.forgeDesktop?.apiBase) {
    return window.forgeDesktop.apiBase;
  }
  const env = (import.meta.env.VITE_FORGE_API_BASE as string | undefined) ?? null;
  return env ?? "http://127.0.0.1:3050";
}

function resolveApiToken(): string {
  if (typeof window !== "undefined" && window.forgeDesktop?.token) {
    return window.forgeDesktop.token;
  }
  const env = (import.meta.env.VITE_FORGE_TOKEN as string | undefined) ?? null;
  return env ?? "forge-control-dev-token";
}

// ────────────────────────── Errors ─────────────────────────────────────────

export interface ForgeErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
  category: string;
  details?: Record<string, unknown>;
  suggested_action?: string | null;
  trace_id?: string | null;
}

export class ForgeApiError extends Error {
  readonly status: number;
  readonly envelope: ForgeErrorEnvelope | null;

  constructor(status: number, message: string, envelope: ForgeErrorEnvelope | null) {
    super(message);
    this.name = "ForgeApiError";
    this.status = status;
    this.envelope = envelope;
  }
}

// ────────────────────────── Client ─────────────────────────────────────────

export class ForgeApiClient {
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
      authorization: `Bearer ${this.token}`,
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
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; query?: Record<string, string | null | undefined>; signal?: AbortSignal | null } = {},
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: this.headers(),
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;

    let res: Response;
    try {
      res = await fetch(this.url(path, opts.query), init);
    } catch (err) {
      // Network error (control plane offline, CORS, etc.).
      const msg = err instanceof Error ? err.message : String(err);
      throw new ForgeApiError(0, `network error: ${msg}`, null);
    }

    if (res.status === 204) return undefined as T;

    if (!res.ok) {
      let envelope: ForgeErrorEnvelope | null = null;
      try {
        const body = (await res.json()) as unknown;
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
      } catch {
        // ignore JSON parse failure
      }
      const msg = envelope?.message ?? `HTTP ${res.status}`;
      throw new ForgeApiError(res.status, msg, envelope);
    }

    // Empty body — let caller decide.
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Non-JSON response.
      return text as unknown as T;
    }
  }

  // ────────────────────────── /system ───────────────────────────────────

  health(signal?: AbortSignal | null): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/v1/system/health", { signal });
  }

  // ────────────────────────── /sessions ─────────────────────────────────

  listSessions(signal?: AbortSignal | null): Promise<SessionListResponse> {
    return this.request<SessionListResponse>("GET", "/v1/sessions", { signal });
  }

  createSession(input: CreateSessionInput, signal?: AbortSignal | null): Promise<Session> {
    return this.request<Session>("POST", "/v1/sessions", { body: input, signal });
  }

  // ────────────────────────── /tasks ────────────────────────────────────

  listTasks(sessionId: string, signal?: AbortSignal | null): Promise<TaskListResponse> {
    return this.request<TaskListResponse>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`, { signal });
  }

  createTask(input: CreateTaskInput, signal?: AbortSignal | null): Promise<Task> {
    return this.request<Task>("POST", "/v1/tasks", { body: input, signal });
  }

  startTask(taskId: string, signal?: AbortSignal | null): Promise<StartTaskResponse> {
    return this.request<StartTaskResponse>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/start`, { signal });
  }

  getTask(taskId: string, signal?: AbortSignal | null): Promise<Task> {
    return this.request<Task>("GET", `/v1/tasks/${encodeURIComponent(taskId)}`, { signal });
  }

  cancelTask(taskId: string, reason?: string | null, signal?: AbortSignal | null): Promise<Task> {
    return this.request<Task>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      body: { reason: reason ?? null },
      signal,
    });
  }

  // ────────────────────────── /turns ────────────────────────────────────

  startTurn(input: StartTurnInput, signal?: AbortSignal | null): Promise<Turn> {
    return this.request<Turn>("POST", "/v1/turns", { body: input, signal });
  }

  interruptTurn(turnId: string, reason?: string | null, signal?: AbortSignal | null): Promise<Turn> {
    return this.request<Turn>("POST", `/v1/turns/${encodeURIComponent(turnId)}/interrupt`, {
      body: { reason: reason ?? null },
      signal,
    });
  }

  // ────────────────────────── /approvals ────────────────────────────────

  resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    rationale?: string | null,
    signal?: AbortSignal | null,
  ): Promise<Approval> {
    return this.request<Approval>("POST", `/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      body: { decision, rationale: rationale ?? null },
      signal,
    });
  }
}

// ────────────────────────── SSE stream ─────────────────────────────────────
//
// The browser's native EventSource cannot set custom headers (so no
// `Authorization: Bearer …`). The control plane requires bearer auth on
// `/v1/events`, so we use fetch + a streaming reader + the SSE decoder
// from @forge/public-api, and surface an EventSource-like object.

export type ForgeEventStreamHandler = (event: ForgeSseEvent) => void;

export interface ForgeEventStream {
  readonly readyState: 0 | 1 | 2 | 3;
  /** Register a listener. Returns an unsubscribe function. */
  addEventListener(type: "message" | "open" | "error", handler: ForgeEventStreamHandler | (() => void)): () => void;
  /** Close the stream. Safe to call multiple times. */
  close(): void;
  /** Last received event id (durable cursor). */
  lastEventId: string | null;
}

class FetchEventStream implements ForgeEventStream {
  readyState: 0 | 1 | 2 | 3 = 0;
  lastEventId: string | null = null;
  private readonly listeners = new Map<string, Set<ForgeEventStreamHandler | (() => void)>>();
  private readonly abort: AbortController;
  private readonly cursor: string | null;
  private readonly taskId: string | null;
  private readonly sessionId: string | null;
  private readonly client: ForgeApiClient;
  private closed = false;

  constructor(client: ForgeApiClient, opts: SubscribeEventsOptions) {
    this.client = client;
    this.cursor = opts.cursor ?? null;
    this.taskId = opts.task_id ?? null;
    this.sessionId = opts.session_id ?? null;
    this.abort = new AbortController();
    if (opts.signal) {
      // Propagate external abort.
      opts.signal.addEventListener("abort", () => this.abort.abort());
    }
    void this.run();
  }

  addEventListener(
    type: "message" | "open" | "error",
    handler: ForgeEventStreamHandler | (() => void),
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

  private emit(type: "message", ev: ForgeSseEvent): void;
  private emit(type: "open" | "error"): void;
  private emit(type: "message" | "open" | "error", ev?: ForgeSseEvent): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const h of set) {
      try {
        if (type === "message") (h as ForgeEventStreamHandler)(ev as ForgeSseEvent);
        else (h as () => void)();
      } catch {
        // Listener errors must not break the stream.
      }
    }
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
      this.readyState = 3;
      this.emit("error");
      return;
    }

    if (!res.ok || !res.body) {
      this.readyState = 3;
      this.emit("error");
      return;
    }

    this.readyState = 1;
    this.emit("open");

    const reader = res.body.getReader();
    const decoder = createSseDecoder();
    const textDecoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = textDecoder.decode(value, { stream: true });
        const events = decoder.feed(text);
        for (const ev of events) {
          // Heartbeat comments produce empty events — skip them.
          if (!ev.event && (!ev.data || ev.data.startsWith(":heartbeat"))) continue;
          if (ev.id) this.lastEventId = ev.id;
          // Normalize event name: SSE may use the default "message" event.
          const named: ForgeSseEvent = {
            id: ev.id,
            event: ev.event || "message",
            data: ev.data,
          };
          this.emit("message", named);
        }
      }
    } catch {
      // Network interruption / abort. If aborted by user, readyState is
      // already 2 (closed). Otherwise it's an unexpected drop.
      if (!this.closed) {
        this.readyState = 3;
        this.emit("error");
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      if (!this.closed) {
        this.readyState = 3;
      }
    }
  }
}

// ────────────────────────── Public singleton ───────────────────────────────

export const api = new ForgeApiClient();

/**
 * Subscribe to the SSE event stream. Returns an EventSource-like
 * `ForgeEventStream` whose `addEventListener("message", …)` callback
 * receives decoded `{ id, event, data }` payloads. Reconnect is the
 * caller's responsibility — pass `cursor: stream.lastEventId` on retry.
 *
 * Per the task contract: "subscribeEvents(taskId?) (returns EventSource)".
 * We return a small wrapper that matches the EventSource surface used
 * by Forge Desktop, because the native EventSource cannot send the
 * `Authorization: Bearer` header the control plane requires.
 */
export function subscribeEvents(opts: SubscribeEventsOptions = {}): ForgeEventStream {
  return new FetchEventStream(api, opts);
}

/** Variant accepting the legacy single-argument form: `subscribeEvents(taskId?)`. */
export function subscribeTaskEvents(taskId: string | null): ForgeEventStream {
  return subscribeEvents({ task_id: taskId });
}
