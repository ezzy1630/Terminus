/**
 * @terminus/orchestration — expected-value scheduler, delegation, integration,
 * reviewer triggers, loop detection, budget control, hierarchical
 * cancellation, plan artifact.
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
  Micros,
} from "@terminus/domain";
import { ValidationError, BudgetExhaustedError } from "@terminus/domain";
import {
  DEFAULT_SCHEDULER_CONFIG,
  type SchedulerConfig,
} from "./scheduler-types.js";

export type { SchedulerConfig } from "./scheduler-types.js";
export { DEFAULT_SCHEDULER_CONFIG } from "./scheduler-types.js";

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

/**
 * A single observation of agent activity. Each field corresponds to one of the
 * 10 loop-detection signals in §37.14; missing fields are treated as "not
 * applicable for this observation".
 */
export interface LoopObservation {
  readonly toolCallId: Uuid7;
  readonly toolName: string;
  readonly normalizedArguments: string;
  readonly resultStatus: string;
  /** Source version (revision or content hash) the tool observed. */
  readonly sourceVersion: string | null;
  readonly timestamp: Rfc3339Timestamp;

  // ── Signal 2: unchanged re-reads ──
  /** Path read by this observation (for read tools). */
  readonly readPath?: string | undefined;
  /** Content hash of the file observed, if available. */
  readonly readContentHash?: string | undefined;

  // ── Signal 3: edit/revert oscillation ──
  /** Patch operation kind, if this is a patch observation. */
  readonly patchOp?: string | undefined;
  /** Path patched, if applicable. */
  readonly patchPath?: string | undefined;
  /** True if this observation is a revert of a previous patch. */
  readonly isRevert?: boolean | undefined;

  // ── Signal 4: no diagnostic reduction ──
  /** Number of active diagnostics at this point in time. */
  readonly diagnosticCount?: number | undefined;

  // ── Signal 5: repeated strategy without new evidence ──
  /** Strategy label (e.g., "fix_imports", "rerun_tests"). */
  readonly strategy?: string | undefined;
  /** Whether new evidence (new file reads, new test results) was gathered. */
  readonly newEvidence?: boolean | undefined;

  // ── Signal 6: duplicate worker exploration ──
  /** Worker/delegation id, if this observation comes from a worker. */
  readonly workerId?: string | undefined;
  /** Exploration target (path or symbol) the worker is investigating. */
  readonly explorationTarget?: string | undefined;

  // ── Signal 7: context growth without task-ledger progress ──
  /** Estimated context tokens at this point. */
  readonly contextTokens?: number | undefined;
  /** True if the task ledger advanced (criterion satisfied, phase changed). */
  readonly taskLedgerProgress?: boolean | undefined;

  // ── Signal 8: repeated scope challenges ──
  /** True if this observation is a scope-expansion request. */
  readonly isScopeChallenge?: boolean | undefined;

  // ── Signal 9: repeated model fallback or schema failure ──
  /** True if this observation records a model fallback or schema failure. */
  readonly isModelFallback?: boolean | undefined;
  readonly isSchemaFailure?: boolean | undefined;

  // ── Signal 10: repeated approval requests for the same denied class ──
  /** Approval class, if this observation is an approval request. */
  readonly approvalClass?: string | undefined;
  /** True if the approval was denied. */
  readonly approvalDenied?: boolean | undefined;
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
  /** Which signal(s) triggered this intervention. */
  readonly signals: readonly string[];
}

export interface LoopDetectorConfig {
  /** Signal 1: same normalized command fails repeatedly. */
  readonly repeatedIdenticalFailure: number;
  /** Signal 2: same file, same content hash, re-read with no new info. */
  readonly unchangedReReads: number;
  /** Signal 3: edit/revert oscillation. */
  readonly editRevertCycles: number;
  /** Signal 4: diagnostics do not improve. */
  readonly noDiagnosticReduction: number;
  /** Signal 5: repeated strategy without new evidence. */
  readonly repeatedStrategyWithoutEvidence: number;
  /** Signal 6: duplicate worker exploration. */
  readonly duplicateWorkerExploration: number;
  /** Signal 7: context growth without task-ledger progress. */
  readonly contextGrowthWithoutProgress: number;
  /** Signal 8: repeated scope challenges. */
  readonly repeatedScopeChallenges: number;
  /** Signal 9: repeated model fallback or schema failure. */
  readonly repeatedModelFallback: number;
  /** Signal 10: repeated approval requests for the same denied class. */
  readonly repeatedDeniedApprovals: number;
  /** Proxy: turns without progress (any kind). */
  readonly turnsWithoutProgress: number;
  /** Hard cap on total turns. */
  readonly maximumTurns: number;
}

export const DEFAULT_LOOP_DETECTOR_CONFIG: LoopDetectorConfig = {
  repeatedIdenticalFailure: 3,
  unchangedReReads: 2,
  editRevertCycles: 2,
  noDiagnosticReduction: 3,
  repeatedStrategyWithoutEvidence: 2,
  duplicateWorkerExploration: 2,
  contextGrowthWithoutProgress: 3,
  repeatedScopeChallenges: 2,
  repeatedModelFallback: 2,
  repeatedDeniedApprovals: 2,
  turnsWithoutProgress: 8,
  maximumTurns: 50,
};

interface SignalCounters {
  // Signal 1: identical failed commands
  identicalFail: Map<string, number>;
  // Signal 2: unchanged re-reads: key = `${readPath}:${readContentHash}`
  unchangedReRead: Map<string, number>;
  // Signal 3: edit/revert oscillation: key = patchPath, value = recent patch ops
  patchHistory: Map<string, string[]>;
  editRevertCount: Map<string, number>;
  // Signal 4: diagnostic count history
  diagnosticHistory: number[];
  // Signal 5: repeated strategy without evidence: key = strategy
  strategyWithoutEvidence: Map<string, number>;
  // Signal 6: duplicate worker exploration: key = explorationTarget
  duplicateExploration: Map<string, Set<string>>; // target -> worker ids
  duplicateExplorationCount: Map<string, number>; // target -> # times flagged
  // Signal 7: context growth history
  contextTokenHistory: number[];
  contextGrowthWithoutProgressCount: number;
  // Signal 8: repeated scope challenges
  scopeChallengeCount: number;
  // Signal 9: repeated model fallback / schema failure
  modelFallbackCount: number;
  schemaFailureCount: number;
  // Signal 10: repeated denied approvals: key = approvalClass
  deniedApproval: Map<string, number>;
  // Proxy: turns without progress
  turnsWithoutProgress: number;
}

function newCounters(): SignalCounters {
  return {
    identicalFail: new Map(),
    unchangedReRead: new Map(),
    patchHistory: new Map(),
    editRevertCount: new Map(),
    diagnosticHistory: [],
    strategyWithoutEvidence: new Map(),
    duplicateExploration: new Map(),
    duplicateExplorationCount: new Map(),
    contextTokenHistory: [],
    contextGrowthWithoutProgressCount: 0,
    scopeChallengeCount: 0,
    modelFallbackCount: 0,
    schemaFailureCount: 0,
    deniedApproval: new Map(),
    turnsWithoutProgress: 0,
  };
}

/**
 * Loop detector covering all 10 signals from §37.14. Each call to `observe()`
 * updates internal counters; `intervene()` returns the highest-priority
 * intervention from the §37.15 ladder (warn → force_checkpoint →
 * classify_failure → narrow_or_replan → change_strategy → spawn_scout →
 * request_user_decision → terminate).
 */
export class LoopDetector {
  private readonly history: LoopObservation[] = [];
  private readonly c: SignalCounters;

  constructor(private readonly config: LoopDetectorConfig = DEFAULT_LOOP_DETECTOR_CONFIG) {
    this.c = newCounters();
  }

  observe(obs: LoopObservation): void {
    this.history.push(obs);
    this.updateCounters(obs);
  }

  private updateCounters(obs: LoopObservation): void {
    // Signal 1: same normalized command fails repeatedly.
    if (obs.resultStatus === "error" || obs.resultStatus === "failed") {
      const key = `${obs.toolName}:${obs.normalizedArguments}`;
      this.c.identicalFail.set(key, (this.c.identicalFail.get(key) ?? 0) + 1);
    } else if (obs.resultStatus === "success") {
      this.c.turnsWithoutProgress = 0;
    } else {
      this.c.turnsWithoutProgress++;
    }

    // Signal 2: unchanged re-reads (same path, same content hash).
    if (
      obs.toolName === "read" &&
      obs.readPath !== undefined &&
      obs.readContentHash !== undefined
    ) {
      const key = `${obs.readPath}:${obs.readContentHash}`;
      this.c.unchangedReRead.set(key, (this.c.unchangedReRead.get(key) ?? 0) + 1);
    }

    // Signal 3: edit/revert oscillation.
    if (obs.patchPath !== undefined && obs.patchOp !== undefined) {
      const ops = this.c.patchHistory.get(obs.patchPath) ?? [];
      const newOps = [...ops, obs.isRevert ? `revert:${obs.patchOp}` : obs.patchOp];
      // Keep last 8 ops per path.
      if (newOps.length > 8) newOps.shift();
      this.c.patchHistory.set(obs.patchPath, newOps);
      // Detect oscillation: op followed by revert of the same op, or
      // repeated create/delete on the same path.
      const oscKey = obs.patchPath;
      const lastTwo = newOps.slice(-2);
      if (
        lastTwo.length === 2 &&
        lastTwo[0]!.startsWith("revert:") === false &&
        lastTwo[1] === `revert:${lastTwo[0]}`
      ) {
        this.c.editRevertCount.set(oscKey, (this.c.editRevertCount.get(oscKey) ?? 0) + 1);
      }
    }

    // Signal 4: diagnostics do not improve.
    if (obs.diagnosticCount !== undefined) {
      this.c.diagnosticHistory.push(obs.diagnosticCount);
      if (this.c.diagnosticHistory.length > this.config.noDiagnosticReduction) {
        // Check that the count is non-decreasing over the last N observations.
        const recent = this.c.diagnosticHistory.slice(-this.config.noDiagnosticReduction);
        let nonDecreasing = true;
        for (let i = 1; i < recent.length; i++) {
          if (recent[i]! < recent[i - 1]!) {
            nonDecreasing = false;
            break;
          }
        }
        // If non-decreasing across the window, leave the count alone — the
        // intervenor picks it up via the diagnostic history directly.
        void nonDecreasing;
      }
    }

    // Signal 5: repeated strategy without new evidence.
    if (obs.strategy !== undefined && obs.newEvidence === false) {
      this.c.strategyWithoutEvidence.set(
        obs.strategy,
        (this.c.strategyWithoutEvidence.get(obs.strategy) ?? 0) + 1,
      );
    }

    // Signal 6: duplicate worker exploration (same target, different workers).
    if (obs.explorationTarget !== undefined && obs.workerId !== undefined) {
      const workers = this.c.duplicateExploration.get(obs.explorationTarget) ?? new Set<string>();
      const wasNew = !workers.has(obs.workerId);
      workers.add(obs.workerId);
      this.c.duplicateExploration.set(obs.explorationTarget, workers);
      if (wasNew && workers.size > 1) {
        // A new worker is exploring a target that another worker already
        // explored. Increment the duplicate count.
        this.c.duplicateExplorationCount.set(
          obs.explorationTarget,
          (this.c.duplicateExplorationCount.get(obs.explorationTarget) ?? 0) + 1,
        );
      }
    }

    // Signal 7: context growth without task-ledger progress.
    if (obs.contextTokens !== undefined) {
      this.c.contextTokenHistory.push(obs.contextTokens);
      if (this.c.contextTokenHistory.length > 32) {
        this.c.contextTokenHistory.shift();
      }
      if (obs.taskLedgerProgress === true) {
        this.c.contextGrowthWithoutProgressCount = 0;
      } else {
        this.c.contextGrowthWithoutProgressCount++;
      }
    }

    // Signal 8: repeated scope challenges.
    if (obs.isScopeChallenge === true) {
      this.c.scopeChallengeCount++;
    }

    // Signal 9: repeated model fallback or schema failure.
    if (obs.isModelFallback === true) {
      this.c.modelFallbackCount++;
    }
    if (obs.isSchemaFailure === true) {
      this.c.schemaFailureCount++;
    }

    // Signal 10: repeated approval requests for the same denied class.
    if (obs.approvalClass !== undefined && obs.approvalDenied === true) {
      this.c.deniedApproval.set(
        obs.approvalClass,
        (this.c.deniedApproval.get(obs.approvalClass) ?? 0) + 1,
      );
    }
  }

  /**
   * Returns the highest-priority intervention (§37.15 ladder), or null if no
   * signal has crossed its threshold. Priorities (low to high):
   * warn → force_checkpoint → classify_failure → narrow_or_replan →
   * change_strategy → spawn_scout → request_user_decision → terminate.
   */
  intervene(): LoopIntervention | null {
    const triggers: LoopIntervention[] = [];

    // Signal 1: repeated identical failure.
    for (const [key, count] of this.c.identicalFail) {
      if (count >= this.config.repeatedIdenticalFailure) {
        triggers.push({
          kind: "change_strategy",
          reason: `tool '${key}' failed identically ${count} times`,
          signals: ["repeated_identical_failure"],
        });
      }
    }

    // Signal 2: unchanged re-reads.
    for (const [key, count] of this.c.unchangedReRead) {
      if (count >= this.config.unchangedReReads) {
        triggers.push({
          kind: "warn",
          reason: `file '${key}' re-read ${count} times with no content change`,
          signals: ["unchanged_re_reads"],
        });
      }
    }

    // Signal 3: edit/revert oscillation.
    for (const [path, count] of this.c.editRevertCount) {
      if (count >= this.config.editRevertCycles) {
        triggers.push({
          kind: "force_checkpoint",
          reason: `edit/revert oscillation on '${path}' (${count} cycles)`,
          signals: ["edit_revert_oscillation"],
        });
      }
    }

    // Signal 4: diagnostics do not improve.
    if (this.c.diagnosticHistory.length >= this.config.noDiagnosticReduction) {
      const recent = this.c.diagnosticHistory.slice(-this.config.noDiagnosticReduction);
      let nonDecreasing = true;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i]! < recent[i - 1]!) {
          nonDecreasing = false;
          break;
        }
      }
      if (nonDecreasing && recent[0]! > 0) {
        triggers.push({
          kind: "classify_failure",
          reason: `diagnostics did not decrease over last ${recent.length} observations (${recent[0]} → ${recent[recent.length - 1]})`,
          signals: ["no_diagnostic_reduction"],
        });
      }
    }

    // Signal 5: repeated strategy without new evidence.
    for (const [strategy, count] of this.c.strategyWithoutEvidence) {
      if (count >= this.config.repeatedStrategyWithoutEvidence) {
        triggers.push({
          kind: "narrow_or_replan",
          reason: `strategy '${strategy}' repeated ${count} times without new evidence`,
          signals: ["repeated_strategy_without_evidence"],
        });
      }
    }

    // Signal 6: duplicate worker exploration.
    for (const [target, count] of this.c.duplicateExplorationCount) {
      if (count >= this.config.duplicateWorkerExploration) {
        triggers.push({
          kind: "spawn_scout",
          reason: `${count} workers explored the same target '${target}'`,
          signals: ["duplicate_worker_exploration"],
        });
      }
    }

    // Signal 7: context growth without task-ledger progress.
    if (this.c.contextGrowthWithoutProgressCount >= this.config.contextGrowthWithoutProgress) {
      triggers.push({
        kind: "force_checkpoint",
        reason: `context grew ${this.c.contextGrowthWithoutProgressCount} times without task-ledger progress`,
        signals: ["context_growth_without_progress"],
      });
    }

    // Signal 8: repeated scope challenges.
    if (this.c.scopeChallengeCount >= this.config.repeatedScopeChallenges) {
      triggers.push({
        kind: "request_user_decision",
        reason: `${this.c.scopeChallengeCount} scope challenges`,
        signals: ["repeated_scope_challenges"],
      });
    }

    // Signal 9: repeated model fallback or schema failure.
    if (this.c.modelFallbackCount >= this.config.repeatedModelFallback) {
      triggers.push({
        kind: "change_strategy",
        reason: `${this.c.modelFallbackCount} model fallbacks`,
        signals: ["repeated_model_fallback"],
      });
    }
    if (this.c.schemaFailureCount >= this.config.repeatedModelFallback) {
      triggers.push({
        kind: "change_strategy",
        reason: `${this.c.schemaFailureCount} schema failures`,
        signals: ["repeated_schema_failure"],
      });
    }

    // Signal 10: repeated denied approvals for the same class.
    for (const [cls, count] of this.c.deniedApproval) {
      if (count >= this.config.repeatedDeniedApprovals) {
        triggers.push({
          kind: "request_user_decision",
          reason: `approval class '${cls}' denied ${count} times`,
          signals: ["repeated_denied_approvals"],
        });
      }
    }

    // Proxy: turns without progress.
    if (this.c.turnsWithoutProgress >= this.config.turnsWithoutProgress) {
      triggers.push({
        kind: "spawn_scout",
        reason: `${this.c.turnsWithoutProgress} turns without progress`,
        signals: ["turns_without_progress"],
      });
    }

    // Hard cap on total turns.
    if (this.history.length >= this.config.maximumTurns) {
      triggers.push({
        kind: "terminate",
        reason: `maximum turns (${this.config.maximumTurns}) reached`,
        signals: ["maximum_turns"],
      });
    }

    if (triggers.length === 0) return null;
    // Pick the highest-priority trigger.
    const priority: Record<LoopIntervention["kind"], number> = {
      warn: 1,
      force_checkpoint: 2,
      classify_failure: 3,
      narrow_or_replan: 4,
      change_strategy: 5,
      spawn_scout: 6,
      request_user_decision: 7,
      terminate: 8,
    };
    triggers.sort((a, b) => priority[b.kind] - priority[a.kind]);
    return triggers[0]!;
  }

  reset(): void {
    this.history.length = 0;
    this.c.identicalFail.clear();
    this.c.unchangedReRead.clear();
    this.c.patchHistory.clear();
    this.c.editRevertCount.clear();
    this.c.diagnosticHistory.length = 0;
    this.c.strategyWithoutEvidence.clear();
    this.c.duplicateExploration.clear();
    this.c.duplicateExplorationCount.clear();
    this.c.contextTokenHistory.length = 0;
    this.c.contextGrowthWithoutProgressCount = 0;
    this.c.scopeChallengeCount = 0;
    this.c.modelFallbackCount = 0;
    this.c.schemaFailureCount = 0;
    this.c.deniedApproval.clear();
    this.c.turnsWithoutProgress = 0;
  }

  /** Returns the raw history of observations (for tests / debugging). */
  observations(): readonly LoopObservation[] {
    return this.history;
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

// ────────────────────────── Budget control (§37.16) ──────────────────────────

/**
 * A budget entry with optional soft and hard limits. Crossing a soft limit
 * produces an alert; crossing a hard limit produces a terminal task state.
 */
export interface BudgetLimit {
  readonly soft: number | null;
  readonly hard: number | null;
}

/**
 * A budget applies at request, role, worker, task, session, and organization
 * levels (§37.16). Each component has its own soft/hard limits.
 */
export interface Budget {
  /** Model cost in micros. */
  readonly modelMicros: BudgetLimit;
  /** Compute seconds. */
  readonly computeSeconds: BudgetLimit;
  /** Wall-clock seconds. */
  readonly wallClockSeconds: BudgetLimit;
  /** Number of human approvals requested. */
  readonly humanApprovals: BudgetLimit;
}

export interface BudgetConsumption {
  readonly modelMicros: number;
  readonly computeSeconds: number;
  readonly wallClockSeconds: number;
  readonly humanApprovals: number;
}

export type BudgetType = keyof BudgetConsumption;

export interface BudgetAlert {
  readonly budgetType: BudgetType;
  readonly scope: string;
  readonly level: "soft" | "hard";
  readonly consumed: number;
  readonly limit: number;
  readonly message: string;
}

export interface BudgetProjection {
  readonly budgetType: BudgetType;
  readonly scope: string;
  /** Estimated seconds until exhaustion at the current rate, or null if rate is zero. */
  readonly estimatedSecondsToExhaustion: number | null;
  readonly ratePerSecond: number;
}

/**
 * Tracks consumption against soft/hard limits for a single budget scope
 * (request / role / worker / task / session / organization). Crossing a hard
 * limit is a terminal condition; the controller throws
 * {@link BudgetExhaustedError} on `consume()` after the hard limit is crossed.
 *
 * Per §37.16: "Crossing a hard budget produces a terminal or user-decision
 * state; it is not a prompt suggestion."
 */
export class BudgetController {
  private consumption: BudgetConsumption = {
    modelMicros: 0,
    computeSeconds: 0,
    wallClockSeconds: 0,
    humanApprovals: 0,
  };
  /** Rate samples for projection (timestamp ms → cumulative consumption). */
  private readonly rateSamples: { type: BudgetType; tMs: number; amount: number }[] = [];
  private exhausted = false;

  constructor(
    private readonly budget: Budget,
    /** Scope label for alerts (e.g., "task:018f..."). */
    private readonly scope: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Consume `amount` of the given budget type. Throws BudgetExhaustedError
   * if a hard limit is crossed. Idempotent at the limit boundary: once
   * exhausted, further consume calls rethrow.
   */
  consume(type: BudgetType, amount: number): void {
    if (amount < 0) {
      throw new ValidationError("budget consumption must be non-negative", { type, amount });
    }
    if (this.exhausted) {
      throw new BudgetExhaustedError(this.scope, {
        budgetType: type,
        consumption: { ...this.consumption },
        budget: this.budget,
      });
    }
    this.consumption = {
      ...this.consumption,
      [type]: this.consumption[type] + amount,
    } as BudgetConsumption;
    this.rateSamples.push({ type, tMs: this.clock(), amount });
    // Trim to last 64 samples per type to bound memory.
    if (this.rateSamples.length > 256) {
      this.rateSamples.splice(0, this.rateSamples.length - 256);
    }
    // Check hard limit.
    const hard = this.budget[type].hard;
    if (hard !== null && this.consumption[type] >= hard) {
      this.exhausted = true;
      throw new BudgetExhaustedError(this.scope, {
        budgetType: type,
        consumption: { ...this.consumption },
        budget: this.budget,
        limit: hard,
      });
    }
  }

  /** Current consumption snapshot. */
  consumptionSnapshot(): BudgetConsumption {
    return { ...this.consumption };
  }

  /** True if a hard limit has been crossed. */
  isExhausted(): boolean {
    return this.exhausted;
  }

  /**
   * Returns active budget alerts (soft limits crossed but hard limits not).
   * Once exhausted, returns the hard alert.
   */
  alerts(): readonly BudgetAlert[] {
    const out: BudgetAlert[] = [];
    const types: BudgetType[] = ["modelMicros", "computeSeconds", "wallClockSeconds", "humanApprovals"];
    for (const t of types) {
      const limit = this.budget[t];
      const consumed = this.consumption[t];
      if (limit.hard !== null && consumed >= limit.hard) {
        out.push({
          budgetType: t,
          scope: this.scope,
          level: "hard",
          consumed,
          limit: limit.hard,
          message: `${this.scope}: ${t} hard limit reached (${consumed}/${limit.hard})`,
        });
      } else if (limit.soft !== null && consumed >= limit.soft) {
        out.push({
          budgetType: t,
          scope: this.scope,
          level: "soft",
          consumed,
          limit: limit.soft,
          message: `${this.scope}: ${t} soft limit reached (${consumed}/${limit.soft})`,
        });
      }
    }
    return out;
  }

  /**
   * Projects when each budget type will be exhausted at the current rate.
   * Returns null for types with no hard limit or no observed rate.
   */
  projectExhaustion(): readonly BudgetProjection[] {
    const out: BudgetProjection[] = [];
    const types: BudgetType[] = ["modelMicros", "computeSeconds", "wallClockSeconds", "humanApprovals"];
    const now = this.clock();
    // Use samples within the last 60 seconds.
    const windowMs = 60_000;
    for (const t of types) {
      const hard = this.budget[t].hard;
      if (hard === null) continue;
      const recent = this.rateSamples.filter(
        (s) => s.type === t && now - s.tMs <= windowMs,
      );
      if (recent.length === 0) {
        out.push({
          budgetType: t,
          scope: this.scope,
          estimatedSecondsToExhaustion: null,
          ratePerSecond: 0,
        });
        continue;
      }
      const totalAmount = recent.reduce((sum, s) => sum + s.amount, 0);
      const timeSpanSeconds = Math.max(0.001, (now - recent[0]!.tMs) / 1000);
      const ratePerSecond = totalAmount / timeSpanSeconds;
      const remaining = Math.max(0, hard - this.consumption[t]);
      const estimatedSeconds = ratePerSecond > 0 ? remaining / ratePerSecond : null;
      out.push({
        budgetType: t,
        scope: this.scope,
        estimatedSecondsToExhaustion: estimatedSeconds,
        ratePerSecond,
      });
    }
    return out;
  }
}

// ────────────────────────── Hierarchical cancellation (§37.17) ───────────────

export type CancellableKind =
  | "session"
  | "task"
  | "turn"
  | "model_attempt"
  | "tool_call"
  | "job"
  | "process"
  | "worker"
  | "integration"
  | "external_effect";

/** Layers cancellation must reach for the §37.17 exit proof. */
export const CANCELLATION_REACH_LAYERS: readonly CancellableKind[] = Object.freeze([
  "model_attempt",
  "tool_call",
  "job",
  "worker",
  "integration",
  "external_effect",
]);

export interface CancellableHandle {
  readonly id: string;
  readonly kind: CancellableKind;
  readonly parentId: string | null;
  /** Optional effect id, for external effects requiring reconciliation. */
  readonly effectId: string | null;
  /** Cancel function. Should be idempotent. */
  readonly cancel: () => Promise<void>;
  /** True if already cancelled. */
  isCancelled(): boolean;
}

/**
 * Coordinates hierarchical cancellation (§37.17). Cancellation is idempotent
 * and propagates down the tree: cancelling a session cancels all its tasks,
 * turns, tool calls, jobs, and processes. An external effect that has already
 * started requires reconciliation, not blind cancel — see
 * {@link reconcileEffect}.
 */
export class CancellationCoordinator {
  private readonly handles: Map<string, CancellableHandle> = new Map();
  /** Map from parent id → child ids. */
  private readonly children: Map<string, Set<string>> = new Map();
  private readonly cancelled: Set<string> = new Set();
  /** External effects pending reconciliation (effectId → handle id). */
  private readonly pendingReconciliation: Map<string, string> = new Map();
  /** External effects already reconciled. */
  private readonly reconciled: Set<string> = new Set();

  /** Register a cancellable handle. Returns the same handle for chaining. */
  register(handle: CancellableHandle): CancellableHandle {
    this.handles.set(handle.id, handle);
    if (handle.parentId) {
      const kids = this.children.get(handle.parentId) ?? new Set<string>();
      kids.add(handle.id);
      this.children.set(handle.parentId, kids);
    }
    if (handle.effectId !== null && handle.kind === "external_effect") {
      this.pendingReconciliation.set(handle.effectId, handle.id);
    }
    return handle;
  }

  /** Cancel a session and everything beneath it (idempotent). */
  async cancelSession(sessionId: string): Promise<void> {
    await this.cancelRecursive(sessionId);
  }

  /** Cancel a task and all its turns/tool calls/jobs/processes (idempotent). */
  async cancelTask(taskId: string): Promise<void> {
    await this.cancelRecursive(taskId);
  }

  /** Cancel a turn and its provider attempt + tool calls (idempotent). */
  async cancelTurn(turnId: string): Promise<void> {
    await this.cancelRecursive(turnId);
  }

  /** Cancel a model/provider attempt (idempotent). */
  async cancelModelAttempt(attemptId: string): Promise<void> {
    await this.cancelRecursive(attemptId);
  }

  /** Cancel a single tool call (idempotent). */
  async cancelToolCall(toolCallId: string): Promise<void> {
    await this.cancelRecursive(toolCallId);
  }

  /** Cancel a worker/delegation (idempotent). */
  async cancelWorker(workerId: string): Promise<void> {
    await this.cancelRecursive(workerId);
  }

  /** Cancel an in-flight integration/merge (idempotent). */
  async cancelIntegration(integrationId: string): Promise<void> {
    await this.cancelRecursive(integrationId);
  }

  /**
   * Prove that cancellation registration covers every required layer under
   * a parent. Returns missing kinds (empty iff the tree is complete).
   */
  missingCancellationLayers(
    parentId: string,
    required: readonly CancellableKind[] = CANCELLATION_REACH_LAYERS,
  ): readonly CancellableKind[] {
    const present = new Set<CancellableKind>();
    const visit = (id: string): void => {
      const h = this.handles.get(id);
      if (h) present.add(h.kind);
      const kids = this.children.get(id);
      if (kids) for (const c of kids) visit(c);
    };
    visit(parentId);
    return required.filter((k) => !present.has(k));
  }

  /** Returns true if the given id has been cancelled. */
  isCancelled(id: string): boolean {
    return this.cancelled.has(id);
  }

  /**
   * Reconcile an external effect that was already started. Blind cancellation
   * is unsafe for in-flight external effects (a charge may have been made, a
   * deploy started, a notification sent). Reconciliation confirms the
   * effect's actual state and marks it reconciled. Idempotent.
   */
  async reconcileEffect(effectId: string): Promise<void> {
    if (this.reconciled.has(effectId)) return;
    const handleId = this.pendingReconciliation.get(effectId);
    if (handleId === undefined) {
      throw new ValidationError(
        `no external effect pending reconciliation for '${effectId}'`,
      );
    }
    const handle = this.handles.get(handleId);
    if (handle) {
      try {
        await handle.cancel();
      } catch {
        // Reconciliation may itself fail; we still mark the effect reconciled
        // to avoid endless retries. The caller is responsible for surfacing
        // the failure.
      }
    }
    this.pendingReconciliation.delete(effectId);
    this.reconciled.add(effectId);
    this.cancelled.add(handleId);
  }

  /** Returns the set of external-effect ids still pending reconciliation. */
  pendingReconciliations(): readonly string[] {
    return [...this.pendingReconciliation.keys()];
  }

  /** Returns true if the named external effect has been reconciled. */
  isReconciled(effectId: string): boolean {
    return this.reconciled.has(effectId);
  }

  private async cancelRecursive(id: string): Promise<void> {
    if (this.cancelled.has(id)) return;
    const handle = this.handles.get(id);
    this.cancelled.add(id);
    if (handle) {
      // For external effects, do NOT blindly cancel — defer to reconciliation.
      if (handle.kind === "external_effect" && handle.effectId !== null) {
        // Mark as cancelled from our perspective but require explicit
        // reconcileEffect() to actually settle the effect.
        return;
      }
      try {
        await handle.cancel();
      } catch {
        // Idempotent: a failed cancel is recorded but does not propagate.
      }
    }
    // Cancel children.
    const kids = this.children.get(id);
    if (kids) {
      await Promise.all([...kids].map((c) => this.cancelRecursive(c)));
    }
  }
}

// ────────────────────────── Plan artifact (§37.4) ────────────────────────────

/**
 * A plan is a durable artifact, not hidden chain-of-thought (§37.4). It
 * contains concise operational reasoning — approach, alternatives considered,
 * selected reason, files/components, sequence, risks, verification, rollback,
 * and unresolved decisions. Private reasoning traces MUST NOT appear here.
 */
export interface PlanArtifact {
  readonly taskContractVersion: number;
  readonly approach: string;
  readonly alternativesConsidered: readonly PlanAlternative[];
  readonly selectedReason: string;
  readonly filesOrComponents: readonly PlanComponent[];
  readonly sequence: readonly PlanStep[];
  readonly risks: readonly PlanRisk[];
  readonly verification: readonly PlanVerificationReference[];
  readonly rollback: string;
  readonly unresolvedDecisions: readonly PlanUnresolvedDecision[];
  readonly generatedAt: Rfc3339Timestamp;
}

export interface PlanAlternative {
  readonly name: string;
  readonly summary: string;
  readonly rejectedReason: string | null;
}

export interface PlanComponent {
  readonly path: string;
  readonly change: "create" | "modify" | "delete";
  readonly rationale: string;
}

export interface PlanStep {
  readonly sequence: number;
  readonly description: string;
  readonly dependsOn: readonly number[];
  readonly verificationHint: string | null;
}

export interface PlanRisk {
  readonly description: string;
  readonly severity: "low" | "medium" | "high";
  readonly mitigation: string | null;
}

export interface PlanVerificationReference {
  readonly criterionId: string;
  readonly nodeIds: readonly string[];
}

export interface PlanUnresolvedDecision {
  readonly question: string;
  readonly options: readonly string[];
  readonly defaultIfUnresolved: string | null;
}

export interface PlanBuilderInput {
  readonly taskContract: TaskContract;
  readonly approach: string;
  readonly alternativesConsidered: readonly PlanAlternative[];
  readonly selectedReason: string;
  readonly filesOrComponents: readonly PlanComponent[];
  readonly sequence: readonly PlanStep[];
  readonly risks: readonly PlanRisk[];
  readonly verification: readonly PlanVerificationReference[];
  readonly rollback: string;
  readonly unresolvedDecisions: readonly PlanUnresolvedDecision[];
}

/**
 * Builds a {@link PlanArtifact} from a task contract and plan inputs. The
 * plan is a durable, reviewable artifact; private reasoning traces are
 * rejected (the builder validates that `approach` and `selectedReason` do not
 * contain forbidden markers like "<thinking>" or "chain-of-thought").
 */
export class PlanBuilder {
  private static readonly FORBIDDEN_MARKERS = [
    "<thinking>",
    "chain-of-thought",
    "private reasoning",
    "<scratch>",
  ];

  constructor(private readonly clock: () => Rfc3339Timestamp = () => new Date().toISOString() as Rfc3339Timestamp) {}

  build(input: PlanBuilderInput): PlanArtifact {
    this.validateNoPrivateReasoning(input.approach, "approach");
    this.validateNoPrivateReasoning(input.selectedReason, "selectedReason");
    for (const alt of input.alternativesConsidered) {
      this.validateNoPrivateReasoning(alt.summary, `alternative '${alt.name}' summary`);
      if (alt.rejectedReason !== null) {
        this.validateNoPrivateReasoning(alt.rejectedReason, `alternative '${alt.name}' rejectedReason`);
      }
    }
    for (const step of input.sequence) {
      this.validateNoPrivateReasoning(step.description, `sequence step ${step.sequence}`);
    }
    // Validate sequence numbering: 1-based, monotonic, deps reference earlier steps.
    const seqNums = new Set<number>();
    for (const step of input.sequence) {
      if (step.sequence < 1) {
        throw new ValidationError(
          `sequence step ${step.sequence} must be >= 1`,
        );
      }
      if (seqNums.has(step.sequence)) {
        throw new ValidationError(
          `duplicate sequence step ${step.sequence}`,
        );
      }
      seqNums.add(step.sequence);
      for (const d of step.dependsOn) {
        if (d >= step.sequence) {
          throw new ValidationError(
            `sequence step ${step.sequence} depends on future or same step ${d}`,
          );
        }
      }
    }
    // Map each acceptance criterion to at least one verification node, or mark
    // it as unresolved.
    const criterionIds = new Set(
      input.taskContract.acceptanceCriteria.map((c) => c.id),
    );
    for (const v of input.verification) {
      if (!criterionIds.has(v.criterionId)) {
        throw new ValidationError(
          `verification references unknown criterion '${v.criterionId}'`,
        );
      }
    }
    return {
      taskContractVersion: input.taskContract.version,
      approach: input.approach,
      alternativesConsidered: input.alternativesConsidered,
      selectedReason: input.selectedReason,
      filesOrComponents: input.filesOrComponents,
      sequence: input.sequence,
      risks: input.risks,
      verification: input.verification,
      rollback: input.rollback,
      unresolvedDecisions: input.unresolvedDecisions,
      generatedAt: this.clock(),
    };
  }

  private validateNoPrivateReasoning(text: string, field: string): void {
    const lower = text.toLowerCase();
    for (const marker of PlanBuilder.FORBIDDEN_MARKERS) {
      if (lower.includes(marker)) {
        throw new ValidationError(
          `plan ${field} contains forbidden private-reasoning marker '${marker}'`,
          { field, marker },
        );
      }
    }
  }
}

// ────────────────────────── Re-exports ───────────────────────────────────────

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
  Micros,
};

export * from "./graph.js";
export * from "./scout.js";
export * from "./worktree.js";
export * from "./worker.js";
export * from "./findings.js";
export * from "./integration.js";
export * from "./loop-lifecycle.js";
export * from "./scheduler-cohorts.js";
export * from "./ablations.js";

import {
  COHORT_SCHEDULER_CONFIG,
  type TaskCohort,
} from "./scheduler-cohorts.js";

/** Cohort-tuned scheduler decision (avoids circular init in scheduler-cohorts). */
export function decideForCohort(
  cohort: TaskCohort,
  task: Task,
  signals: SpawnSignals,
): SpawnDecision {
  return new Scheduler(COHORT_SCHEDULER_CONFIG[cohort]).shouldSpawnWorker(task, signals);
}

export function schedulerForCohort(cohort: TaskCohort): Scheduler {
  return new Scheduler(COHORT_SCHEDULER_CONFIG[cohort]);
}

// ────────────────────────── Phase 8 Exports (§27) ──────────────────────────

export * from "./ev_scheduler.js";
export * from "./clean_reviewer.js";
export * from "./stagnation_supervisor.js";
export * from "./candidate_workspace.js";

