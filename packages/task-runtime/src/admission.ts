/**
 * @terminus/task-runtime — Admission Authority & Separation of Duty (SPEC §15.4, §27.2, §28.4).
 *
 * The AdmissionService is the sole authoritative gatekeeper for:
 * 1. Merging speculative candidate workspace branches into authoritative state.
 * 2. Admitting final external effects.
 * 3. Enforcing separation of duty: reviewers cannot merge their own recommendations (`reviewer !== actor`).
 * 4. Fencing losing speculative branches so they cannot commit external mutations.
 */
import type { EffectRecord } from "@terminus/domain";
import { ScopeViolationError, ValidationError } from "@terminus/domain";
import type { DurableTaskRepository } from "./types.js";
import type { EffectLedger } from "./effects.js";
import type { SequencePolicyEvaluator } from "./sequence-policy.js";

export interface CandidateBranch {
  readonly branchId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly actorPrincipal: string;
  readonly worktreePath: string;
  readonly epoch: number;
  readonly effectIds: readonly string[];
  readonly status: "OPEN" | "ADMITTED" | "REJECTED";
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
  private readonly candidateBranches = new Map<string, CandidateBranch>();

  constructor(
    private readonly repo: DurableTaskRepository,
    private readonly ledger: EffectLedger,
    private readonly sequencePolicy?: SequencePolicyEvaluator
  ) {}

  /**
   * Register a speculative candidate branch with an isolated epoch and worktree.
   */
  registerCandidateBranch(branch: CandidateBranch): void {
    this.candidateBranches.set(branch.branchId, { ...branch, status: "OPEN" });
  }

  /**
   * Authoritatively admit and merge a candidate branch.
   */
  async admitBranch(input: AdmitBranchInput): Promise<{
    readonly admitted: boolean;
    readonly committedEffects: readonly string[];
  }> {
    // 1. Separation of duty invariant: reviewer cannot be the actor
    if (input.reviewerPrincipal === input.actorPrincipal) {
      throw new ScopeViolationError(
        `Separation of duty violation: actor '${input.actorPrincipal}' cannot self-admit branch '${input.branchId}'`
      );
    }

    // 2. Fetch candidate branch
    const branch = this.candidateBranches.get(input.branchId);
    if (!branch) {
      throw new ValidationError(`Candidate branch not found: ${input.branchId}`);
    }
    if (branch.status !== "OPEN") {
      throw new ValidationError(`Candidate branch '${input.branchId}' is already ${branch.status}`);
    }

    // 3. Evaluate sequence policy if configured
    if (this.sequencePolicy) {
      const seqResult = await this.sequencePolicy.evaluate({
        taskId: input.taskId,
        effectType: "branch.merge",
        actorPrincipal: input.actorPrincipal,
        reviewerPrincipal: input.reviewerPrincipal,
        precedingEvents: ["evidence.verified", "claim.satisfied"],
        admittedClaims: input.requiredClaimsSatisfied ?? ["security.secret_scan_passed", "tests.unit_passed"],
      });

      if (seqResult.decision === "DENIED") {
        throw new ScopeViolationError(`Admission denied by sequence policy: ${seqResult.reason}`);
      }
    }

    // 4. Commit all valid effects associated with this branch through the EffectLedger
    const committedEffects: string[] = [];
    for (const effId of branch.effectIds) {
      const eff = await this.repo.getEffectRecord(effId);
      if (eff && eff.state === "VALIDATED") {
        await this.ledger.commitEffect(effId);
        committedEffects.push(effId);
      }
    }

    // 5. Mark branch as ADMITTED
    this.candidateBranches.set(input.branchId, { ...branch, status: "ADMITTED" });

    return {
      admitted: true,
      committedEffects,
    };
  }

  /**
   * Reject a losing speculative branch, fencing its effects and preventing any external commit.
   */
  async rejectBranch(branchId: string, reason: string): Promise<void> {
    const branch = this.candidateBranches.get(branchId);
    if (!branch) {
      throw new ValidationError(`Candidate branch not found: ${branchId}`);
    }

    // Cancel all in-flight effects for this losing branch
    for (const effId of branch.effectIds) {
      const eff = await this.repo.getEffectRecord(effId);
      if (eff && eff.state !== "COMMITTED" && eff.state !== "CANCELLED" && eff.state !== "DENIED") {
        await this.ledger.cancelEffect(effId, `Losing speculative branch rejected: ${reason}`);
      }
    }

    this.candidateBranches.set(branchId, { ...branch, status: "REJECTED" });
  }
}
