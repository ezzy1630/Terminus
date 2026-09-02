import type { MutationRunner, ServiceEventAppender } from "./service-types.js";

export interface VerificationTaskState {
  readonly status: string;
}

export interface RepairAttemptPersistenceInput {
  readonly id: string;
  readonly taskId: string;
  readonly parentTurnId: string;
  readonly leaseKey: string;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly directiveArtifact: string;
  readonly failedNodeIds: readonly string[];
  readonly failureSignatures: readonly string[];
  readonly changedFiles: readonly string[];
  readonly sourceRevision: string;
  readonly environmentDigest: string | null;
  readonly remainingBudgetJson: string;
}

export interface VerificationTransitionInput {
  readonly taskId: string;
  readonly status: string;
  readonly phase: string;
  readonly completedAt: Date | null;
  readonly terminalReasonJson: string | null;
  readonly verificationPlanId?: string | null;
  readonly completionRecordId?: string | null;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly repairBudget?: {
    readonly maxAttempts: number;
    readonly attemptNumber: number;
    readonly failureSignatures: readonly string[];
    readonly sourceRevision: string;
  };
  readonly repairAttempt?: RepairAttemptPersistenceInput;
}

export interface VerificationCoordinatorDependencies<TTransaction> {
  readonly readTask: (taskId: string) => Promise<VerificationTaskState | null>;
  readonly appendEvent: ServiceEventAppender<TTransaction>;
  readonly updateTask: (
    transaction: TTransaction,
    input: VerificationTransitionInput,
    expectedStatuses: readonly string[],
  ) => Promise<void>;
  /** Atomically admit task completion and the corresponding verified turn. */
  readonly updateTaskAndTurn?: (
    transaction: TTransaction,
    input: VerificationTransitionInput,
    expectedStatuses: readonly string[],
    turnId: string,
    expectedTurnState: string,
  ) => Promise<void>;
  /** Persist the repair attempt and its unclaimed lease in the transition transaction. */
  readonly createRepairAttempt?: (
    transaction: TTransaction,
    input: RepairAttemptPersistenceInput,
  ) => Promise<void>;
  readonly mutate: MutationRunner;
  readonly projectTask: (taskId: string, eventType: string) => Promise<void>;
}

/**
 * Owns task-phase transitions around the independent verifier. The verifier
 * itself remains the real kernel/artifact-backed runtime supplied by the
 * control-plane composition root.
 *
 * Transaction boundary: every phase transition appends its semantic event in
 * the same transaction as the task row CAS. Verification plan/result writes
 * happen in their own durable transaction before completion admission.
 */
export class VerificationCoordinator<TTransaction> {
  constructor(
    private readonly dependencies: VerificationCoordinatorDependencies<TTransaction>,
  ) {}

  async begin(taskId: string): Promise<boolean> {
    const current = await this.dependencies.readTask(taskId);
    if (current?.status !== "ACTIVE") return false;
    await this.transition({
      taskId,
      status: "VERIFYING",
      phase: "VERIFY",
      completedAt: null,
      terminalReasonJson: null,
      eventType: "task.verifying",
      payload: { phase: "VERIFY" },
    }, ["ACTIVE"]);
    return true;
  }

  async fail(taskId: string, reason: unknown): Promise<void> {
    await this.transition({
      taskId,
      status: "FAILED_VERIFICATION",
      phase: "VERIFY",
      completedAt: new Date(),
      terminalReasonJson: JSON.stringify(reason),
      eventType: "task.failed",
      payload: { phase: "VERIFY", status: "FAILED_VERIFICATION" },
    }, ["VERIFYING"]);
  }

  /**
   * Bounded verify–repair loop (deep-audit Rank 3): return an
   * ACTIVE/IMPLEMENT task to the actor with a durable repair directive so a
   * follow-up turn can attempt repair. Verification failures become
   * structured, inspectable repair inputs instead of a terminal state; the
   * task must still pass full required verification before any admission.
   */
  async scheduleRepair(
    taskId: string,
    input: {
      readonly repairAttemptId: string;
      readonly parentTurnId: string;
      readonly leaseKey: string;
      readonly attemptNumber: number;
      readonly directiveArtifactUri: string;
      readonly failedNodeIds: readonly string[];
      readonly failureSignatures?: readonly string[];
      readonly remainingAttempts?: number;
      readonly stopReason?: string;
      readonly maxAttempts?: number;
      readonly sourceRevision?: string;
      readonly changedFiles?: readonly string[];
      readonly environmentDigest?: string | null;
      readonly remainingBudgetJson?: string;
    },
  ): Promise<void> {
    await this.transition({
      taskId,
      status: "ACTIVE",
      phase: "IMPLEMENT",
      completedAt: null,
      terminalReasonJson: null,
      eventType: "task.repair_scheduled",
      payload: {
        phase: "IMPLEMENT",
        status: "ACTIVE",
        repair_attempt: input.attemptNumber,
        repair_attempt_id: input.repairAttemptId,
        directive_artifact: input.directiveArtifactUri,
        failed_nodes: [...input.failedNodeIds],
        ...(input.failureSignatures === undefined ? {} : { failure_signatures: [...input.failureSignatures] }),
        ...(input.sourceRevision === undefined ? {} : { source_revision: input.sourceRevision }),
        ...(input.remainingAttempts === undefined ? {} : { remaining_attempts: input.remainingAttempts }),
        ...(input.stopReason !== undefined ? { stop_reason: input.stopReason } : {}),
      },
      ...(input.maxAttempts === undefined || input.sourceRevision === undefined
        ? {}
        : {
            repairBudget: {
              maxAttempts: input.maxAttempts,
              attemptNumber: input.attemptNumber,
              failureSignatures: input.failureSignatures ?? [],
              sourceRevision: input.sourceRevision,
            },
          }),
      repairAttempt: {
        id: input.repairAttemptId,
        taskId,
        parentTurnId: input.parentTurnId,
        leaseKey: input.leaseKey,
        attemptNumber: input.attemptNumber,
        maxAttempts: input.maxAttempts ?? input.attemptNumber,
        directiveArtifact: input.directiveArtifactUri,
        failedNodeIds: [...input.failedNodeIds],
        failureSignatures: [...input.failureSignatures ?? []],
        changedFiles: [...input.changedFiles ?? []],
        sourceRevision: input.sourceRevision ?? "unknown",
        environmentDigest: input.environmentDigest ?? null,
        remainingBudgetJson: input.remainingBudgetJson ?? JSON.stringify({
          remaining_attempts: input.remainingAttempts ?? null,
        }),
      },
    }, ["VERIFYING"]);
  }

  async complete(
    taskId: string,
    verificationPlanId: string,
    turnId?: string,
    completionRecordId?: string,
  ): Promise<void> {
    const input: VerificationTransitionInput = {
      taskId,
      status: "COMPLETED",
      phase: "COMPLETE",
      completedAt: new Date(),
      terminalReasonJson: null,
      verificationPlanId,
      ...(completionRecordId === undefined ? {} : { completionRecordId }),
      eventType: "task.completed",
      payload: { phase: "COMPLETE", status: "COMPLETED", verification_plan_id: verificationPlanId },
    };
    if (turnId === undefined) {
      await this.transition(input, ["VERIFYING"]);
      return;
    }
    const updateTaskAndTurn = this.dependencies.updateTaskAndTurn;
    if (updateTaskAndTurn === undefined) {
      throw new Error("atomic task/turn completion admission is not configured");
    }
    await this.dependencies.mutate(async () => {
      await this.dependencies.appendEvent(
        {
          eventType: input.eventType,
          aggregateType: "task",
          aggregateId: taskId,
          correlationId: taskId,
          payload: input.payload,
        },
        async (transaction) => {
          await updateTaskAndTurn(transaction, input, ["VERIFYING"], turnId, "VERIFYING");
        },
      );
    });
    await this.dependencies.projectTask(taskId, input.eventType);
  }

  /**
   * No required predicate could run in this repository (no detected test
   * runner). The turn's work is finished and its evidence records *why*
   * nothing ran, so the turn settles as VERIFIED; the task remains steerable
   * in REVIEW because a skipped check is not proof of completion. Task and
   * turn move in one transaction.
   */
  async settleWithoutRunnableChecks(
    taskId: string,
    turnId: string,
    reason: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const updateTaskAndTurn = this.dependencies.updateTaskAndTurn;
    if (updateTaskAndTurn === undefined) {
      throw new Error("atomic task/turn settlement is not configured");
    }
    const input: VerificationTransitionInput = {
      taskId,
      status: "ACTIVE",
      phase: "REVIEW",
      completedAt: null,
      terminalReasonJson: null,
      eventType: "task.verification_not_runnable",
      payload: { phase: "REVIEW", status: "ACTIVE", ...reason },
    };
    await this.dependencies.mutate(async () => {
      await this.dependencies.appendEvent(
        {
          eventType: input.eventType,
          aggregateType: "task",
          aggregateId: taskId,
          correlationId: taskId,
          payload: input.payload,
        },
        async (transaction) => {
          await updateTaskAndTurn(transaction, input, ["VERIFYING"], turnId, "VERIFYING");
        },
      );
    });
    await this.dependencies.projectTask(taskId, input.eventType);
  }

  private async transition(
    input: VerificationTransitionInput,
    expectedStatuses: readonly string[],
  ): Promise<void> {
    await this.dependencies.mutate(async () => {
      await this.dependencies.appendEvent(
        {
          eventType: input.eventType,
          aggregateType: "task",
          aggregateId: input.taskId,
          correlationId: input.taskId,
          payload: input.payload,
        },
        async (transaction) => {
          await this.dependencies.updateTask(transaction, input, expectedStatuses);
          if (input.repairAttempt !== undefined) {
            const createRepairAttempt = this.dependencies.createRepairAttempt;
            if (createRepairAttempt === undefined) {
              throw new Error("durable repair-attempt persistence is not configured");
            }
            await createRepairAttempt(transaction, input.repairAttempt);
          }
        },
      );
    });
    await this.dependencies.projectTask(input.taskId, input.eventType);
  }
}

// ─────────────── Plan binding and completion decisions ──────────────────────
//
// The loop's verification phase derived the plan-resume decision (stale
// binding vs. resumable plan) and the completion-gate repair decision
// inline. Those are verification-coordinator decisions: they own the
// invalidation and completion semantics. They are testable without a
// kernel or database.

/**
 * Why an existing verification plan can no longer be resumed. Mirrors the
 * original derivation: null means the plan still describes the world.
 */
export type StalePlanBindingReason =
  | "missing_environment_digest"
  | "environment_changed"
  | "source_revision_changed";

export const stalePlanBindingReason = (input: {
  readonly existingPlan: { readonly sourceRevision: string; readonly environmentDigest: string | null } | null;
  readonly sourceRevision: string;
  readonly environmentDigest: string | null;
}): StalePlanBindingReason | null => {
  if (input.existingPlan === null) return null;
  if (input.existingPlan.environmentDigest === null) return "missing_environment_digest";
  if (input.existingPlan.environmentDigest !== input.environmentDigest) return "environment_changed";
  if (input.existingPlan.sourceRevision !== input.sourceRevision) return "source_revision_changed";
  return null;
};

/** Whether the restored plan matches the task contract still in force. */
export const restoredPlanMatchesContract = (input: {
  readonly restoredPlan: { readonly taskContractId: string; readonly taskContractVersion: number } | null;
  readonly taskId: string;
  readonly activeContractVersion: number;
}): boolean =>
  input.restoredPlan !== null
    && input.restoredPlan.taskContractId === input.taskId
    && input.restoredPlan.taskContractVersion === input.activeContractVersion;

/** Whether required-verification evidence exists to admit completion. */
export const verificationEvaluationPassed = (input: {
  readonly allRequiredPassed: boolean;
  readonly completionExpressionSatisfied: boolean;
}): boolean =>
  input.allRequiredPassed && input.completionExpressionSatisfied;

/**
 * Which completion-gate failure set drives repair. When required predicates
 * passed but admission was refused, the missing claims (or the gate itself)
 * become repair inputs. The evidence-graph gap, not the change, is the
 * failure.
 */
export const completionGateRepairInputs = (input: {
  readonly requiredClaimIds: readonly string[];
  readonly admissibleClaimIds: readonly string[];
}): { readonly missingClaimIds: readonly string[]; readonly failureNodeIds: readonly string[] } => {
  const admissible = new Set(input.admissibleClaimIds);
  const missingClaimIds = input.requiredClaimIds.filter((claimId) => !admissible.has(claimId));
  const failureNodeIds = missingClaimIds.length > 0 ? missingClaimIds : ["completion-gate"];
  return { missingClaimIds, failureNodeIds };
};
