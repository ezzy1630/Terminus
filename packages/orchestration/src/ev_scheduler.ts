/**
 * @terminus/orchestration — Expected-Value Subagent Scheduler.
 *
 * Per SPEC §27.1, §27.2: Subagents are spawned ONLY when expected value
 * (InformationGain + Specialization + ParallelSpeedup - TokenCost - CoordinationCost - ConflictRisk - ReviewCost)
 * exceeds the configured positive threshold.
 */
import type { DelegationContractV2, RiskClass } from "@terminus/domain";
import { delegationContractV2Schema } from "@terminus/domain";

export interface EVSchedulerConfig {
  readonly spawnThreshold: number; // default: 0.15
  readonly maxParallelWorkers: number; // default: 4
  readonly highRiskParallelWriterAllowed: boolean; // default: false
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
}

export interface EVSpawnDecision {
  readonly spawn: boolean;
  readonly role: "scout" | "implementer" | "reviewer" | "specialist" | null;
  readonly expectedValue: number;
  readonly breakdown: EVBreakdown;
  readonly reason: string;
  readonly contract: DelegationContractV2 | null;
}

export class ExpectedValueScheduler {
  constructor(private readonly config: EVSchedulerConfig = DEFAULT_EV_SCHEDULER_CONFIG) {}

  evaluate(signals: EVSchedulerSignals): EVSpawnDecision {
    // 1. Hard cap on parallel workers
    if (signals.activeWorkerCount >= this.config.maxParallelWorkers) {
      const breakdown = this.computeBreakdown(signals);
      return {
        spawn: false,
        role: null,
        expectedValue: 0,
        breakdown,
        reason: `Maximum parallel workers (${this.config.maxParallelWorkers}) reached`,
        contract: null,
      };
    }

    // 2. High/critical risk write work policy
    if (
      (signals.riskClass === "high" || signals.riskClass === "critical") &&
      signals.isWriteWork &&
      !this.config.highRiskParallelWriterAllowed
    ) {
      const breakdown = this.computeBreakdown(signals);
      return {
        spawn: false,
        role: null,
        expectedValue: 0,
        breakdown,
        reason: `Parallel speculative writers denied on ${signals.riskClass}-risk tasks`,
        contract: null,
      };
    }

    // 3. Compute EV terms
    const breakdown = this.computeBreakdown(signals);
    const ev = breakdown.netExpectedValue;

    if (ev <= this.config.spawnThreshold) {
      return {
        spawn: false,
        role: null,
        expectedValue: ev,
        breakdown,
        reason: `Expected value ${ev.toFixed(3)} does not exceed threshold ${this.config.spawnThreshold.toFixed(3)}`,
        contract: null,
      };
    }

    // 4. Select role based on signals
    let role: "scout" | "implementer" | "reviewer" | "specialist";
    if (signals.isWriteWork) {
      role = "implementer";
    } else if (signals.currentUncertainty > 0.6) {
      role = "scout";
    } else if (signals.riskClass === "high" || signals.riskClass === "critical") {
      role = "specialist";
    } else {
      role = "scout";
    }

    // 5. Generate DelegationContractV2
    const contract: DelegationContractV2 = {
      id: `delegation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      parentTaskId: signals.parentTaskId,
      role,
      objective: signals.candidateObjective,
      authorityCeiling: {
        allowedOperations: role === "scout" ? ["read", "search", "inspect"] : ["read", "search", "propose_patch"],
        allowedPaths: signals.allowedPaths ?? [],
        deniedEffects: ["execute_external_effect", "git_merge_authoritative", "deploy"],
      },
      inputHandles: signals.inputHandles ?? [],
      expectedValue: ev,
      outputSchemaVersion: "2.0",
      evidenceRequirements: ["claim_verification_receipt", "execution_trace"],
      budgetMicros: BigInt(Math.floor(Number(signals.budgetRemainingRatio * 500_000))),
      deadline: null,
      writeIsolation: role === "implementer" ? "worktree" : "read_only",
      returnRoute: `/v2/tasks/${signals.parentTaskId}/delegations/return`,
    };

    return {
      spawn: true,
      role,
      expectedValue: ev,
      breakdown,
      reason: `Expected value ${ev.toFixed(3)} exceeds threshold ${this.config.spawnThreshold.toFixed(3)}`,
      contract: delegationContractV2Schema.parse(contract) as unknown as DelegationContractV2,
    };
  }

  private computeBreakdown(signals: EVSchedulerSignals): EVBreakdown {
    const informationGain = signals.currentUncertainty * (1 - signals.likelyFileOverlap) * 0.4;
    const specializationGain = signals.separability * (signals.isWriteWork ? 0.35 : 0.25);
    const parallelSpeedup = signals.separability * (1 - signals.likelyFileOverlap) * signals.contextPressure * 0.3;

    const tokenCost = 0.15 * (1 - signals.budgetRemainingRatio) + 0.05;
    const coordinationCost = 0.1 + signals.likelyFileOverlap * 0.25;
    const conflictRisk = signals.isWriteWork ? signals.likelyFileOverlap * 0.4 : 0.0;
    const reviewCost = signals.isWriteWork ? 0.1 : 0.02;

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
    };
  }
}
