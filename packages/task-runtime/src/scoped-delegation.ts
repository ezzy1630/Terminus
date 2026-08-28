/**
 * Durable scoped-delegation admission and recovery.
 *
 * This module owns the control-plane half of delegation. It never launches a
 * worker or interprets provider output. A kernel implementation must return a
 * trusted, identity-bound receipt before the durable record can advance.
 */
import { z } from "zod";
import type {
  ContentHash,
  DelegationContractV2,
  OutboxMessage,
  Rfc3339Timestamp,
  ScopedDelegationExecution,
  ScopedDelegationState,
} from "@terminus/domain";
import {
  contentHashSchema,
  delegationContractV2Schema,
  IdempotencyConflictError,
  isScopedDelegationTransitionAllowed,
  NotFoundError,
  rfc3339Schema,
  scopedDelegationExecutionSchema,
  StateTransitionError,
  TimeoutError,
  ValidationError,
  nowTimestamp,
  artifactRefSchema,
  scopedDelegationEvidenceReturnSchema,
} from "@terminus/domain";
import type { DurableTaskRepository } from "./types.js";
import { sha256Hex, TransactionalOutbox } from "./outbox.js";

const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;
const DEFAULT_RECOVERY_TIMEOUT_MS = 10_000;

/** Request sent across the provider-neutral kernel boundary. */
export interface ScopedDelegationKernelRequest {
  readonly executionId: string;
  readonly taskId: string;
  readonly parentTurnId: string;
  readonly contractHash: ContentHash;
  readonly requestHash: ContentHash;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly recovery: boolean;
}

export const scopedDelegationKernelRequestSchema = z
  .object({
    executionId: z.string().min(1),
    taskId: z.string().min(1),
    parentTurnId: z.string().min(1),
    contractHash: contentHashSchema,
    requestHash: contentHashSchema,
    idempotencyKey: z.string().min(1),
    attempt: z.number().int().positive(),
    recovery: z.boolean(),
  })
  .strict();

/**
 * Receipt returned by a trusted `terminus.kernel.v1` implementation.
 *
 * `trusted: true` is a boundary marker, not a claim a public client may set:
 * only the configured kernel port is allowed to produce this value.
 */
export const scopedDelegationKernelReceiptSchema = z
  .object({
    source: z.literal("terminus.kernel.v1"),
    trusted: z.literal(true),
    executionId: z.string().min(1),
    taskId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    requestHash: contentHashSchema,
    attempt: z.number().int().positive(),
    status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "BLOCKED", "INTERRUPTED", "UNKNOWN"]),
    workerId: z.string().min(1).nullable(),
    leaseId: z.string().min(1).nullable(),
    fencingToken: z.number().int().positive().nullable(),
    operationHash: contentHashSchema,
    receiptArtifact: artifactRefSchema,
    evidence: scopedDelegationEvidenceReturnSchema.nullable(),
    observedAt: rfc3339Schema,
    recoveryRequired: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const leaseFields = [value.workerId, value.leaseId, value.fencingToken];
    const hasLease = leaseFields.some((field) => field !== null);
    const completeLease = leaseFields.every((field) => field !== null);
    if (hasLease && !completeLease) {
      context.addIssue({
        code: "custom",
        path: ["fencingToken"],
        message: "worker, lease, and fencing token must be bound together",
      });
    }
    if (value.status === "RUNNING" && !completeLease) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "running receipt requires a worker lease and fencing token",
      });
    }
    if (["RUNNING", "INTERRUPTED", "UNKNOWN"].includes(value.status) && value.evidence !== null) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: `${value.status.toLowerCase()} receipt cannot settle delegated evidence`,
      });
    }
    if (["SUCCEEDED", "FAILED", "BLOCKED"].includes(value.status) && value.evidence === null) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: `${value.status.toLowerCase()} receipt must include compact evidence`,
      });
    }
    if (value.status === "UNKNOWN" && !value.recoveryRequired) {
      context.addIssue({
        code: "custom",
        path: ["recoveryRequired"],
        message: "unknown receipt must require reconciliation",
      });
    }
  });

export type ScopedDelegationKernelReceipt = z.infer<typeof scopedDelegationKernelReceiptSchema>;

/** Kernel-only effect boundary; this interface contains no executor fallback. */
export interface ScopedDelegationKernelPort {
  start(request: ScopedDelegationKernelRequest, signal: AbortSignal): Promise<ScopedDelegationKernelReceipt>;
  recover(request: ScopedDelegationKernelRequest, signal: AbortSignal): Promise<ScopedDelegationKernelReceipt>;
}

export interface AdmitScopedDelegationInput {
  readonly id?: string;
  readonly taskId: string;
  readonly parentTurnId: string;
  readonly contract: DelegationContractV2;
  readonly idempotencyKey: string;
  readonly maxRecoveryAttempts?: number;
}

export interface ScopedDelegationAdmission {
  readonly execution: ScopedDelegationExecution;
  readonly duplicate: boolean;
}

export interface ScopedDelegationRecoveryResult {
  readonly execution: ScopedDelegationExecution;
  readonly outcome: "recovered" | "interrupted" | "manual_review";
}

export interface DurableScopedDelegationServiceOptions {
  readonly repo: DurableTaskRepository;
  readonly kernel: ScopedDelegationKernelPort;
  readonly idSource?: () => string;
  readonly clock?: () => Rfc3339Timestamp;
  readonly recoveryTimeoutMs?: number;
  readonly maxRecoveryAttempts?: number;
}

/** Durable coordinator for scoped worker admission, settlement, and recovery. */
export class DurableScopedDelegationService {
  private readonly repo: DurableTaskRepository;
  private readonly kernel: ScopedDelegationKernelPort;
  private readonly idSource: () => string;
  private readonly clock: () => Rfc3339Timestamp;
  private readonly outbox: TransactionalOutbox;
  private readonly recoveryTimeoutMs: number;
  private readonly defaultMaxRecoveryAttempts: number;
  private readonly inFlightStarts = new Map<string, Promise<ScopedDelegationExecution>>();

  constructor(options: DurableScopedDelegationServiceOptions) {
    if (!Number.isInteger(options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS)
      || (options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS) <= 0) {
      throw new ValidationError("scoped delegation recovery timeout must be a positive integer");
    }
    if (!Number.isInteger(options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS)
      || (options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS) <= 0) {
      throw new ValidationError("scoped delegation recovery attempts must be a positive integer");
    }
    this.repo = options.repo;
    this.kernel = options.kernel;
    this.idSource = options.idSource ?? (() => `scoped-delegation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.clock = options.clock ?? (() => nowTimestamp());
    this.outbox = new TransactionalOutbox(this.repo, this.idSource, this.clock);
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
    this.defaultMaxRecoveryAttempts = options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
  }

  /**
   * Persist an admitted contract before any kernel dispatch. Repeating the
   * same task/key returns the original record; a different request conflicts.
   */
  async admit(input: AdmitScopedDelegationInput): Promise<ScopedDelegationAdmission> {
    if (input.taskId.trim().length === 0 || input.parentTurnId.trim().length === 0) {
      throw new ValidationError("scoped delegation task and parent turn are required");
    }
    if (input.idempotencyKey.trim().length === 0) {
      throw new ValidationError("scoped delegation idempotency key is required");
    }
    const contract = this.parseContract(input.contract, input.taskId);
    const maxRecoveryAttempts = input.maxRecoveryAttempts ?? this.defaultMaxRecoveryAttempts;
    if (!Number.isInteger(maxRecoveryAttempts) || maxRecoveryAttempts <= 0) {
      throw new ValidationError("scoped delegation recovery attempts must be a positive integer");
    }

    const contractHash = hashValue(contract);
    const requestHash = hashValue({
      taskId: input.taskId,
      parentTurnId: input.parentTurnId,
      contractHash,
      idempotencyKey: input.idempotencyKey,
      maxRecoveryAttempts,
    });
    const existing = await this.repo.getScopedDelegationByIdempotencyKey(
      input.taskId,
      input.idempotencyKey,
    );
    if (existing !== null) {
      if (existing.requestHash !== requestHash) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      return { execution: existing, duplicate: true };
    }

    const timestamp = this.clock();
    const execution = scopedDelegationExecutionSchema.parse({
      id: input.id ?? this.idSource(),
      taskId: input.taskId,
      parentTurnId: input.parentTurnId,
      contract,
      contractHash,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      workerId: null,
      leaseId: null,
      fencingToken: null,
      attempt: 1,
      state: "ADMITTED",
      result: null,
      lastReceiptArtifact: null,
      lastOperationHash: null,
      recovery: {
        restartCount: 0,
        maxAttempts: maxRecoveryAttempts,
        lastRecoveredAt: null,
        reason: null,
        nextAction: "resume",
      },
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const outboxMessage = this.eventFor(execution, "agent.spawned", {
      agentId: execution.id,
      sessionId: execution.parentTurnId,
      role: execution.contract.role,
      parentAgentId: execution.parentTurnId,
      worktreeId: null,
    });
    const saved = await this.repo.createScopedDelegation(execution, outboxMessage);
    return {
      execution: saved,
      duplicate: saved.id !== execution.id,
    };
  }

  /** Start an admitted execution through the trusted kernel port. */
  async start(executionId: string): Promise<ScopedDelegationExecution> {
    const inFlight = this.inFlightStarts.get(executionId);
    if (inFlight !== undefined) return inFlight;
    const pending = this.startOnce(executionId);
    this.inFlightStarts.set(executionId, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlightStarts.get(executionId) === pending) this.inFlightStarts.delete(executionId);
    }
  }

  private async startOnce(executionId: string): Promise<ScopedDelegationExecution> {
    const execution = await this.requireExecution(executionId);
    if (isTerminal(execution.state)) return execution;
    if (execution.state !== "ADMITTED") {
      throw new StateTransitionError("scoped delegation", execution.state, "RUNNING");
    }
    return this.dispatch(execution, false, execution.attempt);
  }

  /**
   * Reconcile recoverable records after process restart. Every attempt is
   * bounded by the configured timeout and the durable per-execution limit;
   * unknown or exhausted executions stop at MANUAL_REVIEW.
   */
  async recoverAfterRestart(taskId?: string): Promise<readonly ScopedDelegationRecoveryResult[]> {
    const recoverable = await this.repo.listRecoverableScopedDelegations(taskId);
    const results: ScopedDelegationRecoveryResult[] = [];
    for (const candidate of recoverable) {
      const current = await this.requireExecution(candidate.id);
      if (isTerminal(current.state)) continue;
      if (current.recovery.restartCount >= current.recovery.maxAttempts) {
        const manual = await this.persistManualReview(current, "bounded recovery attempts exhausted");
        results.push({ execution: manual, outcome: "manual_review" });
        continue;
      }
      const admitted = current.state === "PENDING"
        ? await this.persistState(current, "ADMITTED", {
          recovery: {
            ...current.recovery,
            nextAction: "resume",
          },
        }, "recovery.reconciled", { reason: "restart admission replay" })
        : current;
      const recovered = await this.dispatch(admitted, true, admitted.attempt + 1);
      results.push({
        execution: recovered,
        outcome: recovered.state === "MANUAL_REVIEW"
          ? "manual_review"
          : recovered.state === "INTERRUPTED"
            ? "interrupted"
            : "recovered",
      });
    }
    return results;
  }

  private async dispatch(
    execution: ScopedDelegationExecution,
    recovery: boolean,
    attempt: number,
  ): Promise<ScopedDelegationExecution> {
    const request = scopedDelegationKernelRequestSchema.parse({
      executionId: execution.id,
      taskId: execution.taskId,
      parentTurnId: execution.parentTurnId,
      contractHash: execution.contractHash,
      requestHash: execution.requestHash,
      idempotencyKey: execution.idempotencyKey,
      attempt,
      recovery,
    });

    let receipt: ScopedDelegationKernelReceipt;
    try {
      receipt = await this.callKernel(request, recovery);
    } catch (error: unknown) {
      return this.persistKernelFailure(execution, attempt, recovery, errorMessage(error));
    }

    try {
      return await this.applyReceipt(execution, receipt, attempt, recovery);
    } catch (error: unknown) {
      return this.persistManualReview(execution, `invalid kernel receipt: ${errorMessage(error)}`, recovery);
    }
  }

  private async callKernel(
    request: ScopedDelegationKernelRequest,
    recovery: boolean,
  ): Promise<ScopedDelegationKernelReceipt> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(
          recovery ? "scoped delegation recovery" : "scoped delegation start",
          this.recoveryTimeoutMs,
        ));
      }, this.recoveryTimeoutMs);
    });
    try {
      const operation = recovery
        ? this.kernel.recover(request, controller.signal)
        : this.kernel.start(request, controller.signal);
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  private async applyReceipt(
    execution: ScopedDelegationExecution,
    rawReceipt: unknown,
    attempt: number,
    recovery: boolean,
  ): Promise<ScopedDelegationExecution> {
    const receipt = scopedDelegationKernelReceiptSchema.parse(rawReceipt);
    if (
      receipt.executionId !== execution.id
      || receipt.taskId !== execution.taskId
      || receipt.idempotencyKey !== execution.idempotencyKey
      || receipt.requestHash !== execution.requestHash
      || receipt.attempt !== attempt
    ) {
      throw new ValidationError("kernel receipt is not bound to the delegated execution", {
        executionId: execution.id,
        receiptExecutionId: receipt.executionId,
      });
    }

    const nextState = receiptState(receipt.status);
    const boundedRecoveryCount = recovery
      ? execution.recovery.restartCount + 1
      : execution.recovery.restartCount;
    const exhausted = boundedRecoveryCount >= execution.recovery.maxAttempts;
    const effectiveState = receipt.status === "UNKNOWN"
      || (receipt.status === "INTERRUPTED" && recovery && exhausted)
      ? "MANUAL_REVIEW"
      : nextState;
    const evidence = receipt.evidence;
    if (
      (effectiveState === "SUCCEEDED" && evidence?.status !== "completed")
      || (effectiveState === "FAILED" && evidence?.status !== "failed")
      || (effectiveState === "BLOCKED"
        && !["blocked", "budget_exhausted", "policy_denied"].includes(evidence?.status ?? ""))
    ) {
      throw new ValidationError("kernel evidence status does not match execution settlement", {
        state: effectiveState,
        evidenceStatus: evidence?.status,
      });
    }
    const recoveryState = this.nextRecoveryState(
      execution,
      effectiveState,
      recovery,
      boundedRecoveryCount,
      receipt.status === "UNKNOWN" ? "kernel returned UNKNOWN settlement" : null,
    );
    return this.persistState(execution, effectiveState, {
      attempt,
      workerId: effectiveState === "RUNNING" ? receipt.workerId : null,
      leaseId: effectiveState === "RUNNING" ? receipt.leaseId : null,
      fencingToken: effectiveState === "RUNNING" ? receipt.fencingToken : null,
      result: evidence,
      lastReceiptArtifact: receipt.receiptArtifact,
      lastOperationHash: receipt.operationHash,
      recovery: recoveryState,
    }, recovery ? "recovery.reconciled" : eventTypeForState(effectiveState), {
      operationHash: receipt.operationHash,
      receiptArtifact: receipt.receiptArtifact,
      kernelStatus: receipt.status,
    });
  }

  private async persistKernelFailure(
    execution: ScopedDelegationExecution,
    attempt: number,
    recovery: boolean,
    reason: string,
  ): Promise<ScopedDelegationExecution> {
    const restartCount = recovery ? execution.recovery.restartCount + 1 : execution.recovery.restartCount;
    const exhausted = restartCount >= execution.recovery.maxAttempts;
    const state: ScopedDelegationState = exhausted ? "MANUAL_REVIEW" : "INTERRUPTED";
    return this.persistState(execution, state, {
      attempt,
      workerId: null,
      leaseId: null,
      fencingToken: null,
      recovery: this.nextRecoveryState(execution, state, recovery, restartCount, reason),
    }, recovery ? "recovery.reconciled" : "recovery.reconciled", { reason });
  }

  private async persistManualReview(
    execution: ScopedDelegationExecution,
    reason: string,
    recovery = false,
  ): Promise<ScopedDelegationExecution> {
    const restartCount = recovery ? execution.recovery.restartCount + 1 : execution.recovery.restartCount;
    return this.persistState(execution, "MANUAL_REVIEW", {
      workerId: null,
      leaseId: null,
      fencingToken: null,
      recovery: this.nextRecoveryState(execution, "MANUAL_REVIEW", recovery, restartCount, reason),
    }, "recovery.reconciled", { reason });
  }

  private nextRecoveryState(
    execution: ScopedDelegationExecution,
    state: ScopedDelegationState,
    recovery: boolean,
    restartCount: number,
    reason: string | null,
  ): ScopedDelegationExecution["recovery"] {
    const nextAction = state === "MANUAL_REVIEW"
      ? "manual_review"
      : state === "INTERRUPTED"
        ? "reconcile"
        : "resume";
    return {
      restartCount,
      maxAttempts: execution.recovery.maxAttempts,
      lastRecoveredAt: recovery ? this.clock() : execution.recovery.lastRecoveredAt,
      reason,
      nextAction,
    };
  }

  private async persistState(
    execution: ScopedDelegationExecution,
    state: ScopedDelegationState,
    changes: Partial<ScopedDelegationExecution>,
    eventType: string,
    eventDetails: Readonly<Record<string, unknown>>,
  ): Promise<ScopedDelegationExecution> {
    if (state !== execution.state && !isScopedDelegationTransitionAllowed(execution.state, state)) {
      throw new StateTransitionError("scoped delegation", execution.state, state);
    }
    const updated = scopedDelegationExecutionSchema.parse({
      ...execution,
      ...changes,
      state,
      version: execution.version + 1,
      updatedAt: this.clock(),
    });
    const outboxMessage = this.eventFor(updated, eventType, {
      previousState: execution.state,
      state: updated.state,
      executionId: updated.id,
      taskId: updated.taskId,
      attempt: updated.attempt,
      requestHash: updated.requestHash,
      ...eventDetails,
    });
    return this.repo.updateScopedDelegation(updated, outboxMessage);
  }

  private eventFor(
    execution: ScopedDelegationExecution,
    eventType: string,
    payload: Record<string, unknown>,
  ): OutboxMessage {
    const eventPayload = eventType === "agent.completed"
      ? {
        ...payload,
        agentId: execution.id,
        status: execution.state,
        completedAt: execution.updatedAt,
      }
      : eventType === "agent.spawned"
        ? {
          ...payload,
          agentId: execution.id,
          sessionId: execution.parentTurnId,
          role: execution.contract.role,
          parentAgentId: execution.parentTurnId,
          worktreeId: null,
        }
        : payload;
    return this.outbox.createMessage(
      "agent",
      execution.id,
      execution.version,
      eventType,
      eventPayload,
      execution.idempotencyKey,
    );
  }

  private parseContract(raw: DelegationContractV2, taskId: string): DelegationContractV2 {
    const contract = delegationContractV2Schema.safeParse(raw);
    if (!contract.success) {
      throw new ValidationError("scoped delegation contract failed validation", {
        issues: contract.error.issues.map((issue) => issue.message),
      });
    }
    if (contract.data.parentTaskId !== taskId) {
      throw new ValidationError("scoped delegation contract must bind to the task", {
        taskId,
        parentTaskId: contract.data.parentTaskId,
      });
    }
    return contract.data;
  }

  private async requireExecution(id: string): Promise<ScopedDelegationExecution> {
    const execution = await this.repo.getScopedDelegation(id);
    if (execution === null) throw new NotFoundError("scoped delegation", id);
    return scopedDelegationExecutionSchema.parse(execution);
  }
}

function hashValue(value: unknown): ContentHash {
  return contentHashSchema.parse(`sha256:${sha256Hex(stableJson(value))}`);
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() });
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function receiptState(
  status: ScopedDelegationKernelReceipt["status"],
): ScopedDelegationState {
  switch (status) {
    case "RUNNING":
      return "RUNNING";
    case "SUCCEEDED":
      return "SUCCEEDED";
    case "FAILED":
      return "FAILED";
    case "BLOCKED":
      return "BLOCKED";
    case "INTERRUPTED":
      return "INTERRUPTED";
    case "UNKNOWN":
      return "MANUAL_REVIEW";
  }
}

function eventTypeForState(state: ScopedDelegationState): string {
  return isTerminal(state) ? "agent.completed" : "agent.spawned";
}

function isTerminal(state: ScopedDelegationState): boolean {
  return ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED", "MANUAL_REVIEW"].includes(state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
