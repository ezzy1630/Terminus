/**
 * Scoped retrieval: BM25 lexical + optional semantic (SPEC §39.6).
 *
 * Semantic similarity is opt-in via an injected scorer; default path is
 * lexical only. Results are revalidated and explained before return.
 */
import type { MemoryClaim, MemoryScope, Rfc3339Timestamp, Uuid7 } from "@terminus/domain";
import { bm25Score, tokenize, type Bm25Params, DEFAULT_BM25_PARAMS } from "./bm25.js";
import { isWithinValidityWindow } from "./contradiction.js";
import {
  explainRetrieval,
  hasCompleteProvenance,
  type MemoryExplanation,
} from "./explain.js";
import {
  revalidateClaim,
  type RevalidationContext,
  type RevalidationHook,
  defaultRevalidationHooks,
} from "./revalidate.js";

export interface SemanticScorer {
  /** Similarity in [0, 1]. */
  score(query: string, statement: string): number;
}

export interface RetrieveOptions {
  readonly query: string;
  readonly scope: Partial<MemoryScope>;
  readonly now: Rfc3339Timestamp;
  readonly limit?: number;
  readonly enableSemantic?: boolean;
  readonly semanticScorer?: SemanticScorer;
  readonly semanticWeight?: number;
  readonly bm25Params?: Bm25Params;
  readonly revalidation?: RevalidationContext;
  readonly revalidationHooks?: readonly RevalidationHook[];
  /** Drop claims lacking complete provenance (default true). */
  readonly requireProvenance?: boolean;
  readonly taskPhase?: string;
}

export interface RetrievedMemory {
  readonly claim: MemoryClaim;
  readonly lexicalScore: number;
  readonly semanticScore: number | null;
  readonly combinedScore: number;
  readonly explanation: MemoryExplanation;
}

export function scopeMatches(claim: MemoryClaim, scope: Partial<MemoryScope>): boolean {
  if (scope.organization != null && claim.scope.organization !== scope.organization) {
    return false;
  }
  if (scope.user != null && claim.scope.user !== scope.user) {
    return false;
  }
  if (scope.workspaceId != null && claim.scope.workspaceId !== scope.workspaceId) {
    // No default cross-workspace sharing (§39.8).
    return false;
  }
  if (scope.pathPatterns != null && scope.pathPatterns.length > 0) {
    if (claim.scope.pathPatterns.length === 0) return true;
    const overlap = claim.scope.pathPatterns.some((p) =>
      scope.pathPatterns!.some((s) => pathOverlap(p, s)),
    );
    if (!overlap) return false;
  }
  return true;
}

function pathOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("/**")) {
    const prefix = a.slice(0, -3);
    return b === prefix || b.startsWith(prefix + "/");
  }
  if (b.endsWith("/**")) {
    const prefix = b.slice(0, -3);
    return a === prefix || a.startsWith(prefix + "/");
  }
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Rank active claims for a query. Expired, disputed, provenance-incomplete,
 * and failed-revalidation claims are excluded.
 */
export function retrieveMemories(
  claims: readonly MemoryClaim[],
  options: RetrieveOptions,
): readonly RetrievedMemory[] {
  const limit = options.limit ?? 10;
  const requireProvenance = options.requireProvenance ?? true;
  const semanticWeight = options.semanticWeight ?? 0.35;
  const enableSemantic = options.enableSemantic === true && options.semanticScorer != null;
  const hooks = options.revalidationHooks ?? defaultRevalidationHooks();

  const eligible = claims.filter((c) => {
    if (c.status !== "active") return false;
    if (!isWithinValidityWindow(c, options.now)) return false;
    if (!scopeMatches(c, options.scope)) return false;
    if (requireProvenance && !hasCompleteProvenance(c)) return false;
    return true;
  });

  const corpus = eligible.map((c) => ({
    id: c.id as string,
    tokens: tokenize(c.statement),
  }));
  const queryTokens = tokenize(options.query);

  const scored: RetrievedMemory[] = [];
  for (const claim of eligible) {
    if (options.revalidation !== undefined) {
      const outcome = revalidateClaim(claim, options.revalidation, hooks);
      if (outcome.status === "stale") continue;
    }

    const doc = { id: claim.id as string, tokens: tokenize(claim.statement) };
    const lexical = bm25Score(queryTokens, doc, corpus, options.bm25Params ?? DEFAULT_BM25_PARAMS);
    if (lexical <= 0 && !enableSemantic) continue;

    const semantic =
      enableSemantic && options.semanticScorer
        ? options.semanticScorer.score(options.query, claim.statement)
        : null;

    const combined =
      semantic === null
        ? lexical
        : lexical * (1 - semanticWeight) + semantic * semanticWeight;

    // Soft boosts: confidence, freshness, successful prior use.
    const confidenceBoost = claim.confidencePpm / 1_000_000;
    const successBoost = Math.min(claim.usage.successfulUses, 10) * 0.02;
    const harmPenalty = claim.usage.harmfulUses * 0.15;
    const finalScore = combined * (0.5 + 0.5 * confidenceBoost) + successBoost - harmPenalty;
    if (finalScore <= 0) continue;

    const rankReasons = [
      `bm25=${lexical.toFixed(4)}`,
      `confidence_ppm=${claim.confidencePpm}`,
      `successful_uses=${claim.usage.successfulUses}`,
    ];
    if (semantic !== null) rankReasons.push(`semantic=${semantic.toFixed(4)}`);
    if (options.taskPhase !== undefined) rankReasons.push(`phase=${options.taskPhase}`);

    scored.push({
      claim,
      lexicalScore: lexical,
      semanticScore: semantic,
      combinedScore: finalScore,
      explanation: explainRetrieval({
        claim,
        query: options.query,
        now: options.now,
        lexicalScore: lexical,
        semanticScore: semantic,
        rankReasons,
      }),
    });
  }

  return scored
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);
}

export function retrievedIds(results: readonly RetrievedMemory[]): readonly Uuid7[] {
  return results.map((r) => r.claim.id);
}
