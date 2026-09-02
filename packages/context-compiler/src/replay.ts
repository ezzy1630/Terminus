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

import type { Uuid7, TokenCount, ContentHash } from "@terminus/domain";
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
  ProviderToolSchema,
} from "@terminus/provider-core";
import { canonicalJson, computeContentHash, computeStablePrefixHash } from "@terminus/context-ir";

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
  /** Exact provider-visible schemas. If omitted, replay reads the manifest record. */
  readonly toolSchemas?: readonly ProviderToolSchema[] | undefined;
}

// ──────────────────────── Replay result ──────────────────────────────────────

export interface ReplayResult {
  readonly rendered: RenderedProviderRequest;
  readonly fragmentCount: number;
  readonly estimatedTokens: number;
  readonly renderedRequestHash: ContentHash;
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
  assertManifestSelection(input.manifest, input.selectedFragments);
  const toolSchemas = replayToolSchemas(input);
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
    toolSchemas,
    cachePlan: {
      stablePrefixHash: cachePlan.stablePrefixHash,
      breakpoints: cachePlan.breakpoints,
    },
    continuationId: input.epoch?.continuationId ?? null,
    outputProfile: "terse",
    reasoningReserveTokens: input.manifest.reasoningReserveTokens,
    outputReserveTokens: input.manifest.outputReserveTokens,
    hardInputLimit: replayHardInputLimit(input.manifest),
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
    renderedRequestHash: hashRenderedRequest(rendered),
    ablation: null,
  };
}

const VOLATILE_WORLD_STATE_FRAGMENT_ID = "runtime:world_state:latest";

function isVolatileFragment(fragment: ContextFragment): boolean {
  return fragment.id === VOLATILE_WORLD_STATE_FRAGMENT_ID;
}

function ablatedCachePlan(
  input: ReplayInput,
  fragments: readonly ContextFragment[],
): ContextCachePlan {
  const originalStableIds = new Set(
    input.manifest.fragments
      .slice(0, input.manifest.cachePlan.volatileSuffixBoundary)
      .map((entry) => entry.fragmentId),
  );
  const stable: ContextFragment[] = [];
  for (const fragment of fragments) {
    if (!originalStableIds.has(fragment.id)) break;
    stable.push(fragment);
  }
  const originalBreakpointIds = new Set(
    input.manifest.cachePlan.breakpoints
      .map((index) => input.manifest.fragments[index]?.fragmentId)
      .filter((id): id is string => id !== undefined),
  );
  const breakpoints = fragments.flatMap((fragment, index) =>
    originalBreakpointIds.has(fragment.id) ? [index] : []
  );

  const hadStableBreakpoint = input.manifest.cachePlan.breakpoints.includes(
    input.manifest.cachePlan.volatileSuffixBoundary - 1,
  );
  if (hadStableBreakpoint && stable.length > 0 && !breakpoints.includes(stable.length - 1)) {
    breakpoints.push(stable.length - 1);
  }

  const originalHadPostStableBreakpoint = input.manifest.cachePlan.breakpoints.some(
    (index) => index >= input.manifest.cachePlan.volatileSuffixBoundary,
  );
  if (originalHadPostStableBreakpoint) {
    let cacheableEnd = fragments.length - 1;
    while (cacheableEnd >= 0 && isVolatileFragment(fragments[cacheableEnd]!)) {
      cacheableEnd -= 1;
    }
    if (cacheableEnd >= 0 && !breakpoints.includes(cacheableEnd)) {
      breakpoints.push(cacheableEnd);
    }
  }

  breakpoints.sort((a, b) => a - b);

  const modelKey = input.model.modelKey;
  const predictedCachedTokens = stable.reduce(
    (sum, fragment) => sum + BigInt(fragment.estimatedTokens[modelKey] ?? 0),
    0n,
  ) as TokenCount;
  return {
    stablePrefixHash: computeStablePrefixHash(stable),
    volatileSuffixBoundary: stable.length,
    breakpoints,
    predictedCachedTokens,
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
  assertManifestSelection(input.manifest, input.selectedFragments);
  const toolSchemas = replayToolSchemas(input);
  const removeSet = new Set(ablation.removeFragmentIds);
  let fragments = input.selectedFragments.filter(
    (frag) => !removeSet.has(frag.id),
  );

  if (ablation.injectFragments !== undefined) {
    fragments = [...fragments, ...ablation.injectFragments];
  }

  const cachePlan = ablatedCachePlan(input, fragments);

  const rendered = await input.renderer.render({
    provider: input.provider,
    model: input.model,
    fragments,
    toolSchemas,
    cachePlan: {
      stablePrefixHash: cachePlan.stablePrefixHash,
      breakpoints: cachePlan.breakpoints,
    },
    continuationId: input.epoch?.continuationId ?? null,
    outputProfile: "terse",
    reasoningReserveTokens: input.manifest.reasoningReserveTokens,
    outputReserveTokens: input.manifest.outputReserveTokens,
    hardInputLimit: replayHardInputLimit(input.manifest),
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
    renderedRequestHash: hashRenderedRequest(rendered),
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

function replayHardInputLimit(manifest: ContextManifest): TokenCount {
  const record = manifest.decisionRecord;
  const configured = record?.hardInputLimit;
  if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) {
    return BigInt(Math.trunc(configured)) as TokenCount;
  }
  // Legacy manifests did not record the limit. Preserve a conservative
  // recoverable fallback rather than pretending the recovery margin was an
  // input limit.
  return (manifest.outputReserveTokens + manifest.reasoningReserveTokens + manifest.recoveryMarginTokens) as TokenCount;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProviderToolSchema(value: unknown): value is ProviderToolSchema {
  if (!isRecord(value)) return false;
  const trustLevels = new Set(["builtin", "first_party", "verified_third_party", "untrusted"]);
  return typeof value.id === "string"
    && typeof value.version === "string"
    && typeof value.summary === "string"
    && isRecord(value.inputSchema)
    && isRecord(value.resultSchema)
    && typeof value.sideEffectClass === "string"
    && Array.isArray(value.requiredCapabilities)
    && value.requiredCapabilities.every((entry) => typeof entry === "string")
    && typeof value.trustLevel === "string"
    && trustLevels.has(value.trustLevel)
    && typeof value.maximumModelResultBytes === "number"
    && Number.isSafeInteger(value.maximumModelResultBytes)
    && value.maximumModelResultBytes >= 0
    && typeof value.maximumArtifactBytes === "number"
    && Number.isSafeInteger(value.maximumArtifactBytes)
    && value.maximumArtifactBytes >= 0
    && typeof value.defaultTimeoutMs === "number"
    && Number.isSafeInteger(value.defaultTimeoutMs)
    && value.defaultTimeoutMs > 0
    && Array.isArray(value.policyTags)
    && value.policyTags.every((entry) => typeof entry === "string");
}

function replayToolSchemas(input: ReplayInput): readonly ProviderToolSchema[] {
  if (input.toolSchemas !== undefined) return input.toolSchemas;
  const candidate = input.manifest.decisionRecord?.toolSchemas;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(isProviderToolSchema);
}

function assertManifestSelection(
  manifest: ContextManifest,
  fragments: readonly ContextFragment[],
): void {
  if (manifest.fragments.length !== fragments.length) {
    throw new Error(
      `replay selection does not match manifest ${manifest.id}: expected ${manifest.fragments.length} fragments, got ${fragments.length}`,
    );
  }
  for (let index = 0; index < manifest.fragments.length; index += 1) {
    const entry = manifest.fragments[index]!;
    const fragment = fragments[index]!;
    if (entry.fragmentId !== fragment.id || entry.artifactHash !== fragment.contentRef.hash) {
      throw new Error(`replay selection mismatch at position ${index} for manifest ${manifest.id}`);
    }
  }
}

function hashRenderedRequest(rendered: RenderedProviderRequest): ContentHash {
  return computeContentHash(canonicalJson({
    providerId: rendered.providerId,
    model: rendered.model,
    body: rendered.body,
    request: { ...rendered.request, signal: null },
  }));
}
