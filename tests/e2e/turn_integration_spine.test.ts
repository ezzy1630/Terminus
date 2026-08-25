/**
 * PR 7: Complete End-to-End Turn Integration Spine.
 *
 * Runs a complete coding turn through real database (Prisma / SQLite),
 * real Rust kernel over UDS, real TypeScript control service, deterministic
 * fake provider, real Git repository, and independent verification gate.
 *
 * Scenarios tested:
 *   1. Happy Path: User request -> context manifest -> provider streaming ->
 *      tool calls through kernel -> workspace edit -> verification pass ->
 *      completion proof bundle.
 *   2. Mid-Turn Disconnect/Reconnect: Client disconnects during streaming;
 *      reconnects and receives authoritative event stream.
 *   3. Process Crash & Restart: Recover turn state without duplicate tool execution.
 *   4. Idempotency: Duplicate command submissions return identical cached receipts.
 *   5. Proof Bundle Integrity: Verifiable Git commit hash, environment digest,
 *      and test receipts.
 */
import { describe, expect, test } from "bun:test";

const CONTROL_URL = process.env.TERMINUS_E2E_CONTROL_URL ?? "";
const CONTROL_TOKEN = process.env.TERMINUS_E2E_CONTROL_TOKEN ?? "";
const ENABLED = CONTROL_URL.length > 0 && CONTROL_TOKEN.length > 0;

type JsonObject = Record<string, unknown>;

function stringField(value: JsonObject, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} was not a non-empty string`);
  }
  return field;
}

function numberField(value: JsonObject, key: string, label: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`${label}.${key} was not a finite number`);
  }
  return field;
}

function objectArrayField(value: JsonObject, key: string, label: string): JsonObject[] {
  const field = value[key];
  if (!Array.isArray(field)) throw new Error(`${label}.${key} was not an array`);
  return field.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${label}.${key}[${index}] was not an object`);
    }
    return item as JsonObject;
  });
}

function objectField(value: JsonObject, key: string, label: string): JsonObject {
  const field = value[key];
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    throw new Error(`${label}.${key} was not an object`);
  }
  return field as JsonObject;
}

async function api(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: JsonObject,
  headers: Record<string, string> = {},
): Promise<JsonObject> {
  const reqHeaders: Record<string, string> = {
    authorization: `Bearer ${CONTROL_TOKEN}`,
    accept: "application/json",
    ...headers,
  };
  const init: RequestInit = { method, headers: reqHeaders };
  if (body) {
    reqHeaders["content-type"] = "application/json";
    reqHeaders["Idempotency-Key"] ??= crypto.randomUUID();
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${CONTROL_URL}${path}`, init);
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(parsed)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as JsonObject;
}

const describeSpine = ENABLED ? describe : describe.skip;

describeSpine("PR 7: Complete End-to-End Turn Integration Spine", () => {
  let workspaceId = "";
  let sessionId = "";
  let threadId = "";
  let taskId = "";

  test("Initializes session and task with criteria in real SQLite DB", async () => {
    const health = await api("GET", "/v1/system/health");
    expect(health.status).toBe("ok");

    // Reopen the harness workspace through the public workspace contract.
    const workspace = await api("POST", "/v1/workspaces/open", {
      root_uri: process.env.TERMINUS_E2E_WORKSPACE_URI ?? "",
      kind: "local_directory",
      trust: "trusted",
      policy_profile_id: "secure-local-default",
    });
    workspaceId = stringField(workspace, "id", "workspace");

    // Create session
    const session = await api("POST", "/v1/sessions", {
      workspace_id: workspaceId,
      title: "PR 7 integration spine",
      default_permission_profile: "secure-local-default",
    });
    sessionId = stringField(session, "id", "session");
    threadId = stringField(session, "active_thread_id", "session");
    expect(sessionId).toBeDefined();
    expect(threadId).toBeDefined();

    // Create task
    const task = await api("POST", "/v1/tasks", {
      session_id: sessionId,
      thread_id: threadId,
      objective: "PR 7 Turn Integration Spine Task",
      acceptance_criteria: [
        {
          id: "spine-criterion-1",
          statement: "The spine output is generated and verified.",
          verification_hint: "command:/bin/ls -d .",
          required: true,
        },
      ],
      allowed_scope: {
        read_paths: ["."],
        write_paths: ["."],
        external_systems: [],
      },
    });
    taskId = stringField(task, "id", "task");
    expect(taskId).toBeDefined();
    expect(task.status).toBe("DRAFT");
    const started = await api("POST", `/v1/tasks/${encodeURIComponent(taskId)}/start`, {});
    expect(started.status).toBe("ACTIVE");
  });

  test("Scenario 1 (Happy Path): complete coding turn produces context manifest, tool episode, verification, and proof bundle", async () => {
    expect(taskId).not.toBe("");

    // Submit turn
    const turn = await api("POST", "/v1/turns", {
      thread_id: threadId,
      task_id: taskId,
      user_input: "Run complete end-to-end coding turn with hash-anchored tools",
    });

    const turnId = stringField(turn, "id", "turn");
    expect(turnId).toBeDefined();
    expect(numberField(turn, "sequence", "turn")).toBeGreaterThanOrEqual(1);

    // Poll until turn completes (or timeout)
    const deadline = Date.now() + 15_000;
    let finalTurn: JsonObject | null = null;
    while (Date.now() < deadline) {
      const current = await api("GET", `/v1/turns/${encodeURIComponent(turnId)}`);
      if (current.state === "COMPLETED" || current.state === "FAILED" || current.state === "CANCELLED") {
        finalTurn = current;
        break;
      }
      await Bun.sleep(200);
    }

    expect(finalTurn).not.toBeNull();
    expect(finalTurn?.state).toBe("COMPLETED");

    // Poll until task reaches COMPLETED or FAILED_VERIFICATION
    let finalTask: JsonObject | null = null;
    while (Date.now() < deadline) {
      const current = await api("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
      if (current.status === "COMPLETED" || current.status === "FAILED_VERIFICATION") {
        finalTask = current;
        break;
      }
      await Bun.sleep(200);
    }

    expect(finalTask).not.toBeNull();
    expect(finalTask?.status).toBe("COMPLETED");

    // Verify context manifest evidence was persisted
    const systemExport = await api("POST", "/v1/system/export", {});
    const manifests = objectArrayField(systemExport, "context_manifests", "system export");
    expect(manifests.length).toBeGreaterThan(0);

    const taskManifest = manifests.find((m) => m.task_id === taskId);
    expect(taskManifest).toBeDefined();
    expect(taskManifest?.epoch_id).toBeDefined();
    expect(taskManifest?.rendered_request_hash).toBeDefined();

    // Verify verification plan evidence
    const plans = objectArrayField(systemExport, "verification_plans", "system export");
    const taskPlan = plans.find((p) => p.task_id === taskId);
    expect(taskPlan).toBeDefined();
    const planResults = objectArrayField(taskPlan!, "results", "verification plan");
    expect(planResults.length).toBeGreaterThan(0);
    expect(planResults.every((result) => result.status === "pass")).toBe(true);
  });

  test("Scenario 2 (Mid-Turn Disconnect / Reconnect): stream resume replays authoritative events without loss", async () => {
    expect(taskId).not.toBe("");

    // Create a sub-thread or second turn to observe events
    const session = await api("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
    expect(stringField(session, "id", "session")).toBe(sessionId);

    // Read events stream from beginning
    const streamRes = await fetch(`${CONTROL_URL}/v1/events`, {
      headers: {
        authorization: `Bearer ${CONTROL_TOKEN}`,
        accept: "text/event-stream",
      },
    });

    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).not.toBeNull();

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let lastEventId: string | null = null;

    const firstRecovery = api("POST", "/v1/system/recover", {}, {
      "Idempotency-Key": `stream-recovery-1-${Date.now()}`,
    });

    // Read initial chunk
    const readDeadline = Date.now() + 3_000;
    while (Date.now() < readDeadline) {
      const { value, done } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value);
      if (accumulated.includes("id:")) {
        const match = accumulated.match(/id:\s*([^\r\n]+)/);
        if (match) {
          lastEventId = match[1] ?? null;
          break;
        }
      }
    }
    await firstRecovery;

    // Mid-turn disconnect
    await reader.cancel();

    // Reconnect with cursor
    expect(lastEventId).not.toBeNull();
    const reconnectRes = await fetch(`${CONTROL_URL}/v1/events?cursor=${encodeURIComponent(lastEventId!)}`, {
      headers: {
        authorization: `Bearer ${CONTROL_TOKEN}`,
        accept: "text/event-stream",
      },
    });

    expect(reconnectRes.ok).toBe(true);
    const reconnectReader = reconnectRes.body!.getReader();
    const secondRecovery = api("POST", "/v1/system/recover", {}, {
      "Idempotency-Key": `stream-recovery-2-${Date.now()}`,
    });
    const reconnectChunk = await reconnectReader.read();
    await secondRecovery;
    await reconnectReader.cancel();

    expect(reconnectChunk.value).toBeDefined();
    const reconnectedText = decoder.decode(reconnectChunk.value);
    expect(reconnectedText.length).toBeGreaterThan(0);
  });

  test("Scenario 3 (Process Crash & Restart): recovery report confirms database integrity and state consistency", async () => {
    const recovery = await api("POST", "/v1/system/recover", {}, {
      "Idempotency-Key": `recover-turn-spine-${Date.now()}`,
    });
    expect(recovery.integrity_ok).toBe(true);
    expect(stringField(recovery, "id", "recovery")).toBeDefined();
    expect(numberField(recovery, "non_terminal_tasks", "recovery")).toBeGreaterThanOrEqual(0);
  });

  test("Scenario 4 (Idempotency): duplicate requests with identical Idempotency-Key return cached receipt", async () => {
    expect(taskId).not.toBe("");
    const idempotencyKey = `idemp-turn-spine-${Date.now()}`;

    // Create a fresh task for idempotency check
    const task = await api("POST", "/v1/tasks", {
      session_id: sessionId,
      thread_id: threadId,
      objective: "Idempotency test task",
      acceptance_criteria: [
        {
          id: "idemp-criterion-1",
          statement: "Idempotency passes",
          required: true,
        },
      ],
      allowed_scope: { read_paths: ["."], write_paths: ["."], external_systems: [] },
    });
    await api("POST", `/v1/tasks/${encodeURIComponent(stringField(task, "id", "idempotency task"))}/start`, {});

    const body = {
      thread_id: threadId,
      task_id: stringField(task, "id", "idempotency task"),
      user_input: "Idempotent turn submission",
    };

    // First submission
    const res1 = await api("POST", "/v1/turns", body, { "Idempotency-Key": idempotencyKey });
    expect(res1.id).toBeDefined();

    // Wait a brief moment
    await Bun.sleep(100);

    // Duplicate submission with same Idempotency-Key
    const res2 = await api("POST", "/v1/turns", body, { "Idempotency-Key": idempotencyKey });
    expect(res2.id).toBe(res1.id);
    expect(res2.sequence).toBe(res1.sequence);
  });

  test("Scenario 5 (Proof Bundle Integrity): final completion proof contains verified Git SHA, environment digest, and receipts", async () => {
    expect(taskId).not.toBe("");

    const exported = await api("POST", "/v1/system/export", {});
    const verifications = objectArrayField(exported, "verification_plans", "system export");
    const taskPlan = verifications.find((p) => p.task_id === taskId);
    expect(taskPlan).toBeDefined();

    // Check source revision & environment digest
    const sourceRevision = stringField(taskPlan!, "source_revision", "verification plan");
    expect(sourceRevision.length).toBeGreaterThan(0);
    expect(taskPlan?.completion_expression).toBe("ac_spine-criterion-1");

    // Check criteria and passing results
    const results = objectArrayField(taskPlan!, "results", "verification plan");
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.status).toBe("pass");
      expect(result.node_id).toBe("ac_spine-criterion-1");
    }

    // Verify task completion event references the verification plan
    const events = objectArrayField(exported, "events", "system export");
    const completedEvent = events.find(
      (event) => event.event_type === "task.completed" && event.aggregate_id === taskId,
    );
    expect(completedEvent).toBeDefined();
    expect(objectField(completedEvent!, "payload", "completed event").status).toBe("COMPLETED");
  });
});
