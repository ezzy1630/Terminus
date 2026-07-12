/**
 * @forge/orchestration — tests for loop detection (§37.14, all 10 signals),
 * budget control (§37.16), hierarchical cancellation (§37.17), and plan
 * artifact (§37.4).
 */
import { describe, test, expect } from "bun:test";
import type { Uuid7, Rfc3339Timestamp, TaskContract } from "@forge/domain";
import {
  LoopDetector,
  DEFAULT_LOOP_DETECTOR_CONFIG,
  BudgetController,
  CancellationCoordinator,
  PlanBuilder,
  type LoopObservation,
  type Budget,
  type CancellableHandle,
  type PlanBuilderInput,
} from "./index.js";

function fakeUuid(n: number): Uuid7 {
  const tail = n.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}` as Uuid7;
}

function fakeTs(): Rfc3339Timestamp {
  return new Date().toISOString() as Rfc3339Timestamp;
}

function obs(overrides: Partial<LoopObservation> = {}): LoopObservation {
  return {
    toolCallId: fakeUuid(Math.floor(Math.random() * 1_000_000) + 100),
    toolName: "exec",
    normalizedArguments: "",
    resultStatus: "success",
    sourceVersion: null,
    timestamp: fakeTs(),
    ...overrides,
  };
}

// ────────────────────────── Loop detector (§37.14, all 10 signals) ───────────

describe("LoopDetector — all 10 signals", () => {
  test("signal 1: repeated identical failed commands", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      repeatedIdenticalFailure: 3,
    });
    for (let i = 0; i < 3; i++) {
      d.observe(obs({
        toolName: "exec",
        normalizedArguments: '["bun","test"]',
        resultStatus: "failed",
      }));
    }
    const i = d.intervene();
    expect(i).not.toBeNull();
    expect(i!.signals).toContain("repeated_identical_failure");
  });

  test("signal 2: unchanged re-reads", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      unchangedReReads: 2,
    });
    for (let i = 0; i < 2; i++) {
      d.observe(obs({
        toolName: "read",
        readPath: "src/a.ts",
        readContentHash: "sha256:abc",
      }));
    }
    const i = d.intervene();
    expect(i).not.toBeNull();
    expect(i!.signals).toContain("unchanged_re_reads");
  });

  test("signal 3: edit/revert oscillation", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      editRevertCycles: 1,
    });
    d.observe(obs({ toolName: "patch", patchOp: "insert", patchPath: "src/a.ts" }));
    d.observe(obs({ toolName: "patch", patchOp: "insert", patchPath: "src/a.ts", isRevert: true }));
    const i = d.intervene();
    expect(i).not.toBeNull();
    expect(i!.signals).toContain("edit_revert_oscillation");
  });

  test("signal 4: no diagnostic reduction", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      noDiagnosticReduction: 3,
    });
    d.observe(obs({ diagnosticCount: 5 }));
    d.observe(obs({ diagnosticCount: 5 }));
    d.observe(obs({ diagnosticCount: 5 }));
    const i = d.intervene();
    expect(i).not.toBeNull();
    expect(i!.signals).toContain("no_diagnostic_reduction");
  });

  test("signal 5: repeated strategy without new evidence", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      repeatedStrategyWithoutEvidence: 2,
    });
    d.observe(obs({ strategy: "fix_imports", newEvidence: false }));
    d.observe(obs({ strategy: "fix_imports", newEvidence: false }));
    const i = d.intervene();
    expect(i).not.toBeNull();
    expect(i!.signals).toContain("repeated_strategy_without_evidence");
  });

  test("signal 6: duplicate worker exploration", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      duplicateWorkerExploration: 1,
    });
    d.observe(obs({ workerId: "w1", explorationTarget: "src/auth.ts" }));
    d.observe(obs({ workerId: "w2", explorationTarget: "src/auth.ts" }));
    const i = d.intervene();
    expect(i).not.toBeNull();
    expect(i!.signals).toContain("duplicate_worker_exploration");
  });

  test("signal 7: context growth without task-ledger progress", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      contextGrowthWithoutProgress: 3,
    });
    d.observe(obs({ contextTokens: 1000, taskLedgerProgress: false }));
    d.observe(obs({ contextTokens: 2000, taskLedgerProgress: false }));
    d.observe(obs({ contextTokens: 3000, taskLedgerProgress: false }));
    const i = d.intervene();
    expect(i).not.toBeNull();
    expect(i!.signals).toContain("context_growth_without_progress");
  });

  test("signal 8: repeated scope challenges", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      repeatedScopeChallenges: 2,
    });
    d.observe(obs({ isScopeChallenge: true }));
    d.observe(obs({ isScopeChallenge: true }));
    const i = d.intervene();
    expect(i).not.toBeNull();
    expect(i!.signals).toContain("repeated_scope_challenges");
  });

  test("signal 9: repeated model fallback or schema failure", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      repeatedModelFallback: 2,
    });
    d.observe(obs({ isModelFallback: true }));
    d.observe(obs({ isSchemaFailure: true }));
    d.observe(obs({ isSchemaFailure: true }));
    const i = d.intervene();
    expect(i).not.toBeNull();
    // Either model fallback or schema failure (both signal 9).
    expect(
      i!.signals.includes("repeated_model_fallback") ||
      i!.signals.includes("repeated_schema_failure"),
    ).toBe(true);
  });

  test("signal 10: repeated approval requests for the same denied class", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      repeatedDeniedApprovals: 2,
    });
    d.observe(obs({ approvalClass: "external_network", approvalDenied: true }));
    d.observe(obs({ approvalClass: "external_network", approvalDenied: true }));
    const i = d.intervene();
    expect(i).not.toBeNull();
    expect(i!.signals).toContain("repeated_denied_approvals");
  });

  test("no signals → no intervention", () => {
    const d = new LoopDetector();
    d.observe(obs({ resultStatus: "success" }));
    expect(d.intervene()).toBeNull();
  });

  test("maximum turns → terminate", () => {
    const d = new LoopDetector({
      ...DEFAULT_LOOP_DETECTOR_CONFIG,
      maximumTurns: 3,
    });
    d.observe(obs());
    d.observe(obs());
    d.observe(obs());
    const i = d.intervene();
    expect(i).not.toBeNull();
    expect(i!.kind).toBe("terminate");
  });
});

// ────────────────────────── Budget control (§37.16) ──────────────────────────

describe("BudgetController", () => {
  const budget: Budget = {
    modelMicros: { soft: 100, hard: 200 },
    computeSeconds: { soft: 10, hard: 20 },
    wallClockSeconds: { soft: 60, hard: 120 },
    humanApprovals: { soft: 2, hard: 5 },
  };

  test("soft limit produces an alert", () => {
    const c = new BudgetController(budget, "task:t1");
    c.consume("modelMicros", 100);
    const alerts = c.alerts();
    expect(alerts.some((a) => a.level === "soft" && a.budgetType === "modelMicros")).toBe(true);
    expect(c.isExhausted()).toBe(false);
  });

  test("hard limit crossing produces terminal state", () => {
    const c = new BudgetController(budget, "task:t1");
    expect(() => c.consume("modelMicros", 200)).toThrow();
    expect(c.isExhausted()).toBe(true);
    // Subsequent consume rethrows.
    expect(() => c.consume("computeSeconds", 1)).toThrow();
  });

  test("hard alert is present after crossing", () => {
    const c = new BudgetController(budget, "task:t1");
    try {
      c.consume("humanApprovals", 5);
    } catch {
      // expected
    }
    const alerts = c.alerts();
    expect(alerts.some((a) => a.level === "hard" && a.budgetType === "humanApprovals")).toBe(true);
  });

  test("projectExhaustion estimates time-to-exhaustion from rate", () => {
    let now = 1_000_000;
    const c = new BudgetController(budget, "task:t1", () => now);
    // Simulate a few samples within the rate window.
    c.consume("modelMicros", 10);
    now += 1_000;
    c.consume("modelMicros", 10);
    now += 1_000;
    const projections = c.projectExhaustion();
    const modelMicrosProj = projections.find((p) => p.budgetType === "modelMicros");
    expect(modelMicrosProj).toBeDefined();
    expect(modelMicrosProj!.ratePerSecond).toBeGreaterThan(0);
    expect(modelMicrosProj!.estimatedSecondsToExhaustion).toBeGreaterThan(0);
  });

  test("projectExhaustion returns null when no rate observed", () => {
    const c = new BudgetController(budget, "task:t1");
    const projections = c.projectExhaustion();
    const modelMicrosProj = projections.find((p) => p.budgetType === "modelMicros");
    expect(modelMicrosProj!.estimatedSecondsToExhaustion).toBeNull();
  });

  test("negative consumption is rejected", () => {
    const c = new BudgetController(budget, "task:t1");
    expect(() => c.consume("modelMicros", -1)).toThrow();
  });
});

// ────────────────────────── Hierarchical cancellation (§37.17) ───────────────

describe("CancellationCoordinator", () => {
  function makeHandle(
    id: string,
    parentId: string | null,
    kind: "session" | "task" | "turn" | "tool_call" | "job" | "process" | "external_effect",
    cancelFn: () => Promise<void> = async () => {},
    effectId: string | null = null,
  ): CancellableHandle {
    let cancelled = false;
    return {
      id,
      kind,
      parentId,
      effectId,
      async cancel(): Promise<void> {
        await cancelFn();
        cancelled = true;
      },
      isCancelled: () => cancelled,
    };
  }

  test("cancelSession cancels all descendants", async () => {
    const coord = new CancellationCoordinator();
    const cancelled: string[] = [];
    coord.register(makeHandle("s1", null, "session", async () => { cancelled.push("s1"); }));
    coord.register(makeHandle("t1", "s1", "task", async () => { cancelled.push("t1"); }));
    coord.register(makeHandle("turn1", "t1", "turn", async () => { cancelled.push("turn1"); }));
    coord.register(makeHandle("tc1", "turn1", "tool_call", async () => { cancelled.push("tc1"); }));
    await coord.cancelSession("s1");
    expect(cancelled.sort()).toEqual(["s1", "t1", "tc1", "turn1"]);
    expect(coord.isCancelled("s1")).toBe(true);
    expect(coord.isCancelled("t1")).toBe(true);
  });

  test("cancelTask cancels task descendants but not siblings", async () => {
    const coord = new CancellationCoordinator();
    const cancelled: string[] = [];
    coord.register(makeHandle("s1", null, "session", async () => { cancelled.push("s1"); }));
    coord.register(makeHandle("t1", "s1", "task", async () => { cancelled.push("t1"); }));
    coord.register(makeHandle("t2", "s1", "task", async () => { cancelled.push("t2"); }));
    await coord.cancelTask("t1");
    expect(cancelled).toContain("t1");
    expect(cancelled).not.toContain("t2");
    expect(coord.isCancelled("t1")).toBe(true);
    expect(coord.isCancelled("t2")).toBe(false);
  });

  test("cancellation is idempotent", async () => {
    const coord = new CancellationCoordinator();
    let cancelCount = 0;
    coord.register(makeHandle("s1", null, "session", async () => { cancelCount++; }));
    await coord.cancelSession("s1");
    await coord.cancelSession("s1");
    expect(cancelCount).toBe(1);
  });

  test("external effect requires reconciliation, not blind cancel", async () => {
    const coord = new CancellationCoordinator();
    let cancelled = false;
    coord.register(makeHandle("eff1", "t1", "external_effect", async () => { cancelled = true; }, "deploy-123"));
    await coord.cancelTask("t1");
    // Blind cancel does NOT invoke the effect's cancel.
    expect(cancelled).toBe(false);
    expect(coord.pendingReconciliations()).toContain("deploy-123");
    await coord.reconcileEffect("deploy-123");
    expect(cancelled).toBe(true);
    expect(coord.isReconciled("deploy-123")).toBe(true);
  });

  test("reconcileEffect is idempotent", async () => {
    const coord = new CancellationCoordinator();
    let cancelCount = 0;
    coord.register(makeHandle("eff1", "t1", "external_effect", async () => { cancelCount++; }, "deploy-456"));
    await coord.reconcileEffect("deploy-456");
    await coord.reconcileEffect("deploy-456");
    expect(cancelCount).toBe(1);
  });

  test("reconcileEffect throws for unknown effect", async () => {
    const coord = new CancellationCoordinator();
    expect(async () => {
      await coord.reconcileEffect("unknown");
    }).toThrow();
  });
});

// ────────────────────────── Plan artifact (§37.4) ────────────────────────────

describe("PlanBuilder", () => {
  function mkContract(version = 1): TaskContract {
    return {
      id: fakeUuid(1),
      version,
      objective: "Implement feature X",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [{ id: "ac1", statement: "It works", verificationHint: null, required: true }],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: { readPaths: ["src/"], writePaths: ["src/"], externalSystems: [] },
      riskClass: "normal",
      budget: { modelMicros: 1_000_000n, computeSeconds: 60, wallClockSeconds: 600, humanApprovals: 1 },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    } as unknown as TaskContract;
  }

  function mkInput(overrides: Partial<PlanBuilderInput> = {}): PlanBuilderInput {
    return {
      taskContract: mkContract(),
      approach: "Add a new module",
      alternativesConsidered: [
        { name: "alt1", summary: "Approach A", rejectedReason: "Too risky" },
      ],
      selectedReason: "Lower risk",
      filesOrComponents: [{ path: "src/x.ts", change: "create", rationale: "New module" }],
      sequence: [{ sequence: 1, description: "Implement module", dependsOn: [], verificationHint: null }],
      risks: [{ description: "Performance", severity: "medium", mitigation: "Benchmark" }],
      verification: [{ criterionId: "ac1", nodeIds: ["parse"] }],
      rollback: "Delete the new module",
      unresolvedDecisions: [],
      ...overrides,
    };
  }

  test("builds a plan from a task contract", () => {
    const b = new PlanBuilder(() => "2024-01-01T00:00:00Z" as Rfc3339Timestamp);
    const plan = b.build(mkInput());
    expect(plan.taskContractVersion).toBe(1);
    expect(plan.approach).toBe("Add a new module");
    expect(plan.sequence.length).toBe(1);
    expect(plan.generatedAt).toBe("2024-01-01T00:00:00Z" as Rfc3339Timestamp);
  });

  test("rejects private-reasoning markers in approach", () => {
    const b = new PlanBuilder();
    expect(() => b.build(mkInput({ approach: "<thinking>let me reason</thinking>" }))).toThrow();
  });

  test("rejects private-reasoning markers in selectedReason", () => {
    const b = new PlanBuilder();
    expect(() => b.build(mkInput({ selectedReason: "chain-of-thought suggests X" }))).toThrow();
  });

  test("rejects sequence step depending on future step", () => {
    const b = new PlanBuilder();
    expect(() =>
      b.build(mkInput({
        sequence: [
          { sequence: 1, description: "Step 1", dependsOn: [2], verificationHint: null },
          { sequence: 2, description: "Step 2", dependsOn: [], verificationHint: null },
        ],
      })),
    ).toThrow();
  });

  test("rejects duplicate sequence numbers", () => {
    const b = new PlanBuilder();
    expect(() =>
      b.build(mkInput({
        sequence: [
          { sequence: 1, description: "Step 1", dependsOn: [], verificationHint: null },
          { sequence: 1, description: "Step 1b", dependsOn: [], verificationHint: null },
        ],
      })),
    ).toThrow();
  });

  test("rejects verification referencing unknown criterion", () => {
    const b = new PlanBuilder();
    expect(() =>
      b.build(mkInput({
        verification: [{ criterionId: "unknown-ac", nodeIds: ["parse"] }],
      })),
    ).toThrow();
  });
});
