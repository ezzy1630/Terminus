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
import { createKernelArtifactClient, PrismaContextStore } from "./context-store.js";
import { PatchCommitMode, type RequestContext } from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import {
  createVerificationRuntime,
  defaultCriteriaNodes,
  persistPlanToPrisma,
  persistResultsToPrisma,
} from "./verification-runtime.js";
import type {
  AcceptanceCriterion,
  Checkpoint,
  ContentHash,
  Episode,
  Micros,
  ModelKey,
  Rfc3339Timestamp,
  TokenCount,
} from "../../../packages/domain/src/index.ts";
import { generateUuid7 } from "../../../packages/domain/src/index.ts";
import {
  authorizationInstanceSchema,
  claimSchema,
  decisionSchema,
  effectRecordSchema,
  evidenceSchema,
  questionSchema,
  riskSchema,
  workerLeaseSchema,
  taskAttemptSchema,
  budgetConsumptionSchema,
  taskContractV2Schema,
  taskV2Schema,
  workflowSchema,
  workflowNodeSchema,
  guardedEdgeSchema,
  nodeRunSchema,
  isEffectTransitionAllowed,
  isTaskV2TransitionAllowed,
  isWorkflowTransitionAllowed,
  isNodeRunTransitionAllowed,
  isAttemptTransitionAllowed,
  isLeaseTransitionAllowed,
  missionSchema,
  nowTimestamp,
  type Claim,
  type Decision,
  type EffectRecord,
  type AuthorizationInstance,
  type Evidence,
  type Question,
  type Risk,
  type WorkerLease,
  type TaskAttempt,
  type BudgetConsumption,
  type Workflow,
  type WorkflowNode,
  type GuardedEdge,
  type NodeRun,
  type TaskContractV2,
  type TaskV2,
} from "../../../packages/domain/src/index.ts";
import { ARP_V2_COMMAND_TYPES, ARP_V2_EVENT_TYPES } from "../../../packages/runtime-protocol/src/index.ts";
import { z } from "zod";
import {
  compileContext,
  type RetrievalMethod,
  type RetrievalPipeline,
  type RetrievalQuery,
  type RetrievalResult,
  type ContextBudget,
  type TaskSnapshot,
  type ThreadSnapshot,
  type WorldStateSnapshot,
} from "@terminus/context-compiler";
import {
  canonicalJson,
  computeContentHash,
  type ContextDirective,
  type ContextEpochSnapshot,
  type ContextFragment,
} from "@terminus/context-ir";
import { LocalRenderer } from "@terminus/provider-local";
import type { ArtifactClient } from "@terminus/artifact-client";
import type {
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ProviderResponse,
  ProviderResponseChunk,
  ConfidentialityPolicy,
} from "@terminus/provider-core";


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

function kernelContext(): RequestContext {
  return {
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    sessionId: "control",
    taskId: "control",
    turnId: "control",
    actorId: SERVER_PRINCIPAL,
    traceparent: "",
    capabilityToken: process.env.TERMINUS_KERNEL_CAP_TOKEN ?? "",
    workspaceId: "",
    deadline: undefined,
    resourceBudgets: undefined,
    policyVersion: "",
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

function now(): Rfc3339Timestamp { return new Date().toISOString() as Rfc3339Timestamp; }
function uuid(): string { return randomUUID(); }

interface TaskContractHashInput {
  readonly version: number;
  readonly objective: string;
  readonly userOutcome: string | null;
  readonly nonGoals: readonly unknown[];
  readonly constraints: readonly unknown[];
  readonly assumptions: readonly unknown[];
  readonly unknowns: readonly unknown[];
  readonly allowedScope: unknown;
  readonly changePolicy: unknown;
}

function taskContractHash(input: TaskContractHashInput): ContentHash {
  return computeContentHash(canonicalJson(input));
}

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

// ────────────────────────── ARP v2 canonical domain (SPEC §5–§16) ──────────

/**
 * Canonical ARP v2 aggregate store.
 *
 * Aggregates live in memory and are event-sourced through the semantic
 * event log (`semantic_events` rows with `schemaVersion = 2`): every
 * mutation emits a v2 envelope whose payload carries the full post-state
 * snapshot, and startup replays those rows to rebuild state across
 * restarts. This keeps the canonical domain durable without widening the
 * Prisma schema; dedicated v2 tables remain future work.
 *
 * Wire encoding: `Micros` bigint values are decimal strings in JSON
 * (JSON has no bigint); request bodies may send them as strings or
 * numbers and they are coerced back to bigint at this boundary.
 */

/** Deep transform: bigint → decimal string so JSON.stringify is total. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

const microsWireSchema = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative(),
]).transform((v) => BigInt(v));

/** Request-body contract schema: identical to the domain schema except that costMicros accepts JSON-safe input. */
const taskContractV2WireSchema = taskContractV2Schema.extend({
  constraints: taskContractV2Schema.shape.constraints.extend({ costMicros: microsWireSchema }),
});

const taskV2ReviveSchema = taskV2Schema.extend({ contract: taskContractV2WireSchema });

interface ArpV2State {
  tasks: Map<string, TaskV2>;
  effects: Map<string, EffectRecord>;
  authorizations: Map<string, AuthorizationInstance>;
  claims: Map<string, Claim>;
  evidences: Map<string, Evidence>;
  questions: Map<string, Question>;
  decisions: Map<string, Decision>;
  workflows: Map<string, Workflow>;
  nodeRuns: Map<string, NodeRun>;
  workerLeases: Map<string, WorkerLease>;
  attempts: Map<string, TaskAttempt>;
  risks: Map<string, Risk>;
  budgets: Map<string, BudgetConsumption>;
}

const arpV2: ArpV2State = {
  tasks: new Map(),
  effects: new Map(),
  authorizations: new Map(),
  claims: new Map(),
  evidences: new Map(),
  questions: new Map(),
  decisions: new Map(),
  workflows: new Map(),
  nodeRuns: new Map(),
  workerLeases: new Map(),
  attempts: new Map(),
  risks: new Map(),
  budgets: new Map(),
};

function arpV2StoreFor(aggregateType: string): Map<string, unknown> | null {
  switch (aggregateType) {
    case "task": return arpV2.tasks as Map<string, unknown>;
    case "effect": return arpV2.effects as Map<string, unknown>;
    case "authorization": return arpV2.authorizations as Map<string, unknown>;
    case "claim": return arpV2.claims as Map<string, unknown>;
    case "evidence": return arpV2.evidences as Map<string, unknown>;
    case "question": return arpV2.questions as Map<string, unknown>;
    case "decision": return arpV2.decisions as Map<string, unknown>;
    case "workflow": return arpV2.workflows as Map<string, unknown>;
    case "node_run": return arpV2.nodeRuns as Map<string, unknown>;
    case "lease": return arpV2.workerLeases as Map<string, unknown>;
    case "attempt": return arpV2.attempts as Map<string, unknown>;
    case "risk": return arpV2.risks as Map<string, unknown>;
    case "budget": return arpV2.budgets as Map<string, unknown>;
    default: return null;
  }
}

/** Per-aggregate sequence for v2 envelopes (recomputed on replay). */
const arpV2Sequences = new Map<string, number>();

/**
 * Emit a canonical ARP v2 envelope. The full post-state snapshot rides in
 * the payload so the event log alone reconstructs the aggregate store.
 */
async function emitV2(params: {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  snapshot: unknown;
  idempotencyKey?: string | null;
  correlationId?: string | null;
}): Promise<void> {
  const seqKey = `${params.aggregateType}:${params.aggregateId}`;
  const nextSeq = (arpV2Sequences.get(seqKey) ?? 0) + 1;
  arpV2Sequences.set(seqKey, nextSeq);
  const ev: StoredEvent = {
    eventId: bus.nextEventId(),
    schemaVersion: 2,
    eventType: params.eventType,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    aggregateSequence: nextSeq,
    occurredAt: new Date(),
    actorJson: JSON.stringify({ kind: "system", id: SERVER_PRINCIPAL }),
    correlationId: params.correlationId ?? params.aggregateId,
    causationId: null,
    idempotencyKey: params.idempotencyKey ?? null,
    payloadJson: JSON.stringify(jsonSafe({ snapshot: params.snapshot })),
    artifactRefsJson: JSON.stringify([]),
    traceId: null,
  };
  await bus.publish(ev);
}

/** Rebuild the in-memory v2 aggregates from the persisted event log. */
async function replayArpV2(): Promise<void> {
  let rows: Array<{ aggregateType: string; aggregateId: string; aggregateSequence: number; payloadJson: string }> = [];
  try {
    rows = await db.semanticEvent.findMany({
      where: { schemaVersion: 2 },
      orderBy: [{ occurredAt: "asc" }, { aggregateSequence: "asc" }],
      take: 10_000,
    });
  } catch (err) {
    console.error("[terminus-control] arp-v2 replay failed; starting with empty canonical store", err);
    return;
  }
  for (const row of rows) {
    const seqKey = `${row.aggregateType}:${row.aggregateId}`;
    arpV2Sequences.set(seqKey, Math.max(arpV2Sequences.get(seqKey) ?? 0, row.aggregateSequence));
    const parsed = safeParse<{ snapshot?: unknown }>(row.payloadJson, {});
    if (!parsed.snapshot || typeof parsed.snapshot !== "object") continue;
    const store = arpV2StoreFor(row.aggregateType);
    if (!store) continue;
    // Tasks and budgets carry bigint fields; revive Micros from wire strings.
    if (row.aggregateType === "task") {
      const revived = taskV2ReviveSchema.safeParse(parsed.snapshot);
      if (revived.success) store.set(row.aggregateId, revived.data);
    } else if (row.aggregateType === "budget") {
      const b = parsed.snapshot as Record<string, unknown>;
      const revived: BudgetConsumption = {
        taskId: String(b.taskId),
        consumedCostMicros: BigInt(String(b.consumedCostMicros ?? 0)),
        consumedComputeSeconds: Number(b.consumedComputeSeconds ?? 0),
        consumedInputTokens: BigInt(String(b.consumedInputTokens ?? 0)),
        consumedOutputTokens: BigInt(String(b.consumedOutputTokens ?? 0)),
        consumedApprovals: Number(b.consumedApprovals ?? 0),
        lastUpdatedAt: String(b.lastUpdatedAt ?? nowTimestamp()) as Rfc3339Timestamp,
      };
      store.set(row.aggregateId, revived);
    } else {
      store.set(row.aggregateId, parsed.snapshot);
    }
  }
  console.log(`[terminus-control] arp-v2 replay: ${arpV2.tasks.size} tasks, ${arpV2.effects.size} effects, ${arpV2.claims.size} claims, ${arpV2.workflows.size} workflows, ${arpV2.workerLeases.size} leases`);
}

/** Serialize a stored event into an ARP v2 envelope for SSE consumers. */
function storedEventToEnvelopeV2(ev: StoredEvent): Record<string, unknown> {
  return {
    eventId: ev.eventId,
    eventType: ev.eventType,
    schemaVersion: 2,
    aggregateType: ev.aggregateType,
    aggregateId: ev.aggregateId,
    aggregateSequence: ev.aggregateSequence,
    occurredAt: ev.occurredAt instanceof Date ? ev.occurredAt.toISOString() : String(ev.occurredAt),
    actor: safeParse(ev.actorJson, { kind: "system", id: SERVER_PRINCIPAL }),
    correlationId: ev.correlationId,
    causationId: ev.causationId,
    idempotencyKey: ev.idempotencyKey,
    payload: safeParse(ev.payloadJson, {}),
    artifactRefs: safeParse(ev.artifactRefsJson, []),
    traceId: ev.traceId,
  };
}

/** Static registry served at GET /v2/system/schema-registry (mirrors tools/codegen/v2-schemas.ts). */
const V2_SCHEMA_REGISTRY_ENTRIES: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["mission", missionSchema],
  ["task-contract-v2", taskContractV2Schema],
  ["task-v2", taskV2Schema],
  ["workflow-node", workflowNodeSchema],
  ["guarded-edge", guardedEdgeSchema],
  ["workflow", workflowSchema],
  ["node-run", nodeRunSchema],
  ["claim", claimSchema],
  ["evidence", evidenceSchema],
  ["authorization-instance", authorizationInstanceSchema],
  ["effect-record", effectRecordSchema],
  ["question", questionSchema],
  ["decision", decisionSchema],
  ["risk", riskSchema],
  ["worker-lease", workerLeaseSchema],
  ["task-attempt", taskAttemptSchema],
  ["budget-consumption", budgetConsumptionSchema],
];

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
  route("POST", "/v1/sessions/:id/resume", async (_req, res, params) => {
    const s = await db.session.findUnique({ where: { id: String(params.id) } });
    if (!s) return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");
    const updated = await db.session.update({
      where: { id: s.id },
      data: { status: "active" },
    });
    await emit({
      eventType: "session.resumed",
      aggregateType: "session",
      aggregateId: updated.id,
      aggregateSequence: 3,
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
    const initialContract: TaskContractHashInput = {
      version: 1,
      objective: body.objective,
      userOutcome: null,
      nonGoals: body.non_goals ?? [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: scope,
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    };
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
        contentHash: taskContractHash(initialContract),
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
    const nextContract: TaskContractHashInput = {
      version: nextVersion,
      objective: body.objective ?? prevContract?.objective ?? "",
      userOutcome: null,
      nonGoals: body.non_goals ?? prevNonGoals,
      constraints: body.constraints ?? prevConstraints,
      assumptions: body.assumptions ?? prevAssumptions,
      unknowns: body.unknowns ?? prevUnknowns,
      allowedScope: body.allowed_scope ?? prevScope,
      changePolicy: body.change_policy ?? prevChangePolicy,
    };
    const newContract = await db.taskContractVersion.create({
      data: {
        task_id: task.id,
        version: nextVersion,
        objective: nextContract.objective,
        userOutcome: null,
        nonGoalsJson: JSON.stringify(nextContract.nonGoals),
        constraintsJson: JSON.stringify(nextContract.constraints),
        assumptionsJson: JSON.stringify(nextContract.assumptions),
        unknownsJson: JSON.stringify(nextContract.unknowns),
        allowedScopeJson: JSON.stringify(nextContract.allowedScope),
        changePolicyJson: JSON.stringify(nextContract.changePolicy),
        contentHash: taskContractHash(nextContract),
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
      if (taskId) {
        // Turn, provider, tool, verification, and completion events use the
        // task id as their correlation id. Their payloads intentionally do
        // not all duplicate it, so payload-only matching strands the desktop
        // after turn.started and drops the rest of the live trajectory.
        return ev.correlationId === taskId
          || (ev.aggregateType === "task" && ev.aggregateId === taskId)
          || (ev.payloadJson?.includes(taskId) ?? false);
      }
      if (sessionId) return ev.payloadJson?.includes(sessionId) ?? false;
      return true;
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
  route("POST", "/v1/approvals", async (req, res) => {
    const body = await jsonBody(req) as {
      task_id: string;
      operation_hash: string;
      scope?: unknown;
      risk?: unknown;
      use_limit?: number;
    };
    const task = await db.task.findUnique({ where: { id: body.task_id } });
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    const approval = await db.approval.create({
      data: {
        id: uuid(),
        taskId: body.task_id,
        operationHash: body.operation_hash,
        scopeJson: JSON.stringify(body.scope ?? {}),
        riskJson: JSON.stringify(body.risk ?? { class: "normal", effects: [] }),
        status: "pending",
        useLimit: body.use_limit ?? 1,
      },
    });
    await emit({
      eventType: "approval.requested",
      aggregateType: "approval", aggregateId: approval.id, aggregateSequence: 1,
      correlationId: approval.taskId,
      payload: { operation_hash: approval.operationHash, status: approval.status },
    });
    sendJson(res, 201, {
      id: approval.id, task_id: approval.taskId, operation_hash: approval.operationHash,
      status: approval.status, risk: JSON.parse(approval.riskJson), requested_at: approval.requestedAt.toISOString(),
    });
  }),
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
    if (kernelUds) {
      try {
        const state = await kernelUds.jobs.Get({
          context: kernelContext(),
          jobId: String(params.id),
        });
        return sendJson(res, 200, state);
      } catch {
        // Fall through to the control-plane recovery projection for jobs
        // created before the kernel UDS bridge was enabled.
      }
    }
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
  route("POST", "/v1/tools/patch", async (req, res) => {
    const body = await jsonBody(req) as {
      workspace_id: string;
      path: string;
      expected_sha256: string;
      expected_utf8: string;
      replacement_utf8: string;
      commit_mode?: "preview" | "apply";
    };
    try {
      const response = await requireKernelUds().patch.Apply({
        context: kernelContext(),
        intent: kernelIntent(),
        transactionId: randomUUID(),
        baseline: {
          workspaceId: body.workspace_id,
          repositoryRevision: "no-vcs",
          dirtyDigest: "",
          sources: [{
            path: { workspaceId: body.workspace_id, relativePath: body.path },
            sha256: body.expected_sha256,
            repositoryRevision: "no-vcs",
          }],
        },
        edits: [{
          replaceExactText: {
            path: { workspaceId: body.workspace_id, relativePath: body.path },
            expectedSha256: body.expected_sha256,
            expectedUtf8: new TextEncoder().encode(body.expected_utf8),
            replacementUtf8: new TextEncoder().encode(body.replacement_utf8),
            requireUnique: true,
          },
        }],
        validationProfileId: "task-default",
        allowTransientInvalidState: false,
        commitMode: body.commit_mode === "preview"
          ? PatchCommitMode.PATCH_COMMIT_MODE_PREVIEW_ONLY
          : PatchCommitMode.PATCH_COMMIT_MODE_APPLY_TO_WORKTREE,
      });
      sendJson(res, 200, response);
    } catch (err) {
      sendError(res, 500, "PATCH_FAILED", String(err), "internal");
    }
  }),
  route("POST", "/v1/tools/exec", async (req, res) => {
    const body = await jsonBody(req) as {
      program: string;
      args?: string[];
      cwd?: string;
      sandbox_profile_id?: string;
    };
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
        sandboxProfileId: body.sandbox_profile_id ?? "secure-local-default",
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
  route("POST", "/v1/tools/job", async (req, res) => {
    const body = await jsonBody(req) as {
      program: string;
      args?: string[];
      cwd?: string;
      sandbox_profile_id?: string;
      durable?: boolean;
    };
    try {
      const result = await requireKernelUds().jobs.Start({
        context: kernelContext(),
        intent: kernelIntent(),
        command: {
          program: body.program,
          args: body.args ?? [],
          cwd: { workspaceId: "dev", relativePath: body.cwd ?? "." },
          publicEnv: {}, secretCapabilityUris: [], timeout: undefined,
          allocatePty: false, shell: undefined,
        },
        sandboxProfileId: body.sandbox_profile_id ?? "secure-local-default",
        outputPolicyId: "default",
        durable: body.durable ?? true,
      });
      sendJson(res, 201, result);
    } catch (err) {
      sendError(res, 500, "JOB_START_FAILED", String(err), "internal");
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

  // ────────────────────────── /import (§29.6) ───────────────────────────
  route("POST", "/v1/system/import", async (req, res) => {
    const body = await jsonBody(req) as {
      manifest?: { format?: string; export_id?: string };
      sessions?: Array<{ id: string; workspace_id: string; title: string; status: string; created_at: string; updated_at: string }>;
      tasks?: Array<{ id: string; session_id: string; status: string; phase: string; objective: string | null; created_at: string; completed_at?: string | null }>;
      events?: Array<{ event_id: string; event_type: string; schema_version: number; aggregate_type: string; aggregate_id: string; aggregate_sequence: number; occurred_at: string; payload: unknown }>;
    };
    if (body.manifest?.format && body.manifest.format !== "terminus-export-v1") {
      return sendError(res, 400, "INVALID_EXPORT_FORMAT", "unsupported export format", "validation");
    }
    let importedSessions = 0;
    let importedTasks = 0;
    let importedEvents = 0;

    if (Array.isArray(body.sessions)) {
      for (const s of body.sessions) {
        const imported = await db.session.upsert({
          where: { id: s.id },
          create: {
            id: s.id,
            workspaceId: s.workspace_id,
            ownerPrincipal: SERVER_PRINCIPAL,
            title: s.title,
            status: s.status,
            defaultModelProfile: "implementer",
            defaultPermissionProfile: "secure-local-default",
            createdAt: new Date(s.created_at),
            updatedAt: new Date(s.updated_at),
          },
          update: { title: s.title, status: s.status, updatedAt: new Date(s.updated_at) },
        }).then(() => true).catch(() => false);
        if (imported) importedSessions += 1;
      }
    }

    if (Array.isArray(body.tasks)) {
      for (const t of body.tasks) {
        const threadId = uuid();
        await db.thread.create({
          data: { id: threadId, sessionId: t.session_id, status: "active" },
        }).catch(() => {});

        const imported = await db.task.upsert({
          where: { id: t.id },
          create: {
            id: t.id,
            sessionId: t.session_id,
            threadId,
            status: t.status,
            phase: t.phase,
            budgetJson: "{}",
            scopeDigest: "",
            createdAt: new Date(t.created_at),
            completedAt: t.completed_at ? new Date(t.completed_at) : null,
          },
          update: { status: t.status, phase: t.phase, completedAt: t.completed_at ? new Date(t.completed_at) : null },
        }).then(() => true).catch(() => false);
        if (imported) importedTasks += 1;
      }
    }

    if (Array.isArray(body.events)) {
      for (const e of body.events) {
        await db.semanticEvent.upsert({
          where: { eventId: e.event_id },
          create: {
            eventId: e.event_id,
            eventType: e.event_type,
            schemaVersion: e.schema_version ?? 1,
            aggregateType: e.aggregate_type,
            aggregateId: e.aggregate_id,
            aggregateSequence: e.aggregate_sequence ?? 1,
            occurredAt: new Date(e.occurred_at),
            actorJson: JSON.stringify({ principal: SERVER_PRINCIPAL }),
            correlationId: uuid(),
            causationId: null,
            idempotencyKey: null,
            payloadJson: JSON.stringify(e.payload ?? {}),
            artifactRefsJson: "[]",
            traceId: null,
          },
          update: {},
        }).catch(() => {});
        importedEvents += 1;
      }
    }

    sendJson(res, 200, {
      status: "imported",
      import_id: uuid(),
      imported_at: new Date().toISOString(),
      counts: {
        sessions: importedSessions,
        tasks: importedTasks,
        events: importedEvents,
      },
    });
  }),

  // ────────────────────────── /side-effects (§28.6) ─────────────────────
  route("GET", "/v1/side-effects", async (_req, res) => {
    const effects = await db.sideEffect.findMany({ orderBy: { startedAt: "desc" }, take: 100 });
    sendJson(res, 200, {
      side_effects: effects.map((e) => ({
        id: e.id,
        tool_call_id: e.toolCallId,
        effect_type: e.effectType,
        resource_uri: e.resourceUri,
        state: e.state,
        idempotency_key: e.idempotencyKey,
        reversibility: e.reversibility,
        evidence_artifact: e.evidenceArtifact,
        started_at: e.startedAt?.toISOString() ?? null,
        settled_at: e.settledAt?.toISOString() ?? null,
      })),
    });
  }),
  route("POST", "/v1/side-effects/:id/settle", async (req, res, params) => {
    const body = await jsonBody(req) as { result: "settled" | "failed"; justification?: string };
    const effectId = String(params.id);
    const effect = await db.sideEffect.findUnique({ where: { id: effectId } });
    if (!effect) return sendError(res, 404, "SIDE_EFFECT_NOT_FOUND", "side effect not found", "not_found");
    const updated = await db.sideEffect.update({
      where: { id: effectId },
      data: {
        state: body.result === "settled" ? "SETTLED" : "FAILED",
        reconciliationJson: JSON.stringify({
          result: body.result,
          justification: body.justification ?? null,
        }),
        settledAt: new Date(),
      },
    });
    sendJson(res, 200, {
      id: updated.id,
      state: updated.state,
      result: body.result,
      settled_at: updated.settledAt?.toISOString() ?? null,
    });
  }),

  // ────────────────────────── ARP v2 (/v2, SPEC §32) ─────────────────────
  route("GET", "/v2/system/health", async (_req, res) => {
    let kernelReady = false;
    try {
      const kernelHealth = await requireKernelUds().info.Health({});
      kernelReady = kernelHealth.state === "healthy" || kernelHealth.state === "ok";
    } catch {
      kernelReady = false;
    }
    sendJson(res, 200, {
      status: kernelReady ? "ok" : "degraded",
      version: "0.1.0",
      protocolVersion: 2,
      uptimeSeconds: Math.floor(process.uptime()),
      ready: kernelReady,
    });
  }),
  route("GET", "/v2/system/schema-registry", async (_req, res) => {
    const schemas: Record<string, unknown> = {};
    for (const [name, schema] of V2_SCHEMA_REGISTRY_ENTRIES) {
      schemas[name] = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    }
    sendJson(res, 200, {
      protocolVersion: 2 as const,
      supportedEventTypes: [...ARP_V2_EVENT_TYPES],
      supportedCommandTypes: [...ARP_V2_COMMAND_TYPES],
      schemas: jsonSafe(schemas),
    });
  }),
  route("POST", "/v2/tasks", async (req, res) => {
    const parsed = z.object({
      missionId: z.string().nullable().default(null),
      organizationId: z.string().default("default-org"),
      departmentId: z.string().default("default-dept"),
      contract: taskContractV2WireSchema,
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TASK_CONTRACT", `invalid v2 task request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const { missionId, organizationId, departmentId, contract } = parsed.data;
    const nowIso = nowTimestamp();
    const task: TaskV2 = {
      id: uuid(),
      missionId,
      organizationId,
      departmentId,
      createdBy: SERVER_PRINCIPAL,
      contract: contract as TaskContractV2,
      status: "DRAFT",
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
    };
    arpV2.tasks.set(task.id, task);
    await emitV2({
      eventType: "task.created",
      aggregateType: "task",
      aggregateId: task.id,
      snapshot: task,
      idempotencyKey: req.headers["x-idempotency-key"] as string | undefined ?? null,
    });
    sendJson(res, 201, jsonSafe(task));
  }),
  route("GET", "/v2/tasks/:id", async (_req, res, params) => {
    const task = arpV2.tasks.get(String(params.id));
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    sendJson(res, 200, jsonSafe(task));
  }),
  route("GET", "/v2/tasks", async (_req, res) => {
    const tasks = [...arpV2.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, { tasks: jsonSafe(tasks) });
  }),
  route("POST", "/v2/tasks/:id/transition", async (req, res, params) => {
    const id = String(params.id);
    const task = arpV2.tasks.get(id);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    const parsed = z.object({
      id: z.string().optional(),
      targetStatus: z.enum(["DRAFT", "READY", "RUNNING", "WAITING_USER", "WAITING_AUTH", "WAITING_RESOURCE", "PAUSED", "VERIFYING", "COMPLETED", "PARTIAL", "BLOCKED", "CANCELLED", "FAILED"]),
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
      reason: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TRANSITION_REQUEST", `invalid transition request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const { targetStatus, expectedVersion, reason } = parsed.data;
    if (expectedVersion !== null && expectedVersion !== task.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${expectedVersion} but task is at version ${task.version}`, "conflict", { expected_version: expectedVersion, actual_version: task.version });
    }
    if (!isTaskV2TransitionAllowed(task.status, targetStatus)) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `illegal task transition ${task.status} -> ${targetStatus}`, "conflict", { from: task.status, to: targetStatus });
    }
    const terminal = targetStatus === "COMPLETED" || targetStatus === "PARTIAL" || targetStatus === "CANCELLED" || targetStatus === "FAILED";
    const updated: TaskV2 = {
      ...task,
      status: targetStatus,
      version: task.version + 1,
      updatedAt: nowTimestamp(),
      completedAt: terminal ? nowTimestamp() : null,
    };
    arpV2.tasks.set(id, updated);
    await emitV2({
      eventType: `task.${targetStatus.toLowerCase()}`,
      aggregateType: "task",
      aggregateId: id,
      snapshot: updated,
      correlationId: id,
    });
    void reason;
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/tasks/:id/contract", async (req, res, params) => {
    const id = String(params.id);
    const task = arpV2.tasks.get(id);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    const parsed = z.object({
      contract: taskContractV2WireSchema,
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TASK_CONTRACT", `invalid contract update: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    if (parsed.data.expectedVersion !== null && parsed.data.expectedVersion !== task.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${parsed.data.expectedVersion} but task is at version ${task.version}`, "conflict");
    }
    const updated: TaskV2 = {
      ...task,
      contract: parsed.data.contract as TaskContractV2,
      version: task.version + 1,
      updatedAt: nowTimestamp(),
    };
    arpV2.tasks.set(id, updated);
    await emitV2({ eventType: "task.contract_updated", aggregateType: "task", aggregateId: id, snapshot: updated, correlationId: id });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/effects", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      attemptId: z.string().min(1),
      connectorOrWorker: z.string().min(1),
      intentType: z.string().min(1),
      canonicalParameters: z.record(z.string(), z.unknown()),
      resourceHandles: z.array(z.unknown()).default([]),
      effectClass: z.string().min(1),
      semanticIdempotencyKey: z.string().min(1),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_EFFECT_REQUEST", `invalid effect proposal: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const body = parsed.data;
    if (!arpV2.tasks.has(body.taskId)) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${body.taskId} not found`, "not_found");
    }
    const existing = [...arpV2.effects.values()].find((e) => e.semanticIdempotencyKey === body.semanticIdempotencyKey);
    if (existing) return sendJson(res, 200, jsonSafe(existing));
    const effect: EffectRecord = {
      id: uuid(),
      taskId: body.taskId,
      attemptId: body.attemptId,
      principal: SERVER_PRINCIPAL,
      connectorOrWorker: body.connectorOrWorker,
      intentType: body.intentType,
      canonicalParameters: body.canonicalParameters,
      resourceHandles: body.resourceHandles as EffectRecord["resourceHandles"],
      effectClass: body.effectClass,
      semanticIdempotencyKey: body.semanticIdempotencyKey,
      authorizationId: null,
      policyDecisionId: null,
      state: "PROPOSED",
      uncertaintyReason: null,
      compensationRef: null,
      version: 0,
      createdAt: nowTimestamp(),
      settledAt: null,
    };
    arpV2.effects.set(effect.id, effect);
    await emitV2({
      eventType: "effect.proposed",
      aggregateType: "effect",
      aggregateId: effect.id,
      snapshot: effect,
      idempotencyKey: body.semanticIdempotencyKey,
      correlationId: effect.taskId,
    });
    sendJson(res, 201, jsonSafe(effect));
  }),
  route("GET", "/v2/effects/:id", async (_req, res, params) => {
    const effect = arpV2.effects.get(String(params.id));
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    sendJson(res, 200, jsonSafe(effect));
  }),
  route("GET", "/v2/effects", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const taskId = url.searchParams.get("taskId");
    const all = [...arpV2.effects.values()]
      .filter((e) => !taskId || e.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, { effects: jsonSafe(all) });
  }),
  route("POST", "/v2/effects/:id/transition", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const parsed = z.object({
      targetState: z.enum(["PROPOSED", "POLICY_CHECKED", "AUTHORIZATION_REQUIRED", "AUTHORIZED", "PREPARED", "DISPATCHED", "OBSERVED", "VALIDATED", "COMMITTED", "DENIED", "CANCELLED", "UNCERTAIN", "RECONCILING", "COMPENSATING", "COMPENSATED", "RESIDUE", "MANUAL_RECONCILE"]),
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
      reason: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TRANSITION_REQUEST", `invalid effect transition: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const { targetState, expectedVersion } = parsed.data;
    if (expectedVersion !== null && expectedVersion !== effect.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${expectedVersion} but effect is at version ${effect.version}`, "conflict", { expected_version: expectedVersion, actual_version: effect.version });
    }
    if (!isEffectTransitionAllowed(effect.state, targetState)) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `illegal effect transition ${effect.state} -> ${targetState}`, "conflict", { from: effect.state, to: targetState });
    }
    const settled = targetState === "COMMITTED" || targetState === "DENIED" || targetState === "CANCELLED" || targetState === "COMPENSATED";
    const updated: EffectRecord = {
      ...effect,
      state: targetState,
      version: effect.version + 1,
      settledAt: settled ? nowTimestamp() : null,
    };
    arpV2.effects.set(id, updated);
    await emitV2({
      eventType: `effect.${targetState.toLowerCase()}`,
      aggregateType: "effect",
      aggregateId: id,
      snapshot: updated,
      correlationId: effect.taskId,
    });
    sendJson(res, 200, jsonSafe(updated));
  }),
  // Semantic alias: authorize an authorization-gated effect (POLICY_CHECKED |
  // AUTHORIZATION_REQUIRED → AUTHORIZED). Strict — no state skipping.
  route("POST", "/v2/effects/:id/authorize", async (req, res, params) => {
    const effect = arpV2.effects.get(String(params.id));
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const parsed = z.object({ authorizationId: z.string().min(1) }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_AUTHORIZATION", "authorizationId is required", "validation");
    }
    if (effect.state !== "POLICY_CHECKED" && effect.state !== "AUTHORIZATION_REQUIRED") {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `effect in state ${effect.state} cannot be authorized`, "conflict", { from: effect.state });
    }
    const updated: EffectRecord = { ...effect, state: "AUTHORIZED", authorizationId: parsed.data.authorizationId, version: effect.version + 1 };
    arpV2.effects.set(effect.id, updated);
    await emitV2({ eventType: "effect.authorized", aggregateType: "effect", aggregateId: effect.id, snapshot: updated, correlationId: effect.taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  // Semantic alias: commit a validated effect (VALIDATED → COMMITTED). Strict.
  route("POST", "/v2/effects/:id/commit", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const parsed = z.object({ expectedVersion: z.number().int().nonnegative().nullable().default(null) }).safeParse(await jsonBody(req));
    if (parsed.success && parsed.data.expectedVersion !== null && parsed.data.expectedVersion !== effect.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${parsed.data.expectedVersion} but effect is at version ${effect.version}`, "conflict");
    }
    if (effect.state !== "VALIDATED") {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `effect in state ${effect.state} cannot be committed; it must reach VALIDATED first`, "conflict", { from: effect.state });
    }
    const updated: EffectRecord = { ...effect, state: "COMMITTED", version: effect.version + 1, settledAt: nowTimestamp() };
    arpV2.effects.set(id, updated);
    await emitV2({ eventType: "effect.committed", aggregateType: "effect", aggregateId: id, snapshot: updated, correlationId: effect.taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/effects/:id/reconcile", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const parsed = z.object({
      observedOutcome: z.string().min(1),
      evidenceArtifactHash: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_RECONCILIATION", `invalid reconciliation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const outcomeTargets: Record<string, string> = {
      observed: "OBSERVED",
      validated: "VALIDATED",
      compensating: "COMPENSATING",
      manual_reconcile: "MANUAL_RECONCILE",
      committed: "COMMITTED",
    };
    const target = outcomeTargets[parsed.data.observedOutcome.toLowerCase()];
    if (!target) {
      return sendError(res, 400, "INVALID_RECONCILIATION", `unknown observedOutcome "${parsed.data.observedOutcome}"`, "validation");
    }
    if (effect.state === "UNCERTAIN") {
      const entered: EffectRecord = { ...effect, state: "RECONCILING", version: effect.version + 1 };
      arpV2.effects.set(id, entered);
      await emitV2({ eventType: "effect.reconciling", aggregateType: "effect", aggregateId: id, snapshot: entered, correlationId: effect.taskId });
    }
    const current = arpV2.effects.get(id)!;
    if (!isEffectTransitionAllowed(current.state, target as EffectRecord["state"])) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `illegal reconciliation ${current.state} -> ${target}`, "conflict", { from: current.state, to: target });
    }
    const updated: EffectRecord = { ...current, state: target as EffectRecord["state"], version: current.version + 1 };
    arpV2.effects.set(id, updated);
    await emitV2({ eventType: `effect.${target.toLowerCase()}`, aggregateType: "effect", aggregateId: id, snapshot: updated, correlationId: effect.taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/authorizations", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      taskVersion: z.number().int().nonnegative().default(1),
      effectClass: z.string().min(1),
      maxScope: z.array(z.string()).default([]),
      useLimit: z.number().int().positive().default(1),
      expiry: z.string().default(new Date(Date.now() + 300_000).toISOString()),
      approvalHash: z.string().nullable().default(null),
      humanApprovalId: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_AUTHORIZATION_REQUEST", `invalid authorization request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const body = parsed.data;
    if (!arpV2.tasks.has(body.taskId)) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${body.taskId} not found`, "not_found");
    }
    const authz: AuthorizationInstance = {
      id: uuid(),
      principal: SERVER_PRINCIPAL,
      taskId: body.taskId,
      taskVersion: body.taskVersion,
      effectClass: body.effectClass,
      maxScope: body.maxScope,
      useLimit: body.useLimit,
      consumedCount: 0,
      expiry: body.expiry as Rfc3339Timestamp,
      humanApprovalId: body.humanApprovalId,
      approvalHash: body.approvalHash,
    };
    arpV2.authorizations.set(authz.id, authz);
    await emitV2({
      eventType: "authorization.created",
      aggregateType: "authorization",
      aggregateId: authz.id,
      snapshot: authz,
      correlationId: authz.taskId,
    });
    sendJson(res, 201, jsonSafe(authz));
  }),
  route("GET", "/v2/authorizations/:id", async (_req, res, params) => {
    const authz = arpV2.authorizations.get(String(params.id));
    if (!authz) return sendError(res, 404, "AUTHORIZATION_NOT_FOUND", "v2 authorization not found", "not_found");
    sendJson(res, 200, jsonSafe(authz));
  }),
  route("GET", "/v2/authorizations", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const taskId = url.searchParams.get("taskId");
    const all = [...arpV2.authorizations.values()]
      .filter((a) => !taskId || a.taskId === taskId);
    sendJson(res, 200, { authorizations: jsonSafe(all) });
  }),
  route("POST", "/v2/authorizations/:id/consume", async (req, res, params) => {
    const id = String(params.id);
    const authz = arpV2.authorizations.get(id);
    if (!authz) return sendError(res, 404, "AUTHORIZATION_NOT_FOUND", "v2 authorization not found", "not_found");
    const parsed = z.object({
      taskId: z.string().min(1),
      taskVersion: z.number().int().nonnegative(),
      effectClass: z.string().min(1),
      approvalHash: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_CONSUME_REQUEST", "invalid consume request", "validation");
    }
    const { taskId, taskVersion, effectClass, approvalHash } = parsed.data;
    if (authz.taskId !== taskId) {
      return sendError(res, 403, "CROSS_TASK_REJECTED", `authorization ${id} is bound to task ${authz.taskId}`, "forbidden");
    }
    if (authz.taskVersion !== taskVersion) {
      return sendError(res, 409, "STALE_VERSION_REJECTED", `authorization ${id} is bound to task version ${authz.taskVersion}`, "conflict");
    }
    if (new Date().toISOString() >= authz.expiry) {
      return sendError(res, 410, "EXPIRED_AUTHORIZATION", `authorization ${id} is expired`, "gone");
    }
    if (authz.consumedCount >= authz.useLimit) {
      return sendError(res, 409, "EXHAUSTED_AUTHORIZATION", `authorization ${id} reached use limit ${authz.useLimit}`, "conflict");
    }
    if (authz.effectClass !== effectClass && authz.effectClass !== "ADMIN") {
      return sendError(res, 403, "EFFECT_CLASS_MISMATCH", `authorization authorizes ${authz.effectClass}, requested ${effectClass}`, "forbidden");
    }
    if (authz.approvalHash && approvalHash && authz.approvalHash !== approvalHash) {
      return sendError(res, 409, "APPROVAL_HASH_MISMATCH", "approval proposal was modified prior to execution", "conflict");
    }
    const updated: AuthorizationInstance = {
      ...authz,
      consumedCount: authz.consumedCount + 1,
    };
    arpV2.authorizations.set(id, updated);
    await emitV2({
      eventType: "authorization.consumed",
      aggregateType: "authorization",
      aggregateId: id,
      snapshot: updated,
      correlationId: authz.taskId,
    });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/authorizations/:id/revoke", async (req, res, params) => {
    const id = String(params.id);
    const authz = arpV2.authorizations.get(id);
    if (!authz) return sendError(res, 404, "AUTHORIZATION_NOT_FOUND", "v2 authorization not found", "not_found");
    const updated: AuthorizationInstance = {
      ...authz,
      useLimit: authz.consumedCount,
    };
    arpV2.authorizations.set(id, updated);
    await emitV2({
      eventType: "authorization.revoked",
      aggregateType: "authorization",
      aggregateId: id,
      snapshot: updated,
      correlationId: authz.taskId,
    });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/claims", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      statement: z.string().min(1),
      requiredEvidenceKind: z.string().min(1),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_CLAIM", `invalid claim: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    if (!arpV2.tasks.has(parsed.data.taskId)) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${parsed.data.taskId} not found`, "not_found");
    }
    const nowIso = nowTimestamp();
    const claim: Claim = {
      id: uuid(),
      taskId: parsed.data.taskId,
      statement: parsed.data.statement,
      requiredEvidenceKind: parsed.data.requiredEvidenceKind,
      status: "PROPOSED",
      evidenceIds: [],
      waivedRationale: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    arpV2.claims.set(claim.id, claim);
    await emitV2({ eventType: "claim.proposed", aggregateType: "claim", aggregateId: claim.id, snapshot: claim, correlationId: claim.taskId });
    sendJson(res, 201, jsonSafe(claim));
  }),
  route("POST", "/v2/claims/:id/waive", async (req, res, params) => {
    const id = String(params.id);
    const claim = arpV2.claims.get(id);
    if (!claim) return sendError(res, 404, "CLAIM_NOT_FOUND", "v2 claim not found", "not_found");
    const parsed = z.object({ rationale: z.string().min(1) }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_WAIVER", "a non-empty rationale is required to waive a claim", "validation");
    }
    const updated: Claim = { ...claim, status: "WAIVED", waivedRationale: parsed.data.rationale, updatedAt: nowTimestamp() };
    arpV2.claims.set(id, updated);
    await emitV2({ eventType: "claim.waived", aggregateType: "claim", aggregateId: id, snapshot: updated, correlationId: claim.taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/evidence", async (req, res) => {
    const parsed = z.object({
      claimId: z.string().min(1),
      kind: z.string().min(1),
      summary: z.string().min(1),
      verifierResult: z.string().min(1),
      sourceRevision: z.string().nullable().default(null),
      environmentHash: z.string().nullable().default(null),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_EVIDENCE", `invalid evidence record: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const claim = arpV2.claims.get(parsed.data.claimId);
    if (!claim) return sendError(res, 404, "CLAIM_NOT_FOUND", `v2 claim ${parsed.data.claimId} not found`, "not_found");
    const evidence: Evidence = {
      id: uuid(),
      claimId: claim.id,
      kind: parsed.data.kind,
      summary: parsed.data.summary,
      sourceRevision: parsed.data.sourceRevision,
      environmentHash: parsed.data.environmentHash,
      verifierResult: parsed.data.verifierResult,
      artifactRef: null,
      metadata: parsed.data.metadata,
      observedAt: nowTimestamp(),
    };
    arpV2.evidences.set(evidence.id, evidence);
    await emitV2({ eventType: "evidence.recorded", aggregateType: "evidence", aggregateId: evidence.id, snapshot: evidence, correlationId: claim.taskId });
    // A passing verifier satisfies the claim it evidences (SPEC §6).
    if (parsed.data.verifierResult.toLowerCase() === "pass" && claim.status === "PROPOSED") {
      const satisfied: Claim = { ...claim, status: "SATISFIED", evidenceIds: [...claim.evidenceIds, evidence.id], updatedAt: nowTimestamp() };
      arpV2.claims.set(claim.id, satisfied);
      await emitV2({ eventType: "claim.satisfied", aggregateType: "claim", aggregateId: claim.id, snapshot: satisfied, correlationId: claim.taskId });
    }
    sendJson(res, 201, jsonSafe(evidence));
  }),
  // ────────────────────────── /v2/workflows ─────────────────────────────────
  route("POST", "/v2/workflows", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      nodes: z.array(workflowNodeSchema).min(1),
      edges: z.array(guardedEdgeSchema).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_WORKFLOW", `invalid workflow: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    if (!arpV2.tasks.has(parsed.data.taskId)) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${parsed.data.taskId} not found`, "not_found");
    }
    const nodeIds = new Set(parsed.data.nodes.map((n) => n.id));
    if (nodeIds.size !== parsed.data.nodes.length) {
      return sendError(res, 400, "DUPLICATE_NODES", "workflow contains duplicate node IDs", "validation");
    }
    for (const e of parsed.data.edges) {
      if (!nodeIds.has(e.sourceNodeId) || !nodeIds.has(e.targetNodeId)) {
        return sendError(res, 400, "INVALID_EDGE", `edge connects unknown node (${e.sourceNodeId} -> ${e.targetNodeId})`, "validation");
      }
    }
    const nowIso = nowTimestamp();
    const workflow: Workflow = {
      id: uuid(),
      version: 1,
      taskId: parsed.data.taskId,
      nodes: parsed.data.nodes,
      edges: parsed.data.edges,
      createdAt: nowIso,
    };
    arpV2.workflows.set(workflow.id, workflow);
    await emitV2({ eventType: "workflow.created", aggregateType: "workflow", aggregateId: workflow.id, snapshot: workflow, correlationId: workflow.taskId });
    sendJson(res, 201, jsonSafe(workflow));
  }),
  route("GET", "/v2/workflows/:id", async (_req, res, params) => {
    const wf = arpV2.workflows.get(String(params.id));
    if (!wf) return sendError(res, 404, "WORKFLOW_NOT_FOUND", "workflow not found", "not_found");
    sendJson(res, 200, jsonSafe(wf));
  }),
  route("POST", "/v2/workflows/:id/nodes/:nodeId/execute", async (req, res, params) => {
    const wf = arpV2.workflows.get(String(params.id));
    if (!wf) return sendError(res, 404, "WORKFLOW_NOT_FOUND", "workflow not found", "not_found");
    const node = wf.nodes.find((n) => n.id === params.nodeId);
    if (!node) return sendError(res, 404, "NODE_NOT_FOUND", `node ${params.nodeId} not found in workflow`, "not_found");
    const parsed = z.object({
      attemptId: z.string().min(1),
      inputs: z.record(z.string(), z.unknown()).default({}),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_NODE_EXECUTION", "invalid node execution request", "validation");
    }
    const nowIso = nowTimestamp();
    const nodeRun: NodeRun = {
      id: uuid(),
      workflowId: wf.id,
      nodeId: node.id,
      attemptId: parsed.data.attemptId,
      status: "RUNNING",
      inputs: { ...node.inputs, ...parsed.data.inputs },
      outputs: null,
      error: null,
      startedAt: nowIso,
      settledAt: null,
    };
    arpV2.nodeRuns.set(nodeRun.id, nodeRun);
    await emitV2({ eventType: "workflow.node_started", aggregateType: "node_run", aggregateId: nodeRun.id, snapshot: nodeRun, correlationId: wf.taskId });
    sendJson(res, 201, jsonSafe(nodeRun));
  }),
  route("POST", "/v2/workflows/:id/nodes/:nodeRunId/complete", async (req, res, params) => {
    const run = arpV2.nodeRuns.get(String(params.nodeRunId));
    if (!run) return sendError(res, 404, "NODE_RUN_NOT_FOUND", "node run not found", "not_found");
    if (!isNodeRunTransitionAllowed(run.status, "COMPLETED")) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot transition node run from ${run.status} to COMPLETED`, "conflict");
    }
    const parsed = z.object({ outputs: z.record(z.string(), z.unknown()).default({}) }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_COMPLETION", "invalid completion outputs", "validation");
    const updated: NodeRun = { ...run, status: "COMPLETED", outputs: parsed.data.outputs, settledAt: nowTimestamp() };
    arpV2.nodeRuns.set(run.id, updated);
    await emitV2({ eventType: "workflow.node_completed", aggregateType: "node_run", aggregateId: run.id, snapshot: updated, correlationId: run.workflowId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/workflows/:id/nodes/:nodeRunId/fail", async (req, res, params) => {
    const run = arpV2.nodeRuns.get(String(params.nodeRunId));
    if (!run) return sendError(res, 404, "NODE_RUN_NOT_FOUND", "node run not found", "not_found");
    if (!isNodeRunTransitionAllowed(run.status, "FAILED")) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot transition node run from ${run.status} to FAILED`, "conflict");
    }
    const parsed = z.object({ error: z.string().min(1) }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_FAILURE", "error message is required", "validation");
    const updated: NodeRun = { ...run, status: "FAILED", error: parsed.data.error, settledAt: nowTimestamp() };
    arpV2.nodeRuns.set(run.id, updated);
    await emitV2({ eventType: "workflow.node_failed", aggregateType: "node_run", aggregateId: run.id, snapshot: updated, correlationId: run.workflowId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  // ────────────────────────── /v2/leases ────────────────────────────────────
  route("POST", "/v2/leases/acquire", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      workerId: z.string().min(1),
      ttlSeconds: z.number().int().positive().default(30),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_LEASE_REQUEST", "invalid lease acquire payload", "validation");
    const { taskId, workerId, ttlSeconds } = parsed.data;
    if (!arpV2.tasks.has(taskId)) return sendError(res, 404, "TASK_NOT_FOUND", `task ${taskId} not found`, "not_found");

    // Monotonic fencing token per task
    let maxFencingToken = 0;
    for (const lease of arpV2.workerLeases.values()) {
      if (lease.taskId === taskId) {
        maxFencingToken = Math.max(maxFencingToken, lease.fencingToken);
        if (lease.status === "ACQUIRED" || lease.status === "RENEWED") {
          const fenced: WorkerLease = { ...lease, status: "FENCED" };
          arpV2.workerLeases.set(lease.id, fenced);
          await emitV2({ eventType: "lease.fenced", aggregateType: "lease", aggregateId: lease.id, snapshot: fenced, correlationId: taskId });
        }
      }
    }

    const now = new Date();
    const expires = new Date(now.getTime() + ttlSeconds * 1000);
    const newLease: WorkerLease = {
      id: uuid(),
      taskId,
      workerId,
      fencingToken: maxFencingToken + 1,
      status: "ACQUIRED",
      acquiredAt: now.toISOString() as Rfc3339Timestamp,
      expiresAt: expires.toISOString() as Rfc3339Timestamp,
      releasedAt: null,
      metadata: {},
    };
    arpV2.workerLeases.set(newLease.id, newLease);
    await emitV2({ eventType: "lease.acquired", aggregateType: "lease", aggregateId: newLease.id, snapshot: newLease, correlationId: taskId });
    sendJson(res, 201, jsonSafe(newLease));
  }),
  route("POST", "/v2/leases/renew", async (req, res) => {
    const parsed = z.object({
      leaseId: z.string().min(1),
      fencingToken: z.number().int().positive(),
      workerId: z.string().min(1),
      ttlSeconds: z.number().int().positive().default(30),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_RENEW_REQUEST", "invalid lease renew payload", "validation");
    const { leaseId, fencingToken, workerId, ttlSeconds } = parsed.data;
    const lease = arpV2.workerLeases.get(leaseId);
    if (!lease) return sendError(res, 404, "LEASE_NOT_FOUND", "lease not found", "not_found");
    if (lease.workerId !== workerId || lease.fencingToken !== fencingToken) {
      return sendError(res, 409, "FENCING_ERROR", "worker or fencing token mismatch", "conflict");
    }
    if (!isLeaseTransitionAllowed(lease.status, "RENEWED")) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot renew lease in status ${lease.status}`, "conflict");
    }
    const now = new Date();
    const expires = new Date(now.getTime() + ttlSeconds * 1000);
    const updated: WorkerLease = {
      ...lease,
      status: "RENEWED",
      expiresAt: expires.toISOString() as Rfc3339Timestamp,
    };
    arpV2.workerLeases.set(lease.id, updated);
    await emitV2({ eventType: "lease.renewed", aggregateType: "lease", aggregateId: lease.id, snapshot: updated, correlationId: lease.taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/leases/release", async (req, res) => {
    const parsed = z.object({
      leaseId: z.string().min(1),
      fencingToken: z.number().int().positive(),
      workerId: z.string().min(1),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_RELEASE_REQUEST", "invalid lease release payload", "validation");
    const { leaseId, fencingToken, workerId } = parsed.data;
    const lease = arpV2.workerLeases.get(leaseId);
    if (!lease) return sendError(res, 404, "LEASE_NOT_FOUND", "lease not found", "not_found");
    if (lease.workerId !== workerId || lease.fencingToken !== fencingToken) {
      return sendError(res, 409, "FENCING_ERROR", "worker or fencing token mismatch", "conflict");
    }
    const updated: WorkerLease = { ...lease, status: "RELEASED" };
    arpV2.workerLeases.set(lease.id, updated);
    await emitV2({ eventType: "lease.released", aggregateType: "lease", aggregateId: lease.id, snapshot: updated, correlationId: lease.taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("GET", "/v2/leases/:taskId", async (_req, res, params) => {
    const active = [...arpV2.workerLeases.values()]
      .filter((l) => l.taskId === params.taskId && (l.status === "ACQUIRED" || l.status === "RENEWED"))
      .pop();
    if (!active) return sendError(res, 404, "NO_ACTIVE_LEASE", `no active lease for task ${params.taskId}`, "not_found");
    sendJson(res, 200, jsonSafe(active));
  }),
  // ────────────────────────── /v2/tasks/:id/attempts ────────────────────────
  route("POST", "/v2/tasks/:id/attempts/start", async (req, res, params) => {
    const taskId = String(params.id);
    const parsed = z.object({
      workerId: z.string().min(1),
      fencingToken: z.number().int().positive(),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_ATTEMPT_REQUEST", "invalid start attempt payload", "validation");
    const { workerId, fencingToken } = parsed.data;
    const lease = [...arpV2.workerLeases.values()]
      .find((l) => l.taskId === taskId && l.workerId === workerId && l.fencingToken === fencingToken && (l.status === "ACQUIRED" || l.status === "RENEWED"));
    if (!lease) {
      return sendError(res, 403, "FENCING_ERROR", "worker does not hold active valid lease with matching fencing token", "auth");
    }
    const attempts = [...arpV2.attempts.values()].filter((a) => a.taskId === taskId);
    const attempt: TaskAttempt = {
      id: uuid(),
      taskId,
      attemptNumber: attempts.length + 1,
      workerId,
      fencingToken,
      status: "RUNNING",
      startedAt: nowTimestamp(),
      settledAt: null,
      error: null,
    };
    arpV2.attempts.set(attempt.id, attempt);
    await emitV2({ eventType: "attempt.started", aggregateType: "attempt", aggregateId: attempt.id, snapshot: attempt, correlationId: taskId });
    sendJson(res, 201, jsonSafe(attempt));
  }),
  route("POST", "/v2/tasks/:id/attempts/:attemptId/settle", async (req, res, params) => {
    const attempt = arpV2.attempts.get(String(params.attemptId));
    if (!attempt) return sendError(res, 404, "ATTEMPT_NOT_FOUND", "attempt not found", "not_found");
    const parsed = z.object({
      status: z.enum(["COMPLETED", "FAILED"]),
      error: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_SETTLEMENT", "invalid settlement payload", "validation");
    if (!isAttemptTransitionAllowed(attempt.status, parsed.data.status)) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot transition attempt from ${attempt.status} to ${parsed.data.status}`, "conflict");
    }
    const updated: TaskAttempt = {
      ...attempt,
      status: parsed.data.status,
      error: parsed.data.error,
      settledAt: nowTimestamp(),
    };
    arpV2.attempts.set(attempt.id, updated);
    const eventType = parsed.data.status === "COMPLETED" ? "attempt.completed" : "attempt.failed";
    await emitV2({ eventType, aggregateType: "attempt", aggregateId: attempt.id, snapshot: updated, correlationId: attempt.taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  // ────────────────────────── /v2/questions ─────────────────────────────────
  route("POST", "/v2/questions", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      prompt: z.string().min(1),
      options: z.array(z.string()).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_QUESTION", "invalid question payload", "validation");
    const q: Question = {
      id: uuid(),
      taskId: parsed.data.taskId,
      prompt: parsed.data.prompt,
      options: parsed.data.options,
      selectedOption: null,
      rationale: null,
      status: "PENDING",
      createdAt: nowTimestamp(),
      resolvedAt: null,
    };
    arpV2.questions.set(q.id, q);
    await emitV2({ eventType: "question.asked", aggregateType: "question", aggregateId: q.id, snapshot: q, correlationId: q.taskId });
    sendJson(res, 201, jsonSafe(q));
  }),
  route("POST", "/v2/questions/:id/answer", async (req, res, params) => {
    const q = arpV2.questions.get(String(params.id));
    if (!q) return sendError(res, 404, "QUESTION_NOT_FOUND", "question not found", "not_found");
    const parsed = z.object({
      selectedOption: z.string().min(1),
      rationale: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_ANSWER", "invalid question answer payload", "validation");
    const updated: Question = {
      ...q,
      selectedOption: parsed.data.selectedOption,
      rationale: parsed.data.rationale,
      status: "ANSWERED",
      resolvedAt: nowTimestamp(),
    };
    arpV2.questions.set(q.id, updated);
    await emitV2({ eventType: "question.answered", aggregateType: "question", aggregateId: q.id, snapshot: updated, correlationId: q.taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/questions/:id/dismiss", async (_req, res, params) => {
    const q = arpV2.questions.get(String(params.id));
    if (!q) return sendError(res, 404, "QUESTION_NOT_FOUND", "question not found", "not_found");
    const updated: Question = { ...q, status: "DISMISSED", resolvedAt: nowTimestamp() };
    arpV2.questions.set(q.id, updated);
    await emitV2({ eventType: "question.dismissed", aggregateType: "question", aggregateId: q.id, snapshot: updated, correlationId: q.taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  // ────────────────────────── /v2/decisions ─────────────────────────────────
  route("POST", "/v2/decisions", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      statement: z.string().min(1),
      rationale: z.string().min(1),
      provenance: z.string().min(1),
      questionId: z.string().nullable().default(null),
      alternativesConsidered: z.array(z.string()).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_DECISION", "invalid decision payload", "validation");
    const d: Decision = {
      id: uuid(),
      taskId: parsed.data.taskId,
      questionId: parsed.data.questionId,
      statement: parsed.data.statement,
      alternativesConsidered: parsed.data.alternativesConsidered,
      rationale: parsed.data.rationale,
      provenance: parsed.data.provenance,
      recordedAt: nowTimestamp(),
    };
    arpV2.decisions.set(d.id, d);
    await emitV2({ eventType: "decision.recorded", aggregateType: "decision", aggregateId: d.id, snapshot: d, correlationId: d.taskId });
    sendJson(res, 201, jsonSafe(d));
  }),
  // ────────────────────────── /v2/risks ─────────────────────────────────────
  route("POST", "/v2/risks", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      riskClass: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]),
      statement: z.string().min(1),
      mitigation: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_RISK", "invalid risk payload", "validation");
    const r: Risk = {
      id: uuid(),
      taskId: parsed.data.taskId,
      riskClass: parsed.data.riskClass,
      statement: parsed.data.statement,
      mitigation: parsed.data.mitigation,
      status: parsed.data.mitigation ? "MITIGATED" : "IDENTIFIED",
      recordedAt: nowTimestamp(),
    };
    arpV2.risks.set(r.id, r);
    await emitV2({ eventType: "risk.recorded", aggregateType: "risk", aggregateId: r.id, snapshot: r, correlationId: r.taskId });
    sendJson(res, 201, jsonSafe(r));
  }),
  route("POST", "/v2/risks/:id/mitigate", async (req, res, params) => {
    const r = arpV2.risks.get(String(params.id));
    if (!r) return sendError(res, 404, "RISK_NOT_FOUND", "risk not found", "not_found");
    const parsed = z.object({ mitigation: z.string().min(1) }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_MITIGATION", "mitigation text is required", "validation");
    const updated: Risk = { ...r, mitigation: parsed.data.mitigation, status: "MITIGATED" };
    arpV2.risks.set(r.id, updated);
    await emitV2({ eventType: "risk.mitigated", aggregateType: "risk", aggregateId: r.id, snapshot: updated, correlationId: r.taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  // ────────────────────────── /v2/tasks/:id/budget ──────────────────────────
  route("POST", "/v2/tasks/:id/budget/consume", async (req, res, params) => {
    const taskId = String(params.id);
    const task = arpV2.tasks.get(taskId);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", `task ${taskId} not found`, "not_found");
    const parsed = z.object({
      costMicros: z.union([z.string(), z.number()]).transform((v) => BigInt(v)).default(0n),
      computeSeconds: z.number().default(0),
      inputTokens: z.union([z.string(), z.number()]).transform((v) => BigInt(v)).default(0n),
      outputTokens: z.union([z.string(), z.number()]).transform((v) => BigInt(v)).default(0n),
      approvals: z.number().int().default(0),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_BUDGET_CONSUMPTION", "invalid budget consumption delta", "validation");

    const current = arpV2.budgets.get(taskId) ?? {
      taskId,
      consumedCostMicros: 0n,
      consumedComputeSeconds: 0,
      consumedInputTokens: 0n,
      consumedOutputTokens: 0n,
      consumedApprovals: 0,
      lastUpdatedAt: nowTimestamp(),
    };
    const updated: BudgetConsumption = {
      taskId,
      consumedCostMicros: current.consumedCostMicros + parsed.data.costMicros,
      consumedComputeSeconds: current.consumedComputeSeconds + parsed.data.computeSeconds,
      consumedInputTokens: current.consumedInputTokens + parsed.data.inputTokens,
      consumedOutputTokens: current.consumedOutputTokens + parsed.data.outputTokens,
      consumedApprovals: current.consumedApprovals + parsed.data.approvals,
      lastUpdatedAt: nowTimestamp(),
    };

    const costLimit = task.contract.constraints.costMicros;
    if (costLimit > 0n && updated.consumedCostMicros > costLimit) {
      arpV2.budgets.set(taskId, updated);
      await emitV2({
        eventType: "budget.exhausted",
        aggregateType: "budget",
        aggregateId: taskId,
        snapshot: updated,
        correlationId: taskId,
      });
      return sendError(res, 429, "BUDGET_EXHAUSTED", `cost budget exceeded: ${updated.consumedCostMicros} > ${costLimit}`, "rate_limit");
    }

    arpV2.budgets.set(taskId, updated);
    await emitV2({ eventType: "budget.consumed", aggregateType: "budget", aggregateId: taskId, snapshot: updated, correlationId: taskId });
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("GET", "/v2/tasks/:id/budget", async (_req, res, params) => {
    const taskId = String(params.id);
    const b = arpV2.budgets.get(taskId) ?? {
      taskId,
      consumedCostMicros: 0n,
      consumedComputeSeconds: 0,
      consumedInputTokens: 0n,
      consumedOutputTokens: 0n,
      consumedApprovals: 0,
      lastUpdatedAt: nowTimestamp(),
    };
    sendJson(res, 200, jsonSafe(b));
  }),
  route("GET", "/v2/events", async (req, res) => {
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
    const taskId = url.searchParams.get("taskId");
    const aggregateType = url.searchParams.get("aggregateType");

    const filter = (ev: StoredEvent) => {
      if (ev.schemaVersion !== 2) return false;
      if (aggregateType && ev.aggregateType !== aggregateType) return false;
      if (taskId) {
        return ev.aggregateId === taskId
          || ev.correlationId === taskId
          || (ev.payloadJson.includes(taskId) && ev.aggregateType !== "evidence");
      }
      return true;
    };

    if (cursor) {
      const replayed = await bus.replay(cursor, filter);
      for (const ev of replayed) {
        res.write(`id: ${ev.eventId}\nevent: ${ev.eventType}\ndata: ${JSON.stringify(storedEventToEnvelopeV2(ev))}\n\n`);
      }
    }

    const unsubscribe = bus.subscribe(filter, (ev) => {
      res.write(`id: ${ev.eventId}\nevent: ${ev.eventType}\ndata: ${JSON.stringify(storedEventToEnvelopeV2(ev))}\n\n`);
    });

    const heartbeat = setInterval(() => {
      try { res.write(`:heartbeat ${Date.now()}\n\n`); } catch { /* ignore */ }
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }),
];

/** JSON.parse with a fallback so a corrupt stored value never crashes the API. */
function safeParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeRiskClass(value: string): TaskSnapshot["contract"]["riskClass"] {
  return value === "low" || value === "high" || value === "critical" ? value : "normal";
}

function localProviderSnapshot(observedAt: Rfc3339Timestamp): ProviderCapabilitySnapshot {
  return {
    providerId: "local",
    observedAt,
    source: "terminus-control/local-deterministic-v1",
    context: {
      advertisedTokens: 16_384,
      testedSafeTokens: 8_192,
      roleSupport: ["system", "user", "assistant", "tool"],
      imageInput: false,
      toolCalling: false,
      parallelToolCalls: false,
      structuredOutput: true,
    },
    continuation: {
      nativeId: false,
      crossRequest: false,
      compaction: true,
      compatibilityKey: "local-deterministic-v1",
    },
    caching: {
      mode: "explicit_breakpoints",
      exactPrefixRequired: true,
      minimumTokens: 0,
      ttlOptions: [],
      toolOrderSensitive: false,
      usageReporting: false,
    },
    reasoning: { supported: false, budgetControl: false, summaryAvailable: false },
    economics: {
      inputMicrosPerMillion: 0n as Micros,
      cachedInputMicrosPerMillion: 0n as Micros,
      outputMicrosPerMillion: 0n as Micros,
      reasoningAccounting: false,
    },
    reliability: {
      toolCallSuccess: 1,
      structuredOutputSuccess: 1,
      editCohortSuccess: 1,
      latencyPercentiles: { p50: 0, p99: 0 },
    },
    policy: {
      allowedConfidentiality: ["public", "workspace"],
      retentionMode: "local_only",
      region: null,
    },
  };
}

function makeContextBudget(
  provider: ProviderCapabilitySnapshot,
  taskBudget: TaskSnapshot["contract"]["budget"],
): ContextBudget {
  const hard = BigInt(provider.context.testedSafeTokens) as TokenCount;
  const output = 1024n as TokenCount;
  const reasoning = 0n as TokenCount;
  const toolResult = 512n as TokenCount;
  const recovery = 256n as TokenCount;
  const reserved = output + reasoning + toolResult + recovery;
  const optional = hard > reserved ? hard - reserved : 0n;
  return {
    modelAdvertisedTokens: BigInt(provider.context.advertisedTokens) as TokenCount,
    testedSafeTokens: hard,
    protocolOverheadTokens: 128n as TokenCount,
    exactContextTokens: 0n as TokenCount,
    optionalContextTarget: optional as TokenCount,
    expectedToolResultReserve: toolResult,
    outputReserve: output,
    reasoningReserve: reasoning,
    recoveryMargin: recovery,
    hardInputLimit: hard,
    hardCostMicros: taskBudget.modelMicros,
  };
}

const EMPTY_CONTEXT_HASH = ("sha256:" + "0".repeat(64)) as ContentHash;

interface EnsureContextEpochInput {
  readonly db: PrismaClient;
  readonly threadId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly provider: ProviderCapabilitySnapshot;
  readonly model: ModelCapabilitySnapshot;
  readonly worldState: WorldStateSnapshot;
  readonly artifacts: ArtifactClient;
}

/**
 * Creates or resumes the durable context epoch before compilation. The epoch
 * snapshot and baseline are kernel artifacts; Prisma stores only their URIs.
 */
async function ensureContextEpoch(
  input: EnsureContextEpochInput,
): Promise<ContextEpochSnapshot> {
  const active = await input.db.contextEpoch.findFirst({
    where: { threadId: input.threadId, state: "active" },
    orderBy: { generation: "desc" },
  });
  if (active !== null && active.providerCompatibilityKey === input.provider.continuation.compatibilityKey) {
    return {
      epochId: active.id as ContextEpochSnapshot["epochId"],
      threadId: active.threadId as ContextEpochSnapshot["threadId"],
      sequence: active.generation,
      baselineHash: active.baselineHash as ContentHash,
      provider: input.provider.providerId,
      model: input.model.modelKey,
      continuationId: null,
      startedAt: active.createdAt.toISOString() as Rfc3339Timestamp,
    };
  }

  const snapshot = await ingestJsonArtifact(
    input.artifacts,
    {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      provider: input.provider.providerId,
      model: input.model.modelKey,
      sourceVersions: input.worldState.sourceVersions,
      sections: input.worldState.sections,
      observedAt: input.worldState.observedAt,
    },
    "context-epoch-snapshot",
    { taskId: input.taskId, workspaceId: input.workspaceId },
  );
  const latest = await input.db.contextEpoch.findFirst({
    where: { threadId: input.threadId },
    orderBy: { generation: "desc" },
  });
  const epochId = generateUuid7();
  const generation = (latest?.generation ?? 0) + 1;
  await input.db.$transaction(async (tx) => {
    if (active !== null) {
      await tx.contextEpoch.update({
        where: { id: active.id },
        data: {
          state: "sealed",
          sealedAt: new Date(),
          sealReason: "provider compatibility changed",
        },
      });
    }
    await tx.contextEpoch.create({
      data: {
        id: epochId,
        threadId: input.threadId,
        generation,
        providerCompatibilityKey: input.provider.continuation.compatibilityKey,
        baselineArtifact: snapshot.uri,
        baselineHash: EMPTY_CONTEXT_HASH,
        snapshotArtifact: snapshot.uri,
        state: "active",
      },
    });
    await tx.thread.update({
      where: { id: input.threadId },
      data: { activeContextEpochId: epochId },
    });
  });
  return {
    epochId,
    threadId: input.threadId as ContextEpochSnapshot["threadId"],
    sequence: generation,
    baselineHash: EMPTY_CONTEXT_HASH,
    provider: input.provider.providerId,
    model: input.model.modelKey,
    continuationId: null,
    startedAt: new Date().toISOString() as Rfc3339Timestamp,
  };
}

async function ingestJsonArtifact(
  artifacts: ArtifactClient,
  value: unknown,
  purpose: string,
  scope: Readonly<Record<string, unknown>>,
): Promise<Awaited<ReturnType<ArtifactClient["ingest"]>>> {
  return artifacts.ingest(
    new TextEncoder().encode(canonicalJson(value)),
    { mediaType: "application/json", custom: { purpose, ...scope } },
  );
}

/** Kernel-backed code-intelligence retrieval for the live compiler path. */
function kernelRetrievalPipeline(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  observedAt: Rfc3339Timestamp,
  modelKey: ModelKey,
  sessionId: string,
  taskId: string,
): RetrievalPipeline {
  const retrieve = async (queries: readonly RetrievalQuery[]): Promise<readonly RetrievalResult[]> => {
    const results: RetrievalResult[] = [];
    const seen = new Set<string>();
    for (const query of queries) {
      const response = await clients.codeIntel.Search({
        context: {
          ...baseContext,
          requestId: randomUUID(),
          idempotencyKey: `code-search:${randomUUID()}`,
        },
        // The kernel code-intel index stores workspace-relative paths. An
        // empty filter asks it to search the authorized workspace index.
        workspaceId: "",
        query: query.text,
        limit: 5,
      });
      if (response.truncated) {
        throw new Error(
          `code-intelligence retrieval truncated for query ${JSON.stringify(query.text)}${response.continuation === undefined ? " without a continuation token" : "; continuation RPC is unavailable"}`,
        );
      }
      for (const hit of response.results) {
        const id = `kernel-code:${hit.path}:${hit.line}:${hit.symbol}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const text = [
          `# Code intelligence result`,
          `path: ${hit.path}`,
          `line: ${hit.line}`,
          `symbol: ${hit.symbol}`,
          `index method: ${hit.method}`,
        ].join("\n");
        const hash = computeContentHash(text);
        const fragment: ContextFragment = {
          id,
          kind: "code",
          contentRef: {
            hash,
            uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ContextFragment["contentRef"]["uri"],
            mediaType: "text/plain",
            bytes: BigInt(new TextEncoder().encode(text).byteLength) as ContextFragment["contentRef"]["bytes"],
          },
          textContent: text,
          source: {
            uri: `workspace://${hit.path}`,
            producer: "terminus-kernel-code-intel",
            producerVersion: "v1",
            observedAt,
            observedBy: "kernel",
            evidenceRefs: [],
          },
          sourceVersion: null,
          authority: 55,
          priority: 55,
          trust: "derived",
          confidentiality: "workspace",
          injectionRisk: "low",
          exactness: "recoverable_by_reference",
          scope: {
            workspaceId: null,
            sessionId: sessionId as ContextFragment["scope"]["sessionId"],
            taskId: taskId as ContextFragment["scope"]["taskId"],
            pathPatterns: [hit.path],
          },
          freshness: { observedAt, sourceVersion: null, stale: false, staleReason: null },
          dependencies: [],
          invalidation: [{ kind: "file_changed", selector: hit.path }],
          estimatedTokens: { [modelKey]: Math.max(1, Math.ceil(text.length / 4)) },
          selectionFeatures: {
            relevance: query.suggestedMethods.includes(mapRetrievalMethod(hit.method)) ? 0.9 : 0.6,
            novelty: 0.7,
            coverage: 0.8,
            uncertaintyReduction: 0.7,
            riskReduction: 0.5,
            modelCompatibility: 1,
            redundancyPenalty: 0,
            injectionPenalty: 0,
          },
        };
        results.push({
          fragment,
          method: mapRetrievalMethod(hit.method),
          rawScore: 1,
          rerankedScore: 1,
          sourceVersion: null,
          reason: query.reason,
        });
      }
    }
    return results;
  };
  return {
    retrieve: (queries) => retrieve(queries),
    expandForGaps: (gaps) => retrieve(gaps.map((gap) => ({
      text: gap.requirement,
      reason: `evidence gap: ${gap.requirementId}`,
      suggestedMethods: ["lexical_bm25"],
    }))),
  };
}

function mapRetrievalMethod(method: string): RetrievalMethod {
  switch (method) {
    case "tree_sitter":
    case "lsp":
    case "graph":
      return method === "graph" ? "dependency_graph" : method;
    case "lexical_bm25":
      return method;
    default:
      return "lexical_bm25";
  }
}

// ────────────────────────── Agent loop ─────────────────────────────────────

/**
 * The agent loop: compile context → provider attempt → tool settlement →
 * verification → completion. Each step emits semantic events so the UI can
 * observe the full trajectory.
 *
 * The local profile is deterministic, but it still uses the same artifact,
 * compiler, renderer, manifest, and observation boundaries as a remote
 * provider. No provider-visible bytes or effect records are fabricated.
 */
async function agentLoop(turnId: string, userInput: string): Promise<void> {
  const turn = await db.turn.findUnique({
    where: { id: turnId },
    include: {
      task: { include: { contractVersions: { orderBy: { version: "desc" }, take: 1 } } },
      thread: { include: { session: { include: { workspace: true } } } },
    },
  });
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
    const task = turn.task;
    const contractRow = task?.contractVersions[0];
    if (task === null || contractRow === undefined) {
      throw new Error(`turn ${turnId} has no active task contract`);
    }
    const criteriaRows = await db.acceptanceCriterion.findMany({
      where: { taskId: task.id, contractVersion: contractRow.version },
      orderBy: { criterionId: "asc" },
    });
    const budgetJson = safeParse<Record<string, unknown>>(task.budgetJson, {});
    const scopeJson = safeParse<Record<string, unknown>>(task.scopeDigest, {});
    const allowedScope = {
      readPaths: readStringArray(scopeJson.read_paths ?? scopeJson.readPaths),
      writePaths: readStringArray(scopeJson.write_paths ?? scopeJson.writePaths),
      externalSystems: readStringArray(scopeJson.external_systems ?? scopeJson.externalSystems),
    };
    const taskSnapshot: TaskSnapshot = {
      taskId: task.id as TaskSnapshot["taskId"],
      contract: {
        id: task.id as TaskSnapshot["contract"]["id"],
        version: contractRow.version,
        objective: contractRow.objective,
        userOutcome: contractRow.userOutcome,
        nonGoals: safeParse<string[]>(contractRow.nonGoalsJson, []),
        acceptanceCriteria: criteriaRows.map((criterion) => ({
          id: criterion.criterionId,
          statement: criterion.statement,
          verificationHint: criterion.verificationHint,
          required: criterion.required,
        })),
        constraints: safeParse<string[]>(contractRow.constraintsJson, []),
        assumptions: safeParse<string[]>(contractRow.assumptionsJson, []),
        unknowns: safeParse<string[]>(contractRow.unknownsJson, []),
        allowedScope,
        riskClass: normalizeRiskClass(task.riskClass),
        budget: {
          modelMicros: BigInt(String(budgetJson.model_micros ?? 5_000_000)) as Micros,
          computeSeconds: numberOr(budgetJson.compute_seconds, 600),
          wallClockSeconds: numberOr(budgetJson.wall_clock_seconds, 3600),
          humanApprovals: numberOr(budgetJson.human_approvals, 20),
        },
        changePolicy: safeParse(contractRow.changePolicyJson, {
          mayExpandScope: false,
          scopeExpansionRequiresUser: true,
        }),
      },
      phase: task.phase,
      changedFiles: [],
      failingTests: [],
      diagnostics: [],
      unknowns: safeParse<string[]>(contractRow.unknownsJson, []),
    };

    const workspace = turn.thread.session.workspace;
    const artifactContext: RequestContext = {
      ...kernelContext(),
      sessionId: turn.thread.sessionId,
      taskId: task.id,
      turnId,
      workspaceId: workspace.id,
      idempotencyKey: `context:${turnId}`,
    };
    const artifactClient = createKernelArtifactClient(requireKernelUds().artifacts, artifactContext);
    const inputArtifact = await artifactClient.ingest(
      new TextEncoder().encode(userInput),
      {
        mediaType: "text/plain",
        custom: { purpose: "turn-input", sessionId: task.sessionId, taskId: task.id, turnId },
      },
    );
    await db.turn.update({
      where: { id: turnId },
      data: { initiatingInputArtifact: inputArtifact.uri },
    });
    await db.episode.create({
      data: {
        id: uuid(),
        turnId,
        sequence: 1,
        kind: "user_message",
        modelVisible: true,
        contentArtifact: inputArtifact.uri,
        sourceVersionsJson: JSON.stringify({ input: inputArtifact.hash }),
      },
    });

    const worldState: WorldStateSnapshot = {
      observedAt: now(),
      sourceVersions: {
        [`task://${task.id}`]: contractRow.contentHash,
        [`workspace://${workspace.id}`]: workspace.lastOpenedAt.toISOString(),
        "policy://secure-local-default": "v1",
      },
      sections: {
        request: { text: userInput, artifact: inputArtifact.uri },
        task: { id: task.id, status: task.status, phase: task.phase, contractVersion: contractRow.version },
        workspace: { id: workspace.id, rootUri: workspace.rootUri, trust: workspace.trust },
        verification: { status: "pending", acceptanceCriteria: criteriaRows.map((criterion) => criterion.criterionId) },
        memory: { enabled: false, reason: "memory precision/harm gate not promoted" },
      },
    };
    const recentEpisodes: Episode[] = (await db.episode.findMany({
      where: { turnId, modelVisible: true },
      orderBy: { sequence: "asc" },
      take: 16,
    })).map((episode) => ({
      id: episode.id as Episode["id"],
      turnId: episode.turnId as Episode["turnId"],
      sequence: episode.sequence,
      kind: episode.kind as Episode["kind"],
      contentRef: episode.contentArtifact?.startsWith("artifact://")
        ? (`sha256:${episode.contentArtifact.slice("artifact://sha256/".length)}` as ContentHash)
        : null,
      providerAttemptId: null,
      toolCallId: episode.toolCallId as Episode["toolCallId"],
      occurredAt: episode.createdAt.toISOString() as Rfc3339Timestamp,
    }));
    const checkpointRow = await db.checkpoint.findFirst({
      where: { threadId: turn.threadId },
      orderBy: { createdAt: "desc" },
    });
    const approvalRows = await db.approval.findMany({
      where: { taskId: task.id },
      orderBy: { requestedAt: "asc" },
    });
    const checkpoint: Checkpoint | null = checkpointRow === null ? null : {
      id: checkpointRow.id as Checkpoint["id"],
      threadId: checkpointRow.threadId as Checkpoint["threadId"],
      turnId: checkpointRow.taskId === null ? null : turnId as Checkpoint["turnId"],
      episodeRange: safeParse(checkpointRow.lastCommittedSequencesJson, { from: 0, to: 0 }),
      artifactHash: checkpointRow.checkpointArtifact.startsWith("artifact://")
        ? (`sha256:${checkpointRow.checkpointArtifact.slice("artifact://sha256/".length)}` as ContentHash)
        : checkpointRow.checkpointArtifact as ContentHash,
      canonicalStateHash: checkpointRow.dirtyStateDigest as ContentHash ?? ("sha256:" + "0".repeat(64)) as ContentHash,
      summary: "Durable checkpoint recovered from the control-plane store.",
      effectState: safeParse<Array<{ effectId: string; state: string; idempotencyKey: string }>>(
        checkpointRow.unsettledEffectsJson,
        [],
      ),
      approvalState: approvalRows.map((approval) => ({
        approvalId: approval.id,
        state: approval.status,
        operationHash: approval.operationHash,
      })),
      createdAt: checkpointRow.createdAt.toISOString() as Rfc3339Timestamp,
    };
    const localProvider = localProviderSnapshot(now());
    const localModel: ModelCapabilitySnapshot = {
      modelKey: "local/deterministic" as ModelKey,
      providerId: localProvider.providerId,
      snapshot: localProvider,
      observedAt: localProvider.observedAt,
    };
    const contextBudget = makeContextBudget(localProvider, taskSnapshot.contract.budget);
    const threadSnapshot: ThreadSnapshot = {
      threadId: turn.threadId as ThreadSnapshot["threadId"],
      sessionId: turn.thread.sessionId as ThreadSnapshot["sessionId"],
      activeContextEpochId: turn.thread.activeContextEpochId as ThreadSnapshot["activeContextEpochId"],
    };
    const contextStore = new PrismaContextStore(
      db,
      artifactClient,
      { sessionId: task.sessionId, taskId: task.id, turnId, workspaceId: workspace.id },
    );
    const contextEpoch = await ensureContextEpoch({
      db,
      threadId: turn.threadId,
      taskId: task.id,
      workspaceId: workspace.id,
      provider: localProvider,
      model: localModel,
      worldState,
      artifacts: artifactClient,
    });
    const confidentialityPolicy: ConfidentialityPolicy = {
      allowedProviders: {
        public: [localProvider.providerId],
        workspace: [localProvider.providerId],
        secret_adjacent: [],
        secret: [],
      },
    };
    const compiled = await compileContext({
      task: taskSnapshot,
      thread: threadSnapshot,
      provider: localProvider,
      model: localModel,
      epoch: contextEpoch,
      worldState,
      recentEpisodes,
      checkpoint,
      userDirectives: [] as readonly ContextDirective[],
      activeCapabilities: [],
      budget: contextBudget,
      experimentAssignments: [],
      renderer: new LocalRenderer(),
      confidentialityPolicy,
      toolSchemas: [],
      compactionPolicy: { enabled: false, targetTokens: Number(contextBudget.optionalContextTarget) },
      store: contextStore,
      retrievalPipeline: kernelRetrievalPipeline(
        requireKernelUds(),
        artifactContext,
        worldState.observedAt,
        localModel.modelKey,
        task.sessionId,
        task.id,
      ),
      signal: null,
    });
    const requestArtifact = compiled.renderedRequestArtifact;
    if (requestArtifact === null) throw new Error("context store did not persist rendered provider request");
    const baselineArtifact = await ingestJsonArtifact(
      artifactClient,
      {
        epochId: contextEpoch.epochId,
        stablePrefixHash: compiled.manifest.cachePlan.stablePrefixHash,
        fragments: compiled.manifest.fragments.map((fragment) => ({
          id: fragment.fragmentId,
          hash: fragment.artifactHash,
        })),
      },
      "context-epoch-baseline",
      { taskId: task.id, turnId, workspaceId: workspace.id },
    );
    await db.contextEpoch.update({
      where: { id: contextEpoch.epochId },
      data: {
        baselineHash: compiled.manifest.cachePlan.stablePrefixHash,
        baselineArtifact: baselineArtifact.uri,
      },
    });
    await emit({
      eventType: "context.manifest_persisted",
      aggregateType: "context_manifest", aggregateId: compiled.manifest.id, aggregateSequence: 1,
      correlationId: turn.taskId ?? undefined,
      payload: {
        turn_id: turnId,
        fragment_count: compiled.manifest.fragments.length,
        provider: localProvider.providerId,
        model: localModel.modelKey,
        total_estimated_tokens: compiled.totalEstimatedTokens,
        omitted_count: compiled.omitted.length,
      },
      artifactRefs: [requestArtifact.uri],
    });

    // 2. PROVIDER_RUNNING — create a durable attempt only after the exact
    // manifest and rendered request have been persisted.
    const midCompileTurn = await db.turn.findUnique({ where: { id: turnId } });
    if (midCompileTurn?.state === "INTERRUPTED") return;
    await db.turn.update({ where: { id: turnId }, data: { state: "PROVIDER_RUNNING" } });
    const attemptId = uuid();
    const attempt = await db.providerAttempt.create({
      data: {
        id: attemptId,
        turnId,
        attemptNumber: 1,
        providerId: localProvider.providerId,
        modelKey: localModel.modelKey,
        capabilitySnapshotHash: compiled.manifest.providerCapabilityHash,
        contextManifestId: compiled.manifest.id,
        requestArtifact: requestArtifact.uri,
        status: "running",
      },
    });
    await db.contextManifest.update({
      where: { id: compiled.manifest.id },
      data: { providerAttemptId: attempt.id },
    });
    await emit({
      eventType: "turn.provider_running",
      aggregateType: "turn", aggregateId: turnId, aggregateSequence: 3,
      correlationId: turn.taskId ?? undefined,
      payload: {
        provider_attempt_id: attemptId,
        provider: localProvider.providerId,
        model: localModel.modelKey,
        context_manifest_id: compiled.manifest.id,
      },
      artifactRefs: [requestArtifact.uri],
    });

    // Keep an observable deterministic provider boundary so interruption and
    // recovery tests exercise the same state transition as a real transport.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const midTurn = await db.turn.findUnique({ where: { id: turnId } });
    if (midTurn?.state === "INTERRUPTED") return;

    // 3. RESPONSE_VALIDATING
    await db.turn.update({ where: { id: turnId }, data: { state: "RESPONSE_VALIDATING" } });
    const responseText = `Acknowledged: ${userInput.slice(0, 200)}`;
    const responseChunks: readonly ProviderResponseChunk[] = [
      { kind: "text", text: responseText },
      { kind: "done" },
    ];
    const providerResponse: ProviderResponse = {
      providerId: localProvider.providerId,
      model: localModel.modelKey,
      chunks: responseChunks,
      observedAt: now(),
    };
    const renderer = new LocalRenderer();
    const projected = await renderer.projectResponse(providerResponse);
    const usage = renderer.extractUsage(providerResponse);
    const responseArtifactMeta = await artifactClient.ingest(
      new TextEncoder().encode(projected.text),
      {
        mediaType: "text/plain",
        custom: { purpose: "provider-response", providerAttemptId: attemptId },
      },
    );
    await db.episode.create({
      data: {
        id: uuid(),
        turnId,
        sequence: 2,
        kind: "model_message",
        modelVisible: true,
        contentArtifact: responseArtifactMeta.uri,
        sourceVersionsJson: JSON.stringify({ providerAttemptId: attemptId, response: responseArtifactMeta.hash }),
      },
    });
    await db.providerAttempt.update({
      where: { id: attemptId },
      data: {
        status: "completed",
        responseArtifact: responseArtifactMeta.uri,
        completedAt: new Date(),
        usageJson: JSON.stringify(jsonSafe(usage)),
        costMicros: 0,
        nativeContinuationJson: null,
      },
    });
    await contextStore.recordObservation(compiled.manifest.id, {
      responseArtifact: responseArtifactMeta.uri,
      usage: jsonSafe(usage),
      projectedFinishReason: projected.finishReason,
    });
    await emit({
      eventType: "turn.response_validating",
      aggregateType: "turn", aggregateId: turnId, aggregateSequence: 4,
      correlationId: turn.taskId ?? undefined,
      payload: {
        provider_attempt_id: attemptId,
        status: "completed",
        usage: jsonSafe(usage),
        finish_reason: projected.finishReason,
      },
      artifactRefs: [responseArtifactMeta.uri],
    });

    // 4. TOOL_SETTLEMENT — no tool call is recorded unless a provider
    // response contains one and the kernel-backed effect path is invoked.
    await db.turn.update({ where: { id: turnId }, data: { state: "TOOL_SETTLEMENT" } });
    await emit({
      eventType: "turn.tool_settlement",
      aggregateType: "turn", aggregateId: turnId, aggregateSequence: 5,
      correlationId: turn.taskId ?? undefined,
      payload: { provider_attempt_id: attemptId, tool_calls: projected.toolCalls.length },
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
        // Real verification DAG + completion gate (M8). False completion is denied.
        const runtime = createVerificationRuntime();
        const contractRows = await db.acceptanceCriterion.findMany({
          where: {
            taskId: task.id,
            contractVersion: task.activeContractVersion,
          },
        });
        const criteria: AcceptanceCriterion[] = contractRows.map((c) => ({
          id: c.criterionId,
          statement: c.statement,
          verificationHint: c.verificationHint,
          required: c.required,
        }));
        const nodes = defaultCriteriaNodes(criteria);
        const completionExpression = nodes.map((n) => n.id).join(" && ");
        const sourceRevision = "git:dev";
        const environmentDigest = "sha256:dev-environment";
        const plan = await runtime.lifecycle.createPlan({
          taskContractId: task.id as never,
          taskContractVersion: task.activeContractVersion,
          sourceRevision,
          criteria,
          nodes,
          completionExpression,
        });
        try {
          await persistPlanToPrisma(db, {
            id: plan.id,
            taskId: task.id,
            contractVersion: plan.taskContractVersion,
            sourceRevision: plan.sourceRevision,
            completionExpression: plan.completionExpression,
            nodes: plan.nodes.map((n) => ({
              id: n.id,
              kind: n.kind,
              required: n.required,
              specification: n.specification,
              timeout: n.timeout,
              retryPolicy: n.retryPolicy,
              acceptanceCriterionId: n.acceptanceCriterionId,
              dependsOn: n.dependsOn,
            })),
            edges: plan.edges,
          });
        } catch (persistErr) {
          console.warn("verification plan prisma persist degraded", persistErr);
        }

        const evaluation = await runtime.lifecycle.evaluate(
          plan.id,
          sourceRevision,
          environmentDigest,
          null,
        );
        try {
          await persistResultsToPrisma(db, evaluation.results);
        } catch (persistErr) {
          console.warn("verification results prisma persist degraded", persistErr);
        }

        for (const r of evaluation.results) {
          await emit({
            eventType: r.status === "pass" ? "verification.node_passed" : "verification.node_failed",
            aggregateType: "verification_result",
            aggregateId: r.id,
            aggregateSequence: 1,
            correlationId: task.id,
            payload: { node_id: r.nodeId, status: r.status },
          });
        }

        const allPassed =
          evaluation.allRequiredPassed && evaluation.completionExpressionSatisfied;
        await emit({
          eventType: "verification.plan_completed",
          aggregateType: "verification_plan",
          aggregateId: plan.id,
          aggregateSequence: 1,
          correlationId: task.id,
          payload: { status: allPassed ? "all_passed" : "failed" },
        });

        if (!allPassed) {
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "FAILED_VERIFICATION",
              phase: "VERIFY",
              completedAt: new Date(),
              terminalReasonJson: JSON.stringify({
                reason: "required_predicates_failed",
                blocked: evaluation.blocked,
              }),
            },
          });
          await emit({
            eventType: "task.failed",
            aggregateType: "task",
            aggregateId: task.id,
            aggregateSequence: 4,
            payload: { phase: "VERIFY", status: "FAILED_VERIFICATION" },
          });
          return;
        }

        try {
          await runtime.lifecycle.complete({
            taskId: task.id as never,
            planId: plan.id,
            criteria,
            findings: [],
            sourceRevision,
            environmentImageDigest: environmentDigest,
            expiresAt: null,
            unresolvedRisks: [],
            acceptedRisks: [],
            externalEffects: [],
            costMicros: 0n as Micros,
            durationSeconds: 0,
            finalCheckpoint: {
              hash: "sha256:" + "0".repeat(64),
              uri: `artifact://sha256/${"0".repeat(64)}`,
              mediaType: "application/json",
              bytes: 0n,
            } as never,
          });
        } catch (gateErr) {
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "FAILED_VERIFICATION",
              phase: "VERIFY",
              completedAt: new Date(),
              terminalReasonJson: JSON.stringify({
                reason: "completion_gate_denied",
                error: String(gateErr),
              }),
            },
          });
          await emit({
            eventType: "task.failed",
            aggregateType: "task",
            aggregateId: task.id,
            aggregateSequence: 4,
            payload: { phase: "VERIFY", status: "FAILED_VERIFICATION" },
          });
          return;
        }

        await db.task.update({
          where: { id: task.id },
          data: {
            status: "COMPLETED",
            phase: "COMPLETE",
            completedAt: new Date(),
            verificationPlanId: plan.id,
          },
        });
        await emit({
          eventType: "task.completed",
          aggregateType: "task",
          aggregateId: task.id,
          aggregateSequence: 4,
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
    // Malformed percent-encoding (e.g. /v1/tasks/%zz) must degrade to a
    // 404-style miss, not throw an unhandled rejection that kills the
    // server: decodeURIComponent throws URIError on invalid sequences, and
    // this loop runs outside the handler try/catch below.
    try {
      r.paramNames.forEach((n, i) => { matchedParams[n] = decodeURIComponent(m[i + 1] ?? ""); });
    } catch {
      matchedRoute = null;
      break;
    }
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

  // 8. Commit idempotency record. A failure here must not become an
  // unhandled rejection that kills the server; the replay guarantee simply
  // degrades for this request and the error is logged.
  if (mut && idempotencyKey) {
    try {
      await commitIdempotency(res, matchedRoute.method, idempotencyKey);
    } catch (err) {
      console.error("idempotency commit error", err);
    }
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

void replayArpV2();

process.on("SIGINT", () => { void db.$disconnect(); process.exit(0); });
process.on("SIGTERM", () => { void db.$disconnect(); process.exit(0); });
