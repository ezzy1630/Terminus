/**
 * In-memory MemoryRepository for tests and local harnesses.
 */
import type { MemoryClaim, MemoryClaimStatus, MemoryScope, Uuid7 } from "@terminus/domain";
import type { MemoryRepository } from "./repository.js";

interface LeaseRecord {
  readonly holder: string;
  readonly expiresAtMs: number;
}

/**
 * A claim matches a scope filter when every filter field the caller set
 * (non-null) equals the claim's field. Unset or null filter fields pass
 * through. Expressed as a single boolean reduction so the function stays
 * branch-light and returns no redundant boolean literals.
 */
const matchesScope = (
  scope: MemoryClaim["scope"],
  filterScope: Partial<MemoryClaim["scope"]>,
): boolean =>
  [
    { wanted: filterScope.organization, actual: scope.organization },
    { wanted: filterScope.user, actual: scope.user },
    { wanted: filterScope.workspaceId, actual: scope.workspaceId },
  ].every(({ wanted, actual }) => wanted == null || actual === wanted);

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly claims = new Map<string, MemoryClaim>();
  private readonly leases = new Map<string, LeaseRecord>();

  createClaim(claim: MemoryClaim): Promise<MemoryClaim> {
    this.claims.set(claim.id, claim);
    return Promise.resolve(claim);
  }

  getClaim(id: Uuid7): Promise<MemoryClaim | null> {
    return Promise.resolve(this.claims.get(id) ?? null);
  }

  updateClaim(claim: MemoryClaim): Promise<MemoryClaim> {
    this.claims.set(claim.id, claim);
    return Promise.resolve(claim);
  }

  listClaims(filter: {
    readonly status?: MemoryClaimStatus | undefined;
    readonly scope?: Partial<MemoryScope> | undefined;
  }): Promise<readonly MemoryClaim[]> {
    let out = [...this.claims.values()];
    if (filter.status !== undefined) {
      out = out.filter((c) => c.status === filter.status);
    }
    if (filter.scope !== undefined) {
      const scope = filter.scope;
      out = out.filter((c) => matchesScope(c.scope, scope));
    }
    return Promise.resolve(out);
  }

  deleteClaim(id: Uuid7): Promise<void> {
    this.claims.delete(id);
    return Promise.resolve();
  }

  acquireLease(resource: string, holder: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const existing = this.leases.get(resource);
    const held = existing !== undefined && existing.expiresAtMs > now && existing.holder !== holder;
    if (!held) {
      this.leases.set(resource, { holder, expiresAtMs: now + ttlSeconds * 1000 });
    }
    return Promise.resolve(!held);
  }

  releaseLease(resource: string, holder: string): Promise<void> {
    const existing = this.leases.get(resource);
    if (existing !== undefined && existing.holder === holder) {
      this.leases.delete(resource);
    }
    return Promise.resolve();
  }
}
