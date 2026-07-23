/**
 * Contradiction, supersession, expiry, and authority rules (SPEC §39.5–§39.6).
 *
 * Pure helpers: no I/O. Curator and retrieval call these to decide claim status.
 */
import type { MemoryClaim, MemoryClaimKind, Rfc3339Timestamp } from "@terminus/domain";

const NEGATION_PREFIXES = [
  "not ",
  "never ",
  "don't ",
  "do not ",
  "cannot ",
  "can't ",
  "no ",
] as const;

/**
 * Heuristic contradiction detector. Detects mutual negation of the same stem
 * and explicit "X, not Y" / "prefer X over Y" conflicts on shared tokens.
 * Production curators MAY replace this with an LLM judge behind the sandbox.
 */
export function isContradiction(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);
  if (left === right) return false;

  for (const n of NEGATION_PREFIXES) {
    if (left.startsWith(n) && right === left.slice(n.length)) return true;
    if (right.startsWith(n) && left === right.slice(n.length)) return true;
  }

  // Shared content words with opposing polarity markers.
  const leftNeg = NEGATION_PREFIXES.some((n) => left.includes(n));
  const rightNeg = NEGATION_PREFIXES.some((n) => right.includes(n));
  if (leftNeg !== rightNeg) {
    const shared = contentTokens(left).filter((t) => contentTokens(right).includes(t));
    if (shared.length >= 2) return true;
  }
  return false;
}

export type AuthorityRank =
  | "repository_authority"
  | "user_explicit"
  | "verified_procedure"
  | "curated_claim"
  | "candidate";

/** Authority cannot be overridden by lower-ranked memory. */
export function authorityRank(kind: MemoryClaimKind, status: MemoryClaim["status"]): AuthorityRank {
  if (status === "candidate") return "candidate";
  switch (kind) {
    case "procedure":
      return "verified_procedure";
    case "preference":
      return "user_explicit";
    case "architecture":
    case "convention":
    case "command":
    case "fact":
    case "pitfall":
    case "failure_resolution":
      return "curated_claim";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

const AUTHORITY_ORDER: Readonly<Record<AuthorityRank, number>> = {
  repository_authority: 100,
  user_explicit: 80,
  verified_procedure: 60,
  curated_claim: 40,
  candidate: 10,
};

export function canOverride(challenger: AuthorityRank, incumbent: AuthorityRank): boolean {
  return AUTHORITY_ORDER[challenger] > AUTHORITY_ORDER[incumbent];
}

/**
 * Decide whether `newer` should supersede `older`. Same kind + overlapping
 * statement tokens + higher or equal confidence + not contradicting authority.
 */
export function shouldSupersede(newer: MemoryClaim, older: MemoryClaim): boolean {
  if (newer.kind !== older.kind) return false;
  if (newer.status === "rejected" || newer.status === "expired") return false;
  if (older.status !== "active" && older.status !== "disputed") return false;
  if (isContradiction(newer.statement, older.statement)) return false;

  const newerRank = authorityRank(newer.kind, newer.status);
  const olderRank = authorityRank(older.kind, older.status);
  if (!canOverride(newerRank, olderRank) && newerRank !== olderRank) return false;

  const overlap = jaccard(contentTokens(newer.statement), contentTokens(older.statement));
  if (overlap < 0.5) return false;
  return newer.confidencePpm >= older.confidencePpm;
}

export function isExpired(claim: MemoryClaim, now: Rfc3339Timestamp): boolean {
  if (claim.status === "expired") return true;
  if (claim.validity.expiresAt === null) return false;
  return claim.validity.expiresAt <= now;
}

export function isWithinValidityWindow(claim: MemoryClaim, now: Rfc3339Timestamp): boolean {
  if (claim.validity.startsAt > now) return false;
  return !isExpired(claim, now);
}

export type RelationDecision =
  | { readonly kind: "duplicate"; readonly of: MemoryClaim }
  | { readonly kind: "contradicts"; readonly other: MemoryClaim }
  | { readonly kind: "supersedes"; readonly older: MemoryClaim }
  | { readonly kind: "superseded_by"; readonly newer: MemoryClaim }
  | { readonly kind: "independent" };

/**
 * Classify how a candidate relates to one active claim.
 */
export function relateClaims(candidate: MemoryClaim, active: MemoryClaim): RelationDecision {
  if (normalize(candidate.statement) === normalize(active.statement)) {
    return { kind: "duplicate", of: active };
  }
  if (isContradiction(candidate.statement, active.statement)) {
    return { kind: "contradicts", other: active };
  }
  if (shouldSupersede(candidate, active)) {
    return { kind: "supersedes", older: active };
  }
  if (shouldSupersede(active, candidate)) {
    return { kind: "superseded_by", newer: active };
  }
  return { kind: "independent" };
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function contentTokens(s: string): readonly string[] {
  return normalize(s)
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 2);
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}
