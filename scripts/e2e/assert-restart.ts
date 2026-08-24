/**
 * Second-phase lifecycle assertions. The shell supervisor restarts the
 * control plane between this file and assert-lifecycle.ts; this runner proves
 * that the SQLite state, checkpoint, task, and event journal remain usable.
 */

import { verifyCheckpointArtifact } from "./checkpoint-artifact.ts";
import { NONTERMINAL_JOB_STATES, RECOVERY_JOB_FIXTURES } from "./control-fixtures.ts";

type JsonObject = Record<string, unknown>;

const baseUrl = process.env.TERMINUS_E2E_CONTROL_URL ?? "http://127.0.0.1:3050";
const token = process.env.TERMINUS_E2E_CONTROL_TOKEN;
const sessionId = process.env.TERMINUS_E2E_SESSION_ID;
const taskId = process.env.TERMINUS_E2E_TASK_ID;
const resumeTaskId = process.env.TERMINUS_E2E_RESUME_TASK_ID;
const threadId = process.env.TERMINUS_E2E_THREAD_ID;
const checkpointId = process.env.TERMINUS_E2E_CHECKPOINT_ID;
const checkpointArtifactHash = process.env.TERMINUS_E2E_CHECKPOINT_ARTIFACT_HASH;
const sseCursor = process.env.TERMINUS_E2E_SSE_CURSOR;
const sseTaskId = process.env.TERMINUS_E2E_SSE_TASK_ID;
const sseEventCountRaw = process.env.TERMINUS_E2E_SSE_EVENT_COUNT;
const expectedTaskVersionRaw = process.env.TERMINUS_E2E_EXPECTED_TASK_VERSION;
const expectedTaskStatus = process.env.TERMINUS_E2E_EXPECTED_TASK_STATUS;

if (
  !token
  || !sessionId
  || !taskId
  || !resumeTaskId
  || !threadId
  || !checkpointId
  || !checkpointArtifactHash
  || !sseCursor
  || !sseTaskId
  || !sseEventCountRaw
  || !expectedTaskVersionRaw
  || !expectedTaskStatus
) {
  throw new Error("restart E2E identifiers and control token are required");
}
const sseEventCount = Number(sseEventCountRaw);
const expectedTaskVersion = Number(expectedTaskVersionRaw);
if (!Number.isInteger(sseEventCount) || sseEventCount <= 1_000) {
  throw new Error(`SSE replay fixture count was invalid: ${sseEventCountRaw}`);
}
if (!Number.isInteger(expectedTaskVersion) || expectedTaskVersion < 1) {
  throw new Error(`expected ARP v2 task version was invalid: ${expectedTaskVersionRaw}`);
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
    headers["Idempotency-Key"] = crypto.randomUUID();
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(parsed)}`);
  return object(parsed, `${method} ${path}`);
}

interface SseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: JsonObject;
}

async function readReplayEvents(
  cursor: string,
  filterTaskId: string,
  expectedCount: number,
  triggerLiveEvent: () => Promise<unknown>,
): Promise<readonly SseEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `${baseUrl}/v1/events?cursor=${encodeURIComponent(cursor)}&task_id=${encodeURIComponent(filterTaskId)}`,
      {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`paged SSE replay failed (${response.status})`);
    }
    const reader = response.body.getReader();
    let liveEventFailed = false;
    let liveEventError: unknown;
    const liveEventPromise = triggerLiveEvent().catch((error: unknown) => {
      liveEventFailed = true;
      liveEventError = error;
    });
    const decoder = new TextDecoder();
    const events: SseEvent[] = [];
    let buffered = "";
    try {
      while (events.length < expectedCount) {
        const next = await reader.read();
        if (next.done) break;
        buffered += decoder.decode(next.value, { stream: true }).replaceAll("\r\n", "\n");
        for (;;) {
          const boundary = buffered.indexOf("\n\n");
          if (boundary < 0) break;
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (block.length === 0 || block.startsWith(":")) continue;
          const fields = new Map<string, string>();
          for (const line of block.split("\n")) {
            const separator = line.indexOf(":");
            if (separator < 0) continue;
            fields.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
          }
          const id = fields.get("id");
          const event = fields.get("event");
          const data = fields.get("data");
          if (!id || !event || !data) continue;
          events.push({ id, event, data: object(JSON.parse(data) as unknown, `SSE event ${id}`) });
          if (events.length >= expectedCount) break;
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new Error(`paged SSE replay timed out after ${events.length}/${expectedCount} events`);
      }
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
      await liveEventPromise;
    }
    if (liveEventFailed) throw liveEventError;
    if (events.length !== expectedCount) {
      throw new Error(`paged SSE replay returned ${events.length}/${expectedCount} events`);
    }
    return events;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function v2Contract(input: {
  readonly version: number;
  readonly mission: string;
  readonly mode: "interactive" | "batch";
  readonly costMicros?: string;
  readonly timeoutSeconds?: number;
  readonly readPaths?: readonly string[];
  readonly writePaths?: readonly string[];
  readonly externalSystems?: readonly string[];
}): JsonObject {
  const readPaths = input.readPaths ?? [];
  const writePaths = input.writePaths ?? [];
  return {
    version: input.version,
    mission: input.mission,
    scope: {
      resources: [],
      allowedEffectClasses: [
        ...(readPaths.length > 0 ? ["LOCAL_FS_READ"] : []),
        ...(writePaths.length > 0 ? ["LOCAL_FS_WRITE"] : []),
      ],
      excludedPathsOrSystems: [],
      pathScope: {
        readPaths,
        writePaths,
        externalSystems: input.externalSystems ?? [],
      },
    },
    acceptance: [{
      claimId: `projection-${input.version}`,
      statement: "The public protocol projections remain coherent.",
      evidenceRequirement: "DETERMINISTIC_TEST",
    }],
    constraints: {
      security: ["NO_AMBIENT_SECRETS"],
      costMicros: input.costMicros ?? "1000000",
      timeoutSeconds: input.timeoutSeconds ?? 60,
    },
    authorityCeiling: [
      ...(readPaths.length > 0 ? ["FS_READ"] : []),
      ...(writePaths.length > 0 ? ["FS_WRITE"] : []),
    ],
    mode: input.mode,
  };
}

async function waitForTaskCompletion(id: string): Promise<JsonObject> {
  const deadline = Date.now() + 30_000;
  let task = await api("GET", `/v1/tasks/${encodeURIComponent(id)}`);
  while (task.status !== "COMPLETED") {
    if (
      task.status === "FAILED"
      || task.status === "FAILED_VERIFICATION"
      || task.status === "ABORTED"
      || task.status === "BLOCKED"
      || Date.now() >= deadline
    ) {
      throw new Error(`resumed task did not complete through the local provider: ${JSON.stringify(task)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    task = await api("GET", `/v1/tasks/${encodeURIComponent(id)}`);
  }
  if (task.terminal_reason !== null || task.phase !== "COMPLETE") {
    throw new Error(`resumed task retained a failure reason: ${JSON.stringify(task)}`);
  }
  return task;
}

const startupReconciledJobs = await Promise.all(
  RECOVERY_JOB_FIXTURES.map((fixture) => api("GET", `/v1/jobs/${encodeURIComponent(fixture.id)}`)),
);
for (const [index, job] of startupReconciledJobs.entries()) {
  const fixture = RECOVERY_JOB_FIXTURES[index];
  if (
    !fixture
    || job.state !== "LOST"
    || NONTERMINAL_JOB_STATES.has(String(job.state))
    || typeof job.settled_at !== "string"
  ) {
    throw new Error(`startup left a nonterminal ${fixture?.state ?? "unknown"} job stale: ${JSON.stringify(job)}`);
  }
}

const beforeRecovery = await api("POST", "/v1/system/recover", {});
if (beforeRecovery.integrity_ok !== true) {
  throw new Error(`restart recovery integrity failed: ${JSON.stringify(beforeRecovery)}`);
}

const overlapReason = "exercise the subscribe/replay overlap";
const replayedEvents = await readReplayEvents(
  sseCursor,
  sseTaskId,
  sseEventCount + 1,
  () => api("POST", `/v1/tasks/${encodeURIComponent(sseTaskId)}/cancel`, { reason: overlapReason }),
);
const replayedIds = replayedEvents.map((event) => event.id);
if (new Set(replayedIds).size !== replayedIds.length) {
  throw new Error("paged SSE replay emitted a duplicate event ID");
}
if (replayedIds.some((id, index) => index > 0 && id <= replayedIds[index - 1]!)) {
  throw new Error("paged SSE replay was not strictly ordered by event ID");
}
const replayFixtures = replayedEvents.filter((event) =>
  event.event === "test.replay" && event.data.fixture === "paged_replay"
);
const overlapEvents = replayedEvents.filter((event) =>
  event.event === "task.aborted" && event.data.reason === overlapReason
);
if (replayFixtures.length !== sseEventCount || overlapEvents.length !== 1) {
  throw new Error(
    `subscribe/replay overlap diverged: ${JSON.stringify({ replay: replayFixtures.length, live: overlapEvents })}`,
  );
}
for (const event of replayedEvents) {
  const isReplayFixture = event.event === "test.replay" && event.data.fixture === "paged_replay";
  const isOverlapEvent = event.event === "task.aborted" && event.data.reason === overlapReason;
  if (!isReplayFixture && !isOverlapEvent) {
    throw new Error(`SSE replay leaked a cross-task or cross-schema event: ${JSON.stringify(event)}`);
  }
}

const session = await api("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
if (session.id !== sessionId || session.status !== "paused") {
  throw new Error(`persistent paused session was not restored: ${JSON.stringify(session)}`);
}
const checkpoint = await api("GET", `/v1/checkpoints/${encodeURIComponent(checkpointId)}`);
if (checkpoint.task_id !== taskId || checkpoint.thread_id !== threadId) {
  throw new Error(`checkpoint lineage changed across restart: ${JSON.stringify(checkpoint)}`);
}
const originalTask = await api("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
const restartedV2Task = await api("GET", `/v2/tasks/${encodeURIComponent(taskId)}`);
if (
  restartedV2Task.id !== taskId
  || restartedV2Task.version !== expectedTaskVersion
  || restartedV2Task.status !== expectedTaskStatus
) {
  throw new Error(`malformed ARP v2 snapshots changed the replayed task: ${JSON.stringify(restartedV2Task)}`);
}
const originalContract = object(originalTask.contract, "original task contract");
const taskSourceVersion = nonEmpty(originalContract, "content_hash", "original task contract");
const checkpointSequences = object(
  checkpoint.last_committed_sequences,
  "checkpoint committed sequences",
);
const sourceTurnId = nonEmpty(checkpointSequences, "sourceTurnId", "checkpoint committed sequences");
const sourceTurnSequence = checkpointSequences.turn;
if (
  typeof sourceTurnSequence !== "number"
  || !Number.isInteger(sourceTurnSequence)
  || sourceTurnSequence < 0
) {
  throw new Error(`checkpoint source turn sequence was invalid: ${JSON.stringify(checkpointSequences)}`);
}
const verifiedCheckpoint = await verifyCheckpointArtifact({
  baseUrl,
  token,
  artifactUri: nonEmpty(checkpoint, "checkpoint_artifact", "checkpoint"),
  taskId,
  taskSourceVersion,
  sourceTurnId,
  sourceTurnSequence,
});
if (verifiedCheckpoint.hash !== checkpointArtifactHash) {
  throw new Error(
    `checkpoint artifact changed across restart: expected ${checkpointArtifactHash}, got ${verifiedCheckpoint.hash}`,
  );
}
const tasks = await api("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`);
if (!Array.isArray(tasks.tasks) || !tasks.tasks.some((candidate) => object(candidate, "task").id === taskId)) {
  throw new Error(`original task was not recoverable: ${JSON.stringify(tasks)}`);
}

const resumedSession = await api("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/resume`, {});
if (resumedSession.status !== "active") {
  throw new Error(`session did not resume: ${JSON.stringify(resumedSession)}`);
}

const resumedTaskId = resumeTaskId;
const resumedTurn = await api("POST", "/v1/turns", {
  thread_id: threadId,
  task_id: resumedTaskId,
  user_input: "resume the original checkpointed task after restart",
});
const resumedTurnId = nonEmpty(resumedTurn, "id", "resumed turn");
await waitForTaskCompletion(resumedTaskId);

const afterRecovery = await api("POST", "/v1/system/recover", {});
if (afterRecovery.integrity_ok !== true) {
  throw new Error(`post-resume recovery integrity failed: ${JSON.stringify(afterRecovery)}`);
}

const v2Created = await api("POST", "/v2/tasks", {
  missionId: null,
  organizationId: "default-org",
  departmentId: "default-dept",
  v1Context: { sessionId, threadId },
  contract: {
    version: 1,
    mission: "prove v2-to-v1 task identity projection",
    scope: {
      resources: [],
      allowedEffectClasses: ["LOCAL_FS_WRITE"],
      excludedPathsOrSystems: [],
    },
    acceptance: [{
      claimId: "same-id",
      statement: "Both protocol projections use the same durable task ID.",
      evidenceRequirement: "DETERMINISTIC_TEST",
    }],
    constraints: {
      security: ["NO_AMBIENT_SECRETS"],
      costMicros: "1000000",
      timeoutSeconds: 60,
    },
    authorityCeiling: ["FS_WRITE"],
    mode: "interactive",
  },
});
const v2CreatedId = nonEmpty(v2Created, "id", "v2-created task");
const v1Projection = await api("GET", `/v1/tasks/${encodeURIComponent(v2CreatedId)}`);
if (v1Projection.id !== v2CreatedId || v1Projection.session_id !== sessionId) {
  throw new Error(`v2-to-v1 task identity projection diverged: ${JSON.stringify(v1Projection)}`);
}
await api("POST", `/v1/tasks/${encodeURIComponent(v2CreatedId)}/cancel`, {
  reason: "deterministic bridge cleanup",
});
const cancelledV2Projection = await api("GET", `/v2/tasks/${encodeURIComponent(v2CreatedId)}`);
if (cancelledV2Projection.status !== "CANCELLED") {
  throw new Error(`v1 cancellation did not update v2 projection: ${JSON.stringify(cancelledV2Projection)}`);
}

const detachedActive = await api("POST", "/v2/tasks", {
  missionId: null,
  organizationId: "default-org",
  departmentId: "default-dept",
  v1Context: null,
  contract: v2Contract({
    version: 1,
    mission: "attach a running batch task without resetting its status",
    mode: "batch",
    readPaths: ["/src/**"],
  }),
});
const detachedActiveId = nonEmpty(detachedActive, "id", "detached active task");
const readyDetached = await api("POST", `/v2/tasks/${encodeURIComponent(detachedActiveId)}/transition`, {
  targetStatus: "READY",
  expectedVersion: detachedActive.version,
  reason: "deterministic context projection",
});
const runningDetached = await api("POST", `/v2/tasks/${encodeURIComponent(detachedActiveId)}/transition`, {
  targetStatus: "RUNNING",
  expectedVersion: readyDetached.version,
  reason: "deterministic context projection",
});
await api("POST", `/v2/tasks/${encodeURIComponent(detachedActiveId)}/conversation-context`, {
  sessionId,
  threadId,
  expectedVersion: runningDetached.version,
});
const activeProjection = await api("GET", `/v1/tasks/${encodeURIComponent(detachedActiveId)}`);
if (activeProjection.status !== "ACTIVE") {
  throw new Error(`conversation attachment reset a running task projection: ${JSON.stringify(activeProjection)}`);
}
await api("POST", `/v1/tasks/${encodeURIComponent(detachedActiveId)}/cancel`, {
  reason: "cleanup active context fixture",
});

const detachedTerminal = await api("POST", "/v2/tasks", {
  missionId: null,
  organizationId: "default-org",
  departmentId: "default-dept",
  v1Context: null,
  contract: v2Contract({
    version: 1,
    mission: "attach a terminal batch task without resurrecting it",
    mode: "batch",
  }),
});
const detachedTerminalId = nonEmpty(detachedTerminal, "id", "detached terminal task");
const terminalDetached = await api("POST", `/v2/tasks/${encodeURIComponent(detachedTerminalId)}/transition`, {
  targetStatus: "CANCELLED",
  expectedVersion: detachedTerminal.version,
  reason: "deterministic terminal projection",
});
await api("POST", `/v2/tasks/${encodeURIComponent(detachedTerminalId)}/conversation-context`, {
  sessionId,
  threadId,
  expectedVersion: terminalDetached.version,
});
const terminalProjection = await api("GET", `/v1/tasks/${encodeURIComponent(detachedTerminalId)}`);
if (terminalProjection.status !== "ABORTED") {
  throw new Error(`conversation attachment resurrected a terminal task: ${JSON.stringify(terminalProjection)}`);
}

const raceTask = await api("POST", "/v2/tasks", {
  missionId: null,
  organizationId: "default-org",
  departmentId: "default-dept",
  v1Context: { sessionId, threadId },
  contract: v2Contract({
    version: 1,
    mission: "serialize competing v1 cancellation and v2 transition",
    mode: "interactive",
  }),
});
const raceTaskId = nonEmpty(raceTask, "id", "terminal race task");
const [cancelRace, transitionRace] = await Promise.allSettled([
  api("POST", `/v1/tasks/${encodeURIComponent(raceTaskId)}/cancel`, {
    reason: "win the deterministic terminal race",
  }),
  api("POST", `/v2/tasks/${encodeURIComponent(raceTaskId)}/transition`, {
    targetStatus: "READY",
    expectedVersion: raceTask.version,
    reason: "competing non-terminal transition",
  }),
]);
if (cancelRace.status !== "fulfilled") {
  throw new Error(`v1 cancellation lost the serialized terminal race: ${String(cancelRace.reason)}`);
}
if (transitionRace.status === "rejected") {
  const detail = transitionRace.reason instanceof Error
    ? transitionRace.reason.message
    : String(transitionRace.reason);
  if (!detail.includes("failed (409)")) {
    throw new Error(`v2 race transition failed unexpectedly: ${detail}`);
  }
}
const racedV1 = await api("GET", `/v1/tasks/${encodeURIComponent(raceTaskId)}`);
const racedV2 = await api("GET", `/v2/tasks/${encodeURIComponent(raceTaskId)}`);
if (racedV1.status !== "ABORTED" || racedV2.status !== "CANCELLED") {
  throw new Error(`terminal race resurrected a task projection: ${JSON.stringify({ racedV1, racedV2 })}`);
}

const projectionTask = await api("POST", "/v2/tasks", {
  missionId: null,
  organizationId: "default-org",
  departmentId: "default-dept",
  v1Context: { sessionId, threadId },
  contract: v2Contract({
    version: 1,
    mission: "project exact v2 budget and scope into v1",
    mode: "interactive",
    costMicros: "1000",
    timeoutSeconds: 30,
    readPaths: ["/src/**"],
    writePaths: ["/tmp/output.txt"],
    externalSystems: ["example.test"],
  }),
});
const projectionTaskId = nonEmpty(projectionTask, "id", "contract projection task");
const projectedContract = await api("POST", `/v2/tasks/${encodeURIComponent(projectionTaskId)}/contract`, {
  expectedVersion: projectionTask.version,
  contract: v2Contract({
    version: 2,
    mission: "project exact v2 budget and scope into v1",
    mode: "interactive",
    costMicros: "424242",
    timeoutSeconds: 123,
    readPaths: ["/src/**"],
    writePaths: ["/tmp/output.txt"],
    externalSystems: ["example.test"],
  }),
});
if (object(projectedContract.contract, "projected v2 contract").version !== 2) {
  throw new Error(`v2 contract did not advance: ${JSON.stringify(projectedContract)}`);
}
const projectedV1 = await api("GET", `/v1/tasks/${encodeURIComponent(projectionTaskId)}`);
const projectedV1Contract = object(projectedV1.contract, "projected v1 contract");
const projectedScope = object(projectedV1Contract.allowed_scope, "projected v1 scope");
if (
  projectedV1.active_contract_version !== 2
  || JSON.stringify(projectedScope.read_paths) !== JSON.stringify(["/src/**"])
  || JSON.stringify(projectedScope.write_paths) !== JSON.stringify(["/tmp/output.txt"])
  || JSON.stringify(projectedScope.external_systems) !== JSON.stringify(["example.test"])
) {
  throw new Error(`v2 scope did not reach the public v1 projection: ${JSON.stringify(projectedV1)}`);
}

const exported = await api("POST", "/v1/system/export", {
  include_artifacts: false,
  include_events: true,
});
if (!Array.isArray(exported.events)) {
  throw new Error(`event export was unavailable for sequence validation: ${JSON.stringify(exported)}`);
}
const allEvents = exported.events.map((event) => object(event, "semantic event"));
const bridgedEvents = allEvents.filter((event) =>
  event.aggregate_type === "task" && event.aggregate_id === v2CreatedId
);
const bridgedSequences = bridgedEvents.map((event) => event.aggregate_sequence);
const numericBridgedSequences = bridgedSequences.filter(
  (sequence): sequence is number => typeof sequence === "number" && Number.isInteger(sequence),
);
if (
  bridgedSequences.length < 2
  || numericBridgedSequences.length !== bridgedSequences.length
  || numericBridgedSequences.some((sequence, index) => index > 0 && sequence <= numericBridgedSequences[index - 1]!)
  || new Set(numericBridgedSequences).size !== numericBridgedSequences.length
) {
  throw new Error(`v1/v2 task events did not share one advancing sequence: ${JSON.stringify(bridgedEvents)}`);
}
const bridgedSchemaVersions = new Set(bridgedEvents.map((event) => event.schema_version));
if (!bridgedSchemaVersions.has(1) || !bridgedSchemaVersions.has(2)) {
  throw new Error(`bridged task did not publish both protocol projections: ${JSON.stringify(bridgedEvents)}`);
}
const checkpointCreatedEvents = allEvents.filter((event) =>
  event.event_type === "checkpoint.created" && event.aggregate_id === checkpointId
);
if (checkpointCreatedEvents.length !== 1) {
  throw new Error(`checkpoint publication was not exactly once: ${JSON.stringify(checkpointCreatedEvents)}`);
}

console.log(JSON.stringify({
  status: "passed",
  recovered_session_id: sessionId,
  original_task_id: taskId,
  resumed_task_id: resumedTaskId,
  bridged_task_id: v2CreatedId,
  projection_task_id: projectionTaskId,
  resumed_turn_id: resumedTurnId,
  sse_replayed_event_count: replayedEvents.length,
  terminal_race_task_id: raceTaskId,
  startup_reconciled_job_count: startupReconciledJobs.length,
  recovery_reports: [beforeRecovery.id, afterRecovery.id],
}, null, 2));
