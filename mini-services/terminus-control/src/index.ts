/**
 * Terminus Control Plane mini-service.
 *
 * Per SPEC §5, §27: TypeScript control plane owns cognition and product
 * state — sessions, tasks, context compiler, providers, orchestration,
 * verification, memory, public API. It has NO ambient effect authority;
 * every privileged operation crosses the Rust kernel boundary via the
 * gateway (?XTransformPort=3040).
 *
 * This service exposes:
 *   - The full public API (SPEC §32) over HTTP/SSE on port 3050.
 *   - A realtime event bus streaming semantic events to clients.
 *   - The agent loop: context compile → provider attempt → tool settlement →
 *     verification → completion, all observable via events and manifests.
 *
 * The service uses Prisma (SQLite) for operational state, generated gRPC over
 * UDS for effects, and the @terminus/* packages for domain logic.
 *
 * Security (SPEC §30.5/§30.6/§30.8):
 *   - Every request except `GET /v1/system/health` MUST present a bearer
 *     token matching `TERMINUS_CONTROL_TOKEN`.
 *   - CORS is locked to the configured gateway origin
 *     (`TERMINUS_CONTROL_CORS_ORIGIN`, default `http://127.0.0.1:81`).
 *   - Mutating requests accept an `x-idempotency-key` header; replays with
 *     the same key+body return the cached response, replays with a
 *     different body return `IDEMPOTENCY_KEY_CONFLICT`.
 *   - SSE event IDs are monotonic (timestamp-prefixed) so `cursor` replay
 *     is ordered; stale cursors emit a `cursor_expired` event.
 *   - Before any mutating handler executes, an `authorized` audit record
 *     is logged with method, path, actor, task_id, trace_id, timestamp.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { firstValueFrom } from "rxjs";
import { createKernelUdsClients, type KernelUdsClients } from "./kernel-uds.js";

// ────────────────────────── Configuration ──────────────────────────────────

const PORT = Number.parseInt(process.env.TERMINUS_CONTROL_PORT ?? "3050", 10);
const KERNEL_GRPC_SOCKET = process.env.TERMINUS_KERNEL_GRPC_SOCKET ?? "";
// SPEC §13.6 / §31.6: secrets are short-lived brokered capabilities, never
// environment-wide shared defaults. The control plane MUST fail closed if no
// token is configured. A well-known dev token is permitted ONLY when
// TERMINUS_DEV=1 is set, so a misconfigured production deployment cannot expose
// the privileged kernel with a publicly-known token.
const DEV_MODE = process.env.TERMINUS_DEV === "1";
function requireToken(envVar: string, devValue: string, label: string): string {
  const v = process.env[envVar];
  if (v && v.length > 0) return v;
  if (DEV_MODE) {
    console.warn(`[terminus-control] TERMINUS_DEV=1: using well-known dev ${label}. NOT for production.`);
    return devValue;
  }
  const msg = `[terminus-control] ${envVar} is required (set it, or set TERMINUS_DEV=1 for local dev).`;
  console.error(msg);
  throw new Error(msg);
}
const CONTROL_TOKEN = requireToken("TERMINUS_CONTROL_TOKEN", "terminus-control-dev-token", "control token");
// The packaged desktop shell uses the loopback bridge origin. During local
// renderer development Vite serves from localhost:5173, so the documented
// TERMINUS_DEV mode must allow that exact origin rather than making the
// desktop appear permanently offline.
const CONTROL_CORS_ORIGIN = process.env.TERMINUS_CONTROL_CORS_ORIGIN
  ?? (process.env.TERMINUS_DEV === "1" ? "http://localhost:5173" : "http://127.0.0.1:81");
// Platform-appropriate default SQLite location (replaces the leftover
// `/home/z/my-project/...` template path so the control plane starts
// out-of-the-box on any host).
const DEFAULT_DB_PATH = `file:${process.env.HOME ?? process.cwd()}/.local/share/terminus/terminus.db`;
const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DB_PATH;
const SERVER_PRINCIPAL = "terminus-control-bearer";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const CORS_ALLOW_HEADERS =
  "authorization, content-type, x-idempotency-key, x-trace-id, traceparent, last-event-id, x-capability-token";
const CORS_ALLOW_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";

const SUPPORTED_CAPABILITIES = [
  "sse_resume",
  "rich_approvals",
  "artifact_streaming",
  "idempotency",
  "tools_direct",
] as const;

const db = new PrismaClient({
  datasources: { db: { url: DATABASE_URL } },
});

const kernelUds: KernelUdsClients | null = KERNEL_GRPC_SOCKET
  ? createKernelUdsClients(KERNEL_GRPC_SOCKET, process.env.TERMINUS_KERNEL_CAP_TOKEN ?? "")
  : null;

function requireKernelUds(): KernelUdsClients {
  if (!kernelUds) {
    throw new Error("TERMINUS_KERNEL_GRPC_SOCKET is required for privileged control-plane effects");
  }
  return kernelUds;
}

function kernelContext() {
  return {
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    sessionId: "control",
    taskId: "control",
    turnId: "control",
    actorId: SERVER_PRINCIPAL,
    traceparent: "",
    capabilityToken: process.env.TERMINUS_KERNEL_CAP_TOKEN ?? "",
  };
}

function kernelIntent() {
  return {
    userIntentRef: "control-plane",
    taskContractHash: "",
    trustLabel: "trusted",
    confidentialityLabel: "workspace",
    taintSources: [],
    policyProfileId: "secure-local-default",
    expectedEffectClass: "",
  };
}

// ────────────────────────── Event bus ──────────────────────────────────────

interface EventBusSubscription {
  id: string;
  filter: (ev: StoredEvent) => boolean;
  push: (ev: StoredEvent) => void;
}

interface StoredEvent {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: number;
  occurredAt: Date;
  actorJson: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string | null;
  payloadJson: string;
  artifactRefsJson: string;
  traceId: string | null;
}

class EventBus {
  private subscriptions = new Map<string, EventBusSubscription>();
  private cursor = 0;
  private monotonicSeq = 0;

  /**
   * Monotonic, lexicographically-comparable event ID. SPEC §30.6 requires
   * `Last-Event-ID` replay to return a contiguous, ordered slice, so the
   * ID is `<16-digit-ms>-<8-digit-seq>` (zero-padded). String comparison
   * of two such IDs therefore yields chronological order.
   */
  nextEventId(): string {
    const ms = Date.now().toString().padStart(16, "0");
    const seq = (this.monotonicSeq++).toString().padStart(8, "0");
    return `${ms}-${seq}`;
  }

  async publish(ev: StoredEvent): Promise<void> {
    // Persist to SQLite (semantic_events table).
    await db.semanticEvent.create({ data: ev }).catch(() => {
      // ignore duplicate-key errors from idempotent retries
    });
    // Fan-out to subscribers.
    for (const sub of this.subscriptions.values()) {
      if (sub.filter(ev)) sub.push(ev);
    }
    this.cursor += 1;
  }
  subscribe(filter: (ev: StoredEvent) => boolean, push: (ev: StoredEvent) => void): () => void {
    const id = randomUUID();
    this.subscriptions.set(id, { id, filter, push });
    return () => { this.subscriptions.delete(id); };
  }

  /**
   * Replay events with `eventId > sinceEventId`, ordered by occurredAt then
   * aggregateSequence. Because event IDs are monotonic by timestamp, the
   * `gt` filter yields a chronologically-ordered tail (SPEC §30.6).
   */
  async replay(sinceEventId: string | null, filter: (ev: StoredEvent) => boolean): Promise<StoredEvent[]> {
    if (!sinceEventId) return [];
    const rows = await db.semanticEvent.findMany({
      where: { eventId: { gt: sinceEventId } },
      orderBy: [{ occurredAt: "asc" }, { aggregateSequence: "asc" }],
      take: 1000,
    });
    return rows as unknown as StoredEvent[];
  }

  /**
   * Return the event ID of the oldest retained event, or null if none.
   * Used to detect stale SSE cursors (SPEC §30.6 CURSOR_EXPIRED).
   */
  async oldestEventId(): Promise<string | null> {
    const oldest = await db.semanticEvent.findFirst({
      orderBy: [{ occurredAt: "asc" }, { aggregateSequence: "asc" }],
      select: { eventId: true },
    });
    return oldest?.eventId ?? null;
  }

  /**
   * Persist the last-sent event ID for a stream so the server can
   * reconstruct per-subscriber progress (SPEC §30.6, §45.5
   * EventStreamCursor table).
   */
  async persistCursor(streamName: string, lastEventId: string, lastSequence: number): Promise<void> {
    await db.eventStreamCursor.upsert({
      where: { streamName },
      create: { streamName, lastEventId, lastSequence },
      update: { lastEventId, lastSequence },
    }).catch(() => {
      // best-effort; cursor persistence must not break the stream.
    });
  }
}

const bus = new EventBus();

async function emit(params: {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: number;
  actor?: { kind: string; id: string };
  correlationId?: string | undefined;
  causationId?: string | null | undefined;
  idempotencyKey?: string | null | undefined;
  payload: unknown;
  artifactRefs?: string[] | undefined;
  traceId?: string | null | undefined;
}): Promise<void> {
  const ev: StoredEvent = {
    eventId: bus.nextEventId(),
    schemaVersion: 1,
    eventType: params.eventType,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    aggregateSequence: params.aggregateSequence,
    occurredAt: new Date(),
    actorJson: JSON.stringify(params.actor ?? { kind: "system", id: "terminus-control" }),
    correlationId: params.correlationId ?? randomUUID(),
    causationId: params.causationId ?? null,
    idempotencyKey: params.idempotencyKey ?? null,
    payloadJson: JSON.stringify(params.payload),
    artifactRefsJson: JSON.stringify(params.artifactRefs ?? []),
    traceId: params.traceId ?? null,
  };
  await bus.publish(ev);
}

// ────────────────────────── Helpers ────────────────────────────────────────

function now(): string { return new Date().toISOString(); }
function uuid(): string { return randomUUID(); }

/** Per-request raw body cache so auth/idempotency/handler can all read it. */
const bodyCache = new WeakMap<IncomingMessage, Buffer>();

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const cached = bodyCache.get(req);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      bodyCache.set(req, buf);
      resolve(buf);
    });
  });
}

function jsonBody(req: IncomingMessage): Promise<unknown> {
  return readRawBody(req).then((buf) => {
    if (buf.length === 0) return {};
    try { return JSON.parse(buf.toString("utf8")); } catch (e) { throw e; }
  });
}

function sha256Hex(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function getTraceId(req: IncomingMessage): string {
  const tp = req.headers["traceparent"];
  if (typeof tp === "string" && tp.length > 0) return tp;
  const tid = req.headers["x-trace-id"];
  if (typeof tid === "string" && tid.length > 0) return tid;
  return randomUUID();
}

function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return false;
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length);
  return constantTimeEqual(token, CONTROL_TOKEN);
}

function isMutating(method: string | undefined): boolean {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

function auditAuthorized(
  req: IncomingMessage,
  url: URL,
  params: Record<string, string>,
  traceId: string,
): void {
  // SPEC §31.3 step 10 — log an `authorized` audit event before any effect.
  // `task_id` is only populated when the route is under /v1/tasks/:id (so
  // the value is genuinely a task ID, not a session/turn/job ID).
  const taskId = url.pathname.startsWith("/v1/tasks/") ? (params.id ?? null) : null;
  const log = {
    event: "authorized",
    method: req.method ?? "GET",
    path: url.pathname,
    actor: SERVER_PRINCIPAL,
    task_id: taskId,
    trace_id: traceId,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(log));
}

// ────────────────────────── Idempotency ────────────────────────────────────

/**
 * Per-response capture so the idempotency wrapper can store the exact
 * bytes the handler produced. Only attached for mutating routes.
 */
interface CapturedResponse {
  status: number;
  body: Buffer;
}

const captureMap = new WeakMap<ServerResponse, CapturedResponse>();

function attachCapture(res: ServerResponse): void {
  captureMap.set(res, { status: 0, body: Buffer.alloc(0) });
}

function recordCapture(res: ServerResponse, status: number, body: Buffer): void {
  const cap = captureMap.get(res);
  if (!cap) return;
  cap.status = status;
  cap.body = body;
}

function popCapture(res: ServerResponse): CapturedResponse | null {
  const cap = captureMap.get(res);
  if (!cap) return null;
  captureMap.delete(res);
  return cap;
}

/**
 * SPEC §30.5. For mutating requests with an `x-idempotency-key` header:
 *   - same key + same body → return cached response
 *   - same key + different body → return 409 IDEMPOTENCY_KEY_CONFLICT
 *   - new key → insert `pending`, run handler, store result as `completed`
 *
 * Returns `true` if the handler should run, `false` if a response has
 * already been sent (replay, conflict, or in-flight).
 *
 * When returning `true`, a capture is attached to `res`; the caller MUST
 * invoke `commitIdempotency(...)` after the handler completes.
 */
async function withIdempotency(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  traceId: string,
): Promise<boolean> {
  const keyHeader = req.headers["x-idempotency-key"];
  const key = Array.isArray(keyHeader) ? (keyHeader[0] ?? null) : keyHeader;
  if (typeof key !== "string" || key.length === 0) {
    console.warn(JSON.stringify({
      event: "idempotency_key_absent",
      method,
      path: req.url ?? "",
      trace_id: traceId,
      timestamp: new Date().toISOString(),
    }));
    return true;
  }
  const buf = await readRawBody(req);
  const hash = sha256Hex(buf);

  const existing = await db.idempotencyRecord.findUnique({
    where: {
      principal_method_idempotencyKey: {
        principal: SERVER_PRINCIPAL,
        method,
        idempotencyKey: key,
      },
    },
  }).catch((err: unknown) => {
    console.warn(JSON.stringify({
      event: "idempotency_lookup_failed",
      method,
      idempotency_key: key,
      error: String(err),
      timestamp: new Date().toISOString(),
    }));
    return null;
  });

  if (existing) {
    if (existing.requestHash !== hash) {
      sendError(
        res,
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
        "idempotency key reused with a different request body",
        "conflict",
        { idempotency_key: key },
      );
      return false;
    }
    // Same key + same body → replay the stored response.
    if (existing.state === "completed") {
      if (existing.errorJson) {
        try {
          const err = JSON.parse(existing.errorJson) as {
            status: number; code: string; message: string; category: string;
            details?: Record<string, unknown>;
          };
          sendError(res, err.status, err.code, err.message, err.category, err.details ?? {});
        } catch {
          sendJson(res, 200, null);
        }
      } else {
        try {
          const artifact = existing.responseArtifact
            ? (JSON.parse(existing.responseArtifact) as unknown)
            : null;
          sendJson(res, 200, artifact);
        } catch {
          sendJson(res, 200, null);
        }
      }
      return false;
    }
    // Still in-flight — ask the client to retry.
    sendError(
      res,
      409,
      "IDEMPOTENCY_IN_PROGRESS",
      "a request with the same idempotency key is still in-flight",
      "conflict",
      { idempotency_key: key, retry_after_ms: 500 },
    );
    return false;
  }

  // No prior record — insert pending, attach capture, let caller run handler.
  await db.idempotencyRecord.create({
    data: {
      principal: SERVER_PRINCIPAL,
      method,
      idempotencyKey: key,
      requestHash: hash,
      state: "pending",
      responseArtifact: null,
      errorJson: null,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    },
  }).catch((err: unknown) => {
    console.warn(JSON.stringify({
      event: "idempotency_insert_failed",
      method,
      idempotency_key: key,
      error: String(err),
      timestamp: new Date().toISOString(),
    }));
  });
  attachCapture(res);
  return true;
}

async function commitIdempotency(
  res: ServerResponse,
  method: string,
  key: string,
): Promise<void> {
  const cap = popCapture(res);
  if (!cap) return;
  const status = cap.status || 200;
  let bodyJson: unknown = null;
  try {
    bodyJson = JSON.parse(cap.body.toString("utf8"));
  } catch {
    bodyJson = cap.body.toString("utf8");
  }
  const isError =
    status >= 400 &&
    typeof bodyJson === "object" &&
    bodyJson !== null &&
    "error" in bodyJson;
  await db.idempotencyRecord.update({
    where: {
      principal_method_idempotencyKey: {
        principal: SERVER_PRINCIPAL,
        method,
        idempotencyKey: key,
      },
    },
    data: isError
      ? {
          state: "completed",
          errorJson: JSON.stringify({
            ...(bodyJson as { error: Record<string, unknown> }).error,
            status,
          }),
        }
      : {
          state: "completed",
          responseArtifact: JSON.stringify(bodyJson),
        },
  }).catch((err: unknown) => {
    console.warn(JSON.stringify({
      event: "idempotency_commit_failed",
      method,
      idempotency_key: key,
      error: String(err),
      timestamp: new Date().toISOString(),
    }));
  });
}

// ────────────────────────── HTTP response helpers ─────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  const headers = {
    "content-type": "application/json",
    "content-length": String(buf.length),
    "access-control-allow-origin": CONTROL_CORS_ORIGIN,
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-allow-methods": CORS_ALLOW_METHODS,
    "vary": "origin",
  };
  recordCapture(res, status, buf);
  res.writeHead(status, headers);
  res.end(buf);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  category: string,
  details: Record<string, unknown> = {},
): void {
  sendJson(res, status, {
    error: {
      code,
      message,
      retryable:
        category === "timeout" ||
        category === "external_dependency" ||
        category === "internal",
      category,
      details,
      suggested_action: null,
      trace_id: randomUUID(),
    },
  });
}

// ────────────────────────── Approval decision reconciliation ───────────────

/**
 * SPEC §32.4. Accept BOTH naming conventions used across the codebase:
 *   - public-api: allow_once | allow_exact | allow_task_scope | deny_once |
 *                 deny_and_rule | stop_task
 *   - domain:     allow_once | allow_for_action | allow_for_task | deny_once |
 *                 deny_and_add_task_rule | stop_task
 * and map them to the canonical domain names. Unknown values return null.
 */
function normalizeApprovalDecision(raw: string): string | null {
  switch (raw) {
    case "allow_once":
    case "allow_exact":
      return "allow_once";
    case "allow_for_action":
    case "allow_task_scope":
      return "allow_for_action";
    case "allow_for_task":
      return "allow_for_task";
    case "deny_once":
      return "deny_once";
    case "deny_and_rule":
    case "deny_and_add_task_rule":
      return "deny_and_add_task_rule";
    case "stop_task":
      return "stop_task";
    default:
      return null;
  }
}

// ────────────────────────── Route handlers ─────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const pattern = path.replace(/:([^/]+)/g, (_, n) => { paramNames.push(n); return "([^/]+)"; });
  return { method, pattern: new RegExp(`^${pattern}$`), paramNames, handler };
}

const routes: Route[] = [
  // ────────────────────────── /system ────────────────────────────────────
  route("GET", "/v1/system/health", async (_req, res) => {
    const kernelHealth = await requireKernelUds().info.Health({});
    sendJson(res, 200, {
      status: kernelHealth.state === "healthy" || kernelHealth.state === "ok" ? "ok" : "degraded",
      version: "0.1.0",
      build_commit: "dev",
      instance_id: "terminus-control-dev",
      uptime_seconds: process.uptime(),
      ready: kernelHealth.state === "healthy" || kernelHealth.state === "ok",
      kernel: kernelHealth,
    });
  }),
  route("POST", "/v1/system/initialize", async (req, res) => {
    // SPEC §30.3 — parse ClientHello, echo the intersection of supported
    // capabilities back as ServerHello.
    const body = await jsonBody(req) as {
      client?: { name?: string; version?: string } | undefined;
      protocol?: { major?: number; minor?: number } | undefined;
      capabilities?: string[] | undefined;
      experimental?: string[] | undefined;
    };
    const clientCaps = body.capabilities ?? [];
    const experimental = body.experimental ?? [];
    const supported = new Set<string>(SUPPORTED_CAPABILITIES);
    const intersection =
      clientCaps.length === 0
        ? [...SUPPORTED_CAPABILITIES]
        : clientCaps.filter((c) => supported.has(c));
    sendJson(res, 200, {
      server: { version: "0.1.0", build_commit: "dev", instance_id: "terminus-control-dev" },
      protocol: { major: 1, minor: 0 },
      client: body.client ?? null,
      capabilities: {
        supported: [...SUPPORTED_CAPABILITIES],
        intersection,
        experimental,
      },
      limits: { max_request_bytes: 1_048_576, max_sse_backlog: 10_000 },
    });
  }),

  // ────────────────────────── /workspaces ────────────────────────────────
  route("POST", "/v1/workspaces/open", async (req, res) => {
    const body = await jsonBody(req) as {
      root_uri: string; kind?: string; trust?: string; policy_profile_id?: string;
    };
    const id = uuid();
    const ws = await db.workspace.create({
      data: {
        id,
        kind: (body.kind ?? "local_directory") as string,
        rootUri: body.root_uri,
        canonicalRoot: body.root_uri,
        trust: (body.trust ?? "trusted") as string,
        policyProfileId: body.policy_profile_id ?? "secure-local-default",
      },
    });
    sendJson(res, 201, {
      id: ws.id, kind: ws.kind, root_uri: ws.rootUri, canonical_root: ws.canonicalRoot,
      trust: ws.trust, policy_profile_id: ws.policyProfileId,
      created_at: ws.createdAt.toISOString(), last_opened_at: ws.lastOpenedAt.toISOString(),
    });
  }),
  route("GET", "/v1/workspaces/:id", async (_req, res, params) => {
    const ws = await db.workspace.findUnique({ where: { id: String(params.id) } });
    if (!ws) return sendError(res, 404, "WORKSPACE_NOT_FOUND", "workspace not found", "not_found");
    sendJson(res, 200, {
      id: ws.id, kind: ws.kind, root_uri: ws.rootUri, canonical_root: ws.canonicalRoot,
      trust: ws.trust, policy_profile_id: ws.policyProfileId,
      created_at: ws.createdAt.toISOString(), last_opened_at: ws.lastOpenedAt.toISOString(),
    });
  }),

  // ────────────────────────── /sessions ──────────────────────────────────
  route("POST", "/v1/sessions", async (req, res) => {
    const body = await jsonBody(req) as {
      workspace_id: string; title: string;
      default_model_profile?: string; default_permission_profile?: string;
    };
    const id = uuid();
    const session = await db.session.create({
      data: {
        id,
        workspaceId: body.workspace_id,
        ownerPrincipal: SERVER_PRINCIPAL,
        title: body.title,
        status: "active",
        defaultModelProfile: body.default_model_profile ?? "implementer",
        defaultPermissionProfile: body.default_permission_profile ?? "secure-local-default",
      },
    });
    // Auto-create a root thread.
    const thread = await db.thread.create({
      data: { id: uuid(), sessionId: session.id, status: "active" },
    });
    await db.session.update({
      where: { id: session.id },
      data: { activeThreadId: thread.id },
    });
    await emit({
      eventType: "session.created",
      aggregateType: "session",
      aggregateId: session.id,
      aggregateSequence: 1,
      payload: { title: session.title, workspace_id: session.workspaceId },
    });
    sendJson(res, 201, {
      id: session.id, workspace_id: session.workspaceId, owner_principal: session.ownerPrincipal,
      title: session.title, status: session.status,
      default_model_profile: session.defaultModelProfile,
      default_permission_profile: session.defaultPermissionProfile,
      active_thread_id: thread.id,
      created_at: session.createdAt.toISOString(), updated_at: session.updatedAt.toISOString(),
    });
  }),
  route("GET", "/v1/sessions/:id", async (_req, res, params) => {
    const s = await db.session.findUnique({ where: { id: String(params.id) } });
    if (!s) return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");
    sendJson(res, 200, {
      id: s.id, workspace_id: s.workspaceId, owner_principal: s.ownerPrincipal,
      title: s.title, status: s.status,
      default_model_profile: s.defaultModelProfile,
      default_permission_profile: s.defaultPermissionProfile,
      active_thread_id: s.activeThreadId,
      created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(),
    });
  }),
  route("GET", "/v1/sessions", async (_req, res) => {
    const sessions = await db.session.findMany({
      where: { status: { not: "deleted" } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    sendJson(res, 200, {
      sessions: sessions.map((s) => ({
        id: s.id, workspace_id: s.workspaceId, title: s.title, status: s.status,
        active_thread_id: s.activeThreadId,
        created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(),
      })),
    });
  }),
  // SPEC §32.2 — pause a session (liveness preserved; turns blocked).
  route("POST", "/v1/sessions/:id/pause", async (_req, res, params) => {
    const s = await db.session.findUnique({ where: { id: String(params.id) } });
    if (!s) return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");
    const updated = await db.session.update({
      where: { id: s.id },
      data: { status: "paused" },
    });
    await emit({
      eventType: "session.paused",
      aggregateType: "session",
      aggregateId: updated.id,
      aggregateSequence: 2,
      payload: { previous_status: s.status, new_status: updated.status },
    });
    sendJson(res, 200, {
      id: updated.id, workspace_id: updated.workspaceId, owner_principal: updated.ownerPrincipal,
      title: updated.title, status: updated.status,
      default_model_profile: updated.defaultModelProfile,
      default_permission_profile: updated.defaultPermissionProfile,
      active_thread_id: updated.activeThreadId,
      created_at: updated.createdAt.toISOString(), updated_at: updated.updatedAt.toISOString(),
    });
  }),

  // ────────────────────────── /threads ───────────────────────────────────
  route("POST", "/v1/threads", async (req, res) => {
    const body = await jsonBody(req) as { session_id: string; parent_thread_id?: string | null };
    const t = await db.thread.create({
      data: {
        id: uuid(), sessionId: body.session_id,
        parentThreadId: body.parent_thread_id ?? null, status: "active",
      },
    });
    sendJson(res, 201, { id: t.id, session_id: t.sessionId, created_at: t.createdAt.toISOString() });
  }),
  route("GET", "/v1/sessions/:id/threads", async (_req, res, params) => {
    const threads = await db.thread.findMany({
      where: { sessionId: String(params.id), status: { not: "deleted" } },
      orderBy: { createdAt: "asc" },
    });
    sendJson(res, 200, { threads });
  }),
  // SPEC §32.2 — fork a thread from an existing one (optionally from a
  // specific turn). The child thread shares the session and records its
  // parent + fork point.
  route("POST", "/v1/threads/:id/fork", async (req, res, params) => {
    const body = await jsonBody(req) as { from_turn_id?: string | null };
    const parent = await db.thread.findUnique({ where: { id: String(params.id) } });
    if (!parent) return sendError(res, 404, "THREAD_NOT_FOUND", "thread not found", "not_found");
    const fromTurn = body.from_turn_id ?? parent.headTurnId ?? null;
    const child = await db.thread.create({
      data: {
        id: uuid(),
        sessionId: parent.sessionId,
        parentThreadId: parent.id,
        forkedFromTurnId: fromTurn,
        status: "active",
      },
    });
    await emit({
      eventType: "thread.forked",
      aggregateType: "thread",
      aggregateId: child.id,
      aggregateSequence: 1,
      correlationId: parent.id,
      payload: { parent_thread_id: parent.id, from_turn_id: fromTurn },
    });
    sendJson(res, 201, {
      id: child.id, session_id: child.sessionId, parent_thread_id: child.parentThreadId,
      forked_from_turn_id: child.forkedFromTurnId, status: child.status,
      created_at: child.createdAt.toISOString(),
    });
  }),

  // ────────────────────────── /tasks ─────────────────────────────────────
  route("POST", "/v1/tasks", async (req, res) => {
    const body = await jsonBody(req) as {
      session_id: string; thread_id: string; objective: string;
      non_goals?: string[];
      acceptance_criteria?: Array<{ id: string; statement: string; verification_hint?: string | null; required?: boolean }>;
      allowed_scope?: { read_paths?: string[]; write_paths?: string[]; external_systems?: string[] };
      risk_class?: string;
    };
    const id = uuid();
    const scope = body.allowed_scope ?? {};
    const t = await db.task.create({
      data: {
        id, sessionId: body.session_id, threadId: body.thread_id,
        status: "DRAFT", phase: "INTAKE", riskClass: body.risk_class ?? "normal",
        budgetJson: JSON.stringify({ model_micros: 5_000_000, compute_seconds: 600, wall_clock_seconds: 3600, human_approvals: 20 }),
        scopeDigest: JSON.stringify(scope),
      },
    });
    // Initial contract version 1.
    await db.taskContractVersion.create({
      data: {
        task_id: id, version: 1,
        objective: body.objective, userOutcome: null,
        nonGoalsJson: JSON.stringify(body.non_goals ?? []),
        constraintsJson: "[]",
        assumptionsJson: "[]",
        unknownsJson: "[]",
        allowedScopeJson: JSON.stringify(scope),
        changePolicyJson: JSON.stringify({ mayExpandScope: false, scopeExpansionRequiresUser: true }),
        contentHash: uuid(),
        createdBy: SERVER_PRINCIPAL,
      },
    });
    // Acceptance criteria.
    for (const c of body.acceptance_criteria ?? []) {
      await db.acceptanceCriterion.create({
        data: {
          taskId: id, contractVersion: 1, criterionId: c.id,
          statement: c.statement, verificationHint: c.verification_hint ?? null,
          required: c.required ?? true, status: "pending",
        },
      });
    }
    await emit({
      eventType: "task.created",
      aggregateType: "task", aggregateId: id, aggregateSequence: 1,
      payload: { objective: body.objective, session_id: body.session_id, thread_id: body.thread_id },
    });
    sendJson(res, 201, {
      id: t.id, session_id: t.sessionId, thread_id: t.threadId,
      status: t.status, phase: t.phase,
      active_contract_version: t.activeContractVersion,
      risk_class: t.riskClass,
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
      completed_at: null,
    });
  }),
  route("POST", "/v1/tasks/:id/start", async (_req, res, params) => {
    const t = await db.task.update({
      where: { id: String(params.id) },
      data: { status: "ACTIVE", phase: "DISCOVER" },
    });
    await emit({
      eventType: "task.activated",
      aggregateType: "task", aggregateId: t.id, aggregateSequence: 2,
      payload: { phase: t.phase },
    });
    sendJson(res, 200, {
      task_id: t.id, status: t.status,
      event_cursor: bus.nextEventId(),
      links: {
        events: `/v1/events?task_id=${t.id}`,
        task: `/v1/tasks/${t.id}`,
      },
    });
  }),
  route("POST", "/v1/tasks/:id/cancel", async (req, res, params) => {
    const body = await jsonBody(req) as { reason?: string | null };
    const t = await db.task.update({
      where: { id: String(params.id) },
      data: { status: "ABORTED", completedAt: new Date(), terminalReasonJson: JSON.stringify({ reason: body.reason ?? "user_cancelled" }) },
    });
    await emit({
      eventType: "task.aborted",
      aggregateType: "task", aggregateId: t.id, aggregateSequence: 99,
      payload: { reason: body.reason ?? "user_cancelled" },
    });
    sendJson(res, 200, {
      id: t.id, status: t.status, phase: t.phase,
      active_contract_version: t.activeContractVersion,
      risk_class: t.riskClass,
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
      completed_at: t.completedAt?.toISOString() ?? null,
    });
  }),
  // SPEC §32.2 — amend the task contract. Creates a new
  // TaskContractVersion and bumps `activeContractVersion` so consumers
  // always read the live contract.
  route("PATCH", "/v1/tasks/:id/contract", async (req, res, params) => {
    const body = await jsonBody(req) as {
      objective?: string;
      non_goals?: string[];
      allowed_scope?: { read_paths?: string[]; write_paths?: string[]; external_systems?: string[] };
      constraints?: unknown[];
      assumptions?: unknown[];
      unknowns?: unknown[];
      change_policy?: { mayExpandScope?: boolean; scopeExpansionRequiresUser?: boolean };
      rationale?: string | null;
    };
    const task = await db.task.findUnique({ where: { id: String(params.id) } });
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    const prevVersion = task.activeContractVersion;
    const nextVersion = prevVersion + 1;
    const prevContract = await db.taskContractVersion.findUnique({
      where: { task_id_version: { task_id: task.id, version: prevVersion } },
    });
    const prevScope = prevContract ? safeParse(prevContract.allowedScopeJson, {}) : {};
    const prevNonGoals = prevContract ? safeParse(prevContract.nonGoalsJson, []) : [];
    const prevConstraints = prevContract ? safeParse(prevContract.constraintsJson, []) : [];
    const prevAssumptions = prevContract ? safeParse(prevContract.assumptionsJson, []) : [];
    const prevUnknowns = prevContract ? safeParse(prevContract.unknownsJson, []) : [];
    const prevChangePolicy = prevContract
      ? safeParse(prevContract.changePolicyJson, { mayExpandScope: false, scopeExpansionRequiresUser: true })
      : { mayExpandScope: false, scopeExpansionRequiresUser: true };
    const newContract = await db.taskContractVersion.create({
      data: {
        task_id: task.id,
        version: nextVersion,
        objective: body.objective ?? prevContract?.objective ?? "",
        userOutcome: null,
        nonGoalsJson: JSON.stringify(body.non_goals ?? prevNonGoals),
        constraintsJson: JSON.stringify(body.constraints ?? prevConstraints),
        assumptionsJson: JSON.stringify(body.assumptions ?? prevAssumptions),
        unknownsJson: JSON.stringify(body.unknowns ?? prevUnknowns),
        allowedScopeJson: JSON.stringify(body.allowed_scope ?? prevScope),
        changePolicyJson: JSON.stringify(body.change_policy ?? prevChangePolicy),
        contentHash: uuid(),
        createdBy: SERVER_PRINCIPAL,
      },
    });
    await db.task.update({
      where: { id: task.id },
      data: { activeContractVersion: nextVersion },
    });
    await emit({
      eventType: "task.contract_amended",
      aggregateType: "task_contract_version",
      aggregateId: `${task.id}@${nextVersion}`,
      aggregateSequence: nextVersion,
      correlationId: task.id,
      payload: {
        task_id: task.id, previous_version: prevVersion, new_version: nextVersion,
        objective: newContract.objective, rationale: body.rationale ?? null,
      },
    });
    sendJson(res, 200, {
      task_id: task.id, version: newContract.version, objective: newContract.objective,
      non_goals: safeParse(newContract.nonGoalsJson, []),
      allowed_scope: safeParse(newContract.allowedScopeJson, {}),
      change_policy: safeParse(newContract.changePolicyJson, {}),
      content_hash: newContract.contentHash,
      created_by: newContract.createdBy,
      created_at: newContract.createdAt.toISOString(),
    });
  }),
  route("GET", "/v1/tasks/:id", async (_req, res, params) => {
    const t = await db.task.findUnique({
      where: { id: String(params.id) },
      include: { contractVersions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!t) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    sendJson(res, 200, {
      id: t.id, session_id: t.sessionId, thread_id: t.threadId,
      status: t.status, phase: t.phase,
      active_contract_version: t.activeContractVersion,
      risk_class: t.riskClass,
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
      completed_at: t.completedAt?.toISOString() ?? null,
      contract: t.contractVersions[0] ? {
        version: t.contractVersions[0].version,
        objective: t.contractVersions[0].objective,
        non_goals: JSON.parse(t.contractVersions[0].nonGoalsJson),
        allowed_scope: JSON.parse(t.contractVersions[0].allowedScopeJson),
      } : null,
    });
  }),
  route("GET", "/v1/sessions/:id/tasks", async (_req, res, params) => {
    const tasks = await db.task.findMany({
      where: { sessionId: String(params.id) },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    sendJson(res, 200, {
      tasks: tasks.map((t) => ({
        id: t.id, session_id: t.sessionId, thread_id: t.threadId,
        status: t.status, phase: t.phase,
        active_contract_version: t.activeContractVersion,
        risk_class: t.riskClass,
        created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
        completed_at: t.completedAt?.toISOString() ?? null,
      })),
    });
  }),

  // ────────────────────────── /turns ─────────────────────────────────────
  route("POST", "/v1/turns", async (req, res) => {
    const body = await jsonBody(req) as { thread_id: string; task_id: string; user_input: string };
    // Count existing turns in this thread to compute sequence.
    const existing = await db.turn.count({ where: { threadId: body.thread_id } });
    const seq = existing + 1;
    const id = uuid();
    const turn = await db.turn.create({
      data: {
        id, threadId: body.thread_id, taskId: body.task_id,
        sequence: seq, state: "PENDING",
        initiatingActor: SERVER_PRINCIPAL,
      },
    });
    await emit({
      eventType: "turn.started",
      aggregateType: "turn", aggregateId: id, aggregateSequence: 1,
      correlationId: body.task_id,
      payload: { thread_id: body.thread_id, task_id: body.task_id, sequence: seq, user_input: body.user_input },
    });
    // Kick off the agent loop asynchronously.
    agentLoop(id, body.user_input).catch((err) => {
      console.error("agent loop failed", err);
    });
    sendJson(res, 201, {
      id: turn.id, thread_id: turn.threadId, task_id: turn.taskId,
      sequence: turn.sequence, state: turn.state,
      initiating_actor: turn.initiatingActor,
      started_at: turn.startedAt?.toISOString() ?? null,
      completed_at: turn.completedAt?.toISOString() ?? null,
    });
  }),
  // SPEC §32.2 — interrupt a running turn. The agent loop checks turn
  // state between phases and stops at the next safe point.
  route("POST", "/v1/turns/:id/interrupt", async (req, res, params) => {
    const body = await jsonBody(req) as { reason?: string | null };
    const turn = await db.turn.findUnique({ where: { id: String(params.id) } });
    if (!turn) return sendError(res, 404, "TURN_NOT_FOUND", "turn not found", "not_found");
    const updated = await db.turn.update({
      where: { id: turn.id },
      data: {
        state: "INTERRUPTED",
        completedAt: new Date(),
        terminalErrorJson: JSON.stringify({ reason: body.reason ?? "user_interrupted" }),
      },
    });
    await emit({
      eventType: "turn.interrupted",
      aggregateType: "turn", aggregateId: updated.id, aggregateSequence: 99,
      correlationId: turn.taskId ?? undefined,
      payload: { reason: body.reason ?? "user_interrupted" },
    });
    sendJson(res, 200, {
      id: updated.id, thread_id: updated.threadId, task_id: updated.taskId,
      sequence: updated.sequence, state: updated.state,
      initiating_actor: updated.initiatingActor,
      started_at: updated.startedAt?.toISOString() ?? null,
      completed_at: updated.completedAt?.toISOString() ?? null,
    });
  }),

  // ────────────────────────── /events (SSE) ──────────────────────────────
  route("GET", "/v1/events", async (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "access-control-allow-origin": CONTROL_CORS_ORIGIN,
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "x-accel-buffering": "no",
    });
    const url = new URL(req.url ?? "", "http://x");
    const cursor = url.searchParams.get("cursor");
    const taskId = url.searchParams.get("task_id");
    const sessionId = url.searchParams.get("session_id");

    const streamName = taskId ? `task:${taskId}` : sessionId ? `session:${sessionId}` : "global";

    const filter = (ev: StoredEvent) => {
      if (taskId && ev.payloadJson && ev.payloadJson.includes(taskId)) return true;
      if (sessionId && ev.payloadJson && ev.payloadJson.includes(sessionId)) return true;
      if (!taskId && !sessionId) return true;
      return false;
    };

    let lastEventId: string | null = cursor ?? null;
    let lastSequence = 0;

    // Cursor validation + cursor_expired event (SPEC §30.6).
    if (cursor) {
      const oldest = await bus.oldestEventId();
      if (oldest && cursor < oldest) {
        const snapshotUrl = taskId
          ? `/v1/tasks/${taskId}`
          : sessionId
            ? `/v1/sessions/${sessionId}`
            : "/v1/sessions";
        const expiredPayload = JSON.stringify({
          type: "cursor_expired",
          cursor,
          oldest_retained_event_id: oldest,
          snapshot_url: snapshotUrl,
          message:
            "the requested cursor is older than the oldest retained event; " +
            "use the snapshot endpoint to reconcile state before resuming",
        });
        res.write(`event: cursor_expired\ndata: ${expiredPayload}\n\n`);
      } else {
        // Replay missed events in chronological order.
        const replayed = await bus.replay(cursor, filter);
        for (const ev of replayed) {
          res.write(`id: ${ev.eventId}\nevent: ${ev.eventType}\ndata: ${ev.payloadJson}\n\n`);
          lastEventId = ev.eventId;
          lastSequence = ev.aggregateSequence;
        }
      }
    }

    // Subscribe to live events.
    const unsubscribe = bus.subscribe(filter, (ev) => {
      res.write(`id: ${ev.eventId}\nevent: ${ev.eventType}\ndata: ${ev.payloadJson}\n\n`);
      lastEventId = ev.eventId;
      lastSequence = ev.aggregateSequence;
    });

    // Heartbeat every 15s.
    const heartbeat = setInterval(() => {
      try { res.write(`:heartbeat ${Date.now()}\n\n`); } catch { /* ignore */ }
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (lastEventId) {
        void bus.persistCursor(streamName, lastEventId, lastSequence);
      }
    });
  }),

  // ────────────────────────── /context ───────────────────────────────────
  route("GET", "/v1/context/manifests/:id", async (_req, res, params) => {
    const m = await db.contextManifest.findUnique({
      where: { id: String(params.id) },
      include: { fragments: true },
    });
    if (!m) return sendError(res, 404, "MANIFEST_NOT_FOUND", "manifest not found", "not_found");
    sendJson(res, 200, {
      id: m.id, provider_attempt_id: m.providerAttemptId,
      compiler_version: m.compilerVersion, policy_version: m.policyVersion,
      epoch_id: m.epochId, provider_key: m.providerKey, model_key: m.modelKey,
      rendered_request_hash: m.renderedRequestHash,
      estimated_tokens: JSON.parse(m.estimatedTokensJson),
      cache_plan: JSON.parse(m.cachePlanJson),
      experiment: JSON.parse(m.experimentJson),
      created_at: m.createdAt.toISOString(),
      fragments: m.fragments.map((f) => ({
        id: f.id, kind: f.kind, source_uri: f.sourceUri, source_version: f.sourceVersion,
        authority: f.authority, priority: f.priority, trust: f.trust,
        confidentiality: f.confidentiality, injection_risk: f.injectionRisk,
        exactness: f.exactness, selected: f.selected, rendered_position: f.renderedPosition,
        estimated_tokens: f.estimatedTokens,
        selection_reason: f.selectionReason, omission_reason: f.omissionReason,
      })),
    });
  }),

  // ────────────────────────── /artifacts ─────────────────────────────────
  route("GET", "/v1/artifacts/:hash", async (_req, res, params) => {
    try {
      const artifact = await requireKernelUds().artifacts.Get({
        context: kernelContext(),
        sha256: String(params.hash),
      });
      const buf = artifact.content;
      res.writeHead(200, {
        "content-type": artifact.artifact?.mediaType ?? "application/octet-stream",
        "content-length": String(buf.length),
        "access-control-allow-origin": CONTROL_CORS_ORIGIN,
        "access-control-allow-headers": CORS_ALLOW_HEADERS,
      });
      res.end(buf);
    } catch (err) {
      sendError(res, 500, "ARTIFACT_FETCH_FAILED", String(err), "internal");
    }
  }),
  route("GET", "/v1/artifacts/:hash/metadata", async (_req, res, params) => {
    try {
      const meta = await requireKernelUds().artifacts.GetMetadata({
        context: kernelContext(),
        sha256: String(params.hash),
      });
      sendJson(res, 200, meta.artifact ?? { sha256: String(params.hash) });
    } catch (err) {
      sendError(res, 500, "ARTIFACT_METADATA_FAILED", String(err), "internal");
    }
  }),

  // ────────────────────────── /approvals ─────────────────────────────────
  route("GET", "/v1/approvals", async (_req, res) => {
    const approvals = await db.approval.findMany({
      where: { status: "pending" },
      orderBy: { requestedAt: "desc" },
      take: 50,
    });
    sendJson(res, 200, { approvals });
  }),
  route("POST", "/v1/approvals/:id/resolve", async (req, res, params) => {
    const body = await jsonBody(req) as {
      decision: string;
      rationale?: string | null;
    };
    // SPEC §32.4 — accept BOTH naming conventions (public-api vs domain)
    // and map to canonical domain names.
    const canonical = normalizeApprovalDecision(body.decision);
    if (!canonical) {
      return sendError(
        res,
        400,
        "INVALID_APPROVAL_DECISION",
        `unsupported approval decision: ${body.decision}`,
        "validation",
        {
          accepted: [
            "allow_once", "allow_exact", "allow_for_action",
            "allow_task_scope", "allow_for_task",
            "deny_once", "deny_and_rule", "deny_and_add_task_rule",
            "stop_task",
          ],
          canonical_names: [
            "allow_once", "allow_for_action", "allow_for_task",
            "deny_once", "deny_and_add_task_rule", "stop_task",
          ],
        },
      );
    }
    const status =
      canonical.startsWith("allow")
        ? "allowed"
        : canonical === "stop_task"
          ? "revoked"
          : "denied";
    const a = await db.approval.update({
      where: { id: String(params.id) },
      data: { status, resolvedAt: new Date(), resolvedBy: SERVER_PRINCIPAL, rationale: body.rationale ?? null },
    });
    await emit({
      eventType: "approval.resolved",
      aggregateType: "approval", aggregateId: a.id, aggregateSequence: 2,
      correlationId: a.taskId,
      payload: { decision: canonical, raw_decision: body.decision, status: a.status },
    });
    sendJson(res, 200, {
      id: a.id, task_id: a.taskId, operation_hash: a.operationHash, status: a.status,
      decision: canonical,
      decision_aliases: {
        allow_once: ["allow_once", "allow_exact"],
        allow_for_action: ["allow_for_action", "allow_task_scope"],
        allow_for_task: ["allow_for_task"],
        deny_once: ["deny_once"],
        deny_and_add_task_rule: ["deny_and_rule", "deny_and_add_task_rule"],
        stop_task: ["stop_task"],
      },
      risk: JSON.parse(a.riskJson), requested_at: a.requestedAt.toISOString(),
      resolved_at: a.resolvedAt?.toISOString() ?? null, rationale: a.rationale,
    });
  }),

  // ────────────────────────── /jobs ──────────────────────────────────────
  route("GET", "/v1/jobs/:id", async (_req, res, params) => {
    const j = await db.job.findUnique({ where: { id: String(params.id) } });
    if (!j) return sendError(res, 404, "JOB_NOT_FOUND", "job not found", "not_found");
    sendJson(res, 200, {
      id: j.id, state: j.state,
      started_at: j.startedAt?.toISOString() ?? null,
      settled_at: j.settledAt?.toISOString() ?? null,
      output_cursor: j.outputCursor,
    });
  }),
  route("POST", "/v1/jobs/:id/stop", async (req, res, params) => {
    const body = await jsonBody(req) as { reason?: string | null };
    try {
      const r = await requireKernelUds().jobs.Stop({
        context: kernelContext(),
        jobId: String(params.id),
        reason: body.reason ?? "stopped",
      });
      sendJson(res, 200, r);
    } catch (err) {
      sendError(res, 500, "JOB_STOP_FAILED", String(err), "internal");
    }
  }),
  // SPEC §32.2 — send input to a job's PTY. Forwards to the kernel
  // (POST /v1/jobs/:id/input) which owns the PTY.
  route("POST", "/v1/jobs/:id/input", async (req, res, params) => {
    const body = await jsonBody(req) as { input?: string; eof?: boolean };
    try {
      const input = body.input ?? "";
      const r = await requireKernelUds().jobs.Input({
        context: kernelContext(),
        jobId: String(params.id),
        stdin: new TextEncoder().encode(input + (body.eof ? "\n" : "")),
      });
      sendJson(res, 200, r);
    } catch (err) {
      sendError(res, 500, "JOB_INPUT_FAILED", String(err), "internal");
    }
  }),

  // ────────────────────────── /verification ──────────────────────────────
  route("GET", "/v1/verification/plans/:id", async (_req, res, params) => {
    const p = await db.verificationPlan.findUnique({
      where: { id: String(params.id) },
      include: { nodes: true },
    });
    if (!p) return sendError(res, 404, "PLAN_NOT_FOUND", "plan not found", "not_found");
    sendJson(res, 200, {
      id: p.id, task_id: p.taskId, contract_version: p.contractVersion,
      source_revision: p.sourceRevision, completion_expression: p.completionExpression,
      nodes: p.nodes.map((n) => ({ id: n.id, kind: n.kind, required: n.required })),
    });
  }),

  // ────────────────────────── /tools (SPEC §32.1 resource group) ────────
  // List the ACI tool vocabulary (read, search, patch, exec, job, inspect,
  // capability). Direct invocation endpoints (/v1/tools/read, /v1/tools/exec)
  // are kept below for IDE/test use.
  route("GET", "/v1/tools", async (_req, res) => {
    sendJson(res, 200, {
      tools: [
        { id: "read", version: "v1", kind: "read", description: "Read a file from the workspace" },
        { id: "search", version: "v1", kind: "search", description: "Search code via FTS5/regex" },
        { id: "patch", version: "v1", kind: "patch", description: "Apply a structured patch" },
        { id: "exec", version: "v1", kind: "exec", description: "Run a sandboxed command" },
        { id: "job", version: "v1", kind: "job", description: "Start/stop/inspect a long-running job" },
        { id: "inspect", version: "v1", kind: "inspect", description: "Inspect workspace state" },
        { id: "capability", version: "v1", kind: "capability", description: "Activate or list capabilities" },
      ],
      default_profile: "secure-local-default",
    });
  }),
  route("POST", "/v1/tools/read", async (req, res) => {
    const body = await jsonBody(req) as { workspace_id: string; path: string };
    try {
      const r = await requireKernelUds().files.Read({
        context: kernelContext(),
        intent: kernelIntent(),
        path: { workspaceId: body.workspace_id, relativePath: body.path },
        mode: "full", ranges: [], symbols: [], maxBytes: 32768, expectedSha256: "",
      });
      sendJson(res, 200, r);
    } catch (err) {
      sendError(res, 500, "READ_FAILED", String(err), "internal");
    }
  }),
  route("POST", "/v1/tools/exec", async (req, res) => {
    const body = await jsonBody(req) as { program: string; args?: string[]; cwd?: string };
    try {
      const events = requireKernelUds().process.Start({
        context: kernelContext(),
        intent: kernelIntent(),
        command: {
          program: body.program,
          args: body.args ?? [],
          cwd: { workspaceId: "dev", relativePath: body.cwd ?? "." },
          publicEnv: {}, secretCapabilityUris: [], timeout: undefined,
          allocatePty: false, shell: undefined,
        },
        sandboxProfileId: "secure-local-default",
        outputPolicyId: "default",
      });
      const first = await firstValueFrom(events);
      const r = first.started
        ? { process_id: first.started.processId, job_id: first.started.jobId, resolved_executable: first.started.resolvedExecutable }
        : { process_id: "", job_id: "", resolved_executable: "" };
      sendJson(res, 200, r);
    } catch (err) {
      sendError(res, 500, "EXEC_FAILED", String(err), "internal");
    }
  }),

  // ────────────────────────── /agents ────────────────────────────────────
  route("GET", "/v1/agents", async (_req, res) => {
    const agents = await db.agent.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { task: true } });
    sendJson(res, 200, { agents });
  }),

  // ────────────────────────── /memory ────────────────────────────────────
  route("GET", "/v1/memory", async (_req, res) => {
    const claims = await db.memoryClaim.findMany({
      where: { status: "active" },
      orderBy: { updatedAt: "desc" }, take: 50,
    });
    sendJson(res, 200, {
      enabled: false, // disabled by default per SPEC §39
      claims: claims.map((c) => ({
        id: c.id, kind: c.kind, statement: c.statement,
        confidence_ppm: c.confidencePpm, status: c.status,
        scope: JSON.parse(c.scopeJson), provenance: JSON.parse(c.provenanceJson),
        created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString(),
      })),
    });
  }),

  // ────────────────────────── /evals ─────────────────────────────────────
  route("GET", "/v1/evals", async (_req, res) => {
    sendJson(res, 200, {
      suites: [
        { id: "tiny-bugfix", name: "Tiny bug fix", task_count: 12, description: "Small one-file fixes" },
        { id: "cross-file-feature", name: "Cross-file feature", task_count: 8, description: "Features spanning 2-5 files" },
        { id: "refactor", name: "Refactor", task_count: 6, description: "Behavior-preserving refactors" },
        { id: "test-generation", name: "Test generation", task_count: 10, description: "Generate tests for existing code" },
        { id: "build-failure", name: "Build failure", task_count: 5, description: "Diagnose and fix build failures" },
        { id: "security-sensitive", name: "Security-sensitive change", task_count: 4, description: "Auth/crypto/secret changes" },
      ],
      baselines: [
        { id: "terminus-minimal", name: "Terminus minimal mode", description: "Bash-only baseline (SPEC §3.7)" },
        { id: "terminus-full", name: "Terminus full mode", description: "All features enabled" },
      ],
      last_run: null,
    });
  }),

  // ────────────────────────── /configuration ─────────────────────────────
  route("GET", "/v1/configuration", async (_req, res) => {
    sendJson(res, 200, {
      terminus: { version: 1, log_level: "info" },
      kernel: { transport: "grpc+uds", socket: KERNEL_GRPC_SOCKET, required_protocol: "terminus.kernel.v1" },
      context: { compiler_version: "v1", evidence_coverage: true, memory: { enabled: false } },
      aci: { default_tools: ["read", "search", "patch", "exec", "job", "inspect", "capability"] },
      sandbox: { profile: "secure-local-default", backend: "local-restrictive" },
      orchestration: { default: "single_agent", scouts: { enabled: true, read_only: true }, writers: { enabled: true, max_parallel: 2 }, reviewer: { risk_triggered: true } },
      security: {
        control_plane_auth: "bearer_token",
        cors_origin: CONTROL_CORS_ORIGIN,
        idempotency: { enabled: true, ttl_seconds: IDEMPOTENCY_TTL_MS / 1000 },
        sse_cursors: { monotonic_event_ids: true, cursor_expired_events: true },
      },
    });
  }),

  // ────────────────────────── /policies (SPEC §32.1 resource group) ─────
  // List sandbox profiles + command rules so clients can render the
  // policy surface without reading config files.
  route("GET", "/v1/policies", async (_req, res) => {
    sendJson(res, 200, {
      active: "secure-local-default",
      profiles: [
        {
          id: "secure-local-default",
          description: "Secure local development profile (SPEC §3.7 default).",
          sandbox: { backend: "local-restrictive", network: "deny_outbound", fs: "workspace_only" },
          command_rules: [
            { pattern: "rg", decision: "allow", scope: "read" },
            { pattern: "git status", decision: "allow", scope: "read" },
            { pattern: "git diff", decision: "allow", scope: "read" },
            { pattern: "git commit", decision: "prompt", scope: "write" },
            { pattern: "rm", decision: "deny" },
            { pattern: "curl", decision: "deny" },
            { pattern: "wget", decision: "deny" },
          ],
          secret_access: "prompt",
          network: "deny_outbound_by_default",
        },
        {
          id: "trusted-local-full",
          description: "Trusted local workspace with broader tool access (requires explicit trust).",
          sandbox: { backend: "local-permissive", network: "allow_loopback", fs: "workspace_only" },
          command_rules: [
            { pattern: "*", decision: "allow", scope: "read_write" },
          ],
          secret_access: "allow_with_audit",
          network: "allow_loopback",
        },
      ],
    });
  }),

  // ────────────────────────── /checkpoints (§29.5) ──────────────────────
  route("POST", "/v1/checkpoints", async (req, res) => {
    const body = await jsonBody(req) as { session_id: string; thread_id: string; task_id?: string; workspace_revision?: string; dirty_state_digest?: string };
    const id = uuid();
    const checkpoint = await db.checkpoint.create({
      data: {
        id,
        sessionId: body.session_id,
        threadId: body.thread_id,
        taskId: body.task_id ?? null,
        checkpointArtifact: `artifact://sha256/${uuid().replace(/-/g, "").slice(0, 64)}`,
        schemaVersion: 1,
        lastCommittedSequencesJson: JSON.stringify({ task: 0, turn: 0 }),
        activeContextEpochId: null,
        promotedInputCursor: null,
        unsettledToolCallsJson: "[]",
        activeJobsJson: "[]",
        workspaceRevision: body.workspace_revision ?? null,
        dirtyStateDigest: body.dirty_state_digest ?? null,
        unsettledEffectsJson: "[]",
        artifactRefsJson: "[]",
        continuationJson: null,
      },
    });
    await emit({
      eventType: "checkpoint.created",
      aggregateType: "checkpoint", aggregateId: id, aggregateSequence: 1,
      correlationId: body.task_id,
      payload: { thread_id: body.thread_id, task_id: body.task_id },
    });
    sendJson(res, 201, {
      id: checkpoint.id,
      session_id: checkpoint.sessionId,
      thread_id: checkpoint.threadId,
      task_id: checkpoint.taskId,
      checkpoint_artifact: checkpoint.checkpointArtifact,
      schema_version: checkpoint.schemaVersion,
      created_at: checkpoint.createdAt.toISOString(),
    });
  }),
  route("GET", "/v1/checkpoints/:id", async (_req, res, params) => {
    const cp = await db.checkpoint.findUnique({ where: { id: String(params.id) } });
    if (!cp) return sendError(res, 404, "CHECKPOINT_NOT_FOUND", "checkpoint not found", "not_found");
    sendJson(res, 200, {
      id: cp.id, session_id: cp.sessionId, thread_id: cp.threadId, task_id: cp.taskId,
      checkpoint_artifact: cp.checkpointArtifact, schema_version: cp.schemaVersion,
      last_committed_sequences: JSON.parse(cp.lastCommittedSequencesJson),
      active_context_epoch_id: cp.activeContextEpochId,
      promoted_input_cursor: cp.promotedInputCursor,
      unsettled_tool_calls: JSON.parse(cp.unsettledToolCallsJson),
      active_jobs: JSON.parse(cp.activeJobsJson),
      workspace_revision: cp.workspaceRevision,
      dirty_state_digest: cp.dirtyStateDigest,
      unsettled_effects: JSON.parse(cp.unsettledEffectsJson),
      artifact_refs: JSON.parse(cp.artifactRefsJson),
      continuation: cp.continuationJson ? JSON.parse(cp.continuationJson) : null,
      created_at: cp.createdAt.toISOString(),
    });
  }),
  route("GET", "/v1/sessions/:id/checkpoints", async (_req, res, params) => {
    const cps = await db.checkpoint.findMany({
      where: { sessionId: String(params.id) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    sendJson(res, 200, { checkpoints: cps.map((c) => ({ id: c.id, thread_id: c.threadId, task_id: c.taskId, created_at: c.createdAt.toISOString() })) });
  }),

  // ────────────────────────── /recovery (§29.5) ─────────────────────────
  route("POST", "/v1/system/recover", async (_req, res) => {
    // SPEC §29.5 startup recovery procedure:
    // 1. acquire the instance lease
    // 2. verify database integrity and migration state
    // 3. load non-terminal tasks and turns
    // 4. reconcile jobs with OS process/cgroup/job-object state
    // 5. reconcile write journals and patch transactions
    // 6. reconcile external side effects in STARTED or UNKNOWN
    // 7. mark provider attempts interrupted before a complete response
    // 8. restore active context epochs
    // 9. expose tasks as resumable, blocked, or requiring manual review
    // 10. emit a recovery report artifact
    const reportId = uuid();
    const startedAt = new Date();

    // Count non-terminal tasks and turns
    const nonTerminalTasks = await db.task.count({
      where: { status: { in: ["ACTIVE", "NEEDS_USER_DECISION", "BLOCKED", "VERIFYING", "DRAFT"] } },
    });
    const nonTerminalTurns = await db.turn.count({
      where: { state: { in: ["PENDING", "CONTEXT_COMPILING", "PROVIDER_RUNNING", "RESPONSE_VALIDATING", "TOOL_SETTLEMENT", "FINALIZING"] } },
    });

    // Reconcile jobs: mark RUNNING jobs as LOST (we can't reach the OS process after restart)
    const lostJobs = await db.job.count({ where: { state: "RUNNING" } });
    if (lostJobs > 0) {
      await db.job.updateMany({ where: { state: "RUNNING" }, data: { state: "LOST" } });
    }

    // Reconcile external side effects in STARTED or UNKNOWN
    const unsettledEffects = await db.sideEffect.count({
      where: { state: { in: ["STARTED", "UNKNOWN"] } },
    });
    if (unsettledEffects > 0) {
      await db.sideEffect.updateMany({
        where: { state: { in: ["STARTED", "UNKNOWN"] } },
        data: { state: "MANUAL_REVIEW" },
      });
    }

    // Mark provider attempts as interrupted
    const interruptedAttempts = await db.providerAttempt.count({ where: { status: "running" } });
    if (interruptedAttempts > 0) {
      await db.providerAttempt.updateMany({
        where: { status: "running" },
        data: { status: "interrupted", errorJson: JSON.stringify({ reason: "process restart" }) },
      });
    }

    // Verify integrity
    let integrityOk = true;
    try {
      const result = await db.$queryRaw<{ quick_check: string }[]>`PRAGMA quick_check`;
      integrityOk = result[0]?.quick_check === "ok";
    } catch { integrityOk = false; }

    const report = await db.recoveryReport.create({
      data: {
        id: reportId,
        startedAt,
        completedAt: new Date(),
        instanceId: "terminus-control-dev",
        schemaVersion: 1,
        nonTerminalTasks,
        nonTerminalTurns,
        reconciledJobs: 0,
        lostJobs,
        reconciledEffects: 0,
        manualReviewEffects: unsettledEffects,
        integrityOk,
        detailsJson: JSON.stringify({ interruptedAttempts }),
      },
    });

    sendJson(res, 200, {
      id: report.id,
      started_at: report.startedAt.toISOString(),
      completed_at: report.completedAt?.toISOString() ?? null,
      instance_id: report.instanceId,
      non_terminal_tasks: report.nonTerminalTasks,
      non_terminal_turns: report.nonTerminalTurns,
      lost_jobs: report.lostJobs,
      manual_review_effects: report.manualReviewEffects,
      integrity_ok: report.integrityOk,
      interrupted_attempts: interruptedAttempts,
    });
  }),

  // ────────────────────────── /export (§29.6) ───────────────────────────
  route("POST", "/v1/system/export", async (req, res) => {
    const body = await jsonBody(req) as { include_artifacts?: boolean; include_events?: boolean };
    // SPEC §29.6 portable export: manifest.json, state.sqlite.snapshot,
    // semantic-events.jsonl, artifacts/, workspace-manifest.json,
    // context-manifests/, verification/, README.md
    const exportId = uuid();
    const sessions = await db.session.findMany({ where: { status: { not: "deleted" } } });
    const tasks = await db.task.findMany({ where: { status: { not: "ABORTED" } }, include: { contractVersions: { orderBy: { version: "desc" }, take: 1 } } });
    const events = body.include_events === false ? [] : await db.semanticEvent.findMany({ orderBy: { occurredAt: "asc" }, take: 10000 });
    const manifests = await db.contextManifest.findMany({ take: 1000, include: { fragments: true } });
    const verifications = await db.verificationPlan.findMany({ take: 500, include: { nodes: true, results: true } });

    const exportPayload = {
      manifest: {
        format: "terminus-export-v1",
        exported_at: new Date().toISOString(),
        export_id: exportId,
        version: "0.1.0",
        counts: {
          sessions: sessions.length,
          tasks: tasks.length,
          events: events.length,
          manifests: manifests.length,
          verifications: verifications.length,
        },
      },
      sessions: sessions.map((s) => ({
        id: s.id, workspace_id: s.workspaceId, title: s.title, status: s.status,
        created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(),
      })),
      tasks: tasks.map((t) => ({
        id: t.id, session_id: t.sessionId, status: t.status, phase: t.phase,
        objective: t.contractVersions[0]?.objective ?? null,
        created_at: t.createdAt.toISOString(), completed_at: t.completedAt?.toISOString() ?? null,
      })),
      events: events.map((e) => ({
        event_id: e.eventId, event_type: e.eventType, schema_version: e.schemaVersion,
        aggregate_type: e.aggregateType, aggregate_id: e.aggregateId,
        aggregate_sequence: e.aggregateSequence, occurred_at: e.occurredAt.toISOString(),
        payload: JSON.parse(e.payloadJson),
      })),
      context_manifests: manifests.map((m) => ({
        id: m.id, provider_key: m.providerKey, model_key: m.modelKey,
        compiler_version: m.compilerVersion, created_at: m.createdAt.toISOString(),
        fragments: m.fragments.map((f) => ({ kind: f.kind, selected: f.selected, authority: f.authority })),
      })),
      verification_plans: verifications.map((p) => ({
        id: p.id, task_id: p.taskId, completion_expression: p.completionExpression,
        nodes: p.nodes.map((n) => ({ id: n.id, kind: n.kind, required: n.required })),
        results: p.results.map((r) => ({ node_id: r.nodeId, status: r.status })),
      })),
    };

    sendJson(res, 200, exportPayload);
  }),
];

/** JSON.parse with a fallback so a corrupt stored value never crashes the API. */
function safeParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

// ────────────────────────── Agent loop ─────────────────────────────────────

/**
 * The agent loop: compile context → provider attempt → tool settlement →
 * verification → completion. Each step emits semantic events so the UI can
 * observe the full trajectory.
 *
 * For the dev mini-service, the "provider" is a deterministic fake that
 * echoes the user input and proposes a single read tool call, then
 * completes. This is enough to demonstrate the full loop end-to-end.
 */
async function agentLoop(turnId: string, userInput: string): Promise<void> {
  const turn = await db.turn.findUnique({ where: { id: turnId } });
  if (!turn) return;
  try {
    // 1. CONTEXT_COMPILING
    await db.turn.update({ where: { id: turnId }, data: { state: "CONTEXT_COMPILING", startedAt: new Date() } });
    await emit({
      eventType: "turn.context_compiling",
      aggregateType: "turn", aggregateId: turnId, aggregateSequence: 2,
      correlationId: turn.taskId ?? undefined,
      payload: { phase: "context_compiling" },
    });
    // Build a minimal context manifest and persist it.
    const manifestId = uuid();
    const baselineArtifact = `artifact://sha256/${randomUUID().replace(/-/g, "").slice(0, 64)}`;
    const manifest = await db.contextManifest.create({
      data: {
        id: manifestId, providerAttemptId: null,
        compilerVersion: "v1", policyVersion: "secure-local-default",
        epochId: null, providerKey: "fake", modelKey: "fake-implementer",
        manifestArtifact: baselineArtifact,
        renderedRequestHash: randomUUID(),
        estimatedTokensJson: JSON.stringify({ input: 1200, output: 800, reasoning: 0, tool_schema: 240, cached: 0 }),
        cachePlanJson: JSON.stringify({ stable_prefix_hash: randomUUID(), volatile_suffix_hash: randomUUID() }),
        experimentJson: JSON.stringify({ assignments: [] }),
      },
    });
    // Add a few example fragments.
    const fragments = [
      { kind: "authority", sourceUri: "terminus://policy/secure-local-default", authority: 100, priority: 100, trust: "trusted", confidentiality: "public", injectionRisk: "none", exactness: "exact", selected: true, renderedPosition: 0, estimatedTokens: 80, selectionReason: "Hard-included authority", omissionReason: null },
      { kind: "task_contract", sourceUri: `task://${turn.taskId}`, authority: 95, priority: 95, trust: "trusted", confidentiality: "workspace", injectionRisk: "none", exactness: "exact", selected: true, renderedPosition: 1, estimatedTokens: 200, selectionReason: "Hard-included task contract", omissionReason: null },
      { kind: "world_state", sourceUri: "workspace://", authority: 80, priority: 80, trust: "derived", confidentiality: "workspace", injectionRisk: "low", exactness: "semantics_preserving", selected: true, renderedPosition: 2, estimatedTokens: 320, selectionReason: "Recomputed world state at epoch boundary", omissionReason: null },
      { kind: "recent_episode", sourceUri: `turn://${turnId}/episode/0`, authority: 60, priority: 60, trust: "trusted", confidentiality: "workspace", injectionRisk: "low", exactness: "exact", selected: true, renderedPosition: 3, estimatedTokens: 180, selectionReason: "Recent complete episode", omissionReason: null },
    ];
    for (let i = 0; i < fragments.length; i++) {
      const f = fragments[i]!;
      await db.contextFragment.create({
        data: {
          id: uuid(), manifestId, fragmentKey: `frag-${i}`,
          contentArtifact: `artifact://sha256/${randomUUID().replace(/-/g, "").slice(0, 64)}`,
          invalidationJson: "[]",
          sourceVersion: null,
          ...f,
        },
      });
    }
    await emit({
      eventType: "context.manifest_persisted",
      aggregateType: "context_manifest", aggregateId: manifestId, aggregateSequence: 1,
      correlationId: turn.taskId ?? undefined,
      payload: { turn_id: turnId, fragment_count: fragments.length, provider: "fake", model: "fake-implementer" },
      artifactRefs: [manifest.manifestArtifact],
    });

    // 2. PROVIDER_RUNNING — create a provider attempt record.
    await db.turn.update({ where: { id: turnId }, data: { state: "PROVIDER_RUNNING" } });
    const attemptId = uuid();
    const requestArtifact = `artifact://sha256/${randomUUID().replace(/-/g, "").slice(0, 64)}`;
    const attempt = await db.providerAttempt.create({
      data: {
        id: attemptId, turnId, attemptNumber: 1,
        providerId: "fake", modelKey: "fake-implementer",
        capabilitySnapshotHash: randomUUID(),
        contextManifestId: manifestId, requestArtifact,
        status: "running",
      },
    });
    await emit({
      eventType: "turn.provider_running",
      aggregateType: "turn", aggregateId: turnId, aggregateSequence: 3,
      correlationId: turn.taskId ?? undefined,
      payload: { provider_attempt_id: attemptId, provider: "fake", model: "fake-implementer" },
    });

    // Simulate provider latency.
    await new Promise((r) => setTimeout(r, 400));

    // Check for interruption between phases.
    const midTurn = await db.turn.findUnique({ where: { id: turnId } });
    if (midTurn && midTurn.state === "INTERRUPTED") return;

    // 3. RESPONSE_VALIDATING
    await db.turn.update({ where: { id: turnId }, data: { state: "RESPONSE_VALIDATING" } });
    const responseArtifact = `artifact://sha256/${randomUUID().replace(/-/g, "").slice(0, 64)}`;
    await db.providerAttempt.update({
      where: { id: attemptId },
      data: {
        status: "completed",
        responseArtifact,
        completedAt: new Date(),
        usageJson: JSON.stringify({ input_tokens: 1200, output_tokens: 180, cached_input_tokens: 0, reasoning_tokens: 0, tool_schema_tokens: 240 }),
        costMicros: 1200,
        nativeContinuationJson: JSON.stringify({ continuation_id: randomUUID() }),
      },
    });
    await emit({
      eventType: "turn.response_validating",
      aggregateType: "turn", aggregateId: turnId, aggregateSequence: 4,
      correlationId: turn.taskId ?? undefined,
      payload: { provider_attempt_id: attemptId, status: "completed", usage: { input: 1200, output: 180 } },
      artifactRefs: [responseArtifact],
    });

    // 4. TOOL_SETTLEMENT — record one synthetic tool call (read).
    await db.turn.update({ where: { id: turnId }, data: { state: "TOOL_SETTLEMENT" } });
    const toolCallId = uuid();
    const argsArtifact = `artifact://sha256/${randomUUID().replace(/-/g, "").slice(0, 64)}`;
    const tc = await db.toolCall.create({
      data: {
        id: toolCallId, turnId, providerAttemptId: attemptId,
        toolId: "read", toolVersion: "v1",
        argumentsArtifact: argsArtifact,
        normalizedOperationHash: randomUUID(),
        state: "PROPOSED",
      },
    });
    await emit({
      eventType: "tool.proposed",
      aggregateType: "tool_call", aggregateId: toolCallId, aggregateSequence: 1,
      correlationId: turn.taskId ?? undefined,
      payload: { turn_id: turnId, tool: "read", args_summary: { path: "src/example.ts" } },
      artifactRefs: [argsArtifact],
    });
    // Policy decision (synthetic — allow).
    const policyId = uuid();
    await db.policyDecision.create({
      data: {
        id: policyId, toolCallId, effectType: "READ_LOCAL",
        normalizedInputArtifact: argsArtifact, decision: "allow",
        ruleIdsJson: JSON.stringify(["allow-read-tools"]),
        constraintsJson: "{}", policyVersion: "secure-local-default",
        explanation: "read on workspace path allowed by default rule",
      },
    });
    await db.toolCall.update({ where: { id: toolCallId }, data: { state: "AUTHORIZED", policyDecisionId: policyId } });
    await emit({
      eventType: "tool.authorized",
      aggregateType: "tool_call", aggregateId: toolCallId, aggregateSequence: 2,
      correlationId: turn.taskId ?? undefined,
      payload: { decision: "allow", rule_ids: ["allow-read-tools"] },
    });
    // Settle the tool call.
    const resultArtifact = `artifact://sha256/${randomUUID().replace(/-/g, "").slice(0, 64)}`;
    await db.toolCall.update({
      where: { id: toolCallId },
      data: {
        state: "SETTLED", resultArtifact,
        resultStatus: "success",
        startedAt: new Date(), settledAt: new Date(),
      },
    });
    await emit({
      eventType: "tool.settled",
      aggregateType: "tool_call", aggregateId: toolCallId, aggregateSequence: 3,
      correlationId: turn.taskId ?? undefined,
      payload: { status: "success", summary: "Read 1 file (412 lines)." },
      artifactRefs: [resultArtifact],
    });

    // 5. FINALIZING
    await db.turn.update({ where: { id: turnId }, data: { state: "FINALIZING" } });
    await emit({
      eventType: "turn.finalizing",
      aggregateType: "turn", aggregateId: turnId, aggregateSequence: 5,
      correlationId: turn.taskId ?? undefined,
      payload: { phase: "finalizing" },
    });

    // 6. COMPLETED
    await db.turn.update({
      where: { id: turnId },
      data: { state: "COMPLETED", completedAt: new Date() },
    });
    await emit({
      eventType: "turn.completed",
      aggregateType: "turn", aggregateId: turnId, aggregateSequence: 6,
      correlationId: turn.taskId ?? undefined,
      payload: { state: "COMPLETED", summary: `Acknowledged: ${userInput.slice(0, 200)}` },
    });

    // If the task has a status of ACTIVE, advance it through VERIFY → COMPLETE.
    if (turn.taskId) {
      const task = await db.task.findUnique({ where: { id: turn.taskId } });
      if (task && task.status === "ACTIVE") {
        await db.task.update({ where: { id: task.id }, data: { status: "VERIFYING", phase: "VERIFY" } });
        await emit({
          eventType: "task.verifying",
          aggregateType: "task", aggregateId: task.id, aggregateSequence: 3,
          payload: { phase: "VERIFY" },
        });
        // Synthetic verification plan: parse + diagnostics + narrow_tests.
        const planId = uuid();
        await db.verificationPlan.create({
          data: {
            id: planId, taskId: task.id, contractVersion: task.activeContractVersion,
            sourceRevision: "git:dev", completionExpression: "parse && diagnostics && narrow_tests",
            planArtifact: `artifact://sha256/${randomUUID().replace(/-/g, "").slice(0, 64)}`,
          },
        });
        for (const [nodeName, kind, required] of [["parse", "command", true], ["diagnostics", "diagnostic", true], ["narrow_tests", "command", true]] as const) {
          await db.verificationNode.create({
            data: {
              id: `${planId}-${nodeName}`, planId, kind, required,
              specificationJson: JSON.stringify({ command: kind === "command" ? "echo ok" : null }),
              timeoutMs: 30_000, retryPolicyJson: JSON.stringify({ max_attempts: 1 }),
            },
          });
        }
        // All pass.
        for (const [nodeName, kind] of [["parse", "command"], ["diagnostics", "diagnostic"], ["narrow_tests", "command"]] as const) {
          const r = await db.verificationResult.create({
            data: {
              id: uuid(), planId, nodeId: `${planId}-${nodeName}`, attempt: 1, status: "pass",
              sourceRevision: "git:dev", environmentDigest: "dev",
              evidenceArtifact: `artifact://sha256/${randomUUID().replace(/-/g, "").slice(0, 64)}`,
              completedAt: new Date(),
            },
          });
          await emit({
            eventType: "verification.node_passed",
            aggregateType: "verification_result", aggregateId: r.id, aggregateSequence: 1,
            correlationId: task.id,
            payload: { node_id: nodeName, kind },
          });
        }
        await emit({
          eventType: "verification.plan_completed",
          aggregateType: "verification_plan", aggregateId: planId, aggregateSequence: 1,
          correlationId: task.id,
          payload: { status: "all_passed" },
        });
        // Complete the task.
        await db.task.update({
          where: { id: task.id },
          data: { status: "COMPLETED", phase: "COMPLETE", completedAt: new Date() },
        });
        await emit({
          eventType: "task.completed",
          aggregateType: "task", aggregateId: task.id, aggregateSequence: 4,
          payload: { phase: "COMPLETE" },
        });
      }
    }
  } catch (err) {
    console.error("agentLoop error", err);
    await db.turn.update({
      where: { id: turnId },
      data: { state: "FAILED", completedAt: new Date(), terminalErrorJson: JSON.stringify({ message: String(err) }) },
    }).catch(() => {});
    await emit({
      eventType: "turn.failed",
      aggregateType: "turn", aggregateId: turnId, aggregateSequence: 99,
      correlationId: turn.taskId ?? undefined,
      payload: { error: String(err) },
    });
  }
}

// ────────────────────────── HTTP server ────────────────────────────────────

/**
 * Request dispatch pipeline:
 *   1. CORS preflight (OPTIONS) → 204.
 *   2. Public health endpoint (GET /v1/system/health) → no auth.
 *   3. Bearer-token auth check (SPEC §30.8) → 401 on mismatch.
 *   4. Route lookup.
 *   5. Audit log `authorized` event before mutating handlers (SPEC §31.3 step 10).
 *   6. Idempotency wrap for mutating methods (SPEC §30.5).
 *   7. Handler execution.
 *   8. Idempotency commit (persist response artifact).
 */
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");

  // 1. CORS preflight.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": CONTROL_CORS_ORIGIN,
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "access-control-allow-methods": CORS_ALLOW_METHODS,
      "access-control-max-age": "600",
      "vary": "origin",
    });
    res.end();
    return;
  }

  // 2. Public health endpoint.
  if (req.method === "GET" && url.pathname === "/v1/system/health") {
    try {
    const kernelHealth = await requireKernelUds().info.Health({});
      sendJson(res, 200, {
        status: kernelHealth.state === "healthy" || kernelHealth.state === "ok" ? "ok" : "degraded",
        version: "0.1.0",
        build_commit: "dev",
        instance_id: "terminus-control-dev",
        uptime_seconds: process.uptime(),
        ready: kernelHealth.state === "healthy" || kernelHealth.state === "ok",
        kernel: kernelHealth,
      });
    } catch (err) {
      console.error("health handler error", err);
      if (!res.headersSent) {
        sendError(res, 500, "INTERNAL", String(err), "internal");
      }
    }
    return;
  }

  // 3. Auth check.
  if (!checkAuth(req)) {
    sendError(res, 401, "UNAUTHENTICATED", "missing or invalid bearer token", "auth", {
      hint: "send 'Authorization: Bearer <TERMINUS_CONTROL_TOKEN>'",
    });
    return;
  }

  const traceId = getTraceId(req);

  // 4. Route lookup.
  let matchedRoute: Route | null = null;
  const matchedParams: Record<string, string> = {};
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    matchedRoute = r;
    r.paramNames.forEach((n, i) => { matchedParams[n] = decodeURIComponent(m[i + 1] ?? ""); });
    break;
  }

  if (!matchedRoute) {
    sendError(res, 404, "NOT_FOUND", `no route for ${req.method} ${url.pathname}`, "not_found");
    return;
  }

  // 5. Audit log before effects.
  if (isMutating(req.method)) {
    auditAuthorized(req, url, matchedParams, traceId);
  }

  // 6. Idempotency wrap (mutating only).
  const mut = isMutating(req.method);
  let idempotencyKey: string | null = null;
  if (mut) {
    const keyHeader = req.headers["x-idempotency-key"];
    idempotencyKey = Array.isArray(keyHeader) ? (keyHeader[0] ?? null) : (keyHeader ?? null);
    const proceed = await withIdempotency(req, res, matchedRoute.method, traceId);
    if (!proceed) return;
  }

  // 7. Handler execution.
  try {
    await matchedRoute.handler(req, res, matchedParams);
  } catch (err) {
    console.error("handler error", err);
    if (!res.headersSent) {
      sendError(res, 500, "INTERNAL", String(err), "internal");
    }
  }

  // 8. Commit idempotency record.
  if (mut && idempotencyKey) {
    await commitIdempotency(res, matchedRoute.method, idempotencyKey);
  }
});

// The Electron preload and desktop documentation use the IPv4 loopback URL
// (`http://127.0.0.1:3050`). Binding explicitly keeps that documented local
// transport reachable on macOS, where Node otherwise prefers an IPv6-only
// localhost listener in some environments.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[terminus-control] listening on http://localhost:${PORT}`);
  console.log(`[terminus-control] kernel transport: grpc+uds (${KERNEL_GRPC_SOCKET || "not configured"})`);
  console.log(`[terminus-control] CORS origin: ${CONTROL_CORS_ORIGIN}`);
  console.log(`[terminus-control] auth: bearer token (TERMINUS_CONTROL_TOKEN)`);
});

process.on("SIGINT", () => { void db.$disconnect(); process.exit(0); });
process.on("SIGTERM", () => { void db.$disconnect(); process.exit(0); });
