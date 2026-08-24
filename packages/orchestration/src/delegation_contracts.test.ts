import { describe, expect, test } from "bun:test";
import { delegationContractV2Schema } from "@terminus/domain";
import {
  BudgetReservationLedger,
  ExpectedValueScheduler,
  createCancellationPropagationContract,
  createDelegationBudgetReservationRequest,
  planWorktreeDelegation,
  validatePathDisjointWorktree,
  type Budget,
  type VerifiedDelegationOutcome,
} from "./index.js";

const budget: Budget = {
  modelMicros: { soft: 70, hard: 100 },
  computeSeconds: { soft: null, hard: 100 },
  wallClockSeconds: { soft: null, hard: 100 },
  humanApprovals: { soft: null, hard: 2 },
};

function writerContract() {
  return delegationContractV2Schema.parse({
    id: "delegation:task-1:implementer",
    parentTaskId: "task-1",
    role: "implementer",
    objective: "implement a bounded change",
    authorityCeiling: {
      allowedOperations: ["read", "search", "propose_patch"],
      allowedPaths: ["packages/a/**"],
      deniedEffects: ["execute_external_effect", "git_merge_authoritative", "deploy"],
    },
    inputHandles: [],
    expectedValue: 0.5,
    outputSchemaVersion: "2.0",
    evidenceRequirements: ["claim_verification_receipt"],
    budgetMicros: 50n,
    deadline: null,
    writeIsolation: "worktree",
    returnRoute: "/v2/tasks/task-1/delegations/return",
  });
}

function signals(overrides: Record<string, unknown> = {}) {
  return {
    separability: 0.95,
    likelyFileOverlap: 0,
    isWriteWork: false,
    currentUncertainty: 0.9,
    contextPressure: 0.8,
    riskClass: "low" as const,
    budgetRemainingRatio: 0.9,
    activeWorkerCount: 0,
    candidateObjective: "inspect independent evidence",
    parentTaskId: "task-1",
    ...overrides,
  };
}

describe("path-disjoint worktree delegation", () => {
  test("accepts disjoint active leases and rejects overlapping writers", () => {
    const valid = validatePathDisjointWorktree({
      baseRevision: "HEAD:abc",
      requestedPathPrefixes: ["packages/a/**"],
      activeLeases: [{ id: "lease-b", ownedPathPrefixes: ["packages/b"] }],
    });
    expect(valid.valid).toBe(true);
    expect(valid.normalizedRequestedPaths).toEqual(["packages/a"]);

    const conflict = validatePathDisjointWorktree({
      baseRevision: "HEAD:abc",
      requestedPathPrefixes: ["packages/a/file.ts"],
      activeLeases: [{ id: "lease-a", ownedPathPrefixes: ["packages/a"] }],
    });
    expect(conflict.valid).toBe(false);
    expect(conflict.conflicts[0]?.existingLeaseId).toBe("lease-a");
  });

  test("returns a typed kernel-blocked plan even after validation passes", () => {
    const plan = planWorktreeDelegation({
      contract: writerContract(),
      worktree: {
        baseRevision: "HEAD:abc",
        requestedPathPrefixes: ["packages/a/**"],
        activeLeases: [],
      },
    });

    expect(plan.status).toBe("blocked_executor_unavailable");
    expect(plan.canExecute).toBe(false);
    expect(plan.metadata.executorBoundary).toBe("terminus.kernel.v1");
    expect(plan.metadata.executorAvailable).toBe(false);
    expect(plan.metadata.disjoint).toBe(true);
  });
});

describe("calibrated expected-value delegation", () => {
  test("uses persisted verified outcomes and exposes their provenance", () => {
    const outcome: VerifiedDelegationOutcome = {
      id: "outcome-1",
      role: "scout",
      isWriteWork: false,
      riskClass: "low",
      verification: { status: "verified", receiptId: "receipt-1" },
      outcome: "beneficial",
      observedBenefit: 0.9,
      observedParallelSpeedup: 0.9,
      observedTokenCost: 0.01,
      observedCoordinationCost: 0.02,
      observedConflictRisk: 0,
      observedReviewCost: 0.01,
      verifiedAt: "2026-08-24T00:00:00Z",
    };
    const scheduler = new ExpectedValueScheduler({
      spawnThreshold: 0.1,
      maxParallelWorkers: 4,
      highRiskParallelWriterAllowed: false,
      verifiedOutcomeStore: {
        loadVerifiedOutcomes: () => [outcome],
      },
    });

    const decision = scheduler.evaluate(signals());
    expect(decision.spawn).toBe(true);
    expect(decision.breakdown.calibration.source).toBe("persisted_verified_outcomes");
    expect(decision.breakdown.calibration.sampleCount).toBe(1);
    expect(decision.budgetReservation?.cancellation.externalEffects).toBe("reconcile");

    const conservative = new ExpectedValueScheduler().evaluate(signals());
    expect(conservative.breakdown.calibration.source).toBe("conservative_prior");
  });

  test("rejects unverified persisted records instead of treating them as calibration", () => {
    const scheduler = new ExpectedValueScheduler({
      spawnThreshold: 0.1,
      maxParallelWorkers: 4,
      highRiskParallelWriterAllowed: false,
      verifiedOutcomeStore: {
        loadVerifiedOutcomes: () => [{ verification: { status: "pending" } } as never],
      },
    });

    expect(() => scheduler.evaluate(signals())).toThrow();
  });

  test("fails closed for writer delegation without a kernel executor", () => {
    const scheduler = new ExpectedValueScheduler({
      spawnThreshold: -1,
      maxParallelWorkers: 4,
      highRiskParallelWriterAllowed: true,
    });
    const decision = scheduler.evaluate(signals({
      isWriteWork: true,
      worktree: {
        baseRevision: "HEAD:abc",
        requestedPathPrefixes: ["packages/a"],
        activeLeases: [],
      },
    }));

    expect(decision.spawn).toBe(false);
    expect(decision.worktreePlan?.status).toBe("blocked_executor_unavailable");
  });
});

describe("budget reservation and cancellation contracts", () => {
  test("reserves capacity, releases cancelled work, and commits actual usage", () => {
    const ledger = new BudgetReservationLedger(budget, "task-1");
    const request = createDelegationBudgetReservationRequest({
      reservationId: "reservation-1",
      parentTaskId: "task-1",
      delegationId: "delegation-1",
      amount: { modelMicros: 70, computeSeconds: 10, wallClockSeconds: 20, humanApprovals: 0 },
    });
    expect(ledger.reserve(request).status).toBe("reserved");
    expect(() => ledger.reserve({
      ...request,
      reservationId: "reservation-2",
      childScope: "delegation-2",
      cancellation: createCancellationPropagationContract({
        rootId: "delegation-2",
        parentId: "task-1",
        reason: "parent_cancelled",
      }),
    })).toThrow();

    const cancelled = ledger.cancelForParent("task-1");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.status).toBe("cancelled");

    const second = ledger.reserve({
      ...request,
      reservationId: "reservation-2",
      childScope: "delegation-2",
      cancellation: createCancellationPropagationContract({
        rootId: "delegation-2",
        parentId: "task-1",
        reason: "parent_cancelled",
      }),
    });
    expect(ledger.commit(second.reservationId, {
      modelMicros: 40,
      computeSeconds: 5,
      wallClockSeconds: 10,
      humanApprovals: 0,
    }).status).toBe("committed");
    expect(ledger.committedConsumption().modelMicros).toBe(40);
  });
});
