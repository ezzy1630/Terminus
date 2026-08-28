/**
 * @terminus/context-compiler — the Context Compiler (SPEC §8, §33).
 *
 * `compileContext(input: CompileInput): Promise<CompiledContext>` performs:
 *  1. collect required fragments (authority, task contract, policy)
 *  2. derive retrieval queries from objective/changed-files/diagnostics/...
 *  3. retrieval pipeline (exact → lexical → tree-sitter → LSP → graph →
 *     optional semantic)
 *  4. deduplicate and validate freshness
 *  5. build evidence-coverage matrix; expand for gaps
 *  6. score candidates (independent weighted evidence minus penalties,
 *     divided by token cost)
 *  7. allocate budget (reserves for output/reasoning/tool-results/recovery;
 *     greedy selection preserving dependency closure and complete-episode
 *     integrity)
 *  8. plan cache epoch (stable prefix, volatile suffix)
 *  9. render provider-specific request via provider renderer
 *  10. build and persist manifest (durable before send)
 *
 * Returns the rendered request, durable manifest, omissions, budget outcome,
 * and optional content-addressed request artifact. No direct DB writes —
 * accept a `ContextStore` interface.
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
} from "@terminus/domain";
import type {
  ContextFragment,
  ContextEpochSnapshot,
  ContextManifest,
  ContextBudget,
  ContextDirective,
  ContextCachePlan,
} from "@terminus/context-ir";
import {
  buildManifest,
  canonicalJson,
  computeContentHash,
  computeStablePrefixHash,
} from "@terminus/context-ir";
import type {
  ProviderCapabilitySnapshot,
  ModelCapabilitySnapshot,
  ProviderRenderer,
  RenderedProviderRequest,
  ConfidentialityPolicy,
  ProviderToolSchema,
} from "@terminus/provider-core";
import { filterByConfidentiality } from "@terminus/provider-core";
import { resolveTokenizer } from "./tokenizer.js";
import type { ModelTokenizer, TokenEstimator } from "./tokenizer.js";
import { compactContext, type CompactionTransform } from "./compaction.js";
import { buildCacheEpochDebugData } from "./cache-debug.js";
import type { CacheEpochDebugSnapshot } from "./cache-debug.js";
import { summarizeRetrievalSelection } from "./retrieval-metrics.js";
import { resolveInstructionPrecedence } from "./project-instructions.js";
import {
  deriveProviderAwareContextBudget,
  CONTEXT_BUDGET_POLICY_VERSION,
} from "./budget-policy.js";
export {
  compactContext,
} from "./compaction.js";
export type {
  CompactionInvariant,
  CompactionTransform,
  SemanticCompactionInput,
  SemanticCompactionResult,
} from "./compaction.js";
export type {
  CalibrationStatus,
  ModelTokenizer,
  ModelTokenBreakdown,
  ReconciledUsage,
  ReconcileUsageOptions,
  TokenCalibrationDiagnostics,
  TokenCalibrationPolicy,
  TokenCalibrationSeed,
  TokenEstimate,
  TokenEstimateSource,
  TokenEstimator,
  TokenizerBinding,
  TokenizerOptions,
} from "./tokenizer.js";
export {
  deriveProviderAwareContextBudget,
  CONTEXT_BUDGET_POLICY_VERSION,
} from "./budget-policy.js";
export type {
  ProviderAwareBudgetBreakdown,
  ProviderAwareBudgetInput,
  ProviderAwareBudgetResult,
} from "./budget-policy.js";
export {
  CalibratedModelTokenizer,
  DEFAULT_CALIBRATION_POLICY,
  TOKEN_CALIBRATION_VERSION,
  TOKEN_ESTIMATOR_CONTRACT_VERSION,
  reconcileUsage,
  resolveTokenizer,
} from "./tokenizer.js";

export {
  buildCacheEpochDebugData,
  buildStablePrefixDebugData,
  compareCacheEpochs,
  snapshotCacheEpoch,
} from "./cache-debug.js";
export type {
  CacheEpochDebugData,
  CacheEpochDebugInput,
  CacheEpochDebugSnapshot,
  CacheEpochDiagnostic,
  CacheEpochDiagnosticCode,
  StablePrefixDebugData,
  StablePrefixEntry,
} from "./cache-debug.js";

export {
  aggregateRetrievalMetrics,
  evaluateRetrievalOutcome,
  summarizeRetrievalSelection,
  RETRIEVAL_METRICS_VERSION,
} from "./retrieval-metrics.js";
export type {
  RetrievalAggregateMetrics,
  RetrievalMetricCandidate,
  RetrievalMetricSymbol,
  RetrievalOracle,
  RetrievalOutcomeInput,
  RetrievalOutcomeMetrics,
  RetrievalRunMetrics,
  RetrievalSelectionMetricInput,
  RetrievalSelectionMetrics,
} from "./retrieval-metrics.js";

export {
  buildHandoffBundle,
  formatHandoffBundle,
} from "./handoff.js";
export type {
  HandoffAcceptance,
  HandoffAcceptanceStatus,
  HandoffActionStatus,
  HandoffBundle,
  HandoffBundleInput,
  HandoffChangedFile,
  HandoffCheckStatus,
  HandoffCompletedAction,
  HandoffEvidenceHandle,
  HandoffFileChange,
  HandoffVerificationCheck,
  HandoffVerificationState,
  HandoffVerificationStatus,
} from "./handoff.js";

// World-state producer registry (SPEC §33.5)
export {
  WorldStateProducerRegistry,
  StaticProducer,
  FunctionalProducer,
  groupObservations,
  repositoryStateProducer,
  diagnosticsProducer,
  jobsProducer,
  testsProducer,
  budgetsProducer,
  permissionsProducer,
  capabilitiesProducer,
  scopeLedgerProducer,
} from "./world-state-registry.js";
export type {
  WorldStateProducer,
  ObservationGroup,
  RepositoryState,
  DiagnosticsState,
  JobsState,
  TestsState,
  BudgetsState,
  PermissionsState,
  CapabilitiesState,
  ScopeLedgerState,
} from "./world-state-registry.js";

// Structured checkpoints + provenance DAG (SPEC §9, §33.16, ADR-0011)
export {
  checkpointContentSchema,
  generateCheckpointContent,
  validateCheckpoint,
  shouldCreateCheckpoint,
  ProvenanceDag,
} from "./checkpoint.js";
export type {
  CheckpointContent,
  CheckpointGeneratorInput,
  ValidationResult,
  ValidationViolation,
  CheckpointTrigger,
  ProvenanceNode,
} from "./checkpoint.js";

// Counterfactual replay (SPEC §33.16)
export {
  replayContext,
  replayWithAblation,
  standardAblations,
  checkpointAblation,
  memoryAblation,
  worldStateAblation,
  documentationAblation,
} from "./replay.js";
export type { AblationSpec, ReplayInput, ReplayResult } from "./replay.js";

// Context explanation API (SPEC §33.16)
export {
  explainFragment,
  explainManifest,
  manifestExplanationToRecord,
} from "./context-explanation.js";
export type {
  FragmentExplanation,
  ManifestExplanation,
} from "./context-explanation.js";

// Project instruction discovery with scoped precedence
export {
  DEFAULT_INSTRUCTION_FILENAMES,
  DEFAULT_MAX_INSTRUCTION_BYTES,
  discoverInstructions,
  instructionsToFragments,
  resolveInstructionPrecedence,
} from "./project-instructions.js";
export type {
  DiscoveredInstruction,
  InstructionDiscoveryConfig,
  InstructionFragmentInput,
  ResolvedInstructions,
} from "./project-instructions.js";

// Durable goal/progress state
export {
  reconstructGoalState,
  formatProgressSummary,
  diffGoalStates,
} from "./durable-goal-state.js";
export type {
  GoalState,
  GoalStateReconstructionInput,
  GoalStateDiff,
} from "./durable-goal-state.js";

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
  /**
   * UTF-8 artifact bytes keyed by their verified content hash. Complete tool
   * episode pairs must be present; missing or mismatched bytes fail closed.
   */
  readonly episodeContent: ReadonlyMap<ContentHash, string>;
  readonly checkpoint: Checkpoint | null;
  readonly userDirectives: readonly ContextDirective[];
  /** Repository-scoped instruction fragments loaded by the control plane. */
  readonly projectInstructionFragments?: readonly ContextFragment[] | undefined;
  readonly activeCapabilities: readonly CapabilityDescriptorSnapshot[];
  readonly budget: ContextBudget;
  readonly experimentAssignments: readonly ExperimentAssignment[];
  readonly renderer: ProviderRenderer;
  readonly confidentialityPolicy: ConfidentialityPolicy;
  /** Tool schemas are part of the exact provider-visible invocation. */
  readonly toolSchemas?: readonly ProviderToolSchema[] | undefined;
  /** Optional verified provider binding or persisted calibration profile. */
  readonly tokenEstimator?: TokenEstimator | undefined;
  /** Semantic compaction is opt-in and must preserve evidence links. */
  readonly compactionPolicy?: CompactionPolicy | undefined;
  /**
   * Optional platform authority documents rendered as hard-required
   * authority fragments (SPEC §8.4 step 2). When omitted, the compiler
   * falls back to the built-in minimal policy baseline.
   */
  readonly authorityDocuments?: readonly AuthorityDocument[] | undefined;
  /** Optional prior snapshot used to explain cache mutations across turns. */
  readonly previousCacheEpoch?: CacheEpochDebugSnapshot | null | undefined;
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
  readonly totalEstimatedTokens: number;
  /** True when hard-required fragments exceed the configured hard limit. */
  readonly overHardLimit: boolean;
  /** Content-addressed provider request, when the store persisted it. */
  readonly renderedRequestArtifact: ArtifactRef | null;
}

export interface CompactionPolicy {
  readonly enabled: boolean;
  readonly targetTokens: number;
}

// ────────────────────────── ContextStore interface ───────────────────────────

export interface ContextStore {
  /** Persist a manifest durably. Must complete before the provider request. */
  persistManifest(
    manifest: Omit<ContextManifest, "id">,
    fragments?: readonly ContextFragment[],
  ): Promise<ContextManifest>;
  /** Load a manifest by id. */
  getManifest(id: Uuid7): Promise<ContextManifest | null>;
  /** Record an observation record (post-attempt usage/cost). */
  recordObservation(
    manifestId: Uuid7,
    observation: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  /** Persist the exact rendered request before provider transport begins. */
  recordRenderedRequest?(
    manifestId: Uuid7,
    rendered: RenderedProviderRequest,
  ): Promise<ArtifactRef | null>;
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
  /** Applicable repository instructions, ordered from closest to root. */
  readonly projectRules: readonly ContextFragment[];
  /** Conflicts resolved by scoped instruction precedence. */
  readonly instructionConflicts: ReadonlyArray<{
    readonly directive: string;
    readonly winner: string;
    readonly overridden: readonly string[];
  }>;
  /** One fragment per unresolved acceptance criterion (§8.4 step 2). */
  readonly acceptanceCriteria: readonly ContextFragment[];
}

/**
 * A caller-supplied platform authority document. Rendered verbatim as a
 * hard-required authority fragment; `id` must be stable across turns so the
 * cache-stable prefix is preserved.
 */
export interface AuthorityDocument {
  readonly id: string;
  readonly sourceUri: string;
  readonly text: string;
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
  const tokenizer = input.tokenEstimator
    ?? resolveTokenizer(input.provider.providerId, modelKey);
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

  // 1. Authority fragments: the active security policy baseline. Caller
  // supplied documents (platform authority + safety rules + tool usage)
  // take precedence; the minimal built-in baseline is the fallback.
  const authorityDocuments: readonly AuthorityDocument[] = input.authorityDocuments?.length
    ? input.authorityDocuments
    : [{
        id: "secure-local-default",
        sourceUri: "terminus://policy/secure-local-default",
        text: `# Authority: secure-local-default policy\n\nThis task operates under the secure-local-default policy profile.\nTrusted workspace. Network egress is denied by default.`,
      }];
  const authorityFragments: ContextFragment[] = authorityDocuments.map((document, documentIndex) => {
    const fragmentId = `required:authority:${document.id}`;
    return {
      id: fragmentId,
      kind: "authority" as const,
      contentRef: makeArtifactRef(`authority:${document.id}`, document.text),
      textContent: document.text,
      source: makeSource(document.sourceUri, "policy-coordinator", now),
      sourceVersion: "v1",
      authority: 100,
      priority: 100,
      trust: "trusted" as const,
      confidentiality: "workspace" as const,
      injectionRisk: "none" as const,
      exactness: "exact" as const,
      scope,
      freshness: { observedAt: now, sourceVersion: "v1", stale: false, staleReason: null },
      dependencies: documentIndex === 0 ? [] : [`${"required:authority:"}${authorityDocuments[0]!.id}`],
      invalidation: [{ kind: "policy_changed" as const, selector: document.sourceUri }],
      estimatedTokens: { [modelKey]: tokenizer.estimateTextTokens(document.text) } as Readonly<Record<string, number>>,
      selectionFeatures: emptyFeatures,
    };
  });
  const primaryAuthorityId = authorityFragments[0]!.id;
  const authority = authorityFragments[0]!;

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
    estimatedTokens: { [modelKey]: tokenizer.estimateTextTokens(contractText) } as Readonly<Record<string, number>>,
    selectionFeatures: emptyFeatures,
  };

  // 3. Policy fragment: command-allowlist policy.
  const policyText = `# Project Rules: command policy\n\nExecuted commands must match the active command allowlist.\nSide effects require a minted capability token.\nExternal network egress requires explicit approval.`;
  const policy: ContextFragment = {
    id: "required:policy:command",
    kind: "project_rule",
    contentRef: makeArtifactRef("policy", policyText),
    textContent: policyText,
    source: makeSource("terminus://policy/command", "policy-coordinator", now),
    sourceVersion: "v1",
    authority: 90,
    priority: 90,
    trust: "trusted",
    confidentiality: "workspace",
    injectionRisk: "none",
    exactness: "exact",
    scope,
    freshness: { observedAt: now, sourceVersion: "v1", stale: false, staleReason: null },
    dependencies: [primaryAuthorityId],
    invalidation: [{ kind: "policy_changed", selector: "terminus://policy/command" }],
    estimatedTokens: { [modelKey]: tokenizer.estimateTextTokens(policyText) } as Readonly<Record<string, number>>,
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
      estimatedTokens: { [modelKey]: tokenizer.estimateTextTokens(acText) } as Readonly<Record<string, number>>,
      selectionFeatures: emptyFeatures,
    });
  }

  const resolvedInstructions = resolveInstructionPrecedence(
    input.projectInstructionFragments ?? [],
    (input.projectInstructionFragments ?? []).map((fragment) => fragment.id),
  );

  return {
    authority: authorityFragments,
    taskContract: [taskContract],
    policy: [policy],
    projectRules: resolvedInstructions.fragments,
    instructionConflicts: resolvedInstructions.conflicts,
    acceptanceCriteria,
  };
}

/** Build an ArtifactRef with a stable, content-derived hash. */
function makeArtifactRef(kind: string, text: string): ArtifactRef {
  // The bytes sent to the kernel must have the same identity as the IR. The
  // kind is metadata, not content, so it must not be mixed into the digest.
  void kind;
  const hash = computeContentHash(text);
  return {
    hash,
    uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ArtifactUri,
    mediaType: "text/plain",
    bytes: BigInt(new TextEncoder().encode(text).byteLength) as ByteCount,
  };
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

// ──────────────────────── Runtime state projection ──────────────────────────

/**
 * Projects authoritative state into ordinary context candidates. The live
 * control plane supplies this state from Prisma and kernel observations; the
 * compiler owns the invariant that incomplete tool episodes never enter the
 * candidate set.
 */
function collectRuntimeFragments(input: CompileInput): readonly RetrievalResult[] {
  const modelKey = input.model.modelKey;
  const tokenizer = input.tokenEstimator
    ?? resolveTokenizer(input.provider.providerId, modelKey);
  const scope: ContextScope = {
    workspaceId: null,
    sessionId: input.thread.sessionId,
    taskId: input.task.taskId,
    pathPatterns: [],
  };
  const features: SelectionFeatures = {
    relevance: 0.8,
    novelty: 0.5,
    coverage: 0.6,
    uncertaintyReduction: 0.7,
    riskReduction: 0.7,
    modelCompatibility: 1,
    redundancyPenalty: 0,
    injectionPenalty: 0,
  };
  const results: RetrievalResult[] = [];

  for (const [section, value] of Object.entries(input.worldState.sections)) {
    const text = `# World State: ${section}\n\n${safeWorldStateJson(section, value)}`;
    const sourceUri = `world://${section}`;
    const version = input.worldState.sourceVersions[sourceUri]
      ?? input.worldState.sourceVersions[section]
      ?? input.worldState.observedAt;
    const evidenceRefs = worldStateEvidenceRefs(value);
    const fragment = makeRuntimeFragment({
      id: `runtime:world_state:${section}`,
      kind: "world_state",
      uri: sourceUri,
      text,
      sourceVersion: version,
      authority: 70,
      priority: 70,
      trust: section === "request" ? "untrusted" : "derived",
      confidentiality: section === "secrets" ? "secret_adjacent" : "workspace",
      injectionRisk: section === "request" ? "medium" : "low",
      exactness: section === "request" ? "recoverable_by_reference" : "semantics_preserving",
      scope,
      modelKey,
      tokenizer,
      features,
      observedAt: input.worldState.observedAt,
      evidenceRefs,
      invalidation: [{ kind: "ttl", selector: `world://${section}` }],
    });
    results.push({
      fragment,
      method: "exact_user_reference",
      rawScore: 1,
      rerankedScore: 1,
      sourceVersion: version,
      reason: `authoritative world state: ${section}`,
    });
  }

  const toolEpisodeIds = new Map<string, { callId: string | null; resultId: string | null }>();
  for (const episode of input.recentEpisodes) {
    if (episode.toolCallId === null) continue;
    const pair = toolEpisodeIds.get(episode.toolCallId) ?? { callId: null, resultId: null };
    if (episode.kind === "tool_call") pair.callId = `runtime:episode:${episode.id}:tool_call`;
    if (episode.kind === "tool_result") pair.resultId = `runtime:episode:${episode.id}:tool_result`;
    toolEpisodeIds.set(episode.toolCallId, pair);
  }
  for (const episode of input.recentEpisodes) {
    const isToolEpisode = episode.kind === "tool_call" || episode.kind === "tool_result";
    if (isToolEpisode && episode.toolCallId !== null) {
      const pair = toolEpisodeIds.get(episode.toolCallId);
      const complete = pair !== undefined && pair.callId !== null && pair.resultId !== null;
      if (!complete) continue;
    }
    const hydratedText = episode.contentRef === null
      ? undefined
      : input.episodeContent.get(episode.contentRef);
    if (isToolEpisode && hydratedText === undefined) {
      throw new Error(`complete tool episode ${episode.id} is missing its persisted content`);
    }
    if (hydratedText !== undefined && computeContentHash(hydratedText) !== episode.contentRef) {
      throw new Error(`episode ${episode.id} content does not match ${episode.contentRef ?? "its persisted hash"}`);
    }
    const evidence = episode.contentRef === null
      ? []
      : [artifactRefFromContentHash(episode.contentRef)];
    const text = hydratedText ?? [
      `# Episode ${episode.sequence}: ${episode.kind}`,
      `turn: ${episode.turnId}`,
      episode.toolCallId === null ? null : `tool_call: ${episode.toolCallId}`,
      episode.contentRef === null ? "content: unavailable" : `content: ${episode.contentRef}`,
    ].filter((line): line is string => line !== null).join("\n");
    const fragment = makeRuntimeFragment({
      id: episode.kind === "tool_call"
        ? `runtime:episode:${episode.id}:tool_call`
        : episode.kind === "tool_result"
          ? `runtime:episode:${episode.id}:tool_result`
          : `runtime:episode:${episode.id}`,
      kind: episode.kind === "tool_result" ? "tool_result" : "recent_episode",
      uri: `episode://${episode.id}`,
      text,
      sourceVersion: episode.contentRef,
      authority: 45,
      priority: 45,
      trust: "derived",
      confidentiality: "workspace",
      injectionRisk: "low",
      exactness: hydratedText === undefined ? "recoverable_by_reference" : "exact",
      scope,
      modelKey,
      tokenizer,
      features,
      observedAt: episode.occurredAt,
      evidenceRefs: evidence,
      dependencies: episode.kind !== "tool_result" || episode.toolCallId === null
        ? []
        : [toolEpisodeIds.get(episode.toolCallId)?.callId ?? ""].filter(Boolean),
      invalidation: [{ kind: "ttl", selector: `episode://${episode.id}` }],
    });
    const exactFragment: ContextFragment = hydratedText === undefined || episode.contentRef === null
      ? fragment
      : {
          ...fragment,
          contentRef: {
            hash: episode.contentRef,
            uri: `artifact://sha256/${episode.contentRef.slice("sha256:".length)}` as ArtifactUri,
            mediaType: "application/json",
            bytes: BigInt(new TextEncoder().encode(hydratedText).byteLength) as ByteCount,
          },
        };
    results.push({
      fragment: exactFragment,
      method: "exact_user_reference",
      rawScore: 0.8,
      rerankedScore: 0.8,
      sourceVersion: episode.contentRef,
      reason: "complete recent episode",
    });
  }

  if (input.checkpoint !== null) {
    const checkpointText = [
      `# Checkpoint ${input.checkpoint.id}`,
      input.checkpoint.summary,
      `episode range: ${input.checkpoint.episodeRange.from}-${input.checkpoint.episodeRange.to}`,
      `canonical state: ${input.checkpoint.canonicalStateHash}`,
      `effect state: ${canonicalJson(input.checkpoint.effectState ?? [])}`,
      `approval state: ${canonicalJson(input.checkpoint.approvalState ?? [])}`,
    ].join("\n");
    const fragment = makeRuntimeFragment({
      id: `runtime:checkpoint:${input.checkpoint.id}`,
      kind: "checkpoint",
      uri: `checkpoint://${input.checkpoint.id}`,
      text: checkpointText,
      sourceVersion: input.checkpoint.canonicalStateHash,
      authority: 78,
      priority: 78,
      trust: "trusted",
      confidentiality: "workspace",
      injectionRisk: "none",
      exactness: "semantics_preserving",
      scope,
      modelKey,
      tokenizer,
      features,
      observedAt: input.checkpoint.createdAt,
      evidenceRefs: [artifactRefFromContentHash(input.checkpoint.artifactHash)],
      invalidation: [{ kind: "ttl", selector: `checkpoint://${input.checkpoint.id}` }],
    });
    results.push({
      fragment,
      method: "exact_user_reference",
      rawScore: 0.9,
      rerankedScore: 0.9,
      sourceVersion: input.checkpoint.canonicalStateHash,
      reason: "durable checkpoint",
    });
  }
  return results;
}

interface RuntimeFragmentInput {
  readonly id: string;
  readonly kind: ContextFragment["kind"];
  readonly uri: string;
  readonly text: string;
  readonly sourceVersion: string | null;
  readonly authority: number;
  readonly priority: number;
  readonly trust: ContextFragment["trust"];
  readonly confidentiality: ContextFragment["confidentiality"];
  readonly injectionRisk: ContextFragment["injectionRisk"];
  readonly exactness: ContextFragment["exactness"];
  readonly scope: ContextScope;
  readonly modelKey: ModelKey;
  readonly tokenizer: ModelTokenizer;
  readonly features: SelectionFeatures;
  readonly observedAt: Rfc3339Timestamp;
  readonly evidenceRefs?: readonly ArtifactRef[] | undefined;
  readonly dependencies?: readonly string[] | undefined;
  readonly invalidation: ContextFragment["invalidation"];
}

function makeRuntimeFragment(input: RuntimeFragmentInput): ContextFragment {
  return {
    id: input.id,
    kind: input.kind,
    contentRef: makeTextArtifactRef(input.text),
    textContent: input.text,
    source: {
      ...makeSource(input.uri, "runtime-state", input.observedAt),
      evidenceRefs: input.evidenceRefs ?? [],
    },
    sourceVersion: input.sourceVersion,
    authority: input.authority,
    priority: input.priority,
    trust: input.trust,
    confidentiality: input.confidentiality,
    injectionRisk: input.injectionRisk,
    exactness: input.exactness,
    scope: input.scope,
    freshness: {
      observedAt: input.observedAt,
      sourceVersion: input.sourceVersion,
      stale: false,
      staleReason: null,
    },
    dependencies: input.dependencies ?? [],
    invalidation: input.invalidation,
    estimatedTokens: {
      [input.modelKey]: input.tokenizer.estimateTextTokens(input.text),
    },
    selectionFeatures: input.features,
  };
}

function makeTextArtifactRef(text: string): ArtifactRef {
  const hash = computeContentHash(text);
  return {
    hash,
    uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ArtifactUri,
    mediaType: "text/plain",
    bytes: BigInt(new TextEncoder().encode(text).byteLength) as ByteCount,
  };
}

function artifactRefFromContentHash(hash: ContentHash): ArtifactRef {
  return {
    hash,
    uri: `artifact://sha256/${hash.replace(/^sha256:/, "")}` as ArtifactUri,
    mediaType: "application/octet-stream",
    bytes: 0n as ByteCount,
  };
}

function worldStateEvidenceRefs(value: unknown): readonly ArtifactRef[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const artifact = (value as { artifact?: unknown }).artifact;
  if (typeof artifact !== "string" || !artifact.startsWith("artifact://sha256/")) return [];
  const hex = artifact.slice("artifact://sha256/".length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return [];
  return [artifactRefFromContentHash(`sha256:${hex.toLowerCase()}` as ContentHash)];
}

function safeWorldStateJson(section: string, value: unknown): string {
  if (section === "secrets" || section === "credentials") {
    return "{\"availability\":\"brokered handles only; secret values omitted\"}";
  }
  try {
    return canonicalJson(value);
  } catch {
    return "{\"error\":\"world state was not serializable\"}";
  }
}

// ────────────────────────── Dedup + freshness ────────────────────────────────

export interface DeduplicationResult {
  readonly accepted: readonly RetrievalResult[];
  readonly omitted: readonly { readonly fragmentId: string; readonly reason: string }[];
}

export function deduplicateAndExplain(
  results: readonly RetrievalResult[],
  currentVersions: Readonly<Record<string, string>>,
): DeduplicationResult {
  const seen = new Set<string>();
  const out: RetrievalResult[] = [];
  const omitted: { fragmentId: string; reason: string }[] = [];
  for (const r of results) {
    if (seen.has(r.fragment.id)) {
      omitted.push({ fragmentId: r.fragment.id, reason: "duplicate candidate" });
      continue;
    }
    seen.add(r.fragment.id);
    // Mark stale if source version mismatches.
    if (r.fragment.sourceVersion !== null) {
      const cur = currentVersions[r.fragment.source.uri];
      if (cur !== undefined && cur !== r.fragment.sourceVersion) {
        omitted.push({
          fragmentId: r.fragment.id,
          reason: `stale source version: expected ${cur}, observed ${r.fragment.sourceVersion}`,
        });
        continue;
      }
    }
    out.push(r);
  }
  return { accepted: out, omitted };
}

export function deduplicateAndValidate(
  results: readonly RetrievalResult[],
  currentVersions: Readonly<Record<string, string>>,
): readonly RetrievalResult[] {
  return deduplicateAndExplain(results, currentVersions).accepted;
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
      .filter((r) => (r.fragment.kind === "code" || r.fragment.kind === "test")
        && fragmentMatchesRequirement(r.fragment, ac.statement))
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
      .filter((r) => (r.fragment.kind === "documentation" || r.fragment.kind === "memory")
        && fragmentMatchesRequirement(r.fragment, u))
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

function fragmentMatchesRequirement(fragment: ContextFragment, requirement: string): boolean {
  const haystack = `${fragment.source.uri} ${fragment.textContent ?? ""}`.toLowerCase();
  const terms = requirement
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length >= 3);
  if (terms.length === 0) return false;
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return matches >= Math.max(1, Math.ceil(terms.length * 0.25));
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

export type ScoringWeightName = keyof ScoringWeights;

const SCORING_WEIGHT_NAMES: readonly ScoringWeightName[] = [
  "relevance",
  "authorityWeight",
  "freshnessWeight",
  "noveltyWeight",
  "requirementCoverage",
  "uncertaintyReduction",
  "riskReduction",
  "modelCompatibility",
  "redundancyPenalty",
  "injectionPenalty",
];

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

export interface ScoringAblation {
  readonly label: string;
  readonly disabledWeights: readonly ScoringWeightName[];
  readonly weights: ScoringWeights;
}

function validateScoringWeights(weights: ScoringWeights): void {
  for (const name of SCORING_WEIGHT_NAMES) {
    const value = weights[name];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`scoring weight ${name} must be a finite non-negative number`);
    }
  }
}

/** Return a deterministic offline policy with selected weights disabled. */
export function ablateScoringWeights(
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  disabledWeights: readonly ScoringWeightName[] = [],
): ScoringWeights {
  validateScoringWeights(weights);
  const disabled = new Set(disabledWeights);
  for (const name of disabled) {
    if (!SCORING_WEIGHT_NAMES.includes(name)) {
      throw new Error(`unknown scoring weight ${name}`);
    }
  }
  return {
    relevance: disabled.has("relevance") ? 0 : weights.relevance,
    authorityWeight: disabled.has("authorityWeight") ? 0 : weights.authorityWeight,
    freshnessWeight: disabled.has("freshnessWeight") ? 0 : weights.freshnessWeight,
    noveltyWeight: disabled.has("noveltyWeight") ? 0 : weights.noveltyWeight,
    requirementCoverage: disabled.has("requirementCoverage") ? 0 : weights.requirementCoverage,
    uncertaintyReduction: disabled.has("uncertaintyReduction") ? 0 : weights.uncertaintyReduction,
    riskReduction: disabled.has("riskReduction") ? 0 : weights.riskReduction,
    modelCompatibility: disabled.has("modelCompatibility") ? 0 : weights.modelCompatibility,
    redundancyPenalty: disabled.has("redundancyPenalty") ? 0 : weights.redundancyPenalty,
    injectionPenalty: disabled.has("injectionPenalty") ? 0 : weights.injectionPenalty,
  };
}

/** One-at-a-time weight ablations for offline comparison only. */
export function standardScoringAblations(
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): readonly ScoringAblation[] {
  return SCORING_WEIGHT_NAMES.map((name) => ({
    label: `without_${name}`,
    disabledWeights: [name],
    weights: ablateScoringWeights(weights, [name]),
  }));
}

export function scoreCandidates(
  candidates: readonly RetrievalResult[],
  input: CompileInput,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): readonly ScoredCandidate[] {
  validateScoringWeights(weights);
  const modelKey = input.model.modelKey;
  return candidates.map((result) => {
    const frag = result.fragment;
    const features = frag.selectionFeatures;
    const tokenCost = Math.max(
      1,
      tokenCostFor(frag, modelKey, input.provider.providerId, input.tokenEstimator),
    );
    // Positive evidence contributes independently. A missing or zero-valued
    // feature must not erase otherwise useful evidence from the candidate.
    const positiveTerms: readonly [number, number][] = [
      [weights.relevance, features.relevance],
      [weights.authorityWeight, frag.authority / 100],
      [weights.freshnessWeight, frag.freshness.stale ? 0.2 : 1],
      [weights.noveltyWeight, features.novelty],
      [weights.requirementCoverage, features.coverage],
      [weights.uncertaintyReduction, features.uncertaintyReduction],
      [weights.riskReduction, features.riskReduction],
      [weights.modelCompatibility, features.modelCompatibility],
    ];
    const positiveWeight = positiveTerms.reduce((sum, [weight]) => sum + weight, 0);
    const positiveScore = positiveWeight === 0
      ? 0
      : positiveTerms.reduce((sum, [weight, value]) => sum + weight * value, 0) / positiveWeight;
    const penalty =
      weights.redundancyPenalty * features.redundancyPenalty +
      weights.injectionPenalty * features.injectionPenalty;
    const utility = (positiveScore - penalty) / tokenCost;
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
  /** True when hard-required fragments alone exceed budget.hardInputLimit.
   * Callers must surface this (fail or truncate upstream); allocation never
   * silently drops hard-required fragments to fit. */
  readonly overHardLimit: boolean;
}

/** Returns the estimated token cost of a fragment for a given model key. */
function tokenCostFor(
  frag: ContextFragment,
  modelKey: ModelKey,
  providerId?: string,
  tokenizer?: ModelTokenizer,
): number {
  const recorded = (frag.estimatedTokens as Readonly<Record<string, number>>)[modelKey as string];
  if (recorded !== undefined && recorded > 0) return recorded;

  const estimator = tokenizer ?? resolveTokenizer(providerId ?? "openai", modelKey);
  return estimator.estimateFragmentTokens(frag).totalTokens;
}

function isToolCallFragment(fragment: ContextFragment): boolean {
  return fragment.id.startsWith("tool_call:") || fragment.id.includes(":tool_call");
}

function isToolResultFragment(fragment: ContextFragment): boolean {
  return fragment.kind === "tool_result"
    || fragment.id.startsWith("tool_result:")
    || fragment.id.includes(":tool_result");
}

export function allocateBudget(
  scored: readonly ScoredCandidate[],
  budget: ContextBudget,
  options: AllocationOptions,
  modelKey: ModelKey,
  providerId?: string,
  tokenizer?: ModelTokenizer,
): AllocationResult {
  const selected: ScoredCandidate[] = [];
  const omitted: { result: RetrievalResult; reason: string }[] = [];
  let remaining = Number(budget.optionalContextTarget);
  const byId = new Map(scored.map((candidate) => [candidate.result.fragment.id, candidate]));
  const selectedIds = new Set<string>();
  // Hard-required first.
  const required = scored.filter((s) => s.hardRequired && options.hardIncludeRequired);
  const optional = scored
    .filter((s) => !s.hardRequired)
    .sort((a, b) => b.utility - a.utility);
  for (const s of required) {
    selected.push(s);
    selectedIds.add(s.result.fragment.id);
    remaining -= tokenCostFor(s.result.fragment, modelKey, providerId, tokenizer);
  }

  const dependencyClosure = (
    candidate: ScoredCandidate,
    visiting: ReadonlySet<string> = new Set(),
  ): { readonly dependencies: readonly ScoredCandidate[]; readonly error: string | null } => {
    const id = candidate.result.fragment.id;
    if (visiting.has(id)) return { dependencies: [], error: `dependency cycle at ${id}` };
    const nextVisiting = new Set(visiting);
    nextVisiting.add(id);
    const dependencies: ScoredCandidate[] = [];
    for (const dependencyId of candidate.result.fragment.dependencies) {
      if (selectedIds.has(dependencyId)) continue;
      const dependency = byId.get(dependencyId);
      if (dependency === undefined) {
        return { dependencies: [], error: `missing dependency ${dependencyId}` };
      }
      const nested = dependencyClosure(dependency, nextVisiting);
      if (nested.error !== null) return nested;
      for (const nestedDependency of nested.dependencies) {
        if (!selectedIds.has(nestedDependency.result.fragment.id)
          && !dependencies.some((item) => item.result.fragment.id === nestedDependency.result.fragment.id)) {
          dependencies.push(nestedDependency);
        }
      }
      if (!selectedIds.has(dependencyId)
        && !dependencies.some((item) => item.result.fragment.id === dependencyId)) {
        dependencies.push(dependency);
      }
    }
    if (options.preserveCompleteEpisodes && isToolCallFragment(candidate.result.fragment)) {
      for (const dependent of scored) {
        if (!isToolResultFragment(dependent.result.fragment)
          || !dependent.result.fragment.dependencies.includes(id)
          || selectedIds.has(dependent.result.fragment.id)
          || dependent.result.fragment.id === id) {
          continue;
        }
        dependencies.push(dependent);
      }
    }
    return { dependencies, error: null };
  };

  for (const s of optional) {
    const closure = options.preserveDependencies
      ? dependencyClosure(s)
      : { dependencies: [], error: null };
    if (closure.error !== null) {
      omitted.push({ result: s.result, reason: `dependency closure not satisfied: ${closure.error}` });
      continue;
    }
    const bundle = [...closure.dependencies, s]
      .filter((candidate, index, all) => all.findIndex((item) => item.result.fragment.id === candidate.result.fragment.id) === index)
      .filter((candidate) => !selectedIds.has(candidate.result.fragment.id));
    const cost = bundle.reduce(
      (sum, candidate) => sum + tokenCostFor(candidate.result.fragment, modelKey, providerId, tokenizer),
      0,
    );
    if (cost <= remaining) {
      for (const candidate of bundle) {
        selected.push(candidate);
        selectedIds.add(candidate.result.fragment.id);
      }
      remaining -= cost;
    } else {
      omitted.push({ result: s.result, reason: "token budget exceeded" });
    }
  }
  const total = selected.reduce(
    (sum, s) => sum + tokenCostFor(s.result.fragment, modelKey, providerId, tokenizer),
    0,
  );
  const hardLimit = Number(budget.hardInputLimit);
  return {
    selected,
    omitted,
    totalEstimatedTokens: total,
    overHardLimit: hardLimit > 0 && total > hardLimit,
  };
}

// ────────────────────────── Cache epoch plan ─────────────────────────────────

export function planCacheEpoch(
  input: CompileInput,
  selected: readonly ScoredCandidate[],
): ContextCachePlan {
  const stable: ScoredCandidate[] = [];
  for (const candidate of selected) {
    if (candidate.result.fragment.exactness !== "exact") break;
    stable.push(candidate);
  }
  const stableHash = computeStablePrefixHash(stable.map((s) => s.result.fragment));
  const volatileBoundary = stable.length;
  const breakpoints = stable.length > 0 ? [stable.length - 1] : [];
  const modelKey = input.model.modelKey;
  const providerId = input.provider.providerId;
  const predicted = stable.reduce(
    (sum, s) => sum + tokenCostFor(s.result.fragment, modelKey, providerId, input.tokenEstimator),
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
  const budgetPolicy = deriveProviderAwareContextBudget({
    budget: input.budget,
    provider: input.provider,
    model: input.model,
    tokenizer: input.tokenEstimator
      ?? resolveTokenizer(input.provider.providerId, input.model.modelKey),
    toolSchemas: input.toolSchemas ?? [],
  });
  // Keep the rest of compilation on one reconciled budget. The original
  // caller budget remains represented by the immutable input at the API
  // boundary; provider overhead is accounted for before allocation.
  input = { ...input, budget: budgetPolicy.budget };
  // 1. Required fragments.
  const required = await collectRequiredFragments(input);
  if (required.instructionConflicts.length > 0) {
    warnings.push(`resolved ${required.instructionConflicts.length} repository instruction conflict(s) by scope`);
  }
  // 2. Retrieval queries.
  const queries = deriveRetrievalQueries(input);
  // 3. Retrieval pipeline.
  const pipeline = resolveRetrievalPipeline(input);
  const retrieved = await pipeline.retrieve(queries, input);
  const runtimeResults = collectRuntimeFragments(input);

  // Track tokenizer choice for manifest recording.
  const tokenizer = input.tokenEstimator
    ?? resolveTokenizer(input.provider.providerId, input.model.modelKey);
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
    ...required.projectRules.map((f) => ({
      fragment: f,
      method: "exact_path_symbol" as const,
      rawScore: 1.0,
      rerankedScore: 1.0,
      sourceVersion: f.sourceVersion,
      reason: "repository_instruction",
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
  // 4. Dedup + freshness. Every omission remains explainable in the
  // manifest; stale candidates are never silently discarded.
  const firstPass = deduplicateAndExplain(
    [...requiredResults, ...runtimeResults, ...retrieved],
    input.worldState.sourceVersions,
  );
  const candidates = firstPass.accepted;
  // 5. Evidence-coverage.
  const coverage = buildEvidenceCoverage(input, candidates);
  let expanded: readonly RetrievalResult[] = [];
  if (coverage.hasCriticalGaps) {
    expanded = await pipeline.expandForGaps(coverage.gaps, input);
    warnings.push(`expanded retrieval for ${coverage.gaps.length} evidence gap(s)`);
  }
  const secondPass = deduplicateAndExplain(
    [...candidates, ...expanded],
    input.worldState.sourceVersions,
  );
  let all = secondPass.accepted;
  const compactionTransforms: CompactionTransform[] = [];
  if (input.compactionPolicy?.enabled === true) {
    const compacted = compactContext({
      fragments: all.map((result) => result.fragment),
      modelKey: input.model.modelKey,
      targetTokens: Math.max(1, input.compactionPolicy.targetTokens),
      observedAt: input.worldState.observedAt,
      tokenizer,
      invariants: [
        {
          id: "task-contract",
          statement: input.task.contract.objective,
          evidenceFragmentIds: required.taskContract.map((fragment) => fragment.id),
        },
      ],
    });
    const byId = new Map(all.map((result) => [result.fragment.id, result]));
    all = compacted.fragments.map((fragment) => {
      const original = byId.get(fragment.id);
      return original ?? {
        fragment,
        method: "semantic" as const,
        rawScore: 0.5,
        rerankedScore: 0.5,
        sourceVersion: fragment.sourceVersion,
        reason: "semantic compaction",
      };
    });
    compactionTransforms.push(...compacted.transforms);
    if (compacted.transforms.length > 0) {
      warnings.push(`semantic compaction applied to ${compacted.transforms.length} fragment group(s)`);
    }
  }
  // 6. Score.
  const scored = scoreCandidates(all, input);
  // 7. Allocate.
  const allocation = allocateBudget(scored, input.budget, {
    preserveDependencies: true,
    preserveCompleteEpisodes: true,
    hardIncludeRequired: true,
  }, input.model.modelKey, input.provider.providerId, tokenizer);
  // 8. Cache plan.
  const cachePlan = planCacheEpoch(input, allocation.selected);
  // Confidentiality filter.
  const confFiltered = filterByConfidentiality(
    input.confidentialityPolicy,
    input.provider.providerId,
    allocation.selected.map((s) => s.result.fragment),
  );
  const selectedFragments = confFiltered.admitted;
  const hardSelectedIds = new Set(
    allocation.selected
      .filter((candidate) => candidate.hardRequired)
      .map((candidate) => candidate.result.fragment.id),
  );
  const admittedIds = new Set(selectedFragments.map((fragment) => fragment.id));
  const confidentialHardOmissions = [...hardSelectedIds].filter((id) => !admittedIds.has(id));
  if (confidentialHardOmissions.length > 0) {
    throw new Error(
      `required context blocked by confidentiality policy: ${confidentialHardOmissions.join(", ")}`,
    );
  }
  if (allocation.overHardLimit) {
    warnings.push(
      `hard input limit exceeded by ${allocation.totalEstimatedTokens - Number(input.budget.hardInputLimit)} tokens`,
    );
  }

  const toolSchemas = input.toolSchemas ?? [];
  const toolSchemaHash = computeContentHash(canonicalJson(toolSchemas));
  const cacheEpochDebug = buildCacheEpochDebugData({
    providerId: input.provider.providerId,
    modelKey: input.model.modelKey,
    epoch: input.epoch,
    cachePlan,
    selectedFragments,
    toolSchemas,
    cacheMode: input.provider.caching.mode,
    exactPrefixRequired: input.provider.caching.exactPrefixRequired,
  }, input.previousCacheEpoch ?? null);
  if (tokenizer.calibration.status === "degraded") {
    warnings.push(`token calibration degraded: ${tokenizer.calibration.reason}`);
  }
  for (const item of cacheEpochDebug.diagnostics) {
    if (item.severity === "warning") warnings.push(`cache diagnostic: ${item.message}`);
  }
  const scoredById = new Map(
    scored.map((candidate) => [candidate.result.fragment.id, candidate]),
  );
  const omissionReasonById = new Map<string, string>();
  const recordOmissionReason = (fragmentId: string, reason: string): void => {
    if (!omissionReasonById.has(fragmentId)) omissionReasonById.set(fragmentId, reason);
  };
  for (const omission of [...firstPass.omitted, ...secondPass.omitted]) {
    recordOmissionReason(omission.fragmentId, omission.reason);
  }
  for (const omission of allocation.omitted) {
    recordOmissionReason(omission.result.fragment.id, omission.reason);
  }
  for (const omission of confFiltered.omitted) {
    recordOmissionReason(omission.fragmentId, omission.reason);
  }
  const retrievalMetricCandidates = all.map((result) => {
    const candidate = scoredById.get(result.fragment.id);
    if (candidate === undefined) {
      throw new Error(`retrieval metric candidate is missing score: ${result.fragment.id}`);
    }
    const selected = admittedIds.has(result.fragment.id);
    return {
      fragmentId: result.fragment.id,
      path: result.fragment.scope.pathPatterns.length === 1
        ? result.fragment.scope.pathPatterns[0]!
        : null,
      symbols: [],
      method: result.method,
      estimatedTokens: tokenCostFor(
        result.fragment,
        input.model.modelKey,
        input.provider.providerId,
        input.tokenEstimator,
      ),
      finalScore: Number.isFinite(candidate.utility) ? candidate.utility : null,
      hardRequired: candidate.hardRequired,
      selected,
      selectionReason: selected
        ? candidate.hardRequired ? "hard-required" : "utility-ranked-within-budget"
        : omissionReasonById.get(result.fragment.id) ?? "not-selected",
    };
  });
  const retrievalMetricById = new Map(
    retrievalMetricCandidates.map((candidate) => [candidate.fragmentId, candidate]),
  );
  const retrievalMetrics = summarizeRetrievalSelection({
    queryCount: queries.length,
    candidates: retrievalMetricCandidates,
    stablePrefixTokens: Number(cachePlan.predictedCachedTokens),
    predictedCachedTokens: Number(cachePlan.predictedCachedTokens),
  });
  const decisionRecord: Readonly<Record<string, unknown>> = {
    retrievalQueries: queries.map((query) => ({
      text: query.text,
      reason: query.reason,
      suggestedMethods: [...query.suggestedMethods],
    })),
    candidates: all.map((result) => ({
      fragmentId: result.fragment.id,
      kind: result.fragment.kind,
      method: result.method,
      rawScore: result.rawScore,
      rerankedScore: result.rerankedScore,
      sourceVersion: result.sourceVersion,
      reason: result.reason,
      estimatedTokens: tokenCostFor(
        result.fragment,
        input.model.modelKey,
        input.provider.providerId,
        input.tokenEstimator,
      ),
      authority: result.fragment.authority,
      trust: result.fragment.trust,
      confidentiality: result.fragment.confidentiality,
      injectionRisk: result.fragment.injectionRisk,
      selectionFeatures: result.fragment.selectionFeatures,
      finalScore: retrievalMetricById.get(result.fragment.id)?.finalScore ?? null,
      hardRequired: scoredById.get(result.fragment.id)?.hardRequired ?? false,
      selected: admittedIds.has(result.fragment.id),
      selectionReason: retrievalMetricById.get(result.fragment.id)?.selectionReason
        ?? "not-selected",
    })),
    retrievalMetrics,
    evidenceCoverage: coverage,
    selected: allocation.selected.map((candidate) => candidate.result.fragment.id),
    allocationOmissions: allocation.omitted.map((omission) => ({
      fragmentId: omission.result.fragment.id,
      reason: omission.reason,
    })),
    freshnessOmissions: [...firstPass.omitted, ...secondPass.omitted],
    instructionConflicts: required.instructionConflicts,
    confidentialityOmissions: confFiltered.omitted,
    transforms: compactionTransforms,
    toolSchemas: toolSchemas.map((schema) => ({
      id: schema.id,
      version: schema.version,
      summary: schema.summary,
      inputSchema: schema.inputSchema,
      resultSchema: schema.resultSchema,
      sideEffectClass: schema.sideEffectClass,
      requiredCapabilities: [...schema.requiredCapabilities],
      trustLevel: schema.trustLevel,
      maximumModelResultBytes: schema.maximumModelResultBytes,
      maximumArtifactBytes: schema.maximumArtifactBytes,
      defaultTimeoutMs: schema.defaultTimeoutMs,
      policyTags: [...schema.policyTags],
    })),
    toolSchemaHash,
    tokenEstimator: tokenizer.calibration,
    contextBudgetPolicy: CONTEXT_BUDGET_POLICY_VERSION,
    contextBudgetBreakdown: budgetPolicy.breakdown,
    cacheEpochDebug,
    memory: {
      enabled: false,
      reason: "durable memory remains disabled until its precision/harm gate passes",
    },
    hardInputLimit: Number(input.budget.hardInputLimit),
    totalEstimatedTokens: allocation.totalEstimatedTokens,
  };

  // 9. Build + persist manifest BEFORE send (SPEC §8.6, §33.13, ADR-0010)
  // Record tokenizer choice in the manifest.
  const tokenizerChoice = `${tokenizer.providerId}:${tokenizer.modelKey}:${tokenizer.calibration.status}`;
  const manifestInput = {
    compilerVersion: `v1 (token-estimator=${tokenizer.contractVersion}; profile=${tokenizerChoice})`,
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
    decisionRecord,
    occurredAt: input.worldState.observedAt,
  };
  const builtManifest = buildManifest(manifestInput);
  const manifest = await input.store.persistManifest(
    builtManifest,
    all.map((result) => result.fragment),
  );

  if (allocation.overHardLimit) {
    // The durable manifest records the exact over-budget decision, but no
    // provider request is allowed to proceed with an unsafe input size.
    throw new Error(
      `context hard input limit exceeded: ${allocation.totalEstimatedTokens} > ${Number(input.budget.hardInputLimit)}`,
    );
  }

  // 10. Render with durable manifest authority.
  const rendered = await input.renderer.render({
    provider: input.provider,
    model: input.model,
    fragments: selectedFragments,
    toolSchemas,
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
    manifestId: manifest.id,
  });
  const renderedRequestArtifact = input.store.recordRenderedRequest === undefined
    ? null
    : await input.store.recordRenderedRequest(manifest.id, rendered);

  return {
    rendered,
    manifest,
    warnings,
    omitted: manifestInput.omitted,
    totalEstimatedTokens: selectedFragments.reduce(
      (sum, fragment) => sum + tokenCostFor(
        fragment,
        input.model.modelKey,
        input.provider.providerId,
        tokenizer,
      ),
      0,
    ),
    overHardLimit: allocation.overHardLimit,
    renderedRequestArtifact,
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
  private readonly tokenEstimate: ((text: string) => number) | null;

  constructor(index: SourceIndex, tokenEstimate?: (text: string) => number) {
    this.index = index;
    this.tokenEstimate = tokenEstimate ?? null;
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
        const frag = this.makeFragment(
          exact,
          exact.content,
          "exact_path_symbol",
          now,
          modelKey,
          q,
          input.tokenEstimator ?? resolveTokenizer(input.provider.providerId, modelKey),
        );
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
        const frag = this.makeFragment(
          doc,
          snippet,
          "lexical_bm25",
          now,
          modelKey,
          q,
          input.tokenEstimator ?? resolveTokenizer(input.provider.providerId, modelKey),
        );
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
    tokenizer: ModelTokenizer,
  ): ContextFragment {
    // The query `q` is referenced here so the rationale string flows into
    // the manifest later via the caller. We embed it in the fragment id so
    // distinct queries against the same path produce distinct fragments
    // (avoids accidental dedup across queries).
    void q;
    const hashHex = computeContentHash(snippet).slice("sha256:".length);
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
      estimatedTokens: {
        [modelKey]: this.tokenEstimate?.(snippet) ?? tokenizer.estimateTextTokens(snippet),
      } as Readonly<Record<string, number>>,
      selectionFeatures: features,
    };
  }
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
  const text = canonicalJson(s);
  return computeContentHash(text);
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
