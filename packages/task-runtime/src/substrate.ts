/**
 * @terminus/task-runtime — Durable Task Substrate Coordinator.
 *
 * Per SPEC §6, §7, §8, §10, §14, §28, §29:
 * Unified coordinator unifying task lifecycle, workflow execution, worker leases,
 * transactional outbox/inbox relay, decision tracking, and recovery replay.
 */
import type {
  TaskV2,
  TaskContractV2,
  TaskStatusV2,
  TaskAttempt,
  AttemptStatus,
  Rfc3339Timestamp,
  PrincipalId,
} from "@terminus/domain";
import {
  isTaskV2TransitionAllowed,
  isTaskV2Terminal,
  isAttemptTransitionAllowed,
  nowTimestamp,
} from "@terminus/domain";
import type { EventEnvelopeV2 } from "@terminus/runtime-protocol";
import type { DurableTaskRepository } from "./types.js";
import { TransactionalOutbox, TransactionalInbox } from "./outbox.js";
import { WorkerLeaseManager } from "./leases.js";
import { WorkflowEngine } from "./workflows.js";
import { DecisionRiskBudgetManager } from "./decisions.js";

export class TaskSubstrateError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "TaskSubstrateError";
  }
}

export class DurableTaskSubstrate {
  readonly outbox: TransactionalOutbox;
  readonly inbox: TransactionalInbox;
  readonly leases: WorkerLeaseManager;
  readonly workflows: WorkflowEngine;
  readonly decisions: DecisionRiskBudgetManager;

  constructor(
    readonly repo: DurableTaskRepository,
    private readonly idSource: () => string = () => `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly attemptIdSource: () => string = () => `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly clock: () => Rfc3339Timestamp = () => nowTimestamp(),
  ) {
    this.outbox = new TransactionalOutbox(this.repo, undefined, this.clock);
    this.inbox = new TransactionalInbox(this.repo, undefined, this.clock);
    this.leases = new WorkerLeaseManager(this.repo, this.outbox, undefined, this.clock);
    this.workflows = new WorkflowEngine(this.repo, this.outbox, undefined, undefined, this.clock);
    this.decisions = new DecisionRiskBudgetManager(this.repo, this.outbox, undefined, undefined, undefined, this.clock);
  }

  async createTask(input: {
    readonly missionId?: string | null | undefined;
    readonly organizationId?: string | undefined;
    readonly departmentId?: string | undefined;
    readonly createdBy?: string | undefined;
    readonly contract: TaskContractV2;
  }): Promise<TaskV2> {
    const now = this.clock();
    const id = this.idSource();
    const task: TaskV2 = {
      id,
      missionId: input.missionId ?? null,
      organizationId: input.organizationId ?? "default-org",
      departmentId: input.departmentId ?? "default-dept",
      createdBy: input.createdBy ?? "principal:user",
      contract: input.contract,
      status: "DRAFT",
      version: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    const outboxMsg = this.outbox.createMessage(
      "task",
      task.id,
      1,
      "task.created",
      {
        taskId: task.id,
        missionId: task.missionId,
        organizationId: task.organizationId,
        departmentId: task.departmentId,
        objective: task.contract.mission,
        contractVersion: task.contract.version,
        mode: task.contract.mode,
      },
    );

    return this.repo.createTaskV2(task, outboxMsg);
  }

  async transitionTask(
    taskId: string,
    to: TaskStatusV2,
    expectedVersion: number | null = null,
    reason: string | null = null,
    principal = "principal:system",
  ): Promise<TaskV2> {
    const task = await this.repo.getTaskV2(taskId);
    if (!task) {
      throw new TaskSubstrateError(`Task ${taskId} not found`);
    }

    if (expectedVersion !== null && task.version !== expectedVersion) {
      throw new TaskSubstrateError(
        `Optimistic concurrency conflict on task ${taskId}: expected version ${expectedVersion}, found ${task.version}`,
      );
    }

    if (task.status === to) {
      return task;
    }

    if (isTaskV2Terminal(task.status)) {
      throw new TaskSubstrateError(
        `Cannot transition from terminal task status ${task.status} to ${to}`,
      );
    }

    if (!isTaskV2TransitionAllowed(task.status, to)) {
      throw new TaskSubstrateError(
        `Illegal transition from task status ${task.status} to ${to}`,
      );
    }

    const now = this.clock();
    const nextVersion = task.version + 1;
    const completedAt =
      to === "COMPLETED" || to === "PARTIAL" || to === "CANCELLED" || to === "FAILED"
        ? now
        : null;

    const updated: TaskV2 = {
      ...task,
      status: to,
      version: nextVersion,
      updatedAt: now,
      completedAt,
    };

    const eventType = `task.${to.toLowerCase()}`;
    const outboxMsg = this.outbox.createMessage(
      "task",
      updated.id,
      nextVersion,
      eventType,
      {
        taskId: updated.id,
        fromStatus: task.status,
        toStatus: to,
        version: nextVersion,
        reason,
      },
    );

    return this.repo.updateTaskV2(updated, outboxMsg);
  }

  async updateContract(
    taskId: string,
    contract: TaskContractV2,
    expectedVersion: number | null = null,
  ): Promise<TaskV2> {
    const task = await this.repo.getTaskV2(taskId);
    if (!task) {
      throw new TaskSubstrateError(`Task ${taskId} not found`);
    }

    if (expectedVersion !== null && task.version !== expectedVersion) {
      throw new TaskSubstrateError(
        `Optimistic concurrency conflict on task ${taskId}: expected version ${expectedVersion}, found ${task.version}`,
      );
    }

    if (contract.version <= task.contract.version) {
      throw new TaskSubstrateError(
        `New contract version (${contract.version}) must exceed previous version (${task.contract.version})`,
      );
    }

    const now = this.clock();
    const nextVersion = task.version + 1;
    const updated: TaskV2 = {
      ...task,
      contract,
      version: nextVersion,
      updatedAt: now,
    };

    const outboxMsg = this.outbox.createMessage(
      "task",
      updated.id,
      nextVersion,
      "task.contract_updated",
      {
        taskId: updated.id,
        previousContractVersion: task.contract.version,
        newContractVersion: contract.version,
        version: nextVersion,
      },
    );

    return this.repo.updateTaskV2(updated, outboxMsg);
  }

  async startAttempt(
    taskId: string,
    workerId: string,
    fencingToken: number,
  ): Promise<TaskAttempt> {
    const valid = await this.leases.verifyFencingToken(taskId, workerId, fencingToken);
    if (!valid) {
      throw new TaskSubstrateError(
        `Worker ${workerId} does not hold a valid fencing token (${fencingToken}) for task ${taskId}`,
      );
    }

    const attempts = await this.repo.listAttempts(taskId);
    const attemptNumber = attempts.length + 1;
    const now = this.clock();

    const attempt: TaskAttempt = {
      id: this.attemptIdSource(),
      taskId,
      attemptNumber,
      workerId,
      fencingToken,
      status: "RUNNING",
      startedAt: now,
      settledAt: null,
      error: null,
    };

    const outboxMsg = this.outbox.createMessage(
      "attempt",
      attempt.id,
      1,
      "attempt.started",
      {
        attemptId: attempt.id,
        taskId,
        attemptNumber,
        workerId,
        fencingToken,
      },
    );

    return this.repo.createAttempt(attempt, outboxMsg);
  }

  async settleAttempt(
    attemptId: string,
    status: AttemptStatus,
    error: string | null = null,
  ): Promise<TaskAttempt> {
    const attempt = await this.repo.getAttempt(attemptId);
    if (!attempt) {
      throw new TaskSubstrateError(`Attempt ${attemptId} not found`);
    }

    if (!isAttemptTransitionAllowed(attempt.status, status)) {
      throw new TaskSubstrateError(
        `Illegal attempt transition from ${attempt.status} to ${status}`,
      );
    }

    const now = this.clock();
    const updated: TaskAttempt = {
      ...attempt,
      status,
      error,
      settledAt: now,
    };

    const eventType = status === "COMPLETED" ? "attempt.completed" : "attempt.failed";
    const outboxMsg = this.outbox.createMessage(
      "attempt",
      updated.id,
      2,
      eventType,
      {
        attemptId: updated.id,
        taskId: updated.taskId,
        attemptNumber: updated.attemptNumber,
        error,
      },
    );

    return this.repo.updateAttempt(updated, outboxMsg);
  }

  async recover(events: readonly EventEnvelopeV2[]): Promise<void> {
    await this.repo.replayFromEvents(events);
  }
}
