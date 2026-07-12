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

export interface Workspace {
  readonly id: Uuid7;
  readonly kind: WorkspaceKind;
  readonly rootUri: string;
  readonly canonicalRoot: string;
  readonly trust: WorkspaceTrust;
  readonly repositoryIdentity: RepositoryIdentity;
  readonly activePolicyProfile: string | null;
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
  hash: z.string(),
  uri: z.string(),
  mediaType: z.string(),
  bytes: z.bigint(),
});

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
