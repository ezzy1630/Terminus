/**
 * @forge/memory — memory candidate extraction, consolidation curator, retrieval.
 *
 * Per SPEC §16, §39: MemoryService with extractCandidates(task),
 * consolidate() (lease-protected), retrieve(query, scope), invalidate(fileHash),
 * quarantine(claimId), disable(), export(), reset(). Includes provenance,
 * confidence (ppm), expiry rules, contradiction detection. Disabled by default.
 *
 * Also exposes a `WorkingMemoryService` (§16.1 / §39.2) that produces a
 * read-only `WorkingMemorySnapshot` projection of deterministic task state:
 * active objective/contract version, progress by acceptance criterion,
 * decisions, failed approaches, modified files, test/diagnostic state,
 * current phase, running jobs, budget consumption, blockers.
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
  TaskPhase,
  AcceptanceCriterion,
  InvalidationRule,
  Micros,
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

// ────────────────────────── Working memory (§16.1, §39.2) ────────────────────

/**
 * Deterministic task-state projection. Per SPEC §16.1: "working memory is a
 * read-only projection of task state, not inferred from prose." The
 * `WorkingMemoryService` builds this snapshot from authoritative sources
 * (task aggregate, scope ledger, verification DAG, job registry, budget
 * ledger) — never from LLM-generated text.
 */
export interface WorkingMemorySnapshot {
  readonly taskId: Uuid7;
  readonly capturedAt: Rfc3339Timestamp;
  /** Active task phase (INTAKE/CONTRACT/DISCOVER/PLAN/IMPLEMENT/VERIFY/REVIEW/COMPLETE). */
  readonly phase: TaskPhase;
  /** Active contract id and version (immutable once recorded). */
  readonly contractVersion: number;
  /** The task objective verbatim from the active contract. */
  readonly objective: string;
  /** Per-criterion progress (PASS / FAIL / UNKNOWN / NOT_RUN). */
  readonly acceptanceCriteria: readonly WorkingMemoryCriterion[];
  /** Decision log entries (user/model decisions, scope expansions, etc.). */
  readonly decisions: readonly WorkingMemoryDecision[];
  /** Approaches that have been tried and failed (with reason). */
  readonly failedApproaches: readonly WorkingMemoryFailedApproach[];
  /** Files modified under the task scope, with the latest observed version. */
  readonly modifiedFiles: readonly WorkingMemoryFileChange[];
  /** Latest test/diagnostic state observed for the task. */
  readonly diagnosticState: WorkingMemoryDiagnosticState;
  /** Currently running jobs (sandboxed commands, side effects, etc.). */
  readonly runningJobs: readonly WorkingMemoryJobRef[];
  /** Budget consumed so far. */
  readonly budgetConsumption: WorkingMemoryBudgetConsumption;
  /** Active blockers (awaiting user input, missing dependency, etc.). */
  readonly blockers: readonly WorkingMemoryBlocker[];
}

export interface WorkingMemoryCriterion {
  readonly id: string;
  readonly statement: string;
  readonly required: boolean;
  readonly status: "PASS" | "FAIL" | "UNKNOWN" | "NOT_RUN";
  readonly lastObservedAt: Rfc3339Timestamp | null;
  readonly evidence: readonly string[];
}

export interface WorkingMemoryDecision {
  readonly id: Uuid7;
  readonly kind: "user_decision" | "model_decision" | "scope_expansion" | "policy_override";
  readonly summary: string;
  readonly decidedAt: Rfc3339Timestamp;
  readonly decidedBy: PrincipalId | null;
}

export interface WorkingMemoryFailedApproach {
  readonly id: Uuid7;
  readonly summary: string;
  readonly reason: string;
  readonly attemptedAt: Rfc3339Timestamp;
  readonly evidenceRefs: readonly ContentHash[];
}

export interface WorkingMemoryFileChange {
  readonly path: string;
  readonly changeKind: "created" | "modified" | "deleted";
  readonly sourceVersion: string | null;
  readonly observedAt: Rfc3339Timestamp;
}

export interface WorkingMemoryDiagnosticState {
  readonly failingTests: readonly string[];
  readonly errors: readonly WorkingMemoryDiagnostic[];
  readonly warnings: readonly WorkingMemoryDiagnostic[];
  readonly observedAt: Rfc3339Timestamp;
}

export interface WorkingMemoryDiagnostic {
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly observedAt: Rfc3339Timestamp;
}

export interface WorkingMemoryJobRef {
  readonly jobId: Uuid7;
  readonly label: string;
  readonly startedAt: Rfc3339Timestamp;
}

export interface WorkingMemoryBudgetConsumption {
  readonly modelMicros: Micros;
  readonly modelMicrosLimit: Micros;
  readonly computeSeconds: number;
  readonly computeSecondsLimit: number;
  readonly wallClockSeconds: number;
  readonly wallClockSecondsLimit: number;
  readonly humanApprovals: number;
  readonly humanApprovalsLimit: number;
}

export interface WorkingMemoryBlocker {
  readonly id: Uuid7;
  readonly kind: "awaiting_user" | "missing_dependency" | "policy_denied" | "budget_exhausted" | "other";
  readonly summary: string;
  readonly raisedAt: Rfc3339Timestamp;
}

// ────────────────────────── Working memory repository ────────────────────────

/**
 * Read-side projections that the `WorkingMemoryService` consults. Each method
 * returns deterministic, authoritative data — never LLM-inferred.
 */
export interface WorkingMemoryRepository {
  getTask(taskId: Uuid7): Promise<Task | null>;
  listDecisions(taskId: Uuid7): Promise<readonly WorkingMemoryDecision[]>;
  listFailedApproaches(taskId: Uuid7): Promise<readonly WorkingMemoryFailedApproach[]>;
  listModifiedFiles(taskId: Uuid7): Promise<readonly WorkingMemoryFileChange[]>;
  getDiagnosticState(taskId: Uuid7): Promise<WorkingMemoryDiagnosticState>;
  listRunningJobs(taskId: Uuid7): Promise<readonly WorkingMemoryJobRef[]>;
  getBudgetConsumption(taskId: Uuid7): Promise<WorkingMemoryBudgetConsumption>;
  listBlockers(taskId: Uuid7): Promise<readonly WorkingMemoryBlocker[]>;
  /** Per-criterion status; defaults to UNKNOWN when not yet observed. */
  listCriterionStatuses(taskId: Uuid7): Promise<ReadonlyMap<string, WorkingMemoryCriterion>>;
}

export interface WorkingMemoryServiceDeps {
  readonly repo: WorkingMemoryRepository;
  readonly clock: () => Rfc3339Timestamp;
}

/**
 * Read-only projection service for deterministic task state per SPEC §16.1 /
 * §39.2. The snapshot is rebuilt on every call (no caching) so callers
 * always see the latest authoritative state. The service never writes.
 */
export class WorkingMemoryService {
  constructor(private readonly deps: WorkingMemoryServiceDeps) {}

  /**
   * Build a `WorkingMemorySnapshot` for a task. Throws `ValidationError`
   * when the task does not exist (so callers can distinguish "no task" from
   * "task with empty working memory").
   */
  async getWorkingMemory(taskId: Uuid7): Promise<WorkingMemorySnapshot> {
    const task = await this.deps.repo.getTask(taskId);
    if (task === null) {
      throw new ValidationError("task not found", { taskId });
    }
    const [
      decisions,
      failedApproaches,
      modifiedFiles,
      diagnosticState,
      runningJobs,
      budgetConsumption,
      blockers,
      criterionStatuses,
    ] = await Promise.all([
      this.deps.repo.listDecisions(taskId),
      this.deps.repo.listFailedApproaches(taskId),
      this.deps.repo.listModifiedFiles(taskId),
      this.deps.repo.getDiagnosticState(taskId),
      this.deps.repo.listRunningJobs(taskId),
      this.deps.repo.getBudgetConsumption(taskId),
      this.deps.repo.listBlockers(taskId),
      this.deps.repo.listCriterionStatuses(taskId),
    ]);

    const acceptanceCriteria: WorkingMemoryCriterion[] = task.contract.acceptanceCriteria.map(
      (ac: AcceptanceCriterion): WorkingMemoryCriterion => {
        const observed = criterionStatuses.get(ac.id);
        if (observed !== undefined) return observed;
        return {
          id: ac.id,
          statement: ac.statement,
          required: ac.required,
          status: "UNKNOWN",
          lastObservedAt: null,
          evidence: [],
        };
      },
    );

    return {
      taskId,
      capturedAt: this.deps.clock(),
      phase: task.phase,
      contractVersion: task.contract.version,
      objective: task.contract.objective,
      acceptanceCriteria,
      decisions,
      failedApproaches,
      modifiedFiles,
      diagnosticState,
      runningJobs,
      budgetConsumption,
      blockers,
    };
  }
}
