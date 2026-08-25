/**
 * @terminus/task-runtime — authoritative candidate admission
 * (SPEC §15.4, §27.2, §28.4).
 *
 * Candidate state and proof are repository-backed. The service is the only
 * caller allowed to invoke the authoritative merge adapter or commit the
 * effects attached to a speculative branch.
 */
import { ScopeViolationError, ValidationError } from "@terminus/domain";
import type {
  CandidateBranchRecord,
  CandidateCompletionProof,
} from "./types.js";
import type { SequencePolicyEvaluator } from "./sequence-policy.js";

export type CandidateBranch = CandidateBranchRecord;

export interface CandidateBranchMerger {
  /** Read the currently authoritative revision for exact-HEAD admission. */
  readonly getAuthoritativeRevision: () => Promise<string>;
  /** Merge the isolated candidate and return the new authoritative revision. */
  readonly merge: (branch: CandidateBranch) => Promise<{
    readonly mergeId: string;
    readonly authoritativeRevision: string;
  }>;
  /** Undo a merge when the local admission transaction fails after merging. */
  readonly rollback?: ((mergeId: string) => Promise<void>) | undefined;
}

/** Narrow persistence contract used by admission. Durable adapters may expose more. */
export interface CandidateAdmissionRepository {
  createCandidateBranch(branch: CandidateBranchRecord): Promise<CandidateBranchRecord>;
  getCandidateBranch(branchId: string): Promise<CandidateBranchRecord | null>;
  claimCandidateBranch(branchId: string, expectedEpoch: number): Promise<CandidateBranchRecord | null>;
  updateCandidateBranch(branch: CandidateBranchRecord): Promise<CandidateBranchRecord>;
  getEffectRecord(effectId: string): Promise<{
    readonly id: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly state: string;
  } | null>;
}

export interface CandidateEffectLedger {
  commitEffect(effectId: string): Promise<unknown>;
  cancelEffect(effectId: string, reason: string): Promise<unknown>;
}

export interface AdmitBranchInput {
  readonly branchId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly actorPrincipal: string;
  readonly reviewerPrincipal: string;
  readonly requiredClaimsSatisfied?: readonly string[];
}

export class AdmissionService {
  constructor(
    private readonly repo: CandidateAdmissionRepository,
    private readonly ledger: CandidateEffectLedger,
    private readonly sequencePolicy?: SequencePolicyEvaluator,
    private readonly merger?: CandidateBranchMerger,
  ) {}

  /** Register a speculative branch durably before it can produce effects. */
  async registerCandidateBranch(branch: CandidateBranch): Promise<void> {
    if (branch.status !== "OPEN") {
      throw new ValidationError(`candidate branch must be registered OPEN: ${branch.branchId}`);
    }
    if (!branch.branchId || !branch.taskId || !branch.attemptId || !branch.actorPrincipal) {
      throw new ValidationError("candidate branch identity is incomplete");
    }
    await this.repo.createCandidateBranch({ ...branch, status: "OPEN" });
  }

  /**
   * Validate proof, exact-head freshness, reviewer independence, and effect
   * state before invoking the authoritative merge adapter.
   */
  async admitBranch(input: AdmitBranchInput): Promise<{
    readonly admitted: boolean;
    readonly committedEffects: readonly string[];
    readonly authoritativeRevision: string;
  }> {
    if (input.reviewerPrincipal === input.actorPrincipal) {
      throw new ScopeViolationError(
        `Separation of duty violation: actor '${input.actorPrincipal}' cannot self-admit branch '${input.branchId}'`,
      );
    }

    const branch = await this.repo.getCandidateBranch(input.branchId);
    if (branch === null) {
      throw new ValidationError(`Candidate branch not found: ${input.branchId}`);
    }
    if (branch.status !== "OPEN") {
      throw new ValidationError(`Candidate branch '${input.branchId}' is already ${branch.status}`);
    }
    if (
      branch.taskId !== input.taskId ||
      branch.attemptId !== input.attemptId ||
      branch.actorPrincipal !== input.actorPrincipal
    ) {
      throw new ValidationError(`candidate branch '${input.branchId}' identity binding does not match admission request`);
    }

    const proof = requireAdmissionProof(branch);
    validateAdmissionProof(branch, proof, input.requiredClaimsSatisfied ?? []);

    const merger = this.merger;
    if (merger === undefined) {
      throw new ValidationError("authoritative merge adapter is not configured; candidate admission is fail-closed");
    }
    const authoritativeRevision = await merger.getAuthoritativeRevision();
    if (authoritativeRevision !== branch.baseRevision) {
      throw new ValidationError(
        `candidate branch '${branch.branchId}' is stale: base '${branch.baseRevision}' != authoritative '${authoritativeRevision}'`,
      );
    }

    const effects = [] as Array<{ readonly id: string }>;
    for (const effectId of branch.effectIds) {
      const effect = await this.repo.getEffectRecord(effectId);
      if (effect === null) {
        throw new ValidationError(`candidate branch references missing effect '${effectId}'`);
      }
      if (effect.taskId !== branch.taskId || effect.attemptId !== branch.attemptId) {
        throw new ValidationError(`effect '${effectId}' is not bound to candidate branch '${branch.branchId}'`);
      }
      if (effect.state !== "VALIDATED") {
        throw new ValidationError(`effect '${effectId}' is ${effect.state}; only VALIDATED effects may be admitted`);
      }
      effects.push({ id: effect.id });
    }

    if (this.sequencePolicy) {
      const sequence = await this.sequencePolicy.evaluate({
        taskId: input.taskId,
        effectType: "git.merge",
        actorPrincipal: input.actorPrincipal,
        reviewerPrincipal: input.reviewerPrincipal,
        precedingEvents: ["evidence.verified", "claim.satisfied"],
        admittedClaims: proof.claims.map((claim) => claim.claimId),
      });
      if (sequence.decision === "DENIED") {
        throw new ScopeViolationError(`Admission denied by sequence policy: ${sequence.reason}`);
      }
    }

    // Claim after all read-only validation and immediately before the merge.
    // The repository advances the durable epoch with a compare-and-swap, so
    // two reviewers cannot both merge the same OPEN branch.
    const claimedBranch = await this.repo.claimCandidateBranch(branch.branchId, branch.epoch);
    if (claimedBranch === null) {
      throw new ValidationError(`candidate branch '${branch.branchId}' was claimed or changed concurrently`);
    }

    const merge = await merger.merge(claimedBranch);
    if (!merge.authoritativeRevision) {
      throw new ValidationError("authoritative merge returned no revision");
    }

    const committedEffects: string[] = [];
    try {
      for (const effect of effects) {
        await this.ledger.commitEffect(effect.id);
        committedEffects.push(effect.id);
      }
      await this.repo.updateCandidateBranch({
        ...claimedBranch,
        epoch: claimedBranch.epoch + 1,
        status: "ADMITTED",
        headRevision: merge.authoritativeRevision,
      });
    } catch (error) {
      if (merger.rollback !== undefined) {
        await merger.rollback(merge.mergeId);
      }
      throw new ValidationError(`candidate admission rolled back after commit failure: ${String(error)}`);
    }

    return {
      admitted: true,
      committedEffects,
      authoritativeRevision: merge.authoritativeRevision,
    };
  }

  /** Fence a losing branch and cancel all of its not-yet-committed effects. */
  async rejectBranch(branchId: string, reason: string): Promise<void> {
    const branch = await this.repo.getCandidateBranch(branchId);
    if (branch === null) {
      throw new ValidationError(`Candidate branch not found: ${branchId}`);
    }
    if (branch.status !== "OPEN") {
      throw new ValidationError(`Candidate branch '${branchId}' is already ${branch.status}`);
    }
    const claimedBranch = await this.repo.claimCandidateBranch(branch.branchId, branch.epoch);
    if (claimedBranch === null) {
      throw new ValidationError(`candidate branch '${branchId}' was claimed or changed concurrently`);
    }
    for (const effectId of claimedBranch.effectIds) {
      const effect = await this.repo.getEffectRecord(effectId);
      if (effect !== null && effect.state !== "COMMITTED" && effect.state !== "CANCELLED" && effect.state !== "DENIED") {
        await this.ledger.cancelEffect(effectId, `Losing speculative branch rejected: ${reason}`);
      }
    }
    await this.repo.updateCandidateBranch({ ...claimedBranch, epoch: claimedBranch.epoch + 1, status: "REJECTED" });
  }
}

function requireAdmissionProof(branch: CandidateBranch): CandidateCompletionProof {
  if (branch.proof === null) {
    throw new ValidationError(`candidate branch '${branch.branchId}' has no immutable completion proof`);
  }
  return branch.proof;
}

function validateAdmissionProof(
  branch: CandidateBranch,
  proof: CandidateCompletionProof,
  requestedClaims: readonly string[],
): void {
  if (!proof.completionExpressionSatisfied) {
    throw new ValidationError(`candidate branch '${branch.branchId}' completion expression is not satisfied`);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(branch.scopeDigest)) {
    throw new ValidationError(`candidate branch '${branch.branchId}' has no valid scope digest`);
  }
  if (!proof.verificationPlanId || !/^sha256:[0-9a-f]{64}$/i.test(proof.completionRecordDigest)) {
    throw new ValidationError(`candidate branch '${branch.branchId}' proof identity is incomplete`);
  }
  if (proof.sourceRevision !== branch.headRevision) {
    throw new ValidationError(`candidate branch '${branch.branchId}' proof is not bound to its head revision`);
  }
  if (!proof.sourceRevision || !proof.environmentImageDigest || !proof.completionRecordDigest) {
    throw new ValidationError(`candidate branch '${branch.branchId}' proof identity is incomplete`);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(proof.completionRecordDigest)) {
    throw new ValidationError(`candidate branch '${branch.branchId}' completion proof digest is not a SHA-256`);
  }
  const claims = new Map(proof.claims.map((claim) => [claim.claimId, claim] as const));
  for (const requestedClaim of requestedClaims) {
    const claim = claims.get(requestedClaim);
    if (claim === undefined || claim.status !== "SATISFIED") {
      throw new ValidationError(`candidate branch '${branch.branchId}' lacks required satisfied claim '${requestedClaim}'`);
    }
  }
  for (const claim of proof.claims) {
    if (claim.status === "SATISFIED" && claim.evidence.length === 0) {
      throw new ValidationError(`candidate claim '${claim.claimId}' has no immutable evidence`);
    }
    for (const evidence of claim.evidence) {
      if (evidence.verifierResult !== "pass") {
        throw new ValidationError(`candidate evidence '${evidence.evidenceId}' is not a pass`);
      }
      if (evidence.sourceRevision !== proof.sourceRevision || evidence.environmentImageDigest !== proof.environmentImageDigest) {
        throw new ValidationError(`candidate evidence '${evidence.evidenceId}' is stale or environment-mismatched`);
      }
      if (!/^sha256:[0-9a-f]{64}$/i.test(evidence.artifactHash) || !evidence.artifactUri.startsWith("artifact://sha256/")) {
        throw new ValidationError(`candidate evidence '${evidence.evidenceId}' is not an immutable artifact reference`);
      }
    }
  }
}
