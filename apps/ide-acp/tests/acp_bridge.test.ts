import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const ACP_SCRIPT = join(ROOT, "apps", "ide-acp", "src", "index.ts");
const AUTH_VALUE = "fixture-auth-value";

interface ObservedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly idempotencyKey: string | null;
  readonly xformPort: string | null;
}

describe("IDE-ACP JSON-RPC Bridge", () => {
  let mockServer: ReturnType<typeof Bun.serve>;
  let gatewayUrl: string;
  const observedRequests: ObservedRequest[] = [];

  beforeAll(() => {
    mockServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const observed = {
          method: req.method,
          path: url.pathname,
          authorization: req.headers.get("authorization"),
          idempotencyKey: req.headers.get("idempotency-key"),
          xformPort: url.searchParams.get("XTransformPort"),
        } satisfies ObservedRequest;
        observedRequests.push(observed);
        if (observed.authorization !== `Bearer ${AUTH_VALUE}`) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (url.pathname === "/v1/system/health") {
          return Response.json({
            status: "ok",
            version: "0.1.0",
            build_commit: "fixture",
            instance_id: "fixture-control",
            uptime_seconds: 1,
            ready: true,
          });
        }
        if (url.pathname === "/v2/ide/context-sync") {
          return Response.json({
            synced: true,
            contextHash: `sha256:${"a".repeat(64)}`,
            receivedDiagnostics: 0,
            durability: "process_local",
          });
        }
        if (url.pathname === "/v2/interventions") {
          return Response.json({
            id: "intervention-1",
            taskId: "task-001",
            attemptId: null,
            actorPrincipal: "ide-operator",
            verb: "pause",
            targetEntityId: null,
            payload: {},
            rationale: "operator paused for manual inspection",
            status: "PROPOSED",
            timestamp: "2026-08-23T00:00:00.000Z",
          });
        }
        if (url.pathname === "/v2/attention/assess/task-001") {
          return Response.json({
            taskId: "task-001",
            requiresAttention: true,
            urgency: "HIGH",
            pendingQuestions: [],
            reason: "An irreversible effect requires operator attention",
            timestamp: "2026-08-23T00:00:00.000Z",
          });
        }
        if (url.pathname === "/v2/attention/questions") {
          return Response.json({
            questions: [
              {
                id: "q-1",
                taskId: "task-001",
                trigger: "irreversible_effect",
                questionText: "Apply schema migration?",
                consequenceMatrix: { yes: "Apply", no: "Stop" },
                options: ["yes", "no"],
                status: "PENDING",
                suggestedOption: null,
                selectedOption: null,
                createdAt: "2026-08-23T00:00:00.000Z",
                resolvedAt: null,
              },
            ],
          });
        }
        if (url.pathname === "/v2/replay/traces/task-001") {
          return Response.json({
            id: "trace-1",
            taskId: "task-001",
            attemptId: "attempt-1",
            pinnedInputsHash: `sha256:${"b".repeat(64)}`,
            steps: [],
            divergencePoints: [],
            omissionDiagnostics: [],
            createdAt: "2026-08-23T00:00:00.000Z",
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    gatewayUrl = `http://127.0.0.1:${mockServer.port}`;
  });

  beforeEach(() => {
    observedRequests.length = 0;
  });

  afterAll(() => {
    mockServer.stop();
  });

  it("handles initialize and protocol negotiation over stdio", async () => {
    const proc = spawn("bun", [ACP_SCRIPT], {
      env: { ...process.env, TERMINUS_GATEWAY: gatewayUrl, TERMINUS_TOKEN: AUTH_VALUE },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: proc.stdout });
    const responses: Array<Record<string, unknown>> = [];

    const promise = new Promise<void>((resolve) => {
      rl.on("line", (line) => {
        if (!line.trim()) return;
        responses.push(JSON.parse(line));
        if (responses.length >= 1) {
          resolve();
        }
      });
    });

    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "initialize",
        params: {},
      }) + "\n",
    );

    await promise;
    proc.kill();

    expect(responses.length).toBe(1);
    expect(responses[0]?.id).toBe("req-1");
    const result = responses[0]?.result as {
      server: { version: string; instance_id: string };
      protocol: { major: number; minor: number };
      capabilities: { supported: string[] };
    };
    expect(result.server.instance_id).toBe("terminus-ide-acp");
    expect(result.protocol.major).toBe(1);
    expect(result.capabilities.supported).toContain("forge_task_creation");
  });

  it("proxies v2 context sync and interventions to gateway", async () => {
    const proc = spawn("bun", [ACP_SCRIPT], {
      env: { ...process.env, TERMINUS_GATEWAY: gatewayUrl, TERMINUS_TOKEN: AUTH_VALUE },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: proc.stdout });
    const responses: Array<Record<string, unknown>> = [];

    const promise = new Promise<void>((resolve) => {
      rl.on("line", (line) => {
        if (!line.trim()) return;
        responses.push(JSON.parse(line));
        if (responses.length >= 2) {
          resolve();
        }
      });
    });

    // Send context sync
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "sync-1",
        method: "terminus/v2/contextSync",
        params: {
          workspaceRootUri: "file:///workspace",
          activeFileUri: "file:///workspace/src/index.ts",
          selectedRange: { startLine: 1, startCol: 1, endLine: 10, endCol: 1 },
          diagnostics: [],
          openEditorUris: ["file:///workspace/src/index.ts"],
        },
      }) + "\n",
    );

    // Send intervention
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "intervene-1",
        method: "terminus/v2/intervene",
        params: {
          taskId: "task-001",
          verb: "pause",
          rationale: "operator paused for manual inspection",
        },
      }) + "\n",
    );

    await promise;
    proc.kill();

    expect(responses.length).toBe(2);
    expect(responses[0]?.id).toBe("sync-1");
    expect((responses[0]?.result as { synced: boolean }).synced).toBe(true);

    expect(responses[1]?.id).toBe("intervene-1");
    expect((responses[1]?.result as { status: string }).status).toBe("PROPOSED");
    expect(observedRequests).toHaveLength(2);
    expect(observedRequests.every(
      (request) => request.authorization === `Bearer ${AUTH_VALUE}`,
    )).toBe(true);
    expect(observedRequests.every(
      (request) => request.idempotencyKey !== null && request.idempotencyKey.length > 0,
    )).toBe(true);
    expect(new Set(observedRequests.map((request) => request.idempotencyKey)).size).toBe(2);
    expect(observedRequests.every((request) => request.xformPort === "3050")).toBe(true);
  });

  it("handles unknown JSON-RPC methods cleanly with error code -32601", async () => {
    const proc = spawn("bun", [ACP_SCRIPT], {
      env: { ...process.env, TERMINUS_GATEWAY: gatewayUrl, TERMINUS_TOKEN: AUTH_VALUE },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: proc.stdout });
    const responses: Array<Record<string, unknown>> = [];

    const promise = new Promise<void>((resolve) => {
      rl.on("line", (line) => {
        if (!line.trim()) return;
        responses.push(JSON.parse(line));
        resolve();
      });
    });

    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "invalid-1",
        method: "terminus/unknownMethod",
      }) + "\n",
    );

    await promise;
    proc.kill();

    expect(responses.length).toBe(1);
    expect(responses[0]?.id).toBe("invalid-1");
    const error = responses[0]?.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
  });

  it("fails closed before network access when TERMINUS_TOKEN is missing", async () => {
    const proc = spawn("bun", [ACP_SCRIPT], {
      env: { ...process.env, TERMINUS_GATEWAY: gatewayUrl, TERMINUS_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: proc.stdout });
    const response = new Promise<Record<string, unknown>>((resolve) => {
      rl.on("line", (line) => {
        if (line.trim()) resolve(JSON.parse(line));
      });
    });

    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: "health-without-auth",
      method: "terminus/health",
    }) + "\n");

    const message = await response;
    proc.kill();

    const error = message.error as { code: number; message: string };
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("TERMINUS_TOKEN must be set");
    expect(observedRequests).toHaveLength(0);
  });
});
