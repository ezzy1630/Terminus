import { describe, expect, test } from "bun:test";
import {
  eventEnvelopeV2Schema,
  commandEnvelopeSchema,
  CursorCodec,
  taskCreatedV2PayloadSchema,
  effectProposedV2PayloadSchema,
  createTaskCommandPayloadSchema,
  proposeEffectCommandPayloadSchema,
  type EventEnvelopeV2,
  type CommandEnvelope,
} from "./index.js";
import { generateUuid7, nowTimestamp } from "@terminus/domain";

describe("ARP v2 Protocol & Cursors", () => {
  test("EventEnvelopeV2 validates conforming event", () => {
    const envelope: EventEnvelopeV2 = {
      eventId: generateUuid7(),
      eventType: "task.created",
      schemaVersion: 2,
      aggregateType: "task",
      aggregateId: "task-123",
      aggregateSequence: 1,
      occurredAt: nowTimestamp(),
      actor: { kind: "user", id: "principal-1" },
      correlationId: null,
      causationId: null,
      idempotencyKey: "idem-1",
      payload: {
        taskId: "task-123",
        missionId: null,
        organizationId: "org-1",
        departmentId: "dept-1",
        objective: "Build ARP v2",
        contractVersion: 1,
        mode: "autonomous",
      },
      artifactRefs: [],
      traceId: "trace-1" as any,
    };


    const parsed = eventEnvelopeV2Schema.parse(envelope);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.eventType).toBe("task.created");

    const payloadParsed = taskCreatedV2PayloadSchema.parse(parsed.payload);
    expect(payloadParsed.objective).toBe("Build ARP v2");
  });

  test("CommandEnvelope validates conforming command", () => {
    const cmd: CommandEnvelope = {
      commandId: generateUuid7(),
      commandType: "effect.propose",
      schemaVersion: 2,
      idempotencyKey: "idem-eff-1",
      expectedVersion: 0,
      principal: "principal-1" as any,
      payload: {
        taskId: "task-123",
        attemptId: "attempt-1",
        connectorOrWorker: "worker-1",
        intentType: "patch",
        canonicalParameters: { path: "Cargo.toml" },
        resourceHandles: [],
        effectClass: "LOCAL_FS_WRITE",
      },
      timestamp: nowTimestamp(),
      traceId: "trace-1" as any,
    };

    const parsed = commandEnvelopeSchema.parse(cmd);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.expectedVersion).toBe(0);

    const payloadParsed = proposeEffectCommandPayloadSchema.parse(parsed.payload);
    expect(payloadParsed.effectClass).toBe("LOCAL_FS_WRITE");
  });

  test("CursorCodec encodes and decodes accurately", () => {
    const now = nowTimestamp();
    const eventId = generateUuid7();
    const cursor = CursorCodec.encode({
      version: 2,
      aggregateId: "task-123",
      sequence: 42,
      occurredAt: now,
      eventId,
    });

    expect(cursor.startsWith("c2_")).toBe(true);

    const decoded = CursorCodec.decode(cursor);
    expect(decoded.version).toBe(2);
    expect(decoded.aggregateId).toBe("task-123");
    expect(decoded.sequence).toBe(42);
    expect(decoded.occurredAt).toBe(now);
    expect(decoded.eventId).toBe(eventId);
  });

  test("CursorCodec compares cursor order chronologically and sequentially", () => {
    const t1 = "2026-08-22T10:00:00.000Z" as any;
    const t2 = "2026-08-22T10:01:00.000Z" as any;

    const c1 = CursorCodec.encode({ version: 2, aggregateId: "task-1", sequence: 1, occurredAt: t1, eventId: "e1" as any });
    const c2 = CursorCodec.encode({ version: 2, aggregateId: "task-1", sequence: 2, occurredAt: t2, eventId: "e2" as any });

    expect(CursorCodec.compare(c1, c2)).toBeLessThan(0);
    expect(CursorCodec.compare(c2, c1)).toBeGreaterThan(0);
    expect(CursorCodec.compare(c1, c1)).toBe(0);
  });

  test("CursorCodec supports legacy numeric cursor strings", () => {
    const decoded = CursorCodec.decode("15");
    expect(decoded.sequence).toBe(15);
    expect(decoded.version).toBe(1);
  });
});
