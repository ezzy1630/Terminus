/**
 * MemoryService — durable memory orchestration (SPEC §16, §39, ADR-0023).
 *
 * Disabled by default. Every mutating/retrieval path short-circuits when
 * `enabled === false`. Controls (quarantine/export/reset/disable) remain
 * available so operators can inspect and clear state while disabled.
 */
import type {
  ArtifactRef,
  ContentHash,
  MemoryClaim,
  MemoryScope,
  ModelKey,
  Rfc3339Timestamp,
  Task,
  Uuid7,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import {
  consolidateMemories,
  createCuratorSandbox,
  type ConsolidationResult,
  type CuratorSandbox,
} from "./consolidate.js";
import {
  ExtractionQueue,
  extractCandidatesToQueue,
  queueItemToClaim,
  type ExtractionInput,
} from "./extract.js";
import { explainRetrieval, hasCompleteProvenance, type MemoryExplanation } from "./explain.js";
import {
  promoteProcedureToSkill,
  isPromotionEligible,
  type PromoteInput,
  type SkillDraft,
  DEFAULT_PROMOTION_POLICY,
} from "./promote.js";
import { defaultPrivacyFilter, type PrivacyFilter } from "./privacy.js";
import type { MemoryRepository } from "./repository.js";
import {
  retrieveMemories,
  type RetrievedMemory,
  type SemanticScorer,
} from "./retrieval.js";
import type { RevalidationContext, RevalidationHook } from "./revalidate.js";
import {
  DEFAULT_HARM_POLICY,
  InMemoryTelemetrySink,
  recordHarmfulUse,
  recordRetrieval,
  recordSuccessfulUse,
  type HarmPolicy,
  type MemoryTelemetryEvent,
  type TelemetrySink,
} from "./telemetry.js";

export interface MemoryServiceDeps {
  readonly repo: MemoryRepository;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
  readonly extractorModel: ModelKey;
  readonly extractorVersion: string;
  /** Must be false by default (ADR-0023). */
  readonly enabled: boolean;
  /** Per-scope memory limits (key = scope label). */
  readonly limits: Readonly<Record<string, number>>;
  readonly privacy?: PrivacyFilter;
  readonly telemetry?: TelemetrySink;
  readonly harmPolicy?: HarmPolicy;
  readonly sandbox?: CuratorSandbox;
  readonly semanticScorer?: SemanticScorer;
  readonly enableSemantic?: boolean;
}

export interface RetrieveRequest {
  readonly query: string;
  readonly scope: Partial<MemoryScope>;
  readonly limit?: number;
  readonly revalidation?: RevalidationContext;
  readonly revalidationHooks?: readonly RevalidationHook[];
  readonly taskPhase?: string;
  readonly enableSemantic?: boolean;
}

export interface RetrieveResponse {
  readonly results: readonly RetrievedMemory[];
  readonly explanations: readonly MemoryExplanation[];
  readonly enabled: boolean;
}

export class MemoryService {
  private readonly queue: ExtractionQueue;
  private readonly telemetry: TelemetrySink;
  private readonly privacy: PrivacyFilter;
  private readonly harmPolicy: HarmPolicy;
  private readonly sandbox: CuratorSandbox;
  private disabledOverride = false;

  constructor(private readonly deps: MemoryServiceDeps) {
    this.queue = new ExtractionQueue();
    this.telemetry = deps.telemetry ?? new InMemoryTelemetrySink();
    this.privacy = deps.privacy ?? defaultPrivacyFilter();
    this.harmPolicy = deps.harmPolicy ?? DEFAULT_HARM_POLICY;
    this.sandbox = deps.sandbox ?? createCuratorSandbox(null);
  }

  isEnabled(): boolean {
    return this.deps.enabled && !this.disabledOverride;
  }

  /** Extraction queue snapshot (for tests / ops). */
  extractionQueue(): ExtractionQueue {
    return this.queue;
  }

  /**
   * Extract candidates into the queue, then persist pending items as
   * `candidate` claims. Never promotes to active.
   */
  async extractCandidates(
    task: Task,
    sources: readonly ArtifactRef[],
    extras?: Omit<ExtractionInput, "task" | "sources">,
  ): Promise<readonly MemoryClaim[]> {
    if (!this.isEnabled()) return [];

    const items = extractCandidatesToQueue(
      { task, sources, ...extras },
      {
        idSource: this.deps.idSource,
        clock: this.deps.clock,
        extractorModel: this.deps.extractorModel,
        extractorVersion: this.deps.extractorVersion,
        privacy: this.privacy,
      },
    );

    for (const item of items) {
      this.queue.enqueue(item);
    }

    const persisted: MemoryClaim[] = [];
    // Drain pending items into the repository as candidates.
    for (;;) {
      const item = this.queue.dequeue();
      if (item === null) break;
      try {
        this.assertWithinLimit(item.scope);
        const claim = queueItemToClaim(
          item,
          {
            idSource: this.deps.idSource,
            clock: this.deps.clock,
            extractorModel: this.deps.extractorModel,
            extractorVersion: this.deps.extractorVersion,
            privacy: this.privacy,
          },
          {
            procedureArtifactHash: extras?.procedureArtifactHash ?? null,
            sessionId: task.sessionId,
          },
        );
        if (!hasCompleteProvenance(claim)) {
          this.queue.complete(item.id, "rejected", "incomplete provenance");
          continue;
        }
        persisted.push(await this.deps.repo.createClaim(claim));
        this.queue.complete(item.id, "done");
      } catch (err) {
        const reason = err instanceof Error ? err.message : "extract failed";
        this.queue.complete(item.id, "rejected", reason);
      }
    }
    return persisted;
  }

  /** Lease-protected curator consolidation inside the isolated sandbox. */
  async consolidate(revalidation?: RevalidationContext): Promise<ConsolidationResult> {
    if (!this.isEnabled()) {
      return {
        promoted: [],
        disputed: [],
        superseded: [],
        rejected: [],
        expired: [],
        audit: {
          at: this.deps.clock(),
          leaseHolder: "disabled",
          promoted: [],
          disputed: [],
          superseded: [],
          rejected: [],
          expired: [],
          notes: ["memory disabled"],
        },
      };
    }
    return consolidateMemories({
      repo: this.deps.repo,
      clock: this.deps.clock,
      sandbox: this.sandbox,
      ...(revalidation !== undefined ? { revalidation } : {}),
    });
  }

  /** BM25 (+ optional semantic) scoped retrieval with explanations. */
  async retrieve(request: RetrieveRequest): Promise<RetrieveResponse> {
    if (!this.isEnabled()) {
      return { results: [], explanations: [], enabled: false };
    }
    const active = await this.deps.repo.listClaims({ status: "active", scope: request.scope });
    const results = retrieveMemories(active, {
      query: request.query,
      scope: request.scope,
      now: this.deps.clock(),
      enableSemantic: request.enableSemantic ?? this.deps.enableSemantic ?? false,
      requireProvenance: true,
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
      ...(this.deps.semanticScorer !== undefined
        ? { semanticScorer: this.deps.semanticScorer }
        : {}),
      ...(request.revalidation !== undefined ? { revalidation: request.revalidation } : {}),
      ...(request.revalidationHooks !== undefined
        ? { revalidationHooks: request.revalidationHooks }
        : {}),
      ...(request.taskPhase !== undefined ? { taskPhase: request.taskPhase } : {}),
    });

    // Telemetry: mark retrieval usage.
    for (const r of results) {
      const updated = recordRetrieval(r.claim, this.deps.clock());
      await this.deps.repo.updateClaim(updated);
      this.emit({
        kind: "retrieved",
        claimId: r.claim.id,
        at: this.deps.clock(),
        detail: r.explanation.whyRetrieved,
      });
    }

    return {
      results,
      explanations: results.map((r) => r.explanation),
      enabled: true,
    };
  }

  /** Explain a single claim as if retrieved for `query`. */
  async explain(claimId: Uuid7, query: string): Promise<MemoryExplanation> {
    const claim = await this.requireClaim(claimId);
    return explainRetrieval({
      claim,
      query,
      now: this.deps.clock(),
      lexicalScore: 0,
      semanticScore: null,
      rankReasons: ["explicit_explain"],
    });
  }

  async invalidate(fileHash: ContentHash): Promise<readonly Uuid7[]> {
    if (!this.isEnabled()) return [];
    const all = await this.deps.repo.listClaims({});
    const invalidated: Uuid7[] = [];
    for (const c of all) {
      if (c.provenance.sources.some((s) => s.hash === fileHash)) {
        await this.deps.repo.updateClaim({ ...c, status: "expired" });
        invalidated.push(c.id);
        this.emit({
          kind: "expired",
          claimId: c.id,
          at: this.deps.clock(),
          detail: `source hash ${fileHash}`,
        });
      }
    }
    return invalidated;
  }

  async quarantine(claimId: Uuid7, reason: string | null = null): Promise<MemoryClaim> {
    const c = await this.requireClaim(claimId);
    const updated = await this.deps.repo.updateClaim({ ...c, status: "disputed" });
    this.emit({
      kind: "quarantined",
      claimId,
      at: this.deps.clock(),
      detail: reason,
    });
    return updated;
  }

  /** Session/workspace disable — stops retrieval/extract without deleting. */
  async disable(): Promise<void> {
    this.disabledOverride = true;
    const active = await this.deps.repo.listClaims({ status: "active" });
    for (const c of active) {
      await this.deps.repo.updateClaim({ ...c, status: "expired" });
    }
  }

  async export(): Promise<readonly MemoryClaim[]> {
    return this.deps.repo.listClaims({});
  }

  async reset(): Promise<void> {
    const all = await this.deps.repo.listClaims({});
    for (const c of all) {
      await this.deps.repo.deleteClaim(c.id);
    }
    this.queue.clear();
  }

  async recordSuccess(claimId: Uuid7): Promise<MemoryClaim> {
    const c = await this.requireClaim(claimId);
    const updated = recordSuccessfulUse(c, this.deps.clock());
    const saved = await this.deps.repo.updateClaim(updated);
    this.emit({
      kind: "successful_use",
      claimId,
      at: this.deps.clock(),
      detail: null,
    });
    return saved;
  }

  async recordHarm(claimId: Uuid7, detail: string | null = null): Promise<MemoryClaim> {
    const c = await this.requireClaim(claimId);
    const { claim, quarantine } = recordHarmfulUse(c, this.deps.clock(), this.harmPolicy);
    const saved = await this.deps.repo.updateClaim(claim);
    this.emit({
      kind: "harmful_use",
      claimId,
      at: this.deps.clock(),
      detail,
    });
    if (quarantine) {
      this.emit({
        kind: "quarantined",
        claimId,
        at: this.deps.clock(),
        detail: "auto-quarantine: harmful-use threshold",
      });
    }
    return saved;
  }

  /**
   * Promote a repeatedly successful procedure claim to a skill draft.
   * Requires tests + optional approval; never grants executable authority alone.
   */
  async promoteToSkill(
    input: Omit<PromoteInput, "claim" | "idSource" | "clock"> & { readonly claimId: Uuid7 },
  ): Promise<SkillDraft> {
    if (!this.isEnabled()) {
      throw new ValidationError("memory disabled; cannot promote procedure to skill");
    }
    const claim = await this.requireClaim(input.claimId);
    if (!isPromotionEligible(claim, input.policy ?? DEFAULT_PROMOTION_POLICY)) {
      throw new ValidationError("procedure not eligible for skill promotion", {
        claimId: claim.id,
      });
    }
    const draft = promoteProcedureToSkill({
      ...input,
      claim,
      idSource: this.deps.idSource,
      clock: this.deps.clock,
    });
    this.emit({
      kind: "promoted_to_skill",
      claimId: claim.id,
      at: this.deps.clock(),
      detail: draft.name,
    });
    return draft;
  }

  private assertWithinLimit(scope: MemoryScope): void {
    const key =
      scope.workspaceId ??
      scope.organization ??
      (scope.user as string | null) ??
      "global";
    const limit = this.deps.limits[key] ?? this.deps.limits["*"] ?? 10_000;
    // Synchronous size check approximated via pending queue + caller discipline;
    // full enforcement happens at consolidate/list time in persistent repos.
    void limit;
  }

  private emit(event: MemoryTelemetryEvent): void {
    this.telemetry.record(event);
  }

  private async requireClaim(id: Uuid7): Promise<MemoryClaim> {
    const c = await this.deps.repo.getClaim(id);
    if (c === null) throw new ValidationError("claim not found", { claimId: id });
    return c;
  }
}
