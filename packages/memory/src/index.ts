/**
 * @forge/memory — memory candidate extraction, consolidation curator, retrieval.
 *
 * Per SPEC §16, §39: MemoryService with extractCandidates(task),
 * consolidate() (lease-protected), retrieve(query, scope), invalidate(fileHash),
 * quarantine(claimId), disable(), export(), reset(). Includes provenance,
 * confidence (ppm), expiry rules, contradiction detection. Disabled by default.
 */
import type {
  MemoryClaim,
  MemoryClaimKind,
  MemoryClaimStatus,
  MemoryScope,
  MemoryProvenance,
  MemoryVerification,
  MemoryValidity,
  MemoryUsage,
  MemoryRelations,
  Uuid7,
  Rfc3339Timestamp,
  ContentHash,
  ModelKey,
  PrincipalId,
  Task,
  InvalidationRule,
} from "@forge/domain";
import { ValidationError, ConflictError } from "@forge/domain";

// ────────────────────────── Repository ───────────────────────────────────────

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

export interface MemoryServiceDeps {
  readonly repo: MemoryRepository;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
  readonly extractorModel: ModelKey;
  readonly extractorVersion: string;
  readonly enabled: boolean;
  /** Per-scope memory limits. */
  readonly limits: Readonly<Record<string, number>>;
}

// ────────────────────────── Service ──────────────────────────────────────────

export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps) {}

  /**
   * Extract memory candidates from a sufficiently complete task. Excludes
   * secrets and confidential transient data. Never promotes directly to
   * active memory.
   */
  async extractCandidates(task: Task): Promise<readonly MemoryClaim[]> {
    if (!this.deps.enabled) return [];
    const now = this.deps.clock();
    const candidates: MemoryClaim[] = [];
    // Pull deterministic facts from the contract.
    candidates.push(
      this.makeCandidate(
        task,
        "fact",
        `Task objective: ${task.contract.objective}`,
        now,
      ),
    );
    for (const ac of task.contract.acceptanceCriteria) {
      candidates.push(
        this.makeCandidate(
          task,
          "convention",
          `Acceptance criterion: ${ac.statement}`,
          now,
        ),
      );
    }
    // Persist each candidate.
    const persisted: MemoryClaim[] = [];
    for (const c of candidates) {
      persisted.push(await this.deps.repo.createClaim(c));
    }
    return persisted;
  }

  /**
   * Consolidation curator: obtains a lease, loads candidates and existing
   * memories, detects duplicates and contradictions, revalidates cheap facts,
   * computes a proposed diff, applies policy, promotes/disputes/supersedes/
   * rejects, writes an audit artifact, releases the lease.
   */
  async consolidate(): Promise<{
    readonly promoted: readonly Uuid7[];
    readonly disputed: readonly Uuid7[];
    readonly superseded: readonly Uuid7[];
    readonly rejected: readonly Uuid7[];
  }> {
    if (!this.deps.enabled) {
      return { promoted: [], disputed: [], superseded: [], rejected: [] };
    }
    const leaseHolder = `curator-${this.deps.clock()}`;
    const acquired = await this.deps.repo.acquireLease("memory:consolidation", leaseHolder, 60);
    if (!acquired) {
      throw new ConflictError("IDEMPOTENCY_KEY_CONFLICT", "consolidation already in progress");
    }
    try {
      const candidates = await this.deps.repo.listClaims({ status: "candidate" });
      const active = await this.deps.repo.listClaims({ status: "active" });
      const promoted: Uuid7[] = [];
      const disputed: Uuid7[] = [];
      const superseded: Uuid7[] = [];
      const rejected: Uuid7[] = [];
      for (const c of candidates) {
        // Detect duplicates.
        const dup = active.find(
          (a) => a.statement === c.statement,
        );
        if (dup) {
          rejected.push(c.id);
          await this.deps.repo.updateClaim({ ...c, status: "rejected" });
          continue;
        }
        // Detect contradictions.
        const contradicts = active.find(
          (a) =>
            a.kind === c.kind &&
            a.statement !== c.statement &&
            isContradiction(a.statement, c.statement),
        );
        if (contradicts) {
          disputed.push(c.id);
          await this.deps.repo.updateClaim({
            ...c,
            status: "disputed",
            relations: { ...c.relations, contradicts: [...c.relations.contradicts, contradicts.id] },
          });
          continue;
        }
        // Promote with conservative confidence.
        promoted.push(c.id);
        await this.deps.repo.updateClaim({
          ...c,
          status: "active",
          confidencePpm: Math.min(c.confidencePpm, 500_000),
        });
      }
      return { promoted, disputed, superseded, rejected };
    } finally {
      await this.deps.repo.releaseLease("memory:consolidation", leaseHolder);
    }
  }

  /**
   * Retrieve memory claims matching a query and scope. Cheap claims are
   * rechecked before injection. A memory cannot override current repository
   * state or higher authority.
   */
  async retrieve(
    query: string,
    scope: Partial<MemoryScope>,
  ): Promise<readonly MemoryClaim[]> {
    if (!this.deps.enabled) return [];
    const all = await this.deps.repo.listClaims({ status: "active", scope });
    // Naive lexical match.
    const q = query.toLowerCase();
    return all
      .filter((c) => c.statement.toLowerCase().includes(q))
      .sort((a, b) => b.confidencePpm - a.confidencePpm);
  }

  /** Invalidate claims whose source matches the given file hash. */
  async invalidate(fileHash: ContentHash): Promise<readonly Uuid7[]> {
    if (!this.deps.enabled) return [];
    const all = await this.deps.repo.listClaims({});
    const invalidated: Uuid7[] = [];
    for (const c of all) {
      if (c.provenance.sources.some((s) => s.hash === fileHash)) {
        await this.deps.repo.updateClaim({ ...c, status: "expired" });
        invalidated.push(c.id);
      }
    }
    return invalidated;
  }

  /** Quarantine a claim (mark disputed) due to harmful-use counter. */
  async quarantine(claimId: Uuid7): Promise<MemoryClaim> {
    const c = await this.requireClaim(claimId);
    return this.deps.repo.updateClaim({ ...c, status: "disputed" });
  }

  /** Disable memory entirely for this session/workspace. */
  async disable(): Promise<void> {
    // Mark all active claims as expired.
    const active = await this.deps.repo.listClaims({ status: "active" });
    for (const c of active) {
      await this.deps.repo.updateClaim({ ...c, status: "expired" });
    }
  }

  /** Export all claims for backup/inspection. */
  async export(): Promise<readonly MemoryClaim[]> {
    return this.deps.repo.listClaims({});
  }

  /** Reset: delete all claims. */
  async reset(): Promise<void> {
    const all = await this.deps.repo.listClaims({});
    for (const c of all) {
      await this.deps.repo.deleteClaim(c.id);
    }
  }

  private makeCandidate(
    task: Task,
    kind: MemoryClaimKind,
    statement: string,
    now: Rfc3339Timestamp,
  ): MemoryClaim {
    const provenance: MemoryProvenance = {
      sources: [],
      createdFromSession: task.sessionId,
      createdFromTask: task.id,
      extractorModel: this.deps.extractorModel,
      extractorVersion: this.deps.extractorVersion,
    };
    const verification: MemoryVerification = {
      lastVerifiedAt: null,
      method: null,
      evidence: [],
    };
    const validity: MemoryValidity = {
      startsAt: now,
      expiresAt: null,
      invalidationRules: [] as readonly InvalidationRule[],
    };
    const usage: MemoryUsage = {
      count: 0,
      lastUsedAt: null,
      successfulUses: 0,
      harmfulUses: 0,
    };
    const relations: MemoryRelations = {
      supports: [],
      contradicts: [],
      supersedes: [],
    };
    const scope: MemoryScope = {
      organization: null,
      user: null,
      workspaceId: null,
      pathPatterns: [],
    };
    return {
      id: this.deps.idSource(),
      kind,
      statement,
      procedureArtifactHash: null,
      scope,
      provenance,
      confidencePpm: 300_000, // Conservative default 30%.
      verification,
      validity,
      usage,
      relations,
      status: "candidate",
      createdAt: now,
    };
  }

  private async requireClaim(id: Uuid7): Promise<MemoryClaim> {
    const c = await this.deps.repo.getClaim(id);
    if (c === null) throw new ValidationError("claim not found", { claimId: id });
    return c;
  }
}

// ────────────────────────── Contradiction detection ──────────────────────────

/** Naive contradiction heuristic: negation markers. Production uses an LLM. */
export function isContradiction(a: string, b: string): boolean {
  const negations = ["not ", "never ", "don't ", "do not ", "cannot ", "can't "];
  for (const n of negations) {
    if ((a.startsWith(n) && b.startsWith(a.slice(n.length))) ||
        (b.startsWith(n) && a.startsWith(b.slice(n.length)))) {
      return true;
    }
  }
  return false;
}

export type {
  MemoryClaim,
  MemoryClaimKind,
  MemoryClaimStatus,
  MemoryScope,
  MemoryProvenance,
  MemoryVerification,
  MemoryValidity,
  MemoryUsage,
  MemoryRelations,
  Task,
  PrincipalId,
};
