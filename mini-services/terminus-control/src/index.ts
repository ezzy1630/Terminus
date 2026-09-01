/**
 * Terminus Control Plane mini-service.
 *
 * Per SPEC §5, §27: TypeScript control plane owns cognition and product
 * state — sessions, tasks, context compiler, providers, orchestration,
 * verification, memory, public API. It has NO ambient effect authority;
 * every privileged operation crosses the Rust kernel boundary via the
 * gateway (?XTransformPort=3040).
 *
 * This service exposes:
 *   - The full public API (SPEC §32) over HTTP/SSE on port 3050.
 *   - A realtime event bus streaming semantic events to clients.
 *   - The agent loop: context compile → provider attempt → tool settlement →
 *     verification → completion, all observable via events and manifests.
 *
 * The service uses Prisma (SQLite) for operational state, generated gRPC over
 * UDS for effects, and the @terminus/* packages for domain logic.
 *
 * Security (SPEC §30.5/§30.6/§30.8):
 *   - Every request except `GET /v1/system/health` MUST present a bearer
 *     token matching `TERMINUS_CONTROL_TOKEN`.
 *   - CORS is locked to the configured desktop origin
 *     (`TERMINUS_CONTROL_CORS_ORIGIN`, default `terminus://app`).
 *   - Mutating requests accept an `Idempotency-Key` header; replays with
 *     the same key+body return the cached response, replays with a
 *     different body return `IDEMPOTENCY_KEY_CONFLICT`.
 *   - SSE event IDs are monotonic (timestamp-prefixed) so `cursor` replay
 *     is ordered; stale cursors emit a `cursor_expired` event.
 *   - Before any mutating handler executes, an `authorized` audit record
 *     is logged with method, path, actor, task_id, trace_id, timestamp.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { closeSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import {
  PrismaClient,
  type Approval as PrismaApproval,
  type IdempotencyRecord,
  type Session as PrismaSession,
  type Thread as PrismaThread,
  type Turn as PrismaTurn,
  type Prisma,
} from "@prisma/client";
import { firstValueFrom } from "rxjs";
import {
  DurableScopedDelegationService,
  SqliteDatabaseAdapter,
  SqliteDurableTaskRepository,
  SqliteSessionRecallIndexRepository,
  globMatch,
  type ScopedDelegationKernelPort,
  type SqliteValue,
} from "@terminus/task-runtime";
import { createKernelUdsClients, type KernelUdsClients } from "./kernel-uds.js";
import {
  authorizesWorkspaceDevelopment,
  configuredTokenMayAuthorize,
  WHOLE_WORKSPACE_SCOPE_GLOB,
  WORKSPACE_DEVELOPMENT_POLICY_PROFILE_ID,
} from "./kernel-policy-profiles.js";
import { canResumeSession } from "./session-lifecycle.js";
import { CodexLaneEventBuffer } from "./codex-lane-events.js";
import { createKernelArtifactClient, PrismaContextStore } from "./context-store.js";
import {
  executeLocalProviderCommand,
  parseLocalProviderCommand,
  type LocalProviderCommand,
} from "./provider-command.js";
import {
  configuredLocalProviderSnapshot,
  parseProviderConfigurationInput,
  parseProviderConfigurationUpdate,
  providerConfigurationCommand,
  providerConfigurationWire,
  PROVIDER_CONFIGURATION_ID,
  type ProviderConfigurationUpdate,
} from "./provider-config.js";
import {
  configuredGatewayModel,
  configuredGatewayProviderSnapshot,
  gatewayCredentialBindingId,
  currentGatewayPrivacyTermsVersion,
  gatewayModelKey,
  gatewayProviderConfigurationWire,
  gatewayProviderConfigurationDeleteSchema,
  gatewaySecretUri,
  GATEWAY_PROVIDER_CONFIGURATION_ID,
  parseGatewayProviderConfigurationUpdate,
  type GatewayProviderConfigurationUpdate,
} from "./gateway-provider-config.js";
import {
  configuredDirectProviderSnapshot,
  directModelKey,
  directProviderId,
  parseDirectProviderConfiguration,
  DIRECT_PROVIDER_CONFIGURATION_ENV,
} from "./direct-provider-config.js";
import {
  createDirectRenderer,
  createStreamTelemetry,
  directEndpoint,
  directNetworkDestinations,
  executeDirectProviderRequest,
  KernelDirectConnectorClient,
  timeToFirstBodyMs,
} from "./direct-provider-transport.js";
import {
  cachedProviderModels,
  describeConfiguredModel,
  discoverProviderModels,
  fetchModelsDevRaw,
  lastProviderModels,
  modelsDevCatalogDigest,
  parseProviderModelsResult,
  providerModelsResultJson,
  providerModelsWire,
  rememberProviderModels,
  restoreProviderModels,
  type ProviderModelsResult,
} from "./provider-models.js";
import {
  CODEX_HOST,
  CODEX_PATH_PREFIX,
  ZEN_SOURCE,
  ZEN_VENDOR_ID,
  chooseDefaultAccount,
  canonicalMetadataForAccount,
  connectLocalProviderAccount,
  discoverAndConnectLocalAccounts,
  mapGatewayConfiguration,
  parseProviderAccountMetadata,
  providerAccountCapabilityScope,
  providerAccountHasApprovedBinding,
  providerAccountProviderId,
  providerAccountSecuritySnapshot,
  providerAccountSecretUri,
  recoverLegacyProviderAccountCredential,
  settleProviderAccountSecretCleanup,
  providerAccountWorkspaceAccess,
  providerAccountWire,
  resolveTurnProvider,
  uuidV7,
  zenAccountCredentialUri,
  type LocalCredentialDiscovery,
  type ProviderAccountRecord,
  type ProviderAccountSecuritySnapshot,
  type ProviderAccountUpsert,
  type ProviderRenderProfile,
  type TurnProviderResolution,
} from "./provider-accounts.js";
import {
  discoverAccountModels,
  parseProviderAccountModels,
  providerAccountCapabilitySnapshot,
  providerAccountModelsJson,
  providerAccountModelsWire,
  toGatewayModel,
  type ProviderAccountModel,
  type ProviderAccountModelsResult,
} from "./provider-account-models.js";
import {
  KernelConnectorClient,
  KernelGatewayClient,
  ZEN_GATEWAY_ENDPOINT,
  type KernelConnectorEndpoint,
} from "./gateway-kernel-client.js";
import {
  MAX_TOOL_MODEL_RESULT_BYTES,
  STANDALONE_TOOL_CAPABILITY_CARDS,
  STANDALONE_TOOL_SCHEMAS,
  selectInitialStandaloneToolSchemas,
  selectStandaloneToolSchemas,
  ObservedSourceTracker,
  duplicateOperationDenial,
  durationFromMilliseconds,
  effectLedgerIdempotencyKey,
  executeStandaloneTool,
  normalizedToolOperationHash,
  InvalidToolCallError,
  parseStandaloneToolCall,
  relativizeStandaloneCallPaths,
  projectModelVisibleResult,
  providerToolCallTranscript,
  providerToolResultTranscript,
  resolveMaxToolCycles,
  capabilityActionRequiresActivatedWorkspace,
  standaloneToolCallIsDeclared,
  mayChangeWorkspace,
  resolveShellModeEnabled,
  replayIsBlockedBy,
  semanticIdempotencyGateApplies,
  toolEffectMetadata,
  ToolAbortedError,
  type ToolDenialMetadata,
  TOOL_DENIAL_SCHEMA_VERSION,
  typedKernelPolicyDenial,
  type ExecutedToolResult,
  type ParsedStandaloneToolCall,
  type ProviderCallIdentity,
  type StandaloneToolEffectMetadata,
} from "./agent-tools.js";
import {
  DEFAULT_PERMISSION_PROFILE,
  PERMISSION_PROFILES,
  approvalActionFor,
  approvalReasonFor,
  approvalRequiredFor,
  isPermissionProfile,
  normalizePermissionProfile,
  type PermissionProfile,
} from "./permission-profiles.js";
import { errorResult, okResult, type ToolResult } from "@terminus/aci";
import {
  CapabilityOperationProto,
  OpencodeStoreStatusProto,
  PatchCommitMode,
  SecretPresenceProto,
  type RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import {
  createVerificationRuntime,
  createKernelPredicateRunner,
  defaultCriteriaNodes,
  summarizeRequiredVerification,
  persistPlanToPrisma,
  persistResultsToPrisma,
  persistClaimEvidenceGraphToPrisma,
  verificationPlanFromPrisma,
  verificationResultFromPrisma,
  createPrismaCompletionAdmission,
  resolveKernelEnvironmentDigest,
  resolveWorkspaceRevision,
  createKernelGitMergeReceiptQuery,
  reconcileAdmittingBranchWithTrustedReceipt,
  TrustedBranchAlreadyResolvedError,
  type TrustedBranchReceiptDisposition,
} from "./verification-runtime.js";
import {
  generateUuid7,
  type Uuid7,
  type TaskContract,
  type AcceptanceCriterion,
  type Checkpoint,
  type ContentHash,
  type Episode,
  type Micros,
  type ModelKey,
  type Rfc3339Timestamp,
  type Task as DomainTask,
  type TokenCount,
  type VerificationPlan,
} from "@terminus/domain";
import { projectStoredEvents, rolloutToJsonl } from "@terminus/rollout";
import { scheduleSchema, computeNextRunAt, advanceJob, type CronJob } from "@terminus/cron";
import {
  authorizationInstanceSchema,
  artifactUriSchema,
  artifactRefSchema,
  contentHashSchema,
  claimSchema,
  decisionSchema,
  effectRecordSchema,
  evidenceSchema,
  questionSchema,
  riskSchema,
  workerLeaseSchema,
  taskAttemptSchema,
  taskPhaseSchema,
  taskStatusSchema,
  budgetConsumptionSchema,
  taskContractV2Schema,
  taskV2Schema,
  workflowSchema,
  workflowNodeSchema,
  guardedEdgeSchema,
  nodeRunSchema,
  isEffectTransitionAllowed,
  isTaskV2Terminal,
  isTaskV2TransitionAllowed,
  isWorkflowTransitionAllowed,
  isNodeRunTransitionAllowed,
  isAttemptTransitionAllowed,
  isLeaseTransitionAllowed,
  missionSchema,
  nowTimestamp,
  ForgeError as DomainForgeError,
  SandboxUnavailableError,
  organizationSchema,
  departmentSchema,
  operatorAgentSchema,
  agentRoomSchema,
  capabilityDirectoryEntrySchema,
  materialQuestionSchema,
  attentionAssessmentSchema,
  structuredInterventionSchema,
  causalStepSchema,
  causalReplayTraceSchema,
  counterfactualExperimentSchema,
  mobileSupervisionSessionSchema,
  acpContextInjectionSchema,
  uiObservationInputSchema,
  uiObservationSchema,
  computerUseActionSchema,
  semanticTargetVerificationSchema,
  uiEvidenceRecordSchema,
  browserDesktopPoolSchema,
  poolLeaseSchema,
  humanTakeoverSessionSchema,
  dataFlowPolicySchema,
  dataTransferAuditSchema,
  dataFlowCheckResultSchema,
  externalConnectorSpecSchema,
  connectorCallIntentSchema,
  connectorExecutionObservationSchema,
  connectorCallResultSchema,
  ambiguousSubmitReconciliationSchema,
  incidentProfileSpecSchema,
  incidentExecutionRecordSchema,
  researchProfileSpecSchema,
  researchProvenanceRecordSchema,
  type Claim,
  type Decision,
  type EffectRecord,
  type AuthorizationInstance,
  type Evidence,
  type Question,
  type Risk,
  type WorkerLease,
  type TaskAttempt,
  type BudgetConsumption,
  type Workflow,
  type WorkflowNode,
  type GuardedEdge,
  type NodeRun,
  type TaskContractV2,
  type TaskV2,
} from "@terminus/domain";
import { ARP_V2_COMMAND_TYPES, ARP_V2_EVENT_TYPES } from "@terminus/runtime-protocol";
import { z } from "zod";
import {
  checkpointContentSchema,
  compileContext,
  DEFAULT_INSTRUCTION_FILENAMES,
  DEFAULT_MAX_INSTRUCTION_BYTES,
  discoverInstructions,
  instructionCandidateDirectories,
  instructionsToFragments,
  validateCheckpoint,
  type CheckpointContent,
  type RetrievalMethod,
  type RetrievalPipeline,
  type RetrievalQuery,
  type RetrievalResult,
  type CacheEpochDebugSnapshot,
  type ContextBudget,
  type DiscoveredInstruction,
  type TaskSnapshot,
  type ThreadSnapshot,
  type WorldStateSnapshot,
} from "@terminus/context-compiler";
import {
  MESSAGE_ENVELOPE_TOKENS,
  deriveProviderAwareContextBudget,
  observeAttemptUsage,
  resolveTokenizer,
} from "@terminus/context-compiler";
import {
  canonicalJson,
  computeContentHash,
  type ContextDirective,
  type ContextEpochSnapshot,
  type ContextFragment,
} from "@terminus/context-ir";
import {
  LOCAL_MODEL_PROFILES,
  LocalRenderer,
} from "@terminus/provider-local";
import {
  GatewayRenderer,
  GatewayTransport,
  gatewayEndpoint,
  type GatewayDeployment,
  type GatewayModel,
} from "@terminus/provider-zen";
import { ANTHROPIC_MODEL_PROFILES } from "@terminus/provider-anthropic";
import { GOOGLE_MODEL_PROFILES } from "@terminus/provider-google";
import {
  ChatGptCodexRenderer,
  CodexTurnState,
  OPENAI_MODEL_PROFILES,
  chatGptCodexRequestHeaders,
  type ChatGptCodexModelProfile,
} from "@terminus/provider-openai";
import {
  CODEX_EXTERNAL_HARNESS,
  CodexAppServerError,
  CodexAppServerSession,
  type CodexAppServerLease,
  type CodexAppServerSessionOptions,
  type CodexAppServerStartThreadInput,
  type CodexAppServerStatus,
  type CodexAppServerTurnInput,
} from "./codex-app-server.js";
import { ContextStateBuilder } from "./agent/context-state-builder.js";
import {
  CapabilityDiscoverySession,
  capabilityTransitionEvent,
  recoverCommittedActiveCapabilityIds,
  type CapabilityTransitionEvent,
} from "./agent/capability-discovery.js";
import {
  buildWorkingMemoryContextSection,
  renderCheckpointSummary,
  type WorkingMemoryContextSection,
} from "./agent/working-memory-context.js";
import type {
  WorkingMemoryBlocker,
  WorkingMemoryCriterion,
  WorkingMemoryDecision,
  WorkingMemoryDiagnostic,
  WorkingMemoryFailedApproach,
  WorkingMemoryFileChange,
  WorkingMemoryJobRef,
} from "@terminus/memory";
import {
  CodingTurnEngine,
  TRUNCATION_CONTINUATION_LIMIT,
  type CompletionClaim,
  type EngineStop,
  type EngineToolSettlement,
} from "./agent/coding-turn-engine.js";
import {
  buildEvidenceIdentity,
  createTerminusExecutionProfile,
  hasCommittedWorkspaceActivation,
  resolveTerminusProfileMode,
  workspaceActivationMode,
  TERMINUS_MINIMAL_TOOL_IDS,
  type EvidenceTerminalOutcome,
  type TerminusExecutionProfile,
} from "./agent/minimal-profile.js";
import {
  turnEvidenceBundleWire,
  turnEvidenceVerificationResultIds,
} from "./agent/evidence-bundle-wire.js";
import {
  classifyLoopError,
  type LoopErrorEnvelope,
  type OperationObservation,
} from "./agent/loop-contracts.js";
import { CacheRatioMonitor } from "./agent/cache-telemetry.js";
import {
  runSessionRecall,
  sessionRecallTextCache,
  SESSION_RECALL_SOURCE_MAX_CHARS,
  SESSION_RECALL_SOURCE_MAX_BYTES,
  type SessionRecallResult,
  type SessionRecallStore,
  type SessionRecallTurn,
} from "./agent/session-recall.js";
import {
  runCompactionRecallTool,
  type CompactionRecallToolResult,
} from "./agent/compaction-recall-tool.js";
import { createExactCompactionRecallStore } from "./agent/compaction-recall-store.js";
import {
  SessionRecallFtsIndex,
  type SessionRecallIndexDocument,
} from "./agent/session-recall-index.js";
import { ProviderTransportError, withProviderRetry } from "./providers/provider-retry.js";
import { boundedStreamOutputReserve } from "./providers/provider-response-budget.js";
import { createNativeDirectExecutor } from "./providers/native-direct-executor.js";
import {
  DIRECT_EXEC_DEFAULT_TIMEOUT_MS,
  DIRECT_JOB_DEFAULT_TIMEOUT_MS,
  resolveCommandTimeoutMs,
  withTurnDeadline,
} from "./kernel-deadlines.js";
import {
  createProviderDeltaCoalescer,
  withMeasuredUsage,
  type TextDeltaCoalescer,
} from "./agent/provider-stream-coalescer.js";
import {
  runCompaction,
  SUMMARY_SYSTEM_INSTRUCTIONS,
  type CompactionStore,
  type CompactionReport,
  type CompactionTaskAnchor,
  type Summarizer,
} from "./agent/compaction-service.js";
import {
  METADATA_PREFLIGHT_BYTES_PER_TOKEN,
  resolveAdaptiveCompactionMode,
  TurnCompactionFailureGuard,
  conservativeCompactionTextTokens,
  deriveCompactionPolicy,
} from "./agent/compaction-policy.js";
import {
  initialResponseAuthorityDocuments,
  standaloneAuthorityDocuments,
} from "./agent/system-prompt.js";
import type { ProcessEvent as ProcessEventProto } from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";

/**
 * Host path of a workspace, memoised: it is read on every tool dispatch to put
 * the repository's own tool directories on the sandbox PATH, and a workspace's
 * root never changes once registered.
 */
const workspaceCanonicalRoots = new Map<string, string | null>();
async function workspaceCanonicalRoot(workspaceId: string): Promise<string | null> {
  const cached = workspaceCanonicalRoots.get(workspaceId);
  if (cached !== undefined) return cached;
  const row = await db.workspace.findUnique({ where: { id: workspaceId }, select: { canonicalRoot: true } });
  const root = row?.canonicalRoot ?? null;
  workspaceCanonicalRoots.set(workspaceId, root);
  return root;
}

async function kernelTaskContextForWorkspace(
  workspaceId: string,
  purpose: string,
): Promise<RequestContext> {
  const sessionRow = await db.session.findFirst({
    where: { workspaceId },
    select: { id: true },
  });
  if (sessionRow === null) throw new Error(`no session for workspace ${workspaceId}`);
  // Kernel capability binders must be concrete: a workspace-level operation
  // runs under the workspace's most recent task. `"*"` was rejected by
  // `kernelTaskContext` on every call, so this path never worked.
  const taskRow = await db.task.findFirst({
    where: { sessionId: sessionRow.id },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (taskRow === null) throw new Error(`no task for workspace ${workspaceId}`);
  // Bounded by that task's contract: an exec token minted with no workspace
  // paths carried the no-workspace-effect sentinel and `git rev-parse` was
  // refused with "capability token scope exceeded".
  return kernelContextForTask(taskRow.id, purpose, [CapabilityOperationProto.CAPABILITY_OPERATION_EXEC]);
}

/** Concatenate byte chunks for bounded process output collection. */
function concatUint8(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
import {
  ScoutUtilityLedger,
  runScoutLoop,
  type ScoutParsedResult,
} from "./agent/scout-runner.js";
import {
  ZERO_DELEGATION_USAGE,
  type DelegationAuthority,
  type DelegationStepAccountant,
  type DelegationUsage,
} from "./agent/delegation-runner.js";
import {
  ASSISTANT_EXCERPT_MAX_CHARS,
  USER_EXCERPT_MAX_CHARS,
  buildRecentHistorySection,
  excerpt,
  recentHistoryExcerptLimits,
  shouldInjectRecentHistory,
  type RecentHistoryLimits,
  type RecentHistorySection,
} from "./agent/turn-continuity.js";
import {
  STEERABLE_TASK_STATUSES,
  restartedTaskDisposition,
  restartedTurnSettlement,
  turnFailureDisposition,
} from "./agent/turn-failure-policy.js";
import {
  hydrateSearchHit,
  buildRepositoryMapFragment,
  type SearchHit,
  type WorkspaceFileReader,
} from "./agent/retrieval-hydrator.js";
import {
  VerificationRepairController,
  buildRepairContext,
  normalizeFailure,
  type RawVerificationFailure,
} from "./agent/verification-repair-controller.js";
import {
  REPOSITORY_SIGNAL_PATHS,
  discoverNativeTestRecipes,
  discoverVerificationRunners,
  selectTaskScopedRepositoryMap,
  type RepositoryFileObservation,
  type VerificationRunnerCatalog,
} from "./agent/repository-signals.js";
import {
  readCompleteRepositoryMap,
  type RepositoryMapObservation,
} from "./agent/repository-map.js";
import {
  HARD_MAX_STEPS,
  TurnBudget,
  type BudgetLedgerSnapshot,
  type OperationProgressAnalysis,
} from "./agent/turn-budget.js";
import {
  mergeTurnBudget,
  parsePersistedTurnBudget,
  parseTurnRequestBudget,
  serializeTurnRequestBudget,
  TurnBudgetInvalidError,
  TURN_REQUEST_FIELDS,
  turnRequestBudgetWire,
  unknownTurnRequestFields,
  type TurnRequestBudget,
} from "./agent/turn-request-budget.js";
import {
  remainingRepairBudget,
  repairPinMismatches,
  type RepairContinuationPins,
} from "./agent/repair-continuation.js";
import {
  decideIntentOnlyRecovery,
  INTENT_ONLY_CONTINUATION_LIMIT,
} from "./agent/intent-only-recovery.js";
import { prepareTurnForProviderContinuation } from "./agent/turn-continuation-state.js";
import {
  ACTIVE_TURN_STATES,
  interpretRecoveryMarkerWrite,
  planRecoveryAfterSettlementFault,
  settlementFaultIsTerminalProcessFault,
} from "./agent/turn-lifecycle/settlement-convergence.js";
import {
  sumAttemptCostMicros,
  sumUsageWire,
  turnStopReason,
  usageWire,
} from "./turn-usage.js";
import type { ArtifactClient } from "@terminus/artifact-client";
import type {
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ProviderResponse,
  ProviderResponseChunk,
  ProviderToolCallChunk,
  ProviderToolSchema,
  ProjectedResponse,
  RenderedProviderRequest,
  ConfidentialityPolicy,
  ReasoningEffort,
} from "@terminus/provider-core";
import {
  computeCost,
  parseReasoningEffort,
  parseReasoningReplay,
  ReasoningReplayLedger,
  type ReasoningReplayEntry,
  resolveMaxOutputTokens,
  resolveReasoningReserveTokens,
  serializeReasoningReplay,
  REASONING_EFFORTS,
} from "@terminus/provider-core";
import { deriveRepairMetrics, type RepositoryMapVerificationSignal } from "@terminus/verification";
import {
  compileSkill,
  compileWorkflowJson,
  compileWorkflowDraft,
  validateWorkflow,
} from "@terminus/workflow-compiler";
import {
  ProfileRegistry,
  PosteriorTracker,
  StageRouter,
  ProviderContinuationManager,
} from "@terminus/model-router";
import {
  ExpectedValueScheduler,
  CleanContextReviewer,
  StagnationSupervisor,
  CandidateWorkspaceManager,
  OrganizationDirectory,
  AttentionCoordinator,
  InterventionManager,
  CausalReplayEngine,
  BrowserDesktopPoolManager,
  ExternalConnectorLibrary,
  IncidentProfileRunner,
  ResearchProfileRunner,
  GovernedComputerUseCoordinator,
  type KernelReceiptVerifier,
  type ObservationReceiptVerifier,
  type PoolLeaseBackend,
} from "@terminus/orchestration";
import {
  ApprovalOperationV1,
  canonicalApprovalBinding,
  TrustedReceiptReferenceWire,
  V2_ENDPOINTS,
  type ApprovalBindingV1,
  type ApprovalDisplay,
  type ApprovalOperationV1 as ApprovalOperationRecord,
} from "@terminus/public-api";
import {
  EffectSettlementService,
  EventSubscriptionService,
  type EventCursorExpired,
  type EventSubscriptionHandle,
  ProviderSessionService,
  parseAllowedScope as parseProjectionAllowedScope,
  scopeExpansionResources as projectionScopeExpansionResources,
  TaskProjectionService,
  v2PathScopeProjection as projectionV2PathScopeProjection,
  ToolEpisodeService,
  TurnCoordinator,
  TurnAdmissionError,
  VerificationCoordinator,
  classifyTerminalTurn,
  planEnterContextCompiling,
  planEnterFinalizing,
  planEnterRepairPending,
  planEnterToolSettlement,
  planEnterVerifying,
  planFailVerification,
  planComplete,
  planReenterContextCompiling,
  planTerminalTurnSettlement,
  taskRowDataForTerminalStop,
  TurnCommandExecutor,
  type TurnTransitionPlan,
  ProviderExecutionUnavailableError,
  ToolCycleBudgetExhaustedError,
  ToolPolicyDeniedError,
  EffectSettlementAlreadyResolvedError,
  type EffectAuthorizationInput,
  type EffectSettlementInput,
  type EffectUnknownInput,
  type ProviderAttemptResponseInput,
  type ProviderAttemptStartInput,
  type ProviderExecutionInput,
  type ProviderGatewayConfig,
  IN_FLIGHT_PROVIDER_STATES,
  ProviderAttemptAlreadyResolvedError,
  type TaskProjectionContractRow,
  type TaskProjectionTaskRow,
  type TurnRow,
  type TurnTaskSnapshot,
  type VerificationTransitionInput,
  type RepairAttemptPersistenceInput,
} from "./services/index.js";
import {
  deriveProviderAttemptIdentity,
  providerAttemptIdempotencyKey,
} from "./services/provider-attempt-identity.js";
import {
  REPAIR_ATTEMPT_ACTIVE_STATES,
  decideRepairAttemptClaim,
  isRepairAttemptActive,
  isRepairAttemptTerminal,
  repairAttemptLeaseKey,
  repairAttemptStateForTurn,
  shouldDeferRepairParentRecovery,
} from "./services/repair-attempt-store.js";

declare const __TERMINUS_CONTROL_BUILD_VERSION__: string;
declare const __TERMINUS_CONTROL_BUILD_COMMIT__: string;

// ────────────────────────── Configuration ──────────────────────────────────

const PORT = (() => {
  const configured = process.env.TERMINUS_CONTROL_PORT ?? "3050";
  if (!/^\d{1,5}$/.test(configured)) {
    throw new Error("TERMINUS_CONTROL_PORT must be an integer between 0 and 65535");
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("TERMINUS_CONTROL_PORT must be an integer between 0 and 65535");
  }
  return parsed;
})();
const CONTROL_READY_FD = (() => {
  const configured = process.env.TERMINUS_CONTROL_READY_FD;
  if (configured === undefined) return null;
  if (!/^(?:[3-9]|[1-9]\d)$/.test(configured)) {
    throw new Error("TERMINUS_CONTROL_READY_FD must be a descriptor between 3 and 99");
  }
  return Number(configured);
})();
const KERNEL_GRPC_SOCKET = process.env.TERMINUS_KERNEL_GRPC_SOCKET ?? "";
const KERNEL_CONTROL_BOOTSTRAP_TOKEN = process.env.TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN ?? "";
const CONTROL_BUILD_VERSION = typeof __TERMINUS_CONTROL_BUILD_VERSION__ === "string"
  ? __TERMINUS_CONTROL_BUILD_VERSION__
  : "0.1.0";
const CONTROL_BUILD_COMMIT = typeof __TERMINUS_CONTROL_BUILD_COMMIT__ === "string"
  ? __TERMINUS_CONTROL_BUILD_COMMIT__
  : "dev";
const CONTROL_INSTANCE_NONCE = process.env.TERMINUS_CONTROL_INSTANCE_NONCE ?? randomUUID();
if (!/^[A-Za-z0-9_-]{32,128}$/.test(CONTROL_INSTANCE_NONCE)) {
  throw new Error("TERMINUS_CONTROL_INSTANCE_NONCE must contain 32..128 base64url characters");
}

/**
 * H5: the HTTP listener binds before startup recovery runs, so a desktop
 * client can attach immediately instead of watching a dead socket. Readiness
 * is what gates "state is reconciled", and a recovery failure degrades
 * readiness instead of killing the process at module scope.
 */
const startupRecovery: {
  status: "pending" | "running" | "complete" | "failed";
  error: string | null;
  completedAt: string | null;
} = { status: "pending", error: null, completedAt: null };
const DESKTOP_PARENT_PID = (() => {
  const configured = process.env.TERMINUS_DESKTOP_PARENT_PID;
  if (configured === undefined) return null;
  if (!/^[1-9]\d*$/.test(configured)) {
    throw new Error("TERMINUS_DESKTOP_PARENT_PID must be a positive process ID");
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 1) {
    throw new Error("TERMINUS_DESKTOP_PARENT_PID must be a positive process ID greater than one");
  }
  return parsed;
})();
// SPEC §13.6 / §31.6: secrets are short-lived brokered capabilities, never
// environment-wide shared defaults. The control plane MUST fail closed if no
// token is configured. A well-known dev token is permitted ONLY when
// TERMINUS_DEV=1 is set, so a misconfigured production deployment cannot expose
// the privileged kernel with a publicly-known token.
// R10: process-scoped scout utility ledger — scouts disable themselves for
// the session after repeated zero-yield runs.
const SCOUT_LEDGER = new ScoutUtilityLedger();
/**
 * How much of a turn's final response and reasoning travels in the
 * `turn.completed` event.
 *
 * This was 200 code points, chosen when the event was a status ping rather
 * than the way a client learns what the agent said. It is not: there is no
 * provider-delta streaming, so `turn.completed` carries the *whole* visible
 * answer, and 200 characters truncated every real response mid-sentence. The
 * full text stays in the response artifact and `continuation` still points at
 * it for anything longer; these limits only bound what a client can render
 * without a second fetch, and both sit well under the 128 KiB presentation
 * budget in @terminus/public-client.
 */
const TURN_RESPONSE_SUMMARY_MAX_CHARS = 16_384;
/** Bound for the human-readable operand carried on `tool.proposed`. */
const TOOL_ARGUMENTS_EXCERPT_MAX_CHARS = 240;
const TURN_REASONING_SUMMARY_MAX_CHARS = 8_192;

const DEV_MODE = process.env.TERMINUS_DEV === "1";
const SHELL_MODE_ENABLED = resolveShellModeEnabled(process.env.TERMINUS_SHELL_MODE);
function requireToken(envVar: string, devValue: string, label: string): string {
  const v = process.env[envVar];
  if (v && v.length > 0) return v;
  if (DEV_MODE) {
    console.warn(`[terminus-control] TERMINUS_DEV=1: using well-known dev ${label}. NOT for production.`);
    return devValue;
  }
  const msg = `[terminus-control] ${envVar} is required (set it, or set TERMINUS_DEV=1 for local dev).`;
  console.error(msg);
  throw new Error(msg);
}
const CONTROL_TOKEN = requireToken("TERMINUS_CONTROL_TOKEN", "terminus-control-dev-token", "control token");
const CONFIGURED_KERNEL_CAP_TOKEN = process.env.TERMINUS_KERNEL_CAP_TOKEN ?? "";
const CONFIGURED_KERNEL_MAINTENANCE_CAP_TOKEN = process.env.TERMINUS_KERNEL_MAINTENANCE_CAP_TOKEN
  ?? (DEV_MODE ? CONFIGURED_KERNEL_CAP_TOKEN : "");
// The packaged desktop shell uses a standard, secure custom origin. During
// local renderer development Vite serves from localhost:5173, so documented
// TERMINUS_DEV mode allows that exact origin instead.
const CONTROL_CORS_ORIGIN = process.env.TERMINUS_CONTROL_CORS_ORIGIN
  ?? (process.env.TERMINUS_DEV === "1" ? "http://localhost:5173" : "terminus://app");
// Platform-appropriate default SQLite location (replaces the leftover
// `/home/z/my-project/...` template path so the control plane starts
// out-of-the-box on any host).
const DEFAULT_DB_PATH = `file:${process.env.HOME ?? process.cwd()}/.local/share/terminus/terminus.db`;
// The documented DATABASE_URL sample uses `file:~/...`. The bun:sqlite
// migration runners expand `~` themselves, but Prisma treats it literally,
// which would fork the database into a literal "./~/..." directory. Expand a
// leading `~` (bare or after the URL scheme) so every consumer resolves the
// same file.
function expandTildeDbUrl(url: string): string {
  if (url === "~" || url.startsWith("~/")) {
    return `${process.env.HOME ?? process.cwd()}${url.slice(1)}`;
  }
  const schemeMatch = /^[a-z][a-z0-9+.-]*:(?:\/\/)?/.exec(url);
  const rest = schemeMatch === null ? url : url.slice(schemeMatch[0].length);
  if (rest !== "~" && !rest.startsWith("~/")) return url;
  if (schemeMatch !== null && schemeMatch[0].includes("//")) return url;
  const prefix = schemeMatch === null ? "" : schemeMatch[0];
  return `${prefix}${process.env.HOME ?? process.cwd()}${rest.slice(1)}`;
}
const DATABASE_URL = expandTildeDbUrl(process.env.DATABASE_URL ?? DEFAULT_DB_PATH);

function sqliteDatabasePath(url: string): string {
  if (!url.startsWith("file:")) {
    throw new Error("terminus-control scoped delegation storage requires a file: DATABASE_URL");
  }
  const path = url.slice("file:".length).split("?", 1)[0] ?? "";
  if (path.length === 0) {
    throw new Error("terminus-control scoped delegation storage requires a local SQLite file path");
  }
  // `file:///absolute/path` is the URI form of the same local path accepted
  // by Prisma as `file:/absolute/path`. Reject `file://host/path` instead of
  // allowing a remote authority to be interpreted as a local filename.
  if (path.startsWith("///")) return path.slice(2);
  if (path.startsWith("//")) {
    throw new Error("terminus-control scoped delegation storage requires a local SQLite file path");
  }
  return path;
}

const SERVER_PRINCIPAL = "terminus-control-bearer";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 1_048_576;

const CORS_ALLOW_HEADERS =
  "authorization, content-type, idempotency-key, x-trace-id, traceparent, last-event-id, x-capability-token";
const CORS_ALLOW_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";

const SUPPORTED_CAPABILITIES = [
  "sse_resume",
  "rich_approvals",
  "artifact_streaming",
  "idempotency",
  "tools_direct",
] as const;

const db = new PrismaClient({
  datasources: { db: { url: DATABASE_URL } },
});

const scopedDelegationDatabase = new Database(sqliteDatabasePath(DATABASE_URL));
const controlSqliteDatabase = new SqliteDatabaseAdapter({
  exec: (sql) => scopedDelegationDatabase.exec(sql),
  query: (sql) => {
    const statement = scopedDelegationDatabase.query(sql);
    return {
      get: (...parameters: SqliteValue[]) => statement.get(...parameters),
      all: (...parameters: SqliteValue[]) => statement.all(...parameters),
      run: (...parameters: SqliteValue[]) => ({ changes: statement.run(...parameters).changes }),
    };
  },
  transaction: (operation) => {
    scopedDelegationDatabase.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      scopedDelegationDatabase.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      scopedDelegationDatabase.exec("ROLLBACK");
      throw error;
    }
  },
});
const sessionRecallIndex = new SessionRecallFtsIndex(
  new SqliteSessionRecallIndexRepository(controlSqliteDatabase),
);
const scopedDelegationRepository = new SqliteDurableTaskRepository(controlSqliteDatabase);

/**
 * A real kernel delegation adapter must provide identity-bound receipts. The
 * current kernel UDS surface has no delegation dispatch RPC, so composition
 * stays explicit and fail-closed instead of treating a process-local worker
 * or a generic extension call as trusted execution.
 */
const unavailableScopedDelegationKernel: ScopedDelegationKernelPort = {
  start: async () => {
    throw new SandboxUnavailableError(
      "No trusted scoped-delegation kernel dispatcher is configured",
    );
  },
  recover: async () => {
    throw new SandboxUnavailableError(
      "No trusted scoped-delegation recovery dispatcher is configured",
    );
  },
};
const scopedDelegationService = new DurableScopedDelegationService({
  repo: scopedDelegationRepository,
  kernel: unavailableScopedDelegationKernel,
});

const CONTROL_WRITER_LEASE_KEY = "terminus-control-writer";
const CONTROL_WRITER_INSTANCE = randomUUID();
const parsedWriterLeaseMs = Number(process.env.TERMINUS_CONTROL_WRITER_LEASE_MS ?? "15000");
const CONTROL_WRITER_LEASE_MS = Number.isFinite(parsedWriterLeaseMs)
  ? Math.max(2_000, Math.floor(parsedWriterLeaseMs))
  : 15_000;
let writerLease: { readonly fencingToken: number; expiresAt: Date; healthy: boolean } | null = null;
let writerLeaseHeartbeat: ReturnType<typeof setInterval> | null = null;

async function acquireControlWriterLease(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CONTROL_WRITER_LEASE_MS);
    const existing = await db.lease.findUnique({ where: { leaseKey: CONTROL_WRITER_LEASE_KEY } });
    if (!existing) {
      try {
        const created = await db.lease.create({
          data: {
            leaseKey: CONTROL_WRITER_LEASE_KEY,
            ownerInstance: CONTROL_WRITER_INSTANCE,
            fencingToken: 1,
            expiresAt,
            metadataJson: JSON.stringify({ role: "control-writer" }),
          },
        });
        writerLease = { fencingToken: created.fencingToken, expiresAt: created.expiresAt, healthy: true };
        return;
      } catch (error: unknown) {
        if (attempt === 3) throw error;
        continue;
      }
    }
    if (existing.ownerInstance !== CONTROL_WRITER_INSTANCE && existing.expiresAt > now) {
      throw new Error(
        `control writer lease is held by ${existing.ownerInstance} until ${existing.expiresAt.toISOString()}`,
      );
    }
    const fencingToken = existing.fencingToken + 1;
    const claimed = await db.lease.updateMany({
      where: {
        leaseKey: CONTROL_WRITER_LEASE_KEY,
        ownerInstance: existing.ownerInstance,
        fencingToken: existing.fencingToken,
        expiresAt: existing.expiresAt,
      },
      data: {
        ownerInstance: CONTROL_WRITER_INSTANCE,
        fencingToken,
        acquiredAt: now,
        expiresAt,
        metadataJson: JSON.stringify({ role: "control-writer" }),
      },
    });
    if (claimed.count === 1) {
      writerLease = { fencingToken, expiresAt, healthy: true };
      return;
    }
  }
  throw new Error("control writer lease changed repeatedly during acquisition");
}

async function renewControlWriterLease(): Promise<void> {
  const current = writerLease;
  if (!current?.healthy) return;
  const now = new Date();
  if (current.expiresAt <= now) {
    writerLease = { ...current, healthy: false };
    failControlWriterLease("control writer lease expired before renewal");
    return;
  }
  try {
    const expiresAt = new Date(now.getTime() + CONTROL_WRITER_LEASE_MS);
    const renewed = await db.lease.updateMany({
      where: {
        leaseKey: CONTROL_WRITER_LEASE_KEY,
        ownerInstance: CONTROL_WRITER_INSTANCE,
        fencingToken: current.fencingToken,
        expiresAt: { gt: now },
      },
      data: { expiresAt },
    });
    if (renewed.count !== 1) {
      writerLease = { ...current, healthy: false };
      failControlWriterLease("control writer lease was fenced by another owner");
      return;
    }
    writerLease = { fencingToken: current.fencingToken, expiresAt, healthy: true };
  } catch (error: unknown) {
    console.error("[terminus-control] writer lease heartbeat failed", error);
    if (writerLease && writerLease.expiresAt <= new Date()) {
      writerLease = { ...writerLease, healthy: false };
      failControlWriterLease("control writer lease expired after heartbeat failures");
    }
  }
}

function failControlWriterLease(reason: string): void {
  console.error(`[terminus-control] ${reason}; terminating the control process`);
  void shutdownControl().finally(() => process.exit(1));
}

function writerLeaseIsHealthy(): boolean {
  return writerLease?.healthy === true && writerLease.expiresAt > new Date();
}

class ControlWriterFencedError extends Error {
  constructor() {
    super("the control-plane writer lease changed or expired before the transaction committed");
    this.name = "ControlWriterFencedError";
  }
}

/**
 * Turn the advisory lease into a transaction fence. The conditional no-op
 * update both verifies the exact fencing token and acquires SQLite's writer
 * lock before any authoritative row or semantic event is changed. A former
 * writer therefore cannot commit after a replacement has claimed the lease.
 */
async function assertControlWriterLease(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const current = writerLease;
  const checkedAt = new Date();
  if (!current?.healthy || current.expiresAt <= checkedAt) {
    if (current) writerLease = { ...current, healthy: false };
    throw new ControlWriterFencedError();
  }
  const fenced = await tx.lease.updateMany({
    where: {
      leaseKey: CONTROL_WRITER_LEASE_KEY,
      ownerInstance: CONTROL_WRITER_INSTANCE,
      fencingToken: current.fencingToken,
      expiresAt: { gt: checkedAt },
    },
    // This deliberately leaves the lease duration unchanged. Its purpose is
    // to establish write ownership for the enclosing transaction.
    data: { ownerInstance: CONTROL_WRITER_INSTANCE },
  });
  if (fenced.count !== 1) {
    writerLease = { ...current, healthy: false };
    throw new ControlWriterFencedError();
  }
}

async function writerTransaction<T>(
  mutation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await assertControlWriterLease(tx);
    return mutation(tx);
  });
}

async function releaseControlWriterLease(): Promise<void> {
  const current = writerLease;
  if (!current) return;
  await db.lease.updateMany({
    where: {
      leaseKey: CONTROL_WRITER_LEASE_KEY,
      ownerInstance: CONTROL_WRITER_INSTANCE,
      fencingToken: current.fencingToken,
    },
    data: { expiresAt: new Date() },
  });
  writerLease = { ...current, expiresAt: new Date(), healthy: false };
}

const parsedRepairAttemptLeaseMs = Number(process.env.TERMINUS_REPAIR_ATTEMPT_LEASE_MS ?? "120000");
const REPAIR_ATTEMPT_LEASE_MS = Number.isFinite(parsedRepairAttemptLeaseMs)
  ? Math.max(5_000, Math.floor(parsedRepairAttemptLeaseMs))
  : 120_000;
interface RepairAttemptClaim {
  readonly attemptId: string;
  readonly taskId: string;
  readonly repairTurnId: string;
  readonly leaseKey: string;
  readonly fencingToken: number;
}

interface ActiveRepairAttemptRun {
  readonly claim: RepairAttemptClaim;
  leaseLost: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
}

const activeRepairAttemptRuns = new Map<string, ActiveRepairAttemptRun>();
const repairAttemptRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Claim one durable repair continuation using the existing fencing lease. */
async function claimRepairAttempt(attemptId: string): Promise<RepairAttemptClaim | null> {
  return mutateAgentState(() => writerTransaction(async (tx) => {
    const attempt = await tx.repairAttempt.findUnique({
      where: { id: attemptId },
      select: { id: true, taskId: true, repairTurnId: true, leaseKey: true, state: true },
    });
    if (attempt === null) throw new Error(`repair attempt ${attemptId} disappeared`);
    const lease = await tx.lease.findUnique({
      where: { leaseKey: attempt.leaseKey },
      select: { ownerInstance: true, fencingToken: true, expiresAt: true },
    });
    if (lease === null) throw new Error(`repair attempt ${attemptId} has no associated lease`);
    const decision = decideRepairAttemptClaim({
      state: attempt.state,
      repairTurnId: attempt.repairTurnId,
      lease,
      ownerInstance: CONTROL_WRITER_INSTANCE,
      now: new Date(),
    });
    if (!decision.claimable) return null;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + REPAIR_ATTEMPT_LEASE_MS);
    const claimed = await tx.lease.updateMany({
      where: {
        leaseKey: attempt.leaseKey,
        ownerInstance: lease.ownerInstance,
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
      },
      data: {
        ownerInstance: CONTROL_WRITER_INSTANCE,
        fencingToken: decision.fencingToken,
        acquiredAt: now,
        expiresAt,
        metadataJson: JSON.stringify({
          role: "verification-repair",
          repair_attempt_id: attempt.id,
          task_id: attempt.taskId,
        }),
      },
    });
    if (claimed.count !== 1) return null;
    const running = await tx.repairAttempt.updateMany({
      where: {
        id: attempt.id,
        state: { in: [...REPAIR_ATTEMPT_ACTIVE_STATES] },
        repairTurnId: { not: null },
      },
      data: { state: "RUNNING", startedAt: now },
    });
    if (running.count !== 1) throw new Error(`repair attempt ${attemptId} changed during lease claim`);
    if (attempt.repairTurnId === null) {
      throw new Error(`repair attempt ${attemptId} lost its continuation during lease claim`);
    }
    return {
      attemptId: attempt.id,
      taskId: attempt.taskId,
      repairTurnId: attempt.repairTurnId,
      leaseKey: attempt.leaseKey,
      fencingToken: decision.fencingToken,
    };
  }));
}

async function renewRepairAttemptLease(claim: RepairAttemptClaim): Promise<boolean> {
  return mutateAgentState(() => writerTransaction(async (tx) => {
    const now = new Date();
    const renewed = await tx.lease.updateMany({
      where: {
        leaseKey: claim.leaseKey,
        ownerInstance: CONTROL_WRITER_INSTANCE,
        fencingToken: claim.fencingToken,
        expiresAt: { gt: now },
      },
      data: { expiresAt: new Date(now.getTime() + REPAIR_ATTEMPT_LEASE_MS) },
    });
    return renewed.count === 1;
  }));
}

/** Release a repair claim without changing its durable attempt state. */
async function releaseRepairAttemptLease(claim: RepairAttemptClaim): Promise<void> {
  await mutateAgentState(() => writerTransaction(async (tx) => {
    await tx.lease.updateMany({
      where: {
        leaseKey: claim.leaseKey,
        ownerInstance: CONTROL_WRITER_INSTANCE,
        fencingToken: claim.fencingToken,
      },
      data: { expiresAt: new Date() },
    });
  }));
}

async function settleRepairAttemptAfterRun(claim: RepairAttemptClaim): Promise<void> {
  await mutateAgentState(() => writerTransaction(async (tx) => {
    const attempt = await tx.repairAttempt.findUnique({
      where: { id: claim.attemptId },
      select: { state: true, taskId: true, repairTurnId: true, leaseKey: true, attemptNumber: true },
    });
    if (attempt === null || isRepairAttemptTerminal(attempt.state)) return;
    const repairTurn = attempt.repairTurnId === null
      ? null
      : await tx.turn.findUnique({ where: { id: attempt.repairTurnId }, select: { state: true } });
    const task = await tx.task.findUnique({ where: { id: attempt.taskId }, select: { status: true } });
    const nextAttempt = await tx.repairAttempt.findFirst({
      where: { taskId: attempt.taskId, attemptNumber: { gt: attempt.attemptNumber } },
      select: { id: true },
    });
    const settled = repairAttemptStateForTurn({
      turnState: repairTurn?.state ?? "FAILED",
      taskStatus: task?.status ?? null,
      hasSuccess: task?.status === "COMPLETED" || repairTurn?.state === "COMPLETED",
      hasNextAttempt: nextAttempt !== null,
    });
    const now = new Date();
    const updated = await tx.repairAttempt.updateMany({
      where: {
        id: claim.attemptId,
        state: { in: [...REPAIR_ATTEMPT_ACTIVE_STATES] },
        leaseKey: claim.leaseKey,
      },
      data: {
        state: settled.state,
        completedAt: now,
        terminalReasonJson: JSON.stringify({
          reason: settled.reason,
          repair_turn_state: repairTurn?.state ?? null,
          task_status: task?.status ?? null,
        }),
      },
    });
    if (updated.count !== 1) return;
    await tx.lease.updateMany({
      where: {
        leaseKey: claim.leaseKey,
        ownerInstance: CONTROL_WRITER_INSTANCE,
        fencingToken: claim.fencingToken,
      },
      data: { expiresAt: now },
    });
  }));
}

async function markRepairAttemptTerminal(
  attemptId: string,
  state: "SUCCEEDED" | "FAILED" | "BLOCKED" | "ABORTED" | "SUPERSEDED",
  reason: string,
): Promise<void> {
  await mutateAgentState(() => writerTransaction(async (tx) => {
    const now = new Date();
    const attempt = await tx.repairAttempt.findUnique({
      where: { id: attemptId },
      select: { leaseKey: true },
    });
    if (attempt === null) return;
    const updated = await tx.repairAttempt.updateMany({
      where: { id: attemptId, state: { in: [...REPAIR_ATTEMPT_ACTIVE_STATES] } },
      data: {
        state,
        completedAt: now,
        terminalReasonJson: JSON.stringify({ reason }),
      },
    });
    if (updated.count !== 1) return;
    await tx.lease.updateMany({ where: { leaseKey: attempt.leaseKey }, data: { expiresAt: now } });
  }));
}

/** Backfill the durable row for a repair event written before migration 0012. */
async function ensureRepairAttemptRecord(input: RepairAttemptPersistenceInput): Promise<void> {
  await mutateAgentState(() => writerTransaction(async (tx) => {
    const existing = await tx.repairAttempt.findUnique({ where: { id: input.id }, select: { id: true } });
    if (existing !== null) return;
    await tx.lease.create({
      data: {
        leaseKey: input.leaseKey,
        ownerInstance: "unclaimed",
        fencingToken: 0,
        expiresAt: new Date(0),
        metadataJson: JSON.stringify({
          role: "verification-repair",
          repair_attempt_id: input.id,
          task_id: input.taskId,
          backfilled: true,
        }),
      },
    });
    await tx.repairAttempt.create({
      data: {
        id: input.id,
        taskId: input.taskId,
        parentTurnId: input.parentTurnId,
        leaseKey: input.leaseKey,
        attemptNumber: input.attemptNumber,
        maxAttempts: input.maxAttempts,
        state: "PENDING",
        directiveArtifact: input.directiveArtifact,
        failedNodeIdsJson: JSON.stringify(input.failedNodeIds),
        failureSignaturesJson: JSON.stringify(input.failureSignatures),
        changedFilesJson: JSON.stringify(input.changedFiles),
        sourceRevision: input.sourceRevision,
        environmentDigest: input.environmentDigest,
        remainingBudgetJson: input.remainingBudgetJson,
      },
    });
  }));
}

/** Retry a recovery pass after another owner’s fencing lease expires. */
async function scheduleRepairAttemptRecovery(attemptId: string, repairTurnId: string): Promise<void> {
  if (activeRepairAttemptRuns.has(attemptId) || repairAttemptRecoveryTimers.has(attemptId)) return;
  const attempt = await db.repairAttempt.findUnique({
    where: { id: attemptId },
    select: {
      state: true,
      repairTurnId: true,
      lease: { select: { expiresAt: true } },
    },
  });
  if (attempt === null || !isRepairAttemptActive(attempt.state)) return;
  if (attempt.repairTurnId !== repairTurnId) return;
  const delayMs = Math.max(1_000, attempt.lease.expiresAt.getTime() - Date.now() + 25);
  const timer = setTimeout(() => {
    repairAttemptRecoveryTimers.delete(attemptId);
    void runRepairTurnWithLease(attemptId, repairTurnId).then((started) => {
      if (!started) void scheduleRepairAttemptRecovery(attemptId, repairTurnId);
    }).catch((error: unknown) => {
      console.error(`repair attempt ${attemptId} recovery retry failed`, error);
      void scheduleRepairAttemptRecovery(attemptId, repairTurnId);
    });
  }, delayMs);
  repairAttemptRecoveryTimers.set(attemptId, timer);
}

/** Run a repair continuation only while its durable lease is held. */
async function runRepairTurnWithLease(attemptId: string, repairTurnId: string): Promise<boolean> {
  let claim: RepairAttemptClaim | null;
  try {
    claim = await claimRepairAttempt(attemptId);
  } catch (error: unknown) {
    console.error(`repair attempt ${attemptId} could not be claimed`, error);
    return false;
  }
  if (claim === null) {
    await scheduleRepairAttemptRecovery(attemptId, repairTurnId).catch((error: unknown) => {
      console.error(`repair attempt ${attemptId} recovery scheduling failed`, error);
    });
    return false;
  }
  if (claim.repairTurnId !== repairTurnId) {
    await releaseRepairAttemptLease(claim).catch((error: unknown) => {
      console.error(`repair attempt ${attemptId} lease release failed after association mismatch`, error);
    });
    console.error(`repair attempt ${attemptId} points at ${claim.repairTurnId}, not ${repairTurnId}`);
    return false;
  }
  const active: ActiveRepairAttemptRun = { claim, leaseLost: false, heartbeat: null };
  activeRepairAttemptRuns.set(attemptId, active);
  active.heartbeat = setInterval(() => {
    void renewRepairAttemptLease(claim).then((healthy) => {
      if (healthy) return;
      active.leaseLost = true;
      abortActiveTurn(repairTurnId, "repair_attempt_lease_lost");
    }).catch((error: unknown) => {
      active.leaseLost = true;
      abortActiveTurn(repairTurnId, "repair_attempt_lease_lost");
      console.error(`repair attempt ${attemptId} lease heartbeat failed`, error);
    });
  }, Math.max(1_000, Math.floor(REPAIR_ATTEMPT_LEASE_MS / 3)));
  try {
    await agentLoop(repairTurnId);
  } catch (error: unknown) {
    console.error(`repair turn ${repairTurnId} failed`, error);
  } finally {
    if (active.heartbeat !== null) clearInterval(active.heartbeat);
    activeRepairAttemptRuns.delete(attemptId);
    if (!active.leaseLost) {
      await settleRepairAttemptAfterRun(claim).catch((error: unknown) => {
        console.error(`repair attempt ${attemptId} settlement failed`, error);
      });
      await releaseRepairAttemptLease(claim).catch((error: unknown) => {
        console.error(`repair attempt ${attemptId} lease release failed`, error);
      });
    } else {
      await scheduleRepairAttemptRecovery(attemptId, repairTurnId).catch((error: unknown) => {
        console.error(`repair attempt ${attemptId} recovery rescheduling failed`, error);
      });
    }
  }
  return true;
}

const kernelUds: KernelUdsClients | null = KERNEL_GRPC_SOCKET
  ? createKernelUdsClients(KERNEL_GRPC_SOCKET, "", KERNEL_CONTROL_BOOTSTRAP_TOKEN)
  : null;

let kernelBrokerCapabilityToken = CONFIGURED_KERNEL_CAP_TOKEN;
let kernelMaintenanceCapabilityToken = CONFIGURED_KERNEL_MAINTENANCE_CAP_TOKEN;
let kernelControlCapabilitiesExpireAtUnix =
  kernelBrokerCapabilityToken.length > 0 && kernelMaintenanceCapabilityToken.length > 0
    ? Number.MAX_SAFE_INTEGER
    : 0;
let kernelBootstrapInFlight: Promise<void> | null = null;

interface KernelTaskCapabilityScope {
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly operationClasses: readonly CapabilityOperationProto[];
  readonly workspacePaths?: readonly string[];
  readonly networkDestinations?: readonly string[];
  readonly secretCapabilities?: readonly string[];
  readonly policyProfileIds?: readonly string[];
}

const NO_WORKSPACE_EFFECT_SCOPE = [".terminus/capabilities/no-workspace-effect"] as const;
const PROJECT_INSTRUCTION_PATH_PATTERNS = [
  "AGENTS.override.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "**/AGENTS.override.md",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/.cursorrules",
] as const;

function leastWorkspaceScope(paths: readonly string[]): readonly string[] {
  const unique = [...new Set(paths)];
  return unique.length > 0 ? unique : NO_WORKSPACE_EFFECT_SCOPE;
}

const kernelTaskCapabilityCache = new Map<string, {
  readonly token: string;
  readonly expiresAtUnix: number;
}>();

function requireKernelUds(): KernelUdsClients {
  if (!kernelUds) {
    throw new Error("TERMINUS_KERNEL_GRPC_SOCKET is required for privileged control-plane effects");
  }
  return kernelUds;
}

/**
 * Which kernel *build* answered, cached for the life of this process.
 *
 * `KernelHealth` carries only liveness, and `KernelInfo.instance_id` is a
 * fresh uuid on every kernel start — using it to identify a build makes two
 * runs of the same binary look like different software, which is exactly
 * backwards for comparing evaluation results.
 *
 * `build_digest` prefers the kernel's own `build_revision`. Today's kernel
 * reports the placeholder `dev` for it, so the fallback is a digest over the
 * fields that change with a build and not with a restart: version, protocol
 * version, and the declared backend/service surface. That is coarser than a
 * commit — two builds of the same version with the same surface hash alike —
 * but it is stable, and it upgrades automatically the moment the kernel
 * reports a real revision.
 */
const KERNEL_BUILD_REVISION_PLACEHOLDERS: ReadonlySet<string> = new Set(["", "dev", "unknown"]);
let kernelBuildIdentityCache: { readonly version: string; readonly build_digest: string } | null = null;

async function kernelBuildIdentity(kernel: KernelUdsClients): Promise<{
  readonly version: string | null;
  readonly build_digest: string | null;
}> {
  if (kernelBuildIdentityCache !== null) return kernelBuildIdentityCache;
  let info: Awaited<ReturnType<KernelUdsClients["info"]["GetInfo"]>>;
  try {
    info = await kernel.info.GetInfo({});
  } catch (error: unknown) {
    // Health must answer even when GetInfo does not; an unknown build is
    // reported as null rather than guessed.
    logInternalError("kernel build identity is unavailable", error);
    return { version: null, build_digest: null };
  }
  const revision = info.buildRevision.trim();
  const digest = KERNEL_BUILD_REVISION_PLACEHOLDERS.has(revision.toLowerCase())
    ? `sha256:${createHash("sha256").update(canonicalJson({
        version: info.version,
        protocol_version: info.protocolVersion,
        supported_backends: [...info.supportedBackends].sort(),
        supported_services: [...info.supportedServices].sort(),
      }), "utf8").digest("hex")}`
    : revision;
  kernelBuildIdentityCache = { version: info.version, build_digest: digest };
  return kernelBuildIdentityCache;
}

function baseKernelContext(input: {
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly capabilityToken: string;
}): RequestContext {
  return {
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    turnId: input.turnId,
    actorId: SERVER_PRINCIPAL,
    traceparent: "",
    capabilityToken: input.capabilityToken,
    workspaceId: input.workspaceId,
    deadline: undefined,
    resourceBudgets: undefined,
    policyVersion: "",
  };
}

async function initializeKernelControlCapabilities(): Promise<void> {
  const nowUnix = Math.floor(Date.now() / 1_000);
  if (
    kernelBrokerCapabilityToken.length > 0
    && kernelMaintenanceCapabilityToken.length > 0
    && kernelControlCapabilitiesExpireAtUnix > nowUnix + 30
  ) {
    return;
  }
  if (kernelBootstrapInFlight !== null) return kernelBootstrapInFlight;
  const clients = requireKernelUds();
  kernelBootstrapInFlight = (async () => {
    const capabilities = await clients.info.BootstrapControl({ principal: SERVER_PRINCIPAL });
    if (
      capabilities.brokerCapabilityToken.length === 0
      || capabilities.maintenanceCapabilityToken.length === 0
      || capabilities.expiresAtUnix <= Math.floor(Date.now() / 1_000)
    ) {
      throw new Error("kernel returned invalid standalone control capabilities");
    }
    kernelBrokerCapabilityToken = capabilities.brokerCapabilityToken;
    kernelMaintenanceCapabilityToken = capabilities.maintenanceCapabilityToken;
    kernelControlCapabilitiesExpireAtUnix = capabilities.expiresAtUnix;
    kernelTaskCapabilityCache.clear();
  })();
  try {
    await kernelBootstrapInFlight;
  } finally {
    kernelBootstrapInFlight = null;
  }
}

async function kernelBrokerContext(): Promise<RequestContext> {
  await initializeKernelControlCapabilities();
  return baseKernelContext({
    sessionId: "control",
    taskId: "control-broker",
    turnId: "broker",
    workspaceId: "*",
    capabilityToken: kernelBrokerCapabilityToken,
  });
}

async function kernelMaintenanceContext(): Promise<RequestContext> {
  await initializeKernelControlCapabilities();
  return baseKernelContext({
    sessionId: "control",
    taskId: "control-maintenance",
    turnId: "reconciliation",
    workspaceId: "*",
    capabilityToken: kernelMaintenanceCapabilityToken,
  });
}

function taskCapabilityCacheKey(scope: KernelTaskCapabilityScope): string {
  const sorted = (values: readonly string[] | undefined): readonly string[] =>
    [...(values ?? [])].sort((left, right) => left.localeCompare(right));
  return JSON.stringify({
    principal: SERVER_PRINCIPAL,
    sessionId: scope.sessionId,
    taskId: scope.taskId,
    workspaceId: scope.workspaceId,
    operationClasses: [...scope.operationClasses].sort((left, right) => left - right),
    workspacePaths: sorted(scope.workspacePaths),
    networkDestinations: sorted(scope.networkDestinations),
    secretCapabilities: sorted(scope.secretCapabilities),
    policyProfileIds: sorted(scope.policyProfileIds),
  });
}

async function kernelTaskContext(scope: KernelTaskCapabilityScope): Promise<RequestContext> {
  for (const [label, value] of [
    ["session", scope.sessionId],
    ["task", scope.taskId],
    ["workspace", scope.workspaceId],
  ] as const) {
    if (value.length === 0 || value === "*") {
      throw new Error(`kernel ${label} capability binder must be concrete`);
    }
  }
  if (scope.operationClasses.length === 0) {
    throw new Error("kernel task capability requires at least one operation class");
  }

  let capabilityToken: string;
  // A configured development token is an explicit local bootstrap shortcut,
  // not a signed authorization for a non-default policy. Force every
  // non-default request through the broker so the token carries the policy
  // binding (and fails closed when that policy is unavailable).
  if (
    DEV_MODE
    && CONFIGURED_KERNEL_CAP_TOKEN.length > 0
    && configuredTokenMayAuthorize(scope.policyProfileIds)
  ) {
    capabilityToken = CONFIGURED_KERNEL_CAP_TOKEN;
  } else {
    await initializeKernelControlCapabilities();
    const cacheKey = taskCapabilityCacheKey(scope);
    const nowUnix = Math.floor(Date.now() / 1_000);
    const cached = kernelTaskCapabilityCache.get(cacheKey);
    if (cached && cached.expiresAtUnix > nowUnix + 30) {
      capabilityToken = cached.token;
    } else {
      const minted = await requireKernelUds().policies.MintTaskCapability({
        context: await kernelBrokerContext(),
        principal: SERVER_PRINCIPAL,
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        workspaceId: scope.workspaceId,
        operationClasses: [...scope.operationClasses],
        workspacePaths: [...(scope.workspacePaths ?? NO_WORKSPACE_EFFECT_SCOPE)],
        networkDestinations: [...(scope.networkDestinations ?? [])],
        secretCapabilities: [...(scope.secretCapabilities ?? [])],
        policyProfileIds: [...(scope.policyProfileIds ?? [])],
        ttlSeconds: 300,
      });
      if (minted.capabilityToken.length === 0 || minted.expiresAtUnix <= nowUnix) {
        throw new Error("kernel returned an invalid task capability");
      }
      capabilityToken = minted.capabilityToken;
      kernelTaskCapabilityCache.set(cacheKey, {
        token: capabilityToken,
        expiresAtUnix: minted.expiresAtUnix,
      });
    }
  }

  return baseKernelContext({
    sessionId: scope.sessionId,
    taskId: scope.taskId,
    turnId: scope.turnId,
    workspaceId: scope.workspaceId,
    capabilityToken,
  });
}

/**
 * A capability request the task's own contract does not authorize.
 *
 * Distinguished from an internal failure because it is neither: it is a
 * caller-visible fact about the task, and the only remedy is a different
 * contract. Reported as a 409 naming the contract, rather than the opaque
 * `EXEC_FAILED` / `DIFF_FAILED` 500 these refusals used to produce — which
 * read as a kernel or sandbox fault and sent debugging in the wrong
 * direction entirely.
 */
class TaskScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskScopeError";
  }
}

/** Answer a scope refusal honestly; returns false when `error` is something else. */
function sendTaskScopeError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof TaskScopeError)) return false;
  sendError(res, 409, "TASK_SCOPE_UNAUTHORIZED", error.message, "conflict");
  return true;
}

async function kernelContextForTask(
  taskId: string,
  turnId: string,
  operationClasses: readonly CapabilityOperationProto[],
  workspacePaths?: readonly string[],
  policyProfileIds?: readonly string[],
): Promise<RequestContext> {
  const requestsWorkspaceDevelopment = policyProfileIds?.includes(
    WORKSPACE_DEVELOPMENT_POLICY_PROFILE_ID,
  ) ?? false;
  if (
    requestsWorkspaceDevelopment
    && !operationClasses.includes(CapabilityOperationProto.CAPABILITY_OPERATION_EXEC)
  ) {
    throw new Error("workspace-development policy requires an Exec capability");
  }
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      sessionId: true,
      activeContractVersion: true,
      session: { select: { workspaceId: true } },
    },
  });
  if (task === null) throw new Error(`task ${taskId} does not exist`);
  const pathOperations = new Set([
    CapabilityOperationProto.CAPABILITY_OPERATION_READ,
    CapabilityOperationProto.CAPABILITY_OPERATION_PATCH,
    CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
    CapabilityOperationProto.CAPABILITY_OPERATION_CODE_INTEL,
    CapabilityOperationProto.CAPABILITY_OPERATION_GIT,
  ]);
  const needsWorkspaceScope = operationClasses.some((operation) => pathOperations.has(operation));
  let boundedWorkspacePaths: readonly string[] = workspacePaths ?? NO_WORKSPACE_EFFECT_SCOPE;
  if (needsWorkspaceScope) {
    const contract = await db.taskContractVersion.findUnique({
      where: {
        task_id_version: {
          task_id: taskId,
          version: task.activeContractVersion,
        },
      },
      select: { allowedScopeJson: true },
    });
    if (contract === null) {
      throw new Error(`task ${taskId} has no active contract version ${task.activeContractVersion}`);
    }
    const allowedScope = v1AllowedScopeProjection(safeParse<unknown>(contract.allowedScopeJson, {}));
    if (requestsWorkspaceDevelopment && !authorizesWorkspaceDevelopment(allowedScope)) {
      throw new TaskScopeError(
        `task ${taskId} contract must grant whole-workspace read and write scope (`
        + `${WHOLE_WORKSPACE_SCOPE_GLOB}) before it can authorize arbitrary local commands`,
      );
    }
    const writeOnly = operationClasses.includes(CapabilityOperationProto.CAPABILITY_OPERATION_PATCH)
      || operationClasses.includes(CapabilityOperationProto.CAPABILITY_OPERATION_GIT);
    const contractAllowedPaths = writeOnly
      ? allowedScope.write_paths
      : [...new Set([...allowedScope.read_paths, ...allowedScope.write_paths])];
    // Repository instructions are read-only authority metadata. They remain
    // readable even when the task's code scope is narrower than the
    // repository root; no write/exec capability is added by these patterns.
    const allowedPaths = operationClasses.includes(CapabilityOperationProto.CAPABILITY_OPERATION_READ)
      ? [...new Set([...contractAllowedPaths, ...PROJECT_INSTRUCTION_PATH_PATTERNS])]
      : contractAllowedPaths;
    if (allowedPaths.length === 0) {
      throw new TaskScopeError(
        `task ${taskId} contract grants no workspace paths for the requested operation; `
        + "the task was created without an allowed_scope and its contract may not expand",
      );
    }
    if (requestsWorkspaceDevelopment) {
      // The subprocess can traverse the whole mounted workspace regardless
      // of its initial cwd, so the signed token must state that full scope.
      boundedWorkspacePaths = [WHOLE_WORKSPACE_SCOPE_GLOB];
    } else if (workspacePaths === undefined) {
      boundedWorkspacePaths = allowedPaths;
    } else {
      const denied = workspacePaths.find((path) => !allowedPaths.some((pattern) => globMatch(pattern, path)));
      if (denied !== undefined) {
        throw new TaskScopeError(`task ${taskId} contract does not authorize workspace path ${denied}`);
      }
      boundedWorkspacePaths = workspacePaths;
    }
  }
  return kernelTaskContext({
    sessionId: task.sessionId,
    taskId,
    turnId,
    workspaceId: task.session.workspaceId,
    operationClasses,
    workspacePaths: boundedWorkspacePaths,
    ...(policyProfileIds === undefined ? {} : { policyProfileIds }),
  });
}

interface KernelJobBinding {
  readonly context: RequestContext;
  readonly kernelJobId: string;
}

async function kernelBindingForJob(
  jobId: string,
  operationClasses: readonly CapabilityOperationProto[],
): Promise<KernelJobBinding | null> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      sessionId: true,
      taskId: true,
      processIdentityJson: true,
      session: { select: { workspaceId: true } },
    },
  });
  if (job === null || job.taskId === null || job.processIdentityJson === null) return null;
  const identity = safeParse<Record<string, unknown>>(job.processIdentityJson, {});
  const kernelJobId = identity.kernelJobId;
  if (typeof kernelJobId !== "string" || kernelJobId.length === 0) return null;
  const context = await kernelTaskContext({
    sessionId: job.sessionId,
    taskId: job.taskId,
    turnId: `job:${jobId}`,
    workspaceId: job.session.workspaceId,
    operationClasses,
  });
  return { context, kernelJobId };
}

function kernelIntent() {
  return {
    userIntentRef: "control-plane",
    taskContractHash: "",
    trustLabel: "trusted",
    confidentialityLabel: "workspace",
    taintSources: [],
    policyProfileId: "secure-local-default",
    expectedEffectClass: "",
  };
}

// ────────────────────────── Event bus ──────────────────────────────────────

interface EventBusSubscription {
  id: string;
  filter: (ev: StoredEvent) => boolean;
  push: (ev: StoredEvent) => void;
}

interface StoredEvent {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: number;
  occurredAt: Date;
  actorJson: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string | null;
  payloadJson: string;
  artifactRefsJson: string;
  traceId: string | null;
}

type PendingStoredEvent = Omit<StoredEvent, "eventId" | "aggregateSequence">;

class EventBus {
  private subscriptions = new Map<string, EventBusSubscription>();
  private cursor = 0;
  private lastEventMillis = 0;
  private monotonicSeq = 0;
  private aggregateSequences = new Map<string, number>();
  private initialized = false;
  private publishTail: Promise<void> = Promise.resolve();

  /**
   * Restore the single aggregate sequence domain shared by v1 and v2
   * projections. History must be validated before the service accepts work.
   */
  initializeFromHistory(events: readonly Pick<StoredEvent, "eventId" | "aggregateType" | "aggregateId" | "aggregateSequence">[]): void {
    if (this.initialized) throw new Error("event bus history was initialized more than once");
    let previousEventId: string | null = null;
    for (const event of events) {
      if (previousEventId !== null && event.eventId <= previousEventId) {
        throw new Error(`semantic event IDs are not strictly increasing at ${event.eventId}`);
      }
      const key = `${event.aggregateType}:${event.aggregateId}`;
      const previous = this.aggregateSequences.get(key) ?? 0;
      if (event.aggregateSequence <= previous) {
        throw new Error(
          `semantic event sequence violation for ${key}: ${event.aggregateSequence} does not advance past ${previous} at ${event.eventId}`,
        );
      }
      this.aggregateSequences.set(key, event.aggregateSequence);
      const match = /^(\d{16})-(\d{8})$/.exec(event.eventId);
      if (match) {
        const millis = Number(match[1]);
        const sequence = Number(match[2]);
        if (millis > this.lastEventMillis || (millis === this.lastEventMillis && sequence >= this.monotonicSeq)) {
          this.lastEventMillis = millis;
          this.monotonicSeq = sequence + 1;
        }
      }
      previousEventId = event.eventId;
    }
    this.initialized = true;
  }

  /**
   * Monotonic, lexicographically-comparable event ID. SPEC §30.6 requires
   * `Last-Event-ID` replay to return a contiguous, ordered slice, so the
   * ID is `<16-digit-ms>-<8-digit-seq>` (zero-padded). String comparison
   * of two such IDs therefore yields chronological order.
   */
  private nextEventId(): string {
    const nowMillis = Date.now();
    if (nowMillis > this.lastEventMillis) {
      this.lastEventMillis = nowMillis;
      this.monotonicSeq = 0;
    }
    const ms = this.lastEventMillis.toString().padStart(16, "0");
    const seq = (this.monotonicSeq++).toString().padStart(8, "0");
    return `${ms}-${seq}`;
  }

  async publish(pending: PendingStoredEvent): Promise<StoredEvent> {
    return this.enqueuePublish(pending, async (event) => {
      await writerTransaction(async (tx) => {
        await tx.semanticEvent.create({ data: event });
      });
    });
  }

  async publishAtomically(
    pending: PendingStoredEvent,
    mutation: (tx: Prisma.TransactionClient, event: StoredEvent) => Promise<void>,
  ): Promise<StoredEvent> {
    return this.enqueuePublish(pending, async (event) => {
      await db.$transaction(async (tx) => {
        await assertControlWriterLease(tx);
        await tx.semanticEvent.create({ data: event });
        await mutation(tx, event);
      });
    });
  }

  async publishManyAtomically(
    pending: readonly PendingStoredEvent[],
    mutation: (tx: Prisma.TransactionClient, events: readonly StoredEvent[]) => Promise<void>,
  ): Promise<readonly StoredEvent[]> {
    if (pending.length === 0) return [];
    return this.enqueuePublishBatch(pending, async (events) => {
      await db.$transaction(async (tx) => {
        await assertControlWriterLease(tx);
        for (const event of events) {
          await tx.semanticEvent.create({ data: event });
        }
        await mutation(tx, events);
      });
    });
  }

  private async enqueuePublish(
    pending: PendingStoredEvent,
    persist: (event: StoredEvent) => Promise<void>,
  ): Promise<StoredEvent> {
    const operation = this.publishTail.then(async () => {
      if (!this.initialized) throw new Error("event bus history is not initialized");
      const sequenceKey = `${pending.aggregateType}:${pending.aggregateId}`;
      const aggregateSequence = (this.aggregateSequences.get(sequenceKey) ?? 0) + 1;
      const ev: StoredEvent = {
        ...pending,
        eventId: this.nextEventId(),
        aggregateSequence,
      };
      // Never convert an arbitrary persistence failure into a success-shaped
      // in-memory event. Fan-out happens only after the durable write or
      // transaction commits.
      await persist(ev);
      this.aggregateSequences.set(sequenceKey, aggregateSequence);
      // Fan-out to subscribers only after the event is durable.
      for (const sub of this.subscriptions.values()) {
        try {
          if (sub.filter(ev)) sub.push(ev);
        } catch (error: unknown) {
          console.error(`[terminus-control] event subscriber ${sub.id} failed after durable commit`, error);
        }
      }
      this.cursor += 1;
      return ev;
    });
    this.publishTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async enqueuePublishBatch(
    pending: readonly PendingStoredEvent[],
    persist: (events: readonly StoredEvent[]) => Promise<void>,
  ): Promise<readonly StoredEvent[]> {
    const operation = this.publishTail.then(async () => {
      if (!this.initialized) throw new Error("event bus history is not initialized");
      const aggregateSequences = new Map(this.aggregateSequences);
      const events = pending.map((item) => {
        const sequenceKey = `${item.aggregateType}:${item.aggregateId}`;
        const aggregateSequence = (aggregateSequences.get(sequenceKey) ?? 0) + 1;
        aggregateSequences.set(sequenceKey, aggregateSequence);
        return {
          ...item,
          eventId: this.nextEventId(),
          aggregateSequence,
        } satisfies StoredEvent;
      });
      await persist(events);
      for (const event of events) {
        this.aggregateSequences.set(
          `${event.aggregateType}:${event.aggregateId}`,
          event.aggregateSequence,
        );
        for (const sub of this.subscriptions.values()) {
          try {
            if (sub.filter(event)) sub.push(event);
          } catch (error: unknown) {
            console.error(`[terminus-control] event subscriber ${sub.id} failed after durable commit`, error);
          }
        }
        this.cursor += 1;
      }
      return events;
    });
    this.publishTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  subscribe(filter: (ev: StoredEvent) => boolean, push: (ev: StoredEvent) => void): () => void {
    const id = randomUUID();
    this.subscriptions.set(id, { id, filter, push });
    return () => { this.subscriptions.delete(id); };
  }

  /** Replay the complete bounded cursor range in fixed-size pages. */
  async replay(
    sinceEventId: string,
    throughEventId: string,
    filter: (ev: StoredEvent) => boolean,
    push: (ev: StoredEvent) => void | Promise<void>,
  ): Promise<void> {
    let cursor = sinceEventId;
    for (;;) {
      const rows = await db.semanticEvent.findMany({
        where: { eventId: { gt: cursor, lte: throughEventId } },
        orderBy: { eventId: "asc" },
        take: 1_000,
      }) as unknown as StoredEvent[];
      for (const event of rows) {
        if (filter(event)) await push(event);
      }
      if (rows.length < 1_000) return;
      const next = rows.at(-1)?.eventId;
      if (!next || next <= cursor) {
        throw new Error("semantic event replay pagination did not advance");
      }
      cursor = next;
    }
  }

  async latestEventId(): Promise<string | null> {
    const latest = await db.semanticEvent.findFirst({
      orderBy: { eventId: "desc" },
      select: { eventId: true },
    });
    return latest?.eventId ?? null;
  }

  /**
   * Return the event ID of the oldest retained event, or null if none.
   * Used to detect stale SSE cursors (SPEC §30.6 CURSOR_EXPIRED).
   */
  async oldestEventId(): Promise<string | null> {
    const oldest = await db.semanticEvent.findFirst({
      orderBy: { eventId: "asc" },
      select: { eventId: true },
    });
    return oldest?.eventId ?? null;
  }

  async eventExists(eventId: string): Promise<boolean> {
    const event = await db.semanticEvent.findUnique({
      where: { eventId },
      select: { eventId: true },
    });
    return event !== null;
  }

  /**
   * Persist the last-sent event ID for a stream so the server can
   * reconstruct per-subscriber progress (SPEC §30.6, §45.5
   * EventStreamCursor table).
   */
  async persistCursor(streamName: string, lastEventId: string, lastSequence: number): Promise<void> {
    await writerTransaction(async (tx) => {
      await tx.eventStreamCursor.upsert({
        where: { streamName },
        create: { streamName, lastEventId, lastSequence },
        update: { lastEventId, lastSequence },
      });
    }).catch(() => {
      // best-effort; cursor persistence must not break the stream.
    });
  }
}

const bus = new EventBus();

const eventSubscriptionService = new EventSubscriptionService<StoredEvent>({
  subscribeLive: (filter, push) => bus.subscribe(filter, push),
  latestEventId: () => bus.latestEventId(),
  oldestEventId: () => bus.oldestEventId(),
  eventExists: (eventId) => bus.eventExists(eventId),
  replay: (since, through, filter, push) => bus.replay(since, through, filter, push),
  persistCursor: (streamName, lastEventId, lastSequence) => bus.persistCursor(streamName, lastEventId, lastSequence),
});

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => turn, () => turn);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

const mutationMutex = new AsyncMutex();

function mutateAgentState<T>(operation: () => Promise<T>): Promise<T> {
  return mutationMutex.runExclusive(operation);
}

// Phase 8 Subsystems (SPEC §26, §27)
const profileRegistry = new ProfileRegistry([
  ...ANTHROPIC_MODEL_PROFILES,
  ...GOOGLE_MODEL_PROFILES,
  ...OPENAI_MODEL_PROFILES,
  ...LOCAL_MODEL_PROFILES,
]);
const posteriorTracker = new PosteriorTracker();
const stageRouter = new StageRouter(profileRegistry, posteriorTracker);
const evScheduler = new ExpectedValueScheduler();
const cleanReviewer = new CleanContextReviewer();
const stagnationSupervisor = new StagnationSupervisor();
const candidateWorkspaceManager = new CandidateWorkspaceManager();
const providerContinuationManager = new ProviderContinuationManager();

// Phase 9 Subsystems (SPEC §1, §4, §16, §29, §33)
const orgDirectory = new OrganizationDirectory();
const attentionCoordinator = new AttentionCoordinator();
const interventionManager = new InterventionManager();
const causalReplayEngine = new CausalReplayEngine();

// Phase 10 Subsystems (SPEC §25, §18.3, §17, §30)
interface TrustedComputerUseBackend {
  readonly observationReceipts: ObservationReceiptVerifier;
  readonly kernelReceipts: KernelReceiptVerifier;
  readonly poolLeases: PoolLeaseBackend;
}

/**
 * No authenticated browser/desktop adapter is linked in this composition
 * root. Keep the unavailable value explicit: a kernel socket alone cannot
 * prove observation verification, settlement verification, or pool leases.
 */
function resolveTrustedComputerUseBackend(): TrustedComputerUseBackend | null {
  return null;
}

const trustedComputerUseBackend = resolveTrustedComputerUseBackend();
const governedComputerUseCoordinator: GovernedComputerUseCoordinator | null =
  trustedComputerUseBackend === null
    ? null
    : new GovernedComputerUseCoordinator({
      observationReceipts: trustedComputerUseBackend.observationReceipts,
      kernelReceipts: trustedComputerUseBackend.kernelReceipts,
    });
const poolManager = new BrowserDesktopPoolManager(trustedComputerUseBackend?.poolLeases ?? null);
const connectorLibrary = new ExternalConnectorLibrary();
const incidentRunner = new IncidentProfileRunner();
const researchRunner = new ResearchProfileRunner();
const acpContextSyncs = new Map<ContentHash, unknown>();

// Explicit coordinator-only pool. No browser or desktop execution backend is bundled.
poolManager.registerPool({
  poolId: "default-browser-pool",
  kind: "browser",
  sandboxTier: "tier2_hardened_container",
  capacity: 1,
  activeLeasesCount: 0,
  endpoint: "coordinator://unconfigured",
  healthStatus: "degraded",
  runtimeConfig: {
    reason: "No kernel-backed browser or desktop lease backend is configured",
  },
  executionSupport: "coordinator_only",
  enforcementStatus: "unverified",
});

incidentRunner.registerProfile({
  profileId: "default-incident-profile",
  organizationId: "default-org",
  departmentId: "incident-response",
  auditLevel: "forensic",
  maxActionTimeoutMs: 15000,
  mandatoryCompensation: true,
  allowedDiagnostics: ["collect_logs", "inspect_health", "capture_state"],
  autoEscalateOnFailure: true,
});

researchRunner.registerProfile({
  profileId: "default-research-profile",
  organizationId: "default-org",
  departmentId: "research",
  allowMultiSourceRetrieval: true,
  notebookSandboxEnabled: false,
  strictProvenanceTracking: true,
  citationFormat: "apa",
  maxSearchQueries: 5,
});


interface EmitInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  actor?: { kind: string; id: string };
  correlationId?: string | undefined;
  causationId?: string | null | undefined;
  idempotencyKey?: string | null | undefined;
  payload: unknown;
  artifactRefs?: string[] | undefined;
  traceId?: string | null | undefined;
}

function pendingEvent(params: EmitInput): PendingStoredEvent {
  return {
    schemaVersion: 1,
    eventType: params.eventType,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    occurredAt: new Date(),
    actorJson: JSON.stringify(params.actor ?? { kind: "system", id: "terminus-control" }),
    correlationId: params.correlationId ?? randomUUID(),
    causationId: params.causationId ?? null,
    idempotencyKey: params.idempotencyKey ?? null,
    payloadJson: JSON.stringify(params.payload),
    artifactRefsJson: JSON.stringify(params.artifactRefs ?? []),
    traceId: params.traceId ?? null,
  };
}

async function emit(
  params: EmitInput,
  mutation?: (tx: Prisma.TransactionClient, event: StoredEvent) => Promise<void>,
): Promise<StoredEvent> {
  const pending = pendingEvent(params);
  if (mutation === undefined) {
    return bus.publish(pending);
  }
  return bus.publishAtomically(pending, mutation);
}

async function emitAtomicBatch(
  params: readonly EmitInput[],
  mutation: (tx: Prisma.TransactionClient, events: readonly StoredEvent[]) => Promise<void>,
): Promise<readonly StoredEvent[]> {
  return bus.publishManyAtomically(params.map(pendingEvent), mutation);
}

// ────────────────────────── Helpers ────────────────────────────────────────

function now(): Rfc3339Timestamp { return new Date().toISOString() as Rfc3339Timestamp; }

function uuid(): string { return randomUUID(); }

/** Extract the scope labels (top-level keys + path values) from an approval scope object. */
function scopeKeys(scope: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(scope)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.length > 0) out.push(`${key}:${entry}`);
      }
    } else if (typeof value === "string" && value.length > 0) {
      out.push(`${key}:${value}`);
    } else {
      out.push(key);
    }
  }
  return out;
}

function decodeApprovalOperation(approval: Pick<PrismaApproval, "operationHash" | "operationJson">): ApprovalOperationRecord | null {
  if (!approval.operationJson) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(approval.operationJson) as unknown;
  } catch {
    return null;
  }
  const parsed = ApprovalOperationV1.safeParse(raw);
  if (!parsed.success) return null;
  const computedHash = computeContentHash(canonicalApprovalBinding(parsed.data.binding));
  return constantTimeEqual(computedHash, approval.operationHash) ? parsed.data : null;
}

function approvalScope(approval: Pick<PrismaApproval, "operationHash" | "operationJson" | "scopeJson">): string[] {
  const operation = decodeApprovalOperation(approval);
  if (operation) {
    return [...new Set([
      ...operation.binding.resources,
      ...operation.binding.destinations,
      ...operation.binding.secret_scope.map((scope) => `secret:${scope}`),
    ])];
  }
  try {
    return scopeKeys(JSON.parse(approval.scopeJson) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function approvalWire(approval: PrismaApproval): Record<string, unknown> {
  const operation = decodeApprovalOperation(approval);
  let riskClass = "unknown";
  if (operation) {
    riskClass = operation.binding.risk.class;
  } else {
    try {
      const parsedRisk = JSON.parse(approval.riskJson) as { class?: unknown };
      if (typeof parsedRisk.class === "string") riskClass = parsedRisk.class;
    } catch {
      // Legacy or corrupt rows remain visibly untrusted.
    }
  }
  return {
    id: approval.id,
    task_id: approval.taskId,
    operation_hash: approval.operationHash,
    binding: operation?.binding ?? null,
    display: operation?.display ?? null,
    status: approval.status,
    decision: approval.decision,
    // A tool call parked on this approval (permission-profile gate) can be
    // released or refused. Approvals with nothing parked on them can only be
    // refused: an allow with no effect behind it would claim an authorization
    // nothing used.
    supported_decisions: approval.toolCallId === null
      ? ["deny_once"]
      : ["allow_once", "allow_for_task", "deny_once"],
    risk: riskClass,
    scope: approvalScope(approval),
    use_limit: approval.useLimit,
    use_count: approval.useCount,
    expires_at: approval.expiresAt?.toISOString() ?? null,
    requested_at: approval.requestedAt.toISOString(),
    resolved_at: approval.resolvedAt?.toISOString() ?? null,
    rationale: approval.rationale,
  };
}

interface TaskContractHashInput {
  readonly version: number;
  readonly objective: string;
  readonly userOutcome: string | null;
  readonly nonGoals: readonly unknown[];
  readonly constraints: readonly unknown[];
  readonly assumptions: readonly unknown[];
  readonly unknowns: readonly unknown[];
  readonly allowedScope: unknown;
  readonly changePolicy: unknown;
}

function taskContractHash(input: TaskContractHashInput): ContentHash {
  return computeContentHash(canonicalJson(input));
}

const V1_MUTABLE_TASK_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "NEEDS_USER_DECISION",
  "BLOCKED",
  "VERIFYING",
] as const;

const V1_ACTIVE_TURN_STATES = [
  "PENDING",
  "CONTEXT_COMPILING",
  "PROVIDER_RUNNING",
  "RESPONSE_VALIDATING",
  "TOOL_SETTLEMENT",
  "VERIFYING",
  "REPAIRING",
  "FINALIZING",
] as const;

const V1_NONTERMINAL_TURN_STATES = [
  ...V1_ACTIVE_TURN_STATES,
  "REPAIR_PENDING",
  "VERIFIED",
] as const;

const V1_NONTERMINAL_JOB_STATES = [
  "CREATED",
  "STARTING",
  "RUNNING",
  "STOPPING",
  "KILLING",
  "ORPHANED",
  "REATTACHED",
] as const;

function isNonterminalJobState(state: string): boolean {
  return V1_NONTERMINAL_JOB_STATES.some((candidate) => candidate === state);
}

function isMutableV1TaskStatus(status: string): boolean {
  return V1_MUTABLE_TASK_STATUSES.some((candidate) => candidate === status);
}

/** In-process handles for the durable cancellation request of each live turn. */
const activeTurnAbortControllers = new Map<string, AbortController>();

function abortActiveTurn(turnId: string, reason: string): boolean {
  const controller = activeTurnAbortControllers.get(turnId);
  if (controller === undefined) return false;
  controller.abort(reason);
  return true;
}

/** Per-request raw body cache so auth/idempotency/handler can all read it. */
const bodyCache = new WeakMap<IncomingMessage, Buffer>();

class RequestBodyTooLargeError extends Error {
  constructor(readonly observedBytes: number) {
    super(`request body exceeded ${MAX_REQUEST_BYTES} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const cached = bodyCache.get(req);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (rejected) return;
      if (bytes > MAX_REQUEST_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError(bytes));
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (rejected) return;
      const buf = Buffer.concat(chunks);
      bodyCache.set(req, buf);
      resolve(buf);
    });
  });
}

function jsonBody(req: IncomingMessage): Promise<unknown> {
  return readRawBody(req).then((buf) => {
    if (buf.length === 0) return {};
    return JSON.parse(buf.toString("utf8"));
  });
}

function sha256Hex(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function getTraceId(req: IncomingMessage): string {
  const tp = req.headers["traceparent"];
  if (typeof tp === "string" && tp.length > 0) return tp;
  const tid = req.headers["x-trace-id"];
  if (typeof tid === "string" && tid.length > 0) return tid;
  return randomUUID();
}

function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return false;
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length);
  return constantTimeEqual(token, CONTROL_TOKEN);
}

function isMutating(method: string | undefined): boolean {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

function auditAuthorized(
  req: IncomingMessage,
  url: URL,
  params: Record<string, string>,
  traceId: string,
): void {
  // SPEC §31.3 step 10 — log an `authorized` audit event before any effect.
  // `task_id` is only populated when the route is under /v1/tasks/:id (so
  // the value is genuinely a task ID, not a session/turn/job ID).
  const taskId = url.pathname.startsWith("/v1/tasks/") ? (params.id ?? null) : null;
  const log = {
    event: "authorized",
    method: req.method ?? "GET",
    path: url.pathname,
    actor: SERVER_PRINCIPAL,
    task_id: taskId,
    trace_id: traceId,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(log));
}

// ────────────────────────── Idempotency ────────────────────────────────────

/**
 * Per-response capture so the idempotency wrapper can store the exact
 * bytes the handler produced. Only attached for mutating routes.
 */
interface CapturedResponse {
  status: number;
  body: Buffer;
}

interface StoredIdempotencyResponseV1 {
  format: "terminus.idempotency.response.v1";
  status: number;
  bodyBase64: string;
}

const captureMap = new WeakMap<ServerResponse, CapturedResponse>();

function attachCapture(res: ServerResponse): void {
  captureMap.set(res, { status: 0, body: Buffer.alloc(0) });
}

function recordCapture(res: ServerResponse, status: number, body: Buffer): boolean {
  const cap = captureMap.get(res);
  if (!cap) return false;
  cap.status = status;
  cap.body = body;
  return true;
}

function popCapture(res: ServerResponse): CapturedResponse | null {
  const cap = captureMap.get(res);
  if (!cap) return null;
  captureMap.delete(res);
  return cap;
}

function decodeStoredIdempotencyResponse(value: unknown): CapturedResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<StoredIdempotencyResponseV1>;
  if (
    record.format !== "terminus.idempotency.response.v1" ||
    typeof record.status !== "number" ||
    !Number.isSafeInteger(record.status) ||
    record.status < 100 ||
    record.status > 599 ||
    typeof record.bodyBase64 !== "string"
  ) return null;
  return { status: record.status, body: Buffer.from(record.bodyBase64, "base64") };
}

function normalizedRequestHash(req: IncomingMessage, body: Buffer): string {
  const target = new URL(req.url ?? "/", "http://terminus.local");
  target.searchParams.sort();
  const query = target.searchParams.toString();
  const requestTarget = `${target.pathname}${query ? `?${query}` : ""}`;
  return sha256Hex(Buffer.concat([Buffer.from(requestTarget, "utf8"), Buffer.from([0]), body]));
}

/**
 * SPEC §30.5. For mutating requests with an `Idempotency-Key` header:
 *   - same key + same body → return cached response
 *   - same key + different body → return 409 IDEMPOTENCY_KEY_CONFLICT
 *   - new key → insert `pending`, run handler, store result as `completed`
 *
 * Returns `true` if the handler should run, `false` if a response has
 * already been sent (replay, conflict, or in-flight).
 *
 * When returning `true`, a capture is attached to `res`; the caller MUST
 * invoke `commitIdempotency(...)` after the handler completes.
 */
async function withIdempotency(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  traceId: string,
): Promise<boolean> {
  const keyHeader = req.headers["idempotency-key"];
  const key = Array.isArray(keyHeader) ? (keyHeader[0] ?? null) : keyHeader;
  if (typeof key !== "string" || key.trim().length === 0 || key.length > 255) {
    sendError(
      res,
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "mutating requests require a non-empty Idempotency-Key of at most 255 characters",
      "validation",
      { header: "Idempotency-Key", trace_id: traceId },
    );
    return false;
  }
  let buf: Buffer;
  try {
    buf = await readRawBody(req);
  } catch (error: unknown) {
    const tooLarge = error instanceof RequestBodyTooLargeError;
    sendError(res, tooLarge ? 413 : 400, tooLarge ? "REQUEST_BODY_TOO_LARGE" : "INVALID_REQUEST_BODY", tooLarge
      ? `request body exceeds the ${MAX_REQUEST_BYTES}-byte limit`
      : "request body could not be read", "validation", {
      error: String(error),
      trace_id: traceId,
      max_request_bytes: MAX_REQUEST_BYTES,
    });
    return false;
  }
  const hash = normalizedRequestHash(req, buf);

  let existing: IdempotencyRecord | null;
  try {
    existing = await db.idempotencyRecord.findUnique({
      where: {
        principal_method_idempotencyKey: {
          principal: SERVER_PRINCIPAL,
          method,
          idempotencyKey: key,
        },
      },
    });
  } catch (error: unknown) {
    sendError(res, 503, "IDEMPOTENCY_UNAVAILABLE", "idempotency storage is unavailable", "external_dependency", {
      idempotency_key: key,
      trace_id: traceId,
      error: String(error),
    });
    return false;
  }

  if (existing && existing.expiresAt.getTime() <= Date.now()) {
    try {
      await writerTransaction(async (tx) => {
        await tx.idempotencyRecord.delete({
          where: {
            principal_method_idempotencyKey: {
              principal: SERVER_PRINCIPAL,
              method,
              idempotencyKey: key,
            },
          },
        });
      });
      existing = null;
    } catch (error: unknown) {
      sendError(res, 503, "IDEMPOTENCY_UNAVAILABLE", "expired idempotency state could not be renewed", "external_dependency", {
        idempotency_key: key,
        trace_id: traceId,
        error: String(error),
      });
      return false;
    }
  }

  if (existing) {
    if (existing.requestHash !== hash) {
      sendError(
        res,
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
        "idempotency key reused with a different request body",
        "conflict",
        { idempotency_key: key },
      );
      return false;
    }
    // Same key + same body → replay the stored response.
    if (existing.state === "completed") {
      if (existing.errorJson) {
        try {
          const err = JSON.parse(existing.errorJson) as {
            status: number; code: string; message: string; category: string;
            details?: Record<string, unknown>;
          };
          if (
            !Number.isInteger(err.status)
            || err.status < 400
            || err.status > 599
            || typeof err.code !== "string"
            || err.code.length === 0
            || typeof err.message !== "string"
            || typeof err.category !== "string"
          ) throw new Error("invalid stored idempotency error");
          sendError(res, err.status, err.code, err.message, err.category, err.details ?? {});
        } catch {
          sendError(
            res,
            409,
            "IDEMPOTENCY_REPLAY_INTEGRITY_FAILED",
            "the stored mutation outcome is corrupt and requires reconciliation",
            "unknown_settlement",
            { idempotency_key: key, reconciliation_required: true },
          );
        }
      } else {
        try {
          const artifact = existing.responseArtifact
            ? (JSON.parse(existing.responseArtifact) as unknown)
            : null;
          const stored = decodeStoredIdempotencyResponse(artifact);
          if (stored === null) throw new Error("invalid stored idempotency response");
          sendJsonBuffer(res, stored.status, stored.body);
        } catch {
          sendError(
            res,
            409,
            "IDEMPOTENCY_REPLAY_INTEGRITY_FAILED",
            "the stored mutation outcome is corrupt and requires reconciliation",
            "unknown_settlement",
            { idempotency_key: key, reconciliation_required: true },
          );
        }
      }
      return false;
    }
    // Still in-flight — ask the client to retry.
    sendError(
      res,
      409,
      "IDEMPOTENCY_IN_PROGRESS",
      "a request with the same idempotency key is still in-flight",
      "conflict",
      { idempotency_key: key, retry_after_ms: 500 },
    );
    return false;
  }

  // No prior record — insert pending, attach capture, let caller run handler.
  try {
    await writerTransaction(async (tx) => {
      await tx.idempotencyRecord.create({
        data: {
          principal: SERVER_PRINCIPAL,
          method,
          idempotencyKey: key,
          requestHash: hash,
          state: "pending",
          responseArtifact: null,
          errorJson: null,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        },
      });
    });
  } catch (error: unknown) {
    sendError(res, 503, "IDEMPOTENCY_UNAVAILABLE", "idempotency operation could not be reserved", "external_dependency", {
      idempotency_key: key,
      trace_id: traceId,
      error: String(error),
    });
    return false;
  }
  attachCapture(res);
  return true;
}

async function commitIdempotency(
  res: ServerResponse,
  method: string,
  key: string,
): Promise<CapturedResponse> {
  const cap = popCapture(res);
  if (!cap || cap.status < 100) {
    throw new Error("mutating handler completed without a captured JSON response");
  }
  const stored: StoredIdempotencyResponseV1 = {
    format: "terminus.idempotency.response.v1",
    status: cap.status,
    bodyBase64: cap.body.toString("base64"),
  };
  await writerTransaction(async (tx) => {
    await tx.idempotencyRecord.update({
      where: {
        principal_method_idempotencyKey: {
          principal: SERVER_PRINCIPAL,
          method,
          idempotencyKey: key,
        },
      },
      data: {
        state: "completed",
        responseArtifact: JSON.stringify(stored),
        errorJson: null,
      },
    });
  });
  return cap;
}

/** Convert crash-stranded reservations into explicit unknown settlements. */
async function reconcilePendingIdempotencyReservations(): Promise<number> {
  const outcome = await writerTransaction((tx) => tx.idempotencyRecord.updateMany({
    where: { state: "pending" },
    data: {
      state: "completed",
      responseArtifact: null,
      errorJson: JSON.stringify({
        status: 409,
        code: "IDEMPOTENCY_OUTCOME_UNKNOWN",
        message: "the previous process stopped before recording the mutation outcome",
        category: "unknown_settlement",
        details: { reconciliation_required: true },
      }),
    },
  }));
  return outcome.count;
}

// ────────────────────────── HTTP response helpers ─────────────────────────

function sendJsonBuffer(res: ServerResponse, status: number, buf: Buffer): void {
  const headers = {
    "content-type": "application/json",
    "content-length": String(buf.length),
    "access-control-allow-origin": CONTROL_CORS_ORIGIN,
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-allow-methods": CORS_ALLOW_METHODS,
    "vary": "origin",
  };
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  if (recordCapture(res, status, buf)) return;
  sendJsonBuffer(res, status, buf);
}

function logInternalError(operation: string, error: unknown): void {
  console.error(`[terminus-control] ${operation}`, error);
}

/**
 * H6: a 500 the caller can correlate. The response never echoes the error text
 * (a Prisma dump discloses source paths and query shapes), but it carries the
 * same `trace_id` the log line does, plus the error's own name/code so the
 * caller can tell a transport fault from a bug without reading server logs.
 */
function sendInternalError(
  res: ServerResponse,
  code: string,
  message: string,
  operation: string,
  error: unknown,
): void {
  const traceId = randomUUID();
  console.error(`[terminus-control] ${operation} trace_id=${traceId}`, error);
  const classified = classifyLoopError(error);
  sendError(res, 500, code, message, "internal", {
    trace_id: traceId,
    cause: {
      code: classified.envelope.code,
      category: classified.envelope.category,
      message: classified.envelope.message,
      retryable: classified.envelope.retryable,
      details: classified.envelope.details,
    },
  });
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  category: string,
  details: Record<string, unknown> = {},
): void {
  sendJson(res, status, {
    error: {
      code,
      message,
      retryable:
        category === "timeout" ||
        category === "external_dependency" ||
        category === "internal",
      category,
      details,
      suggested_action: null,
      trace_id: randomUUID(),
    },
  });
}

function domainErrorStatus(error: DomainForgeError): number {
  switch (error.category) {
    case "validation": return 400;
    case "not_found": return 404;
    case "conflict":
    case "approval_required":
    case "cancelled":
    case "unknown_settlement": return 409;
    case "permission":
    case "policy_denied": return 403;
    case "resource_exhausted":
    case "budget_exhausted": return 429;
    case "sandbox_unavailable":
    case "provider":
    case "external_dependency":
    case "timeout": return 503;
    case "integrity":
    case "internal": return 500;
  }
}

function sendCaughtError(res: ServerResponse, error: unknown): void {
  if (error instanceof ControlWriterFencedError) {
    sendError(
      res,
      503,
      "CONTROL_WRITER_FENCED",
      error.message,
      "external_dependency",
    );
    return;
  }
  if (error instanceof RequestBodyTooLargeError) {
    sendError(
      res,
      413,
      "REQUEST_BODY_TOO_LARGE",
      `request body exceeds the ${MAX_REQUEST_BYTES}-byte limit`,
      "validation",
      { max_request_bytes: MAX_REQUEST_BYTES, observed_bytes: error.observedBytes },
    );
    return;
  }
  if (error instanceof DomainForgeError) {
    sendJson(res, domainErrorStatus(error), error.toEnvelope());
    return;
  }
  if (error instanceof z.ZodError) {
    sendError(
      res,
      400,
      "VALIDATION_FAILED",
      "request or response did not satisfy the public v2 schema",
      "validation",
      { issues: error.issues },
    );
    return;
  }
  // Never echo an unhandled error's message to the client. Prisma failures in
  // particular render a multi-line dump carrying absolute source paths, line
  // numbers, the generated query shape, and column names — that is information
  // disclosure on a public route. The full error is logged against the same
  // trace_id the caller receives, so operators lose nothing.
  const traceId = randomUUID();
  console.error(`[terminus-control] unhandled request error trace_id=${traceId}`, error);
  sendError(
    res,
    500,
    "INTERNAL",
    "the control plane failed to complete this request",
    "internal",
    { trace_id: traceId },
  );
}

interface PageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

function parsePageRequest(req: IncomingMessage, res: ServerResponse, defaultLimit = 100): PageRequest | null {
  const url = new URL(req.url ?? "/", "http://terminus.local");
  const cursor = url.searchParams.get("cursor");
  const limitValue = url.searchParams.get("limit");
  if (cursor !== null && !/^[a-zA-Z0-9._:-]{1,255}$/.test(cursor)) {
    sendError(res, 400, "INVALID_CURSOR", "cursor was not a valid opaque collection cursor", "validation");
    return null;
  }
  if (limitValue !== null && !/^[1-9][0-9]*$/.test(limitValue)) {
    sendError(res, 400, "INVALID_PAGE_LIMIT", "limit must be a positive decimal integer", "validation");
    return null;
  }
  const requestedLimit = limitValue === null ? defaultLimit : Number(limitValue);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit > 200) {
    sendError(res, 400, "INVALID_PAGINATION", "limit must be a safe integer no greater than 200", "validation");
    return null;
  }
  return { cursor, limit: requestedLimit };
}

function nextPageCursor<T extends { id: string }>(rows: readonly T[], limit: number): string | null {
  return rows.length > limit ? rows[limit - 1]?.id ?? null : null;
}

/** Validate the serialized public response, including bigint wire transforms. */
function sendV2Response(res: ServerResponse, status: number, schema: z.ZodType, value: unknown): void {
  const serialized = jsonSafe(value);
  sendJson(res, status, schema.parse(serialized));
}

// ────────────────────────── Approval decision reconciliation ───────────────

/**
 * SPEC §32.4. Accept BOTH naming conventions used across the codebase:
 *   - public-api: allow_once | allow_exact | allow_task_scope | deny_once |
 *                 deny_and_rule | stop_task
 *   - domain:     allow_once | allow_for_action | allow_for_task | deny_once |
 *                 deny_and_add_task_rule | stop_task
 * and map them to the canonical domain names. Unknown values return null.
 */
function normalizeApprovalDecision(raw: string): string | null {
  switch (raw) {
    case "allow_once":
      return "allow_once";
    case "allow_exact":
    case "allow_for_action":
      return "allow_for_action";
    case "allow_task_scope":
    case "allow_for_task":
      return "allow_for_task";
    case "deny_once":
      return "deny_once";
    case "deny_and_rule":
    case "deny_and_add_task_rule":
      return "deny_and_add_task_rule";
    case "stop_task":
      return "stop_task";
    default:
      return null;
  }
}

// ────────────────────────── ARP v2 canonical domain (SPEC §5–§16) ──────────

/**
 * Canonical ARP v2 aggregate store.
 *
 * Aggregates live in memory and are event-sourced through the semantic
 * event log (`semantic_events` rows with `schemaVersion = 2`): every
 * mutation emits a v2 envelope whose payload carries the full post-state
 * snapshot, and startup replays those rows to rebuild state across
 * restarts. This keeps the canonical domain durable without widening the
 * Prisma schema; dedicated v2 tables remain future work.
 *
 * Wire encoding: `Micros` bigint values are decimal strings in JSON
 * (JSON has no bigint); request bodies may send them as strings or
 * numbers and they are coerced back to bigint at this boundary.
 */

/** Deep transform: bigint → decimal string so JSON.stringify is total. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

const microsWireSchema = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative(),
]).transform((v) => BigInt(v));

/** Request-body contract schema: identical to the domain schema except that costMicros accepts JSON-safe input. */
const taskContractV2WireSchema = taskContractV2Schema.extend({
  constraints: taskContractV2Schema.shape.constraints.extend({ costMicros: microsWireSchema }),
});

const taskV2ReviveSchema = taskV2Schema.extend({ contract: taskContractV2WireSchema });
const artifactRefReviveSchema = artifactRefSchema.extend({ bytes: microsWireSchema });
const evidenceReviveSchema = evidenceSchema.extend({
  artifactRef: artifactRefReviveSchema.nullable(),
});
const budgetConsumptionReviveSchema = budgetConsumptionSchema.extend({
  consumedCostMicros: microsWireSchema,
  consumedInputTokens: microsWireSchema,
  consumedOutputTokens: microsWireSchema,
});

const arpV2ReplaySchemas = {
  task: taskV2ReviveSchema,
  effect: effectRecordSchema,
  authorization: authorizationInstanceSchema,
  claim: claimSchema,
  evidence: evidenceReviveSchema,
  question: questionSchema,
  decision: decisionSchema,
  workflow: workflowSchema,
  node_run: nodeRunSchema,
  lease: workerLeaseSchema,
  attempt: taskAttemptSchema,
  risk: riskSchema,
  budget: budgetConsumptionReviveSchema,
} as const satisfies Readonly<Record<string, z.ZodType>>;

interface ArpV2State {
  tasks: Map<string, TaskV2>;
  effects: Map<string, EffectRecord>;
  authorizations: Map<string, AuthorizationInstance>;
  claims: Map<string, Claim>;
  evidences: Map<string, Evidence>;
  questions: Map<string, Question>;
  decisions: Map<string, Decision>;
  workflows: Map<string, Workflow>;
  nodeRuns: Map<string, NodeRun>;
  workerLeases: Map<string, WorkerLease>;
  attempts: Map<string, TaskAttempt>;
  risks: Map<string, Risk>;
  budgets: Map<string, BudgetConsumption>;
}

const arpV2: ArpV2State = {
  tasks: new Map(),
  effects: new Map(),
  authorizations: new Map(),
  claims: new Map(),
  evidences: new Map(),
  questions: new Map(),
  decisions: new Map(),
  workflows: new Map(),
  nodeRuns: new Map(),
  workerLeases: new Map(),
  attempts: new Map(),
  risks: new Map(),
  budgets: new Map(),
};

const cronJobs = new Map<string, CronJob>();

function arpV2StoreFor(aggregateType: string): Map<string, unknown> | null {
  switch (aggregateType) {
    case "task": return arpV2.tasks as Map<string, unknown>;
    case "effect": return arpV2.effects as Map<string, unknown>;
    case "authorization": return arpV2.authorizations as Map<string, unknown>;
    case "claim": return arpV2.claims as Map<string, unknown>;
    case "evidence": return arpV2.evidences as Map<string, unknown>;
    case "question": return arpV2.questions as Map<string, unknown>;
    case "decision": return arpV2.decisions as Map<string, unknown>;
    case "workflow": return arpV2.workflows as Map<string, unknown>;
    case "node_run": return arpV2.nodeRuns as Map<string, unknown>;
    case "lease": return arpV2.workerLeases as Map<string, unknown>;
    case "attempt": return arpV2.attempts as Map<string, unknown>;
    case "risk": return arpV2.risks as Map<string, unknown>;
    case "budget": return arpV2.budgets as Map<string, unknown>;
    default: return null;
  }
}

/**
 * Emit a canonical ARP v2 envelope. The full post-state snapshot rides in
 * the payload so the event log alone reconstructs the aggregate store.
 */
async function emitV2(params: {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  snapshot: unknown;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  mutation?: ((tx: Prisma.TransactionClient, event: StoredEvent) => Promise<void>) | undefined;
}): Promise<void> {
  const pending: PendingStoredEvent = {
    schemaVersion: 2,
    eventType: params.eventType,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    occurredAt: new Date(),
    actorJson: JSON.stringify({ kind: "system", id: SERVER_PRINCIPAL }),
    correlationId: params.correlationId ?? params.aggregateId,
    causationId: null,
    idempotencyKey: params.idempotencyKey ?? null,
    // ARP v2 envelopes carry the aggregate post-state directly in payload.
    // Keeping a second { snapshot } wrapper makes the wire contract disagree
    // with the generated envelope schema and forces every consumer to guess.
    payloadJson: JSON.stringify(jsonSafe(params.snapshot)),
    artifactRefsJson: JSON.stringify([]),
    traceId: null,
  };
  if (params.mutation) {
    await bus.publishAtomically(pending, params.mutation);
  } else {
    await bus.publish(pending);
  }
}

/** Rebuild the in-memory v2 aggregates from the persisted event log. */
async function replayArpV2(): Promise<void> {
  const rows: Array<{
    eventId: string;
    schemaVersion: number;
    aggregateType: string;
    aggregateId: string;
    aggregateSequence: number;
    payloadJson: string;
  }> = [];
  let cursor: string | null = null;
  for (;;) {
    const page: Array<{
      eventId: string;
      schemaVersion: number;
      aggregateType: string;
      aggregateId: string;
      aggregateSequence: number;
      payloadJson: string;
    }> = await db.semanticEvent.findMany({
      orderBy: { eventId: "asc" },
      take: 1_000,
      ...(cursor === null ? {} : { cursor: { eventId: cursor }, skip: 1 }),
      select: {
        eventId: true,
        schemaVersion: true,
        aggregateType: true,
        aggregateId: true,
        aggregateSequence: true,
        payloadJson: true,
      },
    });
    rows.push(...page);
    if (page.length < 1_000) break;
    cursor = page.at(-1)?.eventId ?? null;
    if (cursor === null) throw new Error("ARP v2 replay pagination lost its continuation cursor");
  }
  bus.initializeFromHistory(rows);
  for (const row of rows) {
    if (row.schemaVersion !== 2) continue;
    const store = arpV2StoreFor(row.aggregateType);
    if (!store) continue;
    const schema = arpV2ReplaySchemas[row.aggregateType as keyof typeof arpV2ReplaySchemas];
    if (!schema) {
      console.error(`[terminus-control] ignored ARP v2 event ${row.eventId}: no schema for ${row.aggregateType}`);
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson) as unknown;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[terminus-control] ignored ARP v2 event ${row.eventId}: invalid JSON (${detail})`);
      continue;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      console.error(`[terminus-control] ignored ARP v2 event ${row.eventId}: missing aggregate snapshot`);
      continue;
    }
    // Accept the pre-contract wrapper during restart migration, but all new
    // events are emitted with the direct payload shape above.
    const snapshot = "snapshot" in payload
      ? (payload as { readonly snapshot: unknown }).snapshot
      : payload;
    const revived = schema.safeParse(snapshot);
    if (!revived.success) {
      const issues = revived.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "snapshot"}: ${issue.message}`)
        .join("; ");
      console.error(`[terminus-control] ignored ARP v2 event ${row.eventId}: invalid ${row.aggregateType} snapshot (${issues})`);
      continue;
    }
    const snapshotRecord = revived.data as Readonly<Record<string, unknown>>;
    const snapshotId = row.aggregateType === "budget"
      ? snapshotRecord.taskId
      : snapshotRecord.id;
    if (snapshotId !== row.aggregateId) {
      console.error(
        `[terminus-control] ignored ARP v2 event ${row.eventId}: snapshot identity ${String(snapshotId)} does not match aggregate ${row.aggregateId}`,
      );
      continue;
    }
    const previous = store.get(row.aggregateId) as Readonly<Record<string, unknown>> | undefined;
    const previousVersion = previous?.version;
    const nextVersion = snapshotRecord.version;
    if (
      typeof previousVersion === "number"
      && typeof nextVersion === "number"
      && nextVersion <= previousVersion
    ) {
      console.error(
        `[terminus-control] ignored ARP v2 event ${row.eventId}: snapshot version ${nextVersion} does not advance past ${previousVersion}`,
      );
      continue;
    }
    store.set(row.aggregateId, revived.data);
  }
  console.log(`[terminus-control] arp-v2 replay: ${arpV2.tasks.size} tasks, ${arpV2.effects.size} effects, ${arpV2.claims.size} claims, ${arpV2.workflows.size} workflows, ${arpV2.workerLeases.size} leases`);
}

function v1TaskStatusToV2(status: string): TaskV2["status"] {
  switch (status) {
    case "DRAFT": return "DRAFT";
    case "ACTIVE": return "RUNNING";
    case "NEEDS_USER_DECISION": return "WAITING_USER";
    case "BLOCKED": return "BLOCKED";
    case "VERIFYING": return "VERIFYING";
    case "COMPLETED": return "COMPLETED";
    case "ABORTED": return "CANCELLED";
    case "FAILED":
    case "FAILED_VERIFICATION":
    case "BUDGET_EXHAUSTED":
    case "POLICY_DENIED":
      return "FAILED";
    default:
      return "BLOCKED";
  }
}

function v2TaskStatusToV1(status: TaskV2["status"]): {
  readonly status: string;
  readonly phase: string;
  readonly completedAt: Date | null;
} {
  switch (status) {
    case "DRAFT":
    case "READY":
      return { status: "DRAFT", phase: "INTAKE", completedAt: null };
    case "RUNNING":
      return { status: "ACTIVE", phase: "IMPLEMENT", completedAt: null };
    case "WAITING_USER":
    case "WAITING_AUTH":
      return { status: "NEEDS_USER_DECISION", phase: "IMPLEMENT", completedAt: null };
    case "WAITING_RESOURCE":
    case "PAUSED":
    case "BLOCKED":
      return { status: "BLOCKED", phase: "IMPLEMENT", completedAt: null };
    case "VERIFYING":
      return { status: "VERIFYING", phase: "VERIFY", completedAt: null };
    case "COMPLETED":
      return { status: "COMPLETED", phase: "COMPLETE", completedAt: new Date() };
    case "CANCELLED":
      return { status: "ABORTED", phase: "COMPLETE", completedAt: new Date() };
    case "PARTIAL":
    case "FAILED":
      return { status: "FAILED", phase: "COMPLETE", completedAt: new Date() };
  }
}

async function projectV2StatusIntoV1(
  tx: Prisma.TransactionClient,
  taskId: string,
  status: TaskV2["status"],
): Promise<void> {
  const v1Task = await tx.task.findUnique({
    where: { id: taskId },
    select: { id: true, status: true },
  });
  if (!v1Task) return;
  if (!isMutableV1TaskStatus(v1Task.status) && !v1AndV2StatusesAgree(v1Task.status, status)) {
    throw new Error(`terminal v1 task ${taskId} cannot be projected from ${v1Task.status} to ${status}`);
  }
  const projection = v2TaskStatusToV1(status);
  const updated = await tx.task.updateMany({
    where: { id: taskId, status: v1Task.status },
    data: {
      status: projection.status,
      phase: projection.phase,
      completedAt: projection.completedAt,
      terminalReasonJson: projection.completedAt === null
        ? null
        : JSON.stringify({ reason: `arp_v2_${status.toLowerCase()}` }),
    },
  });
  if (updated.count !== 1) {
    throw new Error(`v1 task ${taskId} changed during v2 status projection`);
  }
}

interface V1AllowedScopeProjection {
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
  readonly external_systems: readonly string[];
}

function v1AllowedScopeProjection(value: unknown): V1AllowedScopeProjection {
  return parseProjectionAllowedScope(value);
}

function scopeExpansionResources(
  previous: V1AllowedScopeProjection,
  next: V1AllowedScopeProjection,
): readonly string[] {
  return projectionScopeExpansionResources(previous, next);
}

function scopeLedgerRows(input: {
  readonly taskId: string;
  readonly contractVersion: number;
  readonly scope: V1AllowedScopeProjection;
  readonly source: string;
  readonly reason: string;
  readonly approvalId?: string | null;
}): Array<{
  id: string;
  taskId: string;
  contractVersion: number;
  resourceUri: string;
  accessClass: string;
  source: string;
  reason: string;
  approvalId: string | null;
}> {
  const row = (resourceUri: string, accessClass: string) => ({
    id: uuid(),
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    resourceUri,
    accessClass,
    source: input.source,
    reason: input.reason,
    approvalId: input.approvalId ?? null,
  });
  return [
    ...input.scope.read_paths.map((path) => row(`workspace:${path}`, "read_allowed")),
    ...input.scope.write_paths.map((path) => row(`workspace:${path}`, "write_allowed")),
    ...input.scope.external_systems.map((system) => row(`external:${system}`, "external_effective")),
  ];
}

class TaskLineageAdmissionError extends Error {
  constructor(
    readonly reason: "thread_not_found" | "session_mismatch",
    readonly actualSessionId: string | null = null,
  ) {
    super(reason);
    this.name = "TaskLineageAdmissionError";
  }
}

function v2PathScopeProjection(contract: TaskContractV2): V1AllowedScopeProjection {
  return projectionV2PathScopeProjection(contract);
}

function derivedV2Authority(scope: V1AllowedScopeProjection): {
  readonly allowedEffectClasses: readonly string[];
  readonly authorityCeiling: readonly string[];
} {
  const allowedEffectClasses: string[] = [];
  const authorityCeiling: string[] = [];
  if (scope.read_paths.length > 0) {
    allowedEffectClasses.push("LOCAL_FS_READ");
    authorityCeiling.push("FS_READ");
  }
  if (scope.write_paths.length > 0) {
    allowedEffectClasses.push("LOCAL_FS_WRITE");
    authorityCeiling.push("FS_WRITE");
  }
  return { allowedEffectClasses, authorityCeiling };
}

async function projectV2ContractIntoV1(
  tx: Prisma.TransactionClient,
  taskId: string,
  contract: TaskContractV2,
): Promise<void> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { activeContractVersion: true, status: true, budgetJson: true },
  });
  if (!task) return;
  const expected = task.activeContractVersion + 1;
  if (contract.version !== expected) {
    throw new Error(`v1 task ${taskId} requires contract version ${expected}`);
  }
  if (!isMutableV1TaskStatus(task.status)) {
    throw new Error(`terminal v1 task ${taskId} contract is immutable (${task.status})`);
  }
  const allowedScope = v2PathScopeProjection(contract);
  const previousContract = await tx.taskContractVersion.findUnique({
    where: {
      task_id_version: {
        task_id: taskId,
        version: task.activeContractVersion,
      },
    },
    select: { allowedScopeJson: true },
  });
  if (!previousContract) {
    throw new Error(`v1 task ${taskId} has no active contract version ${task.activeContractVersion}`);
  }
  const expansions = scopeExpansionResources(
    v1AllowedScopeProjection(safeParse<unknown>(previousContract.allowedScopeJson, {})),
    allowedScope,
  );
  if (expansions.length > 0) {
    throw new Error(`task scope expansion requires user approval: ${expansions.join(", ")}`);
  }
  const previousBudget = safeParse<Record<string, unknown>>(task.budgetJson, {});
  const budgetJson = JSON.stringify({
    model_micros: contract.constraints.costMicros.toString(),
    compute_seconds: contract.constraints.timeoutSeconds,
    wall_clock_seconds: contract.constraints.timeoutSeconds,
    human_approvals: numberOr(previousBudget.human_approvals, 20),
  });
  const v1Contract: TaskContractHashInput = {
    version: contract.version,
    objective: contract.mission,
    userOutcome: null,
    nonGoals: [],
    constraints: [...contract.constraints.security],
    assumptions: [],
    unknowns: [],
    allowedScope,
    changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
  };
  const advanced = await tx.task.updateMany({
    where: {
      id: taskId,
      activeContractVersion: task.activeContractVersion,
      status: { in: [...V1_MUTABLE_TASK_STATUSES] },
    },
    data: {
      activeContractVersion: contract.version,
      budgetJson,
      scopeDigest: JSON.stringify(allowedScope),
    },
  });
  if (advanced.count !== 1) throw new Error(`task ${taskId} contract changed during v2 projection`);
  await tx.taskContractVersion.create({
    data: {
      task_id: taskId,
      version: contract.version,
      objective: contract.mission,
      userOutcome: null,
      nonGoalsJson: "[]",
      constraintsJson: JSON.stringify(contract.constraints.security),
      assumptionsJson: "[]",
      unknownsJson: "[]",
      allowedScopeJson: JSON.stringify(allowedScope),
      v2ProjectionJson: JSON.stringify(jsonSafe(contract)),
      changePolicyJson: JSON.stringify(v1Contract.changePolicy),
      contentHash: taskContractHash(v1Contract),
      createdBy: SERVER_PRINCIPAL,
    },
  });
  const ledgerRows = scopeLedgerRows({
    taskId,
    contractVersion: contract.version,
    scope: allowedScope,
    source: "v2_contract_projection",
    reason: "contract scope carried forward without expansion",
  });
  if (ledgerRows.length > 0) {
    await tx.scopeLedgerEntry.createMany({ data: ledgerRows });
  }
  for (const criterion of contract.acceptance) {
    await tx.acceptanceCriterion.create({
      data: {
        taskId,
        contractVersion: contract.version,
        criterionId: criterion.claimId,
        statement: criterion.statement,
        verificationHint: criterion.evidenceRequirement,
        required: true,
        status: "pending",
      },
    });
  }
}

function v1AndV2StatusesAgree(v1Status: string, v2Status: TaskV2["status"]): boolean {
  switch (v1Status) {
    case "DRAFT": return v2Status === "DRAFT" || v2Status === "READY";
    case "ACTIVE": return v2Status === "RUNNING";
    case "NEEDS_USER_DECISION": return v2Status === "WAITING_USER" || v2Status === "WAITING_AUTH";
    case "BLOCKED": return v2Status === "BLOCKED" || v2Status === "WAITING_RESOURCE" || v2Status === "PAUSED";
    case "VERIFYING": return v2Status === "VERIFYING";
    case "COMPLETED": return v2Status === "COMPLETED";
    case "ABORTED": return v2Status === "CANCELLED";
    case "FAILED":
    case "FAILED_VERIFICATION":
    case "BUDGET_EXHAUSTED":
    case "POLICY_DENIED":
      return v2Status === "FAILED" || v2Status === "PARTIAL";
    default:
      return false;
  }
}

function nonnegativeBigInt(value: unknown, fallback: bigint): bigint {
  const encoded = typeof value === "bigint" || typeof value === "number" || typeof value === "string"
    ? String(value)
    : "";
  return /^\d+$/.test(encoded) ? BigInt(encoded) : fallback;
}

type ConversationContextInput = Readonly<{ sessionId: string; threadId: string }>;

async function createV1TaskProjection(
  tx: Prisma.TransactionClient,
  task: TaskV2,
  context: ConversationContextInput,
): Promise<"created" | "existing" | "context_mismatch" | "thread_not_found"> {
  const thread = await tx.thread.findFirst({
    where: { id: context.threadId, sessionId: context.sessionId },
    select: { id: true },
  });
  if (!thread) return "thread_not_found";

  const existing = await tx.task.findUnique({
    where: { id: task.id },
    select: { sessionId: true, threadId: true },
  });
  if (existing) {
    return existing.sessionId === context.sessionId && existing.threadId === context.threadId
      ? "existing"
      : "context_mismatch";
  }

  const contract = task.contract;
  const allowedScope = v2PathScopeProjection(contract);
  const statusProjection = v2TaskStatusToV1(task.status);
  const v1Contract: TaskContractHashInput = {
    version: contract.version,
    objective: contract.mission,
    userOutcome: null,
    nonGoals: [],
    constraints: [...contract.constraints.security],
    assumptions: [],
    unknowns: [],
    allowedScope,
    changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
  };
  await tx.task.create({
      data: {
        id: task.id,
        sessionId: context.sessionId,
        threadId: context.threadId,
        status: statusProjection.status,
        phase: statusProjection.phase,
        activeContractVersion: contract.version,
        riskClass: "normal",
        budgetJson: JSON.stringify({
          model_micros: contract.constraints.costMicros.toString(),
          compute_seconds: contract.constraints.timeoutSeconds,
          wall_clock_seconds: contract.constraints.timeoutSeconds,
          human_approvals: 20,
        }),
        scopeDigest: JSON.stringify(allowedScope),
        completedAt: statusProjection.completedAt,
        terminalReasonJson: statusProjection.completedAt === null
          ? null
          : JSON.stringify({ reason: `arp_v2_${task.status.toLowerCase()}` }),
      },
  });
  await tx.taskContractVersion.create({
      data: {
        task_id: task.id,
        version: contract.version,
        objective: contract.mission,
        userOutcome: null,
        nonGoalsJson: "[]",
        constraintsJson: JSON.stringify(contract.constraints.security),
        assumptionsJson: "[]",
        unknownsJson: "[]",
        allowedScopeJson: JSON.stringify(allowedScope),
        v2ProjectionJson: JSON.stringify(jsonSafe(contract)),
        changePolicyJson: JSON.stringify(v1Contract.changePolicy),
        contentHash: taskContractHash(v1Contract),
        createdBy: SERVER_PRINCIPAL,
      },
  });
  for (const criterion of contract.acceptance) {
    await tx.acceptanceCriterion.create({
        data: {
          taskId: task.id,
          contractVersion: contract.version,
          criterionId: criterion.claimId,
          statement: criterion.statement,
          verificationHint: criterion.evidenceRequirement,
          required: true,
          status: "pending",
        },
    });
  }
  return "created";
}

async function inspectV1TaskProjection(
  taskId: string,
  context: ConversationContextInput,
): Promise<"created" | "existing" | "context_mismatch" | "thread_not_found"> {
  const thread = await db.thread.findFirst({
    where: { id: context.threadId, sessionId: context.sessionId },
    select: { id: true },
  });
  if (!thread) return "thread_not_found";
  const existing = await db.task.findUnique({
    where: { id: taskId },
    select: { sessionId: true, threadId: true },
  });
  if (!existing) return "created";
  return existing.sessionId === context.sessionId && existing.threadId === context.threadId
    ? "existing"
    : "context_mismatch";
}

const taskProjectionService = new TaskProjectionService<Prisma.TransactionClient>({
  source: {
    readTask: async (taskId) => {
      const task = await db.task.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          sessionId: true,
          threadId: true,
          status: true,
          activeContractVersion: true,
          budgetJson: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
        },
      });
      return task as TaskProjectionTaskRow | null;
    },
    readContract: async (taskId, version) => {
      const contract = await db.taskContractVersion.findUnique({
        where: { task_id_version: { task_id: taskId, version } },
        include: { acceptanceCriteria: { orderBy: { criterionId: "asc" } } },
      });
      return contract as TaskProjectionContractRow | null;
    },
    listTaskIds: async () => (await db.task.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((task) => task.id),
  },
  store: {
    get: (taskId) => arpV2.tasks.get(taskId),
    set: (taskId, task) => { arpV2.tasks.set(taskId, task); },
    publish: async (event) => emitV2({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      snapshot: event.snapshot,
      correlationId: event.correlationId,
    }),
  },
  bridge: {
    createV1: (transaction, task, context) => createV1TaskProjection(transaction, task, context),
    inspectV1: (taskId, context) => inspectV1TaskProjection(taskId, context),
    projectStatus: (transaction, taskId, status) => projectV2StatusIntoV1(transaction, taskId, status),
    projectContract: (transaction, taskId, contract) => projectV2ContractIntoV1(transaction, taskId, contract),
  },
});

async function synchronizeV1TaskProjection(
  taskId: string,
  eventType = "task.v1_projection_recovered",
): Promise<{ readonly task: TaskV2; readonly changed: boolean }> {
  return taskProjectionService.synchronize(taskId, eventType);
}

async function reconcileV1TaskProjections(): Promise<number> {
  return taskProjectionService.reconcile();
}

const effectSettlementService = new EffectSettlementService<Prisma.TransactionClient>({
  appendEvent: async (event, mutation): Promise<void> => {
    await emit({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
      artifactRefs: event.artifactRefs === undefined ? undefined : [...event.artifactRefs],
    }, mutation);
  },
  appendEvents: async (events, mutation): Promise<void> => {
    await emitAtomicBatch(events.map((event) => ({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
      artifactRefs: event.artifactRefs === undefined ? undefined : [...event.artifactRefs],
    })), mutation);
  },
  transaction: (tx) => ({
    authorize: async (input: EffectAuthorizationInput) => {
      await tx.policyDecision.create({
        data: {
          id: input.policyDecisionId,
          toolCallId: input.toolCallId,
          effectType: input.effectType,
          normalizedInputArtifact: input.argumentsArtifactUri,
          decision: "allow_with_constraints",
          ruleIdsJson: JSON.stringify(["task-contract.scope", "kernel.secure-local-default"]),
          constraintsJson: JSON.stringify({ workspace_id: input.workspaceId, resource_uri: input.resourceUri }),
          policyVersion: "secure-local-default:v1",
          explanation: "Task contract scope admitted; the kernel remains authoritative at dispatch.",
        },
      });
      await tx.sideEffect.create({
        data: {
          id: input.sideEffectId,
          toolCallId: input.toolCallId,
          effectType: input.effectType,
          resourceUri: input.resourceUri,
          idempotencyKey: input.idempotencyKey,
          state: "AUTHORIZED",
          reversibility: input.reversibility,
          requestArtifact: input.argumentsArtifactUri,
        },
      });
      await tx.toolCall.update({
        where: { id: input.toolCallId },
        data: { state: "AUTHORIZED", policyDecisionId: input.policyDecisionId },
      });
    },
    start: async (input: EffectAuthorizationInput) => {
      const startedAt = new Date();
      await tx.toolCall.update({ where: { id: input.toolCallId }, data: { state: "STARTED", startedAt } });
      await tx.sideEffect.update({ where: { id: input.sideEffectId }, data: { state: "STARTED", startedAt } });
    },
    markUnknown: async (input: EffectUnknownInput) => {
      const current = await tx.sideEffect.findUnique({
        where: { id: input.sideEffectId },
        select: { state: true },
      });
      if (current === null) {
        throw new Error(`side effect ${input.sideEffectId} disappeared during recovery`);
      }
      if (!new Set(["STARTED", "UNKNOWN", "RECONCILING"]).has(current.state)) {
        throw new EffectSettlementAlreadyResolvedError(input.sideEffectId);
      }
      const reconciliation = JSON.stringify({
        message: input.error,
        reconciliation_required: true,
      });
      const settledAt = new Date();
      const updatedEffect = await tx.sideEffect.updateMany({
        where: {
          id: input.sideEffectId,
          state: { in: ["STARTED", "UNKNOWN", "RECONCILING"] },
        },
        data: {
          state: "MANUAL_REVIEW",
          reconciliationJson: reconciliation,
        },
      });
      if (updatedEffect.count !== 1) {
        throw new EffectSettlementAlreadyResolvedError(input.sideEffectId);
      }
      await tx.toolCall.updateMany({
        where: {
          id: input.toolCallId,
          state: { in: ["AUTHORIZED", "STARTED", "UNKNOWN", "RECONCILING"] },
        },
        data: {
          state: "UNKNOWN",
          settledAt,
          resultStatus: "unknown",
          errorJson: reconciliation,
        },
      });
    },
    cancel: async (input) => {
      const settledAt = new Date();
      await tx.toolCall.updateMany({
        where: { id: input.toolCallId, state: { in: ["AUTHORIZED", "STARTED"] } },
        data: {
          state: "CANCELLED",
          settledAt,
          resultStatus: "cancelled",
          errorJson: JSON.stringify({ reason: input.reason, cancelled_before_dispatch: true }),
        },
      });
      await tx.sideEffect.updateMany({
        where: { id: input.sideEffectId, state: { in: ["AUTHORIZED", "STARTED"] } },
        data: {
          state: "FAILED",
          settledAt,
          reconciliationJson: JSON.stringify({ reason: input.reason, cancelled_before_dispatch: true }),
        },
      });
    },
    settle: async (input: EffectSettlementInput) => {
      const turnBeforeSettlement = await tx.turn.findUnique({
        where: { id: input.turnId },
        select: { state: true },
      });
      if (turnBeforeSettlement === null) {
        throw new Error(`turn ${input.turnId} disappeared before tool settlement`);
      }
      const terminalTurnStates = new Set([
        "COMPLETED",
        "INTERRUPTED",
        "FAILED",
        "BUDGET_EXHAUSTED",
        "POLICY_DENIED",
        "BLOCKED",
        "USER_ACTION_REQUIRED",
        "ABORTED",
      ]);
      const preserveTerminalTurn = terminalTurnStates.has(turnBeforeSettlement.state);
      if (!preserveTerminalTurn && turnBeforeSettlement.state !== "TOOL_SETTLEMENT") {
        throw new Error(`turn ${input.turnId} is ${turnBeforeSettlement.state} before tool settlement`);
      }
      const latestEpisode = await tx.episode.findFirst({
        where: { turnId: input.turnId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const settledAt = new Date();
      await tx.toolCall.update({
        where: { id: input.toolCallId },
        data: {
          state: input.toolState,
          resultArtifact: input.resultArtifactUri,
          resultStatus: input.resultStatus,
          settledAt,
          errorJson: input.errorJson,
        },
      });
      if (input.sideEffectId !== null) {
        await tx.sideEffect.updateMany({
          where: { toolCallId: input.toolCallId, id: input.sideEffectId },
          data: {
            // The effect state has to say whether the effect *happened*. It
            // used to be written SETTLED even for a failed or denied tool
            // call, which made the semantic-idempotency gate treat a
            // rejected patch as an applied one and refuse the corrected
            // retry. FAILED here is terminal and recoverable, not ambiguous.
            state: input.toolState === "SETTLED" ? "SETTLED" : "FAILED",
            evidenceArtifact: input.resultArtifactUri,
            settledAt,
          },
        });
      }
      await tx.episode.createMany({
        data: [
          {
            id: uuid(),
            turnId: input.turnId,
            sequence: (latestEpisode?.sequence ?? 0) + 1,
            kind: "tool_call",
            modelVisible: true,
            contentArtifact: input.callTranscriptArtifactUri,
            toolCallId: input.toolCallId,
            sourceVersionsJson: JSON.stringify({ providerAttemptId: input.providerAttemptId }),
          },
          {
            id: uuid(),
            turnId: input.turnId,
            sequence: (latestEpisode?.sequence ?? 0) + 2,
            kind: "tool_result",
            modelVisible: true,
            contentArtifact: input.resultTranscriptArtifactUri,
            toolCallId: input.toolCallId,
            sourceVersionsJson: JSON.stringify({
              result: input.resultTranscriptHash ?? input.resultTranscriptArtifactUri,
              // Durable read-before-edit evidence; see ObservedSourceTracker.
              ...(input.observedSourceVersions !== undefined
                && Object.keys(input.observedSourceVersions).length > 0
                ? { sources: input.observedSourceVersions }
                : {}),
            }),
          },
        ],
      });
      // A late external receipt still gets durably attached to its tool and
      // effect, but never resurrects a terminal turn after cancellation or
      // recovery. The state remains TOOL_SETTLEMENT for the normal loop.
      if (!preserveTerminalTurn) {
        const turnUpdate = await tx.turn.updateMany({
          where: { id: input.turnId, state: "TOOL_SETTLEMENT" },
          data: { state: "TOOL_SETTLEMENT" },
        });
        if (turnUpdate.count !== 1) {
          throw new Error(`turn ${input.turnId} changed during tool settlement`);
        }
      }
    },
  }),
  mutate: mutateAgentState,
});

const turnCoordinator = new TurnCoordinator<Prisma.TransactionClient>({
  readTask: async (taskId) => {
    const task = await db.task.findUnique({ where: { id: taskId }, select: { id: true, threadId: true, status: true } });
    return task as TurnTaskSnapshot | null;
  },
  readTurn: async (turnId) => {
    const turn = await db.turn.findUnique({
      where: { id: turnId },
      select: {
        id: true,
        threadId: true,
        taskId: true,
        sequence: true,
        state: true,
        initiatingActor: true,
        startedAt: true,
        completedAt: true,
        selectedModel: true,
        selectedReasoningEffort: true,
        selectedProviderAccountId: true,
      },
    });
    return turn as TurnRow | null;
  },
  appendEvent: async (event, mutation): Promise<void> => {
    await emit({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
      artifactRefs: event.artifactRefs === undefined ? undefined : [...event.artifactRefs],
    }, mutation);
  },
  transaction: (tx) => ({
    findTask: async (taskId) => {
      const task = await tx.task.findUnique({ where: { id: taskId }, select: { id: true, threadId: true, status: true } });
      return task as TurnTaskSnapshot | null;
    },
    findActiveTurn: async (taskId, activeStates) => tx.turn.findFirst({
      where: { taskId, state: { in: [...activeStates] } },
      orderBy: { sequence: "desc" },
      select: { id: true },
    }),
    findLatestSequence: async (threadId) => (await tx.turn.findFirst({
      where: { threadId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    }))?.sequence ?? null,
    resumeTask: async (taskId, expectedStatus) => {
      const resumed = await tx.task.updateMany({
        where: { id: taskId, status: expectedStatus },
        data: {
          status: "ACTIVE",
          phase: "IMPLEMENT",
          completedAt: null,
          terminalReasonJson: null,
        },
      });
      if (resumed.count !== 1) throw new TurnAdmissionError("state_changed");
    },
    createTurn: async (input) => {
      await tx.turn.create({
        data: {
          id: input.turnId,
          threadId: input.threadId,
          taskId: input.taskId,
          sequence: input.sequence,
          state: "PENDING",
          initiatingActor: input.initiatingActor,
          initiatingInputArtifact: input.inputArtifactUri,
          selectedModel: input.selectedModel ?? null,
          selectedReasoningEffort: input.selectedReasoningEffort ?? null,
          selectedProviderAccountId: input.selectedProviderAccountId ?? null,
          requestedBudgetJson: input.requestedBudgetJson ?? null,
        },
      });
    },
    createUserEpisode: async (input) => {
      await tx.episode.create({
        data: {
          id: uuid(),
          turnId: input.turnId,
          sequence: 1,
          kind: "user_message",
          modelVisible: true,
          contentArtifact: input.inputArtifactUri,
          sourceVersionsJson: JSON.stringify({ input: input.inputArtifactHash }),
        },
      });
    },
    interruptTurn: async (turnId, reason) => {
      const update = await tx.turn.updateMany({
        where: { id: turnId, state: { in: [...V1_ACTIVE_TURN_STATES] } },
        data: {
          state: "INTERRUPTED",
          completedAt: new Date(),
          terminalErrorJson: JSON.stringify({ reason }),
        },
      });
      if (update.count !== 1) throw new Error(`turn ${turnId} changed before atomic interruption`);
    },
    abortTurn: async (turnId, reason) => {
      const update = await tx.turn.updateMany({
        where: { id: turnId, state: { in: [...V1_ACTIVE_TURN_STATES, "REPAIR_PENDING"] } },
        data: {
          state: "ABORTED",
          completedAt: new Date(),
          terminalErrorJson: JSON.stringify({ reason, cancellation: true }),
        },
      });
      if (update.count !== 1) throw new Error(`turn ${turnId} changed before atomic cancellation`);
    },
  }),
  mutate: mutateAgentState,
  projectTask: async (taskId, eventType): Promise<void> => { await synchronizeV1TaskProjection(taskId, eventType); },
  activeTurnStates: V1_ACTIVE_TURN_STATES,
});

/**
 * Re-enter a verification repair through the same durable turn admission
 * path as a user turn. The directive artifact is the idempotency anchor: a
 * restart or duplicate scheduler pass reuses the already-admitted turn.
 */
async function admitRepairTurn(input: {
  readonly taskId: string;
  readonly threadId: string;
  readonly repairAttemptId: string;
  readonly directiveArtifactUri: string;
  readonly directiveArtifactHash: string;
  readonly attemptNumber: number;
}): Promise<string> {
  const durableAttempt = await db.repairAttempt.findUnique({
    where: { id: input.repairAttemptId },
    select: {
      repairTurnId: true,
      state: true,
      parentTurn: {
        select: {
          selectedModel: true,
          selectedReasoningEffort: true,
          selectedProviderAccountId: true,
          requestedBudgetJson: true,
          budgetLedger: {
            select: {
              stepsUsed: true,
              maxSteps: true,
              tokensUsed: true,
              maxTokens: true,
              costMicros: true,
              maxCostMicros: true,
            },
          },
        },
      },
    },
  });
  if (durableAttempt === null) {
    throw new Error(`repair attempt ${input.repairAttemptId} not found before turn admission`);
  }
  if (isRepairAttemptTerminal(durableAttempt.state)) {
    throw new Error(`repair attempt ${input.repairAttemptId} is already ${durableAttempt.state}`);
  }
  if (durableAttempt.parentTurn.budgetLedger === null) {
    throw new Error(
      `repair attempt ${input.repairAttemptId} has no durable parent budget ledger; refusing to mint a fresh repair budget`,
    );
  }
  const remainingBudget = remainingRepairBudget(durableAttempt.parentTurn.budgetLedger);
  if (remainingBudget.kind === "exhausted") {
    throw new Error(
      `repair attempt ${input.repairAttemptId} exhausted its parent ${remainingBudget.dimension} budget`,
    );
  }
  const expectedPins: RepairContinuationPins = {
    selectedModel: durableAttempt.parentTurn.selectedModel,
    selectedReasoningEffort: durableAttempt.parentTurn.selectedReasoningEffort,
    selectedProviderAccountId: durableAttempt.parentTurn.selectedProviderAccountId,
    requestedBudgetJson: serializeTurnRequestBudget(remainingBudget.budget),
  };
  const validateRepairTurn = (candidate: {
    readonly id: string;
    readonly taskId: string | null;
    readonly threadId: string;
    readonly initiatingActor: string;
    readonly initiatingInputArtifact: string | null;
    readonly selectedModel: string | null;
    readonly selectedReasoningEffort: string | null;
    readonly selectedProviderAccountId: string | null;
    readonly requestedBudgetJson: string | null;
  }): void => {
    if (
      candidate.taskId !== input.taskId
      || candidate.threadId !== input.threadId
      || candidate.initiatingActor !== "repair-controller"
      || candidate.initiatingInputArtifact !== input.directiveArtifactUri
    ) {
      throw new Error(`repair turn ${candidate.id} has mismatched continuation lineage`);
    }
    const mismatches = repairPinMismatches(expectedPins, candidate);
    if (mismatches.length > 0) {
      throw new Error(
        `repair turn ${candidate.id} changed fixed continuation pins: ${mismatches.join(", ")}`,
      );
    }
  };
  if (durableAttempt.repairTurnId !== null) {
    const child = await db.turn.findUnique({
      where: { id: durableAttempt.repairTurnId },
      select: {
        id: true,
        taskId: true,
        threadId: true,
        initiatingActor: true,
        initiatingInputArtifact: true,
        selectedModel: true,
        selectedReasoningEffort: true,
        selectedProviderAccountId: true,
        requestedBudgetJson: true,
      },
    });
    if (child === null) {
      throw new Error(`repair attempt ${input.repairAttemptId} references a missing repair turn`);
    }
    validateRepairTurn(child);
    return child.id;
  }
  const existing = await db.turn.findFirst({
    where: {
      taskId: input.taskId,
      initiatingActor: "repair-controller",
      initiatingInputArtifact: input.directiveArtifactUri,
    },
    orderBy: { sequence: "desc" },
    select: {
      id: true,
      taskId: true,
      threadId: true,
      initiatingActor: true,
      initiatingInputArtifact: true,
      selectedModel: true,
      selectedReasoningEffort: true,
      selectedProviderAccountId: true,
      requestedBudgetJson: true,
    },
  });
  if (existing !== null) {
    validateRepairTurn(existing);
    await writerTransaction(async (tx) => {
      await tx.turn.updateMany({
        where: { id: existing.id, state: "PENDING" },
        data: { state: "REPAIRING" },
      });
      const associated = await tx.repairAttempt.updateMany({
        where: { id: input.repairAttemptId, repairTurnId: null },
        data: { repairTurnId: existing.id, state: "ADMITTED" },
      });
      if (associated.count !== 1) {
        const current = await tx.repairAttempt.findUnique({
          where: { id: input.repairAttemptId },
          select: { repairTurnId: true },
        });
        if (current?.repairTurnId !== existing.id) {
          throw new Error(`repair attempt ${input.repairAttemptId} changed during existing-turn association`);
        }
      }
    });
    return existing.id;
  }

  const latest = await db.turn.findFirst({
    where: { threadId: input.threadId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const repairTurnId = uuid();
  const admitted = await turnCoordinator.admit({
    turnId: repairTurnId,
    threadId: input.threadId,
    taskId: input.taskId,
    sequence: (latest?.sequence ?? 0) + 1,
    inputArtifactUri: input.directiveArtifactUri,
    inputArtifactHash: input.directiveArtifactHash,
    initiatingActor: "repair-controller",
    // A repair is a continuation of the model-fixed run, not a new routing
    // decision. Losing any of these durable pins silently moved repairs to
    // the global default provider/model and widened caller-supplied budgets.
    selectedModel: durableAttempt.parentTurn.selectedModel,
    selectedReasoningEffort: durableAttempt.parentTurn.selectedReasoningEffort,
    selectedProviderAccountId: durableAttempt.parentTurn.selectedProviderAccountId,
    requestedBudgetJson: expectedPins.requestedBudgetJson,
  });
  await mutateAgentState(() => emit({
    eventType: "turn.repairing",
    aggregateType: "turn",
    aggregateId: admitted.turn.id,
    correlationId: input.taskId,
    payload: {
      phase: "REPAIRING",
      repair_attempt: input.attemptNumber,
      repair_attempt_id: input.repairAttemptId,
      directive_artifact: input.directiveArtifactUri,
    },
    artifactRefs: [input.directiveArtifactUri],
  }, async (tx) => {
    const update = await tx.turn.updateMany({
      where: { id: admitted.turn.id, state: "PENDING" },
      data: { state: "REPAIRING" },
    });
    if (update.count !== 1) throw new Error(`repair turn ${admitted.turn.id} changed before repair execution`);
    const associated = await tx.repairAttempt.updateMany({
      where: { id: input.repairAttemptId, repairTurnId: null, state: { in: ["PENDING", "ADMITTED"] } },
      data: { repairTurnId: admitted.turn.id, state: "ADMITTED" },
    });
    if (associated.count !== 1) {
      throw new Error(`repair attempt ${input.repairAttemptId} changed before continuation association`);
    }
  }));
  return admitted.turn.id;
}

/** Close the proposal turn once its durable repair continuation exists. */
async function supersedeRepairPendingTurn(
  turnId: string,
  repairTurnId: string,
  taskId: string,
): Promise<void> {
  await mutateAgentState(async () => {
    const current = await db.turn.findUnique({ where: { id: turnId }, select: { state: true } });
    if (current === null) throw new Error(`repair parent turn ${turnId} disappeared`);
    if (current.state === "ABORTED") return;
    if (current.state !== "REPAIR_PENDING") {
      throw new Error(`repair parent turn ${turnId} changed to ${current.state}`);
    }
    await emit({
      eventType: "turn.superseded",
      aggregateType: "turn",
      aggregateId: turnId,
      correlationId: taskId,
      payload: {
        previous_state: "REPAIR_PENDING",
        state: "ABORTED",
        repair_turn_id: repairTurnId,
        reason: "superseded_by_repair_turn",
      },
    }, async (tx) => {
      const update = await tx.turn.updateMany({
        where: { id: turnId, state: "REPAIR_PENDING" },
        data: {
          state: "ABORTED",
          completedAt: new Date(),
          terminalErrorJson: JSON.stringify({ reason: "superseded_by_repair_turn", repairTurnId }),
        },
      });
      if (update.count !== 1) throw new Error(`repair parent turn ${turnId} changed during supersession`);
    });
  });
}

/** Serialize a stored event into an ARP v2 envelope for SSE consumers. */
function storedEventToEnvelopeV2(ev: StoredEvent): Record<string, unknown> {
  return {
    eventId: ev.eventId,
    eventType: ev.eventType,
    schemaVersion: 2,
    aggregateType: ev.aggregateType,
    aggregateId: ev.aggregateId,
    aggregateSequence: ev.aggregateSequence,
    occurredAt: ev.occurredAt instanceof Date ? ev.occurredAt.toISOString() : String(ev.occurredAt),
    actor: safeParse(ev.actorJson, { kind: "system", id: SERVER_PRINCIPAL }),
    correlationId: ev.correlationId,
    causationId: ev.causationId,
    idempotencyKey: ev.idempotencyKey,
    payload: safeParse(ev.payloadJson, {}),
    artifactRefs: safeParse(ev.artifactRefsJson, []),
    traceId: ev.traceId,
  };
}

/** Static registry served at GET /v2/system/schema-registry (mirrors tools/codegen/v2-schemas.ts). */
const V2_SCHEMA_REGISTRY_ENTRIES: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["mission", missionSchema],
  ["task-contract-v2", taskContractV2Schema],
  ["task-v2", taskV2Schema],
  ["workflow-node", workflowNodeSchema],
  ["guarded-edge", guardedEdgeSchema],
  ["workflow", workflowSchema],
  ["node-run", nodeRunSchema],
  ["claim", claimSchema],
  ["evidence", evidenceSchema],
  ["authorization-instance", authorizationInstanceSchema],
  ["effect-record", effectRecordSchema],
  ["question", questionSchema],
  ["decision", decisionSchema],
  ["risk", riskSchema],
  ["worker-lease", workerLeaseSchema],
  ["task-attempt", taskAttemptSchema],
  ["budget-consumption", budgetConsumptionSchema],
  ["organization", organizationSchema],
  ["department", departmentSchema],
  ["operator-agent", operatorAgentSchema],
  ["agent-room", agentRoomSchema],
  ["capability-directory-entry", capabilityDirectoryEntrySchema],
  ["material-question", materialQuestionSchema],
  ["attention-assessment", attentionAssessmentSchema],
  ["structured-intervention", structuredInterventionSchema],
  ["causal-step", causalStepSchema],
  ["causal-replay-trace", causalReplayTraceSchema],
  ["counterfactual-experiment", counterfactualExperimentSchema],
  ["mobile-supervision-session", mobileSupervisionSessionSchema],
  ["acp-context-injection", acpContextInjectionSchema],
  ["ui-observation-input", uiObservationInputSchema],
  ["ui-observation", uiObservationSchema],
  ["computer-use-action", computerUseActionSchema],
  ["semantic-target-verification", semanticTargetVerificationSchema],
  ["ui-evidence-record", uiEvidenceRecordSchema],
  ["browser-desktop-pool", browserDesktopPoolSchema],
  ["pool-lease", poolLeaseSchema],
  ["human-takeover-session", humanTakeoverSessionSchema],
  ["data-flow-policy", dataFlowPolicySchema],
  ["data-transfer-audit", dataTransferAuditSchema],
  ["data-flow-check-result", dataFlowCheckResultSchema],
  ["external-connector-spec", externalConnectorSpecSchema],
  ["connector-call-intent", connectorCallIntentSchema],
  ["connector-execution-observation", connectorExecutionObservationSchema],
  ["connector-call-result", connectorCallResultSchema],
  ["ambiguous-submit-reconciliation", ambiguousSubmitReconciliationSchema],
  ["incident-profile-spec", incidentProfileSpecSchema],
  ["incident-execution-record", incidentExecutionRecordSchema],
  ["research-profile-spec", researchProfileSpecSchema],
  ["research-provenance-record", researchProvenanceRecordSchema],
];

// ────────────────────────── Route handlers ─────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const pattern = path.replace(/:([^/]+)/g, (_, n) => { paramNames.push(n); return "([^/]+)"; });
  return { method, pattern: new RegExp(`^${pattern}$`), paramNames, handler };
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "connection": "keep-alive",
  "access-control-allow-origin": CONTROL_CORS_ORIGIN,
  "access-control-allow-headers": CORS_ALLOW_HEADERS,
  "x-accel-buffering": "no",
} as const;

function writeSseFrame(
  response: ServerResponse,
  frame: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return Promise.reject(new Error("SSE response is closed"));
  }
  let accepted: boolean;
  try {
    accepted = response.write(frame);
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  if (accepted) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = (): void => settle();
    const onClose = (): void => settle(new Error("SSE response closed before drain"));
    const onError = (error: Error): void => settle(error);
    const onAbort = (): void => settle(new Error("SSE response aborted before drain"));

    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (response.destroyed || response.writableEnded || signal.aborted) onClose();
  });
}

interface EventStreamOptions {
  readonly streamName: string;
  readonly cursor: string | null;
  readonly filter: (event: StoredEvent) => boolean;
  readonly eventFrame: (event: StoredEvent) => string;
  readonly cursorExpiredFrame: (expired: EventCursorExpired) => string;
}

function eventCursorFromRequest(request: IncomingMessage, explicitCursor: string | null): string | null {
  if (explicitCursor !== null && explicitCursor.length > 0) return explicitCursor;
  const lastEventId = request.headers["last-event-id"];
  return typeof lastEventId === "string" && lastEventId.length > 0 ? lastEventId : null;
}

/**
 * Serve both public event versions through the same replay/live broker.
 * Headers are flushed before replay so the caller can exercise the overlap
 * boundary, but disconnect observation is installed before opening the broker.
 */
async function serveEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  options: EventStreamOptions,
): Promise<void> {
  const disconnect = new AbortController();
  let subscription: EventSubscriptionHandle | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let writeTail: Promise<void> = Promise.resolve();

  const writeFrame = (frame: string): Promise<void> => {
    const write = writeTail.then(() => writeSseFrame(response, frame, disconnect.signal));
    writeTail = write.catch(() => undefined);
    return write;
  };

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    disconnect.abort();
    if (heartbeat) clearInterval(heartbeat);
    cleanupPromise = (subscription?.close() ?? Promise.resolve()).catch((error: unknown) => {
      console.error("[terminus-control] failed to persist event stream cursor", error);
    });
    return cleanupPromise;
  };

  request.once("close", () => { void cleanup(); });
  response.writeHead(200, SSE_HEADERS);
  response.flushHeaders();

  try {
    subscription = await eventSubscriptionService.open({
      streamName: options.streamName,
      cursor: options.cursor,
      filter: options.filter,
      onEvent: (event) => writeFrame(options.eventFrame(event)),
      onCursorExpired: (expired) => writeFrame(options.cursorExpiredFrame(expired)),
      onError: (error) => {
        if (!response.destroyed && !response.writableEnded) response.destroy(error);
      },
      signal: disconnect.signal,
    });
    if (disconnect.signal.aborted) {
      await cleanup();
      return;
    }
    heartbeat = setInterval(() => {
      if (disconnect.signal.aborted || response.destroyed || response.writableEnded) return;
      void writeFrame(`:heartbeat ${Date.now()}\n\n`).catch(() => { void cleanup(); });
    }, 15_000);
  } catch (error: unknown) {
    await cleanup();
    if (!response.destroyed && !response.writableEnded) response.end();
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[terminus-control] event stream failed: ${detail}`);
  }
}

const checkpointRequestSchema = z.object({
  session_id: z.string().uuid(),
  thread_id: z.string().uuid(),
  task_id: z.string().uuid(),
}).strict();

const checkpointSequenceStateSchema = z.object({
  task: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  sourceTurnId: z.string().uuid(),
  episodeRange: z.object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }).strict().refine((range) => range.from <= range.to, {
    message: "episode range must be ordered",
  }),
}).strict();

/**
 * URL path segments carry a bare 64-hex digest; the kernel's artifact
 * ownership index is keyed by the canonical `sha256:<hex>` CAS address.
 *
 * The kernel read path was asymmetric about this: `store.get` / `store.metadata`
 * strip an optional prefix, but the `has_task_link` ownership gate that runs
 * first requires the canonical form and rejects bare hex as `InvalidHash`,
 * which surfaced to the client as an opaque 500. Normalize before the boundary
 * so the two agree.
 */
function canonicalArtifactHash(raw: string): string | null {
  const hex = raw.startsWith("sha256:") ? raw.slice("sha256:".length) : raw;
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

// ───────────────────── External Codex subscription lane ───────────────────
//
// This lane is intentionally separate from the native provider renderer. The
// Codex App Server owns its loop, tools, approvals, and model state; Terminus
// only owns the kernel-brokered process and the durable identity that lets the
// desktop reconnect to it. The key includes both values so one workspace can
// never accidentally reuse another session's external thread.
const codexLaneSessions = new Map<string, CodexAppServerSession>();
const CODEX_METADATA_KEY = "external_codex";
const CODEX_CONTEXT_TASK_PREFIX = "external-codex:";
const CODEX_MAX_ID = 512;
const CODEX_MAX_TEXT = 64 * 1_024;

const codexThreadInputSchema = z.object({
  session_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  cwd: z.string().min(1).max(4_096).optional(),
  model: z.string().min(1).max(256).optional(),
  sandbox: z.string().min(1).max(256).optional(),
  approval_policy: z.string().min(1).max(256).optional(),
  base_instructions: z.string().max(CODEX_MAX_TEXT).optional(),
}).strict();

const codexTurnInputSchema = z.object({
  session_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  thread_id: z.string().min(1).max(CODEX_MAX_ID),
  text: z.string().min(1).max(CODEX_MAX_TEXT),
  model: z.string().min(1).max(256).optional(),
  effort: z.string().min(1).max(64).optional(),
  cwd: z.string().min(1).max(4_096).optional(),
  approval_policy: z.string().min(1).max(256).optional(),
  sandbox_policy: z.record(z.string(), z.unknown()).optional(),
}).strict();

const codexInterruptInputSchema = z.object({
  session_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  thread_id: z.string().min(1).max(CODEX_MAX_ID),
  turn_id: z.string().min(1).max(CODEX_MAX_ID),
}).strict();

const codexStopInputSchema = z.object({
  session_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  reason: z.string().min(1).max(256).optional(),
}).strict();

interface PersistedCodexLaneState {
  readonly external_harness: typeof CODEX_EXTERNAL_HARNESS;
  readonly workspace_id: string;
  readonly session_id: string;
  readonly thread_id: string | null;
  readonly job_id: string | null;
  readonly state: string;
  readonly updated_at: string;
}

const codexLaneEventBuffers = new Map<string, CodexLaneEventBuffer>();
const emptyCodexLaneEventBuffer = new CodexLaneEventBuffer();

function getCodexLaneEventBuffer(key: string): CodexLaneEventBuffer {
  const existing = codexLaneEventBuffers.get(key);
  if (existing !== undefined) return existing;
  const created = new CodexLaneEventBuffer();
  codexLaneEventBuffers.set(key, created);
  return created;
}

function codexLaneKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

function readCodexLaneState(session: PrismaSession): PersistedCodexLaneState | null {
  const metadata = safeParse<Record<string, unknown>>(session.metadataJson, {});
  const raw = metadata[CODEX_METADATA_KEY];
  if (!isPlainRecord(raw)) return null;
  const workspaceId = typeof raw.workspace_id === "string" ? raw.workspace_id : null;
  const sessionId = typeof raw.session_id === "string" ? raw.session_id : null;
  if (workspaceId !== session.workspaceId || sessionId !== session.id) return null;
  const threadId = raw.thread_id === null || typeof raw.thread_id === "string" ? raw.thread_id : null;
  const jobId = raw.job_id === null || typeof raw.job_id === "string" ? raw.job_id : null;
  const state = typeof raw.state === "string" ? raw.state : "unknown";
  const updatedAt = typeof raw.updated_at === "string" ? raw.updated_at : session.updatedAt.toISOString();
  return {
    external_harness: CODEX_EXTERNAL_HARNESS,
    workspace_id: workspaceId,
    session_id: sessionId,
    thread_id: threadId,
    job_id: jobId,
    state,
    updated_at: updatedAt,
  };
}

async function persistCodexLaneState(
  session: PrismaSession,
  state: Omit<PersistedCodexLaneState, "external_harness" | "workspace_id" | "session_id" | "updated_at"> & { readonly updated_at?: string },
): Promise<PersistedCodexLaneState> {
  // The route may retain a Prisma snapshot while an App Server callback
  // advances the lease. Always merge against the latest row so callbacks
  // cannot overwrite a newer thread or unrelated session metadata.
  const latest = await db.session.findUnique({ where: { id: session.id } });
  const metadata = safeParse<Record<string, unknown>>(latest?.metadataJson ?? session.metadataJson, {});
  const persisted: PersistedCodexLaneState = {
    external_harness: CODEX_EXTERNAL_HARNESS,
    workspace_id: session.workspaceId,
    session_id: session.id,
    thread_id: state.thread_id,
    job_id: state.job_id,
    state: state.state,
    updated_at: state.updated_at ?? new Date().toISOString(),
  };
  metadata[CODEX_METADATA_KEY] = persisted;
  await db.session.update({ where: { id: session.id }, data: { metadataJson: JSON.stringify(metadata) } });
  return persisted;
}

async function codexSessionIdentity(
  workspaceId: string,
  sessionId: string,
): Promise<PrismaSession | null> {
  const session = await db.session.findUnique({ where: { id: sessionId } });
  if (session === null || session.workspaceId !== workspaceId || session.status === "deleted") return null;
  return session;
}

async function codexKernelContext(
  session: PrismaSession,
  operation: string,
): Promise<RequestContext> {
  // A Codex App Server process is an external harness, not a native task
  // turn. It still receives a concrete, short-lived kernel capability scoped
  // to this session's workspace and JobService only.
  return kernelTaskContext({
    sessionId: session.id,
    taskId: `${CODEX_CONTEXT_TASK_PREFIX}${session.id}`,
    turnId: `codex-${operation}-${randomUUID()}`,
    workspaceId: session.workspaceId,
    operationClasses: [
      CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
      CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
    ],
    workspacePaths: ["."],
  });
}

function codexSessionOptions(
  session: PrismaSession,
  persisted: PersistedCodexLaneState | null,
): CodexAppServerSessionOptions {
  const key = codexLaneKey(session.workspaceId, session.id);
  return {
    clients: requireKernelUds(),
    context: () => codexKernelContext(session, "rpc"),
    workspace_id: session.workspaceId,
    // Do not inherit shell credentials. Codex owns subscription auth in its
    // own supported App Server flow; Terminus never reads or forwards auth
    // store material.
    public_env: {},
    ...(persisted === null ? {} : { persisted_lease: { job_id: persisted.job_id, state: persisted.state } }),
    on_lease: async (lease: CodexAppServerLease) => {
      const latest = await db.session.findUnique({ where: { id: session.id } });
      if (latest === null || latest.workspaceId !== session.workspaceId) {
        throw new Error("Codex App Server session disappeared while persisting its job lease");
      }
      const current = readCodexLaneState(latest);
      await persistCodexLaneState(latest, {
        thread_id: current?.thread_id ?? null,
        job_id: lease.job_id,
        state: lease.state,
      });
    },
    on_event: (event) => getCodexLaneEventBuffer(key).append(event.message),
  };
}

function getCodexLaneSession(session: PrismaSession): CodexAppServerSession {
  const key = codexLaneKey(session.workspaceId, session.id);
  const existing = codexLaneSessions.get(key);
  if (existing !== undefined) {
    const state = existing.status().state;
    if (state !== "expired" && state !== "exited" && state !== "stopped") return existing;
    // A terminal process object cannot be reopened. Keep the durable thread
    // in Session.metadataJson and create a fresh kernel job for an explicit
    // reconnect/resume attempt.
    codexLaneSessions.delete(key);
  }
  const created = new CodexAppServerSession(codexSessionOptions(session, readCodexLaneState(session)));
  codexLaneSessions.set(key, created);
  return created;
}

function codexStatusFromPersisted(persisted: PersistedCodexLaneState | null): CodexAppServerStatus {
  const state = persisted?.state === "running" ? "running"
    : persisted?.state === "exited" ? "exited"
      : persisted?.state === "stopped" ? "stopped"
        : persisted?.state === "unknown_settlement" || persisted?.state === "starting" ? "unknown_settlement"
          : "not_started";
  return {
    available: state === "running",
    state,
    external_harness: CODEX_EXTERNAL_HARNESS,
    protocol: "codex-app-server.v2",
    executable: "codex",
    job_id: persisted?.job_id ?? null,
    reason: state === "unknown_settlement"
      ? "Codex App Server job settlement is unknown; reconcile before retrying"
      : state === "exited"
        ? "Codex App Server exited; start a new external session"
        : null,
  };
}

function codexErrorResponse(res: ServerResponse, error: unknown): void {
  const code = error instanceof CodexAppServerError ? error.code : "CODEX_APP_SERVER_UNAVAILABLE";
  const message = error instanceof CodexAppServerError ? error.message : "the Codex App Server lane is unavailable";
  const status = code === "CODEX_APP_SERVER_PROTOCOL_ERROR" || code === "CODEX_APP_SERVER_METHOD_UNSUPPORTED" ? 422
    : code === "CODEX_APP_SERVER_UNKNOWN_SETTLEMENT" ? 409
      : code === "CODEX_APP_SERVER_EXPIRED" ? 409
      : code === "CODEX_APP_SERVER_EXITED" ? 409
        : 503;
  const category = code === "CODEX_APP_SERVER_UNKNOWN_SETTLEMENT" ? "unknown_settlement"
    : code === "CODEX_APP_SERVER_PROTOCOL_ERROR" || code === "CODEX_APP_SERVER_METHOD_UNSUPPORTED" ? "validation"
      : "external_dependency";
  sendError(res, status, code, message, category, {
    external_harness: CODEX_EXTERNAL_HARNESS,
    reconciliation_required: code === "CODEX_APP_SERVER_UNKNOWN_SETTLEMENT",
  });
}

function codexStatusWire(
  status: CodexAppServerStatus,
  persisted: PersistedCodexLaneState | null,
): Record<string, unknown> {
  return {
    ...status,
    external_harness: CODEX_EXTERNAL_HARNESS,
    persisted_thread_id: persisted?.thread_id ?? null,
    persisted_state: persisted?.state ?? null,
    persisted_updated_at: persisted?.updated_at ?? null,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const routes: Route[] = [
  // ────────────────────────── /system ────────────────────────────────────
  route("POST", "/v1/system/initialize", async (req, res) => {
    // SPEC §30.3 — parse ClientHello, echo the intersection of supported
    // capabilities back as ServerHello.
    const body = await jsonBody(req) as {
      client?: { name?: string; version?: string } | undefined;
      protocol?: { major?: number; minor?: number } | undefined;
      capabilities?: string[] | undefined;
      experimental?: string[] | undefined;
    };
    const clientCaps = body.capabilities ?? [];
    const experimental = body.experimental ?? [];
    const supported = new Set<string>(SUPPORTED_CAPABILITIES);
    const intersection =
      clientCaps.length === 0
        ? [...SUPPORTED_CAPABILITIES]
        : clientCaps.filter((c) => supported.has(c));
    sendJson(res, 200, {
      server: {
        version: CONTROL_BUILD_VERSION,
        build_commit: CONTROL_BUILD_COMMIT,
        instance_id: CONTROL_INSTANCE_NONCE,
      },
      protocol: { major: 1, minor: 0 },
      client: body.client ?? null,
      capabilities: {
        supported: [...SUPPORTED_CAPABILITIES],
        intersection,
        experimental,
      },
      limits: { max_request_bytes: 1_048_576, max_sse_backlog: 10_000 },
    });
  }),

  // ────────────────────────── /workspaces ────────────────────────────────
  route("POST", "/v1/workspaces/open", async (req, res) => {
    const body = await jsonBody(req) as {
      root_uri: string; kind?: string; trust?: string; policy_profile_id?: string;
    };
    const kind = body.kind ?? "local_directory";
    if (kind !== "local_directory" && kind !== "local_git") {
      return sendError(res, 422, "WORKSPACE_KIND_UNSUPPORTED", "the standalone harness currently opens local directory or Git workspaces only", "validation");
    }
    const trust = body.trust ?? "untrusted";
    if (trust !== "trusted" && trust !== "untrusted" && trust !== "restricted") {
      return sendError(res, 422, "WORKSPACE_TRUST_INVALID", "workspace trust must be trusted, untrusted, or restricted", "validation");
    }
    let requestedPath: string;
    let normalizedRootUri: string;
    try {
      const rootUrl = new URL(body.root_uri);
      if (
        rootUrl.protocol !== "file:"
        || rootUrl.username.length > 0
        || rootUrl.password.length > 0
        || rootUrl.search.length > 0
        || rootUrl.hash.length > 0
      ) {
        throw new Error("root_uri must be a plain file URL");
      }
      requestedPath = fileURLToPath(rootUrl);
      if (!isAbsolute(requestedPath)) throw new Error("root_uri must resolve to an absolute path");
      normalizedRootUri = pathToFileURL(requestedPath).href;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "invalid file URL";
      return sendError(res, 422, "WORKSPACE_ROOT_INVALID", detail, "validation");
    }

    if (!kernelUds) {
      return sendError(
        res,
        503,
        "WORKSPACE_KERNEL_UNAVAILABLE",
        "opening a workspace requires the standalone kernel workspace coordinator",
        "external_dependency",
      );
    }
    let resolvedRoot: Awaited<ReturnType<KernelUdsClients["workspaces"]["ResolveRoot"]>>;
    try {
      resolvedRoot = await kernelUds.workspaces.ResolveRoot({
        context: await kernelBrokerContext(),
        rootUri: normalizedRootUri,
        candidateRoot: requestedPath,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "kernel rejected the workspace root";
      return sendError(res, 422, "WORKSPACE_ROOT_REJECTED", detail, "validation");
    }
    const existingIdentity = await db.workspace.findFirst({
      where: {
        OR: [
          { rootUri: normalizedRootUri },
          { canonicalRoot: resolvedRoot.canonicalRoot },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    if (existingIdentity && (existingIdentity.trust !== trust || existingIdentity.kind !== kind)) {
      return sendError(
        res,
        409,
        "WORKSPACE_IDENTITY_CONFLICT",
        "the existing workspace identity has different kind or trust",
        "conflict",
      );
    }
    let registered: Awaited<ReturnType<KernelUdsClients["workspaces"]["Register"]>>;
    try {
      registered = await kernelUds.workspaces.Register({
        context: await kernelBrokerContext(),
        rootUri: normalizedRootUri,
        canonicalRoot: resolvedRoot.canonicalRoot,
        trust,
        remoteEnvironmentJson: "",
        kind,
        requestedWorkspaceId: existingIdentity?.id ?? "",
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "kernel rejected the workspace root";
      return sendError(res, 422, "WORKSPACE_ROOT_REJECTED", detail, "validation");
    }
    const canonicalExisting = await db.workspace.findUnique({
      where: { canonicalRoot: registered.canonicalRoot },
    });
    if (canonicalExisting && (canonicalExisting.trust !== registered.trust || canonicalExisting.kind !== kind)) {
      return sendError(
        res,
        409,
        "WORKSPACE_IDENTITY_CONFLICT",
        "the canonical workspace root already exists with different kind or trust",
        "conflict",
      );
    }
    if (canonicalExisting && canonicalExisting.id !== registered.id) {
      try {
        registered = await kernelUds.workspaces.Register({
          context: await kernelBrokerContext(),
          rootUri: registered.rootUri,
          canonicalRoot: registered.canonicalRoot,
          trust: registered.trust,
          remoteEnvironmentJson: "",
          kind,
          requestedWorkspaceId: canonicalExisting.id,
        });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : "kernel could not preserve the existing workspace identity";
        return sendError(res, 409, "WORKSPACE_IDENTITY_CONFLICT", detail, "conflict");
      }
      if (registered.id !== canonicalExisting.id) {
        throw new Error("kernel did not preserve the authoritative workspace identity");
      }
    }
    const workspaceId = canonicalExisting?.id ?? registered.id;
    await emit({
      eventType: canonicalExisting ? "workspace.reopened" : "workspace.opened",
      aggregateType: "workspace",
      aggregateId: workspaceId,
      payload: { kind, trust: registered.trust },
    }, async (tx) => {
      if (canonicalExisting) {
        await tx.workspace.update({
          where: { id: canonicalExisting.id },
          data: { lastOpenedAt: new Date() },
        });
        return;
      }
      await tx.workspace.create({
        data: {
          id: registered.id,
          kind,
          rootUri: registered.rootUri,
          canonicalRoot: registered.canonicalRoot,
          trust: registered.trust,
          policyProfileId: body.policy_profile_id ?? "secure-local-default",
        },
      });
    });
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    sendJson(res, 201, {
      id: ws.id, kind: ws.kind, root_uri: ws.rootUri, canonical_root: ws.canonicalRoot,
      trust: ws.trust, policy_profile_id: ws.policyProfileId,
      created_at: ws.createdAt.toISOString(), last_opened_at: ws.lastOpenedAt.toISOString(),
    });
  }),
  // R8/Cubic: authoritative workspace revision for benchmark harnesses.
  route("GET", "/v1/workspaces/:id/revision", async (_req, res, params) => {
    const workspaceId = String(params.id);
    try {
      const wsRow = await db.workspace.findUnique({ where: { id: workspaceId } });
      if (wsRow === null) return sendError(res, 404, "WORKSPACE_NOT_FOUND", "workspace not found", "not_found");
      const context = await kernelTaskContextForWorkspace(workspaceId, "workspace-revision");
      const events = requireKernelUds().process.Start({
        context,
        intent: kernelIntent(),
        command: {
          program: "git",
          args: ["rev-parse", "HEAD"],
          cwd: { workspaceId, relativePath: "." },
          publicEnv: { GIT_CONFIG_NOSYSTEM: "1" },
          secretCapabilityUris: [],
          timeout: { seconds: 15, nanos: 0 },
          allocatePty: false,
          shell: undefined,
          allowUnboundedTimeout: false,
        },
        sandboxProfileId: DEV_MODE ? "degraded-local" : "secure-local-default",
        outputPolicyId: "tool-result-bounded",
      });
      const outcome = await new Promise<{ code: number; out: string }>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        let exitCode = -1;
        events.subscribe({
          next: (event: ProcessEventProto) => {
            if (event.stdout !== undefined) chunks.push(event.stdout.bytes);
            if (event.exited !== undefined) exitCode = event.exited.exitCode;
          },
          error: (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
          complete: () => resolve({ code: exitCode, out: new TextDecoder().decode(concatUint8(chunks)).trim() }),
        });
      });
      sendJson(res, 200, {
        workspace_id: workspaceId,
        revision: outcome.code === 0 && /^[0-9a-f]{40}$/.test(outcome.out) ? outcome.out : null,
        git_available: outcome.code === 0,
      });
    } catch (err) {
      logInternalError("workspace revision failed", err);
      sendError(res, 500, "REVISION_FAILED", "workspace revision failed", "internal");
    }
  }),

  route("GET", "/v1/workspaces/:id", async (_req, res, params) => {
    const ws = await db.workspace.findUnique({ where: { id: String(params.id) } });
    if (!ws) return sendError(res, 404, "WORKSPACE_NOT_FOUND", "workspace not found", "not_found");
    sendJson(res, 200, {
      id: ws.id, kind: ws.kind, root_uri: ws.rootUri, canonical_root: ws.canonicalRoot,
      trust: ws.trust, policy_profile_id: ws.policyProfileId,
      created_at: ws.createdAt.toISOString(), last_opened_at: ws.lastOpenedAt.toISOString(),
    });
  }),

  // ────────────────────────── /sessions ──────────────────────────────────
  route("POST", "/v1/sessions", async (req, res) => {
    const body = await jsonBody(req) as {
      workspace_id: string; title: string;
      default_model_profile?: string; default_permission_profile?: string;
    };
    // A missing or unknown workspace is a caller error, not an internal one.
    // Without this the insert reached Prisma and surfaced as a retryable 500,
    // which is doubly wrong: retrying an unknown workspace never succeeds.
    if (typeof body.workspace_id !== "string" || body.workspace_id.length === 0) {
      return sendError(res, 422, "WORKSPACE_ID_REQUIRED", "workspace_id is required to create a session", "validation");
    }
    if (typeof body.title !== "string" || body.title.length === 0) {
      return sendError(res, 422, "SESSION_TITLE_REQUIRED", "title is required to create a session", "validation");
    }
    if (await db.workspace.findUnique({ where: { id: body.workspace_id }, select: { id: true } }) === null) {
      return sendError(res, 404, "WORKSPACE_NOT_FOUND", "workspace not found; open it before creating a session", "not_found");
    }
    const id = uuid();
    const rootThreadId = uuid();
    await emit({
      eventType: "session.created",
      aggregateType: "session",
      aggregateId: id,
      payload: {
        title: body.title,
        workspace_id: body.workspace_id,
        root_thread_id: rootThreadId,
      },
    }, async (tx) => {
      await tx.session.create({
        data: {
          id,
          workspaceId: body.workspace_id,
          ownerPrincipal: SERVER_PRINCIPAL,
          title: body.title,
          status: "active",
          defaultModelProfile: body.default_model_profile ?? "implementer",
          defaultPermissionProfile: isPermissionProfile(body.default_permission_profile)
            ? body.default_permission_profile
            : DEFAULT_PERMISSION_PROFILE,
        },
      });
      await tx.thread.create({
        data: { id: rootThreadId, sessionId: id, status: "active" },
      });
      await tx.session.update({
        where: { id },
        data: { activeThreadId: rootThreadId },
      });
    });
    const [session, thread] = await Promise.all([
      db.session.findUniqueOrThrow({ where: { id } }),
      db.thread.findUniqueOrThrow({ where: { id: rootThreadId } }),
    ]);
    sendJson(res, 201, {
      id: session.id, workspace_id: session.workspaceId, owner_principal: session.ownerPrincipal,
      title: session.title, status: session.status,
      default_model_profile: session.defaultModelProfile,
      default_permission_profile: session.defaultPermissionProfile,
      active_thread_id: thread.id,
      created_at: session.createdAt.toISOString(), updated_at: session.updatedAt.toISOString(),
    });
  }),
  route("GET", "/v1/sessions/:id", async (_req, res, params) => {
    const s = await db.session.findUnique({
      where: { id: String(params.id) },
      include: { workspace: { select: { rootUri: true } } },
    });
    if (!s) return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");
    sendJson(res, 200, {
      id: s.id, workspace_id: s.workspaceId, owner_principal: s.ownerPrincipal,
      workspace_root_uri: s.workspace.rootUri,
      title: s.title, status: s.status,
      default_model_profile: s.defaultModelProfile,
      default_permission_profile: s.defaultPermissionProfile,
      default_model: s.defaultModel,
      default_reasoning_effort: s.defaultReasoningEffort,
      default_provider_account_id: s.defaultProviderAccountId,
      active_thread_id: s.activeThreadId,
      created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(),
    });
  }),
  /**
   * H7: session-level defaults for per-turn model selection. A client that
   * wants "this conversation uses big-pickle at high effort" sets it once
   * instead of repeating it on every `POST /v1/turns`. An explicit per-turn
   * value still wins. Sending `null` clears the default.
   */
  route("PATCH", "/v1/sessions/:id", async (req, res, params) => {
    const body = await jsonBody(req) as {
      default_model?: unknown;
      default_reasoning_effort?: unknown;
      default_permission_profile?: unknown;
      default_provider_account_id?: unknown;
    };
    const data: {
      defaultModel?: string | null;
      defaultReasoningEffort?: string | null;
      defaultPermissionProfile?: PermissionProfile;
      defaultProviderAccountId?: string | null;
    } = {};
    // The permission level is the one session default that changes what the
    // agent may do without asking, so it accepts only the three named levels.
    if ("default_permission_profile" in body) {
      if (!isPermissionProfile(body.default_permission_profile)) {
        return sendError(
          res,
          400,
          "SESSION_DEFAULT_PERMISSION_PROFILE_INVALID",
          `default_permission_profile must be one of ${PERMISSION_PROFILES.join(", ")}`,
          "validation",
          { supplied: body.default_permission_profile, accepted: [...PERMISSION_PROFILES] },
        );
      }
      data.defaultPermissionProfile = body.default_permission_profile;
    }
    if ("default_model" in body) {
      if (body.default_model === null) {
        data.defaultModel = null;
      } else if (
        typeof body.default_model === "string"
        && body.default_model.trim().length > 0
        && body.default_model.length <= 256
      ) {
        data.defaultModel = body.default_model.trim();
      } else {
        return sendError(
          res,
          400,
          "SESSION_DEFAULT_MODEL_INVALID",
          "default_model must be null or a model id of 1..256 characters",
          "validation",
        );
      }
    }
    if ("default_reasoning_effort" in body) {
      if (body.default_reasoning_effort === null) {
        data.defaultReasoningEffort = null;
      } else {
        const effort = parseReasoningEffort(body.default_reasoning_effort);
        if (effort === null) {
          return sendError(
            res,
            400,
            "SESSION_DEFAULT_REASONING_EFFORT_INVALID",
            `default_reasoning_effort must be null or one of ${REASONING_EFFORTS.join(", ")}`,
            "validation",
            { supplied: body.default_reasoning_effort },
          );
        }
        data.defaultReasoningEffort = effort;
      }
    }
    // The routing account a session pins its model to. Null clears it and
    // returns the session to the installation default.
    if ("default_provider_account_id" in body) {
      if (body.default_provider_account_id === null) {
        data.defaultProviderAccountId = null;
      } else if (
        typeof body.default_provider_account_id === "string"
        && body.default_provider_account_id.trim().length > 0
        && body.default_provider_account_id.length <= 128
      ) {
        data.defaultProviderAccountId = body.default_provider_account_id.trim();
      } else {
        return sendError(
          res,
          400,
          "SESSION_DEFAULT_PROVIDER_ACCOUNT_INVALID",
          "default_provider_account_id must be null or a provider account id of 1..128 characters",
          "validation",
        );
      }
    }
    if (Object.keys(data).length === 0) {
      return sendError(
        res,
        400,
        "SESSION_UPDATE_EMPTY",
        "supply default_model, default_reasoning_effort, default_provider_account_id, and/or default_permission_profile",
        "validation",
      );
    }
    // A named default must be admitted now, so the failure surfaces where the
    // user chose it rather than on the next turn. Which catalogue admits it
    // depends on which account the session will route to after this patch.
    // Only routing fields trigger admission. Changing the permission level must
    // not fail because some *other* default has since gone stale.
    const routingPatched = data.defaultModel !== undefined
      || data.defaultProviderAccountId !== undefined;
    const patchedSession = routingPatched
      ? await db.session.findUnique({
          where: { id: String(params.id) },
          select: { defaultProviderAccountId: true },
        })
      : null;
    const effectiveAccountId = data.defaultProviderAccountId === undefined
      ? patchedSession?.defaultProviderAccountId ?? null
      : data.defaultProviderAccountId;
    const patchResolution = routingPatched
      ? resolveTurnProvider({
          requestedAccountId: effectiveAccountId,
          accounts: await listProviderAccountRecords(),
          hasModel: typeof data.defaultModel === "string",
        })
      : { kind: "legacy" as const };
    if (patchResolution.kind === "error") {
      return sendProviderAccountResolutionError(res, patchResolution);
    }
    if (typeof data.defaultModel === "string") {
      if (patchResolution.kind === "account") {
        const admitted = await admittedProviderAccountModel(patchResolution.account, data.defaultModel);
        if (admitted === null) {
          return sendError(
            res,
            409,
            "MODEL_NOT_ADMITTED",
            `model '${data.defaultModel}' has no admitted discovery record for account '${patchResolution.account.displayName}'`,
            "conflict",
            {
              requested_model: data.defaultModel,
              provider_account_id: patchResolution.account.id,
              discovered_models: await admittedProviderAccountModelIds(patchResolution.account),
            },
          );
        }
      } else {
        const gatewayRow = await db.gatewayProviderConfiguration.findUnique({
          where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
        });
        const credential = gatewayRow === null ? null : gatewayDiscoveryCredential(gatewayRow);
        const admitted = credential === null
          ? null
          : await admittedGatewayModelRecord(credential, data.defaultModel);
        if (admitted === null) {
          return sendError(
            res,
            409,
            "MODEL_NOT_ADMITTED",
            `model '${data.defaultModel}' has no admitted discovery record for this gateway account`,
            "conflict",
            {
              requested_model: data.defaultModel,
              ...(credential === null
                ? { discovered_models: [] }
                : {
                    deployment: credential.deployment,
                    discovered_models: await admittedGatewayModelIds(credential),
                  }),
            },
          );
        }
      }
    }
    const updated = await writerTransaction(async (tx) => {
      const current = await tx.session.findUnique({
        where: { id: String(params.id) },
        select: { id: true },
      });
      if (current === null) return null;
      return tx.session.update({
        where: { id: current.id },
        data,
        include: { workspace: { select: { rootUri: true } } },
      });
    });
    if (updated === null) {
      return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");
    }
    sendJson(res, 200, {
      id: updated.id,
      workspace_id: updated.workspaceId,
      workspace_root_uri: updated.workspace.rootUri,
      owner_principal: updated.ownerPrincipal,
      title: updated.title,
      status: updated.status,
      default_model_profile: updated.defaultModelProfile,
      default_permission_profile: updated.defaultPermissionProfile,
      default_model: updated.defaultModel,
      default_reasoning_effort: updated.defaultReasoningEffort,
      default_provider_account_id: updated.defaultProviderAccountId,
      active_thread_id: updated.activeThreadId,
      created_at: updated.createdAt.toISOString(),
      updated_at: updated.updatedAt.toISOString(),
    });
  }),
  route("GET", "/v1/sessions/:id/rollout", async (req, res, params) => {
    const s = await db.session.findUnique({ where: { id: String(params.id) } });
    if (!s) return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");

    const url = new URL(req.url ?? "/", "http://terminus.local");
    const cursor = url.searchParams.get("cursor");
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? 100) || 100));

    const threads = await db.thread.findMany({
      where: { sessionId: s.id },
      select: { id: true },
    });
    const threadIds = threads.map((t) => t.id);

    const turns = threadIds.length > 0
      ? await db.turn.findMany({
          where: { threadId: { in: threadIds } },
          select: { id: true },
        })
      : [];
    const turnIds = turns.map((t) => t.id);

    const tasks = await db.task.findMany({
      where: { sessionId: s.id },
      select: { id: true },
    });
    const taskIds = tasks.map((t) => t.id);

    const aggregateConditions: Array<
      | { aggregateType: string; aggregateId: string }
      | { aggregateType: string; aggregateId: { in: string[] } }
    > = [{ aggregateType: "session", aggregateId: s.id }];

    if (threadIds.length > 0) {
      aggregateConditions.push({ aggregateType: "thread", aggregateId: { in: threadIds } });
    }
    if (turnIds.length > 0) {
      aggregateConditions.push({ aggregateType: "turn", aggregateId: { in: turnIds } });
      aggregateConditions.push({ aggregateType: "tool_call", aggregateId: { in: turnIds } });
    }
    if (taskIds.length > 0) {
      aggregateConditions.push({ aggregateType: "task", aggregateId: { in: taskIds } });
    }

    const rows = await db.semanticEvent.findMany({
      where: { OR: aggregateConditions },
      orderBy: [{ occurredAt: "asc" }, { aggregateSequence: "asc" }, { eventId: "asc" }],
    });

    const projected = projectStoredEvents(rows);
    let lines = projected;
    if (cursor !== null) {
      const idx = projected.findIndex((l) => l.item.event_id === cursor);
      if (idx >= 0) {
        lines = projected.slice(idx + 1);
      }
    }

    const pagedLines = lines.slice(0, limit);
    const nextCursor = lines.length > limit ? (pagedLines.at(-1)?.item.event_id ?? null) : null;

    const accept = req.headers.accept ?? "";
    if (accept.includes("application/x-ndjson") || accept.includes("text/jsonl")) {
      const jsonl = rolloutToJsonl(pagedLines);
      const buf = Buffer.from(jsonl, "utf8");
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "content-length": String(buf.length),
        "access-control-allow-origin": CONTROL_CORS_ORIGIN,
        "vary": "origin",
      });
      res.end(buf);
      return;
    }

    sendJson(res, 200, {
      lines: pagedLines,
      next_cursor: nextCursor,
    });
  }),
  route("GET", "/v1/sessions", async (req, res) => {
    const page = parsePageRequest(req, res);
    if (!page) return;
    const where = { status: { not: "deleted" } } as const;
    const [sessionRows, total] = await Promise.all([
      db.session.findMany({
        where,
        orderBy: { id: "asc" },
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
        take: page.limit + 1,
        // H7: the desktop shows which directory and model a session belongs to
        // without a second round trip per row.
        include: { workspace: { select: { rootUri: true } } },
      }),
      db.session.count({ where }),
    ]);
    const sessions = sessionRows.slice(0, page.limit);
    sendJson(res, 200, {
      sessions: sessions.map((s) => ({
        id: s.id, workspace_id: s.workspaceId, owner_principal: s.ownerPrincipal,
        workspace_root_uri: s.workspace.rootUri,
        title: s.title, status: s.status,
        default_model_profile: s.defaultModelProfile,
        default_permission_profile: s.defaultPermissionProfile,
        default_model: s.defaultModel,
        default_reasoning_effort: s.defaultReasoningEffort,
        default_provider_account_id: s.defaultProviderAccountId,
        active_thread_id: s.activeThreadId,
        created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(),
      })),
      total,
      next_cursor: nextPageCursor(sessionRows, page.limit),
    });
  }),
  // SPEC §32.2 — pause a session (liveness preserved; turns blocked).
  route("POST", "/v1/sessions/:id/pause", async (_req, res, params) => {
    const s = await db.session.findUnique({ where: { id: String(params.id) } });
    if (!s) return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");
    await emit({
      eventType: "session.paused",
      aggregateType: "session",
      aggregateId: s.id,
      payload: { previous_status: s.status, new_status: "paused" },
    }, async (tx) => {
      const changed = await tx.session.updateMany({
        where: { id: s.id, status: s.status },
        data: { status: "paused" },
      });
      if (changed.count !== 1) throw new Error(`session ${s.id} changed before pause`);
    });
    const updated = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    sendJson(res, 200, {
      id: updated.id, workspace_id: updated.workspaceId, owner_principal: updated.ownerPrincipal,
      title: updated.title, status: updated.status,
      default_model_profile: updated.defaultModelProfile,
      default_permission_profile: updated.defaultPermissionProfile,
      active_thread_id: updated.activeThreadId,
      created_at: updated.createdAt.toISOString(), updated_at: updated.updatedAt.toISOString(),
    });
  }),
  route("POST", "/v1/sessions/:id/resume", async (_req, res, params) => {
    const s = await db.session.findUnique({ where: { id: String(params.id) } });
    if (!s) return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");
    if (!canResumeSession(s.status)) {
      return sendError(
        res,
        409,
        "ILLEGAL_TRANSITION",
        `illegal session transition ${s.status} -> active`,
        "conflict",
        { from: s.status, to: "active" },
      );
    }
    await emit({
      eventType: "session.resumed",
      aggregateType: "session",
      aggregateId: s.id,
      payload: { previous_status: s.status, new_status: "active" },
    }, async (tx) => {
      const changed = await tx.session.updateMany({
        where: { id: s.id, status: s.status },
        data: { status: "active" },
      });
      if (changed.count !== 1) throw new Error(`session ${s.id} changed before resume`);
    });
    const updated = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    sendJson(res, 200, {
      id: updated.id, workspace_id: updated.workspaceId, owner_principal: updated.ownerPrincipal,
      title: updated.title, status: updated.status,
      default_model_profile: updated.defaultModelProfile,
      default_permission_profile: updated.defaultPermissionProfile,
      active_thread_id: updated.activeThreadId,
      created_at: updated.createdAt.toISOString(), updated_at: updated.updatedAt.toISOString(),
    });
  }),

  // ────────────────────────── /threads ───────────────────────────────────
  route("POST", "/v1/threads", async (req, res) => {
    const body = await jsonBody(req) as { session_id: string; parent_thread_id?: string | null };
    const parentThreadId = body.parent_thread_id ?? null;
    if (parentThreadId !== null) {
      const parent = await db.thread.findUnique({ where: { id: parentThreadId } });
      if (parent === null) return sendError(res, 404, "THREAD_NOT_FOUND", "parent thread not found", "not_found");
      if (parent.sessionId !== body.session_id) {
        return sendError(res, 409, "THREAD_SESSION_MISMATCH", "parent thread belongs to a different session", "conflict");
      }
    }
    const id = uuid();
    await emit({
      eventType: "thread.created",
      aggregateType: "thread",
      aggregateId: id,
      correlationId: body.session_id,
      payload: { session_id: body.session_id, parent_thread_id: parentThreadId },
    }, async (tx) => {
      await tx.thread.create({
        data: {
          id,
          sessionId: body.session_id,
          parentThreadId,
          status: "active",
        },
      });
    });
    const t = await db.thread.findUniqueOrThrow({ where: { id } });
    sendJson(res, 201, { id: t.id, session_id: t.sessionId, created_at: t.createdAt.toISOString() });
  }),
  route("GET", "/v1/sessions/:id/threads", async (_req, res, params) => {
    const threads = await db.thread.findMany({
      where: { sessionId: String(params.id), status: { not: "deleted" } },
      orderBy: { createdAt: "asc" },
    });
    sendJson(res, 200, { threads });
  }),
  // SPEC §32.2 — fork a thread from an existing one (optionally from a
  // specific turn). The child thread shares the session and records its
  // parent + fork point.
  route("POST", "/v1/threads/:id/fork", async (req, res, params) => {
    const body = await jsonBody(req) as { from_turn_id?: string | null };
    const parent = await db.thread.findUnique({ where: { id: String(params.id) } });
    if (!parent) return sendError(res, 404, "THREAD_NOT_FOUND", "thread not found", "not_found");
    const fromTurn = body.from_turn_id ?? parent.headTurnId ?? null;
    if (fromTurn !== null) {
      const turn = await db.turn.findUnique({ where: { id: fromTurn }, select: { threadId: true } });
      if (turn === null) return sendError(res, 404, "TURN_NOT_FOUND", "fork turn not found", "not_found");
      if (turn.threadId !== parent.id) {
        return sendError(res, 409, "FORK_TURN_MISMATCH", "fork turn does not belong to the parent thread", "conflict");
      }
    }
    const childId = uuid();
    await emit({
      eventType: "thread.forked",
      aggregateType: "thread",
      aggregateId: childId,
      correlationId: parent.id,
      payload: { parent_thread_id: parent.id, from_turn_id: fromTurn },
    }, async (tx) => {
      await tx.thread.create({
        data: {
          id: childId,
          sessionId: parent.sessionId,
          parentThreadId: parent.id,
          forkedFromTurnId: fromTurn,
          status: "active",
        },
      });
    });
    const child = await db.thread.findUniqueOrThrow({ where: { id: childId } });
    sendJson(res, 201, {
      id: child.id, session_id: child.sessionId, parent_thread_id: child.parentThreadId,
      forked_from_turn_id: child.forkedFromTurnId, status: child.status,
      created_at: child.createdAt.toISOString(),
    });
  }),

  // ────────────────────────── /tasks ─────────────────────────────────────
  route("POST", "/v1/tasks", async (req, res) => {
    const body = await jsonBody(req) as {
      session_id: string; thread_id: string; objective: string;
      non_goals?: string[];
      acceptance_criteria?: Array<{ id: string; statement: string; verification_hint?: string | null; required?: boolean }>;
      allowed_scope?: { read_paths?: string[]; write_paths?: string[]; external_systems?: string[] };
      risk_class?: string;
    };
    if (typeof body.objective !== "string" || body.objective.trim().length === 0) {
      return sendError(res, 400, "TASK_OBJECTIVE_REQUIRED", "task objective must be a non-empty string", "validation");
    }
    const parsedCriteria = z.array(z.object({
      id: z.string().min(1).max(128),
      statement: z.string().min(1).max(4_096),
      verification_hint: z.string().max(4_096).nullable().optional(),
      required: z.boolean().optional(),
    }).strict()).max(100).safeParse(body.acceptance_criteria ?? []);
    if (!parsedCriteria.success) {
      return sendError(
        res,
        400,
        "TASK_ACCEPTANCE_CRITERIA_INVALID",
        "acceptance criteria did not satisfy the task contract schema",
        "validation",
        { issues: parsedCriteria.error.issues },
      );
    }
    const acceptanceCriteria = parsedCriteria.data.length > 0
      ? parsedCriteria.data
      : [{
          id: "requested-outcome",
          statement: `Requested outcome is satisfied: ${body.objective.trim()}`,
          verification_hint: null,
          required: true,
        }];
    if (new Set(acceptanceCriteria.map((criterion) => criterion.id)).size !== acceptanceCriteria.length) {
      return sendError(res, 400, "TASK_ACCEPTANCE_CRITERIA_DUPLICATE", "acceptance criterion ids must be unique", "validation");
    }
    if (!acceptanceCriteria.some((criterion) => criterion.required ?? true)) {
      return sendError(
        res,
        400,
        "TASK_REQUIRED_ACCEPTANCE_CRITERION_MISSING",
        "at least one acceptance criterion must be required",
        "validation",
      );
    }
    const id = uuid();
    const scope = body.allowed_scope ?? {};
    const normalizedScope = v1AllowedScopeProjection(scope);
    // Initial contract version 1.
    const initialContract: TaskContractHashInput = {
      version: 1,
      objective: body.objective,
      userOutcome: null,
      nonGoals: body.non_goals ?? [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: normalizedScope,
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    };
    const initialContractHash = taskContractHash(initialContract);
    try {
      await emit({
        eventType: "task.created",
        aggregateType: "task", aggregateId: id,
        payload: { objective: body.objective, session_id: body.session_id, thread_id: body.thread_id },
      }, async (tx) => {
        const thread = await tx.thread.findUnique({
          where: { id: body.thread_id },
          select: { sessionId: true },
        });
        if (thread === null) throw new TaskLineageAdmissionError("thread_not_found");
        if (thread.sessionId !== body.session_id) {
          throw new TaskLineageAdmissionError("session_mismatch", thread.sessionId);
        }
        await tx.task.create({
          data: {
            id, sessionId: body.session_id, threadId: body.thread_id,
            status: "DRAFT", phase: "INTAKE", riskClass: body.risk_class ?? "normal",
            budgetJson: JSON.stringify({ model_micros: 5_000_000, compute_seconds: 600, wall_clock_seconds: 3600, human_approvals: 20 }),
            scopeDigest: JSON.stringify(normalizedScope),
          },
        });
        await tx.taskContractVersion.create({
          data: {
            task_id: id, version: 1,
            objective: body.objective, userOutcome: null,
            nonGoalsJson: JSON.stringify(body.non_goals ?? []),
            constraintsJson: "[]",
            assumptionsJson: "[]",
            unknownsJson: "[]",
            allowedScopeJson: JSON.stringify(normalizedScope),
            changePolicyJson: JSON.stringify({ mayExpandScope: false, scopeExpansionRequiresUser: true }),
            contentHash: initialContractHash,
            createdBy: SERVER_PRINCIPAL,
          },
        });
        for (const c of acceptanceCriteria) {
          await tx.acceptanceCriterion.create({
            data: {
              taskId: id, contractVersion: 1, criterionId: c.id,
              statement: c.statement, verificationHint: c.verification_hint ?? null,
              required: c.required ?? true, status: "pending",
            },
          });
        }
        const ledgerRows = scopeLedgerRows({
          taskId: id,
          contractVersion: 1,
          scope: normalizedScope,
          source: "user_contract",
          reason: "initial task contract scope",
        });
        if (ledgerRows.length > 0) {
          await tx.scopeLedgerEntry.createMany({ data: ledgerRows });
        }
      });
    } catch (error: unknown) {
      if (error instanceof TaskLineageAdmissionError) {
        if (error.reason === "thread_not_found") {
          return sendError(res, 404, "THREAD_NOT_FOUND", "thread not found", "not_found");
        }
        return sendError(
          res,
          409,
          "TASK_SESSION_THREAD_MISMATCH",
          "thread does not belong to the supplied session",
          "conflict",
          {
            supplied_session_id: body.session_id,
            thread_id: body.thread_id,
            actual_session_id: error.actualSessionId,
          },
        );
      }
      throw error;
    }
    const t = await db.task.findUniqueOrThrow({ where: { id } });
    await synchronizeV1TaskProjection(id, "task.created");
    sendJson(res, 201, {
      id: t.id, session_id: t.sessionId, thread_id: t.threadId,
      status: t.status, phase: t.phase,
      active_contract_version: t.activeContractVersion,
      risk_class: t.riskClass,
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
      completed_at: null,
      terminal_reason: null,
      contract: {
        version: 1,
        content_hash: initialContractHash,
        objective: body.objective,
        non_goals: body.non_goals ?? [],
        allowed_scope: {
          read_paths: normalizedScope.read_paths,
          write_paths: normalizedScope.write_paths,
          external_systems: normalizedScope.external_systems,
        },
      },
    });
  }),
  route("POST", "/v1/tasks/:id/start", async (_req, res, params) => {
    const taskId = String(params.id);
    const current = await db.task.findUnique({ where: { id: taskId } });
    if (!current) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    if (current.status !== "DRAFT") {
      return sendError(
        res,
        409,
        "TASK_START_STATE_CONFLICT",
        `task cannot start from ${current.status}`,
        "conflict",
        { task_id: taskId, status: current.status, allowed_status: "DRAFT" },
      );
    }
    const requiredCriteria = await db.acceptanceCriterion.count({
      where: {
        taskId,
        contractVersion: current.activeContractVersion,
        required: true,
      },
    });
    if (requiredCriteria === 0) {
      return sendError(
        res,
        409,
        "TASK_REQUIRED_ACCEPTANCE_CRITERION_MISSING",
        "task cannot start without at least one required acceptance criterion",
        "validation",
        { task_id: taskId, contract_version: current.activeContractVersion },
      );
    }
    const activatedEvent = await emit({
      eventType: "task.activated",
      aggregateType: "task", aggregateId: taskId,
      payload: { phase: "DISCOVER" },
    }, async (tx) => {
      const activated = await tx.task.updateMany({
        where: { id: taskId, status: "DRAFT" },
        data: { status: "ACTIVE", phase: "DISCOVER" },
      });
      if (activated.count !== 1) {
        throw new Error(`task ${taskId} changed before atomic activation`);
      }
    });
    const t = await db.task.findUnique({ where: { id: taskId } });
    if (!t) return sendError(res, 500, "TASK_START_LOST", "started task could not be reloaded", "integrity");
    await synchronizeV1TaskProjection(t.id, "task.running");
    sendJson(res, 200, {
      task_id: t.id, status: t.status,
      event_cursor: activatedEvent.eventId,
      links: {
        events: `/v1/events?task_id=${t.id}`,
        task: `/v1/tasks/${t.id}`,
      },
    });
  }),
  route("POST", "/v1/tasks/:id/cancel", async (req, res, params) => {
    const body = await jsonBody(req) as { reason?: string | null };
    const taskId = String(params.id);
    const reason = body.reason ?? "user_cancelled";
    const current = await db.task.findUnique({ where: { id: taskId } });
    if (!current) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    if (!isMutableV1TaskStatus(current.status)) {
      return sendError(res, 409, "TASK_ALREADY_TERMINAL", `task is already terminal (${current.status})`, "conflict");
    }
    try {
      // The HTTP dispatcher already owns mutationMutex for this mutating
      // route. Reacquiring it here deadlocks the request before the durable
      // task.aborted event can reach an overlapping SSE subscriber.
      // Cancellation remains one event-plus-row transaction below.
      const activeTurns = await db.turn.findMany({
        where: { taskId, state: { in: [...V1_ACTIVE_TURN_STATES, "REPAIR_PENDING"] } },
        orderBy: { sequence: "asc" },
      });
      const cancellationEvents: EmitInput[] = [
        ...activeTurns.map((activeTurn) => ({
          eventType: "turn.aborted" as const,
          aggregateType: "turn" as const,
          aggregateId: activeTurn.id,
          correlationId: taskId,
          idempotencyKey: `task-cancel:${taskId}:turn:${activeTurn.id}`,
          payload: {
            reason,
            previous_state: activeTurn.state,
            phase: activeTurn.state,
          },
        })),
        {
          eventType: "task.aborted" as const,
          aggregateType: "task" as const,
          aggregateId: taskId,
          correlationId: taskId,
          idempotencyKey: `task-cancel:${taskId}`,
          payload: { reason, turn_ids: activeTurns.map((turn) => turn.id) },
        },
      ];
      await emitAtomicBatch(cancellationEvents, async (tx) => {
        for (const activeTurn of activeTurns) {
          const turnUpdate = await tx.turn.updateMany({
            where: {
              id: activeTurn.id,
              taskId,
              state: { in: [...V1_ACTIVE_TURN_STATES, "REPAIR_PENDING"] },
            },
            data: {
              state: "ABORTED",
              completedAt: new Date(),
              terminalErrorJson: JSON.stringify({ reason, cancellation: true }),
            },
          });
          if (turnUpdate.count !== 1) {
            throw new TurnAdmissionError("state_changed", activeTurn.state);
          }
        }
        const update = await tx.task.updateMany({
          where: { id: taskId, status: { in: [...V1_MUTABLE_TASK_STATUSES] } },
          data: {
            status: "ABORTED",
            completedAt: new Date(),
            terminalReasonJson: JSON.stringify({ reason }),
          },
        });
        if (update.count !== 1) throw new Error(`task ${taskId} changed before atomic cancellation`);
      });
      for (const activeTurn of activeTurns) {
        abortActiveTurn(activeTurn.id, reason);
      }
    } catch (error: unknown) {
      if (error instanceof TurnAdmissionError) {
        return sendError(
          res,
          409,
          "TURN_CANCELLATION_STATE_CONFLICT",
          `turn cannot be cancelled from ${error.detail ?? "unknown"}`,
          "conflict",
          { task_id: taskId },
        );
      }
      throw error;
    }
    const t = await db.task.findUnique({
      where: { id: taskId },
      include: {
        contractVersions: {
          orderBy: { version: "desc" },
          take: 1,
          include: { acceptanceCriteria: { orderBy: { criterionId: "asc" } } },
        },
      },
    });
    if (!t) return sendError(res, 500, "TASK_CANCEL_LOST", "cancelled task could not be reloaded", "integrity");
    await synchronizeV1TaskProjection(t.id, "task.cancelled");
    sendJson(res, 200, {
      id: t.id, session_id: t.sessionId, thread_id: t.threadId,
      status: t.status, phase: t.phase,
      active_contract_version: t.activeContractVersion,
      risk_class: t.riskClass,
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
      completed_at: t.completedAt?.toISOString() ?? null,
      terminal_reason: t.terminalReasonJson === null
        ? null
        : safeParse<Record<string, unknown> | null>(t.terminalReasonJson, null),
      contract: taskContractWire(t.contractVersions[0]),
    });
  }),
  // SPEC §32.2 — amend the task contract. Creates a new
  // TaskContractVersion and bumps `activeContractVersion` so consumers
  // always read the live contract.
  route("PATCH", "/v1/tasks/:id/contract", async (req, res, params) => {
    const body = await jsonBody(req) as {
      objective?: string;
      non_goals?: string[];
      allowed_scope?: { read_paths?: string[]; write_paths?: string[]; external_systems?: string[] };
      constraints?: unknown[];
      assumptions?: unknown[];
      unknowns?: unknown[];
      change_policy?: { mayExpandScope?: boolean; scopeExpansionRequiresUser?: boolean };
      rationale?: string | null;
    };
    const taskId = String(params.id);
    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    if (!isMutableV1TaskStatus(task.status)) {
      return sendError(res, 409, "TASK_CONTRACT_TERMINAL", `terminal task contracts are immutable (${task.status})`, "conflict");
    }
    const prevVersion = task.activeContractVersion;
    const nextVersion = prevVersion + 1;
    const prevContract = await db.taskContractVersion.findUnique({
      where: { task_id_version: { task_id: task.id, version: prevVersion } },
    });
    if (!prevContract) {
      return sendError(
        res,
        409,
        "TASK_CONTRACT_MISSING",
        `active task contract version ${prevVersion} is missing`,
        "integrity",
      );
    }
    const prevScope = v1AllowedScopeProjection(safeParse<unknown>(prevContract.allowedScopeJson, {}));
    const nextScope = v1AllowedScopeProjection(body.allowed_scope ?? prevScope);
    const expansions = scopeExpansionResources(prevScope, nextScope);
    if (expansions.length > 0) {
      return sendError(
        res,
        409,
        "TASK_SCOPE_EXPANSION_APPROVAL_REQUIRED",
        "task scope expansion requires a trusted user approval before the contract can change",
        "permission",
        { task_id: taskId, contract_version: prevVersion, proposed_resources: expansions },
      );
    }
    const prevNonGoals = safeParse(prevContract.nonGoalsJson, []);
    const prevConstraints = safeParse(prevContract.constraintsJson, []);
    const prevAssumptions = safeParse(prevContract.assumptionsJson, []);
    const prevUnknowns = safeParse(prevContract.unknownsJson, []);
    const prevChangePolicy = safeParse(
      prevContract.changePolicyJson,
      { mayExpandScope: false, scopeExpansionRequiresUser: true },
    );
    const nextContract: TaskContractHashInput = {
      version: nextVersion,
      objective: body.objective ?? prevContract.objective,
      userOutcome: null,
      nonGoals: body.non_goals ?? prevNonGoals,
      constraints: body.constraints ?? prevConstraints,
      assumptions: body.assumptions ?? prevAssumptions,
      unknowns: body.unknowns ?? prevUnknowns,
      allowedScope: nextScope,
      changePolicy: body.change_policy ?? prevChangePolicy,
    };
    const conflictMessage = `task ${taskId} changed before atomic contract amendment`;
    try {
      await emit({
        eventType: "task.contract_amended",
        aggregateType: "task_contract_version",
        aggregateId: `${taskId}@${nextVersion}`,
        correlationId: taskId,
        payload: {
          task_id: taskId, previous_version: prevVersion, new_version: nextVersion,
          objective: nextContract.objective, rationale: body.rationale ?? null,
        },
      }, async (tx) => {
        const advance = await tx.task.updateMany({
          where: {
            id: taskId,
            activeContractVersion: prevVersion,
            status: { in: [...V1_MUTABLE_TASK_STATUSES] },
          },
          data: {
            activeContractVersion: nextVersion,
            scopeDigest: JSON.stringify(nextScope),
          },
        });
        if (advance.count !== 1) throw new Error(conflictMessage);
        await tx.taskContractVersion.create({
          data: {
            task_id: taskId,
            version: nextVersion,
            objective: nextContract.objective,
            userOutcome: null,
            nonGoalsJson: JSON.stringify(nextContract.nonGoals),
            constraintsJson: JSON.stringify(nextContract.constraints),
            assumptionsJson: JSON.stringify(nextContract.assumptions),
            unknownsJson: JSON.stringify(nextContract.unknowns),
            allowedScopeJson: JSON.stringify(nextScope),
            changePolicyJson: JSON.stringify(nextContract.changePolicy),
            contentHash: taskContractHash(nextContract),
            createdBy: SERVER_PRINCIPAL,
          },
        });
        const criteria = await tx.acceptanceCriterion.findMany({
          where: { taskId, contractVersion: prevVersion },
        });
        if (criteria.length > 0) {
          await tx.acceptanceCriterion.createMany({
            data: criteria.map((criterion) => ({
              taskId,
              contractVersion: nextVersion,
              criterionId: criterion.criterionId,
              statement: criterion.statement,
              verificationHint: criterion.verificationHint,
              required: criterion.required,
              status: "pending",
            })),
          });
        }
        const ledgerRows = scopeLedgerRows({
          taskId,
          contractVersion: nextVersion,
          scope: nextScope,
          source: "contract_amendment",
          reason: body.rationale ?? "contract amended without scope expansion",
        });
        if (ledgerRows.length > 0) {
          await tx.scopeLedgerEntry.createMany({ data: ledgerRows });
        }
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === conflictMessage) {
        return sendError(res, 409, "TASK_CONTRACT_VERSION_CONFLICT", "task contract changed during amendment", "conflict");
      }
      throw error;
    }
    const newContract = await db.taskContractVersion.findUniqueOrThrow({
      where: { task_id_version: { task_id: taskId, version: nextVersion } },
    });
    const amendedTaskId = taskId;
    await synchronizeV1TaskProjection(amendedTaskId, "task.contract_updated");
    sendJson(res, 200, {
      task_id: amendedTaskId, version: newContract.version, objective: newContract.objective,
      non_goals: safeParse(newContract.nonGoalsJson, []),
      allowed_scope: safeParse(newContract.allowedScopeJson, {}),
      change_policy: safeParse(newContract.changePolicyJson, {}),
      content_hash: newContract.contentHash,
      created_by: newContract.createdBy,
      created_at: newContract.createdAt.toISOString(),
    });
  }),
  route("GET", "/v1/tasks/:id", async (_req, res, params) => {
    const t = await db.task.findUnique({
      where: { id: String(params.id) },
      include: {
        contractVersions: {
          orderBy: { version: "desc" },
          take: 1,
          include: { acceptanceCriteria: { orderBy: { criterionId: "asc" } } },
        },
        turns: {
          select: {
            id: true,
            state: true,
            sequence: true,
            startedAt: true,
            completedAt: true,
            providerAttempts: {
              select: {
                usageJson: true,
                costMicros: true,
                providerReportedCostMicros: true,
                computedCostMicros: true,
                costSource: true,
                startedAt: true,
                completedAt: true,
              },
            },
          },
        },
        repairAttempts: {
          orderBy: { attemptNumber: "asc" },
          select: {
            id: true,
            parentTurnId: true,
            repairTurnId: true,
            attemptNumber: true,
            maxAttempts: true,
            state: true,
            directiveArtifact: true,
            failedNodeIdsJson: true,
            failureSignaturesJson: true,
            changedFilesJson: true,
            sourceRevision: true,
            environmentDigest: true,
            remainingBudgetJson: true,
            createdAt: true,
            startedAt: true,
            completedAt: true,
            terminalReasonJson: true,
          },
        },
      },
    });
    if (!t) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    const [completion, verificationPlan, evidenceBundle, latestBudgetLedger, operationObservations] = await Promise.all([
      db.completionRecord.findUnique({
        where: { taskId: t.id },
        select: { status: true, admissionState: true },
      }),
      db.verificationPlan.findFirst({
        where: { taskId: t.id },
        orderBy: { createdAt: "desc" },
        select: {
          nodes: { select: { id: true, required: true } },
          results: {
            select: { nodeId: true, attempt: true, status: true },
          },
        },
      }),
      db.evidenceBundle.findFirst({
        where: { taskId: t.id },
        orderBy: { createdAt: "desc" },
      }),
      db.turnBudgetLedger.findFirst({
        where: { turn: { taskId: t.id } },
        orderBy: { updatedAt: "desc" },
      }),
      db.operationObservation.findMany({
        where: { turn: { taskId: t.id } },
        orderBy: { createdAt: "asc" },
        take: 256,
      }),
    ]);
    const repairTurnIds = new Set(
      t.repairAttempts
        .map((attempt) => attempt.repairTurnId)
        .filter((turnId): turnId is string => turnId !== null),
    );
    const repairProviderAttempts = t.turns
      .filter((turn) => repairTurnIds.has(turn.id))
      .flatMap((turn) => turn.providerAttempts)
      .map((attempt) => {
        const usage = attempt.usageJson === null
          ? null
          : safeParse<Record<string, unknown> | null>(attempt.usageJson, null);
        return {
          inputTokens: metricDecimal(usage?.inputTokens ?? null),
          outputTokens: metricDecimal(usage?.outputTokens ?? null),
          costMicros: trustedProviderAttemptCost(attempt),
        };
      });
    const repairTurns = t.turns
      .filter((turn) => repairTurnIds.has(turn.id))
      .map((turn) => ({
        startedAtMs: turn.startedAt?.getTime() ?? null,
        completedAtMs: turn.completedAt?.getTime() ?? null,
      }));
    const activeTurnStates = new Set<string>([...V1_ACTIVE_TURN_STATES, "REPAIR_PENDING"]);
    const activeTurn = t.turns
      .filter((turn) => activeTurnStates.has(turn.state))
      .sort((left, right) => right.sequence - left.sequence)[0] ?? null;
    const repairMetrics = deriveRepairMetrics({
      taskStatus: t.status,
      terminalReason: metricTerminalReason(t.terminalReasonJson),
      completionAdmissionCommitted: completion?.status === "completed"
        && completion.admissionState === "COMMITTED",
      finalRequiredPredicatesPassed: verificationPlan === null
        ? null
        : requiredVerificationPassed(verificationPlan),
      repairAttempts: t.repairAttempts.map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        state: attempt.state,
        failureSignatures: safeParse<string[]>(attempt.failureSignaturesJson, []),
        terminalReason: metricTerminalReason(attempt.terminalReasonJson),
      })),
      repairProviderAttempts,
      repairTurns,
    });
    sendJson(res, 200, {
      id: t.id, session_id: t.sessionId, thread_id: t.threadId,
      status: t.status, phase: t.phase,
      active_contract_version: t.activeContractVersion,
      risk_class: t.riskClass,
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
      completed_at: t.completedAt?.toISOString() ?? null,
      terminal_reason: t.terminalReasonJson === null
        ? null
        : safeParse<Record<string, unknown> | null>(t.terminalReasonJson, null),
      contract: taskContractWire(t.contractVersions[0]),
      // The turn a client would interrupt to stop work without ending the
      // task. Without this a client can only cancel the whole task, which is
      // terminal, so "stop" and "abandon" collapse into one destructive
      // action. Repair turns count: they are running work too.
      active_turn: activeTurn === null
        ? null
        : {
            id: activeTurn.id,
            sequence: activeTurn.sequence,
            state: activeTurn.state,
            started_at: activeTurn.startedAt?.toISOString() ?? null,
          },
      profile: evidenceBundle === null
        ? null
        : {
            id: evidenceBundle.profileId,
            version: evidenceBundle.profileVersion,
            hash: evidenceBundle.profileHash,
          },
      evidence_bundle: evidenceBundle === null
        ? null
        : turnEvidenceBundleWire(evidenceBundle),
      budget_ledger: latestBudgetLedger === null
        ? null
        : {
            schema_version: latestBudgetLedger.schemaVersion,
            steps_used: latestBudgetLedger.stepsUsed,
            max_steps: latestBudgetLedger.maxSteps,
            hard_max_steps: latestBudgetLedger.hardMaxSteps,
            tokens_used: latestBudgetLedger.tokensUsed.toString(),
            input_tokens: latestBudgetLedger.inputTokens.toString(),
            cached_input_tokens: latestBudgetLedger.cachedInputTokens.toString(),
            cache_write_tokens: latestBudgetLedger.cacheWriteTokens.toString(),
            output_tokens: latestBudgetLedger.outputTokens.toString(),
            reasoning_tokens: latestBudgetLedger.reasoningTokens.toString(),
            tool_schema_tokens: latestBudgetLedger.toolSchemaTokens.toString(),
            max_tokens: latestBudgetLedger.maxTokens?.toString() ?? null,
            cost_micros: latestBudgetLedger.costMicros.toString(),
            max_cost_micros: latestBudgetLedger.maxCostMicros?.toString() ?? null,
            context_headroom_tokens: latestBudgetLedger.contextHeadroomTokens?.toString() ?? null,
            evidence: safeParse<Record<string, unknown>>(latestBudgetLedger.evidenceJson, {}),
            last_progress: latestBudgetLedger.lastProgressJson === null
              ? null
              : safeParse<Record<string, unknown>>(latestBudgetLedger.lastProgressJson, {}),
          },
      operation_observations: operationObservations.map((observation) => ({
        schema_version: observation.schemaVersion,
        observation_hash: observation.observationHash,
        semantic_fingerprint: observation.semanticFingerprint,
        attempt_number: observation.attemptNumber,
        provider_call_id: observation.providerCallId,
        tool_id: observation.toolId,
        tool_version: observation.toolVersion,
        status: observation.status,
        result_hash: observation.resultHash,
        error_code: observation.errorCode,
        error_class: observation.errorClass,
        mutates_workspace: observation.mutatesWorkspace,
        workspace_revision_before: observation.workspaceRevisionBefore,
        workspace_revision_after: observation.workspaceRevisionAfter,
        verification_delta: observation.verificationDelta,
        progressed: observation.progressed,
        no_op: observation.noOp,
        repeated_failure: observation.repeatedFailure,
        oscillating: observation.oscillating,
        failure_class: observation.failureClass,
        progress_reason: observation.progressReason,
        recommended_recovery: safeParse<string[]>(observation.recommendedRecoveryJson, []),
      })),
      repair_metrics: {
        schema_version: repairMetrics.schemaVersion,
        first_proposal_verified_success: repairMetrics.firstProposalVerifiedSuccess,
        repair_success: repairMetrics.repairSuccess,
        repair_attempt_count: repairMetrics.repairAttemptCount,
        repeated_failure: repairMetrics.repeatedFailure,
        repeated_failure_count: repairMetrics.repeatedFailureCount,
        false_positive_completion: repairMetrics.falsePositiveCompletion,
        outcome_class: repairMetrics.outcomeClass,
        stop_reason: repairMetrics.stopReason,
        classification_correct: repairMetrics.classificationCorrect,
        usage: {
          additional_input_tokens: repairMetrics.usage.additionalInputTokens,
          additional_output_tokens: repairMetrics.usage.additionalOutputTokens,
          additional_cost_micros: repairMetrics.usage.additionalCostMicros,
          additional_duration_ms: repairMetrics.usage.additionalDurationMs,
        },
      },
      repair_attempts: t.repairAttempts.map((attempt) => ({
        id: attempt.id,
        parent_turn_id: attempt.parentTurnId,
        repair_turn_id: attempt.repairTurnId,
        attempt_number: attempt.attemptNumber,
        max_attempts: attempt.maxAttempts,
        state: attempt.state,
        directive_artifact: attempt.directiveArtifact,
        failed_node_ids: safeParse<string[]>(attempt.failedNodeIdsJson, []),
        failure_signatures: safeParse<string[]>(attempt.failureSignaturesJson, []),
        changed_files: safeParse<string[]>(attempt.changedFilesJson, []),
        source_revision: attempt.sourceRevision,
        environment_digest: attempt.environmentDigest,
        remaining_budget: safeParse<Record<string, unknown>>(attempt.remainingBudgetJson, {}),
        created_at: attempt.createdAt.toISOString(),
        started_at: attempt.startedAt?.toISOString() ?? null,
        completed_at: attempt.completedAt?.toISOString() ?? null,
        terminal_reason: attempt.terminalReasonJson === null
          ? null
          : safeParse<Record<string, unknown> | null>(attempt.terminalReasonJson, null),
      })),
    });
  }),
  // R8: task workspace diff for benchmark patch extraction (git workspaces).
  route("GET", "/v1/tasks/:id/diff", async (req, res, params) => {
    const taskId = String(params.id);
    try {
      const taskRow = await db.task.findUnique({ where: { id: taskId } });
      if (taskRow === null) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
      const sessionRow = await db.session.findUnique({ where: { id: taskRow.sessionId }, select: { workspaceId: true } });
      const workspaceRow = sessionRow === null
        ? null
        : await db.workspace.findUnique({ where: { id: sessionRow.workspaceId } });
      if (workspaceRow === null) return sendError(res, 404, "WORKSPACE_NOT_FOUND", "task has no workspace", "not_found");
      const context = await kernelContextForTask(
        taskId,
        `task-diff:${taskId}`,
        [CapabilityOperationProto.CAPABILITY_OPERATION_EXEC],
        ["."],
      );
      const runCommand = async (args: readonly string[]): Promise<{ code: number; out: string }> => {
        const events = requireKernelUds().process.Start({
          context,
          intent: kernelIntent(),
          command: {
            program: "git",
            args: [...args],
            cwd: { workspaceId: workspaceRow.id, relativePath: "." },
            publicEnv: { GIT_CONFIG_NOSYSTEM: "1" },
            secretCapabilityUris: [],
            timeout: { seconds: 30, nanos: 0 },
            allocatePty: false,
            shell: undefined,
            allowUnboundedTimeout: false,
          },
          sandboxProfileId: DEV_MODE ? "degraded-local" : "secure-local-default",
          outputPolicyId: "tool-result-bounded",
        });
        return await new Promise((resolve, reject) => {
          const chunks: Uint8Array[] = [];
          let exitCode = -1;
          const sub = events.subscribe({
            next: (event: ProcessEventProto) => {
              if (event.stdout !== undefined) chunks.push(event.stdout.bytes);
              if (event.exited !== undefined) exitCode = event.exited.exitCode;
            },
            error: (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
            complete: () => resolve({ code: exitCode, out: new TextDecoder().decode(concatUint8(chunks)) }),
          });
          void sub;
        });
      };
      const diff = await runCommand(["--no-pager", "diff", "HEAD", "--binary"]);
      const untracked = await runCommand(["ls-files", "--others", "--exclude-standard"]);
      // Index writes (.git/index) are denied by protected-path policy, so
      // intent-to-add cannot work. Emit per-file no-index diffs for bounded
      // untracked files instead — applyable without touching the index.
      let untrackedDiff = "";
      const untrackedFiles = untracked.out.split("\n").filter((line) => line.length > 0).slice(0, 50);
      for (const file of untrackedFiles) {
        if (file.includes("..") || file.startsWith("/")) continue;
        const one = await runCommand(["--no-pager", "diff", "--no-index", "--binary", "/dev/null", file]);
        // git diff --no-index exits 1 when differences exist — success here.
        if (one.out.length > 0) {
          untrackedDiff += one.out + "\n";
        }
      }
      sendJson(res, 200, {
        task_id: taskId,
        workspace_id: workspaceRow.id,
        git_available: diff.code !== -1 && !/fatal|not a git repository/i.test(diff.out) ? true : diff.out.length > 0,
        diff: (diff.out + "\n" + untrackedDiff).slice(0, 2_000_000),
        diff_truncated: diff.out.length + untrackedDiff.length > 2_000_000,
        untracked_files: untracked.out.split("\n").filter((line) => line.length > 0).slice(0, 500),
        exit_code: diff.code,
      });
    } catch (err) {
      if (sendTaskScopeError(res, err)) return;
      sendInternalError(res, "DIFF_FAILED", "task diff failed", "task diff failed", err);
    }
  }),

  /**
   * Artifact inventory for a task (SPEC §29.3): every CAS artifact
   * referenced by the task's provider attempts, tool calls, episodes,
   * verification results, and plans. Offset-paginated; `next_cursor` is null on the
   * last page. Content itself is fetched via GET /v1/artifacts/:hash.
   */
  route("GET", "/v1/tasks/:id/artifacts", async (req, res, params) => {
    const taskId = String(params.id);
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: {
        sessionId: true,
        session: { select: { workspaceId: true } },
      },
    });
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    const url = new URL(req.url ?? "/", "http://x");
    const limitRaw = Number(url.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 100;
    const skip = Math.max(0, Math.trunc(Number(url.searchParams.get("skip") ?? 0)) || 0);

    const [attempts, toolCalls, episodes, plans] = await Promise.all([
      db.providerAttempt.findMany({
        where: { turn: { is: { taskId } } },
        select: { requestArtifact: true, responseArtifact: true },
      }),
      db.toolCall.findMany({
        where: { turn: { is: { taskId } } },
        orderBy: [{ proposedAt: "asc" }, { id: "asc" }],
        select: { id: true, argumentsArtifact: true, resultArtifact: true },
      }),
      db.episode.findMany({
        where: { turn: { is: { taskId } }, contentArtifact: { not: null } },
        select: { contentArtifact: true, kind: true },
      }),
      db.verificationPlan.findMany({
        where: { taskId },
        select: {
          planArtifact: true,
          results: { select: { evidenceArtifact: true } },
        },
      }),
    ]);

    // artifact://sha256/<hex> → sha256:<hex> (the CAS address form used by
    // GET /v1/artifacts/:hash). Unknown shapes are preserved verbatim so the
    // client can still surface them instead of silently dropping evidence.
    const toHash = (uri: string): string => {
      const m = /^artifact:\/\/sha256\/([0-9a-f]{64})$/.exec(uri);
      return m ? `sha256:${m[1]}` : uri;
    };

    type Entry = { hash: string; purpose: string; created_seq: number };
    const seen = new Map<string, Entry>();
    const add = (uri: string | null | undefined, purpose: string, seq: number): void => {
      if (!uri || typeof uri !== "string") return;
      const hash = toHash(uri);
      if (!seen.has(hash)) seen.set(hash, { hash, purpose, created_seq: seq });
    };
    attempts.forEach((a, i) => {
      add(a.requestArtifact, "provider_request", i);
      add(a.responseArtifact, "provider_response", i);
    });
    toolCalls.forEach((call, i) => {
      add(call.argumentsArtifact, `tool_arguments:${call.id}`, i);
      add(call.resultArtifact, `tool_result:${call.id}`, i);
    });
    episodes.forEach((e, i) => add(e.contentArtifact, `episode:${e.kind}`, i));
    plans.forEach((p, i) => {
      add(p.planArtifact, "verification_plan", i);
      p.results.forEach((r, j) => add(r.evidenceArtifact, "verification_evidence", i * 1000 + j));
    });

    const all = [...seen.values()].sort((a, b) => a.created_seq - b.created_seq);
    const page = all.slice(skip, skip + limit);
    const artifactContext = await kernelTaskContext({
      sessionId: task.sessionId,
      taskId,
      turnId: "task-artifact-inventory",
      workspaceId: task.session.workspaceId,
      operationClasses: [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
    });
    const metas = await Promise.all(page.map(async (entry) => {
      let mediaType = "application/octet-stream";
      let sizeBytes: number | null = null;
      try {
        // The kernel's ownership index is keyed by the canonical CAS address.
        // Stripping the prefix here made every lookup fail into the catch
        // below, which is why this inventory reported an unknown media type
        // and a null size for every artifact it has ever listed.
        const meta = await requireKernelUds().artifacts.GetMetadata({
          context: artifactContext,
          sha256: entry.hash,
        });
        if (meta.artifact) {
          if (meta.artifact.mediaType) mediaType = meta.artifact.mediaType;
          sizeBytes = meta.artifact.sizeBytes ?? null;
        }
      } catch {
        // Metadata is best-effort; the hash remains fetchable by the client.
      }
      return {
        hash: entry.hash,
        purpose: entry.purpose,
        media_type: mediaType,
        size_bytes: sizeBytes,
      };
    }));

    const nextSkip = skip + page.length;
    sendJson(res, 200, {
      task_id: taskId,
      artifacts: metas,
      total: all.length,
      next_cursor: nextSkip < all.length ? String(nextSkip) : null,
    });
  }),
  /**
   * Durable transcript for one task.
   *
   * `GET /v1/events` is a live tail: without a cursor it starts from "now", so
   * a client that opens a task which already ran sees an empty conversation
   * even though every event is still in `semantic_events`. This route reads
   * that table directly and pages it forward, using the same task filter the
   * SSE route applies, so a client can rebuild the transcript and then attach
   * the stream at `next_cursor` without a gap or a duplicate.
   *
   * Frames match the SSE wire shape (`id` / `event` / `data`) so one decoder
   * serves both paths.
   */
  route("GET", "/v1/tasks/:id/transcript", async (req, res, params) => {
    const taskId = String(params.id);
    const task = await db.task.findUnique({ where: { id: taskId }, select: { id: true } });
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    const url = new URL(req.url ?? "/", "http://x");
    const limitRaw = Number(url.searchParams.get("limit") ?? 500);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1_000) : 500;
    const before = url.searchParams.get("before");
    // Mirrors the /v1/events filter. Turn, provider, tool and verification
    // events correlate on the task id; task events carry it as the aggregate;
    // the payload scan catches the rest, which is what keeps the replayed
    // transcript identical to what the live stream would have delivered.
    const scope = {
      schemaVersion: 1,
      OR: [
        { correlationId: taskId },
        { aggregateType: "task", aggregateId: taskId },
        { payloadJson: { contains: taskId } },
      ],
    };
    const where = before === null || before.length === 0
      ? scope
      : { ...scope, eventId: { lt: before } };
    // Newest first, then reversed: a conversation is read from its end, so the
    // default page is the tail. Paging backwards with `before` walks toward the
    // beginning, which is what "load earlier" means to a reader.
    const [rows, total] = await Promise.all([
      db.semanticEvent.findMany({
        where,
        orderBy: { eventId: "desc" },
        take: limit + 1,
        select: { eventId: true, eventType: true, payloadJson: true, occurredAt: true },
      }),
      db.semanticEvent.count({ where: scope }),
    ]);
    const hasEarlier = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    sendJson(res, 200, {
      task_id: taskId,
      events: page.map((row) => ({
        id: row.eventId,
        event: row.eventType,
        data: row.payloadJson,
        occurred_at: row.occurredAt.toISOString(),
      })),
      total,
      // The cursor to attach the live stream at, so replay and tail meet
      // exactly once. Null only when the task has produced no events at all,
      // where attaching without a cursor is already correct.
      next_cursor: page.at(-1)?.eventId ?? null,
      // The cursor to request the previous page with.
      earlier_cursor: hasEarlier ? page[0]?.eventId ?? null : null,
      truncation: { occurred: hasEarlier, continuation: hasEarlier ? page[0]?.eventId ?? null : null },
    });
  }),
  route("GET", "/v1/sessions/:id/tasks", async (req, res, params) => {
    const page = parsePageRequest(req, res);
    if (!page) return;
    const where = { sessionId: String(params.id) };
    const [taskRows, total] = await Promise.all([
      db.task.findMany({
        where,
        include: {
        contractVersions: {
          orderBy: { version: "desc" },
          take: 1,
          include: { acceptanceCriteria: { orderBy: { criterionId: "asc" } } },
        },
      },
        orderBy: { id: "asc" },
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
        take: page.limit + 1,
      }),
      db.task.count({ where }),
    ]);
    const tasks = taskRows.slice(0, page.limit);
    // H8: an ACTIVE task with no live turn is idle and steerable, not stuck.
    // Clients need to tell those apart without polling every turn.
    const liveTurnRows = tasks.length === 0
      ? []
      : await db.turn.findMany({
        where: { taskId: { in: tasks.map((t) => t.id) }, state: { in: [...V1_ACTIVE_TURN_STATES] } },
        orderBy: { sequence: "desc" },
        select: { id: true, state: true, taskId: true },
      });
    const activeTurnByTask = new Map<string, { readonly id: string; readonly state: string }>();
    for (const row of liveTurnRows) {
      if (row.taskId === null || activeTurnByTask.has(row.taskId)) continue;
      activeTurnByTask.set(row.taskId, { id: row.id, state: row.state });
    }
    sendJson(res, 200, {
      tasks: tasks.map((t) => ({
        id: t.id, session_id: t.sessionId, thread_id: t.threadId,
        status: t.status, phase: t.phase,
        active_contract_version: t.activeContractVersion,
        risk_class: t.riskClass,
        created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
        completed_at: t.completedAt?.toISOString() ?? null,
        terminal_reason: t.terminalReasonJson === null
          ? null
          : safeParse<Record<string, unknown> | null>(t.terminalReasonJson, null),
        active_turn: activeTurnByTask.get(t.id) ?? null,
        contract: taskContractWire(t.contractVersions[0]),
      })),
      total,
      next_cursor: nextPageCursor(taskRows, page.limit),
    });
  }),

  // ────────────────────────── /turns ─────────────────────────────────────
  route("POST", "/v1/turns", async (req, res) => {
    const body = await jsonBody(req) as {
      thread_id: string;
      task_id: string;
      user_input: string;
      model?: unknown;
      reasoning_effort?: unknown;
      provider_account_id?: unknown;
      budget?: unknown;
    };
    // Unknown keys used to be dropped by the cast above, so a caller that
    // asked for something this route does not implement got a 201 and silence.
    const unknownFields = unknownTurnRequestFields(body);
    if (unknownFields.length > 0) {
      return sendError(
        res,
        400,
        "TURN_INPUT_UNKNOWN_FIELDS",
        `unknown field(s): ${unknownFields.join(", ")}`,
        "validation",
        { unknown_fields: unknownFields, accepted_fields: TURN_REQUEST_FIELDS },
      );
    }
    if (
      typeof body.thread_id !== "string"
      || typeof body.task_id !== "string"
      || typeof body.user_input !== "string"
    ) {
      return sendError(
        res,
        400,
        "TURN_INPUT_INVALID",
        "thread_id, task_id, and user_input are required strings",
        "validation",
      );
    }
    // H7: an optional per-turn model and reasoning depth. Both are bare
    // identifiers as discovered (`big-pickle`), not provider-qualified keys.
    if (body.model !== undefined && body.model !== null
      && (typeof body.model !== "string" || body.model.trim().length === 0 || body.model.length > 256)) {
      return sendError(
        res,
        400,
        "TURN_MODEL_INVALID",
        "model must be a non-empty model id of at most 256 characters",
        "validation",
      );
    }
    const requestedTurnModel = typeof body.model === "string" ? body.model.trim() : null;
    // Which connected account this turn runs on. Optional: a turn that names
    // none keeps the session default, then the installation default, then the
    // legacy chain.
    if (
      body.provider_account_id !== undefined
      && body.provider_account_id !== null
      && (typeof body.provider_account_id !== "string"
        || body.provider_account_id.trim().length === 0
        || body.provider_account_id.length > 128)
    ) {
      return sendError(
        res,
        400,
        "TURN_PROVIDER_ACCOUNT_INVALID",
        "provider_account_id must be a non-empty account id of at most 128 characters",
        "validation",
      );
    }
    const requestedProviderAccountId = typeof body.provider_account_id === "string"
      ? body.provider_account_id.trim()
      : null;
    // A per-turn ceiling on steps, tokens and spend. Enforced by the loop's
    // own budget, and never able to raise what the task contract allows.
    let requestedBudget: TurnRequestBudget | null = null;
    try {
      requestedBudget = parseTurnRequestBudget(body.budget);
    } catch (error: unknown) {
      if (!(error instanceof TurnBudgetInvalidError)) throw error;
      return sendError(res, 400, "TURN_BUDGET_INVALID", error.message, "validation", {
        field: error.field,
        supplied: body.budget,
      });
    }
    let requestedReasoningEffort: ReasoningEffort | null = null;
    if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) {
      requestedReasoningEffort = parseReasoningEffort(body.reasoning_effort);
      if (requestedReasoningEffort === null) {
        return sendError(
          res,
          400,
          "TURN_REASONING_EFFORT_INVALID",
          `reasoning_effort must be one of ${REASONING_EFFORTS.join(", ")}`,
          "validation",
          { supplied: body.reasoning_effort },
        );
      }
    }
    const id = uuid();
    // Perform cheap lineage/state checks before ingesting bytes. The same
    // invariants are checked again in the admission transaction because the
    // task can change while the kernel persists and links the artifact.
    const inputTask = await db.task.findUnique({
      where: { id: body.task_id },
      select: {
        sessionId: true,
        threadId: true,
        status: true,
        session: { select: { workspaceId: true } },
      },
    });
    if (inputTask === null) {
      return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    }
    if (inputTask.threadId !== body.thread_id) {
      return sendError(
        res,
        409,
        "TASK_THREAD_MISMATCH",
        "task does not belong to the supplied thread",
        "conflict",
        {
          task_id: body.task_id,
          supplied_thread_id: body.thread_id,
          actual_thread_id: inputTask.threadId,
        },
      );
    }
    if (!STEERABLE_TASK_STATUSES.includes(inputTask.status)) {
      return sendError(
        res,
        409,
        "TASK_TURN_STATE_CONFLICT",
        `task cannot accept a turn from ${inputTask.status}`,
        "conflict",
        { task_id: body.task_id, status: inputTask.status },
      );
    }
    // H7: a named model must have an admitted discovery record for this
    // gateway account before the turn is admitted. Rejecting here — rather
    // than inside the loop — keeps the failure a client error with the list
    // of models the account can actually use.
    const sessionDefaults = await db.session.findUnique({
      where: { id: inputTask.sessionId },
      select: {
        defaultModel: true,
        defaultReasoningEffort: true,
        defaultProviderAccountId: true,
      },
    });
    const effectiveTurnModel = requestedTurnModel ?? sessionDefaults?.defaultModel ?? null;
    const effectiveReasoningEffort = requestedReasoningEffort
      ?? parseReasoningEffort(sessionDefaults?.defaultReasoningEffort);
    // Resolve the account before the turn exists, so a client that named an
    // account that is gone or unusable learns it here rather than inside the
    // loop — and so the chosen account is recorded on the turn row and cannot
    // change under it mid-turn.
    const turnResolution = resolveTurnProvider({
      requestedAccountId: requestedProviderAccountId,
      sessionDefaultAccountId: sessionDefaults?.defaultProviderAccountId ?? null,
      accounts: await listProviderAccountRecords(),
      hasModel: effectiveTurnModel !== null,
    });
    if (turnResolution.kind === "error") {
      return sendProviderAccountResolutionError(res, turnResolution);
    }
    const selectedProviderAccountId = turnResolution.kind === "account"
      ? turnResolution.account.id
      : null;
    if (turnResolution.kind === "account") {
      if (effectiveTurnModel === null) {
        return sendError(
          res,
          409,
          "MODEL_NOT_ADMITTED",
          `account '${turnResolution.account.displayName}' was selected without a model`,
          "conflict",
          {
            requested_model: null,
            provider_account_id: turnResolution.account.id,
            discovered_models: await admittedProviderAccountModelIds(turnResolution.account),
          },
        );
      }
      const admitted = await admittedProviderAccountModel(turnResolution.account, effectiveTurnModel);
      if (admitted === null) {
        return sendError(
          res,
          409,
          "MODEL_NOT_ADMITTED",
          `model '${effectiveTurnModel}' has no admitted discovery record for account '${turnResolution.account.displayName}'`,
          "conflict",
          {
            requested_model: effectiveTurnModel,
            provider_account_id: turnResolution.account.id,
            discovered_models: await admittedProviderAccountModelIds(turnResolution.account),
          },
        );
      }
    } else if (effectiveTurnModel !== null) {
      const gatewayRow = await db.gatewayProviderConfiguration.findUnique({
        where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
      });
      const credential = gatewayRow === null ? null : gatewayDiscoveryCredential(gatewayRow);
      if (credential === null) {
        return sendError(
          res,
          409,
          "MODEL_NOT_ADMITTED",
          "no usable OpenCode gateway account is configured, so a per-turn model cannot be selected",
          "conflict",
          { requested_model: effectiveTurnModel, discovered_models: [] },
        );
      }
      const admitted = await admittedGatewayModelRecord(credential, effectiveTurnModel);
      if (admitted === null) {
        return sendError(
          res,
          409,
          "MODEL_NOT_ADMITTED",
          `model '${effectiveTurnModel}' has no admitted discovery record for this gateway account`,
          "conflict",
          {
            requested_model: effectiveTurnModel,
            deployment: credential.deployment,
            discovered_models: await admittedGatewayModelIds(credential),
          },
        );
      }
    }
    const inputContext = await kernelTaskContext({
      sessionId: inputTask.sessionId,
      taskId: body.task_id,
      turnId: id,
      workspaceId: inputTask.session.workspaceId,
      operationClasses: [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
    });
    const inputArtifacts = createKernelArtifactClient(requireKernelUds().artifacts, {
      ...inputContext,
      idempotencyKey: `turn-input:${id}`,
    });
    const inputArtifact = await inputArtifacts.ingest(
      new TextEncoder().encode(body.user_input),
      {
        mediaType: "text/plain;charset=utf-8",
        custom: {
          purpose: "turn-input",
          sessionId: inputTask.sessionId,
          taskId: body.task_id,
          turnId: id,
        },
      },
    );
    // Link before publishing any authoritative row or event that references
    // the bytes. A crash before admission leaves only a reclaimable orphan.
    await inputArtifacts.link(inputArtifact.hash, "turn", id, "initiating-input");
    const observedPrevious = await db.turn.findFirst({
      where: { threadId: body.thread_id },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const proposedSequence = (observedPrevious?.sequence ?? 0) + 1;
    let turn: TurnRow;
    try {
      const admitted = await turnCoordinator.admitUnderMutationLock({
        turnId: id,
        threadId: body.thread_id,
        taskId: body.task_id,
        sequence: proposedSequence,
        inputArtifactUri: inputArtifact.uri,
        inputArtifactHash: inputArtifact.hash,
        initiatingActor: SERVER_PRINCIPAL,
        selectedModel: effectiveTurnModel,
        selectedReasoningEffort: effectiveReasoningEffort,
        selectedProviderAccountId,
        requestedBudgetJson: serializeTurnRequestBudget(requestedBudget),
      });
      turn = admitted.turn;
    } catch (error: unknown) {
      if (!(error instanceof TurnAdmissionError)) throw error;
      if (error.reason === "task_not_found") {
        return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
      }
      if (error.reason === "thread_mismatch") {
        return sendError(
          res,
          409,
          "TASK_THREAD_MISMATCH",
          "task does not belong to the supplied thread",
          "conflict",
          { task_id: body.task_id, supplied_thread_id: body.thread_id, actual_thread_id: error.detail },
        );
      }
      if (error.reason === "state_conflict") {
        return sendError(
          res,
          409,
          "TASK_TURN_STATE_CONFLICT",
          `task cannot accept a turn from ${error.detail ?? "unknown"}`,
          "conflict",
          { task_id: body.task_id, status: error.detail },
        );
      }
      if (error.reason === "turn_active") {
        return sendError(
          res,
          409,
          "TASK_TURN_ALREADY_ACTIVE",
          "task already has a non-terminal turn",
          "conflict",
          { task_id: body.task_id, turn_id: error.detail },
        );
      }
      return sendError(
        res,
        409,
        "TASK_TURN_STATE_CONFLICT",
        error.reason === "sequence_changed"
          ? "thread changed before the turn could start"
          : "task changed before the turn could start",
        "conflict",
      );
    }
    // Kick off the agent loop asynchronously.
    agentLoop(id).catch((err) => {
      console.error("agent loop failed", err);
    });
    sendJson(res, 201, {
      id: turn.id, thread_id: turn.threadId, task_id: turn.taskId,
      sequence: turn.sequence, state: turn.state,
      initiating_actor: turn.initiatingActor,
      started_at: turn.startedAt?.toISOString() ?? null,
      completed_at: turn.completedAt?.toISOString() ?? null,
      model: effectiveTurnModel,
      reasoning_effort: effectiveReasoningEffort,
      // Where this turn will run, resolved at admission. Null means the legacy
      // direct/gateway/local chain.
      selected_provider_account_id: turn.selectedProviderAccountId,
      // Echoed so the caller can see exactly what was accepted rather than
      // inferring it from the absence of an error.
      budget: turnRequestBudgetWire(requestedBudget),
    });
  }),
  route("GET", "/v1/turns/:id", async (_req, res, params) => {
    const turn = await db.turn.findUnique({ where: { id: String(params.id) } });
    if (!turn) return sendError(res, 404, "TURN_NOT_FOUND", "turn not found", "not_found");
    // Usage, cost and stop reason are recorded per attempt and were readable
    // only at task granularity, so anything wanting per-turn numbers had to
    // re-derive them from the event log. They are summed here instead.
    const attempts = await db.providerAttempt.findMany({
      where: { turnId: turn.id },
      orderBy: { attemptNumber: "asc" },
      select: {
        attemptNumber: true,
        usageJson: true,
        finishReason: true,
        providerReportedCostMicros: true,
        computedCostMicros: true,
        costSource: true,
      },
    });
    const terminalError = turn.terminalErrorJson === null
      ? null
      : safeParse<unknown>(turn.terminalErrorJson, null);
    const costMicros = sumAttemptCostMicros(attempts);
    const requestedBudget = parsePersistedTurnBudget(turn.requestedBudgetJson);
    sendJson(res, 200, {
      id: turn.id, thread_id: turn.threadId, task_id: turn.taskId,
      sequence: turn.sequence, state: turn.state,
      initiating_actor: turn.initiatingActor,
      started_at: turn.startedAt?.toISOString() ?? null,
      completed_at: turn.completedAt?.toISOString() ?? null,
      model: turn.selectedModel,
      reasoning_effort: turn.selectedReasoningEffort,
      selected_provider_account_id: turn.selectedProviderAccountId,
      budget: turnRequestBudgetWire(requestedBudget),
      usage: sumUsageWire(attempts.map((attempt) => usageWire(attempt.usageJson))),
      // Null, not zero: a turn whose price is unknown did not cost nothing.
      cost_micros: costMicros === null ? null : costMicros.toString(),
      stop_reason: turnStopReason({
        state: turn.state,
        terminalError,
        lastFinishReason: attempts[attempts.length - 1]?.finishReason ?? null,
      }),
      terminal_error: terminalError,
    });
  }),
  /**
   * Per-attempt provider accounting for one turn.
   *
   * Every field here is a column on `provider_attempts`. Without the route the
   * only way to read them was to replay `turn.response_validating` events and
   * re-derive the same numbers, which loses any attempt whose event was pruned
   * and duplicates the accounting rule in a second language.
   */
  route("GET", "/v1/turns/:id/attempts", async (_req, res, params) => {
    const turnId = String(params.id);
    const turn = await db.turn.findUnique({ where: { id: turnId }, select: { id: true } });
    if (turn === null) return sendError(res, 404, "TURN_NOT_FOUND", "turn not found", "not_found");
    const attempts = await db.providerAttempt.findMany({
      where: { turnId },
      orderBy: { attemptNumber: "asc" },
      select: {
        id: true,
        attemptNumber: true,
        modelKey: true,
        providerId: true,
        usageJson: true,
        status: true,
        finishReason: true,
        providerRequestId: true,
        providerReportedCostMicros: true,
        computedCostMicros: true,
        costSource: true,
        requestArtifact: true,
        responseArtifact: true,
        startedAt: true,
        completedAt: true,
      },
    });
    sendJson(res, 200, attempts.map((attempt) => ({
      provider_attempt_id: attempt.id,
      attempt_number: attempt.attemptNumber,
      model: attempt.modelKey,
      provider_id: attempt.providerId,
      status: attempt.status,
      usage: usageWire(attempt.usageJson),
      finish_reason: attempt.finishReason,
      provider_request_id: attempt.providerRequestId,
      // BigInt columns cross as decimal strings, consistent with
      // `budget_ledger`; `cost_source` says which of the two to trust.
      provider_reported_cost_micros: attempt.providerReportedCostMicros?.toString() ?? null,
      computed_cost_micros: attempt.computedCostMicros?.toString() ?? null,
      cost_source: attempt.costSource,
      request_artifact: attempt.requestArtifact,
      response_artifact: attempt.responseArtifact,
      started_at: attempt.startedAt.toISOString(),
      completed_at: attempt.completedAt?.toISOString() ?? null,
    })));
  }),
  // SPEC §32.2 — interrupt a running turn. The agent loop checks turn
  // state between phases and stops at the next safe point.
  route("POST", "/v1/turns/:id/interrupt", async (req, res, params) => {
    const body = await jsonBody(req) as { reason?: string | null };
    let updated: TurnRow;
    try {
      updated = await turnCoordinator.interruptUnderMutationLock(String(params.id), body.reason ?? "user_interrupted");
    } catch (error: unknown) {
      if (!(error instanceof TurnAdmissionError)) throw error;
      if (error.reason === "task_not_found") {
        return sendError(res, 404, "TURN_NOT_FOUND", "turn not found", "not_found");
      }
      return sendError(
        res,
        409,
        "TURN_INTERRUPT_STATE_CONFLICT",
        `turn cannot be interrupted from ${error.detail ?? "unknown"}`,
        "conflict",
      );
    }
    abortActiveTurn(updated.id, body.reason ?? "user_interrupted");
    sendJson(res, 200, {
      id: updated.id, thread_id: updated.threadId, task_id: updated.taskId,
      sequence: updated.sequence, state: updated.state,
      initiating_actor: updated.initiatingActor,
      started_at: updated.startedAt?.toISOString() ?? null,
      completed_at: updated.completedAt?.toISOString() ?? null,
      model: updated.selectedModel,
      reasoning_effort: updated.selectedReasoningEffort,
      selected_provider_account_id: updated.selectedProviderAccountId,
    });
  }),
  // Mid-turn steering: queue a durable user message on an active turn without
  // interrupting it. The episode is model-visible, so the next compiled
  // context carries it; the engine drains queued steering at the stop
  // boundary to keep the turn alive instead of ending on stale text.
  route("POST", "/v1/turns/:id/steer", async (req, res, params) => {
    const body = await jsonBody(req) as { message?: unknown };
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return sendError(res, 400, "STEERING_INPUT_INVALID", "message is a required non-empty string", "validation");
    }
    const message = body.message.slice(0, 16_384);
    const turn = await db.turn.findUnique({
      where: { id: String(params.id) },
      select: { id: true, taskId: true, state: true },
    });
    if (turn === null) {
      return sendError(res, 404, "TURN_NOT_FOUND", "turn not found", "not_found");
    }
    if (turn.taskId === null) {
      return sendError(res, 409, "TURN_STEERING_STATE_CONFLICT", "turn is not attached to a task", "conflict");
    }
    const task = await db.task.findUnique({
      where: { id: turn.taskId },
      select: { id: true, sessionId: true, session: { select: { workspaceId: true } } },
    });
    if (task === null) {
      return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    }
    if (!(V1_ACTIVE_TURN_STATES as readonly string[]).includes(turn.state)) {
      return sendError(
        res,
        409,
        "TURN_STEERING_STATE_CONFLICT",
        `turn cannot be steered from ${turn.state}`,
        "conflict",
        { state: turn.state },
      );
    }
    const episode = await mutateAgentState(async () => {
      const latest = await db.episode.findFirst({
        where: { turnId: turn.id },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const episodeId = uuid();
      const steeringContext = await kernelTaskContext({
        sessionId: task.sessionId,
        taskId: task.id,
        turnId: turn.id,
        workspaceId: task.session.workspaceId,
        operationClasses: [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
      });
      const steeringArtifactClient = createKernelArtifactClient(requireKernelUds().artifacts, {
        ...steeringContext,
        idempotencyKey: `steering:${episodeId}`,
      });
      const artifact = await steeringArtifactClient.ingest(
        new TextEncoder().encode(message),
        { mediaType: "text/plain", custom: { purpose: "steering", turnId: turn.id } },
      );
      await steeringArtifactClient.link(artifact.hash, "episode", episodeId, "content");
      return db.episode.create({
        data: {
          id: episodeId,
          turnId: turn.id,
          sequence: (latest?.sequence ?? 0) + 1,
          kind: "steering_message",
          modelVisible: true,
          contentArtifact: artifact.uri,
          sourceVersionsJson: JSON.stringify({ steering: artifact.hash }),
        },
      });
    });
    await emit({
      eventType: "turn.steering_queued",
      aggregateType: "turn",
      aggregateId: turn.id,
      correlationId: turn.taskId ?? undefined,
      payload: {
        episode_id: episode.id,
        sequence: episode.sequence,
        chars: message.length,
      },
    });
    sendJson(res, 201, {
      episode_id: episode.id,
      sequence: episode.sequence,
      turn_id: turn.id,
      turn_state: turn.state,
    });
  }),

  // ────────────────────────── /events (SSE) ──────────────────────────────
  route("GET", "/v1/events", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const cursor = eventCursorFromRequest(req, url.searchParams.get("cursor"));
    const taskId = url.searchParams.get("task_id");
    const sessionId = url.searchParams.get("session_id");

    const streamName = taskId ? `task:${taskId}` : sessionId ? `session:${sessionId}` : "global";

    const filter = (ev: StoredEvent) => {
      if (ev.schemaVersion !== 1) return false;
      if (taskId) {
        // Turn, provider, tool, verification, and completion events use the
        // task id as their correlation id. Their payloads intentionally do
        // not all duplicate it, so payload-only matching strands the desktop
        // after turn.started and drops the rest of the live trajectory.
        return ev.correlationId === taskId
          || (ev.aggregateType === "task" && ev.aggregateId === taskId)
          || (ev.payloadJson?.includes(taskId) ?? false);
      }
      if (sessionId) return ev.payloadJson?.includes(sessionId) ?? false;
      return true;
    };

    await serveEventStream(req, res, {
      streamName,
      cursor,
      filter,
      eventFrame: (event) => `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${event.payloadJson}\n\n`,
      cursorExpiredFrame: ({ requestedCursor, oldestRetainedEventId }) => {
        const snapshotUrl = taskId
          ? `/v1/tasks/${taskId}`
          : sessionId
            ? `/v1/sessions/${sessionId}`
            : "/v1/sessions";
        const expiredPayload = JSON.stringify({
          type: "cursor_expired",
          cursor: requestedCursor,
          oldest_retained_event_id: oldestRetainedEventId,
          snapshot_url: snapshotUrl,
          message:
            "the requested cursor is older than the oldest retained event; " +
            "use the snapshot endpoint to reconcile state before resuming",
        });
        return `id: ${oldestRetainedEventId}\nevent: cursor_expired\ndata: ${expiredPayload}\n\n`;
      },
    });
  }),

  // ────────────────────────── /context ───────────────────────────────────
  route("GET", "/v1/context/manifests/:id", async (_req, res, params) => {
    const m = await db.contextManifest.findUnique({
      where: { id: String(params.id) },
      include: { fragments: true },
    });
    if (!m) return sendError(res, 404, "MANIFEST_NOT_FOUND", "manifest not found", "not_found");
    sendJson(res, 200, {
      id: m.id, provider_attempt_id: m.providerAttemptId,
      compiler_version: m.compilerVersion, policy_version: m.policyVersion,
      epoch_id: m.epochId, provider_key: m.providerKey, model_key: m.modelKey,
      rendered_request_hash: m.renderedRequestHash,
      estimated_tokens: JSON.parse(m.estimatedTokensJson),
      cache_plan: JSON.parse(m.cachePlanJson),
      experiment: JSON.parse(m.experimentJson),
      created_at: m.createdAt.toISOString(),
      fragments: m.fragments.map((f) => ({
        id: f.id, kind: f.kind, source_uri: f.sourceUri, source_version: f.sourceVersion,
        authority: f.authority, priority: f.priority, trust: f.trust,
        confidentiality: f.confidentiality, injection_risk: f.injectionRisk,
        exactness: f.exactness, selected: f.selected, rendered_position: f.renderedPosition,
        estimated_tokens: f.estimatedTokens,
        selection_reason: f.selectionReason, omission_reason: f.omissionReason,
      })),
    });
  }),

  // ────────────────────────── /artifacts ─────────────────────────────────
  route("GET", "/v1/artifacts/:hash", async (req, res, params) => {
    const taskId = new URL(req.url ?? "/", "http://terminus.local").searchParams.get("task_id");
    if (taskId === null || taskId.length === 0) {
      return sendError(
        res,
        400,
        "ARTIFACT_TASK_REQUIRED",
        "task_id is required to enforce artifact ownership",
        "validation",
      );
    }
    const hash = canonicalArtifactHash(String(params.hash));
    if (hash === null) {
      return sendError(
        res,
        400,
        "ARTIFACT_HASH_INVALID",
        "artifact hash must be 64 lowercase hex characters, optionally sha256:-prefixed",
        "validation",
      );
    }
    try {
      const artifact = await requireKernelUds().artifacts.Get({
        context: await kernelContextForTask(
          taskId,
          "artifact-read",
          [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
        ),
        sha256: hash,
      });
      const buf = artifact.content;
      res.writeHead(200, {
        "content-type": artifact.artifact?.mediaType ?? "application/octet-stream",
        "content-length": String(buf.length),
        "access-control-allow-origin": CONTROL_CORS_ORIGIN,
        "access-control-allow-headers": CORS_ALLOW_HEADERS,
      });
      res.end(buf);
    } catch (err) {
      logInternalError("artifact fetch failed", err);
      sendError(res, 500, "ARTIFACT_FETCH_FAILED", "artifact fetch failed", "internal");
    }
  }),
  route("GET", "/v1/artifacts/:hash/metadata", async (req, res, params) => {
    const taskId = new URL(req.url ?? "/", "http://terminus.local").searchParams.get("task_id");
    if (taskId === null || taskId.length === 0) {
      return sendError(
        res,
        400,
        "ARTIFACT_TASK_REQUIRED",
        "task_id is required to enforce artifact ownership",
        "validation",
      );
    }
    const hash = canonicalArtifactHash(String(params.hash));
    if (hash === null) {
      return sendError(
        res,
        400,
        "ARTIFACT_HASH_INVALID",
        "artifact hash must be 64 lowercase hex characters, optionally sha256:-prefixed",
        "validation",
      );
    }
    try {
      const meta = await requireKernelUds().artifacts.GetMetadata({
        context: await kernelContextForTask(
          taskId,
          "artifact-metadata",
          [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
        ),
        sha256: hash,
      });
      sendJson(res, 200, meta.artifact ?? { sha256: hash });
    } catch (err) {
      logInternalError("artifact metadata fetch failed", err);
      sendError(res, 500, "ARTIFACT_METADATA_FAILED", "artifact metadata fetch failed", "internal");
    }
  }),

  // ────────────────────────── /approvals ─────────────────────────────────
  route("POST", "/v1/approvals", async (_req, res) => {
    // ADR-0042: a bearer-authenticated public client cannot author approval
    // semantics or its own operation hash. The trusted policy broker creates
    // records from a validated tool call and normalized input artifact.
    sendError(
      res,
      503,
      "APPROVAL_BROKER_UNAVAILABLE",
      "public approval creation is disabled; a trusted policy-broker decision is required",
      "external_dependency",
      { required_boundary: "trusted_policy_broker" },
    );
  }),
  route("GET", "/v1/approvals", async (req, res) => {
    const page = parsePageRequest(req, res);
    if (!page) return;
    const url = new URL(req.url ?? "/", "http://terminus.local");
    const taskId = url.searchParams.get("task_id");
    const where = { status: "pending", ...(taskId ? { taskId } : {}) };
    const [approvalRows, total] = await Promise.all([
      db.approval.findMany({
        where,
        orderBy: { id: "asc" },
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
        take: page.limit + 1,
      }),
      db.approval.count({ where }),
    ]);
    const approvals = approvalRows.slice(0, page.limit);
    // Decoded, client-ready rows: risk/scope arrive as stored JSON strings
    // and would otherwise force every client to re-parse them.
    sendJson(res, 200, {
      approvals: approvals.map(approvalWire),
      total,
      next_cursor: nextPageCursor(approvalRows, page.limit),
    });
  }),
  route("POST", "/v1/approvals/:id/resolve", async (req, res, params) => {
    const body = await jsonBody(req) as {
      decision: string;
      operation_hash?: unknown;
      rationale?: string | null;
    };
    // SPEC §32.4 — accept BOTH naming conventions (public-api vs domain)
    // and map to canonical domain names.
    const canonical = normalizeApprovalDecision(body.decision);
    if (!canonical) {
      return sendError(
        res,
        400,
        "INVALID_APPROVAL_DECISION",
        `unsupported approval decision: ${body.decision}`,
        "validation",
        {
          accepted: [
            "allow_once", "allow_exact", "allow_for_action",
            "allow_task_scope", "allow_for_task",
            "deny_once", "deny_and_rule", "deny_and_add_task_rule",
            "stop_task",
          ],
          canonical_names: [
            "allow_once", "allow_for_action", "allow_for_task",
            "deny_once", "deny_and_add_task_rule", "stop_task",
          ],
        },
      );
    }
    if (typeof body.operation_hash !== "string" || body.operation_hash.length === 0) {
      return sendError(
        res,
        400,
        "APPROVAL_OPERATION_HASH_REQUIRED",
        "operation_hash is required to resolve an approval",
        "validation",
      );
    }
    const operationHash = body.operation_hash;
    if (canonical === "deny_and_add_task_rule" || canonical === "stop_task") {
      return sendError(
        res,
        503,
        "APPROVAL_DECISION_COORDINATOR_UNAVAILABLE",
        canonical === "stop_task"
          ? "stop_task requires the kernel-backed task cancellation coordinator"
          : "deny_and_add_task_rule requires the task policy-rule coordinator",
        "external_dependency",
        { decision: canonical },
      );
    }
    const allowing = canonical === "allow_once" || canonical === "allow_for_action" || canonical === "allow_for_task";
    const approvalId = String(params.id);
    const current = await db.approval.findUnique({ where: { id: approvalId } });
    if (!current) return sendError(res, 404, "APPROVAL_NOT_FOUND", "approval not found", "not_found");
    if (!constantTimeEqual(current.operationHash, operationHash)) {
      return sendError(
        res,
        409,
        "APPROVAL_OPERATION_MISMATCH",
        "the approval no longer matches the exact operation shown to the client",
        "conflict",
      );
    }
    if (current.status !== "pending") {
      return sendError(res, 409, "APPROVAL_ALREADY_RESOLVED", "approval is no longer pending", "conflict");
    }
    const resolvedAt = new Date();
    if (current.expiresAt && current.expiresAt.getTime() <= resolvedAt.getTime()) {
      await emit({
        eventType: "approval.expired",
        aggregateType: "approval",
        aggregateId: current.id,
        correlationId: current.taskId,
        payload: { approval_id: current.id, task_id: current.taskId, expired_at: resolvedAt.toISOString() },
      }, async (tx) => {
        const expired = await tx.approval.updateMany({
          where: { id: approvalId, status: "pending" },
          data: { status: "expired" },
        });
        if (expired.count !== 1) throw new Error(`approval ${approvalId} changed before expiry settlement`);
      });
      return sendError(res, 410, "APPROVAL_EXPIRED", "approval expired before resolution", "conflict");
    }
    if (current.useCount >= current.useLimit) {
      return sendError(res, 409, "APPROVAL_USE_LIMIT_EXHAUSTED", "approval use limit is exhausted", "conflict");
    }
    // An allow is honoured only for a tool call parked on this approval
    // (see awaitToolApproval). Anything else has no effect to release, and
    // recording "allowed" for it would claim an authorization nothing used.
    if (allowing && current.toolCallId === null) {
      return sendError(
        res,
        503,
        "APPROVAL_DECISION_COORDINATOR_UNAVAILABLE",
        `${canonical} requires the kernel-backed approval coordinator`,
        "external_dependency",
        { decision: canonical },
      );
    }
    const status = allowing ? "allowed" : "denied";
    const conflictMessage = `approval ${approvalId} changed before atomic resolution`;
    try {
    await emit({
      eventType: "approval.resolved",
      aggregateType: "approval", aggregateId: current.id,
      correlationId: current.taskId,
      payload: {
        approval_id: current.id,
        task_id: current.taskId,
        operation_hash: current.operationHash,
        decision: canonical,
        raw_decision: body.decision,
        status,
        resolved_at: resolvedAt.toISOString(),
      },
    }, async (tx) => {
      const update = await tx.approval.updateMany({
        where: {
          id: approvalId,
          status: "pending",
          operationHash,
          useCount: { lt: current.useLimit },
          OR: [{ expiresAt: null }, { expiresAt: { gt: resolvedAt } }],
        },
        data: {
          status,
          decision: canonical,
          resolvedAt,
          resolvedBy: SERVER_PRINCIPAL,
          rationale: body.rationale ?? null,
          ...(allowing ? { useCount: { increment: 1 } } : {}),
        },
      });
      if (update.count !== 1) throw new Error(conflictMessage);
    });
    // Wake the parked tool call. After a restart there is nothing waiting —
    // the tool call was cancelled and the approval expired at boot — so a
    // stale decision simply records itself.
    settleToolApprovalWaiter(
      approvalId,
      allowing
        ? { kind: "allowed", decision: canonical as "allow_once" | "allow_for_action" | "allow_for_task" }
        : { kind: "denied" },
    );
    } catch (error: unknown) {
      if (error instanceof Error && error.message === conflictMessage) {
        return sendError(
          res,
          409,
          "APPROVAL_RESOLUTION_CONFLICT",
          "approval changed while the decision was being applied",
          "conflict",
        );
      }
      throw error;
    }
    const a = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
    sendJson(res, 200, {
      ...approvalWire(a),
      decision: canonical,
      decision_aliases: {
        allow_once: ["allow_once"],
        allow_for_action: ["allow_for_action", "allow_exact"],
        allow_for_task: ["allow_for_task", "allow_task_scope"],
        deny_once: ["deny_once"],
        deny_and_add_task_rule: ["deny_and_rule", "deny_and_add_task_rule"],
        stop_task: ["stop_task"],
      },
    });
  }),

  // ────────────────────────── /jobs ──────────────────────────────────────
  route("GET", "/v1/jobs/:id", async (_req, res, params) => {
    const jobId = String(params.id);
    const persisted = await db.job.findUnique({ where: { id: jobId } });
    if (!persisted) return sendError(res, 404, "JOB_NOT_FOUND", "job not found", "not_found");
    const jobBinding = await kernelBindingForJob(
      jobId,
      [
        CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
        CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
      ],
    );
    if (kernelUds && jobBinding !== null) {
      try {
        const state = await kernelUds.jobs.Get({
          context: jobBinding.context,
          jobId: jobBinding.kernelJobId,
        });
        return sendJson(res, 200, { ...state, jobId });
      } catch (error: unknown) {
        if (isNonterminalJobState(persisted.state)) {
          return sendError(
            res,
            503,
            "JOB_RECONCILIATION_UNAVAILABLE",
            "the kernel could not confirm the state of this non-terminal job",
            "external_dependency",
            {
              job_id: jobId,
              persisted_state: persisted.state,
              reconciliation_required: true,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }
    if (isNonterminalJobState(persisted.state)) {
      return sendError(
        res,
        409,
        "JOB_BINDING_UNAVAILABLE",
        "the non-terminal job has no kernel identity that can be reconciled",
        "unknown_settlement",
        { job_id: jobId, persisted_state: persisted.state, reconciliation_required: true },
      );
    }
    sendJson(res, 200, {
      id: persisted.id, state: persisted.state,
      started_at: persisted.startedAt?.toISOString() ?? null,
      settled_at: persisted.settledAt?.toISOString() ?? null,
      output_cursor: persisted.outputCursor,
    });
  }),
  route("POST", "/v1/jobs/:id/stop", async (req, res, params) => {
    const body = await jsonBody(req) as { reason?: string | null };
    const jobId = String(params.id);
    const binding = await kernelBindingForJob(
      jobId,
      [
        CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
        CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
      ],
    );
    if (binding === null) return sendError(res, 409, "JOB_BINDING_UNAVAILABLE", "job has no settled kernel binding", "conflict");
    try {
      const r = await requireKernelUds().jobs.Stop({
        context: binding.context,
        jobId: binding.kernelJobId,
        reason: body.reason ?? "stopped",
      });
      const projectedState = r.state.toUpperCase();
      await emit({
        eventType: "job.stopped",
        aggregateType: "job",
        aggregateId: jobId,
        payload: { state: projectedState, reason: body.reason ?? "stopped" },
      }, async (tx) => {
        await tx.job.update({
          where: { id: jobId },
          data: {
            state: projectedState,
            ...(projectedState === "EXITED" || projectedState === "LOST"
              ? { settledAt: new Date() }
              : {}),
          },
        });
      });
      sendJson(res, 200, { ...r, jobId });
    } catch (err) {
      sendInternalError(res, "JOB_STOP_FAILED", "job stop failed", "job stop failed", err);
    }
  }),
  // SPEC §32.2 — send input to a job's PTY. Forwards to the kernel
  // (POST /v1/jobs/:id/input) which owns the PTY.
  route("POST", "/v1/jobs/:id/input", async (req, res, params) => {
    const body = await jsonBody(req) as { input?: string; eof?: boolean };
    const jobId = String(params.id);
    const binding = await kernelBindingForJob(
      jobId,
      [
        CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
        CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
      ],
    );
    if (binding === null) return sendError(res, 409, "JOB_BINDING_UNAVAILABLE", "job has no settled kernel binding", "conflict");
    try {
      const input = body.input ?? "";
      const r = await requireKernelUds().jobs.Input({
        context: binding.context,
        jobId: binding.kernelJobId,
        stdin: new TextEncoder().encode(input + (body.eof ? "\n" : "")),
      });
      sendJson(res, 200, { ...r, jobId });
    } catch (err) {
      sendInternalError(res, "JOB_INPUT_FAILED", "job input failed", "job input failed", err);
    }
  }),

  // ────────────────────────── /verification ──────────────────────────────
  route("GET", "/v1/verification/plans/:id", async (_req, res, params) => {
    const p = await db.verificationPlan.findUnique({
      where: { id: String(params.id) },
      include: { nodes: true },
    });
    if (!p) return sendError(res, 404, "PLAN_NOT_FOUND", "plan not found", "not_found");
    sendJson(res, 200, {
      id: p.id, task_id: p.taskId, contract_version: p.contractVersion,
      source_revision: p.sourceRevision, completion_expression: p.completionExpression,
      nodes: p.nodes.map((n) => ({ id: n.id, kind: n.kind, required: n.required })),
    });
  }),

  // ────────────────────────── /cron (ADR-0049) ───────────────────────────
  route("POST", "/v1/cron", async (req, res) => {
    const body = (await jsonBody(req)) as {
      schedule: unknown;
      payload?: Record<string, unknown>;
      max_catchup_runs?: number;
    };
    const parsedSchedule = scheduleSchema.safeParse(body.schedule);
    if (!parsedSchedule.success) {
      return sendError(res, 400, "INVALID_SCHEDULE", `invalid schedule: ${parsedSchedule.error.message}`, "validation");
    }
    const now = new Date();
    const nextRun = computeNextRunAt(parsedSchedule.data, now);
    if (!nextRun) {
      return sendError(res, 400, "UNSATISFIABLE_SCHEDULE", "schedule has no future execution time within horizon", "validation");
    }
    const id = uuid();
    const job: CronJob = {
      id,
      schedule: parsedSchedule.data,
      state: "active",
      lastRunAt: null,
      nextRunAt: nextRun.toISOString(),
      consecutiveFailures: 0,
      maxCatchupRuns: body.max_catchup_runs ?? 1,
      payload: body.payload ?? {},
    };
    cronJobs.set(id, job);
    await emit({
      eventType: "cron.created",
      aggregateType: "cron",
      aggregateId: id,
      payload: job,
    });
    sendJson(res, 201, job);
  }),
  route("GET", "/v1/cron", async (_req, res) => {
    sendJson(res, 200, { jobs: Array.from(cronJobs.values()) });
  }),
  route("GET", "/v1/cron/:id", async (_req, res, params) => {
    const job = cronJobs.get(String(params.id));
    if (!job) return sendError(res, 404, "CRON_JOB_NOT_FOUND", "cron job not found", "not_found");
    sendJson(res, 200, job);
  }),
  route("DELETE", "/v1/cron/:id", async (_req, res, params) => {
    const job = cronJobs.get(String(params.id));
    if (!job) return sendError(res, 404, "CRON_JOB_NOT_FOUND", "cron job not found", "not_found");
    cronJobs.delete(job.id);
    await emit({
      eventType: "cron.deleted",
      aggregateType: "cron",
      aggregateId: job.id,
      payload: { id: job.id },
    });
    sendJson(res, 200, { deleted: true, id: job.id });
  }),
  route("POST", "/v1/cron/:id/tick", async (_req, res, params) => {
    const job = cronJobs.get(String(params.id));
    if (!job) return sendError(res, 404, "CRON_JOB_NOT_FOUND", "cron job not found", "not_found");
    const now = new Date();
    const advanced = advanceJob(job, now);
    cronJobs.set(job.id, advanced);
    await emit({
      eventType: "cron.ticked",
      aggregateType: "cron",
      aggregateId: job.id,
      payload: { id: job.id, executed_at: now.toISOString() },
    });
    sendJson(res, 200, advanced);
  }),

  // ────────────────────────── /tools (SPEC §32.1 resource group) ────────
  // List the ACI tool vocabulary (read, search, patch, exec, job, inspect,
  // capability). Direct invocation endpoints (/v1/tools/read, /v1/tools/exec)
  // are kept below for IDE/test use.
  route("GET", "/v1/tools", async (_req, res) => {
    sendJson(res, 200, {
      tools: [
        { id: "read", version: "v1", kind: "read", description: "Read a file from the workspace" },
        { id: "search", version: "v1", kind: "search", description: "Search code via FTS5/regex" },
        { id: "patch", version: "v1", kind: "patch", description: "Apply a structured patch" },
        { id: "exec", version: "v1", kind: "exec", description: "Run a sandboxed command" },
        { id: "job", version: "v1", kind: "job", description: "Start/stop/inspect a long-running job" },
        { id: "inspect", version: "v1", kind: "inspect", description: "Inspect workspace state" },
        { id: "capability", version: "v1", kind: "capability", description: "Activate or list capabilities" },
      ],
      default_profile: "secure-local-default",
    });
  }),
  route("POST", "/v1/tools/read", async (req, res) => {
    const body = await jsonBody(req) as { task_id: string; workspace_id: string; path: string };
    if (!body.task_id || !body.workspace_id || !body.path) {
      return sendError(res, 400, "DIRECT_TOOL_SCOPE_REQUIRED", "task_id, workspace_id, and path are required", "validation");
    }
    try {
      const context = await kernelContextForTask(
        body.task_id,
        "direct-read",
        [CapabilityOperationProto.CAPABILITY_OPERATION_READ],
        [body.path],
      );
      if (context.workspaceId !== body.workspace_id) {
        return sendError(res, 422, "TASK_WORKSPACE_MISMATCH", "task does not belong to workspace_id", "validation");
      }
      const r = await requireKernelUds().files.Read({
        context,
        intent: kernelIntent(),
        path: { workspaceId: body.workspace_id, relativePath: body.path },
        mode: "full", ranges: [], symbols: [], maxBytes: 32768, expectedSha256: "",
      });
      sendJson(res, 200, r);
    } catch (err) {
      logInternalError("file read failed", err);
      sendError(res, 500, "READ_FAILED", "file read failed", "internal");
    }
  }),
  route("POST", "/v1/tools/patch", async (req, res) => {
    const body = await jsonBody(req) as {
      task_id: string;
      workspace_id: string;
      path: string;
      expected_sha256: string;
      expected_utf8: string;
      replacement_utf8: string;
      commit_mode?: "preview" | "apply";
    };
    if (!body.task_id || !body.workspace_id || !body.path) {
      return sendError(res, 400, "DIRECT_TOOL_SCOPE_REQUIRED", "task_id, workspace_id, and path are required", "validation");
    }
    try {
      const context = await kernelContextForTask(
        body.task_id,
        "direct-patch",
        [CapabilityOperationProto.CAPABILITY_OPERATION_PATCH],
        [body.path],
      );
      if (context.workspaceId !== body.workspace_id) {
        return sendError(res, 422, "TASK_WORKSPACE_MISMATCH", "task does not belong to workspace_id", "validation");
      }
      const response = await requireKernelUds().patch.Apply({
        context,
        intent: kernelIntent(),
        transactionId: randomUUID(),
        baseline: {
          workspaceId: body.workspace_id,
          repositoryRevision: "no-vcs",
          dirtyDigest: "",
          sources: [{
            path: { workspaceId: body.workspace_id, relativePath: body.path },
            sha256: body.expected_sha256,
            repositoryRevision: "no-vcs",
          }],
        },
        edits: [{
          replaceExactText: {
            path: { workspaceId: body.workspace_id, relativePath: body.path },
            expectedSha256: body.expected_sha256,
            expectedUtf8: new TextEncoder().encode(body.expected_utf8),
            replacementUtf8: new TextEncoder().encode(body.replacement_utf8),
            requireUnique: true,
          },
        }],
        validationProfileId: "task-default",
        allowTransientInvalidState: false,
        commitMode: body.commit_mode === "preview"
          ? PatchCommitMode.PATCH_COMMIT_MODE_PREVIEW_ONLY
          : PatchCommitMode.PATCH_COMMIT_MODE_APPLY_TO_WORKTREE,
      });
      sendJson(res, 200, response);
    } catch (err) {
      logInternalError("patch failed", err);
      sendError(res, 500, "PATCH_FAILED", "patch failed", "internal");
    }
  }),
  route("POST", "/v1/tools/exec", async (req, res) => {
    const body = await jsonBody(req) as {
      task_id: string;
      workspace_id: string;
      program: string;
      args?: string[];
      cwd?: string;
      sandbox_profile_id?: string;
      timeout_ms?: unknown;
    };
    if (!body.task_id || !body.workspace_id || !body.program) {
      return sendError(res, 400, "DIRECT_TOOL_SCOPE_REQUIRED", "task_id, workspace_id, and program are required", "validation");
    }
    // H10: an unbounded command had no wall limit at all, so a runaway child
    // held its sandbox and its turn open indefinitely.
    const execTimeout = resolveCommandTimeoutMs(body.timeout_ms, DIRECT_EXEC_DEFAULT_TIMEOUT_MS);
    if (!execTimeout.ok) {
      return sendError(res, 422, "COMMAND_TIMEOUT_INVALID", execTimeout.reason, "validation");
    }
    try {
      const context = await kernelContextForTask(
        body.task_id,
        "direct-exec",
        [CapabilityOperationProto.CAPABILITY_OPERATION_EXEC],
        [body.cwd ?? "."],
      );
      if (context.workspaceId !== body.workspace_id) {
        return sendError(res, 422, "TASK_WORKSPACE_MISMATCH", "task does not belong to workspace_id", "validation");
      }
      const events = requireKernelUds().process.Start({
        context,
        intent: kernelIntent(),
        command: {
          program: body.program,
          args: body.args ?? [],
          cwd: { workspaceId: body.workspace_id, relativePath: body.cwd ?? "." },
          publicEnv: {}, secretCapabilityUris: [],
          // H10: an explicit bound, so the kernel never has to fall back to
          // its own class default and nothing ever runs unbounded.
          timeout: durationFromMilliseconds(execTimeout.timeoutMs),
          allocatePty: false, shell: undefined,
          allowUnboundedTimeout: false,
        },
        sandboxProfileId: body.sandbox_profile_id ?? "secure-local-default",
        outputPolicyId: "default",
      });
      const first = await firstValueFrom(events);
      const r = first.started
        ? { process_id: first.started.processId, job_id: first.started.jobId, resolved_executable: first.started.resolvedExecutable }
        : { process_id: "", job_id: "", resolved_executable: "" };
      sendJson(res, 200, r);
    } catch (err) {
      if (sendTaskScopeError(res, err)) return;
      logInternalError("exec failed", err);
      sendError(res, 500, "EXEC_FAILED", "exec failed", "internal");
    }
  }),
  route("POST", "/v1/tools/job", async (req, res) => {
    const body = await jsonBody(req) as {
      task_id: string;
      workspace_id: string;
      program: string;
      args?: string[];
      cwd?: string;
      sandbox_profile_id?: string;
      durable?: boolean;
      timeout_ms?: unknown;
    };
    if (!body.task_id || !body.workspace_id || !body.program) {
      return sendError(res, 400, "DIRECT_TOOL_SCOPE_REQUIRED", "task_id, workspace_id, and program are required", "validation");
    }
    // H10: a durable job gets the longer default, still bounded (30 minutes).
    const jobTimeout = resolveCommandTimeoutMs(body.timeout_ms, DIRECT_JOB_DEFAULT_TIMEOUT_MS);
    if (!jobTimeout.ok) {
      return sendError(res, 422, "COMMAND_TIMEOUT_INVALID", jobTimeout.reason, "validation");
    }
    const controlJobId = uuid();
    let prepared = false;
    let kernelResult: Awaited<ReturnType<KernelUdsClients["jobs"]["Start"]>> | null = null;
    try {
      const context = await kernelContextForTask(
        body.task_id,
        "direct-job",
        [
          CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
          CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
          CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST,
        ],
        [body.cwd ?? "."],
      );
      if (context.workspaceId !== body.workspace_id) {
        return sendError(res, 422, "TASK_WORKSPACE_MISMATCH", "task does not belong to workspace_id", "validation");
      }
      const command = {
        program: body.program,
        args: body.args ?? [],
        cwd: { workspaceId: body.workspace_id, relativePath: body.cwd ?? "." },
        publicEnv: {},
        secretCapabilityUris: [],
        // H10: see /v1/tools/exec — a durable job is bounded too.
        timeout: durationFromMilliseconds(jobTimeout.timeoutMs),
        allocatePty: false,
        shell: undefined,
        allowUnboundedTimeout: false,
      };
      const artifacts = createKernelArtifactClient(requireKernelUds().artifacts, {
        ...context,
        idempotencyKey: `job:${controlJobId}`,
      });
      const commandArtifact = await ingestJsonArtifact(
        artifacts,
        command,
        "job-command",
        { taskId: body.task_id, jobId: controlJobId },
      );
      const initialOutputArtifact = await artifacts.ingest(new Uint8Array(), {
        mediaType: "application/octet-stream",
        custom: { purpose: "job-output-initial", taskId: body.task_id, jobId: controlJobId },
      });
      const task = await db.task.findUnique({
        where: { id: body.task_id },
        select: { sessionId: true },
      });
      if (task === null) throw new Error(`task ${body.task_id} disappeared before job admission`);
      const environmentDigest = await resolveKernelEnvironmentDigest(requireKernelUds());
      await emit({
        eventType: "job.start_requested",
        aggregateType: "job",
        aggregateId: controlJobId,
        correlationId: body.task_id,
        payload: { task_id: body.task_id, workspace_id: body.workspace_id },
        artifactRefs: [commandArtifact.uri],
      }, async (tx) => {
        await tx.job.create({
          data: {
            id: controlJobId,
            sessionId: task.sessionId,
            taskId: body.task_id,
            state: "STARTING",
            commandArtifact: commandArtifact.uri,
            resolvedExecutable: null,
            cwdUri: `workspace://${body.workspace_id}/${body.cwd ?? "."}`,
            environmentDigest,
            sandboxId: body.sandbox_profile_id ?? "secure-local-default",
            processIdentityJson: null,
            resourceLimitsJson: "{}",
            outputArtifact: initialOutputArtifact.uri,
            outputCursor: 0,
            cleanupPolicyJson: JSON.stringify({ durable: body.durable ?? true }),
          },
        });
      });
      prepared = true;
      kernelResult = await requireKernelUds().jobs.Start({
        context,
        intent: kernelIntent(),
        command,
        sandboxProfileId: body.sandbox_profile_id ?? "secure-local-default",
        outputPolicyId: "default",
        durable: body.durable ?? true,
      });
      await emit({
        eventType: "job.started",
        aggregateType: "job",
        aggregateId: controlJobId,
        correlationId: body.task_id,
        payload: { kernel_job_id: kernelResult.jobId, process_id: kernelResult.processId },
      }, async (tx) => {
        const update = await tx.job.updateMany({
          where: { id: controlJobId, state: "STARTING" },
          data: {
            state: "RUNNING",
            resolvedExecutable: body.program,
            processIdentityJson: JSON.stringify({
              kernelJobId: kernelResult?.jobId,
              processId: kernelResult?.processId,
            }),
            startedAt: kernelResult?.startedAt ?? new Date(),
          },
        });
        if (update.count !== 1) throw new Error(`job ${controlJobId} changed before start settlement`);
      });
      sendJson(res, 201, { ...kernelResult, jobId: controlJobId });
    } catch (err) {
      logInternalError("job start failed", err);
      if (prepared) {
        const kernelJobId = kernelResult?.jobId;
        const processId = kernelResult?.processId;
        const settlementError = kernelResult === null
          ? "job start failed before kernel settlement"
          : "job start outcome is unknown and requires reconciliation";
        await emit({
          eventType: kernelResult === null ? "job.failed" : "job.orphaned",
          aggregateType: "job",
          aggregateId: controlJobId,
          correlationId: body.task_id,
          payload: { error: settlementError, kernel_job_id: kernelJobId ?? null },
        }, async (tx) => {
          await tx.job.update({
            where: { id: controlJobId },
            data: {
              state: kernelResult === null ? "LOST" : "ORPHANED",
              processIdentityJson: kernelResult === null
                ? null
                : JSON.stringify({ kernelJobId, processId }),
              exitJson: JSON.stringify({ error: settlementError, settlement: kernelResult === null ? "failed" : "unknown" }),
              settledAt: kernelResult === null ? new Date() : null,
            },
          });
        }).catch((settlementError: unknown) => {
          console.error("job start settlement failed", settlementError);
        });
      }
      sendError(
        res,
        kernelResult === null ? 500 : 409,
        kernelResult === null ? "JOB_START_FAILED" : "JOB_START_UNKNOWN",
        kernelResult === null
          ? "job start failed"
          : "job start outcome is unknown and requires reconciliation",
        kernelResult === null ? "internal" : "unknown_settlement",
        { job_id: controlJobId, reconciliation_required: kernelResult !== null },
      );
    }
  }),

  // ────────────────────────── /agents ────────────────────────────────────
  route("GET", "/v1/agents", async (_req, res) => {
    const agents = await db.agent.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { task: true } });
    sendJson(res, 200, { agents });
  }),

  // ────────────────────────── /memory ────────────────────────────────────
  route("GET", "/v1/memory", async (_req, res) => {
    const claims = await db.memoryClaim.findMany({
      where: { status: "active" },
      orderBy: { updatedAt: "desc" }, take: 50,
    });
    sendJson(res, 200, {
      enabled: false, // disabled by default per SPEC §39
      claims: claims.map((c) => ({
        id: c.id, kind: c.kind, statement: c.statement,
        confidence_ppm: c.confidencePpm, status: c.status,
        scope: JSON.parse(c.scopeJson), provenance: JSON.parse(c.provenanceJson),
        created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString(),
      })),
    });
  }),

  // ────────────────────────── /evals ─────────────────────────────────────
  route("GET", "/v1/evals", async (_req, res) => {
    sendJson(res, 200, {
      suites: [
        { id: "tiny-bugfix", name: "Tiny bug fix", task_count: 12, description: "Small one-file fixes" },
        { id: "cross-file-feature", name: "Cross-file feature", task_count: 8, description: "Features spanning 2-5 files" },
        { id: "refactor", name: "Refactor", task_count: 6, description: "Behavior-preserving refactors" },
        { id: "test-generation", name: "Test generation", task_count: 10, description: "Generate tests for existing code" },
        { id: "build-failure", name: "Build failure", task_count: 5, description: "Diagnose and fix build failures" },
        { id: "security-sensitive", name: "Security-sensitive change", task_count: 4, description: "Auth/crypto/secret changes" },
      ],
      baselines: [
        { id: "terminus-minimal", name: "Terminus minimal mode", description: "Bash-only baseline (SPEC §3.7)" },
        { id: "terminus-full", name: "Terminus full mode", description: "All features enabled" },
      ],
      last_run: null,
    });
  }),

  // ────────────────────────── /configuration ─────────────────────────────
  route("GET", "/v1/configuration", async (_req, res) => {
    sendJson(res, 200, {
      terminus: { version: 1, log_level: "info" },
      kernel: { transport: "grpc+uds", socket: KERNEL_GRPC_SOCKET, required_protocol: "terminus.kernel.v1" },
      context: { compiler_version: "v1", evidence_coverage: true, memory: { enabled: false } },
      aci: { default_tools: ["read", "search", "patch", "exec", "job", "inspect", "capability"] },
      sandbox: { profile: "secure-local-default", backend: "local-restrictive" },
      orchestration: { default: "single_agent", scouts: { enabled: false, read_only: true }, writers: { enabled: true, max_parallel: 2 }, reviewer: { risk_triggered: true } },
      security: {
        control_plane_auth: "bearer_token",
        cors_origin: CONTROL_CORS_ORIGIN,
        idempotency: { enabled: true, ttl_seconds: IDEMPOTENCY_TTL_MS / 1000 },
        sse_cursors: { monotonic_event_ids: true, cursor_expired_events: true },
      },
    });
  }),

  // The local provider command is durable control-plane state. It contains
  // no credential material; execution remains exclusively kernel-brokered.
  route("GET", "/v1/provider-config", async (_req, res) => {
    const row = await db.providerConfiguration.findUnique({ where: { id: PROVIDER_CONFIGURATION_ID } });
    sendJson(res, 200, providerConfigurationWire(row));
  }),
  route("PUT", "/v1/provider-config", async (req, res) => {
    let input: ProviderConfigurationUpdate;
    try {
      input = parseProviderConfigurationUpdate(await jsonBody(req));
    } catch (error: unknown) {
      return sendError(
        res,
        400,
        "PROVIDER_CONFIGURATION_INVALID",
        error instanceof Error ? error.message : "provider configuration is invalid",
        "validation",
      );
    }
    const now = new Date();
    const values = {
      program: input.program,
      argsJson: JSON.stringify(input.args),
      model: input.model,
      timeoutSeconds: input.timeout_seconds,
      toolsEnabled: input.tools_enabled,
      updatedBy: SERVER_PRINCIPAL,
      updatedAt: now,
    };
    const row = await writerTransaction(async (tx) => {
      if (input.expected_revision === 0) {
        const current = await tx.providerConfiguration.findUnique({ where: { id: PROVIDER_CONFIGURATION_ID } });
        if (current !== null) return null;
        return tx.providerConfiguration.create({
          data: {
            id: PROVIDER_CONFIGURATION_ID,
            ...values,
            revision: 1,
            createdAt: now,
          },
        });
      }
      const updated = await tx.providerConfiguration.updateMany({
        where: { id: PROVIDER_CONFIGURATION_ID, revision: input.expected_revision },
        data: { ...values, revision: { increment: 1 } },
      });
      if (updated.count !== 1) return null;
      return tx.providerConfiguration.findUnique({ where: { id: PROVIDER_CONFIGURATION_ID } });
    });
    if (row === null) {
      return sendError(
        res,
        409,
        "PROVIDER_CONFIGURATION_CONFLICT",
        "provider configuration changed; reload it before saving",
        "conflict",
      );
    }
    sendJson(res, 200, providerConfigurationWire(row));
  }),

  /**
   * Models this installation can actually route to.
   *
   * Answers with an empty list rather than an error whenever discovery cannot
   * run — no gateway configured, no credential, gateway or catalogue
   * unreachable. A client that receives an empty inventory hides its model
   * picker; one that receives a 5xx has to decide whether to retry forever.
   * The reason travels in `error` either way so it can be surfaced.
   */
  route("GET", "/v1/provider-models", async (_req, res) => {
    // Multi-account inventory. Every model row belongs to exactly one
    // connected account, and `provider` is that account's id, so a picker
    // groups on the same identifier a turn later sends back as
    // `provider_account_id`. An installation with no accounts at all falls
    // through to the legacy single-gateway answer below.
    const inventory = await providerAccountInventory();
    if (inventory !== null) return sendJson(res, 200, inventory);
    const row = await db.gatewayProviderConfiguration.findUnique({
      where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
    });
    if (row === null) {
      return sendJson(res, 200, providerModelsWire(null, "No OpenCode gateway is configured."));
    }
    const credential = gatewayDiscoveryCredential(row);
    if (credential === null) {
      return sendJson(res, 200, providerModelsWire(null, "The OpenCode gateway has no credential configured."));
    }
    const fresh = cachedProviderModels(credential.deployment, Date.now());
    if (fresh !== null) return sendJson(res, 200, providerModelsWire(fresh, null));

    try {
      sendJson(res, 200, providerModelsWire(await discoverAndPersistProviderModels(credential), null));
    } catch (error: unknown) {
      // A stale answer beats no answer: the set of reachable models changes
      // far more slowly than the gateway's availability.
      const message = error instanceof Error ? error.message : "model discovery failed";
      const stale = lastProviderModels(credential.deployment)
        ?? await loadPersistedProviderModels(credential.deployment);
      sendJson(res, 200, providerModelsWire(stale, message));
    }
  }),

  route("GET", "/v1/gateway-provider-config", async (_req, res) => {
    const row = await db.gatewayProviderConfiguration.findUnique({
      where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
    });
    sendJson(res, 200, gatewayProviderConfigurationWire(row));
  }),
  route("PUT", "/v1/gateway-provider-config", async (req, res) => {
    let input: GatewayProviderConfigurationUpdate;
    try {
      input = parseGatewayProviderConfigurationUpdate(await jsonBody(req));
    } catch (error: unknown) {
      return sendError(
        res,
        400,
        "GATEWAY_PROVIDER_CONFIGURATION_INVALID",
        error instanceof Error ? error.message : "gateway provider configuration is invalid",
        "validation",
      );
    }
    const secretUri = gatewaySecretUri(input.deployment);
    const now = new Date();
    const row = await writerTransaction(async (tx) => {
      const current = await tx.gatewayProviderConfiguration.findUnique({
        where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
      });
      if (current === null ? input.expected_revision !== 0 : current.revision !== input.expected_revision) {
        return null;
      }
      const anonymousZenFree = input.deployment === "zen" && input.free_model && input.credential === undefined;
      if (
        input.credential === undefined
        && !anonymousZenFree
        && (current === null || !current.credentialConfigured || current.secretUri !== secretUri)
      ) {
        throw new Error("a credential is required when configuring or changing the gateway deployment");
      }
      if (input.credential !== undefined) {
        const stored = await requireKernelUds().secrets.Store({
          context: { ...await kernelMaintenanceContext(), idempotencyKey: `gateway-secret:${input.expected_revision}:${input.deployment}` },
          capabilityUri: secretUri,
          value: new TextEncoder().encode(input.credential),
        });
        if (!stored.stored || stored.capabilityUri !== secretUri) {
          throw new Error("kernel did not confirm gateway credential storage");
        }
      }
      const data = {
        deployment: input.deployment,
        protocol: input.protocol,
        model: input.model,
        secretUri,
        credentialConfigured: input.credential !== undefined
          || (current?.credentialConfigured === true && !anonymousZenFree),
        toolsEnabled: input.tools_enabled,
        freeModel: input.free_model,
        workspaceAccess: input.workspace_access,
        privacyTermsAdmitted: input.privacy_terms_admitted,
        privacyTermsVersion: input.privacy_terms_version,
        updatedBy: SERVER_PRINCIPAL,
        updatedAt: now,
      };
      if (current === null) {
        return tx.gatewayProviderConfiguration.create({
          data: { id: GATEWAY_PROVIDER_CONFIGURATION_ID, ...data, revision: 1, createdAt: now },
        });
      }
      return tx.gatewayProviderConfiguration.update({
        where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
        data: { ...data, revision: { increment: 1 } },
      });
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("credential is required")) return error;
      throw error;
    });
    if (row instanceof Error) {
      return sendError(res, 400, "GATEWAY_CREDENTIAL_REQUIRED", row.message, "validation");
    }
    if (row === null) {
      return sendError(
        res,
        409,
        "GATEWAY_PROVIDER_CONFIGURATION_CONFLICT",
        "gateway provider configuration changed; reload it before saving",
        "conflict",
      );
    }
    sendJson(res, 200, gatewayProviderConfigurationWire(row));
  }),
  route("DELETE", "/v1/gateway-provider-config", async (req, res) => {
    const parsed = gatewayProviderConfigurationDeleteSchema.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "GATEWAY_PROVIDER_CONFIGURATION_INVALID", "expected_revision is required", "validation");
    }
    const result = await writerTransaction(async (tx) => {
      const current = await tx.gatewayProviderConfiguration.findUnique({
        where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
      });
      if (current === null || current.revision !== parsed.data.expected_revision) return null;
      const deleted = await requireKernelUds().secrets.Delete({
        context: { ...await kernelMaintenanceContext(), idempotencyKey: `gateway-secret-delete:${current.revision}` },
        capabilityUri: current.secretUri,
      });
      if (deleted.stored || deleted.capabilityUri !== current.secretUri) {
        throw new Error("kernel did not confirm gateway credential deletion");
      }
      await tx.gatewayProviderConfiguration.delete({ where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID } });
      return true;
    });
    if (result === null) {
      return sendError(res, 409, "GATEWAY_PROVIDER_CONFIGURATION_CONFLICT", "gateway configuration changed; reload before disconnecting", "conflict");
    }
    sendJson(res, 200, { configured: false, configuration: null });
  }),

  // ───────────────────── External Codex subscription lane ────────────────
  // These endpoints are deliberately not part of /provider-models. Codex
  // owns the external agent loop and its models must never enter Terminus'
  // native picker or appear as a native provider attempt.
  route("GET", "/v1/external/codex/status", async (req, res) => {
    const query = new URL(req.url ?? "/", "http://terminus.local").searchParams;
    const sessionId = query.get("session_id");
    const workspaceId = query.get("workspace_id");
    if (sessionId === null || workspaceId === null) {
      return sendError(res, 400, "CODEX_LANE_IDENTITY_REQUIRED", "session_id and workspace_id are required", "validation");
    }
    const session = await codexSessionIdentity(workspaceId, sessionId);
    if (session === null) return sendError(res, 404, "SESSION_NOT_FOUND", "session was not found in workspace", "not_found");
    const persisted = readCodexLaneState(session);
    // Status polling is strictly observational. In particular, a desktop
    // reconnect must never create a process or reserve a lease as a side
    // effect of GET. A live in-memory lane is the freshest local projection;
    // otherwise use the durable session snapshot.
    const lane = codexLaneSessions.get(codexLaneKey(workspaceId, sessionId));
    sendJson(res, 200, codexStatusWire(lane?.status() ?? codexStatusFromPersisted(persisted), persisted));
  }),
  route("GET", "/v1/external/codex/events", async (req, res) => {
    const query = new URL(req.url ?? "/", "http://terminus.local").searchParams;
    const sessionId = query.get("session_id");
    const workspaceId = query.get("workspace_id");
    const cursor = query.get("cursor");
    if (sessionId === null || workspaceId === null) {
      return sendError(res, 400, "CODEX_LANE_IDENTITY_REQUIRED", "session_id and workspace_id are required", "validation");
    }
    if (cursor !== null && (!/^(0|[1-9][0-9]*)$/.test(cursor) || cursor.length > 16 || !Number.isSafeInteger(Number(cursor)))) {
      return sendError(res, 400, "CODEX_LANE_CURSOR_INVALID", "cursor must be a non-negative decimal sequence", "validation");
    }
    const session = await codexSessionIdentity(workspaceId, sessionId);
    if (session === null) return sendError(res, 404, "SESSION_NOT_FOUND", "session was not found in workspace", "not_found");
    // Observational by design: this route reads only the bounded event window
    // and therefore cannot spawn a process merely because the desktop polls.
    const result = (codexLaneEventBuffers.get(codexLaneKey(workspaceId, sessionId)) ?? emptyCodexLaneEventBuffer).read(cursor);
    sendJson(res, 200, {
      external_harness: CODEX_EXTERNAL_HARNESS,
      events: result.events,
      next_cursor: result.next_cursor,
      cursor_expired: result.cursor_expired,
      ...(result.cursor_expired ? {
        cursor_expired_signal: "replay window expired; resync from the bounded current snapshot",
        resync_cursor: result.resync_cursor,
      } : {}),
    });
  }),
  route("GET", "/v1/external/codex/account", async (req, res) => {
    const query = new URL(req.url ?? "/", "http://terminus.local").searchParams;
    const sessionId = query.get("session_id");
    const workspaceId = query.get("workspace_id");
    if (sessionId === null || workspaceId === null) {
      return sendError(res, 400, "CODEX_LANE_IDENTITY_REQUIRED", "session_id and workspace_id are required", "validation");
    }
    const session = await codexSessionIdentity(workspaceId, sessionId);
    if (session === null) return sendError(res, 404, "SESSION_NOT_FOUND", "session was not found in workspace", "not_found");
    try {
      const account = await getCodexLaneSession(session).account();
      sendJson(res, 200, { external_harness: CODEX_EXTERNAL_HARNESS, account });
    } catch (error: unknown) {
      codexErrorResponse(res, error);
    }
  }),
  route("GET", "/v1/external/codex/models", async (req, res) => {
    const query = new URL(req.url ?? "/", "http://terminus.local").searchParams;
    const sessionId = query.get("session_id");
    const workspaceId = query.get("workspace_id");
    if (sessionId === null || workspaceId === null) {
      return sendError(res, 400, "CODEX_LANE_IDENTITY_REQUIRED", "session_id and workspace_id are required", "validation");
    }
    const session = await codexSessionIdentity(workspaceId, sessionId);
    if (session === null) return sendError(res, 404, "SESSION_NOT_FOUND", "session was not found in workspace", "not_found");
    try {
      const models = await getCodexLaneSession(session).models();
      sendJson(res, 200, { external_harness: CODEX_EXTERNAL_HARNESS, models });
    } catch (error: unknown) {
      codexErrorResponse(res, error);
    }
  }),
  route("POST", "/v1/external/codex/thread/start", async (req, res) => {
    const parsed = codexThreadInputSchema.safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "CODEX_LANE_INPUT_INVALID", "invalid Codex thread input", "validation");
    const session = await codexSessionIdentity(parsed.data.workspace_id, parsed.data.session_id);
    if (session === null) return sendError(res, 404, "SESSION_NOT_FOUND", "session was not found in workspace", "not_found");
    const prior = readCodexLaneState(session);
    if (prior?.thread_id !== null && prior?.thread_id !== undefined) {
      return sendError(res, 409, "CODEX_THREAD_ALREADY_RECORDED", "an external Codex thread is already recorded; resume it or stop the lane", "conflict", { thread_id: prior.thread_id, external_harness: CODEX_EXTERNAL_HARNESS });
    }
    try {
      const lane = getCodexLaneSession(session);
      const result = await lane.startThread(parsed.data as CodexAppServerStartThreadInput);
      const persisted = await persistCodexLaneState(session, {
        thread_id: result.thread_id,
        job_id: lane.status().job_id,
        state: lane.status().state,
      });
      sendJson(res, 201, { ...result, persisted });
    } catch (error: unknown) {
      codexErrorResponse(res, error);
    }
  }),
  route("POST", "/v1/external/codex/thread/resume", async (req, res) => {
    const parsed = z.object({
      session_id: z.string().uuid(),
      workspace_id: z.string().uuid(),
      thread_id: z.string().min(1).max(CODEX_MAX_ID),
    }).strict().safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "CODEX_LANE_INPUT_INVALID", "invalid Codex thread resume input", "validation");
    const session = await codexSessionIdentity(parsed.data.workspace_id, parsed.data.session_id);
    if (session === null) return sendError(res, 404, "SESSION_NOT_FOUND", "session was not found in workspace", "not_found");
    const prior = readCodexLaneState(session);
    if (prior?.thread_id !== parsed.data.thread_id) {
      return sendError(res, 409, "CODEX_THREAD_ID_MISMATCH", "thread id is not the persisted external thread for this session", "conflict", { external_harness: CODEX_EXTERNAL_HARNESS });
    }
    try {
      const lane = getCodexLaneSession(session);
      const result = await lane.resumeThread(parsed.data.thread_id);
      const persisted = await persistCodexLaneState(session, { thread_id: result.thread_id, job_id: lane.status().job_id, state: lane.status().state });
      sendJson(res, 200, { ...result, persisted });
    } catch (error: unknown) {
      codexErrorResponse(res, error);
    }
  }),
  route("POST", "/v1/external/codex/turn/start", async (req, res) => {
    const parsed = codexTurnInputSchema.safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "CODEX_LANE_INPUT_INVALID", "invalid Codex turn input", "validation");
    const session = await codexSessionIdentity(parsed.data.workspace_id, parsed.data.session_id);
    if (session === null) return sendError(res, 404, "SESSION_NOT_FOUND", "session was not found in workspace", "not_found");
    const prior = readCodexLaneState(session);
    if (prior?.thread_id !== parsed.data.thread_id) return sendError(res, 409, "CODEX_THREAD_ID_MISMATCH", "thread id is not the persisted external thread for this session", "conflict", { external_harness: CODEX_EXTERNAL_HARNESS });
    try {
      const lane = getCodexLaneSession(session);
      const result = await lane.startTurn(parsed.data as CodexAppServerTurnInput);
      await persistCodexLaneState(session, { thread_id: result.thread_id, job_id: lane.status().job_id, state: lane.status().state });
      sendJson(res, 202, result);
    } catch (error: unknown) {
      codexErrorResponse(res, error);
    }
  }),
  route("POST", "/v1/external/codex/turn/interrupt", async (req, res) => {
    const parsed = codexInterruptInputSchema.safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "CODEX_LANE_INPUT_INVALID", "invalid Codex interrupt input", "validation");
    const session = await codexSessionIdentity(parsed.data.workspace_id, parsed.data.session_id);
    if (session === null) return sendError(res, 404, "SESSION_NOT_FOUND", "session was not found in workspace", "not_found");
    const prior = readCodexLaneState(session);
    if (prior?.thread_id !== parsed.data.thread_id) return sendError(res, 409, "CODEX_THREAD_ID_MISMATCH", "thread id is not the persisted external thread for this session", "conflict", { external_harness: CODEX_EXTERNAL_HARNESS });
    try {
      const result = await getCodexLaneSession(session).interrupt(parsed.data.thread_id, parsed.data.turn_id);
      sendJson(res, 200, result);
    } catch (error: unknown) {
      codexErrorResponse(res, error);
    }
  }),
  route("POST", "/v1/external/codex/stop", async (req, res) => {
    const parsed = codexStopInputSchema.safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "CODEX_LANE_INPUT_INVALID", "invalid Codex stop input", "validation");
    const session = await codexSessionIdentity(parsed.data.workspace_id, parsed.data.session_id);
    if (session === null) return sendError(res, 404, "SESSION_NOT_FOUND", "session was not found in workspace", "not_found");
    const key = codexLaneKey(session.workspaceId, session.id);
    const persistedBeforeStop = readCodexLaneState(session);
    // A control restart drops the in-memory object, but not the durable job
    // identity. Rehydrate it for an explicit stop so we reconcile/stop that
    // exact lease instead of reporting success while it keeps running.
    const lane = codexLaneSessions.get(key)
      ?? (persistedBeforeStop?.job_id !== null && persistedBeforeStop?.job_id !== undefined
        ? getCodexLaneSession(session)
        : undefined);
    try {
      if (lane !== undefined) await lane.stop(parsed.data.reason ?? "user-stop");
      const persisted = await persistCodexLaneState(session, {
        thread_id: readCodexLaneState(session)?.thread_id ?? persistedBeforeStop?.thread_id ?? null,
        job_id: null,
        state: "stopped",
      });
      codexLaneSessions.delete(key);
      sendJson(res, 200, { external_harness: CODEX_EXTERNAL_HARNESS, stopped: true, persisted });
    } catch (error: unknown) {
      codexErrorResponse(res, error);
    }
  }),

  // ── Connected provider accounts ───────────────────────────────────────
  //
  // One row per usable credential this machine holds. The credential itself
  // never appears here: an account carries an opaque kernel capability URI and
  // the non-secret identity the kernel reported.
  route("GET", "/v1/provider-accounts", async (_req, res) => {
    sendJson(res, 200, await providerAccountsResponse());
  }),
  route("POST", "/v1/provider-accounts/discover", async (_req, res) => {
    try {
      const result = await runProviderAccountDiscovery();
      sendJson(res, 200, {
        ...await providerAccountsResponse(),
        imported: [...result.imported],
      });
    } catch (error: unknown) {
      sendError(
        res,
        503,
        "PROVIDER_ACCOUNT_DISCOVERY_UNAVAILABLE",
        error instanceof Error ? error.message : "local credential discovery failed",
        "external_dependency",
      );
    }
  }),
  route("POST", "/v1/provider-accounts/:id/connect", async (req, res, params) => {
    const parsed = providerAccountConnectSchema.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(
        res,
        400,
        "PROVIDER_ACCOUNT_INPUT_INVALID",
        "expected_revision, expected_fingerprint, expected_destination, expected_catalog_digest, and consent: true are required",
        "validation",
      );
    }
    const account = await db.providerAccount.findUnique({ where: { id: String(params.id) } });
    if (account === null) {
      return sendError(res, 404, "PROVIDER_ACCOUNT_NOT_FOUND", "provider account not found", "not_found");
    }
    if (account.revision !== parsed.data.expected_revision) {
      return sendError(
        res,
        409,
        "PROVIDER_ACCOUNT_CONFLICT",
        "provider account changed; reload it before connecting",
        "conflict",
        { expected_revision: parsed.data.expected_revision, actual_revision: account.revision },
      );
    }
    if (account.fingerprint !== parsed.data.expected_fingerprint) {
      return sendError(
        res,
        409,
        "PROVIDER_ACCOUNT_CONFLICT",
        "provider credential changed; reload it before approving import",
        "conflict",
      );
    }
    if (
      account.baseUrl !== parsed.data.expected_destination
      || account.catalogDigest !== parsed.data.expected_catalog_digest
      || modelsDevCatalogDigest() !== parsed.data.expected_catalog_digest
    ) {
      return sendError(
        res,
        409,
        "PROVIDER_ACCOUNT_CONFLICT",
        "provider destination metadata changed; reload it before approving import",
        "conflict",
      );
    }
    if (!account.source.startsWith("opencode:") && account.source !== "codex-chatgpt") {
      return sendError(
        res,
        409,
        "PROVIDER_ACCOUNT_UNSUPPORTED",
        account.statusDetail || "this provider account cannot be connected by Terminus",
        "conflict",
      );
    }
    try {
      await connectProviderAccountWithConsent(
        account,
        parsed.data.expected_revision,
        parsed.data.expected_fingerprint,
        parsed.data.expected_destination,
        parsed.data.expected_catalog_digest,
      );
      sendJson(res, 200, await providerAccountsResponse());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "provider account connection failed";
      const conflict = message.includes("changed")
        || message.includes("reload")
        || message.includes("no longer available");
      sendError(
        res,
        conflict ? 409 : 502,
        conflict ? "PROVIDER_ACCOUNT_CONFLICT" : "PROVIDER_ACCOUNT_CONNECT_FAILED",
        conflict ? message : "the local credential could not be imported into the system keyring",
        conflict ? "conflict" : "external_dependency",
      );
    }
  }),
  /** Disconnect through the same durable revoke saga used by recovery. */
  route("DELETE", "/v1/provider-accounts/:id", async (req, res, params) => {
    const parsed = providerAccountRevisionSchema.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "PROVIDER_ACCOUNT_INPUT_INVALID", "expected_revision is required", "validation");
    }
    const accountId = String(params.id);
    const account = await db.providerAccount.findUnique({ where: { id: accountId } });
    if (account === null) {
      return sendError(res, 404, "PROVIDER_ACCOUNT_NOT_FOUND", "provider account not found", "not_found");
    }
    if (account.revision !== parsed.data.expected_revision) {
      return sendError(
        res,
        409,
        "PROVIDER_ACCOUNT_CONFLICT",
        "provider account changed; reload it before disconnecting",
        "conflict",
        { expected_revision: parsed.data.expected_revision, actual_revision: account.revision },
      );
    }
    const settled = account.source === ZEN_SOURCE
      ? account
      : await settleProviderAccountCleanup(account);
    if (settled.credentialUri !== "" || settled.secretState !== "none") {
      return sendError(
        res,
        502,
        "PROVIDER_ACCOUNT_SECRET_DELETE_FAILED",
        "credential cleanup is pending; the account was kept and startup recovery will retry",
        "external_dependency",
      );
    }
    await writerTransaction(async (tx) => {
      // A session pointing at a deleted account would fail every later turn
      // with "account not found" and no way to clear it from the UI.
      await tx.session.updateMany({
        where: { defaultProviderAccountId: account.id },
        data: { defaultProviderAccountId: null },
      });
      await tx.providerAccountModelDiscovery.deleteMany({ where: { accountId: account.id } });
      await tx.providerAccount.deleteMany({ where: { id: settled.id, revision: settled.revision } });
    });
    providerAccountModelCache.delete(account.id);
    if (account.isDefault) {
      const remaining = await listProviderAccountRecords();
      const next = chooseDefaultAccount(remaining);
      if (next !== null) await setDefaultProviderAccountRow(next.id);
    }
    sendJson(res, 200, await providerAccountsResponse());
  }),
  route("PUT", "/v1/provider-accounts/:id/default", async (req, res, params) => {
    const parsed = providerAccountRevisionSchema.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "PROVIDER_ACCOUNT_INPUT_INVALID", "expected_revision is required", "validation");
    }
    const accountId = String(params.id);
    const account = await db.providerAccount.findUnique({ where: { id: accountId } });
    if (account === null) {
      return sendError(res, 404, "PROVIDER_ACCOUNT_NOT_FOUND", "provider account not found", "not_found");
    }
    if (account.revision !== parsed.data.expected_revision) {
      return sendError(
        res,
        409,
        "PROVIDER_ACCOUNT_CONFLICT",
        "provider account changed; reload it before setting the default",
        "conflict",
        { expected_revision: parsed.data.expected_revision, actual_revision: account.revision },
      );
    }
    if (account.status !== "connected" || !providerAccountHasApprovedBinding(account)) {
      return sendError(
        res,
        409,
        "PROVIDER_ACCOUNT_UNAVAILABLE",
        `provider account '${account.displayName}' is ${account.status} and cannot be the default`,
        "conflict",
        { provider_account_id: account.id, status: account.status, status_detail: account.statusDetail },
      );
    }
    await setDefaultProviderAccountRow(account.id);
    sendJson(res, 200, await providerAccountsResponse());
  }),

  // ────────────────────────── /policies (SPEC §32.1 resource group) ─────
  // List sandbox profiles + command rules so clients can render the
  // policy surface without reading config files.
  route("GET", "/v1/policies", async (_req, res) => {
    sendJson(res, 200, {
      active: "secure-local-default",
      profiles: [
        {
          id: "secure-local-default",
          description: "Secure local development profile (SPEC §3.7 default).",
          sandbox: { backend: "local-restrictive", network: "deny_outbound", fs: "workspace_only" },
          command_rules: [
            { pattern: "rg", decision: "allow", scope: "read" },
            { pattern: "git status", decision: "allow", scope: "read" },
            { pattern: "git diff", decision: "allow", scope: "read" },
            { pattern: "git commit", decision: "prompt", scope: "write" },
            { pattern: "rm", decision: "deny" },
            { pattern: "curl", decision: "deny" },
            { pattern: "wget", decision: "deny" },
          ],
          secret_access: "prompt",
          network: "deny_outbound_by_default",
        },
        {
          id: "trusted-local-full",
          description: "Trusted local workspace with broader tool access (requires explicit trust).",
          sandbox: { backend: "local-permissive", network: "allow_loopback", fs: "workspace_only" },
          command_rules: [
            { pattern: "*", decision: "allow", scope: "read_write" },
          ],
          secret_access: "allow_with_audit",
          network: "allow_loopback",
        },
      ],
    });
  }),

  // Live sandbox enforcement report, proxied from the kernel (SPEC §13.4).
  // Clients must render degraded/unsupported controls honestly instead of
  // implying full enforcement.
  route("GET", "/v1/sandbox/report", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const profileId = url.searchParams.get("profile_id") ?? "";
    const taskId = url.searchParams.get("task_id");
    if (taskId === null || taskId.length === 0) {
      return sendError(res, 400, "SANDBOX_TASK_REQUIRED", "task_id is required for a sandbox report", "validation");
    }
    const report = await requireKernelUds().sandbox.Report({
      context: await kernelContextForTask(
        taskId,
        "sandbox-report",
        [CapabilityOperationProto.CAPABILITY_OPERATION_SANDBOX],
      ),
      profileId,
    });
    const statusName = ["enforced", "degraded", "unsupported"][report.status] ?? "unsupported";
    sendJson(res, 200, {
      backend_id: report.backendId,
      status: statusName,
      enforced: [...report.enforced],
      degraded: [...report.degraded],
      unsupported: [...report.unsupported],
      notes: [...report.notes],
      ...(profileId ? { profile_id: profileId } : {}),
    });
  }),

  // ────────────────────────── /checkpoints (§29.5) ──────────────────────
  route("POST", "/v1/checkpoints", async (req, res) => {
    const parsed = checkpointRequestSchema.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(
        res,
        400,
        "INVALID_CHECKPOINT_REQUEST",
        `invalid checkpoint request: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        "validation",
      );
    }
    const body = parsed.data;
    const task = await db.task.findUnique({ where: { id: body.task_id } });
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "checkpoint task not found", "not_found");
    if (task.sessionId !== body.session_id || task.threadId !== body.thread_id) {
      return sendError(
        res,
        409,
        "CHECKPOINT_LINEAGE_MISMATCH",
        "checkpoint session, thread, and task must identify the same persisted lineage",
        "conflict",
      );
    }
    const contractRow = await db.taskContractVersion.findUnique({
      where: {
        task_id_version: {
          task_id: task.id,
          version: task.activeContractVersion,
        },
      },
    });
    if (!contractRow) {
      return sendError(res, 409, "CHECKPOINT_SOURCE_UNAVAILABLE", "active task contract not found", "conflict");
    }
    const [criteriaRows, sourceTurn, approvalRows] = await Promise.all([
      db.acceptanceCriterion.findMany({
        where: { taskId: task.id, contractVersion: contractRow.version },
        orderBy: { criterionId: "asc" },
      }),
      db.turn.findFirst({
        where: { taskId: task.id, threadId: task.threadId },
        include: { episodes: { orderBy: { sequence: "asc" } } },
        orderBy: { sequence: "desc" },
      }),
      db.approval.findMany({
        where: { taskId: task.id },
        orderBy: { requestedAt: "asc" },
      }),
    ]);
    if (!sourceTurn) {
      return sendError(
        res,
        409,
        "CHECKPOINT_SOURCE_UNAVAILABLE",
        "a checkpoint requires at least one persisted task turn",
        "conflict",
      );
    }
    const contract = persistedTaskContract(task, contractRow, criteriaRows);
    const approvalState: Array<{
      readonly approvalId: string;
      readonly state: string;
      readonly operationHash: ContentHash;
    }> = [];
    for (const approval of approvalRows) {
      const operationHash = contentHashSchema.safeParse(approval.operationHash);
      if (!operationHash.success) {
        return sendError(
          res,
          409,
          "CHECKPOINT_SOURCE_INVALID",
          `approval ${approval.id} has no valid canonical operation hash`,
          "integrity",
        );
      }
      approvalState.push({
        approvalId: approval.id,
        state: approval.status,
        operationHash: operationHash.data,
      });
    }
    const effectState: NonNullable<CheckpointContent["effectState"]> = [...arpV2.effects.values()]
      .filter((effect) => effect.taskId === task.id)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((effect) => ({
        effectId: effect.id,
        state: effect.state,
        idempotencyKey: effect.semanticIdempotencyKey,
      }));
    const episodeRange = checkpointEpisodeRange(sourceTurn.episodes);
    const sourceVersions = {
      [`task://${task.id}`]: contractRow.contentHash,
      [`turn://${sourceTurn.id}`]: `${sourceTurn.sequence}:${sourceTurn.state}`,
    };
    const requirementState = criteriaRows.map((criterion) => ({
      criterion,
      status: checkpointRequirementStatus(criterion.status),
    }));
    const completedSteps = requirementState
      .filter(({ status }) => status === "satisfied")
      .map(({ criterion }) => ({
        description: criterion.statement,
        evidenceArtifactHashes: [] as readonly ContentHash[],
      }));
    const pendingSteps = requirementState
      .filter(({ status }) => status !== "satisfied")
      .map(({ criterion }) => criterion.statement);
    const failures: CheckpointContent["failures"] = sourceTurn.terminalErrorJson === null
      ? []
      : [{
          description: checkpointFailureDescription(
            sourceTurn.terminalErrorJson,
            sourceTurn.state,
          ),
          artifactHash: null,
          resolved: false,
        }];
    const contentResult = checkpointContentSchema.safeParse({
      objective: contract.objective,
      completedSteps,
      pendingSteps,
      requirements: requirementState.map(({ criterion, status }) => ({
        id: criterion.criterionId,
        statement: criterion.statement,
        status,
        evidence: [],
      })),
      assumptions: contract.assumptions,
      unknowns: contract.unknowns,
      decisions: [],
      failures,
      openQuestions: contract.unknowns,
      sourceVersions,
      scope: contract.allowedScope,
      effectState,
      approvalState,
    });
    if (!contentResult.success) {
      return sendError(
        res,
        409,
        "CHECKPOINT_SOURCE_INVALID",
        `authoritative checkpoint state is not representable: ${contentResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        "integrity",
      );
    }
    const content = contentResult.data;
    const validation = validateCheckpoint(content, contract, sourceVersions);
    if (!validation.valid) {
      return sendError(
        res,
        409,
        "CHECKPOINT_VALIDATION_FAILED",
        validation.violations.map((violation) => violation.description).join("; "),
        "integrity",
      );
    }
    const id = uuid();
    const checkpointContext = await kernelContextForTask(
      task.id,
      sourceTurn.id,
      [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
    );
    const artifactClient = createKernelArtifactClient(requireKernelUds().artifacts, {
      ...checkpointContext,
      idempotencyKey: `checkpoint:${id}`,
    });
    const checkpointArtifact = await ingestJsonArtifact(
      artifactClient,
      content,
      "task-checkpoint",
      { sessionId: task.sessionId, taskId: task.id, turnId: sourceTurn.id },
    );
    const sequenceState = checkpointSequenceStateSchema.parse({
      task: contractRow.version,
      turn: sourceTurn.sequence,
      sourceTurnId: sourceTurn.id,
      episodeRange,
    });
    // Retain the content at the kernel before publishing even a hidden row.
    // Startup reconciliation removes a task-bound orphan if the process dies
    // before the PREPARED intent is durable.
    await artifactClient.link(checkpointArtifact.hash, "checkpoint", id, "content");
    const checkpoint = await writerTransaction((tx) => tx.checkpoint.create({
      data: {
        id,
        sessionId: task.sessionId,
        threadId: task.threadId,
        taskId: task.id,
        checkpointArtifact: checkpointArtifact.uri,
        schemaVersion: 1,
        lastCommittedSequencesJson: canonicalJson(sequenceState),
        activeContextEpochId: null,
        promotedInputCursor: null,
        unsettledToolCallsJson: "[]",
        activeJobsJson: "[]",
        workspaceRevision: null,
        dirtyStateDigest: null,
        unsettledEffectsJson: canonicalJson(effectState),
        artifactRefsJson: "[]",
        continuationJson: null,
        admissionState: "PREPARED",
      },
    }));
    await commitCheckpointPublication({
      id,
      threadId: task.threadId,
      taskId: task.id,
      artifactHash: checkpointArtifact.hash,
    });
    sendJson(res, 201, {
      id: checkpoint.id,
      session_id: checkpoint.sessionId,
      thread_id: checkpoint.threadId,
      task_id: checkpoint.taskId,
      checkpoint_artifact: checkpoint.checkpointArtifact,
      schema_version: checkpoint.schemaVersion,
      created_at: checkpoint.createdAt.toISOString(),
    });
  }),
  route("GET", "/v1/checkpoints/:id", async (_req, res, params) => {
    const cp = await db.checkpoint.findFirst({
      where: { id: String(params.id), admissionState: "COMMITTED" },
    });
    if (!cp) return sendError(res, 404, "CHECKPOINT_NOT_FOUND", "checkpoint not found", "not_found");
    sendJson(res, 200, {
      id: cp.id, session_id: cp.sessionId, thread_id: cp.threadId, task_id: cp.taskId,
      checkpoint_artifact: cp.checkpointArtifact, schema_version: cp.schemaVersion,
      last_committed_sequences: JSON.parse(cp.lastCommittedSequencesJson),
      active_context_epoch_id: cp.activeContextEpochId,
      promoted_input_cursor: cp.promotedInputCursor,
      unsettled_tool_calls: JSON.parse(cp.unsettledToolCallsJson),
      active_jobs: JSON.parse(cp.activeJobsJson),
      workspace_revision: cp.workspaceRevision,
      dirty_state_digest: cp.dirtyStateDigest,
      unsettled_effects: JSON.parse(cp.unsettledEffectsJson),
      artifact_refs: JSON.parse(cp.artifactRefsJson),
      continuation: cp.continuationJson ? JSON.parse(cp.continuationJson) : null,
      created_at: cp.createdAt.toISOString(),
    });
  }),
  route("GET", "/v1/sessions/:id/checkpoints", async (_req, res, params) => {
    const cps = await db.checkpoint.findMany({
      where: { sessionId: String(params.id), admissionState: "COMMITTED" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    sendJson(res, 200, { checkpoints: cps.map((c) => ({ id: c.id, thread_id: c.threadId, task_id: c.taskId, created_at: c.createdAt.toISOString() })) });
  }),

  // ────────────────────────── /recovery (§29.5) ─────────────────────────
  route("POST", "/v1/system/recover", async (_req, res) => {
    // SPEC §29.5 startup recovery procedure:
    // 1. acquire the instance lease
    // 2. verify database integrity and migration state
    // 3. load non-terminal tasks and turns
    // 4. reconcile jobs with OS process/cgroup/job-object state
    // 5. reconcile write journals and patch transactions
    // 6. reconcile external side effects in STARTED or UNKNOWN
    // 7. reconcile provider attempts with no complete response, without retrying
    // 8. restore active context epochs
    // 9. expose tasks as resumable, blocked, or requiring manual review
    // 10. emit a recovery report artifact
    const reportId = uuid();
    const startedAt = new Date();

    // Count non-terminal tasks and turns
    const nonTerminalTasks = await db.task.count({
      where: { status: { in: ["ACTIVE", "NEEDS_USER_DECISION", "BLOCKED", "VERIFYING", "DRAFT"] } },
    });
    const nonTerminalTurns = await db.turn.count({
      where: { state: { in: [...V1_NONTERMINAL_TURN_STATES] } },
    });

    const jobRecovery = await reconcileNonterminalJobs();

    // Reconcile external side effects in STARTED, UNKNOWN, or RECONCILING.
    // The route already owns mutationMutex, so the recovery helper uses the
    // same event/row transaction without attempting to acquire the lock a
    // second time.
    const effectRecovery = await reconcileUnsettledSideEffects(true);
    const providerRecovery = await providerSessionService.reconcileInFlightAttempts(V1_ACTIVE_TURN_STATES, true);
    const candidateBranchRecovery = await reconcileInFlightCandidateBranchAdmissions(
      true,
      buildTrustedBranchReceiptReconciler() ?? undefined,
    );

    const checkpointLinks = await reconcileCheckpointArtifactLinks();
    const checkpointAdmissions = await reconcilePreparedCheckpointAdmissions();
    const recoveredActiveTurns = await recoverActiveAgentTurns();
    const recoveredPendingRepairs = await recoverPendingRepairTurns();

    // Verify integrity
    let integrityOk = true;
    try {
      const result = await db.$queryRaw<{ quick_check: string }[]>`PRAGMA quick_check`;
      integrityOk = result[0]?.quick_check === "ok";
    } catch { integrityOk = false; }

    await emit({
      eventType: "system.recovered",
      aggregateType: "recovery_report",
      aggregateId: reportId,
      payload: {
        non_terminal_tasks: nonTerminalTasks,
        non_terminal_turns: nonTerminalTurns,
        reconciled_jobs: jobRecovery.scanned,
        lost_jobs: jobRecovery.lost,
        manual_review_effects: effectRecovery.manualReview.length,
        manual_review_candidate_branches: candidateBranchRecovery.manualReview.length,
        interrupted_attempts: providerRecovery.interrupted.length,
        recovered_active_turns: recoveredActiveTurns,
        recovered_pending_repairs: recoveredPendingRepairs,
      },
    }, async (tx) => {
      await tx.recoveryReport.create({
        data: {
          id: reportId,
          startedAt,
          completedAt: new Date(),
          instanceId: "terminus-control-dev",
          schemaVersion: 1,
          nonTerminalTasks,
          nonTerminalTurns,
          reconciledJobs: jobRecovery.scanned,
          lostJobs: jobRecovery.lost,
          reconciledEffects: 0,
          manualReviewEffects: effectRecovery.manualReview.length,
          integrityOk: integrityOk
            && effectRecovery.failed.length === 0
            && providerRecovery.failed.length === 0
            && candidateBranchRecovery.failed.length === 0
            && checkpointLinks.failed.length === 0
            && checkpointLinks.quarantined.length === 0
            && checkpointAdmissions.failed.length === 0
            && checkpointAdmissions.quarantined.length === 0,
          detailsJson: JSON.stringify({
            providerRecovery,
            candidateBranchRecovery,
            jobRecovery,
            effectRecovery,
            checkpointLinks,
            checkpointAdmissions,
          }),
        },
      });
    });
    const report = await db.recoveryReport.findUniqueOrThrow({ where: { id: reportId } });

    sendJson(res, 200, {
      id: report.id,
      started_at: report.startedAt.toISOString(),
      completed_at: report.completedAt?.toISOString() ?? null,
      instance_id: report.instanceId,
      non_terminal_tasks: report.nonTerminalTasks,
      non_terminal_turns: report.nonTerminalTurns,
      lost_jobs: report.lostJobs,
      manual_review_effects: report.manualReviewEffects,
      manual_review_candidate_branches: candidateBranchRecovery.manualReview.length,
      integrity_ok: report.integrityOk,
      interrupted_attempts: providerRecovery.interrupted.length,
      recovered_active_turns: recoveredActiveTurns,
      recovered_pending_repairs: recoveredPendingRepairs,
      checkpoint_links: checkpointLinks,
      checkpoint_admissions: checkpointAdmissions,
      effect_recovery: effectRecovery,
      provider_recovery: providerRecovery,
      candidate_branch_recovery: candidateBranchRecovery,
    });
  }),

  // ────────────────────────── /export (§29.6) ───────────────────────────
  route("POST", "/v1/system/export", async (req, res) => {
    const body = await jsonBody(req) as { include_artifacts?: boolean; include_events?: boolean };
    // SPEC §29.6 portable export: manifest.json, state.sqlite.snapshot,
    // semantic-events.jsonl, artifacts/, workspace-manifest.json,
    // context-manifests/, verification/, README.md
    const exportId = uuid();
    const sessions = await db.session.findMany({ where: { status: { not: "deleted" } } });
    const tasks = await db.task.findMany({ where: { status: { not: "ABORTED" } }, include: { contractVersions: { orderBy: { version: "desc" }, take: 1 } } });
    const events = body.include_events === false ? [] : await db.semanticEvent.findMany({ orderBy: { occurredAt: "asc" }, take: 10000 });
    const manifests = await db.contextManifest.findMany({
      take: 1000,
      include: {
        fragments: true,
        providerAttempt: { include: { turn: { select: { taskId: true } } } },
      },
    });
    const verifications = await db.verificationPlan.findMany({ take: 500, include: { nodes: true, results: true } });
    const completionRecords = await db.completionRecord.findMany({ take: 500, orderBy: { generatedAt: "asc" } });
    const candidateBranches = await db.candidateBranch.findMany({ take: 500, orderBy: { createdAt: "asc" } });

    const exportPayload = {
      manifest: {
        format: "terminus-export-v1",
        exported_at: new Date().toISOString(),
        export_id: exportId,
        version: "0.1.0",
        counts: {
          sessions: sessions.length,
          tasks: tasks.length,
          events: events.length,
          manifests: manifests.length,
          verifications: verifications.length,
          completion_records: completionRecords.length,
          candidate_branches: candidateBranches.length,
        },
      },
      sessions: sessions.map((s) => ({
        id: s.id, workspace_id: s.workspaceId, title: s.title, status: s.status,
        created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(),
      })),
      tasks: tasks.map((t) => ({
        id: t.id, session_id: t.sessionId, status: t.status, phase: t.phase,
        objective: t.contractVersions[0]?.objective ?? null,
        created_at: t.createdAt.toISOString(), completed_at: t.completedAt?.toISOString() ?? null,
      })),
      events: events.map((e) => ({
        event_id: e.eventId, event_type: e.eventType, schema_version: e.schemaVersion,
        aggregate_type: e.aggregateType, aggregate_id: e.aggregateId,
        aggregate_sequence: e.aggregateSequence, occurred_at: e.occurredAt.toISOString(),
        payload: JSON.parse(e.payloadJson),
      })),
      context_manifests: manifests.map((m) => ({
        id: m.id, task_id: m.providerAttempt?.turn.taskId ?? null,
        provider_attempt_id: m.providerAttemptId,
        provider_key: m.providerKey, model_key: m.modelKey,
        compiler_version: m.compilerVersion, created_at: m.createdAt.toISOString(),
        epoch_id: m.epochId, rendered_request_hash: m.renderedRequestHash,
        estimated_tokens: safeParse<unknown>(m.estimatedTokensJson, null),
        cache_plan: safeParse<unknown>(m.cachePlanJson, null),
        fragments: m.fragments.map((f) => ({ kind: f.kind, selected: f.selected, authority: f.authority })),
      })),
      verification_plans: verifications.map((p) => ({
        id: p.id, task_id: p.taskId, completion_expression: p.completionExpression,
        contract_version: p.contractVersion, source_revision: p.sourceRevision,
        nodes: p.nodes.map((n) => ({ id: n.id, kind: n.kind, required: n.required })),
        results: p.results.map((r) => ({
          node_id: r.nodeId, status: r.status, source_revision: r.sourceRevision,
          environment_digest: r.environmentDigest, evidence_artifact: r.evidenceArtifact,
        })),
      })),
      completion_records: completionRecords.map((record) => ({
        id: record.id, task_id: record.taskId, contract_version: record.contractVersion,
        final_revision: record.finalRevision, status: record.status,
        admission_state: record.admissionState, candidate_branch_id: record.candidateBranchId,
        criteria: safeParse<unknown[]>(record.criteriaJson, []),
        verification_plan_id: record.verificationPlanId,
        unresolved_risks: safeParse<unknown[]>(record.unresolvedRisksJson, []),
        accepted_risks: safeParse<unknown[]>(record.acceptedRisksJson, []),
        external_effects: safeParse<unknown[]>(record.externalEffectsJson, []),
        cost_micros: record.costMicros.toString(), duration_seconds: record.durationSeconds,
        final_checkpoint: safeParse<unknown>(record.finalCheckpointJson, null),
        generated_at: record.generatedAt.toISOString(),
      })),
      candidate_branches: candidateBranches.map((branch) => ({
        id: branch.id, task_id: branch.taskId, attempt_id: branch.attemptId,
        base_revision: branch.baseRevision, head_revision: branch.headRevision,
        scope_digest: branch.scopeDigest, status: branch.status,
        effect_ids: safeParse<unknown[]>(branch.effectIdsJson, []),
        proof: safeParse<unknown>(branch.proofJson ?? "null", null),
        merge_receipt: safeParse<unknown>(branch.mergeReceiptJson ?? "null", null),
      })),
    };

    sendJson(res, 200, exportPayload);
  }),

  // ────────────────────────── /import (§29.6) ───────────────────────────
  route("POST", "/v1/system/import", async (req, res) => {
    const body = await jsonBody(req);
    const parsed = z.object({
      manifest: z.object({
        format: z.literal("terminus-export-v1"),
        export_id: z.string().min(1),
      }).passthrough(),
    }).passthrough().safeParse(body);
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_EXPORT_FORMAT", "unsupported export format", "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Portable import requires a trusted signed-export verifier and isolated validation store; no state was imported",
      "external_dependency",
      { exportId: parsed.data.manifest.export_id },
    );
  }),

  // ────────────────────────── /side-effects (§28.6) ─────────────────────
  route("GET", "/v1/side-effects", async (_req, res) => {
    const effects = await db.sideEffect.findMany({ orderBy: { startedAt: "desc" }, take: 100 });
    sendJson(res, 200, {
      side_effects: effects.map((e) => ({
        id: e.id,
        tool_call_id: e.toolCallId,
        effect_type: e.effectType,
        resource_uri: e.resourceUri,
        state: e.state,
        idempotency_key: e.idempotencyKey,
        reversibility: e.reversibility,
        evidence_artifact: e.evidenceArtifact,
        started_at: e.startedAt?.toISOString() ?? null,
        settled_at: e.settledAt?.toISOString() ?? null,
      })),
    });
  }),
  route("POST", "/v1/side-effects/:id/settle", async (req, res, params) => {
    const parsed = z.object({
      result: z.enum(["settled", "failed"]),
      reconciliationReceipt: TrustedReceiptReferenceWire,
    }).strict().safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_SETTLEMENT", "a trusted reconciliation receipt reference is required", "validation");
    }
    const effectId = String(params.id);
    const effect = await db.sideEffect.findUnique({ where: { id: effectId } });
    if (!effect) return sendError(res, 404, "SIDE_EFFECT_NOT_FOUND", "side effect not found", "not_found");
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted reconciliation-receipt verifier is configured; the side effect was not settled",
      "external_dependency",
      {
        effectId: effect.id,
        requestedResult: parsed.data.result,
        receiptArtifactUri: parsed.data.reconciliationReceipt.receiptArtifactRef.uri,
      },
    );
  }),

  // ────────────────────────── ARP v2 (/v2, SPEC §32) ─────────────────────
  route("GET", "/v2/system/health", async (_req, res) => {
    let kernelReady = false;
    try {
      const kernelHealth = await requireKernelUds().info.Health({});
      kernelReady = kernelHealth.state === "healthy" || kernelHealth.state === "ok";
    } catch {
      kernelReady = false;
    }
    const writerReady = writerLeaseIsHealthy();
    const ready = kernelReady && writerReady;
    sendJson(res, 200, {
      status: ready ? "ok" : "degraded",
      version: "0.1.0",
      protocolVersion: 2,
      uptimeSeconds: Math.floor(process.uptime()),
      ready,
      kernelReady,
      writerReady,
      writerFencingToken: writerLease?.fencingToken ?? null,
    });
  }),
  route("GET", "/v2/system/schema-registry", async (_req, res) => {
    const schemas: Record<string, unknown> = {};
    for (const [name, schema] of V2_SCHEMA_REGISTRY_ENTRIES) {
      schemas[name] = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    }
    sendJson(res, 200, {
      protocolVersion: 2 as const,
      supportedEventTypes: [...ARP_V2_EVENT_TYPES],
      supportedCommandTypes: [...ARP_V2_COMMAND_TYPES],
      schemas: jsonSafe(schemas),
    });
  }),
  route("POST", "/v2/tasks", async (req, res) => {
    const parsed = z.object({
      missionId: z.string().nullable().default(null),
      organizationId: z.string().default("default-org"),
      departmentId: z.string().default("default-dept"),
      v1Context: z.object({
        sessionId: z.string().min(1),
        threadId: z.string().min(1),
      }).nullable().default(null),
      contract: taskContractV2WireSchema,
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TASK_CONTRACT", `invalid v2 task request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const { missionId, organizationId, departmentId, v1Context, contract } = parsed.data;
    if (contract.mode === "interactive" && v1Context === null) {
      return sendError(
        res,
        409,
        "INTERACTIVE_TASK_REQUIRES_CONTEXT",
        "interactive tasks require an existing session and thread",
        "conflict",
      );
    }
    const nowIso = nowTimestamp();
    const task: TaskV2 = {
      id: uuid(),
      missionId,
      organizationId,
      departmentId,
      createdBy: SERVER_PRINCIPAL,
      conversationContext: v1Context === null ? null : {
        sessionId: v1Context.sessionId,
        threadId: v1Context.threadId,
        attachedAt: nowIso,
      },
      contract: contract as TaskContractV2,
      status: "DRAFT",
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
    };
    if (v1Context !== null) {
      const projection = await taskProjectionService.inspectV1(task.id, v1Context);
      if (projection === "thread_not_found") {
        return sendError(
          res,
          409,
          "TASK_CONTEXT_MISMATCH",
          "v1 task context must name an existing thread in the supplied session",
          "conflict",
        );
      }
      if (projection === "context_mismatch") {
        return sendError(res, 409, "TASK_CONTEXT_MISMATCH", "task is already attached to another conversation", "conflict");
      }
    }
    await emitV2({
      eventType: "task.created",
      aggregateType: "task",
      aggregateId: task.id,
      snapshot: task,
      idempotencyKey: req.headers["idempotency-key"] as string | undefined ?? null,
      mutation: v1Context === null
        ? undefined
        : async (tx) => {
          const projection = await taskProjectionService.createV1(tx, task, v1Context);
          if (projection !== "created") {
            throw new Error(`v1 task projection changed during v2 creation (${projection})`);
          }
        },
    });
    arpV2.tasks.set(task.id, task);
    sendJson(res, 201, jsonSafe(task));
  }),
  route("GET", "/v2/tasks/:id", async (_req, res, params) => {
    const task = arpV2.tasks.get(String(params.id));
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    sendJson(res, 200, jsonSafe(task));
  }),
  route("GET", "/v2/tasks", async (_req, res) => {
    const tasks = [...arpV2.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, { tasks: jsonSafe(tasks) });
  }),
  route("GET", "/v2/tasks/:id/conversation-context", async (_req, res, params) => {
    const id = String(params.id);
    const task = arpV2.tasks.get(id);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    const projection = await db.task.findUnique({
      where: { id },
      select: { sessionId: true, threadId: true, createdAt: true },
    });
    const context = projection === null ? null : {
      sessionId: projection.sessionId,
      threadId: projection.threadId,
      attachedAt: projection.createdAt.toISOString(),
    };
    sendJson(res, 200, context);
  }),
  route("POST", "/v2/tasks/:id/conversation-context", async (req, res, params) => {
    const id = String(params.id);
    const task = arpV2.tasks.get(id);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    const parsed = z.object({
      sessionId: z.string().min(1),
      threadId: z.string().min(1),
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TASK_CONTEXT", `invalid task context: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    if (parsed.data.expectedVersion !== null && parsed.data.expectedVersion !== task.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${parsed.data.expectedVersion} but task is at version ${task.version}`, "conflict");
    }
    if (task.conversationContext !== null && task.conversationContext !== undefined) {
      if (task.conversationContext.sessionId !== parsed.data.sessionId || task.conversationContext.threadId !== parsed.data.threadId) {
        return sendError(res, 409, "TASK_CONTEXT_MISMATCH", "task is already attached to another conversation", "conflict");
      }
      return sendJson(res, 200, jsonSafe(task));
    }
    const attachedAt = nowTimestamp();
    const context = { sessionId: parsed.data.sessionId, threadId: parsed.data.threadId, attachedAt };
    const projection = await taskProjectionService.inspectV1(task.id, context);
    if (projection === "thread_not_found") {
      return sendError(res, 409, "TASK_CONTEXT_MISMATCH", "task context must name an existing thread in the supplied session", "conflict");
    }
    if (projection === "context_mismatch") {
      return sendError(res, 409, "TASK_CONTEXT_MISMATCH", "task is already attached to another conversation", "conflict");
    }
    const updated: TaskV2 = {
      ...task,
      conversationContext: context,
      version: task.version + 1,
      updatedAt: attachedAt,
    };
    await emitV2({
      eventType: "task.conversation_context_attached",
      aggregateType: "task",
      aggregateId: id,
      snapshot: updated,
      correlationId: id,
      idempotencyKey: req.headers["idempotency-key"] as string | undefined ?? null,
      mutation: async (tx) => {
        const settled = await taskProjectionService.createV1(tx, task, context);
        if (settled !== "created" && settled !== "existing") {
          throw new Error(`v1 task projection changed during conversation attachment (${settled})`);
        }
      },
    });
    arpV2.tasks.set(id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/tasks/:id/transition", async (req, res, params) => {
    const id = String(params.id);
    const task = arpV2.tasks.get(id);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    const parsed = z.object({
      id: z.string().optional(),
      targetStatus: z.enum(["DRAFT", "READY", "RUNNING", "WAITING_USER", "WAITING_AUTH", "WAITING_RESOURCE", "PAUSED", "VERIFYING", "COMPLETED", "PARTIAL", "BLOCKED", "CANCELLED", "FAILED"]),
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
      reason: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TRANSITION_REQUEST", `invalid transition request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const { targetStatus, expectedVersion, reason } = parsed.data;
    if (targetStatus === "COMPLETED") {
      return sendError(
        res,
        409,
        "COMPLETION_REQUIRES_ADMISSION",
        "tasks may reach COMPLETED only through verification and candidate admission",
        "policy",
      );
    }
    if (expectedVersion !== null && expectedVersion !== task.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${expectedVersion} but task is at version ${task.version}`, "conflict", { expected_version: expectedVersion, actual_version: task.version });
    }
    if (!isTaskV2TransitionAllowed(task.status, targetStatus)) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `illegal task transition ${task.status} -> ${targetStatus}`, "conflict", { from: task.status, to: targetStatus });
    }
    const terminal = targetStatus === "PARTIAL" || targetStatus === "CANCELLED" || targetStatus === "FAILED";
    const updated: TaskV2 = {
      ...task,
      status: targetStatus,
      version: task.version + 1,
      updatedAt: nowTimestamp(),
      completedAt: terminal ? nowTimestamp() : null,
    };
    await emitV2({
      eventType: `task.${targetStatus.toLowerCase()}`,
      aggregateType: "task",
      aggregateId: id,
      snapshot: updated,
      correlationId: id,
      mutation: async (tx) => {
        await taskProjectionService.projectStatus(tx, id, targetStatus);
      },
    });
    arpV2.tasks.set(id, updated);
    void reason;
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/tasks/:id/contract", async (req, res, params) => {
    const id = String(params.id);
    const task = arpV2.tasks.get(id);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    const parsed = z.object({
      contract: taskContractV2WireSchema,
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TASK_CONTRACT", `invalid contract update: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    if (isTaskV2Terminal(task.status)) {
      return sendError(res, 409, "TASK_TERMINAL", `terminal task contracts are immutable (${task.status})`, "conflict");
    }
    if (parsed.data.expectedVersion !== null && parsed.data.expectedVersion !== task.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${parsed.data.expectedVersion} but task is at version ${task.version}`, "conflict");
    }
    const updated: TaskV2 = {
      ...task,
      contract: parsed.data.contract as TaskContractV2,
      version: task.version + 1,
      updatedAt: nowTimestamp(),
    };
    const bridgedTask = await db.task.findUnique({
      where: { id },
      select: { activeContractVersion: true, status: true },
    });
    if (bridgedTask && updated.contract.version !== bridgedTask.activeContractVersion + 1) {
      return sendError(
        res,
        409,
        "CONTRACT_VERSION_CONFLICT",
        `bridged v1 task requires contract version ${bridgedTask.activeContractVersion + 1}`,
        "conflict",
      );
    }
    if (bridgedTask && !isMutableV1TaskStatus(bridgedTask.status)) {
      return sendError(res, 409, "TASK_TERMINAL", `terminal v1 task contracts are immutable (${bridgedTask.status})`, "conflict");
    }
    await emitV2({
      eventType: "task.contract_updated",
      aggregateType: "task",
      aggregateId: id,
      snapshot: updated,
      correlationId: id,
      mutation: async (tx) => {
        await taskProjectionService.projectContract(tx, id, updated.contract);
      },
    });
    arpV2.tasks.set(id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/effects", async (req, res) => {
    const parsed = V2_ENDPOINTS.ProposeEffectV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_EFFECT_REQUEST", `invalid effect proposal: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const body = parsed.data;
    const task = arpV2.tasks.get(body.taskId);
    if (!task) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${body.taskId} not found`, "not_found");
    }
    if (isTaskV2Terminal(task.status)) {
      return sendError(res, 409, "TASK_TERMINAL", `terminal task cannot propose effects (${task.status})`, "conflict");
    }
    const existing = [...arpV2.effects.values()].find((e) => e.semanticIdempotencyKey === body.semanticIdempotencyKey);
    if (existing) {
      return sendV2Response(res, 200, V2_ENDPOINTS.ProposeEffectV2.response, existing);
    }
    const effect: EffectRecord = {
      id: uuid(),
      taskId: body.taskId,
      attemptId: body.attemptId,
      principal: SERVER_PRINCIPAL,
      connectorOrWorker: body.connectorOrWorker,
      intentType: body.intentType,
      canonicalParameters: body.canonicalParameters,
      resourceHandles: body.resourceHandles,
      effectClass: body.effectClass,
      semanticIdempotencyKey: body.semanticIdempotencyKey,
      authorizationId: null,
      policyDecisionId: null,
      state: "PROPOSED",
      uncertaintyReason: null,
      compensationRef: null,
      version: 0,
      createdAt: nowTimestamp(),
      settledAt: null,
    };
    await emitV2({
      eventType: "effect.proposed",
      aggregateType: "effect",
      aggregateId: effect.id,
      snapshot: effect,
      idempotencyKey: body.semanticIdempotencyKey,
      correlationId: effect.taskId,
    });
    arpV2.effects.set(effect.id, effect);
    sendV2Response(res, 201, V2_ENDPOINTS.ProposeEffectV2.response, effect);
  }),
  route("GET", "/v2/effects/:id", async (_req, res, params) => {
    const effect = arpV2.effects.get(String(params.id));
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    sendJson(res, 200, jsonSafe(effect));
  }),
  route("GET", "/v2/effects", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const taskId = url.searchParams.get("taskId");
    const all = [...arpV2.effects.values()]
      .filter((e) => !taskId || e.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, { effects: jsonSafe(all) });
  }),
  route("POST", "/v2/effects/:id/transition", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const parsed = z.object({
      targetState: z.enum(["PROPOSED", "POLICY_CHECKED", "AUTHORIZATION_REQUIRED", "AUTHORIZED", "PREPARED", "DISPATCHED", "OBSERVED", "VALIDATED", "COMMITTED", "DENIED", "CANCELLED", "UNCERTAIN", "RECONCILING", "COMPENSATING", "COMPENSATED", "RESIDUE", "MANUAL_RECONCILE"]),
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
      reason: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TRANSITION_REQUEST", `invalid effect transition: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const { targetState, expectedVersion } = parsed.data;
    if (expectedVersion !== null && expectedVersion !== effect.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${expectedVersion} but effect is at version ${effect.version}`, "conflict", { expected_version: expectedVersion, actual_version: effect.version });
    }
    if (!isEffectTransitionAllowed(effect.state, targetState)) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `illegal effect transition ${effect.state} -> ${targetState}`, "conflict", { from: effect.state, to: targetState });
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Effect advancement requires a verified policy, authorization, dispatch, observation, denial, or cancellation receipt; the standalone control plane did not change state",
      "external_dependency",
      { effectId: effect.id, from: effect.state, requestedState: targetState },
    );
  }),
  // Semantic alias: authorize an authorization-gated effect (POLICY_CHECKED |
  // AUTHORIZATION_REQUIRED → AUTHORIZED). Strict — no state skipping.
  route("POST", "/v2/effects/:id/authorize", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const body = await jsonBody(req);
    const parsed = V2_ENDPOINTS.AuthorizeEffectV2.request.safeParse({
      ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}),
      id,
    });
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_AUTHORIZATION", "authorizationId is required", "validation");
    }
    if (effect.state !== "POLICY_CHECKED" && effect.state !== "AUTHORIZATION_REQUIRED") {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `effect in state ${effect.state} cannot be authorized`, "conflict", { from: effect.state });
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No durable policy/approval authorization broker is configured; the authorization reference was not consumed and the effect was not authorized",
      "external_dependency",
      { effectId: effect.id, authorizationId: parsed.data.authorizationId },
    );
  }),
  // Semantic alias: commit a validated effect (VALIDATED → COMMITTED). Strict.
  route("POST", "/v2/effects/:id/commit", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const body = await jsonBody(req);
    const parsed = V2_ENDPOINTS.CommitEffectV2.request.safeParse({
      ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}),
      id,
    });
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_COMMIT_REQUEST", "a validation receipt artifact is required", "validation");
    }
    if (parsed.data.expectedVersion !== null && parsed.data.expectedVersion !== effect.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${parsed.data.expectedVersion} but effect is at version ${effect.version}`, "conflict");
    }
    if (effect.state !== "VALIDATED") {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `effect in state ${effect.state} cannot be committed; it must reach VALIDATED first`, "conflict", { from: effect.state });
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted validation-receipt verifier is configured; the effect remains VALIDATED and was not committed",
      "external_dependency",
      {
        effectId: effect.id,
        validationReceiptArtifactUri: parsed.data.validationReceiptArtifactRef.uri,
      },
    );
  }),
  route("POST", "/v2/effects/:id/reconcile", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const body = await jsonBody(req);
    const parsed = V2_ENDPOINTS.ReconcileEffectV2.request.safeParse({
      ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}),
      id,
    });
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_RECONCILIATION", "a trusted reconciliation receipt is required", "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted reconciliation-receipt verifier is configured; the effect state was not changed",
      "external_dependency",
      {
        effectId: effect.id,
        receiptArtifactUri: parsed.data.reconciliationReceipt.receiptArtifactRef.uri,
      },
    );
  }),
  route("POST", "/v2/authorizations", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      taskVersion: z.number().int().nonnegative().default(1),
      effectClass: z.string().min(1),
      maxScope: z.array(z.string()).default([]),
      useLimit: z.number().int().positive().default(1),
      expiry: z.string().default(new Date(Date.now() + 300_000).toISOString()),
      approvalHash: z.string().nullable().default(null),
      humanApprovalId: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_AUTHORIZATION_REQUEST", `invalid authorization request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Authorizations are created only by the durable policy/approval broker; public caller-authored authorization minting is disabled",
      "external_dependency",
      { taskId: parsed.data.taskId, effectClass: parsed.data.effectClass },
    );
  }),
  route("GET", "/v2/authorizations/:id", async (_req, res, params) => {
    const authz = arpV2.authorizations.get(String(params.id));
    if (!authz) return sendError(res, 404, "AUTHORIZATION_NOT_FOUND", "v2 authorization not found", "not_found");
    sendJson(res, 200, jsonSafe(authz));
  }),
  route("GET", "/v2/authorizations", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const taskId = url.searchParams.get("taskId");
    const all = [...arpV2.authorizations.values()]
      .filter((a) => !taskId || a.taskId === taskId);
    sendJson(res, 200, { authorizations: jsonSafe(all) });
  }),
  route("POST", "/v2/authorizations/:id/consume", async (req, res, params) => {
    const id = String(params.id);
    const authz = arpV2.authorizations.get(id);
    if (!authz) return sendError(res, 404, "AUTHORIZATION_NOT_FOUND", "v2 authorization not found", "not_found");
    const parsed = z.object({
      taskId: z.string().min(1),
      taskVersion: z.number().int().nonnegative(),
      effectClass: z.string().min(1),
      approvalHash: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_CONSUME_REQUEST", "invalid consume request", "validation");
    }
    const { taskId, taskVersion, effectClass } = parsed.data;
    if (authz.taskId !== taskId) {
      return sendError(res, 403, "CROSS_TASK_REJECTED", `authorization ${id} is bound to task ${authz.taskId}`, "forbidden");
    }
    if (authz.taskVersion !== taskVersion) {
      return sendError(res, 409, "STALE_VERSION_REJECTED", `authorization ${id} is bound to task version ${authz.taskVersion}`, "conflict");
    }
    if (authz.effectClass !== effectClass && authz.effectClass !== "ADMIN") {
      return sendError(res, 403, "EFFECT_CLASS_MISMATCH", `authorization authorizes ${authz.effectClass}, requested ${effectClass}`, "forbidden");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Authorization consumption is performed only by the durable effect dispatcher with exact operation binding; no authorization was consumed",
      "external_dependency",
      { authorizationId: id, taskId, taskVersion, effectClass },
    );
  }),
  route("POST", "/v2/authorizations/:id/revoke", async (_req, res, params) => {
    const id = String(params.id);
    const authz = arpV2.authorizations.get(id);
    if (!authz) return sendError(res, 404, "AUTHORIZATION_NOT_FOUND", "v2 authorization not found", "not_found");
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Authorization revocation requires an attributable policy-broker principal; no authorization was changed",
      "external_dependency",
      { authorizationId: id, taskId: authz.taskId },
    );
  }),
  route("GET", "/v2/claims", async (req, res) => {
    const taskId = new URL(req.url ?? "", "http://terminus.local").searchParams.get("taskId");
    if (taskId !== null && !arpV2.tasks.has(taskId)) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${taskId} not found`, "not_found");
    }
    const claims = [...arpV2.claims.values()]
      .filter((claim) => taskId === null || claim.taskId === taskId)
      .map((claim) => jsonSafe(claim));
    sendJson(res, 200, { claims });
  }),
  route("POST", "/v2/claims", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      statement: z.string().min(1),
      requiredEvidenceKind: z.string().min(1),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_CLAIM", `invalid claim: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const task = arpV2.tasks.get(parsed.data.taskId);
    if (!task) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${parsed.data.taskId} not found`, "not_found");
    }
    if (isTaskV2Terminal(task.status)) {
      return sendError(res, 409, "TASK_TERMINAL", `terminal task cannot create claims (${task.status})`, "conflict");
    }
    const nowIso = nowTimestamp();
    const claim: Claim = {
      id: uuid(),
      taskId: parsed.data.taskId,
      statement: parsed.data.statement,
      requiredEvidenceKind: parsed.data.requiredEvidenceKind,
      status: "PROPOSED",
      evidenceIds: [],
      waivedRationale: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await emitV2({ eventType: "claim.proposed", aggregateType: "claim", aggregateId: claim.id, snapshot: claim, correlationId: claim.taskId });
    arpV2.claims.set(claim.id, claim);
    sendJson(res, 201, jsonSafe(claim));
  }),
  route("POST", "/v2/claims/:id/waive", async (req, res, params) => {
    const id = String(params.id);
    const claim = arpV2.claims.get(id);
    if (!claim) return sendError(res, 404, "CLAIM_NOT_FOUND", "v2 claim not found", "not_found");
    const parsed = z.object({ rationale: z.string().min(1) }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_WAIVER", "a non-empty rationale is required to waive a claim", "validation");
    }
    const updated: Claim = { ...claim, status: "WAIVED", waivedRationale: parsed.data.rationale, updatedAt: nowTimestamp() };
    await emitV2({ eventType: "claim.waived", aggregateType: "claim", aggregateId: id, snapshot: updated, correlationId: claim.taskId });
    arpV2.claims.set(id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("GET", "/v2/evidence", async (req, res) => {
    const taskId = new URL(req.url ?? "", "http://terminus.local").searchParams.get("taskId");
    if (taskId !== null && !arpV2.tasks.has(taskId)) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${taskId} not found`, "not_found");
    }
    const claimIds = taskId === null
      ? null
      : new Set([...arpV2.claims.values()]
        .filter((claim) => claim.taskId === taskId)
        .map((claim) => claim.id));
    const evidence = [...arpV2.evidences.values()]
      .filter((item) => claimIds === null || claimIds.has(item.claimId))
      .map((item) => jsonSafe(item));
    sendJson(res, 200, { evidence });
  }),
  route("POST", "/v2/evidence", async (req, res) => {
    const parsed = V2_ENDPOINTS.RecordEvidenceV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_EVIDENCE", "a trusted verifier receipt reference is required", "validation");
    }
    const claim = arpV2.claims.get(parsed.data.claimId);
    if (!claim) return sendError(res, 404, "CLAIM_NOT_FOUND", `v2 claim ${parsed.data.claimId} not found`, "not_found");
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted verifier-receipt validator is configured; evidence was not admitted and the claim remains unchanged",
      "external_dependency",
      {
        claimId: claim.id,
        verifierId: parsed.data.verifierId,
        verifierVersion: parsed.data.verifierVersion,
        receiptArtifactUri: parsed.data.receipt.receiptArtifactRef.uri,
      },
    );
  }),
  // ────────────────────────── /v2/workflows ─────────────────────────────────
  route("POST", "/v2/workflows", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      nodes: z.array(workflowNodeSchema).min(1),
      edges: z.array(guardedEdgeSchema).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_WORKFLOW", `invalid workflow: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    if (!arpV2.tasks.has(parsed.data.taskId)) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${parsed.data.taskId} not found`, "not_found");
    }
    const report = validateWorkflow({ nodes: parsed.data.nodes, edges: parsed.data.edges });
    if (!report.valid) {
      return sendError(res, 400, "WORKFLOW_VALIDATION_FAILED", `workflow failed static validation: ${report.errors.map((e) => e.message).join("; ")}`, "validation", { report });
    }
    const nowIso = nowTimestamp();
    const workflow: Workflow = {
      id: uuid(),
      version: 1,
      taskId: parsed.data.taskId,
      nodes: parsed.data.nodes,
      edges: parsed.data.edges,
      staticAnalysis: report,
      createdAt: nowIso,
    };
    await emitV2({ eventType: "workflow.created", aggregateType: "workflow", aggregateId: workflow.id, snapshot: workflow, correlationId: workflow.taskId });
    arpV2.workflows.set(workflow.id, workflow);
    sendJson(res, 201, jsonSafe(workflow));
  }),
  route("POST", "/v2/workflows/compile", async (req, res) => {
    const parsed = z.object({
      source: z.string().min(1),
      sourceKind: z.enum(["skill_markdown", "json_ir", "prose_spec"]).default("skill_markdown"),
      sourcePath: z.string().optional(),
      taskId: z.string().optional(),
      authorityCeiling: z.array(z.string()).optional(),
      mandatorySteps: z.array(z.string()).optional(),
      strictMode: z.boolean().default(false),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_COMPILE_REQUEST", "invalid compile parameters", "validation");
    }
    try {
      let result;
      if (parsed.data.sourceKind === "skill_markdown") {
        result = compileSkill(parsed.data.source, {
          sourcePath: parsed.data.sourcePath,
          taskId: parsed.data.taskId,
          authorityCeiling: parsed.data.authorityCeiling,
          mandatorySteps: parsed.data.mandatorySteps,
          strictMode: parsed.data.strictMode,
        });
      } else {
        result = compileWorkflowJson(parsed.data.source, {
          sourcePath: parsed.data.sourcePath,
          taskId: parsed.data.taskId,
          authorityCeiling: parsed.data.authorityCeiling,
          mandatorySteps: parsed.data.mandatorySteps,
          strictMode: parsed.data.strictMode,
        });
      }
      await emitV2({ eventType: "workflow.compiled", aggregateType: "workflow", aggregateId: result.workflow.id, snapshot: result.workflow, correlationId: result.workflow.taskId });
      arpV2.workflows.set(result.workflow.id, result.workflow);
      sendJson(res, 200, jsonSafe({ workflow: result.workflow, report: result.report }));
    } catch (err: unknown) {
      logInternalError("workflow compilation failed", err);
      return sendError(res, 400, "COMPILATION_FAILED", "workflow source failed validation", "validation");
    }
  }),
  route("POST", "/v2/workflows/validate", async (req, res) => {
    const parsed = z.object({
      nodes: z.array(workflowNodeSchema).min(1),
      edges: z.array(guardedEdgeSchema).default([]),
      authorityCeiling: z.array(z.string()).optional(),
      mandatorySteps: z.array(z.string()).optional(),
      strictMode: z.boolean().default(false),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_VALIDATE_REQUEST", "invalid validation payload", "validation");
    }
    const report = validateWorkflow({
      nodes: parsed.data.nodes,
      edges: parsed.data.edges,
      authorityCeiling: parsed.data.authorityCeiling,
      mandatorySteps: parsed.data.mandatorySteps,
    }, { strictMode: parsed.data.strictMode });
    sendJson(res, 200, jsonSafe(report));
  }),
  route("GET", "/v2/workflows/:id", async (_req, res, params) => {
    const wf = arpV2.workflows.get(String(params.id));
    if (!wf) return sendError(res, 404, "WORKFLOW_NOT_FOUND", "workflow not found", "not_found");
    sendJson(res, 200, jsonSafe(wf));
  }),
  route("GET", "/v2/workflows/:id/dag", async (_req, res, params) => {
    const wf = arpV2.workflows.get(String(params.id));
    if (!wf) return sendError(res, 404, "WORKFLOW_NOT_FOUND", "workflow not found", "not_found");
    const nodes = wf.nodes.map((n) => ({ id: n.id, kind: n.kind, owner: n.owner, effectClass: n.effectClass }));
    const edges = wf.edges.map((e) => ({ sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId, condition: e.condition }));
    sendJson(res, 200, jsonSafe({ workflowId: wf.id, nodes, edges }));
  }),
  route("GET", "/v2/workflows/:id/witness-paths", async (_req, res, params) => {
    const wf = arpV2.workflows.get(String(params.id));
    if (!wf) return sendError(res, 404, "WORKFLOW_NOT_FOUND", "workflow not found", "not_found");
    const witnessPaths = wf.staticAnalysis?.witnessPaths ?? [];
    sendJson(res, 200, jsonSafe({ workflowId: wf.id, witnessPaths }));
  }),
  route("POST", "/v2/workflows/:id/nodes/:nodeId/execute", async (req, res, params) => {
    const wf = arpV2.workflows.get(String(params.id));
    if (!wf) return sendError(res, 404, "WORKFLOW_NOT_FOUND", "workflow not found", "not_found");
    const node = wf.nodes.find((n) => n.id === params.nodeId);
    if (!node) return sendError(res, 404, "NODE_NOT_FOUND", `node ${params.nodeId} not found in workflow`, "not_found");
    const parsed = z.object({
      attemptId: z.string().min(1),
      inputs: z.record(z.string(), z.unknown()).default({}),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_NODE_EXECUTION", "invalid node execution request", "validation");
    }
    const nowIso = nowTimestamp();
    const nodeRun: NodeRun = {
      id: uuid(),
      workflowId: wf.id,
      nodeId: node.id,
      attemptId: parsed.data.attemptId,
      status: "RUNNING",
      inputs: { ...node.inputs, ...parsed.data.inputs },
      outputs: null,
      error: null,
      startedAt: nowIso,
      settledAt: null,
    };
    await emitV2({ eventType: "workflow.node_started", aggregateType: "node_run", aggregateId: nodeRun.id, snapshot: nodeRun, correlationId: wf.taskId });
    arpV2.nodeRuns.set(nodeRun.id, nodeRun);
    sendJson(res, 201, jsonSafe(nodeRun));
  }),
  route("POST", "/v2/workflows/:id/nodes/:nodeRunId/complete", async (req, res, params) => {
    const run = arpV2.nodeRuns.get(String(params.nodeRunId));
    if (!run) return sendError(res, 404, "NODE_RUN_NOT_FOUND", "node run not found", "not_found");
    if (!isNodeRunTransitionAllowed(run.status, "COMPLETED")) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot transition node run from ${run.status} to COMPLETED`, "conflict");
    }
    const parsed = z.object({ outputs: z.record(z.string(), z.unknown()).default({}) }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_COMPLETION", "invalid completion outputs", "validation");
    const updated: NodeRun = { ...run, status: "COMPLETED", outputs: parsed.data.outputs, settledAt: nowTimestamp() };
    await emitV2({ eventType: "workflow.node_completed", aggregateType: "node_run", aggregateId: run.id, snapshot: updated, correlationId: run.workflowId });
    arpV2.nodeRuns.set(run.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/workflows/:id/nodes/:nodeRunId/fail", async (req, res, params) => {
    const run = arpV2.nodeRuns.get(String(params.nodeRunId));
    if (!run) return sendError(res, 404, "NODE_RUN_NOT_FOUND", "node run not found", "not_found");
    if (!isNodeRunTransitionAllowed(run.status, "FAILED")) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot transition node run from ${run.status} to FAILED`, "conflict");
    }
    const parsed = z.object({ error: z.string().min(1) }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_FAILURE", "error message is required", "validation");
    const updated: NodeRun = { ...run, status: "FAILED", error: parsed.data.error, settledAt: nowTimestamp() };
    await emitV2({ eventType: "workflow.node_failed", aggregateType: "node_run", aggregateId: run.id, snapshot: updated, correlationId: run.workflowId });
    arpV2.nodeRuns.set(run.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  // ────────────────────────── /v2/leases ────────────────────────────────────
  route("POST", "/v2/leases/acquire", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      workerId: z.string().min(1),
      ttlSeconds: z.number().int().positive().default(30),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_LEASE_REQUEST", "invalid lease acquire payload", "validation");
    const { taskId, workerId, ttlSeconds } = parsed.data;
    if (!arpV2.tasks.has(taskId)) return sendError(res, 404, "TASK_NOT_FOUND", `task ${taskId} not found`, "not_found");

    // Monotonic fencing token per task
    let maxFencingToken = 0;
    for (const lease of arpV2.workerLeases.values()) {
      if (lease.taskId === taskId) {
        maxFencingToken = Math.max(maxFencingToken, lease.fencingToken);
        if (lease.status === "ACQUIRED" || lease.status === "RENEWED") {
          const fenced: WorkerLease = { ...lease, status: "FENCED" };
          await emitV2({ eventType: "lease.fenced", aggregateType: "lease", aggregateId: lease.id, snapshot: fenced, correlationId: taskId });
          arpV2.workerLeases.set(lease.id, fenced);
        }
      }
    }

    const now = new Date();
    const expires = new Date(now.getTime() + ttlSeconds * 1000);
    const newLease: WorkerLease = {
      id: uuid(),
      taskId,
      workerId,
      fencingToken: maxFencingToken + 1,
      status: "ACQUIRED",
      acquiredAt: now.toISOString() as Rfc3339Timestamp,
      expiresAt: expires.toISOString() as Rfc3339Timestamp,
      releasedAt: null,
      metadata: {},
    };
    await emitV2({ eventType: "lease.acquired", aggregateType: "lease", aggregateId: newLease.id, snapshot: newLease, correlationId: taskId });
    arpV2.workerLeases.set(newLease.id, newLease);
    sendJson(res, 201, jsonSafe(newLease));
  }),
  route("POST", "/v2/leases/renew", async (req, res) => {
    const parsed = z.object({
      leaseId: z.string().min(1),
      fencingToken: z.number().int().positive(),
      workerId: z.string().min(1),
      ttlSeconds: z.number().int().positive().default(30),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_RENEW_REQUEST", "invalid lease renew payload", "validation");
    const { leaseId, fencingToken, workerId, ttlSeconds } = parsed.data;
    const lease = arpV2.workerLeases.get(leaseId);
    if (!lease) return sendError(res, 404, "LEASE_NOT_FOUND", "lease not found", "not_found");
    if (lease.workerId !== workerId || lease.fencingToken !== fencingToken) {
      return sendError(res, 409, "FENCING_ERROR", "worker or fencing token mismatch", "conflict");
    }
    if (!isLeaseTransitionAllowed(lease.status, "RENEWED")) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot renew lease in status ${lease.status}`, "conflict");
    }
    const now = new Date();
    const expires = new Date(now.getTime() + ttlSeconds * 1000);
    const updated: WorkerLease = {
      ...lease,
      status: "RENEWED",
      expiresAt: expires.toISOString() as Rfc3339Timestamp,
    };
    await emitV2({ eventType: "lease.renewed", aggregateType: "lease", aggregateId: lease.id, snapshot: updated, correlationId: lease.taskId });
    arpV2.workerLeases.set(lease.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/leases/release", async (req, res) => {
    const parsed = z.object({
      leaseId: z.string().min(1),
      fencingToken: z.number().int().positive(),
      workerId: z.string().min(1),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_RELEASE_REQUEST", "invalid lease release payload", "validation");
    const { leaseId, fencingToken, workerId } = parsed.data;
    const lease = arpV2.workerLeases.get(leaseId);
    if (!lease) return sendError(res, 404, "LEASE_NOT_FOUND", "lease not found", "not_found");
    if (lease.workerId !== workerId || lease.fencingToken !== fencingToken) {
      return sendError(res, 409, "FENCING_ERROR", "worker or fencing token mismatch", "conflict");
    }
    const updated: WorkerLease = { ...lease, status: "RELEASED" };
    await emitV2({ eventType: "lease.released", aggregateType: "lease", aggregateId: lease.id, snapshot: updated, correlationId: lease.taskId });
    arpV2.workerLeases.set(lease.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("GET", "/v2/leases/:taskId", async (_req, res, params) => {
    const active = [...arpV2.workerLeases.values()]
      .filter((l) => l.taskId === params.taskId && (l.status === "ACQUIRED" || l.status === "RENEWED"))
      .pop();
    if (!active) return sendError(res, 404, "NO_ACTIVE_LEASE", `no active lease for task ${params.taskId}`, "not_found");
    sendJson(res, 200, jsonSafe(active));
  }),
  // ────────────────────────── /v2/tasks/:id/attempts ────────────────────────
  route("POST", "/v2/tasks/:id/attempts/start", async (req, res, params) => {
    const taskId = String(params.id);
    const parsed = z.object({
      workerId: z.string().min(1),
      fencingToken: z.number().int().positive(),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_ATTEMPT_REQUEST", "invalid start attempt payload", "validation");
    const { workerId, fencingToken } = parsed.data;
    const lease = [...arpV2.workerLeases.values()]
      .find((l) => l.taskId === taskId && l.workerId === workerId && l.fencingToken === fencingToken && (l.status === "ACQUIRED" || l.status === "RENEWED"));
    if (!lease) {
      return sendError(res, 403, "FENCING_ERROR", "worker does not hold active valid lease with matching fencing token", "auth");
    }
    const attempts = [...arpV2.attempts.values()].filter((a) => a.taskId === taskId);
    const attempt: TaskAttempt = {
      id: uuid(),
      taskId,
      attemptNumber: attempts.length + 1,
      workerId,
      fencingToken,
      status: "RUNNING",
      startedAt: nowTimestamp(),
      settledAt: null,
      error: null,
    };
    await emitV2({ eventType: "attempt.started", aggregateType: "attempt", aggregateId: attempt.id, snapshot: attempt, correlationId: taskId });
    arpV2.attempts.set(attempt.id, attempt);
    sendJson(res, 201, jsonSafe(attempt));
  }),
  route("POST", "/v2/tasks/:id/attempts/:attemptId/settle", async (req, res, params) => {
    const taskId = String(params.id);
    const attempt = arpV2.attempts.get(String(params.attemptId));
    if (!attempt) return sendError(res, 404, "ATTEMPT_NOT_FOUND", "attempt not found", "not_found");
    if (attempt.taskId !== taskId) {
      return sendError(res, 404, "ATTEMPT_NOT_FOUND", "attempt not found for task", "not_found");
    }
    const parsed = z.object({
      status: z.enum(["COMPLETED", "FAILED"]),
      error: z.string().nullable().default(null),
      workerId: z.string().min(1),
      fencingToken: z.number().int().positive(),
      settlementReceipt: TrustedReceiptReferenceWire,
    }).strict().safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_SETTLEMENT", "worker fencing and a trusted settlement receipt reference are required", "validation");
    if (attempt.workerId !== parsed.data.workerId || attempt.fencingToken !== parsed.data.fencingToken) {
      return sendError(res, 409, "FENCING_ERROR", "worker or fencing token mismatch", "conflict");
    }
    if (!isAttemptTransitionAllowed(attempt.status, parsed.data.status)) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot transition attempt from ${attempt.status} to ${parsed.data.status}`, "conflict");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted worker-settlement receipt verifier is configured; the attempt was not settled",
      "external_dependency",
      {
        attemptId: attempt.id,
        requestedStatus: parsed.data.status,
        receiptArtifactUri: parsed.data.settlementReceipt.receiptArtifactRef.uri,
      },
    );
  }),
  // ────────────────────────── /v2/questions ─────────────────────────────────
  route("POST", "/v2/questions", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      prompt: z.string().min(1),
      options: z.array(z.string()).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_QUESTION", "invalid question payload", "validation");
    const q: Question = {
      id: uuid(),
      taskId: parsed.data.taskId,
      prompt: parsed.data.prompt,
      options: parsed.data.options,
      selectedOption: null,
      rationale: null,
      status: "PENDING",
      createdAt: nowTimestamp(),
      resolvedAt: null,
    };
    await emitV2({ eventType: "question.asked", aggregateType: "question", aggregateId: q.id, snapshot: q, correlationId: q.taskId });
    arpV2.questions.set(q.id, q);
    sendJson(res, 201, jsonSafe(q));
  }),
  route("POST", "/v2/questions/:id/answer", async (req, res, params) => {
    const q = arpV2.questions.get(String(params.id));
    if (!q) return sendError(res, 404, "QUESTION_NOT_FOUND", "question not found", "not_found");
    const parsed = z.object({
      selectedOption: z.string().min(1),
      rationale: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_ANSWER", "invalid question answer payload", "validation");
    const updated: Question = {
      ...q,
      selectedOption: parsed.data.selectedOption,
      rationale: parsed.data.rationale,
      status: "ANSWERED",
      resolvedAt: nowTimestamp(),
    };
    await emitV2({ eventType: "question.answered", aggregateType: "question", aggregateId: q.id, snapshot: updated, correlationId: q.taskId });
    arpV2.questions.set(q.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/questions/:id/dismiss", async (_req, res, params) => {
    const q = arpV2.questions.get(String(params.id));
    if (!q) return sendError(res, 404, "QUESTION_NOT_FOUND", "question not found", "not_found");
    const updated: Question = { ...q, status: "DISMISSED", resolvedAt: nowTimestamp() };
    await emitV2({ eventType: "question.dismissed", aggregateType: "question", aggregateId: q.id, snapshot: updated, correlationId: q.taskId });
    arpV2.questions.set(q.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  // ────────────────────────── /v2/decisions ─────────────────────────────────
  route("POST", "/v2/decisions", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      statement: z.string().min(1),
      rationale: z.string().min(1),
      provenance: z.string().min(1),
      questionId: z.string().nullable().default(null),
      alternativesConsidered: z.array(z.string()).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_DECISION", "invalid decision payload", "validation");
    const d: Decision = {
      id: uuid(),
      taskId: parsed.data.taskId,
      questionId: parsed.data.questionId,
      statement: parsed.data.statement,
      alternativesConsidered: parsed.data.alternativesConsidered,
      rationale: parsed.data.rationale,
      provenance: parsed.data.provenance,
      recordedAt: nowTimestamp(),
    };
    await emitV2({ eventType: "decision.recorded", aggregateType: "decision", aggregateId: d.id, snapshot: d, correlationId: d.taskId });
    arpV2.decisions.set(d.id, d);
    sendJson(res, 201, jsonSafe(d));
  }),
  // ────────────────────────── /v2/risks ─────────────────────────────────────
  route("POST", "/v2/risks", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      riskClass: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]),
      statement: z.string().min(1),
      mitigation: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_RISK", "invalid risk payload", "validation");
    const r: Risk = {
      id: uuid(),
      taskId: parsed.data.taskId,
      riskClass: parsed.data.riskClass,
      statement: parsed.data.statement,
      mitigation: parsed.data.mitigation,
      status: parsed.data.mitigation ? "MITIGATED" : "IDENTIFIED",
      recordedAt: nowTimestamp(),
    };
    await emitV2({ eventType: "risk.recorded", aggregateType: "risk", aggregateId: r.id, snapshot: r, correlationId: r.taskId });
    arpV2.risks.set(r.id, r);
    sendJson(res, 201, jsonSafe(r));
  }),
  route("POST", "/v2/risks/:id/mitigate", async (req, res, params) => {
    const r = arpV2.risks.get(String(params.id));
    if (!r) return sendError(res, 404, "RISK_NOT_FOUND", "risk not found", "not_found");
    const parsed = z.object({ mitigation: z.string().min(1) }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_MITIGATION", "mitigation text is required", "validation");
    const updated: Risk = { ...r, mitigation: parsed.data.mitigation, status: "MITIGATED" };
    await emitV2({ eventType: "risk.mitigated", aggregateType: "risk", aggregateId: r.id, snapshot: updated, correlationId: r.taskId });
    arpV2.risks.set(r.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  // ────────────────────────── /v2/tasks/:id/budget ──────────────────────────
  route("POST", "/v2/tasks/:id/budget/consume", async (req, res, params) => {
    const taskId = String(params.id);
    const task = arpV2.tasks.get(taskId);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", `task ${taskId} not found`, "not_found");
    const body = await jsonBody(req);
    const parsed = V2_ENDPOINTS.ConsumeBudgetV2.request.safeParse({
      ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}),
      id: taskId,
    });
    if (!parsed.success) return sendError(res, 400, "INVALID_BUDGET_CONSUMPTION", "invalid budget consumption delta", "validation");

    const current = arpV2.budgets.get(taskId) ?? {
      taskId,
      consumedCostMicros: 0n,
      consumedComputeSeconds: 0,
      consumedInputTokens: 0n,
      consumedOutputTokens: 0n,
      consumedApprovals: 0,
      lastUpdatedAt: nowTimestamp(),
    };
    const updated: BudgetConsumption = {
      taskId,
      consumedCostMicros: current.consumedCostMicros + BigInt(parsed.data.costMicros),
      consumedComputeSeconds: current.consumedComputeSeconds + parsed.data.computeSeconds,
      consumedInputTokens: current.consumedInputTokens + BigInt(parsed.data.inputTokens),
      consumedOutputTokens: current.consumedOutputTokens + BigInt(parsed.data.outputTokens),
      consumedApprovals: current.consumedApprovals + parsed.data.approvals,
      lastUpdatedAt: nowTimestamp(),
    };

    const costLimit = task.contract.constraints.costMicros;
    if (costLimit > 0n && updated.consumedCostMicros > costLimit) {
      await emitV2({
        eventType: "budget.exhausted",
        aggregateType: "budget",
        aggregateId: taskId,
        snapshot: updated,
        correlationId: taskId,
      });
      arpV2.budgets.set(taskId, updated);
      return sendError(res, 429, "BUDGET_EXHAUSTED", `cost budget exceeded: ${updated.consumedCostMicros} > ${costLimit}`, "rate_limit");
    }

    await emitV2({ eventType: "budget.consumed", aggregateType: "budget", aggregateId: taskId, snapshot: updated, correlationId: taskId });
    arpV2.budgets.set(taskId, updated);
    sendV2Response(res, 200, V2_ENDPOINTS.ConsumeBudgetV2.response, updated);
  }),
  route("GET", "/v2/tasks/:id/budget", async (_req, res, params) => {
    const taskId = String(params.id);
    V2_ENDPOINTS.GetTaskBudgetV2.request.parse({ id: taskId });
    const b = arpV2.budgets.get(taskId) ?? {
      taskId,
      consumedCostMicros: 0n,
      consumedComputeSeconds: 0,
      consumedInputTokens: 0n,
      consumedOutputTokens: 0n,
      consumedApprovals: 0,
      lastUpdatedAt: nowTimestamp(),
    };
    sendV2Response(res, 200, V2_ENDPOINTS.GetTaskBudgetV2.response, b);
  }),
  // ────────────────────────── /v2/models (Phase 8) ──────────────────────────
  route("GET", "/v2/models/profiles", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const parsed = V2_ENDPOINTS.ListModelProfilesV2.request.safeParse({
      ...(url.searchParams.has("adapterRef")
        ? { adapterRef: url.searchParams.get("adapterRef") }
        : {}),
      ...(url.searchParams.has("confidentiality")
        ? { confidentiality: url.searchParams.get("confidentiality") }
        : {}),
    });
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_PROFILE_FILTER", "invalid model profile filter", "validation");
    }

    let profiles = profileRegistry.listAll();
    const adapterRef = parsed.data?.adapterRef;
    if (adapterRef) {
      profiles = profiles.filter((profile) => profile.adapterRef === adapterRef);
    }
    const confidentiality = parsed.data?.confidentiality;
    if (confidentiality) {
      profiles = profiles.filter((profile) =>
        profile.allowedConfidentiality.includes(confidentiality),
      );
    }
    sendV2Response(res, 200, V2_ENDPOINTS.ListModelProfilesV2.response, { profiles });
  }),
  route("GET", "/v2/models/profiles/:id", async (_req, res, params) => {
    const profile = profileRegistry.getById(String(params.id));
    if (!profile) {
      return sendError(res, 404, "PROFILE_NOT_FOUND", `model profile ${params.id} not found`, "not_found");
    }
    sendV2Response(res, 200, V2_ENDPOINTS.GetModelProfileV2.response, profile);
  }),
  route("POST", "/v2/models/route", async (req, res) => {
    const parsed = V2_ENDPOINTS.RouteModelStageV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_ROUTE_REQUEST", `invalid route request: ${parsed.error.message}`, "validation");
    }
    const decision = stageRouter.route({
      stage: parsed.data.stage,
      confidentiality: parsed.data.confidentiality,
      requireOffline: parsed.data.requireOffline,
      ...(parsed.data.allowedAdapterRefs === undefined
        ? {}
        : { allowedAdapterRefs: parsed.data.allowedAdapterRefs }),
      ...(parsed.data.implementerModelFamilyRef === undefined
        ? {}
        : { implementerModelFamilyRef: parsed.data.implementerModelFamilyRef }),
    });
    sendV2Response(res, 200, V2_ENDPOINTS.RouteModelStageV2.response, decision);
  }),
  route("POST", "/v2/models/posterior/update", async (req, res) => {
    const parsed = V2_ENDPOINTS.UpdateModelPosteriorV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_OBSERVATION", `invalid observation: ${parsed.error.message}`, "validation");
    }
    const updated = posteriorTracker.recordObservation({
      ...parsed.data,
      costMicros: BigInt(parsed.data.costMicros),
    });
    sendV2Response(res, 200, V2_ENDPOINTS.UpdateModelPosteriorV2.response, updated);
  }),
  route("GET", "/v2/models/posterior/:modelKey", async (_req, res, params) => {
    const post = posteriorTracker.getOrCreate(String(params.modelKey));
    sendV2Response(res, 200, V2_ENDPOINTS.GetModelPosteriorV2.response, post);
  }),
  // ────────────────────────── /v2/orchestration (Phase 8) ───────────────────
  route("POST", "/v2/orchestration/ev-schedule", async (req, res) => {
    const parsed = z.object({
      parentTaskId: z.string().min(1),
      delegationId: z.string().min(1),
      reservationId: z.string().min(1),
      candidateObjective: z.string().min(1),
      separability: z.number().min(0).max(1),
      likelyFileOverlap: z.number().min(0).max(1),
      isWriteWork: z.boolean(),
      currentUncertainty: z.number().min(0).max(1),
      contextPressure: z.number().min(0).max(1),
      riskClass: z.enum(["low", "medium", "high", "critical"]),
      budgetRemainingRatio: z.number().min(0).max(1),
      activeWorkerCount: z.number().int().nonnegative(),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_SCHEDULE_REQUEST", `invalid EV schedule request: ${parsed.error.message}`, "validation");
    }
    const decision = evScheduler.evaluate({
      ...parsed.data,
      riskClass: parsed.data.riskClass === "medium" ? "normal" : parsed.data.riskClass,
    });
    sendJson(res, 200, jsonSafe(decision));
  }),
  route("POST", "/v2/orchestration/stagnation/check", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      observations: z.array(z.object({
        turnIndex: z.number().int().nonnegative(),
        toolName: z.string(),
        toolArguments: z.string(),
        resultStatus: z.enum(["success", "error", "failed"]),
        readPath: z.string().optional(),
        readContentHash: z.string().optional(),
        patchPath: z.string().optional(),
        isRevert: z.boolean().optional(),
        diagnosticCount: z.number().int().nonnegative().optional(),
        strategyLabel: z.string().optional(),
        newEvidenceGathered: z.boolean().optional(),
        contextTokens: z.number().int().nonnegative().optional(),
        taskLedgerMilestoneReached: z.boolean().optional(),
        budgetBurnRatio: z.number().min(0).max(1),
        confidenceScore: z.number().min(0).max(1).optional(),
      })).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_STAGNATION_CHECK", `invalid stagnation check: ${parsed.error.message}`, "validation");
    }
    for (const obs of parsed.data.observations) {
      stagnationSupervisor.observe(
        obs as Parameters<StagnationSupervisor["observe"]>[0],
      );
    }
    const report = stagnationSupervisor.evaluate(parsed.data.taskId);
    sendJson(res, 200, jsonSafe(report));
  }),
  route("POST", "/v2/orchestration/review/clean", async (req, res) => {
    const parsed = V2_ENDPOINTS.EvaluateCleanReviewV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_CLEAN_REVIEW", `invalid clean review request: ${parsed.error.message}`, "validation");
    }
    const report = cleanReviewer.evaluateFindings(
      parsed.data.taskId,
      parsed.data.reviewerModelFamilyRef,
      parsed.data.implementerModelFamilyRef,
      parsed.data.findings.map((finding) => ({
        id: finding.id,
        path: finding.path,
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        ...(finding.line === undefined ? {} : { line: finding.line }),
        ...(finding.proposedRemediation === undefined
          ? {}
          : { proposedRemediation: finding.proposedRemediation }),
      })),
    );
    sendV2Response(res, 200, V2_ENDPOINTS.EvaluateCleanReviewV2.response, report);
  }),
  // ────────────────────────── Phase 9: Cockpit, Attention & Interventions ──────
  route("GET", "/v2/organizations", async (_req, res) => {
    sendJson(res, 200, jsonSafe({ organizations: orgDirectory.listOrganizations() }));
  }),
  route("GET", "/v2/departments", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const orgId = url.searchParams.get("organizationId") ?? undefined;
    sendJson(res, 200, jsonSafe({ departments: orgDirectory.listDepartments(orgId) }));
  }),
  route("GET", "/v2/operators", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const deptId = url.searchParams.get("departmentId") ?? undefined;
    sendJson(res, 200, jsonSafe({ operators: orgDirectory.listOperators(deptId) }));
  }),
  route("GET", "/v2/agent-rooms", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const deptId = url.searchParams.get("departmentId") ?? undefined;
    sendJson(res, 200, jsonSafe({ rooms: orgDirectory.listRooms(deptId) }));
  }),
  route("GET", "/v2/capabilities/directory", async (_req, res) => {
    sendJson(res, 200, jsonSafe({ capabilities: orgDirectory.listCapabilities() }));
  }),
  route("POST", "/v2/capabilities/resolve", async (req, res) => {
    const parsed = z.object({
      capabilityId: z.string().min(1),
      category: z.string().optional(),
      resourceDomain: z.string().optional(),
      requiredAuthority: z.array(z.string()).optional(),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_CAPABILITY_REQUEST", `invalid capability request: ${parsed.error.message}`, "validation");
    }
    const result = orgDirectory.resolveCapability({
      capabilityId: parsed.data.capabilityId,
      ...(parsed.data.category === undefined ? {} : { category: parsed.data.category }),
      ...(parsed.data.resourceDomain === undefined
        ? {}
        : { resourceDomain: parsed.data.resourceDomain }),
      ...(parsed.data.requiredAuthority === undefined
        ? {}
        : { requiredAuthority: parsed.data.requiredAuthority }),
    });
    sendJson(res, 200, jsonSafe(result));
  }),
  route("GET", "/v2/attention/assess/:taskId", async (_req, res, params) => {
    const assessment = attentionCoordinator.assessTaskAttention(String(params.taskId));
    sendJson(res, 200, jsonSafe(assessment));
  }),
  route("GET", "/v2/attention/questions", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const taskId = url.searchParams.get("taskId") ?? undefined;
    sendJson(res, 200, jsonSafe({ questions: attentionCoordinator.listPendingQuestions(taskId) }));
  }),
  route("POST", "/v2/attention/questions", async (req, res) => {
    const parsed = V2_ENDPOINTS.AskMaterialQuestionV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_MATERIAL_QUESTION", `invalid question: ${parsed.error.message}`, "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted attention-materiality assessor is configured; the question was not queued",
      "external_dependency",
      { taskId: parsed.data.taskId, trigger: parsed.data.trigger },
    );
  }),
  route("POST", "/v2/attention/questions/:id/resolve", async (req, res, params) => {
    const parsed = z.object({
      selectedOption: z.string().min(1),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_RESOLVE_REQUEST", `invalid resolve payload: ${parsed.error.message}`, "validation");
    }
    const result = attentionCoordinator.resolveQuestion(String(params.id), parsed.data.selectedOption);
    sendJson(res, 200, jsonSafe(result));
  }),
  route("POST", "/v2/interventions", async (req, res) => {
    const parsed = V2_ENDPOINTS.ProposeInterventionV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_INTERVENTION", `invalid intervention payload: ${parsed.error.message}`, "validation");
    }
    const intv = interventionManager.proposeIntervention({
      taskId: parsed.data.taskId,
      actorPrincipal: SERVER_PRINCIPAL,
      verb: parsed.data.verb,
      payload: parsed.data.payload,
      rationale: parsed.data.rationale,
      ...(parsed.data.attemptId === undefined ? {} : { attemptId: parsed.data.attemptId }),
      ...(parsed.data.targetEntityId === undefined
        ? {}
        : { targetEntityId: parsed.data.targetEntityId }),
    });
    sendV2Response(res, 200, V2_ENDPOINTS.ProposeInterventionV2.response, intv);
  }),
  route("POST", "/v2/interventions/:id/apply", async (_req, res, params) => {
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "No kernel-backed intervention executor is configured; the proposal was not applied",
      "sandbox_unavailable",
      { interventionId: String(params.id), supportLevel: "coordinator_only" },
    );
  }),
  route("GET", "/v2/interventions", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const taskId = url.searchParams.get("taskId") ?? undefined;
    sendJson(res, 200, jsonSafe({ interventions: interventionManager.listInterventions(taskId) }));
  }),
  route("POST", "/v2/replay/traces", async (req, res) => {
    const input = V2_ENDPOINTS.CreateCausalTraceV2.request.parse(await jsonBody(req));
    const trace = causalReplayEngine.createTrace(
      input.taskId,
      input.attemptId,
      input.pinnedInputsHash,
    );
    sendV2Response(res, 201, V2_ENDPOINTS.CreateCausalTraceV2.response, trace);
  }),
  route("GET", "/v2/replay/traces/:taskId", async (_req, res, params) => {
    const trace = causalReplayEngine.getTraceForTask(String(params.taskId));
    sendV2Response(res, 200, V2_ENDPOINTS.GetCausalTraceV2.response, trace);
  }),
  route("POST", "/v2/replay/steps", async (req, res) => {
    const parsed = V2_ENDPOINTS.RecordCausalStepV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_REPLAY_STEP", `invalid replay step: ${parsed.error.message}`, "validation");
    }
    const updated = causalReplayEngine.recordStep(parsed.data.traceId, parsed.data.step);
    sendV2Response(res, 200, V2_ENDPOINTS.RecordCausalStepV2.response, updated);
  }),
  route("POST", "/v2/replay/traces/:traceId/diagnose", async (req, res, params) => {
    const input = V2_ENDPOINTS.DiagnoseCausalOmissionsV2.request.parse(await jsonBody(req));
    if (input.traceId !== params.traceId) {
      return sendError(res, 400, "VALIDATION_FAILED", "Causal trace path and body identities differ", "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No evidence-producing omission evaluator is configured; no causal diagnostic was recorded",
      "external_dependency",
      { traceId: input.traceId, failureStepIndex: input.failureStepIndex },
    );
  }),
  route("POST", "/v2/replay/counterfactual", async (req, res) => {
    const parsed = V2_ENDPOINTS.RunCounterfactualV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_COUNTERFACTUAL", `invalid counterfactual payload: ${parsed.error.message}`, "validation");
    }
    const exp = causalReplayEngine.runCounterfactual(
      parsed.data.sourceTaskId,
      parsed.data.variationType,
      parsed.data.variationDetails,
    );
    sendV2Response(res, 200, V2_ENDPOINTS.RunCounterfactualV2.response, exp);
  }),
  route("GET", "/v2/mobile/sessions/:taskId", async (_req, res, params) => {
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No mobile supervision gateway is configured",
      "external_dependency",
      { taskId: params.taskId, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/mobile/sessions/:taskId/action", async (req, res, params) => {
    const parsed = z.object({
      action: z.enum(["pause", "resume", "approve_effect", "terminate", "request_review"]),
      effectId: z.string().optional(),
      rationale: z.string().optional(),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_MOBILE_ACTION", `invalid mobile action: ${parsed.error.message}`, "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No mobile supervision gateway is configured; the action was not applied",
      "external_dependency",
      { taskId: params.taskId, action: parsed.data.action, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/ide/context-sync", async (req, res) => {
    const parsed = V2_ENDPOINTS.SyncAcpContextV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_IDE_CONTEXT", `invalid IDE context payload: ${parsed.error.message}`, "validation");
    }
    const contextHash = computeContentHash(canonicalJson(parsed.data));
    acpContextSyncs.set(contextHash, parsed.data);
    sendV2Response(res, 200, V2_ENDPOINTS.SyncAcpContextV2.response, {
      synced: true,
      contextHash,
      receivedDiagnostics: parsed.data.diagnostics.length,
      durability: "process_local",
    });
  }),
  // ────────────────────────── Phase 10: Computer Use & Agency ─────────────────
  // These routes expose pure/process-local coordinators. They never claim a
  // browser, desktop, clipboard, filesystem, or network effect without a
  // trusted backend receipt.
  route("POST", "/v2/computer/observe", async (req, res) => {
    const input = V2_ENDPOINTS.CreateUiObservationV2.request.parse(await jsonBody(req));
    if (governedComputerUseCoordinator !== null) {
      return sendError(
        res,
        503,
        "EXTERNAL_DEPENDENCY_FAILED",
        "A trusted computer-use coordinator is configured, but no observation store adapter is exposed",
        "external_dependency",
        { taskId: input.taskId, supportLevel: "coordinator_only" },
      );
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted UI observation receipt verifier is configured; the referenced observation was not admitted",
      "external_dependency",
      {
        taskId: input.taskId,
        sourceAdapterRef: input.receipt.sourceAdapterRef,
        receiptArtifactUri: input.receipt.receiptArtifactRef.uri,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("GET", "/v2/computer/observations/:id", async (_req, res, params) => {
    const { id } = V2_ENDPOINTS.GetUiObservationV2.request.parse({ id: params.id });
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted UI observation store is configured",
      "external_dependency",
      { observationId: id, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/computer/verify-target", async (req, res) => {
    const input = V2_ENDPOINTS.VerifyUiTargetV2.request.parse(await jsonBody(req));
    if (governedComputerUseCoordinator !== null) {
      return sendError(
        res,
        503,
        "EXTERNAL_DEPENDENCY_FAILED",
        "Semantic target verification requires an adapter-owned trusted observation store",
        "external_dependency",
        { observationId: input.observationId, actionId: input.action.actionId },
      );
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Semantic target verification requires an admitted trusted observation; no observation verifier is configured",
      "external_dependency",
      { observationId: input.observationId, actionId: input.action.actionId },
    );
  }),
  route("POST", "/v2/computer/action", async (req, res) => {
    const input = V2_ENDPOINTS.DispatchComputerActionV2.request.parse(await jsonBody(req));
    if (governedComputerUseCoordinator !== null) {
      return sendError(
        res,
        503,
        "SANDBOX_UNAVAILABLE",
        "A trusted coordinator is configured, but no kernel-backed computer-use dispatcher is exposed",
        "sandbox_unavailable",
        { actionId: input.action.actionId, observationId: input.observationId, supportLevel: "coordinator_only" },
      );
    }
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "No trusted observation verifier or kernel-backed computer-use dispatcher is configured; no input was dispatched",
      "sandbox_unavailable",
      {
        actionId: input.action.actionId,
        observationId: input.observationId,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("POST", "/v2/computer/evidence", async (req, res) => {
    const input = V2_ENDPOINTS.RecordUiEvidenceV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted computer-use receipt verifier is configured; caller-authored UI evidence was not admitted",
      "external_dependency",
      {
        actionId: input.actionId,
        taskId: input.taskId,
        receiptArtifactUri: input.receipt.receiptArtifactRef.uri,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("GET", "/v2/computer/pools", async (_req, res) => {
    V2_ENDPOINTS.ListComputerPoolsV2.request.parse({});
    sendV2Response(res, 200, V2_ENDPOINTS.ListComputerPoolsV2.response, poolManager.listPools());
  }),
  route("POST", "/v2/computer/pools/:poolId/lease", async (req, res, params) => {
    const input = V2_ENDPOINTS.AcquirePoolLeaseV2.request.parse(await jsonBody(req));
    if (input.poolId !== params.poolId) {
      return sendError(res, 400, "VALIDATION_FAILED", "Pool path and body identities differ", "validation");
    }
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "No kernel-backed browser or desktop pool lease backend is configured; no lease was acquired",
      "sandbox_unavailable",
      { poolId: input.poolId, taskId: input.taskId, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/computer/pools/:poolId/leases/:leaseId/release", async (req, res, params) => {
    const input = V2_ENDPOINTS.ReleasePoolLeaseV2.request.parse(await jsonBody(req));
    if (input.poolId !== params.poolId || input.leaseId !== params.leaseId) {
      return sendError(res, 400, "VALIDATION_FAILED", "Pool lease path and body identities differ", "validation");
    }
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "No kernel-backed browser or desktop pool lease backend is configured; no lease was released",
      "sandbox_unavailable",
      { poolId: input.poolId, leaseId: input.leaseId, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/computer/takeover", async (req, res) => {
    const input = V2_ENDPOINTS.InitiateHumanTakeoverV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "Human takeover requires a kernel-backed input-control handoff and a trusted observation; neither backend is configured",
      "sandbox_unavailable",
      { taskId: input.taskId, poolId: input.poolId, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/computer/takeover/:takeoverId/resume", async (req, res, params) => {
    const input = V2_ENDPOINTS.ResumeFromTakeoverV2.request.parse(await jsonBody(req));
    if (input.takeoverId !== params.takeoverId) {
      return sendError(res, 400, "VALIDATION_FAILED", "Takeover path and body identities differ", "validation");
    }
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "Autonomous resume requires a kernel-backed input-control handoff and a newly admitted trusted observation",
      "sandbox_unavailable",
      {
        takeoverId: input.takeoverId,
        observationId: input.newObservationId,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("POST", "/v2/data-flow/evaluate", async (req, res) => {
    const input = V2_ENDPOINTS.EvaluateDataFlowV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No kernel DLP receipt verifier is configured; the data-flow decision was not admitted and the payload handle was not dereferenced",
      "external_dependency",
      {
        taskId: input.taskId,
        policyId: input.policyId,
        direction: input.direction,
        payloadHandleId: input.payloadHandle.objectId,
        dlpReceiptArtifactUri: input.dlpReceiptArtifactRef.uri,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("POST", "/v2/data-flow/quarantine", async (req, res) => {
    const input = V2_ENDPOINTS.QuarantineDownloadV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "No kernel download quarantine backend is configured; no file was moved",
      "sandbox_unavailable",
      { taskId: input.taskId, fileName: input.fileName, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/computer/reconcile-submit", async (req, res) => {
    const input = V2_ENDPOINTS.ReconcileSubmitV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted settlement-probe verifier is configured; the ambiguous submit remains unresolved and must not be retried",
      "external_dependency",
      {
        effectId: input.effectId,
        previousObservationId: input.previousObservationId,
        postTimeoutObservationId: input.postTimeoutObservationId,
        settlementProbeReceiptArtifactUri: input.settlementProbeReceiptArtifactRef.uri,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("GET", "/v2/connectors", async (_req, res) => {
    V2_ENDPOINTS.ListConnectorsV2.request.parse({});
    sendV2Response(res, 200, V2_ENDPOINTS.ListConnectorsV2.response, connectorLibrary.listConnectors());
  }),
  route("POST", "/v2/connectors/:connectorId/call", async (req, res, params) => {
    const input = V2_ENDPOINTS.ExecuteConnectorCallV2.request.parse(await jsonBody(req));
    if (input.connectorId !== params.connectorId) {
      return sendError(res, 400, "VALIDATION_FAILED", "Connector path and body identities differ", "validation");
    }
    const result = await connectorLibrary.executeCall(input);
    sendV2Response(res, 200, V2_ENDPOINTS.ExecuteConnectorCallV2.response, result);
  }),
  route("POST", "/v2/profiles/incident/start", async (req, res) => {
    const input = V2_ENDPOINTS.StartIncidentTaskV2.request.parse(await jsonBody(req));
    const record = incidentRunner.startIncident(input.profileId, input.taskId, input.initialDiagnostics);
    sendV2Response(res, 201, V2_ENDPOINTS.StartIncidentTaskV2.response, record);
  }),
  route("POST", "/v2/profiles/research/start", async (req, res) => {
    const input = V2_ENDPOINTS.StartResearchTaskV2.request.parse(await jsonBody(req));
    const record = researchRunner.startResearch(input.profileId, input.taskId);
    sendV2Response(res, 201, V2_ENDPOINTS.StartResearchTaskV2.response, record);
  }),
  route("GET", "/v2/events", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const cursor = eventCursorFromRequest(req, url.searchParams.get("cursor"));
    const taskId = url.searchParams.get("taskId");
    const aggregateType = url.searchParams.get("aggregateType");

    const filter = (ev: StoredEvent) => {
      if (ev.schemaVersion !== 2) return false;
      if (aggregateType && ev.aggregateType !== aggregateType) return false;
      if (taskId) {
        return ev.aggregateId === taskId
          || ev.correlationId === taskId
          || (ev.payloadJson.includes(taskId) && ev.aggregateType !== "evidence");
      }
      return true;
    };

    await serveEventStream(req, res, {
      streamName: taskId ? `v2:task:${taskId}` : aggregateType ? `v2:aggregate:${aggregateType}` : "v2:global",
      cursor,
      filter,
      eventFrame: (event) => `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${JSON.stringify(storedEventToEnvelopeV2(event))}\n\n`,
      cursorExpiredFrame: ({ requestedCursor, oldestRetainedEventId }) => `id: ${oldestRetainedEventId}\nevent: cursor_expired\ndata: ${JSON.stringify({
        type: "cursor_expired",
        cursor: requestedCursor,
        oldestRetainedEventId,
        snapshotUrl: taskId ? `/v2/tasks/${taskId}` : "/v2/tasks",
      })}\n\n`,
    });
  }),
];

/** JSON.parse with a fallback so a corrupt stored value never crashes the API. */
function safeParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

function metricDecimal(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function trustedProviderAttemptCost(input: {
  readonly costMicros: number | null;
  readonly providerReportedCostMicros: bigint | null;
  readonly computedCostMicros: bigint | null;
  readonly costSource: string | null;
}): string | null {
  if (input.costSource === "provider_reported") {
    return metricDecimal(input.providerReportedCostMicros);
  }
  if (input.costSource === "free_model_contract") {
    return metricDecimal(input.computedCostMicros);
  }
  // The legacy field has no provenance and may contain the historical zero
  // sentinel. It is intentionally excluded from trusted metrics.
  void input.costMicros;
  return null;
}

/** Read only a bounded, normalized terminal reason for repair metrics. */
function metricTerminalReason(text: string | null): string | null {
  if (text === null) return null;
  const parsed = safeParse<unknown>(text, null);
  if (typeof parsed === "string") return parsed;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  for (const key of ["repair_stop_reason", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function requiredVerificationPassed(input: {
  readonly nodes: readonly { readonly id: string; readonly required: boolean }[];
  readonly results: readonly { readonly nodeId: string; readonly attempt: number; readonly status: string }[];
}): boolean {
  const latest = new Map<string, { readonly attempt: number; readonly status: string }>();
  for (const result of input.results) {
    const prior = latest.get(result.nodeId);
    if (prior === undefined || result.attempt > prior.attempt) {
      latest.set(result.nodeId, result);
    }
  }
  return input.nodes
    .filter((node) => node.required)
    .every((node) => latest.get(node.id)?.status === "pass");
}

function taskContractWire(row: {
  readonly version: number;
  readonly contentHash: string;
  readonly objective: string;
  readonly nonGoalsJson: string;
  readonly allowedScopeJson: string;
  readonly acceptanceCriteria?: readonly {
    readonly criterionId: string;
    readonly statement: string;
    readonly verificationHint: string | null;
    readonly required: boolean;
    readonly status: string;
  }[] | undefined;
} | null | undefined): {
  readonly version: number;
  readonly content_hash: string;
  readonly objective: string;
  readonly non_goals: readonly string[];
  readonly acceptance_criteria: readonly {
    readonly id: string;
    readonly statement: string;
    readonly verification_hint: string | null;
    readonly required: boolean;
    readonly status: string;
  }[];
  readonly allowed_scope: {
    readonly read_paths: readonly string[];
    readonly write_paths: readonly string[];
    readonly external_systems: readonly string[];
  };
} | null {
  if (!row) return null;
  const parsedScope = safeParse<unknown>(row.allowedScopeJson, {});
  const scope = parsedScope !== null && typeof parsedScope === "object" && !Array.isArray(parsedScope)
    ? parsedScope as Record<string, unknown>
    : {};
  return {
    version: row.version,
    content_hash: row.contentHash,
    objective: row.objective,
    non_goals: readStringArray(safeParse<unknown>(row.nonGoalsJson, [])),
    // The criteria a run is graded against, as written. They were stored on
    // every contract version and projected nowhere, so an evaluation harness
    // had to re-read them from the task fixture on disk and hope the two
    // agreed.
    acceptance_criteria: (row.acceptanceCriteria ?? []).map((criterion) => ({
      id: criterion.criterionId,
      statement: criterion.statement,
      verification_hint: criterion.verificationHint,
      required: criterion.required,
      status: criterion.status,
    })),
    allowed_scope: {
      read_paths: readStringArray(scope.read_paths),
      write_paths: readStringArray(scope.write_paths),
      external_systems: readStringArray(scope.external_systems),
    },
  };
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function persistedTaskContract(
  task: {
    readonly id: string;
    readonly riskClass: string;
    readonly budgetJson: string;
  },
  contract: {
    readonly version: number;
    readonly objective: string;
    readonly userOutcome: string | null;
    readonly nonGoalsJson: string;
    readonly constraintsJson: string;
    readonly assumptionsJson: string;
    readonly unknownsJson: string;
    readonly allowedScopeJson: string;
    readonly changePolicyJson: string;
  },
  criteria: readonly {
    readonly criterionId: string;
    readonly statement: string;
    readonly verificationHint: string | null;
    readonly required: boolean;
  }[],
): TaskSnapshot["contract"] {
  const budget = safeParse<Record<string, unknown>>(task.budgetJson, {});
  const rawScope = safeParse<Record<string, unknown>>(contract.allowedScopeJson, {});
  return {
    id: task.id as TaskSnapshot["contract"]["id"],
    version: contract.version,
    objective: contract.objective,
    userOutcome: contract.userOutcome,
    nonGoals: safeParse<string[]>(contract.nonGoalsJson, []),
    acceptanceCriteria: criteria.map((criterion) => ({
      id: criterion.criterionId,
      statement: criterion.statement,
      verificationHint: criterion.verificationHint,
      required: criterion.required,
    })),
    constraints: safeParse<string[]>(contract.constraintsJson, []),
    assumptions: safeParse<string[]>(contract.assumptionsJson, []),
    unknowns: safeParse<string[]>(contract.unknownsJson, []),
    allowedScope: {
      readPaths: readStringArray(rawScope.read_paths ?? rawScope.readPaths),
      writePaths: readStringArray(rawScope.write_paths ?? rawScope.writePaths),
      externalSystems: readStringArray(rawScope.external_systems ?? rawScope.externalSystems),
    },
    riskClass: normalizeRiskClass(task.riskClass),
    budget: {
      modelMicros: BigInt(String(budget.model_micros ?? 5_000_000)) as Micros,
      computeSeconds: numberOr(budget.compute_seconds, 600),
      wallClockSeconds: numberOr(budget.wall_clock_seconds, 3_600),
      humanApprovals: numberOr(budget.human_approvals, 20),
    },
    changePolicy: safeParse(contract.changePolicyJson, {
      mayExpandScope: false,
      scopeExpansionRequiresUser: true,
    }),
  };
}

function checkpointRequirementStatus(
  status: string,
): CheckpointContent["requirements"][number]["status"] {
  if (status === "satisfied" || status === "passed" || status === "verified") return "satisfied";
  if (status === "unsatisfied" || status === "failed") return "unsatisfied";
  return "unverified";
}

interface CheckpointAdmissionRecoveryResult {
  readonly prepared: number;
  readonly recovered: readonly string[];
  readonly deferred: readonly string[];
  readonly quarantined: readonly string[];
  readonly failed: readonly { id: string; error: string }[];
}

interface PreparedCheckpointAdmissionRow {
  readonly id: string;
  readonly taskId: string | null;
  readonly checkpointArtifact: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly lastCommittedSequencesJson: string;
  readonly createdAt: Date;
}

interface CheckpointPublication {
  readonly id: string;
  readonly threadId: string;
  readonly taskId: string;
  readonly artifactHash: ContentHash;
}

async function commitCheckpointPublication(publication: CheckpointPublication): Promise<void> {
  const existingEvent = await db.semanticEvent.findFirst({
    where: {
      eventType: "checkpoint.created",
      aggregateType: "checkpoint",
      aggregateId: publication.id,
    },
    select: { eventId: true },
  });
  if (existingEvent) {
    const committed = await writerTransaction((tx) => tx.checkpoint.updateMany({
      where: { id: publication.id, admissionState: "PREPARED" },
      data: { admissionState: "COMMITTED" },
    }));
    if (committed.count !== 1) {
      throw new Error(`checkpoint ${publication.id} publication state changed during recovery`);
    }
    return;
  }
  await emit({
    eventType: "checkpoint.created",
    aggregateType: "checkpoint",
    aggregateId: publication.id,
    correlationId: publication.taskId,
    payload: {
      thread_id: publication.threadId,
      task_id: publication.taskId,
      artifact_hash: publication.artifactHash,
    },
  }, async (tx) => {
    const committed = await tx.checkpoint.updateMany({
      where: { id: publication.id, admissionState: "PREPARED" },
      data: { admissionState: "COMMITTED" },
    });
    if (committed.count !== 1) {
      throw new Error(`checkpoint ${publication.id} admission changed before atomic publication`);
    }
  });
}

interface TerminalTurnPublication extends CheckpointPublication {
  readonly turnId: string;
  readonly responseArtifactUri: string;
  readonly summary: string;
  readonly summaryTruncated: boolean;
  /** The provider's own reasoning for this turn, when it returned any. */
  readonly reasoning?: string | null;
  readonly continuation: string | null;
  readonly recovered?: boolean;
}

/**
 * Commit the successful automatic checkpoint and terminal turn event in one
 * writer transaction. Artifact bytes were retained before this point; the
 * transaction only admits the already-prepared checkpoint and terminal row.
 */
async function commitCheckpointAndTerminalTurn(
  publication: TerminalTurnPublication,
): Promise<void> {
  await emitAtomicBatch(
    [
      {
        eventType: "checkpoint.created",
        aggregateType: "checkpoint",
        aggregateId: publication.id,
        correlationId: publication.taskId,
        idempotencyKey: `checkpoint-publication:${publication.id}`,
        payload: {
          thread_id: publication.threadId,
          task_id: publication.taskId,
          artifact_hash: publication.artifactHash,
        },
      },
      {
        eventType: "context.auto_checkpoint_committed",
        aggregateType: "turn",
        aggregateId: publication.turnId,
        correlationId: publication.taskId,
        idempotencyKey: `auto-checkpoint:${publication.turnId}`,
        payload: { checkpoint_id: publication.id },
      },
      {
        eventType: "turn.completed",
        aggregateType: "turn",
        aggregateId: publication.turnId,
        correlationId: publication.taskId,
        idempotencyKey: `turn-completed:${publication.turnId}`,
        payload: {
          state: "COMPLETED",
          summary: publication.summary,
          summary_truncated: publication.summaryTruncated,
          continuation: publication.continuation,
          ...(publication.reasoning ? { reasoning: publication.reasoning } : {}),
          ...(publication.recovered === true ? { recovered: true } : {}),
        },
        artifactRefs: [publication.responseArtifactUri],
      },
    ],
    async (tx) => {
      const checkpoint = await tx.checkpoint.updateMany({
        where: { id: publication.id, admissionState: "PREPARED" },
        data: { admissionState: "COMMITTED" },
      });
      if (checkpoint.count !== 1) {
        throw new Error(`checkpoint ${publication.id} changed before terminal publication`);
      }
      const turn = await tx.turn.updateMany({
        where: { id: publication.turnId, state: "FINALIZING" },
        data: { state: "COMPLETED", completedAt: new Date() },
      });
      if (turn.count !== 1) {
        throw new Error(`turn ${publication.turnId} changed before terminal publication`);
      }
    },
  );
}

/**
 * R5: load bounded prior-turn history for a thread. Returns null when there
 * is no previous COMPLETED turn. The assistant excerpt comes from the durable
 * turn.completed event's response artifact; the user excerpt from the turn's
 * initiating input artifact.
 */
async function loadPriorTurnHistory(
  threadId: string,
  currentSequence: number,
  artifacts: ArtifactClient,
  limits: RecentHistoryLimits = {
    userMaxChars: USER_EXCERPT_MAX_CHARS,
    assistantMaxChars: ASSISTANT_EXCERPT_MAX_CHARS,
  },
): Promise<RecentHistorySection | null> {
  if (currentSequence <= 1) return null;
  const prior = await db.turn.findFirst({
    where: { threadId, sequence: currentSequence - 1, state: "COMPLETED" },
    orderBy: { sequence: "desc" },
    select: { id: true, sequence: true, initiatingInputArtifact: true, completedAt: true },
  });
  if (prior === null) return null;
  const decodeBounded = async (artifactUri: string | null | undefined, maxChars: number): Promise<string> => {
    if (!artifactUri || !artifactUri.startsWith("artifact://sha256/")) return "";
    try {
      const bytes = await artifacts.get(`sha256:${artifactUri.slice("artifact://sha256/".length)}` as ContentHash);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      return excerpt(text, maxChars);
    } catch {
      // History is best-effort context; an unreadable artifact degrades to "".
      return "";
    }
  };
  let assistantText = "";
  try {
    const completedEvent = await db.semanticEvent.findFirst({
      where: { eventType: "turn.completed", aggregateType: "turn", aggregateId: prior.id },
      orderBy: { occurredAt: "desc" },
      select: { payloadJson: true },
    });
    if (completedEvent !== null) {
      const payload = safeParse<Record<string, unknown>>(completedEvent.payloadJson, {});
      const summary = typeof payload.summary === "string" ? payload.summary : "";
      const continuation = typeof payload.continuation === "string" ? payload.continuation : null;
      const fullText = continuation !== null
        ? await decodeBounded(continuation, limits.assistantMaxChars)
        : summary;
      assistantText = fullText.length > 0 ? fullText : excerpt(summary, limits.assistantMaxChars);
    }
  } catch {
    assistantText = "";
  }
  const userText = await decodeBounded(prior.initiatingInputArtifact, limits.userMaxChars);
  if (userText.length === 0 && assistantText.length === 0) return null;
  return buildRecentHistorySection({
    sequence: prior.sequence,
    userText,
    assistantText,
    completedAt: prior.completedAt?.toISOString() ?? null,
  }, limits);
}

/**
 * R5: prepare the automatic end-of-turn checkpoint. Reuses the authoritative
 * checkpoint schema so the existing latest-COMMITTED-checkpoint load path
 * carries task decisions across turns without manual /checkpoints calls.
 * Publication is completed by the terminal-turn transaction below so a
 * successful checkpoint and `turn.completed` cannot diverge.
 */
async function prepareTurnCheckpoint(input: {
  readonly taskId: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnSequence: number;
  readonly contract: TaskContract;
  readonly contractContentHash: ContentHash;
  readonly criteriaRows: readonly { criterionId: string; statement: string; required: boolean; status: string }[];
  readonly effectState: CheckpointContent["effectState"];
  readonly terminalErrorJson: string | null;
}): Promise<{ checkpoint: CheckpointPublication } | { skipped: string }> {
  try {
    const requirementState = input.criteriaRows.map((criterion) => ({
      criterion,
      status: checkpointRequirementStatus(criterion.status),
    }));
    const satisfiedCount = requirementState.filter(({ status }) => status === "satisfied").length;
    const contentResult = checkpointContentSchema.safeParse({
      objective: input.contract.objective,
      completedSteps: requirementState
        .filter(({ status }) => status === "satisfied")
        .map(({ criterion }) => ({
          description: criterion.statement,
          evidenceArtifactHashes: [] as readonly ContentHash[],
        })),
      pendingSteps: requirementState
        .filter(({ status }) => status !== "satisfied")
        .map(({ criterion }) => criterion.statement),
      requirements: requirementState.map(({ criterion, status }) => ({
        id: criterion.criterionId,
        statement: criterion.statement,
        status,
        evidence: [],
      })),
      assumptions: [...input.contract.assumptions],
      unknowns: [...input.contract.unknowns],
      decisions: [
        {
          decision: `turn ${input.turnSequence} completed with ${satisfiedCount}/${requirementState.length} acceptance criteria satisfied`,
          rationale: "automatic end-of-turn checkpoint (R5)",
          alternatives: [],
        },
      ],
      failures: input.terminalErrorJson === null
        ? []
        : [{
            description: excerpt(input.terminalErrorJson, 512),
            artifactHash: null,
            resolved: false,
          }],
      openQuestions: [...input.contract.unknowns],
      sourceVersions: {
        [`task://${input.taskId}`]: input.contractContentHash,
        [`turn://${input.turnId}`]: `${input.turnSequence}:COMPLETED`,
      },
      scope: input.contract.allowedScope,
      effectState: input.effectState,
      approvalState: [],
    });
    if (!contentResult.success) {
      return { skipped: `content not representable: ${contentResult.error.issues[0]?.message ?? "unknown"}` };
    }
    const content = contentResult.data;
    const validation = validateCheckpoint(content, input.contract, content.sourceVersions);
    if (!validation.valid) {
      return { skipped: `validation failed: ${validation.violations[0]?.description ?? "unknown"}` };
    }
    const checkpointContext = await kernelContextForTask(
      input.taskId,
      input.turnId,
      [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
    );
    const checkpointArtifacts = createKernelArtifactClient(requireKernelUds().artifacts, {
      ...checkpointContext,
      idempotencyKey: `auto-checkpoint:${input.turnId}`,
    });
    const artifact = await ingestJsonArtifact(
      checkpointArtifacts,
      content,
      "task-checkpoint",
      { sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId },
    );
    const id = uuid();
    const bounds = await db.episode.aggregate({
      where: { turnId: input.turnId },
      _min: { sequence: true },
      _max: { sequence: true },
    });
    const episodeRangeForTurn = {
      from: bounds._min.sequence ?? 0,
      to: bounds._max.sequence ?? 0,
    };
    await writerTransaction((tx) => tx.checkpoint.create({
      data: {
        id,
        sessionId: input.sessionId,
        threadId: input.threadId,
        taskId: input.taskId,
        checkpointArtifact: artifact.uri,
        schemaVersion: 1,
        lastCommittedSequencesJson: canonicalJson(checkpointSequenceStateSchema.parse({
          task: input.contract.version,
          turn: input.turnSequence,
          sourceTurnId: input.turnId,
          episodeRange: episodeRangeForTurn,
        })),
        activeContextEpochId: null,
        promotedInputCursor: null,
        unsettledToolCallsJson: "[]",
        activeJobsJson: "[]",
        workspaceRevision: null,
        dirtyStateDigest: null,
        unsettledEffectsJson: canonicalJson(input.effectState),
        artifactRefsJson: "[]",
        continuationJson: null,
        admissionState: "PREPARED",
      },
    }));
    await checkpointArtifacts.link(artifact.hash, "checkpoint", id, "content");
    return {
      checkpoint: {
        id,
        threadId: input.threadId,
        taskId: input.taskId,
        artifactHash: artifact.hash,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await emit({
        eventType: "context.auto_checkpoint_failed",
        aggregateType: "turn",
        aggregateId: input.turnId,
        correlationId: input.taskId,
        payload: { reason: message.slice(0, 512) },
      });
    } catch {
      // Never let telemetry failure break turn completion.
    }
    return { skipped: message.slice(0, 256) };
  }
}

async function quarantinePreparedCheckpoint(id: string): Promise<void> {
  await writerTransaction((tx) => tx.checkpoint.updateMany({
    where: { id, admissionState: "PREPARED" },
    data: { admissionState: "QUARANTINED" },
  }));
}

async function findPreparedCheckpointForTurn(
  taskId: string,
  turnId: string,
): Promise<CheckpointPublication | null> {
  const rows = await db.checkpoint.findMany({
    where: { taskId, admissionState: "PREPARED" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      taskId: true,
      threadId: true,
      checkpointArtifact: true,
      lastCommittedSequencesJson: true,
    },
  });
  for (const row of rows) {
    const sequenceState = safeParse<Record<string, unknown>>(row.lastCommittedSequencesJson, {});
    if (sequenceState.sourceTurnId !== turnId || row.taskId !== taskId) continue;
    const artifactUri = artifactUriSchema.safeParse(row.checkpointArtifact);
    if (!artifactUri.success) continue;
    return {
      id: row.id,
      taskId,
      threadId: row.threadId,
      artifactHash: contentHashSchema.parse(
        `sha256:${artifactUri.data.slice("artifact://sha256/".length)}`,
      ),
    };
  }
  return null;
}

function isTransientKernelFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = "code" in error ? (error as { readonly code?: unknown }).code : undefined;
  return code === 4 || code === 14;
}

/**
 * Finish checkpoint admissions interrupted after the kernel retained exact
 * bytes but before event publication and row visibility committed atomically.
 */
async function reconcilePreparedCheckpointAdmissions(): Promise<CheckpointAdmissionRecoveryResult> {
  const recovered: string[] = [];
  const deferred: string[] = [];
  const quarantined: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  let prepared = 0;
  let cursor: string | null = null;

  for (;;) {
    const rows: PreparedCheckpointAdmissionRow[] = await db.checkpoint.findMany({
      where: { admissionState: "PREPARED" },
      orderBy: { id: "asc" },
      take: 100,
      select: {
        id: true,
        taskId: true,
        checkpointArtifact: true,
        sessionId: true,
        threadId: true,
        lastCommittedSequencesJson: true,
        createdAt: true,
      },
      ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    prepared += rows.length;
    for (const row of rows) {
      if (row.taskId === null) {
        await quarantinePreparedCheckpoint(row.id);
        quarantined.push(row.id);
        continue;
      }
      const artifactUri = artifactUriSchema.safeParse(row.checkpointArtifact);
      if (!artifactUri.success) {
        await quarantinePreparedCheckpoint(row.id);
        quarantined.push(row.id);
        continue;
      }
      if (!kernelUds) {
        failed.push({ id: row.id, error: "kernel artifact service is unavailable" });
        continue;
      }
      const artifactHash = contentHashSchema.parse(
        `sha256:${artifactUri.data.slice("artifact://sha256/".length)}`,
      );
      const task = await db.task.findUnique({ where: { id: row.taskId } });
      if (!task || task.sessionId !== row.sessionId || task.threadId !== row.threadId) {
        await quarantinePreparedCheckpoint(row.id);
        quarantined.push(row.id);
        continue;
      }
      const contractRow = await db.taskContractVersion.findUnique({
        where: {
          task_id_version: {
            task_id: task.id,
            version: task.activeContractVersion,
          },
        },
      });
      if (!contractRow) {
        await quarantinePreparedCheckpoint(row.id);
        quarantined.push(row.id);
        continue;
      }
      const criteria = await db.acceptanceCriterion.findMany({
        where: { taskId: task.id, contractVersion: contractRow.version },
        orderBy: { criterionId: "asc" },
      });
      const contract = persistedTaskContract(task, contractRow, criteria);
      const recoveryContext = await kernelContextForTask(
        row.taskId,
        "checkpoint-admission-recovery",
        [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
      );
      const artifactClient = createKernelArtifactClient(kernelUds.artifacts, {
        ...recoveryContext,
        idempotencyKey: `checkpoint-recovery:${row.id}`,
      });
      try {
        await loadValidatedCheckpoint({
          row,
          artifacts: artifactClient,
          contract,
          taskId: task.id,
          taskSourceVersion: contractRow.contentHash,
        });
        await artifactClient.link(artifactHash, "checkpoint", row.id, "content");
      } catch (error: unknown) {
        if (!isTransientKernelFailure(error)) {
          await quarantinePreparedCheckpoint(row.id);
          quarantined.push(row.id);
          continue;
        }
        failed.push({
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const sequenceState = safeParse<Record<string, unknown>>(row.lastCommittedSequencesJson, {});
      const sourceTurnId = typeof sequenceState.sourceTurnId === "string"
        ? sequenceState.sourceTurnId
        : null;
      if (sourceTurnId !== null) {
        const sourceTurn = await db.turn.findUnique({
          where: { id: sourceTurnId },
          select: { taskId: true, state: true },
        });
        const completion = await db.completionRecord.findUnique({
          where: { taskId: task.id },
          select: { status: true, admissionState: true },
        });
        if (
          sourceTurn?.taskId === task.id
          && (sourceTurn.state === "FINALIZING" || sourceTurn.state === "VERIFIED")
          && task.status === "COMPLETED"
          && completion?.status === "completed"
          && completion.admissionState === "COMMITTED"
        ) {
          // Terminal recovery owns this row. Keeping it PREPARED lets the
          // checkpoint and `turn.completed` event commit together.
          deferred.push(row.id);
          continue;
        }
      }
      try {
        await commitCheckpointPublication({
          id: row.id,
          threadId: row.threadId,
          taskId: task.id,
          artifactHash,
        });
        recovered.push(row.id);
      } catch (error: unknown) {
        failed.push({
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (rows.length < 100) break;
    cursor = rows.at(-1)?.id ?? null;
    if (cursor === null) throw new Error("checkpoint recovery lost its continuation cursor");
  }

  return { prepared, recovered, deferred, quarantined, failed };
}

interface CheckpointLinkRecoveryResult {
  readonly scanned: number;
  readonly removedOrphans: readonly string[];
  readonly deferredOrphans: readonly string[];
  readonly rebound: readonly string[];
  readonly requeued: readonly string[];
  readonly quarantined: readonly string[];
  readonly failed: readonly { id: string; error: string }[];
}

function kernelLinkCreatedAtMillis(value: string): number | null {
  const unix = /^(\d+)\.(\d+)\+00:00$/.exec(value);
  if (unix) {
    const seconds = Number(unix[1]);
    return Number.isFinite(seconds) ? seconds * 1_000 : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function checkpointOrphanGraceMillis(): number {
  const configured = Number(process.env.TERMINUS_CHECKPOINT_ORPHAN_GRACE_MS ?? "300000");
  return Number.isFinite(configured) && configured >= 0 ? configured : 300_000;
}

async function reconcileCheckpointArtifactLinks(): Promise<CheckpointLinkRecoveryResult> {
  if (!kernelUds) {
    return {
      scanned: 0,
      removedOrphans: [],
      deferredOrphans: [],
      rebound: [],
      requeued: [],
      quarantined: [],
      failed: [{ id: "kernel", error: "kernel artifact service is unavailable" }],
    };
  }
  const removedOrphans: string[] = [];
  const deferredOrphans: string[] = [];
  const rebound: string[] = [];
  const requeued: string[] = [];
  const quarantined: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const observedCheckpointIds = new Set<string>();
  let scanned = 0;
  let continuationToken = "";
  do {
    const page = await kernelUds.artifacts.ListCheckpointLinks({
      context: await kernelMaintenanceContext(),
      pageSize: 250,
      continuationToken,
    });
    for (const link of page.links) {
      scanned += 1;
      if (observedCheckpointIds.has(link.checkpointId)) {
        await writerTransaction((tx) => tx.checkpoint.updateMany({
          where: { id: link.checkpointId },
          data: { admissionState: "QUARANTINED" },
        }));
        quarantined.push(link.checkpointId);
        continue;
      }
      observedCheckpointIds.add(link.checkpointId);
      const row = await db.checkpoint.findUnique({
        where: { id: link.checkpointId },
        select: { id: true, taskId: true, checkpointArtifact: true, sessionId: true },
      });
      if (!row) {
        const createdAt = kernelLinkCreatedAtMillis(link.createdAt);
        const oldEnough = createdAt !== null
          && Date.now() - createdAt >= checkpointOrphanGraceMillis();
        if (!oldEnough) {
          deferredOrphans.push(link.checkpointId);
          continue;
        }
        try {
          const response = await kernelUds.artifacts.UnlinkCheckpoint({
            context: await kernelMaintenanceContext(),
            sha256: link.sha256,
            checkpointId: link.checkpointId,
            ownerTaskId: link.ownerTaskId,
          });
          if (!response.unlinked) throw new Error("kernel checkpoint link changed before unlink");
          removedOrphans.push(link.checkpointId);
        } catch (error: unknown) {
          failed.push({
            id: link.checkpointId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      const artifactUri = artifactUriSchema.safeParse(row.checkpointArtifact);
      const expectedHash = artifactUri.success
        ? `sha256:${artifactUri.data.slice("artifact://sha256/".length)}`
        : null;
      if (
        row.taskId === null
        || expectedHash !== link.sha256
        || (link.ownerTaskId.length > 0 && link.ownerTaskId !== row.taskId)
      ) {
        await writerTransaction((tx) => tx.checkpoint.update({
          where: { id: row.id },
          data: { admissionState: "QUARANTINED" },
        }));
        quarantined.push(row.id);
        continue;
      }
      if (link.ownerTaskId.length === 0) {
        try {
          const rebindContext = await kernelContextForTask(
            row.taskId,
            "checkpoint-link-reconciliation",
            [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
          );
          const artifacts = createKernelArtifactClient(kernelUds.artifacts, {
            ...rebindContext,
            idempotencyKey: `checkpoint-link-rebind:${row.id}`,
          });
          const linkHash = contentHashSchema.parse(link.sha256);
          await artifacts.link(linkHash, "checkpoint", row.id, "content");
          rebound.push(row.id);
        } catch (error: unknown) {
          failed.push({
            id: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const next = page.continuationToken;
    if (next.length > 0 && next === continuationToken) {
      throw new Error("kernel checkpoint-link pagination did not advance");
    }
    continuationToken = next;
  } while (continuationToken.length > 0);

  let checkpointCursor: string | null = null;
  for (;;) {
    const committed: Array<{ id: string; taskId: string | null }> = await db.checkpoint.findMany({
      where: { admissionState: "COMMITTED" },
      select: { id: true, taskId: true },
      orderBy: { id: "asc" },
      take: 500,
      ...(checkpointCursor === null ? {} : { cursor: { id: checkpointCursor }, skip: 1 }),
    });
    for (const checkpoint of committed) {
      if (observedCheckpointIds.has(checkpoint.id)) continue;
      const nextState = checkpoint.taskId === null ? "QUARANTINED" : "PREPARED";
      await writerTransaction((tx) => tx.checkpoint.updateMany({
        where: { id: checkpoint.id, admissionState: "COMMITTED" },
        data: { admissionState: nextState },
      }));
      if (nextState === "PREPARED") requeued.push(checkpoint.id);
      else quarantined.push(checkpoint.id);
    }
    if (committed.length < 500) break;
    checkpointCursor = committed.at(-1)?.id ?? null;
    if (checkpointCursor === null) throw new Error("checkpoint link recovery lost its continuation cursor");
  }

  return {
    scanned,
    removedOrphans,
    deferredOrphans,
    rebound,
    requeued,
    quarantined,
    failed,
  };
}

function checkpointFailureDescription(terminalErrorJson: string, state: string): string {
  const decoded = safeParse<unknown>(terminalErrorJson, null);
  if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
    const record = decoded as Record<string, unknown>;
    for (const key of ["message", "error", "reason"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return `Turn stopped in ${state}`;
}

function normalizeRiskClass(value: string): TaskSnapshot["contract"]["riskClass"] {
  return value === "low" || value === "high" || value === "critical" ? value : "normal";
}

function unconfiguredProviderSnapshot(observedAt: Rfc3339Timestamp): ProviderCapabilitySnapshot {
  return {
    providerId: "local",
    observedAt,
    source: "terminus-control/unconfigured-provider-v1",
    context: {
      advertisedTokens: 16_384,
      testedSafeTokens: 8_192,
      roleSupport: ["system", "user", "assistant", "tool"],
      imageInput: false,
      toolCalling: false,
      parallelToolCalls: false,
      structuredOutput: true,
    },
    continuation: {
      nativeId: false,
      crossRequest: false,
      compaction: true,
      compatibilityKey: "unconfigured-provider-v1",
    },
    caching: {
      mode: "explicit_breakpoints",
      exactPrefixRequired: true,
      minimumTokens: 0,
      ttlOptions: [],
      toolOrderSensitive: false,
      usageReporting: false,
    },
    reasoning: { supported: false, budgetControl: false, summaryAvailable: false },
    economics: {
      inputMicrosPerMillion: 0n as Micros,
      cachedInputMicrosPerMillion: 0n as Micros,
      outputMicrosPerMillion: 0n as Micros,
      reasoningAccounting: false,
    },
    reliability: {
      toolCallSuccess: 0,
      structuredOutputSuccess: 0,
      editCohortSuccess: 0,
      latencyPercentiles: { p50: 0, p99: 0 },
    },
    policy: {
      allowedConfidentiality: ["public", "workspace"],
      retentionMode: "local_only",
      region: null,
    },
  };
}

/** Execute the configured local provider exclusively through kernel Job RPC. */
async function executeGatewayProviderRequest(
  rendered: RenderedProviderRequest,
  gateway: ProviderGatewayConfig,
  context: RequestContext,
  signal: AbortSignal | null | undefined,
  onChunk?: ProviderExecutionInput["onChunk"],
): Promise<ProviderResponse> {
  const client = gateway.endpoint === undefined
    ? new KernelGatewayClient(requireKernelUds().connectors, context)
    : new KernelConnectorClient(requireKernelUds().connectors, context, gateway.endpoint);
  // The turn-state echo is refreshed per dispatch: the header record was
  // built once at turn start, and the token only exists after a response.
  const extraHeaders = {
    ...(gateway.extraHeaders ?? {}),
    ...(gateway.codexTurnState?.requestHeaders() ?? {}),
  };
  const transport = new GatewayTransport({
    credentialBindingId: gateway.secretUri,
    models: [gateway.model],
    client,
    ...(Object.keys(extraHeaders).length === 0 ? {} : { extraHeaders }),
  });
  const chunks: ProviderResponseChunk[] = [];
  const dispatchedAt = Date.now();
  let firstChunkAt: number | null = null;
  try {
    for await (const chunk of transport.stream(rendered.request, rendered.body, signal ?? rendered.request.signal)) {
      if (firstChunkAt === null && (chunk.kind === "text" || chunk.kind === "tool_call")) {
        firstChunkAt = Date.now();
      }
      chunks.push(chunk);
      await onChunk?.(chunk);
    }
  } finally {
    // In `finally` because the head frame carries these on a 429 as well as a
    // 200 — quota receipts and turn continuity must survive a thrown request.
    gateway.codexTurnState?.observe(client.responseHeaders());
    if (gateway.accountId !== undefined) {
      recordProviderAccountUsageHeaders(gateway.accountId, client.responseHeaders());
    }
  }
  const providerError = chunks.find((chunk) => chunk.kind === "error");
  if (providerError?.kind === "error") {
    // Structured, not prose: the retry classifier must not have to parse
    // `server_error: Streaming response failed: [502] …` to learn it is 5xx.
    throw ProviderTransportError.fromProviderErrorChunk({
      errorCode: providerError.errorCode,
      errorMessage: providerError.errorMessage,
      retryAfterMs: providerError.retryAfterMs,
      fallbackMessage: "gateway provider failed",
    });
  }
  return {
    providerId: rendered.providerId,
    model: rendered.model,
    chunks: withMeasuredUsage(chunks, {
      wallMs: Date.now() - dispatchedAt,
      // First body frame when the transport measured one; the first decoded
      // chunk otherwise. The head frame is deliberately not the boundary —
      // it times the kernel's round trip, not the provider's first token.
      timeToFirstTokenMs: client.timeToFirstBodyMs()
        ?? (firstChunkAt === null ? null : firstChunkAt - dispatchedAt),
    }),
    observedAt: now(),
  };
}

/**
 * Binds the shared text-delta coalescer (H9) to this turn's event stream.
 * Buffer state lives in the closure of the single per-turn stream consumer,
 * so no locking beyond the agent-state mutation mutex is required.
 */
function createProviderTextDeltaEmitter(turnId: string, taskId: string): TextDeltaCoalescer {
  return createProviderDeltaCoalescer({
    text: async (text) => {
      await mutateAgentState(() => emit({
        eventType: "turn.provider_text_delta",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: taskId,
        payload: { text },
      }));
    },
    reasoning: async (text) => {
      await mutateAgentState(() => emit({
        eventType: "turn.provider_reasoning_delta",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: taskId,
        payload: { text },
      }));
    },
  });
}

function providerAttemptEndpoint(
  directConfiguration: ReturnType<typeof parseDirectProviderConfiguration>,
  gatewayModel: GatewayModel | null,
): string {
  if (directConfiguration !== null) {
    const endpoint = directEndpoint(directConfiguration);
    return `https://${endpoint.host}:${endpoint.port}${endpoint.path}`;
  }
  if (gatewayModel !== null) return gatewayEndpoint(gatewayModel);
  return "kernel://terminus.local-provider.v1";
}

function providerRequestIdFromChunks(chunks: readonly ProviderResponseChunk[]): string | null {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const value = chunks[index]?.providerRequestId;
    if (value !== undefined && value.trim() !== "") return value;
  }
  return null;
}

const providerSessionService = new ProviderSessionService<Prisma.TransactionClient>({
  readTurnState: async (turnId) => (await db.turn.findUnique({ where: { id: turnId }, select: { state: true } }))?.state ?? null,
  appendEvent: async (event, mutation): Promise<void> => {
    await emit({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
      artifactRefs: event.artifactRefs === undefined ? undefined : [...event.artifactRefs],
    }, mutation);
  },
  transaction: (tx) => ({
    startAttempt: async (input: ProviderAttemptStartInput) => {
      const turnUpdate = await tx.turn.updateMany({
        where: { id: input.turnId, state: "CONTEXT_COMPILING" },
        data: { state: "PROVIDER_RUNNING" },
      });
      if (turnUpdate.count !== 1) {
        throw new Error(`turn ${input.turnId} changed before provider attempt start`);
      }
      await tx.providerAttempt.create({
        data: {
          id: input.attemptId,
          turnId: input.turnId,
          attemptNumber: input.attemptNumber,
          providerId: input.providerId,
          modelKey: input.modelKey,
          capabilitySnapshotHash: input.capabilitySnapshotHash,
          contextManifestId: input.contextManifestId,
          requestArtifact: input.requestArtifact,
          requestFingerprint: input.requestFingerprint,
          providerIdempotencyKey: input.providerIdempotencyKey,
          status: "running",
        },
      });
      await tx.contextManifest.update({
        where: { id: input.contextManifestId },
        data: { providerAttemptId: input.attemptId },
      });
    },
    completeAttempt: async (input: ProviderAttemptResponseInput) => {
      const turnUpdate = await tx.turn.updateMany({
        where: { id: input.turnId, state: "PROVIDER_RUNNING" },
        data: { state: "RESPONSE_VALIDATING" },
      });
      if (turnUpdate.count !== 1) {
        throw new Error(`turn ${input.turnId} changed before provider response settlement`);
      }
      if (input.messageArtifact !== null && input.messageHash !== null) {
        const latestEpisode = await tx.episode.findFirst({
          where: { turnId: input.turnId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        await tx.episode.create({
          data: {
            id: uuid(),
            turnId: input.turnId,
            sequence: (latestEpisode?.sequence ?? 0) + 1,
            kind: "model_message",
            modelVisible: true,
            contentArtifact: input.messageArtifact,
            sourceVersionsJson: JSON.stringify({ providerAttemptId: input.attemptId, response: input.messageHash }),
          },
        });
      }
      await tx.providerAttempt.update({
        where: { id: input.attemptId },
        data: {
          status: "completed",
          responseArtifact: input.responseArtifact,
          providerRequestId: input.providerRequestId,
          continuationId: input.continuationId,
          completedAt: new Date(),
          usageJson: JSON.stringify(jsonSafe(input.usage)),
          // Legacy cost_micros was a zero sentinel. New accounting is kept in
          // exact bigint columns with an explicit source, so old readers do
          // not mistake a computed estimate for provider-reported spend.
          costMicros: null,
          providerReportedCostMicros: input.cost.providerReportedCostMicros,
          computedCostMicros: input.cost.computedCostMicros,
          costSource: input.cost.source,
          finishReason: input.finishReason,
          nativeContinuationJson: input.continuationId === null
            ? null
            : JSON.stringify({ continuation_id: input.continuationId }),
          // Written even when the response carried no text: a tool-call-only
          // attempt creates no assistant episode, and it is exactly the case
          // whose reasoning has to be replayed on the next request.
          ...(input.reasoningReplayJson === undefined
            ? {}
            : { reasoningReplayJson: input.reasoningReplayJson }),
        },
      });
    },
  }),
  mutate: mutateAgentState,
  executeLocal: async (input: ProviderExecutionInput) => {
    if (input.command === null) throw new ProviderExecutionUnavailableError(input.rendered.providerId);
    return executeLocalProviderCommand({
      clients: requireKernelUds(),
      context: input.context,
      workspaceId: input.workspaceId,
      command: input.command,
      rendered: input.rendered,
      signal: input.signal ?? input.rendered.request.signal,
      devMode: DEV_MODE,
    });
  },
  executeGateway: async (input: ProviderExecutionInput) => {
    if (input.gateway === null) throw new ProviderExecutionUnavailableError(input.rendered.providerId);
    return executeGatewayProviderRequest(input.rendered, input.gateway, input.context, input.signal, input.onChunk);
  },
});

interface ContextBudgetSelection {
  readonly budget: ContextBudget;
  readonly breakdown: ReturnType<typeof deriveProviderAwareContextBudget>["breakdown"];
}

/**
 * Hold a reserve inside a window-derived ceiling without letting a tiny or
 * unreported window drive it to zero. A zero ceiling means "window unknown",
 * in which case the requested reserve stands.
 */
function clampReserve(requested: bigint, ceiling: bigint, floor: bigint): TokenCount {
  if (ceiling <= 0n) return requested as TokenCount;
  if (requested <= ceiling) return requested as TokenCount;
  return (ceiling > floor ? ceiling : floor) as TokenCount;
}

/**
 * The turn's token allocation.
 *
 * Two of these numbers used to be constants and both were wrong in the same
 * direction — they were sized for a 2024 model and never revisited:
 *
 *   - `output` was 1024, so any real patch was truncated mid-write and the
 *     engine then refused the truncated tool call. It now comes from the
 *     selected model's own max-output (128k on GPT-5.6 and Claude 5), capped
 *     at half the window so a small model cannot reserve its whole context
 *     for a reply.
 *   - `reasoning` was 0, and both renderers gated their reasoning/thinking
 *     field on it being positive, so the effort chosen in the UI reached the
 *     wire on exactly one transport. It now scales with that effort
 *     (`resolveReasoningReserveTokens`: low 4k / medium 16k / high 32k /
 *     max 64k), capped at a quarter of the window. The renderers no longer
 *     gate on it at all — this is context accounting, not a wire value.
 */
function makeContextBudget(
  provider: ProviderCapabilitySnapshot,
  model: ModelCapabilitySnapshot,
  taskBudget: TaskSnapshot["contract"]["budget"],
  toolSchemas: readonly ProviderToolSchema[],
  reasoningEffort: ReasoningEffort | null,
): ContextBudgetSelection {
  const hard = BigInt(Math.max(0, Math.floor(provider.context.testedSafeTokens))) as TokenCount;
  const modelMaxOutput = BigInt(
    provider.context.maxOutputTokens
      ?? resolveMaxOutputTokens({ modelId: String(model.modelKey), outputTokens: 0 }),
  );
  // Half the window for the reply, a quarter for reasoning: on a 270k or 1M
  // window both ceilings are far above the model's real maximum and never
  // bind; on a small window they stop the reserves from eating the prompt.
  const output = clampReserve(
    boundedStreamOutputReserve(modelMaxOutput),
    hard / 2n,
    1_024n,
  );
  const reasoning = clampReserve(
    BigInt(resolveReasoningReserveTokens(reasoningEffort)),
    hard / 4n,
    0n,
  );
  const toolResult = 512n as TokenCount;
  const recovery = 256n as TokenCount;
  const reserved = output + reasoning + toolResult + recovery;
  const optional = hard > reserved ? hard - reserved : 0n;
  const baseBudget: ContextBudget = {
    modelAdvertisedTokens: BigInt(provider.context.advertisedTokens) as TokenCount,
    testedSafeTokens: hard,
    protocolOverheadTokens: 128n as TokenCount,
    exactContextTokens: 0n as TokenCount,
    optionalContextTarget: optional as TokenCount,
    expectedToolResultReserve: toolResult,
    outputReserve: output,
    reasoningReserve: reasoning,
    recoveryMargin: recovery,
    hardInputLimit: hard,
    hardCostMicros: taskBudget.modelMicros,
  };
  return deriveProviderAwareContextBudget({
    budget: baseBudget,
    provider,
    model,
    tokenizer: resolveTokenizer(provider.providerId, model.modelKey),
    toolSchemas,
  });
}

const TURN_BUDGET_LEDGER_VERSION = "terminus.turn-budget-ledger.v1" as const;

function nonNegativeBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function artifactUriHash(uri: string | null | undefined): string | null {
  if (uri === undefined || uri === null || !uri.startsWith("artifact://sha256/")) return null;
  const hash = `sha256:${uri.slice("artifact://sha256/".length)}`;
  return /^sha256:[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function compactionSummaryHash(sourceVersionsJson: string | null): string | null {
  if (sourceVersionsJson === null) return null;
  const sourceVersions = safeParse<Record<string, unknown> | null>(sourceVersionsJson, null);
  const parsed = contentHashSchema.safeParse(sourceVersions?.summaryHash);
  return parsed.success ? parsed.data : null;
}

function ledgerProgressJson(progress: OperationProgressAnalysis | null): string | null {
  return progress === null ? null : canonicalJson(progress);
}

function turnBudgetLedgerData(
  ledger: BudgetLedgerSnapshot,
  contextBudgetJson?: string | null,
) {
  return {
    schemaVersion: TURN_BUDGET_LEDGER_VERSION,
    stepsUsed: ledger.stepsUsed,
    maxSteps: ledger.maxSteps,
    hardMaxSteps: ledger.hardMaxSteps,
    tokensUsed: ledger.tokensUsed,
    inputTokens: ledger.usage.inputTokens,
    cachedInputTokens: ledger.usage.cachedInputTokens,
    cacheWriteTokens: ledger.usage.cacheWriteTokens,
    outputTokens: ledger.usage.outputTokens,
    reasoningTokens: ledger.usage.reasoningTokens,
    toolSchemaTokens: ledger.usage.toolSchemaTokens,
    maxTokens: ledger.maxTokens,
    costMicros: ledger.costMicros,
    maxCostMicros: ledger.maxCostMicros,
    contextHeadroomTokens: ledger.contextHeadroomTokens,
    finalVerificationReserveTokens: ledger.finalVerificationReserveTokens,
    finalVerificationReserveCostMicros: ledger.finalVerificationReserveCostMicros,
    contextBudgetJson: contextBudgetJson ?? null,
    evidenceJson: canonicalJson(ledger.evidence),
    lastProgressJson: ledgerProgressJson(ledger.lastProgress),
  };
}

async function persistTurnBudgetLedger(
  turnId: string,
  ledger: BudgetLedgerSnapshot,
  contextBudgetJson?: string | null,
): Promise<void> {
  await writerTransaction(async (tx) => {
    const data = turnBudgetLedgerData(ledger, contextBudgetJson);
    await tx.turnBudgetLedger.upsert({
      where: { turnId },
      create: { id: uuid(), turnId, ...data },
      update: data,
    });
  });
}

async function persistOperationObservation(
  turnId: string,
  observation: OperationObservation,
  progress: OperationProgressAnalysis | null,
): Promise<void> {
  await writerTransaction((tx) => persistOperationObservationInTransaction(tx, turnId, observation, progress));
}

async function persistOperationObservationInTransaction(
  tx: Prisma.TransactionClient,
  turnId: string,
  observation: OperationObservation,
  progress: OperationProgressAnalysis | null,
): Promise<void> {
  const analysis = progress ?? {
    progressed: false,
    noOp: false,
    repeatedFailure: false,
    oscillating: false,
    failureClass: null,
    recommendedRecovery: ["inspect_evidence"] as const,
    reason: "new_operation" as const,
  };
  await tx.operationObservation.upsert({
    where: {
      turnId_observationHash: {
        turnId,
        observationHash: observation.observationHash,
      },
    },
    create: {
      id: uuid(),
      turnId,
      providerAttemptId: observation.attemptId,
      schemaVersion: observation.schemaVersion,
      observationHash: observation.observationHash,
      semanticFingerprint: observation.semanticFingerprint,
      attemptNumber: observation.attemptNumber,
      providerCallId: observation.providerCallId,
      toolId: observation.toolId,
      toolVersion: observation.toolVersion,
      status: observation.status,
      resultHash: observation.resultHash,
      errorCode: observation.errorCode,
      errorClass: observation.errorClass,
      mutatesWorkspace: observation.mutatesWorkspace,
      workspaceRevisionBefore: observation.workspaceRevisionBefore,
      workspaceRevisionAfter: observation.workspaceRevisionAfter,
      verificationDelta: observation.verificationDelta,
      hypothesisId: observation.hypothesisId,
      criterionIdsJson: canonicalJson(observation.criterionIds),
      objectiveStep: observation.objectiveStep,
      progressed: analysis.progressed,
      noOp: analysis.noOp,
      repeatedFailure: analysis.repeatedFailure,
      oscillating: analysis.oscillating,
      failureClass: analysis.failureClass,
      progressReason: analysis.reason,
      recommendedRecoveryJson: canonicalJson(analysis.recommendedRecovery),
    },
    update: {
      progressed: analysis.progressed,
      noOp: analysis.noOp,
      repeatedFailure: analysis.repeatedFailure,
      oscillating: analysis.oscillating,
      failureClass: analysis.failureClass,
      progressReason: analysis.reason,
      recommendedRecoveryJson: canonicalJson(analysis.recommendedRecovery),
    },
  });
}

/** Persist the observation and its latest ledger snapshot under one writer transaction. */
async function persistOperationObservationAndLedger(
  turnId: string,
  observation: OperationObservation,
  progress: OperationProgressAnalysis | null,
  ledger: BudgetLedgerSnapshot,
  contextBudgetJson?: string | null,
): Promise<void> {
  await writerTransaction(async (tx) => {
    await persistOperationObservationInTransaction(tx, turnId, observation, progress);
    const data = turnBudgetLedgerData(ledger, contextBudgetJson);
    await tx.turnBudgetLedger.upsert({
      where: { turnId },
      create: { id: uuid(), turnId, ...data },
      update: data,
    });
  });
}

interface EvidenceBundlePersistenceInput {
  readonly taskId: string;
  readonly turnId: string;
  readonly contractVersion: number;
  readonly baseWorkspaceRevision: string;
  readonly finalWorkspaceRevision: string;
  readonly profile: TerminusExecutionProfile;
  readonly providerAttemptIds: readonly string[];
  readonly contextManifestIds: readonly string[];
  readonly requestArtifactHashes: readonly string[];
  readonly responseArtifactHashes: readonly string[];
  readonly toolCallIds: readonly string[];
  readonly verificationResultIds: readonly string[];
  readonly proofBundleHash?: string | null | undefined;
  readonly terminalOutcome: EvidenceTerminalOutcome;
  readonly admissionState?: "PREPARED" | "COMMITTED" | "QUARANTINED" | undefined;
  readonly artifacts: ArtifactClient;
}

/** Persist the queryable evidence identity and its self-contained artifact. */
async function persistEvidenceBundle(input: EvidenceBundlePersistenceInput): Promise<{
  readonly identityHash: string;
  readonly artifactUri: string;
}> {
  const identity = buildEvidenceIdentity(input);
  const bundleArtifact = await input.artifacts.ingest(
    new TextEncoder().encode(canonicalJson({
      schema_version: identity.schemaVersion,
      identity_hash: identity.identityHash,
      task_id: identity.taskId,
      turn_id: identity.turnId,
      contract_version: identity.contractVersion,
      base_workspace_revision: identity.baseWorkspaceRevision,
      final_workspace_revision: identity.finalWorkspaceRevision,
      profile: {
        profile_id: input.profile.profileId,
        version: input.profile.version,
        provider_id: input.profile.providerId,
        model_key: input.profile.modelKey,
        tool_ids: input.profile.toolIds,
        configuration_hash: input.profile.configurationHash,
        profile_hash: input.profile.profileHash,
      },
      provider_attempt_ids: identity.providerAttemptIds,
      context_manifest_ids: identity.contextManifestIds,
      request_artifact_hashes: identity.requestArtifactHashes,
      response_artifact_hashes: identity.responseArtifactHashes,
      tool_call_ids: identity.toolCallIds,
      verification_result_ids: identity.verificationResultIds,
      proof_bundle_hash: identity.proofBundleHash,
      terminal_outcome: identity.terminalOutcome,
    })),
    {
      mediaType: "application/json",
      custom: { purpose: "evidence-bundle", taskId: input.taskId, turnId: input.turnId },
    },
  );
  await input.artifacts.link(bundleArtifact.hash, "task", input.taskId, "evidence-bundle");
  await input.artifacts.link(bundleArtifact.hash, "turn", input.turnId, "evidence-bundle");
  const admissionState = input.admissionState ?? "COMMITTED";
  await writerTransaction(async (tx) => {
    const existing = await tx.evidenceBundle.findUnique({
      where: { taskId_turnId: { taskId: input.taskId, turnId: input.turnId } },
    });
    if (existing !== null) {
      if (existing.identityHash !== identity.identityHash) {
        throw new Error(`evidence bundle ${input.taskId}/${input.turnId} changed immutable identity`);
      }
      await tx.evidenceBundle.update({
        where: { id: existing.id },
        data: { admissionState, bundleArtifact: bundleArtifact.uri },
      });
      return;
    }
    await tx.evidenceBundle.create({
      data: {
        id: `evidence:${input.taskId}:${input.turnId}`,
        taskId: input.taskId,
        turnId: input.turnId,
        schemaVersion: identity.schemaVersion,
        identityHash: identity.identityHash,
        contractVersion: identity.contractVersion,
        baseWorkspaceRevision: identity.baseWorkspaceRevision,
        finalWorkspaceRevision: identity.finalWorkspaceRevision,
        profileId: input.profile.profileId,
        profileVersion: input.profile.version,
        profileHash: identity.profileHash,
        bundleArtifact: bundleArtifact.uri,
        providerAttemptIdsJson: canonicalJson(identity.providerAttemptIds),
        contextManifestIdsJson: canonicalJson(identity.contextManifestIds),
        requestArtifactHashesJson: canonicalJson(identity.requestArtifactHashes),
        responseArtifactHashesJson: canonicalJson(identity.responseArtifactHashes),
        toolCallIdsJson: canonicalJson(identity.toolCallIds),
        verificationResultIdsJson: canonicalJson(identity.verificationResultIds),
        proofBundleHash: identity.proofBundleHash,
        terminalOutcome: identity.terminalOutcome,
        admissionState,
      },
    });
  });
  return { identityHash: identity.identityHash, artifactUri: bundleArtifact.uri };
}

const EMPTY_CONTEXT_HASH = ("sha256:" + "0".repeat(64)) as ContentHash;

interface EnsureContextEpochInput {
  readonly db: PrismaClient;
  readonly threadId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly provider: ProviderCapabilitySnapshot;
  readonly model: ModelCapabilitySnapshot;
  readonly worldState: WorldStateSnapshot;
  readonly artifacts: ArtifactClient;
}

/**
 * Creates or resumes the durable context epoch before compilation. The epoch
 * snapshot and baseline are kernel artifacts; Prisma stores only their URIs.
 */
async function ensureContextEpoch(
  input: EnsureContextEpochInput,
): Promise<ContextEpochSnapshot> {
  const observedActive = await input.db.contextEpoch.findFirst({
    where: { threadId: input.threadId, state: "active" },
    orderBy: { generation: "desc" },
  });
  if (
    observedActive !== null
    && observedActive.providerCompatibilityKey === input.provider.continuation.compatibilityKey
  ) {
    return {
      epochId: observedActive.id as ContextEpochSnapshot["epochId"],
      threadId: observedActive.threadId as ContextEpochSnapshot["threadId"],
      sequence: observedActive.generation,
      baselineHash: observedActive.baselineHash as ContentHash,
      provider: input.provider.providerId,
      model: input.model.modelKey,
      continuationId: null,
      startedAt: observedActive.createdAt.toISOString() as Rfc3339Timestamp,
    };
  }

  const snapshot = await ingestJsonArtifact(
    input.artifacts,
    {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      provider: input.provider.providerId,
      model: input.model.modelKey,
      sourceVersions: input.worldState.sourceVersions,
      sections: input.worldState.sections,
      observedAt: input.worldState.observedAt,
    },
    "context-epoch-snapshot",
    { taskId: input.taskId, workspaceId: input.workspaceId },
  );
  return mutateAgentState(async () => {
    const active = await input.db.contextEpoch.findFirst({
      where: { threadId: input.threadId, state: "active" },
      orderBy: { generation: "desc" },
    });
    if (active !== null && active.providerCompatibilityKey === input.provider.continuation.compatibilityKey) {
      return {
        epochId: active.id as ContextEpochSnapshot["epochId"],
        threadId: active.threadId as ContextEpochSnapshot["threadId"],
        sequence: active.generation,
        baselineHash: active.baselineHash as ContentHash,
        provider: input.provider.providerId,
        model: input.model.modelKey,
        continuationId: null,
        startedAt: active.createdAt.toISOString() as Rfc3339Timestamp,
      };
    }
    const latest = await input.db.contextEpoch.findFirst({
      where: { threadId: input.threadId },
      orderBy: { generation: "desc" },
    });
    const epochId = generateUuid7();
    const generation = (latest?.generation ?? 0) + 1;
    const createdAt = new Date();
    await input.db.$transaction(async (tx) => {
      await assertControlWriterLease(tx);
      if (active !== null) {
        await tx.contextEpoch.update({
          where: { id: active.id },
          data: {
            state: "sealed",
            sealedAt: createdAt,
            sealReason: "provider compatibility changed",
          },
        });
      }
      await tx.contextEpoch.create({
        data: {
          id: epochId,
          threadId: input.threadId,
          generation,
          providerCompatibilityKey: input.provider.continuation.compatibilityKey,
          baselineArtifact: snapshot.uri,
          baselineHash: EMPTY_CONTEXT_HASH,
          snapshotArtifact: snapshot.uri,
          state: "active",
        },
      });
      await tx.thread.update({
        where: { id: input.threadId },
        data: { activeContextEpochId: epochId },
      });
    });
    return {
      epochId,
      threadId: input.threadId as ContextEpochSnapshot["threadId"],
      sequence: generation,
      baselineHash: EMPTY_CONTEXT_HASH,
      provider: input.provider.providerId,
      model: input.model.modelKey,
      continuationId: null,
      startedAt: createdAt.toISOString() as Rfc3339Timestamp,
    };
  });
}

async function ingestJsonArtifact(
  artifacts: ArtifactClient,
  value: unknown,
  purpose: string,
  scope: Readonly<Record<string, unknown>>,
): Promise<Awaited<ReturnType<ArtifactClient["ingest"]>>> {
  return artifacts.ingest(
    new TextEncoder().encode(canonicalJson(value)),
    { mediaType: "application/json", custom: { purpose, ...scope } },
  );
}

function checkpointEpisodeRange(
  episodes: readonly { readonly sequence: number }[],
): { readonly from: number; readonly to: number } {
  if (episodes.length === 0) return { from: 0, to: 0 };
  return {
    from: episodes[0]?.sequence ?? 0,
    to: episodes.at(-1)?.sequence ?? 0,
  };
}

async function loadValidatedCheckpoint(input: {
  readonly row: {
    readonly id: string;
    readonly threadId: string;
    readonly taskId: string | null;
    readonly checkpointArtifact: string;
    readonly lastCommittedSequencesJson: string;
    readonly createdAt: Date;
  };
  readonly artifacts: ArtifactClient;
  readonly contract: TaskSnapshot["contract"];
  readonly taskId: string;
  readonly taskSourceVersion: string;
}): Promise<Checkpoint> {
  if (input.row.taskId !== input.taskId) {
    throw new Error(`checkpoint ${input.row.id} is not bound to task ${input.taskId}`);
  }
  const sequenceState = checkpointSequenceStateSchema.safeParse(
    safeParse<unknown>(input.row.lastCommittedSequencesJson, null),
  );
  if (!sequenceState.success) {
    throw new Error(`checkpoint ${input.row.id} has invalid committed-sequence metadata`);
  }
  if (sequenceState.data.task !== input.contract.version) {
    throw new Error(
      `checkpoint ${input.row.id} contract version ${sequenceState.data.task} does not match active version ${input.contract.version}`,
    );
  }
  const sourceTurn = await db.turn.findUnique({
    where: { id: sequenceState.data.sourceTurnId },
    include: { episodes: { orderBy: { sequence: "asc" } } },
  });
  if (
    sourceTurn === null
    || sourceTurn.taskId !== input.taskId
    || sourceTurn.threadId !== input.row.threadId
  ) {
    throw new Error(`checkpoint ${input.row.id} source turn lineage is unavailable`);
  }
  if (sourceTurn.sequence !== sequenceState.data.turn) {
    throw new Error(`checkpoint ${input.row.id} source turn sequence changed`);
  }
  const actualEpisodeRange = checkpointEpisodeRange(sourceTurn.episodes);
  if (
    actualEpisodeRange.from !== sequenceState.data.episodeRange.from
    || actualEpisodeRange.to !== sequenceState.data.episodeRange.to
  ) {
    throw new Error(`checkpoint ${input.row.id} source episode range changed`);
  }
  const currentSourceVersions = {
    [`task://${input.taskId}`]: input.taskSourceVersion,
    [`turn://${sourceTurn.id}`]: `${sourceTurn.sequence}:${sourceTurn.state}`,
  };
  const artifactUri = artifactUriSchema.safeParse(input.row.checkpointArtifact);
  if (!artifactUri.success) {
    throw new Error(`checkpoint ${input.row.id} has an invalid artifact URI`);
  }
  const artifactHash = contentHashSchema.parse(
    `sha256:${artifactUri.data.slice("artifact://sha256/".length)}`,
  );
  const bytes = await input.artifacts.get(artifactHash);
  const observedHash = computeContentHash(bytes);
  if (observedHash !== artifactHash) {
    throw new Error(
      `checkpoint ${input.row.id} artifact hash mismatch: expected ${artifactHash}, observed ${observedHash}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`checkpoint ${input.row.id} artifact is not valid UTF-8`, { cause: error });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`checkpoint ${input.row.id} artifact is not valid JSON`, { cause: error });
  }
  const content = checkpointContentSchema.safeParse(decoded);
  if (!content.success) {
    throw new Error(
      `checkpoint ${input.row.id} artifact does not match CheckpointContent: ${content.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  if (canonicalJson(content.data) !== text) {
    throw new Error(`checkpoint ${input.row.id} artifact is not canonically encoded`);
  }
  const expectedSourceKeys = Object.keys(currentSourceVersions).sort();
  const checkpointSourceKeys = Object.keys(content.data.sourceVersions).sort();
  if (
    expectedSourceKeys.length !== checkpointSourceKeys.length
    || expectedSourceKeys.some((key, index) => key !== checkpointSourceKeys[index])
  ) {
    throw new Error(`checkpoint ${input.row.id} does not contain the exact authoritative source set`);
  }
  const validation = validateCheckpoint(content.data, input.contract, currentSourceVersions);
  if (!validation.valid) {
    throw new Error(
      `checkpoint ${input.row.id} is invalid for the active task: ${validation.violations.map((violation) => violation.description).join("; ")}`,
    );
  }
  return {
    id: input.row.id as Checkpoint["id"],
    threadId: input.row.threadId as Checkpoint["threadId"],
    turnId: sequenceState.data.sourceTurnId as Checkpoint["turnId"],
    episodeRange: sequenceState.data.episodeRange,
    artifactHash,
    canonicalStateHash: artifactHash,
    summary: renderCheckpointSummary(content.data),
    effectState: content.data.effectState,
    approvalState: content.data.approvalState,
    createdAt: input.row.createdAt.toISOString() as Rfc3339Timestamp,
  };
}

interface RepositoryInstructionDiscoveryInput {
  readonly clients: KernelUdsClients;
  readonly taskId: string;
  readonly turnId: string;
  readonly contractHash: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspaceRootUri: string;
  readonly contract: TaskContract;
  readonly changedFiles: readonly string[];
  readonly modelKey: ModelKey;
  readonly observedAt: Rfc3339Timestamp;
  readonly signal: AbortSignal;
}

/**
 * Recover the cache-epoch snapshot a compilation recorded in its manifest.
 *
 * The compiler writes `decisionRecord.cacheEpochDebug.current`; feeding it
 * back as the next attempt's `previousCacheEpoch` is what turns the cache
 * diagnostics from "no previous epoch" into a named invalidation reason.
 * Shape-checked rather than cast: the decision record is `unknown` by type
 * and a malformed one must degrade to "no previous epoch", not throw.
 */
function readCacheEpochSnapshot(
  decisionRecord: Readonly<Record<string, unknown>> | null | undefined,
): CacheEpochDebugSnapshot | null {
  const debug = decisionRecord?.cacheEpochDebug;
  if (typeof debug !== "object" || debug === null) return null;
  const current = (debug as { current?: unknown }).current;
  if (typeof current !== "object" || current === null) return null;
  const candidate = current as { stablePrefix?: unknown; breakpoints?: unknown };
  if (typeof candidate.stablePrefix !== "object" || candidate.stablePrefix === null) return null;
  if (!Array.isArray(candidate.breakpoints)) return null;
  return current as CacheEpochDebugSnapshot;
}

/**
 * Load repository instructions through the kernel read capability and turn
 * them into compiler fragments. The control plane never opens these files
 * directly; missing files are ordinary, while an aborted read is preserved.
 */
async function loadRepositoryInstructionFragments(
  input: RepositoryInstructionDiscoveryInput,
): Promise<readonly ContextFragment[]> {
  if (input.signal.aborted) throw new ToolAbortedError();
  let rootPath: string;
  try {
    rootPath = fileURLToPath(input.workspaceRootUri).replace(/\/+$/, "");
  } catch (error: unknown) {
    throw new Error("workspace root URI is not a valid file URL", { cause: error });
  }
  if (rootPath.length === 0) rootPath = "/";

  const directories = instructionCandidateDirectories([
    ...input.changedFiles,
    ...input.contract.allowedScope.readPaths,
    ...input.contract.allowedScope.writePaths,
  ]);
  const relativePaths = directories.flatMap((directory) => DEFAULT_INSTRUCTION_FILENAMES.map((filename) =>
    directory === "." ? filename : `${directory}/${filename}`,
  ));
  const readContext = await kernelContextForTask(
    input.taskId,
    input.turnId,
    [CapabilityOperationProto.CAPABILITY_OPERATION_READ],
    relativePaths,
  );
  const contentByPath = new Map<string, string>();
  const sourceVersionByPath = new Map<string, string>();
  const absolutePath = (relativePath: string): string =>
    rootPath === "/" ? `/${relativePath}` : `${rootPath}/${relativePath}`;

  for (const relativePath of relativePaths) {
    if (input.signal.aborted) throw new ToolAbortedError();
    try {
      const response = await input.clients.files.Read({
        context: {
          ...readContext,
          requestId: randomUUID(),
          idempotencyKey: `instruction:${input.taskId}:${relativePath}`,
        },
        intent: {
          userIntentRef: "repository-instruction-discovery",
          taskContractHash: input.contractHash,
          trustLabel: "trusted",
          confidentialityLabel: "workspace",
          taintSources: [],
          policyProfileId: "secure-local-default",
          expectedEffectClass: "read_local",
        },
        path: { workspaceId: input.workspaceId, relativePath },
        mode: "full",
        ranges: [],
        symbols: [],
        maxBytes: DEFAULT_MAX_INSTRUCTION_BYTES,
        expectedSha256: "",
      });
      if (input.signal.aborted) throw new ToolAbortedError();
      const sourceVersion = response.sourceVersion?.sha256;
      if (sourceVersion === undefined || sourceVersion.length === 0) continue;
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(response.modelProjectionUtf8);
      } catch {
        continue;
      }
      if (response.truncated) {
        content += `\n\n[TRUNCATION: Project instruction file exceeded ${DEFAULT_MAX_INSTRUCTION_BYTES} bytes; remaining content elided]\n`;
      }
      const path = absolutePath(relativePath);
      contentByPath.set(path, content);
      sourceVersionByPath.set(path, sourceVersion);
    } catch (error: unknown) {
      if (input.signal.aborted) throw new ToolAbortedError();
      // A missing instruction at a candidate path is normal. The applicable
      // set is assembled from successful kernel reads only.
    }
  }

  const discoveredByPath = new Map<string, DiscoveredInstruction>();
  for (const directory of directories) {
    const workingDirectory = directory === "." ? rootPath : `${rootPath}/${directory}`;
    const discovered = discoverInstructions(
      {
        workspaceRoot: rootPath,
        workingDirectory,
        filenames: DEFAULT_INSTRUCTION_FILENAMES,
        maxDepth: directory === "." ? 0 : directory.split("/").length,
        maxBytes: DEFAULT_MAX_INSTRUCTION_BYTES,
      },
      (path) => contentByPath.get(path) ?? null,
    );
    for (const instruction of discovered) {
      const sourceVersion = sourceVersionByPath.get(instruction.path);
      if (sourceVersion === undefined) continue;
      const directoryDepth = instruction.directory === "/"
        ? 0
        : instruction.directory.split("/").filter((segment) => segment.length > 0).length;
      const filenameIndex = DEFAULT_INSTRUCTION_FILENAMES.indexOf(instruction.filename as typeof DEFAULT_INSTRUCTION_FILENAMES[number]);
      const precedence = directoryDepth * 100 + DEFAULT_INSTRUCTION_FILENAMES.length - filenameIndex;
      const normalized = { ...instruction, precedence, sourceVersion } satisfies DiscoveredInstruction;
      const prior = discoveredByPath.get(instruction.path);
      if (prior === undefined || normalized.precedence > prior.precedence) {
        discoveredByPath.set(instruction.path, normalized);
      }
    }
  }

  return instructionsToFragments({
    instructions: [...discoveredByPath.values()].sort((left, right) => right.precedence - left.precedence || left.path.localeCompare(right.path)),
    observedAt: input.observedAt,
    workspaceId: input.workspaceId as Uuid7,
    sessionId: input.sessionId as Uuid7,
    taskId: input.taskId as Uuid7,
    modelKey: input.modelKey,
  });
}

interface RepositoryDiscoverySignals {
  readonly repositoryMap: RepositoryMapObservation | null;
  readonly verificationRepositoryMap: RepositoryMapVerificationSignal | undefined;
  readonly nativeTestCommands: readonly string[];
  readonly nativeRecipeSources: readonly string[];
  readonly nativeRecipeSourceVersions: readonly string[];
  readonly observedConfigPaths: readonly string[];
  readonly unavailableConfigPaths: readonly string[];
  /** Concrete command per verification runner role, derived from the reads. */
  readonly verificationRunners: VerificationRunnerCatalog;
}

interface RepositorySignalDiscoveryInput {
  readonly clients: KernelUdsClients;
  readonly codeIntelContext: RequestContext;
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly contractHash: string;
  /** The task contract's read scope; the discovery token is minted inside it. */
  readonly readPaths: readonly string[];
  readonly signal: AbortSignal;
}

const SOURCE_VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const REPOSITORY_MAP_PAGE_SIZE = 200;
const REPOSITORY_MAP_MAX_PAGES = 64;
// Superseded by the token budget in `selectTaskScopedRepositoryMap`: an entry
// count is the wrong unit when one line can be a bare path or a symbol list.
const REPOSITORY_MAP_CONTEXT_ENTRY_LIMIT = 200;

function repositoryMapVerificationSignal(
  observation: RepositoryMapObservation,
): RepositoryMapVerificationSignal {
  return {
    sourceVersion: observation.indexRevision,
    entryCount: observation.entries.length,
    totalEntryCount: observation.totalEntries,
    omittedEntries: Math.max(0, observation.totalEntries - observation.entries.length),
    continuationToken: observation.continuationToken,
    paths: observation.entries.map((entry) => entry.path),
  };
}

/** Read repository metadata and the bounded semantic map through the kernel. */
async function discoverRepositorySignals(
  input: RepositorySignalDiscoveryInput,
): Promise<RepositoryDiscoverySignals> {
  if (input.signal.aborted) throw new ToolAbortedError();
  const unavailableConfigPaths = new Set<string>(REPOSITORY_SIGNAL_PATHS);
  const observations: RepositoryFileObservation[] = [];
  let readContext: RequestContext | null = null;
  try {
    readContext = await kernelTaskContext({
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      workspaceId: input.workspaceId,
      operationClasses: [CapabilityOperationProto.CAPABILITY_OPERATION_READ],
      // Without this the token carried the no-workspace-effect sentinel, every
      // config-file read was "capability token scope exceeded", and the H3
      // runner catalog was empty on every live turn — verification reported
      // "no test runner detected" for repositories that had one.
      workspacePaths: leastWorkspaceScope(input.readPaths),
    });
  } catch {
    // A narrow task contract may not authorize repository metadata. Preserve
    // that fact as unavailable instead of widening the capability scope.
  }
  if (readContext !== null) {
    for (const relativePath of REPOSITORY_SIGNAL_PATHS) {
      if (input.signal.aborted) throw new ToolAbortedError();
      try {
        const response = await input.clients.files.Read({
          context: {
            ...readContext,
            requestId: randomUUID(),
            idempotencyKey: `repository-signal:${input.taskId}:${relativePath}`,
          },
          intent: {
            userIntentRef: "repository-signal-discovery",
            taskContractHash: input.contractHash,
            trustLabel: "derived",
            confidentialityLabel: "workspace",
            taintSources: [],
            policyProfileId: "secure-local-default",
            expectedEffectClass: "read_local",
          },
          path: { workspaceId: input.workspaceId, relativePath },
          mode: "full",
          ranges: [],
          symbols: [],
          maxBytes: 64 * 1_024,
          expectedSha256: "",
        });
        if (response.truncated) continue;
        const sourceVersion = response.sourceVersion?.sha256;
        if (sourceVersion === undefined || !SOURCE_VERSION_PATTERN.test(sourceVersion)) continue;
        const content = new TextDecoder("utf-8", { fatal: false }).decode(response.modelProjectionUtf8);
        observations.push({ path: relativePath, content, sourceVersion });
        unavailableConfigPaths.delete(relativePath);
      } catch (error: unknown) {
        if (input.signal.aborted) throw new ToolAbortedError();
        // Missing, denied, or unreadable metadata is an explicit unavailable
        // observation. No guessed recipe is emitted for it.
      }
    }
  }

  const nativeRecipes = discoverNativeTestRecipes(observations);
  let repositoryMap: RepositoryMapObservation | null = null;
  try {
    repositoryMap = await readCompleteRepositoryMap({
      maxPages: REPOSITORY_MAP_MAX_PAGES,
      readPage: async (continuationToken, pageNumber) => {
        if (input.signal.aborted) throw new ToolAbortedError();
        const response = await input.clients.codeIntel.Map({
          context: {
            ...input.codeIntelContext,
            requestId: randomUUID(),
            idempotencyKey: `repository-map:${input.taskId}:${input.turnId}:${pageNumber}`,
          },
          workspaceId: input.workspaceId,
          limit: REPOSITORY_MAP_PAGE_SIZE,
          continuation: continuationToken,
        });
        if (input.signal.aborted) throw new ToolAbortedError();
        return {
          entries: response.entries,
          indexRevision: response.indexRevision,
          totalEntries: response.totalEntries,
          truncated: response.truncated,
          continuationToken: response.continuation ?? null,
        };
      },
    });
  } catch (error: unknown) {
    if (error instanceof ToolAbortedError) throw error;
    // Map retrieval is advisory context. A failed or malformed response is
    // represented as unavailable; no stale or partial map enters the prompt.
  }

  return {
    repositoryMap,
    verificationRepositoryMap: repositoryMap === null
      ? undefined
      : repositoryMapVerificationSignal(repositoryMap),
    nativeTestCommands: nativeRecipes.nativeTestCommands,
    nativeRecipeSources: nativeRecipes.nativeRecipeSources,
    nativeRecipeSourceVersions: nativeRecipes.nativeRecipeSourceVersions,
    observedConfigPaths: observations.map((observation) => observation.path).sort(),
    unavailableConfigPaths: [...unavailableConfigPaths].sort(),
    verificationRunners: discoverVerificationRunners(observations),
  };
}

/** Kernel-backed code-intelligence retrieval for the live compiler path. */
function kernelRetrievalPipeline(
  clients: KernelUdsClients,
  buildContext: () => Promise<RequestContext>,
  observedAt: Rfc3339Timestamp,
  modelKey: ModelKey,
  sessionId: string,
  taskId: string,
  workspaceId: string,
  repositoryMap: RepositoryMapObservation | null,
  /** The task contract's allowed scope; ranks the repository map. */
  allowedScope: { readonly readPaths: readonly string[]; readonly writePaths: readonly string[] }
    = { readPaths: [], writePaths: [] },
): RetrievalPipeline {
  const fileReader: WorkspaceFileReader = async ({ path, startLine, endLine }) => {
    try {
      const baseContext = await buildContext();
      const read = await clients.files.Read({
        context: {
          ...baseContext,
          requestId: randomUUID(),
          idempotencyKey: `code-hydrate:${randomUUID()}`,
        },
        intent: {
          userIntentRef: "retrieval-hydration",
          taskContractHash: "",
          trustLabel: "derived",
          confidentialityLabel: "workspace",
          taintSources: [],
          policyProfileId: "secure-local-default",
          expectedEffectClass: "read_local",
        },
        path: { workspaceId, relativePath: path },
        mode: "ranges",
        ranges: [{ startLine, endLine }],
        symbols: [],
        maxBytes: 48 * 1_024,
        expectedSha256: "",
      });
      return {
        content: new TextDecoder("utf-8", { fatal: false }).decode(read.modelProjectionUtf8),
        fileSha256: read.sourceVersion?.sha256 ?? null,
        totalLines: null,
      };
    } catch {
      // File unreadable (deleted/moved/unreadable since indexing): the
      // caller falls back to the metadata-only representation.
      return { content: null, fileSha256: null, totalLines: null };
    }
  };
  const repositoryMapFragment = repositoryMap === null || repositoryMap.entries.length === 0
    ? null
    : (() => {
        // Task-scoped and token-capped: files the contract may write come
        // first, then files it may read, then the rest of the index — and the
        // whole fragment stops at REPOSITORY_MAP_TOKEN_BUDGET instead of the
        // 16-18k tokens the alphabetically-first 200 files used to cost.
        const selection = selectTaskScopedRepositoryMap(
          repositoryMap.entries
            .slice(0, REPOSITORY_MAP_CONTEXT_ENTRY_LIMIT * 8)
            .map((entry) => ({ path: entry.path, symbols: entry.symbols })),
          { readPaths: allowedScope.readPaths, writePaths: allowedScope.writePaths },
        );
        const entries = selection.entries;
        const rendered = buildRepositoryMapFragment(entries, {
          maxEntries: entries.length,
          omittedEntries: Math.max(0, repositoryMap.entries.length - entries.length),
          continuationToken: repositoryMap.continuationToken,
          title: "Kernel repository map",
        });
        const hash = computeContentHash(rendered.text);
        const bytes = new TextEncoder().encode(rendered.text).byteLength;
        const pathPatterns = entries.map((entry) => entry.path);
        const fragment: ContextFragment = {
          id: `kernel-repository-map:${hash}`,
          kind: "code",
          contentRef: {
            hash,
            uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ContextFragment["contentRef"]["uri"],
            mediaType: "text/plain",
            bytes: BigInt(bytes) as ContextFragment["contentRef"]["bytes"],
          },
          textContent: rendered.text,
          source: {
            uri: `workspace://${workspaceId}/repository-map`,
            producer: "terminus-kernel-code-intel",
            producerVersion: "v1",
            observedAt,
            observedBy: "kernel",
            evidenceRefs: [],
          },
          sourceVersion: repositoryMap.indexRevision,
          authority: 55,
          priority: 60,
          trust: "derived",
          confidentiality: "workspace",
          injectionRisk: "low",
          exactness: "semantics_preserving",
          scope: {
            workspaceId: workspaceId as ContextFragment["scope"]["workspaceId"],
            sessionId: sessionId as ContextFragment["scope"]["sessionId"],
            taskId: taskId as ContextFragment["scope"]["taskId"],
            pathPatterns,
          },
          freshness: {
            observedAt,
            sourceVersion: repositoryMap.indexRevision,
            stale: false,
            staleReason: null,
          },
          dependencies: [],
          invalidation: [{ kind: "file_changed", selector: `workspace://${workspaceId}` }],
          estimatedTokens: { [modelKey]: Math.max(1, Math.ceil(rendered.text.length / 4)) },
          selectionFeatures: {
            relevance: 0.65,
            novelty: 0.9,
            coverage: 0.95,
            uncertaintyReduction: 0.85,
            riskReduction: 0.55,
            modelCompatibility: 1,
            redundancyPenalty: 0,
            injectionPenalty: 0,
          },
        };
        return fragment;
      })();
  const retrieve = async (queries: readonly RetrievalQuery[]): Promise<readonly RetrievalResult[]> => {
    const results: RetrievalResult[] = repositoryMapFragment === null
      ? []
      : [{
          fragment: repositoryMapFragment,
          method: "semantic",
          rawScore: 0.8,
          rerankedScore: 0.8,
          sourceVersion: repositoryMapFragment.sourceVersion,
          reason: "kernel repository map",
        }];
    const seen = new Set<string>();
    for (const query of queries) {
      const baseContext = await buildContext();
      const response = await clients.codeIntel.Search({
        context: {
          ...baseContext,
          requestId: randomUUID(),
          idempotencyKey: `code-search:${randomUUID()}`,
        },
        workspaceId,
        query: query.text,
        limit: 5,
      });
      if (response.truncated) {
        throw new Error(
          `code-intelligence retrieval truncated for query ${JSON.stringify(query.text)}${response.continuation === undefined ? " without a continuation token" : "; continuation RPC is unavailable"}`,
        );
      }
      for (const hit of response.results) {
        const id = `kernel-code:${hit.path}:${hit.line}:${hit.symbol}`;
        if (seen.has(id)) continue;
        seen.add(id);
        // Hydrate the hit into an actual source span before labeling it as
        // code context (deep-audit Rank 1 / PR3). Metadata-only fallback
        // preserves navigation value when the file cannot be read.
        const searchHit: SearchHit = {
          path: hit.path,
          line: hit.line,
          symbol: typeof hit.symbol === "string" && hit.symbol.length > 0 ? hit.symbol : null,
          method: hit.method,
        };
        const hydratedSpan = await hydrateSearchHit(searchHit, fileReader);
        const text = hydratedSpan?.fragmentText ?? [
          `# Code intelligence result`,
          `path: ${hit.path}`,
          `line: ${hit.line}`,
          `symbol: ${hit.symbol}`,
          `index method: ${hit.method}`,
          `(source span unavailable — request read for implementation)`,
        ].join("\n");
        const hash = computeContentHash(text);
        const fragment: ContextFragment = {
          id,
          kind: "code",
          contentRef: {
            hash,
            uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ContextFragment["contentRef"]["uri"],
            mediaType: "text/plain",
            bytes: BigInt(new TextEncoder().encode(text).byteLength) as ContextFragment["contentRef"]["bytes"],
          },
          textContent: text,
          source: {
            uri: `workspace://${hit.path}`,
            producer: "terminus-kernel-code-intel",
            producerVersion: "v1",
            observedAt,
            observedBy: "kernel",
            evidenceRefs: [],
          },
          sourceVersion: null,
          authority: 55,
          priority: 55,
          trust: "derived",
          confidentiality: "workspace",
          injectionRisk: "low",
          exactness: "recoverable_by_reference",
          scope: {
            workspaceId: null,
            sessionId: sessionId as ContextFragment["scope"]["sessionId"],
            taskId: taskId as ContextFragment["scope"]["taskId"],
            pathPatterns: [hit.path],
          },
          freshness: { observedAt, sourceVersion: null, stale: false, staleReason: null },
          dependencies: [],
          invalidation: [{ kind: "file_changed", selector: hit.path }],
          estimatedTokens: { [modelKey]: Math.max(1, Math.ceil(text.length / 4)) },
          selectionFeatures: {
            relevance: query.suggestedMethods.includes(mapRetrievalMethod(hit.method)) ? 0.9 : 0.6,
            novelty: 0.7,
            coverage: 0.8,
            uncertaintyReduction: 0.7,
            riskReduction: 0.5,
            modelCompatibility: 1,
            redundancyPenalty: 0,
            injectionPenalty: 0,
          },
        };
        results.push({
          fragment,
          method: mapRetrievalMethod(hit.method),
          rawScore: 1,
          rerankedScore: 1,
          sourceVersion: hydratedSpan?.fileSha256 ?? null,
          reason: query.reason,
        });
      }
    }
    return results;
  };
  return {
    retrieve: (queries) => retrieve(queries),
    expandForGaps: (gaps) => retrieve(gaps.map((gap) => ({
      text: gap.requirement,
      reason: `evidence gap: ${gap.requirementId}`,
      suggestedMethods: ["lexical_bm25"],
    }))),
  };
}

function mapRetrievalMethod(method: string): RetrievalMethod {
  switch (method) {
    case "tree_sitter":
    case "lsp":
    case "graph":
      return method === "graph" ? "dependency_graph" : method;
    case "lexical_bm25":
      return method;
    default:
      return "lexical_bm25";
  }
}

interface AgentTaskTransition {
  readonly taskId: string;
  readonly expectedStatuses: readonly string[];
  readonly status: string;
  readonly phase: string;
  readonly completedAt: Date | null;
  readonly terminalReasonJson: string | null;
  readonly verificationPlanId?: string | null;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

async function transitionAgentTask(input: AgentTaskTransition): Promise<boolean> {
  return mutateAgentState(async () => {
    const current = await db.task.findUnique({
      where: { id: input.taskId },
      select: { status: true },
    });
    if (current === null || !input.expectedStatuses.includes(current.status)) return false;
    await emit({
      eventType: input.eventType,
      aggregateType: "task",
      aggregateId: input.taskId,
      correlationId: input.taskId,
      payload: input.payload,
    }, async (tx) => {
      const update = await tx.task.updateMany({
        where: { id: input.taskId, status: { in: [...input.expectedStatuses] } },
        data: {
          status: input.status,
          phase: input.phase,
          completedAt: input.completedAt,
          terminalReasonJson: input.terminalReasonJson,
          ...(input.verificationPlanId === undefined
            ? {}
            : { verificationPlanId: input.verificationPlanId }),
        },
      });
      if (update.count !== 1) throw new Error(`task ${input.taskId} changed during agent transition`);
    });
    await synchronizeV1TaskProjection(input.taskId, input.eventType);
    return true;
  });
}

// ───────────────── Gateway model discovery (H4) ─────────────────────────────
//
// Discovery used to live only in process memory, warmed only by
// `GET /v1/provider-models`. A restarted control plane therefore denied every
// turn with "configured gateway model <id> has no admitted discovery record"
// until a client happened to open the model picker. Three changes fix that:
// the last successful result is durable, the process warms it at startup, and
// a turn that still finds nothing discovers once on demand rather than failing.

interface GatewayDiscoveryCredential {
  readonly deployment: GatewayDeployment;
  /** Empty string means the explicitly anonymous free-Zen path. */
  readonly secretUri: string;
}

/**
 * The credential a discovery call must use, or null when the gateway is not
 * usable at all. A free Zen model with no credential is a supported anonymous
 * configuration, not a misconfiguration.
 */
function gatewayDiscoveryCredential(row: {
  readonly deployment: string;
  readonly freeModel: boolean;
  readonly credentialConfigured: boolean;
}): GatewayDiscoveryCredential | null {
  const deployment: GatewayDeployment = row.deployment === "go" ? "go" : "zen";
  const anonymousZenFree = deployment === "zen" && row.freeModel && !row.credentialConfigured;
  if (!row.credentialConfigured && !anonymousZenFree) return null;
  return { deployment, secretUri: anonymousZenFree ? "" : gatewaySecretUri(deployment) };
}

async function loadPersistedProviderModels(
  deployment: GatewayDeployment,
): Promise<ProviderModelsResult | null> {
  const row = await db.providerModelDiscovery.findUnique({ where: { deployment } });
  if (row === null) return null;
  const parsed = parseProviderModelsResult(row.resultJson);
  if (parsed === null) {
    console.warn(`[terminus-control] persisted model discovery for ${deployment} is unreadable; ignoring it`);
    return null;
  }
  restoreProviderModels(parsed);
  return parsed;
}

async function discoverAndPersistProviderModels(
  credential: GatewayDiscoveryCredential,
  signal?: AbortSignal | null,
): Promise<ProviderModelsResult> {
  const context = await kernelBrokerContext();
  const result = await discoverProviderModels({
    client: new KernelGatewayClient(requireKernelUds().connectors, context),
    deployment: credential.deployment,
    secretUri: credential.secretUri,
    observedAt: now(),
    ...(signal === undefined || signal === null ? {} : { signal }),
  });
  rememberProviderModels(result, Date.now());
  const resultJson = providerModelsResultJson(result);
  await writerTransaction((tx) => tx.providerModelDiscovery.upsert({
    where: { deployment: credential.deployment },
    create: {
      deployment: credential.deployment,
      resultJson,
      modelCount: result.models.length,
      observedAt: result.observedAt,
    },
    update: { resultJson, modelCount: result.models.length, observedAt: result.observedAt },
  }));
  return result;
}

/** One on-demand discovery per deployment per process, so a turn cannot loop. */
const onDemandDiscoveryAttempted = new Set<string>();

/**
 * Resolve the admitted discovery record for a gateway model without failing the
 * turn for a cold cache: memory → durable row → one bounded live discovery.
 * Returns null only when the model is genuinely not admitted.
 */
async function admittedGatewayModelRecord(
  credential: GatewayDiscoveryCredential,
  modelId: string,
  signal?: AbortSignal | null,
): Promise<GatewayModel | null> {
  const fromCache = describeConfiguredModel(credential.deployment, modelId);
  if (fromCache !== null) return fromCache;
  const persisted = await loadPersistedProviderModels(credential.deployment);
  const fromDisk = persisted?.models.find((model) => model.id === modelId) ?? null;
  if (fromDisk !== null) return fromDisk;
  const attemptKey = `${credential.deployment}:${modelId}`;
  if (onDemandDiscoveryAttempted.has(attemptKey)) return null;
  onDemandDiscoveryAttempted.add(attemptKey);
  try {
    const discovered = await discoverAndPersistProviderModels(credential, signal);
    return discovered.models.find((model) => model.id === modelId) ?? null;
  } catch (error: unknown) {
    console.warn(
      `[terminus-control] on-demand model discovery for ${modelId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** The model ids this account may currently use, for a denial's details. */
async function admittedGatewayModelIds(
  credential: GatewayDiscoveryCredential,
): Promise<readonly string[]> {
  const known = lastProviderModels(credential.deployment)
    ?? await loadPersistedProviderModels(credential.deployment);
  return (known?.models ?? []).map((model) => model.id).sort();
}

/**
 * Warm discovery after the listener binds. Bounded retries with backoff: a
 * gateway that is briefly unreachable at boot must not leave the process
 * permanently unable to route a turn.
 */
async function warmProviderModelDiscovery(): Promise<void> {
  const row = await db.gatewayProviderConfiguration.findUnique({
    where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
  });
  if (row === null) return;
  const credential = gatewayDiscoveryCredential(row);
  if (credential === null) return;
  const persisted = await loadPersistedProviderModels(credential.deployment);
  if (persisted !== null) {
    console.log(
      `[terminus-control] restored ${persisted.models.length} discovered ${credential.deployment} model(s) observed at ${persisted.observedAt}`,
    );
  }
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await discoverAndPersistProviderModels(credential);
      console.log(
        `[terminus-control] warmed model discovery: ${result.models.length} ${credential.deployment} model(s)`,
      );
      return;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === attempts) {
        console.warn(
          `[terminus-control] model discovery warm-up failed after ${attempts} attempt(s): ${message}`,
        );
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000 * 2 ** (attempt - 1)));
    }
  }
}

// ───────────────── Connected provider accounts ──────────────────────────────
//
// Routing used to be a fixed chain: vendor-direct environment configuration,
// else the singleton gateway row, else a local command. A machine that already
// held a ChatGPT login and an OpenCode auth store could reach exactly one of
// them. Each usable credential is now a `provider_accounts` row, and a turn
// names the account it runs on.
//
// Nothing here ever sees credential material. The kernel reports identity, a
// fingerprint, and non-secret metadata; it imports the bytes straight into the
// OS keyring under `secret://provider-account/<uuid-v7>`, and every request
// hands the connector that opaque URI.

/** What the last discovery run observed, for `GET /v1/provider-accounts`. */
let lastProviderAccountDiscovery: {
  readonly lastRunAt: string;
  readonly codexInstalled: boolean;
  readonly opencodeInstalled: boolean;
  readonly warnings: readonly string[];
  readonly opencodeStoreStatus: "available" | "missing" | "rejected" | "unavailable";
} | null = null;

function localStoreStatus(
  value: OpencodeStoreStatusProto,
): "available" | "missing" | "rejected" | "unavailable" {
  switch (value) {
    case OpencodeStoreStatusProto.OPENCODE_STORE_STATUS_AVAILABLE:
      return "available";
    case OpencodeStoreStatusProto.OPENCODE_STORE_STATUS_MISSING:
      return "missing";
    case OpencodeStoreStatusProto.OPENCODE_STORE_STATUS_REJECTED:
      return "rejected";
    case OpencodeStoreStatusProto.OPENCODE_STORE_STATUS_UNAVAILABLE:
    case OpencodeStoreStatusProto.OPENCODE_STORE_STATUS_UNSPECIFIED:
    case OpencodeStoreStatusProto.UNRECOGNIZED:
      return "unavailable";
  }
}

async function listProviderAccountRecords(): Promise<readonly ProviderAccountRecord[]> {
  return db.providerAccount.findMany({ orderBy: [{ displayName: "asc" }, { source: "asc" }] });
}

function providerAccountColumns(input: ProviderAccountUpsert) {
  return {
    displayName: input.displayName,
    vendorId: input.vendorId,
    authKind: input.authKind,
    credentialUri: input.credentialUri,
    fingerprint: input.fingerprint,
    baseUrl: input.baseUrl,
    catalogDigest: input.catalogDigest,
    credentialFingerprint: input.credentialFingerprint,
    approvedBaseUrl: input.approvedBaseUrl,
    approvedCatalogDigest: input.approvedCatalogDigest,
    secretState: input.secretState,
    secretOperationId: input.secretOperationId,
    host: input.host,
    protocol: input.protocol,
    connectorId: input.connectorId,
    renderProfile: input.renderProfile,
    status: input.status,
    statusDetail: input.statusDetail,
    billing: input.billing,
    metadataJson: input.metadataJson,
    expiresAt: input.expiresAt,
  };
}

/**
 * Create the account for a source, or update the one that exists.
 *
 * `revision` moves only when something actually changed, so a discovery run
 * that finds nothing new does not invalidate every client's optimistic
 * concurrency token. `isDefault` is never touched here: it is a user decision.
 */
async function upsertProviderAccountRecord(input: ProviderAccountUpsert): Promise<ProviderAccountRecord> {
  const columns = providerAccountColumns(input);
  return writerTransaction(async (tx) => {
    const current = await tx.providerAccount.findUnique({ where: { source: input.source } });
    if (current === null) {
      return tx.providerAccount.create({
        data: {
          id: input.id,
          source: input.source,
          ...columns,
          discoveredAt: input.discoveredAt,
          isDefault: false,
          revision: 1,
        },
      });
    }
    const unchanged = (Object.keys(columns) as (keyof typeof columns)[]).every((key) => {
      const next = columns[key];
      const previous = current[key];
      if (next instanceof Date || previous instanceof Date) {
        return (next instanceof Date ? next.getTime() : null) === (previous instanceof Date ? previous.getTime() : null);
      }
      return next === previous;
    });
    if (unchanged) return current;
    return tx.providerAccount.update({
      where: { id: current.id },
      data: { ...columns, revision: { increment: 1 } },
    });
  });
}

/**
 * Replace a row only if every security-relevant field still matches the
 * caller's snapshot. External keyring effects are always bracketed by this
 * CAS so stale discovery cannot overwrite a newly imported credential.
 */
async function reconcileProviderAccountRecord(
  input: ProviderAccountUpsert,
  expected: ProviderAccountSecuritySnapshot,
): Promise<ProviderAccountRecord | null> {
  const columns = providerAccountColumns(input);
  return writerTransaction(async (tx) => {
    const updated = await tx.providerAccount.updateMany({
      where: {
        id: expected.id,
        source: input.source,
        revision: expected.revision,
        fingerprint: expected.fingerprint,
        credentialUri: expected.credentialUri,
        secretState: expected.secretState,
        secretOperationId: expected.secretOperationId,
      },
      data: { ...columns, revision: { increment: 1 } },
    });
    if (updated.count !== 1) return null;
    return tx.providerAccount.findUnique({ where: { id: expected.id } });
  });
}

function providerAccountUpsertFromRecord(
  account: ProviderAccountRecord,
  changes: Partial<Pick<
    ProviderAccountUpsert,
    | "credentialUri"
    | "fingerprint"
    | "baseUrl"
    | "catalogDigest"
    | "credentialFingerprint"
    | "approvedBaseUrl"
    | "approvedCatalogDigest"
    | "secretState"
    | "secretOperationId"
    | "status"
    | "statusDetail"
    | "metadataJson"
    | "host"
    | "connectorId"
    | "renderProfile"
  >>,
): ProviderAccountUpsert {
  return {
    id: account.id,
    source: account.source,
    displayName: account.displayName,
    vendorId: account.vendorId,
    authKind: account.authKind,
    credentialUri: changes.credentialUri ?? account.credentialUri,
    fingerprint: changes.fingerprint ?? account.fingerprint,
    baseUrl: changes.baseUrl ?? account.baseUrl,
    catalogDigest: changes.catalogDigest ?? account.catalogDigest,
    credentialFingerprint: changes.credentialFingerprint ?? account.credentialFingerprint,
    approvedBaseUrl: changes.approvedBaseUrl ?? account.approvedBaseUrl,
    approvedCatalogDigest: changes.approvedCatalogDigest ?? account.approvedCatalogDigest,
    secretState: changes.secretState ?? providerAccountSecuritySnapshot(account).secretState,
    secretOperationId: changes.secretOperationId ?? account.secretOperationId,
    host: changes.host ?? account.host,
    protocol: account.protocol,
    connectorId: changes.connectorId ?? account.connectorId,
    renderProfile: changes.renderProfile ?? account.renderProfile,
    status: changes.status ?? account.status,
    statusDetail: changes.statusDetail ?? account.statusDetail,
    billing: account.billing,
    metadataJson: changes.metadataJson ?? account.metadataJson,
    discoveredAt: account.discoveredAt,
    expiresAt: account.expiresAt,
  };
}

async function claimProviderAccountImport(
  account: ProviderAccountRecord,
  claim: {
    readonly capabilityUri: string;
    readonly operationId: string;
    readonly credentialFingerprint: string;
    readonly approvedBaseUrl: string;
    readonly approvedCatalogDigest: string;
  },
): Promise<ProviderAccountRecord | null> {
  return reconcileProviderAccountRecord(providerAccountUpsertFromRecord(account, {
    credentialUri: claim.capabilityUri,
    credentialFingerprint: claim.credentialFingerprint,
    approvedBaseUrl: claim.approvedBaseUrl,
    approvedCatalogDigest: claim.approvedCatalogDigest,
    secretState: "import_pending",
    secretOperationId: claim.operationId,
    status: "error",
    statusDetail: "Credential import settlement is pending; routing is disabled.",
  }), providerAccountSecuritySnapshot(account));
}

async function finalizeProviderAccountImport(
  claimed: ProviderAccountRecord,
): Promise<ProviderAccountRecord | null> {
  return reconcileProviderAccountRecord(providerAccountUpsertFromRecord(claimed, {
    secretState: "bound",
    secretOperationId: "",
    status: "connected",
    statusDetail: "",
  }), providerAccountSecuritySnapshot(claimed));
}

async function markProviderAccountImportForCleanup(
  claimed: ProviderAccountRecord,
): Promise<ProviderAccountRecord | null> {
  return reconcileProviderAccountRecord(providerAccountUpsertFromRecord(claimed, {
    secretState: "revoke_pending",
    status: "error",
    statusDetail: "Credential import could not be settled; keyring cleanup is pending.",
  }), providerAccountSecuritySnapshot(claimed));
}

const PROVIDER_ACCOUNT_SECRET_URI = /^secret:\/\/provider-account\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function inspectProviderCredential(
  credentialUri: string,
): Promise<"present" | "missing" | "unavailable"> {
  const inspected = await requireKernelUds().secrets.Inspect({
    context: await kernelMaintenanceContext(),
    capabilityUri: credentialUri,
  });
  if (inspected.capabilityUri !== credentialUri) {
    throw new Error("kernel returned secret inspection for a different capability");
  }
  switch (inspected.presence) {
    case SecretPresenceProto.SECRET_PRESENCE_PRESENT:
      return "present";
    case SecretPresenceProto.SECRET_PRESENCE_MISSING:
      return "missing";
    case SecretPresenceProto.SECRET_PRESENCE_UNAVAILABLE:
    case SecretPresenceProto.SECRET_PRESENCE_UNSPECIFIED:
    case SecretPresenceProto.UNRECOGNIZED:
      return "unavailable";
  }
}

async function deleteProviderCredentialUri(
  credentialUri: string,
  operationId: string,
): Promise<boolean> {
  const deleted = await requireKernelUds().secrets.Delete({
    context: {
      ...await kernelMaintenanceContext(),
      idempotencyKey: `provider-account-cleanup:${operationId}:${credentialUri}`,
    },
    capabilityUri: credentialUri,
  });
  return !deleted.stored && deleted.capabilityUri === credentialUri;
}

async function deleteOwnedProviderCredential(account: ProviderAccountRecord): Promise<boolean> {
  if (account.credentialUri === "") return true;
  // A legacy row may point at the original tool-owned store. Sever that stale
  // reference, but never ask the kernel to delete material Terminus did not
  // import into its provider-account namespace.
  if (!PROVIDER_ACCOUNT_SECRET_URI.test(account.credentialUri)) return true;
  try {
    return await deleteProviderCredentialUri(account.credentialUri, account.secretOperationId);
  } catch (error: unknown) {
    console.warn(`[terminus-control] provider credential cleanup remains pending: ${String(error)}`);
    return false;
  }
}

async function settleProviderAccountCleanup(
  initial: ProviderAccountRecord,
): Promise<ProviderAccountRecord> {
  return settleProviderAccountSecretCleanup({
    account: initial,
    markRevokePending: async (pending) => reconcileProviderAccountRecord(providerAccountUpsertFromRecord(pending, {
      secretState: "revoke_pending",
      secretOperationId: pending.secretOperationId || uuidV7(),
      status: "error",
      statusDetail: "Credential cleanup is pending; routing is disabled.",
      metadataJson: canonicalMetadataForAccount(pending.source, pending.metadataJson),
    }), providerAccountSecuritySnapshot(pending)),
    revokeCredential: (credentialUri, pending) => deleteOwnedProviderCredential({
      ...pending,
      credentialUri,
    }),
    finalize: async (pending) => reconcileProviderAccountRecord(providerAccountUpsertFromRecord(pending, {
      credentialUri: "",
      credentialFingerprint: "",
      approvedBaseUrl: "",
      approvedCatalogDigest: "",
      secretState: "none",
      secretOperationId: "",
      status: "disconnected",
      statusDetail: "Credential cleanup completed; connect again to approve the current credential and destination.",
      metadataJson: canonicalMetadataForAccount(pending.source, pending.metadataJson),
    }), providerAccountSecuritySnapshot(pending)),
  });
}

/** Recover durable import/delete operations and scrub pre-hardening residue. */
async function recoverProviderAccountSecretState(): Promise<void> {
  const rows = await listProviderAccountRecords();
  for (const row of rows) {
    const legacyCopiedCredential = row.secretState === "none"
      && row.credentialUri !== ""
      && (row.source === "codex-chatgpt" || row.source.startsWith("opencode:"));
    const legacyOrphan = row.secretState === "none"
      && row.credentialUri === ""
      && (row.source === "codex-chatgpt" || row.source.startsWith("opencode:"));
    if (legacyOrphan) {
      try {
        const recovered = await recoverLegacyProviderAccountCredential({
          accountId: row.id,
          inspect: inspectProviderCredential,
          revoke: (credentialUri) => deleteProviderCredentialUri(credentialUri, row.id),
        });
        if (!recovered) {
          console.warn(`[terminus-control] legacy provider credential cleanup remains pending for ${row.id}`);
        }
      } catch (error: unknown) {
        console.warn(`[terminus-control] legacy provider credential cleanup remains pending for ${row.id}: ${String(error)}`);
      }
    }
    if (
      row.secretState === "import_pending"
      || row.secretState === "revoke_pending"
      || legacyCopiedCredential
    ) {
      await settleProviderAccountCleanup(row);
      continue;
    }
    const metadataJson = canonicalMetadataForAccount(row.source, row.metadataJson);
    if (metadataJson !== row.metadataJson) {
      await reconcileProviderAccountRecord(providerAccountUpsertFromRecord(row, { metadataJson }), providerAccountSecuritySnapshot(row));
    }
  }
}

/**
 * Exactly one default. The partial unique index enforces it, so the previous
 * default is cleared before the new one is set rather than in one statement.
 */
async function setDefaultProviderAccountRow(accountId: string): Promise<void> {
  await writerTransaction(async (tx) => {
    await tx.providerAccount.updateMany({
      where: { isDefault: true, NOT: { id: accountId } },
      data: { isDefault: false },
    });
    await tx.providerAccount.updateMany({ where: { id: accountId }, data: { isDefault: true } });
  });
}

/** The legacy gateway row as this module reads it, or null when unconfigured. */
async function readGatewayConfigurationSnapshot(): Promise<{
  readonly deployment: string;
  readonly protocol: string;
  readonly credentialConfigured: boolean;
  readonly freeModel: boolean;
  readonly secretUri: string;
} | null> {
  const row = await db.gatewayProviderConfiguration.findUnique({
    where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
  });
  if (row === null) return null;
  return {
    deployment: row.deployment,
    protocol: row.protocol,
    credentialConfigured: row.credentialConfigured,
    freeModel: row.freeModel,
    secretUri: row.secretUri,
  };
}

/**
 * Ask the kernel what credentials this machine holds and reconcile the rows.
 *
 * Discovery is metadata-only for new credentials. It may revoke a previously
 * copied key after an authoritative logout or rotation; reconnect requires a
 * fresh, destination-bound approval in Settings.
 */
async function runProviderAccountDiscovery(): Promise<{
  readonly accounts: readonly ProviderAccountRecord[];
  readonly imported: readonly string[];
  readonly warnings: readonly string[];
  readonly codexInstalled: boolean;
  readonly opencodeInstalled: boolean;
  readonly opencodeStoreStatus: "available" | "missing" | "rejected" | "unavailable";
  readonly lastRunAt: string;
}> {
  await recoverProviderAccountSecretState();
  const result = await discoverAndConnectLocalAccounts({
    discoverLocal: async (): Promise<LocalCredentialDiscovery> => {
      const response = await requireKernelUds().providerAccounts.DiscoverLocal({
        context: {
          ...await kernelMaintenanceContext(),
          idempotencyKey: `provider-account-discover:${Date.now()}`,
        },
      });
      return {
        credentials: response.credentials.map((credential) => ({
          source: credential.source,
          authKind: credential.authKind,
          fingerprint: credential.fingerprint,
          metadataJson: credential.metadataJson,
          expiresAtUnix: Number(credential.expiresAtUnix),
          store: credential.store,
        })),
        warnings: response.warnings,
        codexInstalled: response.codexInstalled,
        opencodeInstalled: response.opencodeInstalled,
        opencodeStoreStatus: localStoreStatus(response.opencodeStoreStatus),
      };
    },
    // Metadata-only probe: `SecretService.Mint` resolves the credential in
    // whichever store the kernel is configured with and returns an opaque
    // handle plus expiry — never bytes. A row whose URI no longer resolves
    // (the kernel's secret backend changed, or the keychain entry is gone) is
    // re-imported rather than left permanently broken.
    credentialStatus: async (credentialUri: string): Promise<"present" | "missing" | "unavailable"> => {
      const inspected = await requireKernelUds().secrets.Inspect({
        context: await kernelMaintenanceContext(),
        capabilityUri: credentialUri,
      });
      if (inspected.capabilityUri !== credentialUri) {
        throw new Error("kernel returned secret inspection for a different capability");
      }
      switch (inspected.presence) {
        case SecretPresenceProto.SECRET_PRESENCE_PRESENT:
          return "present";
        case SecretPresenceProto.SECRET_PRESENCE_MISSING:
          return "missing";
        case SecretPresenceProto.SECRET_PRESENCE_UNAVAILABLE:
        case SecretPresenceProto.SECRET_PRESENCE_UNSPECIFIED:
        case SecretPresenceProto.UNRECOGNIZED:
          return "unavailable";
      }
    },
    revokeCredential: async (credentialUri: string): Promise<boolean> => {
      const deleted = await requireKernelUds().secrets.Delete({
        context: {
          ...await kernelMaintenanceContext(),
          idempotencyKey: `provider-account-discovery-revoke:${credentialUri}`,
        },
        capabilityUri: credentialUri,
      });
      return !deleted.stored && deleted.capabilityUri === credentialUri;
    },
    listAccounts: listProviderAccountRecords,
    upsertAccount: upsertProviderAccountRecord,
    reconcileAccount: reconcileProviderAccountRecord,
    readGatewayConfiguration: readGatewayConfigurationSnapshot,
    fetchCatalog: async () => ({
      ...await fetchModelsDevRaw({ forceOffline: true }),
      digest: modelsDevCatalogDigest(),
    }),
    newAccountId: () => uuidV7(),
    newOperationId: () => uuidV7(),
    warn: (message) => console.warn(`[terminus-control] ${message}`),
  });
  lastProviderAccountDiscovery = {
    lastRunAt: result.lastRunAt,
    codexInstalled: result.codexInstalled,
    opencodeInstalled: result.opencodeInstalled,
    warnings: result.warnings,
    opencodeStoreStatus: result.opencodeStoreStatus,
  };
  return result;
}

/** Import only after the HTTP connect route has validated explicit consent. */
async function connectProviderAccountWithConsent(
  account: ProviderAccountRecord,
  expectedRevision: number,
  expectedFingerprint: string,
  expectedDestination: string,
  expectedCatalogDigest: string,
): Promise<ProviderAccountRecord> {
  if (modelsDevCatalogDigest() !== expectedCatalogDigest) {
    throw new Error("provider catalog changed after approval; reload it before connecting");
  }
  const capabilityUri = providerAccountSecretUri(uuidV7());
  try {
    return await connectLocalProviderAccount({
      account,
      expectedRevision,
      expectedFingerprint,
      expectedDestination,
      expectedCatalogDigest,
      capabilityUri,
      userConsent: true,
      discoverLocal: async (): Promise<LocalCredentialDiscovery> => {
        const response = await requireKernelUds().providerAccounts.DiscoverLocal({
          context: await kernelMaintenanceContext(),
        });
        return {
          credentials: response.credentials.map((credential) => ({
            source: credential.source,
            authKind: credential.authKind,
            fingerprint: credential.fingerprint,
            metadataJson: credential.metadataJson,
            expiresAtUnix: Number(credential.expiresAtUnix),
            store: credential.store,
          })),
          warnings: response.warnings,
          codexInstalled: response.codexInstalled,
          opencodeInstalled: response.opencodeInstalled,
          opencodeStoreStatus: localStoreStatus(response.opencodeStoreStatus),
        };
      },
      importLocal: async ({ source, capabilityUri: destination, expectedFingerprint: approvedFingerprint }) => {
        const response = await requireKernelUds().providerAccounts.ImportLocal({
          context: {
            ...await kernelMaintenanceContext(),
            idempotencyKey: `provider-account-import:${destination}:${approvedFingerprint}`,
          },
          source,
          capabilityUri: destination,
          expectedFingerprint: approvedFingerprint,
        });
        return {
          capabilityUri: response.capabilityUri,
          stored: response.stored,
          fingerprint: response.credential?.fingerprint ?? "",
        };
      },
      fetchCatalog: async () => ({
        ...await fetchModelsDevRaw({ forceOffline: true }),
        digest: modelsDevCatalogDigest(),
      }),
      claimImport: claimProviderAccountImport,
      finalizeImport: finalizeProviderAccountImport,
      markImportForCleanup: markProviderAccountImportForCleanup,
      now: () => new Date(),
    });
  } catch (error: unknown) {
    const pending = await db.providerAccount.findFirst({
      where: {
        id: account.id,
        credentialUri: capabilityUri,
        secretState: { in: ["import_pending", "revoke_pending"] },
      },
    });
    if (pending !== null) {
      await settleProviderAccountCleanup(pending);
    }
    throw error;
  }
}

/**
 * The exact HTTPS surface one account may reach.
 *
 * Derived from the account's own base URL, so a connected account can never
 * widen its destination past the path prefix it was discovered with.
 */
function providerAccountEndpoint(account: ProviderAccountRecord): KernelConnectorEndpoint {
  const profile = account.renderProfile as ProviderRenderProfile;
  if (profile === "zen_gateway") return ZEN_GATEWAY_ENDPOINT;
  if (
    account.secretState !== "bound"
    || account.credentialUri === ""
    || account.credentialFingerprint !== account.fingerprint
    || account.approvedBaseUrl !== account.baseUrl
    || account.approvedCatalogDigest !== account.catalogDigest
  ) {
    throw new Error("provider account has no current approved credential and destination binding");
  }
  if (profile === "chatgpt_codex") {
    return {
      connectorId: "chatgpt-codex",
      host: CODEX_HOST,
      port: 443,
      allowedPathPrefixes: [CODEX_PATH_PREFIX],
      label: account.displayName,
    };
  }
  const base = new URL(account.approvedBaseUrl);
  const prefix = base.pathname === "/" ? "/" : `${base.pathname.replace(/\/+$/, "")}/`;
  return {
    connectorId: account.connectorId,
    host: account.host,
    port: base.port === "" ? 443 : Number(base.port),
    allowedPathPrefixes: [prefix],
    label: account.displayName,
  };
}

/** Honest non-credential headers for one connected ChatGPT account. */
function providerAccountRequestHeaders(
  account: ProviderAccountRecord,
  sessionId: string | null,
  threadId?: string | null,
): Readonly<Record<string, string>> {
  if ((account.renderProfile as ProviderRenderProfile) !== "chatgpt_codex") return {};
  const metadata = parseProviderAccountMetadata(account.metadataJson);
  return chatGptCodexRequestHeaders({
    originator: "terminus",
    userAgent: `terminus/${CONTROL_BUILD_VERSION}`,
    accountId: metadata.account_id ?? null,
    sessionId,
    threadId: threadId ?? null,
  });
}

function providerAccountClient(
  account: ProviderAccountRecord,
  context: RequestContext,
): KernelConnectorClient {
  return new KernelConnectorClient(
    requireKernelUds().connectors,
    context,
    providerAccountEndpoint(account),
  );
}

// ── Per-account model discovery ─────────────────────────────────────────────

/** Freshest discovery per account. Warmed at startup, refreshed on demand. */
const providerAccountModelCache = new Map<string, ProviderAccountModelsResult>();
/** One on-demand discovery per account+model per process, so a turn cannot loop. */
const providerAccountDiscoveryAttempted = new Set<string>();

async function loadPersistedProviderAccountModels(
  accountId: string,
): Promise<ProviderAccountModelsResult | null> {
  const row = await db.providerAccountModelDiscovery.findUnique({ where: { accountId } });
  if (row === null) return null;
  const parsed = parseProviderAccountModels(row.resultJson);
  if (parsed === null) {
    console.warn(`[terminus-control] persisted model discovery for account ${accountId} is unreadable; ignoring it`);
    return null;
  }
  providerAccountModelCache.set(accountId, parsed);
  return parsed;
}

async function discoverAndPersistProviderAccountModels(
  account: ProviderAccountRecord,
  signal?: AbortSignal | null,
): Promise<ProviderAccountModelsResult> {
  const context = await kernelBrokerContext();
  const result = await discoverAccountModels({
    account,
    client: providerAccountClient(account, context),
    observedAt: now(),
    catalog: (await fetchModelsDevRaw()).catalog,
    headers: providerAccountRequestHeaders(account, null),
    ...(signal === undefined || signal === null ? {} : { signal }),
    discoverZen: async () => {
      // Account discovery owns its credential binding. Requiring the retired
      // singleton row here made a fresh auto-connected OpenCode installation
      // unable to discover any model even though its anonymous account was
      // already fully specified.
      const credential: GatewayDiscoveryCredential = {
        deployment: account.baseUrl.includes("/zen/go/") ? "go" : "zen",
        secretUri: account.credentialUri,
      };
      const discovered = await discoverAndPersistProviderModels(credential, signal);
      return { models: discovered.models, rejected: discovered.rejected };
    },
  });
  providerAccountModelCache.set(account.id, result);
  const resultJson = providerAccountModelsJson(result);
  await writerTransaction(async (tx) => {
    await tx.providerAccountModelDiscovery.upsert({
      where: { accountId: account.id },
      create: {
        accountId: account.id,
        resultJson,
        modelCount: result.models.length,
        observedAt: result.observedAt,
      },
      update: { resultJson, modelCount: result.models.length, observedAt: result.observedAt },
    });
    // The probe is the only thing that proves the account answers. A failure
    // records why without demoting an account that still routes.
    if (result.reachable === true) {
      await tx.providerAccount.updateMany({
        where: { id: account.id },
        data: { lastVerifiedAt: new Date(), statusDetail: "" },
      });
    } else if (result.reachable === false && account.status === "connected") {
      await tx.providerAccount.updateMany({
        where: { id: account.id, status: "connected" },
        data: { statusDetail: result.reachabilityDetail },
      });
    }
  });
  return result;
}

/** Memory → durable row, without triggering discovery. */
async function knownProviderAccountModels(
  accountId: string,
): Promise<ProviderAccountModelsResult | null> {
  return providerAccountModelCache.get(accountId) ?? await loadPersistedProviderAccountModels(accountId);
}

/**
 * The admitted record for one model on one account: memory, durable row, then
 * a single bounded live discovery. Null only when the model is genuinely not
 * admitted for this account.
 */
async function admittedProviderAccountModel(
  account: ProviderAccountRecord,
  modelId: string,
  signal?: AbortSignal | null,
): Promise<ProviderAccountModel | null> {
  const known = await knownProviderAccountModels(account.id);
  const found = known?.models.find((model) => model.id === modelId) ?? null;
  if (found !== null) return found;
  const attemptKey = `${account.id}:${modelId}`;
  if (providerAccountDiscoveryAttempted.has(attemptKey)) return null;
  providerAccountDiscoveryAttempted.add(attemptKey);
  try {
    const discovered = await discoverAndPersistProviderAccountModels(account, signal);
    return discovered.models.find((model) => model.id === modelId) ?? null;
  } catch (error: unknown) {
    console.warn(
      `[terminus-control] on-demand model discovery for account ${account.id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** The model ids this account may currently use, for a denial's details. */
async function admittedProviderAccountModelIds(
  account: ProviderAccountRecord,
): Promise<readonly string[]> {
  const known = await knownProviderAccountModels(account.id);
  return (known?.models ?? []).map((model) => model.id).sort();
}

async function providerAccountModelCounts(
  accounts: readonly ProviderAccountRecord[],
): Promise<ReadonlyMap<string, number>> {
  if (accounts.length === 0) return new Map();
  const rows = await db.providerAccountModelDiscovery.findMany({
    where: { accountId: { in: accounts.map((account) => account.id) } },
    select: { accountId: true, modelCount: true },
  });
  const counts = new Map<string, number>(rows.map((row) => [row.accountId, row.modelCount]));
  for (const account of accounts) {
    const cached = providerAccountModelCache.get(account.id);
    if (cached !== undefined) counts.set(account.id, cached.models.length);
  }
  return counts;
}

/**
 * Warm every connected account after startup recovery.
 *
 * Bounded and parallel: eight accounts each doing a bounded catalogue call
 * must not add eight timeouts to the readiness path. Failures are logged, not
 * fatal — a durable record from a previous run still routes.
 */
async function warmProviderAccountDiscovery(): Promise<void> {
  let discovered: Awaited<ReturnType<typeof runProviderAccountDiscovery>>;
  try {
    discovered = await runProviderAccountDiscovery();
  } catch (error: unknown) {
    console.warn(
      `[terminus-control] provider account auto-connect failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  console.log(
    `[terminus-control] connected provider accounts: ${discovered.accounts.length} known, ${discovered.imported.length} imported or refreshed`,
  );
  for (const warning of discovered.warnings) {
    console.warn(`[terminus-control] provider account discovery: ${warning}`);
  }
  const connected = discovered.accounts.filter(
    (account) => account.status === "connected" && providerAccountHasApprovedBinding(account),
  );
  for (const account of connected) {
    const persisted = await loadPersistedProviderAccountModels(account.id);
    if (persisted !== null) {
      console.log(
        `[terminus-control] restored ${persisted.models.length} model(s) for ${account.displayName} observed at ${persisted.observedAt}`,
      );
    }
  }
  const warmed = await Promise.race([
    Promise.allSettled(connected.map((account) => discoverAndPersistProviderAccountModels(account))),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PROVIDER_ACCOUNT_WARM_BUDGET_MS)),
  ]);
  if (warmed === null) {
    console.warn(
      `[terminus-control] provider account model warm-up exceeded ${PROVIDER_ACCOUNT_WARM_BUDGET_MS}ms; durable records still route`,
    );
    return;
  }
  for (const [index, outcome] of warmed.entries()) {
    const account = connected[index];
    if (account === undefined) continue;
    if (outcome.status === "rejected") {
      console.warn(
        `[terminus-control] model discovery for ${account.displayName} failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
      );
    } else {
      console.log(
        `[terminus-control] warmed ${outcome.value.models.length} model(s) for ${account.displayName}`,
      );
    }
  }
}

const PROVIDER_ACCOUNT_WARM_BUDGET_MS = 20_000;

/** Typed 409 for an account a client named that cannot run this turn. */
function sendProviderAccountResolutionError(
  res: ServerResponse,
  resolution: Extract<TurnProviderResolution, { readonly kind: "error" }>,
): void {
  if (resolution.code === "PROVIDER_ACCOUNT_NOT_FOUND") {
    sendError(
      res,
      409,
      "PROVIDER_ACCOUNT_NOT_FOUND",
      `provider account '${resolution.accountId}' does not exist`,
      "conflict",
      { provider_account_id: resolution.accountId },
    );
    return;
  }
  sendError(
    res,
    409,
    "PROVIDER_ACCOUNT_UNAVAILABLE",
    `provider account '${resolution.accountId}' is ${resolution.status} and cannot run a turn`,
    "conflict",
    {
      provider_account_id: resolution.accountId,
      status: resolution.status,
      status_detail: resolution.statusDetail,
    },
  );
}

/**
 * How many settled attempts of a thread are re-read for their reasoning.
 *
 * Well past a single turn's tool budget, so a resumed turn recovers its whole
 * chain, and small enough that a long-lived thread does not drag a growing
 * blob into every render. Entries older than this can only be replayed if the
 * compiler still renders the call they belong to, which it does not.
 */
const REASONING_REPLAY_ATTEMPT_WINDOW = 200;

/**
 * Rebuild the reasoning-replay map for a thread from durable state.
 *
 * The renderer's ledger is process memory; the tool calls it must lead are
 * rows. A control plane that restarts mid-turn — or a second turn that still
 * renders the previous one's calls — otherwise replays a `tool_use` with no
 * `thinking` block in front of it, which Anthropic answers with a 400, and a
 * `function_call` whose encrypted chain is gone, which OpenAI silently
 * re-derives at full price.
 *
 * Best effort by construction: a decode failure means "no replay available",
 * never a failed turn.
 */
async function loadThreadReasoningReplay(threadId: string): Promise<readonly ReasoningReplayEntry[]> {
  try {
    const rows = await db.providerAttempt.findMany({
      where: { turn: { threadId }, reasoningReplayJson: { not: null } },
      orderBy: { startedAt: "desc" },
      take: REASONING_REPLAY_ATTEMPT_WINDOW,
      select: { reasoningReplayJson: true },
    });
    // Oldest first, so `seed`'s first-write-wins leaves the newest signature
    // for a call id in place if one was ever re-issued.
    const entries: ReasoningReplayEntry[] = [];
    for (const row of rows) entries.push(...parseReasoningReplay(row.reasoningReplayJson));
    return entries;
  } catch (error: unknown) {
    logInternalError("reasoning replay ledger could not be restored", error);
    return [];
  }
}

/**
 * The renderer for one account model.
 *
 * ChatGPT Codex has a measured Responses dialect; other accounts reuse the
 * provider-neutral gateway renderer.
 */
function providerAccountRenderer(
  routing: {
    readonly account: ProviderAccountRecord;
    readonly model: ProviderAccountModel;
    readonly providerId: string;
    readonly gatewayModel: GatewayModel;
  },
  reasoningEffort: ReasoningEffort | null,
  promptCacheKey: string,
  reasoningReplay: ReasoningReplayLedger,
): ChatGptCodexRenderer | GatewayRenderer {
  if ((routing.account.renderProfile as ProviderRenderProfile) === "chatgpt_codex") {
    const profile: ChatGptCodexModelProfile = {
      slug: routing.model.id,
      reasoningLevels: [...routing.model.reasoningEfforts],
      defaultReasoningLevel: routing.model.defaultReasoningEffort,
      supportsParallelToolCalls: routing.model.supportsParallelToolCalls,
      supportsReasoningSummaries: routing.model.supportsReasoningSummaries,
    };
    return new ChatGptCodexRenderer(routing.providerId, {
      reasoningEffort,
      promptCacheKey,
      profile,
      reasoningReplay,
    });
  }
  return new GatewayRenderer([routing.gatewayModel], { reasoningEffort, reasoningReplay });
}

/** Record the provider's own plan-window receipt without changing routing. */
function recordProviderAccountUsageHeaders(
  accountId: string,
  headers: Readonly<Record<string, string>>,
): void {
  const usedPercent = headers["x-codex-primary-used-percent"];
  const resetAfterSeconds = headers["x-codex-primary-reset-after-seconds"];
  if (usedPercent === undefined && resetAfterSeconds === undefined) return;
  const parts: string[] = [];
  if (usedPercent !== undefined) parts.push(`${usedPercent}% of the plan window used`);
  if (resetAfterSeconds !== undefined) {
    const seconds = Number(resetAfterSeconds);
    parts.push(Number.isFinite(seconds) && seconds > 0
      ? `resets in ${Math.max(1, Math.round(seconds / 60))} min`
      : `resets in ${resetAfterSeconds}s`);
  }
  const detail = parts.join(", ");
  void writerTransaction((tx) => tx.providerAccount.updateMany({
    where: { id: accountId, status: "connected" },
    data: { statusDetail: detail },
  })).catch((error: unknown) => {
    console.warn(`[terminus-control] recording provider account usage failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

const providerAccountRevisionSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
}).strict();

const providerAccountConnectSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  expected_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  expected_destination: z.string().url().max(2_048),
  expected_catalog_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  consent: z.literal(true),
}).strict();

/**
 * The account list plus what the last discovery run observed.
 *
 * Which local tools are installed travels as `installed_tools: ["codex", ...]`
 * rather than one boolean per tool: `tools/standalone-check.ts` rejects a
 * shipped desktop identifier that puts a separator next to the harness name,
 * and a list of names carries the same fact without one.
 */
async function providerAccountsResponse(): Promise<{
  accounts: unknown[];
  discovery: {
    last_run_at: string | null;
    installed_tools: string[];
    opencode_store_status: "available" | "missing" | "rejected" | "unavailable" | null;
    warnings: string[];
  };
}> {
  const accounts = await listProviderAccountRecords();
  const counts = await providerAccountModelCounts(accounts);
  const installedTools: string[] = [];
  if (lastProviderAccountDiscovery?.codexInstalled === true) installedTools.push("codex");
  if (lastProviderAccountDiscovery?.opencodeInstalled === true) installedTools.push(ZEN_VENDOR_ID);
  return {
    accounts: accounts.map((account) => providerAccountWire(
      account,
      counts.get(account.id) ?? 0,
      modelsDevCatalogDigest(),
    )),
    discovery: {
      last_run_at: lastProviderAccountDiscovery?.lastRunAt ?? null,
      installed_tools: installedTools,
      opencode_store_status: lastProviderAccountDiscovery?.opencodeStoreStatus ?? null,
      warnings: [...(lastProviderAccountDiscovery?.warnings ?? [])],
    },
  };
}

/**
 * The multi-account inventory.
 *
 * Returns null when no account exists at all, so `GET /v1/provider-models`
 * falls back to the legacy single-gateway answer for an installation that has
 * never run discovery.
 */
async function providerAccountInventory(): Promise<ReturnType<typeof providerAccountModelsWire> | null> {
  const accounts = await listProviderAccountRecords();
  if (accounts.length === 0) return null;
  const entries: { readonly account: ProviderAccountRecord; readonly result: ProviderAccountModelsResult | null }[] = [];
  const failures: string[] = [];
  for (const account of accounts) {
    let result = await knownProviderAccountModels(account.id);
    if (result === null && account.status === "connected" && providerAccountHasApprovedBinding(account)) {
      try {
        result = await discoverAndPersistProviderAccountModels(account);
      } catch (error: unknown) {
        failures.push(
          `${account.displayName}: ${error instanceof Error ? error.message : "model discovery failed"}`,
        );
      }
    }
    entries.push({ account, result });
  }
  const wire = providerAccountModelsWire(entries, null);
  if (wire.models.length > 0) {
    return failures.length === 0 ? wire : { ...wire, error: failures.join("; ") };
  }
  // A stale answer beats no answer, and an empty one needs a reason a client
  // can show instead of an unexplained blank picker.
  const reason = failures.length > 0
    ? failures.join("; ")
    : accounts.some((account) => account.status === "connected" && providerAccountHasApprovedBinding(account))
      ? "No connected provider account has reported any models yet."
      : "No provider account is connected.";
  return { ...wire, error: reason };
}


const verificationCoordinator = new VerificationCoordinator<Prisma.TransactionClient>({
  readTask: async (taskId) => db.task.findUnique({ where: { id: taskId }, select: { status: true } }),
  appendEvent: async (event, mutation): Promise<void> => {
    await emit({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      payload: event.payload,
      artifactRefs: event.artifactRefs === undefined ? undefined : [...event.artifactRefs],
    }, mutation);
  },
  updateTask: async (tx, input: VerificationTransitionInput, expectedStatuses) => {
    const currentTask = input.repairBudget === undefined
      ? null
      : await tx.task.findUnique({ where: { id: input.taskId }, select: { budgetJson: true } });
    const budgetJson = input.repairBudget === undefined || currentTask === null
      ? undefined
      : (() => {
          const prior = safeParse<Record<string, unknown>>(currentTask.budgetJson, {});
          const priorRepair = typeof prior.repair_budget === "object"
            && prior.repair_budget !== null
            && !Array.isArray(prior.repair_budget)
            ? prior.repair_budget as Record<string, unknown>
            : {};
          const priorHistory = Array.isArray(priorRepair.failure_history)
            ? priorRepair.failure_history.filter((value): value is string => typeof value === "string")
            : [];
          return JSON.stringify({
            ...prior,
            repair_budget: {
              ...priorRepair,
              max_attempts: input.repairBudget.maxAttempts,
              attempts_used: input.repairBudget.attemptNumber,
              failure_signatures: [...input.repairBudget.failureSignatures],
              failure_history: [...priorHistory, ...input.repairBudget.failureSignatures],
              last_source_revision: input.repairBudget.sourceRevision,
            },
          });
        })();
    const update = await tx.task.updateMany({
      where: { id: input.taskId, status: { in: [...expectedStatuses] } },
      data: {
        status: input.status,
        phase: input.phase,
        completedAt: input.completedAt,
        terminalReasonJson: input.terminalReasonJson,
        ...(input.verificationPlanId === undefined ? {} : { verificationPlanId: input.verificationPlanId }),
        ...(budgetJson === undefined ? {} : { budgetJson }),
      },
    });
    if (update.count !== 1) throw new Error(`task ${input.taskId} changed during verification transition`);
  },
  createRepairAttempt: async (tx, input: RepairAttemptPersistenceInput) => {
    await tx.lease.create({
      data: {
        leaseKey: input.leaseKey,
        ownerInstance: "unclaimed",
        fencingToken: 0,
        expiresAt: new Date(0),
        metadataJson: JSON.stringify({
          role: "verification-repair",
          repair_attempt_id: input.id,
          task_id: input.taskId,
        }),
      },
    });
    await tx.repairAttempt.create({
      data: {
        id: input.id,
        taskId: input.taskId,
        parentTurnId: input.parentTurnId,
        leaseKey: input.leaseKey,
        attemptNumber: input.attemptNumber,
        maxAttempts: input.maxAttempts,
        state: "PENDING",
        directiveArtifact: input.directiveArtifact,
        failedNodeIdsJson: JSON.stringify(input.failedNodeIds),
        failureSignaturesJson: JSON.stringify(input.failureSignatures),
        changedFilesJson: JSON.stringify(input.changedFiles),
        sourceRevision: input.sourceRevision,
        environmentDigest: input.environmentDigest,
        remainingBudgetJson: input.remainingBudgetJson,
      },
    });
  },
  updateTaskAndTurn: async (tx, input, expectedStatuses, turnId, expectedTurnState) => {
    const taskUpdate = await tx.task.updateMany({
      where: { id: input.taskId, status: { in: [...expectedStatuses] } },
      data: {
        status: input.status,
        phase: input.phase,
        completedAt: input.completedAt,
        terminalReasonJson: input.terminalReasonJson,
        ...(input.verificationPlanId === undefined ? {} : { verificationPlanId: input.verificationPlanId }),
      },
    });
    if (taskUpdate.count !== 1) throw new Error(`task ${input.taskId} changed during atomic verification admission`);
    const turnUpdate = await tx.turn.updateMany({
      where: { id: turnId, state: expectedTurnState },
      data: { state: "VERIFIED" },
    });
    if (turnUpdate.count !== 1) throw new Error(`turn ${turnId} changed during atomic verification admission`);
    if (input.completionRecordId !== undefined && input.completionRecordId !== null) {
      const completionUpdate = await tx.completionRecord.updateMany({
        where: {
          id: input.completionRecordId,
          taskId: input.taskId,
          admissionState: "PREPARED",
        },
        data: { admissionState: "COMMITTED" },
      });
      if (completionUpdate.count !== 1) {
        throw new Error(`completion record ${input.completionRecordId} changed during atomic verification admission`);
      }
    }
  },
  mutate: mutateAgentState,
  projectTask: async (taskId, eventType): Promise<void> => { await synchronizeV1TaskProjection(taskId, eventType); },
});

class AmbiguousToolSettlementError extends Error {
  constructor(readonly toolCallId: string, message: string) {
    super(message);
    this.name = "AmbiguousToolSettlementError";
  }
}

class EngineTerminalStopError extends Error {
  constructor(readonly stop: EngineStop) {
    super(`coding loop stopped with ${stop.kind}`);
    this.name = "EngineTerminalStopError";
  }
}

interface StandaloneToolSettlementInput {
  readonly callChunk: ProviderToolCallChunk;
  readonly providerAttemptId: string;
  readonly turnId: string;
  readonly threadId: string;
  readonly turnSequence: number;
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly contractVersion: number;
  readonly contractHash: string;
  readonly artifactClient: ArtifactClient;
  readonly observedSources: ObservedSourceTracker;
  readonly capabilitySession: CapabilityDiscoverySession;
  /** Compute the exact post-transition schema ids before atomic settlement. */
  readonly nextWorkspaceToolIds: () => readonly string[];
  /** Read the authoritative workspace identity around the kernel effect. */
  readonly workspaceRevision?: (() => Promise<string | null>) | undefined;
  /** Current verifier/repair association, if this turn has one. */
  readonly operationContext?: (() => {
    readonly verificationDelta?: string | null | undefined;
    readonly hypothesisId?: string | null | undefined;
    readonly criterionIds?: readonly string[] | undefined;
    readonly objectiveStep?: string | null | undefined;
  }) | undefined;
  readonly signal?: AbortSignal | null;
  /** The loop already rejected this call; settle the correction, run nothing. */
  readonly rejection?: InvalidToolCallError | undefined;
}

interface StandaloneOperationMetadata {
  readonly workspaceRevisionBefore: string | null;
  readonly workspaceRevisionAfter: string | null;
  readonly verificationDelta: string | null;
  readonly hypothesisId: string | null;
  readonly criterionIds: readonly string[] | undefined;
  readonly objectiveStep: string | null;
}

async function readStandaloneWorkspaceRevision(
  input: StandaloneToolSettlementInput,
): Promise<string | null> {
  if (input.workspaceRevision === undefined) return null;
  try {
    return await input.workspaceRevision();
  } catch {
    // A missing revision is explicit evidence of unavailable identity; it is
    // never replaced with a guessed commit or timestamp.
    return null;
  }
}

function standaloneOperationContext(
  input: StandaloneToolSettlementInput,
): Omit<StandaloneOperationMetadata, "workspaceRevisionBefore" | "workspaceRevisionAfter"> {
  const context = input.operationContext?.();
  return {
    verificationDelta: context?.verificationDelta ?? null,
    hypothesisId: context?.hypothesisId ?? null,
    criterionIds: context?.criterionIds,
    objectiveStep: context?.objectiveStep ?? null,
  };
}

// ────────────────────────── Permission profile gate ────────────────────────

/** How long a tool call waits for a decision before it is treated as refused. */
const TOOL_APPROVAL_TIMEOUT_MS = 15 * 60_000;

type ToolApprovalVerdict =
  | { readonly kind: "allowed"; readonly decision: "allow_once" | "allow_for_action" | "allow_for_task" }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "aborted" };

/**
 * Tool calls parked on a pending approval, by approval id. The resolve route
 * settles the waiter; nothing else does. A process restart empties this map,
 * which is why startup recovery expires every pending tool-call approval —
 * there is no longer anything to wake.
 */
const toolApprovalWaiters = new Map<string, (verdict: ToolApprovalVerdict) => void>();

/**
 * "Allow for this task": tools the user has waved through for the rest of
 * the task. In-process on purpose — the grant is a convenience for one
 * sitting, and a restart asking again is the safe failure.
 */
const taskApprovalGrants = new Map<string, Set<string>>();

function taskGrantsWithoutApproval(taskId: string, toolId: string): boolean {
  return taskApprovalGrants.get(taskId)?.has(toolId) ?? false;
}

function grantToolForTask(taskId: string, toolId: string): void {
  const grants = taskApprovalGrants.get(taskId) ?? new Set<string>();
  grants.add(toolId);
  taskApprovalGrants.set(taskId, grants);
}

/** Wake a parked tool call. Returns false when nothing is waiting on this approval. */
function settleToolApprovalWaiter(approvalId: string, verdict: ToolApprovalVerdict): boolean {
  const waiter = toolApprovalWaiters.get(approvalId);
  if (waiter === undefined) return false;
  waiter(verdict);
  return true;
}

async function sessionPermissionProfile(sessionId: string): Promise<PermissionProfile> {
  const row = await db.session.findUnique({
    where: { id: sessionId },
    select: { defaultPermissionProfile: true },
  });
  return normalizePermissionProfile(row?.defaultPermissionProfile);
}

async function expireToolApproval(approvalId: string, taskId: string, toolCallId: string): Promise<void> {
  const expiredAt = new Date();
  await mutateAgentState(() => emit({
    eventType: "approval.expired",
    aggregateType: "approval",
    aggregateId: approvalId,
    correlationId: taskId,
    payload: { approval_id: approvalId, task_id: taskId, tool_call_id: toolCallId, expired_at: expiredAt.toISOString() },
  }, async (tx) => {
    await tx.approval.updateMany({ where: { id: approvalId, status: "pending" }, data: { status: "expired" } });
  }));
}

async function revokeToolApproval(approvalId: string, taskId: string, toolCallId: string): Promise<void> {
  const revokedAt = new Date();
  // Emitted as a resolution so clients refresh their pending list; the status
  // says what actually happened.
  await mutateAgentState(() => emit({
    eventType: "approval.resolved",
    aggregateType: "approval",
    aggregateId: approvalId,
    correlationId: taskId,
    payload: {
      approval_id: approvalId,
      task_id: taskId,
      tool_call_id: toolCallId,
      decision: null,
      status: "revoked",
      reason: "turn stopped while waiting for approval",
      resolved_at: revokedAt.toISOString(),
    },
  }, async (tx) => {
    await tx.approval.updateMany({ where: { id: approvalId, status: "pending" }, data: { status: "revoked", resolvedAt: revokedAt } });
    await tx.toolCall.updateMany({
      where: { id: toolCallId, state: "APPROVAL_PENDING" },
      data: {
        state: "CANCELLED",
        settledAt: revokedAt,
        resultStatus: "cancelled",
        errorJson: JSON.stringify({ reason: "turn_stopped_while_awaiting_approval" }),
      },
    });
  }));
}

/**
 * Park a tool call on the user's decision.
 *
 * Records the approval the way the policy broker would — a hashed binding
 * the client must echo back, plus display copy — flags the tool call as
 * APPROVAL_PENDING, announces it, and then waits. The turn stays open the
 * whole time, so the answer lands in the same conversation rather than in a
 * task the user has to reopen. Stopping the turn revokes the request; the
 * timeout expires it.
 */
async function awaitToolApproval(args: {
  readonly input: StandaloneToolSettlementInput;
  readonly call: ParsedStandaloneToolCall;
  readonly toolCallId: string;
  readonly effect: StandaloneToolEffectMetadata;
  readonly permissionProfile: PermissionProfile;
  readonly argumentsArtifactUri: string;
}): Promise<ToolApprovalVerdict> {
  const { input, call, toolCallId, effect, permissionProfile } = args;
  const approvalId = uuid();
  const requestedAt = new Date();
  const expiresAt = new Date(requestedAt.getTime() + TOOL_APPROVAL_TIMEOUT_MS);
  const exactAction = approvalActionFor(call);
  const binding: ApprovalBindingV1 = {
    version: 1,
    task_id: input.taskId,
    task_contract_version: input.contractVersion,
    user_intent_ref: input.turnId,
    policy_version: "secure-local-default:v1",
    effect_kind: effect.effectType,
    exact_action: exactAction,
    resources: [effect.resourceUri],
    destinations: call.toolId === "web_fetch" ? [effect.resourceUri] : [],
    source_versions: {},
    secret_scope: [],
    risk: {
      class: call.toolId === "web_fetch" ? "high" : "normal",
      effects: [effect.effectType],
    },
    taint: { influenced_by_untrusted_content: false, warning: null },
    expires_at: expiresAt.toISOString(),
    use_limit: 1,
  };
  const display: ApprovalDisplay = {
    summary: exactAction,
    exact_action: exactAction,
    reason: approvalReasonFor(permissionProfile, call),
    reversibility: effect.reversibility,
    environment: "Local workspace",
  };
  const operation: ApprovalOperationRecord = { binding, display };
  const operationHash = computeContentHash(canonicalApprovalBinding(binding));
  await mutateAgentState(() => emit({
    eventType: "approval.requested",
    aggregateType: "approval",
    aggregateId: approvalId,
    correlationId: input.taskId,
    payload: {
      approval_id: approvalId,
      task_id: input.taskId,
      turn_id: input.turnId,
      tool_call_id: toolCallId,
      tool_id: call.toolId,
      operation_hash: operationHash,
      summary: exactAction,
      reason: display.reason,
      permission_profile: permissionProfile,
      expires_at: expiresAt.toISOString(),
    },
    artifactRefs: [args.argumentsArtifactUri],
  }, async (tx) => {
    await tx.approval.create({
      data: {
        id: approvalId,
        taskId: input.taskId,
        toolCallId,
        operationHash,
        operationJson: canonicalJson(operation),
        scopeJson: JSON.stringify({ resources: binding.resources, destinations: binding.destinations }),
        riskJson: JSON.stringify({ class: binding.risk.class, effects: binding.risk.effects }),
        status: "pending",
        useLimit: 1,
        expiresAt,
        requestedAt,
      },
    });
    await tx.toolCall.update({ where: { id: toolCallId }, data: { state: "APPROVAL_PENDING", approvalId } });
  }));
  return new Promise<ToolApprovalVerdict>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      void revokeToolApproval(approvalId, input.taskId, toolCallId)
        .catch(() => undefined)
        .finally(() => finish({ kind: "aborted" }));
    };
    const finish = (verdict: ToolApprovalVerdict): void => {
      if (settled) return;
      settled = true;
      toolApprovalWaiters.delete(approvalId);
      if (timer !== null) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(verdict);
    };
    toolApprovalWaiters.set(approvalId, finish);
    timer = setTimeout(() => {
      void expireToolApproval(approvalId, input.taskId, toolCallId)
        .catch(() => undefined)
        .finally(() => finish({ kind: "expired" }));
    }, TOOL_APPROVAL_TIMEOUT_MS);
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Settle a call the model got wrong without running anything.
 *
 * The call still gets a durable tool_call row, a `tool.proposed` event, and a
 * persisted error result keyed to the provider call id: the model-visible
 * transcript must carry a result for every call the provider emitted, or the
 * next request is refused for an unmatched tool call. The result's summary is
 * the correction. The loop continues, and the model retries — which is what
 * every competitive harness does with a malformed call. Before this path
 * existed the parse error propagated out of the turn and one `exec` carrying
 * both `program` and `shell` ended the conversation as "not retryable".
 */
async function settleRejectedProviderToolCall(
  input: StandaloneToolSettlementInput,
  rejection: InvalidToolCallError,
): Promise<EngineToolSettlement> {
  const chunk = input.callChunk;
  // The model must see its own tool name echoed back, or it cannot match the
  // result to the call it made.
  const identity: ProviderCallIdentity = { providerCallId: chunk.toolCallId, toolId: rejection.toolName };
  const workspaceRevision = await readStandaloneWorkspaceRevision(input);
  const operationContext = standaloneOperationContext(input);
  const toolCallId = uuid();
  const argumentsArtifact = await input.artifactClient.ingest(
    new TextEncoder().encode(canonicalJson(chunk.arguments)),
    { mediaType: "application/json", custom: { purpose: "tool-arguments", toolCallId } },
  );
  const callTranscriptArtifact = await input.artifactClient.ingest(
    new TextEncoder().encode(canonicalJson(providerToolCallTranscript({ ...identity, arguments: chunk.arguments }))),
    { mediaType: "application/json", custom: { purpose: "tool-call-transcript", toolCallId } },
  );
  await input.artifactClient.link(argumentsArtifact.hash, "tool_call", toolCallId, "arguments");
  await input.artifactClient.link(callTranscriptArtifact.hash, "tool_call", toolCallId, "provider-transcript");
  // Hashed over the raw call: a call that never parsed has no normalized
  // operation, and nothing dedupes against it.
  const operationHash = computeContentHash(canonicalJson({
    task_id: input.taskId,
    contract_version: input.contractVersion,
    rejected_tool: identity.toolId,
    arguments: chunk.arguments,
  }));
  await mutateAgentState(() => emit({
    eventType: "tool.proposed",
    aggregateType: "tool_call",
    aggregateId: toolCallId,
    correlationId: input.taskId,
    payload: {
      turn_id: input.turnId,
      provider_attempt_id: input.providerAttemptId,
      provider_call_id: identity.providerCallId,
      tool_id: identity.toolId,
      tool_version: "standalone-v1",
      arguments_excerpt: "invalid tool call",
      normalized_operation_hash: operationHash,
    },
    artifactRefs: [argumentsArtifact.uri, callTranscriptArtifact.uri],
  }, async (tx) => {
    await tx.toolCall.create({
      data: {
        id: toolCallId,
        turnId: input.turnId,
        providerAttemptId: input.providerAttemptId,
        toolId: identity.toolId,
        toolVersion: "standalone-v1",
        argumentsArtifact: argumentsArtifact.uri,
        normalizedOperationHash: operationHash,
        state: "PROPOSED",
      },
    });
  }));
  const result = errorResult(rejection.modelMessage, {
    toolCallId,
    traceId: input.turnId,
    status: "error",
    summary: rejection.modelMessage,
  });
  return persistSettledToolResult({
    input,
    call: identity,
    toolCallId,
    callTranscriptArtifactUri: callTranscriptArtifact.uri,
    sideEffectId: null,
    result,
    workspaceRevisionBefore: workspaceRevision,
    workspaceRevisionAfter: workspaceRevision,
    ...operationContext,
  });
}

/**
 * Every spelling of a workspace root a model might have been handed.
 *
 * `canonicalRoot` and the `file://` root differ wherever the path crosses a
 * symlink — `/tmp` against `/private/tmp` on macOS — and the model quotes back
 * whichever one its context showed it. Roots do not move, so this is read once
 * per workspace per process.
 */
const workspaceRootPathCache = new Map<string, readonly string[]>();

async function workspaceRootPaths(workspaceId: string): Promise<readonly string[]> {
  const cached = workspaceRootPathCache.get(workspaceId);
  if (cached !== undefined) return cached;
  const row = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { rootUri: true, canonicalRoot: true },
  });
  const roots: string[] = [];
  if (row !== null) {
    if (row.canonicalRoot.length > 0) roots.push(row.canonicalRoot);
    try {
      const parsed = new URL(row.rootUri);
      if (parsed.protocol === "file:") roots.push(fileURLToPath(parsed));
    } catch {
      // A root that is not a URL contributes no spelling; the canonical root
      // above is still authoritative.
    }
  }
  const unique = [...new Set(roots)];
  workspaceRootPathCache.set(workspaceId, unique);
  return unique;
}

type SessionRecallTurnRow = {
  readonly id: string;
  readonly taskId: string | null;
  readonly threadId: string;
  readonly sequence: number;
  readonly completedAt: Date | null;
  readonly initiatingInputArtifact: string | null;
};

async function projectSessionRecallTurns(
  rows: readonly SessionRecallTurnRow[],
): Promise<readonly SessionRecallTurn[]> {
  if (rows.length === 0) return [];
  const events = await db.semanticEvent.findMany({
    where: {
      eventType: "turn.completed",
      aggregateType: "turn",
      aggregateId: { in: rows.map((row) => row.id) },
    },
    orderBy: { occurredAt: "desc" },
    select: { aggregateId: true, payloadJson: true, artifactRefsJson: true },
  });
  const completionByTurn = new Map<string, { readonly summary: string; readonly artifactUri: string | null }>();
  for (const event of events) {
    if (completionByTurn.has(event.aggregateId)) continue;
    const payload = safeParse<Record<string, unknown>>(event.payloadJson, {});
    const refs = safeParse<string[]>(event.artifactRefsJson, []);
    completionByTurn.set(event.aggregateId, {
      summary: typeof payload.summary === "string" ? payload.summary : "",
      artifactUri: refs.find((uri) => artifactUriHash(uri) !== null) ?? null,
    });
  }
  return rows.flatMap((row): readonly SessionRecallTurn[] => {
    if (row.taskId === null) return [];
    const completion = completionByTurn.get(row.id);
    return [{
      id: row.id,
      taskId: row.taskId,
      threadId: row.threadId,
      sequence: row.sequence,
      completedAt: row.completedAt?.toISOString() ?? null,
      userArtifactUri: row.initiatingInputArtifact,
      assistantArtifactUri: completion?.artifactUri ?? null,
      assistantSummary: completion?.summary ?? "",
    }];
  });
}

function createSessionRecallStore(artifacts: ArtifactClient): SessionRecallStore {
  const readArtifactText = async (uri: string): Promise<string> => {
    const hash = artifactUriHash(uri);
    if (hash === null) throw new Error(`session recall source is not a content-addressed artifact: ${uri}`);
    const metadata = await artifacts.metadata(hash as ContentHash);
    if (metadata.bytes > BigInt(SESSION_RECALL_SOURCE_MAX_BYTES)) {
      throw new Error(`session recall source exceeds the ${SESSION_RECALL_SOURCE_MAX_BYTES}-byte read bound`);
    }
    const bytes = await artifacts.get(hash as ContentHash);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  };
  return {
    listCompletedTurns: async ({ taskId, threadId, beforeSequence, limit }) => {
      const rows = await db.turn.findMany({
        where: {
          taskId,
          threadId,
          state: "COMPLETED",
          sequence: { lt: beforeSequence },
        },
        orderBy: { sequence: "desc" },
        take: limit,
        select: {
          id: true,
          taskId: true,
          threadId: true,
          sequence: true,
          completedAt: true,
          initiatingInputArtifact: true,
        },
      });
      return projectSessionRecallTurns(rows);
    },
    findCompletedTurn: async ({ taskId, threadId, sequence }) => {
      const row = await db.turn.findFirst({
        where: { taskId, threadId, state: "COMPLETED", sequence },
        select: {
          id: true,
          taskId: true,
          threadId: true,
          sequence: true,
          completedAt: true,
          initiatingInputArtifact: true,
        },
      });
      if (row === null) return null;
      return (await projectSessionRecallTurns([row]))[0] ?? null;
    },
    searchCompletedTurns: async ({
      taskId,
      threadId,
      beforeSequence,
      scanLimit,
      query,
      cacheObserver,
    }) => {
      const rows = await db.turn.findMany({
        where: {
          taskId,
          threadId,
          state: "COMPLETED",
          sequence: { lt: beforeSequence },
        },
        orderBy: { sequence: "desc" },
        take: scanLimit + 1,
        select: {
          id: true,
          taskId: true,
          threadId: true,
          sequence: true,
          completedAt: true,
          initiatingInputArtifact: true,
        },
      });
      const candidateRows = rows.slice(0, scanLimit);
      const candidates = await projectSessionRecallTurns(candidateRows);
      if (candidates.length === 0) {
        return {
          turns: [],
          scannedTurns: 0,
          nextBeforeSequence: null,
          backfilledTurns: 0,
          sourceFailures: 0,
        };
      }
      const states = sessionRecallIndex.currentStates(candidates.map((turn) => turn.id));
      const stale = candidates.flatMap((turn) => {
        const sourceIdentity = computeContentHash(canonicalJson({
          schema: "terminus.session-recall-fts-source.v1",
          user_artifact: turn.userArtifactUri,
          assistant_artifact: turn.assistantArtifactUri,
          assistant_summary: turn.assistantSummary,
          max_chars_per_source: SESSION_RECALL_SOURCE_MAX_CHARS,
        }));
        const current = states.get(turn.id);
        return current?.sourceIdentity === sourceIdentity && current.complete
          ? []
          : [{ turn, sourceIdentity }];
      });
      const documents: SessionRecallIndexDocument[] = [];
      let sourceFailures = 0;
      for (let offset = 0; offset < stale.length; offset += 4) {
        const batch = stale.slice(offset, offset + 4);
        const projected = await Promise.all(batch.map(async ({ turn, sourceIdentity }) => {
          let failures = 0;
          const readIndexText = async (uri: string | null, fallback: string): Promise<string> => {
            if (uri === null) return fallback;
            try {
              return (await sessionRecallTextCache.read(uri, readArtifactText, cacheObserver)).text;
            } catch {
              failures += 1;
              return fallback;
            }
          };
          const [userText, assistantText] = await Promise.all([
            readIndexText(turn.userArtifactUri, ""),
            readIndexText(turn.assistantArtifactUri, turn.assistantSummary),
          ]);
          return {
            failures,
            document: {
              turnId: turn.id,
              taskId: turn.taskId,
              threadId: turn.threadId,
              sequence: turn.sequence,
              completedAt: turn.completedAt,
              userText,
              assistantText: assistantText.length > 0 ? assistantText : turn.assistantSummary,
              sourceIdentity,
              complete: failures === 0,
            } satisfies SessionRecallIndexDocument,
          };
        }));
        for (const result of projected) {
          sourceFailures += result.failures;
          documents.push(result.document);
        }
      }
      sessionRecallIndex.upsertMany(documents);
      const oldestSequence = candidates.at(-1)?.sequence;
      if (oldestSequence === undefined) throw new Error("session recall index lost its candidate window");
      const hits = sessionRecallIndex.search({
        taskId,
        threadId,
        query,
        beforeSequence,
        fromSequenceInclusive: oldestSequence,
        limit: scanLimit,
      });
      const byId = new Map(candidates.map((turn) => [turn.id, turn]));
      return {
        turns: hits.flatMap((hit) => {
          const turn = byId.get(hit.turnId);
          return turn === undefined ? [] : [turn];
        }),
        scannedTurns: candidates.length,
        nextBeforeSequence: rows.length > candidateRows.length ? oldestSequence : null,
        backfilledTurns: documents.length,
        sourceFailures,
      };
    },
    readArtifactText,
  };
}

function createCurrentTurnCompactionRecallStore(
  turnId: string,
  artifacts: ArtifactClient,
) {
  return createExactCompactionRecallStore({
    expectedTurnId: turnId,
    persistence: {
      listCurrentTurnSummaryRows: async ({ turnId: summaryTurnId }) => db.episode.findMany({
        where: { turnId: summaryTurnId, kind: "summary" },
        orderBy: [{ sequence: "desc" }, { id: "desc" }],
        select: {
          id: true,
          turnId: true,
          sequence: true,
          sourceVersionsJson: true,
        },
      }),
      listSourceEpisodeRows: async ({ turnId: sourceTurnId, episodeIds }) => db.episode.findMany({
        where: { turnId: sourceTurnId, id: { in: [...episodeIds] } },
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
        select: {
          id: true,
          turnId: true,
          kind: true,
          sequence: true,
          toolCallId: true,
          contentArtifact: true,
        },
      }),
      readCasBytes: async ({ contentHash }) => artifacts.get(contentHashSchema.parse(contentHash)),
    },
  });
}

function sessionRecallSourceVersions(result: SessionRecallResult): Readonly<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const entry of result.results) {
    for (const uri of [entry.user_source_uri, entry.assistant_source_uri]) {
      const hash = artifactUriHash(uri);
      if (uri !== null && hash !== null) versions[uri] = hash;
    }
  }
  return versions;
}

function sessionRecallSummary(result: SessionRecallResult): string {
  const noun = result.results.length === 1 ? "turn" : "turns";
  const scanned = result.action === "search" ? ` after scanning ${result.scanned_turns}` : "";
  const continuation = result.next_before_sequence === null
    ? ""
    : `; continue before turn ${result.next_before_sequence}`;
  return `Recalled ${result.results.length} completed ${noun}${scanned} in this task/thread${continuation}`;
}

function compactionRecallSourceVersions(
  result: CompactionRecallToolResult,
): Readonly<Record<string, string>> {
  return Object.fromEntries(result.results.map((entry) => [entry.source_uri, entry.source_sha256]));
}

function compactionRecallSummary(result: CompactionRecallToolResult): string {
  const noun = result.results.length === 1 ? "source episode" : "source episodes";
  return `Expanded ${result.results.length} exact ${noun} from the current turn's compaction summary`;
}

function compactionRecallContinuation(result: CompactionRecallToolResult): string | null {
  if (result.continuation !== null) {
    return `recall compaction_browse with summary_hash ${result.summary_hash} and continuation ${result.continuation}`;
  }
  const truncated = result.results.find((entry) => entry.content_truncated);
  if (truncated === undefined) return null;
  const offset = result.action === "compaction_read"
    ? truncated.next_offset_chars ?? truncated.previous_offset_chars
    : truncated.previous_offset_chars ?? truncated.next_offset_chars;
  return offset === null
    ? null
    : `recall compaction_read with summary_hash ${result.summary_hash}, episode_id ${truncated.episode_id}, and offset_chars ${offset}`;
}

async function settleStandaloneProviderTool(
  input: StandaloneToolSettlementInput,
): Promise<EngineToolSettlement> {
  if (input.signal?.aborted === true) throw new ToolAbortedError();
  if (input.rejection !== undefined) return settleRejectedProviderToolCall(input, input.rejection);
  let call: ParsedStandaloneToolCall;
  try {
    // Rewritten before the arguments artifact and the operation hash below, so
    // the recorded call is the one that actually ran.
    call = relativizeStandaloneCallPaths(
      parseStandaloneToolCall(input.callChunk),
      await workspaceRootPaths(input.workspaceId),
    );
  } catch (error: unknown) {
    if (error instanceof InvalidToolCallError) return settleRejectedProviderToolCall(input, error);
    throw error;
  }
  const workspaceRevisionBefore = await readStandaloneWorkspaceRevision(input);
  const operationContext = standaloneOperationContext(input);
  const toolCallId = uuid();
  const operationHash = normalizedToolOperationHash({
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    call,
  });
  const effect = toolEffectMetadata(call);
  const argumentsText = canonicalJson(call.arguments);
  const argumentsArtifact = await input.artifactClient.ingest(
    new TextEncoder().encode(argumentsText),
    { mediaType: "application/json", custom: { purpose: "tool-arguments", toolCallId } },
  );
  const callTranscriptText = canonicalJson(providerToolCallTranscript(call));
  const callTranscriptArtifact = await input.artifactClient.ingest(
    new TextEncoder().encode(callTranscriptText),
    { mediaType: "application/json", custom: { purpose: "tool-call-transcript", toolCallId } },
  );
  await input.artifactClient.link(argumentsArtifact.hash, "tool_call", toolCallId, "arguments");
  await input.artifactClient.link(callTranscriptArtifact.hash, "tool_call", toolCallId, "provider-transcript");

  await mutateAgentState(() => emit({
    eventType: "tool.proposed",
    aggregateType: "tool_call",
    aggregateId: toolCallId,
    correlationId: input.taskId,
    payload: {
      turn_id: input.turnId,
      provider_attempt_id: input.providerAttemptId,
      provider_call_id: call.providerCallId,
      tool_id: call.toolId,
      tool_version: call.toolVersion,
      arguments_excerpt: toolArgumentsExcerpt(call),
      normalized_operation_hash: operationHash,
    },
    artifactRefs: [argumentsArtifact.uri, callTranscriptArtifact.uri],
  }, async (tx) => {
    await tx.toolCall.create({
      data: {
        id: toolCallId,
        turnId: input.turnId,
        providerAttemptId: input.providerAttemptId,
        toolId: call.toolId,
        toolVersion: call.toolVersion,
        argumentsArtifact: argumentsArtifact.uri,
        normalizedOperationHash: operationHash,
        state: "PROPOSED",
      },
    });
  }));

  // Capability activation changes only this turn's declared context/tool
  // surface. It is persisted like every other provider call, but it is not a
  // kernel effect and therefore needs no scope capability or approval.
  if (call.toolId === "capability") {
    const outcome = call.arguments.action === "activate_workspace"
      ? {
          ok: true as const,
          data: {
            action: "activate_workspace" as const,
            workspace_activated: true,
            active_capabilities: input.capabilitySession.activeCapabilityIds(),
          },
          summary: "Workspace context and coding tools activated for this turn",
        }
      : input.capabilitySession.execute(call.arguments);
    const result = outcome.ok
      ? (() => {
          const base = okResult(outcome.data, {
            toolCallId,
            traceId: input.turnId,
            summary: outcome.summary,
          });
          const nextCursor = "next_cursor" in outcome.data ? outcome.data.next_cursor : null;
          return nextCursor === null || nextCursor === undefined
            ? base
            : {
                ...base,
                status: "partial" as const,
                truncation: {
                  occurred: true,
                  reason: "more admitted capability cards match this bounded page",
                  continuation: `call capability.${outcome.data.action} again with cursor ${nextCursor}`,
                },
              };
        })()
      : errorResult(outcome.message, {
          toolCallId,
          traceId: input.turnId,
          status: "error",
          summary: outcome.message,
        });
    const action = call.arguments.action;
    const transitionEvent = outcome.ok && (
      action === "activate_workspace"
      || action === "activate"
      || action === "deactivate"
    )
      ? capabilityTransitionEvent({
          action,
          ...(action === "activate" || action === "deactivate"
            ? { capabilityId: call.arguments.capability_id }
            : {}),
          turnId: input.turnId,
          taskId: input.taskId,
          providerCallId: call.providerCallId,
          activeCapabilities: input.capabilitySession.activeCapabilityIds(),
          activeToolSetHash: input.capabilitySession.activeToolSetHash(),
          nextToolIds: input.nextWorkspaceToolIds(),
        })
      : null;
    return persistSettledToolResult({
      input,
      call,
      toolCallId,
      callTranscriptArtifactUri: callTranscriptArtifact.uri,
      sideEffectId: null,
      result,
      workspaceRevisionBefore,
      workspaceRevisionAfter: workspaceRevisionBefore,
      ...(transitionEvent === null ? {} : { settlementEvents: [transitionEvent] }),
      ...operationContext,
    });
  }

  // Adaptive session recall reads only immutable artifacts belonging to
  // earlier COMPLETED turns in this exact task/thread. The artifact client
  // still crosses the kernel boundary, but this query creates no workspace
  // side effect, approval, or durable semantic memory claim.
  if (call.toolId === "recall") {
    if (call.arguments.action === "compaction_browse" || call.arguments.action === "compaction_read") {
      const startedAt = performance.now();
      try {
        const recalled = await runCompactionRecallTool({
          turnId: input.turnId,
          request: call.arguments,
          store: createCurrentTurnCompactionRecallStore(input.turnId, input.artifactClient),
        });
        const elapsed = performance.now() - startedAt;
        const base = okResult(recalled, {
          toolCallId,
          traceId: input.turnId,
          summary: compactionRecallSummary(recalled),
          sourceVersions: compactionRecallSourceVersions(recalled),
          timing: { executionMs: elapsed, totalMs: elapsed },
        });
        const continuation = compactionRecallContinuation(recalled);
        const result: ToolResult<unknown> = continuation === null
          ? base
          : {
              ...base,
              status: "partial",
              truncation: {
                occurred: true,
                reason: recalled.continuation !== null
                  ? "more exact source episodes remain outside this bounded page"
                  : "the exact source episode was excerpted within the requested character budget",
                continuation,
              },
            };
        return persistSettledToolResult({
          input,
          call,
          toolCallId,
          callTranscriptArtifactUri: callTranscriptArtifact.uri,
          sideEffectId: null,
          result,
          workspaceRevisionBefore,
          workspaceRevisionAfter: workspaceRevisionBefore,
          ...operationContext,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const elapsed = performance.now() - startedAt;
        const result = {
          ...errorResult(message, {
            toolCallId,
            traceId: input.turnId,
            status: "error",
            summary: `Compaction recall failed: ${message}`,
          }),
          timing: { queuedMs: 0, executionMs: elapsed, totalMs: elapsed },
        };
        return persistSettledToolResult({
          input,
          call,
          toolCallId,
          callTranscriptArtifactUri: callTranscriptArtifact.uri,
          sideEffectId: null,
          result,
          workspaceRevisionBefore,
          workspaceRevisionAfter: workspaceRevisionBefore,
          ...operationContext,
        });
      }
    }
    const startedAt = performance.now();
    const recalled = await runSessionRecall({
      taskId: input.taskId,
      threadId: input.threadId,
      currentTurnSequence: input.turnSequence,
      request: call.arguments,
      store: createSessionRecallStore(input.artifactClient),
    });
    const elapsed = performance.now() - startedAt;
    const { telemetry: _telemetry, ...modelVisibleRecall } = recalled;
    const base = okResult(recalled, {
      toolCallId,
      traceId: input.turnId,
      summary: sessionRecallSummary(recalled),
      sourceVersions: sessionRecallSourceVersions(recalled),
      timing: { executionMs: elapsed, totalMs: elapsed },
      diagnostics: recalled.warnings.map((warning) => ({
        severity: "warning" as const,
        code: "SESSION_RECALL_SOURCE_UNAVAILABLE",
        message: warning,
        path: null,
        range: null,
      })),
    });
    const pageContinuation = recalled.next_before_sequence === null
      ? null
      : `recall ${recalled.action} with before_sequence ${recalled.next_before_sequence}`;
    const sourceContinuation = recalled.results.flatMap((entry) => [
      entry.user_truncated ? entry.user_source_uri : null,
      entry.assistant_truncated ? entry.assistant_source_uri : null,
    ]).find((uri): uri is string => uri !== null) ?? null;
    const continuation = pageContinuation ?? sourceContinuation;
    const contentTruncated = sourceContinuation !== null;
    const result: ToolResult<unknown> = {
      ...base,
      status: recalled.warnings.length > 0 ? "partial" : "success",
      truncation: continuation === null
        ? base.truncation
        : {
            occurred: true,
            reason: pageContinuation !== null
              ? "older completed turns remain outside this bounded recall page"
              : contentTruncated
                ? "recalled turn text was excerpted within the requested character budget; exact source URIs are included"
                : "session recall output was bounded",
            continuation,
          },
    };
    return persistSettledToolResult({
      input,
      call,
      toolCallId,
      callTranscriptArtifactUri: callTranscriptArtifact.uri,
      sideEffectId: null,
      result,
      modelVisibleData: modelVisibleRecall,
      workspaceRevisionBefore,
      workspaceRevisionAfter: workspaceRevisionBefore,
      ...operationContext,
    });
  }

  // Observations (sideEffectClass "read") and processes (sideEffectClass
  // "process") are exempt from the semantic idempotency gate: the same read
  // issued after a write must dispatch or the model can never observe the
  // result of its own edit, and `exec cargo test` after a fix is a different
  // observation of a different workspace, not a replay.
  const priorEffect = semanticIdempotencyGateApplies(call)
    ? await db.sideEffect.findUnique({
      where: { effectType_idempotencyKey: { effectType: effect.effectType, idempotencyKey: operationHash } },
      select: { id: true, state: true },
    })
    : null;
  // Only an effect that may have reached the workspace blocks a replay. The
  // row is created at AUTHORIZED and never removed, so matching on existence
  // alone meant a mutation that FAILED (stale hash, rejected anchor) blocked
  // its own corrected retry with "already applied … Do not retry".
  const existingEffect = replayIsBlockedBy(priorEffect) ? priorEffect : null;
  if (existingEffect !== null) {
    const denialText = duplicateOperationDenial({
      call,
      effectId: existingEffect.id,
      effectState: existingEffect.state,
    });
    const policyDecisionId = await denyStandaloneTool({
      input,
      call,
      toolCallId,
      argumentsArtifactUri: argumentsArtifact.uri,
      effectType: effect.effectType,
      ruleId: "standalone.semantic-idempotency",
      explanation: denialText,
    });
    const result = {
      ...errorResult(denialText, {
        toolCallId,
        traceId: input.turnId,
        status: "denied",
        summary: `Duplicate ${call.toolId} was not dispatched; the earlier effect already applied it`,
      }),
      policyDecisionId,
    };
    return persistSettledToolResult({
      input,
      call,
      toolCallId,
      callTranscriptArtifactUri: callTranscriptArtifact.uri,
      sideEffectId: null,
      result,
      denial: {
        schemaVersion: TOOL_DENIAL_SCHEMA_VERSION,
        origin: "contract",
        disposition: "recoverable",
        decision: "deny",
        decisionId: policyDecisionId,
        explanation: denialText,
      },
      workspaceRevisionBefore,
      workspaceRevisionAfter: workspaceRevisionBefore,
      ...operationContext,
    });
  }
  const ledgerIdempotencyKey = effectLedgerIdempotencyKey({ call, operationHash, toolCallId });
  const operationClass = call.toolId === "inspect"
    ? CapabilityOperationProto.CAPABILITY_OPERATION_CODE_INTEL
    : call.toolId === "read"
      ? CapabilityOperationProto.CAPABILITY_OPERATION_READ
      // `write` is a patch transaction in the kernel and mints the same
      // capability, so it is bound by the contract's write scope.
      : call.toolId === "patch" || call.toolId === "write"
        ? CapabilityOperationProto.CAPABILITY_OPERATION_PATCH
        : call.toolId === "exec_poll"
          ? CapabilityOperationProto.CAPABILITY_OPERATION_JOB
          : call.toolId === "web_fetch"
            ? CapabilityOperationProto.CAPABILITY_OPERATION_NETWORK
            : CapabilityOperationProto.CAPABILITY_OPERATION_EXEC;
  const workspacePaths = call.toolId === "inspect"
    ? undefined
    : [call.toolId === "exec"
        ? call.arguments.cwd
        : call.toolId === "web_fetch"
          ? "."
          : call.toolId === "read" || call.toolId === "patch" || call.toolId === "write" || call.toolId === "grep" || call.toolId === "glob"
            ? call.arguments.path
            : "."];

  let context: RequestContext;
  try {
    context = await kernelContextForTask(
      input.taskId,
      input.turnId,
      [operationClass],
      workspacePaths,
    );
  } catch (error: unknown) {
    const explanation = error instanceof Error ? error.message : String(error);
    const kernelDenial = typedKernelPolicyDenial(error);
    if (kernelDenial !== null) {
      const result = {
        ...errorResult(kernelDenial.explanation, {
          toolCallId,
          traceId: input.turnId,
          status: "denied",
          summary: "Kernel policy denied capability admission",
        }),
        policyDecisionId: kernelDenial.decisionId ?? uuid(),
      };
      return persistSettledToolResult({
        input,
        call,
        toolCallId,
        callTranscriptArtifactUri: callTranscriptArtifact.uri,
        sideEffectId: null,
        result,
        denial: kernelDenial,
        workspaceRevisionBefore,
        workspaceRevisionAfter: workspaceRevisionBefore,
        ...operationContext,
      });
    }
    if (!(error instanceof TaskScopeError)) {
      const result = {
        ...errorResult(explanation, {
          toolCallId,
          traceId: input.turnId,
          status: "error",
          summary: "Capability admission failed",
        }),
        policyDecisionId: null,
      };
      return persistSettledToolResult({
        input,
        call,
        toolCallId,
        callTranscriptArtifactUri: callTranscriptArtifact.uri,
        sideEffectId: null,
        result,
        workspaceRevisionBefore,
        workspaceRevisionAfter: workspaceRevisionBefore,
        ...operationContext,
      });
    }
    const policyDecisionId = await denyStandaloneTool({
      input,
      call,
      toolCallId,
      argumentsArtifactUri: argumentsArtifact.uri,
      effectType: effect.effectType,
      ruleId: "task-contract.scope",
      explanation,
    });
    const result = {
      ...errorResult(explanation, {
        toolCallId,
        traceId: input.turnId,
        status: "denied",
        summary: "Task contract denied the tool call",
      }),
      policyDecisionId,
    };
    return persistSettledToolResult({
      input,
      call,
      toolCallId,
      callTranscriptArtifactUri: callTranscriptArtifact.uri,
      sideEffectId: null,
      result,
      denial: {
        schemaVersion: TOOL_DENIAL_SCHEMA_VERSION,
        origin: "contract",
        disposition: "recoverable",
        decision: "deny",
        decisionId: policyDecisionId,
        explanation,
      },
      workspaceRevisionBefore,
      workspaceRevisionAfter: workspaceRevisionBefore,
      ...operationContext,
    });
  }

  // The session's permission level, enforced here and nowhere else. It sits
  // after the contract-scope check on purpose: a call the contract refuses
  // is refused, not put to the user as a question.
  const permissionProfile = await sessionPermissionProfile(input.sessionId);
  if (approvalRequiredFor(permissionProfile, call) && !taskGrantsWithoutApproval(input.taskId, call.toolId)) {
    const verdict = await awaitToolApproval({
      input,
      call,
      toolCallId,
      effect,
      permissionProfile,
      argumentsArtifactUri: argumentsArtifact.uri,
    });
    if (verdict.kind === "aborted") throw new ToolAbortedError();
    if (verdict.kind === "allowed") {
      if (verdict.decision === "allow_for_task") grantToolForTask(input.taskId, call.toolId);
    } else {
      // Refused by the user, or by their absence. The model is told which,
      // and told not to try the same thing again.
      const explanation = verdict.kind === "denied"
        ? `The user denied this ${call.toolId} call. Do not retry it; continue without it or ask the user how to proceed.`
        : `The approval request for this ${call.toolId} call expired before the user decided. Do not retry it; ask the user how to proceed.`;
      const deniedPolicyDecisionId = await denyStandaloneTool({
        input,
        call,
        toolCallId,
        argumentsArtifactUri: argumentsArtifact.uri,
        effectType: effect.effectType,
        ruleId: verdict.kind === "denied" ? "permission-profile.user-denied" : "permission-profile.approval-expired",
        explanation,
      });
      const deniedResult = {
        ...errorResult(explanation, {
          toolCallId,
          traceId: input.turnId,
          status: "denied",
          summary: verdict.kind === "denied"
            ? `The user denied ${call.toolId}`
            : `Approval for ${call.toolId} expired`,
        }),
        policyDecisionId: deniedPolicyDecisionId,
      };
      return persistSettledToolResult({
        input,
        call,
        toolCallId,
        callTranscriptArtifactUri: callTranscriptArtifact.uri,
        sideEffectId: null,
        result: deniedResult,
        denial: {
          schemaVersion: TOOL_DENIAL_SCHEMA_VERSION,
          origin: "user",
          disposition: "recoverable",
          decision: "deny",
          decisionId: deniedPolicyDecisionId,
          explanation,
        },
        workspaceRevisionBefore,
        workspaceRevisionAfter: workspaceRevisionBefore,
        ...operationContext,
      });
    }
  }

  const policyDecisionId = uuid();
  const sideEffectId = generateUuid7();
  await effectSettlementService.authorize({
    taskId: input.taskId,
    toolCallId,
    toolId: call.toolId,
    sideEffectId,
    policyDecisionId,
    effectType: effect.effectType,
    argumentsArtifactUri: argumentsArtifact.uri,
    resourceUri: effect.resourceUri,
    reversibility: effect.reversibility,
    idempotencyKey: ledgerIdempotencyKey,
    workspaceId: input.workspaceId,
  });
  await effectSettlementService.start({
    taskId: input.taskId,
    toolCallId,
    toolId: call.toolId,
    sideEffectId,
    policyDecisionId,
    effectType: effect.effectType,
    argumentsArtifactUri: argumentsArtifact.uri,
    resourceUri: effect.resourceUri,
    reversibility: effect.reversibility,
    idempotencyKey: ledgerIdempotencyKey,
    workspaceId: input.workspaceId,
  });

  if (input.signal?.aborted) {
    await effectSettlementService.cancel({
      taskId: input.taskId,
      toolCallId,
      toolId: call.toolId,
      sideEffectId,
      reason: "turn-cancelled-before-dispatch",
    });
    throw new ToolAbortedError();
  }

  let dispatched = false;
  let result: ExecutedToolResult;
  try {
    dispatched = true;
    result = await executeStandaloneTool({
      clients: requireKernelUds(),
      context: { ...context, idempotencyKey: ledgerIdempotencyKey },
      workspaceId: input.workspaceId,
      workspaceRoot: await workspaceCanonicalRoot(input.workspaceId),
      call,
      internalToolCallId: toolCallId,
      sideEffectId,
      policyDecisionId,
      traceId: input.turnId,
      contractHash: input.contractHash,
      devMode: DEV_MODE,
      shellModeEnabled: SHELL_MODE_ENABLED,
      observedSources: input.observedSources,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error: unknown) {
    const kernelDenial = typedKernelPolicyDenial(error);
    if (kernelDenial !== null) {
      result = {
        ...errorResult(kernelDenial.explanation, {
          toolCallId,
          traceId: input.turnId,
          status: "denied",
          summary: `Kernel policy denied ${call.toolId}`,
        }),
        policyDecisionId: kernelDenial.decisionId ?? policyDecisionId,
        denial: kernelDenial,
      };
      const workspaceRevisionAfter = await readStandaloneWorkspaceRevision(input);
      return persistSettledToolResult({
        input,
        call,
        toolCallId,
        callTranscriptArtifactUri: callTranscriptArtifact.uri,
        sideEffectId,
        result,
        denial: kernelDenial,
        workspaceRevisionBefore,
        workspaceRevisionAfter,
        ...operationContext,
      });
    }
    if (error instanceof ToolAbortedError && !dispatched) {
      await effectSettlementService.cancel({
        taskId: input.taskId,
        toolCallId,
        toolId: call.toolId,
        sideEffectId,
        reason: "turn-cancelled-before-dispatch",
      });
      throw error;
    }
    if (error instanceof ToolAbortedError) {
      await effectSettlementService.markUnknown({
        taskId: input.taskId,
        toolCallId,
        sideEffectId,
        error: "turn cancelled after tool dispatch; settlement requires reconciliation",
      });
      throw new AmbiguousToolSettlementError(
        toolCallId,
        `Tool ${call.toolId} was cancelled after dispatch; settlement requires reconciliation`,
      );
    }
    if (call.toolId !== "read") {
      const message = error instanceof Error ? error.message : String(error);
      await effectSettlementService.markUnknown({
        taskId: input.taskId,
        toolCallId,
        sideEffectId,
        error: message,
      });
      throw new AmbiguousToolSettlementError(toolCallId, `Tool ${call.toolId} lost settlement certainty: ${message}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    result = {
      ...errorResult(message, {
        toolCallId,
        traceId: input.turnId,
        summary: `Read failed: ${message}`,
      }),
      policyDecisionId,
    };
  }

  const workspaceRevisionAfter = await readStandaloneWorkspaceRevision(input);
  return persistSettledToolResult({
    input,
    call,
    toolCallId,
    callTranscriptArtifactUri: callTranscriptArtifact.uri,
    sideEffectId,
    result,
    denial: result.denial,
    workspaceRevisionBefore,
    workspaceRevisionAfter,
    ...operationContext,
  });
}

async function denyStandaloneTool(input: {
  readonly input: StandaloneToolSettlementInput;
  readonly call: ParsedStandaloneToolCall;
  readonly toolCallId: string;
  readonly argumentsArtifactUri: string;
  readonly effectType: string;
  readonly ruleId: string;
  readonly explanation: string;
}): Promise<string> {
  const policyDecisionId = uuid();
  await mutateAgentState(() => emit({
    eventType: "tool.denied",
    aggregateType: "tool_call",
    aggregateId: input.toolCallId,
    correlationId: input.input.taskId,
    payload: {
      tool_call_id: input.toolCallId,
      tool_id: input.call.toolId,
      provider_call_id: input.call.providerCallId,
      policy_decision_id: policyDecisionId,
      rule_id: input.ruleId,
      explanation: input.explanation,
    },
    artifactRefs: [input.argumentsArtifactUri],
  }, async (tx) => {
    await tx.policyDecision.create({
      data: {
        id: policyDecisionId,
        toolCallId: input.toolCallId,
        effectType: input.effectType,
        normalizedInputArtifact: input.argumentsArtifactUri,
        decision: "deny",
        ruleIdsJson: JSON.stringify([input.ruleId]),
        constraintsJson: "{}",
        policyVersion: "secure-local-default:v1",
        explanation: input.explanation,
      },
    });
    await tx.toolCall.update({
      where: { id: input.toolCallId },
      data: { state: "DENIED", policyDecisionId, settledAt: new Date(), resultStatus: "denied" },
    });
  }));
  return policyDecisionId;
}

/**
 * A short, human-readable operand for a proposed tool call — the path being
 * read, the command being run, the pattern being searched for.
 *
 * The full arguments are already ingested as a linked artifact, but artifact
 * refs do not travel on the v1 event stream, so without this a client can only
 * say that *some* read happened. The excerpt is bounded and carries operands
 * the model chose, never file contents: `patch` deliberately reports only its
 * path, because its arguments hold whole file bodies.
 */
function toolArgumentsExcerpt(call: ParsedStandaloneToolCall): string {
  const excerpt = ((): string => {
    switch (call.toolId) {
      case "capability":
        return "capability_id" in call.arguments
          ? `${call.arguments.action}: ${call.arguments.capability_id}`
          : "query" in call.arguments && call.arguments.query !== undefined
            ? `${call.arguments.action}: ${call.arguments.query}`
            : call.arguments.action;
      case "read":
      case "patch":
      case "write":
        return call.arguments.path;
      case "exec": {
        const shell = call.arguments.shell;
        if (shell !== undefined) return shell.script;
        const program = call.arguments.program ?? "";
        return [program, ...call.arguments.args].join(" ").trim();
      }
      case "exec_poll":
        return call.arguments.background_id;
      case "web_fetch":
        return call.arguments.url;
      case "grep":
        return `${call.arguments.pattern} in ${call.arguments.path}`;
      case "glob":
        return call.arguments.pattern;
      case "inspect":
        return call.arguments.action === "symbol"
          ? `${call.arguments.action}: ${call.arguments.query}`
          : call.arguments.action;
      case "recall":
        return call.arguments.action === "search"
          ? `${call.arguments.action}: ${call.arguments.query}`
          : call.arguments.action === "read"
            ? `${call.arguments.action}: turn ${call.arguments.turn_sequence}`
            : call.arguments.action;
    }
  })();
  const codePoints = Array.from(excerpt);
  return codePoints.length <= TOOL_ARGUMENTS_EXCERPT_MAX_CHARS
    ? excerpt
    : `${codePoints.slice(0, TOOL_ARGUMENTS_EXCERPT_MAX_CHARS - 1).join("")}…`;
}

/** `path → sha256` observations a settled result proves, bounded and clean. */
function observedSourceVersionsOf(result: ToolResult<unknown>): Record<string, string> {
  const sources: Record<string, string> = {};
  if (result.status !== "success" && result.status !== "partial") return sources;
  for (const [path, sha256] of Object.entries(result.sourceVersions ?? {})) {
    if (typeof sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(sha256)) continue;
    if (path.length === 0 || path.length > 4_096) continue;
    sources[path] = sha256;
  }
  return sources;
}

/**
 * Restore this task's read-before-edit knowledge from the durable episode log.
 *
 * The tracker is per turn, so before this every follow-up turn's first edit
 * was denied with PATCH_REQUIRES_OBSERVED_SOURCE and had to re-read a file the
 * conversation had already read. Two indexed queries, no kernel RPCs: the
 * hashes were written onto the tool_result episodes when they settled.
 */
async function seedObservedSourcesFromEpisodes(
  taskId: string,
  workspaceId: string,
  tracker: ObservedSourceTracker,
): Promise<number> {
  const turns = await db.turn.findMany({
    where: { taskId },
    orderBy: { sequence: "asc" },
    select: { id: true },
  });
  if (turns.length === 0) return 0;
  const turnRank = new Map(turns.map((turn, index) => [turn.id, index]));
  const rows = await db.episode.findMany({
    where: { turnId: { in: turns.map((turn) => turn.id) }, kind: "tool_result" },
    select: { turnId: true, sequence: true, sourceVersionsJson: true },
  });
  const entries: { workspaceId: string; path: string; sha256: string }[] = [];
  for (const row of rows.sort((left, right) => {
    const rank = (turnRank.get(left.turnId) ?? 0) - (turnRank.get(right.turnId) ?? 0);
    return rank !== 0 ? rank : left.sequence - right.sequence;
  })) {
    const parsed = safeParse<Record<string, unknown> | null>(row.sourceVersionsJson, null);
    const sources = parsed?.sources;
    if (typeof sources !== "object" || sources === null) continue;
    for (const [path, sha256] of Object.entries(sources as Record<string, unknown>)) {
      if (typeof sha256 !== "string") continue;
      entries.push({ workspaceId, path, sha256 });
    }
  }
  return tracker.seed(entries);
}

interface LiveWorkingMemoryInput {
  readonly task: {
    readonly id: string;
    readonly sessionId: string;
    readonly threadId: string;
    readonly status: string;
    readonly phase: string;
    readonly verificationPlanId: string | null;
    readonly createdAt: Date;
    readonly completedAt: Date | null;
    readonly terminalReasonJson: string | null;
  };
  readonly contract: TaskContract;
  readonly contractContentHash: string;
  readonly criteriaRows: readonly {
    readonly criterionId: string;
    readonly statement: string;
    readonly required: boolean;
    readonly status: string;
  }[];
  readonly observedAt: Rfc3339Timestamp;
  readonly currentChanges: readonly {
    readonly path: string;
    readonly operation: string;
    readonly newSha256: string | null;
  }[];
  readonly failingTests: readonly string[];
  readonly diagnostics: readonly { readonly path: string; readonly message: string }[];
  readonly verificationFailures: readonly string[];
  readonly worldStateDigest: string;
}

function workingMemoryCriterionStatus(status: string): WorkingMemoryCriterion["status"] {
  const normalized = status.toLowerCase();
  if (["satisfied", "passed", "verified", "pass"].includes(normalized)) return "PASS";
  if (["unsatisfied", "failed", "fail", "error"].includes(normalized)) return "FAIL";
  if (["pending", "not_run", "not-run"].includes(normalized)) return "NOT_RUN";
  return "UNKNOWN";
}

function workingMemoryChangeKind(operation: string): WorkingMemoryFileChange["changeKind"] {
  const normalized = operation.toLowerCase();
  if (normalized.includes("create") || normalized === "add") return "created";
  if (normalized.includes("delete") || normalized === "remove") return "deleted";
  return "modified";
}

function workingMemoryBlockerKind(status: string): WorkingMemoryBlocker["kind"] | null {
  if (status === "NEEDS_USER_DECISION") return "awaiting_user";
  if (status === "POLICY_DENIED") return "policy_denied";
  if (status === "BUDGET_EXHAUSTED") return "budget_exhausted";
  if (status === "BLOCKED" || status === "FAILED_VERIFICATION") return "other";
  return null;
}

/**
 * Project the current task from authoritative operational records.
 *
 * This is working memory, not durable semantic memory: no model-generated
 * claim is stored, retrieved, or promoted. The output is rebuilt before each
 * provider attempt and is bounded by `buildWorkingMemoryContextSection`.
 */
async function loadLiveWorkingMemory(input: LiveWorkingMemoryInput): Promise<{
  readonly section: WorkingMemoryContextSection;
  readonly sourceVersions: Readonly<Record<string, string>>;
}> {
  const [failureRows, jobRows, budgetRows, approvalRows, writeToolCalls] = await Promise.all([
    db.operationObservation.findMany({
      where: {
        turn: { taskId: input.task.id },
        OR: [
          { status: { notIn: ["success", "partial"] } },
          { repeatedFailure: true },
          { oscillating: true },
          { failureClass: { not: null } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    db.job.findMany({
      where: { taskId: input.task.id },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        state: true,
        resolvedExecutable: true,
        cwdUri: true,
        startedAt: true,
        settledAt: true,
      },
    }),
    db.turnBudgetLedger.findMany({
      where: { turn: { taskId: input.task.id } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true, costMicros: true, updatedAt: true },
    }),
    db.approval.findMany({
      where: { taskId: input.task.id },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        requestedAt: true,
        resolvedAt: true,
        useCount: true,
        operationHash: true,
      },
    }),
    db.toolCall.findMany({
      where: {
        turn: { taskId: input.task.id },
        toolId: { in: ["patch", "write"] },
        state: "SETTLED",
      },
      orderBy: [{ settledAt: "desc" }, { id: "desc" }],
      select: { id: true, settledAt: true },
    }),
  ]);

  const writeToolSettledAt = new Map(
    writeToolCalls.map((toolCall) => [toolCall.id, toolCall.settledAt] as const),
  );
  const sourceRows = writeToolCalls.length === 0
    ? []
    : await db.episode.findMany({
        where: {
          kind: "tool_result",
          toolCallId: { in: writeToolCalls.map((toolCall) => toolCall.id) },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { toolCallId: true, sourceVersionsJson: true, createdAt: true },
      });

  const decisions: WorkingMemoryDecision[] = [...arpV2.decisions.values()]
    .filter((decision) => decision.taskId === input.task.id)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
    .map((decision) => ({
      id: decision.id as Uuid7,
      kind: /(^|[:/])user($|[:/])/i.test(decision.provenance)
        ? "user_decision"
        : "model_decision",
      summary: decision.statement,
      decidedAt: decision.recordedAt,
      decidedBy: null,
    }));

  const failedApproaches: WorkingMemoryFailedApproach[] = failureRows.map((failure) => {
    const evidence = contentHashSchema.safeParse(failure.resultHash);
    return {
      id: failure.id as Uuid7,
      summary: failure.objectiveStep ?? `${failure.toolId} returned ${failure.status}`,
      reason: failure.failureClass ?? failure.progressReason,
      attemptedAt: failure.createdAt.toISOString() as Rfc3339Timestamp,
      evidenceRefs: evidence.success ? [evidence.data] : [],
    };
  });

  const modifiedFilesByPath = new Map<string, WorkingMemoryFileChange>();
  for (const row of sourceRows) {
    const parsed = safeParse<Record<string, unknown> | null>(row.sourceVersionsJson, null);
    const sources = parsed?.sources;
    if (typeof sources !== "object" || sources === null || Array.isArray(sources)) continue;
    for (const [path, version] of Object.entries(sources)) {
      if (typeof version !== "string" || modifiedFilesByPath.has(path)) continue;
      modifiedFilesByPath.set(path, {
        path,
        changeKind: "modified",
        sourceVersion: version,
        observedAt: (writeToolSettledAt.get(row.toolCallId ?? "") ?? row.createdAt)
          .toISOString() as Rfc3339Timestamp,
      });
    }
  }
  for (const change of input.currentChanges) {
    modifiedFilesByPath.set(change.path, {
      path: change.path,
      changeKind: workingMemoryChangeKind(change.operation),
      sourceVersion: change.newSha256,
      observedAt: input.observedAt,
    });
  }
  const modifiedFiles = [...modifiedFilesByPath.values()]
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt) || left.path.localeCompare(right.path));

  const diagnosticErrors: WorkingMemoryDiagnostic[] = [
    ...input.diagnostics.map((diagnostic) => ({
      path: diagnostic.path,
      message: diagnostic.message,
      severity: "error" as const,
      observedAt: input.observedAt,
    })),
    ...input.verificationFailures.map((failure) => ({
      path: "<verification>",
      message: failure,
      severity: "error" as const,
      observedAt: input.observedAt,
    })),
  ];

  const activeJobStates = new Set(["STARTING", "RUNNING", "STOPPING", "KILLING", "REATTACHED"]);
  const runningJobs: WorkingMemoryJobRef[] = jobRows
    .filter((job) => job.startedAt !== null && activeJobStates.has(job.state))
    .map((job) => ({
      jobId: job.id as Uuid7,
      label: `${job.state}: ${job.resolvedExecutable ?? "process"} (${job.cwdUri})`,
      startedAt: job.startedAt?.toISOString() as Rfc3339Timestamp,
    }));

  const observedAtMs = Date.parse(input.observedAt);
  const computeSeconds = jobRows.reduce((total, job) => {
    if (job.startedAt === null) return total;
    const endMs = job.settledAt?.getTime() ?? observedAtMs;
    return total + Math.max(0, Math.floor((endMs - job.startedAt.getTime()) / 1_000));
  }, 0);
  const consumedApprovals = approvalRows.reduce((total, approval) => total + approval.useCount, 0);
  const modelMicros = budgetRows.reduce((total, ledger) => total + ledger.costMicros, 0n) as Micros;

  const blockers: WorkingMemoryBlocker[] = [
    ...[...arpV2.questions.values()]
      .filter((question) => question.taskId === input.task.id && question.status === "PENDING")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((question) => ({
        id: question.id as Uuid7,
        kind: "awaiting_user" as const,
        summary: question.prompt,
        raisedAt: question.createdAt,
      })),
    ...approvalRows
      .filter((approval) => approval.status === "pending")
      .map((approval) => ({
        id: approval.id as Uuid7,
        kind: "awaiting_user" as const,
        summary: `Approval is required for operation ${approval.operationHash}.`,
        raisedAt: approval.requestedAt.toISOString() as Rfc3339Timestamp,
      })),
  ];
  const taskBlockerKind = workingMemoryBlockerKind(input.task.status);
  if (taskBlockerKind !== null) {
    blockers.push({
      id: input.task.id as Uuid7,
      kind: taskBlockerKind,
      summary: input.task.terminalReasonJson === null
        ? `Task is ${input.task.status}.`
        : checkpointFailureDescription(input.task.terminalReasonJson, input.task.status),
      raisedAt: input.observedAt,
    });
  }

  const criterionStatuses = new Map<string, WorkingMemoryCriterion>(
    input.criteriaRows.map((criterion) => [
      criterion.criterionId,
      {
        id: criterion.criterionId,
        statement: criterion.statement,
        required: criterion.required,
        status: workingMemoryCriterionStatus(criterion.status),
        lastObservedAt: null,
        evidence: [],
      },
    ]),
  );
  const task: DomainTask = {
    id: input.task.id as Uuid7,
    sessionId: input.task.sessionId as Uuid7,
    threadId: input.task.threadId as Uuid7,
    contract: input.contract,
    status: taskStatusSchema.parse(input.task.status),
    phase: taskPhaseSchema.parse(input.task.phase),
    scopeLedgerId: null,
    verificationPlanId: input.task.verificationPlanId as Uuid7 | null,
    createdAt: input.task.createdAt.toISOString() as Rfc3339Timestamp,
    completedAt: input.task.completedAt === null
      ? null
      : input.task.completedAt.toISOString() as Rfc3339Timestamp,
  };

  const sourceVersions = {
    [`task://${input.task.id}`]: input.contractContentHash,
    [`working-memory://${input.task.id}/criteria`]: computeContentHash(canonicalJson(input.criteriaRows)),
    [`working-memory://${input.task.id}/decisions`]: computeContentHash(canonicalJson(decisions)),
    [`working-memory://${input.task.id}/failures`]: computeContentHash(canonicalJson(failedApproaches)),
    [`working-memory://${input.task.id}/files`]: computeContentHash(canonicalJson(modifiedFiles)),
    [`working-memory://${input.task.id}/diagnostics`]: computeContentHash(canonicalJson({
      digest: input.worldStateDigest,
      verificationFailures: input.verificationFailures,
    })),
    [`working-memory://${input.task.id}/jobs`]: computeContentHash(canonicalJson(jobRows.map((job) => ({
      id: job.id,
      state: job.state,
      resolvedExecutable: job.resolvedExecutable,
      cwdUri: job.cwdUri,
      startedAt: job.startedAt?.toISOString() ?? null,
      settledAt: job.settledAt?.toISOString() ?? null,
    })))),
    [`working-memory://${input.task.id}/budget`]: computeContentHash(canonicalJson({
      ledgers: budgetRows.map((ledger) => ({
        id: ledger.id,
        costMicros: ledger.costMicros,
        updatedAt: ledger.updatedAt.toISOString(),
      })),
      computeSeconds,
      consumedApprovals,
    })),
    [`working-memory://${input.task.id}/blockers`]: computeContentHash(canonicalJson(blockers)),
  };
  const section = await buildWorkingMemoryContextSection({
    task,
    capturedAt: input.observedAt,
    criterionStatuses,
    decisions,
    failedApproaches,
    modifiedFiles,
    diagnosticState: {
      failingTests: [...input.failingTests, ...input.verificationFailures],
      errors: diagnosticErrors,
      warnings: [],
      observedAt: input.observedAt,
    },
    runningJobs,
    budgetConsumption: {
      modelMicros,
      modelMicrosLimit: input.contract.budget.modelMicros,
      computeSeconds,
      computeSecondsLimit: input.contract.budget.computeSeconds,
      wallClockSeconds: Math.max(0, Math.floor((observedAtMs - input.task.createdAt.getTime()) / 1_000)),
      wallClockSecondsLimit: input.contract.budget.wallClockSeconds,
      humanApprovals: consumedApprovals,
      humanApprovalsLimit: input.contract.budget.humanApprovals,
    },
    blockers,
    sourceVersions,
  });
  return { section, sourceVersions };
}

async function persistSettledToolResult(input: {
  readonly input: StandaloneToolSettlementInput;
  /** A parsed call, or the identity of a rejected one. */
  readonly call: ProviderCallIdentity;
  readonly toolCallId: string;
  readonly callTranscriptArtifactUri: string;
  readonly sideEffectId: string | null;
  readonly result: ToolResult<unknown>;
  /** Structured provenance retained in the full result artifact and loop. */
  readonly denial?: ToolDenialMetadata | undefined;
  /** Optional data projection; the full result artifact retains result.data. */
  readonly modelVisibleData?: unknown;
  readonly workspaceRevisionBefore?: string | null | undefined;
  readonly workspaceRevisionAfter?: string | null | undefined;
  readonly verificationDelta?: string | null | undefined;
  readonly hypothesisId?: string | null | undefined;
  readonly criterionIds?: readonly string[] | undefined;
  readonly objectiveStep?: string | null | undefined;
  /** Semantic transitions committed atomically with the settled tool result. */
  readonly settlementEvents?: readonly CapabilityTransitionEvent[] | undefined;
}): Promise<EngineToolSettlement> {
  // Keep the model-facing projection minimal, while the authoritative result
  // artifact retains denial provenance and the kernel decision identity.
  const durableResult: ExecutedToolResult = input.denial === undefined
    ? input.result
    : { ...input.result, denial: input.denial };
  const fullResultText = canonicalJson(durableResult);
  const fullResultArtifact = await input.input.artifactClient.ingest(
    new TextEncoder().encode(fullResultText),
    { mediaType: "application/json", custom: { purpose: "tool-result", toolCallId: input.toolCallId } },
  );
  await input.input.artifactClient.link(fullResultArtifact.hash, "tool_call", input.toolCallId, "result");
  const fullResultBytes = new TextEncoder().encode(fullResultText).byteLength;
  // Dual-path projection (ADR-0039 §11): the model-visible transcript carries
  // a minimal view of the same settled result; ceremony stays in the
  // observability artifact ingested above.
  const modelVisibleRecord = projectModelVisibleResult(
    input.result,
    input.modelVisibleData === undefined ? undefined : { data: input.modelVisibleData },
  );
  const projectedResult = fullResultBytes <= MAX_TOOL_MODEL_RESULT_BYTES
    ? modelVisibleRecord
    : z.record(z.string(), z.unknown()).parse(canonicalJson({
        ...modelVisibleRecord,
        data: null,
        summary: `${input.result.summary} Full result: ${fullResultArtifact.uri}`,
        truncation: {
          occurred: true,
          reason: `tool result exceeded ${MAX_TOOL_MODEL_RESULT_BYTES} model bytes`,
          continuation: fullResultArtifact.uri,
        },
      }));
  const resultTranscriptText = canonicalJson(providerToolResultTranscript(input.call, projectedResult));
  if (new TextEncoder().encode(resultTranscriptText).byteLength > MAX_TOOL_MODEL_RESULT_BYTES) {
    throw new Error("bounded tool result transcript still exceeds the model-result limit");
  }
  const resultTranscriptArtifact = await input.input.artifactClient.ingest(
    new TextEncoder().encode(resultTranscriptText),
    { mediaType: "application/json", custom: { purpose: "tool-result-transcript", toolCallId: input.toolCallId } },
  );
  await input.input.artifactClient.link(resultTranscriptArtifact.hash, "tool_call", input.toolCallId, "provider-result-transcript");

  const toolState = input.result.status === "denied"
    ? "DENIED"
    : input.result.status === "success" || input.result.status === "partial"
      ? "SETTLED"
      : "FAILED";
  await effectSettlementService.settle({
    taskId: input.input.taskId,
    turnId: input.input.turnId,
    providerAttemptId: input.input.providerAttemptId,
    toolCallId: input.toolCallId,
    toolId: input.call.toolId,
    sideEffectId: input.sideEffectId,
    providerCallId: input.call.providerCallId,
    status: input.result.status,
    resultStatus: input.result.status,
    toolState,
    summary: input.result.summary,
    callTranscriptArtifactUri: input.callTranscriptArtifactUri,
    resultArtifactUri: fullResultArtifact.uri,
    resultTranscriptArtifactUri: resultTranscriptArtifact.uri,
    resultTranscriptHash: resultTranscriptArtifact.hash,
    errorJson: toolState === "SETTLED"
      ? null
      : JSON.stringify({
          summary: input.result.summary,
          ...(input.denial === undefined ? {} : { denial: input.denial }),
        }),
    truncation: input.result.truncation,
    observedSourceVersions: observedSourceVersionsOf(input.result),
  }, input.settlementEvents ?? []);
  const status = input.result.status;
  return {
    status: status === "success" || status === "partial" || status === "error"
      || status === "denied" || status === "timeout" || status === "cancelled" || status === "unknown"
      ? status
      : "unknown",
    resultHash: fullResultArtifact.hash,
    errorCode: status === "success" || status === "partial"
      ? null
      : input.denial?.origin === "kernel"
        ? "KERNEL_POLICY_DENIED"
        : `TOOL_RESULT_${status.toUpperCase()}`,
    errorClass: status === "success" || status === "partial"
      ? null
      : input.denial?.origin === "kernel" ? "kernel_policy_denied" : status,
    denial: input.denial,
    workspaceRevisionBefore: input.workspaceRevisionBefore ?? null,
    workspaceRevisionAfter: input.workspaceRevisionAfter ?? null,
    verificationDelta: input.verificationDelta ?? null,
    hypothesisId: input.hypothesisId ?? null,
    criterionIds: input.criterionIds,
    objectiveStep: input.objectiveStep ?? null,
  };
}

// ────────────────────────── Agent loop ─────────────────────────────────────

/**
 * Pair settled episodes into ordered `[toolName, resultJson]` observations
 * for world-state derivation. A tool_result observation inherits the tool
 * name of its immediately preceding tool_call episode.
 */
function buildEpisodeObservations(
  episodes: readonly { readonly kind: string; readonly contentRef: ContentHash | null }[],
  content: ReadonlyMap<ContentHash, string>,
): { readonly toolName: string; readonly resultJson: string }[] {
  const observations: { readonly toolName: string; readonly resultJson: string }[] = [];
  let pendingToolName: string | null = null;
  for (const episode of episodes) {
    const body = episode.contentRef === null ? null : content.get(episode.contentRef);
    if (body === undefined || body === null) continue;
    if (episode.kind === "tool_call") {
      try {
        const parsed: unknown = JSON.parse(body);
        if (
          typeof parsed === "object" && parsed !== null &&
          typeof (parsed as Record<string, unknown>).tool_name === "string"
        ) {
          pendingToolName = (parsed as { tool_name?: unknown }).tool_name as string;
        }
      } catch {
        pendingToolName = null;
      }
    } else if (episode.kind === "tool_result" && pendingToolName !== null) {
      observations.push({ toolName: pendingToolName, resultJson: body });
      pendingToolName = null;
    }
  }
  return observations;
}

async function executeTurnTransition(plan: TurnTransitionPlan, tx: Prisma.TransactionClient): Promise<void> {
  const update = await tx.turn.updateMany({
    where: { id: plan.aggregateId, state: { in: [...plan.expectedStates] } },
    data: {
      state: plan.nextState,
      ...(plan.setStartedAt ? { startedAt: new Date() } : {}),
      ...(plan.setCompletedAt ? { completedAt: new Date() } : {}),
      ...(plan.terminalErrorJson === null ? {} : { terminalErrorJson: plan.terminalErrorJson }),
    },
  });
  if (update.count !== 1) throw new Error(plan.conflictError);
}

/**
 * The agent loop: compile context → provider attempt → tool settlement →
 * verification → completion. Each step emits semantic events so the UI can
 * observe the full trajectory.
 *
 * Context compilation can run locally. Provider execution cannot proceed
 * until a kernel-brokered transport is configured; the missing boundary is
 * reported as a blocked task and never replaced by a synthetic response.
 */
async function agentLoop(turnId: string): Promise<void> {
  const turn = await db.turn.findUnique({
    where: { id: turnId },
    include: {
      task: { include: { contractVersions: { orderBy: { version: "desc" }, take: 1 } } },
      thread: { include: { session: { include: { workspace: true } } } },
    },
  });
  if (!turn) return;
  const resumeVerificationFromState = turn.state === "RESPONSE_VALIDATING" || turn.state === "VERIFYING";
  const existingController = activeTurnAbortControllers.get(turnId);
  const abortController = existingController ?? new AbortController();
  activeTurnAbortControllers.set(turnId, abortController);
  let turnProfile: TerminusExecutionProfile | null = null;
  let turnBaseWorkspaceRevision = "unresolved";
  let latestHypothesisId: string | null = null;
  let turnContextBudgetJson: string | null = null;
  let activeEngine: CodingTurnEngine | null = null;
  // Steering cursor: highest steering_message sequence already handed to the
  // engine. Episodes are append-only per turn, so the cursor only moves.
  let lastSteeredSequence = 0;
  // Compaction preflight cache: artifact URI → byte size, fetched from kernel
  // artifact metadata at most once per artifact for the turn's lifetime.
  const turnArtifactSizeCache = new Map<string, number>();
  // Token counts are model-specific, but one turn has one selected model.
  const turnArtifactTokenCache = new Map<string, number>();
  // Identical failed compactions get one provider attempt per turn. Appending
  // an episode changes the source fingerprint and creates a new opportunity.
  const compactionFailureGuard = new TurnCompactionFailureGuard();
  let persistEvidenceForCurrentTurn: (
    terminalOutcome: EvidenceTerminalOutcome,
    options?: {
      readonly finalWorkspaceRevision?: string | undefined;
      readonly proofBundleHash?: string | null | undefined;
      readonly admissionState?: "PREPARED" | "COMMITTED" | "QUARANTINED" | undefined;
      readonly verificationPlanId?: string | undefined;
    },
  ) => Promise<void> = async () => {};
  try {
    // 1. CONTEXT_COMPILING. A restart may leave the turn at the last safe
    // pre-provider boundary; continuing from there is idempotent.
    const enteredContextCompilation = await mutateAgentState(async () => {
      const current = await db.turn.findUnique({ where: { id: turnId }, select: { state: true } });
      if (
        current?.state === "CONTEXT_COMPILING"
        || current?.state === "RESPONSE_VALIDATING"
        || current?.state === "VERIFYING"
      ) return true;
      if (current?.state !== "PENDING" && current?.state !== "REPAIRING") return false;
      const resumedFrom: "PENDING" | "REPAIRING" = current.state;
      await emit({
        eventType: "turn.context_compiling",
        aggregateType: "turn", aggregateId: turnId,
        correlationId: turn.taskId ?? undefined,
        payload: { phase: "context_compiling", resumed_from: resumedFrom },
      }, async (tx) => {
        await executeTurnTransition(
          planEnterContextCompiling({ turnId, taskId: turn.taskId, resumedFrom }),
          tx,
        );
      });
      return true;
    });
    if (!enteredContextCompilation) return;
    const task = turn.task;
    const contractRow = task?.contractVersions[0];
    if (task === null || contractRow === undefined) {
      throw new Error(`turn ${turnId} has no active task contract`);
    }
    // Client streaming: durable text-delta emitter shared by all transports.
    const providerTextDeltas = createProviderTextDeltaEmitter(turnId, task.id);
    const criteriaRows = await db.acceptanceCriterion.findMany({
      where: { taskId: task.id, contractVersion: contractRow.version },
      orderBy: { criterionId: "asc" },
    });
    const contract = persistedTaskContract(task, contractRow, criteriaRows);
    const taskSnapshot: TaskSnapshot = {
      taskId: task.id as TaskSnapshot["taskId"],
      contract,
      phase: task.phase,
      changedFiles: [],
      failingTests: [],
      diagnostics: [],
      unknowns: safeParse<string[]>(contractRow.unknownsJson, []),
    };

    const workspace = turn.thread.session.workspace;
    const operationWorkspaceRevision = async (): Promise<string | null> => {
      try {
        const revisionContext = await kernelTaskContext({
          sessionId: turn.thread.sessionId,
          taskId: task.id,
          turnId,
          workspaceId: workspace.id,
          operationClasses: [CapabilityOperationProto.CAPABILITY_OPERATION_EXEC],
          workspacePaths: leastWorkspaceScope([
            ...contract.allowedScope.readPaths,
            ...contract.allowedScope.writePaths,
          ]),
        });
        return await resolveWorkspaceRevision(
          requireKernelUds(),
          revisionContext,
          workspace.id,
          abortController.signal,
        );
      } catch {
        return null;
      }
    };
    try {
      const baseRevisionContext = await kernelTaskContext({
        sessionId: turn.thread.sessionId,
        taskId: task.id,
        turnId,
        workspaceId: workspace.id,
        operationClasses: [CapabilityOperationProto.CAPABILITY_OPERATION_EXEC],
        workspacePaths: leastWorkspaceScope([
          ...contract.allowedScope.readPaths,
          ...contract.allowedScope.writePaths,
        ]),
      });
      turnBaseWorkspaceRevision = await resolveWorkspaceRevision(
        requireKernelUds(),
        baseRevisionContext,
        workspace.id,
        abortController.signal,
      );
    } catch {
      // A terminal provider/policy outcome can still be recorded, but the
      // evidence bundle marks the unavailable source identity explicitly.
      turnBaseWorkspaceRevision = "unresolved";
    }
    const buildArtifactContext = async (): Promise<RequestContext> => ({
      ...await kernelTaskContext({
        sessionId: turn.thread.sessionId,
        taskId: task.id,
        turnId,
        workspaceId: workspace.id,
        operationClasses: [
          CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST,
          CapabilityOperationProto.CAPABILITY_OPERATION_CODE_INTEL,
        ],
        workspacePaths: leastWorkspaceScope([
          ...contract.allowedScope.readPaths,
          ...contract.allowedScope.writePaths,
        ]),
      }),
      sessionId: turn.thread.sessionId,
      taskId: task.id,
      turnId,
      workspaceId: workspace.id,
      idempotencyKey: `context:${turnId}`,
    });
    const artifactClient = createKernelArtifactClient(requireKernelUds().artifacts, buildArtifactContext);
    /**
     * Tell the model its last response was cut off by the output limit and
     * that it should carry on.
     *
     * It is written as a steering episode because that is the one channel the
     * engine already drains at the top of every iteration and the context
     * compiler already carries to the provider — the nudge reaches the next
     * request with no new plumbing, and it is durable, so a restart can see
     * why the turn kept going.
     */
    const queueTruncationContinuation = async (
      stop: { readonly kind: "length" | "truncated_tool_calls"; readonly toolCallCount?: number },
    ): Promise<void> => {
      const message = stop.kind === "truncated_tool_calls"
        ? `Your last response hit the output limit while writing ${stop.toolCallCount ?? 0} tool call(s), so they were discarded before running — nothing was executed. Continue from where you stopped and re-issue those calls, keeping each one small enough to finish.`
        : "Your last response hit the output limit and was cut off mid-message. Continue from exactly where you stopped; do not repeat what you already wrote.";
      const episodeId = uuid();
      const nudgeArtifact = await artifactClient.ingest(
        new TextEncoder().encode(message),
        { mediaType: "text/plain", custom: { purpose: "steering", turnId, reason: "output_truncated" } },
      );
      await artifactClient.link(nudgeArtifact.hash, "episode", episodeId, "content");
      await mutateAgentState(() => emit({
        eventType: "turn.output_truncated",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: task.id,
        payload: {
          reason: stop.kind,
          tool_calls_discarded: stop.toolCallCount ?? 0,
          continuation: "queued",
        },
        artifactRefs: [nudgeArtifact.uri],
      }, async (tx) => {
        const latest = await tx.episode.findFirst({
          where: { turnId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        await tx.episode.create({
          data: {
            id: episodeId,
            turnId,
            sequence: (latest?.sequence ?? 0) + 1,
            kind: "steering_message",
            modelVisible: true,
            contentArtifact: nudgeArtifact.uri,
            sourceVersionsJson: JSON.stringify({ steering: nudgeArtifact.hash, reason: "output_truncated" }),
          },
        });
        await prepareTurnForProviderContinuation(tx.turn, turnId);
      }));
    };
    /**
     * Give one bounded, durable continuation to a coding turn that stopped
     * after expressing intent without changing the workspace or producing
     * evidence for its required criteria. The same engine keeps the selected
     * provider/account/model/reasoning and turn budget pinned.
     */
    const queueIntentOnlyContinuation = async (
      pendingCriterionIds: readonly string[],
    ): Promise<void> => {
      const message =
        "No workspace change was made in your previous response, and required acceptance criteria are still pending. Continue the requested task now: use an allowed workspace-mutating tool to make the change, then verify it. Do not claim completion without a mutation and evidence. If the mutation is blocked or not authorized, state that explicitly instead of presenting this as completed work.";
      const episodeId = uuid();
      const nudgeArtifact = await artifactClient.ingest(
        new TextEncoder().encode(message),
        {
          mediaType: "text/plain",
          custom: {
            purpose: "steering",
            turnId,
            reason: "intent_only_stop",
            pendingCriterionIds,
          },
        },
      );
      await artifactClient.link(nudgeArtifact.hash, "episode", episodeId, "content");
      await mutateAgentState(() => emit({
        eventType: "turn.steering_queued",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: task.id,
        payload: {
          reason: "intent_only_stop",
          continuation: "queued",
          pending_criterion_ids: pendingCriterionIds,
        },
        artifactRefs: [nudgeArtifact.uri],
      }, async (tx) => {
        const latest = await tx.episode.findFirst({
          where: { turnId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        await tx.episode.create({
          data: {
            id: episodeId,
            turnId,
            sequence: (latest?.sequence ?? 0) + 1,
            kind: "steering_message",
            modelVisible: true,
            contentArtifact: nudgeArtifact.uri,
            sourceVersionsJson: JSON.stringify({
              steering: nudgeArtifact.hash,
              reason: "intent_only_stop",
              pending_criterion_ids: pendingCriterionIds,
            }),
          },
        });
        await prepareTurnForProviderContinuation(tx.turn, turnId);
      }));
    };
    persistEvidenceForCurrentTurn = async (
      terminalOutcome: EvidenceTerminalOutcome,
      options: {
        readonly finalWorkspaceRevision?: string | undefined;
        readonly proofBundleHash?: string | null | undefined;
        readonly admissionState?: "PREPARED" | "COMMITTED" | "QUARANTINED" | undefined;
        readonly verificationPlanId?: string | undefined;
      } = {},
    ): Promise<void> => {
      if (turnProfile === null) return;
      const [attempts, toolCalls, verificationResultIds] = await Promise.all([
        db.providerAttempt.findMany({
          where: { turnId },
          orderBy: { attemptNumber: "asc" },
          select: {
            id: true,
            contextManifestId: true,
            requestArtifact: true,
            responseArtifact: true,
          },
        }),
        db.toolCall.findMany({
          where: { turnId },
          orderBy: { proposedAt: "asc" },
          select: { id: true },
        }),
        turnEvidenceVerificationResultIds(
          options.verificationPlanId ?? null,
          (verificationPlanId) => db.verificationResult.findMany({
            where: { planId: verificationPlanId },
            orderBy: { startedAt: "asc" },
            select: { id: true },
          }),
        ),
      ]);
      await persistEvidenceBundle({
        taskId: task.id,
        turnId,
        contractVersion: contractRow.version,
        baseWorkspaceRevision: turnBaseWorkspaceRevision,
        finalWorkspaceRevision: options.finalWorkspaceRevision ?? turnBaseWorkspaceRevision,
        profile: turnProfile,
        providerAttemptIds: attempts.map((attempt) => attempt.id),
        contextManifestIds: attempts.map((attempt) => attempt.contextManifestId),
        requestArtifactHashes: attempts
          .map((attempt) => artifactUriHash(attempt.requestArtifact))
          .filter((hash): hash is string => hash !== null),
        responseArtifactHashes: attempts
          .map((attempt) => artifactUriHash(attempt.responseArtifact))
          .filter((hash): hash is string => hash !== null),
        toolCallIds: toolCalls.map((toolCall) => toolCall.id),
        verificationResultIds,
        proofBundleHash: options.proofBundleHash ?? null,
        terminalOutcome,
        admissionState: options.admissionState,
        artifacts: artifactClient,
      });
    };
    const inputArtifactUri = artifactUriSchema.parse(turn.initiatingInputArtifact);
    const inputArtifactHash = contentHashSchema.parse(
      `sha256:${inputArtifactUri.slice("artifact://sha256/".length)}`,
    );
    const inputBytes = await artifactClient.get(inputArtifactHash);
    if (inputBytes.byteLength > MAX_REQUEST_BYTES) {
      throw new Error(`turn input artifact exceeds the ${MAX_REQUEST_BYTES}-byte admission limit`);
    }
    const userInput = new TextDecoder("utf-8", { fatal: true }).decode(inputBytes);

    const worldState: WorldStateSnapshot = {
      observedAt: now(),
      sourceVersions: {
        [`task://${task.id}`]: contractRow.contentHash,
        [`workspace://${workspace.id}`]: workspace.lastOpenedAt.toISOString(),
        "policy://secure-local-default": "v1",
      },
      sections: {
        // `request` duplicates the `user_message` episode, which now renders
        // with `role: user`; the compiler suppresses it (see
        // SUPPRESSED_WORLD_STATE_SECTIONS) so the model reads the ask once.
        request: { text: userInput, artifact: inputArtifactUri },
        task: { id: task.id, status: task.status, phase: task.phase, contractVersion: contractRow.version },
        workspace: { id: workspace.id, rootUri: workspace.rootUri, trust: workspace.trust },
        verification: { status: "pending", acceptanceCriteria: criteriaRows.map((criterion) => criterion.criterionId) },
        // No `memory` section: there is no memory mechanism to describe. The
        // section only ever said "disabled", and saying it cost tokens and
        // invited the model to look for a tool that does not exist.
      },
    };
    const checkpointRow = await db.checkpoint.findFirst({
      where: { threadId: turn.threadId, taskId: task.id, admissionState: "COMMITTED" },
      orderBy: { createdAt: "desc" },
    });
    const checkpoint: Checkpoint | null = checkpointRow === null
      ? null
      : await loadValidatedCheckpoint({
          row: checkpointRow,
          artifacts: artifactClient,
          contract,
          taskId: task.id,
          taskSourceVersion: contractRow.contentHash,
        });
    const providerConfiguration = await db.providerConfiguration.findUnique({
      where: { id: PROVIDER_CONFIGURATION_ID },
    });
    const gatewayProviderConfiguration = await db.gatewayProviderConfiguration.findUnique({
      where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
    });
    // The connected provider account, pinned on the turn row at admission so
    // it cannot change under a turn that is already running. An account that
    // has since been disconnected, expired, or lost the model fails the turn:
    // running the user's prompt against a different provider than the one they
    // picked is the one outcome that must never happen silently.
    const selectedProviderAccount = turn.selectedProviderAccountId === null
      ? null
      : await db.providerAccount.findUnique({ where: { id: turn.selectedProviderAccountId } });
    if (turn.selectedProviderAccountId !== null && selectedProviderAccount === null) {
      throw new Error(
        `provider account ${turn.selectedProviderAccountId} was disconnected before this turn ran`,
      );
    }
    if (selectedProviderAccount !== null && selectedProviderAccount.status !== "connected") {
      throw new Error(
        `provider account ${selectedProviderAccount.displayName} is ${selectedProviderAccount.status}${selectedProviderAccount.statusDetail === "" ? "" : `: ${selectedProviderAccount.statusDetail}`}`,
      );
    }
    const selectedAccountModel = selectedProviderAccount === null || turn.selectedModel === null
      ? null
      : await admittedProviderAccountModel(
          selectedProviderAccount,
          turn.selectedModel,
          abortController.signal,
        );
    if (selectedProviderAccount !== null && selectedAccountModel === null) {
      throw new Error(
        `model ${turn.selectedModel ?? "(none)"} is not admitted for provider account ${selectedProviderAccount.displayName}`,
      );
    }
    const accountRouting = selectedProviderAccount === null || selectedAccountModel === null
      ? null
      : (() => {
          const providerId = providerAccountProviderId(selectedProviderAccount);
          const observedAt = now();
          // An account synthesized from a positively detected OpenCode
          // installation is an existing local delegation to this exact
          // gateway, like an imported credential account. Anonymous gateway
          // use with no installed OpenCode remains behind explicit terms.
          const configuredGatewayTermsAdmitted = gatewayProviderConfiguration?.workspaceAccess === true
              && gatewayProviderConfiguration.privacyTermsAdmitted
              && gatewayProviderConfiguration.privacyTermsVersion
                === currentGatewayPrivacyTermsVersion(
                  gatewayProviderConfiguration.deployment === "go" ? "go" : "zen",
                );
          const workspaceAccess = providerAccountWorkspaceAccess(
            selectedProviderAccount,
            configuredGatewayTermsAdmitted,
          );
          return {
            account: selectedProviderAccount,
            model: selectedAccountModel,
            providerId,
            gatewayModel: toGatewayModel({
              account: selectedProviderAccount,
              model: selectedAccountModel,
              providerId,
              observedAt,
            }),
            snapshot: providerAccountCapabilitySnapshot({
              account: selectedProviderAccount,
              model: selectedAccountModel,
              providerId,
              observedAt,
              workspaceAccess,
            }),
            endpoint: providerAccountEndpoint(selectedProviderAccount),
            extraHeaders: providerAccountRequestHeaders(
              selectedProviderAccount,
              turn.thread.sessionId,
              turn.threadId,
            ),
            scope: providerAccountCapabilityScope(selectedProviderAccount),
          };
        })();
    const localProviderCommand = providerConfiguration === null
      ? parseLocalProviderCommand(process.env.TERMINUS_LOCAL_PROVIDER_COMMAND_JSON)
      : providerConfigurationCommand(providerConfiguration);
    const localToolsEnabled = localProviderCommand?.toolsEnabled ?? false;
    const localProvider = providerConfiguration === null
      ? (localProviderCommand === null
          ? unconfiguredProviderSnapshot(now())
          : configuredLocalProviderSnapshot(
              {
                program: localProviderCommand.program,
                args: [...localProviderCommand.args],
                model: localProviderCommand.model,
                timeout_seconds: localProviderCommand.timeoutSeconds,
                tools_enabled: localToolsEnabled,
              },
              1,
              now(),
            ))
      : configuredLocalProviderSnapshot(
          parseProviderConfigurationInput({
            program: providerConfiguration.program,
            args: JSON.parse(providerConfiguration.argsJson) as unknown,
            model: providerConfiguration.model,
            timeout_seconds: providerConfiguration.timeoutSeconds,
            tools_enabled: providerConfiguration.toolsEnabled,
          }),
          providerConfiguration.revision,
          now(),
        );
    const localModel: ModelCapabilitySnapshot = {
      modelKey: localProviderCommand?.model ?? ("local/unconfigured" as ModelKey),
      providerId: localProvider.providerId,
      snapshot: localProvider,
      observedAt: localProvider.observedAt,
    };
    // Transport precedence (ADR-0039 §10, audit P0-2): vendor-direct BYO-key
    // configuration > OpenCode gateway > local NDJSON command. The direct
    // configuration references a kernel secret capability URI only; key
    // material never appears in configuration or logs.
    const directConfiguration = accountRouting !== null
      ? null
      : parseDirectProviderConfiguration(process.env[DIRECT_PROVIDER_CONFIGURATION_ENV]);
    const directObservedAt = now();
    // H7: a turn may name its own admitted model; H4: resolve the discovery
    // record through memory, the durable row, and finally one bounded on-demand
    // discovery, instead of failing the turn for a cold in-process cache.
    const gatewayCredential = accountRouting !== null || gatewayProviderConfiguration === null
      ? null
      : gatewayDiscoveryCredential(gatewayProviderConfiguration);
    const requestedModelId = turn.selectedModel ?? gatewayProviderConfiguration?.model ?? null;
    const discoveredGatewayRecord = accountRouting !== null
      || directConfiguration !== null
      || gatewayProviderConfiguration === null
      || gatewayCredential === null
      || requestedModelId === null
      ? null
      : await admittedGatewayModelRecord(gatewayCredential, requestedModelId, abortController.signal);
    // An account-routed turn reuses the gateway transport: `GatewayTransport`
    // and `GatewayRenderer` already take a base URL and protocol per model, so
    // a connected account needs no second chat-completions transport.
    const gatewayModel = accountRouting !== null
      ? accountRouting.gatewayModel
      : directConfiguration !== null || gatewayProviderConfiguration === null
        ? null
        : configuredGatewayModel(
            turn.selectedModel === null
              ? gatewayProviderConfiguration
              : { ...gatewayProviderConfiguration, model: turn.selectedModel },
            now(),
            discoveredGatewayRecord,
          );
    // Respect the effort selected in the composer even for direct replies.
    // A small prompt should be cheap because its context and tool surface are
    // small, not because the harness silently changes the user's model dial.
    const turnReasoningEffort = parseReasoningEffort(turn.selectedReasoningEffort);
    const selectedProvider = accountRouting !== null
      ? accountRouting.snapshot
      : directConfiguration !== null
      ? configuredDirectProviderSnapshot(directConfiguration, directObservedAt)
      : gatewayModel === null
        ? localProvider
        : configuredGatewayProviderSnapshot(
            gatewayModel,
            gatewayProviderConfiguration?.revision ?? 0,
            gatewayProviderConfiguration?.workspaceAccess ?? false,
            gatewayProviderConfiguration?.privacyTermsAdmitted ?? false,
            gatewayProviderConfiguration?.privacyTermsVersion ?? null,
          );
    const selectedModel: ModelCapabilitySnapshot = accountRouting !== null
      ? {
          modelKey: accountRouting.model.id as ModelKey,
          providerId: accountRouting.providerId,
          snapshot: selectedProvider,
          observedAt: selectedProvider.observedAt,
        }
      : directConfiguration !== null
      ? {
          modelKey: directModelKey(directConfiguration),
          providerId: directProviderId(directConfiguration.vendor),
          snapshot: selectedProvider,
          observedAt: selectedProvider.observedAt,
        }
      : gatewayModel === null
        ? localModel
        : {
            modelKey: gatewayModelKey(gatewayModel),
            providerId: selectedProvider.providerId,
            snapshot: selectedProvider,
            observedAt: selectedProvider.observedAt,
          };
    const gatewayBindingId: string = accountRouting !== null
      ? accountRouting.account.credentialUri
      : gatewayModel === null
        ? ""
        : gatewayCredentialBindingId(
            gatewayModel,
            gatewayProviderConfiguration?.credentialConfigured === true,
          );
    // Durable reasoning replay (both vendors, same contract): the renderer is
    // rebuilt on every resume while the tool calls it must lead survive in
    // `episodes` and get rendered again. Seed the ledger from the attempts
    // this thread has already settled so a replayed call still carries the
    // reasoning that produced it — the alternative is an ordering/signature
    // 400 on Anthropic and a silently re-derived chain on OpenAI.
    const reasoningReplay = new ReasoningReplayLedger();
    reasoningReplay.seed(await loadThreadReasoningReplay(turn.threadId));
    const selectedRenderer = accountRouting !== null
      ? providerAccountRenderer(accountRouting, turnReasoningEffort, turn.threadId, reasoningReplay)
      : directConfiguration !== null
      ? createDirectRenderer(directConfiguration, { reasoningEffort: turnReasoningEffort, reasoningReplay })
      : gatewayModel === null
        ? new LocalRenderer()
        : new GatewayRenderer([gatewayModel], { reasoningEffort: turnReasoningEffort, reasoningReplay });
    const toolsEnabled = accountRouting !== null
      ? accountRouting.model.toolCalling
      : directConfiguration !== null
      ? selectedProvider.context.toolCalling
      : gatewayModel === null
        ? (localProviderCommand?.toolsEnabled ?? false)
        : gatewayModel.toolCalling;
    const toolsEnabledForTurn = toolsEnabled;
    // One per Terminus turn: provider continuity must not leak into the next.
    const codexTurnState = new CodexTurnState();
    // The dispatch target for this turn. An account carries its own connector
    // and its non-credential headers.
    const providerGatewayConfig: ProviderGatewayConfig | null = gatewayModel === null
      ? null
      : {
          model: gatewayModel,
          secretUri: gatewayBindingId,
          ...(accountRouting === null
            ? {}
            : {
                endpoint: accountRouting.endpoint,
                extraHeaders: accountRouting.extraHeaders,
                codexTurnState,
                accountId: accountRouting.account.id,
              }),
        };
    const requestedToolCapabilities = [...new Set(
      (process.env.TERMINUS_ACTIVE_TOOL_CAPABILITIES ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    )];
    const harnessProfileMode = resolveTerminusProfileMode(process.env.TERMINUS_HARNESS_PROFILE);
    const requestedCompactionMode = resolveAdaptiveCompactionMode(
      process.env.TERMINUS_EXPERIMENTAL_ADAPTIVE_COMPACTION,
    );
    const activationMode = workspaceActivationMode(harnessProfileMode);
    const committedActivationEvents = toolsEnabledForTurn
      ? await db.semanticEvent.findMany({
          where: {
            eventType: { in: ["capability.activated", "capability.deactivated"] },
            aggregateType: "turn",
            aggregateId: turnId,
          },
          orderBy: [
            { aggregateSequence: "asc" },
            { eventId: "asc" },
          ],
          select: { payloadJson: true },
        })
      : [];
    const committedActivationPayloads = committedActivationEvents.map((event) => event.payloadJson);
    const recoveredToolCapabilities = recoverCommittedActiveCapabilityIds(
      requestedToolCapabilities,
      committedActivationPayloads,
      STANDALONE_TOOL_CAPABILITY_CARDS.map((card) => card.id),
    );
    const capabilitySession = new CapabilityDiscoverySession(
      STANDALONE_TOOL_CAPABILITY_CARDS,
      recoveredToolCapabilities,
    );
    let workspaceActivated = toolsEnabledForTurn && (
      activationMode === "eager"
      || hasCommittedWorkspaceActivation(committedActivationPayloads)
    );
    const selectWorkspaceToolSchemas = () => selectStandaloneToolSchemas({
      toolsEnabled: toolsEnabledForTurn,
      activatedCapabilities: capabilitySession.activeCapabilityIds(),
      adaptiveToolsEnabled: harnessProfileMode === "adaptive",
    });
    const selectActiveToolSchemas = () => workspaceActivated
      ? selectWorkspaceToolSchemas()
      : selectInitialStandaloneToolSchemas(toolsEnabledForTurn);
    const profileToolSchemas = selectStandaloneToolSchemas({
      toolsEnabled: toolsEnabledForTurn,
      activatedCapabilities: STANDALONE_TOOL_CAPABILITY_CARDS.map((card) => card.id),
      adaptiveToolsEnabled: harnessProfileMode === "adaptive",
    });
    const workspaceToolSchemas = selectWorkspaceToolSchemas();
    const initialToolSchemas = workspaceActivated
      ? workspaceToolSchemas
      : selectInitialStandaloneToolSchemas(toolsEnabledForTurn);
    let activeToolSchemas = initialToolSchemas;
    const activatedToolCapabilities = capabilitySession.activeCapabilityIds();
    const selectedProfile = createTerminusExecutionProfile({
      mode: harnessProfileMode,
      providerId: selectedProvider.providerId,
      modelKey: String(selectedModel.modelKey),
      // The profile records the bounded union; each provider attempt records
      // the exact schema hash. Minimal starts with capability and expands on
      // the next attempt. Adaptive starts with the workspace set.
      toolIds: profileToolSchemas.map((schema) => schema.id),
      configuration: {
        transport: accountRouting !== null
          ? "provider_account"
          : directConfiguration !== null ? "direct" : gatewayModel === null ? "local" : "gateway",
        provider_revision: accountRouting?.account.revision
          ?? gatewayProviderConfiguration?.revision
          ?? providerConfiguration?.revision
          ?? 0,
        tools_enabled: toolsEnabledForTurn,
        workspace_activation: activationMode,
        tool_schema_hash: computeContentHash(canonicalJson(profileToolSchemas)),
        context_compatibility_key: selectedProvider.continuation.compatibilityKey,
        tested_safe_tokens: selectedProvider.context.testedSafeTokens,
        compaction_requested_assignment: requestedCompactionMode,
      },
    });
    turnProfile = selectedProfile;
    let contextBudgetSelection = makeContextBudget(
      selectedProvider,
      selectedModel,
      taskSnapshot.contract.budget,
      activeToolSchemas,
      // The depth the user chose sizes the reasoning reserve; it is the same
      // value the renderer puts on the wire.
      turnReasoningEffort,
    );
    let contextBudget = contextBudgetSelection.budget;
    turnContextBudgetJson = canonicalJson(jsonSafe(contextBudgetSelection.breakdown));
    await mutateAgentState(() => emit({
      eventType: "turn.profile_selected",
      aggregateType: "turn",
      aggregateId: turnId,
      correlationId: task.id,
      payload: {
        profile_id: selectedProfile.profileId,
        profile_version: selectedProfile.version,
        profile_hash: selectedProfile.profileHash,
        configuration_hash: selectedProfile.configurationHash,
        provider_id: selectedProfile.providerId,
        model_key: selectedProfile.modelKey,
        tool_ids: selectedProfile.toolIds,
        disabled: {
          router: !selectedProfile.routerEnabled,
          memory: !selectedProfile.memoryEnabled,
          workflow: !selectedProfile.workflowEnabled,
          subagents: !selectedProfile.subagentsEnabled,
        },
        context_budget_policy: contextBudgetSelection.breakdown.policyVersion,
        active_tool_capabilities: activatedToolCapabilities,
        discoverable_tool_cards: STANDALONE_TOOL_CAPABILITY_CARDS,
      },
    }));
    const threadSnapshot: ThreadSnapshot = {
      threadId: turn.threadId as ThreadSnapshot["threadId"],
      sessionId: turn.thread.sessionId as ThreadSnapshot["sessionId"],
      activeContextEpochId: turn.thread.activeContextEpochId as ThreadSnapshot["activeContextEpochId"],
    };
    const contextStore = new PrismaContextStore(
      db,
      artifactClient,
      { sessionId: task.sessionId, taskId: task.id, turnId, workspaceId: workspace.id },
      mutateAgentState,
      assertControlWriterLease,
    );
    const toolEpisodeService = new ToolEpisodeService({
      store: {
        // R4/Cubic: page newest-first so the byte-budgeted walk always sees
        // the LATEST rows regardless of turn length.
        listModelVisibleEpisodes: async (episodeTurnId) => {
          const pageSize = 200;
          const pages: { id: string; turnId: string; sequence: number; kind: string; contentArtifact: string | null; toolCallId: string | null; createdAt: Date }[] = [];
          for (;;) {
            const rows = await db.episode.findMany({
              where: { turnId: episodeTurnId, modelVisible: true },
              orderBy: [{ sequence: "desc" }],
              take: pageSize,
              ...(pages.length > 0
                ? { skip: 1, cursor: { id: pages[pages.length - 1]!.id } }
                : {}),
            });
            pages.push(...rows);
            if (rows.length < pageSize) break;
          }
          return pages.reverse();
        },
        readArtifact: (hash) => artifactClient.get(hash as ContentHash),
      },
      settleCall: async (toolInput) => settleStandaloneProviderTool({
        callChunk: toolInput.call,
        providerAttemptId: toolInput.providerAttemptId,
        turnId: toolInput.turnId,
        threadId: turn.threadId,
        turnSequence: turn.sequence,
        taskId: toolInput.taskId,
        sessionId: toolInput.sessionId,
        workspaceId: toolInput.workspaceId,
        contractVersion: toolInput.contractVersion,
        contractHash: toolInput.contractHash,
        artifactClient: toolInput.artifactClient,
        capabilitySession,
        nextWorkspaceToolIds: () => selectWorkspaceToolSchemas().map((schema) => schema.id),
        rejection: toolInput.rejection,
        observedSources,
        workspaceRevision: operationWorkspaceRevision,
        operationContext: () => ({
          verificationDelta: latestFailureSelectors.length === 0 && latestDiagnostics.length === 0
            ? null
            : computeContentHash(canonicalJson({
                failure_selectors: [...latestFailureSelectors].sort(),
                diagnostics: [...latestDiagnostics].sort(),
              })),
          hypothesisId: latestHypothesisId,
          criterionIds: criteriaRows.map((criterion) => criterion.criterionId),
          objectiveStep: turn.state === "REPAIRING" ? "verification_repair" : task.phase,
        }),
        signal: abortController.signal,
      }).then((settlement) => {
        settlementByProviderCallId.set(toolInput.call.toolCallId, settlement);
      }),
    });
    const toolEpisodeSession = toolEpisodeService.startTurn();
    // R1 (harness critical path): per-turn registry of read-observed file
    // hashes so patch can resolve an omitted expected_sha256 while keeping
    // stale-write protection anchored to actually observed source versions.
    const observedSources = new ObservedSourceTracker();
    // …seeded from the durable episode log so the knowledge survives across
    // turns and repair attempts. A file read in turn 1 stays editable in
    // turn 2 without a redundant re-read.
    const seededObservations = await seedObservedSourcesFromEpisodes(
      task.id,
      workspace.id,
      observedSources,
    );
    if (seededObservations > 0) {
      await mutateAgentState(() => emit({
        eventType: "turn.observed_sources_seeded",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: task.id,
        payload: { observations: seededObservations },
      }));
    }
    // Rank 3: bounded verify–repair–admit policy for this completion proposal.
    // Cumulative repair budget: durable count of prior repair schedules for
    // this task seeds the per-turn controller so cross-turn loops stay bounded.
    const priorRepairs = await db.semanticEvent.count({
      where: { eventType: "task.repair_scheduled", aggregateType: "task", aggregateId: task.id },
    });
    const priorRepairEvent = await db.semanticEvent.findFirst({
      where: { eventType: "task.repair_scheduled", aggregateType: "task", aggregateId: task.id },
      orderBy: { eventId: "desc" },
      select: { payloadJson: true },
    });
    const priorRepairPayload = priorRepairEvent === null
      ? null
      : safeParse<Record<string, unknown> | null>(priorRepairEvent.payloadJson, null);
    const taskBudget = safeParse<Record<string, unknown>>(task.budgetJson, {});
    const storedRepairBudget = typeof taskBudget.repair_budget === "object"
      && taskBudget.repair_budget !== null
      && !Array.isArray(taskBudget.repair_budget)
      ? taskBudget.repair_budget as Record<string, unknown>
      : {};
    const eventFailureSignatures = Array.isArray(priorRepairPayload?.failure_signatures)
      ? priorRepairPayload.failure_signatures.filter((value): value is string => typeof value === "string")
      : [];
    const storedFailureSignatures = Array.isArray(storedRepairBudget.failure_signatures)
      ? storedRepairBudget.failure_signatures.filter((value): value is string => typeof value === "string")
      : [];
    const storedMaxRepairs = typeof storedRepairBudget.max_attempts === "number"
      && Number.isInteger(storedRepairBudget.max_attempts)
      && storedRepairBudget.max_attempts >= 0
      ? storedRepairBudget.max_attempts
      : null;
    const storedAttemptsUsed = typeof storedRepairBudget.attempts_used === "number"
      && Number.isInteger(storedRepairBudget.attempts_used)
      && storedRepairBudget.attempts_used >= 0
      ? storedRepairBudget.attempts_used
      : 0;
    const repairAttemptForTurn = turn.state === "REPAIRING"
      ? await db.repairAttempt.findUnique({
          where: { repairTurnId: turnId },
          select: { remainingBudgetJson: true },
        })
      : null;
    const currentRepairBudget = repairAttemptForTurn === null
      ? null
      : safeParse<Record<string, unknown> | null>(repairAttemptForTurn.remainingBudgetJson, null);
    const currentHypothesisId = typeof currentRepairBudget?.hypothesis_id === "string"
      ? currentRepairBudget.hypothesis_id
      : typeof storedRepairBudget.hypothesis_id === "string"
        ? storedRepairBudget.hypothesis_id
        : null;
    latestHypothesisId = currentHypothesisId;
    const configuredRepairRaw = process.env.TERMINUS_MAX_REPAIR_ATTEMPTS?.trim() ?? "";
    const configuredRepairParsed = configuredRepairRaw === "" ? 2 : Number.parseInt(configuredRepairRaw, 10);
    const configuredMaxRepairs = Number.isInteger(configuredRepairParsed) && configuredRepairParsed >= 0
      ? configuredRepairParsed
      : 2;
    const maxRepairAttempts = storedMaxRepairs ?? configuredMaxRepairs;
    const verificationRepairController = new VerificationRepairController({
      // This is the total task allowance, not a fresh quota added to every
      // turn. Historical schedules seed usage below.
      maxRepairAttempts,
      priorAttemptsUsed: Math.max(priorRepairs, storedAttemptsUsed),
      priorFailureSignatures: [...new Set([...storedFailureSignatures, ...eventFailureSignatures])],
    });
    let latestChangedFiles: readonly string[] = [];
    // H3: a turn that only observed the workspace has nothing to verify. Any
    // non-read tool (patch, exec, web_fetch) is treated as a potential change,
    // so verification is skipped only when the turn provably made none.
    let turnMayHaveChangedWorkspace = false;
    // Keep intent separate from observed effects: denied or failed mutation
    // calls still identify a coding turn, but never count as a workspace
    // change for verification or completion.
    let turnAttemptedWorkspaceMutation = false;
    let latestInstructionHashes: readonly string[] = [];
    let latestFailureSelectors: readonly string[] = [];
    let latestDiagnostics: readonly string[] = [];
    const latestRepositorySignals: { value: RepositoryDiscoverySignals | null } = { value: null };
    const contextEpoch = await ensureContextEpoch({
      db,
      threadId: turn.threadId,
      taskId: task.id,
      workspaceId: workspace.id,
      provider: selectedProvider,
      model: selectedModel,
      worldState,
      artifacts: artifactClient,
    });
    // What the compiler predicted this manifest's prompt would cost, filled
    // by `compileProviderContext` and read at settlement so the estimator
    // gets a predicted/observed pair to calibrate from.
    const confidentialityPolicy: ConfidentialityPolicy = {
      allowedProviders: {
        public: [selectedProvider.providerId],
        workspace: selectedProvider.policy.allowedConfidentiality.includes("workspace")
          ? [selectedProvider.providerId]
          : [],
        secret_adjacent: [],
        secret: [],
      },
    };
    // The previous attempt's cache-epoch snapshot, carried across attempts of
    // this turn so `buildCacheEpochDebugData` can explain what invalidated the
    // prefix instead of reporting `no_previous_epoch` forever. Attempt N is a
    // full recompile; without this the cache diagnostics are blind.
    let previousCacheEpoch: CacheEpochDebugSnapshot | null = null;
    const compileProviderContext = async () => {
      activeToolSchemas = selectActiveToolSchemas();
      // Optional schemas consume context only after activation. The profile
      // records the bounded union, while each attempt budgets the exact wire
      // declaration. This is the token-saving point of progressive disclosure.
      contextBudgetSelection = makeContextBudget(
        selectedProvider,
        selectedModel,
        taskSnapshot.contract.budget,
        activeToolSchemas,
        turnReasoningEffort,
      );
      contextBudget = contextBudgetSelection.budget;
      turnContextBudgetJson = canonicalJson(jsonSafe(contextBudgetSelection.breakdown));
      const compactionTaskAnchor: CompactionTaskAnchor = {
        contractVersion: contractRow.version,
        contractHash: contractRow.contentHash,
        objective: taskSnapshot.contract.objective,
        acceptanceCriteria: criteriaRows.map((criterion) => ({
          id: criterion.criterionId,
          statement: criterion.statement,
          required: criterion.required,
          status: checkpointRequirementStatus(criterion.status),
        })),
        nonGoals: taskSnapshot.contract.nonGoals,
        constraints: taskSnapshot.contract.constraints,
        allowedScope: taskSnapshot.contract.allowedScope,
      };
      const compactionTokenizer = resolveTokenizer(selectedProvider.providerId, selectedModel.modelKey);
      const estimateCompactionTokens = (text: string): number =>
        conservativeCompactionTextTokens(compactionTokenizer, text);
      const compactionPolicy = deriveCompactionPolicy(contextBudget, {
        mode: requestedCompactionMode,
        // Reserve selected-model-estimated, task-specific summary input before
        // allocating source text. The fixed margin covers envelope variance.
        summaryReservedInputTokens: estimateCompactionTokens(
          `${SUMMARY_SYSTEM_INSTRUCTIONS}\n${canonicalJson(compactionTaskAnchor)}`,
        ) + 512,
        tokenizerStatus: compactionTokenizer.calibration.status,
      });
      const episodeWindow = compactionPolicy.assignment === "adaptive"
        ? {
            maxTokens: compactionPolicy.compactThresholdTokens,
            estimateTextTokens: estimateCompactionTokens,
            messageEnvelopeTokens: MESSAGE_ENVELOPE_TOKENS,
          }
        : undefined;
      let recent = await toolEpisodeService.loadModelVisibleEpisodes(turnId, episodeWindow);
      // Verification recovery must not make any provider call while it
      // rebuilds the durable response/plan boundary. A compaction summary is
      // optional; retain source episodes when recovery has no provider path.
      const compactionSummarizer = resumeVerificationFromState || !compactionPolicy.compactionEnabled
        ? null
        : buildSummarizer();
      // R4/Cubic round-2: the compaction decision must consider the FULL
      // episode set, not the already window-capped view — otherwise a long
      // turn never crosses the threshold. Byte sizes come from the CAS
      // artifact metadata (no payload reads).
      const fullEpisodeSizes = await db.episode.findMany({
        where: { turnId, modelVisible: true },
        orderBy: { sequence: "asc" },
        select: {
          id: true,
          kind: true,
          sequence: true,
          toolCallId: true,
          contentArtifact: true,
          sourceVersionsJson: true,
        },
      });
      // Artifact sizes are immutable and episodes are append-only per turn,
      // so this per-turn cache makes the compaction preflight O(new episodes)
      // in kernel metadata RPCs instead of O(total episodes) per attempt.
      // A cached 0 is a real "metadata unavailable" result, not a miss. Byte
      // metadata is only a conservative preflight; the selected tokenizer
      // decides after source materialization.
      const sizeByUri = turnArtifactSizeCache;
      for (const row of fullEpisodeSizes) {
        if (row.contentArtifact === null) continue;
        if (sizeByUri.has(row.contentArtifact)) continue;
        const hash = row.contentArtifact.startsWith("artifact://sha256/")
          ? `sha256:${row.contentArtifact.slice("artifact://sha256/".length)}`
          : null;
        if (hash === null) continue;
        try {
          const meta = await requireKernelUds().artifacts.GetMetadata({
            context: {
              ...(await kernelTaskContext({
                sessionId: turn.thread.sessionId,
                taskId: task.id,
                turnId,
                workspaceId: workspace.id,
                operationClasses: [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
              })),
              idempotencyKey: `compaction-meta:${row.id}`,
            } as never,
            sha256: hash,
          });
          sizeByUri.set(row.contentArtifact, Number(meta.artifact?.sizeBytes ?? 0));
        } catch {
          sizeByUri.set(row.contentArtifact, 0);
        }
      }
      const totalBytes = fullEpisodeSizes.reduce(
        (sum, row) => sum + (row.contentArtifact !== null ? sizeByUri.get(row.contentArtifact) ?? 0 : 0),
        0,
      );
      const metadataUpperBoundTokens = compactionPolicy.assignment === "adaptive"
        ? Math.ceil(totalBytes / METADATA_PREFLIGHT_BYTES_PER_TOKEN)
          + fullEpisodeSizes.length * MESSAGE_ENVELOPE_TOKENS
        : totalBytes;
      const hasUnavailableMetadata = fullEpisodeSizes.some(
        (row) => row.contentArtifact !== null
          && (sizeByUri.get(row.contentArtifact) ?? 0) === 0,
      );
      const contentByEpisodeId = new Map<string, string | null>();
      const tokenCountByEpisodeId = new Map<string, number>();
      const compactionFingerprint = computeContentHash(canonicalJson({
        taskAnchor: compactionTaskAnchor,
        policy: compactionPolicy,
        sources: fullEpisodeSizes.map((row) => ({
          id: row.id,
          sequence: row.sequence,
          contentArtifact: row.contentArtifact,
          sourceVersionsJson: row.sourceVersionsJson,
        })),
      }));
      const retrySuppressed = compactionFailureGuard.shouldSuppress(compactionFingerprint);
      const shouldMaterializeAndMeasure = !retrySuppressed
        && compactionSummarizer !== null
        && (hasUnavailableMetadata
          || metadataUpperBoundTokens > compactionPolicy.compactThresholdTokens);
      if (shouldMaterializeAndMeasure) {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (const row of fullEpisodeSizes) {
          if (abortController.signal.aborted) throw new Error("turn aborted during compaction source loading");
          if (row.contentArtifact === null || !row.contentArtifact.startsWith("artifact://sha256/")) {
            contentByEpisodeId.set(row.id, null);
            tokenCountByEpisodeId.set(
              row.id,
              compactionPolicy.assignment === "adaptive" ? MESSAGE_ENVELOPE_TOKENS : 0,
            );
            continue;
          }
          const hash = `sha256:${row.contentArtifact.slice("artifact://sha256/".length)}` as ContentHash;
          const cached = recent.content.get(hash);
          if (cached !== undefined) {
            contentByEpisodeId.set(row.id, cached);
            sizeByUri.set(row.contentArtifact, new TextEncoder().encode(cached).byteLength);
            const tokenCount = compactionPolicy.assignment === "adaptive"
              ? turnArtifactTokenCache.get(row.contentArtifact)
                ?? estimateCompactionTokens(cached) + MESSAGE_ENVELOPE_TOKENS
              : sizeByUri.get(row.contentArtifact) ?? 0;
            if (compactionPolicy.assignment === "adaptive") {
              turnArtifactTokenCache.set(row.contentArtifact, tokenCount);
            }
            tokenCountByEpisodeId.set(row.id, tokenCount);
            continue;
          }
          try {
            const bytes = await artifactClient.get(hash);
            const text = decoder.decode(bytes);
            contentByEpisodeId.set(row.id, text);
            sizeByUri.set(row.contentArtifact, bytes.byteLength);
            const tokenCount = compactionPolicy.assignment === "adaptive"
              ? turnArtifactTokenCache.get(row.contentArtifact)
                ?? estimateCompactionTokens(text) + MESSAGE_ENVELOPE_TOKENS
              : bytes.byteLength;
            if (compactionPolicy.assignment === "adaptive") {
              turnArtifactTokenCache.set(row.contentArtifact, tokenCount);
            }
            tokenCountByEpisodeId.set(row.id, tokenCount);
          } catch {
            // A missing or non-text source is not safe to summarize. The
            // compaction service will retain it and expose the failure code.
            contentByEpisodeId.set(row.id, null);
            tokenCountByEpisodeId.set(
              row.id,
              compactionPolicy.assignment === "adaptive"
                ? (sizeByUri.get(row.contentArtifact) ?? 0) + MESSAGE_ENVELOPE_TOKENS
                : sizeByUri.get(row.contentArtifact) ?? 0,
            );
          }
        }
      }
      const measuredHistoryTokens = shouldMaterializeAndMeasure
        ? fullEpisodeSizes.reduce(
            (sum, row) => sum + (tokenCountByEpisodeId.get(row.id)
              ?? (compactionPolicy.assignment === "adaptive" ? MESSAGE_ENVELOPE_TOKENS : 0)),
            0,
          )
        : metadataUpperBoundTokens;
      const compactionReport: CompactionReport = retrySuppressed
        ? {
            triggered: false,
            prunedCount: 0,
            prunedBytes: 0,
            summaryChars: 0,
            reason: "retry_suppressed",
            failureCode: "retry_suppressed",
          }
        : await runCompaction(buildCompactionStore(), {
          turnId,
          taskAnchor: compactionTaskAnchor,
          enabled: compactionPolicy.compactionEnabled,
          episodes: fullEpisodeSizes.map((row) => ({
            id: row.id,
            kind: row.kind,
            sequence: row.sequence,
            toolCallId: row.toolCallId,
            contentJson: contentByEpisodeId.get(row.id) ?? null,
            contentArtifact: row.contentArtifact,
            byteSize: row.contentArtifact !== null ? sizeByUri.get(row.contentArtifact) ?? 0 : 0,
            tokenCount: tokenCountByEpisodeId.get(row.id)
              ?? (row.contentArtifact === null
                ? (compactionPolicy.assignment === "adaptive" ? MESSAGE_ENVELOPE_TOKENS : 0)
                : compactionPolicy.assignment === "adaptive"
                  ? (sizeByUri.get(row.contentArtifact) ?? 0) + MESSAGE_ENVELOPE_TOKENS
                  : sizeByUri.get(row.contentArtifact) ?? 0),
            compactionSummaryHash: compactionSummaryHash(row.sourceVersionsJson),
          })),
          totalTokens: measuredHistoryTokens,
          compactThresholdTokens: compactionPolicy.compactThresholdTokens,
          keepRecentTokens: compactionPolicy.keepRecentTokens,
          summaryHardInputLimitTokens: compactionPolicy.summaryHardInputLimitTokens,
          maxTranscriptChunkTokens: compactionPolicy.maxTranscriptChunkTokens,
          maxTranscriptChunkChars: compactionPolicy.maxTranscriptChunkChars,
          ...(compactionPolicy.assignment === "adaptive"
            ? {
                estimateTranscriptTokens: (text: string) => estimateCompactionTokens(text) + MESSAGE_ENVELOPE_TOKENS,
                maxSummaryAndTailTokens: compactionPolicy.compactThresholdTokens,
                estimateSummaryTokens: (text: string) => estimateCompactionTokens(text) + MESSAGE_ENVELOPE_TOKENS,
              }
            : {
                maxSummaryAndTailTokens: compactionPolicy.compactThresholdTokens,
                estimateSummaryTokens: (text: string) => new TextEncoder().encode(text).byteLength,
              }),
          summarizer: compactionSummarizer,
          signal: abortController.signal,
          hypothesisId: currentHypothesisId,
        });
      if (
        !compactionReport.triggered
        && compactionReport.reason !== "below_threshold"
        && compactionReport.reason !== "policy_disabled"
        && compactionReport.reason !== "retry_suppressed"
      ) {
        compactionFailureGuard.recordFailure(compactionFingerprint);
      }
      if (compactionReport.triggered) {
        recent = await toolEpisodeService.loadModelVisibleEpisodes(turnId, episodeWindow);
        await mutateAgentState(() => emit({
          eventType: "context.compacted",
          aggregateType: "turn",
          aggregateId: turnId,
          correlationId: task.id,
          payload: {
            pruned_count: compactionReport.prunedCount,
            pruned_bytes: compactionReport.prunedBytes,
            summary_chars: compactionReport.summaryChars,
            mode: compactionReport.reason,
            policy_version: compactionPolicy.policyVersion,
            compaction_assignment: compactionPolicy.assignment,
            requested_compaction_assignment: requestedCompactionMode,
            measurement_unit: compactionPolicy.assignment === "adaptive" ? "tokens" : "bytes",
            policy_source: compactionPolicy.source,
            compact_threshold_tokens: compactionPolicy.compactThresholdTokens,
            keep_recent_tokens: compactionPolicy.keepRecentTokens,
            summary_hard_input_limit_tokens: compactionPolicy.summaryHardInputLimitTokens,
            summary_reserved_input_tokens: compactionPolicy.summaryReservedInputTokens,
            max_transcript_chunk_tokens: compactionPolicy.maxTranscriptChunkTokens,
            max_transcript_chunk_chars: compactionPolicy.maxTranscriptChunkChars,
            measured_history_tokens: measuredHistoryTokens,
          },
        }));
      } else if (compactionReport.reason !== "below_threshold") {
        await mutateAgentState(() => emit({
          eventType: "context.compaction_deferred",
          aggregateType: "turn",
          aggregateId: turnId,
          correlationId: task.id,
          payload: {
            reason: compactionReport.reason,
            failure_code: compactionReport.failureCode ?? null,
            policy_version: compactionPolicy.policyVersion,
            policy_source: compactionPolicy.source,
            compaction_assignment: compactionPolicy.assignment,
            requested_compaction_assignment: requestedCompactionMode,
            measurement_unit: compactionPolicy.assignment === "adaptive" ? "tokens" : "bytes",
            compact_threshold_tokens: compactionPolicy.compactThresholdTokens,
            keep_recent_tokens: compactionPolicy.keepRecentTokens,
            summary_reserved_input_tokens: compactionPolicy.summaryReservedInputTokens,
            max_transcript_chunk_tokens: compactionPolicy.maxTranscriptChunkTokens,
            measured_history_tokens: measuredHistoryTokens,
          },
        }));
      }
      // Prior-turn verification failures become first-class repair inputs.
      const lastFailedPlan = await db.verificationPlan.findFirst({
        where: { taskId: task.id },
        orderBy: { createdAt: "desc" },
        include: { results: { where: { status: { in: ["fail", "error"] } } } },
      });
      const priorVerificationFailures = (lastFailedPlan?.results ?? [])
        .map((result) => `${result.nodeId}: ${result.reason ?? result.status}`);
      // Rank 1 (PR2): derive authoritative working-set state from settled
      // episodes instead of passing empty collections to the compiler.
      const contextState = new ContextStateBuilder().build({
        taskId: task.id as never,
        contractVersion: contractRow.version,
        contractContentHash: contractRow.contentHash as ContentHash,
        phase: task.phase,
        unknowns: safeParse<string[]>(contractRow.unknownsJson, []),
        observedAt: worldState.observedAt,
        workspace: {
          workspaceId: workspace.id,
          rootUri: workspace.rootUri,
          trust: workspace.trust,
        },
        environment: {
          sandboxProfileId: DEV_MODE ? "degraded-local" : "secure-local-default",
          backendId: null,
        },
        episodeObservations: buildEpisodeObservations(recent.episodes, recent.content),
        priorVerificationFailures,
      });
      latestChangedFiles = [...contextState.taskSnapshot.changedFiles];
      latestFailureSelectors = [...contextState.taskSnapshot.failingTests];
      latestDiagnostics = contextState.taskSnapshot.diagnostics.map(
        (diagnostic) => `${diagnostic.path}: ${diagnostic.message}`,
      );
      const workingMemory = !workspaceActivated
        ? null
        : await loadLiveWorkingMemory({
            task,
            contract,
            contractContentHash: contractRow.contentHash,
            criteriaRows,
            observedAt: worldState.observedAt,
            currentChanges: contextState.signals.workspaceChanges,
            failingTests: contextState.taskSnapshot.failingTests,
            diagnostics: contextState.taskSnapshot.diagnostics,
            verificationFailures: priorVerificationFailures,
            worldStateDigest: contextState.worldStateDigest,
          });
      const effectiveTaskSnapshot: TaskSnapshot = {
        ...taskSnapshot,
        contract: !workspaceActivated
          ? {
              ...taskSnapshot.contract,
              objective: "Handle the user's latest request. Activate workspace access only when it is needed.",
              userOutcome: null,
              nonGoals: [],
              acceptanceCriteria: [],
              constraints: [],
              assumptions: [],
              unknowns: [],
            }
          : taskSnapshot.contract,
        changedFiles: contextState.taskSnapshot.changedFiles,
        failingTests: contextState.taskSnapshot.failingTests,
        diagnostics: contextState.taskSnapshot.diagnostics,
      };
      const repositorySignals: RepositoryDiscoverySignals = !workspaceActivated
        ? {
            repositoryMap: null,
            verificationRepositoryMap: undefined,
            nativeTestCommands: [],
            nativeRecipeSources: [],
            nativeRecipeSourceVersions: [],
            observedConfigPaths: [],
            unavailableConfigPaths: [],
            verificationRunners: discoverVerificationRunners([]),
          }
        : await discoverRepositorySignals({
            clients: requireKernelUds(),
            codeIntelContext: await buildArtifactContext(),
            sessionId: turn.thread.sessionId,
            taskId: task.id,
            turnId,
            workspaceId: workspace.id,
            contractHash: contractRow.contentHash,
            readPaths: contract.allowedScope.readPaths,
            signal: abortController.signal,
          });
      latestRepositorySignals.value = repositorySignals;
      const effectiveWorldState: WorldStateSnapshot = !workspaceActivated
        ? {
            observedAt: worldState.observedAt,
            sourceVersions: { [`task://${task.id}`]: contractRow.contentHash },
            sections: {},
          }
        : {
        ...worldState,
        sourceVersions: {
          ...worldState.sourceVersions,
          ...(workingMemory?.sourceVersions ?? {}),
        },
        sections: {
          ...worldState.sections,
          ...contextState.worldStateSections,
          ...(workingMemory === null ? {} : { working_memory: workingMemory.section }),
          // No `tool_capabilities` section: the tool schemas attached to the
          // request are the declaration. Restating them in prose cost ~120
          // tokens a turn and went stale the moment the palette changed.
          repository_signals: {
            repository_map: repositorySignals.repositoryMap === null
              ? { availability: "temporarily_unavailable" }
              : {
                  availability: "available",
                  index_revision: repositorySignals.repositoryMap.indexRevision,
                  entry_count: repositorySignals.repositoryMap.entries.length,
                  total_entry_count: repositorySignals.repositoryMap.totalEntries,
                  truncated: repositorySignals.repositoryMap.truncated,
                  continuation_available: repositorySignals.repositoryMap.continuationToken !== null,
                },
            native_test_commands: repositorySignals.nativeTestCommands,
            native_recipe_sources: repositorySignals.nativeRecipeSources,
            native_recipe_source_versions: repositorySignals.nativeRecipeSourceVersions,
            observed_config_paths: repositorySignals.observedConfigPaths,
            unavailable_config_paths: repositorySignals.unavailableConfigPaths,
          },
        },
      };
      if (workspaceActivated && scoutBriefSection !== null) {
        (effectiveWorldState.sections as Record<string, unknown>).scout_brief = scoutBriefSection;
      }
      const projectInstructionFragments = !workspaceActivated
        ? []
        : await loadRepositoryInstructionFragments({
            clients: requireKernelUds(),
            taskId: task.id,
            turnId,
            contractHash: contractRow.contentHash,
            sessionId: turn.thread.sessionId,
            workspaceId: workspace.id,
            workspaceRootUri: workspace.rootUri,
            contract,
            changedFiles: contextState.taskSnapshot.changedFiles,
            modelKey: selectedModel.modelKey,
            observedAt: worldState.observedAt,
            signal: abortController.signal,
          });
      latestInstructionHashes = projectInstructionFragments.map((fragment) => fragment.contentRef.hash);
      // R5: cross-turn continuity — when this turn has no episodes yet,
      // inject a bounded excerpt of the previous completed turn so the model
      // does not restart from amnesia. Deterministic; no extra LLM call.
      if (workspaceActivated && shouldInjectRecentHistory(recent.episodes)) {
        // Proportional to the real window, not a fixed 6,000 characters.
        const priorSection = await loadPriorTurnHistory(
          turn.threadId,
          turn.sequence,
          artifactClient,
          recentHistoryExcerptLimits(Number(contextBudget.optionalContextTarget)),
        );
        if (priorSection !== null) {
          (effectiveWorldState.sections as Record<string, unknown>).recent_history = priorSection.previous_turn;
        }
      }
      const compiled = await compileContext({
        task: effectiveTaskSnapshot,
        thread: threadSnapshot,
        provider: selectedProvider,
        model: selectedModel,
        epoch: contextEpoch,
        worldState: effectiveWorldState,
        recentEpisodes: recent.episodes,
        episodeContent: recent.content,
        checkpoint,
        userDirectives: [] as readonly ContextDirective[],
        projectInstructionFragments,
        // Prompt v1: shared authority + safety + working agreement, then the
        // per-family instruction layer selected from the model id.
        authorityDocuments: !workspaceActivated
          ? initialResponseAuthorityDocuments()
          : standaloneAuthorityDocuments(selectedModel.modelKey),
        previousCacheEpoch,
        activeCapabilities: toolsEnabled
          ? activeToolSchemas.map((tool) => ({ id: tool.id, version: tool.version }))
          : [],
        budget: contextBudget,
        experimentAssignments: [{
          experimentId: `terminus.compaction.assignment.v1.${compactionPolicy.assignment}`,
          variant: compactionPolicy.assignment,
        }],
        renderer: selectedRenderer,
        confidentialityPolicy,
        toolSchemas: activeToolSchemas,
        compactionPolicy: { enabled: false, targetTokens: Number(contextBudget.optionalContextTarget) },
        store: contextStore,
        retrievalPipeline: !workspaceActivated
          ? {
              retrieve: async () => [],
              expandForGaps: async () => [],
            }
          : kernelRetrievalPipeline(
              requireKernelUds(),
              buildArtifactContext,
              worldState.observedAt,
              selectedModel.modelKey,
              task.sessionId,
              task.id,
              workspace.id,
              repositorySignals.repositoryMap,
              contract.allowedScope,
            ),
        signal: abortController.signal,
      });
      previousCacheEpoch = readCacheEpochSnapshot(compiled.manifest.decisionRecord)
        ?? previousCacheEpoch;
      const requestArtifact = compiled.renderedRequestArtifact;
      if (requestArtifact === null) throw new Error("context store did not persist rendered provider request");
      const baselineArtifact = await ingestJsonArtifact(
        artifactClient,
        {
          epochId: contextEpoch.epochId,
          stablePrefixHash: compiled.manifest.cachePlan.stablePrefixHash,
          fragments: compiled.manifest.fragments.map((fragment) => ({
            id: fragment.fragmentId,
            hash: fragment.artifactHash,
          })),
        },
        "context-epoch-baseline",
        { taskId: task.id, turnId, workspaceId: workspace.id },
      );
      await mutateAgentState(() => emit({
        eventType: "context.manifest_persisted",
        aggregateType: "context_manifest",
        aggregateId: compiled.manifest.id,
        correlationId: turn.taskId ?? undefined,
        payload: {
          turn_id: turnId,
          fragment_count: compiled.manifest.fragments.length,
          provider: selectedProvider.providerId,
          model: selectedModel.modelKey,
          total_estimated_tokens: compiled.totalEstimatedTokens,
          omitted_count: compiled.omitted.length,
        },
        artifactRefs: [requestArtifact.uri],
      }, async (tx) => {
        await tx.contextEpoch.update({
          where: { id: contextEpoch.epochId },
          data: {
            baselineHash: compiled.manifest.cachePlan.stablePrefixHash,
            baselineArtifact: baselineArtifact.uri,
          },
        });
      }));
      // `totalEstimatedTokens` counts the selected fragments only; the tool
      // schemas are rendered into the same prompt and the provider bills for
      // them, so the comparison the estimator learns from has to include them.
      predictedPromptByManifest.set(
        compiled.manifest.id,
        compiled.totalEstimatedTokens
          + resolveTokenizer(selectedProvider.providerId, selectedModel.modelKey)
            .estimateToolSchemaTokens(compiled.rendered.request.toolSchemas),
      );
      return { compiled, requestArtifact };
    };

    let finalText: string | null = null;
    let finalResponseArtifactUri: string | null = null;
    let completionClaims: readonly CompletionClaim[] = [];
    // Rank 1/Rank 2: run the bounded coding loop through the extracted
    // engine — adaptive budgets replace the fixed four-cycle ceiling, and
    // multi-call responses are batched (reads parallel-safe, writes ordered).
    const sideEffectClassOf = (toolName: string): string =>
      STANDALONE_TOOL_SCHEMAS.find((tool) => tool.id === toolName)?.sideEffectClass ?? "external";
    // Shared kernel task context for every provider-plane call (main loop,
    // R4 summary turns). Network/secret scopes follow the selected transport.
    const buildProviderTaskContext = async (): Promise<RequestContext> => kernelTaskContext({
      sessionId: turn.thread.sessionId,
      taskId: task.id,
      turnId,
      workspaceId: workspace.id,
      operationClasses: directConfiguration !== null || gatewayModel !== null
        ? [
            ...(directConfiguration !== null || gatewayBindingId !== ""
              ? [CapabilityOperationProto.CAPABILITY_OPERATION_SECRET]
              : []),
            CapabilityOperationProto.CAPABILITY_OPERATION_NETWORK,
            CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST,
          ]
        : [
            CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
            CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
            CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST,
          ],
      workspacePaths: directConfiguration === null && gatewayModel === null
        ? leastWorkspaceScope([
            ...contract.allowedScope.readPaths,
            ...contract.allowedScope.writePaths,
          ])
        : [],
      // One host and at most one secret: an account can reach only the
      // destination it was discovered with.
      networkDestinations: accountRouting !== null
        ? [...accountRouting.scope.networkDestinations]
        : directConfiguration !== null
        ? [...directNetworkDestinations()]
        : gatewayModel === null
          ? []
          : ["opencode.ai:443"],
      secretCapabilities: accountRouting !== null
        ? [...accountRouting.scope.secretCapabilities]
        : directConfiguration !== null
        ? [directConfiguration.secretUri]
        : gatewayModel === null
          ? []
          : gatewayBindingId === "" ? [] : [gatewayBindingId],
    });
    const buildDirectExecutor = (): ProviderExecutionInput["executeDirectRequest"] => {
      if (directConfiguration === null) return undefined;
      // R6/Cubic: route through the vendor-native runtimes so live turns get
      // cache reconciliation + budget preflight + partial settlement.
      let budgetMicros = 5_000_000n;
      try {
        const parsedBudget = JSON.parse(task.budgetJson) as { model_micros?: number };
        if (typeof parsedBudget.model_micros === "number" && parsedBudget.model_micros > 0) {
          budgetMicros = BigInt(Math.min(parsedBudget.model_micros, Number.MAX_SAFE_INTEGER));
        }
      } catch {
        // Default budget stands when the stored task budget is unreadable.
      }
      return async (execInput) => {
        // H9: time-to-first-token is measured per dispatch, so the observer
        // and the executor are built here rather than once per turn.
        const dispatchedAt = Date.now();
        const telemetry = createStreamTelemetry();
        let firstChunkAt: number | null = null;
        const nativeExecutor = createNativeDirectExecutor({
          configuration: directConfiguration,
          connectors: requireKernelUds().connectors,
          requestBudgetMicros: budgetMicros,
          economics: selectedProvider.economics,
          promptCacheKey: contextEpoch.epochId,
          telemetry,
          onChunk: async (chunk) => {
            if (firstChunkAt === null && (chunk.kind === "text" || chunk.kind === "tool_call")) {
              firstChunkAt = Date.now();
            }
            await providerTextDeltas.onChunk(chunk);
          },
        });
        // Adapt the native stream result back into the transport-level
        // ProviderResponse the engine settles. `nativeResult.usage` carries
        // the runtime's measured wall latency; the engine reads usage off the
        // chunks, so it is written back onto the terminal `done` chunk
        // instead of being discarded (H9).
        const nativeResult = await nativeExecutor(execInput as Parameters<typeof nativeExecutor>[0]);
        return {
          providerId: execInput.rendered.providerId,
          model: execInput.rendered.model,
          chunks: withMeasuredUsage(
            nativeResult.chunks,
            {
              wallMs: Date.now() - dispatchedAt,
              // The first body frame, when the transport saw one. The first
              // decoded chunk is the fallback: it is later by however long
              // the provider spent on token-free leading SSE events.
              timeToFirstTokenMs: timeToFirstBodyMs(telemetry)
                ?? (firstChunkAt === null ? null : firstChunkAt - dispatchedAt),
            },
            nativeResult.usage,
          ),
          observedAt: new Date().toISOString() as never,
        };
      };
    };
    // R4: durable effects for compaction — hide pruned rows and append one
    // model-visible summary episode backed by a CAS artifact.
    const buildCompactionStore = (): CompactionStore => ({
      hideEpisodes: async (ids) => {
        if (ids.length === 0) return;
        await db.episode.updateMany({
          where: { id: { in: [...ids] }, turnId },
          data: { modelVisible: false },
        });
      },
      latestSequence: async (episodeTurnId) => {
        const row = await db.episode.findFirst({
          where: { turnId: episodeTurnId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        return row?.sequence ?? null;
      },
      appendSummaryEpisode: async ({ turnId: summaryTurnId, sequence, summaryText }) => {
        const summaryId = uuid();
        const artifact = await artifactClient.ingest(
          new TextEncoder().encode(summaryText),
          { mediaType: "text/markdown", custom: { purpose: "compaction-summary", turnId: summaryTurnId } },
        );
        await artifactClient.link(artifact.hash, "episode", summaryId, "content");
        await db.episode.create({
          data: {
            id: summaryId,
            turnId: summaryTurnId,
            sequence,
            kind: "summary",
            modelVisible: true,
            contentArtifact: artifact.uri,
            toolCallId: null,
          },
        });
      },
      commitCompaction: async ({ turnId: summaryTurnId, summaryText, summary, summaryHash, prunedEpisodeIds }) => {
        const summaryId = uuid();
        const artifact = await artifactClient.ingest(
          new TextEncoder().encode(summaryText),
          { mediaType: "text/markdown", custom: { purpose: "compaction-summary", turnId: summaryTurnId } },
        );
        // The immutable artifact is retained before the fenced DB transaction;
        // if the transaction loses the writer lease, no source row is hidden.
        await artifactClient.link(artifact.hash, "episode", summaryId, "content");
        await writerTransaction(async (tx) => {
          const latest = await tx.episode.findFirst({
            where: { turnId: summaryTurnId },
            orderBy: { sequence: "desc" },
            select: { sequence: true },
          });
          const hidden = await tx.episode.updateMany({
            where: {
              id: { in: [...prunedEpisodeIds] },
              turnId: summaryTurnId,
              modelVisible: true,
            },
            data: { modelVisible: false },
          });
          if (hidden.count !== prunedEpisodeIds.length) {
            throw new Error(`compaction source set changed for turn ${summaryTurnId}`);
          }
          await tx.episode.create({
            data: {
              id: summaryId,
              turnId: summaryTurnId,
              sequence: (latest?.sequence ?? 0) + 1,
              kind: "summary",
              modelVisible: true,
              contentArtifact: artifact.uri,
              toolCallId: null,
              sourceVersionsJson: JSON.stringify({
                summaryHash,
                sourceEpisodeIds: prunedEpisodeIds,
                sourceArtifacts: Object.fromEntries(
                  summary.sourceEpisodes.map((source) => [source.episodeId, source.artifactRef]),
                ),
                parentSummaryHashes: summary.parentSummaries.map((parent) => parent.summaryHash),
              }),
            },
          });
        });
      },
      recallCompaction: createCurrentTurnCompactionRecallStore(turnId, artifactClient).recallCompaction,
    });
    // R4: one dedicated provider turn producing the structured handoff
    // summary. Rendered WITHOUT cache breakpoints (one-off call) and with a
    // synthetic manifest id scoped to this turn.
    let summarizerMemo: Summarizer | null | undefined;
    const buildSummarizer = (): Summarizer | null => {
      if (summarizerMemo !== undefined) return summarizerMemo;
      if (!toolsEnabled && directConfiguration === null && gatewayModel === null && localProviderCommand === null) {
        summarizerMemo = null;
        return summarizerMemo;
      }
      const summaryTokenizer = resolveTokenizer(selectedProvider.providerId, selectedModel.modelKey);
      summarizerMemo = async ({ transcript, taskAnchor, hardInputLimitTokens }) => {
        const instructionsHash = computeContentHash(SUMMARY_SYSTEM_INSTRUCTIONS);
        const taskAnchorText = canonicalJson(taskAnchor);
        const taskAnchorHash = computeContentHash(taskAnchorText);
        const transcriptHash = computeContentHash(transcript);
        const scope = {
          workspaceId: workspace.id as never,
          sessionId: turn.thread.sessionId as never,
          taskId: task.id as never,
          pathPatterns: [],
        };
        const now = new Date().toISOString() as never;
        const makeFragment = (
          fragmentId: string,
          kind: "authority" | "task_contract" | "recent_episode",
          text: string,
          hash: string,
        ): ContextFragment => ({
          id: fragmentId,
          kind,
          contentRef: {
            hash: hash as never,
            uri: `artifact://sha256/${hash.slice("sha256:".length)}` as never,
            mediaType: "text/plain",
            bytes: BigInt(new TextEncoder().encode(text).byteLength) as never,
          },
          textContent: text,
          source: { uri: `turn://${turnId}/compaction`, producer: "terminus-control", producerVersion: "v1", observedAt: now, observedBy: "control", evidenceRefs: [] },
          sourceVersion: null,
          authority: kind === "recent_episode" ? 45 : 90,
          priority: kind === "recent_episode" ? 45 : 90,
          trust: kind === "recent_episode" ? "untrusted" : "trusted",
          confidentiality: "workspace",
          injectionRisk: kind === "recent_episode" ? "high" : "low",
          exactness: "exact",
          scope,
          freshness: { observedAt: now, sourceVersion: null, stale: false, staleReason: null },
          dependencies: [],
          invalidation: [],
          estimatedTokens: {
            [selectedModel.modelKey]: conservativeCompactionTextTokens(summaryTokenizer, text),
          },
          selectionFeatures: { relevance: 1, novelty: 0, coverage: 1, uncertaintyReduction: 1, riskReduction: 1, modelCompatibility: 1, redundancyPenalty: 0, injectionPenalty: 0 },
        });
        const canonicalRenderInput = {
          provider: selectedProvider,
          model: selectedModel,
          manifestId: `summary:${turnId}:${taskAnchorHash}`,
          fragments: [
            makeFragment(`compaction:instructions:${turnId}`, "authority", SUMMARY_SYSTEM_INSTRUCTIONS, instructionsHash),
            makeFragment(`compaction:task-anchor:${turnId}`, "task_contract", taskAnchorText, taskAnchorHash),
            makeFragment(`compaction:transcript:${turnId}`, "recent_episode", transcript, transcriptHash),
          ],
          toolSchemas: [],
          // No cache-control writes: summaries are one-off and must not
          // pollute the stable prefix.
          cachePlan: { stablePrefixHash: instructionsHash, breakpoints: [] },
          continuationId: null,
          outputProfile: "terse",
          reasoningReserveTokens: 4_096n as never,
          outputReserveTokens: 2_048n as never,
          hardInputLimit: BigInt(hardInputLimitTokens) as never,
          signal: abortController.signal,
        } as Parameters<typeof selectedRenderer.render>[0];
        const rendered = await selectedRenderer.render(canonicalRenderInput);
        const directExecutor = buildDirectExecutor();
        const response = await providerSessionService.execute({
          rendered,
          command: localProviderCommand,
          gateway: providerGatewayConfig,
          direct: directConfiguration === null
            ? null
            : { vendor: directConfiguration.vendor },
          ...(directExecutor === undefined ? {} : { executeDirectRequest: directExecutor }),
          context: {
            ...await buildProviderTaskContext(),
            idempotencyKey: `compaction:${turnId}:${taskAnchorHash}:${transcriptHash}`,
          },
          workspaceId: workspace.id,
          signal: abortController.signal,
        });
        const projectedSummary = await selectedRenderer.projectResponse(response);
        return projectedSummary.text;
      };
      return summarizerMemo;
    };
    let lastResponseArtifactUri: string | null = null;
    let currentProjected: ProjectedResponse | null = null;
    // Per-attempt bookkeeping the executor owns; the loop reads it through
    // the executor so the maps are injectable and independently instantiable.
    const turnCommandExecutor = new TurnCommandExecutor({
      mutate: mutateAgentState,
      emit: async (input) => emit(input as EmitInput),
      // prepareTurnForProviderContinuation throws the original CAS-failure
      // error on any miss; the 1 reports the guarded row it updated.
      rearmProviderContinuation: async (rearmTurnId, tx) => {
        await prepareTurnForProviderContinuation(
          tx as Parameters<typeof prepareTurnForProviderContinuation>[0],
          rearmTurnId,
        );
        return 1;
      },
    });
    const {
      declaredToolSchemasByAttempt,
      manifestIdByAttempt,
      predictedCacheByAttempt,
      predictedPromptByManifest,
      settlementByProviderCallId,
      toolSettlementEnteredFor,
    } = turnCommandExecutor.ledger;
    // R7 (harness critical path): reconcile predicted vs actual prompt-cache
    // reads per attempt; a systematic gap means the cache-stable prefix was
    // mutated, which silently multiplies cost.
    const cacheMonitor = new CacheRatioMonitor();
    // Merged knob precedence: an explicit TERMINUS_TURN_MAX_STEPS wins;
    // otherwise TERMINUS_MAX_TOOL_CYCLES (validated, fail-closed, default 64)
    // sizes the soft budget. A per-turn budget from `POST /v1/turns` tightens
    // all three limits and can never loosen them — `mergeTurnBudget` takes the
    // lower value. The clamp is `HARD_MAX_STEPS` rather than the 256 that used
    // to sit here: `TurnBudget` already clamps to its own hard ceiling, so the
    // larger number never had any effect and only read as if it did.
    const turnRequestBudget = parsePersistedTurnBudget(turn.requestedBudgetJson);
    const configuredMaxSteps = Math.min(
      mergeTurnBudget(
        Number.parseInt(process.env.TERMINUS_TURN_MAX_STEPS ?? "", 10) ||
          resolveMaxToolCycles(process.env.TERMINUS_MAX_TOOL_CYCLES),
        turnRequestBudget?.maxSteps ?? null,
      ) ?? HARD_MAX_STEPS,
      HARD_MAX_STEPS,
    );
    type ScoutBriefSection = {
      claims: readonly string[];
      files: readonly { path: string; role: string }[];
      open_questions: readonly string[];
    };
    let scoutBriefSection: ScoutBriefSection | null = null;
    // R10: conditional read-only scout — fresh context, read/grep/glob only,
    // bounded steps. Default OFF; TERMINUS_ENABLE_SCOUT=1 is an explicit
    // opt-in, and a utility ledger disables the scout after repeated
    // zero-yield runs. Result becomes a bounded scout_brief world-state
    // section.
    // Intentionally disabled until the child tool path is wired through the
    // normal durable tool-settlement boundary. The previous opt-in path called
    // process.Start for grep/glob, inherited workspace-influenced PATH, and
    // wrote no tool-call/result evidence. Adaptive delegation remains a typed
    // runner, but no paid live child can execute an unsafe or unaudited path.
    const scoutEnabledForTurn = false;
    let scoutFiles: readonly { path: string; role: string }[] = [];
    let scoutUsage: DelegationUsage = ZERO_DELEGATION_USAGE;
    let scoutProviderStepCount = 0;
    if (scoutEnabledForTurn) {
      try {
        const scoutResult = await (async (): Promise<ScoutParsedResult | { status: "skipped" }> => {
          if (selectedProvider.context.toolCalling === false) return { status: "skipped" };
          const instructionsHash = computeContentHash("terminus-scout-authority-v1");
          const scoutReasoningReplay = new ReasoningReplayLedger();
          const scoutRenderer = accountRouting !== null
            ? providerAccountRenderer(
                accountRouting,
                turnReasoningEffort,
                `scout:${turnId}`,
                scoutReasoningReplay,
              )
            : directConfiguration !== null
              ? createDirectRenderer(directConfiguration, {
                  reasoningEffort: turnReasoningEffort,
                  reasoningReplay: scoutReasoningReplay,
                })
              : gatewayModel === null
                ? new LocalRenderer()
                : new GatewayRenderer([gatewayModel], {
                    reasoningEffort: turnReasoningEffort,
                    reasoningReplay: scoutReasoningReplay,
                  });
          const scoutGatewayConfig = providerGatewayConfig === null
            ? null
            : {
                ...providerGatewayConfig,
                ...(accountRouting === null ? {} : { codexTurnState: new CodexTurnState() }),
              };
          const scoutAgentId = `scout-agent:${turnId}`;
          const scoutDelegationId = `scout-delegation:${turnId}`;
          const scoutObjective = `Objective: ${contract.objective}\nRead paths in scope: ${contract.allowedScope.readPaths.slice(0, 64).join(", ") || "(entire workspace)"}`;
          const scoutAuthority = {
            allowedTools: ["read"],
            allowedReadPaths: leastWorkspaceScope(contract.allowedScope.readPaths),
            allowedWritePaths: [],
            deniedEffects: ["write", "external_network", "secret_access", "scope_expansion"],
          } satisfies DelegationAuthority;
          const totalTokenLimit = mergeTurnBudget(
            nonNegativeBigInt(taskBudget.max_tokens),
            turnRequestBudget?.maxTokens ?? null,
          );
          const totalCostLimit = mergeTurnBudget(
            nonNegativeBigInt(taskBudget.model_micros) ?? taskSnapshot.contract.budget.modelMicros,
            turnRequestBudget?.maxCostMicros ?? null,
          ) ?? taskSnapshot.contract.budget.modelMicros;
          const scoutBudget = {
            maxSteps: Math.min(10, Math.max(1, Math.floor(configuredMaxSteps / 4))),
            maxTokens: totalTokenLimit === null ? 32_768n : totalTokenLimit / 5n,
            maxCostMicros: totalCostLimit / 5n,
          };
          const scoutContract = {
            schema: "terminus.scout-delegation.v1",
            parent_task_id: task.id,
            parent_turn_id: turnId,
            delegation_id: scoutDelegationId,
            objective: scoutObjective,
            authority: scoutAuthority,
            budget: {
              max_steps: scoutBudget.maxSteps,
              max_tokens: scoutBudget.maxTokens.toString(),
              max_cost_micros: scoutBudget.maxCostMicros.toString(),
            },
            provider_id: selectedProvider.providerId,
            model_key: selectedModel.modelKey,
            profile_hash: selectedProfile.profileHash,
          };
          const scoutContractBytes = new TextEncoder().encode(canonicalJson(scoutContract));
          const scoutContractArtifact = await artifactClient.ingest(scoutContractBytes, {
            mediaType: "application/json",
            custom: { purpose: "scout-delegation-contract", delegationId: scoutDelegationId },
          });
          await emit({
            eventType: "agent.spawned",
            aggregateType: "agent",
            aggregateId: scoutAgentId,
            correlationId: task.id,
            idempotencyKey: `scout:${turnId}:admitted`,
            payload: {
              agent_id: scoutAgentId,
              delegation_id: scoutDelegationId,
              task_id: task.id,
              parent_turn_id: turnId,
              role: "scout",
              authority: scoutAuthority,
              budget: scoutContract.budget,
            },
            artifactRefs: [scoutContractArtifact.uri],
          }, async (tx) => {
            await tx.agent.upsert({
              where: { id: scoutAgentId },
              create: {
                id: scoutAgentId,
                taskId: task.id,
                parentAgentId: null,
                role: "scout",
                adapterId: selectedProvider.providerId,
                modelProfile: String(selectedModel.modelKey),
                worktreeUri: null,
                state: "RUNNING",
              },
              update: {
                adapterId: selectedProvider.providerId,
                modelProfile: String(selectedModel.modelKey),
                state: "RUNNING",
                completedAt: null,
              },
            });
            await tx.delegation.upsert({
              where: { id: scoutDelegationId },
              create: {
                id: scoutDelegationId,
                taskId: task.id,
                agentId: scoutAgentId,
                contractArtifact: scoutContractArtifact.uri,
                contractHash: scoutContractArtifact.hash,
                resultArtifact: null,
                status: "RUNNING",
                budgetJson: canonicalJson(scoutContract.budget),
              },
              update: {
                contractArtifact: scoutContractArtifact.uri,
                contractHash: scoutContractArtifact.hash,
                resultArtifact: null,
                status: "RUNNING",
                budgetJson: canonicalJson(scoutContract.budget),
                completedAt: null,
              },
            });
          });
          const scoutAccountant = {
            startStep: async (input) => {
              await emit({
                eventType: "scout.step_started",
                aggregateType: "agent",
                aggregateId: scoutAgentId,
                correlationId: task.id,
                idempotencyKey: `${input.attemptId}:started`,
                payload: {
                  delegation_id: input.delegationId,
                  parent_task_id: input.parentTaskId,
                  step: input.step,
                  provider_attempt_id: input.attemptId,
                },
              });
            },
            settleStep: async (input) => {
              await emit({
                eventType: "scout.step_settled",
                aggregateType: "agent",
                aggregateId: scoutAgentId,
                correlationId: task.id,
                idempotencyKey: `${input.attemptId}:settled`,
                payload: {
                  delegation_id: input.delegationId,
                  parent_task_id: input.parentTaskId,
                  step: input.step,
                  provider_attempt_id: input.attemptId,
                  status: input.status,
                  usage: jsonSafe(input.usage),
                  failure_reason: input.failureReason,
                },
              });
            },
          } satisfies DelegationStepAccountant;
          const scope = {
            workspaceId: workspace.id as never,
            sessionId: turn.thread.sessionId as never,
            taskId: task.id as never,
            pathPatterns: [],
          };
          const now = new Date().toISOString() as never;
          const fragment = (fragmentId: string, kind: "authority" | "recent_episode" | "tool_result" | "user_attachment", text: string, hash: string): ContextFragment => ({
            id: fragmentId,
            kind,
            contentRef: {
              hash: hash as never,
              uri: `artifact://sha256/${hash.slice("sha256:".length)}` as never,
              mediaType: "text/plain",
              bytes: BigInt(new TextEncoder().encode(text).byteLength) as never,
            },
            textContent: text,
            source: { uri: `turn://${turnId}/scout`, producer: "terminus-control", producerVersion: "v1", observedAt: now, observedBy: "control", evidenceRefs: [] },
            sourceVersion: null,
            authority: kind === "authority" ? 90 : 45,
            priority: kind === "authority" ? 90 : 45,
            trust: "derived",
            confidentiality: "workspace",
            injectionRisk: "low",
            exactness: "exact",
            scope,
            freshness: { observedAt: now, sourceVersion: null, stale: false, staleReason: null },
            dependencies: [],
            invalidation: [],
            estimatedTokens: { [selectedModel.modelKey]: Math.max(1, Math.ceil(text.length / 4)) },
            selectionFeatures: { relevance: 1, novelty: 0, coverage: 1, uncertaintyReduction: 1, riskReduction: 1, modelCompatibility: 1, redundancyPenalty: 0, injectionPenalty: 0 },
          });
          const directExecutor = buildDirectExecutor();
          const buildScoutKernelContext = async (): Promise<RequestContext> => kernelTaskContext({
            sessionId: turn.thread.sessionId,
            taskId: task.id,
            turnId,
            workspaceId: workspace.id,
            operationClasses: [
              CapabilityOperationProto.CAPABILITY_OPERATION_READ,
            ],
            workspacePaths: leastWorkspaceScope(contract.allowedScope.readPaths),
          });
          const scoutTracker = new ObservedSourceTracker();
          const scoutObservedPaths = new Set<string>();
          const result = await runScoutLoop({
            objective: scoutObjective,
            identity: {
              parentTaskId: task.id,
              delegationId: scoutDelegationId,
              attemptIdForStep: (step) => `${scoutDelegationId}:attempt:${step}`,
            },
            authority: scoutAuthority,
            budget: scoutBudget,
            accountant: scoutAccountant,
            signal: abortController.signal,
            validateFinalResult: (scout) => {
              const unobserved = scout.files.find((file) => !scoutObservedPaths.has(file.path));
              if (unobserved !== undefined) {
                return `scout cited unobserved file '${unobserved.path}'`;
              }
              const invalidReference = scout.evidenceRefs.find(
                (reference) => !reference.startsWith("artifact://") && !reference.startsWith("workspace://"),
              );
              return invalidReference === undefined
                ? null
                : `scout returned an unsupported evidence reference '${invalidReference}'`;
            },
            callProvider: async (messages, { step, attemptId }) => {
              const fragments = messages.map((message, index) => {
                const kind = index === 0
                  ? "authority"
                  : message.role === "assistant"
                    ? "recent_episode"
                    : message.role === "tool"
                      ? "tool_result"
                      : "user_attachment";
                return fragment(
                  `scout:${turnId}:${index}`,
                  kind,
                  message.text,
                  computeContentHash(message.text),
                );
              });
              const scoutToolSchemas = STANDALONE_TOOL_SCHEMAS.filter((tool) => tool.id === "read");
              const rendered = await scoutRenderer.render({
                provider: selectedProvider,
                model: selectedModel,
                manifestId: `${scoutDelegationId}:manifest:${step}`,
                fragments,
                toolSchemas: scoutToolSchemas,
                cachePlan: { stablePrefixHash: instructionsHash, breakpoints: [] },
                continuationId: null,
                outputProfile: "terse",
                reasoningReserveTokens: 4_096n as never,
                outputReserveTokens: 2_048n as never,
                hardInputLimit: 200_000n as never,
                signal: abortController.signal,
              } as Parameters<typeof selectedRenderer.render>[0]);
              const requestArtifact = await artifactClient.ingest(
                new TextEncoder().encode(canonicalJson(jsonSafe(rendered))),
                {
                  mediaType: "application/json",
                  custom: {
                    purpose: "scout-provider-request",
                    delegationId: scoutDelegationId,
                    providerAttemptId: attemptId,
                  },
                },
              );
              const modelSnapshotHash = computeContentHash(canonicalJson({
                model: selectedModel,
                provider: selectedProvider,
              }));
              const attemptIdentity = deriveProviderAttemptIdentity({
                attemptId,
                providerId: selectedProvider.providerId,
                modelKey: selectedModel.modelKey,
                modelSnapshotHash,
                requestArtifactHash: requestArtifact.hash,
                endpoint: providerAttemptEndpoint(directConfiguration, gatewayModel),
                toolSchemaHash: computeContentHash(canonicalJson(scoutToolSchemas)),
                contextEpochId: contextEpoch.epochId,
              });
              await emit({
                eventType: "scout.provider_running",
                aggregateType: "agent",
                aggregateId: scoutAgentId,
                correlationId: task.id,
                idempotencyKey: `${attemptId}:provider-running`,
                payload: {
                  delegation_id: scoutDelegationId,
                  provider_attempt_id: attemptId,
                  step,
                  provider: selectedProvider.providerId,
                  model: selectedModel.modelKey,
                  request_fingerprint: attemptIdentity.requestFingerprint,
                },
                artifactRefs: [requestArtifact.uri],
              }, async (tx) => {
                await tx.providerAttempt.upsert({
                  where: { id: attemptId },
                  create: {
                    id: attemptId,
                    turnId,
                    attemptNumber: -(step + 1),
                    providerId: selectedProvider.providerId,
                    modelKey: String(selectedModel.modelKey),
                    capabilitySnapshotHash: modelSnapshotHash,
                    contextManifestId: `${scoutDelegationId}:manifest:${step}`,
                    requestArtifact: requestArtifact.uri,
                    requestFingerprint: attemptIdentity.requestFingerprint,
                    providerIdempotencyKey: attemptIdentity.providerIdempotencyKey,
                    status: "running",
                  },
                  update: {
                    requestArtifact: requestArtifact.uri,
                    requestFingerprint: attemptIdentity.requestFingerprint,
                    status: "running",
                    completedAt: null,
                    errorJson: null,
                  },
                });
              });
              try {
                const response = await providerSessionService.execute({
                  rendered,
                  command: localProviderCommand,
                  gateway: scoutGatewayConfig,
                  direct: directConfiguration === null
                    ? null
                    : { vendor: directConfiguration.vendor },
                  ...(directExecutor === undefined ? {} : { executeDirectRequest: directExecutor }),
                  context: { ...await buildScoutKernelContext(), idempotencyKey: attemptIdentity.providerIdempotencyKey },
                  workspaceId: workspace.id,
                  signal: abortController.signal,
                });
                const projectedScout = await scoutRenderer.projectResponse(response);
                const usage = scoutRenderer.extractUsage(response);
              const accountFreeContract = accountRouting !== null
                && (accountRouting.account.billing === "subscription" || accountRouting.account.billing === "free");
              const freeModelContract = accountRouting !== null
                ? accountFreeContract
                : gatewayModel !== null
                  && gatewayModel.deployment === "zen"
                  && gatewayModel.free
                  && gatewayProviderConfiguration?.credentialConfigured !== true
                  && selectedProvider.economics.inputMicrosPerMillion === 0n
                  && selectedProvider.economics.cachedInputMicrosPerMillion === 0n
                  && selectedProvider.economics.outputMicrosPerMillion === 0n;
              const costSource = accountRouting !== null || directConfiguration !== null || gatewayModel !== null
                ? freeModelContract ? "free_model_contract" as const : "admitted_economics" as const
                : "unavailable" as const;
              const computedCostMicros = costSource === "unavailable"
                ? null
                : computeCost({
                    usage,
                    economics: selectedProvider.economics,
                    providerReportedCostMicros: null,
                  }).computedCostMicros;
              const responseArtifact = await artifactClient.ingest(
                new TextEncoder().encode(canonicalJson(response)),
                {
                  mediaType: "application/json",
                  custom: {
                    purpose: "scout-provider-response",
                    delegationId: scoutDelegationId,
                    providerAttemptId: attemptId,
                  },
                },
              );
              await emit({
                eventType: "scout.provider_settled",
                aggregateType: "agent",
                aggregateId: scoutAgentId,
                correlationId: task.id,
                idempotencyKey: `${attemptId}:provider-settled`,
                payload: {
                  delegation_id: scoutDelegationId,
                  provider_attempt_id: attemptId,
                  step,
                  usage: jsonSafe(usage),
                  finish_reason: projectedScout.finishReason,
                  cost_source: costSource,
                  computed_cost_micros: computedCostMicros?.toString() ?? null,
                },
                artifactRefs: [responseArtifact.uri],
              }, async (tx) => {
                await tx.providerAttempt.update({
                  where: { id: attemptId },
                  data: {
                    status: "completed",
                    responseArtifact: responseArtifact.uri,
                    providerRequestId: response.providerRequestId ?? providerRequestIdFromChunks(response.chunks),
                    continuationId: projectedScout.continuationId,
                    completedAt: new Date(),
                    usageJson: canonicalJson(jsonSafe(usage)),
                    providerReportedCostMicros: null,
                    computedCostMicros,
                    costSource,
                    finishReason: projectedScout.finishReason,
                    reasoningReplayJson: projectedScout.reasoningReplay === undefined || projectedScout.reasoningReplay.length === 0
                      ? null
                      : serializeReasoningReplay(projectedScout.reasoningReplay),
                  },
                });
              });
                return {
                  renderedBody: jsonSafe(rendered),
                  projectedText: projectedScout.text,
                  toolCalls: projectedScout.toolCalls.map((call) => ({
                    toolName: call.toolName,
                    argumentsJson: canonicalJson(call.arguments),
                  })),
                  usage: {
                    inputTokens: usage.inputTokens,
                    cachedInputTokens: usage.cachedInputTokens,
                    cacheWriteTokens: usage.cacheWriteTokens,
                    outputTokens: usage.outputTokens,
                    reasoningTokens: usage.reasoningTokens,
                    toolSchemaTokens: usage.toolSchemaTokens,
                    costMicros: computedCostMicros ?? 0n,
                  },
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await emit({
                  eventType: "scout.provider_failed",
                  aggregateType: "agent",
                  aggregateId: scoutAgentId,
                  correlationId: task.id,
                  idempotencyKey: `${attemptId}:provider-failed`,
                  payload: {
                    delegation_id: scoutDelegationId,
                    provider_attempt_id: attemptId,
                    step,
                    reason: message.slice(0, 512),
                  },
                }, async (tx) => {
                  await tx.providerAttempt.updateMany({
                    where: { id: attemptId, status: "running" },
                    data: {
                      status: abortController.signal.aborted ? "cancelled" : "failed",
                      completedAt: new Date(),
                      errorJson: canonicalJson({ message: message.slice(0, 512) }),
                    },
                  });
                });
                throw error;
              }
            },
            executeTool: async ({ toolName, argumentsJson, attemptId, callIndex }) => {
              let parsedArguments: unknown;
              try {
                parsedArguments = JSON.parse(argumentsJson);
              } catch {
                parsedArguments = {};
              }
              const call = parseStandaloneToolCall({
                toolCallId: `${attemptId ?? scoutDelegationId}:tool:${callIndex ?? 0}`,
                toolName,
                arguments: parsedArguments as Record<string, unknown>,
              });
              const result = await executeStandaloneTool({
                clients: requireKernelUds(),
                context: async () => ({
                  ...await buildScoutKernelContext(),
                  idempotencyKey: `scout-tool:${call.providerCallId}`,
                }),
                workspaceId: workspace.id,
                workspaceRoot: await workspaceCanonicalRoot(workspace.id),
                call,
                internalToolCallId: uuid(),
                sideEffectId: generateUuid7(),
                policyDecisionId: uuid(),
                traceId: turnId,
                contractHash: contractRow.contentHash,
                devMode: DEV_MODE,
                shellModeEnabled: false,
                observedSources: scoutTracker,
                signal: abortController.signal,
              });
              if (toolName === "read" && result.status === "success" && parsedArguments !== null
                && typeof parsedArguments === "object" && !Array.isArray(parsedArguments)
                && typeof (parsedArguments as Record<string, unknown>).path === "string") {
                scoutObservedPaths.add((parsedArguments as Record<string, unknown>).path as string);
              }
              const visible = projectModelVisibleResult(result);
              return { ok: result.status === "success" || result.status === "partial", resultText: JSON.stringify(visible) };
            },
          });
          const resultArtifact = await artifactClient.ingest(
            new TextEncoder().encode(canonicalJson(jsonSafe(result))),
            {
              mediaType: "application/json",
              custom: { purpose: "scout-delegation-result", delegationId: scoutDelegationId },
            },
          );
          const completed = result.status === "completed";
          await emit({
            eventType: completed ? "agent.completed" : "agent.failed",
            aggregateType: "agent",
            aggregateId: scoutAgentId,
            correlationId: task.id,
            idempotencyKey: `${scoutDelegationId}:terminal`,
            payload: {
              agent_id: scoutAgentId,
              delegation_id: scoutDelegationId,
              status: result.status,
              provider_steps: result.stepReceipts.length,
              usage: jsonSafe(result.usage),
              failure_reason: result.failureReason,
            },
            artifactRefs: [resultArtifact.uri],
          }, async (tx) => {
            const completedAt = new Date();
            await tx.delegation.update({
              where: { id: scoutDelegationId },
              data: {
                resultArtifact: resultArtifact.uri,
                status: result.status.toUpperCase(),
                completedAt,
              },
            });
            await tx.agent.update({
              where: { id: scoutAgentId },
              data: {
                state: completed ? "COMPLETED" : result.status.toUpperCase(),
                completedAt,
              },
            });
          });
          return result;
        })();
        if ("claims" in scoutResult && scoutResult.status === "completed") {
          scoutUsage = scoutResult.usage;
          scoutProviderStepCount = scoutResult.stepReceipts.length;
          scoutFiles = scoutResult.files;
          SCOUT_LEDGER.recordScout(task.id, scoutResult.claims.length + scoutResult.files.length);
          scoutBriefSection = {
            claims: scoutResult.claims,
            files: scoutResult.files.slice(0, 32),
            open_questions: scoutResult.openQuestions,
          };
          await mutateAgentState(() => emit({
            eventType: "scout.completed",
            aggregateType: "task",
            aggregateId: task.id,
            correlationId: task.id,
            payload: {
              claims: scoutResult.claims.length,
              files: scoutResult.files.length,
              open_questions: scoutResult.openQuestions.length,
            },
          }));
        } else {
          if ("usage" in scoutResult) {
            scoutUsage = scoutResult.usage;
            scoutProviderStepCount = scoutResult.stepReceipts.length;
          }
          SCOUT_LEDGER.recordScout(task.id, 0);
          await mutateAgentState(() => emit({
            eventType: "scout.skipped",
            aggregateType: "task",
            aggregateId: task.id,
            correlationId: task.id,
            payload: { reason: scoutResult.status },
          }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await mutateAgentState(() => emit({
          eventType: "scout.failed",
          aggregateType: "task",
          aggregateId: task.id,
          correlationId: task.id,
          payload: { reason: message.slice(0, 512) },
        }, async (tx) => {
          const completedAt = new Date();
          await tx.delegation.updateMany({
            where: { id: `scout-delegation:${turnId}`, status: "RUNNING" },
            data: { status: "FAILED", completedAt },
          });
          await tx.agent.updateMany({
            where: { id: `scout-agent:${turnId}`, state: "RUNNING" },
            data: { state: "FAILED", completedAt },
          });
        }));
      }
    }
    const maxTokens = mergeTurnBudget(
      nonNegativeBigInt(taskBudget.max_tokens),
      turnRequestBudget?.maxTokens ?? null,
    );
    const maxCostMicros = mergeTurnBudget(
      nonNegativeBigInt(taskBudget.model_micros) ?? taskSnapshot.contract.budget.modelMicros,
      turnRequestBudget?.maxCostMicros ?? null,
    ) ?? taskSnapshot.contract.budget.modelMicros;
    const scoutTokenUsage = scoutUsage.inputTokens
      + scoutUsage.cacheWriteTokens
      + scoutUsage.outputTokens
      + scoutUsage.reasoningTokens
      + scoutUsage.toolSchemaTokens;
    const remainingMaxTokens = maxTokens === null
      ? null
      : maxTokens > scoutTokenUsage ? maxTokens - scoutTokenUsage : 0n;
    const remainingCostMicros = maxCostMicros > scoutUsage.costMicros
      ? maxCostMicros - scoutUsage.costMicros
      : 0n;
    const remainingMaxSteps = Math.max(1, configuredMaxSteps - scoutProviderStepCount);
    const wallClockSeconds = numberOr(taskBudget.wall_clock_seconds, taskSnapshot.contract.budget.wallClockSeconds);
    const finalVerificationReserveTokens = contextBudget.outputReserve + contextBudget.recoveryMargin;
    const finalVerificationReserveCostMicros = 0n;
    const ledgerBudget = {
      maxSteps: remainingMaxSteps,
      hardMaxSteps: HARD_MAX_STEPS,
      wallClockMs: Math.max(0, Math.floor(wallClockSeconds * 1_000)),
      ...(remainingMaxTokens === null ? {} : { maxTokens: remainingMaxTokens }),
      maxCostMicros: remainingCostMicros,
      contextHeadroomTokens: contextBudget.hardInputLimit,
      finalVerificationReserveTokens,
      finalVerificationReserveCostMicros,
    };
    activeEngine = new CodingTurnEngine({
      budget: {
        // The explicit knob is clamped to the hard safety ceiling (ADR-0039):
        // an operator may lower the budget but never raise the invariant.
        ...ledgerBudget,
      },
      newId: uuid,
      sideEffectClassOf,
      effectMetadataOf: (call) => {
        try {
          return toolEffectMetadata(parseStandaloneToolCall(call));
        } catch {
          // Invalid calls are settled through the typed policy/argument error
          // path. Until that path runs, keep their execution serialized.
          return {
            sideEffectClass: sideEffectClassOf(call.toolName),
            workspaceSnapshot: null,
            externalNetwork: false,
            processAffinity: null,
            consistency: "live" as const,
            rateLimitGroup: null,
            cacheable: false,
            expectedLatencyMs: 30_000,
            expectedOutputBytes: 32 * 1_024,
            effectType: "EXECUTE_LOCAL" as const,
            resourceUri: "workspace://unknown",
            reversibility: "unknown" as const,
          };
        }
      },
      mutatesWorkspaceOf: (call) => {
        try {
          return mayChangeWorkspace(parseStandaloneToolCall(call));
        } catch {
          // Unknown or invalid calls remain conservative until their typed
          // settlement error proves that no effect ran.
          return true;
        }
      },
      signal: abortController.signal,
      taskId: task.id,
      contractVersion: contractRow.version,
      operationContext: ({ call }) => {
        try {
          const parsedCall = parseStandaloneToolCall(call);
          return { toolVersion: parsedCall.toolVersion };
        } catch {
          return {};
        }
      },
      onOperationObserved: async (observation) => {
        if (activeEngine !== null) {
          await persistOperationObservationAndLedger(
            turnId,
            observation,
            activeEngine.budget.latestProgress,
            activeEngine.budget.ledger,
            turnContextBudgetJson,
          );
        } else {
          await persistOperationObservation(turnId, observation, null);
        }
      },
      onPolicyDenied: async (message) => {
        await mutateAgentState(() => emit({
          eventType: "turn.policy_denied",
          aggregateType: "turn",
          aggregateId: turnId,
          correlationId: task.id,
          payload: {
            reason: "tool_policy_denied",
            message: message.slice(0, 512),
          },
        }));
      },
      // Mid-turn steering gate: report steering messages queued since the
      // last drain, oldest first. Content is read from the durable steering
      // artifacts; cursor state lives in the agentLoop closure so a resume
      // never re-drains acknowledged messages.
      drainSteering: async () => {
        const rows = await db.episode.findMany({
          where: { turnId, kind: "steering_message", sequence: { gt: lastSteeredSequence } },
          orderBy: { sequence: "asc" },
          select: { sequence: true, contentArtifact: true },
        });
        if (rows.length === 0) return [];
        lastSteeredSequence = rows[rows.length - 1]!.sequence;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const messages: string[] = [];
        for (const row of rows) {
          if (row.contentArtifact === null || !row.contentArtifact.startsWith("artifact://sha256/")) {
            throw new Error(`steering episode ${row.sequence} has no readable content artifact`);
          }
          const hash = `sha256:${row.contentArtifact.slice("artifact://sha256/".length)}` as ContentHash;
          messages.push(decoder.decode(await artifactClient.get(hash)));
        }
        return messages;
      },
      compileContext: async () => {
        const turnState = await db.turn.findUnique({
          where: { id: turnId },
          select: { state: true },
        });
        if (turnState?.state === "RESPONSE_VALIDATING") {
          await turnCommandExecutor.rearmForProviderContinuation({ turnId, taskId: task.id });
        } else if (turnState?.state !== "CONTEXT_COMPILING") {
          throw new Error(
            `turn ${turnId} cannot compile provider context from ${turnState?.state ?? "missing"}`,
          );
        }
        const { compiled, requestArtifact } = await compileProviderContext();
        const modelSnapshotHash = computeContentHash(canonicalJson({
          model: selectedModel,
          provider: selectedProvider,
        }));
        return {
          rendered: compiled.rendered,
          requestArtifactUri: requestArtifact.uri,
          requestArtifactHash: requestArtifact.hash,
          contextManifestId: compiled.manifest.id as string,
          providerCapabilityHash: compiled.manifest.providerCapabilityHash as string,
          modelSnapshotHash,
          providerEndpoint: providerAttemptEndpoint(directConfiguration, gatewayModel),
          toolSchemaHash: computeContentHash(canonicalJson(compiled.rendered.request.toolSchemas)),
          contextEpochId: contextEpoch.epochId,
        };
      },
      beginAttempt: async ({ attemptId, attemptNumber, compiled }) => {
        declaredToolSchemasByAttempt.set(attemptId, compiled.rendered.request.toolSchemas);
        manifestIdByAttempt.set(attemptId, compiled.contextManifestId as Uuid7);
        predictedCacheByAttempt.set(attemptId, compiled.rendered.predictedCachedTokens);
        const identity = deriveProviderAttemptIdentity({
          attemptId,
          providerId: selectedProvider.providerId,
          modelKey: selectedModel.modelKey,
          modelSnapshotHash: compiled.modelSnapshotHash,
          requestArtifactHash: compiled.requestArtifactHash,
          endpoint: compiled.providerEndpoint,
          toolSchemaHash: compiled.toolSchemaHash,
          contextEpochId: compiled.contextEpochId,
        });
        return providerSessionService.beginAttempt({
          attemptId,
          turnId,
          taskId: task.id,
          attemptNumber,
          providerId: selectedProvider.providerId,
          modelKey: selectedModel.modelKey,
          capabilitySnapshotHash: compiled.providerCapabilityHash,
          contextManifestId: compiled.contextManifestId,
          requestArtifact: compiled.requestArtifactUri,
          requestFingerprint: identity.requestFingerprint,
          providerIdempotencyKey: identity.providerIdempotencyKey,
        });
      },
      executeProvider: async ({ attemptId, compiled }) => {
        const directExecutor = buildDirectExecutor();
        // R6: bounded retry/backoff for transient provider faults. The
        // native runtime settles partials explicitly; this is the recovery
        // layer it delegates to.
        try {
          return await withProviderRetry(
            async () =>
              providerSessionService.execute({
                rendered: compiled.rendered,
                command: localProviderCommand,
                gateway: providerGatewayConfig,
                direct: directConfiguration === null
                  ? null
                  : { vendor: directConfiguration.vendor },
                ...(directExecutor === undefined ? {} : { executeDirectRequest: directExecutor }),
                // Client streaming: text deltas reach the event stream as
                // they arrive (coalesced); the local PTY transport only
                // exposes stdout after job completion and cannot stream.
                ...(directConfiguration === null && gatewayModel === null
                  ? {}
                  : { onChunk: providerTextDeltas.onChunk }),
                context: {
                  ...await buildProviderTaskContext(),
                  idempotencyKey: providerAttemptIdempotencyKey(attemptId),
                },
                workspaceId: workspace.id,
                signal: abortController.signal,
              }),
            { maxAttempts: 3, signal: abortController.signal },
          );
        } finally {
          await providerTextDeltas.flush();
        }
      },
      settleResponse: async ({ attemptId, response }) => {
        const midTurn = await db.turn.findUnique({ where: { id: turnId }, select: { state: true } });
        if (midTurn?.state === "INTERRUPTED" || midTurn?.state === "ABORTED") {
          return {
            projected: {
              text: "",
              toolCalls: [],
              reasoning: null,
              continuationId: null,
              finishReason: "cancelled",
            } satisfies ProjectedResponse,
            interrupted: true,
          };
        }
        const projected = await selectedRenderer.projectResponse(response);
        const usage = selectedRenderer.extractUsage(response);
        // A subscription or free-tier account has no per-token price at all,
        // so a computed zero must be labelled as the contract it came from.
        // Reporting it as `admitted_economics` would let a reader mistake "no
        // price exists" for "we measured zero spend".
        const accountFreeContract = accountRouting !== null
          && (accountRouting.account.billing === "subscription"
            || accountRouting.account.billing === "free");
        const freeModelContract = accountRouting !== null
          ? accountFreeContract
          : gatewayModel !== null
            && gatewayModel.deployment === "zen"
            && gatewayModel.free
            && gatewayProviderConfiguration?.credentialConfigured !== true
            && selectedProvider.economics.inputMicrosPerMillion === 0n
            && selectedProvider.economics.cachedInputMicrosPerMillion === 0n
            && selectedProvider.economics.outputMicrosPerMillion === 0n;
        const costSource = accountRouting !== null || directConfiguration !== null || gatewayModel !== null
          ? freeModelContract ? "free_model_contract" as const : "admitted_economics" as const
          : "unavailable" as const;
        const cost = costSource === "unavailable"
          ? {
              providerReportedCostMicros: null,
              computedCostMicros: null,
              source: costSource,
            }
          : {
              providerReportedCostMicros: null,
              computedCostMicros: computeCost({
                usage,
                economics: selectedProvider.economics,
                providerReportedCostMicros: null,
              }).computedCostMicros,
              source: costSource,
            };
        // R7: reconcile predicted vs actual cache reads for this attempt.
        const predictedCached = predictedCacheByAttempt.get(attemptId) ?? 0n;
        const cacheRecord = cacheMonitor.record(attemptId, predictedCached, usage.cachedInputTokens);
        const cacheStatus = cacheMonitor.status();
        const observedRatio = cacheRecord.ratio;
        if (observedRatio !== null) {
          await mutateAgentState(() => emit({
            eventType: "context.cache_ratio_observed",
            aggregateType: "context_manifest",
            aggregateId: manifestIdByAttempt.get(attemptId) ?? turnId,
            correlationId: task.id,
            payload: {
              provider_attempt_id: attemptId,
              predicted_cached_tokens: cacheRecord.predictedCachedTokens.toString(),
              actual_read_tokens: cacheRecord.actualReadTokens.toString(),
              ratio: Number(observedRatio.toFixed(4)),
              consecutive_low_misses: cacheStatus.consecutiveLowMisses,
            },
          }));
        }
        if (cacheStatus.warning !== null && cacheRecord.ratio !== null) {
          await mutateAgentState(() => emit({
            eventType: "context.cache_ratio_warning",
            aggregateType: "context_manifest",
            aggregateId: manifestIdByAttempt.get(attemptId) ?? turnId,
            correlationId: task.id,
            payload: {
              provider_attempt_id: attemptId,
              warning: cacheStatus.warning,
              average_ratio: cacheStatus.averageRatio === null ? null : Number(cacheStatus.averageRatio.toFixed(4)),
            },
          }));
        }
        const responseArtifactMeta = await artifactClient.ingest(
          new TextEncoder().encode(canonicalJson(response)),
          {
            mediaType: "application/json",
            custom: { purpose: "provider-response", providerAttemptId: attemptId },
          },
        );
        const messageArtifactMeta = projected.text.length === 0
          ? null
          : await artifactClient.ingest(
              new TextEncoder().encode(projected.text),
              {
                mediaType: "text/plain",
                custom: { purpose: "provider-message", providerAttemptId: attemptId },
              },
            );
        const observedManifestId = manifestIdByAttempt.get(attemptId);
        if (observedManifestId === undefined) {
          throw new Error(`provider attempt ${attemptId} has no context manifest`);
        }
        await contextStore.recordObservation(observedManifestId, {
          responseArtifact: responseArtifactMeta.uri,
          usage: jsonSafe(usage),
          projectedFinishReason: projected.finishReason,
          cache: {
            predictedCachedTokens: cacheRecord.predictedCachedTokens.toString(),
            observedCachedTokens: cacheRecord.actualReadTokens.toString(),
            ratio: observedRatio,
          },
        });
        await providerSessionService.settleResponse({
          attemptId,
          turnId,
          taskId: task.id,
          responseArtifact: responseArtifactMeta.uri,
          messageArtifact: messageArtifactMeta?.uri ?? null,
          messageHash: messageArtifactMeta?.hash ?? null,
          usage: jsonSafe(usage),
          finishReason: projected.finishReason,
          continuationId: projected.continuationId,
          providerRequestId: response.providerRequestId ?? providerRequestIdFromChunks(response.chunks),
          cost,
          // Durable reasoning replay: the renderer's in-memory ledger dies
          // with the process, but the tool calls it must lead survive in
          // `episodes` and get rendered again after a resume.
          reasoningReplayJson: projected.reasoningReplay === undefined || projected.reasoningReplay.length === 0
            ? null
            : serializeReasoningReplay(projected.reasoningReplay),
        });
        // Estimator feedback: compare what the compiler predicted for this
        // attempt's prompt against what the provider actually charged for it.
        // Without this call the calibration ledger has no samples and every
        // estimate stays permanently `degraded`.
        const predictedPromptTokens = predictedPromptByManifest.get(observedManifestId);
        if (predictedPromptTokens !== undefined) {
          observeAttemptUsage({
            providerId: selectedProvider.providerId,
            modelKey: selectedModel.modelKey,
            manifestId: observedManifestId,
            predictedPromptTokens,
            usage,
          });
        }
        lastResponseArtifactUri = responseArtifactMeta.uri;
        currentProjected = projected;
        if (projected.toolCalls.length === 0) {
          // Close the provider/tool phase for observers on a final response.
          await mutateAgentState(() => emit({
            eventType: "turn.tool_settlement",
            aggregateType: "turn",
            aggregateId: turnId,
            correlationId: task.id,
            payload: { provider_attempt_id: attemptId, tool_calls: 0 },
          }));
        }
        const claims: readonly CompletionClaim[] = criteriaRows.map((criterion) => ({
          criterionId: criterion.criterionId,
          // A proposal carries the criterion mapping, but no verifier result.
          // The independent verification gate remains the only completion
          // authority.
          evidenceRefs: [],
          changedArtifactRefs: [],
        }));
        const completion = projected.finishReason === "stop" && projected.text.trim().length > 0
          ? { kind: "completion_proposal" as const, claims }
          : { kind: "assistant_message" as const };
        return {
          projected,
          interrupted: false,
          responseArtifactUri: responseArtifactMeta.uri,
          usage: {
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            toolSchemaTokens: usage.toolSchemaTokens,
            costMicros: cost.computedCostMicros ?? undefined,
          },
          completion,
        };
      },
      settleToolCall: async ({ call, attemptNumber, attemptId }) => {
        if (!toolsEnabledForTurn) {
          throw new ToolPolicyDeniedError("Provider emitted a tool call while standalone tools were disabled");
        }
        const declaredToolSchemas = declaredToolSchemasByAttempt.get(attemptId);
        if (declaredToolSchemas === undefined) {
          throw new Error(`provider attempt ${attemptId} has no declared tool-schema snapshot`);
        }
        const declaredToolIds = declaredToolSchemas.map((schema) => schema.id);
        // A call the model got wrong is settled as an error result it can
        // read, not thrown out of the turn (see InvalidToolCallError). Only
        // the verdict is reached here; the settlement path persists it.
        let parsedCall: ParsedStandaloneToolCall | null = null;
        let rejection: InvalidToolCallError | null = null;
        try {
          parsedCall = parseStandaloneToolCall(call);
        } catch (error: unknown) {
          if (!(error instanceof InvalidToolCallError)) throw error;
          rejection = error;
        }
        if (
          parsedCall !== null
          && !standaloneToolCallIsDeclared(parsedCall, declaredToolSchemas)
        ) {
          const requiresWorkspaceActivation = capabilityActionRequiresActivatedWorkspace(parsedCall);
          rejection = new InvalidToolCallError({
            toolName: call.toolName,
            providerCallId: call.toolCallId,
            modelMessage: requiresWorkspaceActivation
              ? "Workspace capability discovery is unavailable in this provider attempt. Call capability with {\"action\":\"activate_workspace\"}; the expanded schema is declared on the next attempt."
              : `'${parsedCall.toolId}' is not available in this provider attempt. Available tools: ${declaredToolIds.join(", ")}.`,
          });
          parsedCall = null;
        }
        if (parsedCall !== null && mayChangeWorkspace(parsedCall)) {
          // This is intentionally recorded before settlement. A denied call
          // is not evidence of a mutation, but it distinguishes a blocked
          // coding attempt from a legitimate read-only/question turn.
          turnAttemptedWorkspaceMutation = true;
        }
        if (!toolSettlementEnteredFor.has(attemptId)) {
          toolSettlementEnteredFor.add(attemptId);
          const count = currentProjected?.toolCalls.length ?? 0;
          await mutateAgentState(() => emit({
            eventType: "turn.tool_settlement",
            aggregateType: "turn",
            aggregateId: turnId,
            correlationId: task.id,
            payload: { provider_attempt_id: attemptId, tool_calls: count },
          }, async (tx) => {
            await executeTurnTransition(
              planEnterToolSettlement({ turnId, taskId: task.id, providerAttemptId: attemptId, toolCallCount: count }),
              tx,
            );
          }));
        }
        await toolEpisodeSession.settle({
          call,
          attemptNumber,
          providerAttemptId: attemptId,
          turnId,
          taskId: task.id,
          sessionId: turn.thread.sessionId,
          workspaceId: workspace.id,
          contractVersion: contractRow.version,
          contractHash: contractRow.contentHash,
          artifactClient,
          ...(rejection === null ? {} : { rejection }),
        });
        const settlement = settlementByProviderCallId.get(call.toolCallId);
        if (
          parsedCall?.toolId === "capability"
          && (settlement?.status === "success" || settlement?.status === "partial")
        ) {
          const action = parsedCall.arguments.action;
          if (action === "activate_workspace") {
            // The durable activation snapshot committed atomically with the
            // result. This assignment only advances the current process.
            workspaceActivated = true;
          }
        }
        if (
          parsedCall !== null
          && mayChangeWorkspace(parsedCall)
          && (settlement?.status === "success" || settlement?.status === "partial")
        ) {
          turnMayHaveChangedWorkspace = true;
        }
        return settlement;
      },
      afterToolsSettled: async () => {
        await mutateAgentState(() => emit({
          eventType: "turn.context_compiling",
          aggregateType: "turn",
          aggregateId: turnId,
          correlationId: task.id,
          payload: { phase: "context_compiling", reason: "tool_calls_settled" },
        }, async (tx) => {
          await executeTurnTransition(planReenterContextCompiling({ turnId, taskId: task.id }), tx);
        }));
      },
    });
    activeEngine.budget.recordEvidence({
      outstandingCriteria: criteriaRows.filter((criterion) => criterion.required).length,
      satisfiedCriteria: 0,
      evidenceCoverage: 0,
    });
    if (resumeVerificationFromState) {
      // A completed provider response is already durably identified by the
      // proposal event or provider-attempt row. Recovery must never re-enter
      // the provider engine from RESPONSE_VALIDATING/VERIFYING.
      const [proposal, completedAttempt] = await Promise.all([
        db.semanticEvent.findFirst({
          where: { eventType: "completion.proposed", aggregateType: "turn", aggregateId: turnId },
          orderBy: { occurredAt: "desc" },
          select: { payloadJson: true, artifactRefsJson: true },
        }),
        db.providerAttempt.findFirst({
          where: { turnId, status: "completed", responseArtifact: { not: null } },
          orderBy: { completedAt: "desc" },
          select: { responseArtifact: true },
        }),
      ]);
      const proposalPayload = proposal === null
        ? null
        : safeParse<Record<string, unknown>>(proposal.payloadJson, {});
      const proposalRefs = proposal === null ? [] : safeParse<string[]>(proposal.artifactRefsJson, []);
      const responseArtifact = typeof proposalPayload?.response_artifact === "string"
        ? proposalPayload.response_artifact
        : proposalRefs[0] ?? completedAttempt?.responseArtifact ?? null;
      const parsedResponseArtifact = responseArtifact === null
        ? null
        : artifactUriSchema.safeParse(responseArtifact);
      if (parsedResponseArtifact === null || !parsedResponseArtifact.success) {
        throw new Error("verification recovery has no valid completed provider response artifact");
      }
      finalText = "";
      finalResponseArtifactUri = parsedResponseArtifact.data;
    } else {
      if (activeEngine === null) throw new Error("coding loop engine was not initialized");
      // H10: every kernel RPC issued underneath the loop inherits a deadline no
      // later than the turn's own wall-clock budget, so a kernel that stops
      // answering fails the turn with DEADLINE_EXCEEDED instead of hanging it.
      const engine = activeEngine;
      // The steering episode is the durable admission record. Reconstruct the
      // count before the first provider call so a control-plane restart cannot
      // turn the one-continuation allowance into an unbounded retry loop.
      const priorIntentOnlyContinuations = await db.episode.count({
        where: {
          turnId,
          kind: "steering_message",
          sourceVersionsJson: { contains: '"reason":"intent_only_stop"' },
        },
      });
      let intentOnlyContinuationCount = priorIntentOnlyContinuations;
      let stop = await withTurnDeadline(ledgerBudget.wallClockMs, async () => engine.run());
      for (;;) {
        // A response cut off by the output limit is not a stop, it is an
        // interruption. Both length cases — a truncated tool call and a
        // truncated message — used to end the turn (the first as
        // ToolCycleBudgetExhausted because the switch had no case for it, the
        // second as a "completed" turn holding half a sentence). Queue a
        // continuation nudge as a durable steering episode and re-enter the
        // loop, which drains it into the next compiled context. The engine's
        // own step/token/wall-clock budget still bounds the whole thing;
        // TRUNCATION_CONTINUATION_LIMIT only stops a provider that truncates
        // every single response from spinning.
        for (
          let continuation = 0;
          (stop.kind === "truncated_tool_calls" || stop.kind === "length")
            && continuation < TRUNCATION_CONTINUATION_LIMIT
            && !abortController.signal.aborted;
          continuation += 1
        ) {
          await queueTruncationContinuation(stop);
          stop = await withTurnDeadline(ledgerBudget.wallClockMs, async () => engine.run());
        }
        await persistTurnBudgetLedger(turnId, activeEngine.budget.ledger, turnContextBudgetJson);

        // A provider response is only a completion proposal after this guard.
        // In particular, the no-workspace-change path below must not turn an
        // intent-only coding stop into a successful read-only completion.
        const providerStoppedWithResponse = stop.kind === "length"
          || stop.kind === "truncated_tool_calls"
          || stop.kind === "assistant_message"
          || stop.kind === "completion_proposal"
          || stop.kind === "final";
        if (providerStoppedWithResponse) {
          const recovery = decideIntentOnlyRecovery({
            criteria: criteriaRows.map((criterion) => ({
              criterionId: criterion.criterionId,
              required: criterion.required,
              status: criterion.status,
            })),
            claims: stop.kind === "completion_proposal" ? stop.proposal.claims : [],
            workspaceMutationObserved: turnMayHaveChangedWorkspace,
            workspaceMutationAttempted: turnAttemptedWorkspaceMutation,
            continuationAdmitted: intentOnlyContinuationCount >= INTENT_ONLY_CONTINUATION_LIMIT,
          });
          if (recovery.kind === "continue") {
            await queueIntentOnlyContinuation(recovery.pendingCriterionIds);
            intentOnlyContinuationCount += 1;
            stop = await withTurnDeadline(ledgerBudget.wallClockMs, async () => engine.run());
            continue;
          }
          if (recovery.kind === "block") {
            const error: LoopErrorEnvelope = {
              code: "INTENT_ONLY_STOP_REPEATED",
              category: "verification",
              message: "The provider stopped again without changing the workspace or producing evidence for required acceptance criteria.",
              retryable: false,
              suggestedAction: "retry the task after reviewing the provider or workspace access",
              details: {
                pending_criterion_ids: recovery.pendingCriterionIds,
                continuation_limit: INTENT_ONLY_CONTINUATION_LIMIT,
              },
            };
            throw new EngineTerminalStopError({
              kind: "blocked",
              reason: recovery.reason,
              error,
            });
          }
        }

        switch (stop.kind) {
          case "length":
          case "truncated_tool_calls":
            // The continuation budget is spent and the model is still being
            // cut off. Settle on the text that did arrive rather than failing
            // the turn outright; an empty one falls through to no_final_response.
            if (stop.text.trim().length === 0) {
              throw new EngineTerminalStopError({ kind: "no_final_response" });
            }
            finalText = stop.text;
            finalResponseArtifactUri = stop.responseArtifactUri ?? lastResponseArtifactUri;
            completionClaims = criteriaRows.map((criterion) => ({
              criterionId: criterion.criterionId,
              evidenceRefs: [],
              changedArtifactRefs: [],
            }));
            break;
          case "assistant_message":
            // H3: a final assistant message with no pending tool calls means
            // the model is done. Settle the turn on it. When the turn changed
            // the workspace the verification pass below still runs first;
            // when it did not, there is nothing to verify.
            if (stop.text.trim().length === 0) {
              throw new EngineTerminalStopError({ kind: "no_final_response" });
            }
            finalText = stop.text;
            finalResponseArtifactUri = stop.responseArtifactUri ?? lastResponseArtifactUri;
            completionClaims = criteriaRows.map((criterion) => ({
              criterionId: criterion.criterionId,
              evidenceRefs: [],
              changedArtifactRefs: [],
            }));
            break;
          case "completion_proposal":
            finalText = stop.proposal.text;
            finalResponseArtifactUri = stop.proposal.responseArtifactUri;
            completionClaims = stop.proposal.claims;
            break;
          case "final":
            finalText = stop.text;
            finalResponseArtifactUri = stop.responseArtifactUri ?? lastResponseArtifactUri;
            completionClaims = criteriaRows.map((criterion) => ({
              criterionId: criterion.criterionId,
              evidenceRefs: [],
              changedArtifactRefs: [],
            }));
            break;
          case "interrupted":
          case "budget_stop":
          case "policy_stop":
          case "blocked":
          case "needs_user_input":
          case "failed_verification":
          case "budget_exhausted":
          case "policy_denied":
          case "doom_loop":
          case "no_final_response":
            throw new EngineTerminalStopError(stop);
        }
        break;
      }
    }

    if (finalText === null || finalResponseArtifactUri === null) {
      throw new ToolCycleBudgetExhaustedError("Provider turn ended without a final response");
    }

    // R10: citation accounting — when the parent actually changed files the
    // scout surfaced, count it so productive scouts stay enabled.
    if (scoutFiles.length > 0 && latestChangedFiles.some((changedFile) => scoutFiles.some((scoutFile) => scoutFile.path === changedFile))) {
      SCOUT_LEDGER.recordCitation(task.id);
      await mutateAgentState(() => emit({
        eventType: "scout.cited",
        aggregateType: "task",
        aggregateId: task.id,
        correlationId: task.id,
        payload: { cited_files: scoutFiles.length },
      }));
    }

    // A model final response is a proposal artifact, not completion. The
    // terminal transition and success checkpoint are defined below and only
    // called after verification admission succeeds.
    const existingCompletionProposal = await db.semanticEvent.findFirst({
      where: {
        eventType: "completion.proposed",
        aggregateType: "turn",
        aggregateId: turnId,
      },
      select: { eventId: true },
    });
    if (existingCompletionProposal === null) {
      const evidenceProfile = turnProfile;
      if (evidenceProfile === null) throw new Error("completion proposal has no selected profile");
      await mutateAgentState(() => emit({
        eventType: "completion.proposed",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: turn.taskId ?? undefined,
        payload: {
          status: "PROPOSED",
          response_artifact: finalResponseArtifactUri,
          claims: completionClaims,
          profile_id: evidenceProfile.profileId,
          profile_version: evidenceProfile.version,
          profile_hash: evidenceProfile.profileHash,
          evidence_bundle_version: "terminus.evidence-bundle.v1",
        },
        artifactRefs: [finalResponseArtifactUri],
      }));
    }

    const finalizeTurn = async (
      expectedState: "RESPONSE_VALIDATING" | "VERIFIED",
      after: "verification_admitted" | "verification_not_applicable" | "verification_unavailable" | "taskless_turn",
    ): Promise<void> => {
      await mutateAgentState(() => emit({
        eventType: "turn.finalizing",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: turn.taskId ?? undefined,
        payload: { phase: "finalizing", after },
      }, async (tx) => {
        await executeTurnTransition(planEnterFinalizing({
          turnId,
          taskId: turn.taskId,
          after,
          expectedState,
        }), tx);
      }));

      // R5: automatic end-of-turn checkpoint so cross-turn continuity carries
      // decisions and criteria state without manual /checkpoints calls. Keep
      // this before terminal publication: a completed turn must have had its
      // continuity checkpoint opportunity after verification admission.
      let checkpointOutcome: { checkpoint: CheckpointPublication } | { skipped: string } = {
        skipped: "taskless turn",
      };
      if (turn.taskId !== null && turn.taskId !== undefined) {
        const autoCheckpointCriteriaRows = await db.acceptanceCriterion.findMany({
          where: { taskId: turn.taskId, contractVersion: contractRow.version },
        });
        const effectStateForCheckpoint: NonNullable<CheckpointContent["effectState"]> = [...arpV2.effects.values()]
          .filter((effect) => effect.taskId === turn.taskId)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((effect) => ({
            effectId: effect.id,
            state: effect.state,
            idempotencyKey: effect.semanticIdempotencyKey,
          }));
        checkpointOutcome = await prepareTurnCheckpoint({
          taskId: turn.taskId,
          threadId: turn.threadId,
          sessionId: turn.thread.sessionId,
          turnId,
          turnSequence: turn.sequence,
          contract,
          contractContentHash: contractRow.contentHash as ContentHash,
          criteriaRows: autoCheckpointCriteriaRows.map((criterion) => ({
            criterionId: criterion.criterionId,
            statement: criterion.statement,
            required: criterion.required,
            status: criterion.status,
          })),
          effectState: effectStateForCheckpoint,
          terminalErrorJson: null,
        });
      }

      const summaryCodePoints = Array.from(finalText);
      const summaryTruncated = summaryCodePoints.length > TURN_RESPONSE_SUMMARY_MAX_CHARS;
      const summary = summaryCodePoints.slice(0, TURN_RESPONSE_SUMMARY_MAX_CHARS).join("");
      const reasoningCodePoints = Array.from(currentProjected?.reasoning ?? "");
      const reasoning = reasoningCodePoints.length === 0
        ? null
        : reasoningCodePoints.slice(0, TURN_REASONING_SUMMARY_MAX_CHARS).join("");
      if ("checkpoint" in checkpointOutcome) {
        await mutateAgentState(() => commitCheckpointAndTerminalTurn({
          ...checkpointOutcome.checkpoint,
          turnId,
          responseArtifactUri: finalResponseArtifactUri,
          summary,
          summaryTruncated,
          continuation: summaryTruncated ? finalResponseArtifactUri : null,
          reasoning,
        }));
        return;
      }
      await mutateAgentState(() => emit({
        eventType: "turn.completed",
        aggregateType: "turn", aggregateId: turnId,
        correlationId: turn.taskId ?? undefined,
        payload: {
          state: "COMPLETED",
          summary,
          summary_truncated: summaryTruncated,
          continuation: summaryTruncated ? finalResponseArtifactUri : null,
          ...(reasoning === null ? {} : { reasoning }),
        },
        artifactRefs: [finalResponseArtifactUri],
      }, async (tx) => {
        await executeTurnTransition(
          { ...planComplete({ turnId }), eventType: "turn.completed", payload: {} },
          tx,
        );
      }));
    };

    const failVerificationTurn = async (reason: Readonly<Record<string, unknown>>): Promise<void> => {
      await mutateAgentState(() => emit({
        eventType: "turn.failed",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: turn.taskId ?? undefined,
        payload: { reason: "verification_failed", ...reason },
      }, async (tx) => {
        await executeTurnTransition(planFailVerification({ turnId, taskId: turn.taskId, reason }), tx);
      }));
    };

    // If the task has a status of ACTIVE, advance it through VERIFY → COMPLETE.
    // A restart may re-enter here with the task already VERIFYING; in that
    // case the durable plan below is resumed without another provider call.
    if (turn.taskId) {
      const task = await db.task.findUnique({ where: { id: turn.taskId } });
      const enteringVerification = task?.status === "ACTIVE";
      const continuingVerification = task?.status === "VERIFYING" && resumeVerificationFromState;
      if (task !== null && enteringVerification && !turnMayHaveChangedWorkspace) {
        // H3: chat / question / explanation turn. There is no workspace change
        // to verify, so demanding test evidence would make the turn
        // permanently incompletable. The turn settles on the final message and
        // the task stays ACTIVE so the user can keep steering it.
        await mutateAgentState(() => emit({
          eventType: "turn.verification_not_applicable",
          aggregateType: "turn",
          aggregateId: turnId,
          correlationId: task.id,
          payload: {
            reason: "turn_made_no_workspace_changes",
            detail: "No workspace-mutating tool settled in this turn; there is no change to verify.",
            proposal_artifact: finalResponseArtifactUri,
          },
          artifactRefs: [finalResponseArtifactUri],
        }));
        await persistEvidenceForCurrentTurn("COMPLETED");
        await finalizeTurn("RESPONSE_VALIDATING", "verification_not_applicable");
        return;
      }
      if (task && (enteringVerification || continuingVerification)) {
        if (enteringVerification) {
          await mutateAgentState(() => emit({
            eventType: "turn.verifying",
            aggregateType: "turn",
            aggregateId: turnId,
            correlationId: task.id,
            payload: { phase: "VERIFY", proposal_artifact: finalResponseArtifactUri },
            artifactRefs: [finalResponseArtifactUri],
          }, async (tx) => {
            await executeTurnTransition(
              planEnterVerifying({ turnId, taskId: task.id, proposalArtifact: finalResponseArtifactUri }),
              tx,
            );
          }));
          const enteredVerification = await verificationCoordinator.begin(task.id);
          if (!enteredVerification) throw new Error(`task ${task.id} changed before verification`);
        }
        // Real verification DAG + completion gate (M8). Verification commands,
        // source identity, environment identity, and evidence all cross the
        // kernel/artifact boundary; no local always-pass fallback is allowed.
        const verificationClients = requireKernelUds();
        const verificationBaseContext: RequestContext = {
          ...await kernelTaskContext({
            sessionId: turn.thread.sessionId,
            taskId: task.id,
            turnId,
            workspaceId: workspace.id,
            operationClasses: [
              CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
              CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
            ],
            workspacePaths: leastWorkspaceScope([
              ...contract.allowedScope.readPaths,
              ...contract.allowedScope.writePaths,
            ]),
          }),
          sessionId: turn.thread.sessionId,
          taskId: task.id,
          turnId,
          workspaceId: workspace.id,
        };
        const verificationArtifactWriter = {
          write: async (input: {
            readonly bytes: Uint8Array;
            readonly mediaType: string;
            readonly metadata: Readonly<Record<string, unknown>>;
          }) => {
            const artifact = await artifactClient.ingest(input.bytes, {
              mediaType: input.mediaType,
              custom: input.metadata,
            });
            return artifactClient.toArtifactRef(artifact);
          },
        };
        const runtime = createVerificationRuntime(
          createKernelPredicateRunner(
            verificationClients,
            verificationBaseContext,
            workspace.id,
            // H3: derive each predicate's command from what this repository
            // actually ships instead of assuming `just <recipe>`.
            () => latestRepositorySignals.value?.verificationRunners ?? {},
            await workspaceCanonicalRoot(workspace.id),
          ),
          verificationArtifactWriter,
        );
        const contractRows = await db.acceptanceCriterion.findMany({
          where: {
            taskId: task.id,
            contractVersion: task.activeContractVersion,
          },
        });
        const criteria: AcceptanceCriterion[] = contractRows.map((c) => ({
          id: c.criterionId,
          statement: c.statement,
          verificationHint: c.verificationHint,
          required: c.required,
        }));
        const sourceRevision = await resolveWorkspaceRevision(
          verificationClients,
          verificationBaseContext,
          workspace.id,
          abortController.signal,
        );
        const environmentDigest = await resolveKernelEnvironmentDigest(
          verificationClients,
          abortController.signal,
        );
        const previousVerificationPlan = await db.verificationPlan.findFirst({
          where: { taskId: task.id },
          orderBy: { createdAt: "desc" },
          select: { sourceRevision: true },
        });
        const workspaceChangedSinceLastAttempt = previousVerificationPlan === null
          || previousVerificationPlan.sourceRevision !== sourceRevision;
        const existingVerificationPlan = continuingVerification
          ? await db.verificationPlan.findFirst({
              where: { taskId: task.id },
              orderBy: { createdAt: "desc" },
              include: { nodes: true, edges: true },
            })
          : null;
        let plan: VerificationPlan;
        let resumedResults: NonNullable<ReturnType<typeof verificationResultFromPrisma>>[] = [];
        // A plan whose binding no longer holds is re-derived, not fatal.
        // Binding it to the kernel instance id meant any kernel restart
        // during VERIFYING poisoned the task permanently: every later attempt
        // threw "stale source or environment binding" and the task could
        // never complete. A stale binding says the plan describes a world
        // that no longer exists — so we plan against the world that does.
        const staleBindingReason = existingVerificationPlan === null
          ? null
          : existingVerificationPlan.environmentDigest === null
            ? "missing_environment_digest"
            : existingVerificationPlan.environmentDigest !== environmentDigest
              ? "environment_changed"
              : existingVerificationPlan.sourceRevision !== sourceRevision
                ? "source_revision_changed"
                : null;
        const restoredPlan = existingVerificationPlan === null || staleBindingReason !== null
          ? null
          : verificationPlanFromPrisma(existingVerificationPlan);
        const resumablePlan = restoredPlan !== null
          && restoredPlan.taskContractId === task.id
          && restoredPlan.taskContractVersion === task.activeContractVersion
          ? restoredPlan
          : null;
        if (existingVerificationPlan !== null && resumablePlan === null) {
          await mutateAgentState(() => emit({
            eventType: "verification.plan_replanned",
            aggregateType: "turn",
            aggregateId: turnId,
            correlationId: task.id,
            payload: {
              previous_plan_id: existingVerificationPlan.id,
              reason: staleBindingReason ?? "plan_no_longer_matches_contract",
              source_revision: sourceRevision,
              environment_digest: environmentDigest,
            },
          }));
        }
        if (resumablePlan !== null) {
          const persistedResults = await db.verificationResult.findMany({
            where: { planId: resumablePlan.id },
            orderBy: [{ nodeId: "asc" }, { attempt: "asc" }],
          });
          const latestRowByNode = new Map<string, (typeof persistedResults)[number]>();
          for (const row of persistedResults) latestRowByNode.set(row.nodeId, row);
          const latestByNode = new Map<string, NonNullable<ReturnType<typeof verificationResultFromPrisma>>>();
          for (const row of latestRowByNode.values()) {
            const result = verificationResultFromPrisma(row);
            if (result !== null) latestByNode.set(result.nodeId, result);
          }
          resumedResults = [...latestByNode.values()];
          await runtime.lifecycle.restorePlan({
            plan: resumablePlan,
            criteria,
            results: resumedResults,
          });
          plan = resumablePlan;
        } else {
          const nodes = defaultCriteriaNodes(criteria, {
            objective: contract.objective,
            riskClass: contract.riskClass,
            mode: "admission",
            // The contract's own wall-clock budget, so a long suite gets the
            // time the task was granted instead of a fixed 30 s.
            timeoutSeconds: contract.budget.wallClockSeconds,
            signals: {
              changedFiles: latestChangedFiles,
              // `projectFiles` means observed repository configuration and
              // instruction sources. Contract scope is authority, not
              // evidence that every readable/writable path changed: folding
              // it into the verification signals made a read-only `.ts`
              // verifier invent required parse/format/diagnostic checks.
              projectFiles: latestRepositorySignals.value?.observedConfigPaths ?? [],
              instructionHashes: latestInstructionHashes,
              failingTests: latestFailureSelectors,
              diagnostics: latestDiagnostics,
              nativeTestCommands: latestRepositorySignals.value?.nativeTestCommands ?? [],
              nativeRecipeSources: latestRepositorySignals.value?.nativeRecipeSources ?? [],
              nativeRecipeSourceVersions: latestRepositorySignals.value?.nativeRecipeSourceVersions ?? [],
              repositoryMap: latestRepositorySignals.value?.verificationRepositoryMap,
              generatedPaths: latestChangedFiles.filter((path) => /generated/i.test(path)),
              uiComputerUseAvailable: false,
            },
            runnerCatalog: latestRepositorySignals.value?.verificationRunners ?? {},
          });
          const completionExpression = nodes
            .filter((node) => node.required)
            .map((node) => node.id)
            .join(" && ");
          const createdPlan = await runtime.lifecycle.createPlan({
            taskContractId: task.id as never,
            taskContractVersion: task.activeContractVersion,
            sourceRevision,
            criteria,
            nodes,
            completionExpression,
          });
          const planArtifact = await ingestJsonArtifact(
            artifactClient,
            {
              plan: createdPlan,
              criteria,
              environmentDigest,
            },
            "verification-plan",
            { taskId: task.id, workspaceId: workspace.id },
          );
          await mutateAgentState(() => db.$transaction(async (tx) => {
            await assertControlWriterLease(tx);
            await persistPlanToPrisma(tx, {
              id: createdPlan.id,
              taskId: task.id,
              contractVersion: createdPlan.taskContractVersion,
              sourceRevision: createdPlan.sourceRevision,
              environmentDigest,
              completionExpression: createdPlan.completionExpression,
              planArtifact: planArtifact.uri,
              nodes: createdPlan.nodes.map((n) => ({
                id: n.id,
                kind: n.kind,
                required: n.required,
                specification: n.specification,
                timeout: n.timeout,
                retryPolicy: n.retryPolicy,
                acceptanceCriterionId: n.acceptanceCriterionId,
                dependsOn: n.dependsOn,
              })),
              edges: createdPlan.edges,
            });
          }));
          plan = createdPlan;
        }

        const evaluation = await runtime.lifecycle.evaluate(
          plan.id,
          sourceRevision,
          environmentDigest,
          abortController.signal,
          { resumeResults: resumedResults },
        );
        const attempts = await runtime.store.listAttempts(plan.id);
        const evidenceGraph = await runtime.store.getEvidenceGraph(plan.id);
        const allPassed =
          evaluation.allRequiredPassed && evaluation.completionExpressionSatisfied;
        // H3: distinguish "the repository's checks failed" from "this
        // repository has no check to run". The second is not a verification
        // failure and must not burn repair attempts.
        const resultByNodeId = new Map(evaluation.results.map((result) => [result.nodeId, result]));
        const requiredSummary = summarizeRequiredVerification(plan.nodes, evaluation.results);
        const skippedRequiredNodes = requiredSummary.skippedRequiredNodeIds;
        const noRunnableChecks = !allPassed
          && requiredSummary.noRunnableChecks;
        const resumedNodeIds = new Set(resumedResults.map((result) => result.nodeId));
        const newlyEvaluatedResults = evaluation.results.filter((result) => !resumedNodeIds.has(result.nodeId));
        const existingPlanCompletedEvent = await db.semanticEvent.findFirst({
          where: {
            eventType: "verification.plan_completed",
            aggregateType: "verification_plan",
            aggregateId: plan.id,
          },
          select: { eventId: true },
        });
        await mutateAgentState(async () => {
          await db.$transaction(async (tx) => {
            await assertControlWriterLease(tx);
            await persistResultsToPrisma(tx, evaluation.results, attempts);
            if (evidenceGraph !== null) {
              await persistClaimEvidenceGraphToPrisma(tx, evidenceGraph);
            }
          });
          // The acceptance criterion each node was planned for. Without it a
          // reader knows a node failed but not which criterion is therefore
          // unmet, and has to re-derive the mapping from the plan artifact.
          // Null when the node is infrastructure the plan bound to no
          // criterion — stated, not omitted.
          const criterionByNodeId = new Map<string, string | null>(
            plan.nodes.map((node) => [node.id, node.acceptanceCriterionId]),
          );
          for (const r of newlyEvaluatedResults) {
            // A skipped predicate is absence of proof, not a failed check.
            // `verification.plan_completed` below carries the explicit
            // no-runnable outcome; do not publish a success- or
            // failure-shaped node event for work the verifier never ran.
            if (r.status === "skipped") continue;
            await emit({
              eventType: r.status === "pass" ? "verification.node_passed" : "verification.node_failed",
              aggregateType: "verification_result",
              aggregateId: r.id,
              correlationId: task.id,
              payload: {
                node_id: r.nodeId,
                criterion_id: criterionByNodeId.get(r.nodeId) ?? null,
                status: r.status,
              },
            });
          }
          if (existingPlanCompletedEvent === null) {
            await emit({
              eventType: "verification.plan_completed",
              aggregateType: "verification_plan",
              aggregateId: plan.id,
              correlationId: task.id,
              payload: {
                status: allPassed
                  ? "all_passed"
                  : noRunnableChecks
                    ? "no_runnable_checks"
                    : "failed",
              },
            });
          }
        });

        if (noRunnableChecks) {
          // Nothing in this repository implements the required predicates.
          // Record why, settle the turn on the model's final message, and
          // return the task to review — a skipped check is not proof, so the
          // completion gate is deliberately not entered.
          const skipReasons = skippedRequiredNodes.map((nodeId) => ({
            node_id: nodeId,
            reason: resultByNodeId.get(nodeId)?.reasonIfSkipped ?? "no test runner detected",
          }));
          const detectedRunners = Object.keys(latestRepositorySignals.value?.verificationRunners ?? {});
          // The UI showed a task sitting in ACTIVE with no explanation. Say
          // it in one sentence a person can act on: what could not run, and
          // what would make it runnable.
          const notRunnableDetail = detectedRunners.length === 0
            ? `Verification could not run: this repository exposes no test, lint or typecheck runner Terminus recognises, so ${skipReasons.length} required check${skipReasons.length === 1 ? "" : "s"} (${skipReasons.map((entry) => entry.node_id).join(", ")}) were skipped. The work is done but unproven — add a runnable check (a test script, justfile recipe or package script), or review the change yourself.`
            : `Verification could not run: ${skipReasons.length} required check${skipReasons.length === 1 ? "" : "s"} (${skipReasons.map((entry) => entry.node_id).join(", ")}) have no matching runner here (detected: ${detectedRunners.join(", ")}). The work is done but unproven — add a matching check, or review the change yourself.`;
          const skipEvidence = await ingestJsonArtifact(
            artifactClient,
            {
              taskId: task.id,
              planId: plan.id,
              sourceRevision,
              environmentDigest,
              outcome: "no_runnable_checks",
              detail: notRunnableDetail,
              skipped_nodes: skipReasons,
              detected_runners: latestRepositorySignals.value?.verificationRunners ?? {},
            },
            "verification-no-runnable-checks",
            { taskId: task.id, workspaceId: workspace.id },
          );
          await mutateAgentState(() => emit({
            eventType: "verification.no_runnable_checks",
            aggregateType: "turn",
            aggregateId: turnId,
            correlationId: task.id,
            payload: { plan_id: plan.id, detail: notRunnableDetail, skipped_nodes: skipReasons },
            artifactRefs: [skipEvidence.uri],
          }));
          await persistEvidenceForCurrentTurn("COMPLETED", {
            finalWorkspaceRevision: sourceRevision,
            proofBundleHash: skipEvidence.hash,
            verificationPlanId: plan.id,
          });
          await verificationCoordinator.settleWithoutRunnableChecks(task.id, turnId, {
            reason: "no_runnable_checks",
            // The task remains steerable (a skipped check is not proof); this
            // sentence and REVIEW phase keep it out of the running state.
            detail: notRunnableDetail,
            detected_runners: detectedRunners,
            skipped_nodes: skipReasons.map((entry) => entry.node_id),
            evidence_artifact: skipEvidence.uri,
          });
          await finalizeTurn("VERIFIED", "verification_unavailable");
          return;
        }

        if (!allPassed) {
          // Rank 3: normalize failures into durable repair inputs and run
          // the bounded repair decision instead of terminating at the first
          // verification failure.
          const failedResults = evaluation.results.filter(
            (result) => result.status === "fail" || result.status === "error",
          );
          const nodeById = new Map(plan.nodes.map((node) => [node.id, node]));
          const normalizedFailures = failedResults.map((result) =>
            normalizeFailure({
              nodeId: result.nodeId,
              predicateType: nodeById.get(result.nodeId)?.kind ?? "command",
              command: result.commandOrQuery,
              exitCode: result.exitCode,
              output: JSON.stringify(result.structuredObservations),
              artifactRefs: result.artifacts
                .map((artifact) => String(artifact?.uri ?? ""))
                .filter((uri) => uri.length > 0),
              sourceRevision: result.sourceRevision,
            }),
          );
          const repairDecision = verificationRepairController.decideAfterFailure({
            failures: normalizedFailures,
            workspaceChangedSinceLastAttempt,
            actorReportedBlocker: false,
            requiresUserAuthority: false,
          });
          if (repairDecision.action === "repair") {
            if (activeEngine === null) {
              throw new Error("verification repair cannot continue without an authoritative budget ledger");
            }
            // Admission computes the continuation's remaining limits from
            // this snapshot. Persist before scheduling so a crash cannot
            // recreate the repair with a fresh budget.
            await persistTurnBudgetLedger(turnId, activeEngine.budget.ledger, turnContextBudgetJson);
            const repairAttemptId = uuid();
            const directive = buildRepairContext({
              failures: normalizedFailures,
              changedFiles: latestChangedFiles,
              hypothesisId: repairDecision.hypothesisId,
              previousAttemptSummary:
                repairDecision.attemptNumber > 1
                  ? `Repair attempt ${repairDecision.attemptNumber - 1} changed the failure set; see verification results for plan ${plan.id}.`
                  : null,
            });
            const directiveArtifact = await ingestJsonArtifact(
              artifactClient,
              { directive, failures: normalizedFailures, attempt: repairDecision.attemptNumber },
              "verification-repair-directive",
              { taskId: task.id, planId: plan.id, workspaceId: workspace.id },
            );
            await verificationCoordinator.scheduleRepair(task.id, {
              repairAttemptId,
              parentTurnId: turnId,
              leaseKey: repairAttemptLeaseKey(repairAttemptId),
              attemptNumber: repairDecision.attemptNumber,
              directiveArtifactUri: directiveArtifact.uri,
              failedNodeIds: normalizedFailures.map((failure) => failure.nodeId),
              failureSignatures: normalizedFailures.map((failure) => failure.signatureHash),
              changedFiles: latestChangedFiles,
              sourceRevision,
              environmentDigest,
              remainingAttempts: repairDecision.maxAttempts - repairDecision.attemptNumber,
              maxAttempts: repairDecision.maxAttempts,
              remainingBudgetJson: canonicalJson({
                max_attempts: repairDecision.maxAttempts,
                attempts_used: repairDecision.attemptNumber,
                remaining_attempts: repairDecision.maxAttempts - repairDecision.attemptNumber,
                failure_signatures: normalizedFailures.map((failure) => failure.signatureHash),
                hypothesis_id: repairDecision.hypothesisId,
                source_revision: sourceRevision,
                environment_digest: environmentDigest,
              }),
            });
            await mutateAgentState(() => emit({
              eventType: "turn.repair_pending",
              aggregateType: "turn",
              aggregateId: turnId,
              correlationId: task.id,
              payload: {
                phase: "REPAIR_PENDING",
                repair_attempt: repairDecision.attemptNumber,
                repair_attempt_id: repairAttemptId,
                hypothesis_id: repairDecision.hypothesisId,
                directive_artifact: directiveArtifact.uri,
              },
              artifactRefs: [directiveArtifact.uri],
            }, async (tx) => {
              await executeTurnTransition(
                planEnterRepairPending({ turnId, taskId: task.id, payload: {
                  phase: "REPAIR_PENDING",
                  repair_attempt: repairDecision.attemptNumber,
                  repair_attempt_id: repairAttemptId,
                  hypothesis_id: repairDecision.hypothesisId,
                  directive_artifact: directiveArtifact.uri,
                } }),
                tx,
              );
            }));
            const repairTurnId = await admitRepairTurn({
              taskId: task.id,
              threadId: turn.threadId,
              repairAttemptId,
              directiveArtifactUri: directiveArtifact.uri,
              directiveArtifactHash: directiveArtifact.hash,
              attemptNumber: repairDecision.attemptNumber,
            });
            await supersedeRepairPendingTurn(turnId, repairTurnId, task.id);
            void runRepairTurnWithLease(repairAttemptId, repairTurnId);
            return;
          }
          await verificationCoordinator.fail(task.id, {
            reason: "required_predicates_failed",
            blocked: evaluation.blocked,
            repair_stop_reason:
              repairDecision.action === "stop" ? repairDecision.reason : undefined,
            failure_signatures: normalizedFailures.map((failure) => failure.signatureHash),
          });
          if (activeEngine !== null) {
            activeEngine.budget.recordEvidence({
              outstandingCriteria: criteria.filter((criterion) => criterion.required).length,
              satisfiedCriteria: Math.max(0, criteria.filter((criterion) => criterion.required).length - normalizedFailures.length),
              verificationFailures: normalizedFailures.length,
              repairAttempts: Math.max(priorRepairs, storedAttemptsUsed),
              evidenceCoverage: criteria.length === 0 ? 0 : Math.max(0, (criteria.length - normalizedFailures.length) / criteria.length),
            });
            await persistTurnBudgetLedger(turnId, activeEngine.budget.ledger, turnContextBudgetJson);
          }
          await persistEvidenceForCurrentTurn("FAILED_VERIFICATION", {
            finalWorkspaceRevision: sourceRevision,
            verificationPlanId: plan.id,
          });
          await failVerificationTurn({
            blocked: evaluation.blocked,
            repair_stop_reason:
              repairDecision.action === "stop" ? repairDecision.reason : undefined,
            failure_signatures: normalizedFailures.map((failure) => failure.signatureHash),
          });
          return;
        }

        const finalCheckpoint = await ingestJsonArtifact(
          artifactClient,
          {
            taskId: task.id,
            planId: plan.id,
            sourceRevision,
            environmentDigest,
            results: evaluation.results,
            claims: evidenceGraph?.claims ?? [],
          },
          "verification-completion",
          { taskId: task.id, workspaceId: workspace.id },
        );
        await persistEvidenceForCurrentTurn("COMPLETED", {
          finalWorkspaceRevision: sourceRevision,
          proofBundleHash: finalCheckpoint.hash,
          admissionState: "PREPARED",
          verificationPlanId: plan.id,
        });
        const completionRecordId = `completion:${task.id}`;
        try {
          const completionRecord = await runtime.lifecycle.complete({
            taskId: task.id as never,
            planId: plan.id,
            criteria,
            findings: [],
            sourceRevision,
            environmentImageDigest: environmentDigest,
            expiresAt: null,
            unresolvedRisks: [],
            acceptedRisks: [],
            externalEffects: [],
            costMicros: 0n as Micros,
            durationSeconds: 0,
            finalCheckpoint: artifactClient.toArtifactRef(finalCheckpoint),
          });

          const candidateBranchId = `completion:${task.id}:${plan.id}`;
          // Persist an admission intent before the authoritative branch merge.
          // PREPARED is durable evidence, not a completion claim; the record
          // becomes COMMITTED only with the task/turn admission transaction.
          const completionData = {
            id: completionRecordId,
            taskId: task.id,
            contractVersion: completionRecord.contractVersion,
            finalRevision: completionRecord.finalRevision,
            status: completionRecord.status,
            criteriaJson: canonicalJson(completionRecord.criteria),
            verificationPlanId: completionRecord.verificationPlanId,
            unresolvedRisksJson: canonicalJson(completionRecord.unresolvedRisks),
            acceptedRisksJson: canonicalJson(completionRecord.acceptedRisks),
            externalEffectsJson: canonicalJson(completionRecord.externalEffects),
            costMicros: completionRecord.costMicros,
            durationSeconds: completionRecord.durationSeconds,
            finalCheckpointJson: canonicalJson(completionRecord.finalCheckpoint),
            generatedAt: new Date(completionRecord.generatedAt),
            admissionState: "PREPARED",
            candidateBranchId,
          };

          if (evidenceGraph === null) {
            throw new Error("completion admission requires a persisted claim/evidence graph");
          }
          const requiredClaimIds = new Set(
            criteria.filter((criterion) => criterion.required).map((criterion) => `claim:${task.id}:${criterion.id}`),
          );
          const claims = evidenceGraph.claims
            .filter(
              (claim): claim is Claim & { readonly status: "SATISFIED" | "WAIVED" } =>
                claim.status === "SATISFIED" || claim.status === "WAIVED",
            )
            .map((claim) => ({
              claimId: claim.id,
              status: claim.status,
              evidence: evidenceGraph.evidence
                .filter((evidence) => evidence.claimId === claim.id)
                .map((evidence) => {
                  if (evidence.artifactRef === null || evidence.sourceRevision === null || evidence.environmentHash === null) {
                    throw new Error(`claim '${claim.id}' has incomplete admission evidence`);
                  }
                  return {
                    evidenceId: evidence.id,
                    artifactUri: evidence.artifactRef.uri,
                    artifactHash: evidence.artifactRef.hash,
                    sourceRevision: evidence.sourceRevision,
                    environmentImageDigest: evidence.environmentHash,
                    verifierResult: "pass" as const,
                  };
                }),
            }))
            .filter((claim) => requiredClaimIds.has(claim.claimId) || claim.status === "SATISFIED");
          const completionRecordDigest = computeContentHash(
            new TextEncoder().encode(canonicalJson(completionRecord)),
          );
          const admission = createPrismaCompletionAdmission(
            db,
            () => resolveWorkspaceRevision(verificationClients, verificationBaseContext, workspace.id, abortController.signal),
          );
          await mutateAgentState(async () => {
            const existing = await db.completionRecord.findUnique({ where: { taskId: task.id } });
            if (existing === null) {
              await db.completionRecord.create({ data: completionData });
              return;
            }
            const immutableFieldsMatch = existing.id === completionData.id
              && existing.contractVersion === completionData.contractVersion
              && existing.finalRevision === completionData.finalRevision
              && existing.status === completionData.status
              && existing.criteriaJson === completionData.criteriaJson
              && existing.verificationPlanId === completionData.verificationPlanId
              && existing.unresolvedRisksJson === completionData.unresolvedRisksJson
              && existing.acceptedRisksJson === completionData.acceptedRisksJson
              && existing.externalEffectsJson === completionData.externalEffectsJson
              && existing.costMicros === completionData.costMicros
              && existing.durationSeconds === completionData.durationSeconds
              && existing.finalCheckpointJson === completionData.finalCheckpointJson
              && existing.generatedAt.getTime() === completionData.generatedAt.getTime()
              && existing.candidateBranchId === completionData.candidateBranchId
              && existing.admissionState === "PREPARED";
            if (!immutableFieldsMatch) {
              throw new Error("completion admission intent already exists with different immutable content");
            }
          });
          await admission.registerCandidateBranch({
            branchId: candidateBranchId,
            taskId: task.id,
            attemptId: turnId,
            actorPrincipal: "agent:verification-runtime",
            worktreePath: workspace.rootUri,
            epoch: 1,
            baseRevision: sourceRevision,
            headRevision: sourceRevision,
            scopeDigest: computeContentHash(task.scopeDigest),
            effectIds: [],
            proof: {
              verificationPlanId: plan.id,
              completionRecordDigest,
              sourceRevision,
              environmentImageDigest: environmentDigest,
              completionExpressionSatisfied: true,
              claims,
            },
            status: "OPEN",
          });
          await admission.admitBranch({
            branchId: candidateBranchId,
            taskId: task.id,
            attemptId: turnId,
            actorPrincipal: "agent:verification-runtime",
            reviewerPrincipal: "principal:verification-reviewer",
            requiredClaimsSatisfied: [...requiredClaimIds],
          });
        } catch (gateErr) {
          await writerTransaction((tx) => tx.evidenceBundle.updateMany({
            where: { taskId: task.id, turnId },
            data: { admissionState: "QUARANTINED" },
          }));
          // Every required predicate passed and the admission gate still
          // refused — an evidence-graph gap, not a broken change. Failing the
          // task here threw away work that was verifiably correct. Name the
          // claim that is missing its evidence and hand it to the same
          // bounded repair controller that handles a failed predicate; only
          // when repair is exhausted does the turn fail.
          const gateMessage = gateErr instanceof Error ? gateErr.message : String(gateErr);
          const requiredClaimIdsForRepair = criteria
            .filter((criterion) => criterion.required)
            .map((criterion) => `claim:${task.id}:${criterion.id}`);
          const admissibleClaimIds = new Set(
            (evidenceGraph?.claims ?? [])
              .filter((claim) => claim.status === "SATISFIED" || claim.status === "WAIVED")
              .map((claim) => claim.id),
          );
          const missingClaimIds = requiredClaimIdsForRepair.filter((claimId) => !admissibleClaimIds.has(claimId));
          const gateFailures = (missingClaimIds.length > 0 ? missingClaimIds : ["completion-gate"]).map((claimId) =>
            normalizeFailure({
              nodeId: claimId,
              predicateType: "completion_gate",
              command: null,
              exitCode: null,
              output: [
                `The completion gate refused admission: ${gateMessage}`,
                missingClaimIds.length > 0
                  ? `Claim '${claimId}' has no admissible evidence. Every required verification predicate passed, so the change itself is not in question — the evidence that proves criterion '${claimId.split(":").slice(2).join(":")}' is missing or incomplete. Re-run the check that proves it (or state explicitly why it cannot be proven) so the claim carries a passing verifier result.`
                  : "No required claim is missing; the admission transaction itself failed. Re-run verification and retry.",
              ].join("\n"),
              artifactRefs: [],
              sourceRevision,
            }),
          );
          const gateRepairDecision = verificationRepairController.decideAfterFailure({
            failures: gateFailures,
            workspaceChangedSinceLastAttempt,
            actorReportedBlocker: false,
            requiresUserAuthority: false,
          });
          if (gateRepairDecision.action === "repair") {
            if (activeEngine === null) {
              throw new Error("completion-gate repair cannot continue without an authoritative budget ledger");
            }
            await persistTurnBudgetLedger(turnId, activeEngine.budget.ledger, turnContextBudgetJson);
            const repairAttemptId = uuid();
            const directive = buildRepairContext({
              failures: gateFailures,
              changedFiles: latestChangedFiles,
              hypothesisId: gateRepairDecision.hypothesisId,
              previousAttemptSummary: null,
            });
            const directiveArtifact = await ingestJsonArtifact(
              artifactClient,
              {
                directive,
                failures: gateFailures,
                attempt: gateRepairDecision.attemptNumber,
                missing_claim_ids: missingClaimIds,
                gate_error: gateMessage.slice(0, 2_048),
              },
              "verification-repair-directive",
              { taskId: task.id, planId: plan.id, workspaceId: workspace.id },
            );
            await verificationCoordinator.scheduleRepair(task.id, {
              repairAttemptId,
              parentTurnId: turnId,
              leaseKey: repairAttemptLeaseKey(repairAttemptId),
              attemptNumber: gateRepairDecision.attemptNumber,
              directiveArtifactUri: directiveArtifact.uri,
              failedNodeIds: gateFailures.map((failure) => failure.nodeId),
              failureSignatures: gateFailures.map((failure) => failure.signatureHash),
              changedFiles: latestChangedFiles,
              sourceRevision,
              environmentDigest,
              remainingAttempts: gateRepairDecision.maxAttempts - gateRepairDecision.attemptNumber,
              maxAttempts: gateRepairDecision.maxAttempts,
              remainingBudgetJson: canonicalJson({
                max_attempts: gateRepairDecision.maxAttempts,
                attempts_used: gateRepairDecision.attemptNumber,
                remaining_attempts: gateRepairDecision.maxAttempts - gateRepairDecision.attemptNumber,
                failure_signatures: gateFailures.map((failure) => failure.signatureHash),
                hypothesis_id: gateRepairDecision.hypothesisId,
                source_revision: sourceRevision,
                environment_digest: environmentDigest,
                reason: "completion_gate_denied",
                missing_claim_ids: missingClaimIds,
              }),
            });
            await mutateAgentState(() => emit({
              eventType: "turn.repair_pending",
              aggregateType: "turn",
              aggregateId: turnId,
              correlationId: task.id,
              payload: {
                phase: "REPAIR_PENDING",
                reason: "completion_gate_denied",
                missing_claim_ids: missingClaimIds,
                repair_attempt: gateRepairDecision.attemptNumber,
                repair_attempt_id: repairAttemptId,
                hypothesis_id: gateRepairDecision.hypothesisId,
                directive_artifact: directiveArtifact.uri,
              },
              artifactRefs: [directiveArtifact.uri],
            }, async (tx) => {
              await executeTurnTransition(
                planEnterRepairPending({ turnId, taskId: task.id, payload: {
                  phase: "REPAIR_PENDING",
                  reason: "completion_gate_denied",
                  missing_claim_ids: missingClaimIds,
                  repair_attempt: gateRepairDecision.attemptNumber,
                  repair_attempt_id: repairAttemptId,
                  hypothesis_id: gateRepairDecision.hypothesisId,
                  directive_artifact: directiveArtifact.uri,
                } }),
                tx,
              );
            }));
            const repairTurnId = await admitRepairTurn({
              taskId: task.id,
              threadId: turn.threadId,
              repairAttemptId,
              directiveArtifactUri: directiveArtifact.uri,
              directiveArtifactHash: directiveArtifact.hash,
              attemptNumber: gateRepairDecision.attemptNumber,
            });
            await supersedeRepairPendingTurn(turnId, repairTurnId, task.id);
            void runRepairTurnWithLease(repairAttemptId, repairTurnId);
            return;
          }
          await verificationCoordinator.fail(task.id, {
            reason: "completion_gate_denied",
            error: gateMessage,
            missing_claim_ids: missingClaimIds,
            repair_stop_reason: gateRepairDecision.reason,
          });
          await failVerificationTurn({
            reason: "completion_gate_denied",
            missing_claim_ids: missingClaimIds,
            repair_stop_reason: gateRepairDecision.reason,
          });
          return;
        }

        await verificationCoordinator.complete(task.id, plan.id, turnId, completionRecordId);
        await writerTransaction((tx) => tx.evidenceBundle.updateMany({
          where: { taskId: task.id, turnId },
          data: { admissionState: "COMMITTED" },
        }));
        await mutateAgentState(() => emit({
          eventType: "verification.admitted",
          aggregateType: "turn",
          aggregateId: turnId,
          correlationId: task.id,
          payload: { plan_id: plan.id, phase: "VERIFIED" },
        }));
        await finalizeTurn("VERIFIED", "verification_admitted");
      } else {
        throw new Error(
          `task ${turn.taskId} no longer accepts completion proposal${task === null ? " because it was deleted" : ` in status ${task.status}`}`,
        );
      }
    } else {
      // Taskless turns have no acceptance DAG; they still publish a proposal
      // first, then use the ordinary terminal turn transition.
      await finalizeTurn("RESPONSE_VALIDATING", "taskless_turn");
    }
  } catch (err) {
    console.error("agentLoop error", err);
    const classified = classifyLoopError(err);
    const engineStop = err instanceof EngineTerminalStopError ? err.stop : null;
    const stopEnvelope = engineStop !== null && "error" in engineStop
      ? engineStop.error
      : null;
    const providerUnavailable = err instanceof ProviderExecutionUnavailableError;
    const ambiguousToolSettlement = err instanceof AmbiguousToolSettlementError;
    const policyDenied = err instanceof ToolPolicyDeniedError;
    const budgetExhausted = err instanceof ToolCycleBudgetExhaustedError;
    const stopKind = engineStop?.kind ?? null;
    // Lifecycle decision: classify the stop into the terminal vocabulary.
    // The task-side consequence rides on the same classification via
    // turnFailureDisposition, so the turn/task vocabularies cannot drift.
    const settlement = planTerminalTurnSettlement({
      turnId,
      classification: classifyTerminalTurn({
        stopKind,
        stopEnvelope,
        providerUnavailable,
        policyDenied,
        budgetExhausted,
        ambiguousToolSettlement,
      }),
      stopEnvelope,
      classifiedEnvelope: classified.envelope,
    });
    const terminalTurnState = settlement.classification.state;
    const terminalTurnEvent = settlement.classification.eventType;
    const failureCode = settlement.classification.code;
    const failureMessage = stopEnvelope?.message ?? classified.envelope.message;
    const failureDetails = stopEnvelope?.details ?? classified.envelope.details;
    const failureReason = settlement.classification.reason;
    // H8: only a user cancellation or a hard budget/policy stop ends the task.
    const disposition = turnFailureDisposition(terminalTurnState);
    const taskStatusForStop = disposition.taskStatus;
    const terminalEvidenceOutcome: EvidenceTerminalOutcome | null = settlement.classification.evidenceOutcome;
    const blockedError = taskStatusForStop === "BLOCKED" || taskStatusForStop === "NEEDS_USER_DECISION";
    if (activeEngine !== null) {
      try {
        await persistTurnBudgetLedger(turnId, activeEngine.budget.ledger, turnContextBudgetJson);
      } catch (ledgerError) {
        // The ledger is evidence, not liveness: a fault here must not prevent
        // the terminal settlement below from converging the turn.
        console.error("agentLoop budget ledger persist fault", ledgerError);
      }
    }
    const immutableTurnStates = [
      "COMPLETED",
      "INTERRUPTED",
      "FAILED",
      "BUDGET_EXHAUSTED",
      "POLICY_DENIED",
      "BLOCKED",
      "USER_ACTION_REQUIRED",
      "REPAIR_PENDING",
      "VERIFIED",
      "ABORTED",
    ] as const;
    const failureErrorJson = settlement.providerAttemptsErrorJson;
    const turnTerminalErrorJson = settlement.turnTerminalErrorJson;
    const turnFailurePayload = settlement.eventPayload;
    const failProviderAttempts = async (tx: Prisma.TransactionClient): Promise<void> => {
      await tx.providerAttempt.updateMany({
        where: { turnId, status: "running" },
        data: { status: "failed", completedAt: new Date(), errorJson: failureErrorJson },
      });
    };
    const settleTurnRow = async (tx: Prisma.TransactionClient): Promise<void> => {
      const update = await tx.turn.updateMany({
        where: { id: turnId, state: { notIn: [...immutableTurnStates] } },
        data: {
          state: terminalTurnState,
          completedAt: new Date(),
          terminalErrorJson: turnTerminalErrorJson,
        },
      });
      if (update.count !== 1) throw new Error(`turn ${turnId} changed during failure settlement`);
    };
    try {
      await mutateAgentState(async () => {
      const currentTurn = await db.turn.findUnique({
        where: { id: turnId },
        select: { state: true },
      });
      const mayFailTurn = currentTurn !== null
        && !immutableTurnStates.includes(currentTurn.state as (typeof immutableTurnStates)[number]);
      const failedTaskId = turn.taskId;
      const failedTask = failedTaskId === null
        ? null
        : await db.task.findUnique({ where: { id: failedTaskId }, select: { status: true } });
      const taskIsSettleable = failedTask !== null
        && (failedTask.status === "ACTIVE" || failedTask.status === "VERIFYING");

      // H8: a failed turn is not a failed task. Only a user cancellation or a
      // hard budget/policy stop ends the task; every other failure leaves it
      // ACTIVE with no live turn so the user can steer, retry, or redirect.
      // `taskStatusForStop` is non-null exactly for those hard stops.
      const taskTerminalStatus = taskStatusForStop;
      const taskStaysActive = taskTerminalStatus === null;
      const taskNeedsWrite = taskIsSettleable
        && (!taskStaysActive || failedTask.status === "VERIFYING");
      const taskEventType = disposition.taskEventType;
      const evidenceOutcome = terminalEvidenceOutcome
        ?? (failedTask?.status === "VERIFYING" && !taskStaysActive ? "FAILED_VERIFICATION" : null);
      const taskFailurePayload = {
        status: taskTerminalStatus ?? "ACTIVE",
        active_turn: null,
        code: failureCode,
        message: failureMessage,
        reason: failureReason,
        details: failureDetails,
      };
      const writeTaskRow = async (tx: Prisma.TransactionClient): Promise<void> => {
        if (failedTaskId === null || failedTask === null) return;
        const update = await tx.task.updateMany({
          where: { id: failedTaskId, status: failedTask.status },
          data: taskRowDataForTerminalStop({
            taskStaysActive,
            taskTerminalStatus,
            failedTaskStatus: failedTask.status,
            blockedError,
            failure: { reason: failureReason, code: failureCode, message: failureMessage, details: failureDetails },
          }),
        });
        if (update.count !== 1) throw new Error(`task ${failedTaskId} changed during failure settlement`);
      };

      // C10: the turn-terminal and task-terminal writes settle in one
      // transaction so a crash can never leave a live task pointing at a
      // dead turn (or the reverse).
      if (mayFailTurn && taskNeedsWrite && failedTaskId !== null) {
        await emitAtomicBatch([
          {
            eventType: terminalTurnEvent,
            aggregateType: "turn",
            aggregateId: turnId,
            correlationId: failedTaskId,
            payload: turnFailurePayload,
          },
          {
            eventType: taskEventType,
            aggregateType: "task",
            aggregateId: failedTaskId,
            correlationId: failedTaskId,
            payload: taskFailurePayload,
          },
        ], async (tx) => {
          await failProviderAttempts(tx);
          await settleTurnRow(tx);
          await writeTaskRow(tx);
        });
      } else if (mayFailTurn) {
        await emit({
          eventType: terminalTurnEvent,
          aggregateType: "turn",
          aggregateId: turnId,
          correlationId: turn.taskId ?? undefined,
          payload: turnFailurePayload,
        }, async (tx) => {
          await failProviderAttempts(tx);
          await settleTurnRow(tx);
        });
      } else {
        await writerTransaction(failProviderAttempts);
        if (taskNeedsWrite && failedTaskId !== null) {
          await emit({
            eventType: taskEventType,
            aggregateType: "task",
            aggregateId: failedTaskId,
            correlationId: failedTaskId,
            payload: taskFailurePayload,
          }, writeTaskRow);
        }
      }

      if (failedTaskId === null || !taskIsSettleable) return;
      // The task row is unchanged when it simply stays ACTIVE; the turn's own
      // terminal event is the durable record. Still publish the observation so
      // subscribers learn the active turn is gone.
      if (taskStaysActive && !taskNeedsWrite) {
        await emit({
          eventType: taskEventType,
          aggregateType: "task",
          aggregateId: failedTaskId,
          correlationId: failedTaskId,
          payload: taskFailurePayload,
        });
      }
      if (evidenceOutcome !== null) {
        try {
          await persistEvidenceForCurrentTurn(evidenceOutcome);
        } catch (evidenceError) {
          // Evidence is durable-adjacent, not liveness: the terminal event
          // above is the authoritative settlement. Surface the fault; never
          // rethrow it out of the settlement path.
          console.error("agentLoop evidence persist fault", evidenceError);
        }
      }
      if (failedTaskId !== null) {
        try {
          await synchronizeV1TaskProjection(failedTaskId, taskEventType);
        } catch (projectionError) {
          // The projection reconciles later; the turn is already settled.
          console.error("agentLoop task projection fault", projectionError);
        }
      }
    });
  } catch (settlementError: unknown) {
    // Reference-loop convergence rule: a fault inside the failure-settlement
    // block must never escape agentLoop. The only trap around this promise
    // is the admission-site `.catch(console.error)`; a rethrow here leaves an
    // active turn stranded in CONTEXT_COMPILING (or its pre-failure phase)
    // with no durable record and no re-driver until process restart.
    //
    // A fenced writer lease means this process is being terminated anyway —
    // restart recovery owns the turn. Anything else leaves a durable
    // recovery marker event so recovery (or a later settlement attempt)
    // converges the turn without operator intervention.
    if (settlementFaultIsTerminalProcessFault(settlementError)) throw settlementError;
    const currentTurn = await db.turn.findUnique({
      where: { id: turnId },
      select: { state: true },
    }).catch(() => null);
    if (currentTurn === null || !ACTIVE_TURN_STATES.includes(currentTurn.state as never)) {
      console.error("agentLoop failure settlement fault after terminal settlement", settlementError);
      return;
    }
    const previousState = currentTurn.state;
    const plan = planRecoveryAfterSettlementFault({
      previousState,
      code: failureCode,
      details: settlementError instanceof Error ? settlementError.message : String(settlementError),
    });
    console.error(
      `agentLoop failure settlement fault; recorded durable recovery for turn ${turnId} in ${previousState}`,
      settlementError,
    );
    await emit({
      eventType: "turn.recovery_requested",
      aggregateType: "turn",
      aggregateId: turnId,
      correlationId: turn.taskId ?? undefined,
      payload: { ...plan.marker },
    }, async (tx) => {
      // Idempotent marker write: the turn stays in its current non-terminal
      // state with an explicit recovery reason. Restart recovery and the
      // admission path both key off this record instead of the old silent
      // stranding.
      const markerJson = JSON.stringify(plan.marker);
      const marked = await tx.turn.updateMany({
        where: { id: turnId, state: previousState, terminalErrorJson: null },
        data: { terminalErrorJson: markerJson },
      });
      const interpretation = interpretRecoveryMarkerWrite(marked.count);
      if (interpretation === "needs_durable_reconciliation") {
        throw new Error(`turn ${turnId} recovery marker raced during failure settlement`);
      }
    });
    }
  } finally {
    if (activeTurnAbortControllers.get(turnId) === abortController) {
      activeTurnAbortControllers.delete(turnId);
    }
  }
}

interface JobRecoverySummary {
  readonly scanned: number;
  readonly lost: number;
  readonly live: number;
  readonly exited: number;
}

/** Reconcile every durable non-terminal job against the kernel before ready. */
async function reconcileNonterminalJobs(): Promise<JobRecoverySummary> {
  const jobs = await db.job.findMany({
    where: { state: { in: [...V1_NONTERMINAL_JOB_STATES] } },
    orderBy: { id: "asc" },
    select: { id: true, state: true },
  });
  let lost = 0;
  let live = 0;
  let exited = 0;
  for (const job of jobs) {
    let kernelState: string | null = null;
    let reconciliationError: string | null = null;
    try {
      const binding = await kernelBindingForJob(
        job.id,
        [
          CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
          CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
        ],
      );
      if (binding === null) {
        reconciliationError = "job has no settled kernel binding";
      } else {
        const observed = await requireKernelUds().jobs.Get({
          context: binding.context,
          jobId: binding.kernelJobId,
        });
        kernelState = observed.state.toLowerCase();
      }
    } catch (error: unknown) {
      reconciliationError = error instanceof Error ? error.message : String(error);
    }

    const nextState = kernelState === "running"
      ? "RUNNING"
      : kernelState === "queued"
        ? "STARTING"
        : kernelState === "exited"
          ? "EXITED"
          : "LOST";
    if (nextState === "LOST") lost += 1;
    else if (nextState === "EXITED") exited += 1;
    else live += 1;
    const settledAt = nextState === "LOST" || nextState === "EXITED"
      ? new Date()
      : null;
    await emit({
      eventType: "job.reconciled",
      aggregateType: "job",
      aggregateId: job.id,
      payload: {
        previous_state: job.state,
        state: nextState,
        kernel_state: kernelState,
        reconciliation_error: reconciliationError,
      },
    }, async (tx) => {
      const updated = await tx.job.updateMany({
        where: { id: job.id, state: job.state },
        data: {
          state: nextState,
          settledAt,
          ...(nextState === "LOST"
            ? {
                exitJson: JSON.stringify({
                  reason: "kernel_job_not_recoverable",
                  reconciliation_error: reconciliationError,
                }),
              }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw new Error(`job ${job.id} changed during startup reconciliation`);
      }
    });
  }
  return { scanned: jobs.length, lost, live, exited };
}

interface UnsettledEffectRecoveryRecord {
  readonly id: string;
  readonly toolCallId: string;
  readonly turnId: string;
  readonly taskId: string | null;
  readonly previousState: string;
}

interface UnsettledEffectRecoveryResult {
  readonly scanned: number;
  readonly manualReview: readonly UnsettledEffectRecoveryRecord[];
  readonly alreadyResolved: readonly string[];
  readonly failed: readonly { id: string; error: string }[];
}

const AMBIGUOUS_EFFECT_STATES = ["STARTED", "UNKNOWN", "RECONCILING"] as const;

/**
 * Reconcile every effect whose external receipt is not durably known. This
 * path never retries the effect: it records an atomic tool/effect
 * MANUAL_REVIEW transition and a deterministic recovery event. A later
 * settlement wins safely if it committed before this recovery transaction.
 */
async function reconcileUnsettledSideEffects(
  alreadyUnderMutationLock = false,
): Promise<UnsettledEffectRecoveryResult> {
  const effects = await db.sideEffect.findMany({
    where: { state: { in: [...AMBIGUOUS_EFFECT_STATES] } },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      toolCallId: true,
      state: true,
      toolCall: {
        select: {
          turnId: true,
          turn: { select: { taskId: true } },
        },
      },
    },
  });
  const manualReview: UnsettledEffectRecoveryRecord[] = [];
  const alreadyResolved: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const effect of effects) {
    const taskId = effect.toolCall.turn.taskId;
    const correlationId = taskId ?? effect.toolCall.turnId;
    try {
      const input: EffectUnknownInput = {
        taskId: correlationId,
        toolCallId: effect.toolCallId,
        sideEffectId: effect.id,
        error: "process restarted before a trusted kernel receipt was persisted; manual reconciliation is required",
        idempotencyKey: `effect-recovery:${effect.id}`,
      };
      const changed = alreadyUnderMutationLock
        ? await effectSettlementService.markUnknownUnderMutation(input)
        : await effectSettlementService.markUnknown(input);
      if (changed) {
        manualReview.push({
          id: effect.id,
          toolCallId: effect.toolCallId,
          turnId: effect.toolCall.turnId,
          taskId,
          previousState: effect.state,
        });
      } else {
        alreadyResolved.push(effect.id);
      }
    } catch (error: unknown) {
      failed.push({
        id: effect.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { scanned: effects.length, manualReview, alreadyResolved, failed };
}

const RECOVERABLE_TOOL_CALL_STATES = new Set(["SETTLED", "FAILED", "TIMED_OUT", "CANCELLED", "DENIED"]);
const RECOVERABLE_EFFECT_STATES = new Set(["SETTLED", "FAILED"]);

interface CandidateBranchRecoveryRecord {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly epoch: number;
}

interface CandidateBranchRecoveryResult {
  readonly scanned: number;
  readonly manualReview: readonly CandidateBranchRecoveryRecord[];
  readonly alreadyResolved: readonly string[];
  readonly failed: readonly { id: string; error: string }[];
}

class CandidateBranchAlreadyResolvedError extends Error {
  constructor(readonly branchId: string) {
    super(`candidate branch ${branchId} was already resolved before recovery`);
    this.name = "CandidateBranchAlreadyResolvedError";
  }
}

/**
 * Reconcile candidate branches that crossed the external merge boundary
 * without a durable ADMITTED receipt. When a trusted receipt reconciler is
 * available, each ADMITTING branch is resolved from a verified external
 * receipt (the merge is never issued again); otherwise recovery records
 * MANUAL_REVIEW atomically and never issues the merge.
 */
async function reconcileInFlightCandidateBranchAdmissions(
  alreadyUnderMutationLock = false,
  trustedReceiptReconciler?:
    | ((branch: CandidateBranchRecoveryRecord) => Promise<TrustedBranchReceiptDisposition>)
    | undefined,
): Promise<CandidateBranchRecoveryResult & { readonly admitted: readonly string[] }> {
  const branches = await db.candidateBranch.findMany({
    where: { status: "ADMITTING" },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    select: { id: true, taskId: true, attemptId: true, epoch: true },
  });
  const manualReview: CandidateBranchRecoveryRecord[] = [];
  const admitted: string[] = [];
  const alreadyResolved: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const branch of branches) {
    if (trustedReceiptReconciler !== undefined) {
      try {
        const disposition = trustedReceiptReconciler === undefined
          ? null
          : await trustedReceiptReconciler(branch);
        if (disposition === null) throw new Error("trusted receipt reconciler returned no disposition");
        if (disposition.outcome === "ADMITTED") {
          admitted.push(disposition.branchId);
        } else if (disposition.outcome === "MANUAL_REVIEW") {
          manualReview.push(branch);
        } else {
          alreadyResolved.push(disposition.branchId);
        }
      } catch (error: unknown) {
        if (error instanceof TrustedBranchAlreadyResolvedError) {
          alreadyResolved.push(error.branchId);
        } else {
          failed.push({
            id: branch.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      continue;
    }
    const recover = async (): Promise<void> => {
      await emit({
        eventType: "candidate_branch.recovery_manual_review",
        aggregateType: "task",
        aggregateId: branch.taskId,
        correlationId: branch.taskId,
        idempotencyKey: `candidate-branch-recovery:${branch.id}`,
        payload: {
          task_id: branch.taskId,
          branch_id: branch.id,
          previous_status: "ADMITTING",
          reason: "candidate_branch_merge_receipt_unavailable_after_restart",
          admission_operation_id: `completion-admission:${branch.id}`,
        },
      }, async (tx) => {
        const current = await tx.candidateBranch.findUnique({
          where: { id: branch.id },
          select: { status: true, epoch: true, taskId: true },
        });
        if (
          current === null
          || current.status !== "ADMITTING"
          || current.epoch !== branch.epoch
          || current.taskId !== branch.taskId
        ) {
          throw new CandidateBranchAlreadyResolvedError(branch.id);
        }
        const updated = await tx.candidateBranch.updateMany({
          where: { id: branch.id, taskId: branch.taskId, epoch: branch.epoch, status: "ADMITTING" },
          data: { status: "MANUAL_REVIEW", epoch: { increment: 1 } },
        });
        if (updated.count !== 1) throw new CandidateBranchAlreadyResolvedError(branch.id);
        await tx.task.updateMany({
          where: { id: branch.taskId, status: { in: ["ACTIVE", "VERIFYING"] } },
          data: {
            status: "BLOCKED",
            phase: "VERIFY",
            completedAt: null,
            terminalReasonJson: JSON.stringify({
              reason: "candidate_branch_admission_recovery_required",
              branch_id: branch.id,
              attempt_id: branch.attemptId,
              reconciliation_required: true,
            }),
          },
        });
      });
    };
    try {
      if (alreadyUnderMutationLock) await recover();
      else await mutateAgentState(recover);
      manualReview.push(branch);
    } catch (error: unknown) {
      if (error instanceof CandidateBranchAlreadyResolvedError) {
        alreadyResolved.push(error.branchId);
      } else {
        failed.push({
          id: branch.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { scanned: branches.length, manualReview, admitted, alreadyResolved, failed };
}

/**
 * Build the trusted branch receipt reconciler from live kernel clients, or
 * null when the kernel is unavailable. Each call resolves the branch's
 * workspace, mints the recovery EXEC capability context, reads authoritative
 * Git state through the kernel, and commits the validated receipt outcome
 * transactionally. The conservative MANUAL_REVIEW path stays in charge when
 * this returns null so recovery never silently trusts an unverified source.
 */
function buildTrustedBranchReceiptReconciler():
  | ((branch: CandidateBranchRecoveryRecord) => Promise<TrustedBranchReceiptDisposition>)
  | null {
  if (kernelUds === null) return null;
  return async (branch) => {
    const task = await db.task.findUnique({
      where: { id: branch.taskId },
      select: { sessionId: true },
    });
    if (task === null) {
      throw new Error(`task '${branch.taskId}' not found for branch receipt recovery`);
    }
    const session = await db.session.findUnique({
      where: { id: task.sessionId },
      select: { workspaceId: true },
    });
    if (session === null) {
      throw new Error(`session '${task.sessionId}' not found for branch receipt recovery`);
    }
    const context = await kernelTaskContextForWorkspace(
      session.workspaceId,
      `branch-receipt-recovery:${branch.id}`,
    );
    const receiptQuery = createKernelGitMergeReceiptQuery(
      requireKernelUds(),
      context,
      session.workspaceId,
    );
    return reconcileAdmittingBranchWithTrustedReceipt(
      db,
      branch.id,
      receiptQuery,
      (event, mutation) => emit(event, async (tx) => {
        await mutation(tx);
      }),
    );
  };
}

/**
 * A context boundary is safe to resume when no provider request or effect is
 * ambiguous. A tool-settlement boundary is also resumable once every tool
 * and effect has a terminal receipt; the next engine step then recompiles
 * context and cannot duplicate the settled operations.
 */
async function canResumeTurnAtBoundary(turnId: string, state: string): Promise<boolean> {
  const [attempts, toolCalls, effects] = await Promise.all([
    db.providerAttempt.findMany({ where: { turnId }, select: { status: true } }),
    db.toolCall.findMany({ where: { turnId }, select: { state: true } }),
    db.sideEffect.findMany({ where: { toolCall: { turnId } }, select: { state: true } }),
  ]);
  const providerSafe = attempts.every((attempt) => !(IN_FLIGHT_PROVIDER_STATES as readonly string[]).includes(attempt.status.toLowerCase()));
  const effectsSafe = toolCalls.every((call) => RECOVERABLE_TOOL_CALL_STATES.has(call.state))
    && effects.every((effect) => RECOVERABLE_EFFECT_STATES.has(effect.state));
  if (!providerSafe || !effectsSafe) return false;
  if (state === "PENDING" || state === "REPAIRING") {
    return attempts.length === 0 && toolCalls.length === 0 && effects.length === 0;
  }
  if (state === "RESPONSE_VALIDATING" || state === "VERIFYING") {
    // The provider response and all effect receipts are already durable at
    // this boundary. The recovery-aware agent loop reuses the response and
    // persisted verification plan; it never replays the provider request.
    return true;
  }
  return state === "CONTEXT_COMPILING"
    || (state === "TOOL_SETTLEMENT" && toolCalls.length > 0);
}

type RecoveredKernelDenial = Extract<ToolDenialMetadata, { origin: "kernel" }>;

/** Read the versioned denial envelope persisted at the tool-call boundary. */
async function recoveredKernelDenialForTurn(turnId: string): Promise<RecoveredKernelDenial | null> {
  const calls = await db.toolCall.findMany({
    where: { turnId, state: "DENIED" },
    orderBy: { settledAt: "desc" },
    select: { errorJson: true },
  });
  for (const call of calls) {
    const envelope = call.errorJson === null
      ? null
      : safeParse<Record<string, unknown> | null>(call.errorJson, null);
    const denial = envelope?.denial;
    if (denial === null || denial === undefined || typeof denial !== "object") continue;
    const candidate = denial as Record<string, unknown>;
    if (
      candidate.schemaVersion !== TOOL_DENIAL_SCHEMA_VERSION
      || candidate.origin !== "kernel"
      || candidate.disposition !== "terminal"
      || typeof candidate.decision !== "string"
      || (candidate.decisionId !== null && typeof candidate.decisionId !== "string")
      || typeof candidate.explanation !== "string"
    ) continue;
    return {
      schemaVersion: TOOL_DENIAL_SCHEMA_VERSION,
      origin: "kernel",
      disposition: "terminal",
      decision: candidate.decision,
      decisionId: candidate.decisionId as string | null,
      explanation: candidate.explanation,
    };
  }
  return null;
}

/** Idempotently settle a turn after a crash following a durable kernel denial. */
async function settleRecoveredKernelPolicyDenial(input: {
  readonly id: string;
  readonly taskId: string | null;
  readonly state: string;
  readonly denial: RecoveredKernelDenial;
}): Promise<void> {
  const terminalError = {
    code: "KERNEL_POLICY_DENIED",
    category: "policy_denied",
    message: input.denial.explanation,
    reason: "policy_denied",
    details: {
      schema_version: input.denial.schemaVersion,
      origin: input.denial.origin,
      disposition: input.denial.disposition,
      decision: input.denial.decision,
      decision_id: input.denial.decisionId,
      explanation: input.denial.explanation,
    },
  };
  await mutateAgentState(async () => {
    const current = await db.turn.findUnique({ where: { id: input.id }, select: { state: true } });
    if (current === null || ["COMPLETED", "INTERRUPTED", "FAILED", "BUDGET_EXHAUSTED", "POLICY_DENIED", "BLOCKED", "USER_ACTION_REQUIRED", "ABORTED"].includes(current.state)) {
      return;
    }
    const settledAt = new Date();
    await emit({
      eventType: "turn.policy_denied",
      aggregateType: "turn",
      aggregateId: input.id,
      correlationId: input.taskId ?? undefined,
      idempotencyKey: `turn-policy-denied-recovery:${input.id}`,
      payload: terminalError,
    }, async (tx) => {
      await tx.providerAttempt.updateMany({
        where: { turnId: input.id, status: "running" },
        data: { status: "failed", completedAt: settledAt, errorJson: JSON.stringify(terminalError) },
      });
      const turn = await tx.turn.updateMany({
        where: { id: input.id, state: input.state },
        data: {
          state: "POLICY_DENIED",
          completedAt: settledAt,
          terminalErrorJson: JSON.stringify(terminalError),
        },
      });
      if (turn.count !== 1) throw new Error(`turn ${input.id} changed during policy-denial recovery`);
      if (input.taskId !== null) {
        await tx.task.updateMany({
          where: { id: input.taskId, status: { in: ["ACTIVE", "VERIFYING"] } },
          data: {
            status: "POLICY_DENIED",
            phase: "VERIFY",
            completedAt: settledAt,
            terminalReasonJson: JSON.stringify(terminalError),
          },
        });
      }
    });
    if (input.taskId !== null) {
      await emit({
        eventType: "task.turn_policy_denied",
        aggregateType: "task",
        aggregateId: input.taskId,
        correlationId: input.taskId,
        idempotencyKey: `task-policy-denied-recovery:${input.id}`,
        payload: { status: "POLICY_DENIED", active_turn: null, ...terminalError },
      });
      await synchronizeV1TaskProjection(input.taskId, "task.turn_policy_denied");
    }
  });
}

/** Finish a verified turn after a crash between admission and publication. */
async function recoverVerifiedOrFinalizingTurn(input: {
  readonly id: string;
  readonly taskId: string | null;
  readonly state: string;
}): Promise<boolean> {
  if (input.taskId === null) return false;
  const task = await db.task.findUnique({
    where: { id: input.taskId },
    select: { status: true },
  });
  const completion = await db.completionRecord.findUnique({
    where: { taskId: input.taskId },
    select: { status: true, admissionState: true },
  });
  if (
    task?.status !== "COMPLETED"
    || completion?.status !== "completed"
    || completion.admissionState !== "COMMITTED"
  ) return false;

  const proposal = await db.semanticEvent.findFirst({
    where: { eventType: "completion.proposed", aggregateType: "turn", aggregateId: input.id },
    orderBy: { occurredAt: "desc" },
    select: { payloadJson: true, artifactRefsJson: true },
  });
  const proposalPayload = proposal === null
    ? null
    : safeParse<Record<string, unknown>>(proposal.payloadJson, {});
  const proposalRefs = proposal === null ? [] : safeParse<string[]>(proposal.artifactRefsJson, []);
  const responseArtifact = typeof proposalPayload?.response_artifact === "string"
    ? proposalPayload.response_artifact
    : proposalRefs[0] ?? null;
  if (responseArtifact === null) return false;

  if (input.state === "FINALIZING") {
    const preparedCheckpoint = await findPreparedCheckpointForTurn(input.taskId, input.id);
    if (preparedCheckpoint !== null) {
      await commitCheckpointAndTerminalTurn({
        ...preparedCheckpoint,
        turnId: input.id,
        responseArtifactUri: responseArtifact,
        summary: "",
        summaryTruncated: true,
        continuation: responseArtifact,
        recovered: true,
      });
      return true;
    }
  }

  if (input.state === "VERIFIED") {
    await emit({
      eventType: "turn.finalizing",
      aggregateType: "turn",
      aggregateId: input.id,
      correlationId: input.taskId,
      payload: { phase: "finalizing", recovered: true },
    }, async (tx) => {
      const updated = await tx.turn.updateMany({
        where: { id: input.id, state: "VERIFIED" },
        data: { state: "FINALIZING" },
      });
      if (updated.count !== 1) throw new Error(`turn ${input.id} changed during verified recovery`);
    });
  }

  await emit({
    eventType: "turn.completed",
    aggregateType: "turn",
    aggregateId: input.id,
    correlationId: input.taskId,
    payload: {
      state: "COMPLETED",
      summary: "",
      summary_truncated: true,
      continuation: responseArtifact,
      recovered: true,
    },
    artifactRefs: [responseArtifact],
  }, async (tx) => {
    const updated = await tx.turn.updateMany({
      where: { id: input.id, state: "FINALIZING" },
      data: { state: "COMPLETED", completedAt: new Date() },
    });
    if (updated.count !== 1) throw new Error(`turn ${input.id} changed during terminal recovery`);
  });
  return true;
}

interface CompletionAdmissionRecoveryResult {
  readonly prepared: number;
  readonly recovered: readonly string[];
  readonly quarantined: readonly string[];
  readonly failed: readonly { id: string; error: string }[];
}

async function quarantinePreparedCompletionRecord(id: string): Promise<void> {
  await writerTransaction((tx) => tx.completionRecord.updateMany({
    where: { id, admissionState: "PREPARED" },
    data: { admissionState: "QUARANTINED" },
  }));
}

/**
 * Reconcile a crash after candidate-branch admission but before task/turn
 * completion. The prepared record is the immutable completion intent; an
 * ADMITTED branch is the only safe proof that the external merge gate passed.
 */
async function reconcilePreparedCompletionRecords(): Promise<CompletionAdmissionRecoveryResult> {
  const records = await db.completionRecord.findMany({
    where: { admissionState: "PREPARED" },
    orderBy: [{ generatedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      taskId: true,
      verificationPlanId: true,
      candidateBranchId: true,
    },
  });
  const recovered: string[] = [];
  const quarantined: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const record of records) {
    if (record.candidateBranchId === null) {
      await quarantinePreparedCompletionRecord(record.id);
      quarantined.push(record.id);
      continue;
    }
    const branch = await db.candidateBranch.findUnique({
      where: { id: record.candidateBranchId },
      select: { status: true, taskId: true, attemptId: true },
    });
    if (branch === null || branch.status !== "ADMITTED" || branch.taskId !== record.taskId) {
      await quarantinePreparedCompletionRecord(record.id);
      quarantined.push(record.id);
      continue;
    }
    const [task, turn] = await Promise.all([
      db.task.findUnique({ where: { id: record.taskId }, select: { status: true } }),
      db.turn.findUnique({ where: { id: branch.attemptId }, select: { id: true, taskId: true, state: true } }),
    ]);
    if (task === null || turn === null || turn.taskId !== record.taskId) {
      await quarantinePreparedCompletionRecord(record.id);
      quarantined.push(record.id);
      continue;
    }
    if (
      task.status === "COMPLETED"
      && ["VERIFIED", "FINALIZING", "COMPLETED"].includes(turn.state)
    ) {
      const committed = await writerTransaction((tx) => tx.completionRecord.updateMany({
        where: { id: record.id, admissionState: "PREPARED" },
        data: { admissionState: "COMMITTED" },
      }));
      if (committed.count === 1) recovered.push(record.id);
      continue;
    }
    if (task.status !== "VERIFYING" || turn.state !== "VERIFYING") {
      await quarantinePreparedCompletionRecord(record.id);
      quarantined.push(record.id);
      continue;
    }
    try {
      await verificationCoordinator.complete(record.taskId, record.verificationPlanId, turn.id, record.id);
      recovered.push(record.id);
    } catch (error: unknown) {
      failed.push({
        id: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { prepared: records.length, recovered, quarantined, failed };
}

interface EvidenceBundleRecoveryResult {
  readonly prepared: number;
  readonly committed: readonly string[];
  readonly quarantined: readonly string[];
}

/** Reconcile the small crash window between completion admission and bundle commit. */
async function reconcilePreparedEvidenceBundles(): Promise<EvidenceBundleRecoveryResult> {
  const bundles = await db.evidenceBundle.findMany({
    where: { admissionState: "PREPARED" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, taskId: true, turnId: true },
  });
  const committed: string[] = [];
  const quarantined: string[] = [];
  for (const bundle of bundles) {
    const [task, turn] = await Promise.all([
      db.task.findUnique({ where: { id: bundle.taskId }, select: { status: true } }),
      db.turn.findUnique({ where: { id: bundle.turnId }, select: { taskId: true, state: true } }),
    ]);
    const shouldCommit = task?.status === "COMPLETED"
      && turn?.taskId === bundle.taskId
      && ["VERIFIED", "FINALIZING", "COMPLETED"].includes(turn.state);
    const updated = await writerTransaction((tx) => tx.evidenceBundle.updateMany({
      where: { id: bundle.id, admissionState: "PREPARED" },
      data: { admissionState: shouldCommit ? "COMMITTED" : "QUARANTINED" },
    }));
    if (updated.count !== 1) continue;
    (shouldCommit ? committed : quarantined).push(bundle.id);
  }
  return { prepared: bundles.length, committed, quarantined };
}

/** Quarantine a terminal-adjacent turn when its completion proof is incomplete. */
async function quarantineTerminalRecoveryTurn(input: {
  readonly id: string;
  readonly taskId: string | null;
  readonly state: "VERIFIED" | "FINALIZING";
}): Promise<void> {
  const reason = {
    reason: "terminal_recovery_proof_incomplete",
    previous_state: input.state,
    reconciliation_required: true,
  };
  await emit({
    eventType: "turn.recovery_failed",
    aggregateType: "turn",
    aggregateId: input.id,
    correlationId: input.taskId ?? undefined,
    payload: { ...reason, state: "FAILED" },
  }, async (tx) => {
    const failed = await tx.turn.updateMany({
      where: { id: input.id, state: input.state },
      data: {
        state: "FAILED",
        completedAt: new Date(),
        terminalErrorJson: JSON.stringify(reason),
      },
    });
    if (failed.count !== 1) throw new Error(`terminal turn ${input.id} changed during recovery quarantine`);
    if (input.taskId !== null) {
      await tx.task.updateMany({
        where: { id: input.taskId, status: { in: ["ACTIVE", "VERIFYING", "COMPLETED"] } },
        data: {
          status: "BLOCKED",
          phase: "VERIFY",
          completedAt: null,
          terminalReasonJson: JSON.stringify({ ...reason, turn_id: input.id }),
        },
      });
    }
  });
  if (input.taskId !== null) await synchronizeV1TaskProjection(input.taskId, "turn.recovery_failed");
}

/**
 * Resume every active turn whose durable boundary is unambiguous. Later
 * phases are quarantined with explicit evidence rather than replaying a
 * provider request or effect blindly.
 */
async function recoverActiveAgentTurns(): Promise<number> {
  const active = await db.turn.findMany({
    where: { state: { in: [...V1_ACTIVE_TURN_STATES, "VERIFIED"] } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      taskId: true,
      threadId: true,
      sequence: true,
      state: true,
      initiatingActor: true,
      initiatingInputArtifact: true,
      terminalErrorJson: true,
      episodes: {
        where: { sequence: 1, kind: "user_message" },
        take: 1,
        select: { contentArtifact: true, sourceVersionsJson: true },
      },
      repairAttemptAsContinuation: { select: { id: true } },
      repairAttemptsAsParent: {
        where: { state: { in: [...REPAIR_ATTEMPT_ACTIVE_STATES] } },
        take: 1,
        select: { id: true },
      },
    },
  });
  for (const turn of active) {
    // A turn whose failure settlement could not be proven carries a durable
    // recovery marker (see the agentLoop settlement-fault path). Converge it
    // terminally before any other recovery pass touches it: the marker is
    // the explicit record that the in-process executor died without
    // recording the outcome.
    const recoveryMarker = turn.terminalErrorJson === null
      ? null
      : safeParse<Record<string, unknown> | null>(turn.terminalErrorJson, null);
    if (recoveryMarker?.reason === "failure_settlement_unproven") {
      await emit({
        eventType: "turn.failed",
        aggregateType: "turn",
        aggregateId: turn.id,
        correlationId: turn.taskId ?? undefined,
        payload: { ...recoveryMarker, state: "FAILED" },
      }, async (tx) => {
        const settled = await tx.turn.updateMany({
          where: { id: turn.id, state: turn.state },
          data: {
            state: "FAILED",
            completedAt: new Date(),
            terminalErrorJson: turn.terminalErrorJson,
          },
        });
        if (settled.count !== 1) {
          throw new Error(`turn ${turn.id} changed while converging a recovery marker`);
        }
      });
      if (turn.taskId !== null) {
        await emit({
          eventType: "task.turn_failed",
          aggregateType: "task",
          aggregateId: turn.taskId,
          correlationId: turn.taskId,
          payload: { status: "ACTIVE", active_turn: null, ...recoveryMarker },
        });
        await synchronizeV1TaskProjection(turn.taskId, "task.turn_failed");
      }
      continue;
    }
    if (turn.state === "VERIFIED" || turn.state === "FINALIZING") {
      if (await recoverVerifiedOrFinalizingTurn(turn)) continue;
      await quarantineTerminalRecoveryTurn({
        id: turn.id,
        taskId: turn.taskId,
        state: turn.state,
      });
      continue;
    }
    const repairAttemptId = turn.repairAttemptAsContinuation?.id ?? null;
    if (turn.initiatingActor === "repair-controller" && repairAttemptId === null) {
      // The durable attempt recovery below owns the admission window between
      // creating the child turn and associating it with its attempt.
      continue;
    }
    if (shouldDeferRepairParentRecovery({
      turnState: turn.state,
      hasActiveAttempt: turn.repairAttemptsAsParent.length > 0,
      hasContinuation: repairAttemptId !== null,
    })) {
      // A repair row is authoritative once scheduling commits. Leave this
      // admission window for recoverDurableRepairAttempts instead of
      // quarantining the parent as an uncertain verifier restart.
      continue;
    }
    const recoveredDenial = await recoveredKernelDenialForTurn(turn.id);
    if (recoveredDenial !== null) {
      await settleRecoveredKernelPolicyDenial({
        id: turn.id,
        taskId: turn.taskId,
        state: turn.state,
        denial: recoveredDenial,
      });
      continue;
    }
    if (repairAttemptId !== null && (turn.state === "REPAIRING" || turn.state === "CONTEXT_COMPILING")) {
      await runRepairTurnWithLease(repairAttemptId, turn.id);
      continue;
    }
    const safeToResume = await canResumeTurnAtBoundary(turn.id, turn.state);
    if (!safeToResume) {
      const interruptedAt = new Date();
      await emit({
        eventType: "turn.recovery_interrupted",
        aggregateType: "turn",
        aggregateId: turn.id,
        correlationId: turn.taskId ?? undefined,
        payload: {
          previous_state: turn.state,
          state: "INTERRUPTED",
          reason: "process_restart_after_work_began",
          reconciliation_required: true,
        },
      }, async (tx) => {
        await tx.providerAttempt.updateMany({
          where: { turnId: turn.id, status: "running" },
          data: {
            status: "interrupted",
            completedAt: interruptedAt,
            errorJson: JSON.stringify({ reason: "process_restart" }),
          },
        });
        await tx.toolCall.updateMany({
          where: {
            turnId: turn.id,
            state: { in: ["STARTED", "UNKNOWN", "RECONCILING"] },
          },
          data: {
            state: "UNKNOWN",
            settledAt: interruptedAt,
            resultStatus: "unknown",
            errorJson: JSON.stringify({ reason: "process_restart", reconciliation_required: true }),
          },
        });
        await tx.toolCall.updateMany({
          where: {
            turnId: turn.id,
            state: {
              in: [
                "PROPOSED",
                "VALIDATED",
                "POLICY_EVALUATED",
                "AUTHORIZED",
                "APPROVAL_PENDING",
              ],
            },
          },
          data: {
            state: "CANCELLED",
            settledAt: interruptedAt,
            resultStatus: "cancelled",
            errorJson: JSON.stringify({ reason: "process_restart_before_effect_start" }),
          },
        });
        // A tool call parked on an approval was waiting on an in-process
        // waiter that died with the old process. The call is cancelled above;
        // the approval must not stay "pending" in every client's inbox.
        await tx.approval.updateMany({
          where: { status: "pending", toolCall: { is: { turnId: turn.id } } },
          data: { status: "expired" },
        });
        await tx.sideEffect.updateMany({
          where: {
            toolCall: { turnId: turn.id },
            state: { in: ["STARTED", "UNKNOWN", "RECONCILING"] },
          },
          data: {
            state: "MANUAL_REVIEW",
            reconciliationJson: JSON.stringify({ reason: "process_restart", reconciliation_required: true }),
          },
        });
        const interrupted = await tx.turn.updateMany({
          where: { id: turn.id, state: turn.state },
          data: {
            state: "INTERRUPTED",
            completedAt: interruptedAt,
            terminalErrorJson: JSON.stringify({
              reason: "process_restart_after_work_began",
              previous_state: turn.state,
              reconciliation_required: true,
            }),
          },
        });
        if (interrupted.count !== 1) {
          throw new Error(`active turn ${turn.id} changed during startup recovery`);
        }
        if (repairAttemptId !== null) {
          const repairAttempt = await tx.repairAttempt.findUnique({
            where: { id: repairAttemptId },
            select: { leaseKey: true },
          });
          await tx.repairAttempt.updateMany({
            where: { id: repairAttemptId, state: { in: [...REPAIR_ATTEMPT_ACTIVE_STATES] } },
            data: {
              state: "BLOCKED",
              completedAt: interruptedAt,
              terminalReasonJson: JSON.stringify({
                reason: "process_restart_after_work_began",
                previous_turn_state: turn.state,
                reconciliation_required: true,
              }),
            },
          });
          if (repairAttempt !== null) {
            await tx.lease.updateMany({ where: { leaseKey: repairAttempt.leaseKey }, data: { expiresAt: interruptedAt } });
          }
        }
        if (turn.taskId !== null) {
          // H5/H8: the interrupted *turn* needs reconciliation; the task does
          // not become the user's problem. It returns to ACTIVE with no live
          // turn so the next message is accepted.
          await tx.task.updateMany({
            where: { id: turn.taskId, status: { in: ["ACTIVE", "VERIFYING"] } },
            data: {
              status: "ACTIVE",
              phase: "IMPLEMENT",
              completedAt: null,
              terminalReasonJson: null,
            },
          });
        }
      });
      if (turn.taskId !== null) {
        await synchronizeV1TaskProjection(turn.taskId, "turn.recovery_interrupted");
      }
      continue;
    }
    if (turn.state === "TOOL_SETTLEMENT") {
      await emit({
        eventType: "turn.recovery_reconciled",
        aggregateType: "turn",
        aggregateId: turn.id,
        correlationId: turn.taskId ?? undefined,
        payload: {
          previous_state: turn.state,
          state: "CONTEXT_COMPILING",
          reason: "all_tool_effects_have_terminal_receipts",
        },
      }, async (tx) => {
        const resumed = await tx.turn.updateMany({
          where: { id: turn.id, state: "TOOL_SETTLEMENT" },
          data: { state: "CONTEXT_COMPILING" },
        });
        if (resumed.count !== 1) throw new Error(`turn ${turn.id} changed during tool-settlement recovery`);
      });
      if (repairAttemptId !== null) {
        await runRepairTurnWithLease(repairAttemptId, turn.id);
        continue;
      }
    }
    const started = await db.semanticEvent.findFirst({
      where: {
        eventType: "turn.started",
        aggregateType: "turn",
        aggregateId: turn.id,
      },
      orderBy: { eventId: "desc" },
      select: { payloadJson: true, artifactRefsJson: true },
    });
    const payload = started === null
      ? null
      : safeParse<Record<string, unknown> | null>(started.payloadJson, null);
    const artifactRefs = started === null
      ? []
      : safeParse<unknown[]>(started.artifactRefsJson, []);
    const inputUri = artifactUriSchema.safeParse(turn.initiatingInputArtifact);
    const expectedHash = inputUri.success
      ? `sha256:${inputUri.data.slice("artifact://sha256/".length)}`
      : null;
    const episode = turn.episodes[0];
    const episodeSources = episode === undefined
      ? null
      : safeParse<Record<string, unknown> | null>(episode.sourceVersionsJson, null);
    const valid = payload !== null
      && payload.task_id === turn.taskId
      && payload.thread_id === turn.threadId
      && payload.sequence === turn.sequence
      && inputUri.success
      && payload.input_artifact === inputUri.data
      && payload.input_hash === expectedHash
      && artifactRefs.includes(inputUri.data)
      && episode?.contentArtifact === inputUri.data
      && episodeSources?.input === expectedHash;
    if (!valid && turn.state === "PENDING") {
      await emit({
        eventType: "turn.failed",
        aggregateType: "turn",
        aggregateId: turn.id,
        correlationId: turn.taskId ?? undefined,
        payload: { reason: "missing_or_invalid_admitted_input" },
      }, async (tx) => {
        const failed = await tx.turn.updateMany({
          where: { id: turn.id, state: "PENDING" },
          data: {
            state: "FAILED",
            completedAt: new Date(),
            terminalErrorJson: JSON.stringify({ reason: "missing_or_invalid_admitted_input" }),
          },
        });
        if (failed.count !== 1) throw new Error(`pending turn ${turn.id} changed during startup recovery`);
      });
      continue;
    }
    // H5: never re-drive a live turn after a restart. The provider attempt,
    // tool settlements, and context epoch of the interrupted run are gone;
    // replaying `agentLoop` would duplicate provider spend and re-propose
    // effects. Settle the orphan terminally and say why.
    await settleOrphanedTurnAfterRestart({ id: turn.id, taskId: turn.taskId, state: turn.state });
  }
  return active.length;
}

/**
 * Terminal settlement for a turn the control plane was executing when it
 * stopped. The turn is FAILED with an explicit cause; the task is left ACTIVE
 * (H8) so the user can simply send the message again.
 */
async function settleOrphanedTurnAfterRestart(turn: {
  readonly id: string;
  readonly taskId: string | null;
  readonly state: string;
}): Promise<void> {
  const settledAt = new Date();
  const { turnState, ...terminalError } = restartedTurnSettlement(turn.state);
  await mutateAgentState(async () => {
    await emit({
      eventType: "turn.failed",
      aggregateType: "turn",
      aggregateId: turn.id,
      correlationId: turn.taskId ?? undefined,
      payload: terminalError,
    }, async (tx) => {
      await tx.providerAttempt.updateMany({
        where: { turnId: turn.id, status: "running" },
        data: {
          status: "failed",
          completedAt: settledAt,
          errorJson: JSON.stringify(terminalError),
        },
      });
      const failed = await tx.turn.updateMany({
        where: { id: turn.id, state: turn.state },
        data: {
          state: turnState,
          completedAt: settledAt,
          terminalErrorJson: JSON.stringify(terminalError),
        },
      });
      if (failed.count !== 1) {
        throw new Error(`turn ${turn.id} changed during restart settlement`);
      }
    });
    if (turn.taskId === null) return;
    // The task itself is untouched: it stays ACTIVE with no live turn.
    await emit({
      eventType: "task.turn_failed",
      aggregateType: "task",
      aggregateId: turn.taskId,
      correlationId: turn.taskId,
      payload: { status: "ACTIVE", active_turn: null, ...terminalError },
    });
    await synchronizeV1TaskProjection(turn.taskId, "task.turn_failed");
  });
}

/**
 * Tasks whose turn is gone. A task in VERIFYING with no live turn cannot make
 * progress on its own and is not steerable; return it to ACTIVE. A task that
 * is already ACTIVE with zero turns (created and started but never given a
 * turn) is already correct and is left alone — recovery must tolerate that
 * shape rather than treat it as corruption.
 */
async function reconcileOrphanedActiveTasks(): Promise<number> {
  const stuck = await db.task.findMany({
    where: { status: "VERIFYING" },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  let returned = 0;
  for (const task of stuck) {
    const liveTurn = await db.turn.findFirst({
      where: { taskId: task.id, state: { in: [...V1_NONTERMINAL_TURN_STATES] } },
      select: { id: true },
    });
    const disposition = restartedTaskDisposition({ status: "VERIFYING", hasLiveTurn: liveTurn !== null });
    if (disposition.nextStatus === null) continue;
    await mutateAgentState(async () => {
      await emit({
        eventType: "task.turn_failed",
        aggregateType: "task",
        aggregateId: task.id,
        correlationId: task.id,
        payload: {
          status: "ACTIVE",
          active_turn: null,
          reason: "control_plane_restarted",
          message: "Verification was interrupted by a control-plane restart; the task is active again.",
        },
      }, async (tx) => {
        const update = await tx.task.updateMany({
          where: { id: task.id, status: "VERIFYING" },
          data: { status: "ACTIVE", phase: "IMPLEMENT", completedAt: null, terminalReasonJson: null },
        });
        if (update.count !== 1) throw new Error(`task ${task.id} changed during orphan reconciliation`);
      });
      await synchronizeV1TaskProjection(task.id, "task.turn_failed");
    });
    returned += 1;
  }
  return returned;
}

/**
 * Recover repair continuations from their durable attempt records. The row is
 * authoritative for identity and provenance; semantic events are only the
 * compatibility fallback below for attempts written before migration 0012.
 */
async function recoverDurableRepairAttempts(): Promise<number> {
  const attempts = await db.repairAttempt.findMany({
    where: { state: { in: [...REPAIR_ATTEMPT_ACTIVE_STATES] } },
    orderBy: [{ taskId: "asc" }, { attemptNumber: "asc" }],
    select: {
      id: true,
      taskId: true,
      parentTurnId: true,
      repairTurnId: true,
      attemptNumber: true,
      maxAttempts: true,
      directiveArtifact: true,
      failedNodeIdsJson: true,
      failureSignaturesJson: true,
      changedFilesJson: true,
      sourceRevision: true,
      environmentDigest: true,
      remainingBudgetJson: true,
      parentTurn: { select: { id: true, threadId: true, taskId: true, state: true } },
      repairTurn: { select: { id: true, state: true } },
    },
  });
  for (const attempt of attempts) {
    const directiveUri = artifactUriSchema.safeParse(attempt.directiveArtifact);
    if (!directiveUri.success) {
      await markRepairAttemptTerminal(attempt.id, "BLOCKED", "repair_directive_missing_or_invalid");
      continue;
    }
    if (attempt.parentTurn.taskId !== attempt.taskId) {
      await markRepairAttemptTerminal(attempt.id, "BLOCKED", "repair_parent_task_mismatch");
      continue;
    }
    let parentState = attempt.parentTurn.state;
    if (attempt.repairTurnId === null && parentState === "VERIFYING") {
      await emit({
        eventType: "turn.repair_pending",
        aggregateType: "turn",
        aggregateId: attempt.parentTurnId,
        correlationId: attempt.taskId,
        payload: {
          phase: "REPAIR_PENDING",
          repair_attempt: attempt.attemptNumber,
          repair_attempt_id: attempt.id,
          directive_artifact: directiveUri.data,
          recovered: true,
        },
        artifactRefs: [directiveUri.data],
      }, async (tx) => {
        const updated = await tx.turn.updateMany({
          where: { id: attempt.parentTurnId, state: "VERIFYING" },
          data: { state: "REPAIR_PENDING" },
        });
        if (updated.count !== 1) {
          const current = await tx.turn.findUnique({ where: { id: attempt.parentTurnId }, select: { state: true } });
          if (current?.state !== "REPAIR_PENDING") {
            throw new Error(`repair parent ${attempt.parentTurnId} changed during durable recovery`);
          }
        }
      });
      parentState = "REPAIR_PENDING";
    }
    let repairTurnId = attempt.repairTurnId;
    if (repairTurnId === null && parentState === "REPAIR_PENDING") {
      repairTurnId = await admitRepairTurn({
        taskId: attempt.taskId,
        threadId: attempt.parentTurn.threadId,
        repairAttemptId: attempt.id,
        directiveArtifactUri: directiveUri.data,
        directiveArtifactHash: `sha256:${directiveUri.data.slice("artifact://sha256/".length)}`,
        attemptNumber: attempt.attemptNumber,
      });
    }
    if (repairTurnId === null) {
      await markRepairAttemptTerminal(
        attempt.id,
        parentState === "ABORTED" ? "ABORTED" : "BLOCKED",
        parentState === "ABORTED" ? "repair_parent_aborted" : "repair_continuation_not_admitted",
      );
      continue;
    }
    if (parentState === "REPAIR_PENDING") {
      await supersedeRepairPendingTurn(attempt.parentTurnId, repairTurnId, attempt.taskId);
    }
    const repairTurn = await db.turn.findUnique({ where: { id: repairTurnId }, select: { state: true } });
    if (repairTurn === null) {
      await markRepairAttemptTerminal(attempt.id, "BLOCKED", "repair_turn_missing");
      continue;
    }
    if (repairTurn.state === "REPAIRING" || repairTurn.state === "CONTEXT_COMPILING" || repairTurn.state === "TOOL_SETTLEMENT") {
      await emit({
        eventType: "recovery.reconciled",
        aggregateType: "turn",
        aggregateId: attempt.parentTurnId,
        correlationId: attempt.taskId,
        payload: {
          previous_state: parentState,
          repair_turn_id: repairTurnId,
          repair_attempt_id: attempt.id,
          reason: "durable_repair_attempt_recovered",
        },
        artifactRefs: [directiveUri.data],
      });
      await runRepairTurnWithLease(attempt.id, repairTurnId);
      continue;
    }
    if (["COMPLETED", "VERIFIED", "FINALIZING", "FAILED", "BLOCKED", "ABORTED", "BUDGET_EXHAUSTED", "POLICY_DENIED", "USER_ACTION_REQUIRED"].includes(repairTurn.state)) {
      const settledState = repairTurn.state === "COMPLETED"
        || repairTurn.state === "VERIFIED"
        || repairTurn.state === "FINALIZING"
        ? "SUCCEEDED"
        : repairTurn.state === "ABORTED"
          ? "ABORTED"
          : repairTurn.state === "BLOCKED"
            || repairTurn.state === "POLICY_DENIED"
            || repairTurn.state === "USER_ACTION_REQUIRED"
            ? "BLOCKED"
            : "FAILED";
      await markRepairAttemptTerminal(
        attempt.id,
        settledState,
        "repair_turn_was_already_terminal",
      );
    }
  }
  return attempts.length;
}

/** Reconcile a crash between repair scheduling and repair-turn admission. */
async function recoverPendingRepairTurns(): Promise<number> {
  const pending = await db.turn.findMany({
    where: { state: "REPAIR_PENDING", repairAttemptsAsParent: { none: {} } },
    orderBy: { id: "asc" },
    select: { id: true, taskId: true, threadId: true },
  });
  for (const turn of pending) {
    if (turn.taskId === null) continue;
    const taskId = turn.taskId;
    const scheduled = await db.semanticEvent.findFirst({
      where: {
        eventType: "task.repair_scheduled",
        aggregateType: "task",
        aggregateId: taskId,
      },
      orderBy: { eventId: "desc" },
      select: { payloadJson: true },
    });
    const payload = scheduled === null
      ? null
      : safeParse<Record<string, unknown> | null>(scheduled.payloadJson, null);
    const directiveUri = artifactUriSchema.safeParse(payload?.directive_artifact);
    const attemptNumber = typeof payload?.repair_attempt === "number" && payload.repair_attempt > 0
      ? payload.repair_attempt
      : null;
    if (!directiveUri.success || attemptNumber === null) {
      await emit({
        eventType: "turn.recovery_failed",
        aggregateType: "turn",
        aggregateId: turn.id,
        correlationId: turn.taskId,
        payload: { reason: "repair_directive_missing_or_invalid", state: "BLOCKED" },
      }, async (tx) => {
        const blocked = await tx.turn.updateMany({
          where: { id: turn.id, state: "REPAIR_PENDING" },
          data: {
            state: "BLOCKED",
            completedAt: new Date(),
            terminalErrorJson: JSON.stringify({ reason: "repair_directive_missing_or_invalid" }),
          },
        });
        if (blocked.count !== 1) throw new Error(`repair turn ${turn.id} changed during recovery`);
        await tx.task.updateMany({
          where: { id: taskId, status: "ACTIVE" },
          data: {
            status: "BLOCKED",
            phase: "VERIFY",
            terminalReasonJson: JSON.stringify({ reason: "repair_directive_missing_or_invalid", turn_id: turn.id }),
          },
        });
      });
      await synchronizeV1TaskProjection(taskId, "turn.recovery_failed");
      continue;
    }
    const directiveHash = `sha256:${directiveUri.data.slice("artifact://sha256/".length)}`;
    const legacyAttemptId = typeof payload?.repair_attempt_id === "string"
      && payload.repair_attempt_id.length > 0
      ? payload.repair_attempt_id
      : `legacy-repair:${turn.id}:${attemptNumber}`;
    const legacyFailedNodes = Array.isArray(payload?.failed_nodes)
      ? payload.failed_nodes.filter((value): value is string => typeof value === "string")
      : [];
    const legacyFailureSignatures = Array.isArray(payload?.failure_signatures)
      ? payload.failure_signatures.filter((value): value is string => typeof value === "string")
      : [];
    const legacySourceRevision = typeof payload?.source_revision === "string"
      && payload.source_revision.length > 0
      ? payload.source_revision
      : "legacy-recovery";
    try {
      await ensureRepairAttemptRecord({
        id: legacyAttemptId,
        taskId,
        parentTurnId: turn.id,
        leaseKey: repairAttemptLeaseKey(legacyAttemptId),
        attemptNumber,
        maxAttempts: attemptNumber,
        directiveArtifact: directiveUri.data,
        failedNodeIds: legacyFailedNodes,
        failureSignatures: legacyFailureSignatures,
        changedFiles: [],
        sourceRevision: legacySourceRevision,
        environmentDigest: null,
        remainingBudgetJson: JSON.stringify({ remaining_attempts: 0 }),
      });
      const repairTurnId = await admitRepairTurn({
        taskId,
        threadId: turn.threadId,
        repairAttemptId: legacyAttemptId,
        directiveArtifactUri: directiveUri.data,
        directiveArtifactHash: directiveHash,
        attemptNumber,
      });
      await supersedeRepairPendingTurn(turn.id, repairTurnId, taskId);
      await emit({
        eventType: "recovery.reconciled",
        aggregateType: "turn",
        aggregateId: turn.id,
        correlationId: taskId,
        payload: {
          previous_state: "REPAIR_PENDING",
          repair_turn_id: repairTurnId,
          repair_attempt_id: legacyAttemptId,
          reason: "repair_turn_admitted_after_restart",
        },
        artifactRefs: [directiveUri.data],
      });
      void runRepairTurnWithLease(legacyAttemptId, repairTurnId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await emit({
        eventType: "turn.recovery_failed",
        aggregateType: "turn",
        aggregateId: turn.id,
        correlationId: taskId,
        payload: { reason: "repair_turn_admission_failed", error: message.slice(0, 512), state: "BLOCKED" },
      }, async (tx) => {
        const blocked = await tx.turn.updateMany({
          where: { id: turn.id, state: "REPAIR_PENDING" },
          data: {
            state: "BLOCKED",
            completedAt: new Date(),
            terminalErrorJson: JSON.stringify({ reason: "repair_turn_admission_failed", error: message }),
          },
        });
        if (blocked.count !== 1) throw new Error(`repair turn ${turn.id} changed during recovery failure`);
        await tx.task.updateMany({
          where: { id: taskId, status: { in: ["ACTIVE", "VERIFYING"] } },
          data: {
            status: "BLOCKED",
            phase: "VERIFY",
            terminalReasonJson: JSON.stringify({ reason: "repair_turn_admission_failed", error: message }),
          },
        });
      });
      await synchronizeV1TaskProjection(taskId, "turn.recovery_failed");
    }
  }
  return pending.length;
}

// ────────────────────────── HTTP server ────────────────────────────────────

/**
 * Request dispatch pipeline:
 *   1. CORS preflight (OPTIONS) → 204.
 *   2. Public health endpoint (GET /v1/system/health) → no auth.
 *   3. Bearer-token auth check (SPEC §30.8) → 401 on mismatch.
 *   4. Route lookup.
 *   5. Audit log `authorized` event before mutating handlers (SPEC §31.3 step 10).
 *   6. Idempotency wrap for mutating methods (SPEC §30.5).
 *   7. Handler execution.
 *   8. Idempotency commit (persist response artifact).
 */
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");

  // 1. CORS preflight.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": CONTROL_CORS_ORIGIN,
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "access-control-allow-methods": CORS_ALLOW_METHODS,
      "access-control-max-age": "600",
      "vary": "origin",
    });
    res.end();
    return;
  }

  // 2. Public health endpoint.
  if (req.method === "GET" && url.pathname === "/v1/system/health") {
    try {
      const kernel = requireKernelUds();
      // `instance_id` is a fresh uuid on every kernel start, so it cannot
      // identify a build. `version` and `build_digest` can: two runs that
      // report the same pair executed the same kernel.
      const [kernelHealth, kernelIdentity] = await Promise.all([
        kernel.info.Health({}),
        kernelBuildIdentity(kernel),
      ]);
      const writerReady = writerLeaseIsHealthy();
      const kernelReady = kernelHealth.state === "healthy" || kernelHealth.state === "ok";
      const recovered = startupRecovery.status === "complete";
      sendJson(res, 200, {
        status: kernelReady && writerReady ? "ok" : "degraded",
        version: CONTROL_BUILD_VERSION,
        build_commit: CONTROL_BUILD_COMMIT,
        instance_id: CONTROL_INSTANCE_NONCE,
        uptime_seconds: process.uptime(),
        // H5: bound but not yet reconciled is a real, reportable state.
        ready: kernelReady && writerReady && recovered,
        recovery: {
          status: startupRecovery.status,
          error: startupRecovery.error,
          completed_at: startupRecovery.completedAt,
        },
        kernel: { ...kernelHealth, ...kernelIdentity },
        writer: writerLease === null ? { healthy: false } : {
          healthy: writerReady,
          fencing_token: writerLease.fencingToken,
          expires_at: writerLease.expiresAt.toISOString(),
        },
      });
    } catch (err) {
      if (!res.headersSent) {
        sendInternalError(res, "HEALTH_CHECK_FAILED", "health check failed", "health handler failed", err);
      } else {
        logInternalError("health handler failed", err);
      }
    }
    return;
  }

  // 3. Auth check.
  if (!checkAuth(req)) {
    sendError(res, 401, "UNAUTHENTICATED", "missing or invalid bearer token", "auth", {
      hint: "send 'Authorization: Bearer <TERMINUS_CONTROL_TOKEN>'",
    });
    return;
  }

  const traceId = getTraceId(req);

  // 4. Route lookup.
  let matchedRoute: Route | null = null;
  const matchedParams: Record<string, string> = {};
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    matchedRoute = r;
    // Malformed percent-encoding (e.g. /v1/tasks/%zz) must degrade to a
    // 404-style miss, not throw an unhandled rejection that kills the
    // server: decodeURIComponent throws URIError on invalid sequences, and
    // this loop runs outside the handler try/catch below.
    try {
      r.paramNames.forEach((n, i) => { matchedParams[n] = decodeURIComponent(m[i + 1] ?? ""); });
    } catch {
      matchedRoute = null;
      break;
    }
    break;
  }

  if (!matchedRoute) {
    sendError(res, 404, "NOT_FOUND", `no route for ${req.method} ${url.pathname}`, "not_found");
    return;
  }

  // 5. Audit log before effects.
  if (isMutating(req.method)) {
    auditAuthorized(req, url, matchedParams, traceId);
  }

  const mut = isMutating(req.method);
  const dispatch = async () => {
    if (mut && !writerLeaseIsHealthy()) {
      sendError(
        res,
        503,
        "CONTROL_WRITER_FENCED",
        "the control-plane writer lease is unavailable or expired",
        "external_dependency",
      );
      return;
    }

    // 6. Idempotency wrap (mutating only).
    let idempotencyKey: string | null = null;
    if (mut) {
      const keyHeader = req.headers["idempotency-key"];
      idempotencyKey = Array.isArray(keyHeader) ? (keyHeader[0] ?? null) : (keyHeader ?? null);
      const proceed = await withIdempotency(req, res, matchedRoute.method, traceId);
      if (!proceed) return;
    }

    // 7. Handler execution.
    try {
      await matchedRoute.handler(req, res, matchedParams);
    } catch (err) {
      console.error("handler error", err);
      if (!res.headersSent) {
        sendCaughtError(res, err);
      }
    }

    // 8. Persist the exact response before exposing it to the client. If the
    // reservation cannot be completed, settlement is ambiguous: fail closed
    // instead of returning success without a replay guarantee.
    if (mut && idempotencyKey) {
      try {
        const captured = await commitIdempotency(res, matchedRoute.method, idempotencyKey);
        sendJsonBuffer(res, captured.status, captured.body);
      } catch (err) {
        console.error("idempotency commit error", err);
        // `commitIdempotency` removes the capture before persistence, so this
        // error bypasses capture and reaches the caller immediately.
        if (!res.headersSent) {
          sendError(
            res,
            500,
            "IDEMPOTENCY_COMMIT_FAILED",
            "the mutation may have settled, but its replay record could not be committed",
            "unknown_settlement",
            { idempotency_key: idempotencyKey, reconciliation_required: true },
          );
        }
      }
    }
  };

  if (mut) await mutationMutex.runExclusive(dispatch);
  else await dispatch();
});

// Replay and reconcile authoritative state before accepting public requests.
// Starting an empty success-shaped store after a database error would make
// task identity and approvals diverge across clients.
requireKernelUds();
await initializeKernelControlCapabilities();
await acquireControlWriterLease();
writerLeaseHeartbeat = setInterval(() => {
  void renewControlWriterLease();
}, Math.max(1_000, Math.floor(CONTROL_WRITER_LEASE_MS / 3)));
/**
 * Everything that reconciles durable state after a restart. Runs *after* the
 * listener binds (H5) and never rethrows: a recovery failure degrades
 * readiness so an operator can see it, instead of killing the process at
 * module scope where the failure is invisible.
 */
async function runStartupRecovery(): Promise<void> {
  startupRecovery.status = "running";
  try {
  const scopedDelegationRecovery = await scopedDelegationService.recoverAfterRestart();
  const reconciledIdempotencyReservations = await reconcilePendingIdempotencyReservations();
  await replayArpV2();
  const jobRecovery = await reconcileNonterminalJobs();
  const effectRecovery = await reconcileUnsettledSideEffects();
  const providerRecovery = await providerSessionService.reconcileInFlightAttempts(V1_ACTIVE_TURN_STATES);
  const candidateBranchRecovery = await reconcileInFlightCandidateBranchAdmissions(
    false,
    buildTrustedBranchReceiptReconciler() ?? undefined,
  );
  const repairedTaskProjections = await reconcileV1TaskProjections();
  const checkpointLinkRecovery = await reconcileCheckpointArtifactLinks();
  const checkpointAdmissionRecovery = await reconcilePreparedCheckpointAdmissions();
  const completionAdmissionRecovery = await reconcilePreparedCompletionRecords();
  const evidenceBundleRecovery = await reconcilePreparedEvidenceBundles();
  const recoveredActiveTurns = await recoverActiveAgentTurns();
  const recoveredDurableRepairAttempts = await recoverDurableRepairAttempts();
  const recoveredPendingRepairTurns = await recoverPendingRepairTurns();
  if (
    effectRecovery.failed.length > 0
    ||
    providerRecovery.failed.length > 0
    ||
    candidateBranchRecovery.failed.length > 0
    ||
    checkpointLinkRecovery.failed.length > 0
    || checkpointAdmissionRecovery.failed.length > 0
    || completionAdmissionRecovery.failed.length > 0
  ) {
    throw new Error(
      `startup recovery could not settle: ${effectRecovery.failed.length} effect failures, ${providerRecovery.failed.length} provider failures, ${candidateBranchRecovery.failed.length} candidate branch failures, ${checkpointLinkRecovery.failed.length} checkpoint link failures, ${checkpointAdmissionRecovery.failed.length} checkpoint admission failures, ${completionAdmissionRecovery.failed.length} completion admission failures`,
    );
  }
  if (repairedTaskProjections > 0) {
    console.log(`[terminus-control] repaired ${repairedTaskProjections} v1/v2 task projections`);
  }
  if (reconciledIdempotencyReservations > 0) {
    console.log(
      `[terminus-control] reconciled ${reconciledIdempotencyReservations} unknown idempotency settlement(s)`,
    );
  }
  if (scopedDelegationRecovery.length > 0) {
    const recovered = scopedDelegationRecovery.filter((result) => result.outcome === "recovered").length;
    const interrupted = scopedDelegationRecovery.filter((result) => result.outcome === "interrupted").length;
    const manualReview = scopedDelegationRecovery.filter((result) => result.outcome === "manual_review").length;
    console.log(
      `[terminus-control] scoped delegation recovery: ${recovered} recovered, ${interrupted} interrupted, ${manualReview} manual review`,
    );
  }
  if (jobRecovery.scanned > 0) {
    console.log(
      `[terminus-control] job recovery: ${jobRecovery.scanned} scanned, ${jobRecovery.lost} lost, ${jobRecovery.live} live, ${jobRecovery.exited} exited`,
    );
  }
  if (effectRecovery.scanned > 0) {
    console.log(
      `[terminus-control] effect recovery: ${effectRecovery.manualReview.length} moved to manual review, ${effectRecovery.alreadyResolved.length} already resolved`,
    );
  }
  if (providerRecovery.scanned > 0) {
    console.log(
      `[terminus-control] provider recovery: ${providerRecovery.interrupted.length} interrupted, ${providerRecovery.alreadyResolved.length} already resolved`,
    );
  }
  if (candidateBranchRecovery.scanned > 0) {
    console.log(
      `[terminus-control] candidate branch recovery: ${candidateBranchRecovery.manualReview.length} manual review, ${candidateBranchRecovery.admitted.length} admitted from trusted receipts, ${candidateBranchRecovery.alreadyResolved.length} already resolved`,
    );
  }
  if (checkpointAdmissionRecovery.prepared > 0) {
    console.log(
      `[terminus-control] checkpoint admission recovery: ${checkpointAdmissionRecovery.recovered.length} recovered, ${checkpointAdmissionRecovery.quarantined.length} quarantined, ${checkpointAdmissionRecovery.failed.length} pending`,
    );
  }
  if (completionAdmissionRecovery.prepared > 0) {
    console.log(
      `[terminus-control] completion admission recovery: ${completionAdmissionRecovery.recovered.length} recovered, ${completionAdmissionRecovery.quarantined.length} quarantined, ${completionAdmissionRecovery.failed.length} pending`,
    );
  }
  if (evidenceBundleRecovery.prepared > 0) {
    console.log(
      `[terminus-control] evidence bundle recovery: ${evidenceBundleRecovery.committed.length} committed, ${evidenceBundleRecovery.quarantined.length} quarantined`,
    );
  }
  if (recoveredDurableRepairAttempts > 0 || recoveredPendingRepairTurns > 0) {
    console.log(
      `[terminus-control] repair recovery: ${recoveredDurableRepairAttempts} durable attempts, ${recoveredPendingRepairTurns} legacy pending turns`,
    );
  }
  if (recoveredActiveTurns > 0) {
    console.log(`[terminus-control] reconciled ${recoveredActiveTurns} active turn(s)`);
  }
  if (recoveredPendingRepairTurns > 0) {
    console.log(`[terminus-control] reconciled ${recoveredPendingRepairTurns} pending repair turn(s)`);
  }
  if (
    checkpointLinkRecovery.scanned > 0
    || checkpointLinkRecovery.removedOrphans.length > 0
    || checkpointLinkRecovery.requeued.length > 0
  ) {
    console.log(
      `[terminus-control] checkpoint link recovery: ${checkpointLinkRecovery.scanned} scanned, ${checkpointLinkRecovery.removedOrphans.length} orphans removed, ${checkpointLinkRecovery.requeued.length} rows requeued, ${checkpointLinkRecovery.quarantined.length} quarantined`,
    );
  }
    // H4: warm gateway model discovery so the first turn after a restart is
    // not denied for a cold cache. Failures are logged, not fatal: the durable
    // record from a previous run still routes.
    await warmProviderModelDiscovery();
    // Connected provider accounts: reconcile what this machine holds, then
    // warm each account's model list. Runs after migrations and after the
    // kernel is reachable, because both the import and the catalogue calls go
    // through it. Failures are logged, never fatal.
    await warmProviderAccountDiscovery();
    const orphanedActiveTasks = await reconcileOrphanedActiveTasks();
    if (orphanedActiveTasks > 0) {
      console.log(`[terminus-control] returned ${orphanedActiveTasks} task(s) with no live turn to ACTIVE`);
    }
    startupRecovery.status = "complete";
    startupRecovery.error = null;
    startupRecovery.completedAt = new Date().toISOString();
  } catch (error: unknown) {
    startupRecovery.status = "failed";
    startupRecovery.error = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    startupRecovery.completedAt = new Date().toISOString();
    console.error("[terminus-control] startup recovery failed; readiness stays false", error);
  }
}

// The Electron preload and desktop documentation use the IPv4 loopback URL
// (`http://127.0.0.1:3050`). Binding explicitly keeps that documented local
// transport reachable on macOS, where Node otherwise prefers an IPv6-only
// localhost listener in some environments.
server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address !== null
    ? address.port
    : PORT;
  console.log(`[terminus-control] listening on http://localhost:${listeningPort}`);
  console.log(`[terminus-control] kernel transport: grpc+uds (${KERNEL_GRPC_SOCKET || "not configured"})`);
  console.log(`[terminus-control] CORS origin: ${CONTROL_CORS_ORIGIN}`);
  console.log(`[terminus-control] auth: bearer token (TERMINUS_CONTROL_TOKEN)`);
  if (CONTROL_READY_FD !== null) {
    try {
      writeSync(CONTROL_READY_FD, `${JSON.stringify({
        schema: "terminus.control-ready.v1",
        port: listeningPort,
        instance_id: CONTROL_INSTANCE_NONCE,
      })}\n`);
      closeSync(CONTROL_READY_FD);
    } catch (error: unknown) {
      console.error("[terminus-control] failed to report bound listener", error);
      void shutdownControl().finally(() => process.exit(1));
      return;
    }
  }
  // H5: recovery starts only after the socket is bound, and never blocks it.
  // `GET /v1/system/health` reports `ready: false` until it settles.
  void runStartupRecovery();
});

let shuttingDown = false;
const desktopParentWatchdog = DESKTOP_PARENT_PID === null
  ? null
  : setInterval(() => {
      if (process.ppid === DESKTOP_PARENT_PID) return;
      console.error("[terminus-control] desktop supervisor disappeared; shutting down");
      void shutdownControl().finally(() => process.exit(1));
    }, 1_000);
async function shutdownControl(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (desktopParentWatchdog) clearInterval(desktopParentWatchdog);
  if (writerLeaseHeartbeat) clearInterval(writerLeaseHeartbeat);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await releaseControlWriterLease().catch((error: unknown) => {
    console.error("[terminus-control] failed to release writer lease", error);
  });
  try {
    await db.$disconnect();
  } finally {
    scopedDelegationDatabase.close();
  }
}

process.on("SIGINT", () => { void shutdownControl().finally(() => process.exit(0)); });
process.on("SIGTERM", () => { void shutdownControl().finally(() => process.exit(0)); });
