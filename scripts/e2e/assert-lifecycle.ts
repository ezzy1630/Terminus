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

const firstEvent = await Promise.race([
  streamReader.read(),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("event stream produced no event")), 3_000)),
]);
const eventChunk = new TextDecoder().decode(firstEvent.value);
streamController.abort();
await streamReader.cancel();
if (!eventChunk.includes("task.") && !eventChunk.includes("turn.")) {
  throw new Error(`event stream did not contain a lifecycle event: ${eventChunk.slice(0, 500)}`);
}

const exported = await api("POST", "/v1/system/export", {});
if (exported.format !== "terminus-export-v1") {
  throw new Error(`unexpected export format: ${JSON.stringify(exported)}`);
}
const events = exported.events;
const manifests = exported.context_manifests;
const verifications = exported.verification_plans;
if (!Array.isArray(events) || events.length === 0) throw new Error("export did not contain events");
if (!Array.isArray(manifests) || manifests.length === 0) throw new Error("export did not contain context manifests");
if (!Array.isArray(verifications) || verifications.length === 0) throw new Error("export did not contain verification plans");

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
