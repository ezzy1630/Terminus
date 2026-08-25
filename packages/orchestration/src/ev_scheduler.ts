/**
 * @terminus/orchestration — Expected-Value Subagent Scheduler.
 *
 * Per SPEC §27.1, §27.2: Subagents are spawned ONLY when expected value
 * (InformationGain + Specialization + ParallelSpeedup - TokenCost - CoordinationCost - ConflictRisk - ReviewCost)
 * exceeds the configured positive threshold.
 */
import type { DelegationContractV2, RiskClass } from "@terminus/domain";
import { delegationContractV2Schema, ValidationError } from "@terminus/domain";
import {
  type EVCalibrationSnapshot,
  type VerifiedDelegationOutcomeStore,
  VerifiedOutcomeCalibrator,
} from "./ev_calibration.js";
import {
  createDelegationBudgetReservationRequest,
  type BudgetReservationRequest,
} from "./delegation_budget.js";
import {
  planWorktreeDelegation,
  type ActiveWorktreePathLease,
  type WorktreeDelegationPlan,
} from "./worktree_delegation.js";

type SpawnRole = "scout" | "implementer" | "reviewer" | "specialist";

export interface EVSchedulerConfig {
  readonly spawnThreshold: number; // default: 0.15
  readonly maxParallelWorkers: number; // default: 4
  readonly highRiskParallelWriterAllowed: boolean; // default: false
  /** Loaded from durable, verified outcome storage at the composition root. */
  readonly verifiedOutcomeStore?: VerifiedDelegationOutcomeStore;
}

export const DEFAULT_EV_SCHEDULER_CONFIG: EVSchedulerConfig = {
  spawnThreshold: 0.15,
  maxParallelWorkers: 4,
  highRiskParallelWriterAllowed: false,
};

export interface EVSchedulerSignals {
  readonly separability: number; // 0..1 (how independent the subtask is)
  readonly likelyFileOverlap: number; // 0..1 (expected shared files)
  readonly isWriteWork: boolean;
  readonly currentUncertainty: number; // 0..1
  readonly contextPressure: number; // 0..1 (how full the primary context is)
  readonly riskClass: RiskClass;
  readonly budgetRemainingRatio: number; // 0..1
  readonly activeWorkerCount: number;
  readonly candidateObjective: string;
  readonly parentTaskId: string;
  readonly allowedPaths?: readonly string[];
  readonly inputHandles?: readonly string[];
  /** Stable identities issued by the persistence layer before scheduling. */
  readonly delegationId: string;
  readonly reservationId: string;
  readonly budgetMicros?: bigint;
  readonly budgetReservationAmount?: BudgetReservationRequest["amount"];
  /** Required for writer delegation; no implicit shared-checkout fallback. */
  readonly worktree?: {
    readonly baseRevision: string;
    readonly requestedPathPrefixes: readonly string[];
    readonly activeLeases: readonly ActiveWorktreePathLease[];
  };
}

export interface EVBreakdown {
  readonly informationGain: number;
  readonly specializationGain: number;
  readonly parallelSpeedup: number;
  readonly tokenCost: number;
  readonly coordinationCost: number;
  readonly conflictRisk: number;
  readonly reviewCost: number;
  readonly netExpectedValue: number;
  readonly calibration: EVCalibrationSnapshot;
}

export interface EVSpawnDecision {
  readonly spawn: boolean;
  readonly role: "scout" | "implementer" | "reviewer" | "specialist" | null;
  readonly expectedValue: number;
  readonly breakdown: EVBreakdown;
  readonly reason: string;
  readonly contract: DelegationContractV2 | null;
  readonly worktreePlan: WorktreeDelegationPlan | null;
  readonly budgetReservation: BudgetReservationRequest | null;
}

export class ExpectedValueScheduler {
  private readonly calibrator: VerifiedOutcomeCalibrator;

  constructor(
    private readonly config: EVSchedulerConfig = DEFAULT_EV_SCHEDULER_CONFIG,
    outcomeStore?: VerifiedDelegationOutcomeStore,
  ) {
    this.calibrator = new VerifiedOutcomeCalibrator(
      outcomeStore ?? config.verifiedOutcomeStore ?? null,
    );
  }

  evaluate(signals: EVSchedulerSignals): EVSpawnDecision {
    const candidateRole = this.roleFor(signals);

    // 1. Hard cap on parallel workers
    if (signals.activeWorkerCount >= this.config.maxParallelWorkers) {
      const breakdown = this.computeBreakdown(signals, candidateRole);
      return {
        spawn: false,
        role: null,
        expectedValue: 0,
        breakdown,
        reason: `Maximum parallel workers (${this.config.maxParallelWorkers}) reached`,
        contract: null,
        worktreePlan: null,
        budgetReservation: null,
      };
    }

    // 2. High/critical risk write work policy
    if (
      (signals.riskClass === "high" || signals.riskClass === "critical") &&
      signals.isWriteWork &&
      !this.config.highRiskParallelWriterAllowed
    ) {
      const breakdown = this.computeBreakdown(signals, candidateRole);
      return {
        spawn: false,
        role: null,
        expectedValue: 0,
        breakdown,
        reason: `Parallel speculative writers denied on ${signals.riskClass}-risk tasks`,
        contract: null,
        worktreePlan: null,
        budgetReservation: null,
      };
    }

    // 3. Compute EV terms
    const breakdown = this.computeBreakdown(signals, candidateRole);
    const ev = breakdown.netExpectedValue;

    if (ev <= this.config.spawnThreshold) {
      return {
        spawn: false,
        role: null,
        expectedValue: ev,
        breakdown,
        reason: `Expected value ${ev.toFixed(3)} does not exceed threshold ${this.config.spawnThreshold.toFixed(3)}`,
        contract: null,
        worktreePlan: null,
        budgetReservation: null,
      };
    }

    if (signals.delegationId.trim().length === 0 || signals.reservationId.trim().length === 0) {
      return {
        spawn: false,
        role: null,
        expectedValue: ev,
        breakdown,
        reason: "delegation and budget reservation identities must be issued before spawning",
        contract: null,
        worktreePlan: null,
        budgetReservation: null,
      };
    }

    // 4. Generate a deterministic delegation contract.
    const contract = this.buildContract(signals, candidateRole, ev);

    // 5. A writer cannot fall back to the coordinator checkout. The plan is
    // returned for the kernel boundary, but this package cannot execute it.
    if (signals.isWriteWork) {
      const worktreePlan = planWorktreeDelegation({
        contract,
        worktree: signals.worktree ?? {
          baseRevision: "",
          requestedPathPrefixes: [],
          activeLeases: [],
        },
      });
      return {
        spawn: false,
        role: null,
        expectedValue: ev,
        breakdown,
        reason: worktreePlan.blockedReason === "kernel_worktree_executor_unavailable"
          ? "writer delegation planned but kernel worktree executor is unavailable"
          : "writer delegation blocked by path-disjointness validation",
        contract: null,
        worktreePlan,
        budgetReservation: null,
      };
    }

    const budgetReservation = createDelegationBudgetReservationRequest({
      reservationId: signals.reservationId,
      parentTaskId: signals.parentTaskId,
      delegationId: contract.id,
      amount: signals.budgetReservationAmount ?? {
        modelMicros: safeNumber(contract.budgetMicros),
        computeSeconds: 0,
        wallClockSeconds: 0,
        humanApprovals: 0,
      },
    });

    return {
      spawn: true,
      role: candidateRole,
      expectedValue: ev,
      breakdown,
      reason: `Expected value ${ev.toFixed(3)} exceeds threshold ${this.config.spawnThreshold.toFixed(3)}`,
      contract,
      worktreePlan: null,
      budgetReservation,
    };
  }

  private computeBreakdown(signals: EVSchedulerSignals, role: SpawnRole): EVBreakdown {
    const calibration = this.calibrator.calibrate({
      role,
      isWriteWork: signals.isWriteWork,
      riskClass: signals.riskClass,
    });
    const empirical = calibration.source === "persisted_verified_outcomes";
    const benefitScale = calibration.expectedBenefit;
    const speedupScale = calibration.expectedParallelSpeedup;
    const informationGain = signals.currentUncertainty * (1 - signals.likelyFileOverlap) * 0.4 * benefitScale;
    const specializationGain = signals.separability * (signals.isWriteWork ? 0.35 : 0.25) * benefitScale;
    const parallelSpeedup = signals.separability * (1 - signals.likelyFileOverlap) * signals.contextPressure * 0.3 * speedupScale;

    const tokenCost = empirical
      ? calibration.expectedTokenCost
      : 0.15 * (1 - signals.budgetRemainingRatio) + 0.05;
    const coordinationCost = empirical
      ? calibration.expectedCoordinationCost
      : 0.1 + signals.likelyFileOverlap * 0.25;
    const conflictRisk = signals.isWriteWork
      ? empirical ? calibration.expectedConflictRisk : signals.likelyFileOverlap * 0.4
      : 0.0;
    const reviewCost = empirical
      ? calibration.expectedReviewCost
      : signals.isWriteWork ? 0.1 : 0.02;

    const netExpectedValue =
      informationGain +
      specializationGain +
      parallelSpeedup -
      tokenCost -
      coordinationCost -
      conflictRisk -
      reviewCost;

    return {
      informationGain,
      specializationGain,
      parallelSpeedup,
      tokenCost,
      coordinationCost,
      conflictRisk,
      reviewCost,
      netExpectedValue,
      calibration,
    };
  }

  private roleFor(signals: EVSchedulerSignals): SpawnRole {
    if (signals.isWriteWork) return "implementer";
    if (signals.currentUncertainty > 0.6) return "scout";
    if (signals.riskClass === "high" || signals.riskClass === "critical") return "specialist";
    return "scout";
  }

  private buildContract(
    signals: EVSchedulerSignals,
    role: SpawnRole,
    expectedValue: number,
  ): DelegationContractV2 {
    const requestedPaths = signals.worktree?.requestedPathPrefixes ?? signals.allowedPaths ?? [];
    const budgetMicros = signals.budgetMicros ?? BigInt(Math.floor(Number(signals.budgetRemainingRatio * 500_000)));
    if (budgetMicros < 0n) throw new ValidationError("delegation budget must be non-negative");
    const contract: DelegationContractV2 = {
      id: signals.delegationId,
      parentTaskId: signals.parentTaskId,
      role,
      objective: signals.candidateObjective,
      authorityCeiling: {
        allowedOperations: role === "scout" ? ["read", "search", "inspect"] : ["read", "search", "propose_patch"],
        allowedPaths: requestedPaths,
        deniedEffects: ["execute_external_effect", "git_merge_authoritative", "deploy"],
      },
      inputHandles: signals.inputHandles ?? [],
      expectedValue,
      outputSchemaVersion: "2.0",
      evidenceRequirements: ["claim_verification_receipt", "execution_trace"],
      budgetMicros,
      deadline: null,
      writeIsolation: role === "implementer" ? "worktree" : "read_only",
      returnRoute: `/v2/tasks/${signals.parentTaskId}/delegations/return`,
    };
    return delegationContractV2Schema.parse(contract) as unknown as DelegationContractV2;
  }
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError("delegation budget exceeds reservation precision");
  }
  return Number(value);
}
