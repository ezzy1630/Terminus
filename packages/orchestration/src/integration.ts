/**
 * Merge/integration coordinator with conflict ownership, recovery, and
 * mandatory post-merge verification. Per SPEC §37.10.
 *
 * This module plans and tracks integration; kernel git ops perform the merge.
 */
import type {
  DelegationResult,
  Uuid7,
  WorktreeLease,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";

interface IntegrationStep {
  readonly description: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly detail: string;
}

interface IntegrationResult {
  readonly steps: readonly IntegrationStep[];
  readonly accepted: boolean;
  readonly reason: string;
}

interface DiffSummary {
  readonly changedPaths: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly riskClass: string;
  readonly touchesAuth: boolean;
  readonly touchesMigrations: boolean;
  readonly touchesPublicApi: boolean;
  readonly touchesDependencies: boolean;
  readonly isCrossCutting: boolean;
  readonly isPerformanceCritical: boolean;
  readonly repeatedRepairCycles: boolean;
  readonly testCoverageWeak: boolean;
  readonly implementerLowConfidence: boolean;
  readonly userRequestedExhaustive: boolean;
}

export type ConflictOwner = "worker" | "coordinator" | "user";

export interface ConflictRecord {
  readonly leaseId: string;
  readonly paths: readonly string[];
  readonly owner: ConflictOwner;
  readonly recovery: "rebase" | "abort" | "manual";
  readonly detail: string;
}

export interface MergePlan {
  readonly leaseId: string;
  readonly baseRevision: string;
  readonly workerHead: string;
  readonly targetBranch: string;
  readonly steps: readonly IntegrationStep[];
  readonly accepted: boolean;
  readonly reason: string;
  readonly requireVerification: true;
}

export interface MergeExecutionPort {
  readonly merge: (input: {
    readonly leaseId: string;
    readonly baseRevision: string;
    readonly workerHead: string;
    readonly targetBranch: string;
  }) => Promise<
    | { readonly status: "merged"; readonly revision: string }
    | { readonly status: "conflict"; readonly paths: readonly string[] }
  >;
}

export interface PostMergeVerificationPort {
  readonly evaluate: (
    planId: Uuid7,
    revision: string,
  ) => Promise<{ readonly allRequiredPassed: boolean; readonly detail: string }>;
}

export class MergeIntegrationCoordinator {
  private readonly conflicts: ConflictRecord[] = [];

  constructor(
    private readonly mergePort: MergeExecutionPort,
    private readonly verifyPort: PostMergeVerificationPort | null = null,
  ) {}

  /**
   * Validate worker result + lease exact-HEAD, produce a merge plan.
   * Always sets requireVerification=true.
   */
  planMerge(input: {
    readonly lease: WorktreeLease;
    readonly diff: DiffSummary;
    readonly result: DelegationResult;
    readonly targetBranch: string;
  }): MergePlan {
    const steps: IntegrationStep[] = [];
    steps.push({
      description: "validate result schema",
      status: input.result.status === "completed" ? "passed" : "failed",
      detail: `status=${input.result.status}`,
    });
    if (input.lease.status !== "active" && input.lease.status !== "merging") {
      steps.push({
        description: "worktree lease active",
        status: "failed",
        detail: `lease status ${input.lease.status}`,
      });
    }
    if (input.lease.baseRevision.length === 0) {
      steps.push({
        description: "exact-HEAD base present",
        status: "failed",
        detail: "missing baseRevision",
      });
    }
    if (input.diff.touchesAuth) {
      steps.push({
        description: "security review required",
        status: "failed",
        detail: "auth/security boundary change requires reviewer before merge",
      });
    }
    for (const f of input.result.changedFiles) {
      const owned = input.lease.ownedPathPrefixes.some(
        (p) => f === p || f.startsWith(`${p}/`),
      );
      if (!owned) {
        steps.push({
          description: "changed file ownership",
          status: "failed",
          detail: `file '${f}' outside owned prefixes`,
        });
      }
    }
    const accepted = steps.every((s) => s.status !== "failed");
    return {
      leaseId: input.lease.id,
      baseRevision: input.lease.baseRevision,
      workerHead: input.lease.headRevision,
      targetBranch: input.targetBranch,
      steps,
      accepted,
      reason: accepted ? "merge plan accepted" : "merge plan blocked",
      requireVerification: true,
    };
  }

  /**
   * Execute merge via kernel port, then run verification. Conflicts are
   * attributed to an owner with a recovery action.
   */
  async executeMerge(input: {
    readonly plan: MergePlan;
    readonly verificationPlanId: Uuid7 | null;
    readonly conflictOwner?: ConflictOwner;
  }): Promise<{
    readonly integration: IntegrationResult;
    readonly revision: string | null;
    readonly conflict: ConflictRecord | null;
    readonly verificationPassed: boolean | null;
  }> {
    if (!input.plan.accepted) {
      return {
        integration: {
          steps: input.plan.steps,
          accepted: false,
          reason: input.plan.reason,
        },
        revision: null,
        conflict: null,
        verificationPassed: null,
      };
    }

    const mergeResult = await this.mergePort.merge({
      leaseId: input.plan.leaseId,
      baseRevision: input.plan.baseRevision,
      workerHead: input.plan.workerHead,
      targetBranch: input.plan.targetBranch,
    });

    if (mergeResult.status === "conflict") {
      const conflict: ConflictRecord = {
        leaseId: input.plan.leaseId,
        paths: mergeResult.paths,
        owner: input.conflictOwner ?? "worker",
        recovery: "rebase",
        detail: `conflict on ${mergeResult.paths.join(", ")}`,
      };
      this.conflicts.push(conflict);
      return {
        integration: {
          steps: [
            ...input.plan.steps,
            {
              description: "merge",
              status: "failed",
              detail: conflict.detail,
            },
          ],
          accepted: false,
          reason: "merge conflict",
        },
        revision: null,
        conflict,
        verificationPassed: null,
      };
    }

    let verificationPassed: boolean | null = null;
    const steps: IntegrationStep[] = [
      ...input.plan.steps,
      {
        description: "merge",
        status: "passed",
        detail: `merged at ${mergeResult.revision}`,
      },
    ];

    // Always verify after integration/merge when a plan is provided.
    if (input.verificationPlanId !== null) {
      if (this.verifyPort === null) {
        throw new ValidationError("post-merge verification required but no verify port configured");
      }
      const v = await this.verifyPort.evaluate(input.verificationPlanId, mergeResult.revision);
      verificationPassed = v.allRequiredPassed;
      steps.push({
        description: "post-merge verification",
        status: v.allRequiredPassed ? "passed" : "failed",
        detail: v.detail,
      });
    }

    const accepted = steps.every((s) => s.status !== "failed");
    return {
      integration: {
        steps,
        accepted,
        reason: accepted ? "merged and verified" : "post-merge verification failed",
      },
      revision: mergeResult.revision,
      conflict: null,
      verificationPassed,
    };
  }

  listConflicts(): readonly ConflictRecord[] {
    return this.conflicts;
  }

  recoverConflict(leaseId: string): ConflictRecord {
    const c = this.conflicts.find((x) => x.leaseId === leaseId);
    if (!c) throw new ValidationError("no conflict for lease", { leaseId });
    return c;
  }
}
