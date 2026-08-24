/** Prove that the persisted fencing token gates authoritative control writes. */

import { PrismaClient } from "@prisma/client";

type JsonObject = Record<string, unknown>;

const CONTROL_WRITER_LEASE_KEY = "terminus-control-writer";
const baseUrl = process.env.TERMINUS_E2E_CONTROL_URL;
const token = process.env.TERMINUS_E2E_CONTROL_TOKEN;
const databasePath = process.env.TERMINUS_TEST_DB;
const sessionId = process.env.TERMINUS_E2E_SESSION_ID;
const threadId = process.env.TERMINUS_E2E_THREAD_ID;

if (!baseUrl || !token || !databasePath || !sessionId || !threadId) {
  throw new Error("writer-fence assertion requires the control URL, token, database, session, and thread");
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object`);
  }
  return value as JsonObject;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was not a non-empty string`);
  }
  return value;
}

async function request(
  method: "GET" | "POST",
  path: string,
  body?: JsonObject,
  idempotencyKey?: string,
): Promise<{ readonly ok: boolean; readonly status: number; readonly body: JsonObject }> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = idempotencyKey ?? crypto.randomUUID();
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
  return { ok: response.ok, status: response.status, body: object(parsed, `${method} ${path}`) };
}

const fixture = await request("POST", "/v1/tasks", {
  session_id: sessionId,
  thread_id: threadId,
  objective: "prove transactional control-writer fencing",
  non_goals: ["execute the task"],
  acceptance_criteria: [{
    id: "writer-fence",
    statement: "A stale control writer cannot change domain state or publish an event.",
    required: true,
  }],
  allowed_scope: { read_paths: ["."], write_paths: [], external_systems: [] },
});
if (!fixture.ok) {
  throw new Error(`writer-fence task creation failed (${fixture.status}): ${JSON.stringify(fixture.body)}`);
}
const taskId = nonEmptyString(fixture.body.id, "writer-fence task id");
const cancellationKey = `e2e-writer-fence-${crypto.randomUUID()}`;
const replacementOwner = `e2e-replacement-writer-${crypto.randomUUID()}`;
const database = new PrismaClient({
  datasources: { db: { url: `file:${databasePath}` } },
});

let leaseWasReplaced = false;
let result: JsonObject | null = null;
try {
  const [initialLease, taskBefore, eventCountBefore] = await Promise.all([
    database.lease.findUnique({ where: { leaseKey: CONTROL_WRITER_LEASE_KEY } }),
    database.task.findUnique({
      where: { id: taskId },
      select: {
        status: true,
        activeContractVersion: true,
        completedAt: true,
        terminalReasonJson: true,
      },
    }),
    database.semanticEvent.count({
      where: { aggregateType: "task", aggregateId: taskId },
    }),
  ]);
  if (!initialLease || !taskBefore || taskBefore.status !== "DRAFT") {
    throw new Error(`writer-fence fixture was not ready: ${JSON.stringify({ initialLease, taskBefore })}`);
  }

  const replacementToken = initialLease.fencingToken + 1;
  const replaced = await database.lease.updateMany({
    where: {
      leaseKey: CONTROL_WRITER_LEASE_KEY,
      ownerInstance: initialLease.ownerInstance,
      fencingToken: initialLease.fencingToken,
    },
    data: {
      ownerInstance: replacementOwner,
      fencingToken: replacementToken,
      acquiredAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      metadataJson: JSON.stringify({ role: "control-writer", fixture: "replacement" }),
    },
  });
  if (replaced.count !== 1) {
    throw new Error(`could not replace the live writer lease: ${JSON.stringify(replaced)}`);
  }
  leaseWasReplaced = true;

  const cancellation = await request(
    "POST",
    `/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
    { reason: "stale writer must not settle this cancellation" },
    cancellationKey,
  );
  if (cancellation.ok || cancellation.status !== 503) {
    throw new Error(`stale writer did not fail closed: ${JSON.stringify(cancellation)}`);
  }

  const [taskAfter, eventCountAfter, cancellationReservations, health] = await Promise.all([
    database.task.findUnique({
      where: { id: taskId },
      select: {
        status: true,
        activeContractVersion: true,
        completedAt: true,
        terminalReasonJson: true,
      },
    }),
    database.semanticEvent.count({
      where: { aggregateType: "task", aggregateId: taskId },
    }),
    database.idempotencyRecord.count({ where: { idempotencyKey: cancellationKey } }),
    request("GET", "/v2/system/health"),
  ]);
  if (
    JSON.stringify(taskAfter) !== JSON.stringify(taskBefore)
    || eventCountAfter !== eventCountBefore
    || cancellationReservations !== 0
  ) {
    throw new Error(`fenced mutation changed durable state: ${JSON.stringify({
      taskBefore,
      taskAfter,
      eventCountBefore,
      eventCountAfter,
      cancellationReservations,
    })}`);
  }
  if (!health.ok || health.body.ready !== false || health.body.status !== "degraded") {
    throw new Error(`v2 health reported a fenced writer as ready: ${JSON.stringify(health)}`);
  }

  result = {
    writer_fence_status: "passed",
    task_id: taskId,
    rejection_status: cancellation.status,
    event_count: eventCountAfter,
    v2_ready: health.body.ready,
  };

  // Restore only the isolated fixture row. The process-local lease remains
  // unhealthy, so it still rejects writes until the supervisor stops it.
  const restored = await database.lease.updateMany({
    where: {
      leaseKey: CONTROL_WRITER_LEASE_KEY,
      ownerInstance: replacementOwner,
      fencingToken: replacementToken,
    },
    data: {
      ownerInstance: initialLease.ownerInstance,
      fencingToken: initialLease.fencingToken,
      acquiredAt: initialLease.acquiredAt,
      expiresAt: initialLease.expiresAt,
      metadataJson: initialLease.metadataJson,
    },
  });
  if (restored.count !== 1) {
    throw new Error(`writer-fence fixture cleanup changed ${restored.count} lease rows`);
  }
  leaseWasReplaced = false;
} finally {
  if (leaseWasReplaced) {
    await database.lease.updateMany({
      where: { leaseKey: CONTROL_WRITER_LEASE_KEY, ownerInstance: replacementOwner },
      data: { expiresAt: new Date(0) },
    });
  }
  await database.$disconnect();
}

if (!result) throw new Error("writer-fence assertion did not produce a result");
console.log(JSON.stringify(result));
