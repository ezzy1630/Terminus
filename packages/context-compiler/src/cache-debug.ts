/**
 * Stable-prefix and context-epoch diagnostics.
 *
 * Hashes alone are difficult to review. These records keep the ordered
 * prefix entries beside the hash and explain which observable mutation made
 * a cache-compatible request become a new prefix.
 */

import type { ContentHash, ModelKey, TokenCount } from "@terminus/domain";
import type {
  ContextCachePlan,
  ContextEpochSnapshot,
  ContextFragment,
} from "@terminus/context-ir";
import { canonicalJson, computeStablePrefixHash, computeContentHash } from "@terminus/context-ir";
import type { ProviderToolSchema } from "@terminus/provider-core";

export interface StablePrefixEntry {
  readonly index: number;
  readonly fragmentId: string;
  readonly artifactHash: ContentHash;
  readonly estimatedTokens: number;
  readonly cacheBreakpoint: boolean;
}

export interface StablePrefixDebugData {
  readonly hash: ContentHash;
  readonly fragmentCount: number;
  readonly tokenCount: number;
  readonly entries: readonly StablePrefixEntry[];
  /** Whether the stable prefix follows the canonical cache-safe ordering. */
  readonly canonicalOrderingValid: boolean;
  /** First index that violates the canonical ordering, if any. */
  readonly orderingViolationAt: number | null;
}

export interface CacheEpochDebugSnapshot {
  readonly epochId: string | null;
  readonly epochSequence: number | null;
  readonly epochBaselineHash: ContentHash | null;
  readonly providerId: string;
  readonly modelKey: ModelKey;
  readonly continuationId: string | null;
  readonly cacheMode: string | null;
  readonly exactPrefixRequired: boolean | null;
  readonly stablePrefix: StablePrefixDebugData;
  readonly volatileSuffixBoundary: number;
  readonly breakpoints: readonly number[];
  readonly predictedCachedTokens: number;
  readonly toolSchemaFingerprint: ContentHash | null;
  readonly canonicalOrderingValid: boolean;
  readonly orderingViolationAt: number | null;
}

export type CacheEpochDiagnosticCode =
  | "no_previous_epoch"
  | "stable_prefix_unchanged"
  | "stable_prefix_changed"
  | "stable_fragment_added"
  | "stable_fragment_removed"
  | "stable_fragment_reordered"
  | "stable_fragment_content_changed"
  | "epoch_changed"
  | "provider_changed"
  | "model_changed"
  | "continuation_changed"
  | "cache_mode_changed"
  | "tool_schema_changed"
  | "epoch_baseline_mismatch"
  | "planned_hash_mismatch"
  | "stable_prefix_order_invalid";

/**
 * Canonical stable-prefix order from SPEC §38.7. Lower numbers are emitted
 * before higher numbers; ordering is checked, not silently repaired, because
 * the hash must describe the bytes actually rendered.
 */
const STABLE_PREFIX_KIND_ORDER: Readonly<Record<ContextFragment["kind"], number>> = {
  authority: 0,
  tool_schema: 1,
  project_rule: 2,
  world_state: 3,
  task_contract: 4,
  checkpoint: 5,
  recent_episode: 6,
  tool_result: 7,
  code: 8,
  test: 8,
  documentation: 8,
  memory: 8,
  user_attachment: 8,
};

function orderingViolationAt(fragments: readonly ContextFragment[]): number | null {
  let previous = -1;
  for (const [index, fragment] of fragments.entries()) {
    const current = STABLE_PREFIX_KIND_ORDER[fragment.kind];
    if (current < previous) return index;
    previous = current;
  }
  return null;
}

export interface CacheEpochDiagnostic {
  readonly code: CacheEpochDiagnosticCode;
  readonly severity: "info" | "warning";
  readonly message: string;
}

export interface CacheEpochDebugData {
  readonly current: CacheEpochDebugSnapshot;
  readonly previous: CacheEpochDebugSnapshot | null;
  readonly stablePrefixChanged: boolean;
  readonly invalidationReasons: readonly CacheEpochDiagnosticCode[];
  readonly diagnostics: readonly CacheEpochDiagnostic[];
}

export interface CacheEpochDebugInput {
  readonly providerId: string;
  readonly modelKey: ModelKey;
  readonly epoch: ContextEpochSnapshot | null;
  readonly cachePlan: ContextCachePlan;
  readonly selectedFragments: readonly ContextFragment[];
  readonly toolSchemas?: readonly ProviderToolSchema[] | undefined;
  readonly cacheMode?: string | null | undefined;
  readonly exactPrefixRequired?: boolean | null | undefined;
}

function numberFromTokenCount(value: TokenCount | number): number {
  return typeof value === "number" ? value : Number(value);
}

function stableFragments(
  fragments: readonly ContextFragment[],
  volatileSuffixBoundary: number,
): readonly ContextFragment[] {
  const boundary = Math.max(0, Math.min(fragments.length, volatileSuffixBoundary));
  return fragments.slice(0, boundary);
}

function toolSchemaFingerprint(
  tools: readonly ProviderToolSchema[] | undefined,
): ContentHash | null {
  if (tools === undefined || tools.length === 0) return null;
  return computeContentHash(canonicalJson(tools));
}

export function buildStablePrefixDebugData(
  fragments: readonly ContextFragment[],
  cachePlan: ContextCachePlan,
  modelKey: ModelKey,
): StablePrefixDebugData {
  const prefix = stableFragments(fragments, cachePlan.volatileSuffixBoundary);
  const entries = prefix.map((fragment, index) => ({
    index,
    fragmentId: fragment.id,
    artifactHash: fragment.contentRef.hash,
    estimatedTokens: fragment.estimatedTokens[modelKey] ?? 0,
    cacheBreakpoint: cachePlan.breakpoints.includes(index),
  }));
  const violationAt = orderingViolationAt(prefix);
  return {
    hash: computeStablePrefixHash(prefix),
    fragmentCount: prefix.length,
    tokenCount: entries.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
    entries,
    canonicalOrderingValid: violationAt === null,
    orderingViolationAt: violationAt,
  };
}

export function snapshotCacheEpoch(input: CacheEpochDebugInput): CacheEpochDebugSnapshot {
  const stablePrefix = buildStablePrefixDebugData(
    input.selectedFragments,
    input.cachePlan,
    input.modelKey,
  );
  return {
    epochId: input.epoch?.epochId ?? null,
    epochSequence: input.epoch?.sequence ?? null,
    epochBaselineHash: input.epoch?.baselineHash ?? null,
    providerId: input.providerId,
    modelKey: input.modelKey,
    continuationId: input.epoch?.continuationId ?? null,
    cacheMode: input.cacheMode ?? null,
    exactPrefixRequired: input.exactPrefixRequired ?? null,
    stablePrefix,
    volatileSuffixBoundary: input.cachePlan.volatileSuffixBoundary,
    breakpoints: [...input.cachePlan.breakpoints],
    predictedCachedTokens: numberFromTokenCount(input.cachePlan.predictedCachedTokens),
    toolSchemaFingerprint: toolSchemaFingerprint(input.toolSchemas),
    canonicalOrderingValid: stablePrefix.canonicalOrderingValid,
    orderingViolationAt: stablePrefix.orderingViolationAt,
  };
}

function diagnostic(
  code: CacheEpochDiagnosticCode,
  severity: CacheEpochDiagnostic["severity"],
  message: string,
): CacheEpochDiagnostic {
  return { code, severity, message };
}

function compareStableEntries(
  previous: readonly StablePrefixEntry[],
  current: readonly StablePrefixEntry[],
): readonly CacheEpochDiagnostic[] {
  const diagnostics: CacheEpochDiagnostic[] = [];
  const previousIds = previous.map((entry) => entry.fragmentId);
  const currentIds = current.map((entry) => entry.fragmentId);
  const commonIds = previousIds.filter((id) => currentIds.includes(id));
  if (current.length > previous.length) {
    diagnostics.push(diagnostic(
      "stable_fragment_added",
      "warning",
      `stable prefix gained ${current.length - previous.length} fragment(s)`,
    ));
  }
  if (current.length < previous.length) {
    diagnostics.push(diagnostic(
      "stable_fragment_removed",
      "warning",
      `stable prefix lost ${previous.length - current.length} fragment(s)`,
    ));
  }
  if (commonIds.length > 0 && previousIds.join("\n") !== currentIds.join("\n")) {
    diagnostics.push(diagnostic(
      "stable_fragment_reordered",
      "warning",
      "stable prefix fragment order changed",
    ));
  }
  const previousById = new Map(previous.map((entry) => [entry.fragmentId, entry]));
  for (const entry of current) {
    const prior = previousById.get(entry.fragmentId);
    if (prior !== undefined && prior.artifactHash !== entry.artifactHash) {
      diagnostics.push(diagnostic(
        "stable_fragment_content_changed",
        "warning",
        `stable fragment ${entry.fragmentId} changed content`,
      ));
    }
  }
  return diagnostics;
}

/** Compare two snapshots and explain cache-invalidating mutations. */
export function compareCacheEpochs(
  previous: CacheEpochDebugSnapshot,
  current: CacheEpochDebugSnapshot,
): CacheEpochDebugData {
  const diagnostics: CacheEpochDiagnostic[] = [];
  const invalidationReasons: CacheEpochDiagnosticCode[] = [];
  const add = (item: CacheEpochDiagnostic): void => {
    diagnostics.push(item);
    if (item.code !== "stable_prefix_unchanged" && item.code !== "epoch_changed") {
      invalidationReasons.push(item.code);
    }
  };

  if (previous.providerId !== current.providerId) {
    add(diagnostic("provider_changed", "warning", "provider changed across cache epochs"));
  }
  if (String(previous.modelKey) !== String(current.modelKey)) {
    add(diagnostic("model_changed", "warning", "model changed across cache epochs"));
  }
  if (previous.epochId !== current.epochId) {
    add(diagnostic("epoch_changed", "info", "context epoch changed"));
  }
  if (previous.continuationId !== current.continuationId) {
    add(diagnostic("continuation_changed", "warning", "provider continuation identity changed"));
  }
  if (
    previous.cacheMode !== current.cacheMode
    || previous.exactPrefixRequired !== current.exactPrefixRequired
  ) {
    add(diagnostic("cache_mode_changed", "warning", "provider cache semantics changed"));
  }
  if (previous.toolSchemaFingerprint !== current.toolSchemaFingerprint) {
    add(diagnostic("tool_schema_changed", "warning", "tool schema fingerprint changed"));
  }
  if (current.canonicalOrderingValid === false) {
    add(diagnostic(
      "stable_prefix_order_invalid",
      "warning",
      `stable prefix violates canonical ordering at index ${current.orderingViolationAt ?? "unknown"}`,
    ));
  }

  if (previous.stablePrefix.hash !== current.stablePrefix.hash) {
    add(diagnostic("stable_prefix_changed", "warning", "stable prefix hash changed"));
    for (const item of compareStableEntries(previous.stablePrefix.entries, current.stablePrefix.entries)) add(item);
  } else {
    diagnostics.push(diagnostic("stable_prefix_unchanged", "info", "stable prefix hash is unchanged"));
  }

  const stablePrefixChanged = previous.stablePrefix.hash !== current.stablePrefix.hash;
  return {
    current,
    previous,
    stablePrefixChanged,
    invalidationReasons: [...new Set(invalidationReasons)],
    diagnostics,
  };
}

/** Build current debug data and compare it with an optional prior snapshot. */
export function buildCacheEpochDebugData(
  input: CacheEpochDebugInput,
  previous: CacheEpochDebugSnapshot | null = null,
): CacheEpochDebugData {
  const current = snapshotCacheEpoch(input);
  const diagnostics: CacheEpochDiagnostic[] = [];
  if (current.stablePrefix.hash !== input.cachePlan.stablePrefixHash) {
    diagnostics.push(diagnostic(
      "planned_hash_mismatch",
      "warning",
      "cache plan hash does not match the selected stable prefix",
    ));
  }
  if (
    current.epochBaselineHash !== null
    && current.epochBaselineHash !== current.stablePrefix.hash
  ) {
    diagnostics.push(diagnostic(
      "epoch_baseline_mismatch",
      "warning",
      "current stable prefix differs from the epoch baseline",
    ));
  }
  if (current.canonicalOrderingValid === false) {
    diagnostics.push(diagnostic(
      "stable_prefix_order_invalid",
      "warning",
      `stable prefix violates canonical ordering at index ${current.orderingViolationAt ?? "unknown"}`,
    ));
  }
  if (previous === null) {
    diagnostics.push(diagnostic("no_previous_epoch", "info", "no previous cache epoch was supplied"));
    return {
      current,
      previous: null,
      stablePrefixChanged: false,
      invalidationReasons: diagnostics
        .filter((item) => item.severity === "warning")
        .map((item) => item.code),
      diagnostics,
    };
  }

  const compared = compareCacheEpochs(previous, current);
  return {
    ...compared,
    diagnostics: [...diagnostics, ...compared.diagnostics],
    invalidationReasons: [
      ...new Set([
        ...compared.invalidationReasons,
        ...diagnostics.filter((item) => item.severity === "warning").map((item) => item.code),
      ]),
    ],
  };
}
