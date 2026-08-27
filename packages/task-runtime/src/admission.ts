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
  CandidateBranchMergeReceipt,
  CandidateCompletionProof,
} from "./types.js";
import type { SequencePolicyEvaluator } from "./sequence-policy.js";

export type CandidateBranch = CandidateBranchRecord;

export function candidateBranchAdmissionOperationId(branchId: string): string {
  return `completion-admission:${branchId}`;
}

export interface CandidateBranchMerger {
  /** Read the currently authoritative revision for exact-HEAD admission. */
  readonly getAuthoritativeRevision: () => Promise<string>;
  /** Merge the isolated candidate and return the new authoritative revision. */
  readonly merge: (branch: CandidateBranch) => Promise<{
    readonly mergeId: string;
    readonly authoritativeRevision: string;
    /** A trusted adapter may return the immutable receipt it just verified. */
    readonly receipt?: CandidateBranchMergeReceipt | undefined;
  }>;
  /** Undo a merge when the local admission transaction fails after merging. */
  readonly rollback?: ((mergeId: string) => Promise<void>) | undefined;
}

/**
 * Trusted read-side adapter for an external merge that crossed the process
 * boundary before the local branch row reached ADMITTED. The adapter owns
 * authentication and receipt verification; AdmissionService owns exact
 * binding and the durable state transition.
 */
export interface CandidateBranchMergeReceiptQuery {
  readonly getMergeReceipt: (branch: CandidateBranch) => Promise<CandidateBranchMergeReceipt>;
}

export interface CandidateBranchReconciliationResult {
  readonly disposition: "ADMITTED" | "MANUAL_REVIEW" | "ALREADY_RESOLVED";
  readonly committedEffects: readonly string[];
  readonly authoritativeRevision: string | null;
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
    private readonly mergeReceiptQuery?: CandidateBranchMergeReceiptQuery,
  ) {}

  /** Register a speculative branch durably before it can produce effects. */
  async registerCandidateBranch(branch: CandidateBranch): Promise<void> {
    if (branch.status !== "OPEN") {
      throw new ValidationError(`candidate branch must be registered OPEN: ${branch.branchId}`);
    }
    if (!branch.branchId || !branch.taskId || !branch.attemptId || !branch.actorPrincipal) {
      throw new ValidationError("candidate branch identity is incomplete");
    }
    if (branch.mergeReceipt !== undefined && branch.mergeReceipt !== null) {
      throw new ValidationError("candidate branch merge receipts are adapter-owned and cannot be registered by a caller");
    }
    await this.repo.createCandidateBranch({ ...branch, mergeReceipt: null, status: "OPEN" });
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
    // The repository advances the durable epoch and marks the branch
    // ADMITTING with a compare-and-swap, so a restart cannot mistake an
    // externally submitted merge for an OPEN branch and issue it again.
    const claimedBranch = await this.repo.claimCandidateBranch(branch.branchId, branch.epoch);
    if (claimedBranch === null) {
      throw new ValidationError(`candidate branch '${branch.branchId}' was claimed or changed concurrently`);
    }

    const merge = await merger.merge(claimedBranch);
    const committedEffects: string[] = [];
    try {
      if (!merge.mergeId) {
        throw new ValidationError("authoritative merge returned no merge identity");
      }
      if (!merge.authoritativeRevision) {
        throw new ValidationError("authoritative merge returned no revision");
      }
      const mergeReceipt = merge.receipt === undefined
        ? claimedBranch.mergeReceipt ?? null
        : validateCandidateBranchMergeReceipt(claimedBranch, merge.receipt, {
          expectedMergeId: merge.mergeId,
          expectedAuthoritativeRevision: merge.authoritativeRevision,
          requireExecuted: true,
        });
      for (const effect of effects) {
        await this.ledger.commitEffect(effect.id);
        committedEffects.push(effect.id);
      }
      await this.repo.updateCandidateBranch({
        ...claimedBranch,
        epoch: claimedBranch.epoch + 1,
        status: "ADMITTED",
        headRevision: merge.authoritativeRevision,
        mergeReceipt,
      });
    } catch (error) {
      if (merger.rollback !== undefined && typeof merge.mergeId === "string" && merge.mergeId.length > 0) {
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

  /**
   * Resolve an ADMITTING branch from a trusted external receipt without
   * issuing the merge again. Executed receipts complete the same effect
   * commits as normal admission; negative or ambiguous receipts are retained
   * on a fenced MANUAL_REVIEW branch.
   */
  async reconcileAdmittingBranch(branchId: string): Promise<CandidateBranchReconciliationResult> {
    const branch = await this.repo.getCandidateBranch(branchId);
    if (branch === null) {
      throw new ValidationError(`Candidate branch not found: ${branchId}`);
    }
    if (branch.status !== "ADMITTING") {
      return {
        disposition: "ALREADY_RESOLVED",
        committedEffects: [],
        authoritativeRevision: branch.status === "ADMITTED" ? branch.headRevision : null,
      };
    }

    const receiptQuery = this.mergeReceiptQuery;
    if (receiptQuery === undefined) {
      throw new ValidationError(
        "trusted external merge-receipt query is not configured; candidate admission remains fenced",
      );
    }

    const proof = requireAdmissionProof(branch);
    validateAdmissionProof(branch, proof, []);
    const receipt = validateCandidateBranchMergeReceipt(
      branch,
      await receiptQuery.getMergeReceipt(branch),
    );

    if (receipt.status !== "EXECUTED") {
      await this.repo.updateCandidateBranch({
        ...branch,
        epoch: branch.epoch + 1,
        mergeReceipt: receipt,
        status: "MANUAL_REVIEW",
      });
      return {
        disposition: "MANUAL_REVIEW",
        committedEffects: [],
        authoritativeRevision: null,
      };
    }

    const committedEffects: string[] = [];
    for (const effectId of branch.effectIds) {
      const effect = await this.repo.getEffectRecord(effectId);
      if (effect === null) {
        throw new ValidationError(`candidate branch references missing effect '${effectId}'`);
      }
      if (effect.taskId !== branch.taskId || effect.attemptId !== branch.attemptId) {
        throw new ValidationError(`effect '${effectId}' is not bound to candidate branch '${branch.branchId}'`);
      }
      if (effect.state === "VALIDATED") {
        await this.ledger.commitEffect(effectId);
        committedEffects.push(effectId);
      } else if (effect.state !== "COMMITTED") {
        throw new ValidationError(
          `effect '${effectId}' is ${effect.state}; trusted merge recovery requires VALIDATED or COMMITTED effects`,
        );
      }
    }

    await this.repo.updateCandidateBranch({
      ...branch,
      epoch: branch.epoch + 1,
      headRevision: receipt.authoritativeRevision!,
      mergeReceipt: receipt,
      status: "ADMITTED",
    });
    return {
      disposition: "ADMITTED",
      committedEffects,
      authoritativeRevision: receipt.authoritativeRevision,
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

export function validateCandidateBranchMergeReceipt(
  branch: CandidateBranch,
  receipt: CandidateBranchMergeReceipt,
  options: {
    readonly expectedMergeId?: string;
    readonly expectedAuthoritativeRevision?: string;
    readonly requireExecuted?: boolean;
  } = {},
): CandidateBranchMergeReceipt {
  if (receipt === null || typeof receipt !== "object") {
    throw new ValidationError(`candidate branch '${branch.branchId}' returned no merge receipt`);
  }
  if (
    receipt.status !== "EXECUTED"
    && receipt.status !== "NOT_EXECUTED"
    && receipt.status !== "AMBIGUOUS"
  ) {
    throw new ValidationError(`candidate branch '${branch.branchId}' returned an invalid merge receipt status`);
  }
  const requiredStrings: ReadonlyArray<[string, unknown]> = [
    ["operationId", receipt.operationId],
    ["receiptArtifactUri", receipt.receiptArtifactUri],
    ["receiptArtifactHash", receipt.receiptArtifactHash],
    ["branchId", receipt.branchId],
    ["taskId", receipt.taskId],
    ["attemptId", receipt.attemptId],
    ["actorPrincipal", receipt.actorPrincipal],
    ["baseRevision", receipt.baseRevision],
    ["candidateHeadRevision", receipt.candidateHeadRevision],
    ["scopeDigest", receipt.scopeDigest],
    ["completionRecordDigest", receipt.completionRecordDigest],
  ];
  for (const [name, value] of requiredStrings) {
    if (typeof value !== "string" || value.length === 0) {
      throw new ValidationError(`candidate branch '${branch.branchId}' merge receipt has no ${name}`);
    }
  }
  const artifactHash = /^sha256:([0-9a-f]{64})$/i.exec(receipt.receiptArtifactHash);
  if (
    artifactHash === null
    || receipt.receiptArtifactUri !== `artifact://sha256/${artifactHash[1]!.toLowerCase()}`
  ) {
    throw new ValidationError(`candidate branch '${branch.branchId}' merge receipt is not an immutable artifact reference`);
  }
  const expectedOperationId = candidateBranchAdmissionOperationId(branch.branchId);
  if (receipt.operationId !== expectedOperationId) {
    throw new ValidationError(`candidate branch '${branch.branchId}' merge receipt operation binding does not match`);
  }
  if (
    receipt.branchId !== branch.branchId
    || receipt.taskId !== branch.taskId
    || receipt.attemptId !== branch.attemptId
    || receipt.actorPrincipal !== branch.actorPrincipal
    || receipt.baseRevision !== branch.baseRevision
    || receipt.candidateHeadRevision !== branch.headRevision
    || receipt.scopeDigest !== branch.scopeDigest
  ) {
    throw new ValidationError(`candidate branch '${branch.branchId}' merge receipt identity binding does not match`);
  }
  const proof = requireAdmissionProof(branch);
  if (receipt.completionRecordDigest !== proof.completionRecordDigest) {
    throw new ValidationError(`candidate branch '${branch.branchId}' merge receipt content binding does not match`);
  }
  if (options.requireExecuted === true && receipt.status !== "EXECUTED") {
    throw new ValidationError(`candidate branch '${branch.branchId}' merge did not return an executed receipt`);
  }
  if (receipt.status === "EXECUTED") {
    if (!receipt.mergeId || !receipt.authoritativeRevision) {
      throw new ValidationError(`candidate branch '${branch.branchId}' executed merge receipt is incomplete`);
    }
    if (options.expectedMergeId !== undefined && receipt.mergeId !== options.expectedMergeId) {
      throw new ValidationError(`candidate branch '${branch.branchId}' merge receipt identity does not match the merge result`);
    }
    if (
      options.expectedAuthoritativeRevision !== undefined
      && receipt.authoritativeRevision !== options.expectedAuthoritativeRevision
    ) {
      throw new ValidationError(`candidate branch '${branch.branchId}' merge receipt revision does not match the merge result`);
    }
  } else if (receipt.mergeId !== null || receipt.authoritativeRevision !== null) {
    throw new ValidationError(`candidate branch '${branch.branchId}' non-executed merge receipt contains settled identity`);
  }
  return receipt;
}
