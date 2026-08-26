import type { MutationRunner, ServiceEventAppender } from "./service-types.js";

export interface VerificationTaskState {
  readonly status: string;
}

export interface VerificationTransitionInput {
  readonly taskId: string;
  readonly status: string;
  readonly phase: string;
  readonly completedAt: Date | null;
  readonly terminalReasonJson: string | null;
  readonly verificationPlanId?: string | null;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly repairBudget?: {
    readonly maxAttempts: number;
    readonly attemptNumber: number;
    readonly failureSignatures: readonly string[];
    readonly sourceRevision: string;
  };
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
   * ACTIVE/EXECUTE task to the actor with a durable repair directive so a
   * follow-up turn can attempt repair. Verification failures become
   * structured, inspectable repair inputs instead of a terminal state; the
   * task must still pass full required verification before any admission.
   */
  async scheduleRepair(
    taskId: string,
    input: {
      readonly attemptNumber: number;
      readonly directiveArtifactUri: string;
      readonly failedNodeIds: readonly string[];
      readonly failureSignatures?: readonly string[];
      readonly remainingAttempts?: number;
      readonly stopReason?: string;
      readonly maxAttempts?: number;
      readonly sourceRevision?: string;
    },
  ): Promise<void> {
    await this.transition({
      taskId,
      status: "ACTIVE",
      phase: "EXECUTE",
      completedAt: null,
      terminalReasonJson: null,
      eventType: "task.repair_scheduled",
      payload: {
        phase: "EXECUTE",
        status: "ACTIVE",
        repair_attempt: input.attemptNumber,
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
    }, ["VERIFYING"]);
  }

  async complete(taskId: string, verificationPlanId: string, turnId?: string): Promise<void> {
    const input: VerificationTransitionInput = {
      taskId,
      status: "COMPLETED",
      phase: "COMPLETE",
      completedAt: new Date(),
      terminalReasonJson: null,
      verificationPlanId,
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
        },
      );
    });
    await this.dependencies.projectTask(input.taskId, input.eventType);
  }
}
