/**
 * Cheap revalidation hooks for durable memory (SPEC §39.6, ADR-0023).
 *
 * Rechecks claims against current workspace state before injection. Only
 * "cheap" methods run inline; expensive checks are deferred.
 */
import type {
  ContentHash,
  MemoryClaim,
  Rfc3339Timestamp,
  InvalidationRule,
} from "@terminus/domain";

export type RevalidationMethod =
  | "ttl"
  | "file_hash"
  | "symbol_presence"
  | "statement_unchanged"
  | "authority_override";

export type RevalidationOutcome =
  | {
      readonly status: "valid";
      readonly method: RevalidationMethod;
      readonly verifiedAt: Rfc3339Timestamp;
    }
  | {
      readonly status: "stale";
      readonly method: RevalidationMethod;
      readonly reason: string;
      readonly verifiedAt: Rfc3339Timestamp;
    }
  | {
      readonly status: "skipped";
      readonly method: RevalidationMethod;
      readonly reason: string;
    };

export interface RevalidationContext {
  readonly now: Rfc3339Timestamp;
  /** Current content hashes keyed by path (or selector). */
  readonly fileHashes: ReadonlyMap<string, ContentHash>;
  /** Symbols known to exist in the current workspace index. */
  readonly knownSymbols: ReadonlySet<string>;
  /**
   * Statements from higher-authority sources (AGENTS.md, ADRs) that memory
   * must not contradict. Memory never overrides these.
   */
  readonly authorityStatements: readonly string[];
}

export type RevalidationHook = (
  claim: MemoryClaim,
  ctx: RevalidationContext,
) => RevalidationOutcome;

const DEFAULT_HOOKS: readonly RevalidationHook[] = [
  revalidateTtl,
  revalidateFileHash,
  revalidateSymbol,
  revalidateAuthority,
];

export function defaultRevalidationHooks(): readonly RevalidationHook[] {
  return DEFAULT_HOOKS;
}

/**
 * Run all cheap hooks. First `stale` wins; otherwise returns the last `valid`
 * outcome, or `skipped` if nothing applied.
 */
export function revalidateClaim(
  claim: MemoryClaim,
  ctx: RevalidationContext,
  hooks: readonly RevalidationHook[] = defaultRevalidationHooks(),
): RevalidationOutcome {
  let lastValid: RevalidationOutcome | null = null;
  for (const hook of hooks) {
    const outcome = hook(claim, ctx);
    if (outcome.status === "stale") return outcome;
    if (outcome.status === "valid") lastValid = outcome;
  }
  if (lastValid !== null) return lastValid;
  return {
    status: "skipped",
    method: "statement_unchanged",
    reason: "no applicable cheap revalidation hook",
  };
}

export function revalidateTtl(claim: MemoryClaim, ctx: RevalidationContext): RevalidationOutcome {
  const expiresAt = claim.validity.expiresAt;
  if (expiresAt !== null && expiresAt <= ctx.now) {
    return {
      status: "stale",
      method: "ttl",
      reason: `expired at ${expiresAt}`,
      verifiedAt: ctx.now,
    };
  }
  for (const rule of claim.validity.invalidationRules) {
    if (rule.kind === "ttl") {
      const ms = Number(rule.selector);
      if (Number.isFinite(ms) && ms > 0) {
        const created = Date.parse(claim.createdAt);
        const nowMs = Date.parse(ctx.now);
        if (Number.isFinite(created) && Number.isFinite(nowMs) && nowMs - created > ms) {
          return {
            status: "stale",
            method: "ttl",
            reason: `ttl ${ms}ms exceeded`,
            verifiedAt: ctx.now,
          };
        }
      }
    }
  }
  return { status: "valid", method: "ttl", verifiedAt: ctx.now };
}

export function revalidateFileHash(
  claim: MemoryClaim,
  ctx: RevalidationContext,
): RevalidationOutcome {
  const fileRules = claim.validity.invalidationRules.filter(
    (r): r is InvalidationRule => r.kind === "file_changed",
  );
  if (fileRules.length === 0) {
    return { status: "skipped", method: "file_hash", reason: "no file_changed rules" };
  }
  for (const rule of fileRules) {
    const current = ctx.fileHashes.get(rule.selector);
    if (current === undefined) {
      return {
        status: "stale",
        method: "file_hash",
        reason: `file missing: ${rule.selector}`,
        verifiedAt: ctx.now,
      };
    }
    const source = claim.provenance.sources.find(
      (s) => s.uri.includes(rule.selector) || s.hash === current,
    );
    // If we recorded a source hash for this path and it diverged, stale.
    const recorded = claim.provenance.sources.find((s) => s.uri.includes(rule.selector));
    if (recorded !== undefined && recorded.hash !== current) {
      return {
        status: "stale",
        method: "file_hash",
        reason: `hash changed for ${rule.selector}`,
        verifiedAt: ctx.now,
      };
    }
    void source;
  }
  return { status: "valid", method: "file_hash", verifiedAt: ctx.now };
}

export function revalidateSymbol(
  claim: MemoryClaim,
  ctx: RevalidationContext,
): RevalidationOutcome {
  const symbolRules = claim.validity.invalidationRules.filter((r) => r.kind === "symbol_changed");
  if (symbolRules.length === 0) {
    return { status: "skipped", method: "symbol_presence", reason: "no symbol_changed rules" };
  }
  for (const rule of symbolRules) {
    if (!ctx.knownSymbols.has(rule.selector)) {
      return {
        status: "stale",
        method: "symbol_presence",
        reason: `symbol absent: ${rule.selector}`,
        verifiedAt: ctx.now,
      };
    }
  }
  return { status: "valid", method: "symbol_presence", verifiedAt: ctx.now };
}

/**
 * Memory cannot override repository authority (SPEC §39.6).
 */
export function revalidateAuthority(
  claim: MemoryClaim,
  ctx: RevalidationContext,
): RevalidationOutcome {
  const claimNorm = claim.statement.trim().toLowerCase();
  for (const auth of ctx.authorityStatements) {
    const authNorm = auth.trim().toLowerCase();
    if (authNorm.length === 0) continue;
    // Direct negation of an authority statement → stale / cannot inject.
    if (
      claimNorm === `not ${authNorm}` ||
      claimNorm === `do not ${authNorm}` ||
      claimNorm === `never ${authNorm}`
    ) {
      return {
        status: "stale",
        method: "authority_override",
        reason: "claim contradicts repository authority",
        verifiedAt: ctx.now,
      };
    }
  }
  return { status: "valid", method: "authority_override", verifiedAt: ctx.now };
}
