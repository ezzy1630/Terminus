import { describe, expect, test } from "bun:test";
import { Observable, type Subscriber } from "rxjs";
import type { JobEvent, RequestContext } from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import {
  CODEX_EXTERNAL_HARNESS,
  CodexAppServerError,
  CodexAppServerSession,
  probeCodexAppServer,
} from "./codex-app-server.js";

const context: RequestContext = {
  requestId: "request",
  idempotencyKey: "idempotency",
  sessionId: "session",
  taskId: "task",
  turnId: "turn",
  actorId: "terminus",
  traceparent: "",
  capabilityToken: "capability",
  workspaceId: "workspace",
  deadline: undefined,
  resourceBudgets: undefined,
  policyVersion: "",
};

function fakeKernel() {
  let subscriber: Subscriber<JobEvent> | null = null;
  let sequence = 0;
  const methods: string[] = [];
  let startInput: { command?: { program?: string; args?: readonly string[]; timeout?: { seconds?: number }; allowUnboundedTimeout?: boolean } } | null = null;
  const jobs = {
    Start: async (input: { command?: { program?: string; args?: readonly string[]; timeout?: { seconds?: number }; allowUnboundedTimeout?: boolean } }) => {
      startInput = input;
      expect(input.command?.program).toBe("codex");
      expect(input.command?.args).toEqual(["app-server", "--stdio"]);
      return { jobId: "job-1", processId: "process-1", startedAt: undefined };
    },
    Stream: () => new Observable<JobEvent>((next) => {
      subscriber = next;
      return () => { subscriber = null; };
    }),
    Input: async (input: { stdin: Uint8Array }) => {
      const message = JSON.parse(new TextDecoder().decode(input.stdin)) as { id?: number; method?: string };
      if (message.method !== undefined) methods.push(message.method);
      if (message.id !== undefined) {
        const response = message.method === "account/read"
          ? { account: { type: "chatgpt", email: "user@example.com", planType: "plus" }, requiresOpenaiAuth: false }
          : message.method === "model/list"
            ? { data: [{ id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", supportedReasoningEfforts: ["low", "medium"], defaultReasoningEffort: "medium", hidden: false }] }
            : message.method === "thread/start"
              ? { thread: { id: "thread-1" } }
              : message.method === "thread/resume"
                ? { thread: { id: "thread-1" } }
                : message.method === "turn/start"
                  ? { turn: { id: "turn-1" } }
                  : {};
        subscriber?.next({ sequence: ++sequence, stdout: { cursor: sequence, bytes: new TextEncoder().encode(JSON.stringify({ id: message.id, result: response }) + "\n"), redacted: false }, occurredAt: undefined });
      }
      return { jobId: "job-1", state: "running", exitCode: 0, startedAt: undefined, exitedAt: undefined, stdoutArtifact: undefined, stderrArtifact: undefined };
    },
    Stop: async () => ({ jobId: "job-1", state: "exited", exitCode: 0, startedAt: undefined, exitedAt: undefined, stdoutArtifact: undefined, stderrArtifact: undefined }),
  };
  return {
    clients: { jobs },
    methods,
    startInput: () => startInput,
    emit: (message: unknown) => subscriber?.next({ sequence: ++sequence, stdout: { cursor: sequence, bytes: new TextEncoder().encode(JSON.stringify(message) + "\n"), redacted: false }, occurredAt: undefined }),
    reconcile: () => subscriber?.next({ sequence: ++sequence, reconciled: { state: "unknown-settlement", explanation: "kernel restart" }, occurredAt: undefined }),
  };
}

describe("Codex App Server external lane", () => {
  test("keeps account, model, thread, turn, and interrupt traffic in the kernel job", async () => {
    const fake = fakeKernel();
    const events: Record<string, unknown>[] = [];
    const session = new CodexAppServerSession({
      clients: fake.clients as never,
      context,
      workspace_id: "workspace",
      public_env: { PATH: "/usr/bin", HOME: "/Users/test" },
      on_event: (event) => events.push(event.message),
    });

    await expect(session.account()).resolves.toMatchObject({ type: "chatgpt", plan_type: "plus" });
    await expect(session.models()).resolves.toEqual([expect.objectContaining({ id: "gpt-5.6-luna" })]);
    await expect(session.startThread({ model: "gpt-5.6-luna" })).resolves.toEqual({ thread_id: "thread-1", external_harness: CODEX_EXTERNAL_HARNESS });
    await expect(session.resumeThread("thread-1")).resolves.toEqual({ thread_id: "thread-1", external_harness: CODEX_EXTERNAL_HARNESS });
    await expect(session.startTurn({ thread_id: "thread-1", text: "inspect the repository" })).resolves.toEqual({ thread_id: "thread-1", turn_id: "turn-1", external_harness: CODEX_EXTERNAL_HARNESS });
    await expect(session.interrupt("thread-1", "turn-1")).resolves.toEqual({ interrupted: true, external_harness: CODEX_EXTERNAL_HARNESS });
    expect(fake.methods).toEqual(["initialize", "initialized", "account/read", "model/list", "thread/start", "thread/resume", "turn/start", "turn/interrupt"]);
    expect(fake.startInput()?.command?.allowUnboundedTimeout).toBe(false);
    expect(fake.startInput()?.command?.timeout?.seconds).toBe(30 * 60);
    expect(session.status().external_harness).toBe("codex");
    expect(events).toEqual([]);
    await session.stop();
  });

  test("does not expose token-bearing or provider-renderer methods", async () => {
    const fake = fakeKernel();
    const session = new CodexAppServerSession({ clients: fake.clients as never, context, workspace_id: "workspace", public_env: {} });
    await session.open();
    await expect((session as unknown as { request: (method: string, params: unknown) => Promise<unknown> }).request("getAuthStatus", { includeToken: true })).rejects.toMatchObject({ code: "CODEX_APP_SERVER_METHOD_UNSUPPORTED" });
    expect(fake.methods).toEqual(["initialize", "initialized"]);
    await session.stop();
  });

  test("redacts sensitive event fields and reports unknown job settlement", async () => {
    const fake = fakeKernel();
    const events: Record<string, unknown>[] = [];
    const session = new CodexAppServerSession({ clients: fake.clients as never, context, workspace_id: "workspace", public_env: {}, on_event: (event) => events.push(event.message) });
    await session.open();
    fake.emit({ method: "account/status", params: { accessToken: "never-return-this", detail: "safe" } });
    expect(events).toEqual([{ method: "account/status", params: { accessToken: "[redacted]", detail: "safe" } }]);
    fake.reconcile();
    expect(session.status().state).toBe("unknown_settlement");
    await session.stop().catch(() => undefined);
  });

  test("returns an explicit unavailable status when kernel launch fails", async () => {
    const options = {
      clients: { jobs: { Start: async () => { throw new Error("codex missing"); } } },
      context,
      workspace_id: "workspace",
      public_env: {},
    } as never;
    await expect(probeCodexAppServer(options)).resolves.toMatchObject({ available: false, external_harness: "codex", reason: "the Codex App Server could not be started through the kernel" });
  });
});

test("the bridge has no auth-store or direct process/socket implementation", async () => {
  const source = await Bun.file(new URL("./codex-app-server.ts", import.meta.url)).text();
  expect(source).not.toContain("auth.json");
  expect(source).not.toContain("createConnection");
  expect(source).not.toContain("spawn(");
});
