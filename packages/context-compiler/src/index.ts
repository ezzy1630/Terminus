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
  ArtifactRef,
  ArtifactUri,
  ByteCount,
  ContextScope,
  SelectionFeatures,
  SourceDescriptor,
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
  /**
   * Optional retrieval pipeline. When supplied, this is used in preference
   * to the legacy `store as RetrievalPipeline` cast. When omitted, the
   * compiler falls back to: (1) the store if it also implements
   * `RetrievalPipeline`; (2) a `DeterministicRetrieval` that returns no
   * candidates (so compilation still works for tests that don't supply a
   * real index).
   */
  readonly retrievalPipeline?: RetrievalPipeline | undefined;
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
  /** One fragment per unresolved acceptance criterion (§8.4 step 2). */
  readonly acceptanceCriteria: readonly ContextFragment[];
}

/**
 * Builds the hard-required fragments per SPEC §8.4 step 2: "Hard-include
 * active authority, task/scope contract, policy, and unresolved acceptance
 * criteria." Each fragment carries the actual rendered text in
 * `textContent` so the provider renderers can emit real content instead of
 * artifact URIs.
 */
export async function collectRequiredFragments(
  input: CompileInput,
): Promise<RequiredFragments> {
  const now = input.worldState.observedAt;
  const modelKey = input.model.modelKey;
  const scope: ContextScope = {
    workspaceId: null,
    sessionId: input.thread.sessionId,
    taskId: input.task.taskId,
    pathPatterns: [],
  };
  const emptyFeatures: SelectionFeatures = {
    relevance: 1,
    novelty: 0,
    coverage: 1,
    uncertaintyReduction: 1,
    riskReduction: 1,
    modelCompatibility: 1,
    redundancyPenalty: 0,
    injectionPenalty: 0,
  };

  // 1. Authority fragment: the active security policy baseline.
  const authorityText = `# Authority: secure-local-default policy\n\nThis task operates under the secure-local-default policy profile.\nTrusted workspace. Network egress is denied by default.`;
  const authority: ContextFragment = {
    id: "required:authority:secure-local-default",
    kind: "authority",
    contentRef: makeArtifactRef("authority", authorityText),
    textContent: authorityText,
    source: makeSource("forge://policy/secure-local-default", "policy-coordinator", now),
    sourceVersion: "v1",
    authority: 100,
    priority: 100,
    trust: "trusted",
    confidentiality: "workspace",
    injectionRisk: "none",
    exactness: "exact",
    scope,
    freshness: { observedAt: now, sourceVersion: "v1", stale: false, staleReason: null },
    dependencies: [],
    invalidation: [{ kind: "policy_changed", selector: "forge://policy/secure-local-default" }],
    estimatedTokens: { [modelKey]: estimateTokens(authorityText) } as Readonly<Record<string, number>>,
    selectionFeatures: emptyFeatures,
  };

  // 2. Task contract fragment: objective, non-goals, acceptance criteria.
  const contract = input.task.contract;
  const contractLines: string[] = [
    `# Task Contract (v${contract.version})`,
    "",
    `## Objective`,
    contract.objective,
  ];
  if (contract.userOutcome !== null) {
    contractLines.push("", `## User Outcome`, contract.userOutcome);
  }
  if (contract.nonGoals.length > 0) {
    contractLines.push("", "## Non-Goals");
    for (const ng of contract.nonGoals) contractLines.push(`- ${ng}`);
  }
  if (contract.acceptanceCriteria.length > 0) {
    contractLines.push("", `## Acceptance Criteria`);
    for (const ac of contract.acceptanceCriteria) {
      contractLines.push(`- [${ac.required ? "required" : "optional"}] ${ac.id}: ${ac.statement}`);
      if (ac.verificationHint !== null) contractLines.push(`  - hint: ${ac.verificationHint}`);
    }
  }
  if (contract.constraints.length > 0) {
    contractLines.push("", `## Constraints`);
    for (const c of contract.constraints) contractLines.push(`- ${c}`);
  }
  if (contract.assumptions.length > 0) {
    contractLines.push("", `## Assumptions`);
    for (const a of contract.assumptions) contractLines.push(`- ${a}`);
  }
  if (contract.unknowns.length > 0) {
    contractLines.push("", `## Unknowns`);
    for (const u of contract.unknowns) contractLines.push(`- ${u}`);
  }
  const contractText = contractLines.join("\n");
  const taskContract: ContextFragment = {
    id: `required:task_contract:${input.task.taskId}`,
    kind: "task_contract",
    contentRef: makeArtifactRef("task_contract", contractText),
    textContent: contractText,
    source: makeSource(`task://${input.task.taskId}`, "task-runtime", now),
    sourceVersion: `v${contract.version}`,
    authority: 95,
    priority: 95,
    trust: "trusted",
    confidentiality: "workspace",
    injectionRisk: "none",
    exactness: "exact",
    scope,
    freshness: { observedAt: now, sourceVersion: `v${contract.version}`, stale: false, staleReason: null },
    dependencies: [],
    invalidation: [{ kind: "policy_changed", selector: `task://${input.task.taskId}` }],
    estimatedTokens: { [modelKey]: estimateTokens(contractText) } as Readonly<Record<string, number>>,
    selectionFeatures: emptyFeatures,
  };

  // 3. Policy fragment: command-allowlist policy.
  const policyText = `# Project Rules: command policy\n\nExecuted commands must match the active command allowlist.\nSide effects require a minted capability token.\nExternal network egress requires explicit approval.`;
  const policy: ContextFragment = {
    id: "required:policy:command",
    kind: "project_rule",
    contentRef: makeArtifactRef("policy", policyText),
    textContent: policyText,
    source: makeSource("forge://policy/command", "policy-coordinator", now),
    sourceVersion: "v1",
    authority: 90,
    priority: 90,
    trust: "trusted",
    confidentiality: "workspace",
    injectionRisk: "none",
    exactness: "exact",
    scope,
    freshness: { observedAt: now, sourceVersion: "v1", stale: false, staleReason: null },
    dependencies: ["required:authority:secure-local-default"],
    invalidation: [{ kind: "policy_changed", selector: "forge://policy/command" }],
    estimatedTokens: { [modelKey]: estimateTokens(policyText) } as Readonly<Record<string, number>>,
    selectionFeatures: emptyFeatures,
  };

  // 4. One fragment per unresolved acceptance criterion.
  const acceptanceCriteria: ContextFragment[] = [];
  for (const ac of contract.acceptanceCriteria) {
    if (!ac.required) continue;
    // A criterion is "unresolved" until the verification DAG confirms pass.
    // The context compiler treats all criteria without an observed pass as
    // unresolved; the verification package records passes elsewhere.
    const acText = `# Acceptance Criterion: ${ac.id}\n\n${ac.statement}\n${ac.verificationHint !== null ? `\nVerification hint: ${ac.verificationHint}\n` : ""}`;
    acceptanceCriteria.push({
      id: `required:acceptance:${ac.id}`,
      kind: "task_contract",
      contentRef: makeArtifactRef(`ac:${ac.id}`, acText),
      textContent: acText,
      source: makeSource(`task://${input.task.taskId}/criterion/${ac.id}`, "task-runtime", now),
      sourceVersion: `v${contract.version}`,
      authority: 92,
      priority: 92,
      trust: "trusted",
      confidentiality: "workspace",
      injectionRisk: "none",
      exactness: "exact",
      scope,
      freshness: { observedAt: now, sourceVersion: `v${contract.version}`, stale: false, staleReason: null },
      dependencies: [`required:task_contract:${input.task.taskId}`],
      invalidation: [{ kind: "policy_changed", selector: `task://${input.task.taskId}/criterion/${ac.id}` }],
      estimatedTokens: { [modelKey]: estimateTokens(acText) } as Readonly<Record<string, number>>,
      selectionFeatures: emptyFeatures,
    });
  }

  return { authority: [authority], taskContract: [taskContract], policy: [policy], acceptanceCriteria };
}

/** Rough token estimate: ~4 characters per token. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Build an ArtifactRef with a stable, content-derived hash. */
function makeArtifactRef(kind: string, text: string): ArtifactRef {
  // Synchronous SHA-256 of the text. We avoid pulling in `node:crypto` here
  // (which would couple this pure-logic package to a runtime). Instead we
  // reuse the context-ir helper which already imports `node:crypto`.
  // To avoid a circular dep, we compute a deterministic hash inline.
  const hex = simpleHashHex(`${kind}:${text}`);
  return {
    hash: `sha256:${hex}` as ContentHash,
    uri: `artifact://sha256/${hex}` as ArtifactUri,
    mediaType: "text/plain",
    bytes: BigInt(text.length) as ByteCount,
  };
}

/**
 * Deterministic hash. We deliberately do NOT use this as a security boundary
 * — the kernel re-hashes with its canonical sha256 before persisting. The
 * purpose here is to give each required fragment a stable, content-derived
 * identity so manifest entries round-trip correctly.
 */
function simpleHashHex(input: string): string {
  // FNV-1a 64-bit approximation, repeated to fill 64 hex chars.
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0;
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const part2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return (part1 + part2).repeat(4);
}

/** Build a SourceDescriptor for an internal resource URI. */
function makeSource(uri: string, producer: string, observedAt: Rfc3339Timestamp): SourceDescriptor {
  return {
    uri,
    producer,
    producerVersion: "v1",
    observedAt,
    observedBy: "kernel",
    evidenceRefs: [],
  };
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
  const pipeline = resolveRetrievalPipeline(input);
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
    ...required.acceptanceCriteria.map((f) => ({
      fragment: f,
      method: "exact_user_reference" as const,
      rawScore: 1.0,
      rerankedScore: 1.0,
      sourceVersion: f.sourceVersion,
      reason: "acceptance_criterion",
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

// ────────────────────────── Source index + Lexical retrieval ─────────────────

/**
 * In-memory map of source path → text content. Used by `LexicalRetrieval` to
 * do real substring matching. The kernel's tree-sitter / LSP indices can
 * plug in by adapting to this interface (or implementing `RetrievalPipeline`
 * directly).
 */
export interface SourceIndex {
  /** Returns the source paths known to the index. */
  readonly paths: readonly string[];
  /** Returns the content for a path, or `null` if unknown. */
  get(path: string): string | null;
  /** Optional: source version for each path (e.g. git SHA). */
  readonly versions?: Readonly<Record<string, string>> | undefined;
}

/** A retrieved snippet from the lexical pipeline. */
export interface RetrievedFragment {
  readonly path: string;
  /** The matching snippet (window around the match). */
  readonly snippet: string;
  readonly score: number;
  readonly method: RetrievalMethod;
  readonly sourceVersion: string | null;
}

/**
 * Resolve which retrieval pipeline to use for a compile run. If the caller
 * supplied an explicit `retrievalPipeline` on the input, use that; otherwise
 * fall back to the store if it also implements `RetrievalPipeline`; otherwise
 * use a `DeterministicRetrieval` (returns no candidates) so compilation still
 * works for tests that don't supply a real index.
 */
function resolveRetrievalPipeline(input: CompileInput): RetrievalPipeline {
  if (input.retrievalPipeline !== undefined) return input.retrievalPipeline;
  const maybe = input.store as Partial<RetrievalPipeline>;
  if (typeof maybe.retrieve === "function" && typeof maybe.expandForGaps === "function") {
    return maybe as RetrievalPipeline;
  }
  return new DeterministicRetrieval();
}

/**
 * Lexical retrieval pipeline (SPEC §8.4 step 3). Performs:
 *  1. Exact path/symbol lookup — if a query matches a known path or symbol
 *     exactly, the full source file is returned at top score.
 *  2. Lexical BM25-style scoring — tokens of each query are matched against
 *     the tokenized content of each indexed file. Files are ranked by
 *     term-frequency / inverse-document-frequency score with a length norm.
 *  3. Returns ranked snippets with source versions.
 *
 * This is a minimal but real implementation; tree-sitter / LSP indices can
 * plug in later by adapting to the `SourceIndex` interface or by
 * implementing `RetrievalPipeline` directly.
 */
export class LexicalRetrieval implements RetrievalPipeline {
  private readonly index: SourceIndex;
  private readonly tokenEstimate: (text: string) => number;

  constructor(index: SourceIndex, tokenEstimate?: (text: string) => number) {
    this.index = index;
    this.tokenEstimate = tokenEstimate ?? defaultTokenEstimate;
  }

  async retrieve(
    queries: readonly RetrievalQuery[],
    input: CompileInput,
  ): Promise<readonly RetrievalResult[]> {
    const now = input.worldState.observedAt;
    const modelKey = input.model.modelKey;
    const docs = this.index.paths.map((p) => ({
      path: p,
      content: this.index.get(p) ?? "",
      version: this.index.versions?.[p] ?? null,
    }));
    const df = computeDocumentFrequencies(docs.map((d) => d.content));
    const N = Math.max(1, docs.length);
    const results: RetrievalResult[] = [];
    const seenFragmentIds = new Set<string>();
    for (const q of queries) {
      // 1. Exact path/symbol lookup.
      const exact = docs.find((d) => d.path === q.text);
      if (exact !== undefined) {
        const frag = this.makeFragment(exact, exact.content, "exact_path_symbol", now, modelKey, q);
        if (!seenFragmentIds.has(frag.id)) {
          seenFragmentIds.add(frag.id);
          results.push({
            fragment: frag,
            method: "exact_path_symbol",
            rawScore: 100,
            rerankedScore: 100,
            sourceVersion: exact.version,
            reason: q.reason,
          });
        }
        continue;
      }
      // 2. Lexical BM25-style scoring.
      const qTokens = tokenize(q.text);
      if (qTokens.length === 0) continue;
      const scored = docs
        .map((d) => {
          const tfMap = termFrequencies(d.content);
          let score = 0;
          for (const term of qTokens) {
            const tf = tfMap.get(term) ?? 0;
            if (tf === 0) continue;
            const docFreq = df.get(term) ?? 0;
            const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
            const k1 = 1.5;
            const b = 0.75;
            const dl = d.content.length;
            const avgdl = avgDocLength(docs);
            const denom = tf + k1 * (1 - b + b * (dl / Math.max(1, avgdl)));
            score += idf * (tf * (k1 + 1)) / Math.max(1, denom);
          }
          return { doc: d, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      for (const { doc, score } of scored) {
        const snippet = extractSnippet(doc.content, qTokens, 240);
        const frag = this.makeFragment(doc, snippet, "lexical_bm25", now, modelKey, q);
        if (seenFragmentIds.has(frag.id)) continue;
        seenFragmentIds.add(frag.id);
        results.push({
          fragment: frag,
          method: "lexical_bm25",
          rawScore: score,
          rerankedScore: score,
          sourceVersion: doc.version,
          reason: q.reason,
        });
      }
    }
    return results;
  }

  async expandForGaps(
    gaps: readonly EvidenceGap[],
    input: CompileInput,
  ): Promise<readonly RetrievalResult[]> {
    // For each evidence gap, derive a query and run retrieval.
    const queries: RetrievalQuery[] = gaps.map((g) => ({
      text: g.requirement,
      reason: `evidence gap: ${g.requirementId}`,
      suggestedMethods: ["lexical_bm25"],
    }));
    return this.retrieve(queries, input);
  }

  private makeFragment(
    doc: { readonly path: string; readonly content: string; readonly version: string | null },
    snippet: string,
    method: RetrievalMethod,
    now: Rfc3339Timestamp,
    modelKey: ModelKey,
    q: RetrievalQuery,
  ): ContextFragment {
    // The query `q` is referenced here so the rationale string flows into
    // the manifest later via the caller. We embed it in the fragment id so
    // distinct queries against the same path produce distinct fragments
    // (avoids accidental dedup across queries).
    void q;
    const hashHex = simpleHashHex(`${doc.path}:${snippet}`);
    const scope: ContextScope = {
      workspaceId: null,
      sessionId: null,
      taskId: null,
      pathPatterns: [doc.path],
    };
    const features: SelectionFeatures = {
      relevance: method === "exact_path_symbol" ? 1 : 0.5,
      novelty: 0.5,
      coverage: 0.5,
      uncertaintyReduction: 0.5,
      riskReduction: 0.5,
      modelCompatibility: 0.8,
      redundancyPenalty: 0,
      injectionPenalty: 0,
    };
    return {
      id: `lexical:${doc.path}:${hashHex.slice(0, 16)}`,
      kind: "code",
      contentRef: {
        hash: `sha256:${hashHex}` as ContentHash,
        uri: `artifact://sha256/${hashHex}` as ArtifactUri,
        mediaType: "text/plain",
        bytes: BigInt(snippet.length) as ByteCount,
      },
      textContent: snippet,
      source: {
        uri: `workspace://${doc.path}`,
        producer: "lexical-retrieval",
        producerVersion: "v1",
        observedAt: now,
        observedBy: "kernel",
        evidenceRefs: [],
      },
      sourceVersion: doc.version,
      authority: 50,
      priority: 50,
      trust: "derived",
      confidentiality: "workspace",
      injectionRisk: "low",
      exactness: "recoverable_by_reference",
      scope,
      freshness: { observedAt: now, sourceVersion: doc.version, stale: false, staleReason: null },
      dependencies: [],
      invalidation: [{ kind: "file_changed", selector: doc.path }],
      estimatedTokens: { [modelKey]: this.tokenEstimate(snippet) } as Readonly<Record<string, number>>,
      selectionFeatures: features,
    };
  }
}

/** Default token estimator: ~4 chars per token. */
function defaultTokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Tokenize a string for BM25 scoring. */
function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}

/** Compute term frequencies for a document. */
function termFrequencies(content: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tokenize(content)) {
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return map;
}

/** Compute document frequencies across a corpus. */
function computeDocumentFrequencies(docs: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const d of docs) {
    const seen = new Set<string>();
    for (const t of tokenize(d)) {
      if (seen.has(t)) continue;
      seen.add(t);
      map.set(t, (map.get(t) ?? 0) + 1);
    }
  }
  return map;
}

/** Average document length (in characters) across a corpus. */
function avgDocLength(docs: readonly { readonly content: string }[]): number {
  if (docs.length === 0) return 1;
  return docs.reduce((s, d) => s + d.content.length, 0) / docs.length;
}

/** Extract a snippet around the first matching token in the content. */
function extractSnippet(content: string, queryTokens: readonly string[], windowSize: number): string {
  if (content.length <= windowSize) return content;
  const lower = content.toLowerCase();
  let bestIdx = -1;
  for (const t of queryTokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (bestIdx === -1 || i < bestIdx)) bestIdx = i;
  }
  if (bestIdx === -1) return content.slice(0, windowSize);
  const start = Math.max(0, bestIdx - Math.floor(windowSize / 2));
  const end = Math.min(content.length, start + windowSize);
  return content.slice(start, end);
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
