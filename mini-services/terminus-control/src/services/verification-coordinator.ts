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
}

export interface VerificationCoordinatorDependencies<TTransaction> {
  readonly readTask: (taskId: string) => Promise<VerificationTaskState | null>;
  readonly appendEvent: ServiceEventAppender<TTransaction>;
  readonly updateTask: (
    transaction: TTransaction,
    input: VerificationTransitionInput,
    expectedStatuses: readonly string[],
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

  async complete(taskId: string, verificationPlanId: string): Promise<void> {
    await this.transition({
      taskId,
      status: "COMPLETED",
      phase: "COMPLETE",
      completedAt: new Date(),
      terminalReasonJson: null,
      verificationPlanId,
      eventType: "task.completed",
      payload: { phase: "COMPLETE", status: "COMPLETED" },
    }, ["VERIFYING"]);
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
