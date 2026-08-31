/**
 * Procedure → skill promotion (SPEC §39.7).
 *
 * A repeatedly successful procedure MAY graduate into a skill only after
 * verification, capability review hooks, versioning, and approval.
 * Memory text alone never becomes executable authority.
 */
import type {
  ContentHash,
  MemoryClaim,
  Rfc3339Timestamp,
  Uuid7,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";

export interface SkillPromotionCandidate {
  readonly claimId: Uuid7;
  readonly statement: string;
  readonly procedureArtifactHash: ContentHash;
  readonly successfulUses: number;
  readonly harmfulUses: number;
  readonly lastVerifiedAt: Rfc3339Timestamp | null;
  readonly verificationMethod: string | null;
}

export interface SkillDraft {
  readonly id: Uuid7;
  readonly name: string;
  readonly version: string;
  readonly sourceClaimId: Uuid7;
  readonly procedureArtifactHash: ContentHash;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly failureBehavior: string;
  readonly tests: readonly string[];
  readonly approvedBy: string | null;
  readonly createdAt: Rfc3339Timestamp;
  readonly status: "draft" | "approved" | "rejected";
}

export interface PromotionPolicy {
  /** Minimum successful uses before promotion is considered. */
  readonly minSuccessfulUses: number;
  /** Harmful uses must be zero (or below this). */
  readonly maxHarmfulUses: number;
  /** Require lastVerifiedAt to be set. */
  readonly requireVerification: boolean;
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
  minSuccessfulUses: 3,
  maxHarmfulUses: 0,
  requireVerification: true,
};

function isProcedureClaim(claim: MemoryClaim): boolean {
  return claim.kind === "procedure" && claim.status === "active" && claim.procedureArtifactHash !== null;
}

function satisfiesPromotionUsage(claim: MemoryClaim, policy: PromotionPolicy): boolean {
  if (claim.usage.successfulUses < policy.minSuccessfulUses) return false;
  if (claim.usage.harmfulUses > policy.maxHarmfulUses) return false;
  if (policy.requireVerification && claim.verification.lastVerifiedAt === null) return false;
  return true;
}

// skipcq: JS-0067
export function isPromotionEligible(
  claim: MemoryClaim,
  policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
): boolean {
  return isProcedureClaim(claim) && satisfiesPromotionUsage(claim, policy);
}

export function toPromotionCandidate(claim: MemoryClaim): SkillPromotionCandidate {
  if (claim.procedureArtifactHash === null) {
    throw new ValidationError("procedure claim missing artifact hash", { claimId: claim.id });
  }
  return {
    claimId: claim.id,
    statement: claim.statement,
    procedureArtifactHash: claim.procedureArtifactHash,
    successfulUses: claim.usage.successfulUses,
    harmfulUses: claim.usage.harmfulUses,
    lastVerifiedAt: claim.verification.lastVerifiedAt,
    verificationMethod: claim.verification.method,
  };
}

export interface PromoteInput {
  readonly claim: MemoryClaim;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
  readonly name: string;
  readonly version: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly failureBehavior: string;
  readonly tests: readonly string[];
  /** Human or policy approval identity; required to leave draft. */
  readonly approvedBy?: string | null;
  readonly policy?: PromotionPolicy;
}

/**
 * Build a skill draft from an eligible procedure claim. Does not grant
 * executable authority — approval + capability review remain external.
 */
export function promoteProcedureToSkill(input: PromoteInput): SkillDraft {
  const policy = input.policy ?? DEFAULT_PROMOTION_POLICY;
  if (!isPromotionEligible(input.claim, policy)) {
    throw new ValidationError("procedure not eligible for skill promotion", {
      claimId: input.claim.id,
      successfulUses: input.claim.usage.successfulUses,
      harmfulUses: input.claim.usage.harmfulUses,
    });
  }
  const hash = input.claim.procedureArtifactHash;
  if (hash === null) {
    throw new ValidationError("missing procedure artifact", { claimId: input.claim.id });
  }
  if (input.tests.length === 0) {
    throw new ValidationError("skill promotion requires tests", { claimId: input.claim.id });
  }

  const approvedBy = input.approvedBy ?? null;
  return {
    id: input.idSource(),
    name: input.name,
    version: input.version,
    sourceClaimId: input.claim.id,
    procedureArtifactHash: hash,
    inputs: input.inputs,
    outputs: input.outputs,
    failureBehavior: input.failureBehavior,
    tests: input.tests,
    approvedBy,
    createdAt: input.clock(),
    status: approvedBy !== null ? "approved" : "draft",
  };
}
