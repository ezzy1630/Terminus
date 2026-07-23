/**
 * Memory retrieval explanation (SPEC §39.8 — per-turn memory manifest).
 *
 * Every injected claim MUST expose why it was retrieved, its source,
 * scope, confidence, and freshness.
 */
import type {
  MemoryClaim,
  MemoryScope,
  MemoryProvenance,
  Rfc3339Timestamp,
} from "@terminus/domain";
import { isExpired } from "./contradiction.js";

export type FreshnessLabel = "fresh" | "aging" | "stale" | "expired" | "unverified";

export interface MemoryExplanation {
  readonly claimId: MemoryClaim["id"];
  readonly statement: string;
  /** Why this claim was selected for the query. */
  readonly whyRetrieved: string;
  /** Provenance summary (session/task/sources). */
  readonly source: MemorySourceExplanation;
  readonly scope: MemoryScope;
  /** Confidence in [0, 1]. */
  readonly confidence: number;
  readonly confidencePpm: number;
  readonly freshness: FreshnessLabel;
  readonly freshnessDetail: string;
  readonly lastVerifiedAt: Rfc3339Timestamp | null;
  readonly lexicalScore: number;
  readonly semanticScore: number | null;
}

export interface MemorySourceExplanation {
  readonly sessionId: MemoryProvenance["createdFromSession"];
  readonly taskId: MemoryProvenance["createdFromTask"];
  readonly extractorModel: MemoryProvenance["extractorModel"];
  readonly extractorVersion: string;
  readonly sourceCount: number;
  readonly sourceHashes: readonly string[];
  readonly complete: boolean;
}

export interface ExplainInput {
  readonly claim: MemoryClaim;
  readonly query: string;
  readonly now: Rfc3339Timestamp;
  readonly lexicalScore: number;
  readonly semanticScore: number | null;
  readonly rankReasons: readonly string[];
}

/**
 * Build a structured explanation for a retrieved claim.
 */
export function explainRetrieval(input: ExplainInput): MemoryExplanation {
  const { claim, query, now, lexicalScore, semanticScore, rankReasons } = input;
  const confidence = claim.confidencePpm / 1_000_000;
  const source = explainSource(claim.provenance);
  const freshness = freshnessLabel(claim, now);
  const why =
    rankReasons.length > 0
      ? rankReasons.join("; ")
      : defaultWhy(query, lexicalScore, semanticScore, confidence);

  return {
    claimId: claim.id,
    statement: claim.statement,
    whyRetrieved: why,
    source,
    scope: claim.scope,
    confidence,
    confidencePpm: claim.confidencePpm,
    freshness: freshness.label,
    freshnessDetail: freshness.detail,
    lastVerifiedAt: claim.verification.lastVerifiedAt,
    lexicalScore,
    semanticScore,
  };
}

export function explainSource(provenance: MemoryProvenance): MemorySourceExplanation {
  const sourceHashes = provenance.sources.map((s) => s.hash);
  const complete =
    provenance.createdFromTask !== null &&
    provenance.extractorVersion.length > 0 &&
    provenance.sources.length > 0;

  return {
    sessionId: provenance.createdFromSession,
    taskId: provenance.createdFromTask,
    extractorModel: provenance.extractorModel,
    extractorVersion: provenance.extractorVersion,
    sourceCount: provenance.sources.length,
    sourceHashes,
    complete,
  };
}

/** Provenance is complete when task, extractor version, and ≥1 source exist. */
export function hasCompleteProvenance(claim: MemoryClaim): boolean {
  return explainSource(claim.provenance).complete;
}

function freshnessLabel(
  claim: MemoryClaim,
  now: Rfc3339Timestamp,
): { readonly label: FreshnessLabel; readonly detail: string } {
  if (isExpired(claim, now)) {
    return { label: "expired", detail: `expiresAt=${claim.validity.expiresAt}` };
  }
  if (claim.verification.lastVerifiedAt === null) {
    return { label: "unverified", detail: "never verified" };
  }
  const verifiedMs = Date.parse(claim.verification.lastVerifiedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(verifiedMs) || !Number.isFinite(nowMs)) {
    return { label: "unverified", detail: "unparseable timestamps" };
  }
  const ageMs = nowMs - verifiedMs;
  const day = 86_400_000;
  if (ageMs <= day) return { label: "fresh", detail: `verified ${ageMs}ms ago` };
  if (ageMs <= 7 * day) return { label: "aging", detail: `verified ${ageMs}ms ago` };
  return { label: "stale", detail: `verified ${ageMs}ms ago` };
}

function defaultWhy(
  query: string,
  lexicalScore: number,
  semanticScore: number | null,
  confidence: number,
): string {
  const parts = [
    `lexical_bm25=${lexicalScore.toFixed(4)}`,
    `confidence=${confidence.toFixed(3)}`,
  ];
  if (semanticScore !== null) {
    parts.push(`semantic=${semanticScore.toFixed(4)}`);
  }
  parts.push(`query=${JSON.stringify(query.slice(0, 80))}`);
  return parts.join("; ");
}
