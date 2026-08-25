/**
 * Explicit obligations for criteria that cannot be established by an
 * automated predicate. An obligation is open until a human decision and
 * immutable decision evidence are supplied; it is never an implicit pass.
 */
import type {
  AcceptanceCriterion,
  ArtifactRef,
  Rfc3339Timestamp,
  VerificationNode,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import { parseNodeSpec } from "./node-spec.js";
import { isImmutableArtifact } from "./evidence.js";

export type HumanAcceptanceStatus = "open" | "accepted" | "rejected";

export interface HumanAcceptanceObligation {
  readonly id: string;
  readonly criterionId: string;
  readonly statement: string;
  readonly instructions: string;
  readonly required: boolean;
  readonly status: HumanAcceptanceStatus;
  readonly acceptedBy: string | null;
  readonly acceptedAt: Rfc3339Timestamp | null;
  readonly evidence: readonly ArtifactRef[];
  readonly sourceRevision: string;
  readonly environmentImageDigest: string;
}

function manualInstructions(criterion: AcceptanceCriterion): string {
  const hint = (criterion.verificationHint ?? "").trim();
  if (hint.toLowerCase().startsWith("manual:")) {
    const instructions = hint.slice("manual:".length).trim();
    if (instructions.length > 0) return instructions;
  }
  return `Human acceptance required for: ${criterion.statement}`;
}

/** Whether the criterion requires a human decision at this source/environment. */
export function criterionRequiresHumanAcceptance(
  criterion: AcceptanceCriterion,
  nodes: readonly VerificationNode[] = [],
): boolean {
  const hint = (criterion.verificationHint ?? "").trim().toLowerCase();
  if (hint.startsWith("manual:")) return true;
  return nodes.some((node) =>
    node.acceptanceCriterionId === criterion.id
    && parseNodeSpec(node.specification).predicateType === "human_approval"
  );
}

export interface CreateHumanAcceptanceObligationsInput {
  readonly criteria: readonly AcceptanceCriterion[];
  readonly nodes?: readonly VerificationNode[];
  readonly sourceRevision: string;
  readonly environmentImageDigest: string;
}

/** Build stable, open obligations for every subjective criterion. */
export function createHumanAcceptanceObligations(
  input: CreateHumanAcceptanceObligationsInput,
): readonly HumanAcceptanceObligation[] {
  return input.criteria
    .filter((criterion) => criterionRequiresHumanAcceptance(criterion, input.nodes ?? []))
    .map((criterion) => ({
      id: `human-acceptance:${criterion.id}`,
      criterionId: criterion.id,
      statement: criterion.statement,
      instructions: manualInstructions(criterion),
      required: criterion.required,
      status: "open" as const,
      acceptedBy: null,
      acceptedAt: null,
      evidence: [],
      sourceRevision: input.sourceRevision,
      environmentImageDigest: input.environmentImageDigest,
    }));
}

export interface AcceptHumanAcceptanceObligationInput {
  readonly acceptedBy: string;
  readonly acceptedAt: Rfc3339Timestamp;
  readonly evidence: readonly ArtifactRef[];
}

/**
 * Record a human decision without implying a cryptographic signature. The
 * caller remains responsible for sourcing the decision from a human channel.
 */
export function acceptHumanAcceptanceObligation(
  obligation: HumanAcceptanceObligation,
  input: AcceptHumanAcceptanceObligationInput,
): HumanAcceptanceObligation {
  if (obligation.status !== "open") {
    throw new ValidationError(
      `human acceptance obligation '${obligation.id}' is already ${obligation.status}`,
    );
  }
  if (input.acceptedBy.trim().length === 0) {
    throw new ValidationError("human acceptance requires an accepting identity");
  }
  if (input.evidence.length === 0 || input.evidence.some((artifact) => !isImmutableArtifact(artifact))) {
    throw new ValidationError("human acceptance requires immutable decision evidence");
  }
  return {
    ...obligation,
    status: "accepted",
    acceptedBy: input.acceptedBy,
    acceptedAt: input.acceptedAt,
    evidence: input.evidence,
  };
}

export interface ValidateHumanAcceptanceObligationsInput {
  readonly criteria: readonly AcceptanceCriterion[];
  readonly nodes?: readonly VerificationNode[];
  readonly obligations: readonly HumanAcceptanceObligation[];
  readonly sourceRevision: string;
  readonly environmentImageDigest: string;
}

/** Return all reasons a human obligation set cannot support completion. */
export function validateHumanAcceptanceObligations(
  input: ValidateHumanAcceptanceObligationsInput,
): readonly string[] {
  const failures: string[] = [];
  const criteriaById = new Map(input.criteria.map((criterion) => [criterion.id, criterion] as const));
  const obligationsByCriterion = new Map<string, HumanAcceptanceObligation>();

  for (const obligation of input.obligations) {
    if (obligationsByCriterion.has(obligation.criterionId)) {
      failures.push(`${obligation.criterionId}: duplicate human acceptance obligation`);
      continue;
    }
    obligationsByCriterion.set(obligation.criterionId, obligation);
    const criterion = criteriaById.get(obligation.criterionId);
    if (criterion === undefined) {
      failures.push(`${obligation.criterionId}: obligation references unknown criterion`);
      continue;
    }
    if (!criterionRequiresHumanAcceptance(criterion, input.nodes ?? [])) {
      failures.push(`${obligation.criterionId}: obligation is not bound to a subjective criterion`);
    }
    if (obligation.statement !== criterion.statement) {
      failures.push(`${obligation.criterionId}: obligation statement does not match the criterion`);
    }
    if (obligation.required !== criterion.required) {
      failures.push(`${obligation.criterionId}: obligation required flag does not match the criterion`);
    }
    if (obligation.sourceRevision !== input.sourceRevision) {
      failures.push(`${obligation.criterionId}: obligation has a stale source revision`);
    }
    if (obligation.environmentImageDigest !== input.environmentImageDigest) {
      failures.push(`${obligation.criterionId}: obligation has a stale environment`);
    }
    if (obligation.status === "accepted") {
      if (obligation.acceptedBy === null || obligation.acceptedBy.trim().length === 0) {
        failures.push(`${obligation.criterionId}: accepted obligation lacks accepting identity`);
      }
      if (obligation.acceptedAt === null) {
        failures.push(`${obligation.criterionId}: accepted obligation lacks decision time`);
      }
      if (obligation.evidence.length === 0 || obligation.evidence.some((artifact) => !isImmutableArtifact(artifact))) {
        failures.push(`${obligation.criterionId}: accepted obligation lacks immutable evidence`);
      }
    }
    if (obligation.status === "open" && (
      obligation.acceptedBy !== null
      || obligation.acceptedAt !== null
      || obligation.evidence.length > 0
    )) {
      failures.push(`${obligation.criterionId}: open obligation contains an acceptance decision`);
    }
  }

  for (const criterion of input.criteria) {
    if (!criterionRequiresHumanAcceptance(criterion, input.nodes ?? [])) continue;
    const obligation = obligationsByCriterion.get(criterion.id);
    if (obligation === undefined) {
      failures.push(`${criterion.id}: human acceptance obligation missing`);
      continue;
    }
    if (criterion.required && obligation.status !== "accepted") {
      failures.push(`${criterion.id}: human acceptance is ${obligation.status}`);
    }
  }
  return failures;
}
