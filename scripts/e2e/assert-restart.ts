/**
 * Second-phase lifecycle assertions. The shell supervisor restarts the
 * control plane between this file and assert-lifecycle.ts; this runner proves
 * that the SQLite state, checkpoint, task, and event journal remain usable.
 */

type JsonObject = Record<string, unknown>;

const baseUrl = process.env.TERMINUS_E2E_CONTROL_URL ?? "http://127.0.0.1:3050";
const token = process.env.TERMINUS_E2E_CONTROL_TOKEN;
const sessionId = process.env.TERMINUS_E2E_SESSION_ID;
const taskId = process.env.TERMINUS_E2E_TASK_ID;
const threadId = process.env.TERMINUS_E2E_THREAD_ID;
const checkpointId = process.env.TERMINUS_E2E_CHECKPOINT_ID;

if (!token || !sessionId || !taskId || !threadId || !checkpointId) {
  throw new Error("restart E2E identifiers and control token are required");
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object`);
  }
  return value as JsonObject;
}

function nonEmpty(value: JsonObject, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw new Error(`${label}.${key} missing`);
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
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(parsed)}`);
  return object(parsed, `${method} ${path}`);
}

async function waitForCompletion(id: string): Promise<JsonObject> {
  const deadline = Date.now() + 15_000;
  let task = await api("GET", `/v1/tasks/${encodeURIComponent(id)}`);
  while (task.status !== "COMPLETED") {
    if (task.status === "FAILED" || task.status === "ABORTED" || Date.now() >= deadline) {
      throw new Error(`resumed task did not complete: ${JSON.stringify(task)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    task = await api("GET", `/v1/tasks/${encodeURIComponent(id)}`);
  }
  return task;
}

const beforeRecovery = await api("POST", "/v1/system/recover", {});
if (beforeRecovery.integrity_ok !== true) {
  throw new Error(`restart recovery integrity failed: ${JSON.stringify(beforeRecovery)}`);
}

const session = await api("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
if (session.id !== sessionId || session.status !== "paused") {
  throw new Error(`persistent paused session was not restored: ${JSON.stringify(session)}`);
}
const checkpoint = await api("GET", `/v1/checkpoints/${encodeURIComponent(checkpointId)}`);
if (checkpoint.task_id !== taskId || checkpoint.thread_id !== threadId) {
  throw new Error(`checkpoint lineage changed across restart: ${JSON.stringify(checkpoint)}`);
}
const tasks = await api("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`);
if (!Array.isArray(tasks.tasks) || !tasks.tasks.some((candidate) => object(candidate, "task").id === taskId)) {
  throw new Error(`original task was not recoverable: ${JSON.stringify(tasks)}`);
}

const resumedSession = await api("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/resume`, {});
if (resumedSession.status !== "active") {
  throw new Error(`session did not resume: ${JSON.stringify(resumedSession)}`);
}

const resumedTask = await api("POST", "/v1/tasks", {
  session_id: sessionId,
  thread_id: threadId,
  objective: "prove deterministic task resume after control-plane restart",
  non_goals: ["external side effects"],
  acceptance_criteria: [
    { id: "restart", statement: "The resumed task reaches completion after a control-plane restart.", required: true },
  ],
  allowed_scope: { read_paths: ["/**"], write_paths: [], external_systems: [] },
});
const resumedTaskId = nonEmpty(resumedTask, "id", "resumed task");
await api("POST", `/v1/tasks/${encodeURIComponent(resumedTaskId)}/start`, {});
const resumedTurn = await api("POST", "/v1/turns", {
  thread_id: threadId,
  task_id: resumedTaskId,
  user_input: "resume the deterministic lifecycle after restart",
});
const resumedTurnId = nonEmpty(resumedTurn, "id", "resumed turn");
const completed = await waitForCompletion(resumedTaskId);
if (completed.phase !== "COMPLETE") throw new Error(`resumed task phase was not COMPLETE: ${JSON.stringify(completed)}`);

const afterRecovery = await api("POST", "/v1/system/recover", {});
if (afterRecovery.integrity_ok !== true) {
  throw new Error(`post-resume recovery integrity failed: ${JSON.stringify(afterRecovery)}`);
}

console.log(JSON.stringify({
  status: "passed",
  recovered_session_id: sessionId,
  original_task_id: taskId,
  resumed_task_id: resumedTaskId,
  resumed_turn_id: resumedTurnId,
  recovery_reports: [beforeRecovery.id, afterRecovery.id],
}, null, 2));
