/**
 * @terminus/memory — durable memory candidate extraction, consolidation
 * curator, BM25 retrieval, revalidation, controls, and M10 exit gate.
 *
 * Per SPEC §16, §39, §48.13 and ADR-0023:
 * disabled by default until the precision/harm gate passes.
 */
export type { MemoryRepository } from "./repository.js";
export { InMemoryMemoryRepository } from "./store.js";

export {
  MemoryService,
  type MemoryServiceDeps,
  type RetrieveRequest,
  type RetrieveResponse,
} from "./service.js";

export {
  filterPrivateData,
  assertStorableStatement,
  containsPrivateData,
  defaultPrivacyFilter,
  type PrivacyDisposition,
  type PrivacyFilter,
  type PrivacyPattern,
} from "./privacy.js";

export {
  ExtractionQueue,
  extractCandidatesToQueue,
  queueItemToClaim,
  type ExtractionQueueItem,
  type ExtractionQueueStatus,
  type ExtractionInput,
  type ExtractorDeps,
} from "./extract.js";

export {
  consolidateMemories,
  createCuratorSandbox,
  type CuratorSandbox,
  type ConsolidationAudit,
  type ConsolidationResult,
  type ConsolidateDeps,
} from "./consolidate.js";

export {
  isContradiction,
  shouldSupersede,
  isExpired,
  isWithinValidityWindow,
  relateClaims,
  authorityRank,
  canOverride,
  type AuthorityRank,
  type RelationDecision,
} from "./contradiction.js";

export {
  bm25Score,
  tokenize,
  DEFAULT_BM25_PARAMS,
  type Bm25Params,
  type Bm25Document,
} from "./bm25.js";

export {
  retrieveMemories,
  scopeMatches,
  retrievedIds,
  type RetrieveOptions,
  type RetrievedMemory,
  type SemanticScorer,
} from "./retrieval.js";

export {
  revalidateClaim,
  revalidateTtl,
  revalidateFileHash,
  revalidateSymbol,
  revalidateAuthority,
  defaultRevalidationHooks,
  type RevalidationContext,
  type RevalidationHook,
  type RevalidationMethod,
  type RevalidationOutcome,
} from "./revalidate.js";

export {
  explainRetrieval,
  explainSource,
  hasCompleteProvenance,
  type MemoryExplanation,
  type MemorySourceExplanation,
  type FreshnessLabel,
  type ExplainInput,
} from "./explain.js";

export {
  recordRetrieval,
  recordSuccessfulUse,
  recordHarmfulUse,
  InMemoryTelemetrySink,
  DEFAULT_HARM_POLICY,
  type MemoryTelemetryEvent,
  type TelemetrySink,
  type HarmPolicy,
  type UsageUpdate,
} from "./telemetry.js";

export {
  isPromotionEligible,
  toPromotionCandidate,
  promoteProcedureToSkill,
  DEFAULT_PROMOTION_POLICY,
  type SkillPromotionCandidate,
  type SkillDraft,
  type PromotionPolicy,
  type PromoteInput,
} from "./promote.js";

export {
  buildClaimFromSeed,
  runPrecisionExperiment,
  runUtilityExperiment,
  runStaleMemoryExperiment,
  runContradictionExperiment,
  runHarmExperiment,
  runProvenanceExperiment,
  runAllExperiments,
  type ExperimentClaimSeed,
  type HeldOutTask,
  type ExperimentCorpus,
  type ExperimentReport,
  type PrecisionResult,
  type UtilityResult,
  type StaleMemoryResult,
  type ContradictionResult,
  type HarmResult,
  type ProvenanceResult,
} from "./experiments.js";

export {
  evaluateExitGate,
  DEFAULT_EXIT_GATE_THRESHOLDS,
  type ExitGateThresholds,
  type ExitGateVerdict,
} from "./exit-gate.js";

export {
  WorkingMemoryService,
  type WorkingMemorySnapshot,
  type WorkingMemoryCriterion,
  type WorkingMemoryDecision,
  type WorkingMemoryFailedApproach,
  type WorkingMemoryFileChange,
  type WorkingMemoryDiagnosticState,
  type WorkingMemoryDiagnostic,
  type WorkingMemoryJobRef,
  type WorkingMemoryBudgetConsumption,
  type WorkingMemoryBlocker,
  type WorkingMemoryRepository,
  type WorkingMemoryServiceDeps,
} from "./working-memory.js";

export type {
  MemoryClaim,
  MemoryClaimKind,
  MemoryClaimStatus,
  MemoryScope,
  MemoryProvenance,
  MemoryVerification,
  MemoryValidity,
  MemoryUsage,
  MemoryRelations,
  Task,
  PrincipalId,
} from "@terminus/domain";
