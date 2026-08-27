import { describe, expect, test } from "bun:test";
import type { ContentHash } from "@terminus/domain";
import type { ProviderToolCallChunk } from "@terminus/provider-core";
import {
  EffectSettlementService,
  EventSubscriptionService,
  ProviderExecutionUnavailableError,
  ProviderSessionService,
  TaskProjectionService,
  ToolEpisodeService,
  ToolPolicyDeniedError,
  TurnCoordinator,
  TurnAdmissionError,
  VerificationCoordinator,
  type EffectSettlementInput,
  type EventCursorRecord,
  type ProviderAttemptResponseInput,
  type ProviderAttemptStartInput,
  type ProviderExecutionInput,
  type TaskProjectionContractRow,
  type TaskProjectionTaskRow,
  type TurnAdmissionInput,
  type TurnRow,
  type TurnTaskSnapshot,
  type VerificationTransitionInput,
} from "./index.js";

describe("control-plane service boundaries", () => {
  test("EventSubscriptionService closes the replay/live race and persists progress", async () => {
    type Event = EventCursorRecord & { readonly value: string };
    const events: Event[] = [
      { eventId: "0001", aggregateSequence: 1, value: "one" },
      { eventId: "0002", aggregateSequence: 2, value: "two" },
    ];
    let livePush: ((event: Event) => void) | null = null;
    const received: string[] = [];
    const persisted: string[] = [];
    const service = new EventSubscriptionService<Event>({
      subscribeLive: (_filter, push) => {
        livePush = push;
        return () => { livePush = null; };
      },
      latestEventId: async () => events.at(-1)?.eventId ?? null,
      oldestEventId: async () => events[0]?.eventId ?? null,
      eventExists: async (eventId) => events.some((event) => event.eventId === eventId),
      replay: async (since, through, filter, push) => {
        for (const event of events) {
          if (event.eventId > since && event.eventId <= through && filter(event)) push(event);
        }
        livePush?.({ eventId: "0003", aggregateSequence: 3, value: "three" });
      },
      persistCursor: async (_stream, eventId) => { persisted.push(eventId); },
    });

    const handle = await service.open({
      streamName: "task:1",
      cursor: "0001",
      filter: () => true,
      onEvent: (event) => { received.push(event.value); },
    });
    expect(received).toEqual(["two", "three"]);
    await handle.close();
    expect(persisted).toEqual(["0003"]);
  });

  test("TurnCoordinator repeats admission checks inside the event transaction", async () => {
    type Transaction = { readonly name: "turn" };
    const task: TurnTaskSnapshot = { id: "task-1", threadId: "thread-1", status: "BLOCKED" };
    let admitted = false;
    let aborted = false;
    let resumed = false;
    const events: string[] = [];
    const created: TurnAdmissionInput[] = [];
    const turn: TurnRow = {
      id: "turn-1",
      threadId: "thread-1",
      taskId: "task-1",
      sequence: 2,
      state: "PENDING",
      initiatingActor: "test",
      startedAt: null,
      completedAt: null,
    };
    const coordinator = new TurnCoordinator<Transaction>({
      readTask: async () => task,
      readTurn: async () => admitted ? { ...turn, state: aborted ? "ABORTED" : turn.state } : null,
      appendEvent: async (event, mutation) => {
        events.push(event.eventType);
        await mutation({ name: "turn" });
      },
      transaction: () => ({
        findTask: async () => task,
        findActiveTurn: async () => null,
        findLatestSequence: async () => 1,
        resumeTask: async () => { resumed = true; },
        createTurn: async (input) => { created.push(input); admitted = true; },
        createUserEpisode: async () => undefined,
        interruptTurn: async () => undefined,
        abortTurn: async () => { aborted = true; },
      }),
      mutate: async (operation) => operation(),
      projectTask: async () => undefined,
      activeTurnStates: ["PENDING", "PROVIDER_RUNNING"],
    });

    await coordinator.admit({
      turnId: "turn-1",
      threadId: "thread-1",
      taskId: "task-1",
      sequence: 2,
      inputArtifactUri: "artifact://sha256/input",
      inputArtifactHash: "sha256:input",
      initiatingActor: "test",
    });
    expect(events).toEqual(["turn.started"]);
    expect(resumed).toBe(true);
    expect(created).toHaveLength(1);

    await coordinator.abortUnderMutationLock("turn-1", "user_cancelled");
    expect(aborted).toBe(true);
    expect(events).toEqual(["turn.started", "turn.aborted"]);
  });

  test("TurnCoordinator blocks user admission while a repair continuation is pending", async () => {
    type Transaction = { readonly name: "repair" };
    const task: TurnTaskSnapshot = { id: "task-1", threadId: "thread-1", status: "BLOCKED" };
    const created: string[] = [];
    let repairTurnAdmitted = false;
    const coordinator = new TurnCoordinator<Transaction>({
      readTask: async () => task,
      readTurn: async (turnId) => repairTurnAdmitted && turnId === "repair-turn"
        ? {
            id: "repair-turn",
            threadId: "thread-1",
            taskId: "task-1",
            sequence: 2,
            state: "PENDING",
            initiatingActor: "repair-controller",
            startedAt: null,
            completedAt: null,
          }
        : null,
      appendEvent: async (_event, mutation) => mutation({ name: "repair" }),
      transaction: () => ({
        findTask: async () => task,
        findActiveTurn: async (_taskId, states) => states.includes("REPAIR_PENDING")
          ? {
              id: "parent-turn",
              threadId: "thread-1",
              taskId: "task-1",
              sequence: 1,
              state: "REPAIR_PENDING",
              initiatingActor: "test",
              startedAt: null,
              completedAt: null,
            }
          : null,
        findLatestSequence: async () => 1,
        resumeTask: async () => undefined,
        createTurn: async (input) => {
          created.push(input.initiatingActor);
          repairTurnAdmitted = true;
        },
        createUserEpisode: async () => undefined,
        interruptTurn: async () => undefined,
      }),
      mutate: async (operation) => operation(),
      projectTask: async () => undefined,
      activeTurnStates: ["PENDING", "PROVIDER_RUNNING"],
    });

    await expect(coordinator.admit({
      turnId: "user-turn",
      threadId: "thread-1",
      taskId: "task-1",
      sequence: 2,
      inputArtifactUri: "artifact://sha256/input",
      inputArtifactHash: "sha256:input",
      initiatingActor: "user",
    })).rejects.toBeInstanceOf(TurnAdmissionError);

    await coordinator.admit({
      turnId: "repair-turn",
      threadId: "thread-1",
      taskId: "task-1",
      sequence: 2,
      inputArtifactUri: "artifact://sha256/directive",
      inputArtifactHash: "sha256:directive",
      initiatingActor: "repair-controller",
    });
    expect(created).toEqual(["repair-controller"]);
  });

  test("ProviderSessionService records attempt lifecycle and fails closed without transport", async () => {
    type Transaction = { readonly name: "provider" };
    const events: string[] = [];
    const operations: string[] = [];
    const start: ProviderAttemptStartInput = {
      attemptId: "attempt-1",
      turnId: "turn-1",
      taskId: "task-1",
      attemptNumber: 1,
      providerId: "local",
      modelKey: "local/model",
      capabilitySnapshotHash: "sha256:capability",
      contextManifestId: "manifest-1",
      requestArtifact: "artifact://sha256/request",
    };
    const service = new ProviderSessionService<Transaction>({
      readTurnState: async () => "PENDING",
      appendEvent: async (event, mutation) => {
        events.push(event.eventType);
        await mutation({ name: "provider" });
      },
      transaction: () => ({
        startAttempt: async () => { operations.push("start"); },
        completeAttempt: async () => { operations.push("complete"); },
      }),
      mutate: async (operation) => operation(),
      executeLocal: async () => { throw new Error("not used"); },
      executeGateway: async () => { throw new Error("not used"); },
    });
    expect(await service.beginAttempt(start)).toBe(true);
    const response: ProviderAttemptResponseInput = {
      attemptId: "attempt-1",
      turnId: "turn-1",
      taskId: "task-1",
      responseArtifact: "artifact://sha256/response",
      messageArtifact: null,
      messageHash: null,
      usage: { output: 1 },
      finishReason: "stop",
      continuationId: null,
    };
    await service.settleResponse(response);
    expect(events).toEqual(["turn.provider_running", "turn.response_validating"]);
    expect(operations).toEqual(["start", "complete"]);

    const unavailable = service.execute({
      rendered: { providerId: "local" } as unknown as ProviderExecutionInput["rendered"],
      command: null,
      gateway: null,
      context: {} as ProviderExecutionInput["context"],
      workspaceId: "workspace-1",
    });
    await expect(unavailable).rejects.toBeInstanceOf(ProviderExecutionUnavailableError);

    const controller = new AbortController();
    controller.abort();
    await expect(service.execute({
      rendered: { providerId: "local" } as unknown as ProviderExecutionInput["rendered"],
      command: null,
      gateway: null,
      context: {} as ProviderExecutionInput["context"],
      workspaceId: "workspace-1",
      signal: controller.signal,
    })).rejects.toThrow("aborted before dispatch");
  });

  test("EffectSettlementService keeps lifecycle events paired with transaction mutations", async () => {
    type Transaction = { readonly name: "effect" };
    const events: string[] = [];
    const operations: string[] = [];
    const service = new EffectSettlementService<Transaction>({
      appendEvent: async (event, mutation) => {
        events.push(event.eventType);
        await mutation({ name: "effect" });
      },
      transaction: () => ({
        authorize: async () => { operations.push("authorize"); },
        start: async () => { operations.push("start"); },
        markUnknown: async () => { operations.push("unknown"); },
        cancel: async () => { operations.push("cancel"); },
        settle: async () => { operations.push("settle"); },
      }),
      mutate: async (operation) => operation(),
    });
    const authorization = {
      taskId: "task-1",
      toolCallId: "call-1",
      sideEffectId: "effect-1",
      policyDecisionId: "policy-1",
      effectType: "READ_LOCAL",
      argumentsArtifactUri: "artifact://sha256/args",
      resourceUri: "workspace://src/index.ts",
      reversibility: "reversible",
      idempotencyKey: "sha256:operation",
      workspaceId: "workspace-1",
    } as const;
    await service.authorize(authorization);
    await service.start(authorization);
    await service.cancel({
      taskId: "task-1",
      toolCallId: "call-1",
      sideEffectId: "effect-1",
      reason: "user_cancelled",
    });
    await service.markUnknown({ taskId: "task-1", toolCallId: "call-1", sideEffectId: "effect-1", error: "lost receipt" });
    const settlement: EffectSettlementInput = {
      taskId: "task-1",
      turnId: "turn-1",
      providerAttemptId: "attempt-1",
      toolCallId: "call-1",
      sideEffectId: "effect-1",
      providerCallId: "provider-call-1",
      status: "success",
      resultStatus: "success",
      toolState: "SETTLED",
      summary: "read complete",
      callTranscriptArtifactUri: "artifact://sha256/call",
      resultArtifactUri: "artifact://sha256/result",
      resultTranscriptArtifactUri: "artifact://sha256/result-transcript",
      resultTranscriptHash: "sha256:result-transcript",
      errorJson: null,
      truncation: null,
    };
    await service.settle(settlement);
    expect(events).toEqual(["tool.authorized", "tool.started", "tool.cancelled", "tool.settlement_unknown", "tool.settled"]);
    expect(operations).toEqual(["authorize", "start", "cancel", "unknown", "settle"]);
  });

  test("ToolEpisodeService bounds per-turn calls and loads bounded model episodes", async () => {
    const call = { toolCallId: "call-1" } as unknown as ProviderToolCallChunk;
    const settled: string[] = [];
    const hash = "sha256:episode" as ContentHash;
    const service = new ToolEpisodeService({
      store: {
        listModelVisibleEpisodes: async () => [{
          id: "episode-1",
          turnId: "turn-1",
          sequence: 1,
          kind: "user_message",
          contentArtifact: "artifact://sha256/episode",
          toolCallId: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        }],
        readArtifact: async () => new TextEncoder().encode("hello"),
      },
      settleCall: async (input) => { settled.push(input.call.toolCallId); },
      maxCycles: 1,
    });
    const session = service.startTurn();
    await session.settle({
      call,
      attemptNumber: 1,
      providerAttemptId: "attempt-1",
      turnId: "turn-1",
      taskId: "task-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      contractVersion: 1,
      contractHash: "sha256:contract",
      artifactClient: {} as never,
    });
    expect(settled).toEqual(["call-1"]);
    await expect(session.settle({
      call,
      attemptNumber: 1,
      providerAttemptId: "attempt-1",
      turnId: "turn-1",
      taskId: "task-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      contractVersion: 1,
      contractHash: "sha256:contract",
      artifactClient: {} as never,
    })).rejects.toBeInstanceOf(ToolPolicyDeniedError);
    const episodes = await service.loadModelVisibleEpisodes("turn-1");
    expect(episodes.episodes).toHaveLength(1);
    expect(episodes.content.get(hash)).toBe("hello");
  });

  test("VerificationCoordinator owns the VERIFYING and terminal task CAS transitions", async () => {
    type Transaction = { readonly name: "verification" };
    let state = "ACTIVE";
    const events: string[] = [];
    const transitions: string[] = [];
    const service = new VerificationCoordinator<Transaction>({
      readTask: async () => ({ status: state }),
      appendEvent: async (event, mutation) => {
        events.push(event.eventType);
        await mutation({ name: "verification" });
      },
      updateTask: async (_tx, input: VerificationTransitionInput) => {
        state = input.status;
        transitions.push(input.status);
      },
      mutate: async (operation) => operation(),
      projectTask: async (_taskId, eventType) => { events.push(`project:${eventType}`); },
    });
    expect(await service.begin("task-1")).toBe(true);
    await service.complete("task-1", "plan-1");
    expect(state).toBe("COMPLETED");
    expect(transitions).toEqual(["VERIFYING", "COMPLETED"]);
    expect(events).toEqual([
      "task.verifying",
      "project:task.verifying",
      "task.completed",
      "project:task.completed",
    ]);
  });

  test("VerificationCoordinator atomically admits the verified turn with task completion", async () => {
    type Transaction = { readonly name: "atomic-verification" };
    let taskState = "VERIFYING";
    let turnState = "VERIFYING";
    const events: string[] = [];
    const service = new VerificationCoordinator<Transaction>({
      readTask: async () => ({ status: taskState }),
      appendEvent: async (event, mutation) => {
        events.push(event.eventType);
        await mutation({ name: "atomic-verification" });
      },
      updateTask: async () => undefined,
      updateTaskAndTurn: async (_tx, input, expectedStatuses, turnId, expectedTurnState) => {
        expect(turnId).toBe("turn-1");
        expect(expectedStatuses).toEqual(["VERIFYING"]);
        expect(expectedTurnState).toBe("VERIFYING");
        taskState = input.status;
        turnState = "VERIFIED";
      },
      mutate: async (operation) => operation(),
      projectTask: async (_taskId, eventType) => { events.push(`project:${eventType}`); },
    });

    await service.complete("task-1", "plan-1", "turn-1");
    expect(taskState).toBe("COMPLETED");
    expect(turnState).toBe("VERIFIED");
    expect(events).toEqual(["task.completed", "project:task.completed"]);
  });

  test("VerificationCoordinator persists repair identity in the same transition transaction", async () => {
    type Transaction = { readonly name: "durable-repair" };
    let taskState = "VERIFYING";
    const events: string[] = [];
    const persisted: Array<{ readonly id: string; readonly parentTurnId: string; readonly leaseKey: string }> = [];
    const service = new VerificationCoordinator<Transaction>({
      readTask: async () => ({ status: taskState }),
      appendEvent: async (event, mutation) => {
        events.push(event.eventType);
        await mutation({ name: "durable-repair" });
      },
      updateTask: async (_tx, input) => { taskState = input.status; },
      createRepairAttempt: async (_tx, input) => {
        persisted.push({ id: input.id, parentTurnId: input.parentTurnId, leaseKey: input.leaseKey });
      },
      mutate: async (operation) => operation(),
      projectTask: async (_taskId, eventType) => { events.push(`project:${eventType}`); },
    });

    await service.scheduleRepair("task-1", {
      repairAttemptId: "attempt-1",
      parentTurnId: "turn-1",
      leaseKey: "terminus-repair-attempt:attempt-1",
      attemptNumber: 1,
      maxAttempts: 2,
      directiveArtifactUri: "artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      failedNodeIds: ["verify-tests"],
      failureSignatures: ["sig-1"],
      changedFiles: ["src/calc.ts"],
      sourceRevision: "git:source-1",
      environmentDigest: "sha256:environment-1",
      remainingAttempts: 1,
      remainingBudgetJson: '{"remaining_attempts":1}',
    });

    expect(taskState).toBe("ACTIVE");
    expect(persisted).toEqual([{
      id: "attempt-1",
      parentTurnId: "turn-1",
      leaseKey: "terminus-repair-attempt:attempt-1",
    }]);
    expect(events).toEqual(["task.repair_scheduled", "project:task.repair_scheduled"]);
  });

  test("TaskProjectionService emits a durable v2 snapshot when v1 state changes", async () => {
    type Transaction = { readonly name: "projection" };
    const task: TaskProjectionTaskRow = {
      id: "task-1",
      sessionId: "session-1",
      threadId: "thread-1",
      status: "ACTIVE",
      activeContractVersion: 1,
      budgetJson: JSON.stringify({ model_micros: "10", wall_clock_seconds: 30 }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
      completedAt: null,
    };
    const contract: TaskProjectionContractRow = {
      version: 1,
      objective: "finish the task",
      constraintsJson: JSON.stringify(["NO_AMBIENT_SECRETS"]),
      allowedScopeJson: JSON.stringify({ read_paths: ["src"] }),
      v2ProjectionJson: null,
      contentHash: "sha256:contract",
      createdBy: "test",
      acceptanceCriteria: [{ criterionId: "criterion-1", statement: "it works", verificationHint: null }],
    };
    const snapshots: string[] = [];
    const projection = new Map<string, import("@terminus/domain").TaskV2>();
    const service = new TaskProjectionService<Transaction>({
      source: {
        readTask: async () => task,
        readContract: async () => contract,
        listTaskIds: async () => [task.id],
      },
      store: {
        get: (taskId) => projection.get(taskId),
        set: (taskId, value) => { projection.set(taskId, value); },
        publish: async (event) => { snapshots.push(event.snapshot.id); },
      },
      bridge: {
        createV1: async () => "created",
        inspectV1: async () => "created",
        projectStatus: async () => undefined,
        projectContract: async () => undefined,
      },
    });
    const result = await service.synchronize(task.id);
    expect(result.changed).toBe(true);
    expect(result.task.status).toBe("RUNNING");
    expect(snapshots).toEqual(["task-1"]);
    expect(projection.get(task.id)?.version).toBe(1);
    const unchanged = await service.synchronize(task.id);
    expect(unchanged.changed).toBe(false);
    expect(snapshots).toEqual(["task-1"]);
  });
});
