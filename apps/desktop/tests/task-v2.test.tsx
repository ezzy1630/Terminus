import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import TaskV2Panel from "../src/components/TaskV2Panel";
import {
  arpV2,
  decodeArpV2EventEnvelope,
  subscribeEventsV2,
  TerminusArpV2Client,
} from "../src/lib/api-v2";
import { eventBelongsToTask } from "../src/hooks/use-task-v2";
import { TerminusApiError } from "../src/lib/api";
import type { ArpV2EventEnvelope, TaskV2Snapshot } from "../src/types/v2";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function task(id: string, mission: string): TaskV2Snapshot {
  return {
    id,
    missionId: null,
    organizationId: "org-1",
    departmentId: "department-1",
    createdBy: "operator-1",
    conversationContext: { sessionId: "session-1", threadId: "thread-1", attachedAt: "2026-08-23T12:00:00.000Z" },
    contract: {
      version: 1,
      mission,
      scope: { resources: [], allowedEffectClasses: [], excludedPathsOrSystems: [] },
      acceptance: [{ claimId: `${id}-claim`, statement: `Acceptance for ${mission}`, evidenceRequirement: "DETERMINISTIC_TEST" }],
      constraints: { security: [], costMicros: "1000", timeoutSeconds: 60 },
      authorityCeiling: [],
      mode: "interactive",
    },
    status: "READY",
    version: 1,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
    completedAt: null,
  };
}

function effect(taskId: string): Record<string, unknown> {
  return {
    id: "effect-1",
    taskId,
    attemptId: "attempt-1",
    principal: "operator-1",
    connectorOrWorker: "worker-1",
    intentType: "write",
    canonicalParameters: {},
    resourceHandles: [],
    effectClass: "LOCAL_FS_WRITE",
    semanticIdempotencyKey: "effect-key",
    authorizationId: null,
    policyDecisionId: null,
    state: "PROPOSED",
    uncertaintyReason: null,
    compensationRef: null,
    version: 1,
    createdAt: "2026-08-23T12:00:00.000Z",
    settledAt: null,
  };
}

function materialQuestion(taskId: string): Record<string, unknown> {
  return {
    id: "question-1",
    taskId,
    trigger: "human_taste",
    questionText: "Which direction should the agent take?",
    consequenceMatrix: { keep: "continue" },
    options: ["keep"],
    status: "PENDING",
    suggestedOption: null,
    selectedOption: null,
    createdAt: "2026-08-23T12:00:00.000Z",
    resolvedAt: null,
  };
}

function intervention(id: string): Record<string, unknown> {
  return {
    id,
    taskId: "task-requested",
    attemptId: null,
    actorPrincipal: "operator-1",
    verb: "pause",
    targetEntityId: null,
    payload: {},
    rationale: "Pause for review",
    status: "PROPOSED",
    timestamp: "2026-08-23T12:00:00.000Z",
  };
}

function eventEnvelope(overrides: Partial<ArpV2EventEnvelope> = {}): ArpV2EventEnvelope {
  return {
    eventId: "event-1",
    eventType: "task.updated",
    schemaVersion: 2,
    aggregateType: "task",
    aggregateId: "task-requested",
    aggregateSequence: 1,
    occurredAt: "2026-08-23T12:00:00.000Z",
    actor: { kind: "system", id: "terminus-control" },
    correlationId: "task-requested",
    causationId: null,
    idempotencyKey: null,
    // A snapshot is a valid event payload; the envelope types the payload as
    // an open record, which an interface without an index signature does not
    // structurally satisfy without this widening.
    payload: { ...task("task-requested", "Requested task") },
    artifactRefs: [],
    traceId: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TaskV2Panel scoped resource", () => {
  test("does not render a late A response after switching to task B", async () => {
    const taskA = task("task-a", "Task A mission");
    const taskB = task("task-b", "Task B mission");
    const pendingA = deferred<TaskV2Snapshot | null>();
    const pendingB = deferred<TaskV2Snapshot | null>();
    const getTask = vi.spyOn(arpV2, "getTask").mockImplementation((id) => id === taskA.id ? pendingA.promise : pendingB.promise);
    vi.spyOn(arpV2, "listEffects").mockResolvedValue([]);
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    const view = render(<TaskV2Panel taskId={taskA.id} />);
    await waitFor(() => expect(getTask).toHaveBeenCalledWith(taskA.id, expect.any(AbortSignal)));

    view.rerender(<TaskV2Panel taskId={taskB.id} />);
    expect(screen.getByRole("status", { name: "Loading task details" })).toBeInTheDocument();

    await act(async () => {
      pendingA.resolve(taskA);
      await pendingA.promise;
    });
    expect(screen.queryByText(taskA.contract.mission, { exact: true })).not.toBeInTheDocument();
    expect(getTask.mock.calls[0]?.[1]?.aborted).toBe(true);

    await act(async () => {
      pendingB.resolve(taskB);
      await pendingB.promise;
    });
    expect(await screen.findByText(taskB.contract.mission, { exact: true })).toBeInTheDocument();
  });

  test("keeps the last confirmed snapshot visibly stale when refresh fails", async () => {
    const taskA = task("task-a", "Task A mission");
    const pendingRefresh = deferred<TaskV2Snapshot | null>();
    const getTask = vi.spyOn(arpV2, "getTask")
      .mockResolvedValueOnce(taskA)
      .mockImplementationOnce(() => pendingRefresh.promise);
    vi.spyOn(arpV2, "listEffects").mockResolvedValue([]);
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    render(<TaskV2Panel taskId={taskA.id} />);
    expect(await screen.findByText(taskA.contract.mission, { exact: true })).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: "Refresh canonical task" }).click();
    });
    expect(screen.getByText(/Showing the last confirmed snapshot/)).toBeInTheDocument();

    await act(async () => {
      pendingRefresh.reject(new Error("refresh failed"));
      await pendingRefresh.promise.catch(() => undefined);
    });
    expect(await screen.findByText(/Refresh failed\. Showing the last confirmed snapshot: refresh failed/)).toBeInTheDocument();
    expect(screen.getByText(taskA.contract.mission, { exact: true })).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="stale"]')).toBeInTheDocument();
    expect(getTask).toHaveBeenCalledTimes(2);
  });

  test("shows a selected-task error instead of falling back to the catalog", async () => {
    const taskA = task("task-a", "Task A mission");
    vi.spyOn(arpV2, "getTask").mockResolvedValue(null);
    vi.spyOn(arpV2, "listEffects").mockResolvedValue([]);
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([taskA]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    render(<TaskV2Panel taskId="missing-task" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("no canonical v2 task with id missing-task");
    expect(screen.queryByText(taskA.contract.mission, { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/No canonical tasks yet/)).not.toBeInTheDocument();
  });
});

describe("ARP v2 scoped responses", () => {
  function client(): TerminusArpV2Client {
    return new TerminusArpV2Client({ baseUrl: "http://example.test", token: "tok" });
  }

  function response(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  test("rejects a task detail whose id differs from the requested id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(task("task-other", "Other task"))));

    const error = await client().getTask("task-requested").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("v2 task detail response crossed the requested task scope");
  });

  test("rejects effects returned for a different task", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ effects: [effect("task-other")] })));

    const error = await client().listEffects("task-requested").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("v2 effect list response crossed the requested task scope");
  });

  test("rejects a proposed effect returned for a different task", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(effect("task-other"))));

    const error = await client().proposeEffect({
      taskId: "task-requested",
      intentType: "write",
      effectClass: "LOCAL_FS_WRITE",
    }, { idempotencyKey: "effect-proposal-test" }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as TerminusApiError).message).toContain("v2 effect proposal response crossed the requested task scope");
  });

  test("rejects attention assessments and questions returned for a different task", async () => {
    const assessment = {
      taskId: "task-other",
      requiresAttention: true,
      urgency: "HIGH",
      pendingQuestions: [materialQuestion("task-other")],
      reason: "human input is required",
      timestamp: "2026-08-23T12:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async () => response(assessment)));

    const assessmentError = await client().assessTaskAttention("task-requested").catch((reason: unknown) => reason);
    expect(assessmentError).toBeInstanceOf(TerminusApiError);
    expect(assessmentError).toMatchObject({ status: 502 });

    vi.stubGlobal("fetch", vi.fn(async () => response({ questions: [materialQuestion("task-other")] })));
    const questionError = await client().listMaterialQuestions("task-requested").catch((reason: unknown) => reason);
    expect(questionError).toBeInstanceOf(TerminusApiError);
    expect(questionError).toMatchObject({ status: 502 });
  });

  test("rejects question resolution and intervention application responses with another identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      success: true,
      question: materialQuestion("task-requested"),
      error: null,
    })));
    const questionError = await client().resolveMaterialQuestion(
      "question-requested",
      "keep",
      { idempotencyKey: "question-resolve-scope" },
    ).catch((reason: unknown) => reason);
    expect(questionError).toBeInstanceOf(TerminusApiError);
    expect(questionError).toMatchObject({ status: 502 });

    vi.stubGlobal("fetch", vi.fn(async () => response({
      success: true,
      intervention: intervention("intervention-other"),
      appliedChanges: {},
      error: null,
    })));
    const interventionError = await client().applyIntervention(
      "intervention-requested",
      { idempotencyKey: "intervention-apply-scope" },
    ).catch((reason: unknown) => reason);
    expect(interventionError).toBeInstanceOf(TerminusApiError);
    expect(interventionError).toMatchObject({ status: 502 });
  });

  test("rejects a quick action response with a different requested action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      success: true,
      action: "resume",
      timestamp: "2026-08-23T12:00:00.000Z",
    })));
    const error = await client().executeMobileAction(
      "task-requested",
      "pause",
      { idempotencyKey: "mobile-action-scope" },
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TerminusApiError);
    expect(error).toMatchObject({ status: 502 });
  });
});

describe("ARP v2 event admission", () => {
  test("decodes every required envelope field instead of trusting eventType alone", () => {
    expect(() => decodeArpV2EventEnvelope({ eventType: "task.updated" })).toThrow(
      "v2 event envelope.schemaVersion was not a finite number",
    );
    expect(decodeArpV2EventEnvelope(eventEnvelope())).toEqual(eventEnvelope());
  });

  test("binds effect and claim refreshes to an explicit task snapshot", () => {
    expect(eventBelongsToTask(eventEnvelope(), "task-requested")).toBe(true);
    expect(eventBelongsToTask(eventEnvelope({ aggregateId: "task-other" }), "task-requested")).toBe(false);

    const relatedEffect = eventEnvelope({
      eventType: "effect.proposed",
      aggregateType: "effect",
      aggregateId: "effect-1",
      payload: effect("task-requested"),
    });
    expect(eventBelongsToTask(relatedEffect, "task-requested")).toBe(true);
    expect(eventBelongsToTask({
      ...relatedEffect,
      payload: { snapshot: effect("task-requested") },
    }, "task-requested")).toBe(true);
    expect(eventBelongsToTask({
      ...relatedEffect,
      payload: effect("task-other"),
    }, "task-requested")).toBe(false);
    expect(eventBelongsToTask({
      ...relatedEffect,
      aggregateId: "effect-other",
    }, "task-requested")).toBe(false);
  });

  test("does not advance the stream cursor when the SSE id and envelope id differ", async () => {
    const envelope = eventEnvelope({ eventId: "envelope-event" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `id: transport-event\nevent: ${envelope.eventType}\ndata: ${JSON.stringify(envelope)}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    const stream = subscribeEventsV2({ baseUrl: "http://example.test", token: "tok" });
    const messages: ArpV2EventEnvelope[] = [];
    stream.addEventListener("message", (event) => messages.push(event));
    await new Promise<void>((resolve) => stream.addEventListener("error", resolve));

    expect(messages).toEqual([]);
    expect(stream.lastEventId).toBeNull();
    stream.close();
  });
});
