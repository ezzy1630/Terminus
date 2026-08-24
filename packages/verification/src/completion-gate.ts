/**
 * Completion gate — prevents false completion when required predicates fail,
 * expire, or are invalidated. Per SPEC §17, §40.6, ADR-0021.
 */
import type {
  AcceptanceCriterion,
  CompletionRecord,
  VerificationPlan,
  VerificationResult,
  ReviewFinding,
  Uuid7,
  ArtifactRef,
  Micros,
  Rfc3339Timestamp,
} from "@terminus/domain";
import { ValidationError, findingBlocksCompletion } from "@terminus/domain";
import {
  allRequiredBindingsValid,
  bindAcceptanceCriteria,
  type BindingCoverageReport,
} from "./binding.js";
import {
  buildClaimEvidenceGraph,
  claimId,
  isImmutableArtifact,
  validateClaimEvidenceGraph,
} from "./evidence.js";

export interface CompletionGateInput {
  readonly taskId: Uuid7;
  readonly contractVersion: number;
  readonly plan: VerificationPlan;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly results: readonly VerificationResult[];
  readonly findings: readonly ReviewFinding[];
  readonly sourceRevision: string;
  readonly environmentImageDigest: string;
  readonly now: Rfc3339Timestamp;
  readonly expiresAt: string | null;
  readonly invalidatedNodeIds: ReadonlySet<string>;
  /** Precomputed by caller via evaluateCompletionExpression — avoids import cycles. */
  readonly completionExpressionSatisfied: boolean;
  readonly unresolvedRisks: readonly string[];
  readonly acceptedRisks: readonly string[];
  readonly externalEffects: readonly ArtifactRef[];
  readonly costMicros: Micros;
  readonly durationSeconds: number;
  readonly finalCheckpoint: ArtifactRef;
}

export type CompletionDenialReason =
  | "uncovered_criteria"
  | "manual_criterion"
  | "required_predicate_failed"
  | "binding_invalid"
  | "completion_expression_unsatisfied"
  | "open_findings"
  | "revision_mismatch"
  | "evidence_missing";

export type CompletionGateDecision =
  | { readonly allow: true; readonly coverage: BindingCoverageReport }
  | {
      readonly allow: false;
      readonly reason: CompletionDenialReason;
      readonly detail: string;
      readonly coverage: BindingCoverageReport;
    };

export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateDecision {
  if (!input.criteria.some((criterion) => criterion.required)) {
    return {
      allow: false,
      reason: "uncovered_criteria",
      detail: "completion requires at least one required acceptance criterion",
      coverage: bindAcceptanceCriteria(input.criteria, input.plan.nodes),
    };
  }
  const coverage = bindAcceptanceCriteria(input.criteria, input.plan.nodes);
  if (!coverage.complete) {
    return {
      allow: false,
      reason: "uncovered_criteria",
      detail: `uncovered required criteria: ${coverage.uncoveredRequired.join(", ")}`,
      coverage,
    };
  }

  const nonAutomatedRequired = coverage.bindings.filter(
    (binding) => binding.required && binding.disposition !== "predicate",
  );
  if (nonAutomatedRequired.length > 0) {
    return {
      allow: false,
      reason: "manual_criterion",
      detail: `required criteria have no independent predicate: ${nonAutomatedRequired.map((binding) => binding.criterionId).join(", ")}`,
      coverage,
    };
  }

  if (input.sourceRevision !== input.plan.sourceRevision) {
    return {
      allow: false,
      reason: "revision_mismatch",
      detail: `plan revision '${input.plan.sourceRevision}' != final '${input.sourceRevision}'`,
      coverage,
    };
  }

  if (!isImmutableArtifact(input.finalCheckpoint)) {
    return {
      allow: false,
      reason: "evidence_missing",
      detail: "final checkpoint is not an immutable artifact reference",
      coverage,
    };
  }

  const resultMap = new Map(input.results.map((r) => [r.nodeId, r] as const));
  const binding = allRequiredBindingsValid(input.plan, resultMap, {
    sourceRevision: input.sourceRevision,
    environmentImageDigest: input.environmentImageDigest,
    now: input.now,
    expiresAt: input.expiresAt,
    invalidatedNodeIds: input.invalidatedNodeIds,
  });
  if (!binding.ok) {
    return {
      allow: false,
      reason: "binding_invalid",
      detail: binding.failures.map((f) => `${f.nodeId}: ${f.reason}`).join("; "),
      coverage,
    };
  }

  const requiredFailed = input.plan.nodes
    .filter((n) => n.required)
    .filter((n) => resultMap.get(n.id)?.status !== "pass");
  if (requiredFailed.length > 0) {
    return {
      allow: false,
      reason: "required_predicate_failed",
      detail: `required nodes not pass: ${requiredFailed.map((n) => n.id).join(", ")}`,
      coverage,
    };
  }

  const graph = buildClaimEvidenceGraph({
    taskId: input.taskId,
    criteria: input.criteria,
    nodes: input.plan.nodes,
    results: input.results,
    observedAt: input.now,
  });
  const requiredClaimIds = coverage.bindings
    .filter((binding) => binding.required && binding.disposition === "predicate")
    .map((binding) => claimId(input.taskId, binding.criterionId));
  const evidenceFailures = validateClaimEvidenceGraph(graph, {
    sourceRevision: input.sourceRevision,
    environmentImageDigest: input.environmentImageDigest,
    requiredClaimIds,
  });
  if (evidenceFailures.length > 0) {
    return {
      allow: false,
      reason: "evidence_missing",
      detail: evidenceFailures.join("; "),
      coverage,
    };
  }

  if (!input.completionExpressionSatisfied) {
    return {
      allow: false,
      reason: "completion_expression_unsatisfied",
      detail: `expression '${input.plan.completionExpression}' not satisfied`,
      coverage,
    };
  }

  const blockers = input.findings.filter((f) => findingBlocksCompletion(f.lifecycle));
  if (blockers.length > 0) {
    return {
      allow: false,
      reason: "open_findings",
      detail: `blocking findings: ${blockers.map((f) => f.id).join(", ")}`,
      coverage,
    };
  }

  return { allow: true, coverage };
}

/**
 * Build a CompletionRecord only when the gate allows. Throws ValidationError
 * on denial — callers must transition to FAILED_VERIFICATION instead.
 */
export function assertCompletionAllowed(
  input: CompletionGateInput,
  idSource: () => Uuid7,
  clock: () => Rfc3339Timestamp,
): CompletionRecord {
  const decision = evaluateCompletionGate(input);
  if (decision.allow === false) {
    throw new ValidationError("completion denied by verification gate", {
      reason: decision.reason,
      detail: decision.detail,
    });
  }

  const resultMap = new Map(input.results.map((r) => [r.nodeId, r] as const));
  const criteria = decision.coverage.bindings.map((b) => {
    if (b.disposition === "manual") {
      return {
        id: b.criterionId,
        status: "manual" as const,
        evidence: [] as ArtifactRef[],
        reason: "manual disposition",
      };
    }
    if (b.disposition === "unverifiable") {
      return {
        id: b.criterionId,
        status: "unverifiable" as const,
        evidence: [] as ArtifactRef[],
        reason: "unverifiable disposition",
      };
    }
    const evidence = b.nodeIds.flatMap((nid) => resultMap.get(nid)?.artifacts ?? []);
    const allPass = b.nodeIds.every((nid) => resultMap.get(nid)?.status === "pass");
    return {
      id: b.criterionId,
      status: allPass ? ("satisfied" as const) : ("unsatisfied" as const),
      evidence,
      reason: allPass ? null : "predicate failed",
    };
  });

  // Unsatisfied must not appear for required criteria after the gate, but
  // keep the invariant explicit.
  if (criteria.some((c) => c.status === "unsatisfied")) {
    throw new ValidationError("cannot build completion record: criteria unsatisfied");
  }

  void idSource;
  return {
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    finalRevision: input.sourceRevision,
    status: "completed",
    criteria,
    verificationPlanId: input.plan.id,
    unresolvedRisks: input.unresolvedRisks,
    acceptedRisks: input.acceptedRisks,
    externalEffects: input.externalEffects,
    costMicros: input.costMicros,
    durationSeconds: input.durationSeconds,
    finalCheckpoint: input.finalCheckpoint,
    generatedAt: clock(),
  };
}
