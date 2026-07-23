/**
 * Managed writer worktrees (§37.8). Ownership ledger + exact-HEAD policy.
 * Does not mutate git state — the kernel owns create/merge/remove.
 */
import type { Uuid7, Rfc3339Timestamp, WorktreeLease } from "@terminus/domain";
import { ValidationError } from "@terminus/domain";

export interface WorktreeOps {
  readonly createWorktree: (input: {
    readonly path: string;
    readonly baseRevision: string;
  }) => Promise<{ readonly path: string; readonly headRevision: string }>;
  readonly removeWorktree: (path: string) => Promise<void>;
}

export interface WorktreeManagerDeps {
  readonly ops: WorktreeOps;
  readonly idSource: () => string;
  readonly clock: () => Rfc3339Timestamp;
}

function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
    }
  }
  return false;
}

export class ManagedWorktreeLedger {
  private readonly leases = new Map<string, WorktreeLease>();

  constructor(private readonly deps: WorktreeManagerDeps) {}

  list(): readonly WorktreeLease[] {
    return [...this.leases.values()];
  }

  get(id: string): WorktreeLease | null {
    return this.leases.get(id) ?? null;
  }

  async acquire(input: {
    readonly taskId: Uuid7;
    readonly agentId: Uuid7 | null;
    readonly delegationId: Uuid7 | null;
    readonly path: string;
    readonly baseRevision: string;
    readonly ownedPathPrefixes: readonly string[];
  }): Promise<WorktreeLease> {
    if (input.ownedPathPrefixes.length === 0) {
      throw new ValidationError("writer worktree requires owned path prefixes");
    }
    for (const lease of this.leases.values()) {
      if (lease.status !== "active" && lease.status !== "merging") continue;
      if (pathsOverlap(lease.ownedPathPrefixes, input.ownedPathPrefixes)) {
        throw new ValidationError("worktree path ownership conflict", {
          existing: lease.id,
          prefixes: lease.ownedPathPrefixes,
        });
      }
    }
    const created = await this.deps.ops.createWorktree({
      path: input.path,
      baseRevision: input.baseRevision,
    });
    // Exact-HEAD policy: created head must equal requested base.
    if (created.headRevision !== input.baseRevision) {
      await this.deps.ops.removeWorktree(created.path);
      throw new ValidationError("worktree head does not match exact base revision", {
        expected: input.baseRevision,
        actual: created.headRevision,
      });
    }
    const now = this.deps.clock();
    const lease: WorktreeLease = {
      id: this.deps.idSource(),
      taskId: input.taskId,
      agentId: input.agentId,
      delegationId: input.delegationId,
      path: created.path,
      baseRevision: input.baseRevision,
      headRevision: created.headRevision,
      ownedPathPrefixes: input.ownedPathPrefixes,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.leases.set(lease.id, lease);
    return lease;
  }

  beginMerge(leaseId: string, expectedBaseRevision: string): WorktreeLease {
    const lease = this.require(leaseId);
    if (lease.status !== "active") {
      throw new ValidationError("worktree not active", { status: lease.status });
    }
    if (lease.baseRevision !== expectedBaseRevision) {
      throw new ValidationError("exact-HEAD base revision mismatch", {
        expected: expectedBaseRevision,
        actual: lease.baseRevision,
      });
    }
    return this.update(lease, { status: "merging" });
  }

  markMerged(leaseId: string, headRevision: string): WorktreeLease {
    const lease = this.require(leaseId);
    return this.update(lease, { status: "merged", headRevision });
  }

  markConflict(leaseId: string): WorktreeLease {
    const lease = this.require(leaseId);
    return this.update(lease, { status: "conflict" });
  }

  async abandon(leaseId: string): Promise<WorktreeLease> {
    const lease = this.require(leaseId);
    await this.deps.ops.removeWorktree(lease.path);
    return this.update(lease, { status: "abandoned" });
  }

  /** GC abandoned/merged leases older than maxAgeMs (caller supplies now). */
  collectGarbage(nowMs: number, maxAgeMs: number): readonly string[] {
    const removed: string[] = [];
    for (const lease of this.leases.values()) {
      if (lease.status !== "merged" && lease.status !== "abandoned") continue;
      const updated = Date.parse(lease.updatedAt);
      if (Number.isFinite(updated) && nowMs - updated >= maxAgeMs) {
        this.leases.delete(lease.id);
        removed.push(lease.id);
      }
    }
    return removed;
  }

  private require(id: string): WorktreeLease {
    const lease = this.leases.get(id);
    if (!lease) throw new ValidationError("worktree lease not found", { id });
    return lease;
  }

  private update(
    lease: WorktreeLease,
    patch: Partial<Pick<WorktreeLease, "status" | "headRevision">>,
  ): WorktreeLease {
    const next: WorktreeLease = {
      ...lease,
      ...patch,
      updatedAt: this.deps.clock(),
    };
    this.leases.set(next.id, next);
    return next;
  }
}
