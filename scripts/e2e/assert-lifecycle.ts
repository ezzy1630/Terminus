/**
 * Public-API assertions for the deterministic lifecycle harness.
 *
 * This file intentionally has no process, filesystem, socket, or secret
 * authority. The shell supervisor owns service lifecycle; this runner uses
 * only the public control-plane HTTP/SSE contract.
 */

type JsonObject = Record<string, unknown>;
type ApiOptions = { idempotencyKey?: string };

const baseUrl = process.env.TERMINUS_E2E_CONTROL_URL ?? "http://127.0.0.1:3050";
const token = process.env.TERMINUS_E2E_CONTROL_TOKEN;
const workspaceRoot = process.env.TERMINUS_E2E_WORKSPACE_ROOT;
const debug = (message: string): void => {
  if (process.env.TERMINUS_E2E_DEBUG === "1") console.error(`[e2e] ${message}`);
};

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

async function api(
  method: "GET" | "POST",
  path: string,
  body?: JsonObject,
  options: ApiOptions = {},
): Promise<JsonObject> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body) {
    headers["content-type"] = "application/json";
    headers["x-idempotency-key"] = options.idempotencyKey ?? crypto.randomUUID();
    init.body = JSON.stringify(body);
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
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
    if (response.status === 409 && options.idempotencyKey) {
      const error = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonObject).error
        : null;
      const errorObject = error && typeof error === "object" && !Array.isArray(error)
        ? error as JsonObject
        : null;
      if (errorObject?.code === "IDEMPOTENCY_IN_PROGRESS") {
        const retryAfter = typeof errorObject.details === "object" && errorObject.details !== null
          && !Array.isArray(errorObject.details)
          && typeof (errorObject.details as JsonObject).retry_after_ms === "number"
          ? (errorObject.details as JsonObject).retry_after_ms as number
          : 500;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 50), 1_000)));
        continue;
      }
    }
    if (!response.ok) {
      throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(parsed)}`);
    }
    return asObject(parsed, `${method} ${path}`);
  }
  throw new Error(`${method} ${path} exceeded idempotency retry budget`);
}

async function expectFailure(
  method: "GET" | "POST",
  path: string,
  expectedStatus: number,
  body?: JsonObject,
  options?: ApiOptions,
): Promise<void> {
  try {
    await api(method, path, body, options);
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

const workspaceRequest = {
  root_uri: workspaceRoot,
  kind: "local_directory",
  trust: "trusted",
  policy_profile_id: "secure-local-default",
};
const workspaceOpenKey = "e2e-workspace-open-v1";
const workspace = await api("POST", "/v1/workspaces/open", workspaceRequest, {
  idempotencyKey: workspaceOpenKey,
});
debug("workspace opened and replayed");
const workspaceId = stringField(workspace, "id", "workspace");
const workspaceReplay = await api("POST", "/v1/workspaces/open", workspaceRequest, {
  idempotencyKey: workspaceOpenKey,
});
if (stringField(workspaceReplay, "id", "workspace replay") !== workspaceId) {
  throw new Error(`idempotency replay created a second workspace: ${JSON.stringify(workspaceReplay)}`);
}
await expectFailure(
  "POST",
  "/v1/workspaces/open",
  409,
  { ...workspaceRequest, root_uri: `${workspaceRoot}/different` },
  { idempotencyKey: workspaceOpenKey },
);

const readFixture = await api("POST", "/v1/tools/read", {
  workspace_id: "dev",
  path: "e2e-fixture.txt",
});
const readArtifact = readFixture.fullContent ?? readFixture.full_content;
if (!readArtifact || typeof readArtifact !== "object") {
  throw new Error(`kernel UDS file read did not return an artifact: ${JSON.stringify(readFixture)}`);
}
const sourceVersion = asObject(readFixture.sourceVersion ?? readFixture.source_version, "read source version");
const fixtureSha = stringField(sourceVersion, "sha256", "read source version");
const patchBody = {
  workspace_id: "dev",
  path: "e2e-fixture.txt",
  expected_sha256: fixtureSha,
  expected_utf8: "Terminus deterministic read fixture.\n",
  replacement_utf8: "Terminus deterministic patched fixture.\n",
};
const preview = await api("POST", "/v1/tools/patch", { ...patchBody, commit_mode: "preview" });
if (preview.state !== "preview" && preview.state !== "staged") {
  throw new Error(`patch preview did not remain non-mutating: ${JSON.stringify(preview)}`);
}
const applied = await api("POST", "/v1/tools/patch", { ...patchBody, commit_mode: "apply" });
if (applied.state !== "applied") {
  throw new Error(`patch apply did not settle: ${JSON.stringify(applied)}`);
}
await expectFailure("POST", "/v1/tools/patch", 500, { ...patchBody, commit_mode: "apply" });

const exec = await api("POST", "/v1/tools/exec", {
  program: "/bin/ls",
  args: ["-d", "."],
  cwd: ".",
  sandbox_profile_id: "degraded-local",
});
if (!stringField(exec, "processId" in exec ? "processId" : "process_id", "exec").length) {
  throw new Error(`kernel UDS process start did not return a process id: ${JSON.stringify(exec)}`);
}

const job = await api("POST", "/v1/tools/job", {
  program: "/bin/cat",
  args: [],
  cwd: ".",
  sandbox_profile_id: "degraded-local",
  durable: true,
});
const jobId = stringField(job, "jobId" in job ? "jobId" : "job_id", "job");
const jobView = await api("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
if (!stringField(jobView, "jobId" in jobView ? "jobId" : "job_id", "job view")) {
  throw new Error(`durable job was not visible through control: ${JSON.stringify(jobView)}`);
}
await api("POST", `/v1/jobs/${encodeURIComponent(jobId)}/stop`, { reason: "deterministic cleanup" });
debug("kernel file/process/job paths completed");

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

const deniedApproval = await api("POST", "/v1/approvals", {
  task_id: taskId,
  operation_hash: "sha256:e2e-deny",
  risk: { class: "high", effects: ["WRITE_LOCAL"] },
});
const deniedApprovalId = stringField(deniedApproval, "id", "denied approval");
const pendingApprovals = await api("GET", "/v1/approvals");
if (!Array.isArray(pendingApprovals.approvals) || !pendingApprovals.approvals.some((candidate) => asObject(candidate, "approval").id === deniedApprovalId)) {
  throw new Error(`pending approval was not listed: ${JSON.stringify(pendingApprovals)}`);
}
const denied = await api("POST", `/v1/approvals/${encodeURIComponent(deniedApprovalId)}/resolve`, {
  decision: "deny_once",
  rationale: "deterministic denial path",
});
if (denied.status !== "denied") throw new Error(`approval denial did not persist: ${JSON.stringify(denied)}`);

const allowedApproval = await api("POST", "/v1/approvals", {
  task_id: taskId,
  operation_hash: "sha256:e2e-allow",
  risk: { class: "normal", effects: ["READ_LOCAL"] },
});
const allowedApprovalId = stringField(allowedApproval, "id", "allowed approval");
const allowed = await api("POST", `/v1/approvals/${encodeURIComponent(allowedApprovalId)}/resolve`, {
  decision: "allow_once",
  rationale: "deterministic approval path",
});
if (allowed.status !== "allowed") throw new Error(`approval allow did not persist: ${JSON.stringify(allowed)}`);

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
debug("task started");
const turn = await api("POST", "/v1/turns", {
  thread_id: threadId,
  task_id: taskId,
  user_input: "run the deterministic lifecycle",
});
const turnId = stringField(turn, "id", "turn");
const completed = await waitForCompletion(taskId);
debug("task completed");
if (completed.phase !== "COMPLETE") {
  throw new Error(`completed task has unexpected phase: ${JSON.stringify(completed)}`);
}

const interruptTask = await api("POST", "/v1/tasks", {
  session_id: sessionId,
  thread_id: threadId,
  objective: "exercise deterministic turn interruption",
  non_goals: ["completion"],
  acceptance_criteria: [{ id: "interrupt", statement: "The turn can be interrupted safely.", required: true }],
  allowed_scope: { read_paths: ["/**"], write_paths: [], external_systems: [] },
});
const interruptTaskId = stringField(interruptTask, "id", "interrupt task");
await api("POST", `/v1/tasks/${encodeURIComponent(interruptTaskId)}/start`, {});
const interruptTurn = await api("POST", "/v1/turns", {
  thread_id: threadId,
  task_id: interruptTaskId,
  user_input: "interrupt this deterministic turn",
});
const interruptTurnId = stringField(interruptTurn, "id", "interrupt turn");
const interrupted = await api("POST", `/v1/turns/${encodeURIComponent(interruptTurnId)}/interrupt`, {
  reason: "deterministic interruption",
});
if (interrupted.state !== "INTERRUPTED") {
  throw new Error(`turn interruption did not persist: ${JSON.stringify(interrupted)}`);
}
await api("POST", `/v1/tasks/${encodeURIComponent(interruptTaskId)}/cancel`, { reason: "cleanup interrupted fixture" });

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
debug("event stream abort requested");
await streamReader.cancel();
debug("event stream cancelled");
if (!eventChunk.includes("task.") && !eventChunk.includes("turn.")) {
  throw new Error(`event stream did not contain a lifecycle event: ${eventChunk.slice(0, 500)}`);
}

const exported = await api("POST", "/v1/system/export", {});
debug("export loaded");
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

const imported = await api("POST", "/v1/system/import", exported);
debug("import completed");
if (imported.status !== "imported" || typeof imported.import_id !== "string") {
  throw new Error(`export/import round-trip failed: ${JSON.stringify(imported)}`);
}

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
debug("recovery loaded");
if (recovery.integrity_ok !== true || typeof recovery.id !== "string") {
  throw new Error(`recovery report did not prove integrity: ${JSON.stringify(recovery)}`);
}

console.log(JSON.stringify({
  status: "passed",
  workspace_id: workspaceId,
  session_id: sessionId,
  task_id: taskId,
  turn_id: turnId,
  thread_id: threadId,
  checkpoint_id: checkpointId,
  event_count: events.length,
  context_manifest_count: manifests.length,
  verification_plan_count: verifications.length,
  import_status: imported.status,
}, null, 2));
