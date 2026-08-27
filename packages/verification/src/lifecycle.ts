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
  ContentHash,
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
  type ChangedCodeInvalidationInput,
  type EvaluationResult,
  type EvaluationOptions,
  type NodeExecutor,
} from "./index.js";
import type { VerificationAttemptRecord, VerificationStore } from "./store.js";
import { serializeNodeSpec, type PredicateType } from "./node-spec.js";
import { buildClaimEvidenceGraph } from "./evidence.js";
import type { ClaimEvidenceGraph } from "./evidence.js";
import {
  computeAcceptanceCriteriaHash,
  computeVerificationResultsHash,
  type ProofBundle,
} from "./proof-bundle.js";
import type { HumanAcceptanceObligation } from "./human-acceptance.js";
import {
  createVerifierBinding,
  validateVerifierResultBinding,
  type VerifierBinding,
} from "./run-binding.js";

export interface LifecycleDeps {
  readonly store: VerificationStore;
  readonly engine: VerificationEngine;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
  /** Repository intelligence used to select affected tests/build checks. */
  readonly dependencyIndex?: Partial<Omit<ChangedCodeInvalidationInput, "changedPaths">> | undefined;
}

export interface CreatePlanInput {
  readonly taskContractId: Uuid7;
  readonly taskContractVersion: number;
  readonly sourceRevision: string;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly nodes: readonly VerificationNode[];
  readonly completionExpression: string;
}

export interface RestorePlanInput {
  readonly plan: VerificationPlan;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly results?: readonly VerificationResult[];
  readonly attempts?: readonly VerificationAttemptRecord[];
  readonly evidenceGraph?: ClaimEvidenceGraph | null;
}

export class VerificationLifecycle {
  private readonly invalidated = new Map<string, Set<string>>();
  private readonly criteriaByPlan = new Map<string, readonly AcceptanceCriterion[]>();
  private readonly criteriaHashByPlan = new Map<string, ContentHash>();
  private readonly verifierBindingByPlan = new Map<string, VerifierBinding>();
  private readonly resultsHashByPlan = new Map<string, ContentHash>();

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
    this.criteriaByPlan.set(plan.id, input.criteria);
    const criteriaHash = computeAcceptanceCriteriaHash(input.criteria);
    this.criteriaHashByPlan.set(plan.id, criteriaHash);
    await this.deps.store.saveLifecycleBinding({
      planId: plan.id,
      criteriaHash,
      verifierBinding: null,
      resultsHash: null,
      invalidatedNodeIds: [],
    });
    return plan;
  }

  /**
   * Rehydrate a plan and its immutable evidence before crash recovery. The
   * caller can pass the returned results to evaluate as resumeResults.
   */
  async restorePlan(input: RestorePlanInput): Promise<void> {
    requireCriterionCoverage(input.criteria, input.plan.nodes);
    const binding = createVerifierBinding(input.plan);
    const results = input.results ?? [];
    for (const result of results) {
      const failures = validateVerifierResultBinding(result, binding);
      if (failures.length > 0) {
        throw new ValidationError("persisted verification result has an invalid run binding", {
          resultId: result.id,
          failures,
        });
      }
      if (
        result.planId !== input.plan.id
        || result.sourceRevision !== input.plan.sourceRevision
      ) {
        throw new ValidationError("persisted verification result does not belong to the restored plan", {
          resultId: result.id,
          planId: input.plan.id,
        });
      }
    }
    await this.deps.store.savePlan(input.plan);
    await this.deps.store.saveNodes(input.plan.id, input.plan.nodes);
    await this.deps.store.saveEdges(input.plan.id, input.plan.edges);
    const criteriaHash = computeAcceptanceCriteriaHash(input.criteria);
    const resultsHash = computeVerificationResultsHash(results);
    this.criteriaByPlan.set(input.plan.id, input.criteria);
    this.criteriaHashByPlan.set(input.plan.id, criteriaHash);
    this.verifierBindingByPlan.set(input.plan.id, binding);
    this.resultsHashByPlan.set(input.plan.id, resultsHash);
    await this.deps.store.saveLifecycleBinding({
      planId: input.plan.id,
      criteriaHash,
      verifierBinding: binding,
      resultsHash,
      invalidatedNodeIds: [],
    });
    for (const result of results) await this.deps.store.saveResult(result);
    for (const attempt of input.attempts ?? []) await this.deps.store.saveAttempt(attempt);
    if (input.evidenceGraph !== undefined) {
      if (input.evidenceGraph === null) await this.deps.store.deleteEvidenceGraph(input.plan.id);
      else await this.deps.store.saveEvidenceGraph(input.plan.id, input.evidenceGraph);
    }
  }

  /**
   * Evaluate the plan, persist every attempt + final result, stamp digest.
   */
  async evaluate(
    planId: Uuid7,
    workspaceRevision: string,
    environmentImageDigest: string,
    signal: AbortSignal | null = null,
    options: EvaluationOptions = {},
  ): Promise<EvaluationResult> {
    const plan = await this.deps.store.getPlan(planId);
    if (plan === null) throw new ValidationError("verification plan not found", { planId });
    if (workspaceRevision !== plan.sourceRevision) {
      throw new ValidationError("verification must run against the plan's exact source revision", {
        planRevision: plan.sourceRevision,
        workspaceRevision,
      });
    }
    if (environmentImageDigest.trim().length === 0) {
      throw new ValidationError("verification requires an environment image digest");
    }

    const result = await this.deps.engine.evaluate(plan, workspaceRevision, signal, {
      ...options,
      environmentImageDigest,
      onAttempt: async (attemptResult) => {
        const attempt: VerificationAttemptRecord = {
          id: this.deps.idSource(),
          planId: attemptResult.planId,
          nodeId: attemptResult.nodeId,
          attempt: attemptResult.attempts,
          status: attemptResult.status,
          sourceRevision: attemptResult.sourceRevision,
          environmentImageDigest: attemptResult.environmentImageDigest,
          evidence: attemptResult.artifacts,
          toolCallId: attemptResult.toolCallId,
          startedAt: attemptResult.startedAt,
          completedAt: attemptResult.completedAt,
          reason: attemptResult.reasonIfSkipped,
          observations: attemptResult.structuredObservations,
          commandOrQuery: attemptResult.commandOrQuery,
          exitCode: attemptResult.exitCode,
          verifierVersion: attemptResult.verifierVersion,
        };
        await this.deps.store.saveAttempt(attempt);
      },
    });
    const resultsHash = computeVerificationResultsHash(result.results);
    this.verifierBindingByPlan.set(planId, result.verifierBinding);
    this.resultsHashByPlan.set(planId, resultsHash);
    const persistedBinding = await this.deps.store.getLifecycleBinding(planId);
    if (persistedBinding === null) {
      throw new ValidationError("verification lifecycle binding is missing from durable storage", { planId });
    }
    const cleared = this.invalidated.get(planId) ?? new Set<string>();
    for (const r of result.results) {
      await this.deps.store.saveResult(r);
      // Fresh evaluation clears prior invalidation marks for that node.
      cleared.delete(r.nodeId);
    }
    if (cleared.size === 0) this.invalidated.delete(planId);
    else this.invalidated.set(planId, cleared);
    await this.deps.store.saveLifecycleBinding({
      ...persistedBinding,
      verifierBinding: result.verifierBinding,
      resultsHash,
      invalidatedNodeIds: [...(this.invalidated.get(planId) ?? [])].sort(),
    });
    const criteria = this.criteriaByPlan.get(planId);
    if (criteria !== undefined) {
      await this.deps.store.saveEvidenceGraph(planId, buildClaimEvidenceGraph({
        taskId: plan.taskContractId,
        criteria,
        nodes: plan.nodes,
        results: result.results,
        observedAt: this.deps.clock(),
      }));
    }
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
      symbolDependencies: this.deps.dependencyIndex?.symbolDependencies ?? new Map(),
      testOwnership: this.deps.dependencyIndex?.testOwnership ?? new Map(),
      buildGraph: this.deps.dependencyIndex?.buildGraph ?? new Map(),
    });
    if (nodeIds.size > 0) {
      await this.deps.store.deleteResults(planId, nodeIds);
      await this.deps.store.deleteEvidenceGraph(planId);
      const set = this.invalidated.get(planId) ?? new Set<string>();
      for (const id of nodeIds) set.add(id);
      this.invalidated.set(planId, set);
      const persistedBinding = await this.deps.store.getLifecycleBinding(planId);
      if (persistedBinding !== null) {
        await this.deps.store.saveLifecycleBinding({
          ...persistedBinding,
          invalidatedNodeIds: [...set].sort(),
        });
      }
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
    readonly humanAcceptanceObligations?: readonly HumanAcceptanceObligation[] | undefined;
    readonly proofBundle?: ProofBundle | undefined;
    readonly proofBundleContentHash?: ContentHash | undefined;
    readonly taskContractHash?: ContentHash | undefined;
  }): Promise<CompletionRecord> {
    const plan = await this.deps.store.getPlan(input.planId);
    if (plan === null) throw new ValidationError("verification plan not found", { planId: input.planId });
    const results = await this.deps.store.listResults(input.planId);
    const resultMap = new Map(results.map((r) => [r.nodeId, r] as const));
    const persistedBinding = await this.deps.store.getLifecycleBinding(input.planId);
    const invalidatedNodeIds = this.invalidated.get(input.planId)
      ?? new Set<string>(persistedBinding?.invalidatedNodeIds ?? []);
    const expectedCriteriaHash = this.criteriaHashByPlan.get(input.planId) ?? persistedBinding?.criteriaHash;
    const verifierBinding = this.verifierBindingByPlan.get(input.planId)
      ?? persistedBinding?.verifierBinding
      ?? undefined;
    const expectedResultsHash = this.resultsHashByPlan.get(input.planId) ?? persistedBinding?.resultsHash;
    if (
      expectedCriteriaHash === undefined
      || verifierBinding === undefined
      || expectedResultsHash === undefined
    ) {
      throw new ValidationError(
        "verification completion is missing its immutable run/evidence binding; manual acceptance cannot be inferred",
      );
    }
    if (computeVerificationResultsHash(results) !== expectedResultsHash) {
      throw new ValidationError("verification evidence changed after evaluation");
    }

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
      expectedCriteriaHash,
      verifierBinding,
      ...(input.humanAcceptanceObligations !== undefined
        ? { humanAcceptanceObligations: input.humanAcceptanceObligations }
        : {}),
      ...(input.proofBundle !== undefined ? { proofBundle: input.proofBundle } : {}),
      ...(input.proofBundleContentHash !== undefined
        ? { proofBundleContentHash: input.proofBundleContentHash }
        : {}),
      ...(input.taskContractHash !== undefined ? { taskContractHash: input.taskContractHash } : {}),
    };

    const decision = evaluateCompletionGate(gateInput);
    if (decision.allow === false) {
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
    const evidenceGraph = buildClaimEvidenceGraph({
      taskId: input.taskId,
      criteria: input.criteria,
      nodes: plan.nodes,
      results,
      observedAt: this.deps.clock(),
    });
    await this.deps.store.saveEvidenceGraph(input.planId, evidenceGraph);
    await this.deps.store.saveCompletionRecord(record);
    // Clear invalidation marks after successful completion.
    this.invalidated.delete(input.planId);
    if (persistedBinding !== null) {
      await this.deps.store.saveLifecycleBinding({
        ...persistedBinding,
        invalidatedNodeIds: [],
      });
    }
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
