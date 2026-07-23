/**
 * Candidate extraction queue (SPEC §39.4, M10 task 1).
 *
 * Candidates are enqueued from sufficiently complete tasks, privacy-filtered,
 * provenance-linked, and never promoted directly to active memory.
 */
import type {
  ArtifactRef,
  ContentHash,
  InvalidationRule,
  MemoryClaim,
  MemoryClaimKind,
  MemoryProvenance,
  MemoryRelations,
  MemoryScope,
  MemoryUsage,
  MemoryValidity,
  MemoryVerification,
  ModelKey,
  Rfc3339Timestamp,
  Task,
  Uuid7,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import { assertStorableStatement, type PrivacyFilter, defaultPrivacyFilter } from "./privacy.js";

export type ExtractionQueueStatus = "pending" | "processing" | "done" | "rejected";

export interface ExtractionQueueItem {
  readonly id: Uuid7;
  readonly taskId: Uuid7;
  readonly kind: MemoryClaimKind;
  readonly statement: string;
  readonly sources: readonly ArtifactRef[];
  readonly scope: MemoryScope;
  readonly invalidationRules: readonly InvalidationRule[];
  readonly confidencePpm: number;
  readonly status: ExtractionQueueStatus;
  readonly rejectReason: string | null;
  readonly enqueuedAt: Rfc3339Timestamp;
}

export interface ExtractionInput {
  readonly task: Task;
  /** Evidence / checkpoint / diff artifacts supporting the claims. */
  readonly sources: readonly ArtifactRef[];
  /** Optional explicit user statements to extract as preferences. */
  readonly userStatements?: readonly string[];
  /** Optional procedure artifact hash for procedure claims. */
  readonly procedureArtifactHash?: ContentHash | null;
  readonly scope?: Partial<MemoryScope>;
}

export interface ExtractorDeps {
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
  readonly extractorModel: ModelKey;
  readonly extractorVersion: string;
  readonly privacy?: PrivacyFilter;
}

/**
 * In-process FIFO extraction queue. Persists nothing; the service drains
 * items into `MemoryRepository` as `candidate` claims.
 */
export class ExtractionQueue {
  private readonly items: ExtractionQueueItem[] = [];

  enqueue(item: ExtractionQueueItem): void {
    this.items.push(item);
  }

  peek(): ExtractionQueueItem | null {
    return this.items.find((i) => i.status === "pending") ?? null;
  }

  dequeue(): ExtractionQueueItem | null {
    const idx = this.items.findIndex((i) => i.status === "pending");
    if (idx < 0) return null;
    const item = this.items[idx]!;
    const next: ExtractionQueueItem = { ...item, status: "processing" };
    this.items[idx] = next;
    return next;
  }

  complete(id: Uuid7, status: "done" | "rejected", rejectReason: string | null = null): void {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return;
    this.items[idx] = { ...this.items[idx]!, status, rejectReason };
  }

  list(status?: ExtractionQueueStatus): readonly ExtractionQueueItem[] {
    if (status === undefined) return [...this.items];
    return this.items.filter((i) => i.status === status);
  }

  size(status?: ExtractionQueueStatus): number {
    return this.list(status).length;
  }

  clear(): void {
    this.items.length = 0;
  }
}

/**
 * Build queue items from a completed (or sufficiently complete) task.
 * Incomplete tasks yield an empty list. Secrets are rejected / redacted.
 */
export function extractCandidatesToQueue(
  input: ExtractionInput,
  deps: ExtractorDeps,
): readonly ExtractionQueueItem[] {
  if (!isExtractable(input.task)) {
    return [];
  }
  if (input.sources.length === 0) {
    throw new ValidationError("memory extraction requires complete source provenance", {
      taskId: input.task.id,
    });
  }

  const privacy = deps.privacy ?? defaultPrivacyFilter();
  const now = deps.clock();
  const scope = resolveScope(input);
  const items: ExtractionQueueItem[] = [];

  const push = (
    kind: MemoryClaimKind,
    rawStatement: string,
    confidencePpm: number,
    rules: readonly InvalidationRule[],
  ): void => {
    let statement: string;
    try {
      statement = assertStorableStatement(rawStatement, privacy);
    } catch (err) {
      items.push({
        id: deps.idSource(),
        taskId: input.task.id,
        kind,
        statement: rawStatement,
        sources: input.sources,
        scope,
        invalidationRules: rules,
        confidencePpm,
        status: "rejected",
        rejectReason: err instanceof ValidationError ? err.message : "privacy rejected",
        enqueuedAt: now,
      });
      return;
    }
    items.push({
      id: deps.idSource(),
      taskId: input.task.id,
      kind,
      statement,
      sources: input.sources,
      scope,
      invalidationRules: rules,
      confidencePpm,
      status: "pending",
      rejectReason: null,
      enqueuedAt: now,
    });
  };

  // Deterministic facts from the contract — conservative confidence.
  push(
    "fact",
    `Task objective: ${input.task.contract.objective}`,
    250_000,
    pathRules(input.task.contract.allowedScope.writePaths),
  );

  for (const ac of input.task.contract.acceptanceCriteria) {
    push(
      "convention",
      `Acceptance criterion: ${ac.statement}`,
      300_000,
      pathRules(input.task.contract.allowedScope.writePaths),
    );
  }

  for (const constraint of input.task.contract.constraints) {
    push("convention", constraint, 350_000, pathRules(input.task.contract.allowedScope.writePaths));
  }

  for (const assumption of input.task.contract.assumptions) {
    // Assumptions are weaker — lower confidence, short TTL (7d).
    push("fact", assumption, 200_000, [
      ...pathRules(input.task.contract.allowedScope.writePaths),
      { kind: "ttl", selector: String(7 * 86_400_000) },
    ]);
  }

  for (const unknown of input.task.contract.unknowns) {
    push("pitfall", `Unknown: ${unknown}`, 150_000, [{ kind: "ttl", selector: String(3 * 86_400_000) }]);
  }

  for (const stmt of input.userStatements ?? []) {
    // Single ambiguous observation must not become a durable preference (§39.8).
    push("preference", stmt, 100_000, [{ kind: "ttl", selector: String(86_400_000) }]);
  }

  if (input.procedureArtifactHash != null) {
    push(
      "procedure",
      `Verified procedure from task ${input.task.id}`,
      400_000,
      pathRules(input.task.contract.allowedScope.writePaths),
    );
  }

  return items;
}

/**
 * Materialize a queue item into a `candidate` MemoryClaim with full provenance.
 */
export function queueItemToClaim(
  item: ExtractionQueueItem,
  deps: ExtractorDeps,
  extras?: {
    readonly procedureArtifactHash?: ContentHash | null;
    readonly sessionId?: Uuid7 | null;
  },
): MemoryClaim {
  if (item.status === "rejected") {
    throw new ValidationError("cannot materialize rejected extraction item", {
      itemId: item.id,
      reason: item.rejectReason,
    });
  }
  const statement = assertStorableStatement(item.statement, deps.privacy ?? defaultPrivacyFilter());
  const now = deps.clock();
  const provenance: MemoryProvenance = {
    sources: item.sources,
    createdFromSession: extras?.sessionId ?? null,
    createdFromTask: item.taskId,
    extractorModel: deps.extractorModel,
    extractorVersion: deps.extractorVersion,
  };
  const verification: MemoryVerification = {
    lastVerifiedAt: null,
    method: null,
    evidence: [],
  };
  const validity: MemoryValidity = {
    startsAt: now,
    expiresAt: null,
    invalidationRules: item.invalidationRules,
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
  return {
    id: item.id,
    kind: item.kind,
    statement,
    procedureArtifactHash: extras?.procedureArtifactHash ?? null,
    scope: item.scope,
    provenance,
    confidencePpm: item.confidencePpm,
    verification,
    validity,
    usage,
    relations,
    status: "candidate",
    createdAt: item.enqueuedAt,
  };
}

function isExtractable(task: Task): boolean {
  // Sufficiently complete: COMPLETE phase, or COMPLETED/FAILED_VERIFICATION with a contract.
  if (task.phase === "COMPLETE") return true;
  if (task.status === "COMPLETED") return true;
  // Explicit user-driven extraction may still run after failed verification
  // when evidence exists — but never during early phases.
  if (task.phase === "REVIEW" || task.phase === "VERIFY") return true;
  return false;
}

function resolveScope(input: ExtractionInput): MemoryScope {
  return {
    organization: input.scope?.organization ?? null,
    user: input.scope?.user ?? null,
    workspaceId: input.scope?.workspaceId ?? null,
    pathPatterns:
      input.scope?.pathPatterns ??
      input.task.contract.allowedScope.writePaths,
  };
}

function pathRules(paths: readonly string[]): readonly InvalidationRule[] {
  return paths.map((p) => ({ kind: "file_changed" as const, selector: p }));
}
