/**
 * Test-only persistence fixtures for restart and replay invariants.
 *
 * The deterministic shell supervisor runs this only while terminus-control is
 * stopped. Direct storage access is intentional here: malformed ARP events
 * cannot be admitted through the public API, and a restart is the acceptance
 * surface that must reject them.
 */

import { PrismaClient, type Prisma } from "@prisma/client";

import {
  ACTIVE_TURN_RECOVERY_FIXTURES,
  PENDING_RECOVERY_TURN_ID,
  POST_PENDING_RECOVERY_TURNS,
  RECOVERY_JOB_FIXTURES,
} from "./control-fixtures.ts";

type JsonObject = Record<string, unknown>;

interface FixtureSummary {
  readonly sse_cursor: string;
  readonly sse_task_id: string;
  readonly sse_event_count: number;
  readonly expected_task_version: number;
  readonly expected_task_status: string;
}

interface EventInput {
  readonly eventId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly occurredAt: Date;
  readonly actorJson: string;
  readonly correlationId: string;
  readonly payloadJson: string;
  readonly artifactRefsJson?: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`control invariant fixture requires ${name}`);
  return value;
}

const databasePath = requiredEnvironment("TERMINUS_TEST_DB");
const taskId = requiredEnvironment("TERMINUS_TEST_TASK_ID");
const sseTaskId = requiredEnvironment("TERMINUS_TEST_SSE_TASK_ID");
const pendingRecoveryTaskId = requiredEnvironment("TERMINUS_TEST_PENDING_RECOVERY_TASK_ID");

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object`);
  }
  return value as JsonObject;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} was not an integer`);
  }
  return value;
}

function semanticEvent(input: EventInput): Prisma.SemanticEventCreateManyInput {
  const { artifactRefsJson = "[]", ...event } = input;
  return {
    ...event,
    causationId: null,
    idempotencyKey: null,
    artifactRefsJson,
    traceId: null,
  };
}

const database = new PrismaClient({
  datasources: { db: { url: `file:${databasePath}` } },
});

async function seedFixtures(): Promise<FixtureSummary> {
  const latestTaskEvent = await database.semanticEvent.findFirst({
    where: { schemaVersion: 2, aggregateType: "task", aggregateId: taskId },
    orderBy: { aggregateSequence: "desc" },
    select: { payloadJson: true, aggregateSequence: true },
  });
  if (!latestTaskEvent) {
    throw new Error(`task ${taskId} had no ARP v2 snapshot to corrupt`);
  }
  const task = await database.task.findUnique({
    where: { id: taskId },
    select: { sessionId: true },
  });
  if (!task) throw new Error(`task ${taskId} disappeared before fixture admission`);
  const pendingRecoveryTask = await database.task.findUnique({
    where: { id: pendingRecoveryTaskId },
    select: { threadId: true },
  });
  if (!pendingRecoveryTask) {
    throw new Error(`pending recovery task ${pendingRecoveryTaskId} disappeared before fixture admission`);
  }
  const admittedSourceTurn = await database.turn.findFirst({
    where: { taskId, initiatingInputArtifact: { not: null } },
    orderBy: { sequence: "asc" },
    select: { initiatingInputArtifact: true },
  });
  const admittedInputArtifact = admittedSourceTurn?.initiatingInputArtifact;
  if (!admittedInputArtifact?.startsWith("artifact://sha256/")) {
    throw new Error(`task ${taskId} had no admitted input artifact for active-turn recovery fixtures`);
  }
  const admittedInputHash = `sha256:${admittedInputArtifact.slice("artifact://sha256/".length)}`;

  const latestPayload = object(JSON.parse(latestTaskEvent.payloadJson) as unknown, "latest task payload");
  const latestSnapshot = object(latestPayload.snapshot, "latest task snapshot");
  const latestVersion = integer(latestSnapshot.version, "latest task snapshot version");
  const latestStatus = latestSnapshot.status;
  if (typeof latestStatus !== "string" || latestStatus.length === 0) {
    throw new Error("latest task snapshot status was missing");
  }

  const latestEvent = await database.semanticEvent.findFirst({
    orderBy: { eventId: "desc" },
    select: { eventId: true },
  });
  const latestEventId = latestEvent?.eventId ?? "0000000000000000-00000000";
  const match = /^(\d{16})-(\d{8})$/.exec(latestEventId);
  const fixtureMillis = Math.max(Date.now(), match ? Number(match[1]) + 1 : 0);
  const occurredAt = new Date(fixtureMillis);
  let fixtureSequence = 0;
  const nextEventId = (): string => {
    const millis = fixtureMillis.toString().padStart(16, "0");
    const sequence = (fixtureSequence++).toString().padStart(8, "0");
    return `${millis}-${sequence}`;
  };

  const actorJson = JSON.stringify({ kind: "system", id: "terminus-e2e-fixture" });
  const replayEventCount = 1_005;
  const events: Prisma.SemanticEventCreateManyInput[] = [];
  const sseCursor = nextEventId();
  events.push(semanticEvent({
    eventId: sseCursor,
    eventType: "test.replay_anchor",
    schemaVersion: 1,
    aggregateType: "test_replay_anchor",
    aggregateId: sseTaskId,
    aggregateSequence: 1,
    occurredAt,
    actorJson,
    correlationId: sseTaskId,
    payloadJson: JSON.stringify({ fixture: "replay_anchor", task_id: sseTaskId }),
  }));

  for (let index = 0; index < replayEventCount; index += 1) {
    const eventId = nextEventId();
    events.push(semanticEvent({
      eventId,
      eventType: "test.replay",
      schemaVersion: 1,
      aggregateType: "test_replay_item",
      aggregateId: eventId,
      aggregateSequence: 1,
      occurredAt,
      actorJson,
      correlationId: sseTaskId,
      payloadJson: JSON.stringify({ fixture: "paged_replay", index, task_id: sseTaskId }),
    }));
  }

  // These rows are newer than the cursor but must never cross the v1 stream
  // boundary: one has the wrong task and one has the wrong schema.
  const crossTaskId = nextEventId();
  events.push(semanticEvent({
    eventId: crossTaskId,
    eventType: "test.cross_task_decoy",
    schemaVersion: 1,
    aggregateType: "test_replay_decoy",
    aggregateId: crossTaskId,
    aggregateSequence: 1,
    occurredAt,
    actorJson,
    correlationId: "00000000-0000-7000-8000-0000000000ff",
    payloadJson: JSON.stringify({ fixture: "cross_task_decoy" }),
  }));
  const crossSchemaId = nextEventId();
  events.push(semanticEvent({
    eventId: crossSchemaId,
    eventType: "test.cross_schema_decoy",
    schemaVersion: 2,
    aggregateType: "test_replay_v2_decoy",
    aggregateId: crossSchemaId,
    aggregateSequence: 1,
    occurredAt,
    actorJson,
    correlationId: sseTaskId,
    payloadJson: JSON.stringify({ fixture: "cross_schema_decoy", task_id: sseTaskId }),
  }));

  for (const fixture of ACTIVE_TURN_RECOVERY_FIXTURES) {
    const hasAdmittedInput = fixture.state !== "PENDING";
    events.push(semanticEvent({
      eventId: nextEventId(),
      eventType: "turn.started",
      schemaVersion: 1,
      aggregateType: "turn",
      aggregateId: fixture.id,
      aggregateSequence: 1,
      occurredAt,
      actorJson,
      correlationId: pendingRecoveryTaskId,
      payloadJson: JSON.stringify({
        thread_id: pendingRecoveryTask.threadId,
        task_id: pendingRecoveryTaskId,
        sequence: fixture.sequence,
        ...(hasAdmittedInput
          ? { input_artifact: admittedInputArtifact, input_hash: admittedInputHash }
          : {}),
      }),
      artifactRefsJson: JSON.stringify(hasAdmittedInput ? [admittedInputArtifact] : []),
    }));
  }

  // Both events are valid task snapshots at the schema layer. Replay must
  // reject the first because its version does not advance and the second
  // because the embedded identity differs from the durable aggregate key.
  events.push(semanticEvent({
    eventId: nextEventId(),
    eventType: "task.fixture_regressed",
    schemaVersion: 2,
    aggregateType: "task",
    aggregateId: taskId,
    aggregateSequence: latestTaskEvent.aggregateSequence + 1,
    occurredAt,
    actorJson,
    correlationId: taskId,
    payloadJson: JSON.stringify({ snapshot: { ...latestSnapshot, version: latestVersion } }),
  }));
  events.push(semanticEvent({
    eventId: nextEventId(),
    eventType: "task.fixture_wrong_identity",
    schemaVersion: 2,
    aggregateType: "task",
    aggregateId: taskId,
    aggregateSequence: latestTaskEvent.aggregateSequence + 2,
    occurredAt,
    actorJson,
    correlationId: taskId,
    payloadJson: JSON.stringify({
      snapshot: {
        ...latestSnapshot,
        id: "00000000-0000-7000-8000-000000000099",
        version: latestVersion + 1,
      },
    }),
  }));

  await database.$transaction(async (transaction) => {
    await transaction.turn.createMany({
      data: ACTIVE_TURN_RECOVERY_FIXTURES.map((fixture) => ({
        id: fixture.id,
        threadId: pendingRecoveryTask.threadId,
        taskId: pendingRecoveryTaskId,
        sequence: fixture.sequence,
        state: fixture.state,
        initiatingActor: "terminus-e2e-fixture",
        initiatingInputArtifact: fixture.state === "PENDING" ? null : admittedInputArtifact,
        startedAt: fixture.state === "PENDING" ? null : occurredAt,
      })),
    });
    await transaction.episode.createMany({
      data: POST_PENDING_RECOVERY_TURNS.map((fixture) => ({
        id: `00000000-0000-7000-8000-00000000c00${fixture.sequence}`,
        turnId: fixture.id,
        sequence: 1,
        kind: "user_message",
        modelVisible: true,
        contentArtifact: admittedInputArtifact,
        sourceVersionsJson: JSON.stringify({ input: admittedInputHash }),
      })),
    });
    await transaction.toolCall.createMany({
      data: POST_PENDING_RECOVERY_TURNS.map((fixture) => ({
        id: `00000000-0000-7000-8000-00000000d00${fixture.sequence}`,
        turnId: fixture.id,
        toolId: "e2e.recovery-effect",
        toolVersion: "1",
        argumentsArtifact: admittedInputArtifact,
        normalizedOperationHash: `sha256:${String(fixture.sequence).repeat(64)}`,
        state: "STARTED",
        startedAt: occurredAt,
      })),
    });
    await transaction.sideEffect.createMany({
      data: POST_PENDING_RECOVERY_TURNS.map((fixture) => ({
        id: `00000000-0000-7000-8000-00000000e00${fixture.sequence}`,
        toolCallId: `00000000-0000-7000-8000-00000000d00${fixture.sequence}`,
        effectType: "WRITE_LOCAL",
        resourceUri: `workspace://e2e/recovery-${fixture.sequence}`,
        idempotencyKey: `active-turn-recovery-${fixture.sequence}`,
        state: "STARTED",
        reversibility: "unknown",
        requestArtifact: admittedInputArtifact,
        startedAt: occurredAt,
      })),
    });
    await transaction.job.createMany({
      data: RECOVERY_JOB_FIXTURES.map((fixture) => ({
        id: fixture.id,
        sessionId: task.sessionId,
        taskId,
        state: fixture.state,
        commandArtifact: `artifact://sha256/${"1".repeat(64)}`,
        resolvedExecutable: "/bin/false",
        cwdUri: "workspace://e2e/.",
        environmentDigest: `sha256:${"2".repeat(64)}`,
        sandboxId: "degraded-local",
        processIdentityJson: JSON.stringify({
          kernelJobId: `missing-${fixture.id}`,
          processId: `missing-${fixture.id}`,
        }),
        resourceLimitsJson: "{}",
        outputArtifact: `artifact://sha256/${"3".repeat(64)}`,
        outputCursor: 0,
        cleanupPolicyJson: JSON.stringify({ fixture: "startup-reconciliation" }),
        startedAt: occurredAt,
        settledAt: null,
        exitJson: null,
      })),
    });
    const batchSize = 200;
    for (let offset = 0; offset < events.length; offset += batchSize) {
      await transaction.semanticEvent.createMany({ data: events.slice(offset, offset + batchSize) });
    }
  });

  return {
    sse_cursor: sseCursor,
    sse_task_id: sseTaskId,
    sse_event_count: replayEventCount,
    expected_task_version: latestVersion,
    expected_task_status: latestStatus,
  };
}

try {
  console.log(JSON.stringify(await seedFixtures()));
} finally {
  await database.$disconnect();
}
