/**
 * @terminus/orchestration — tests for Expected-Value Scheduler, Clean-Context Reviewer,
 * Stagnation Supervisor, and Candidate Workspace Manager (SPEC §27).
 */
import { describe, test, expect } from "bun:test";
import { delegationContractV2Schema, stagnationReportSchema } from "@terminus/domain";
import {
  ExpectedValueScheduler,
  CleanContextReviewer,
  StagnationSupervisor,
  CandidateWorkspaceManager,
} from "./index.js";

describe("ExpectedValueScheduler (SPEC §27.1, §27.2)", () => {
  test("denies spawning when expected value is below threshold", () => {
    const scheduler = new ExpectedValueScheduler({
      spawnThreshold: 0.2,
      maxParallelWorkers: 4,
      highRiskParallelWriterAllowed: false,
    });

    const decision = scheduler.evaluate({
      separability: 0.1, // low independence
      likelyFileOverlap: 0.9, // high conflict risk
      isWriteWork: true,
      currentUncertainty: 0.1,
      contextPressure: 0.2,
      riskClass: "normal",
      budgetRemainingRatio: 0.3,
      activeWorkerCount: 1,
      candidateObjective: "Refactor core parser",
      parentTaskId: "task-root",
      delegationId: "delegation:phase8:low-value",
      reservationId: "reservation:phase8:low-value",
    });

    expect(decision.spawn).toBe(false);
    expect(decision.expectedValue).toBeLessThanOrEqual(0.2);
    expect(decision.contract).toBeNull();
  });

  test("approves spawning when expected value exceeds threshold and synthesizes DelegationContractV2", () => {
    const scheduler = new ExpectedValueScheduler({
      spawnThreshold: 0.1,
      maxParallelWorkers: 4,
      highRiskParallelWriterAllowed: false,
    });

    const decision = scheduler.evaluate({
      separability: 0.95, // highly separable scout task
      likelyFileOverlap: 0.0, // no overlap
      isWriteWork: false,
      currentUncertainty: 0.9, // high uncertainty
      contextPressure: 0.8,
      riskClass: "low",
      budgetRemainingRatio: 0.9,
      activeWorkerCount: 0,
      candidateObjective: "Explore dependency graph",
      parentTaskId: "task-root",
      delegationId: "delegation:phase8:scout",
      reservationId: "reservation:phase8:scout",
      allowedPaths: ["src/lib/"],
    });

    expect(decision.spawn).toBe(true);
    expect(decision.role).toBe("scout");
    expect(decision.expectedValue).toBeGreaterThan(0.1);
    expect(decision.contract).not.toBeNull();
    expect(decision.contract?.role).toBe("scout");
    expect(decision.contract?.writeIsolation).toBe("read_only");

    const parsed = delegationContractV2Schema.safeParse(decision.contract);
    expect(parsed.success).toBe(true);
  });

  test("rejects parallel writers on high-risk tasks", () => {
    const scheduler = new ExpectedValueScheduler();

    const decision = scheduler.evaluate({
      separability: 0.9,
      likelyFileOverlap: 0.0,
      isWriteWork: true,
      currentUncertainty: 0.5,
      contextPressure: 0.5,
      riskClass: "high",
      budgetRemainingRatio: 0.8,
      activeWorkerCount: 0,
      candidateObjective: "Rewrite authentication security kernel",
      parentTaskId: "task-root",
      delegationId: "delegation:phase8:writer",
      reservationId: "reservation:phase8:writer",
    });

    expect(decision.spawn).toBe(false);
    expect(decision.reason).toContain("Parallel speculative writers denied");
  });
});

describe("CleanContextReviewer (SPEC §27.4, §15.3)", () => {
  test("builds clean review context stripping author biases", () => {
    const reviewer = new CleanContextReviewer();

    const payload = reviewer.buildCleanReviewPayload({
      taskId: "task-100",
      contract: {
        version: 1,
        mission: "Refactor model router",
        scope: {
          resources: [],
          allowedEffectClasses: ["fs_read", "fs_write"],
          excludedPathsOrSystems: [],
        },
        acceptance: [
          { claimId: "c1", statement: "All tests pass", evidenceRequirement: "unit_tests" },
          { claimId: "c2", statement: "Zero regressions", evidenceRequirement: "eval_smoke" },
        ],
        constraints: {
          security: [],
          costMicros: 10_000_000n,
          timeoutSeconds: 60,
        },
        authorityCeiling: ["read", "write"],
        mode: "standard",
      },
      candidateDiff: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-foo\n+bar\n",
      changedFiles: ["packages/model-router/src/index.ts"],
      verificationEvidence: [
        {
          claimId: "claim-1",
          verifierKind: "test_suite",
          passed: true,
          summary: "37 tests passed",
        },
      ],
      riskClass: "normal",
      implementerModelFamilyRef: "family-a",
    });

    expect(payload.systemPrompt).toContain("independent, adversarial code reviewer");
    expect(payload.contextPayload.task).toBeDefined();
    expect(payload.contextPayload.candidate).toBeDefined();
    expect(payload.contextPayload.evidence).toBeDefined();
  });

  test("rejects candidate when critical findings exist and identifies diverse family", () => {
    const reviewer = new CleanContextReviewer();

    const report = reviewer.evaluateFindings(
      "task-100",
      "family-b",
      "family-a",
      [
        {
          id: "find-1",
          path: "packages/model-router/src/index.ts",
          severity: "critical",
          title: "Unhandled null dereference",
          description: "Missing check for undefined profile",
        },
      ],
    );

    expect(report.isDiverseFamily).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.findings.length).toBe(1);
  });
});

describe("StagnationSupervisor (SPEC §27.5)", () => {
  test("detects loop, oscillation, diagnostic stagnation, and escalates intervention", () => {
    const supervisor = new StagnationSupervisor();

    // Observe repeated command failure
    for (let i = 0; i < 3; i++) {
      supervisor.observe({
        turnIndex: i,
        toolName: "run_command",
        toolArguments: "cargo test",
        resultStatus: "failed",
        budgetBurnRatio: 0.1,
      });
    }

    // Observe unchanged re-reads
    for (let i = 3; i < 6; i++) {
      supervisor.observe({
        turnIndex: i,
        toolName: "read_file",
        toolArguments: "src/lib.rs",
        resultStatus: "success",
        readPath: "src/lib.rs",
        readContentHash: "hash_abc",
        budgetBurnRatio: 0.2,
      });
    }

    // Observe edit/revert oscillation
    supervisor.observe({
      turnIndex: 6,
      toolName: "edit_file",
      toolArguments: "src/lib.rs",
      resultStatus: "success",
      isRevert: true,
      budgetBurnRatio: 0.3,
    });
    supervisor.observe({
      turnIndex: 7,
      toolName: "edit_file",
      toolArguments: "src/lib.rs",
      resultStatus: "success",
      isRevert: true,
      budgetBurnRatio: 0.4,
    });

    const report = supervisor.evaluate("task-stagnant-1");
    expect(report.taskId).toBe("task-stagnant-1");
    expect(report.stagnationScore).toBeGreaterThanOrEqual(0.5);
    expect(report.detectedSignals.length).toBeGreaterThanOrEqual(3);
    expect(report.recommendedIntervention).not.toBe("none");

    const parsed = stagnationReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
  });
});

describe("CandidateWorkspaceManager (SPEC §27.3, §14.2)", () => {
  test("manages candidate workspaces with clean discard and admission lifecycle", () => {
    const mgr = new CandidateWorkspaceManager();

    const ws = mgr.createCandidateWorkspace({
      parentTaskId: "task-parent",
      workerId: "worker-writer-1",
      baseWorkspacePath: "/workspace",
    });

    expect(ws.status).toBe("active");
    expect(ws.branchName).toContain("task-parent");

    mgr.recordFileModification(ws.id, "src/feature.ts");
    expect(mgr.get(ws.id)?.modifiedFiles).toContain("src/feature.ts");

    const admitted = mgr.admit(ws.id);
    expect(admitted.status).toBe("admitted");

    const ws2 = mgr.createCandidateWorkspace({
      parentTaskId: "task-parent",
      workerId: "worker-writer-2",
      baseWorkspacePath: "/workspace",
    });
    mgr.discard(ws2.id, "Losing candidate branch");
    expect(mgr.get(ws2.id)?.status).toBe("discarded");
  });
});
