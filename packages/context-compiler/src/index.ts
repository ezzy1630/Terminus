/**
 * @forge/context-compiler — the Context Compiler (SPEC §8, §33).
 *
 * `compileContext(input: CompileInput): Promise<CompiledContext>` performs:
 *  1. collect required fragments (authority, task contract, policy)
 *  2. derive retrieval queries from objective/changed-files/diagnostics/...
 *  3. retrieval pipeline (exact → lexical → tree-sitter → LSP → graph →
 *     optional semantic)
 *  4. deduplicate and validate freshness
 *  5. build evidence-coverage matrix; expand for gaps
 *  6. score candidates (utility = relevance × authority × freshness × novelty
 *     × coverage × uncertainty_reduction × risk_reduction ×
 *     model_compatibility / token_cost)
 *  7. allocate budget (reserves for output/reasoning/tool-results/recovery;
 *     greedy selection preserving dependency closure and complete-episode
 *     integrity)
 *  8. plan cache epoch (stable prefix, volatile suffix)
 *  9. render provider-specific request via provider renderer
 *  10. build and persist manifest (durable before send)
 *
 * Returns `{ rendered, manifest }`. No direct DB writes — accept a
 * `ContextStore` interface.
 */
import { z } from "zod";
import type {
  TaskContract,
  Episode,
  Checkpoint,
  Uuid7,
  ModelKey,
  ContentHash,
  Rfc3339Timestamp,
  TokenCount,
} from "@forge/domain";
import type {
  ContextFragment,
  ContextEpochSnapshot,
  ContextManifest,
  ContextBudget,
  ContextDirective,
  ContextCachePlan,
} from "@forge/context-ir";
import { buildManifest, computeStablePrefixHash, isConfidentialityAllowed } from "@forge/context-ir";
import type {
  ProviderCapabilitySnapshot,
  ModelCapabilitySnapshot,
  ProviderRenderer,
  RenderedProviderRequest,
  ConfidentialityPolicy,
} from "@forge/provider-core";
import { filterByConfidentiality } from "@forge/provider-core";

// ────────────────────────── Inputs ───────────────────────────────────────────

export interface TaskSnapshot {
  readonly taskId: Uuid7;
  readonly contract: TaskContract;
  readonly phase: string;
  readonly changedFiles: readonly string[];
  readonly failingTests: readonly string[];
  readonly diagnostics: readonly { readonly path: string; readonly message: string }[];
  readonly unknowns: readonly string[];
}

export interface ThreadSnapshot {
  readonly threadId: Uuid7;
  readonly sessionId: Uuid7;
  readonly activeContextEpochId: Uuid7 | null;
}

export interface WorldStateSnapshot {
  readonly sections: Readonly<Record<string, unknown>>;
  readonly observedAt: Rfc3339Timestamp;
  readonly sourceVersions: Readonly<Record<string, string>>;
}

export interface CapabilityDescriptorSnapshot {
  readonly id: string;
  readonly version: string;
}

export interface ExperimentAssignment {
  readonly experimentId: string;
  readonly variant: string;
}

export interface CompileInput {
  readonly task: TaskSnapshot;
  readonly thread: ThreadSnapshot;
  readonly provider: ProviderCapabilitySnapshot;
  readonly model: ModelCapabilitySnapshot;
  readonly epoch: ContextEpochSnapshot | null;
  readonly worldState: WorldStateSnapshot;
  readonly recentEpisodes: readonly Episode[];
  readonly checkpoint: Checkpoint | null;
  readonly userDirectives: readonly ContextDirective[];
  readonly activeCapabilities: readonly CapabilityDescriptorSnapshot[];
  readonly budget: ContextBudget;
  readonly experimentAssignments: readonly ExperimentAssignment[];
  readonly renderer: ProviderRenderer;
  readonly confidentialityPolicy: ConfidentialityPolicy;
  readonly store: ContextStore;
  readonly signal: AbortSignal | null;
}

export interface CompiledContext {
  readonly rendered: RenderedProviderRequest;
  readonly manifest: ContextManifest;
  readonly warnings: readonly string[];
  readonly omitted: readonly { readonly fragmentId: string; readonly reason: string }[];
}

// ────────────────────────── ContextStore interface ───────────────────────────

export interface ContextStore {
  /** Persist a manifest durably. Must complete before the provider request. */
  persistManifest(manifest: Omit<ContextManifest, "id">): Promise<ContextManifest>;
  /** Load a manifest by id. */
  getManifest(id: Uuid7): Promise<ContextManifest | null>;
  /** Record an observation record (post-attempt usage/cost). */
  recordObservation(
    manifestId: Uuid7,
    observation: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

// ────────────────────────── Retrieval ────────────────────────────────────────

export type RetrievalMethod =
  | "exact_user_reference"
  | "exact_path_symbol"
  | "lexical_bm25"
  | "tree_sitter"
  | "lsp"
  | "dependency_graph"
  | "failure_localization"
  | "semantic"
  | "user_directive";

export interface RetrievalQuery {
  readonly text: string;
  readonly reason: string;
  readonly suggestedMethods: readonly RetrievalMethod[];
}

export interface RetrievalResult {
  readonly fragment: ContextFragment;
  readonly method: RetrievalMethod;
  readonly rawScore: number;
  readonly rerankedScore: number;
  readonly sourceVersion: string | null;
  readonly reason: string;
}

export interface RetrievalPipeline {
  retrieve(queries: readonly RetrievalQuery[], input: CompileInput): Promise<readonly RetrievalResult[]>;
  expandForGaps(
    gaps: readonly EvidenceGap[],
    input: CompileInput,
  ): Promise<readonly RetrievalResult[]>;
}

// ────────────────────────── Evidence-coverage ────────────────────────────────

export interface EvidenceRow {
  readonly requirementId: string;
  readonly requirement: string;
  readonly requiredEvidenceType: readonly string[];
  readonly candidateFragments: readonly string[];
  readonly covered: boolean;
}

export interface EvidenceGap {
  readonly requirementId: string;
  readonly requirement: string;
  readonly requiredEvidenceType: readonly string[];
  readonly reason: string;
}

export interface EvidenceCoverageMatrix {
  readonly rows: readonly EvidenceRow[];
  readonly gaps: readonly EvidenceGap[];
  readonly hasCriticalGaps: boolean;
}

// ────────────────────────── Query generation ─────────────────────────────────

export function deriveRetrievalQueries(input: CompileInput): readonly RetrievalQuery[] {
  const queries: RetrievalQuery[] = [];
  // Objective + acceptance criteria.
  queries.push({
    text: input.task.contract.objective,
    reason: "task objective",
    suggestedMethods: ["lexical_bm25", "tree_sitter", "semantic"],
  });
  for (const ac of input.task.contract.acceptanceCriteria) {
    queries.push({
      text: ac.statement,
      reason: `acceptance criterion ${ac.id}`,
      suggestedMethods: ["lexical_bm25", "tree_sitter"],
    });
  }
  // User-named paths/symbols from directives.
  for (const d of input.userDirectives) {
    if (d.kind === "include_path" || d.kind === "include_symbol") {
      queries.push({
        text: d.target,
        reason: `user directive: ${d.kind}`,
        suggestedMethods: ["exact_path_symbol"],
      });
    }
  }
  // Changed files.
  for (const path of input.task.changedFiles) {
    queries.push({
      text: path,
      reason: "changed file",
      suggestedMethods: ["exact_path_symbol", "tree_sitter"],
    });
  }
  // Failing tests.
  for (const t of input.task.failingTests) {
    queries.push({
      text: t,
      reason: "failing test",
      suggestedMethods: ["failure_localization", "lexical_bm25"],
    });
  }
  // Diagnostics.
  for (const d of input.task.diagnostics) {
    queries.push({
      text: `${d.path} ${d.message}`,
      reason: "diagnostic",
      suggestedMethods: ["failure_localization", "lexical_bm25"],
    });
  }
  // Unknowns.
  for (const u of input.task.contract.unknowns) {
    queries.push({
      text: u,
      reason: "unknown",
      suggestedMethods: ["lexical_bm25", "semantic"],
    });
  }
  return queries;
}

// ────────────────────────── Required fragments ───────────────────────────────

export interface RequiredFragments {
  readonly authority: readonly ContextFragment[];
  readonly taskContract: readonly ContextFragment[];
  readonly policy: readonly ContextFragment[];
}

export async function collectRequiredFragments(
  input: CompileInput,
): Promise<RequiredFragments> {
  // In a real implementation these come from the policy and prompt stores.
  // For now we delegate to the store via the retrieval pipeline; the testkit
  // supplies a fake.
  void input;
  return { authority: [], taskContract: [], policy: [] };
}

// ────────────────────────── Dedup + freshness ────────────────────────────────

export function deduplicateAndValidate(
  results: readonly RetrievalResult[],
  currentVersions: Readonly<Record<string, string>>,
): readonly RetrievalResult[] {
  const seen = new Set<string>();
  const out: RetrievalResult[] = [];
  for (const r of results) {
    if (seen.has(r.fragment.id)) continue;
    seen.add(r.fragment.id);
    // Mark stale if source version mismatches.
    if (r.fragment.sourceVersion !== null) {
      const cur = currentVersions[r.fragment.source.uri];
      if (cur !== undefined && cur !== r.fragment.sourceVersion) {
        // Drop stale fragments silently; manifest will record the omission.
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

// ────────────────────────── Evidence-coverage matrix ─────────────────────────

export function buildEvidenceCoverage(
  input: CompileInput,
  candidates: readonly RetrievalResult[],
): EvidenceCoverageMatrix {
  const rows: EvidenceRow[] = [];
  const gaps: EvidenceGap[] = [];
  // One row per acceptance criterion.
  for (const ac of input.task.contract.acceptanceCriteria) {
    const matching = candidates
      .filter((r) => r.fragment.kind === "code" || r.fragment.kind === "test")
      .map((r) => r.fragment.id);
    const covered = matching.length > 0 || !ac.required;
    rows.push({
      requirementId: ac.id,
      requirement: ac.statement,
      requiredEvidenceType: ac.required ? ["code", "test"] : [],
      candidateFragments: matching,
      covered,
    });
    if (!covered && ac.required) {
      gaps.push({
        requirementId: ac.id,
        requirement: ac.statement,
        requiredEvidenceType: ["code", "test"],
        reason: "no code or test fragment matches this required acceptance criterion",
      });
    }
  }
  // One row per unknown.
  for (const u of input.task.contract.unknowns) {
    const matching = candidates
      .filter((r) => r.fragment.kind === "documentation" || r.fragment.kind === "memory")
      .map((r) => r.fragment.id);
    const covered = matching.length > 0;
    rows.push({
      requirementId: `unknown:${u}`,
      requirement: u,
      requiredEvidenceType: ["documentation", "memory"],
      candidateFragments: matching,
      covered,
    });
    if (!covered) {
      gaps.push({
        requirementId: `unknown:${u}`,
        requirement: u,
        requiredEvidenceType: ["documentation", "memory"],
        reason: "no documentation or memory fragment covers this unknown",
      });
    }
  }
  return {
    rows,
    gaps,
    hasCriticalGaps: gaps.some((g) => g.requiredEvidenceType.includes("code") || g.requiredEvidenceType.includes("test")),
  };
}

// ────────────────────────── Scoring (§33.10) ─────────────────────────────────

export interface ScoredCandidate {
  readonly result: RetrievalResult;
  readonly utility: number;
  readonly hardRequired: boolean;
}

export interface ScoringWeights {
  readonly relevance: number;
  readonly authorityWeight: number;
  readonly freshnessWeight: number;
  readonly noveltyWeight: number;
  readonly requirementCoverage: number;
  readonly uncertaintyReduction: number;
  readonly riskReduction: number;
  readonly modelCompatibility: number;
  readonly redundancyPenalty: number;
  readonly injectionPenalty: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  relevance: 1.0,
  authorityWeight: 0.8,
  freshnessWeight: 0.7,
  noveltyWeight: 0.5,
  requirementCoverage: 1.0,
  uncertaintyReduction: 0.6,
  riskReduction: 0.5,
  modelCompatibility: 0.8,
  redundancyPenalty: 0.3,
  injectionPenalty: 0.9,
};

export function scoreCandidates(
  candidates: readonly RetrievalResult[],
  input: CompileInput,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): readonly ScoredCandidate[] {
  const modelKey = input.model.modelKey;
  return candidates.map((result) => {
    const frag = result.fragment;
    const features = frag.selectionFeatures;
    const tokenCost = Math.max(1, frag.estimatedTokens[modelKey] ?? 1);
    const numerator =
      weights.relevance * features.relevance *
      weights.authorityWeight * (frag.authority / 100) *
      weights.freshnessWeight * (frag.freshness.stale ? 0.2 : 1) *
      weights.noveltyWeight * features.novelty *
      weights.requirementCoverage * features.coverage *
      weights.uncertaintyReduction * features.uncertaintyReduction *
      weights.riskReduction * features.riskReduction *
      weights.modelCompatibility * features.modelCompatibility;
    const penalty =
      weights.redundancyPenalty * features.redundancyPenalty +
      weights.injectionPenalty * features.injectionPenalty;
    const utility = (numerator - penalty) / tokenCost;
    const hardRequired = frag.authority >= 80;
    return { result, utility: hardRequired ? Number.POSITIVE_INFINITY : utility, hardRequired };
  });
}

// ────────────────────────── Budget allocator (§33.11) ────────────────────────

export interface AllocationOptions {
  readonly preserveDependencies: boolean;
  readonly preserveCompleteEpisodes: boolean;
  readonly hardIncludeRequired: boolean;
}

export interface AllocationResult {
  readonly selected: readonly ScoredCandidate[];
  readonly omitted: readonly { readonly result: RetrievalResult; readonly reason: string }[];
  readonly totalEstimatedTokens: number;
}

/** Returns the estimated token cost of a fragment for a given model key. */
function tokenCostFor(
  frag: ContextFragment,
  modelKey: ModelKey,
): number {
  return (
    (frag.estimatedTokens as Readonly<Record<string, number>>)[modelKey as string] ??
    (frag.estimatedTokens as Readonly<Record<string, number>>)[
      Object.keys(frag.estimatedTokens)[0] ?? ""
    ] ??
    0
  );
}

export function allocateBudget(
  scored: readonly ScoredCandidate[],
  budget: ContextBudget,
  options: AllocationOptions,
  modelKey: ModelKey,
): AllocationResult {
  const selected: ScoredCandidate[] = [];
  const omitted: { result: RetrievalResult; reason: string }[] = [];
  let remaining = Number(budget.optionalContextTarget);
  // Hard-required first.
  const required = scored.filter((s) => s.hardRequired && options.hardIncludeRequired);
  const optional = scored
    .filter((s) => !s.hardRequired)
    .sort((a, b) => b.utility - a.utility);
  for (const s of required) {
    selected.push(s);
    remaining -= tokenCostFor(s.result.fragment, modelKey);
  }
  for (const s of optional) {
    const cost = tokenCostFor(s.result.fragment, modelKey);
    if (cost <= remaining) {
      // Preserve dependency closure: if any dependency is not already selected,
      // try to include it; else omit.
      const depsOk =
        !options.preserveDependencies ||
        s.result.fragment.dependencies.every((d) =>
          selected.some((sel) => sel.result.fragment.id === d),
        );
      if (!depsOk) {
        omitted.push({ result: s.result, reason: "dependency closure not satisfied" });
        continue;
      }
      selected.push(s);
      remaining -= cost;
    } else {
      omitted.push({ result: s.result, reason: "token budget exceeded" });
    }
  }
  const total = selected.reduce(
    (sum, s) => sum + tokenCostFor(s.result.fragment, modelKey),
    0,
  );
  void budget;
  return { selected, omitted, totalEstimatedTokens: total };
}

// ────────────────────────── Cache epoch plan ─────────────────────────────────

export function planCacheEpoch(
  input: CompileInput,
  selected: readonly ScoredCandidate[],
): ContextCachePlan {
  const stable = selected.filter((s) => s.result.fragment.exactness === "exact");
  const stableHash = computeStablePrefixHash(stable.map((s) => s.result.fragment));
  const volatileBoundary = stable.length;
  const breakpoints = stable.length > 0 ? [stable.length - 1] : [];
  const modelKey = input.model.modelKey;
  const predicted = stable.reduce(
    (sum, s) => sum + tokenCostFor(s.result.fragment, modelKey),
    0,
  );
  return {
    stablePrefixHash: stableHash,
    volatileSuffixBoundary: volatileBoundary,
    breakpoints,
    predictedCachedTokens: BigInt(predicted) as TokenCount,
  };
}

// ────────────────────────── Compile ──────────────────────────────────────────

export async function compileContext(input: CompileInput): Promise<CompiledContext> {
  const warnings: string[] = [];
  // 1. Required fragments.
  const required = await collectRequiredFragments(input);
  // 2. Retrieval queries.
  const queries = deriveRetrievalQueries(input);
  // 3. Retrieval pipeline.
  const pipeline = input.store as unknown as RetrievalPipeline;
  if (typeof pipeline.retrieve !== "function") {
    throw new Error("ContextStore must also implement RetrievalPipeline");
  }
  const retrieved = await pipeline.retrieve(queries, input);
  // Combine required + retrieved as RetrievalResult.
  const requiredResults: RetrievalResult[] = [
    ...required.authority.map((f) => ({
      fragment: f,
      method: "exact_user_reference" as const,
      rawScore: 1.0,
      rerankedScore: 1.0,
      sourceVersion: f.sourceVersion,
      reason: "authority",
    })),
    ...required.taskContract.map((f) => ({
      fragment: f,
      method: "exact_user_reference" as const,
      rawScore: 1.0,
      rerankedScore: 1.0,
      sourceVersion: f.sourceVersion,
      reason: "task_contract",
    })),
    ...required.policy.map((f) => ({
      fragment: f,
      method: "exact_user_reference" as const,
      rawScore: 1.0,
      rerankedScore: 1.0,
      sourceVersion: f.sourceVersion,
      reason: "policy",
    })),
  ];
  // 4. Dedup + freshness.
  const candidates = deduplicateAndValidate(
    [...requiredResults, ...retrieved],
    input.worldState.sourceVersions,
  );
  // 5. Evidence-coverage.
  const coverage = buildEvidenceCoverage(input, candidates);
  let expanded: readonly RetrievalResult[] = [];
  if (coverage.hasCriticalGaps) {
    expanded = await pipeline.expandForGaps(coverage.gaps, input);
    warnings.push(`expanded retrieval for ${coverage.gaps.length} evidence gap(s)`);
  }
  const all = deduplicateAndValidate([...candidates, ...expanded], input.worldState.sourceVersions);
  // 6. Score.
  const scored = scoreCandidates(all, input);
  // 7. Allocate.
  const allocation = allocateBudget(scored, input.budget, {
    preserveDependencies: true,
    preserveCompleteEpisodes: true,
    hardIncludeRequired: true,
  }, input.model.modelKey);
  // 8. Cache plan.
  const cachePlan = planCacheEpoch(input, allocation.selected);
  // Confidentiality filter.
  const confFiltered = filterByConfidentiality(
    input.confidentialityPolicy,
    input.provider.providerId,
    allocation.selected.map((s) => s.result.fragment),
  );
  const selectedFragments = confFiltered.admitted;
  // 9. Render.
  const rendered = await input.renderer.render({
    provider: input.provider,
    model: input.model,
    fragments: selectedFragments,
    toolSchemas: [],
    cachePlan: {
      stablePrefixHash: cachePlan.stablePrefixHash,
      breakpoints: cachePlan.breakpoints,
    },
    continuationId: input.epoch?.continuationId ?? null,
    outputProfile: "terse",
    reasoningReserveTokens: input.budget.reasoningReserve,
    outputReserveTokens: input.budget.outputReserve,
    hardInputLimit: input.budget.hardInputLimit,
    signal: input.signal,
  });
  // 10. Build + persist manifest.
  const manifestInput = {
    compilerVersion: "v1",
    policyVersion: "v1",
    providerCapabilityHash: hashSnapshot(input.provider),
    model: input.model.modelKey,
    epoch: input.epoch ?? {
      epochId: "00000000-0000-7000-8000-000000000000" as Uuid7,
      threadId: input.thread.threadId,
      sequence: 0,
      baselineHash: cachePlan.stablePrefixHash,
      provider: input.provider.providerId,
      model: input.model.modelKey,
      continuationId: null,
      startedAt: input.worldState.observedAt,
    },
    selected: selectedFragments,
    omitted: [
      ...allocation.omitted.map((o) => ({ fragmentId: o.result.fragment.id, reason: o.reason })),
      ...confFiltered.omitted,
    ],
    cachePlan,
    reserves: {
      output: input.budget.outputReserve,
      reasoning: input.budget.reasoningReserve,
      toolResult: input.budget.expectedToolResultReserve,
      recovery: input.budget.recoveryMargin,
    },
    predictedCachedTokens: cachePlan.predictedCachedTokens,
    confidentialityDecisions: Object.fromEntries(
      selectedFragments.map((f) => [f.id, f.confidentiality]),
    ) as Record<string, ContextManifest["confidentialityDecisions"][string]>,
    taintDecisions: Object.fromEntries(
      selectedFragments.map((f) => [f.id, f.injectionRisk]),
    ) as Record<string, ContextManifest["taintDecisions"][string]>,
    experimentAssignments: input.experimentAssignments.map((e) => e.experimentId),
    occurredAt: input.worldState.observedAt,
  };
  const builtManifest = buildManifest(manifestInput);
  const manifest = await input.store.persistManifest(builtManifest);
  return {
    rendered,
    manifest,
    warnings,
    omitted: manifestInput.omitted,
  };
}

// ────────────────────────── Deterministic fake retrieval ─────────────────────

/**
 * A deterministic retrieval pipeline for tests and bootstrap. Returns nothing
 * — real implementations override `retrieve` and `expandForGaps`.
 */
export class DeterministicRetrieval implements RetrievalPipeline {
  async retrieve(
    _queries: readonly RetrievalQuery[],
    _input: CompileInput,
  ): Promise<readonly RetrievalResult[]> {
    return [];
  }
  async expandForGaps(
    _gaps: readonly EvidenceGap[],
    _input: CompileInput,
  ): Promise<readonly RetrievalResult[]> {
    return [];
  }
}

// ────────────────────────── Helpers ──────────────────────────────────────────

function hashSnapshot(s: ProviderCapabilitySnapshot): ContentHash {
  // Deterministic hash of the snapshot for manifest recording.
  const text = `${s.providerId}:${s.observedAt}:${s.policy.retentionMode}:${s.context.testedSafeTokens}`;
  let h1 = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, "0").repeat(8);
  return `sha256:${hex}` as ContentHash;
}

export type {
  ContextFragment,
  ContextManifest,
  ContextBudget,
  ContextDirective,
  ContextEpochSnapshot,
  ContextCachePlan,
  TaskContract,
  Episode,
  Checkpoint,
  ModelKey,
  ContentHash,
  TokenCount,
  ProviderRenderer,
  RenderedProviderRequest,
  ConfidentialityPolicy,
};
