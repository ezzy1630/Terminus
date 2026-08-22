/**
 * @terminus/task-runtime — Worker Leases & Fencing Epochs.
 *
 * Per SPEC §10, §14, §46.9:
 * Coordinates worker execution leases, generates monotonic fencing tokens,
 * and rejects stale worker mutations after lease expiry or fencing epoch revocation.
 */
import type { WorkerLease, LeaseStatus, Rfc3339Timestamp } from "@terminus/domain";
import { isLeaseTransitionAllowed, isLeaseTerminal, nowTimestamp } from "@terminus/domain";
import type { DurableTaskRepository } from "./types.js";
import { TransactionalOutbox } from "./outbox.js";

export class FencingError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "FencingError";
  }
}

export class LeaseError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "LeaseError";
  }
}

export class WorkerLeaseManager {
  private readonly highestFencingTokens = new Map<string, number>();

  constructor(
    private readonly repo: DurableTaskRepository,
    private readonly outbox: TransactionalOutbox,
    private readonly idSource: () => string = () => `lease-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly clock: () => Rfc3339Timestamp = () => nowTimestamp(),
  ) {}

  private getNextFencingToken(taskId: string, currentHighest = 0): number {
    const mem = this.highestFencingTokens.get(taskId) ?? currentHighest;
    const next = Math.max(mem, currentHighest) + 1;
    this.highestFencingTokens.set(taskId, next);
    return next;
  }

  async acquireLease(
    taskId: string,
    workerId: string,
    durationSeconds = 30,
    metadata: Record<string, unknown> = {},
  ): Promise<WorkerLease> {
    const nowIso = this.clock();
    const nowMs = new Date(nowIso).getTime();
    const existingLeases = await this.repo.listLeasesForTask(taskId);

    let maxToken = 0;
    let activeLease: WorkerLease | null = null;

    for (const l of existingLeases) {
      if (l.fencingToken > maxToken) {
        maxToken = l.fencingToken;
      }
      if (l.status === "ACQUIRED" || l.status === "RENEWED") {
        const exp = new Date(l.expiresAt).getTime();
        if (exp > nowMs) {
          activeLease = l;
        }
      }
    }

    if (activeLease) {
      if (activeLease.workerId === workerId) {
        // Same worker renewing / extending
        const expiresAt = new Date(nowMs + durationSeconds * 1000).toISOString() as Rfc3339Timestamp;
        const updated: WorkerLease = {
          ...activeLease,
          status: "RENEWED",
          expiresAt,
          metadata: { ...activeLease.metadata, ...metadata },
        };
        const outboxMsg = this.outbox.createMessage(
          "lease",
          updated.id,
          updated.fencingToken,
          "lease.renewed",
          {
            leaseId: updated.id,
            taskId,
            workerId,
            fencingToken: updated.fencingToken,
            expiresAt,
          },
        );
        return this.repo.updateLease(updated, outboxMsg);
      } else {
        // Different worker attempting to acquire while active
        throw new LeaseError(
          `Task ${taskId} is currently leased by worker ${activeLease.workerId} until ${activeLease.expiresAt}`,
          { activeLeaseId: activeLease.id, currentWorkerId: activeLease.workerId },
        );
      }
    }

    // Fence any previously active but expired leases
    for (const l of existingLeases) {
      if (l.status === "ACQUIRED" || l.status === "RENEWED") {
        const fenced: WorkerLease = {
          ...l,
          status: "EXPIRED",
          releasedAt: nowIso,
        };
        await this.repo.updateLease(fenced);
      }
    }

    const nextFencingToken = this.getNextFencingToken(taskId, maxToken);
    const expiresAt = new Date(nowMs + durationSeconds * 1000).toISOString() as Rfc3339Timestamp;

    const newLease: WorkerLease = {
      id: this.idSource(),
      taskId,
      workerId,
      fencingToken: nextFencingToken,
      status: "ACQUIRED",
      acquiredAt: nowIso,
      expiresAt,
      releasedAt: null,
      metadata,
    };

    const outboxMsg = this.outbox.createMessage(
      "lease",
      newLease.id,
      newLease.fencingToken,
      "lease.acquired",
      {
        leaseId: newLease.id,
        taskId,
        workerId,
        fencingToken: nextFencingToken,
        expiresAt,
      },
    );

    return this.repo.createLease(newLease, outboxMsg);
  }

  async renewLease(
    leaseId: string,
    fencingToken: number,
    durationSeconds = 30,
  ): Promise<WorkerLease> {
    const lease = await this.repo.getLease(leaseId);
    if (!lease) {
      throw new LeaseError(`Lease ${leaseId} not found`);
    }

    if (lease.fencingToken !== fencingToken) {
      throw new FencingError(
        `Fencing token mismatch for lease ${leaseId}: expected ${lease.fencingToken}, got ${fencingToken}`,
      );
    }

    if (lease.status !== "ACQUIRED" && lease.status !== "RENEWED") {
      throw new LeaseError(`Cannot renew lease in status ${lease.status}`);
    }

    const nowIso = this.clock();
    const nowMs = new Date(nowIso).getTime();
    const expiresAt = new Date(nowMs + durationSeconds * 1000).toISOString() as Rfc3339Timestamp;

    const updated: WorkerLease = {
      ...lease,
      status: "RENEWED",
      expiresAt,
    };

    const outboxMsg = this.outbox.createMessage(
      "lease",
      updated.id,
      updated.fencingToken,
      "lease.renewed",
      {
        leaseId: updated.id,
        taskId: updated.taskId,
        workerId: updated.workerId,
        fencingToken: updated.fencingToken,
        expiresAt,
      },
    );

    return this.repo.updateLease(updated, outboxMsg);
  }

  async releaseLease(leaseId: string, fencingToken: number): Promise<WorkerLease> {
    const lease = await this.repo.getLease(leaseId);
    if (!lease) {
      throw new LeaseError(`Lease ${leaseId} not found`);
    }

    if (lease.fencingToken !== fencingToken) {
      throw new FencingError(
        `Fencing token mismatch for lease ${leaseId}: expected ${lease.fencingToken}, got ${fencingToken}`,
      );
    }

    if (lease.status !== "ACQUIRED" && lease.status !== "RENEWED") {
      throw new LeaseError(`Cannot release lease in status ${lease.status}`);
    }

    const nowIso = this.clock();
    const updated: WorkerLease = {
      ...lease,
      status: "RELEASED",
      releasedAt: nowIso,
    };

    const outboxMsg = this.outbox.createMessage(
      "lease",
      updated.id,
      updated.fencingToken,
      "lease.released",
      {
        leaseId: updated.id,
        taskId: updated.taskId,
        workerId: updated.workerId,
        fencingToken: updated.fencingToken,
      },
    );

    return this.repo.updateLease(updated, outboxMsg);
  }

  async verifyFencingToken(
    taskId: string,
    workerId: string,
    fencingToken: number,
  ): Promise<boolean> {
    const activeLease = await this.repo.getActiveLeaseForTask(taskId);
    if (!activeLease) {
      return false;
    }
    if (activeLease.workerId !== workerId) {
      return false;
    }
    if (activeLease.fencingToken !== fencingToken) {
      return false;
    }
    const nowMs = new Date(this.clock()).getTime();
    const expMs = new Date(activeLease.expiresAt).getTime();
    return expMs > nowMs;
  }
}
