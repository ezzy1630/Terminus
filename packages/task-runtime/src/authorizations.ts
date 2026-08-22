/**
 * @terminus/task-runtime — Durable Authorization Instances & Consumption (SPEC §14, §15).
 *
 * Replaces the operation-hash scan/consume model with exact, durable,
 * task-version-bound, single-use or count-bounded AuthorizationInstance records.
 *
 * Invariants:
 * 1. An authorization instance cannot be consumed across different tasks.
 * 2. An authorization instance cannot be consumed after a task contract version bump (replanning).
 * 3. Consumptions are atomic and monotonic up to `useLimit`.
 * 4. Approval text shown to the user is hash-bound via `approvalHash`; material changes invalidate approval.
 */
import type { AuthorizationInstance, Rfc3339Timestamp } from "@terminus/domain";
import {
  authorizationInstanceSchema,
  ScopeViolationError,
  ValidationError,
} from "@terminus/domain";
import type { DurableTaskRepository } from "./types.js";
import { TransactionalOutbox } from "./outbox.js";

export interface CreateAuthorizationInput {
  readonly id: string;
  readonly principal: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly effectClass: string;
  readonly maxScope: readonly string[];
  readonly useLimit?: number;
  readonly expiry: Rfc3339Timestamp;
  readonly humanApprovalId?: string | null;
  readonly approvalHash?: string | null;
}

export class AuthorizationManager {
  constructor(
    private readonly repo: DurableTaskRepository,
    private readonly outbox: TransactionalOutbox
  ) {}

  /**
   * Create and persist a new durable AuthorizationInstance.
   */
  async createAuthorization(input: CreateAuthorizationInput): Promise<AuthorizationInstance> {
    const authz: AuthorizationInstance = {
      id: input.id,
      principal: input.principal,
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      effectClass: input.effectClass,
      maxScope: input.maxScope,
      useLimit: input.useLimit ?? 1,
      consumedCount: 0,
      expiry: input.expiry,
      humanApprovalId: input.humanApprovalId ?? null,
      approvalHash: input.approvalHash ?? null,
    };

    authorizationInstanceSchema.parse(authz);

    const outboxMessage = this.outbox.createMessage(
      "authorization",
      authz.id,
      1,
      "authorization.created",
      {
        authorizationId: authz.id,
        taskId: authz.taskId,
        taskVersion: authz.taskVersion,
        effectClass: authz.effectClass,
        useLimit: authz.useLimit,
        expiry: authz.expiry,
      }
    );

    return this.repo.createAuthorization(authz, outboxMessage);
  }

  /**
   * Look up an authorization instance by ID.
   */
  async getAuthorization(id: string): Promise<AuthorizationInstance | null> {
    return this.repo.getAuthorization(id);
  }

  /**
   * Atomically validate and consume an authorization instance for an effect.
   */
  async consumeAuthorization(
    authzId: string,
    context: {
      readonly taskId: string;
      readonly taskVersion: number;
      readonly effectClass: string;
      readonly requestedScope?: readonly string[];
      readonly approvalHash?: string | null;
      readonly principal?: string;
    }
  ): Promise<AuthorizationInstance> {
    const authz = await this.repo.getAuthorization(authzId);
    if (!authz) {
      throw new ValidationError(`Authorization instance not found: ${authzId}`);
    }

    // 1. Cross-task rejection
    if (authz.taskId !== context.taskId) {
      throw new ScopeViolationError(
        `Cross-task authorization rejected: authorization ${authzId} is bound to task ${authz.taskId}, requested for task ${context.taskId}`
      );
    }

    // 2. Task version / replanning invalidation
    if (authz.taskVersion !== context.taskVersion) {
      throw new ValidationError(
        `Stale authorization rejected: authorization ${authzId} is bound to task version ${authz.taskVersion}, but current task version is ${context.taskVersion}`
      );
    }

    // 3. Expiry check
    const now = new Date().toISOString();
    if (now >= authz.expiry) {
      throw new ValidationError(
        `Expired authorization rejected: authorization ${authzId} expired at ${authz.expiry} (current: ${now})`
      );
    }

    // 4. Use count / exhaustion check
    if (authz.consumedCount >= authz.useLimit) {
      throw new ValidationError(
        `Exhausted authorization rejected: authorization ${authzId} reached use limit of ${authz.useLimit}`
      );
    }

    // 5. Effect class check
    if (authz.effectClass !== context.effectClass && authz.effectClass !== "ADMIN") {
      throw new ScopeViolationError(
        `Operation class mismatch: authorization ${authzId} authorizes '${authz.effectClass}', effect requested '${context.effectClass}'`
      );
    }

    // 6. Approval hash matching (material action validation)
    if (authz.approvalHash && context.approvalHash && authz.approvalHash !== context.approvalHash) {
      throw new ValidationError(
        `Approval hash mismatch: authorization proposal was altered prior to execution (expected ${authz.approvalHash}, got ${context.approvalHash})`
      );
    }

    // 7. Scope containment check
    if (context.requestedScope && authz.maxScope.length > 0) {
      for (const reqPath of context.requestedScope) {
        const matches = authz.maxScope.some((pattern) => {
          if (pattern === "**" || pattern === "*") return true;
          return reqPath.startsWith(pattern.replace(/\/\*\*$/, "").replace(/\/\*$/, ""));
        });
        if (!matches) {
          throw new ScopeViolationError(
            `Scope exceeded: requested scope '${reqPath}' is not contained in authorization scope [${authz.maxScope.join(", ")}]`
          );
        }
      }
    }

    // 8. Atomic monotonic consumption
    const updated: AuthorizationInstance = {
      ...authz,
      consumedCount: authz.consumedCount + 1,
    };

    const outboxMessage = this.outbox.createMessage(
      "authorization",
      updated.id,
      updated.consumedCount + 1,
      "authorization.consumed",
      {
        authorizationId: updated.id,
        taskId: updated.taskId,
        taskVersion: updated.taskVersion,
        consumedCount: updated.consumedCount,
        useLimit: updated.useLimit,
      }
    );

    return this.repo.updateAuthorization(updated, outboxMessage);
  }

  /**
   * Revoke an authorization instance.
   */
  async revokeAuthorization(authzId: string, reason: string): Promise<AuthorizationInstance> {
    const authz = await this.repo.getAuthorization(authzId);
    if (!authz) {
      throw new ValidationError(`Authorization instance not found: ${authzId}`);
    }

    // Set useLimit = consumedCount to exhaust immediately
    const revoked: AuthorizationInstance = {
      ...authz,
      useLimit: authz.consumedCount,
    };

    const outboxMessage = this.outbox.createMessage(
      "authorization",
      revoked.id,
      revoked.consumedCount + 2,
      "authorization.revoked",
      {
        authorizationId: revoked.id,
        taskId: revoked.taskId,
        reason,
      }
    );

    return this.repo.updateAuthorization(revoked, outboxMessage);
  }
}
