/**
 * Terminus Desktop — API client tests (SPEC §29 — required test scenarios).
 *
 * Coverage:
 *   1. TerminusApiClient URL builder + header construction (unit, offline).
 *   2. TerminusApiError envelope shape (unit, offline — driven via fetch mock).
 *   3. Live integration tests against the control plane at
 *      http://127.0.0.1:3050 with `TERMINUS_TOKEN` or
 *      `TERMINUS_CONTROL_TOKEN`:
 *        - health()
 *        - listSessions()
 *        - createSession(input)
 *        - listTasks(sessionId)
 *        - createTask(input)
 *        - startTask(taskId)
 *        - startTurn(input)
 *        - getTask(taskId)
 *        - resolveApproval(id, decision) — used for the 400 test.
 *   4. Error handling:
 *        - 401 without auth (listSessions with bogus token).
 *        - 404 for missing resource (getTask on a non-existent task id).
 *        - 400 for invalid input (resolveApproval with a bogus decision).
 *
 * The live tests auto-skip when the control plane is unreachable so
 * `bunx vitest run` is green in environments without the harness running.
 * To run them, start the control plane first:
 *
 *   cd /home/z/my-project && scripts/start-mini-services.sh
 *
 * Then:
 *
 *   cd apps/desktop && bunx vitest run tests/api.test.ts --reporter=verbose
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  subscribeEvents,
  TerminusApiClient,
  TerminusApiError,
  MAX_REST_RESPONSE_BYTES,
} from "../src/lib/api";
import { subscribeEventsV2, TerminusArpV2Client } from "../src/lib/api-v2";
import { DEFAULT_SSE_MAX_FRAME_BYTES as PUBLIC_SSE_MAX_FRAME_BYTES } from "@terminus/public-api";
import type { CreateSessionInput, CreateTaskInput } from "../src/types";

// ────────────────────────── Configuration ───────────────────────────────────

const API_BASE = "http://127.0.0.1:3050";
const nativeFetch = globalThis.fetch;
const TOKEN = process.env.TERMINUS_TOKEN
  ?? process.env.TERMINUS_CONTROL_TOKEN
  ?? (process.env.TERMINUS_DEV === "1" ? "terminus-control-dev-token" : "");
let mutationSequence = 0;

function mutationOptions(scope: string): { idempotencyKey: string } {
  mutationSequence += 1;
  return { idempotencyKey: `desktop-test:${scope}:${mutationSequence}` };
}

function v1Task(id: string, sessionId: string): Record<string, unknown> {
  return {
    id,
    session_id: sessionId,
    thread_id: "thread-1",
    status: "DRAFT",
    phase: "INTAKE",
    active_contract_version: 1,
    risk_class: "low",
    created_at: "2026-08-23T12:00:00.000Z",
    updated_at: "2026-08-23T12:00:00.000Z",
    completed_at: null,
    terminal_reason: null,
    contract: null,
  };
}

function v1Session(id: string, workspaceId: string): Record<string, unknown> {
  return {
    id,
    workspace_id: workspaceId,
    title: "Session",
    status: "active",
    active_thread_id: "thread-1",
    created_at: "2026-08-23T12:00:00.000Z",
    updated_at: "2026-08-23T12:00:00.000Z",
  };
}

function v1Workspace(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "workspace-1",
    kind: "local_directory",
    root_uri: "file:///tmp/project",
    canonical_root: "/tmp/project",
    trust: "trusted",
    policy_profile_id: "secure-local-default",
    created_at: "2026-08-23T12:00:00.000Z",
    last_opened_at: "2026-08-23T12:00:00.000Z",
    ...overrides,
  };
}

function startTaskResponse(taskId: string): Record<string, unknown> {
  return {
    task_id: taskId,
    status: "ACTIVE",
    event_cursor: "cursor-1",
    links: { events: "/v1/events", task: `/v1/tasks/${taskId}` },
  };
}

function v1Turn(taskId: string, threadId = "thread-1"): Record<string, unknown> {
  return {
    id: "turn-1",
    thread_id: threadId,
    task_id: taskId,
    sequence: 1,
    state: "ACTIVE",
    initiating_actor: "operator",
    started_at: "2026-08-23T12:00:00.000Z",
    completed_at: null,
  };
}

function v1Approval(id: string, taskId: string): Record<string, unknown> {
  return {
    id,
    task_id: taskId,
    operation_hash: "sha256:operation-1",
    binding: null,
    display: null,
    status: "pending",
    decision: null,
    supported_decisions: ["allow_once"],
    risk: "low",
    scope: [],
    use_limit: 1,
    use_count: 0,
    expires_at: null,
    requested_at: "2026-08-23T12:00:00.000Z",
    resolved_at: null,
    rationale: null,
  };
}

// ────────────────────────── Live-server probe ───────────────────────────────

/**
 * Probe the control plane once per file. We use top-level await so the
 * result is available to `test.skipIf` at registration time. Vitest
 * supports top-level await in ESM-mode test files by default.
 */
async function probeLive(): Promise<boolean> {
  if (TOKEN.length === 0) return false;
  // Race the fetch against a 1.5s timeout. We don't pass `signal` to
  // fetch because the jsdom test environment provides its own
  // AbortController global that doesn't satisfy undici's fetch (Node's
  // native fetch). Promise.race keeps the probe fast and avoids the
  // AbortSignal type mismatch.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), 1500);
  });
  try {
    const res = await Promise.race([
      fetch(`${API_BASE}/v1/system/health`),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    return res !== false && res.ok;
  } catch {
    if (timer) clearTimeout(timer);
    return false;
  }
}

const live = await probeLive();

const describeLive = live ? describe : describe.skip;

// ────────────────────────── 1. Unit tests (offline) ─────────────────────────

describe("TerminusApiClient — URL + headers (offline)", () => {
  test("health() accepts the current kernel state summary", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: "ok",
      version: "0.1.0",
      build_commit: "dev",
      instance_id: "control-test",
      uptime_seconds: 1,
      ready: true,
      kernel: { state: "ok", degradations: [], checkedAt: "2026-08-23T12:00:00.000Z" },
    }), { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const health = await client.health();

    expect(health.kernel).toMatchObject({ status: "ok", ready: true });
  });

  test("url() builds a path with no query when query is empty", () => {
    const c = new TerminusApiClient("http://example.test/", "tok");
    expect(c.url("/v1/sessions")).toBe("http://example.test/v1/sessions");
  });

  test("url() strips trailing slashes from the base", () => {
    const c = new TerminusApiClient("http://example.test///", "tok");
    expect(c.url("/v1/sessions")).toBe("http://example.test/v1/sessions");
  });

  test("url() serializes query parameters, skipping null/undefined", () => {
    const c = new TerminusApiClient("http://example.test", "tok");
    const u = c.url("/v1/events", {
      cursor: "abc",
      task_id: "t-1",
      session_id: null,
    });
    expect(u).toBe("http://example.test/v1/events?cursor=abc&task_id=t-1");
  });

  test("buildHeaders() exposes content-type, accept, and bearer auth", () => {
    const c = new TerminusApiClient("http://example.test", "secret-token");
    const h = c.buildHeaders();
    expect(h["content-type"]).toBe("application/json");
    expect(h["accept"]).toBe("application/json");
    expect(h["authorization"]).toBe("Bearer secret-token");
  });

  test("buildHeaders() merges extra headers without losing auth", () => {
    const c = new TerminusApiClient("http://example.test", "tok");
    const h = c.buildHeaders({ accept: "text/event-stream" });
    expect(h["accept"]).toBe("text/event-stream");
    expect(h["authorization"]).toBe("Bearer tok");
  });

  test("collection methods fetch one bounded page and preserve its continuation", async () => {
    const session = {
      id: "session-001",
      workspace_id: "workspace-001",
      title: "Bounded project",
      status: "active",
      active_thread_id: "thread-001",
      created_at: "2026-08-23T12:00:00.000Z",
      updated_at: "2026-08-23T12:00:00.000Z",
    };
    const mocked = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({
      sessions: [session],
      total: 401,
      next_cursor: String(input).includes("cursor=session-001") ? null : "session-001",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = mocked as typeof fetch;
    const client = new TerminusApiClient("http://example.test", "tok");

    const firstPage = await client.listSessions();
    const nextPage = await client.listSessions({ cursor: firstPage.next_cursor });

    expect(firstPage).toMatchObject({
      total: 401,
      next_cursor: "session-001",
      truncation: { occurred: true, continuation: "session-001" },
    });
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(String(mocked.mock.calls[0]?.[0])).toContain("/v1/sessions?limit=200");
    expect(String(mocked.mock.calls[1]?.[0])).toContain("cursor=session-001");
    expect(nextPage.sessions).toHaveLength(1);
  });

  test("mutations require and transmit the logical idempotency key", async () => {
    const mocked = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(v1Session("session-1", "workspace-1")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = mocked as typeof fetch;
    const client = new TerminusApiClient("http://example.test", "tok");

    await client.createSession(
      { workspace_id: "workspace-1", title: "Test" },
      { idempotencyKey: "session:create:logical-1" },
    );

    const headers = new Headers(mocked.mock.calls[0]?.[1]?.headers);
    expect(headers.get("idempotency-key")).toBe("session:create:logical-1");
  });

  test("blank idempotency keys fail before fetch", async () => {
    const mocked = vi.fn<typeof fetch>();
    globalThis.fetch = mocked;
    const client = new TerminusApiClient("http://example.test", "tok");

    await expect(client.createSession(
      { workspace_id: "workspace-1", title: "Test" },
      { idempotencyKey: "  " },
    )).rejects.toThrow(/Idempotency-Key must be a non-empty string/);
    expect(mocked).not.toHaveBeenCalled();
  });

  test("gateway settings decode without ever returning credential bytes", async () => {
    const mocked = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const submitted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        configured: true,
        configuration: {
          deployment: submitted.deployment ?? "zen",
          protocol: submitted.protocol ?? "chat_completions",
          model: submitted.model ?? "gpt-5-nano",
          tools_enabled: submitted.tools_enabled ?? true,
          free_model: submitted.free_model ?? true,
          workspace_access: submitted.workspace_access ?? false,
          privacy_terms_admitted: submitted.privacy_terms_admitted ?? false,
          privacy_terms_version: submitted.privacy_terms_version ?? null,
          credential_configured: true,
          revision: 1,
          updated_by: "control",
          created_at: "2026-08-24T00:00:00.000Z",
          updated_at: "2026-08-24T00:00:00.000Z",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = mocked as typeof fetch;
    const client = new TerminusApiClient("http://example.test", "tok");

    const response = await client.putGatewayProviderConfiguration({
      deployment: "zen",
      protocol: "chat_completions",
      model: "gpt-5-nano",
      tools_enabled: true,
      free_model: true,
      workspace_access: false,
      privacy_terms_admitted: false,
      privacy_terms_version: null,
      credential: "private-key-value",
      expected_revision: 0,
    }, { idempotencyKey: "gateway:create:1" });

    expect(response.configuration?.credential_configured).toBe(true);
    expect(JSON.stringify(response)).not.toContain("private-key-value");
  });

  test("rejects a task list containing a task from another session", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      tasks: [v1Task("task-other", "session-other")],
      total: 1,
      next_cursor: null,
    }), { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const error = await client.listTasks("session-requested").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("task list response crossed the requested scope");
  });

  test("rejects task detail whose id differs from the requested task", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(v1Task("task-other", "session-1")), { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const error = await client.getTask("task-requested").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("task detail response crossed the requested scope");
  });

  test("rejects approvals returned for a different task", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      approvals: [v1Approval("approval-1", "task-other")],
      total: 1,
      next_cursor: null,
    }), { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const error = await client.listApprovals("task-requested").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("approval list response crossed the requested scope");
  });

  test("rejects a non-pending approval row from the list boundary", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      approvals: [{ ...v1Approval("approval-resolved", "task-requested"), status: "allowed" }],
      total: 1,
      next_cursor: null,
    }), { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const error = await client.listApprovals("task-requested").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("non-pending row");
  });

  test("rejects an artifact page returned for a different task", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      task_id: "task-other",
      artifacts: [],
      total: 0,
      next_cursor: null,
    }), { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const error = await client.listTaskArtifacts("task-requested").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("task artifact page response crossed the requested scope");
  });

  test("rejects invalid artifact continuation inputs instead of restarting at page one", async () => {
    const mocked = vi.fn(async () => new Response(null, { status: 500 }));
    globalThis.fetch = mocked as unknown as typeof fetch;

    const error = await new TerminusApiClient("http://example.test", "tok")
      .listTaskArtifacts("task-requested", "opaque-cursor")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocked).not.toHaveBeenCalled();
  });

  test("rejects malformed and non-advancing artifact continuations", async () => {
    const artifact = {
      hash: "sha256:artifact",
      purpose: "verification_evidence",
      media_type: "text/plain",
      size_bytes: 12,
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      task_id: "task-requested",
      artifacts: [artifact],
      total: 2,
      next_cursor: "not-an-offset",
    }), { status: 200 })) as unknown as typeof fetch;
    const client = new TerminusApiClient("http://example.test", "tok");

    const malformed = await client.listTaskArtifacts("task-requested").catch((reason: unknown) => reason);
    expect(malformed).toBeInstanceOf(TerminusApiError);
    expect((malformed as TerminusApiError).message).toContain("not a numeric offset");

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      task_id: "task-requested",
      artifacts: [artifact],
      total: 3,
      next_cursor: "1",
    }), { status: 200 })) as unknown as typeof fetch;
    const repeated = await client.listTaskArtifacts("task-requested", "1").catch((reason: unknown) => reason);
    expect(repeated).toBeInstanceOf(TerminusApiError);
    expect((repeated as TerminusApiError).message).toContain("non-advancing continuation");
  });

  test("rejects a session creation response for a different workspace", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(v1Session("session-1", "workspace-other")), { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const error = await client.createSession(
      { workspace_id: "workspace-requested", title: "Session" },
      { idempotencyKey: "session-create-scope" },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
  });

  test("rejects task creation, start, cancellation, and turn responses outside their requested identity", async () => {
    const client = new TerminusApiClient("http://example.test", "tok");

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(v1Task("task-1", "session-other")), { status: 200 })) as unknown as typeof fetch;
    const createError = await client.createTask({
      session_id: "session-requested",
      thread_id: "thread-1",
      objective: "objective",
    }, { idempotencyKey: "task-create-scope" }).catch((reason: unknown) => reason);
    expect(createError).toBeInstanceOf(TerminusApiError);
    expect(createError).toMatchObject({ status: 502 });

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(startTaskResponse("task-other")), { status: 200 })) as unknown as typeof fetch;
    const startError = await client.startTask("task-requested", { idempotencyKey: "task-start-scope" }).catch((reason: unknown) => reason);
    expect(startError).toBeInstanceOf(TerminusApiError);
    expect(startError).toMatchObject({ status: 502 });

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(v1Task("task-other", "session-1")), { status: 200 })) as unknown as typeof fetch;
    const cancelError = await client.cancelTask("task-requested", { idempotencyKey: "task-cancel-scope" }).catch((reason: unknown) => reason);
    expect(cancelError).toBeInstanceOf(TerminusApiError);
    expect(cancelError).toMatchObject({ status: 502 });

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(v1Turn("task-other")), { status: 200 })) as unknown as typeof fetch;
    const turnError = await client.startTurn({
      task_id: "task-requested",
      thread_id: "thread-1",
      user_input: "hello",
    }, { idempotencyKey: "turn-scope" }).catch((reason: unknown) => reason);
    expect(turnError).toBeInstanceOf(TerminusApiError);
    expect(turnError).toMatchObject({ status: 502 });
  });

  test("rejects an approval resolution response with a different id or operation hash", async () => {
    const client = new TerminusApiClient("http://example.test", "tok");
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(v1Approval("approval-other", "task-1")), { status: 200 })) as unknown as typeof fetch;
    const idError = await client.resolveApproval(
      "approval-requested",
      "sha256:operation-1",
      "allow_once",
      { idempotencyKey: "approval-id-scope" },
    ).catch((reason: unknown) => reason);
    expect(idError).toBeInstanceOf(TerminusApiError);
    expect(idError).toMatchObject({ status: 502 });

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(v1Approval("approval-requested", "task-1")), { status: 200 })) as unknown as typeof fetch;
    const operationError = await client.resolveApproval(
      "approval-requested",
      "sha256:operation-other",
      "allow_once",
      { idempotencyKey: "approval-operation-scope" },
    ).catch((reason: unknown) => reason);
    expect(operationError).toBeInstanceOf(TerminusApiError);
    expect(operationError).toMatchObject({ status: 502 });
  });

  test("rejects a poisoned approval resolution status or decision", async () => {
    const client = new TerminusApiClient("http://example.test", "tok");
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      ...v1Approval("approval-requested", "task-1"),
      status: "denied",
      decision: "allow_once",
    }), { status: 200 })) as unknown as typeof fetch;

    const statusError = await client.resolveApproval(
      "approval-requested",
      "sha256:operation-1",
      "allow_once",
      { idempotencyKey: "approval-status-scope" },
    ).catch((reason: unknown) => reason);
    expect(statusError).toBeInstanceOf(TerminusApiError);
    expect(statusError).toMatchObject({ status: 502 });

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      ...v1Approval("approval-requested", "task-1"),
      status: "allowed",
      decision: "deny_once",
    }), { status: 200 })) as unknown as typeof fetch;
    const decisionError = await client.resolveApproval(
      "approval-requested",
      "sha256:operation-1",
      "allow_once",
      { idempotencyKey: "approval-decision-scope" },
    ).catch((reason: unknown) => reason);
    expect(decisionError).toBeInstanceOf(TerminusApiError);
    expect(decisionError).toMatchObject({ status: 502 });
  });

  test("rejects a turn interruption response for a different turn", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(v1Turn("task-1")), { status: 200 })) as unknown as typeof fetch;
    const client = new TerminusApiClient("http://example.test", "tok");
    const error = await client.interruptTurn(
      "turn-requested",
      { idempotencyKey: "turn-interrupt-scope" },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("turn interruption response crossed the requested scope");
  });
});

describe("SSE transport closure (offline)", () => {
  function eofResponse(): Response {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  test("v1 emits error when the server closes without an owner close", async () => {
    globalThis.fetch = vi.fn(async () => eofResponse()) as unknown as typeof fetch;
    const stream = subscribeEvents({ task_id: "task-1" });
    const onError = vi.fn();
    stream.addEventListener("error", onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(stream.readyState).toBe(3);
    stream.close();
  });

  test("v2 emits error when the server closes without an owner close", async () => {
    globalThis.fetch = vi.fn(async () => eofResponse()) as unknown as typeof fetch;
    const stream = subscribeEventsV2({ baseUrl: "http://example.test", token: "tok", taskId: "task-1" });
    const onError = vi.fn();
    stream.addEventListener("error", onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(stream.readyState).toBe(3);
    stream.close();
  });

  test("v1 emits error when an SSE frame exceeds the decoder limit", async () => {
    const payload = `data: ${"x".repeat(PUBLIC_SSE_MAX_FRAME_BYTES + 1)}\n\n`;
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const stream = subscribeEvents({ task_id: "task-1" });
    const onError = vi.fn();
    stream.addEventListener("error", onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(stream.readyState).toBe(3);
  });

  test("v2 emits error when an SSE frame is unterminated at EOF", async () => {
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: unfinished"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const stream = subscribeEventsV2({ baseUrl: "http://example.test", token: "tok", taskId: "task-1" });
    const onError = vi.fn();
    stream.addEventListener("error", onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(stream.readyState).toBe(3);
  });
});

describe("bounded artifact previews (offline)", () => {
  test("cancels the response producer when the byte cap is reached", async () => {
    let cancellationReason: unknown = null;
    let requestedUrl = "";
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("0123456789"));
      },
      cancel(reason) {
        cancellationReason = reason;
      },
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(body, {
        status: 200,
        headers: { "content-length": "10" },
      });
    }) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const preview = await client.getArtifactText("sha256:artifact", "task-1", 4);

    expect(preview).toEqual({ text: "0123", truncated: true, totalBytes: 10 });
    expect(cancellationReason).toBe("artifact preview byte cap reached");
    expect(requestedUrl).toBe("http://example.test/v1/artifacts/artifact?task_id=task-1");
  });
});

// ────────────────────────── 2. TerminusApiError shape (offline) ────────────────

describe("TerminusApiError — envelope shape (offline)", () => {
  test("carries status, message, and envelope fields", () => {
    const env = {
      code: "TASK_NOT_FOUND",
      message: "task not found",
      retryable: false,
      category: "not_found",
      suggested_action: null,
      trace_id: "trace-abc",
    };
    const err = new TerminusApiError(404, "task not found", env);
    expect(err.status).toBe(404);
    expect(err.message).toBe("task not found");
    expect(err.envelope?.code).toBe("TASK_NOT_FOUND");
    expect(err.envelope?.category).toBe("not_found");
    expect(err.envelope?.retryable).toBe(false);
    expect(err.name).toBe("TerminusApiError");
    expect(err).toBeInstanceOf(Error);
  });

  test("envelope is null when the server returns an unstructured body", () => {
    const err = new TerminusApiError(500, "internal", null);
    expect(err.envelope).toBeNull();
    expect(err.status).toBe(500);
  });

  test("network errors surface as status=0 (SPEC §30.4)", async () => {
    const c = new TerminusApiClient("http://127.0.0.1:1", TOKEN);
    await expect(c.health()).rejects.toMatchObject({
      name: "TerminusApiError",
      status: 0,
    });
  });

  test("a non-JSON 4xx body still raises TerminusApiError with envelope=null", async () => {
    // Mock fetch to return a 502 with an HTML body (typical from a
    // misconfigured gateway). The client should still raise rather
    // than throw a JSON parse error.
    const original = globalThis.fetch;
    const mocked = vi.fn(async () =>
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    globalThis.fetch = mocked as unknown as typeof fetch;
    try {
      const c = new TerminusApiClient("http://example.test", "tok");
      await expect(c.listSessions()).rejects.toMatchObject({
        name: "TerminusApiError",
        status: 502,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("an error envelope from the server is parsed into the TerminusApiError", async () => {
    const original = globalThis.fetch;
    const body = {
      error: {
        code: "UNAUTHENTICATED",
        message: "missing or invalid bearer token",
        retryable: false,
        category: "auth",
        suggested_action: "Provide a Bearer token in the Authorization header.",
        trace_id: "trace-xyz",
      },
    };
    const mocked = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = mocked as unknown as typeof fetch;
    try {
      const c = new TerminusApiClient("http://example.test", "wrong-token");
      const err = (await c.listSessions().catch((e: unknown) => e)) as TerminusApiError;
      expect(err).toBeInstanceOf(TerminusApiError);
      expect(err.status).toBe(401);
      expect(err.envelope?.code).toBe("UNAUTHENTICATED");
      expect(err.envelope?.category).toBe("auth");
      expect(err.envelope?.suggested_action).toContain("Bearer");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("rejects an oversized v1 REST response before JSON admission", async () => {
    const oversized = new Uint8Array(MAX_REST_RESPONSE_BYTES + 1);
    globalThis.fetch = vi.fn(async () => new Response(oversized, { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const error = await client.health().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("REST response exceeded");
  });

  test("rejects an oversized v2 REST response before JSON admission", async () => {
    const oversized = new Uint8Array(MAX_REST_RESPONSE_BYTES + 1);
    globalThis.fetch = vi.fn(async () => new Response(oversized, { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusArpV2Client({ baseUrl: "http://example.test", token: "tok" });
    const error = await client.listTasks().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("REST response exceeded");
  });

  test("rejects a workspace open response bound to a different root or policy", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(v1Workspace({ root_uri: "file:///tmp/other" })), { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const error = await client.openWorkspace({
      root_uri: "file:///tmp/project",
      kind: "local_directory",
      trust: "trusted",
      policy_profile_id: "secure-local-default",
    }, { idempotencyKey: "workspace-scope" }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("workspace open response crossed the requested scope");
  });

  test("rejects a sandbox report returned for a different profile", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      profile_id: "profile-other",
      backend_id: "seatbelt-v1",
      status: "enforced",
      enforced: [],
      degraded: [],
      unsupported: [],
      notes: [],
    }), { status: 200 })) as unknown as typeof fetch;

    const client = new TerminusApiClient("http://example.test", "tok");
    const error = await client.getSandboxReport("profile-requested").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("sandbox report response crossed the requested scope");
  });
});

// ────────────────────────── 3. Live integration tests ───────────────────────

describeLive("TerminusApiClient — live control plane (http://127.0.0.1:3050)", () => {
  /**
   * The control plane's `POST /v1/sessions` validates that `workspace_id`
   * references an existing Workspace row (foreign-key constraint). To
   * keep the live tests self-contained, we open a fresh workspace through
   * the same client path onboarding uses. The workspace_id is then reused
   * for createSession.
   */
  async function openWorkspace(c: TerminusApiClient): Promise<string> {
    const rootUri = `file:///tmp/terminus-desktop-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workspace = await c.openWorkspace({
      root_uri: rootUri,
      kind: "local_directory",
      trust: "trusted",
      policy_profile_id: "secure-local-default",
    }, mutationOptions("workspace"));
    return workspace.id;
  }

  test("health() returns ok=true with a version string", async () => {
    const c = new TerminusApiClient(API_BASE, TOKEN);
    const h = await c.health();
    expect(h.status).toBe("ok");
    expect(h.ready).toBe(true);
    expect(typeof h.version).toBe("string");
    expect(h.version.length).toBeGreaterThan(0);
    expect(h.kernel).toBeDefined();
    expect(h.kernel?.ready).toBe(true);
  });

  test("listSessions() returns an array (possibly empty) of Session objects", async () => {
    const c = new TerminusApiClient(API_BASE, TOKEN);
    const res = await c.listSessions();
    expect(Array.isArray(res.sessions)).toBe(true);
    if (res.sessions.length > 0) {
      const s = res.sessions[0]!;
      expect(typeof s.id).toBe("string");
      expect(typeof s.title).toBe("string");
      expect(typeof s.workspace_id).toBe("string");
      // active_thread_id may be null for stale sessions but is usually a string.
      expect(s.active_thread_id === null || typeof s.active_thread_id === "string").toBe(true);
    }
  });

  test("createSession() creates a session + auto-creates an active thread", async () => {
    const c = new TerminusApiClient(API_BASE, TOKEN);
    const workspaceId = await openWorkspace(c);
    const input: CreateSessionInput = {
      workspace_id: workspaceId,
      title: `Terminus Desktop test session ${new Date().toISOString()}`,
    };
    const s = await c.createSession(input, mutationOptions("session"));
    expect(s.id).toMatch(/[0-9a-f-]{20,}/);
    expect(s.title).toBe(input.title);
    expect(s.workspace_id).toBe(input.workspace_id);
    expect(s.status).toBe("active");
    // The control plane auto-creates a root thread.
    expect(typeof s.active_thread_id).toBe("string");
    expect(s.active_thread_id!.length).toBeGreaterThan(0);
  });

  test("listTasks(sessionId) returns tasks for the freshly created session", async () => {
    const c = new TerminusApiClient(API_BASE, TOKEN);
    const workspaceId = await openWorkspace(c);
    const session = await c.createSession({
      workspace_id: workspaceId,
      title: `Terminus Desktop listTasks test ${new Date().toISOString()}`,
    }, mutationOptions("list-tasks-session"));
    const res = await c.listTasks(session.id);
    expect(Array.isArray(res.tasks)).toBe(true);
    // No tasks yet — we just created the session.
    expect(res.tasks.length).toBe(0);
  });

  test("createTask() + getTask() round-trips a draft task", async () => {
    const c = new TerminusApiClient(API_BASE, TOKEN);
    const workspaceId = await openWorkspace(c);
    const session = await c.createSession({
      workspace_id: workspaceId,
      title: `Terminus Desktop createTask test ${new Date().toISOString()}`,
    }, mutationOptions("create-task-session"));
    const input: CreateTaskInput = {
      session_id: session.id,
      thread_id: session.active_thread_id!,
      objective: "Test objective from the Terminus Desktop test suite.",
      non_goals: ["Touching production systems"],
      risk_class: "low",
    };
    const task = await c.createTask(input, mutationOptions("task"));
    expect(task.session_id).toBe(session.id);
    expect(task.thread_id).toBe(session.active_thread_id);
    expect(task.status).toBe("DRAFT");
    expect(task.phase).toBe("INTAKE");
    expect(task.risk_class).toBe("low");

    // getTask should return the same task.
    const fetched = await c.getTask(task.id);
    expect(fetched.id).toBe(task.id);
    expect(fetched.status).toBe("DRAFT");
    // The control plane includes the active contract version in the
    // task detail response — verify the objective round-trips.
    expect(fetched.contract).toBeDefined();
    expect(fetched.contract?.version).toBe(1);
    expect(fetched.contract?.objective).toBe(input.objective);
    expect(fetched.contract?.non_goals).toEqual(input.non_goals);
  });

  test("startTask() transitions DRAFT → ACTIVE", async () => {
    const c = new TerminusApiClient(API_BASE, TOKEN);
    const workspaceId = await openWorkspace(c);
    const session = await c.createSession({
      workspace_id: workspaceId,
      title: `Terminus Desktop startTask test ${new Date().toISOString()}`,
    }, mutationOptions("start-task-session"));
    const task = await c.createTask({
      session_id: session.id,
      thread_id: session.active_thread_id!,
      objective: "Start-task test objective.",
      risk_class: "low",
    }, mutationOptions("start-task-contract"));
    const started = await c.startTask(task.id, mutationOptions("start-task"));
    expect(started.task_id).toBe(task.id);
    expect(started.status).toBe("ACTIVE");
    expect(typeof started.event_cursor).toBe("string");

    const fetched = await c.getTask(task.id);
    expect(fetched.status).toBe("ACTIVE");
    expect(fetched.phase).toBe("DISCOVER");
  });

  test("startTurn() creates a new turn on the task thread", async () => {
    const c = new TerminusApiClient(API_BASE, TOKEN);
    const workspaceId = await openWorkspace(c);
    const session = await c.createSession({
      workspace_id: workspaceId,
      title: `Terminus Desktop startTurn test ${new Date().toISOString()}`,
    }, mutationOptions("start-turn-session"));
    const task = await c.createTask({
      session_id: session.id,
      thread_id: session.active_thread_id!,
      objective: "Start-turn test objective.",
      risk_class: "low",
    }, mutationOptions("start-turn-task"));
    await c.startTask(task.id, mutationOptions("start-turn-start"));
    const turn = await c.startTurn({
      thread_id: session.active_thread_id!,
      task_id: task.id,
      user_input: "Hello from the test suite.",
    }, mutationOptions("turn"));
    expect(turn.thread_id).toBe(session.active_thread_id);
    expect(turn.task_id).toBe(task.id);
    expect(typeof turn.id).toBe("string");
    expect(typeof turn.sequence).toBe("number");
    expect(turn.sequence).toBeGreaterThan(0);
  });
});

// ────────────────────────── 4. Error handling ───────────────────────────────

describeLive("TerminusApiClient — error handling (live)", () => {
  test("401 without auth: listSessions with a bogus token raises TerminusApiError(401, UNAUTHENTICATED)", async () => {
    const c = new TerminusApiClient(API_BASE, "this-token-does-not-exist");
    const err = (await c.listSessions().catch((e: unknown) => e)) as TerminusApiError;
    expect(err).toBeInstanceOf(TerminusApiError);
    expect(err.status).toBe(401);
    expect(err.envelope).not.toBeNull();
    expect(err.envelope?.code).toBe("UNAUTHENTICATED");
    expect(err.envelope?.category).toBe("auth");
    expect(err.envelope?.retryable).toBe(false);
  });

  test("404 for missing resource: getTask on a non-existent id raises TerminusApiError(404, TASK_NOT_FOUND)", async () => {
    const c = new TerminusApiClient(API_BASE, TOKEN);
    const err = (await c.getTask("no-such-task-id-00000000").catch((e: unknown) => e)) as TerminusApiError;
    expect(err).toBeInstanceOf(TerminusApiError);
    expect(err.status).toBe(404);
    expect(err.envelope).not.toBeNull();
    expect(err.envelope?.category).toBe("not_found");
  });

  test("400 for invalid input: resolveApproval with an unsupported decision raises TerminusApiError(400, INVALID_APPROVAL_DECISION)", async () => {
    const c = new TerminusApiClient(API_BASE, TOKEN);
    // The control plane's /v1/approvals/:id/resolve handler returns 400
    // when the `decision` field doesn't match an accepted value. We don't
    // need a real approval id — the validation runs before the lookup.
    const err = (await c
      .resolveApproval(
        "approval-does-not-matter",
        "sha256:operation-does-not-matter",
        "not-a-real-decision" as never,
        mutationOptions("invalid-approval"),
      )
      .catch((e: unknown) => e)) as TerminusApiError;
    expect(err).toBeInstanceOf(TerminusApiError);
    expect(err.status).toBe(400);
    expect(err.envelope).not.toBeNull();
    expect(err.envelope?.code).toBe("INVALID_APPROVAL_DECISION");
    expect(err.envelope?.category).toBe("validation");
    expect(err.envelope?.details).toBeDefined();
    expect(err.envelope?.details).toHaveProperty("accepted");
  });

  test("network error (server offline) surfaces as TerminusApiError(status=0)", async () => {
    // Point at a port nothing is listening on. The connection must
    // fail synchronously inside fetch and surface as status=0.
    const c = new TerminusApiClient("http://127.0.0.1:1", TOKEN);
    const err = (await c.health().catch((e: unknown) => e)) as TerminusApiError;
    expect(err).toBeInstanceOf(TerminusApiError);
    expect(err.status).toBe(0);
    expect(err.envelope).toBeNull();
  });
});

// ────────────────────────── Live-suite status notice ────────────────────────

// This final test always runs (even when the server is offline) so the
// vitest output records whether the live integration tests ran or were
// skipped. It makes the skipped set visible in `bunx vitest run` output
// instead of silently disappearing.

describe("TerminusApiClient — live-suite status", () => {
  test(`control plane at ${API_BASE} is ${live ? "reachable" : "unreachable (live tests skipped)"}`, () => {
    expect(live).toBe(live);
  });
});

// ────────────────────────── Cleanup hooks ───────────────────────────────────

// The control plane doesn't expose session-delete endpoints, so the
// sessions created by these tests persist. Tag them with a recognizable
// title prefix so they can be cleaned up later if needed.

beforeEach(() => {
  // Reset any fetch mocks between tests in the offline describe blocks.
  vi.restoreAllMocks();
  globalThis.fetch = nativeFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = nativeFetch;
});
