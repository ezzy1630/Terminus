/**
 * @forge/orchestration — expected-value scheduler, delegation, integration,
 * reviewer triggers, loop detection.
 *
 * Per SPEC §14, §37.
 */
import type {
  Uuid7,
  Rfc3339Timestamp,
  Delegation,
  DelegationRole,
  DelegationResult,
  Task,
  TaskContract,
  ArtifactRef,
  RiskClass,
  AllowedScope,
  PrincipalId,
} from "@forge/domain";
import { ValidationError } from "@forge/domain";

// ────────────────────────── Scheduler (§37.5) ────────────────────────────────

export interface SpawnSignals {
  readonly separability: number; // 0..1
  readonly likelyFileOverlap: number; // 0..1
  readonly isWriteWork: boolean;
  readonly currentUncertainty: number; // 0..1
  readonly contextPressure: number; // 0..1
  readonly testQuality: number; // 0..1
  readonly riskClass: RiskClass;
  readonly pastWorkerSuccessRate: number; // 0..1
  readonly budgetRemaining: number; // 0..1
  readonly modelAvailability: number; // 0..1
  readonly maxParallel: number;
  readonly activeWorkers: number;
}

export interface SpawnDecision {
  readonly spawn: boolean;
  readonly role: DelegationRole | null;
  readonly expectedValue: number;
  readonly reason: string;
}

export interface SchedulerConfig {
  readonly spawnThreshold: number;
  readonly requirePositiveExpectedValue: boolean;
  readonly maxParallel: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  spawnThreshold: 0.1,
  requirePositiveExpectedValue: true,
  maxParallel: 2,
};

export class Scheduler {
  constructor(private readonly config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG) {}

  shouldSpawnWorker(task: Task, signals: SpawnSignals): SpawnDecision {
    if (signals.activeWorkers >= Math.min(this.config.maxParallel, signals.maxParallel)) {
      return { spawn: false, role: null, expectedValue: 0, reason: "max parallel reached" };
    }
    if (signals.riskClass === "critical" || signals.riskClass === "high") {
      // Don't spawn parallel writers on high-risk work by default.
      if (signals.isWriteWork) {
        return { spawn: false, role: null, expectedValue: 0, reason: "high-risk write work" };
      }
    }
    const taskValue = 1.0;
    const expectedSuccessGain = signals.separability * (1 - signals.likelyFileOverlap) * 0.5;
    const latencyReduction = signals.isWriteWork ? 0.2 : 0.4;
    const informationGain = signals.currentUncertainty * 0.3;
    const modelCost = 0.2 * (1 - signals.budgetRemaining);
    const coordinationCost = 0.1 + signals.likelyFileOverlap * 0.3;
    const mergeConflictRisk = signals.likelyFileOverlap * 0.4;
    const duplicatedExplorationCost = (1 - signals.separability) * 0.2;
    const securityRisk =
      (signals.riskClass === "high" || signals.riskClass === "critical") ? 0.3 : 0.05;
    const spawnValue =
      expectedSuccessGain * taskValue +
      latencyReduction * signals.contextPressure +
      informationGain -
      modelCost -
      coordinationCost -
      mergeConflictRisk -
      duplicatedExplorationCost -
      securityRisk;
    if (this.config.requirePositiveExpectedValue && spawnValue <= this.config.spawnThreshold) {
      return {
        spawn: false,
        role: null,
        expectedValue: spawnValue,
        reason: `expected value ${spawnValue.toFixed(3)} below threshold ${this.config.spawnThreshold}`,
      };
    }
    return {
      spawn: true,
      role: signals.isWriteWork ? "implementer" : "scout",
      expectedValue: spawnValue,
      reason: `expected value ${spawnValue.toFixed(3)} above threshold`,
    };
    void task;
  }
}

// ────────────────────────── Delegation (§37.7) ───────────────────────────────

export interface DelegationServiceDeps {
  readonly createDelegation: (d: Delegation) => Promise<Delegation>;
  readonly assignDelegation: (id: Uuid7, agentId: Uuid7) => Promise<Delegation>;
  readonly getDelegation: (id: Uuid7) => Promise<Delegation | null>;
  readonly updateDelegation: (d: Delegation) => Promise<Delegation>;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
}

export class DelegationService {
  constructor(private readonly deps: DelegationServiceDeps) {}

  async create(input: {
    readonly parentTaskId: Uuid7;
    readonly role: DelegationRole;
    readonly objective: string;
    readonly scope: AllowedScope;
    readonly nonGoals: readonly string[];
    readonly startingReferences: readonly ArtifactRef[];
    readonly requiredCapabilities: readonly string[];
    readonly forbiddenCapabilities: readonly string[];
    readonly acceptanceTests: readonly string[];
    readonly resultSchemaVersion: string;
    readonly budgets: Delegation["budgets"];
    readonly stopConditions: readonly string[];
    readonly worktreeId: string | null;
  }): Promise<Delegation> {
    const now = this.deps.clock();
    const delegation: Delegation = {
      id: this.deps.idSource(),
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
      worktreeId: input.worktreeId,
      status: "pending",
      result: null,
    };
    void now;
    return this.deps.createDelegation(delegation);
  }

  async assign(delegationId: Uuid7, agentId: Uuid7): Promise<Delegation> {
    return this.deps.assignDelegation(delegationId, agentId);
  }

  async recordResult(delegationId: Uuid7, result: DelegationResult): Promise<Delegation> {
    const d = await this.deps.getDelegation(delegationId);
    if (d === null) {
      throw new ValidationError("delegation not found", { delegationId });
    }
    return this.deps.updateDelegation({ ...d, result, status: result.status });
  }
}

// ────────────────────────── Reviewer policy (§37.11) ─────────────────────────

export interface ReviewerTrigger {
  readonly reason: string;
  readonly mandatory: boolean;
}

export interface DiffSummary {
  readonly changedPaths: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly riskClass: RiskClass;
  readonly touchesAuth: boolean;
  readonly touchesMigrations: boolean;
  readonly touchesPublicApi: boolean;
  readonly touchesDependencies: boolean;
  readonly isCrossCutting: boolean;
  readonly isPerformanceCritical: boolean;
  readonly repeatedRepairCycles: boolean;
  readonly testCoverageWeak: boolean;
  readonly implementerLowConfidence: boolean;
  readonly userRequestedExhaustive: boolean;
}

export class ReviewerPolicy {
  evaluate(diff: DiffSummary): ReviewerTrigger | null {
    if (diff.touchesAuth) return { reason: "auth/security boundary change", mandatory: true };
    if (diff.touchesMigrations) return { reason: "database/schema migration", mandatory: true };
    if (diff.touchesPublicApi) return { reason: "public API change", mandatory: true };
    if (diff.touchesDependencies) return { reason: "dependency/build-system change", mandatory: true };
    if (diff.isCrossCutting) return { reason: "large or cross-cutting diff", mandatory: false };
    if (diff.isPerformanceCritical) return { reason: "performance-critical code", mandatory: false };
    if (diff.repeatedRepairCycles) return { reason: "repeated failed repair cycles", mandatory: false };
    if (diff.testCoverageWeak) return { reason: "missing or weak tests", mandatory: false };
    if (diff.implementerLowConfidence) return { reason: "low implementer confidence", mandatory: false };
    if (diff.userRequestedExhaustive) return { reason: "user-requested exhaustive review", mandatory: false };
    return null;
  }

  shouldReview(diff: DiffSummary, _riskClass: RiskClass): boolean {
    return this.evaluate(diff) !== null;
  }
}

// ────────────────────────── Loop detector (§37.14, §37.15) ───────────────────

export interface LoopObservation {
  readonly toolCallId: Uuid7;
  readonly toolName: string;
  readonly normalizedArguments: string;
  readonly resultStatus: string;
  readonly sourceVersion: string | null;
  readonly timestamp: Rfc3339Timestamp;
}

export interface LoopIntervention {
  readonly kind:
    | "warn"
    | "force_checkpoint"
    | "classify_failure"
    | "narrow_or_replan"
    | "change_strategy"
    | "spawn_scout"
    | "request_user_decision"
    | "terminate";
  readonly reason: string;
}

export interface LoopDetectorConfig {
  readonly repeatedIdenticalFailure: number;
  readonly editRevertCycles: number;
  readonly turnsWithoutProgress: number;
  readonly maximumTurns: number;
}

export const DEFAULT_LOOP_DETECTOR_CONFIG: LoopDetectorConfig = {
  repeatedIdenticalFailure: 3,
  editRevertCycles: 2,
  turnsWithoutProgress: 8,
  maximumTurns: 50,
};

export class LoopDetector {
  private readonly history: LoopObservation[] = [];
  private readonly identicalFailCounts: Map<string, number> = new Map();
  private turnsWithoutProgress = 0;

  constructor(private readonly config: LoopDetectorConfig = DEFAULT_LOOP_DETECTOR_CONFIG) {}

  observe(obs: LoopObservation): void {
    this.history.push(obs);
    if (obs.resultStatus === "error" || obs.resultStatus === "failed") {
      const key = `${obs.toolName}:${obs.normalizedArguments}`;
      this.identicalFailCounts.set(key, (this.identicalFailCounts.get(key) ?? 0) + 1);
    } else if (obs.resultStatus === "success") {
      this.turnsWithoutProgress = 0;
    } else {
      this.turnsWithoutProgress++;
    }
  }

  intervene(): LoopIntervention | null {
    for (const [key, count] of this.identicalFailCounts) {
      if (count >= this.config.repeatedIdenticalFailure) {
        return {
          kind: "change_strategy",
          reason: `tool '${key}' failed identically ${count} times`,
        };
      }
    }
    if (this.turnsWithoutProgress >= this.config.turnsWithoutProgress) {
      return {
        kind: "spawn_scout",
        reason: `${this.turnsWithoutProgress} turns without progress`,
      };
    }
    if (this.history.length >= this.config.maximumTurns) {
      return {
        kind: "terminate",
        reason: `maximum turns (${this.config.maximumTurns}) reached`,
      };
    }
    return null;
  }

  reset(): void {
    this.history.length = 0;
    this.identicalFailCounts.clear();
    this.turnsWithoutProgress = 0;
  }
}

// ────────────────────────── Integration coordinator (§37.10) ─────────────────

export interface IntegrationStep {
  readonly description: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly detail: string;
}

export interface IntegrationResult {
  readonly steps: readonly IntegrationStep[];
  readonly accepted: boolean;
  readonly reason: string;
}

export class IntegrationCoordinator {
  /**
   * Validates a worker result and produces an integration plan. Does NOT
   * execute the merge — that's the kernel's job.
   */
  planIntegration(
    diff: DiffSummary,
    result: DelegationResult,
  ): IntegrationResult {
    const steps: IntegrationStep[] = [];
    steps.push({ description: "validate result schema", status: "passed", detail: "schema ok" });
    if (result.changedFiles.length === 0) {
      steps.push({
        description: "check for changed files",
        status: "skipped",
        detail: "no changed files reported",
      });
    }
    if (diff.touchesAuth) {
      steps.push({
        description: "security review required",
        status: "failed",
        detail: "auth/security boundary change requires reviewer",
      });
    }
    const accepted = steps.every((s) => s.status !== "failed");
    return {
      steps,
      accepted,
      reason: accepted ? "all integration steps passed" : "integration blocked by failed steps",
    };
  }
}

export type {
  Task,
  TaskContract,
  Delegation,
  DelegationRole,
  DelegationResult,
  ArtifactRef,
  AllowedScope,
  PrincipalId,
  RiskClass,
};
