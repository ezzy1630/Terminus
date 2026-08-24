/**
 * @terminus/domain — core aggregate types.
 *
 * Per SPEC §28.2: Workspace, Session, Thread, Task, Turn, Episode,
 * ProviderAttempt, ContextEpoch, ContextManifest, ContextFragment, Artifact,
 * ArtifactRef, ToolCall, PolicyDecision, Approval, SideEffect, Job, Agent,
 * Delegation, VerificationPlan, VerificationNode, VerificationResult,
 * MemoryClaim, Capability, CapabilityActivation, IdempotencyRecord, Lease,
 * SemanticEvent, EventStreamCursor.
 */
import { z } from "zod";
import type {
  Uuid7,
  ContentHash,
  ArtifactUri,
  ResourceUri,
  Rfc3339Timestamp,
  Micros,
  TokenCount,
  ByteCount,
  ModelKey,
  PrincipalId,
  TraceId,
  CursorToken,
} from "./ids.js";
import {
  artifactUriSchema,
  byteCountSchema,
  contentHashSchema,
  microsSchema,
  rfc3339Schema,
} from "./ids.js";
import type {
  TaskStatus,
  TaskPhase,
  TurnState,
  ToolCallState,
  SideEffectState,
  JobState,
  ContextEpochState,
  SessionStatus,
  ThreadStatus,
  WorkspaceTrust,
  WorkspaceKind,
  RiskClass,
  TrustLabel,
  ConfidentialityLabel,
  InjectionRisk,
  Exactness,
  ActorKind,
  CapabilityKind,
  CapabilityTrustLevel,
  MemoryClaimStatus,
  MemoryClaimKind,
  VerificationNodeKind,
  VerificationResultStatus,
  ReviewFindingLifecycle,
  DelegationRole,
  DelegationResultStatus,
  OutputProfile,
  ApprovalDecision,
  WorkflowStatus,
  NodeRunStatus,
  AttemptStatus,
  LeaseStatus,
} from "./enums.js";

// ─────────────────────────── Workspace (§28.2) ───────────────────────────────

export interface RepositoryIdentity {
  readonly vcs: "git" | "none";
  readonly remoteFingerprint: string | null;
  readonly initialCommit: string | null;
}

export const repositoryIdentitySchema = z.object({
  vcs: z.enum(["git", "none"]),
  remoteFingerprint: z.string().nullable(),
  initialCommit: z.string().nullable(),
});

/** Remote environment binding when `kind === "remote"` (SPEC §48.14). */
export interface RemoteEnvironmentRef {
  readonly kernelId: string;
  readonly endpoint: string;
  readonly imageDigest: string;
  readonly backend: "container" | "microvm";
  readonly policyProfile: string;
  readonly transport: "mtls";
}

export const remoteEnvironmentRefSchema = z.object({
  kernelId: z.string().regex(/^kernel:[^\s:]+$/),
  endpoint: z.string().min(1),
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  backend: z.enum(["container", "microvm"]),
  policyProfile: z.string().min(1),
  transport: z.literal("mtls"),
});

export interface Workspace {
  readonly id: Uuid7;
  readonly kind: WorkspaceKind;
  readonly rootUri: string;
  readonly canonicalRoot: string;
  readonly trust: WorkspaceTrust;
  readonly repositoryIdentity: RepositoryIdentity;
  readonly activePolicyProfile: string | null;
  readonly remoteEnvironment: RemoteEnvironmentRef | null;
  readonly createdAt: Rfc3339Timestamp;
  readonly lastOpenedAt: Rfc3339Timestamp | null;
}

export const workspaceSchema = z.object({
  id: z.string(),
  kind: z.enum(["local_git", "local_directory", "container", "microvm", "remote"]),
  rootUri: z.string(),
  canonicalRoot: z.string(),
  trust: z.enum(["trusted", "untrusted", "restricted"]),
  repositoryIdentity: repositoryIdentitySchema,
  activePolicyProfile: z.string().nullable(),
  remoteEnvironment: remoteEnvironmentRefSchema.nullable().default(null),
  createdAt: z.string(),
  lastOpenedAt: z.string().nullable(),
});

// ──────────────────────────── Session (§28.2) ────────────────────────────────

export interface Session {
  readonly id: Uuid7;
  readonly workspaceId: Uuid7;
  readonly ownerPrincipal: PrincipalId;
  readonly title: string;
  readonly status: SessionStatus;
  readonly createdAt: Rfc3339Timestamp;
  readonly updatedAt: Rfc3339Timestamp;
  readonly defaultModelProfile: string | null;
  readonly defaultPermissionProfile: string | null;
  readonly activeThreadId: Uuid7 | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ───────────────────────────── Thread (§28.2) ────────────────────────────────

export interface Thread {
  readonly id: Uuid7;
  readonly sessionId: Uuid7;
  readonly parentThreadId: Uuid7 | null;
  readonly forkedFromTurnId: Uuid7 | null;
  readonly status: ThreadStatus;
  readonly activeContextEpochId: Uuid7 | null;
  readonly headTurnId: Uuid7 | null;
  readonly createdAt: Rfc3339Timestamp;
}

// ───────────────────────── Acceptance criteria / scope ────────────────────────

export interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly verificationHint: string | null;
  readonly required: boolean;
}

export const acceptanceCriterionSchema = z.object({
  id: z.string(),
  statement: z.string(),
  verificationHint: z.string().nullable(),
  required: z.boolean(),
});

export interface AllowedScope {
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly externalSystems: readonly string[];
}

export const allowedScopeSchema = z.object({
  readPaths: z.array(z.string()),
  writePaths: z.array(z.string()),
  externalSystems: z.array(z.string()),
});

export interface TaskBudget {
  readonly modelMicros: Micros;
  readonly computeSeconds: number;
  readonly wallClockSeconds: number;
  readonly humanApprovals: number;
}

export const taskBudgetSchema = z.object({
  modelMicros: z.bigint(),
  computeSeconds: z.number().int().nonnegative(),
  wallClockSeconds: z.number().int().nonnegative(),
  humanApprovals: z.number().int().nonnegative(),
});

export interface TaskChangePolicy {
  readonly mayExpandScope: boolean;
  readonly scopeExpansionRequiresUser: boolean;
}

export const taskChangePolicySchema = z.object({
  mayExpandScope: z.boolean(),
  scopeExpansionRequiresUser: z.boolean(),
});

// ────────────────────────── Task contract (§37.2) ────────────────────────────

export interface TaskContract {
  readonly id: Uuid7;
  readonly version: number;
  readonly objective: string;
  readonly userOutcome: string | null;
  readonly nonGoals: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly constraints: readonly string[];
  readonly assumptions: readonly string[];
  readonly unknowns: readonly string[];
  readonly allowedScope: AllowedScope;
  readonly riskClass: RiskClass;
  readonly budget: TaskBudget;
  readonly changePolicy: TaskChangePolicy;
}

export const taskContractSchema = z.object({
  id: z.string(),
  version: z.number().int().nonnegative(),
  objective: z.string(),
  userOutcome: z.string().nullable(),
  nonGoals: z.array(z.string()),
  acceptanceCriteria: z.array(acceptanceCriterionSchema),
  constraints: z.array(z.string()),
  assumptions: z.array(z.string()),
  unknowns: z.array(z.string()),
  allowedScope: allowedScopeSchema,
  riskClass: z.enum(["low", "normal", "high", "critical"]),
  budget: taskBudgetSchema,
  changePolicy: taskChangePolicySchema,
});

// ──────────────────────────── Task (§28.2) ───────────────────────────────────

export interface Task {
  readonly id: Uuid7;
  readonly sessionId: Uuid7;
  readonly threadId: Uuid7;
  readonly contract: TaskContract;
  readonly status: TaskStatus;
  readonly phase: TaskPhase;
  readonly scopeLedgerId: Uuid7 | null;
  readonly verificationPlanId: Uuid7 | null;
  readonly createdAt: Rfc3339Timestamp;
  readonly completedAt: Rfc3339Timestamp | null;
}

// ──────────────────────── Scope ledger entry (§37.3) ─────────────────────────

export interface ScopeLedgerEntry {
  readonly id: Uuid7;
  readonly taskId: Uuid7;
  readonly kind:
    | "user_named"
    | "inferred_dependency"
    | "read"
    | "write_proposed"
    | "write_actual"
    | "external_proposed"
    | "external_used"
    | "scope_expansion";
  readonly path: string | null;
  readonly externalSystem: string | null;
  readonly justification: string | null;
  readonly approvedBy: PrincipalId | null;
  readonly observedAt: Rfc3339Timestamp;
}

// ──────────────────────────── Turn / Episode ─────────────────────────────────

export interface Turn {
  readonly id: Uuid7;
  readonly threadId: Uuid7;
  readonly taskId: Uuid7 | null;
  readonly sequence: number;
  readonly state: TurnState;
  readonly initiatedBy: PrincipalId;
  readonly startedAt: Rfc3339Timestamp;
  readonly finalizedAt: Rfc3339Timestamp | null;
}

export interface Episode {
  readonly id: Uuid7;
  readonly turnId: Uuid7;
  readonly sequence: number;
  readonly kind:
    | "user_message"
    | "model_message"
    | "tool_call"
    | "tool_result"
    | "side_effect"
    | "checkpoint"
    | "system";
  /** Artifact hash for the episode content. */
  readonly contentRef: ContentHash | null;
  readonly providerAttemptId: Uuid7 | null;
  readonly toolCallId: Uuid7 | null;
  readonly occurredAt: Rfc3339Timestamp;
}

// ──────────────────────── Provider attempt (§28.2) ───────────────────────────

export interface ProviderAttempt {
  readonly id: Uuid7;
  readonly turnId: Uuid7;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly model: ModelKey;
  readonly contextManifestId: Uuid7;
  readonly continuationId: string | null;
  readonly startedAt: Rfc3339Timestamp;
  readonly settledAt: Rfc3339Timestamp | null;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly failureCode: string | null;
  readonly usage: ProviderUsage | null;
  readonly costMicros: Micros | null;
}

export interface ProviderUsage {
  readonly inputTokens: TokenCount;
  readonly cachedInputTokens: TokenCount;
  readonly cacheWriteTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly reasoningTokens: TokenCount;
  readonly toolSchemaTokens: TokenCount;
  readonly latencyMs: number;
  readonly timeToFirstTokenMs: number | null;
}

// ────────────────────────── Artifact / ref (§29.3) ───────────────────────────

export interface Artifact {
  readonly hash: ContentHash;
  readonly uri: ArtifactUri;
  readonly bytes: ByteCount;
  readonly mediaType: string;
  readonly createdAt: Rfc3339Timestamp;
  readonly compression: "none" | "zstd" | "gzip" | "br";
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ArtifactRef {
  readonly hash: ContentHash;
  readonly uri: ArtifactUri;
  readonly mediaType: string;
  readonly bytes: ByteCount;
}

export const artifactRefSchema = z.object({
  hash: contentHashSchema,
  uri: artifactUriSchema,
  mediaType: z.string().min(1),
  bytes: byteCountSchema,
}).strict();

// ───────────────────────── Context epoch (§28.8, §33.15) ─────────────────────

export interface ContextEpoch {
  readonly id: Uuid7;
  readonly threadId: Uuid7;
  readonly sequence: number;
  readonly state: ContextEpochState;
  readonly baselineHash: ContentHash;
  readonly provider: string;
  readonly model: ModelKey;
  readonly continuationId: string | null;
  readonly startedAt: Rfc3339Timestamp;
  readonly sealedAt: Rfc3339Timestamp | null;
  readonly supersededBy: Uuid7 | null;
}

// ───────────────────────── Context fragment (§33.2) ──────────────────────────

export type ContextKind =
  | "authority"
  | "project_rule"
  | "task_contract"
  | "world_state"
  | "code"
  | "test"
  | "documentation"
  | "tool_result"
  | "recent_episode"
  | "checkpoint"
  | "memory"
  | "tool_schema"
  | "user_attachment";

export const contextKindSchema = z.enum([
  "authority",
  "project_rule",
  "task_contract",
  "world_state",
  "code",
  "test",
  "documentation",
  "tool_result",
  "recent_episode",
  "checkpoint",
  "memory",
  "tool_schema",
  "user_attachment",
]);

export interface ContextScope {
  readonly workspaceId: Uuid7 | null;
  readonly sessionId: Uuid7 | null;
  readonly taskId: Uuid7 | null;
  readonly pathPatterns: readonly string[];
}

export interface Freshness {
  readonly observedAt: Rfc3339Timestamp;
  readonly sourceVersion: string | null;
  readonly stale: boolean;
  readonly staleReason: string | null;
}

export interface InvalidationRule {
  readonly kind: "file_changed" | "symbol_changed" | "test_changed" | "policy_changed" | "ttl";
  readonly selector: string;
}

export interface SelectionFeatures {
  readonly relevance: number;
  readonly novelty: number;
  readonly coverage: number;
  readonly uncertaintyReduction: number;
  readonly riskReduction: number;
  readonly modelCompatibility: number;
  readonly redundancyPenalty: number;
  readonly injectionPenalty: number;
}

export interface SourceDescriptor {
  readonly uri: string;
  readonly producer: string;
  readonly producerVersion: string;
  readonly observedAt: Rfc3339Timestamp;
  readonly observedBy: "kernel" | "control" | "provider" | "user" | "external";
  readonly evidenceRefs: readonly ArtifactRef[];
}

export interface ContextFragment {
  readonly id: string;
  readonly kind: ContextKind;
  readonly contentRef: ArtifactRef;
  /**
   * Optional in-band text content for the fragment. When present, renderers
   * use this text directly instead of dereferencing `contentRef.uri`. This is
   * a pragmatic shortcut for the common case where the package layer already
   * has the text in hand and cannot reach a live artifact store. When absent,
   * renderers fall back to the URI (which is what the kernel will later
   * resolve at the wire boundary if a real artifact store is wired in).
   */
  readonly textContent?: string | undefined;
  readonly source: SourceDescriptor;
  readonly sourceVersion: string | null;
  readonly authority: number;
  readonly priority: number;
  readonly trust: TrustLabel;
  readonly confidentiality: ConfidentialityLabel;
  readonly injectionRisk: InjectionRisk;
  readonly exactness: Exactness;
  readonly scope: ContextScope;
  readonly freshness: Freshness;
  readonly dependencies: readonly string[];
  readonly invalidation: readonly InvalidationRule[];
  readonly estimatedTokens: Readonly<Record<ModelKey, number>>;
  readonly selectionFeatures: SelectionFeatures;
}

export interface ContextManifest {
  readonly id: Uuid7;
  readonly providerAttemptId: Uuid7 | null;
  readonly epochId: Uuid7;
  readonly compilerVersion: string;
  readonly policyVersion: string;
  readonly providerCapabilityHash: ContentHash;
  readonly model: ModelKey;
  readonly fragments: readonly ContextManifestEntry[];
  readonly omitted: readonly ContextManifestOmission[];
  readonly cachePlan: ContextCachePlan;
  readonly outputReserveTokens: TokenCount;
  readonly reasoningReserveTokens: TokenCount;
  readonly toolResultReserveTokens: TokenCount;
  readonly recoveryMarginTokens: TokenCount;
  readonly predictedCachedTokens: TokenCount;
  readonly observedCachedTokens: TokenCount | null;
  readonly confidentialityDecisions: Readonly<Record<string, ConfidentialityLabel>>;
  readonly taintDecisions: Readonly<Record<string, InjectionRisk>>;
  readonly experimentAssignments: readonly string[];
  /**
   * Immutable compiler decision record. It contains the retrieval queries,
   * candidate scores, evidence coverage, transforms, and policy decisions
   * needed to explain and replay the invocation without consulting model
   * recollection.
   */
  readonly decisionRecord?: Readonly<Record<string, unknown>> | undefined;
  readonly createdAt: Rfc3339Timestamp;
}

export interface ContextManifestEntry {
  readonly fragmentId: string;
  readonly role: string;
  readonly order: number;
  readonly artifactHash: ContentHash;
  readonly estimatedTokens: number;
  readonly required: boolean;
  readonly cacheBreakpoint: boolean;
}

export interface ContextManifestOmission {
  readonly fragmentId: string;
  readonly reason: string;
}

export interface ContextCachePlan {
  readonly stablePrefixHash: ContentHash;
  readonly volatileSuffixBoundary: number;
  readonly breakpoints: readonly number[];
  readonly predictedCachedTokens: TokenCount;
}

// ────────────────────────── Tool call (§28.5) ────────────────────────────────

export interface ToolCall {
  readonly id: Uuid7;
  readonly turnId: Uuid7;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly normalizedArguments: Readonly<Record<string, unknown>>;
  readonly state: ToolCallState;
  readonly policyDecisionId: Uuid7 | null;
  readonly approvalId: Uuid7 | null;
  readonly startedAt: Rfc3339Timestamp | null;
  readonly settledAt: Rfc3339Timestamp | null;
  readonly resultArtifactHash: ContentHash | null;
  readonly resultStatus:
    | "success"
    | "partial"
    | "error"
    | "denied"
    | "timeout"
    | "cancelled"
    | "unknown"
    | null;
  readonly failureCode: string | null;
}

// ───────────────────────── Policy decision (§13.2) ───────────────────────────

export interface PolicyDecision {
  readonly id: Uuid7;
  readonly effectType: string;
  readonly normalizedCommand: string | null;
  readonly decision: "allow" | "deny" | "prompt";
  readonly matchedRules: readonly string[];
  readonly reason: string;
  readonly sandboxProfile: string | null;
  readonly approvalRequired: boolean;
  readonly decidedAt: Rfc3339Timestamp;
}

// ───────────────────────── Approval (§32.4) ──────────────────────────────────

export interface Approval {
  readonly id: Uuid7;
  readonly taskId: Uuid7;
  readonly operationSummary: string;
  readonly exactAction: string;
  readonly resolvedResources: readonly string[];
  readonly reason: string;
  readonly risk: RiskClass;
  readonly reversibility: "reversible" | "irreversible" | "external";
  readonly externalEffect: boolean;
  readonly originatingUserIntent: string;
  readonly untrustedInfluence: boolean;
  readonly policyRules: readonly string[];
  readonly previewArtifactHashes: readonly ContentHash[];
  readonly state: "pending" | "approved" | "denied" | "expired" | "cancelled";
  readonly decision: ApprovalDecision | null;
  readonly decidedBy: PrincipalId | null;
  readonly decidedAt: Rfc3339Timestamp | null;
  readonly createdAt: Rfc3339Timestamp;
}

// ───────────────────────── Side effect (§28.6) ───────────────────────────────

export interface SideEffect {
  readonly id: Uuid7;
  readonly taskId: Uuid7;
  readonly kind: string;
  readonly state: SideEffectState;
  readonly idempotencyKey: string;
  readonly reconciliationQuery: string | null;
  readonly startedAt: Rfc3339Timestamp | null;
  readonly settledAt: Rfc3339Timestamp | null;
  readonly result: "settled" | "failed" | "manual_review_required" | "unknown" | null;
}

// ──────────────────────────── Job (§28.7) ────────────────────────────────────

export interface Job {
  readonly id: Uuid7;
  readonly taskId: Uuid7 | null;
  readonly spec: JobSpec;
  readonly state: JobState;
  readonly sandboxLeaseId: Uuid7 | null;
  readonly startedAt: Rfc3339Timestamp | null;
  readonly exitedAt: Rfc3339Timestamp | null;
  readonly exitCode: number | null;
  readonly stdoutArtifactHash: ContentHash | null;
  readonly stderrArtifactHash: ContentHash | null;
  readonly cleanupPolicy: "stop_on_release" | "persist";
}

export interface JobSpec {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly allocatePty: boolean;
  readonly sandboxProfileId: string;
}

// ─────────────────────────── Agent / Delegation ──────────────────────────────

export interface Agent {
  readonly id: Uuid7;
  readonly sessionId: Uuid7;
  readonly role: DelegationRole | "coordinator";
  readonly modelProfile: string;
  readonly worktreeId: string | null;
  readonly parentAgentId: Uuid7 | null;
  readonly state: "spawning" | "running" | "completed" | "failed" | "cancelled";
  readonly startedAt: Rfc3339Timestamp;
  readonly completedAt: Rfc3339Timestamp | null;
}

export interface Delegation {
  readonly id: Uuid7;
  readonly parentTaskId: Uuid7;
  readonly role: DelegationRole;
  readonly objective: string;
  readonly scope: AllowedScope;
  readonly nonGoals: readonly string[];
  readonly allowedReadPaths: readonly string[];
  readonly allowedWritePaths: readonly string[];
  readonly startingReferences: readonly ArtifactRef[];
  readonly requiredCapabilities: readonly string[];
  readonly forbiddenCapabilities: readonly string[];
  readonly acceptanceTests: readonly string[];
  readonly resultSchemaVersion: string;
  readonly budgets: DelegationBudgets;
  readonly stopConditions: readonly string[];
  readonly worktreeId: string | null;
  readonly status: DelegationResultStatus | "pending" | "running";
  readonly result: DelegationResult | null;
}

export interface DelegationBudgets {
  readonly inputTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly toolCalls: number;
  readonly costMicros: Micros;
  readonly wallClockSeconds: number;
}

export interface DelegationResult {
  readonly status: DelegationResultStatus;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly commit: string | null;
  readonly tests: readonly DelegationTestResult[];
  readonly findings: readonly string[];
  readonly risks: readonly string[];
  readonly unresolved: readonly string[];
  readonly artifacts: readonly ArtifactRef[];
  readonly actualBudget: Partial<DelegationBudgets>;
}

export interface DelegationTestResult {
  readonly command: string;
  readonly status: "passed" | "failed" | "skipped" | "error";
  readonly evidence: string | null;
  readonly sourceRevision: string;
}

// ─────────────────────── Verification (§40.1, §40.3) ─────────────────────────

export interface VerificationPlan {
  readonly id: Uuid7;
  readonly taskContractId: Uuid7;
  readonly taskContractVersion: number;
  readonly sourceRevision: string;
  readonly nodes: readonly VerificationNode[];
  readonly edges: readonly VerificationEdge[];
  readonly completionExpression: string;
  readonly createdAt: Rfc3339Timestamp;
}

export interface VerificationNode {
  readonly id: string;
  readonly kind: VerificationNodeKind;
  readonly required: boolean;
  readonly dependsOn: readonly string[];
  readonly specification: string;
  readonly timeout: number;
  readonly retryPolicy: VerificationRetryPolicy;
  readonly acceptanceCriterionId: string | null;
}

export interface VerificationEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "depends" | "invalidates";
}

export interface VerificationRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly flakeIdentity: string | null;
}

export interface VerificationResult {
  readonly id: Uuid7;
  readonly planId: Uuid7;
  readonly nodeId: string;
  readonly status: VerificationResultStatus;
  readonly startedAt: Rfc3339Timestamp;
  readonly completedAt: Rfc3339Timestamp | null;
  readonly sourceRevision: string;
  readonly environmentImageDigest: string | null;
  readonly commandOrQuery: string;
  readonly exitCode: number | null;
  readonly structuredObservations: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly ArtifactRef[];
  readonly toolCallId: Uuid7 | null;
  readonly verifierVersion: string;
  readonly reasonIfSkipped: string | null;
  readonly attempts: number;
}

export interface CompletionRecord {
  readonly taskId: Uuid7;
  readonly contractVersion: number;
  readonly finalRevision: string;
  readonly status: "completed";
  readonly criteria: readonly CompletionCriterion[];
  readonly verificationPlanId: Uuid7;
  readonly unresolvedRisks: readonly string[];
  readonly acceptedRisks: readonly string[];
  readonly externalEffects: readonly ArtifactRef[];
  readonly costMicros: Micros;
  readonly durationSeconds: number;
  readonly finalCheckpoint: ArtifactRef;
  readonly generatedAt: Rfc3339Timestamp;
}

export interface CompletionCriterion {
  readonly id: string;
  readonly status: "satisfied" | "unsatisfied" | "manual" | "unverifiable";
  readonly evidence: readonly ArtifactRef[];
  readonly reason: string | null;
}

/**
 * Detached reviewer finding (§37.11, §40.7). Lifecycle is enforced by
 * {@link ReviewFindingLifecycle} transitions; OPEN findings block completion
 * unless explicitly accepted as risk or marked out of scope.
 */
export interface ReviewFinding {
  readonly id: Uuid7;
  readonly taskId: Uuid7;
  readonly delegationId: Uuid7 | null;
  readonly verificationPlanId: Uuid7 | null;
  readonly title: string;
  readonly body: string;
  readonly severity: "info" | "low" | "medium" | "high" | "critical";
  readonly lifecycle: ReviewFindingLifecycle;
  readonly affectedPaths: readonly string[];
  readonly evidence: readonly ArtifactRef[];
  readonly createdAt: Rfc3339Timestamp;
  readonly updatedAt: Rfc3339Timestamp;
}

/**
 * Managed writer worktree lease (§37.8). Ownership is exclusive per path
 * prefix; exact-HEAD policy requires `baseRevision` match before merge.
 */
export interface WorktreeLease {
  readonly id: string;
  readonly taskId: Uuid7;
  readonly agentId: Uuid7 | null;
  readonly delegationId: Uuid7 | null;
  readonly path: string;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly ownedPathPrefixes: readonly string[];
  readonly status: "active" | "merging" | "merged" | "abandoned" | "conflict";
  readonly createdAt: Rfc3339Timestamp;
  readonly updatedAt: Rfc3339Timestamp;
}

// ───────────────────────── Memory claim (§39.3) ──────────────────────────────

export interface MemoryClaim {
  readonly id: Uuid7;
  readonly kind: MemoryClaimKind;
  readonly statement: string;
  readonly procedureArtifactHash: ContentHash | null;
  readonly scope: MemoryScope;
  readonly provenance: MemoryProvenance;
  readonly confidencePpm: number;
  readonly verification: MemoryVerification;
  readonly validity: MemoryValidity;
  readonly usage: MemoryUsage;
  readonly relations: MemoryRelations;
  readonly status: MemoryClaimStatus;
  readonly createdAt: Rfc3339Timestamp;
}

export interface MemoryScope {
  readonly organization: string | null;
  readonly user: PrincipalId | null;
  readonly workspaceId: Uuid7 | null;
  readonly pathPatterns: readonly string[];
}

export interface MemoryProvenance {
  readonly sources: readonly ArtifactRef[];
  readonly createdFromSession: Uuid7 | null;
  readonly createdFromTask: Uuid7 | null;
  readonly extractorModel: ModelKey | null;
  readonly extractorVersion: string;
}

export interface MemoryVerification {
  readonly lastVerifiedAt: Rfc3339Timestamp | null;
  readonly method: string | null;
  readonly evidence: readonly ArtifactRef[];
}

export interface MemoryValidity {
  readonly startsAt: Rfc3339Timestamp;
  readonly expiresAt: Rfc3339Timestamp | null;
  readonly invalidationRules: readonly InvalidationRule[];
}

export interface MemoryUsage {
  readonly count: number;
  readonly lastUsedAt: Rfc3339Timestamp | null;
  readonly successfulUses: number;
  readonly harmfulUses: number;
}

export interface MemoryRelations {
  readonly supports: readonly Uuid7[];
  readonly contradicts: readonly Uuid7[];
  readonly supersedes: readonly Uuid7[];
}

// ─────────────────────── Capability (§35.1, §35.2) ───────────────────────────

export interface CapabilityDescriptor {
  readonly id: string;
  readonly version: string;
  readonly kind: CapabilityKind;
  readonly source: string;
  readonly contentHash: ContentHash;
  readonly signature: string | null;
  readonly publisher: string | null;
  readonly trustLevel: CapabilityTrustLevel;
  readonly entrypoint: string | null;
  readonly operations: readonly string[];
  readonly filesystem: Readonly<Record<string, unknown>>;
  readonly network: Readonly<Record<string, unknown>>;
  readonly secrets: readonly string[];
  readonly subprocesses: Readonly<Record<string, unknown>>;
  readonly externalState: Readonly<Record<string, unknown>>;
  readonly resourceLimits: Readonly<Record<string, unknown>>;
  readonly modelVisibility: Readonly<Record<string, unknown>>;
  readonly configurationSchema: Readonly<Record<string, unknown>> | null;
  readonly compatibility: Readonly<Record<string, unknown>> | null;
  readonly lifecycle?: { readonly disableScripts?: boolean; readonly isolateEnvironment?: boolean };
  readonly toolSchemas?: readonly Readonly<Record<string, unknown>>[];
  readonly effectClassification?: readonly ("read_only" | "fs_mutate" | "network_egress" | "process_exec" | "secret_access")[];
}

export interface CapabilityActivation {
  readonly id: Uuid7;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly capabilityHash: ContentHash;
  readonly sessionId: Uuid7;
  readonly taskId: Uuid7 | null;
  readonly activatedBy: PrincipalId;
  readonly activatedAt: Rfc3339Timestamp;
  readonly deactivatedAt: Rfc3339Timestamp | null;
  readonly state: "active" | "deactivated" | "revoked";
}

// ──────────────────── Idempotency / Lease / Event ────────────────────────────

export interface IdempotencyRecord {
  readonly key: string;
  readonly principal: PrincipalId;
  readonly method: string;
  readonly requestHash: ContentHash;
  readonly responseArtifactHash: ContentHash | null;
  readonly terminalError: string | null;
  readonly state: "in_progress" | "settled" | "failed";
  readonly createdAt: Rfc3339Timestamp;
  readonly expiresAt: Rfc3339Timestamp;
}

export interface Lease {
  readonly id: Uuid7;
  readonly resource: string;
  readonly holder: string;
  readonly acquiredAt: Rfc3339Timestamp;
  readonly expiresAt: Rfc3339Timestamp;
  readonly releasedAt: Rfc3339Timestamp | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SemanticEvent {
  readonly eventId: Uuid7;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly occurredAt: Rfc3339Timestamp;
  readonly actor: SemanticEventActor;
  readonly correlationId: Uuid7 | null;
  readonly causationId: Uuid7 | null;
  readonly idempotencyKey: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly traceId: TraceId | null;
}

export interface SemanticEventActor {
  readonly kind: ActorKind;
  readonly id: string;
}

export interface EventStreamCursor {
  readonly cursor: CursorToken;
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
  readonly lastEventId: Uuid7;
  readonly lastSequence: number;
  readonly expiresAt: Rfc3339Timestamp;
}

// ────────────────────────── Checkpoint (§9.3) ────────────────────────────────

export interface Checkpoint {
  readonly id: Uuid7;
  readonly threadId: Uuid7;
  readonly turnId: Uuid7 | null;
  readonly episodeRange: { readonly from: number; readonly to: number };
  readonly artifactHash: ContentHash;
  readonly canonicalStateHash: ContentHash;
  readonly summary: string;
  /** Unsettled effects and approvals that must survive context compaction. */
  readonly effectState?: readonly {
    readonly effectId: string;
    readonly state: string;
    readonly idempotencyKey: string;
  }[] | undefined;
  readonly approvalState?: readonly {
    readonly approvalId: string;
    readonly state: string;
    readonly operationHash: string;
  }[] | undefined;
  readonly createdAt: Rfc3339Timestamp;
}

// ─────────────────────── Output profile helpers (§38.9) ──────────────────────

export interface OutputProfileConfig {
  readonly profile: OutputProfile;
  readonly stripBoilerplate: boolean;
}

export const outputProfileConfigSchema = z.object({
  profile: z.enum(["terse", "explanatory", "teaching", "structured"]),
  stripBoilerplate: z.boolean(),
});

// ─────────────────────── ARP v2 Canonical Aggregates ─────────────────────────

// 1. Organization & Federation (SPEC §4)

export interface Organization {
  readonly id: string;
  readonly displayName: string;
  readonly rootPolicyProfile: string;
  readonly createdAt: Rfc3339Timestamp;
}

export const organizationSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  rootPolicyProfile: z.string().min(1),
  createdAt: rfc3339Schema,
});

export interface Department {
  readonly id: string;
  readonly organizationId: string;
  readonly displayName: string;
  readonly policyProfile: string;
  readonly defaultOperatorId: string | null;
  readonly createdAt: Rfc3339Timestamp;
}

export const departmentSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  displayName: z.string().min(1),
  policyProfile: z.string().min(1),
  defaultOperatorId: z.string().nullable(),
  createdAt: rfc3339Schema,
});

export interface OperatorAgent {
  readonly id: string;
  readonly departmentId: string;
  readonly displayName: string;
  readonly capabilityScope: readonly string[];
  readonly modelProfile: string;
  readonly active: boolean;
}

export const operatorAgentSchema = z.object({
  id: z.string().min(1),
  departmentId: z.string().min(1),
  displayName: z.string().min(1),
  capabilityScope: z.array(z.string()),
  modelProfile: z.string().min(1),
  active: z.boolean(),
});

// 2. Resource Handle (SPEC §11)

export interface ResourceHandle {
  readonly objectId: string;
  readonly objectType: string;
  readonly version: number;
  readonly scope: readonly string[];
  readonly allowedOperations: readonly string[];
  readonly principalBinding: string;
  readonly taskBinding: string;
  readonly authorityEpoch: number;
  readonly provenance: string;
  readonly trustLabel: string;
  readonly expiry: Rfc3339Timestamp | null;
  readonly integrityHash: string;
}

export const resourceHandleSchema = z.object({
  objectId: z.string().min(1),
  objectType: z.string().min(1),
  version: z.number().int().nonnegative(),
  scope: z.array(z.string().min(1)),
  allowedOperations: z.array(z.string().min(1)),
  principalBinding: z.string().min(1),
  taskBinding: z.string().min(1),
  authorityEpoch: z.number().int().nonnegative(),
  provenance: z.string().min(1),
  trustLabel: z.string().min(1),
  expiry: rfc3339Schema.nullable(),
  integrityHash: contentHashSchema,
}).strict();

// 3. Claims & Evidence (SPEC §6, §28)

export interface Claim {
  readonly id: string;
  readonly taskId: string;
  readonly statement: string;
  readonly requiredEvidenceKind: string;
  readonly status: "PROPOSED" | "SATISFIED" | "DISPUTED" | "WAIVED";
  readonly evidenceIds: readonly string[];
  readonly waivedRationale: string | null;
  readonly createdAt: Rfc3339Timestamp;
  readonly updatedAt: Rfc3339Timestamp;
}

export const claimSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  statement: z.string().min(1),
  requiredEvidenceKind: z.string().min(1),
  status: z.enum(["PROPOSED", "SATISFIED", "DISPUTED", "WAIVED"]),
  evidenceIds: z.array(z.string()),
  waivedRationale: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface Evidence {
  readonly id: string;
  readonly claimId: string;
  readonly kind: string;
  readonly summary: string;
  readonly sourceRevision: string | null;
  readonly environmentHash: string | null;
  readonly verifierResult: string;
  readonly artifactRef: ArtifactRef | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly observedAt: Rfc3339Timestamp;
}

export const evidenceSchema = z.object({
  id: z.string().min(1),
  claimId: z.string().min(1),
  kind: z.string().min(1),
  summary: z.string().min(1),
  sourceRevision: z.string().nullable(),
  environmentHash: z.string().nullable(),
  verifierResult: z.string().min(1),
  artifactRef: artifactRefSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  observedAt: z.string(),
});

// 4. Mission & Task v2 (SPEC §6, §7)

export interface Mission {
  readonly id: string;
  readonly organizationId: string;
  readonly departmentId: string;
  readonly createdBy: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly createdAt: Rfc3339Timestamp;
}

export const missionSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  departmentId: z.string().min(1),
  createdBy: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string()),
  createdAt: z.string(),
});

export interface TaskContractV2 {
  readonly version: number;
  readonly mission: string;
  readonly scope: {
    readonly resources: readonly ResourceHandle[];
    readonly allowedEffectClasses: readonly string[];
    readonly excludedPathsOrSystems: readonly string[];
    readonly pathScope?: {
      readonly readPaths: readonly string[];
      readonly writePaths: readonly string[];
      readonly externalSystems: readonly string[];
    } | undefined;
  };
  readonly acceptance: readonly {
    readonly claimId: string;
    readonly statement: string;
    readonly evidenceRequirement: string;
  }[];
  readonly constraints: {
    readonly security: readonly string[];
    readonly costMicros: bigint;
    readonly timeoutSeconds: number;
  };
  readonly authorityCeiling: readonly string[];
  readonly mode: string;
}

export const taskContractV2Schema = z.object({
  version: z.number().int().positive(),
  mission: z.string().min(1),
  scope: z.object({
    resources: z.array(resourceHandleSchema),
    allowedEffectClasses: z.array(z.string()),
    excludedPathsOrSystems: z.array(z.string()),
    pathScope: z.object({
      readPaths: z.array(z.string()),
      writePaths: z.array(z.string()),
      externalSystems: z.array(z.string()),
    }).optional(),
  }),
  acceptance: z.array(
    z.object({
      claimId: z.string().min(1),
      statement: z.string().min(1),
      evidenceRequirement: z.string().min(1),
    }),
  ),
  constraints: z.object({
    security: z.array(z.string()),
    costMicros: z.bigint().nonnegative(),
    timeoutSeconds: z.number().int().positive(),
  }),
  authorityCeiling: z.array(z.string()),
  mode: z.string().min(1),
});

/** Durable context required to open an interactive task in its exact conversation. */
export interface TaskConversationContextV2 {
  readonly sessionId: string;
  readonly threadId: string;
  readonly attachedAt: Rfc3339Timestamp;
}

export const taskConversationContextV2Schema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  attachedAt: z.string(),
});

export interface TaskV2 {
  readonly id: string;
  readonly missionId: string | null;
  readonly organizationId: string;
  readonly departmentId: string;
  readonly createdBy: string;
  readonly conversationContext?: TaskConversationContextV2 | null;
  readonly contract: TaskContractV2;
  readonly status:
    | "DRAFT"
    | "READY"
    | "RUNNING"
    | "WAITING_USER"
    | "WAITING_AUTH"
    | "WAITING_RESOURCE"
    | "PAUSED"
    | "VERIFYING"
    | "COMPLETED"
    | "PARTIAL"
    | "BLOCKED"
    | "CANCELLED"
    | "FAILED";
  readonly version: number;
  readonly createdAt: Rfc3339Timestamp;
  readonly updatedAt: Rfc3339Timestamp;
  readonly completedAt: Rfc3339Timestamp | null;
}

export const taskV2Schema = z.object({
  id: z.string().min(1),
  missionId: z.string().nullable(),
  organizationId: z.string().min(1),
  departmentId: z.string().min(1),
  createdBy: z.string().min(1),
  conversationContext: taskConversationContextV2Schema.nullable().default(null),
  contract: taskContractV2Schema,
  status: z.enum([
    "DRAFT",
    "READY",
    "RUNNING",
    "WAITING_USER",
    "WAITING_AUTH",
    "WAITING_RESOURCE",
    "PAUSED",
    "VERIFYING",
    "COMPLETED",
    "PARTIAL",
    "BLOCKED",
    "CANCELLED",
    "FAILED",
  ]),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});

// 5. Workflow IR Entities (SPEC §8)

export interface SourceSpan {
  readonly sourcePath: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly text: string;
}

export const sourceSpanSchema = z.object({
  sourcePath: z.string().min(1),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  text: z.string(),
});

export interface AmbiguityStatus {
  readonly isAmbiguous: boolean;
  readonly reason?: string | undefined;
  readonly requiredJudgment: "model" | "human";
}

export const ambiguityStatusSchema = z.object({
  isAmbiguous: z.boolean(),
  reason: z.string().optional(),
  requiredJudgment: z.enum(["model", "human"]),
});

export interface TrustRequirement {
  readonly minTrustLevel: string;
  readonly requiredSignatures?: readonly string[] | undefined;
}

export const trustRequirementSchema = z.object({
  minTrustLevel: z.string().min(1),
  requiredSignatures: z.array(z.string()).optional(),
});

export interface Predicate {
  readonly expression: string;
  readonly dialect: "json_logic" | "predicate_expr" | "deterministic";
  readonly deterministic: boolean;
}

export const predicateSchema = z.object({
  expression: z.string().min(1),
  dialect: z.enum(["json_logic", "predicate_expr", "deterministic"]).default("predicate_expr"),
  deterministic: z.boolean().default(true),
});

export interface EvidenceRequirement {
  readonly claimId: string;
  readonly schema: string;
  readonly verifierKind: string;
}

export const evidenceRequirementSchema = z.object({
  claimId: z.string().min(1),
  schema: z.string().min(1),
  verifierKind: z.string().min(1),
});

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly backoffMs: number;
  readonly nonRetryableErrors?: readonly string[] | undefined;
}

export const retryPolicySchema = z.object({
  maxRetries: z.number().int().nonnegative().default(0),
  backoffMs: z.number().int().nonnegative().default(1000),
  nonRetryableErrors: z.array(z.string()).optional(),
});

export interface ResourceBudget {
  readonly maxCostMicros?: string | undefined;
  readonly maxTokens?: number | undefined;
  readonly maxWallClockSeconds?: number | undefined;
}

export const resourceBudgetSchema = z.object({
  maxCostMicros: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxWallClockSeconds: z.number().int().positive().optional(),
});

export interface TaintPolicy {
  readonly allowTaintedInputs: boolean;
  readonly sanitizeWith?: string | undefined;
  readonly sinkClassification?: string | undefined;
}

export const taintPolicySchema = z.object({
  allowTaintedInputs: z.boolean().default(false),
  sanitizeWith: z.string().optional(),
  sinkClassification: z.string().optional(),
});

export interface WitnessPath {
  readonly pathId: string;
  readonly nodeIds: readonly string[];
  readonly coversMandatorySteps: readonly string[];
}

export const witnessPathSchema = z.object({
  pathId: z.string().min(1),
  nodeIds: z.array(z.string()),
  coversMandatorySteps: z.array(z.string()),
});

export interface StaticValidationError {
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string | undefined;
  readonly edge?: { readonly sourceNodeId: string; readonly targetNodeId: string } | undefined;
  readonly sourceSpan?: SourceSpan | undefined;
}

export const staticValidationErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  nodeId: z.string().optional(),
  edge: z.object({ sourceNodeId: z.string(), targetNodeId: z.string() }).optional(),
  sourceSpan: sourceSpanSchema.optional(),
});

export interface StaticValidationWarning {
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string | undefined;
  readonly sourceSpan?: SourceSpan | undefined;
}

export const staticValidationWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  nodeId: z.string().optional(),
  sourceSpan: sourceSpanSchema.optional(),
});

export interface StaticValidationReport {
  readonly valid: boolean;
  readonly errors: readonly StaticValidationError[];
  readonly warnings: readonly StaticValidationWarning[];
  readonly reachability: {
    readonly allReachable: boolean;
    readonly unreachableNodeIds: readonly string[];
    readonly deadEndNodeIds: readonly string[];
  };
  readonly loopBounds: {
    readonly hasCycles: boolean;
    readonly bounded: boolean;
    readonly unboundedCycleNodeIds: readonly string[];
  };
  readonly taintFlow: {
    readonly safe: boolean;
    readonly violations: readonly string[];
  };
  readonly witnessPaths: readonly WitnessPath[];
}

export const staticValidationReportSchema = z.object({
  valid: z.boolean(),
  errors: z.array(staticValidationErrorSchema),
  warnings: z.array(staticValidationWarningSchema),
  reachability: z.object({
    allReachable: z.boolean(),
    unreachableNodeIds: z.array(z.string()),
    deadEndNodeIds: z.array(z.string()),
  }),
  loopBounds: z.object({
    hasCycles: z.boolean(),
    bounded: z.boolean(),
    unboundedCycleNodeIds: z.array(z.string()),
  }),
  taintFlow: z.object({
    safe: z.boolean(),
    violations: z.array(z.string()),
  }),
  witnessPaths: z.array(witnessPathSchema),
});

export interface GuardedEdge {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly condition: string | null;
  readonly conditionType?: "deterministic" | "model_predicate" | undefined;
  readonly sourceSpan?: SourceSpan | null | undefined;
}

export const guardedEdgeSchema = z.object({
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  condition: z.string().nullable(),
  conditionType: z.enum(["deterministic", "model_predicate"]).optional().default("deterministic"),
  sourceSpan: sourceSpanSchema.nullable().optional(),
});

export interface WorkflowNode {
  readonly id: string;
  readonly kind:
    | "deterministic"
    | "model_judgment"
    | "human"
    | "connector"
    | "effect"
    | "verifier"
    | "subworkflow";
  readonly owner: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly requiredCapabilities: readonly string[];
  readonly trustInputs?: readonly TrustRequirement[] | undefined;
  readonly preconditions?: readonly Predicate[] | undefined;
  readonly postconditions?: readonly Predicate[] | undefined;
  readonly effectClass: string | null;
  readonly evidenceRequirements?: readonly EvidenceRequirement[] | undefined;
  readonly retryPolicy?: RetryPolicy | undefined;
  readonly timeoutSeconds: number;
  readonly budget?: ResourceBudget | undefined;
  readonly compensationNodeId: string | null;
  readonly sourceSpan?: SourceSpan | null | undefined;
  readonly ambiguityStatus?: AmbiguityStatus | null | undefined;
  readonly taintPolicy?: TaintPolicy | undefined;
}

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "deterministic",
    "model_judgment",
    "human",
    "connector",
    "effect",
    "verifier",
    "subworkflow",
  ]),
  owner: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  outputs: z.record(z.string(), z.unknown()).default({}),
  requiredCapabilities: z.array(z.string()).default([]),
  trustInputs: z.array(trustRequirementSchema).optional(),
  preconditions: z.array(predicateSchema).optional(),
  postconditions: z.array(predicateSchema).optional(),
  effectClass: z.string().nullable().default(null),
  evidenceRequirements: z.array(evidenceRequirementSchema).optional(),
  retryPolicy: retryPolicySchema.optional(),
  timeoutSeconds: z.number().int().positive().default(60),
  budget: resourceBudgetSchema.optional(),
  compensationNodeId: z.string().nullable().default(null),
  sourceSpan: sourceSpanSchema.nullable().optional(),
  ambiguityStatus: ambiguityStatusSchema.nullable().optional(),
  taintPolicy: taintPolicySchema.optional(),
});

export interface WorkflowSourceProvenance {
  readonly sourceKind: "skill_markdown" | "prose_spec" | "json_ir" | "yaml_workflow" | "model_generated";
  readonly sourcePath?: string | undefined;
  readonly sourceHash?: string | undefined;
  readonly compilerVersion: string;
}

export const workflowSourceProvenanceSchema = z.object({
  sourceKind: z.enum(["skill_markdown", "prose_spec", "json_ir", "yaml_workflow", "model_generated"]),
  sourcePath: z.string().optional(),
  sourceHash: z.string().optional(),
  compilerVersion: z.string().min(1),
});

export interface Workflow {
  readonly id: string;
  readonly version: number;
  readonly taskId: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly GuardedEdge[];
  readonly sourceProvenance?: WorkflowSourceProvenance | undefined;
  readonly staticAnalysis?: StaticValidationReport | undefined;
  readonly createdAt: Rfc3339Timestamp;
}

export const workflowSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  taskId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(guardedEdgeSchema),
  sourceProvenance: workflowSourceProvenanceSchema.optional(),
  staticAnalysis: staticValidationReportSchema.optional(),
  createdAt: z.string(),
});

export interface NodeRun {
  readonly id: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
  readonly retryCount?: number | undefined;
  readonly startedAt: Rfc3339Timestamp | null;
  readonly settledAt: Rfc3339Timestamp | null;
}

export const nodeRunSchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
  status: z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
  inputs: z.record(z.string(), z.unknown()).default({}),
  outputs: z.record(z.string(), z.unknown()).nullable().default(null),
  error: z.string().nullable().default(null),
  retryCount: z.number().int().nonnegative().optional().default(0),
  startedAt: z.string().nullable().default(null),
  settledAt: z.string().nullable().default(null),
});

// 6. Transactional Effect Record & Authorization Instance (SPEC §14, §16)

export interface AuthorizationInstance {
  readonly id: string;
  readonly principal: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly effectClass: string;
  readonly maxScope: readonly string[];
  readonly useLimit: number;
  readonly consumedCount: number;
  readonly expiry: Rfc3339Timestamp;
  readonly humanApprovalId: string | null;
  readonly approvalHash: string | null;
}

export const authorizationInstanceSchema = z.object({
  id: z.string().min(1),
  principal: z.string().min(1),
  taskId: z.string().min(1),
  taskVersion: z.number().int().nonnegative(),
  effectClass: z.string().min(1),
  maxScope: z.array(z.string()),
  useLimit: z.number().int().positive(),
  consumedCount: z.number().int().nonnegative(),
  expiry: z.string(),
  humanApprovalId: z.string().nullable(),
  approvalHash: z.string().nullable().default(null),
});

export interface ApprovalPresentation {
  readonly approvalId: string;
  readonly taskId: string;
  readonly semanticAction: string;
  readonly targetResource: string;
  readonly dataLeavingSystem: readonly string[];
  readonly identityUsed: string;
  readonly reversibility: "REVERSIBLE" | "COMPENSABLE" | "IRREVERSIBLE" | "READ_ONLY" | "UNKNOWN";
  readonly consequences: string;
  readonly evidencePreconditions: readonly string[];
  readonly exactScope: readonly string[];
  readonly durationSeconds: number;
  readonly reason: string;
  readonly approvalHash: string;
}

export const approvalPresentationSchema = z.object({
  approvalId: z.string().min(1),
  taskId: z.string().min(1),
  semanticAction: z.string().min(1),
  targetResource: z.string().min(1),
  dataLeavingSystem: z.array(z.string()).default([]),
  identityUsed: z.string().min(1),
  reversibility: z.enum(["REVERSIBLE", "COMPENSABLE", "IRREVERSIBLE", "READ_ONLY", "UNKNOWN"]),
  consequences: z.string().min(1),
  evidencePreconditions: z.array(z.string()).default([]),
  exactScope: z.array(z.string()).default([]),
  durationSeconds: z.number().int().nonnegative().default(300),
  reason: z.string().min(1),
  approvalHash: z.string().min(1),
});

export interface SequencePolicyRule {
  readonly id: string;
  readonly description: string;
  readonly targetEffectType: string;
  readonly requiredPrecedingEvents: readonly string[];
  readonly requiredAdmittedClaims: readonly string[];
  readonly separationOfDuty: boolean;
  readonly enforcement: "HARD_DENY" | "PROMPT" | "WARN";
}

export const sequencePolicyRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  targetEffectType: z.string().min(1),
  requiredPrecedingEvents: z.array(z.string()).default([]),
  requiredAdmittedClaims: z.array(z.string()).default([]),
  separationOfDuty: z.boolean().default(false),
  enforcement: z.enum(["HARD_DENY", "PROMPT", "WARN"]).default("HARD_DENY"),
});

export interface EffectRecord {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly principal: string;
  readonly connectorOrWorker: string;
  readonly intentType: string;
  readonly canonicalParameters: Readonly<Record<string, unknown>>;
  readonly resourceHandles: readonly ResourceHandle[];
  readonly effectClass: string;
  readonly semanticIdempotencyKey: string;
  readonly authorizationId: string | null;
  readonly policyDecisionId: string | null;
  readonly state:
    | "PROPOSED"
    | "POLICY_CHECKED"
    | "AUTHORIZATION_REQUIRED"
    | "AUTHORIZED"
    | "PREPARED"
    | "DISPATCHED"
    | "OBSERVED"
    | "VALIDATED"
    | "COMMITTED"
    | "DENIED"
    | "CANCELLED"
    | "UNCERTAIN"
    | "RECONCILING"
    | "COMPENSATING"
    | "COMPENSATED"
    | "RESIDUE"
    | "MANUAL_RECONCILE";
  readonly uncertaintyReason: string | null;
  readonly compensationRef: string | null;
  readonly version: number;
  readonly createdAt: Rfc3339Timestamp;
  readonly settledAt: Rfc3339Timestamp | null;
}

export const effectRecordSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  principal: z.string().min(1),
  connectorOrWorker: z.string().min(1),
  intentType: z.string().min(1),
  canonicalParameters: z.record(z.string(), z.unknown()),
  resourceHandles: z.array(resourceHandleSchema),
  effectClass: z.string().min(1),
  semanticIdempotencyKey: z.string().min(1),
  authorizationId: z.string().nullable(),
  policyDecisionId: z.string().nullable(),
  state: z.enum([
    "PROPOSED",
    "POLICY_CHECKED",
    "AUTHORIZATION_REQUIRED",
    "AUTHORIZED",
    "PREPARED",
    "DISPATCHED",
    "OBSERVED",
    "VALIDATED",
    "COMMITTED",
    "DENIED",
    "CANCELLED",
    "UNCERTAIN",
    "RECONCILING",
    "COMPENSATING",
    "COMPENSATED",
    "RESIDUE",
    "MANUAL_RECONCILE",
  ]),
  uncertaintyReason: z.string().nullable(),
  compensationRef: z.string().nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  settledAt: z.string().nullable(),
});

// 7. Questions, Decisions, Risks & Attention (SPEC §4.2, §29.3)

export interface Question {
  readonly id: string;
  readonly taskId: string;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly selectedOption: string | null;
  readonly rationale: string | null;
  readonly status: "PENDING" | "ANSWERED" | "DISMISSED";
  readonly createdAt: Rfc3339Timestamp;
  readonly resolvedAt: Rfc3339Timestamp | null;
}

export const questionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  prompt: z.string().min(1),
  options: z.array(z.string()).default([]),
  selectedOption: z.string().nullable().default(null),
  rationale: z.string().nullable().default(null),
  status: z.enum(["PENDING", "ANSWERED", "DISMISSED"]),
  createdAt: z.string(),
  resolvedAt: z.string().nullable().default(null),
});

export interface Decision {
  readonly id: string;
  readonly taskId: string;
  readonly questionId: string | null;
  readonly statement: string;
  readonly alternativesConsidered: readonly string[];
  readonly rationale: string;
  readonly provenance: string;
  readonly recordedAt: Rfc3339Timestamp;
}

export const decisionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  questionId: z.string().nullable().default(null),
  statement: z.string().min(1),
  alternativesConsidered: z.array(z.string()).default([]),
  rationale: z.string().min(1),
  provenance: z.string().min(1),
  recordedAt: z.string(),
});

export interface Risk {
  readonly id: string;
  readonly taskId: string;
  readonly riskClass: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  readonly statement: string;
  readonly mitigation: string | null;
  readonly status: "IDENTIFIED" | "MITIGATED" | "ACCEPTED" | "TRIGGERED";
  readonly recordedAt: Rfc3339Timestamp;
}

export const riskSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  riskClass: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]),
  statement: z.string().min(1),
  mitigation: z.string().nullable().default(null),
  status: z.enum(["IDENTIFIED", "MITIGATED", "ACCEPTED", "TRIGGERED"]),
  recordedAt: z.string(),
});

// 8. Worker Leases & Fencing Epochs (SPEC §10, §14)

export interface WorkerLease {
  readonly id: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly status: LeaseStatus;
  readonly acquiredAt: Rfc3339Timestamp;
  readonly expiresAt: Rfc3339Timestamp;
  readonly releasedAt: Rfc3339Timestamp | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export const workerLeaseSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  workerId: z.string().min(1),
  fencingToken: z.number().int().positive(),
  status: z.enum(["ACQUIRED", "RENEWED", "RELEASED", "EXPIRED", "FENCED"]),
  acquiredAt: z.string(),
  expiresAt: z.string(),
  releasedAt: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

// 9. Task Attempt & Execution Lifecycle (SPEC §5, §6)

export interface TaskAttempt {
  readonly id: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly status: AttemptStatus;
  readonly startedAt: Rfc3339Timestamp;
  readonly settledAt: Rfc3339Timestamp | null;
  readonly error: string | null;
}

export const taskAttemptSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  workerId: z.string().min(1),
  fencingToken: z.number().int().positive(),
  status: z.enum(["STARTING", "RUNNING", "RECOVERING", "COMPLETED", "FAILED", "ABORTED"]),
  startedAt: z.string(),
  settledAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

// 10. Transactional Outbox & Inbox (SPEC §10, §29)

export interface OutboxMessage {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string | null;
  readonly createdAt: Rfc3339Timestamp;
  readonly publishedAt: Rfc3339Timestamp | null;
  readonly delivered: boolean;
}

export const outboxMessageSchema = z.object({
  id: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  eventType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().nullable().default(null),
  createdAt: z.string(),
  publishedAt: z.string().nullable().default(null),
  delivered: z.boolean().default(false),
});

export interface InboxMessage {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly source: string;
  readonly messageType: string;
  readonly payloadHash: string;
  readonly receivedAt: Rfc3339Timestamp;
  readonly processedAt: Rfc3339Timestamp | null;
  readonly status: "PENDING" | "PROCESSED" | "FAILED" | "DUPLICATE";
}

export const inboxMessageSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  source: z.string().min(1),
  messageType: z.string().min(1),
  payloadHash: z.string().min(1),
  receivedAt: z.string(),
  processedAt: z.string().nullable().default(null),
  status: z.enum(["PENDING", "PROCESSED", "FAILED", "DUPLICATE"]),
});

// 11. Budget Consumption Tracking (SPEC §37.2, §46.9)

export interface BudgetConsumption {
  readonly taskId: string;
  readonly consumedCostMicros: bigint;
  readonly consumedComputeSeconds: number;
  readonly consumedInputTokens: bigint;
  readonly consumedOutputTokens: bigint;
  readonly consumedApprovals: number;
  readonly lastUpdatedAt: Rfc3339Timestamp;
}

export const budgetConsumptionSchema = z.object({
  taskId: z.string().min(1),
  consumedCostMicros: z.bigint().nonnegative(),
  consumedComputeSeconds: z.number().int().nonnegative(),
  consumedInputTokens: z.bigint().nonnegative(),
  consumedOutputTokens: z.bigint().nonnegative(),
  consumedApprovals: z.number().int().nonnegative(),
  lastUpdatedAt: z.string(),
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Phase 8: Model Profiles, Stage-Aware Routing & Orchestration (SPEC §26, §27)
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelProfile {
  readonly id: string;
  /** Opaque reference resolved by the provider registry. */
  readonly adapterRef: string;
  /** Opaque reference resolved only inside the selected provider package. */
  readonly renderingProfileRef: string;
  readonly modelKey: string;
  readonly version: string;
  /** Opaque model-family reference used for independent-review diversity. */
  readonly modelFamilyRef: string;
  readonly economics: {
    readonly inputMicrosPerMillion: Micros;
    readonly cachedInputMicrosPerMillion: Micros;
    readonly outputMicrosPerMillion: Micros;
    readonly reasoningAccounting: boolean;
  };
  readonly latencyModel: {
    readonly p50Ms: number;
    readonly p90Ms: number;
    readonly p99Ms: number;
    readonly ttftMs: number;
  };
  readonly allowedConfidentiality: readonly ConfidentialityLabel[];
  readonly capabilities: {
    readonly codingQuality: "low" | "medium" | "high";
    readonly toolReliability: "low" | "medium" | "high";
    readonly structuredOutput: boolean;
    readonly imageInput: boolean;
    readonly advertisedContextTokens: number;
    readonly testedSafeContextTokens: number;
    readonly securityReasoning: "low" | "medium" | "high";
    readonly reasoningStrength: "none" | "low" | "medium" | "high";
    readonly offlineExecution: boolean;
  };
}

export const modelProfileSchema = z
  .object({
    id: z.string().min(1),
    adapterRef: z.string().min(1),
    renderingProfileRef: z.string().min(1),
    modelKey: z.string().min(1),
    version: z.string().min(1),
    modelFamilyRef: z.string().min(1),
    economics: z
      .object({
        inputMicrosPerMillion: microsSchema.refine((value) => value >= 0n),
        cachedInputMicrosPerMillion: microsSchema.refine(
          (value) => value >= 0n,
        ),
        outputMicrosPerMillion: microsSchema.refine((value) => value >= 0n),
        reasoningAccounting: z.boolean(),
      })
      .strict(),
    latencyModel: z
      .object({
        p50Ms: z.number().nonnegative(),
        p90Ms: z.number().nonnegative(),
        p99Ms: z.number().nonnegative(),
        ttftMs: z.number().nonnegative(),
      })
      .strict()
      .refine(({ p50Ms, p90Ms, p99Ms }) => p50Ms <= p90Ms && p90Ms <= p99Ms, {
        message: "latency percentiles must be ordered p50 <= p90 <= p99",
      }),
    allowedConfidentiality: z.array(
      z.enum(["public", "workspace", "secret_adjacent", "secret"]),
    ),
    capabilities: z
      .object({
        codingQuality: z.enum(["low", "medium", "high"]),
        toolReliability: z.enum(["low", "medium", "high"]),
        structuredOutput: z.boolean(),
        imageInput: z.boolean(),
        advertisedContextTokens: z.number().int().positive(),
        testedSafeContextTokens: z.number().int().positive(),
        securityReasoning: z.enum(["low", "medium", "high"]),
        reasoningStrength: z.enum(["none", "low", "medium", "high"]),
        offlineExecution: z.boolean(),
      })
      .strict()
      .refine(
        ({ advertisedContextTokens, testedSafeContextTokens }) =>
          testedSafeContextTokens <= advertisedContextTokens,
        {
          message: "tested safe context must not exceed the advertised context",
        },
      ),
  })
  .strict();

export interface RouteDecisionV2 {
  readonly stage: "classifier" | "implementer" | "reviewer" | "specialist" | "vision" | "local_safe";
  readonly chosenProfileId: string | null;
  readonly chosenModelKey: string | null;
  readonly reason: string;
  readonly candidateScores: Readonly<Record<string, number>>;
  readonly fallbackProfileIds: readonly string[];
  readonly expectedCostMicros: bigint;
  readonly expectedLatencyMs: number;
  readonly timestamp: Rfc3339Timestamp;
}

export const routeDecisionV2Schema = z.object({
  stage: z.enum(["classifier", "implementer", "reviewer", "specialist", "vision", "local_safe"]),
  chosenProfileId: z.string().nullable(),
  chosenModelKey: z.string().nullable(),
  reason: z.string().min(1),
  candidateScores: z.record(z.string(), z.number()),
  fallbackProfileIds: z.array(z.string()),
  expectedCostMicros: z.bigint().nonnegative(),
  expectedLatencyMs: z.number().nonnegative(),
  timestamp: rfc3339Schema,
});

export interface ModelCohortPosterior {
  readonly modelKey: string;
  readonly toolCallAlpha: number;
  readonly toolCallBeta: number;
  readonly structuredOutputAlpha: number;
  readonly structuredOutputBeta: number;
  readonly editCohortAlpha: number;
  readonly editCohortBeta: number;
  readonly latencyLogMean: number;
  readonly latencyLogVariance: number;
  readonly observedCostMicros: bigint;
  readonly observedCacheHitRate: number;
  readonly sampleCount: number;
  readonly lastUpdated: Rfc3339Timestamp;
}

export const modelCohortPosteriorSchema = z.object({
  modelKey: z.string().min(1),
  toolCallAlpha: z.number().positive(),
  toolCallBeta: z.number().positive(),
  structuredOutputAlpha: z.number().positive(),
  structuredOutputBeta: z.number().positive(),
  editCohortAlpha: z.number().positive(),
  editCohortBeta: z.number().positive(),
  latencyLogMean: z.number(),
  latencyLogVariance: z.number().positive(),
  observedCostMicros: z.bigint().nonnegative(),
  observedCacheHitRate: z.number().min(0).max(1),
  sampleCount: z.number().int().nonnegative(),
  lastUpdated: z.string(),
});

export interface DelegationContractV2 {
  readonly id: string;
  readonly parentTaskId: string;
  readonly role: "scout" | "implementer" | "reviewer" | "specialist";
  readonly objective: string;
  readonly authorityCeiling: {
    readonly allowedOperations: readonly string[];
    readonly allowedPaths: readonly string[];
    readonly deniedEffects: readonly string[];
  };
  readonly inputHandles: readonly string[];
  readonly expectedValue: number;
  readonly outputSchemaVersion: string;
  readonly evidenceRequirements: readonly string[];
  readonly budgetMicros: bigint;
  readonly deadline: string | null;
  readonly writeIsolation: "worktree" | "read_only" | "ephemeral_branch";
  readonly returnRoute: string;
}

export const delegationContractV2Schema = z.object({
  id: z.string().min(1),
  parentTaskId: z.string().min(1),
  role: z.enum(["scout", "implementer", "reviewer", "specialist"]),
  objective: z.string().min(1),
  authorityCeiling: z.object({
    allowedOperations: z.array(z.string()),
    allowedPaths: z.array(z.string()),
    deniedEffects: z.array(z.string()),
  }),
  inputHandles: z.array(z.string()),
  expectedValue: z.number(),
  outputSchemaVersion: z.string().min(1),
  evidenceRequirements: z.array(z.string()),
  budgetMicros: z.bigint().nonnegative(),
  deadline: z.string().nullable(),
  writeIsolation: z.enum(["worktree", "read_only", "ephemeral_branch"]),
  returnRoute: z.string().min(1),
});

export interface StagnationReport {
  readonly taskId: string;
  readonly stagnationScore: number;
  readonly detectedSignals: readonly string[];
  readonly turnCount: number;
  readonly budgetBurnRatio: number;
  readonly recommendedIntervention:
    | "none"
    | "warn"
    | "force_checkpoint"
    | "change_strategy"
    | "spawn_scout"
    | "spawn_critic"
    | "request_user_decision"
    | "pause_for_intervention"
    | "terminate";
  readonly rationale: string;
  readonly timestamp: Rfc3339Timestamp;
}

export const stagnationReportSchema = z.object({
  taskId: z.string().min(1),
  stagnationScore: z.number().min(0).max(1),
  detectedSignals: z.array(z.string()),
  turnCount: z.number().int().nonnegative(),
  budgetBurnRatio: z.number().min(0).max(1),
  recommendedIntervention: z.enum([
    "none",
    "warn",
    "force_checkpoint",
    "change_strategy",
    "spawn_scout",
    "spawn_critic",
    "request_user_decision",
    "pause_for_intervention",
    "terminate",
  ]),
  rationale: z.string().min(1),
  timestamp: rfc3339Schema,
});

export interface ProviderContinuation {
  readonly id: string;
  readonly taskId: string;
  readonly modelKey: string;
  readonly inputManifestHash: string;
  readonly toolStateEpoch: number;
  readonly continuationToken: string | null;
  readonly retryCount: number;
  readonly lastFailureKind: string | null;
  readonly createdAt: Rfc3339Timestamp;
}

export const providerContinuationSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  modelKey: z.string().min(1),
  inputManifestHash: z.string().min(1),
  toolStateEpoch: z.number().int().nonnegative(),
  continuationToken: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
  lastFailureKind: z.string().nullable(),
  createdAt: rfc3339Schema,
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Phase 9: Unified Clients, Operator Cockpit & Attention (SPEC §1, §4, §16, §29, §33)
// ─────────────────────────────────────────────────────────────────────────────

// 13.1 Organization Topology & Agent Rooms (SPEC §4, §16.1)
export interface AgentRoom {
  readonly id: string;
  readonly departmentId: string;
  readonly name: string;
  readonly operatorId: string;
  readonly activeWorkerIds: readonly string[];
  readonly specialistIds: readonly string[];
  readonly reviewerIds: readonly string[];
  readonly supervisorId: string | null;
  readonly createdAt: Rfc3339Timestamp;
}

export const agentRoomSchema = z.object({
  id: z.string().min(1),
  departmentId: z.string().min(1),
  name: z.string().min(1),
  operatorId: z.string().min(1),
  activeWorkerIds: z.array(z.string()),
  specialistIds: z.array(z.string()),
  reviewerIds: z.array(z.string()),
  supervisorId: z.string().nullable(),
  createdAt: rfc3339Schema,
});

export interface CapabilityDirectoryEntry {
  readonly id: string;
  readonly capabilityId: string;
  readonly category: string;
  readonly providerOperatorId: string;
  readonly resourceDomain: string;
  readonly authorityRequirement: readonly string[];
  readonly status: "AVAILABLE" | "RESTRICTED" | "OFFLINE";
}

export const capabilityDirectoryEntrySchema = z.object({
  id: z.string().min(1),
  capabilityId: z.string().min(1),
  category: z.string().min(1),
  providerOperatorId: z.string().min(1),
  resourceDomain: z.string().min(1),
  authorityRequirement: z.array(z.string()),
  status: z.enum(["AVAILABLE", "RESTRICTED", "OFFLINE"]),
});

// 13.2 Attention Coordinator & Material Questions (SPEC §29.3, §16.2)
export type MaterialityTrigger =
  | "interpretation_divergence"
  | "authority_expansion"
  | "irreversible_effect"
  | "external_effect"
  | "missing_grant"
  | "human_taste"
  | "confidence_collapse";

export interface MaterialQuestion {
  readonly id: string;
  readonly taskId: string;
  readonly trigger: MaterialityTrigger;
  readonly questionText: string;
  readonly consequenceMatrix: Readonly<Record<string, string>>;
  readonly options: readonly string[];
  readonly status: "PENDING" | "ANSWERED" | "DISMISSED";
  readonly suggestedOption: string | null;
  readonly selectedOption: string | null;
  readonly createdAt: Rfc3339Timestamp;
  readonly resolvedAt: Rfc3339Timestamp | null;
}

export const materialQuestionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  trigger: z.enum([
    "interpretation_divergence",
    "authority_expansion",
    "irreversible_effect",
    "external_effect",
    "missing_grant",
    "human_taste",
    "confidence_collapse",
  ]),
  questionText: z.string().min(1),
  consequenceMatrix: z.record(z.string(), z.string()),
  options: z.array(z.string()),
  status: z.enum(["PENDING", "ANSWERED", "DISMISSED"]),
  suggestedOption: z.string().nullable(),
  selectedOption: z.string().nullable(),
  createdAt: rfc3339Schema,
  resolvedAt: rfc3339Schema.nullable(),
});

export interface AttentionAssessment {
  readonly taskId: string;
  readonly requiresAttention: boolean;
  readonly urgency: "LOW" | "NORMAL" | "HIGH" | "BLOCKING";
  readonly pendingQuestions: readonly MaterialQuestion[];
  readonly reason: string;
  readonly timestamp: Rfc3339Timestamp;
}

export const attentionAssessmentSchema = z.object({
  taskId: z.string().min(1),
  requiresAttention: z.boolean(),
  urgency: z.enum(["LOW", "NORMAL", "HIGH", "BLOCKING"]),
  pendingQuestions: z.array(materialQuestionSchema),
  reason: z.string().min(1),
  timestamp: rfc3339Schema,
});

// 13.3 Structured Interventions (SPEC §16.3)
export type StructuredInterventionVerb =
  | "focus"
  | "ignore"
  | "elaborate"
  | "change_constraint"
  | "edit_plan"
  | "approve_exact_effect"
  | "deny_narrow"
  | "pause"
  | "resume"
  | "takeover"
  | "fork"
  | "rewind"
  | "terminate"
  | "request_independent_review";

export const structuredInterventionVerbSchema = z.enum([
  "focus",
  "ignore",
  "elaborate",
  "change_constraint",
  "edit_plan",
  "approve_exact_effect",
  "deny_narrow",
  "pause",
  "resume",
  "takeover",
  "fork",
  "rewind",
  "terminate",
  "request_independent_review",
]);

const interventionTextSchema = z.string().trim().min(1).max(4_000);
const interventionStringArraySchema = z.array(interventionTextSchema).min(1).max(64);
const interventionTimeoutSecondsSchema = z
  .union([
    z.number().int().positive().safe(),
    z.string().regex(/^[1-9][0-9]*$/, "timeout_seconds must be a positive integer"),
  ])
  .transform((value, context) => {
    const seconds = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(seconds)) {
      context.addIssue({
        code: "custom",
        message: "timeout_seconds exceeds the safe integer range",
      });
      return z.NEVER;
    }
    return seconds;
  });

/** Canonical JSON payload contract for every structured intervention verb. */
export const INTERVENTION_PAYLOAD_SCHEMAS = {
  focus: z.object({ scope: interventionStringArraySchema }).strict(),
  ignore: z.object({}).strict(),
  elaborate: z.object({ text: interventionTextSchema }).strict(),
  change_constraint: z.discriminatedUnion("constraint", [
    z.object({
      constraint: z.literal("cost_micros"),
      value: z.string().regex(/^(0|[1-9][0-9]*)$/, "cost_micros must be a canonical non-negative decimal string"),
    }).strict(),
    z.object({
      constraint: z.literal("timeout_seconds"),
      value: interventionTimeoutSecondsSchema,
    }).strict(),
    z.object({
      constraint: z.literal("security_policy"),
      value: interventionTextSchema,
    }).strict(),
  ]),
  edit_plan: z.object({
    operation: z.enum(["replace_node", "add_node", "remove_node", "change_edge"]),
    instruction: interventionTextSchema,
  }).strict(),
  approve_exact_effect: z.object({ effectId: interventionTextSchema }).strict(),
  deny_narrow: z.object({
    effectId: interventionTextSchema,
    restrictedCapabilities: interventionStringArraySchema,
  }).strict(),
  pause: z.object({}).strict(),
  resume: z.object({}).strict(),
  takeover: z.object({ humanPrincipal: interventionTextSchema }).strict(),
  fork: z.object({ label: interventionTextSchema }).strict(),
  rewind: z.object({ checkpointHash: contentHashSchema }).strict(),
  terminate: z.object({}).strict(),
  request_independent_review: z.object({ scope: interventionTextSchema }).strict(),
} as const satisfies Readonly<Record<StructuredInterventionVerb, z.ZodType>>;

export interface StructuredIntervention {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string | null;
  readonly actorPrincipal: string;
  readonly verb: StructuredInterventionVerb;
  readonly targetEntityId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly rationale: string;
  readonly status: "PROPOSED" | "APPLIED" | "REJECTED";
  readonly timestamp: Rfc3339Timestamp;
}

export const structuredInterventionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  attemptId: z.string().nullable(),
  actorPrincipal: z.string().min(1),
  verb: structuredInterventionVerbSchema,
  targetEntityId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  rationale: z.string().min(1),
  status: z.enum(["PROPOSED", "APPLIED", "REJECTED"]),
  timestamp: rfc3339Schema,
}).strict().superRefine((intervention, context) => {
  const payload = INTERVENTION_PAYLOAD_SCHEMAS[intervention.verb].safeParse(intervention.payload);
  if (!payload.success) {
    for (const issue of payload.error.issues) {
      context.addIssue({
        code: "custom",
        path: ["payload", ...issue.path],
        message: issue.message,
      });
    }
    return;
  }

  const taskTargetVerbs: readonly StructuredInterventionVerb[] = [
    "elaborate",
    "change_constraint",
    "pause",
    "resume",
    "takeover",
    "fork",
    "terminate",
    "request_independent_review",
  ];
  if (taskTargetVerbs.includes(intervention.verb)) {
    if (intervention.targetEntityId !== intervention.taskId) {
      context.addIssue({
        code: "custom",
        path: ["targetEntityId"],
        message: "task intervention target must equal taskId",
      });
    }
    return;
  }
  if (intervention.targetEntityId === null) {
    context.addIssue({
      code: "custom",
      path: ["targetEntityId"],
      message: "entity intervention requires an exact target",
    });
    return;
  }
  if (intervention.verb === "approve_exact_effect") {
    const effectPayload = INTERVENTION_PAYLOAD_SCHEMAS.approve_exact_effect.parse(intervention.payload);
    if (effectPayload.effectId !== intervention.targetEntityId) {
      context.addIssue({
        code: "custom",
        path: ["targetEntityId"],
        message: "effect intervention target must equal payload.effectId",
      });
    }
  }
  if (intervention.verb === "deny_narrow") {
    const effectPayload = INTERVENTION_PAYLOAD_SCHEMAS.deny_narrow.parse(intervention.payload);
    if (effectPayload.effectId !== intervention.targetEntityId) {
      context.addIssue({
        code: "custom",
        path: ["targetEntityId"],
        message: "effect intervention target must equal payload.effectId",
      });
    }
  }
  if (intervention.verb === "rewind") {
    const rewindPayload = INTERVENTION_PAYLOAD_SCHEMAS.rewind.parse(intervention.payload);
    if (rewindPayload.checkpointHash !== intervention.targetEntityId) {
      context.addIssue({
        code: "custom",
        path: ["targetEntityId"],
        message: "rewind target must equal payload.checkpointHash",
      });
    }
  }
});

// 13.4 Causal Replay & Counterfactuals (SPEC §33, §19)
export interface CausalStep {
  readonly stepIndex: number;
  readonly component: string;
  readonly inputManifestHash: ContentHash;
  readonly modelOutputHash: ContentHash | null;
  readonly effectId: string | null;
  readonly verifierResult: string | null;
  readonly durationMs: number;
  readonly counterfactualAlternative: string | null;
}

export const causalStepSchema = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    component: z.string().min(1),
    inputManifestHash: contentHashSchema,
    modelOutputHash: contentHashSchema.nullable(),
    effectId: z.string().nullable(),
    verifierResult: z.string().nullable(),
    durationMs: z.number().nonnegative(),
    counterfactualAlternative: z.string().nullable(),
  })
  .strict();

export interface CausalReplayTrace {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly pinnedInputsHash: ContentHash;
  readonly steps: readonly CausalStep[];
  readonly divergencePoints: readonly string[];
  readonly omissionDiagnostics: readonly {
    readonly blockId: string;
    readonly sourcePath: string;
    readonly omittedReason: string;
    readonly causalRelevanceScore: number;
    readonly evaluatorId: string;
    readonly evidenceRefs: readonly (ArtifactUri | ContentHash)[];
  }[];
  readonly createdAt: Rfc3339Timestamp;
}

export const causalReplayTraceSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    attemptId: z.string().min(1),
    pinnedInputsHash: contentHashSchema,
    steps: z.array(causalStepSchema),
    divergencePoints: z.array(z.string()),
    omissionDiagnostics: z.array(
      z
        .object({
          blockId: z.string().min(1),
          sourcePath: z.string().min(1),
          omittedReason: z.string().min(1),
          causalRelevanceScore: z.number().min(0).max(1),
          evaluatorId: z.string().min(1),
          evidenceRefs: z.array(z.union([artifactUriSchema, contentHashSchema])).min(1),
        })
        .strict(),
    ),
    createdAt: rfc3339Schema,
  })
  .strict();

export interface CounterfactualExperiment {
  readonly id: string;
  readonly sourceTaskId: string;
  readonly variationType: "profile" | "prompt" | "retrieval" | "intervention";
  readonly variationDetails: Readonly<Record<string, unknown>>;
  readonly executionStatus: "planned" | "completed";
  readonly predictedOutcome: string;
  readonly actualOutcome: string | null;
  readonly deltaSuccess: boolean | null;
  readonly deltaCostMicros: Micros | null;
  readonly deltaLatencyMs: number | null;
}

export const counterfactualExperimentSchema = z.object({
  id: z.string().min(1),
  sourceTaskId: z.string().min(1),
  variationType: z.enum(["profile", "prompt", "retrieval", "intervention"]),
  variationDetails: z.record(z.string(), z.unknown()),
  executionStatus: z.enum(["planned", "completed"]),
  predictedOutcome: z.string().min(1),
  actualOutcome: z.string().nullable(),
  deltaSuccess: z.boolean().nullable(),
  deltaCostMicros: microsSchema.nullable(),
  deltaLatencyMs: z.number().nullable(),
});

// 13.5 Mobile Supervision & ACP Context Injection (SPEC §1, §9, §32.6)
export interface MobileSupervisionSession {
  readonly id: string;
  readonly taskId: string;
  readonly operatorPrincipal: string;
  readonly devicePlatform: "ios" | "android" | "web";
  readonly connectionState: "CONNECTED" | "SUSPENDED" | "DISCONNECTED";
  readonly quickActions: readonly (
    "pause" | "resume" | "approve_effect" | "terminate" | "request_review"
  )[];
  readonly lastSeenAt: Rfc3339Timestamp;
}

export const mobileSupervisionSessionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  operatorPrincipal: z.string().min(1),
  devicePlatform: z.enum(["ios", "android", "web"]),
  connectionState: z.enum(["CONNECTED", "SUSPENDED", "DISCONNECTED"]),
  quickActions: z.array(
    z.enum([
      "pause",
      "resume",
      "approve_effect",
      "terminate",
      "request_review",
    ]),
  ),
  lastSeenAt: z.string(),
});

export interface AcpContextInjection {
  readonly workspaceRootUri: string;
  readonly activeFileUri: string | null;
  readonly selectedRange: {
    readonly startLine: number;
    readonly startCol: number;
    readonly endLine: number;
    readonly endCol: number;
  } | null;
  readonly diagnostics: readonly {
    readonly fileUri: string;
    readonly line: number;
    readonly severity: "error" | "warning" | "info" | "hint";
    readonly message: string;
  }[];
  readonly openEditorUris: readonly string[];
}

export const acpContextInjectionSchema = z.object({
  workspaceRootUri: z.string().min(1),
  activeFileUri: z.string().nullable(),
  selectedRange: z
    .object({
      startLine: z.number().int().nonnegative(),
      startCol: z.number().int().nonnegative(),
      endLine: z.number().int().nonnegative(),
      endCol: z.number().int().nonnegative(),
    })
    .nullable(),
  diagnostics: z.array(
    z.object({
      fileUri: z.string().min(1),
      line: z.number().int().nonnegative(),
      severity: z.enum(["error", "warning", "info", "hint"]),
      message: z.string().min(1),
    }),
  ),
  openEditorUris: z.array(z.string()),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. Phase 10 — Computer Use & General Agency Aggregates (SPEC §25, §18.3, §17, §30)
// ═══════════════════════════════════════════════════════════════════════════════

// 14.1 UI Observation Model & Hierarchy (SPEC §25.1)
export interface UiViewport {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly scaleFactor: number;
}

export const uiViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  devicePixelRatio: z.number().positive().default(1),
  scaleFactor: z.number().positive().default(1),
});

export interface UiBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const uiBoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export interface UiDomNode {
  readonly nodeId: string;
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly text: string | null;
  readonly boundingBox: UiBoundingBox | null;
  readonly isInteractive: boolean;
  readonly childrenNodeIds: readonly string[];
}

export const uiDomNodeSchema = z.object({
  nodeId: z.string().min(1),
  tag: z.string().min(1),
  attributes: z.record(z.string(), z.string()),
  text: z.string().nullable(),
  boundingBox: uiBoundingBoxSchema.nullable(),
  isInteractive: z.boolean(),
  childrenNodeIds: z.array(z.string()),
});

export interface UiAccessibilityNode {
  readonly nodeId: string;
  readonly role: string;
  readonly name: string;
  readonly description: string | null;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly focused: boolean;
  readonly boundingBox: UiBoundingBox | null;
  readonly childrenNodeIds: readonly string[];
}

export const uiAccessibilityNodeSchema = z.object({
  nodeId: z.string().min(1),
  role: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  value: z.string().nullable(),
  disabled: z.boolean(),
  focused: z.boolean(),
  boundingBox: uiBoundingBoxSchema.nullable(),
  childrenNodeIds: z.array(z.string()),
});

export interface UiElementTarget {
  readonly elementId: string;
  readonly role: string;
  readonly name: string;
  readonly selector: string;
  readonly boundingBox: UiBoundingBox;
  readonly textSnippet: string | null;
  readonly confidence: number;
  readonly semanticHash: string;
  /** Structural sources that independently identified this target. */
  readonly evidenceSources: readonly ("dom" | "accessibility")[];
}

export const uiElementTargetSchema = z.object({
  elementId: z.string().min(1),
  role: z.string().min(1),
  name: z.string(),
  selector: z.string().min(1),
  boundingBox: uiBoundingBoxSchema,
  textSnippet: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  semanticHash: z.string().min(1),
  evidenceSources: z.array(z.enum(["dom", "accessibility"])).min(1),
});

/** Raw adapter observation accepted by the fusion coordinator. */
export interface UiObservationInput {
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly timestamp: Rfc3339Timestamp;
  readonly viewport: UiViewport;
  readonly screenshotArtifactId: string | null;
  readonly domTreeArtifactId: string | null;
  readonly documentUri: string | null;
  readonly domNodes: readonly UiDomNode[];
  readonly accessibilityNodes: readonly UiAccessibilityNode[];
  readonly focusedElementId: string | null;
  readonly taintLabel:
    "SYSTEM_TRUSTED" | "USER_TRUSTED" | "UNTRUSTED_UI" | "UNTRUSTED_WEB";
  readonly version: number;
}

export const uiObservationInputSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  timestamp: rfc3339Schema,
  viewport: uiViewportSchema,
  screenshotArtifactId: z.string().min(1).nullable(),
  domTreeArtifactId: z.string().min(1).nullable(),
  documentUri: z.string().min(1).nullable(),
  domNodes: z.array(uiDomNodeSchema),
  accessibilityNodes: z.array(uiAccessibilityNodeSchema),
  focusedElementId: z.string().min(1).nullable(),
  taintLabel: z.enum([
    "SYSTEM_TRUSTED",
    "USER_TRUSTED",
    "UNTRUSTED_UI",
    "UNTRUSTED_WEB",
  ]),
  version: z.number().int().positive(),
});

export interface UiObservation {
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly timestamp: Rfc3339Timestamp;
  readonly viewport: UiViewport;
  readonly screenshotArtifactId: string | null;
  readonly domTreeArtifactId: string | null;
  readonly documentUri: string | null;
  readonly accessibilityTree: readonly UiAccessibilityNode[];
  readonly focusedElementId: string | null;
  readonly targetElements: readonly UiElementTarget[];
  readonly taintLabel:
    "SYSTEM_TRUSTED" | "USER_TRUSTED" | "UNTRUSTED_UI" | "UNTRUSTED_WEB";
  readonly version: number;
}

export const uiObservationSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  timestamp: rfc3339Schema,
  viewport: uiViewportSchema,
  screenshotArtifactId: z.string().nullable(),
  domTreeArtifactId: z.string().nullable(),
  documentUri: z.string().min(1).nullable(),
  accessibilityTree: z.array(uiAccessibilityNodeSchema),
  focusedElementId: z.string().nullable(),
  targetElements: z.array(uiElementTargetSchema),
  taintLabel: z.enum([
    "SYSTEM_TRUSTED",
    "USER_TRUSTED",
    "UNTRUSTED_UI",
    "UNTRUSTED_WEB",
  ]),
  version: z.number().int().positive(),
});

// 14.2 Computer Use Actions (SPEC §25.1)
export type ComputerUseActionKind =
  | "click"
  | "double_click"
  | "right_click"
  | "hover"
  | "type_text"
  | "key_press"
  | "key_combination"
  | "scroll"
  | "drag_and_drop"
  | "navigate"
  | "take_screenshot"
  | "extract_dom"
  | "focus_element"
  | "select_option";

export type ComputerUseEffectClass =
  | "read_only"
  | "bufferable_local"
  | "reversible_external"
  | "compensable_external"
  | "irreversible"
  | "unknown_semantics";

export interface ComputerUseAction {
  readonly actionId: string;
  readonly taskId: string;
  readonly observationId: string;
  readonly observationVersion: number;
  readonly kind: ComputerUseActionKind;
  readonly target: UiElementTarget | null;
  readonly coordinate: { readonly x: number; readonly y: number } | null;
  readonly text: string | null;
  readonly keys: readonly string[] | null;
  readonly scrollDelta: { readonly dx: number; readonly dy: number } | null;
  readonly intent: string;
  readonly requiresSemanticVerification: boolean;
  readonly effectClass: ComputerUseEffectClass;
}

export const computerUseActionSchema = z.object({
  actionId: z.string().min(1),
  taskId: z.string().min(1),
  observationId: z.string().min(1),
  observationVersion: z.number().int().positive(),
  kind: z.enum([
    "click",
    "double_click",
    "right_click",
    "hover",
    "type_text",
    "key_press",
    "key_combination",
    "scroll",
    "drag_and_drop",
    "navigate",
    "take_screenshot",
    "extract_dom",
    "focus_element",
    "select_option",
  ]),
  target: uiElementTargetSchema.nullable(),
  coordinate: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .nullable(),
  text: z.string().nullable(),
  keys: z.array(z.string()).nullable(),
  scrollDelta: z
    .object({
      dx: z.number(),
      dy: z.number(),
    })
    .nullable(),
  intent: z.string().min(1),
  requiresSemanticVerification: z.boolean(),
  effectClass: z.enum([
    "read_only",
    "bufferable_local",
    "reversible_external",
    "compensable_external",
    "irreversible",
    "unknown_semantics",
  ]),
});

// 14.3 Semantic Target Verification & Evidence (SPEC §25.2)
export interface SemanticTargetVerification {
  readonly verificationId: string;
  readonly actionId: string;
  readonly observationId: string;
  readonly target: UiElementTarget | null;
  readonly matchConfidence: number;
  readonly visuallyConfirmed: boolean;
  readonly domConfirmed: boolean;
  readonly ambiguityScore: number;
  readonly verifiedCoordinates: { readonly x: number; readonly y: number } | null;
  readonly verdict: "verified" | "ambiguous" | "divergent" | "rejected";
  readonly reason: string;
}

export const semanticTargetVerificationSchema = z
  .object({
    verificationId: z.string().min(1),
    actionId: z.string().min(1),
    observationId: z.string().min(1),
    target: uiElementTargetSchema.nullable(),
    matchConfidence: z.number().min(0).max(1),
    visuallyConfirmed: z.boolean(),
    domConfirmed: z.boolean(),
    ambiguityScore: z.number().min(0).max(1),
    verifiedCoordinates: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .nullable(),
    verdict: z.enum(["verified", "ambiguous", "divergent", "rejected"]),
    reason: z.string().min(1),
  })
  .strict()
  .superRefine((verification, context) => {
    if (verification.verdict === "rejected") {
      if (verification.target !== null) {
        context.addIssue({
          code: "custom",
          path: ["target"],
          message: "rejected target verification must not retain a target",
        });
      }
      if (verification.verifiedCoordinates !== null) {
        context.addIssue({
          code: "custom",
          path: ["verifiedCoordinates"],
          message: "rejected target verification must not retain dispatch coordinates",
        });
      }
      return;
    }
    if (verification.target === null || verification.verifiedCoordinates === null) {
      context.addIssue({
        code: "custom",
        message: "non-rejected target verification requires a target and verified coordinates",
      });
    }
  });

export interface UiEvidenceRecord {
  readonly evidenceId: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly preScreenshotArtifactId: string | null;
  readonly postScreenshotArtifactId: string | null;
  readonly domMutationsCount: number;
  readonly durationMs: number;
  readonly observedChanges: readonly string[];
  readonly timestamp: Rfc3339Timestamp;
}

export const uiEvidenceRecordSchema = z.object({
  evidenceId: z.string().min(1),
  actionId: z.string().min(1),
  taskId: z.string().min(1),
  preScreenshotArtifactId: z.string().nullable(),
  postScreenshotArtifactId: z.string().nullable(),
  domMutationsCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  observedChanges: z.array(z.string()),
  timestamp: rfc3339Schema,
});

// 14.4 Browser & Desktop Pools (SPEC §19, §25)
export interface BrowserDesktopPool {
  readonly poolId: string;
  readonly kind: "browser" | "desktop";
  readonly capacity: number;
  readonly activeLeasesCount: number;
  readonly sandboxTier: "tier2_hardened_container" | "tier3_microvm";
  readonly healthStatus: "healthy" | "degraded" | "draining" | "unhealthy";
  readonly endpoint: string;
  readonly runtimeConfig: Readonly<Record<string, unknown>>;
  /** Coordinator-only pools never claim that a browser/desktop backend exists. */
  readonly executionSupport: "coordinator_only" | "kernel_backed";
  readonly enforcementStatus: "unverified" | "enforced";
}

export const browserDesktopPoolSchema = z.object({
  poolId: z.string().min(1),
  kind: z.enum(["browser", "desktop"]),
  capacity: z.number().int().positive(),
  activeLeasesCount: z.number().int().nonnegative(),
  sandboxTier: z.enum(["tier2_hardened_container", "tier3_microvm"]),
  healthStatus: z.enum(["healthy", "degraded", "draining", "unhealthy"]),
  endpoint: z.string().min(1),
  runtimeConfig: z.record(z.string(), z.unknown()),
  executionSupport: z.enum(["coordinator_only", "kernel_backed"]),
  enforcementStatus: z.enum(["unverified", "enforced"]),
});

export interface PoolLease {
  readonly leaseId: string;
  readonly poolId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly assignedInstanceId: string;
  readonly acquiredAt: Rfc3339Timestamp;
  readonly expiresAt: Rfc3339Timestamp;
  readonly status: "active" | "released" | "expired" | "evicted";
}

export const poolLeaseSchema = z.object({
  leaseId: z.string().min(1),
  poolId: z.string().min(1),
  taskId: z.string().min(1),
  workerId: z.string().min(1),
  assignedInstanceId: z.string().min(1),
  acquiredAt: rfc3339Schema,
  expiresAt: rfc3339Schema,
  status: z.enum(["active", "released", "expired", "evicted"]),
});

// 14.5 Human Takeover Protocol (SPEC §25.4)
export interface HumanTakeoverSession {
  readonly takeoverId: string;
  readonly taskId: string;
  readonly poolId: string;
  readonly surface: "browser" | "desktop";
  readonly state:
    "human_control" | "resume_pending_observation" | "agent_control";
  readonly startedAt: Rfc3339Timestamp;
  readonly resumedAt: Rfc3339Timestamp | null;
  readonly preTakeoverObservationId: string;
  readonly preTakeoverObservationVersion: number;
  readonly resumeObservationId: string | null;
  readonly reason: string;
}

export const humanTakeoverSessionSchema = z.object({
  takeoverId: z.string().min(1),
  taskId: z.string().min(1),
  poolId: z.string().min(1),
  surface: z.enum(["browser", "desktop"]),
  state: z.enum([
    "human_control",
    "resume_pending_observation",
    "agent_control",
  ]),
  startedAt: rfc3339Schema,
  resumedAt: rfc3339Schema.nullable(),
  preTakeoverObservationId: z.string().min(1),
  preTakeoverObservationVersion: z.number().int().positive(),
  resumeObservationId: z.string().min(1).nullable(),
  reason: z.string().min(1),
});

// 14.6 Data-Flow Policy & Clipboard/Download Quarantine (SPEC §18.3, §19.2)
export interface DataFlowPolicy {
  readonly policyId: string;
  readonly taskId: string;
  readonly clipboardAccess: "none" | "read_only" | "write_only" | "read_write";
  readonly allowedUploadMimeTypes: readonly string[];
  readonly maxUploadBytes: ByteCount;
  readonly downloadQuarantine: boolean;
  readonly dlpScanRequired: boolean;
  readonly quarantineDirectory: string;
}

export const dataFlowPolicySchema = z.object({
  policyId: z.string().min(1),
  taskId: z.string().min(1),
  clipboardAccess: z.enum(["none", "read_only", "write_only", "read_write"]),
  allowedUploadMimeTypes: z.array(z.string()),
  maxUploadBytes: byteCountSchema,
  downloadQuarantine: z.boolean(),
  dlpScanRequired: z.boolean(),
  quarantineDirectory: z.string().min(1),
});

export interface DataTransferAudit {
  readonly transferId: string;
  readonly taskId: string;
  readonly direction:
    "upload" | "download" | "clipboard_read" | "clipboard_write";
  readonly source: string;
  readonly destination: string;
  readonly bytesCount: ByteCount;
  readonly mimeType: string;
  readonly dlpScanPassed: boolean | null;
  readonly quarantinedPath: string | null;
  readonly artifactId: ArtifactUri | null;
  readonly contentHash: ContentHash | null;
  readonly dlpReceiptArtifactId: ArtifactUri | null;
  readonly destinationEvidenceArtifactId: ArtifactUri | null;
  readonly timestamp: Rfc3339Timestamp;
}

export const dataTransferAuditSchema = z.object({
  transferId: z.string().min(1),
  taskId: z.string().min(1),
  direction: z.enum([
    "upload",
    "download",
    "clipboard_read",
    "clipboard_write",
  ]),
  source: z.string().min(1),
  destination: z.string().min(1),
  bytesCount: byteCountSchema,
  mimeType: z.string().min(1),
  dlpScanPassed: z.boolean().nullable(),
  quarantinedPath: z.string().nullable(),
  artifactId: artifactUriSchema.nullable(),
  contentHash: contentHashSchema.nullable(),
  dlpReceiptArtifactId: artifactUriSchema.nullable(),
  destinationEvidenceArtifactId: artifactUriSchema.nullable(),
  timestamp: rfc3339Schema,
}).strict();

export interface DataFlowCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
  readonly audit: DataTransferAudit;
}

export const dataFlowCheckResultSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().min(1),
  audit: dataTransferAuditSchema,
});

// 14.7 External Connector Library (SPEC §17.2, §18.2)
export interface ExternalConnectorSpec {
  readonly connectorId: string;
  /** External system identity. The canonical domain does not enumerate vendors. */
  readonly provider: string;
  readonly baseUrl: string;
  readonly allowedMethods: readonly (
    "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  )[];
  readonly rateLimitRps: number;
  readonly credentialBindingId: string;
  readonly effectClasses: readonly ComputerUseEffectClass[];
  readonly status: "active" | "maintenance" | "disabled";
}

export const externalConnectorSpecSchema = z.object({
  connectorId: z.string().min(1),
  provider: z.string().min(1),
  baseUrl: z.url(),
  allowedMethods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])),
  rateLimitRps: z.number().positive(),
  credentialBindingId: z.string().min(1),
  effectClasses: z
    .array(
      z.enum([
        "read_only",
        "bufferable_local",
        "reversible_external",
        "compensable_external",
        "irreversible",
        "unknown_semantics",
      ]),
    )
    .min(1),
  status: z.enum(["active", "maintenance", "disabled"]),
});

export interface ConnectorCallIntent {
  readonly intentId: string;
  readonly connectorId: string;
  readonly taskId: string;
  readonly operation: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly authorizationId: string;
  readonly effectClass: ComputerUseEffectClass;
}

export const connectorCallIntentSchema = z.object({
  intentId: z.string().min(1),
  connectorId: z.string().min(1),
  taskId: z.string().min(1),
  operation: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1),
  authorizationId: z.string().min(1),
  effectClass: z.enum([
    "read_only",
    "bufferable_local",
    "reversible_external",
    "compensable_external",
    "irreversible",
    "unknown_semantics",
  ]),
});

/** Source-shaped result returned by the trusted L7 connector boundary. */
export interface ConnectorExecutionObservation {
  readonly settlement: "success" | "failure" | "uncertain";
  readonly httpStatusCode: number | null;
  readonly responseBody: Readonly<Record<string, unknown>>;
  readonly executedAt: Rfc3339Timestamp;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
}

export const connectorExecutionObservationSchema = z.object({
  settlement: z.enum(["success", "failure", "uncertain"]),
  httpStatusCode: z.number().int().min(100).max(599).nullable(),
  responseBody: z.record(z.string(), z.unknown()),
  executedAt: rfc3339Schema,
  failureCode: z.string().min(1).nullable(),
  failureMessage: z.string().min(1).nullable(),
});

export interface ConnectorCallResult {
  readonly receiptId: string;
  readonly intentId: string;
  readonly connectorId: string;
  readonly status: "success" | "failure" | "uncertain";
  readonly httpStatusCode: number | null;
  readonly responseBody: Readonly<Record<string, unknown>>;
  readonly requestHash: ContentHash;
  readonly responseHash: ContentHash;
  readonly executedAt: Rfc3339Timestamp;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
}

export const connectorCallResultSchema = z.object({
  receiptId: z.string().min(1),
  intentId: z.string().min(1),
  connectorId: z.string().min(1),
  status: z.enum(["success", "failure", "uncertain"]),
  httpStatusCode: z.number().int().min(100).max(599).nullable(),
  responseBody: z.record(z.string(), z.unknown()),
  requestHash: contentHashSchema,
  responseHash: contentHashSchema,
  executedAt: rfc3339Schema,
  failureCode: z.string().min(1).nullable(),
  failureMessage: z.string().min(1).nullable(),
});

// 14.8 Ambiguous Submit Reconciliation (SPEC §25.3, §16.1)
export interface AmbiguousSubmitReconciliation {
  readonly reconciliationId: string;
  readonly effectId: string;
  readonly taskId: string;
  readonly previousObservationId: string;
  readonly postTimeoutObservationId: string;
  readonly submitState:
    | "confirmed_executed"
    | "confirmed_not_executed"
    | "ambiguous_manual_required";
  readonly reconciliationEvidence: string;
  readonly receiptId: string | null;
  readonly safeToRetry: boolean;
  readonly reconciledAt: Rfc3339Timestamp;
}

export const ambiguousSubmitReconciliationSchema = z.object({
  reconciliationId: z.string().min(1),
  effectId: z.string().min(1),
  taskId: z.string().min(1),
  previousObservationId: z.string().min(1),
  postTimeoutObservationId: z.string().min(1),
  submitState: z.enum([
    "confirmed_executed",
    "confirmed_not_executed",
    "ambiguous_manual_required",
  ]),
  reconciliationEvidence: z.string().min(1),
  receiptId: z.string().min(1).nullable(),
  safeToRetry: z.boolean(),
  reconciledAt: rfc3339Schema,
});

// 14.9 Incident & Research Profiles (SPEC §30)
export interface IncidentProfileSpec {
  readonly profileId: string;
  readonly organizationId: string;
  readonly departmentId: string;
  readonly auditLevel: "standard" | "elevated" | "forensic";
  readonly maxActionTimeoutMs: number;
  readonly mandatoryCompensation: boolean;
  readonly allowedDiagnostics: readonly string[];
  readonly autoEscalateOnFailure: boolean;
}

export const incidentProfileSpecSchema = z.object({
  profileId: z.string().min(1),
  organizationId: z.string().min(1),
  departmentId: z.string().min(1),
  auditLevel: z.enum(["standard", "elevated", "forensic"]),
  maxActionTimeoutMs: z.number().int().positive(),
  mandatoryCompensation: z.boolean(),
  allowedDiagnostics: z.array(z.string()),
  autoEscalateOnFailure: z.boolean(),
});

export interface IncidentExecutionRecord {
  readonly executionId: string;
  readonly taskId: string;
  readonly profileId: string;
  readonly diagnosticActions: readonly string[];
  readonly forensicAuditLog: readonly string[];
  readonly compensationVerified: boolean;
  readonly escalated: boolean;
  readonly state: "active" | "blocked_compensation" | "resolved";
  readonly startedAt: Rfc3339Timestamp;
  readonly completedAt: Rfc3339Timestamp | null;
}

export const incidentExecutionRecordSchema = z.object({
  executionId: z.string().min(1),
  taskId: z.string().min(1),
  profileId: z.string().min(1),
  diagnosticActions: z.array(z.string().min(1)),
  forensicAuditLog: z.array(z.string().min(1)),
  compensationVerified: z.boolean(),
  escalated: z.boolean(),
  state: z.enum(["active", "blocked_compensation", "resolved"]),
  startedAt: rfc3339Schema,
  completedAt: rfc3339Schema.nullable(),
});

export interface ResearchProfileSpec {
  readonly profileId: string;
  readonly organizationId: string;
  readonly departmentId: string;
  readonly allowMultiSourceRetrieval: boolean;
  readonly notebookSandboxEnabled: boolean;
  readonly strictProvenanceTracking: boolean;
  readonly citationFormat: "apa" | "ieee" | "markdown_source";
  readonly maxSearchQueries: number;
}

export const researchProfileSpecSchema = z.object({
  profileId: z.string().min(1),
  organizationId: z.string().min(1),
  departmentId: z.string().min(1),
  allowMultiSourceRetrieval: z.boolean(),
  notebookSandboxEnabled: z.boolean(),
  strictProvenanceTracking: z.boolean(),
  citationFormat: z.enum(["apa", "ieee", "markdown_source"]),
  maxSearchQueries: z.number().int().positive(),
});

export interface ResearchProvenanceRecord {
  readonly researchId: string;
  readonly taskId: string;
  readonly profileId: string;
  readonly sourcesConsulted: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly uri: string;
    readonly hash: ContentHash;
    readonly citation: string;
  }[];
  readonly notebookOutputs: readonly {
    readonly cellIndex: number;
    readonly codeSnippet: string;
    readonly resultSummary: string;
    readonly artifactRef: ArtifactUri;
  }[];
  readonly hypotheses: readonly {
    readonly statement: string;
    readonly outcome: "confirmed" | "refuted" | "inconclusive";
  }[];
  readonly createdAt: Rfc3339Timestamp;
}

export const researchProvenanceRecordSchema = z.object({
  researchId: z.string().min(1),
  taskId: z.string().min(1),
  profileId: z.string().min(1),
  sourcesConsulted: z.array(
    z.object({
      sourceId: z.string().min(1),
      title: z.string().min(1),
      uri: z.url(),
      hash: contentHashSchema,
      citation: z.string().min(1),
    }),
  ),
  notebookOutputs: z.array(
    z.object({
      cellIndex: z.number().int().nonnegative(),
      codeSnippet: z.string(),
      resultSummary: z.string(),
      artifactRef: artifactUriSchema,
    }),
  ),
  hypotheses: z.array(
    z.object({
      statement: z.string().min(1),
      outcome: z.enum(["confirmed", "refuted", "inconclusive"]),
    }),
  ),
  createdAt: rfc3339Schema,
});
