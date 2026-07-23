/**
 * @terminus/context-compiler — Counterfactual Replay (SPEC §33.16).
 *
 * "Any manifest can be re-rendered under a different renderer or model."
 *
 * Counterfactual replay reads a manifest (which records all fragments
 * considered, selected, and ordered) and re-renders it through a
 * different provider renderer. This enables:
 *  - A/B testing of context policies
 *  - Provider swap mid-task
 *  - Audit (what would model X have seen?)
 *  - Ablation (what if we removed this fragment?)
 */

import type { Uuid7, TokenCount } from "@terminus/domain";
import type {
  ContextFragment,
  ContextManifest,
  ContextCachePlan,
  ContextEpochSnapshot,
} from "@terminus/context-ir";
import type {
  ProviderRenderer,
  RenderedProviderRequest,
  ProviderCapabilitySnapshot,
  ModelCapabilitySnapshot,
} from "@terminus/provider-core";

// ──────────────────────── Ablation specification ─────────────────────────────

/**
 * Describes a modification to a manifest for counterfactual replay.
 * Each ablation removes some fragments and optionally replaces them.
 */
export interface AblationSpec {
  /** Human-readable label for this ablation experiment. */
  readonly label: string;
  /** Fragment IDs to remove before re-render. */
  readonly removeFragmentIds: readonly string[];
  /** Optional replacement fragments to inject. */
  readonly injectFragments?: readonly ContextFragment[] | undefined;
}

// ──────────────────────── Replay input ───────────────────────────────────────

export interface ReplayInput {
  readonly manifest: ContextManifest;
  /** The fragments that were selected in the original compilation. */
  readonly selectedFragments: readonly ContextFragment[];
  /** The renderer to use for re-rendering. */
  readonly renderer: ProviderRenderer;
  readonly provider: ProviderCapabilitySnapshot;
  readonly model: ModelCapabilitySnapshot;
  readonly epoch: ContextEpochSnapshot | null;
  readonly signal: AbortSignal | null;
}

// ──────────────────────── Replay result ──────────────────────────────────────

export interface ReplayResult {
  readonly rendered: RenderedProviderRequest;
  readonly fragmentCount: number;
  readonly estimatedTokens: number;
  /** The ablation spec that was applied, if any. */
  readonly ablation: AblationSpec | null;
}

// ──────────────────────── Replay functions ───────────────────────────────────

/**
 * Re-render a manifest under a different renderer or model.
 *
 * Pure replay: same manifest, same fragments, different renderer.
 * The manifest records the exact fragments and their order — replay
 * honors that order.
 */
export async function replayContext(
  input: ReplayInput,
): Promise<ReplayResult> {
  const cachePlan: ContextCachePlan = {
    stablePrefixHash: input.manifest.cachePlan.stablePrefixHash,
    volatileSuffixBoundary: input.manifest.cachePlan.volatileSuffixBoundary,
    breakpoints: [...input.manifest.cachePlan.breakpoints],
    predictedCachedTokens: input.manifest.predictedCachedTokens,
  };

  const rendered = await input.renderer.render({
    provider: input.provider,
    model: input.model,
    fragments: input.selectedFragments,
    toolSchemas: [],
    cachePlan: {
      stablePrefixHash: cachePlan.stablePrefixHash,
      breakpoints: cachePlan.breakpoints,
    },
    continuationId: input.epoch?.continuationId ?? null,
    outputProfile: "terse",
    reasoningReserveTokens: input.manifest.reasoningReserveTokens,
    outputReserveTokens: input.manifest.outputReserveTokens,
    hardInputLimit: input.manifest.recoveryMarginTokens,
    signal: input.signal,
    manifestId: input.manifest.id,
  });

  const estimatedTokens = input.selectedFragments.reduce(
    (sum, frag) => {
      const modelKey = input.model.modelKey as string;
      const record = frag.estimatedTokens as Readonly<Record<string, number>>;
      return sum + (record[modelKey] ?? 0);
    },
    0,
  );

  return {
    rendered,
    fragmentCount: input.selectedFragments.length,
    estimatedTokens,
    ablation: null,
  };
}

/**
 * Replay with an ablation: remove specified fragments, optionally inject
 * replacements, then re-render.
 *
 * The ablation spec is recorded in the result for experiment tracking.
 */
export async function replayWithAblation(
  input: ReplayInput,
  ablation: AblationSpec,
): Promise<ReplayResult> {
  const removeSet = new Set(ablation.removeFragmentIds);
  let fragments = input.selectedFragments.filter(
    (frag) => !removeSet.has(frag.id),
  );

  if (ablation.injectFragments !== undefined) {
    fragments = [...fragments, ...ablation.injectFragments];
  }

  const cachePlan: ContextCachePlan = {
    stablePrefixHash: input.manifest.cachePlan.stablePrefixHash,
    volatileSuffixBoundary: input.manifest.cachePlan.volatileSuffixBoundary,
    breakpoints: [...input.manifest.cachePlan.breakpoints],
    predictedCachedTokens: input.manifest.predictedCachedTokens,
  };

  const rendered = await input.renderer.render({
    provider: input.provider,
    model: input.model,
    fragments,
    toolSchemas: [],
    cachePlan: {
      stablePrefixHash: cachePlan.stablePrefixHash,
      breakpoints: cachePlan.breakpoints,
    },
    continuationId: input.epoch?.continuationId ?? null,
    outputProfile: "terse",
    reasoningReserveTokens: input.manifest.reasoningReserveTokens,
    outputReserveTokens: input.manifest.outputReserveTokens,
    hardInputLimit: input.manifest.recoveryMarginTokens,
    signal: input.signal,
    manifestId: input.manifest.id,
  });

  const estimatedTokens = fragments.reduce(
    (sum, frag) => {
      const modelKey = input.model.modelKey as string;
      const record = frag.estimatedTokens as Readonly<Record<string, number>>;
      return sum + (record[modelKey] ?? 0);
    },
    0,
  );

  return {
    rendered,
    fragmentCount: fragments.length,
    estimatedTokens,
    ablation,
  };
}

// ──────────────────────── Ablation presets ───────────────────────────────────

/** Ablation that removes all checkpoint fragments. */
export function checkpointAblation(fragments: readonly ContextFragment[]): AblationSpec {
  const checkpointIds = fragments
    .filter((f) => f.kind === "checkpoint")
    .map((f) => f.id);
  return {
    label: "remove_all_checkpoints",
    removeFragmentIds: checkpointIds,
  };
}

/** Ablation that removes all memory fragments. */
export function memoryAblation(fragments: readonly ContextFragment[]): AblationSpec {
  const memoryIds = fragments
    .filter((f) => f.kind === "memory")
    .map((f) => f.id);
  return {
    label: "remove_all_memory",
    removeFragmentIds: memoryIds,
  };
}

/** Ablation that removes all world_state fragments. */
export function worldStateAblation(fragments: readonly ContextFragment[]): AblationSpec {
  const wsIds = fragments
    .filter((f) => f.kind === "world_state")
    .map((f) => f.id);
  return {
    label: "remove_all_world_state",
    removeFragmentIds: wsIds,
  };
}

/** Ablation that removes all documentation fragments. */
export function documentationAblation(fragments: readonly ContextFragment[]): AblationSpec {
  const docIds = fragments
    .filter((f) => f.kind === "documentation")
    .map((f) => f.id);
  return {
    label: "remove_all_documentation",
    removeFragmentIds: docIds,
  };
}

/** Returns all standard ablation presets for a set of fragments. */
export function standardAblations(
  fragments: readonly ContextFragment[],
): readonly AblationSpec[] {
  return [
    checkpointAblation(fragments),
    memoryAblation(fragments),
    worldStateAblation(fragments),
    documentationAblation(fragments),
  ];
}
