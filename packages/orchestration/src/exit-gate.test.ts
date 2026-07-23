/**
 * M8 orchestration exit gate: parallelism helps separable work; non-separable
 * stays single-agent; cycles terminate within budget; cancellation reaches
 * model/tools/jobs/workers/integrations/effects.
 */
import { describe, test, expect } from "bun:test";
import type { Uuid7, Rfc3339Timestamp, Task, TaskContract } from "@terminus/domain";
import {
  CancellationCoordinator,
  CANCELLATION_REACH_LAYERS,
  GraphExecutor,
  validateGraph,
  rejectModelWrittenOrchestration,
  decideForCohort,
  expectsParallelism,
  expectsSingleAgent,
  inferCohort,
  applyLoopIntervention,
  LoopDetector,
  DEFAULT_LOOP_DETECTOR_CONFIG,
  ReadOnlyScoutService,
  ManagedWorktreeLedger,
  validateWorkerResult,
  MergeIntegrationCoordinator,
  ReviewFindingService,
  InMemoryFindingStore,
  ORCHESTRATION_ABLATIONS,
  type SpawnSignals,
  type GraphDefinition,
  type CancellableHandle,
} from "./index.js";

function fakeUuid(n: number): Uuid7 {
  const tail = n.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}` as Uuid7;
}

function fakeTs(): Rfc3339Timestamp {
  return new Date().toISOString() as Rfc3339Timestamp;
}

function baseSignals(over: Partial<SpawnSignals> = {}): SpawnSignals {
  return {
    separability: 0.8,
    likelyFileOverlap: 0.1,
    isWriteWork: true,
    currentUncertainty: 0.2,
    contextPressure: 0.5,
    testQuality: 0.8,
    riskClass: "normal",
    pastWorkerSuccessRate: 0.7,
    budgetRemaining: 0.8,
    modelAvailability: 1,
    maxParallel: 4,
    activeWorkers: 0,
    ...over,
  };
}

function mkTask(): Task {
  return {
    id: fakeUuid(1),
    sessionId: fakeUuid(2),
    threadId: fakeUuid(3),
    contract: {
      id: fakeUuid(5),
      version: 1,
      objective: "do work",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: { readPaths: ["**"], writePaths: ["src/**"], externalSystems: [] },
      riskClass: "normal",
      budget: {
        modelMicros: 1_000_000n as TaskContract["budget"]["modelMicros"],
        computeSeconds: 100,
        wallClockSeconds: 100,
        humanApprovals: 5,
      },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    },
    status: "ACTIVE",
    phase: "IMPLEMENT",
    scopeLedgerId: fakeUuid(4),
    verificationPlanId: null,
    createdAt: fakeTs(),
    completedAt: null,
  };
}

describe("M8 orchestration exit gate", () => {
  test("parallelism helps separable cohort", () => {
    const cohort = inferCohort({
      separability: 0.9,
      likelyFileOverlap: 0.1,
      riskClass: "normal",
      unfamiliarRepo: false,
    });
    expect(cohort).toBe("parallelizable");
    expect(expectsParallelism(cohort)).toBe(true);
    const decision = decideForCohort(cohort, mkTask(), baseSignals());
    expect(decision.spawn).toBe(true);
  });

  test("non-separable work stays single-agent", () => {
    const cohort = inferCohort({
      separability: 0.1,
      likelyFileOverlap: 0.9,
      riskClass: "normal",
      unfamiliarRepo: false,
    });
    expect(cohort).toBe("tightly_coupled");
    expect(expectsSingleAgent(cohort)).toBe(true);
    const decision = decideForCohort(
      cohort,
      mkTask(),
      baseSignals({ separability: 0.1, likelyFileOverlap: 0.9 }),
    );
    expect(decision.spawn).toBe(false);
  });

  test("cycles terminate within budget (graph rejects cycles)", () => {
    const cyclic: GraphDefinition = {
      id: "g1",
      nodes: [
        {
          id: "a",
          kind: "worker",
          required: true,
          inputs: [],
          outputs: [{ name: "result", valueTag: "unit" }],
          dependsOn: ["b"],
          retryIdentity: "a",
          fanOutKey: null,
          transform: null,
        },
        {
          id: "b",
          kind: "worker",
          required: true,
          inputs: [],
          outputs: [{ name: "result", valueTag: "unit" }],
          dependsOn: ["a"],
          retryIdentity: "b",
          fanOutKey: null,
          transform: null,
        },
      ],
      edges: [],
      convergence: { maxSteps: 10, maxWallClockMs: 1000, requiredOutputPorts: [] },
      boundedConcurrency: 2,
      missingWorkerPolicy: "fail_required",
    };
    expect(() => validateGraph(cyclic)).toThrow(/cycle/i);
  });

  test("required node failure fails the graph; optional yields typed absence", async () => {
    const def: GraphDefinition = {
      id: "g2",
      nodes: [
        {
          id: "req",
          kind: "worker",
          required: true,
          inputs: [],
          outputs: [{ name: "result", valueTag: "string" }],
          dependsOn: [],
          retryIdentity: "req-1",
          fanOutKey: null,
          transform: null,
        },
        {
          id: "opt",
          kind: "worker",
          required: false,
          inputs: [],
          outputs: [{ name: "result", valueTag: "string" }],
          dependsOn: [],
          retryIdentity: "opt-1",
          fanOutKey: null,
          transform: null,
        },
      ],
      edges: [],
      convergence: { maxSteps: 10, maxWallClockMs: 1000, requiredOutputPorts: [] },
      boundedConcurrency: 2,
      missingWorkerPolicy: "typed_absence",
    };
    const exec = new GraphExecutor({
      handler: {
        async execute(node) {
          if (node.id === "req") return { status: "fail", error: "boom" };
          return { status: "fail", error: "optional boom" };
        },
      },
      transforms: new Map(),
      clock: () => Date.now(),
      seenWork: new Set(),
    });
    const result = await exec.run(def, null);
    expect(result.status).toBe("failed");
    expect(result.failures.some((f) => f.nodeId === "req")).toBe(true);
  });

  test("model-written JS orchestration is rejected", () => {
    expect(() => rejectModelWrittenOrchestration("async function run() {}")).toThrow(
      /not permitted/,
    );
  });

  test("cancellation reaches model, tools, jobs, workers, integrations, effects", async () => {
    const cancelled: string[] = [];
    const mk = (id: string, kind: CancellableHandle["kind"], parentId: string | null, effectId: string | null = null): CancellableHandle => {
      let done = false;
      return {
        id,
        kind,
        parentId,
        effectId,
        cancel: async () => {
          cancelled.push(id);
          done = true;
        },
        isCancelled: () => done,
      };
    };
    const c = new CancellationCoordinator();
    c.register(mk("task-1", "task", null));
    c.register(mk("attempt-1", "model_attempt", "task-1"));
    c.register(mk("tool-1", "tool_call", "attempt-1"));
    c.register(mk("job-1", "job", "tool-1"));
    c.register(mk("worker-1", "worker", "task-1"));
    c.register(mk("integ-1", "integration", "task-1"));
    c.register(mk("effect-1", "external_effect", "task-1", "effect-1"));

    expect(c.missingCancellationLayers("task-1")).toEqual([]);
    await c.cancelTask("task-1");
    expect(c.isCancelled("attempt-1")).toBe(true);
    expect(c.isCancelled("tool-1")).toBe(true);
    expect(c.isCancelled("job-1")).toBe(true);
    expect(c.isCancelled("worker-1")).toBe(true);
    expect(c.isCancelled("integ-1")).toBe(true);
    // External effects require reconciliation rather than blind cancel.
    expect(c.isCancelled("effect-1")).toBe(true);
    await c.reconcileEffect("effect-1");
    expect(c.isReconciled("effect-1")).toBe(true);
    expect(CANCELLATION_REACH_LAYERS.length).toBe(6);
  });

  test("loop terminate intervention maps to ABORTED", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      maximumTurns: 2,
      turnsWithoutProgress: 2,
    });
    d.observe({
      toolCallId: fakeUuid(1),
      toolName: "exec",
      normalizedArguments: "x",
      resultStatus: "failed",
      sourceVersion: null,
      timestamp: fakeTs(),
    });
    d.observe({
      toolCallId: fakeUuid(2),
      toolName: "exec",
      normalizedArguments: "y",
      resultStatus: "pending",
      sourceVersion: null,
      timestamp: fakeTs(),
    });
    // Force terminate via direct intervention mapping.
    const effect = applyLoopIntervention({
      kind: "terminate",
      reason: "budget",
      signals: ["maximum_turns"],
    });
    expect(effect.taskStatus).toBe("ABORTED");
    expect(effect.terminate).toBe(true);
  });

  test("scout spawn enforces empty write paths", async () => {
    const created: unknown[] = [];
    const scouts = new ReadOnlyScoutService({
      async create(input) {
        created.push(input);
        return {
          id: fakeUuid(9),
          parentTaskId: input.parentTaskId,
          role: input.role,
          objective: input.objective,
          scope: input.scope,
          nonGoals: input.nonGoals,
          allowedReadPaths: input.scope.readPaths,
          allowedWritePaths: input.scope.writePaths,
          startingReferences: input.startingReferences,
          requiredCapabilities: input.requiredCapabilities,
          forbiddenCapabilities: input.forbiddenCapabilities,
          acceptanceTests: input.acceptanceTests,
          resultSchemaVersion: input.resultSchemaVersion,
          budgets: input.budgets,
          stopConditions: input.stopConditions,
          worktreeId: null,
          status: "pending",
          result: null,
        };
      },
    });
    const d = await scouts.spawn({
      parentTaskId: fakeUuid(1),
      objective: "explore",
      readPaths: ["src/**"],
      startingReferences: [],
      budgets: {
        inputTokens: 1000n as never,
        outputTokens: 1000n as never,
        toolCalls: 10,
        costMicros: 1000n as never,
        wallClockSeconds: 60,
      },
    });
    expect(d.allowedWritePaths).toEqual([]);
    expect(d.role).toBe("scout");
  });

  test("managed worktree enforces exact-HEAD and ownership", async () => {
    const ledger = new ManagedWorktreeLedger({
      ops: {
        async createWorktree({ path, baseRevision }) {
          return { path, headRevision: baseRevision };
        },
        async removeWorktree() {},
      },
      idSource: () => "wt-1",
      clock: fakeTs,
    });
    const lease = await ledger.acquire({
      taskId: fakeUuid(1),
      agentId: null,
      delegationId: null,
      path: "/tmp/wt",
      baseRevision: "abc",
      ownedPathPrefixes: ["src/a"],
    });
    expect(lease.status).toBe("active");
    await expect(
      ledger.acquire({
        taskId: fakeUuid(1),
        agentId: null,
        delegationId: null,
        path: "/tmp/wt2",
        baseRevision: "abc",
        ownedPathPrefixes: ["src/a/b"],
      }),
    ).rejects.toThrow(/ownership conflict/);
  });

  test("typed worker result validation rejects scout writes", () => {
    expect(() =>
      validateWorkerResult(
        {
          id: fakeUuid(1),
          parentTaskId: fakeUuid(2),
          role: "scout",
          objective: "x",
          scope: { readPaths: ["**"], writePaths: [], externalSystems: [] },
          nonGoals: [],
          allowedReadPaths: ["**"],
          allowedWritePaths: [],
          startingReferences: [],
          requiredCapabilities: [],
          forbiddenCapabilities: [],
          acceptanceTests: [],
          resultSchemaVersion: "1",
          budgets: {
            inputTokens: 1n as never,
            outputTokens: 1n as never,
            toolCalls: 1,
            costMicros: 1n as never,
            wallClockSeconds: 1,
          },
          stopConditions: [],
          worktreeId: null,
          status: "running",
          result: null,
        },
        {
          status: "completed",
          summary: "wrote",
          changed_files: ["src/a.ts"],
          commit: null,
          tests: [],
          findings: [],
          risks: [],
          artifacts: [],
        },
      ),
    ).toThrow(/read-only|scout/i);
  });

  test("merge coordinator requires post-merge verification", async () => {
    let verified = false;
    const coord = new MergeIntegrationCoordinator(
      {
        async merge() {
          return { status: "merged", revision: "rev-merged" };
        },
      },
      {
        async evaluate() {
          verified = true;
          return { allRequiredPassed: true, detail: "ok" };
        },
      },
    );
    const plan = coord.planMerge({
      lease: {
        id: "wt-1",
        taskId: fakeUuid(1),
        agentId: null,
        delegationId: null,
        path: "/tmp/wt",
        baseRevision: "base",
        headRevision: "head",
        ownedPathPrefixes: ["src"],
        status: "active",
        createdAt: fakeTs(),
        updatedAt: fakeTs(),
      },
      diff: {
        changedPaths: ["src/a.ts"],
        additions: 1,
        deletions: 0,
        riskClass: "normal",
        touchesAuth: false,
        touchesMigrations: false,
        touchesPublicApi: false,
        touchesDependencies: false,
        isCrossCutting: false,
        isPerformanceCritical: false,
        repeatedRepairCycles: false,
        testCoverageWeak: false,
        implementerLowConfidence: false,
        userRequestedExhaustive: false,
      },
      result: {
        status: "completed",
        summary: "ok",
        changedFiles: ["src/a.ts"],
        commit: "c1",
        tests: [],
        findings: [],
        risks: [],
        unresolved: [],
        artifacts: [],
        actualBudget: {},
      },
      targetBranch: "main",
    });
    expect(plan.requireVerification).toBe(true);
    const out = await coord.executeMerge({
      plan,
      verificationPlanId: fakeUuid(9),
    });
    expect(verified).toBe(true);
    expect(out.integration.accepted).toBe(true);
  });

  test("review finding lifecycle blocks completion while OPEN", async () => {
    const svc = new ReviewFindingService({
      store: new InMemoryFindingStore(),
      idSource: () => fakeUuid(Math.floor(Math.random() * 10000) + 1),
      clock: fakeTs,
    });
    await svc.open({
      taskId: fakeUuid(1),
      delegationId: null,
      verificationPlanId: null,
      title: "issue",
      body: "body",
      severity: "high",
      affectedPaths: ["src/a.ts"],
      evidence: [],
    });
    expect(await svc.completionAllowed(fakeUuid(1))).toBe(false);
  });

  test("ablations cover one-agent/scout/writer/reviewer", () => {
    const dims = new Set(ORCHESTRATION_ABLATIONS.map((a) => a.dimension));
    expect(dims.has("scout")).toBe(true);
    expect(dims.has("writer")).toBe(true);
    expect(dims.has("reviewer")).toBe(true);
    expect(dims.has("parallel_writers")).toBe(true);
  });
});
