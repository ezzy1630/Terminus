/**
 * In-memory MemoryRepository for tests and local harnesses.
 */
import type { MemoryClaim, MemoryClaimStatus, MemoryScope, Uuid7 } from "@terminus/domain";
import type { MemoryRepository } from "./repository.js";

interface LeaseRecord {
  readonly holder: string;
  readonly expiresAtMs: number;
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly claims = new Map<string, MemoryClaim>();
  private readonly leases = new Map<string, LeaseRecord>();

  async createClaim(claim: MemoryClaim): Promise<MemoryClaim> {
    this.claims.set(claim.id, claim);
    return claim;
  }

  async getClaim(id: Uuid7): Promise<MemoryClaim | null> {
    return this.claims.get(id) ?? null;
  }

  async updateClaim(claim: MemoryClaim): Promise<MemoryClaim> {
    this.claims.set(claim.id, claim);
    return claim;
  }

  async listClaims(filter: {
    readonly status?: MemoryClaimStatus | undefined;
    readonly scope?: Partial<MemoryScope> | undefined;
  }): Promise<readonly MemoryClaim[]> {
    let out = [...this.claims.values()];
    if (filter.status !== undefined) {
      out = out.filter((c) => c.status === filter.status);
    }
    if (filter.scope !== undefined) {
      const scope = filter.scope;
      out = out.filter(
        (c) =>
          (scope.organization == null || c.scope.organization === scope.organization) &&
          (scope.user == null || c.scope.user === scope.user) &&
          (scope.workspaceId == null || c.scope.workspaceId === scope.workspaceId),
      );
    }
    return out;
  }

  async deleteClaim(id: Uuid7): Promise<void> {
    this.claims.delete(id);
  }

  async acquireLease(resource: string, holder: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const existing = this.leases.get(resource);
    if (existing !== undefined && existing.expiresAtMs > now && existing.holder !== holder) {
      return false;
    }
    this.leases.set(resource, { holder, expiresAtMs: now + ttlSeconds * 1000 });
    return true;
  }

  async releaseLease(resource: string, holder: string): Promise<void> {
    const existing = this.leases.get(resource);
    if (existing !== undefined && existing.holder === holder) {
      this.leases.delete(resource);
    }
  }
}
