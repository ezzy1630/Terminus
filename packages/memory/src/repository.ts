/**
 * MemoryRepository contract (SPEC §39).
 */
import type { MemoryClaim, MemoryClaimStatus, MemoryScope, Uuid7 } from "@terminus/domain";

export interface MemoryRepository {
  createClaim(claim: MemoryClaim): Promise<MemoryClaim>;
  getClaim(id: Uuid7): Promise<MemoryClaim | null>;
  updateClaim(claim: MemoryClaim): Promise<MemoryClaim>;
  listClaims(filter: {
    readonly status?: MemoryClaimStatus | undefined;
    readonly scope?: Partial<MemoryScope> | undefined;
  }): Promise<readonly MemoryClaim[]>;
  deleteClaim(id: Uuid7): Promise<void>;
  acquireLease(resource: string, holder: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(resource: string, holder: string): Promise<void>;
}
