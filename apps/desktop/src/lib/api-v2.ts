/**
 * Terminus Desktop — ARP v2 canonical client adapter (SPEC §32).
 *
 * Speaks ONLY the canonical `/v2/*` surface against the control plane:
 * tasks (proof-carrying contracts + optimistic concurrency), transactional
 * effects (propose → … → commit with server-enforced state machine),
 * claims/evidence, and resumable SSE envelopes from `/v2/events`.
 *
 * This is the same protocol surface the CLI's `*-v2` commands use, so a
 * task created by either client is visible to both (Phase 1 exit gate:
 * "CLI and one graphical client use ARP v2 for the same task").
 *
 * Reuses the v1 client's base-URL/token resolution and error envelope so
 * both surfaces behave identically offline/misconfigured.
 */
import { createSseDecoder } from "@terminus/public-api";
import { api, TerminusApiError } from "./api";
import type {
  ArpV2EventEnvelope,
  ClaimSnapshot,
  EffectSnapshot,
  EffectState,
  TaskContractV2,
  TaskV2Snapshot,
  TaskV2Status,
} from "../types/v2";

// ────────────────────────── Boundary decoding ──────────────────────────────

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TerminusApiError(0, `${what} response was not an object`, null);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Decode an unknown payload into a TaskV2Snapshot, rejecting malformed data. */
export function decodeTaskV2(value: unknown): TaskV2Snapshot {
  const o = asObject(value, "v2 task");
  const contract = asObject(o.contract, "v2 task contract");
  const constraints = asObject(contract.constraints, "v2 task constraints");
  const scope = asObject(contract.scope, "v2 task scope");
  return {
    id: str(o.id),
    missionId: o.missionId === null ? null : str(o.missionId),
    organizationId: str(o.organizationId),
    departmentId: str(o.departmentId),
    createdBy: str(o.createdBy),
    status: str(o.status) as TaskV2Status,
    version: typeof o.version === "number" ? o.version : 0,
    createdAt: str(o.createdAt),
    updatedAt: str(o.updatedAt),
    completedAt: o.completedAt === null || o.completedAt === undefined ? null : str(o.completedAt),
    contract: {
      version: typeof contract.version === "number" ? contract.version : 1,
      mission: str(contract.mission),
      scope: {
        resources: Array.isArray(scope.resources) ? scope.resources : [],
        allowedEffectClasses: Array.isArray(scope.allowedEffectClasses) ? scope.allowedEffectClasses.map(String) : [],
        excludedPathsOrSystems: Array.isArray(scope.excludedPathsOrSystems) ? scope.excludedPathsOrSystems.map(String) : [],
      },
      acceptance: Array.isArray(contract.acceptance)
        ? contract.acceptance.map((raw) => {
            const c = asObject(raw, "acceptance criterion");
            return {
              claimId: str(c.claimId),
              statement: str(c.statement),
              evidenceRequirement: str(c.evidenceRequirement),
            };
          })
        : [],
      constraints: {
        security: Array.isArray(constraints.security) ? constraints.security.map(String) : [],
        costMicros: str(constraints.costMicros) || "0",
        timeoutSeconds: typeof constraints.timeoutSeconds === "number" ? constraints.timeoutSeconds : 0,
      },
      authorityCeiling: Array.isArray(contract.authorityCeiling) ? contract.authorityCeiling.map(String) : [],
      mode: str(contract.mode) || "interactive",
    },
  };
}

function decodeEffect(value: unknown): EffectSnapshot {
  const o = asObject(value, "v2 effect");
  return {
    id: str(o.id),
    taskId: str(o.taskId),
    attemptId: str(o.attemptId),
    principal: str(o.principal),
    connectorOrWorker: str(o.connectorOrWorker),
    intentType: str(o.intentType),
    canonicalParameters: o.canonicalParameters && typeof o.canonicalParameters === "object"
      ? (o.canonicalParameters as Record<string, unknown>)
      : {},
    resourceHandles: Array.isArray(o.resourceHandles) ? o.resourceHandles : [],
    effectClass: str(o.effectClass),
    semanticIdempotencyKey: str(o.semanticIdempotencyKey),
    authorizationId: o.authorizationId === null || o.authorizationId === undefined ? null : str(o.authorizationId),
    policyDecisionId: o.policyDecisionId === null || o.policyDecisionId === undefined ? null : str(o.policyDecisionId),
    state: str(o.state) as EffectState,
    uncertaintyReason: o.uncertaintyReason === null || o.uncertaintyReason === undefined ? null : str(o.uncertaintyReason),
    compensationRef: o.compensationRef === null || o.compensationRef === undefined ? null : str(o.compensationRef),
    version: typeof o.version === "number" ? o.version : 0,
    createdAt: str(o.createdAt),
    settledAt: o.settledAt === null || o.settledAt === undefined ? null : str(o.settledAt),
  };
}

function decodeClaim(value: unknown): ClaimSnapshot {
  const o = asObject(value, "v2 claim");
  return {
    id: str(o.id),
    taskId: str(o.taskId),
    statement: str(o.statement),
    requiredEvidenceKind: str(o.requiredEvidenceKind),
    status: str(o.status) as ClaimSnapshot["status"],
    evidenceIds: Array.isArray(o.evidenceIds) ? o.evidenceIds.map(String) : [],
    waivedRationale: o.waivedRationale === null || o.waivedRationale === undefined ? null : str(o.waivedRationale),
    createdAt: str(o.createdAt),
    updatedAt: str(o.updatedAt),
  };
}

// ────────────────────────── Client ─────────────────────────────────────────

/** Endpoint binding override. Defaults resolve like the v1 client (Electron bridge → Vite env → documented loopback). */
export interface ArpV2ClientConfig {
  baseUrl?: string;
  token?: string;
}

function buildUrl(base: string, path: string, query?: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v != null) q.set(k, v);
  }
  const qs = q.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

function buildHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export class TerminusArpV2Client {
  private readonly resolveUrl: (path: string, query?: Record<string, string | null | undefined>) => string;
  private readonly buildAuthHeaders: (extra?: Record<string, string>) => Record<string, string>;

  /**
   * @param config omit to share the v1 client's base URL/token resolution;
   *   provide `baseUrl`/`token` to bind this adapter to a specific control
   *   plane (used by the live ARP v2 E2E to exercise the exact graphical
   * -client code path against the harness daemon).
   */
  constructor(config: ArpV2ClientConfig = {}) {
    if (config.baseUrl !== undefined || config.token !== undefined) {
      const base = (config.baseUrl ?? "").replace(/\/+$/, "");
      const token = config.token ?? "";
      this.resolveUrl = (path, query) => buildUrl(base, path, query);
      this.buildAuthHeaders = (extra) => buildHeaders(token, extra);
    } else {
      this.resolveUrl = (path, query) => api.url(path, query);
      this.buildAuthHeaders = (extra) => api.buildHeaders(extra);
    }
  }

  /**
   * Fetch a JSON endpoint on the /v2 surface. `notFoundOk` returns null on
   * 404 instead of throwing (used when probing whether a task exists).
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; signal?: AbortSignal | null; notFoundOk?: boolean } = {},
  ): Promise<T | null> {
    try {
      const res = await fetch(this.resolveUrl(path), {
        method,
        headers: this.buildAuthHeaders(),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal ?? undefined,
      });
      if (res.status === 404 && opts.notFoundOk) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new TerminusApiError(res.status, text.slice(0, 500) || `HTTP ${res.status}`, null);
      }
      const text = await res.text();
      if (text.length === 0) return undefined as T;
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof TerminusApiError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new TerminusApiError(0, `network error: ${msg}`, null);
    }
  }

  health(signal?: AbortSignal | null): Promise<{ status: string; protocolVersion: number; ready: boolean }> {
    return this.request("GET", "/v2/system/health", { signal }) as Promise<{ status: string; protocolVersion: number; ready: boolean }>;
  }

  schemaRegistry(signal?: AbortSignal | null): Promise<{ protocolVersion: number; supportedEventTypes: string[]; schemas: Record<string, unknown> }> {
    return this.request("GET", "/v2/system/schema-registry", { signal }) as Promise<{ protocolVersion: number; supportedEventTypes: string[]; schemas: Record<string, unknown> }>;
  }

  /** Returns null when the id has no canonical v2 counterpart. */
  async getTask(taskId: string, signal?: AbortSignal | null): Promise<TaskV2Snapshot | null> {
    const raw = await this.request("GET", `/v2/tasks/${encodeURIComponent(taskId)}`, { signal, notFoundOk: true });
    return raw ? decodeTaskV2(raw) : null;
  }

  listTasks(signal?: AbortSignal | null): Promise<TaskV2Snapshot[]> {
    return (async () => {
      const raw = await this.request("GET", "/v2/tasks", { signal });
      const arr = asObject(raw, "v2 task list").tasks;
      return Array.isArray(arr) ? arr.map(decodeTaskV2) : [];
    })();
  }

  createTask(input: { objective: string; mode?: string }, signal?: AbortSignal | null): Promise<TaskV2Snapshot> {
    // Canonical proof-carrying contract mirroring CompatibilityGateway.
    const contract: TaskContractV2 = {
      version: 1,
      mission: input.objective,
      scope: { resources: [], allowedEffectClasses: ["LOCAL_FS_WRITE", "LOCAL_PROCESS_SPAWN"], excludedPathsOrSystems: [] },
      acceptance: [{ claimId: "claim-1", statement: input.objective, evidenceRequirement: "DETERMINISTIC_TEST" }],
      constraints: { security: ["NO_AMBIENT_SECRETS"], costMicros: "10000000", timeoutSeconds: 3600 },
      authorityCeiling: ["FS_WRITE", "PROCESS_SPAWN"],
      mode: input.mode ?? "interactive",
    };
    return (async () => {
      const raw = await this.request("POST", "/v2/tasks", {
        body: { missionId: null, organizationId: "default-org", departmentId: "default-dept", contract },
        signal,
      });
      return decodeTaskV2(raw);
    })();
  }

  async transitionTask(
    taskId: string,
    targetStatus: TaskV2Status,
    expectedVersion?: number | null,
    signal?: AbortSignal | null,
  ): Promise<TaskV2Snapshot> {
    const raw = await this.request("POST", `/v2/tasks/${encodeURIComponent(taskId)}/transition`, {
      body: { targetStatus, expectedVersion: expectedVersion ?? null },
      signal,
    });
    return decodeTaskV2(raw);
  }

  async listEffects(taskId: string, signal?: AbortSignal | null): Promise<EffectSnapshot[]> {
    const raw = await this.request("GET", `/v2/effects?taskId=${encodeURIComponent(taskId)}`, { signal, notFoundOk: true });
    if (!raw) return [];
    const arr = asObject(raw, "v2 effect list").effects;
    return Array.isArray(arr) ? arr.map(decodeEffect) : [];
  }

  proposeEffect(input: {
    taskId: string;
    intentType: string;
    effectClass: string;
    canonicalParameters?: Record<string, unknown>;
  }, signal?: AbortSignal | null): Promise<EffectSnapshot> {
    return (async () => {
      const raw = await this.request("POST", "/v2/effects", {
        body: {
          taskId: input.taskId,
          attemptId: `desktop-${Date.now()}`,
          connectorOrWorker: "terminus-desktop",
          intentType: input.intentType,
          canonicalParameters: input.canonicalParameters ?? {},
          resourceHandles: [],
          effectClass: input.effectClass,
          semanticIdempotencyKey: `desktop-${input.taskId}-${input.intentType}-${Date.now()}`,
        },
        signal,
      });
      return decodeEffect(raw);
    })();
  }

  /** Advance an effect one step along the canonical state machine. */
  async advanceEffect(effectId: string, targetState: EffectState, expectedVersion?: number | null, signal?: AbortSignal | null): Promise<EffectSnapshot> {
    const raw = await this.request("POST", `/v2/effects/${encodeURIComponent(effectId)}/transition`, {
      body: { targetState, expectedVersion: expectedVersion ?? null },
      signal,
    });
    return decodeEffect(raw);
  }

  /** Human confirmation gate: authorize an authorization-gated effect. */
  async confirmEffect(effectId: string, authorizationId: string, signal?: AbortSignal | null): Promise<EffectSnapshot> {
    const raw = await this.request("POST", `/v2/effects/${encodeURIComponent(effectId)}/authorize`, {
      body: { authorizationId },
      signal,
    });
    return decodeEffect(raw);
  }

  /** Commit a VALIDATED effect (the terminal settlement). */
  async commitEffect(effectId: string, expectedVersion?: number | null, signal?: AbortSignal | null): Promise<EffectSnapshot> {
    const raw = await this.request("POST", `/v2/effects/${encodeURIComponent(effectId)}/commit`, {
      body: { expectedVersion: expectedVersion ?? null },
      signal,
    });
    return decodeEffect(raw);
  }

  submitClaim(taskId: string, statement: string, requiredEvidenceKind = "DETERMINISTIC_TEST", signal?: AbortSignal | null): Promise<ClaimSnapshot> {
    return (async () => {
      const raw = await this.request("POST", "/v2/claims", {
        body: { taskId, statement, requiredEvidenceKind },
        signal,
      });
      return decodeClaim(raw);
    })();
  }
}

export const arpV2 = new TerminusArpV2Client();

// ────────────────────────── /v2/events (SSE) ───────────────────────────────

export interface ArpV2EventStreamHandler { (envelope: ArpV2EventEnvelope): void }

export interface ArpV2EventStream {
  readonly readyState: 0 | 1 | 2 | 3;
  addEventListener(type: "message" | "open" | "error", handler: ArpV2EventStreamHandler | (() => void)): () => void;
  close(): void;
  lastEventId: string | null;
}

/**
 * Subscribe to canonical v2 event envelopes. Cursor replay uses the SSE
 * `id:` line (durable, monotonic) exactly like the v1 stream.
 */
export function subscribeEventsV2(opts: { taskId?: string | null; cursor?: string | null; signal?: AbortSignal | null } & ArpV2ClientConfig = {}): ArpV2EventStream {
  const listeners = new Map<string, Set<ArpV2EventStreamHandler | (() => void)>>();
  const abort = new AbortController();
  const bound = opts.baseUrl !== undefined || opts.token !== undefined;
  const base = (opts.baseUrl ?? "").replace(/\/+$/, "");
  const token = opts.token ?? "";
  const resolveUrl = bound
    ? (path: string, query?: Record<string, string | null | undefined>): string => buildUrl(base, path, query)
    : (path: string, query?: Record<string, string | null | undefined>): string => api.url(path, query);
  const buildAuthHeaders = bound
    ? (extra?: Record<string, string>): Record<string, string> => buildHeaders(token, extra)
    : (extra?: Record<string, string>): Record<string, string> => api.buildHeaders(extra);
  let readyState: 0 | 1 | 2 | 3 = 0;
  let lastEventId: string | null = null;
  let closed = false;

  if (opts.signal) opts.signal.addEventListener("abort", () => abort.abort());

  const emit = (type: "message" | "open" | "error", ev?: ArpV2EventEnvelope): void => {
    const set = listeners.get(type);
    if (!set) return;
    for (const h of set) {
      try {
        if (type === "message") (h as ArpV2EventStreamHandler)(ev as ArpV2EventEnvelope);
        else (h as () => void)();
      } catch {
        // Listener errors must not break the stream.
      }
    }
  };

  void (async (): Promise<void> => {
    const url = resolveUrl("/v2/events", { taskId: opts.taskId ?? null, cursor: opts.cursor ?? null });
    let res: Response;
    try {
      res = await fetch(url, {
        headers: buildAuthHeaders({ accept: "text/event-stream" }),
        signal: abort.signal,
      });
    } catch {
      if (closed) return;
      readyState = 3;
      emit("error");
      return;
    }
    if (!res.ok || !res.body) {
      readyState = 3;
      emit("error");
      return;
    }
    readyState = 1;
    emit("open");
    const reader = res.body.getReader();
    const decoder = createSseDecoder();
    const textDecoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const sse of decoder.feed(textDecoder.decode(value, { stream: true }))) {
          if (sse.id) lastEventId = sse.id;
          let payload: unknown;
          try {
            payload = JSON.parse(sse.data) as unknown;
          } catch {
            continue;
          }
          const envelope = payload as ArpV2EventEnvelope;
          if (!envelope || typeof envelope !== "object" || typeof envelope.eventType !== "string") continue;
          emit("message", envelope);
        }
      }
    } catch {
      // Aborted or interrupted — handled below.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      if (!closed) readyState = 3;
    }
  })();

  return {
    get readyState() {
      return readyState;
    },
    get lastEventId() {
      return lastEventId;
    },
    addEventListener(type, handler) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      readyState = 2;
      abort.abort();
    },
  };
}
