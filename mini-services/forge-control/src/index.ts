/**
 * Forge Control Plane mini-service.
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
 * The service uses Prisma (SQLite) for operational state, the kernel HTTP
 * API for effects, and the @forge/* packages for domain logic.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

// ────────────────────────── Configuration ──────────────────────────────────

const PORT = 3050;
const KERNEL_PORT = 3040;
const KERNEL_TOKEN = process.env.FORGE_KERNEL_TOKEN ?? "forge-kernel-dev-token";
const DATABASE_URL = process.env.DATABASE_URL ?? "file:/home/z/my-project/db/custom.db";

const db = new PrismaClient({
  datasources: { db: { url: DATABASE_URL } },
});

// ────────────────────────── Kernel client ──────────────────────────────────

async function kernel<T = unknown>(
  path: string,
  body: unknown = {},
  method = "POST",
): Promise<T> {
  const url = `http://127.0.0.1:${KERNEL_PORT}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KERNEL_TOKEN}`,
      "x-capability-token": process.env.FORGE_KERNEL_CAP_TOKEN ?? "",
    },
  };
  if (method !== "GET") init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = text; }
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json &&
      (json as { error: unknown }).error &&
      typeof (json as { error: { message?: unknown } }).error.message === "string"
        ? (json as { error: { message: string } }).error.message
        : `kernel ${res.status}`;
    throw new Error(message);
  }
  return json as T;
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

  async replay(sinceEventId: string | null, filter: (ev: StoredEvent) => boolean): Promise<StoredEvent[]> {
    if (!sinceEventId) return [];
    const rows = await db.semanticEvent.findMany({
      where: { eventId: { gt: sinceEventId } },
      orderBy: { aggregateSequence: "asc" },
      take: 1000,
    });
    return rows as unknown as StoredEvent[];
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
  payload: unknown;
  artifactRefs?: string[] | undefined;
  traceId?: string | null | undefined;
}): Promise<void> {
  const ev: StoredEvent = {
    eventId: randomUUID(),
    schemaVersion: 1,
    eventType: params.eventType,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    aggregateSequence: params.aggregateSequence,
    occurredAt: new Date(),
    actorJson: JSON.stringify(params.actor ?? { kind: "system", id: "forge-control" }),
    correlationId: params.correlationId ?? randomUUID(),
    causationId: params.causationId ?? null,
    idempotencyKey: null,
    payloadJson: JSON.stringify(params.payload),
    artifactRefsJson: JSON.stringify(params.artifactRefs ?? []),
    traceId: params.traceId ?? null,
  };
  await bus.publish(ev);
}

// ────────────────────────── Helpers ────────────────────────────────────────

function now(): string { return new Date().toISOString(); }
function uuid(): string { return randomUUID(); }

function jsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(buf.toString("utf8"))); } catch (e) { reject(e); }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(buf.length),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  });
  res.end(buf);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, category: string, details: Record<string, unknown> = {}): void {
  sendJson(res, status, {
    error: {
      code,
      message,
      retryable: category === "timeout" || category === "external_dependency" || category === "internal",
      category,
      details,
      suggested_action: null,
      trace_id: randomUUID(),
    },
  });
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
    const kernelHealth = await kernel<{ status: string; ready: boolean }>("/v1/health", {});
    sendJson(res, 200, {
      status: kernelHealth.ready ? "ok" : "degraded",
      version: "0.1.0",
      build_commit: "dev",
      instance_id: "forge-control-dev",
      uptime_seconds: process.uptime(),
      ready: kernelHealth.ready,
      kernel: kernelHealth,
    });
  }),
  route("POST", "/v1/system/initialize", async (req, res) => {
    const body = await jsonBody(req) as { client?: unknown };
    sendJson(res, 200, {
      server: { version: "0.1.0", build_commit: "dev", instance_id: "forge-control-dev" },
      protocol: { major: 1, minor: 0 },
      capabilities: {
        supported: ["sse_resume", "rich_approvals", "artifact_streaming"],
        experimental: [],
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
        ownerPrincipal: "user@local",
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
        createdBy: "user@local",
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
      event_cursor: uuid(),
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
        initiatingActor: "user",
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

  // ────────────────────────── /events (SSE) ──────────────────────────────
  route("GET", "/v1/events", async (req, res, _params) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "access-control-allow-origin": "*",
      "x-accel-buffering": "no",
    });
    const url = new URL(req.url ?? "", "http://x");
    const cursor = url.searchParams.get("cursor");
    const taskId = url.searchParams.get("task_id");
    const sessionId = url.searchParams.get("session_id");

    const filter = (ev: StoredEvent) => {
      if (taskId && ev.payloadJson && ev.payloadJson.includes(taskId)) return true;
      if (sessionId && ev.payloadJson && ev.payloadJson.includes(sessionId)) return true;
      if (!taskId && !sessionId) return true;
      return false;
    };

    // Replay missed events.
    if (cursor) {
      const replayed = await bus.replay(cursor, filter);
      for (const ev of replayed) {
        res.write(`id: ${ev.eventId}\nevent: ${ev.eventType}\ndata: ${ev.payloadJson}\n\n`);
      }
    }

    // Subscribe to live events.
    const unsubscribe = bus.subscribe(filter, (ev) => {
      res.write(`id: ${ev.eventId}\nevent: ${ev.eventType}\ndata: ${ev.payloadJson}\n\n`);
    });

    // Heartbeat every 15s.
    const heartbeat = setInterval(() => {
      try { res.write(`:heartbeat ${Date.now()}\n\n`); } catch { /* ignore */ }
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
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
      const bytes = await kernel<Uint8Array>(`/v1/artifacts/${encodeURIComponent(String(params.hash))}`, {}, "GET");
      const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array();
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(buf.length),
        "access-control-allow-origin": "*",
      });
      res.end(buf);
    } catch (err) {
      sendError(res, 500, "ARTIFACT_FETCH_FAILED", String(err), "internal");
    }
  }),
  route("GET", "/v1/artifacts/:hash/metadata", async (_req, res, params) => {
    try {
      const meta = await kernel(`/v1/artifacts/${encodeURIComponent(String(params.hash))}/metadata`, {}, "GET");
      sendJson(res, 200, meta);
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
      decision: "allow_once" | "allow_exact" | "allow_task_scope" | "deny_once" | "deny_and_rule" | "stop_task";
      rationale?: string | null;
    };
    const status = body.decision.startsWith("allow") ? "allowed" : body.decision === "stop_task" ? "revoked" : "denied";
    const a = await db.approval.update({
      where: { id: String(params.id) },
      data: { status, resolvedAt: new Date(), resolvedBy: "user@local", rationale: body.rationale ?? null },
    });
    await emit({
      eventType: "approval.resolved",
      aggregateType: "approval", aggregateId: a.id, aggregateSequence: 2,
      correlationId: a.taskId,
      payload: { decision: body.decision, status: a.status },
    });
    sendJson(res, 200, {
      id: a.id, task_id: a.taskId, operation_hash: a.operationHash, status: a.status,
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
      const r = await kernel(`/v1/jobs/${encodeURIComponent(String(params.id))}/stop`, { reason: body.reason ?? null });
      sendJson(res, 200, r);
    } catch (err) {
      sendError(res, 500, "JOB_STOP_FAILED", String(err), "internal");
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

  // ────────────────────────── /tools (direct invocation for IDE/test) ────
  route("POST", "/v1/tools/read", async (req, res) => {
    const body = await jsonBody(req) as { workspace_id: string; path: string };
    try {
      const r = await kernel("/v1/files/read", {
        context: { request_id: uuid(), session_id: "dev", task_id: "dev", turn_id: "dev", actor_id: "user", traceparent: null, capability_token: null },
        intent: { user_intent_ref: null, task_contract_hash: null, trust_label: "trusted", confidentiality_label: "workspace", taint_sources: [], policy_profile_id: "secure-local-default" },
        path: { workspace_id: body.workspace_id, relative_path: body.path },
        mode: "full", max_bytes: 32768, expected_sha256: null,
      });
      sendJson(res, 200, r);
    } catch (err) {
      sendError(res, 500, "READ_FAILED", String(err), "internal");
    }
  }),
  route("POST", "/v1/tools/exec", async (req, res) => {
    const body = await jsonBody(req) as { program: string; args?: string[]; cwd?: string };
    try {
      const r = await kernel("/v1/process/start", {
        context: { request_id: uuid(), session_id: "dev", task_id: "dev", turn_id: "dev", actor_id: "user", traceparent: null, capability_token: null },
        intent: { user_intent_ref: null, task_contract_hash: null, trust_label: "trusted", confidentiality_label: "workspace", taint_sources: [], policy_profile_id: "secure-local-default" },
        command: { program: body.program, args: body.args ?? [], cwd: { workspace_id: "dev", relative_path: body.cwd ?? "." }, public_env: {}, secret_capability_uris: [], timeout: "30s", allocate_pty: false },
        sandbox_profile_id: "secure-local-default",
        output_policy_id: "default",
      });
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
        { id: "forge-minimal", name: "Forge minimal mode", description: "Bash-only baseline (SPEC §3.7)" },
        { id: "forge-full", name: "Forge full mode", description: "All features enabled" },
      ],
      last_run: null,
    });
  }),

  // ────────────────────────── /configuration ─────────────────────────────
  route("GET", "/v1/configuration", async (_req, res) => {
    sendJson(res, 200, {
      forge: { version: 1, log_level: "info" },
      kernel: { port: KERNEL_PORT, required_protocol: "1.x" },
      context: { compiler_version: "v1", evidence_coverage: true, memory: { enabled: false } },
      aci: { default_tools: ["read", "search", "patch", "exec", "job", "inspect", "capability"] },
      sandbox: { profile: "secure-local-default", backend: "local-restrictive" },
      orchestration: { default: "single_agent", scouts: { enabled: true, read_only: true }, writers: { enabled: true, max_parallel: 2 }, reviewer: { risk_triggered: true } },
    });
  }),
];

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
      { kind: "authority", sourceUri: "forge://policy/secure-local-default", authority: 100, priority: 100, trust: "trusted", confidentiality: "public", injectionRisk: "none", exactness: "exact", selected: true, renderedPosition: 0, estimatedTokens: 80, selectionReason: "Hard-included authority", omissionReason: null },
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

const server = createServer(async (req, res) => {
  // CORS preflight.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*",
    });
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://x");
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.paramNames.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1] ?? ""); });
    try {
      await r.handler(req, res, params);
    } catch (err) {
      console.error("handler error", err);
      sendError(res, 500, "INTERNAL", String(err), "internal");
    }
    return;
  }
  sendError(res, 404, "NOT_FOUND", `no route for ${req.method} ${url.pathname}`, "not_found");
});

server.listen(PORT, () => {
  console.log(`[forge-control] listening on http://localhost:${PORT}`);
  console.log(`[forge-control] kernel at http://localhost:${KERNEL_PORT} (via ?XTransformPort=${KERNEL_PORT})`);
});

process.on("SIGINT", () => { void db.$disconnect(); process.exit(0); });
process.on("SIGTERM", () => { void db.$disconnect(); process.exit(0); });
