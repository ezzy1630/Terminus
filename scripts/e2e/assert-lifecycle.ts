/**
 * Public-API assertions for the deterministic lifecycle harness.
 *
 * This file intentionally has no process, filesystem, socket, or secret
 * authority. The shell supervisor owns service lifecycle; this runner uses
 * only the public control-plane HTTP/SSE contract.
 */

type JsonObject = Record<string, unknown>;

const baseUrl = process.env.TERMINUS_E2E_CONTROL_URL ?? "http://127.0.0.1:3050";
const token = process.env.TERMINUS_E2E_CONTROL_TOKEN;
const workspaceRoot = process.env.TERMINUS_E2E_WORKSPACE_ROOT;

if (!token || !workspaceRoot) {
  throw new Error("E2E control token and workspace root are required");
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object`);
  }
  return value as JsonObject;
}

function stringField(value: JsonObject, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} was not a non-empty string`);
  }
  return field;
}

async function api(method: "GET" | "POST", path: string, body?: JsonObject): Promise<JsonObject> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body) {
    headers["content-type"] = "application/json";
    headers["x-idempotency-key"] = crypto.randomUUID();
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(parsed)}`);
  }
  return asObject(parsed, `${method} ${path}`);
}

async function expectFailure(method: "GET" | "POST", path: string, expectedStatus: number): Promise<void> {
  try {
    await api(method, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`failed (${expectedStatus})`)) return;
    throw new Error(`unexpected failure for ${method} ${path}: ${message}`);
  }
  throw new Error(`${method} ${path} unexpectedly succeeded`);
}

async function waitForCompletion(taskId: string): Promise<JsonObject> {
  const deadline = Date.now() + 15_000;
  let task = await api("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
  while (task.status !== "COMPLETED") {
    if (task.status === "FAILED" || task.status === "ABORTED" || Date.now() >= deadline) {
      throw new Error(`task did not complete: ${JSON.stringify(task)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    task = await api("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
  }
  return task;
}

const workspace = await api("POST", "/v1/workspaces/open", {
  root_uri: workspaceRoot,
  kind: "local_directory",
  trust: "trusted",
  policy_profile_id: "secure-local-default",
});
const workspaceId = stringField(workspace, "id", "workspace");

const session = await api("POST", "/v1/sessions", {
  workspace_id: workspaceId,
  title: "deterministic release lifecycle",
});
const sessionId = stringField(session, "id", "session");
const threadId = stringField(session, "active_thread_id", "session");

const task = await api("POST", "/v1/tasks", {
  session_id: sessionId,
  thread_id: threadId,
  objective: "exercise the complete deterministic task lifecycle",
  non_goals: ["external side effects"],
  acceptance_criteria: [
    { id: "lifecycle", statement: "The task reaches COMPLETED with verification evidence.", required: true },
  ],
  allowed_scope: { read_paths: ["/**"], write_paths: [], external_systems: [] },
});
const taskId = stringField(task, "id", "task");

const streamController = new AbortController();
const streamResponse = await fetch(`${baseUrl}/v1/events?task_id=${encodeURIComponent(taskId)}`, {
  headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
  signal: streamController.signal,
});
if (!streamResponse.ok || !streamResponse.body) {
  throw new Error(`event subscription failed (${streamResponse.status})`);
}
const streamReader = streamResponse.body.getReader();

await api("POST", `/v1/tasks/${encodeURIComponent(taskId)}/start`, {});
const turn = await api("POST", "/v1/turns", {
  thread_id: threadId,
  task_id: taskId,
  user_input: "run the deterministic lifecycle",
});
const turnId = stringField(turn, "id", "turn");
const completed = await waitForCompletion(taskId);
if (completed.phase !== "COMPLETE") {
  throw new Error(`completed task has unexpected phase: ${JSON.stringify(completed)}`);
}

const toolCatalog = await api("GET", "/v1/tools");
if (!Array.isArray(toolCatalog.tools) || toolCatalog.tools.length < 5 || toolCatalog.default_profile !== "secure-local-default") {
  throw new Error(`tool catalog did not expose the secure default: ${JSON.stringify(toolCatalog)}`);
}
await expectFailure("GET", "/v1/tasks/00000000-0000-7000-8000-000000000000", 404);

const eventDeadline = Date.now() + 3_000;
let eventChunk = "";
while (Date.now() < eventDeadline && !eventChunk.includes("task.") && !eventChunk.includes("turn.")) {
  const remaining = eventDeadline - Date.now();
  const next = await Promise.race([
    streamReader.read(),
    new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
      setTimeout(() => reject(new Error("event stream produced no lifecycle event")), remaining),
    ),
  ]);
  if (next.done) break;
  eventChunk += new TextDecoder().decode(next.value);
}
streamController.abort();
await streamReader.cancel();
if (!eventChunk.includes("task.") && !eventChunk.includes("turn.")) {
  throw new Error(`event stream did not contain a lifecycle event: ${eventChunk.slice(0, 500)}`);
}

const exported = await api("POST", "/v1/system/export", {});
const exportManifest = asObject(exported.manifest, "export.manifest");
if (exportManifest.format !== "terminus-export-v1") {
  throw new Error(`unexpected export format: ${JSON.stringify(exported)}`);
}
const events = exported.events;
const manifests = exported.context_manifests;
const verifications = exported.verification_plans;
if (!Array.isArray(events) || events.length === 0) throw new Error("export did not contain events");
if (!Array.isArray(manifests) || manifests.length === 0) throw new Error("export did not contain context manifests");
if (!Array.isArray(verifications) || verifications.length === 0) throw new Error("export did not contain verification plans");

const verification = asObject(verifications[0], "verification plan");
const verificationId = stringField(verification, "id", "verification plan");
const verificationView = await api("GET", `/v1/verification/plans/${encodeURIComponent(verificationId)}`);
if (!Array.isArray(verificationView.nodes) || verificationView.nodes.length < 3) {
  throw new Error(`verification DAG was incomplete: ${JSON.stringify(verificationView)}`);
}
const verificationResults = verification.results;
if (!Array.isArray(verificationResults) || verificationResults.length < 3 || verificationResults.some((result) => asObject(result, "verification result").status !== "pass")) {
  throw new Error(`verification evidence was incomplete: ${JSON.stringify(verification)}`);
}

const checkpoint = await api("POST", "/v1/checkpoints", {
  session_id: sessionId,
  thread_id: threadId,
  task_id: taskId,
  workspace_revision: "no-vcs",
  dirty_state_digest: "sha256:e2e-clean",
});
const checkpointId = stringField(checkpoint, "id", "checkpoint");
const checkpointView = await api("GET", `/v1/checkpoints/${encodeURIComponent(checkpointId)}`);
if (checkpointView.task_id !== taskId) throw new Error(`checkpoint did not bind to task: ${JSON.stringify(checkpointView)}`);

const forked = await api("POST", `/v1/threads/${encodeURIComponent(threadId)}/fork`, { from_turn_id: turnId });
if (forked.parent_thread_id !== threadId || forked.forked_from_turn_id !== turnId) {
  throw new Error(`thread fork did not preserve lineage: ${JSON.stringify(forked)}`);
}
const paused = await api("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/pause`, {});
if (paused.status !== "paused") throw new Error(`session pause did not persist: ${JSON.stringify(paused)}`);

const recovery = await api("POST", "/v1/system/recover", {});
if (recovery.integrity_ok !== true || typeof recovery.id !== "string") {
  throw new Error(`recovery report did not prove integrity: ${JSON.stringify(recovery)}`);
}

console.log(JSON.stringify({
  status: "passed",
  workspace_id: workspaceId,
  session_id: sessionId,
  task_id: taskId,
  turn_id: turnId,
  event_count: events.length,
  context_manifest_count: manifests.length,
  verification_plan_count: verifications.length,
}, null, 2));
