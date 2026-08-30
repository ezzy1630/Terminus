/**
 * Bounded recovery for a provider that stops after intent-only work.
 *
 * A read-only turn is a valid answer even when its task has permission to
 * write. A coding turn that actually attempted a mutation is different:
 * a final response with no successful mutation and no evidence is not a
 * completion candidate. Give the provider one durable continuation, then
 * leave the turn explicitly blocked if it repeats the same outcome.
 */

export const INTENT_ONLY_CONTINUATION_LIMIT = 1;

export interface IntentOnlyCriterion {
  readonly criterionId: string;
  readonly required: boolean;
  readonly status: string;
}

export interface IntentOnlyClaim {
  readonly criterionId: string;
  readonly evidenceRefs: readonly string[];
  readonly changedArtifactRefs: readonly string[];
}

export interface IntentOnlyRecoveryInput {
  readonly criteria: readonly IntentOnlyCriterion[];
  readonly claims: readonly IntentOnlyClaim[];
  /** True only after a workspace-changing tool settled successfully. */
  readonly workspaceMutationObserved: boolean;
  /** Includes denied/failed mutating calls, which are still intent signals. */
  readonly workspaceMutationAttempted: boolean;
  /** Whether this turn has already consumed its one recovery continuation. */
  readonly continuationAdmitted: boolean;
}

export type IntentOnlyRecoveryDecision =
  | {
      readonly kind: "ignore";
      readonly reason:
        | "no_pending_required_criteria"
        | "workspace_mutation_observed"
        | "evidence_present"
        | "read_only_turn";
    }
  | {
      readonly kind: "continue";
      readonly reason: "pending_required_criteria_without_workspace_mutation";
      readonly pendingCriterionIds: readonly string[];
    }
  | {
      readonly kind: "block";
      readonly reason: "repeated_intent_only_stop";
      readonly pendingCriterionIds: readonly string[];
    };

function criterionIsSatisfied(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "satisfied" || normalized === "passed" || normalized === "verified";
}

function claimHasEvidence(claim: IntentOnlyClaim | undefined): boolean {
  return claim !== undefined
    && (claim.evidenceRefs.length > 0 || claim.changedArtifactRefs.length > 0);
}

/**
 * Decide whether a final provider response may enter the no-verification
 * path. This function has no persistence side effects; the composition root
 * owns the durable continuation and terminal transition.
 */
export function decideIntentOnlyRecovery(
  input: IntentOnlyRecoveryInput,
): IntentOnlyRecoveryDecision {
  const pendingCriteria = input.criteria.filter(
    (criterion) => criterion.required && !criterionIsSatisfied(criterion.status),
  );
  if (pendingCriteria.length === 0) {
    return { kind: "ignore", reason: "no_pending_required_criteria" };
  }
  if (input.workspaceMutationObserved) {
    return { kind: "ignore", reason: "workspace_mutation_observed" };
  }

  const claimsById = new Map(input.claims.map((claim) => [claim.criterionId, claim]));
  if (pendingCriteria.some((criterion) => claimHasEvidence(claimsById.get(criterion.criterionId)))) {
    return { kind: "ignore", reason: "evidence_present" };
  }

  // Write scope is permission, not an obligation. Desktop conversations use
  // a reusable workspace contract, so reply-only turns may legitimately have
  // write paths. Only an actual mutating call is an intent signal.
  if (!input.workspaceMutationAttempted) {
    return { kind: "ignore", reason: "read_only_turn" };
  }

  const pendingCriterionIds = pendingCriteria.map((criterion) => criterion.criterionId);
  if (input.continuationAdmitted) {
    return {
      kind: "block",
      reason: "repeated_intent_only_stop",
      pendingCriterionIds,
    };
  }
  return {
    kind: "continue",
    reason: "pending_required_criteria_without_workspace_mutation",
    pendingCriterionIds,
  };
}
