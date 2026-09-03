import { describe, expect, test } from "bun:test";
import {
  IN_FLIGHT_PROVIDER_STATES,
  ProviderAttemptAlreadyResolvedError,
  ProviderSessionService,
} from "./provider-session-service.js";
import type { ProviderSessionTransaction } from "./provider-session-service.js";

interface RecoveryAttemptRow {
  readonly id: string;
  readonly turnId: string;
  readonly status: string;
  readonly providerIdempotencyKey: string;
  readonly requestFingerprint: string;
  readonly requestArtifact: string;
  readonly responseArtifact: string | null;
  readonly turn: { readonly state: string; readonly taskId: string | null };
}

interface RecoveryWorld {
  attempts: RecoveryAttemptRow[];
  turnStates: Map<string, { state: string; taskId: string | null }>;
  taskStatuses: Map<string, string>;
  events: { eventType: string; idempotencyKey: string | null; payload: Record<string, unknown> }[];
}

const makeService = (world: RecoveryWorld) => {
  const service = new ProviderSessionService<unknown>({
    readTurnState: (turnId) => Promise.resolve(world.turnStates.get(turnId)?.state ?? null),
    appendEvent: async (event, mutation) => {
      world.events.push({
        eventType: event.eventType,
        idempotencyKey: event.idempotencyKey ?? null,
        payload: event.payload as Record<string, unknown>,
      });
      await mutation({});
    },
    transaction: (): ProviderSessionTransaction => ({
      startAttempt: () => Promise.resolve(),
      completeAttempt: () => Promise.resolve(),
      findAttemptStatus: (attemptId) =>
        Promise.resolve(world.attempts.find((attempt) => attempt.id === attemptId)?.status ?? null),
      interruptAttempt: ({ attemptId, inFlightStates }) => {
        const attempt = world.attempts.find((candidate) => candidate.id === attemptId);
        if (attempt === undefined || !inFlightStates.includes(attempt.status)) return Promise.resolve(0);
        (attempt as { status: string }).status = "interrupted";
        return Promise.resolve(1);
      },
      readTurnForRecovery: (turnId) => Promise.resolve(world.turnStates.get(turnId) ?? null),
      interruptTurnForRecovery: ({ turnId, expectedState }) => {
        const turn = world.turnStates.get(turnId);
        if (turn === undefined || turn.state !== expectedState) return Promise.resolve(0);
        (turn as { state: string }).state = "INTERRUPTED";
        return Promise.resolve(1);
      },
      blockTaskForRecovery: ({ taskId, expectedStatuses }) => {
        const status = world.taskStatuses.get(taskId);
        if (status === undefined || !expectedStatuses.includes(status)) return Promise.resolve();
        world.taskStatuses.set(taskId, "BLOCKED");
        return Promise.resolve();
      },
    }),
    mutate: (op) => Promise.resolve(op()),
    executeLocal: () => Promise.reject(new Error("not wired")),
    executeGateway: () => Promise.reject(new Error("not wired")),
    listInFlightAttempts: () =>
      Promise.resolve(world.attempts.filter((a) => (IN_FLIGHT_PROVIDER_STATES as readonly string[]).includes(a.status))),
  });
  return service;
};

describe("provider attempt recovery (restart reconciliation)", () => {
  test("an in-flight attempt is interrupted, its turn settled, and its task blocked in one event", async () => {
    const world: RecoveryWorld = {
      attempts: [{
        id: "a1",
        turnId: "t1",
        status: "running",
        providerIdempotencyKey: "key:a1",
        requestFingerprint: "fp:a1",
        requestArtifact: "artifact://sha256/req",
        responseArtifact: null,
        turn: { state: "PROVIDER_RUNNING", taskId: "task1" },
      }],
      turnStates: new Map([["t1", { state: "PROVIDER_RUNNING", taskId: "task1" }]]),
      taskStatuses: new Map([["task1", "ACTIVE"]]),
      events: [],
    };
    const service = makeService(world);
    const result = await service.reconcileInFlightAttempts([
      "PENDING", "CONTEXT_COMPILING", "PROVIDER_RUNNING", "RESPONSE_VALIDATING",
      "TOOL_SETTLEMENT", "VERIFYING", "REPAIRING", "FINALIZING",
    ]);

    expect(result.scanned).toBe(1);
    expect(result.interrupted).toHaveLength(1);
    expect(result.alreadyResolved).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(world.attempts[0]!.status).toBe("interrupted");
    expect(world.turnStates.get("t1")!.state).toBe("INTERRUPTED");
    expect(world.taskStatuses.get("task1")).toBe("BLOCKED");
    expect(world.events).toHaveLength(1);
    expect(world.events[0]!.eventType).toBe("turn.recovery_interrupted");
    expect(world.events[0]!.idempotencyKey).toBe("provider-recovery:a1");
    expect(world.events[0]!.payload.provider_idempotency_key).toBe("key:a1");
  });

  test("a second recovery pass never re-lists a resolved attempt; a mid-flight race resolves as already-resolved", async () => {
    // Steady state: after a first pass the attempt is `interrupted`, so a
    // second pass does not even list it. The duplicate-delivery guarantee
    // for the race (in flight when listed, resolved before the CAS) is
    // covered separately below.
    const world: RecoveryWorld = {
      attempts: [{
        id: "a1",
        turnId: "t1",
        status: "interrupted",
        providerIdempotencyKey: "key:a1",
        requestFingerprint: "fp:a1",
        requestArtifact: "artifact://sha256/req",
        responseArtifact: null,
        turn: { state: "INTERRUPTED", taskId: "task1" },
      }],
      turnStates: new Map([["t1", { state: "INTERRUPTED", taskId: "task1" }]]),
      taskStatuses: new Map([["task1", "BLOCKED"]]),
      events: [],
    };
    const service = makeService(world);
    const result = await service.reconcileInFlightAttempts(["PROVIDER_RUNNING"]);
    expect(result.interrupted).toEqual([]);
    expect(result.alreadyResolved).toEqual([]);
    expect(result.scanned).toBe(0);
    expect(world.events).toEqual([]);
    expect(world.turnStates.get("t1")!.state).toBe("INTERRUPTED");
    expect(world.taskStatuses.get("task1")).toBe("BLOCKED");
  });

  test("an attempt resolved between listing and CAS is reported already-resolved, never double-settled", async () => {
    const world: RecoveryWorld = {
      attempts: [{
        id: "a1",
        turnId: "t1",
        status: "running",
        providerIdempotencyKey: "key:a1",
        requestFingerprint: "fp:a1",
        requestArtifact: "artifact://sha256/req",
        responseArtifact: null,
        turn: { state: "INTERRUPTED", taskId: "task1" },
      }],
      turnStates: new Map([["t1", { state: "INTERRUPTED", taskId: "task1" }]]),
      taskStatuses: new Map([["task1", "BLOCKED"]]),
      events: [],
    };
    // Another owner resolved the attempt between the recovery pass's list
    // and its CAS; the status read inside the transaction sees "completed".
    const service = new ProviderSessionService<unknown>({
      readTurnState: () => Promise.resolve(null),
      appendEvent: async (event, mutation) => {
        await mutation({});
        return event;
      },
      transaction: (): ProviderSessionTransaction => ({
        startAttempt: () => Promise.resolve(),
        completeAttempt: () => Promise.resolve(),
        findAttemptStatus: () => Promise.resolve("completed"),
        interruptAttempt: () => Promise.resolve(0),
        readTurnForRecovery: () => Promise.resolve(null),
        interruptTurnForRecovery: () => Promise.resolve(1),
        blockTaskForRecovery: () => Promise.resolve(),
      }),
      mutate: (op) => Promise.resolve(op()),
      executeLocal: () => Promise.reject(new Error("not wired")),
      executeGateway: () => Promise.reject(new Error("not wired")),
      listInFlightAttempts: () => Promise.resolve(world.attempts),
    });
    const result = await service.reconcileInFlightAttempts(["PROVIDER_RUNNING"]);
    expect(result.alreadyResolved).toEqual(["a1"]);
    expect(result.interrupted).toEqual([]);
    expect(world.events).toEqual([]);
  });

  test("a settled turn is left alone while its attempt still fails closed", async () => {
    const world: RecoveryWorld = {
      attempts: [{
        id: "a2",
        turnId: "t2",
        status: "streaming",
        providerIdempotencyKey: "key:a2",
        requestFingerprint: "fp:a2",
        requestArtifact: "artifact://sha256/req2",
        responseArtifact: "artifact://sha256/partial",
        turn: { state: "COMPLETED", taskId: "task2" },
      }],
      turnStates: new Map([["t2", { state: "COMPLETED", taskId: "task2" }]]),
      taskStatuses: new Map([["task2", "COMPLETED"]]),
      events: [],
    };
    const service = makeService(world);
    const result = await service.reconcileInFlightAttempts(["PROVIDER_RUNNING", "CONTEXT_COMPILING"]);
    expect(result.interrupted).toHaveLength(1);
    // The attempt was interrupted, but the terminal turn and task were not touched.
    expect(world.turnStates.get("t2")!.state).toBe("COMPLETED");
    expect(world.taskStatuses.get("task2")).toBe("COMPLETED");
  });

  test("a recovery fault on one attempt does not stop the others", async () => {
    const world: RecoveryWorld = {
      attempts: [
        {
          id: "bad",
          turnId: "t1",
          status: "starting",
          providerIdempotencyKey: "key:bad",
          requestFingerprint: "fp:bad",
          requestArtifact: "artifact://sha256/bad",
          responseArtifact: null,
          turn: { state: "PROVIDER_RUNNING", taskId: "task1" },
        },
        {
          id: "good",
          turnId: "t2",
          status: "running",
          providerIdempotencyKey: "key:good",
          requestFingerprint: "fp:good",
          requestArtifact: "artifact://sha256/good",
          responseArtifact: null,
          turn: { state: "PROVIDER_RUNNING", taskId: "task2" },
        },
      ],
      turnStates: new Map([
        ["t1", { state: "PROVIDER_RUNNING", taskId: "task1" }],
        ["t2", { state: "PROVIDER_RUNNING", taskId: "task2" }],
      ]),
      taskStatuses: new Map(),
      events: [],
    };
    // Simulate a durable fault between find and CAS on the first attempt.
    const service = new ProviderSessionService<unknown>({
      readTurnState: () => Promise.resolve(null),
      appendEvent: async (event, mutation) => {
        await mutation({});
        return event;
      },
      transaction: (): ProviderSessionTransaction => ({
        startAttempt: () => Promise.resolve(),
        completeAttempt: () => Promise.resolve(),
        findAttemptStatus: (attemptId) => {
          if (attemptId === "bad") return Promise.reject(new Error("durable store unavailable"));
          return Promise.resolve(world.attempts.find((attempt) => attempt.id === attemptId)?.status ?? null);
        },
        interruptAttempt: () => Promise.resolve(1),
        readTurnForRecovery: (turnId) => Promise.resolve(world.turnStates.get(turnId) ?? null),
        interruptTurnForRecovery: () => Promise.resolve(1),
        blockTaskForRecovery: () => Promise.resolve(),
      }),
      mutate: (op) => Promise.resolve(op()),
      executeLocal: () => Promise.reject(new Error("not wired")),
      executeGateway: () => Promise.reject(new Error("not wired")),
      listInFlightAttempts: () => Promise.resolve(world.attempts),
    });
    const result = await service.reconcileInFlightAttempts(["PROVIDER_RUNNING"]);
    expect(result.failed).toEqual([{ id: "bad", error: "durable store unavailable" }]);
    expect(result.interrupted.map((r) => r.id)).toEqual(["good"]);
    expect(result.alreadyResolved).toEqual([]);
  });

  test("already-resolved errors from the CAS keep the pass converging", async () => {
    const world: RecoveryWorld = {
      attempts: [{
        id: "a3",
        turnId: "t3",
        status: "submitted",
        providerIdempotencyKey: "key:a3",
        requestFingerprint: "fp:a3",
        requestArtifact: "artifact://sha256/req3",
        responseArtifact: null,
        turn: { state: "PROVIDER_RUNNING", taskId: "task3" },
      }],
      turnStates: new Map([["t3", { state: "PROVIDER_RUNNING", taskId: "task3" }]]),
      taskStatuses: new Map(),
      events: [],
    };
    const service = new ProviderSessionService<unknown>({
      readTurnState: () => Promise.resolve(null),
      appendEvent: async (event, mutation) => {
        await mutation({});
        return event;
      },
      transaction: (): ProviderSessionTransaction => ({
        startAttempt: () => Promise.resolve(),
        completeAttempt: () => Promise.resolve(),
        findAttemptStatus: () => Promise.resolve("completed"),
        interruptAttempt: () => Promise.resolve(0),
        readTurnForRecovery: () => Promise.resolve(null),
        interruptTurnForRecovery: () => Promise.resolve(1),
        blockTaskForRecovery: () => Promise.resolve(),
      }),
      mutate: (op) => Promise.resolve(op()),
      executeLocal: () => Promise.reject(new Error("not wired")),
      executeGateway: () => Promise.reject(new Error("not wired")),
      listInFlightAttempts: () => Promise.resolve(world.attempts),
    });
    const result = await service.reconcileInFlightAttempts(["PROVIDER_RUNNING"]);
    expect(result.alreadyResolved).toEqual(["a3"]);
    expect(result.failed).toEqual([]);
    expect(new ProviderAttemptAlreadyResolvedError("a3").attemptId).toBe("a3");
  });

  test("resolves recovery mutations from the event transaction client", async () => {
    const transactionMarker = {};
    let observedTransaction: object | null = null;
    const service = new ProviderSessionService<object>({
      readTurnState: () => Promise.resolve(null),
      appendEvent: (_event, mutation) => mutation(transactionMarker),
      transaction: (transaction): ProviderSessionTransaction => {
        observedTransaction = transaction;
        return {
          startAttempt: () => Promise.resolve(),
          completeAttempt: () => Promise.resolve(),
          findAttemptStatus: () => Promise.resolve("running"),
          interruptAttempt: () => Promise.resolve(1),
          readTurnForRecovery: () => Promise.resolve(null),
          interruptTurnForRecovery: () => Promise.resolve(1),
          blockTaskForRecovery: () => Promise.resolve(),
        };
      },
      mutate: (operation) => Promise.resolve(operation()),
      executeLocal: () => Promise.reject(new Error("not wired")),
      executeGateway: () => Promise.reject(new Error("not wired")),
      listInFlightAttempts: () => Promise.resolve([{
        id: "attempt-transaction",
        turnId: "turn-transaction",
        status: "running",
        providerIdempotencyKey: null,
        requestFingerprint: null,
        requestArtifact: "artifact://sha256/request",
        responseArtifact: null,
        turn: { state: "COMPLETED", taskId: null },
      }]),
    });

    const result = await service.reconcileInFlightAttempts(["PROVIDER_RUNNING"]);
    expect(result.interrupted).toHaveLength(1);
    expect(observedTransaction).toBe(transactionMarker);
  });
});
