/**
 * Acceptance-criterion ↔ predicate bindings and predicate ↔ revision/digest
 * validity. Per SPEC §40.4, §40.5.
 *
 * Every required acceptance criterion MUST map to at least one verification
 * node (or an explicit manual/unverifiable disposition). Every result used
 * for completion MUST match the plan's source revision and environment digest.
 */
import type {
  AcceptanceCriterion,
  VerificationNode,
  VerificationPlan,
  VerificationResult,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import { parseNodeSpec, type PredicateType } from "./node-spec.js";

export type CriterionDisposition = "predicate" | "manual" | "unverifiable";

export interface CriterionBinding {
  readonly criterionId: string;
  readonly required: boolean;
  readonly disposition: CriterionDisposition;
  readonly nodeIds: readonly string[];
  readonly predicateTypes: readonly PredicateType[];
}

export interface PredicateBinding {
  readonly nodeId: string;
  readonly predicateType: PredicateType | null;
  readonly sourceRevision: string;
  readonly environmentImageDigest: string;
  /** RFC3339 expiry; null means no expiry. */
  readonly expiresAt: string | null;
}

export interface BindingCoverageReport {
  readonly bindings: readonly CriterionBinding[];
  readonly uncoveredRequired: readonly string[];
  readonly complete: boolean;
}

/**
 * Bind every acceptance criterion to the verification nodes that declare
 * `acceptanceCriterionId`, or to an explicit disposition encoded in the
 * criterion's `verificationHint` (`manual:` / `unverifiable:` prefixes).
 */
export function bindAcceptanceCriteria(
  criteria: readonly AcceptanceCriterion[],
  nodes: readonly VerificationNode[],
): BindingCoverageReport {
  const byCriterion = new Map<string, VerificationNode[]>();
  for (const n of nodes) {
    if (n.acceptanceCriterionId === null) continue;
    const list = byCriterion.get(n.acceptanceCriterionId) ?? [];
    list.push(n);
    byCriterion.set(n.acceptanceCriterionId, list);
  }

  const bindings: CriterionBinding[] = [];
  const uncoveredRequired: string[] = [];

  for (const c of criteria) {
    const mapped = byCriterion.get(c.id) ?? [];
    const hint = (c.verificationHint ?? "").trim().toLowerCase();
    let disposition: CriterionDisposition = "predicate";
    if (mapped.length === 0) {
      if (hint.startsWith("manual:")) disposition = "manual";
      else if (hint.startsWith("unverifiable:")) disposition = "unverifiable";
      else disposition = "predicate";
    }

    const predicateTypes = mapped
      .map((n) => parseNodeSpec(n.specification).predicateType)
      .filter((t): t is PredicateType => t !== null);

    const binding: CriterionBinding = {
      criterionId: c.id,
      required: c.required,
      disposition,
      nodeIds: mapped.map((n) => n.id),
      predicateTypes,
    };
    bindings.push(binding);

    if (c.required && disposition === "predicate" && mapped.length === 0) {
      uncoveredRequired.push(c.id);
    }
  }

  return {
    bindings,
    uncoveredRequired,
    complete: uncoveredRequired.length === 0,
  };
}

/** Require full coverage of required criteria; throw otherwise. */
export function requireCriterionCoverage(
  criteria: readonly AcceptanceCriterion[],
  nodes: readonly VerificationNode[],
): BindingCoverageReport {
  const report = bindAcceptanceCriteria(criteria, nodes);
  if (!report.complete) {
    throw new ValidationError(
      "required acceptance criteria lack predicate bindings",
      { uncoveredRequired: report.uncoveredRequired },
    );
  }
  return report;
}

/**
 * Bind each node to the revision/digest it was evaluated against. Used to
 * stamp results and to reject stale evidence at completion time.
 */
export function bindPredicatesToEnvironment(
  plan: VerificationPlan,
  environmentImageDigest: string,
  expiresAt: string | null = null,
): readonly PredicateBinding[] {
  if (environmentImageDigest.length === 0) {
    throw new ValidationError("environmentImageDigest is required for predicate binding");
  }
  return plan.nodes.map((n) => ({
    nodeId: n.id,
    predicateType: parseNodeSpec(n.specification).predicateType,
    sourceRevision: plan.sourceRevision,
    environmentImageDigest,
    expiresAt,
  }));
}

export type ResultValidity =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "revision_mismatch" | "digest_mismatch" | "expired" | "invalidated" | "missing";
      readonly detail: string;
    };

/**
 * Validate that a result is still admissible for completion under the given
 * expected revision/digest and wall-clock time.
 */
export function validateResultBinding(
  result: VerificationResult | null | undefined,
  expected: {
    readonly sourceRevision: string;
    readonly environmentImageDigest: string;
    readonly now: string;
    readonly expiresAt: string | null;
    readonly invalidated: boolean;
  },
): ResultValidity {
  if (result === null || result === undefined) {
    return { ok: false, reason: "missing", detail: "no result recorded" };
  }
  if (expected.invalidated) {
    return { ok: false, reason: "invalidated", detail: "result invalidated by changed code" };
  }
  if (result.sourceRevision !== expected.sourceRevision) {
    return {
      ok: false,
      reason: "revision_mismatch",
      detail: `result revision '${result.sourceRevision}' != expected '${expected.sourceRevision}'`,
    };
  }
  const digest = result.environmentImageDigest;
  if (digest === null || digest !== expected.environmentImageDigest) {
    return {
      ok: false,
      reason: "digest_mismatch",
      detail: `result digest '${digest ?? "null"}' != expected '${expected.environmentImageDigest}'`,
    };
  }
  if (expected.expiresAt !== null && expected.now >= expected.expiresAt) {
    return {
      ok: false,
      reason: "expired",
      detail: `result expired at ${expected.expiresAt}`,
    };
  }
  return { ok: true };
}

/**
 * True iff every required node has a valid passing result under the binding.
 */
export function allRequiredBindingsValid(
  plan: VerificationPlan,
  results: ReadonlyMap<string, VerificationResult>,
  expected: {
    readonly sourceRevision: string;
    readonly environmentImageDigest: string;
    readonly now: string;
    readonly expiresAt: string | null;
    readonly invalidatedNodeIds: ReadonlySet<string>;
  },
): { readonly ok: boolean; readonly failures: readonly { nodeId: string; reason: string }[] } {
  const failures: { nodeId: string; reason: string }[] = [];
  for (const node of plan.nodes) {
    if (!node.required) continue;
    const validity = validateResultBinding(results.get(node.id), {
      sourceRevision: expected.sourceRevision,
      environmentImageDigest: expected.environmentImageDigest,
      now: expected.now,
      expiresAt: expected.expiresAt,
      invalidated: expected.invalidatedNodeIds.has(node.id),
    });
    if (validity.ok === false) {
      failures.push({ nodeId: node.id, reason: validity.detail });
      continue;
    }
    const r = results.get(node.id)!;
    if (r.status !== "pass") {
      failures.push({ nodeId: node.id, reason: `status is '${r.status}'` });
    }
  }
  return { ok: failures.length === 0, failures };
}
