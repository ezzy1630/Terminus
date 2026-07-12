/**
 * Terminus Desktop — API client tests (SPEC §29 — required test scenarios).
 *
 * Coverage:
 *   1. TerminusApiClient URL builder + header construction (unit, offline).
 *   2. TerminusApiError envelope shape (unit, offline — driven via fetch mock).
 *   3. Live integration tests against the control plane at
 *      http://127.0.0.1:3050 with bearer `terminus-control-dev-token`:
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
import { TerminusApiClient, TerminusApiError } from "../src/lib/api";
import type { CreateSessionInput, CreateTaskInput } from "../src/types";

// ────────────────────────── Configuration ───────────────────────────────────

const API_BASE = "http://127.0.0.1:3050";
const TOKEN = "terminus-control-dev-token";

// ────────────────────────── Live-server probe ───────────────────────────────

/**
 * Probe the control plane once per file. We use top-level await so the
 * result is available to `test.skipIf` at registration time. Vitest
 * supports top-level await in ESM-mode test files by default.
 */
async function probeLive(): Promise<boolean> {
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
});

// ────────────────────────── 3. Live integration tests ───────────────────────

describeLive("TerminusApiClient — live control plane (http://127.0.0.1:3050)", () => {
  /**
   * The control plane's `POST /v1/sessions` validates that `workspace_id`
   * references an existing Workspace row (foreign-key constraint). To
   * keep the live tests self-contained, we open a fresh workspace via
   * the public API (not via TerminusApiClient — the client doesn't yet
   * surface /v1/workspaces/open) at the start of each test that needs
   * one. The workspace_id is then reused for createSession.
   */
  async function openWorkspace(c: TerminusApiClient): Promise<string> {
    const rootUri = `file:///tmp/terminus-desktop-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${API_BASE}/v1/workspaces/open`, {
      method: "POST",
      headers: c.buildHeaders(),
      body: JSON.stringify({
        root_uri: rootUri,
        kind: "local_directory",
        trust: "trusted",
        policy_profile_id: "secure-local-default",
      }),
    });
    if (!res.ok) {
      throw new Error(`openWorkspace failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { id: string };
    return body.id;
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
    const s = await c.createSession(input);
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
    });
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
    });
    const input: CreateTaskInput = {
      session_id: session.id,
      thread_id: session.active_thread_id!,
      objective: "Test objective from the Terminus Desktop test suite.",
      non_goals: ["Touching production systems"],
      risk_class: "low",
    };
    const task = await c.createTask(input);
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
    });
    const task = await c.createTask({
      session_id: session.id,
      thread_id: session.active_thread_id!,
      objective: "Start-task test objective.",
      risk_class: "low",
    });
    const started = await c.startTask(task.id);
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
    });
    const task = await c.createTask({
      session_id: session.id,
      thread_id: session.active_thread_id!,
      objective: "Start-turn test objective.",
      risk_class: "low",
    });
    await c.startTask(task.id);
    const turn = await c.startTurn({
      thread_id: session.active_thread_id!,
      task_id: task.id,
      user_input: "Hello from the test suite.",
    });
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
      .resolveApproval("approval-does-not-matter", "not-a-real-decision" as never)
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
});

afterEach(() => {
  vi.restoreAllMocks();
});
