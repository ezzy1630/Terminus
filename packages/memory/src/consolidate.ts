/**
 * Consolidation curator with lease + isolated sandbox (SPEC §39.5).
 *
 * The curator has no network and writes only through the provided repository.
 * Isolation is enforced by refusing any network/capability handle in the
 * sandbox context — callers MUST NOT pass network clients into consolidate.
 */
import type { MemoryClaim, Rfc3339Timestamp, Uuid7 } from "@terminus/domain";
import { ConflictError, ValidationError } from "@terminus/domain";
import { relateClaims, isExpired } from "./contradiction.js";
import {
  revalidateClaim,
  type RevalidationContext,
  type RevalidationHook,
  defaultRevalidationHooks,
} from "./revalidate.js";
import { hasCompleteProvenance } from "./explain.js";

export interface CuratorSandbox {
  /** Hard invariant: curator consolidation has no network. */
  readonly networkAllowed: false;
  /** Optional workspace path the curator may write audit artifacts into. */
  readonly auditWorkspace: string | null;
}

export function createCuratorSandbox(auditWorkspace: string | null = null): CuratorSandbox {
  return { networkAllowed: false, auditWorkspace };
}

export interface ConsolidationAudit {
  readonly at: Rfc3339Timestamp;
  readonly leaseHolder: string;
  readonly promoted: readonly Uuid7[];
  readonly disputed: readonly Uuid7[];
  readonly superseded: readonly Uuid7[];
  readonly rejected: readonly Uuid7[];
  readonly expired: readonly Uuid7[];
  readonly notes: readonly string[];
}

export interface ConsolidationResult {
  readonly promoted: readonly Uuid7[];
  readonly disputed: readonly Uuid7[];
  readonly superseded: readonly Uuid7[];
  readonly rejected: readonly Uuid7[];
  readonly expired: readonly Uuid7[];
  readonly audit: ConsolidationAudit;
}

export interface ConsolidationRepo {
  listClaims(filter: {
    readonly status?: MemoryClaim["status"] | undefined;
  }): Promise<readonly MemoryClaim[]>;
  updateClaim(claim: MemoryClaim): Promise<MemoryClaim>;
  acquireLease(resource: string, holder: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(resource: string, holder: string): Promise<void>;
}

export interface ConsolidateDeps {
  readonly repo: ConsolidationRepo;
  readonly clock: () => Rfc3339Timestamp;
  readonly sandbox: CuratorSandbox;
  readonly leaseTtlSeconds?: number;
  readonly revalidation?: RevalidationContext;
  readonly revalidationHooks?: readonly RevalidationHook[];
  /** Max confidence applied on first promotion (ppm). */
  readonly maxPromoteConfidencePpm?: number;
}

const LEASE_RESOURCE = "memory:consolidation";

/**
 * Run one consolidation pass under an exclusive lease inside the sandbox.
 */
export async function consolidateMemories(deps: ConsolidateDeps): Promise<ConsolidationResult> {
  assertSandbox(deps.sandbox);

  const leaseHolder = `curator-${deps.clock()}`;
  const ttl = deps.leaseTtlSeconds ?? 60;
  const acquired = await deps.repo.acquireLease(LEASE_RESOURCE, leaseHolder, ttl);
  if (!acquired) {
    throw new ConflictError("IDEMPOTENCY_KEY_CONFLICT", "consolidation already in progress");
  }

  try {
    return await runCuratorPass(deps, leaseHolder);
  } finally {
    await deps.repo.releaseLease(LEASE_RESOURCE, leaseHolder);
  }
}

async function runCuratorPass(
  deps: ConsolidateDeps,
  leaseHolder: string,
): Promise<ConsolidationResult> {
  const now = deps.clock();
  const maxConf = deps.maxPromoteConfidencePpm ?? 500_000;
  const hooks = deps.revalidationHooks ?? defaultRevalidationHooks();

  const promoted: Uuid7[] = [];
  const disputed: Uuid7[] = [];
  const superseded: Uuid7[] = [];
  const rejected: Uuid7[] = [];
  const expired: Uuid7[] = [];
  const notes: string[] = [];

  // Expire active claims past TTL / validity.
  const active = [...(await deps.repo.listClaims({ status: "active" }))];
  for (const claim of active) {
    if (isExpired(claim, now)) {
      await deps.repo.updateClaim({ ...claim, status: "expired" });
      expired.push(claim.id);
      notes.push(`expired ${claim.id}`);
    }
  }

  // Refresh active set after expiry.
  const activeFresh = (await deps.repo.listClaims({ status: "active" })).filter(
    (c) => !isExpired(c, now),
  );
  const candidates = await deps.repo.listClaims({ status: "candidate" });

  for (const candidate of candidates) {
    if (!hasCompleteProvenance(candidate)) {
      await deps.repo.updateClaim({ ...candidate, status: "rejected" });
      rejected.push(candidate.id);
      notes.push(`rejected ${candidate.id}: incomplete provenance`);
      continue;
    }

    if (deps.revalidation !== undefined) {
      const outcome = revalidateClaim(candidate, deps.revalidation, hooks);
      if (outcome.status === "stale") {
        await deps.repo.updateClaim({ ...candidate, status: "rejected" });
        rejected.push(candidate.id);
        notes.push(`rejected ${candidate.id}: revalidation stale (${outcome.reason})`);
        continue;
      }
    }

    let handled = false;
    for (const existing of activeFresh) {
      const relation = relateClaims(candidate, existing);
      switch (relation.kind) {
        case "duplicate": {
          await deps.repo.updateClaim({ ...candidate, status: "rejected" });
          rejected.push(candidate.id);
          notes.push(`rejected ${candidate.id}: duplicate of ${existing.id}`);
          handled = true;
          break;
        }
        case "contradicts": {
          const updatedCandidate: MemoryClaim = {
            ...candidate,
            status: "disputed",
            relations: {
              ...candidate.relations,
              contradicts: uniqueIds([...candidate.relations.contradicts, existing.id]),
            },
          };
          const updatedExisting: MemoryClaim = {
            ...existing,
            status: "disputed",
            relations: {
              ...existing.relations,
              contradicts: uniqueIds([...existing.relations.contradicts, candidate.id]),
            },
          };
          await deps.repo.updateClaim(updatedCandidate);
          await deps.repo.updateClaim(updatedExisting);
          disputed.push(candidate.id);
          notes.push(`disputed ${candidate.id} vs ${existing.id}`);
          handled = true;
          break;
        }
        case "supersedes": {
          const updatedExisting: MemoryClaim = {
            ...existing,
            status: "expired",
            relations: {
              ...existing.relations,
              supersedes: existing.relations.supersedes,
            },
          };
          const updatedCandidate: MemoryClaim = {
            ...candidate,
            status: "active",
            confidencePpm: Math.min(candidate.confidencePpm, maxConf),
            relations: {
              ...candidate.relations,
              supersedes: uniqueIds([...candidate.relations.supersedes, existing.id]),
            },
            verification: {
              lastVerifiedAt: now,
              method: "curator_promote",
              evidence: candidate.provenance.sources,
            },
          };
          await deps.repo.updateClaim(updatedExisting);
          await deps.repo.updateClaim(updatedCandidate);
          superseded.push(existing.id);
          promoted.push(candidate.id);
          // Keep local active set coherent for subsequent candidates.
          const idx = activeFresh.findIndex((a) => a.id === existing.id);
          if (idx >= 0) activeFresh.splice(idx, 1);
          activeFresh.push(updatedCandidate);
          notes.push(`supersede ${existing.id} <- ${candidate.id}`);
          handled = true;
          break;
        }
        case "superseded_by": {
          await deps.repo.updateClaim({ ...candidate, status: "rejected" });
          rejected.push(candidate.id);
          notes.push(`rejected ${candidate.id}: superseded by ${existing.id}`);
          handled = true;
          break;
        }
        case "independent":
          break;
        default: {
          const _exhaustive: never = relation;
          void _exhaustive;
        }
      }
      if (handled) break;
    }

    if (handled) continue;

    // Promote independent candidate.
    const promotedClaim: MemoryClaim = {
      ...candidate,
      status: "active",
      confidencePpm: Math.min(candidate.confidencePpm, maxConf),
      verification: {
        lastVerifiedAt: now,
        method: "curator_promote",
        evidence: candidate.provenance.sources,
      },
    };
    await deps.repo.updateClaim(promotedClaim);
    promoted.push(candidate.id);
    activeFresh.push(promotedClaim);
    notes.push(`promoted ${candidate.id}`);
  }

  const audit: ConsolidationAudit = {
    at: now,
    leaseHolder,
    promoted,
    disputed,
    superseded,
    rejected,
    expired,
    notes,
  };

  return { promoted, disputed, superseded, rejected, expired, audit };
}

function assertSandbox(sandbox: CuratorSandbox): void {
  if (sandbox.networkAllowed !== false) {
    throw new ValidationError("curator sandbox must set networkAllowed=false");
  }
}

function uniqueIds(ids: readonly Uuid7[]): readonly Uuid7[] {
  return [...new Set(ids)];
}
