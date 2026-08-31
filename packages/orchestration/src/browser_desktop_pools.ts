/** Lease coordinator for browser and desktop workers. No runtime is bundled here. */
import { canonicalJson } from "@terminus/context-ir";
import {
  ConflictError,
  NotFoundError,
  ResourceExhaustedError,
  SandboxUnavailableError,
  ValidationError,
  browserDesktopPoolSchema,
  generateUuid7,
  poolLeaseSchema,
  type BrowserDesktopPool,
  type PoolLease,
  type Rfc3339Timestamp,
} from "@terminus/domain";

export interface PoolLeaseBackend {
  readonly acquire: (
    pool: BrowserDesktopPool,
    taskId: string,
    workerId: string,
  ) => Promise<{ readonly instanceId: string }>;
  readonly releaseAndRecycle: (
    pool: BrowserDesktopPool,
    lease: PoolLease,
  ) => Promise<{ readonly recycled: boolean }>;
}

export interface PoolManagerClock {
  readonly nowMs: () => number;
}

const SYSTEM_CLOCK: PoolManagerClock = { nowMs: () => Date.now() };

export class BrowserDesktopPoolManager {
  private readonly pools = new Map<string, BrowserDesktopPool>();
  private readonly leases = new Map<string, PoolLease>();
  private readonly recycledInstances = new Set<string>();
  private readonly activeInstanceLeaseIds = new Map<string, string>();
  private readonly recyclingLeaseIds = new Set<string>();

  public constructor(
    private readonly backend: PoolLeaseBackend | null = null,
    private readonly clock: PoolManagerClock = SYSTEM_CLOCK,
  ) {}

  public registerPool(rawPool: BrowserDesktopPool): void {
    browserDesktopPoolSchema.parse(rawPool);
    const pool = rawPool;
    if (pool.activeLeasesCount !== 0) {
      throw new ValidationError("A newly registered pool must start with zero active leases", {
        poolId: pool.poolId,
        activeLeasesCount: pool.activeLeasesCount,
      });
    }
    const existing = this.pools.get(pool.poolId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(pool)) {
      throw new ConflictError(
        "DESCRIPTOR_RUG_PULL",
        `Browser/desktop pool '${pool.poolId}' is already registered with different content`,
        { poolId: pool.poolId },
      );
    }
    this.pools.set(pool.poolId, this.copyPool(pool));
  }

  public getPool(poolId: string): BrowserDesktopPool | null {
    const pool = this.pools.get(poolId);
    return pool === undefined ? null : this.copyPool(pool);
  }

  public listPools(): readonly BrowserDesktopPool[] {
    return [...this.pools.values()].map((pool) => this.copyPool(pool));
  }

  public async acquireLease(
    poolId: string,
    taskId: string,
    workerId: string,
    ttlMs = 300_000,
  ): Promise<PoolLease> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new ValidationError("Pool lease TTL must be a positive safe integer", { ttlMs });
    }
    if (taskId.trim().length === 0 || workerId.trim().length === 0) {
      throw new ValidationError("Pool lease task and worker identities are required");
    }
    const pool = this.requirePool(poolId);
    if (
      pool.executionSupport !== "kernel_backed"
      || pool.enforcementStatus !== "enforced"
      || this.backend === null
    ) {
      throw new SandboxUnavailableError(
        `Pool ${poolId} is coordinator-only; no enforced browser or desktop backend is configured`,
        {
          poolId,
          executionSupport: pool.executionSupport,
          enforcementStatus: pool.enforcementStatus,
        },
      );
    }
    if (pool.healthStatus !== "healthy") {
      throw new SandboxUnavailableError(`Pool ${poolId} is not healthy`, {
        poolId,
        healthStatus: pool.healthStatus,
      });
    }

    await this.expireLeases(poolId);
    const currentPool = this.requirePool(poolId);
    if (currentPool.activeLeasesCount >= currentPool.capacity) {
      throw new ResourceExhaustedError("browser_desktop_pool", {
        poolId,
        capacity: currentPool.capacity,
      });
    }

    const reservedPool = this.reserveCapacity(currentPool);
    try {
      const assignment = await this.backend.acquire(this.copyPool(reservedPool), taskId, workerId);
      if (
        assignment.instanceId.trim().length === 0
        || assignment.instanceId !== assignment.instanceId.trim()
      ) {
        throw new SandboxUnavailableError("Pool backend returned an invalid instance identity", { poolId });
      }
      if (this.activeInstanceLeaseIds.has(assignment.instanceId)) {
        throw new SandboxUnavailableError("Pool backend returned an instance that already has an active lease", {
          poolId,
          instanceId: assignment.instanceId,
        });
      }
      const nowMs = this.clock.nowMs();
      const lease: PoolLease = {
        leaseId: generateUuid7(nowMs),
        poolId,
        taskId,
        workerId,
        assignedInstanceId: assignment.instanceId,
        acquiredAt: new Date(nowMs).toISOString() as Rfc3339Timestamp,
        expiresAt: new Date(nowMs + ttlMs).toISOString() as Rfc3339Timestamp,
        status: "active",
      };
      poolLeaseSchema.parse(lease);
      this.leases.set(lease.leaseId, lease);
      this.activeInstanceLeaseIds.set(lease.assignedInstanceId, lease.leaseId);
      return { ...lease };
    } catch (error: unknown) {
      this.decrementActiveLeaseCount(poolId);
      throw error;
    }
  }

  public async releaseLease(leaseId: string): Promise<PoolLease> {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) throw new NotFoundError("pool lease", leaseId);
    if (lease.status !== "active") return { ...lease };
    const pool = this.requirePool(lease.poolId);
    if (this.backend === null) {
      throw new SandboxUnavailableError("Cannot recycle a pool instance without a configured backend", {
        poolId: pool.poolId,
        leaseId,
      });
    }
    if (this.recyclingLeaseIds.has(leaseId)) {
      throw new ConflictError(
        "STATE_TRANSITION_INVALID",
        "Pool lease recycling is already in progress",
        { leaseId },
      );
    }
    this.recyclingLeaseIds.add(leaseId);
    try {
      const receipt = await this.backend.releaseAndRecycle(this.copyPool(pool), { ...lease });
      if (!receipt.recycled) {
        throw new SandboxUnavailableError("Pool backend did not confirm instance recycling", {
          poolId: pool.poolId,
          leaseId,
          instanceId: lease.assignedInstanceId,
        });
      }
      const updated: PoolLease = { ...lease, status: "released" };
      poolLeaseSchema.parse(updated);
      this.leases.set(leaseId, updated);
      this.activeInstanceLeaseIds.delete(lease.assignedInstanceId);
      this.recycledInstances.add(lease.assignedInstanceId);
      this.decrementActiveLeaseCount(pool.poolId);
      return { ...updated };
    } finally {
      this.recyclingLeaseIds.delete(leaseId);
    }
  }

  public heartbeatLease(leaseId: string, ttlMs = 300_000): PoolLease {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) throw new NotFoundError("pool lease", leaseId);
    if (lease.status !== "active") {
      throw new ConflictError(
        "STATE_TRANSITION_INVALID",
        `Cannot heartbeat pool lease in state ${lease.status}`,
        { leaseId, status: lease.status },
      );
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new ValidationError("Pool lease TTL must be a positive safe integer", { ttlMs });
    }
    if (Date.parse(lease.expiresAt) <= this.clock.nowMs()) {
      throw new ConflictError(
        "STATE_TRANSITION_INVALID",
        "Cannot heartbeat an expired pool lease",
        { leaseId, expiresAt: lease.expiresAt },
      );
    }
    const updated: PoolLease = {
      ...lease,
      expiresAt: new Date(this.clock.nowMs() + ttlMs).toISOString() as Rfc3339Timestamp,
    };
    poolLeaseSchema.parse(updated);
    this.leases.set(leaseId, updated);
    return { ...updated };
  }

  public isInstanceRecycled(instanceId: string): boolean {
    return this.recycledInstances.has(instanceId);
  }

  public getLease(leaseId: string): PoolLease | null {
    const lease = this.leases.get(leaseId);
    return lease === undefined ? null : { ...lease };
  }

  private async expireLeases(poolId: string): Promise<void> {
    const nowMs = this.clock.nowMs();
    for (const lease of this.leases.values()) {
      if (
        lease.poolId !== poolId
        || lease.status !== "active"
        || Date.parse(lease.expiresAt) > nowMs
        || this.recyclingLeaseIds.has(lease.leaseId)
      ) continue;
      this.recyclingLeaseIds.add(lease.leaseId);
      const pool = this.requirePool(poolId);
      try {
        if (this.backend === null) {
          throw new SandboxUnavailableError("Expired pool lease cannot be recycled without a backend", {
            poolId,
            leaseId: lease.leaseId,
          });
        }
        const receipt = await this.backend.releaseAndRecycle(this.copyPool(pool), { ...lease });
        if (!receipt.recycled) {
          throw new SandboxUnavailableError("Expired pool lease recycling was not confirmed", {
            poolId,
            leaseId: lease.leaseId,
          });
        }
        this.leases.set(lease.leaseId, { ...lease, status: "expired" });
        this.activeInstanceLeaseIds.delete(lease.assignedInstanceId);
        this.recycledInstances.add(lease.assignedInstanceId);
        this.decrementActiveLeaseCount(pool.poolId);
      } finally {
        this.recyclingLeaseIds.delete(lease.leaseId);
      }
    }
  }

  private requirePool(poolId: string): BrowserDesktopPool {
    const pool = this.pools.get(poolId);
    if (pool === undefined) throw new NotFoundError("browser/desktop pool", poolId);
    return pool;
  }

  private reserveCapacity(pool: BrowserDesktopPool): BrowserDesktopPool {
    const reserved = {
      ...pool,
      activeLeasesCount: pool.activeLeasesCount + 1,
    };
    this.pools.set(pool.poolId, reserved);
    return reserved;
  }

  private decrementActiveLeaseCount(poolId: string): void {
    const pool = this.requirePool(poolId);
    if (pool.activeLeasesCount <= 0) {
      throw new ConflictError(
        "STATE_TRANSITION_INVALID",
        "Pool active lease count would become negative",
        { poolId, activeLeasesCount: pool.activeLeasesCount },
      );
    }
    this.pools.set(poolId, {
      ...pool,
      activeLeasesCount: pool.activeLeasesCount - 1,
    });
  }

  private copyPool(pool: BrowserDesktopPool): BrowserDesktopPool {
    return { ...pool, runtimeConfig: { ...pool.runtimeConfig } };
  }
}
