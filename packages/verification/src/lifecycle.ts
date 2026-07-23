/**
 * Live verification lifecycle: persist plan graph, evaluate, invalidate on
 * changed code, gate completion. Per SPEC §40.
 */
import type {
  AcceptanceCriterion,
  CompletionRecord,
  ReviewFinding,
  VerificationNode,
  VerificationPlan,
  VerificationResult,
  Uuid7,
  Rfc3339Timestamp,
  ArtifactRef,
  Micros,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import { requireCriterionCoverage } from "./binding.js";
import { assertCompletionAllowed, evaluateCompletionGate } from "./completion-gate.js";
import {
  buildVerificationPlan,
  ChangedCodeInvalidator,
  evaluateCompletionExpression,
  VerificationEngine,
  type EvaluationResult,
  type NodeExecutor,
} from "./index.js";
import type { VerificationAttemptRecord, VerificationStore } from "./store.js";
import { serializeNodeSpec, type PredicateType } from "./node-spec.js";

export interface LifecycleDeps {
  readonly store: VerificationStore;
  readonly engine: VerificationEngine;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
}

export interface CreatePlanInput {
  readonly taskContractId: Uuid7;
  readonly taskContractVersion: number;
  readonly sourceRevision: string;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly nodes: readonly VerificationNode[];
  readonly completionExpression: string;
}

export class VerificationLifecycle {
  private readonly invalidated = new Map<string, Set<string>>();

  constructor(private readonly deps: LifecycleDeps) {}

  /**
   * Persist a plan with nodes/edges after enforcing AC→predicate coverage.
   */
  async createPlan(input: CreatePlanInput): Promise<VerificationPlan> {
    requireCriterionCoverage(input.criteria, input.nodes);
    const plan = buildVerificationPlan({
      id: this.deps.idSource(),
      taskContractId: input.taskContractId,
      taskContractVersion: input.taskContractVersion,
      sourceRevision: input.sourceRevision,
      nodes: input.nodes,
      completionExpression: input.completionExpression,
    });
    await this.deps.store.savePlan(plan);
    await this.deps.store.saveNodes(plan.id, plan.nodes);
    await this.deps.store.saveEdges(plan.id, plan.edges);
    return plan;
  }

  /**
   * Evaluate the plan, persist every attempt + final result, stamp digest.
   */
  async evaluate(
    planId: Uuid7,
    workspaceRevision: string,
    environmentImageDigest: string,
    signal: AbortSignal | null = null,
  ): Promise<EvaluationResult> {
    const plan = await this.deps.store.getPlan(planId);
    if (plan === null) throw new ValidationError("verification plan not found", { planId });

    const result = await this.deps.engine.evaluate(plan, workspaceRevision, signal, {
      environmentImageDigest,
    });

    const cleared = this.invalidated.get(planId) ?? new Set<string>();
    for (const r of result.results) {
      const attempt: VerificationAttemptRecord = {
        id: this.deps.idSource(),
        planId: r.planId,
        nodeId: r.nodeId,
        attempt: r.attempts,
        status: r.status,
        sourceRevision: r.sourceRevision,
        environmentImageDigest: r.environmentImageDigest,
        evidence: r.artifacts,
        toolCallId: r.toolCallId,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        reason: r.reasonIfSkipped,
        observations: r.structuredObservations,
      };
      await this.deps.store.saveAttempt(attempt);
      await this.deps.store.saveResult(r);
      // Fresh evaluation clears prior invalidation marks for that node.
      cleared.delete(r.nodeId);
    }
    if (cleared.size === 0) this.invalidated.delete(planId);
    else this.invalidated.set(planId, cleared);
    return result;
  }

  /**
   * Changed-code invalidation in the live lifecycle: clear stored results for
   * invalidated nodes so subsequent evaluate re-runs them.
   */
  async invalidateForChangedPaths(
    planId: Uuid7,
    changedPaths: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const plan = await this.deps.store.getPlan(planId);
    if (plan === null) throw new ValidationError("verification plan not found", { planId });
    const invalidator = new ChangedCodeInvalidator();
    const nodeIds = invalidator.invalidate(plan, {
      changedPaths,
      symbolDependencies: new Map(),
      testOwnership: new Map(),
      buildGraph: new Map(),
    });
    if (nodeIds.size > 0) {
      await this.deps.store.deleteResults(planId, nodeIds);
      const set = this.invalidated.get(planId) ?? new Set<string>();
      for (const id of nodeIds) set.add(id);
      this.invalidated.set(planId, set);
    }
    return nodeIds;
  }

  /**
   * Attempt completion. Returns a CompletionRecord on success; throws on
   * false-completion attempts (required failure / expire / invalidate / open findings).
   */
  async complete(input: {
    readonly taskId: Uuid7;
    readonly planId: Uuid7;
    readonly criteria: readonly AcceptanceCriterion[];
    readonly findings: readonly ReviewFinding[];
    readonly sourceRevision: string;
    readonly environmentImageDigest: string;
    readonly expiresAt: string | null;
    readonly unresolvedRisks: readonly string[];
    readonly acceptedRisks: readonly string[];
    readonly externalEffects: readonly ArtifactRef[];
    readonly costMicros: Micros;
    readonly durationSeconds: number;
    readonly finalCheckpoint: ArtifactRef;
  }): Promise<CompletionRecord> {
    const plan = await this.deps.store.getPlan(input.planId);
    if (plan === null) throw new ValidationError("verification plan not found", { planId: input.planId });
    const results = await this.deps.store.listResults(input.planId);
    const resultMap = new Map(results.map((r) => [r.nodeId, r] as const));
    const invalidatedNodeIds = this.invalidated.get(input.planId) ?? new Set<string>();

    const gateInput = {
      taskId: input.taskId,
      contractVersion: plan.taskContractVersion,
      plan,
      criteria: input.criteria,
      results,
      findings: input.findings,
      sourceRevision: input.sourceRevision,
      environmentImageDigest: input.environmentImageDigest,
      now: this.deps.clock(),
      expiresAt: input.expiresAt,
      invalidatedNodeIds,
      completionExpressionSatisfied: evaluateCompletionExpression(
        plan.completionExpression,
        resultMap,
      ),
      unresolvedRisks: input.unresolvedRisks,
      acceptedRisks: input.acceptedRisks,
      externalEffects: input.externalEffects,
      costMicros: input.costMicros,
      durationSeconds: input.durationSeconds,
      finalCheckpoint: input.finalCheckpoint,
    };

    const decision = evaluateCompletionGate(gateInput);
    if (!decision.allow) {
      throw new ValidationError("false completion prevented", {
        reason: decision.reason,
        detail: decision.detail,
      });
    }

    const record = assertCompletionAllowed(
      gateInput,
      this.deps.idSource,
      this.deps.clock,
    );
    await this.deps.store.saveCompletionRecord(record);
    // Clear invalidation marks after successful completion.
    this.invalidated.delete(input.planId);
    return record;
  }
}

/** Helper to build a criterion-bound node with a standard predicate type. */
export function criterionNode(input: {
  readonly id: string;
  readonly criterionId: string | null;
  readonly predicateType: PredicateType;
  readonly paths: readonly string[];
  readonly required: boolean;
  readonly dependsOn?: readonly string[];
  readonly command?: string;
}): VerificationNode {
  return {
    id: input.id,
    kind: "command",
    required: input.required,
    dependsOn: input.dependsOn ?? [],
    specification: serializeNodeSpec({
      predicateType: input.predicateType,
      paths: input.paths,
      observations: {},
      command: input.command,
    }),
    timeout: 30_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, flakeIdentity: null },
    acceptanceCriterionId: input.criterionId,
  };
}

/** Build a VerificationEngine wired to a single NodeExecutor for all kinds. */
export function engineFromExecutor(
  executor: NodeExecutor,
  idSource: () => Uuid7,
  clock: () => Rfc3339Timestamp,
): VerificationEngine {
  return new VerificationEngine({
    executorFor: () => executor,
    idSource,
    clock,
  });
}

export type { VerificationResult };
