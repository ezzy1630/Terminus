/**
 * @terminus/domain — state machine enumerations.
 *
 * Per SPEC §28.3-§28.8 and Appendix C.
 */
import { z } from "zod";

// ───────────────────────── Task state machine (§28.3) ─────────────────────────

export const TaskStatus = {
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
  NEEDS_USER_DECISION: "NEEDS_USER_DECISION",
  BLOCKED: "BLOCKED",
  VERIFYING: "VERIFYING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  FAILED_VERIFICATION: "FAILED_VERIFICATION",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  POLICY_DENIED: "POLICY_DENIED",
  ABORTED: "ABORTED",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];
export const taskStatusSchema = z.enum([
  "DRAFT",
  "ACTIVE",
  "NEEDS_USER_DECISION",
  "BLOCKED",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "FAILED_VERIFICATION",
  "BUDGET_EXHAUSTED",
  "POLICY_DENIED",
  "ABORTED",
]);

export const TaskTerminalStatus: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "COMPLETED",
  "FAILED",
  "FAILED_VERIFICATION",
  "BUDGET_EXHAUSTED",
  "POLICY_DENIED",
  "ABORTED",
]);

/** Allowed task transitions per §28.3. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  DRAFT: ["ACTIVE", "ABORTED"],
  ACTIVE: [
    "NEEDS_USER_DECISION",
    "BLOCKED",
    "VERIFYING",
    "BUDGET_EXHAUSTED",
    "POLICY_DENIED",
    "FAILED",
    "ABORTED",
  ],
  NEEDS_USER_DECISION: ["ACTIVE", "ABORTED"],
  BLOCKED: ["ACTIVE", "ABORTED"],
  VERIFYING: ["COMPLETED", "ACTIVE", "FAILED_VERIFICATION", "ABORTED"],
  COMPLETED: [],
  FAILED: [],
  FAILED_VERIFICATION: [],
  BUDGET_EXHAUSTED: [],
  POLICY_DENIED: [],
  ABORTED: [],
} as const;

// ───────────────────────── Turn state machine (§28.4) ─────────────────────────

export const TurnState = {
  PENDING: "PENDING",
  CONTEXT_COMPILING: "CONTEXT_COMPILING",
  PROVIDER_RUNNING: "PROVIDER_RUNNING",
  RESPONSE_VALIDATING: "RESPONSE_VALIDATING",
  TOOL_SETTLEMENT: "TOOL_SETTLEMENT",
  FINALIZING: "FINALIZING",
  COMPLETED: "COMPLETED",
  INTERRUPTED: "INTERRUPTED",
  FAILED: "FAILED",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  POLICY_DENIED: "POLICY_DENIED",
} as const;
export type TurnState = (typeof TurnState)[keyof typeof TurnState];
export const turnStateSchema = z.enum([
  "PENDING",
  "CONTEXT_COMPILING",
  "PROVIDER_RUNNING",
  "RESPONSE_VALIDATING",
  "TOOL_SETTLEMENT",
  "FINALIZING",
  "COMPLETED",
  "INTERRUPTED",
  "FAILED",
  "BUDGET_EXHAUSTED",
  "POLICY_DENIED",
]);

export const TURN_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  PENDING: ["CONTEXT_COMPILING", "INTERRUPTED", "FAILED"],
  CONTEXT_COMPILING: ["PROVIDER_RUNNING", "FAILED", "BUDGET_EXHAUSTED", "POLICY_DENIED"],
  PROVIDER_RUNNING: ["RESPONSE_VALIDATING", "INTERRUPTED", "FAILED", "BUDGET_EXHAUSTED"],
  RESPONSE_VALIDATING: ["TOOL_SETTLEMENT", "PROVIDER_RUNNING", "FINALIZING", "FAILED"],
  TOOL_SETTLEMENT: ["PROVIDER_RUNNING", "FINALIZING", "FAILED", "POLICY_DENIED"],
  FINALIZING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  INTERRUPTED: ["PENDING", "FAILED"],
  FAILED: [],
  BUDGET_EXHAUSTED: [],
  POLICY_DENIED: [],
} as const;

// ───────────────────── Tool-call state machine (§28.5) ──────────────────────

export const ToolCallState = {
  PROPOSED: "PROPOSED",
  VALIDATED: "VALIDATED",
  POLICY_EVALUATED: "POLICY_EVALUATED",
  DENIED: "DENIED",
  APPROVAL_PENDING: "APPROVAL_PENDING",
  AUTHORIZED: "AUTHORIZED",
  STARTED: "STARTED",
  SETTLED: "SETTLED",
  FAILED: "FAILED",
  TIMED_OUT: "TIMED_OUT",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
  RECONCILING: "RECONCILING",
} as const;
export type ToolCallState = (typeof ToolCallState)[keyof typeof ToolCallState];
export const toolCallStateSchema = z.enum([
  "PROPOSED",
  "VALIDATED",
  "POLICY_EVALUATED",
  "DENIED",
  "APPROVAL_PENDING",
  "AUTHORIZED",
  "STARTED",
  "SETTLED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "UNKNOWN",
  "RECONCILING",
]);

// ─────────────── External side-effect state machine (§28.6) ──────────────────

export const SideEffectState = {
  PROPOSED: "PROPOSED",
  AUTHORIZED: "AUTHORIZED",
  STARTED: "STARTED",
  SETTLED: "SETTLED",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN",
  RECONCILING: "RECONCILING",
  MANUAL_REVIEW: "MANUAL_REVIEW",
} as const;
export type SideEffectState = (typeof SideEffectState)[keyof typeof SideEffectState];
export const sideEffectStateSchema = z.enum([
  "PROPOSED",
  "AUTHORIZED",
  "STARTED",
  "SETTLED",
  "FAILED",
  "UNKNOWN",
  "RECONCILING",
  "MANUAL_REVIEW",
]);

// ───────────────────────── Job state machine (§28.7) ─────────────────────────

export const JobState = {
  CREATED: "CREATED",
  STARTING: "STARTING",
  RUNNING: "RUNNING",
  EXITED: "EXITED",
  STOPPING: "STOPPING",
  KILLING: "KILLING",
  ORPHANED: "ORPHANED",
  REATTACHED: "REATTACHED",
  LOST: "LOST",
} as const;
export type JobState = (typeof JobState)[keyof typeof JobState];
export const jobStateSchema = z.enum([
  "CREATED",
  "STARTING",
  "RUNNING",
  "EXITED",
  "STOPPING",
  "KILLING",
  "ORPHANED",
  "REATTACHED",
  "LOST",
]);

// ─────────────── Context-epoch state machine (§28.8) ─────────────────────────

export const ContextEpochState = {
  INITIALIZING: "INITIALIZING",
  ACTIVE: "ACTIVE",
  REPLACEMENT_PENDING: "REPLACEMENT_PENDING",
  SEALED: "SEALED",
} as const;
export type ContextEpochState = (typeof ContextEpochState)[keyof typeof ContextEpochState];
export const contextEpochStateSchema = z.enum([
  "INITIALIZING",
  "ACTIVE",
  "REPLACEMENT_PENDING",
  "SEALED",
]);

// ───────────────────────── Support enums ─────────────────────────────────────

export const SessionStatus = {
  ACTIVE: "active",
  PAUSED: "paused",
  ARCHIVED: "archived",
  DELETED: "deleted",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];
export const sessionStatusSchema = z.enum(["active", "paused", "archived", "deleted"]);

export const ThreadStatus = {
  ACTIVE: "active",
  PAUSED: "paused",
  ARCHIVED: "archived",
} as const;
export type ThreadStatus = (typeof ThreadStatus)[keyof typeof ThreadStatus];
export const threadStatusSchema = z.enum(["active", "paused", "archived"]);

export const WorkspaceTrust = {
  TRUSTED: "trusted",
  UNTRUSTED: "untrusted",
  RESTRICTED: "restricted",
} as const;
export type WorkspaceTrust = (typeof WorkspaceTrust)[keyof typeof WorkspaceTrust];
export const workspaceTrustSchema = z.enum(["trusted", "untrusted", "restricted"]);

export const WorkspaceKind = {
  LOCAL_GIT: "local_git",
  LOCAL_DIRECTORY: "local_directory",
  CONTAINER: "container",
  MICROVM: "microvm",
  REMOTE: "remote",
} as const;
export type WorkspaceKind = (typeof WorkspaceKind)[keyof typeof WorkspaceKind];
export const workspaceKindSchema = z.enum([
  "local_git",
  "local_directory",
  "container",
  "microvm",
  "remote",
]);

export const RiskClass = {
  LOW: "low",
  NORMAL: "normal",
  HIGH: "high",
  CRITICAL: "critical",
} as const;
export type RiskClass = (typeof RiskClass)[keyof typeof RiskClass];
export const riskClassSchema = z.enum(["low", "normal", "high", "critical"]);

export const TaskPhase = {
  INTAKE: "INTAKE",
  CONTRACT: "CONTRACT",
  DISCOVER: "DISCOVER",
  PLAN: "PLAN",
  IMPLEMENT: "IMPLEMENT",
  VERIFY: "VERIFY",
  REVIEW: "REVIEW",
  COMPLETE: "COMPLETE",
} as const;
export type TaskPhase = (typeof TaskPhase)[keyof typeof TaskPhase];
export const taskPhaseSchema = z.enum([
  "INTAKE",
  "CONTRACT",
  "DISCOVER",
  "PLAN",
  "IMPLEMENT",
  "VERIFY",
  "REVIEW",
  "COMPLETE",
]);

export const TrustLabel = {
  TRUSTED: "trusted",
  DERIVED: "derived",
  UNTRUSTED: "untrusted",
} as const;
export type TrustLabel = (typeof TrustLabel)[keyof typeof TrustLabel];
export const trustLabelSchema = z.enum(["trusted", "derived", "untrusted"]);

export const ConfidentialityLabel = {
  PUBLIC: "public",
  WORKSPACE: "workspace",
  SECRET_ADJACENT: "secret_adjacent",
  SECRET: "secret",
} as const;
export type ConfidentialityLabel =
  (typeof ConfidentialityLabel)[keyof typeof ConfidentialityLabel];
export const confidentialityLabelSchema = z.enum([
  "public",
  "workspace",
  "secret_adjacent",
  "secret",
]);

/** Ordering for strictest-wins comparisons. Higher = more restricted. */
export const CONFIDENTIALITY_ORDER: Readonly<Record<ConfidentialityLabel, number>> = {
  public: 0,
  workspace: 1,
  secret_adjacent: 2,
  secret: 3,
} as const;

export const InjectionRisk = {
  NONE: "none",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;
export type InjectionRisk = (typeof InjectionRisk)[keyof typeof InjectionRisk];
export const injectionRiskSchema = z.enum(["none", "low", "medium", "high"]);

export const Exactness = {
  EXACT: "exact",
  SEMANTICS_PRESERVING: "semantics_preserving",
  RECOVERABLE_BY_REFERENCE: "recoverable_by_reference",
} as const;
export type Exactness = (typeof Exactness)[keyof typeof Exactness];
export const exactnessSchema = z.enum([
  "exact",
  "semantics_preserving",
  "recoverable_by_reference",
]);

export const ActorKind = {
  USER: "user",
  MODEL: "model",
  SYSTEM: "system",
  PLUGIN: "plugin",
  EXTERNAL_AGENT: "external_agent",
} as const;
export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind];
export const actorKindSchema = z.enum([
  "user",
  "model",
  "system",
  "plugin",
  "external_agent",
]);

export const CapabilityKind = {
  SKILL: "skill",
  TOOL_PACK: "tool_pack",
  MCP_SERVER: "mcp_server",
  PLUGIN: "plugin",
  EXTERNAL_HARNESS: "external_harness",
  ENVIRONMENT: "environment",
} as const;
export type CapabilityKind = (typeof CapabilityKind)[keyof typeof CapabilityKind];
export const capabilityKindSchema = z.enum([
  "skill",
  "tool_pack",
  "mcp_server",
  "plugin",
  "external_harness",
  "environment",
]);

export const CapabilityTrustLevel = {
  BUILTIN: "builtin",
  FIRST_PARTY: "first_party",
  VERIFIED_THIRD_PARTY: "verified_third_party",
  UNTRUSTED: "untrusted",
} as const;
export type CapabilityTrustLevel =
  (typeof CapabilityTrustLevel)[keyof typeof CapabilityTrustLevel];
export const capabilityTrustLevelSchema = z.enum([
  "builtin",
  "first_party",
  "verified_third_party",
  "untrusted",
]);

export const MemoryClaimStatus = {
  CANDIDATE: "candidate",
  ACTIVE: "active",
  DISPUTED: "disputed",
  EXPIRED: "expired",
  REJECTED: "rejected",
} as const;
export type MemoryClaimStatus = (typeof MemoryClaimStatus)[keyof typeof MemoryClaimStatus];
export const memoryClaimStatusSchema = z.enum([
  "candidate",
  "active",
  "disputed",
  "expired",
  "rejected",
]);

export const MemoryClaimKind = {
  FACT: "fact",
  CONVENTION: "convention",
  PREFERENCE: "preference",
  PITFALL: "pitfall",
  COMMAND: "command",
  ARCHITECTURE: "architecture",
  PROCEDURE: "procedure",
  FAILURE_RESOLUTION: "failure_resolution",
} as const;
export type MemoryClaimKind = (typeof MemoryClaimKind)[keyof typeof MemoryClaimKind];
export const memoryClaimKindSchema = z.enum([
  "fact",
  "convention",
  "preference",
  "pitfall",
  "command",
  "architecture",
  "procedure",
  "failure_resolution",
]);

export const VerificationNodeKind = {
  COMMAND: "command",
  DIAGNOSTIC: "diagnostic",
  DIFF_RULE: "diff_rule",
  HUMAN: "human",
  EXTERNAL_QUERY: "external_query",
} as const;
export type VerificationNodeKind =
  (typeof VerificationNodeKind)[keyof typeof VerificationNodeKind];
export const verificationNodeKindSchema = z.enum([
  "command",
  "diagnostic",
  "diff_rule",
  "human",
  "external_query",
]);

export const VerificationResultStatus = {
  PASS: "pass",
  FAIL: "fail",
  ERROR: "error",
  SKIPPED: "skipped",
  BLOCKED: "blocked",
} as const;
export type VerificationResultStatus =
  (typeof VerificationResultStatus)[keyof typeof VerificationResultStatus];
export const verificationResultStatusSchema = z.enum([
  "pass",
  "fail",
  "error",
  "skipped",
  "blocked",
]);

export const ReviewFindingLifecycle = {
  OPEN: "OPEN",
  ACCEPTED: "ACCEPTED",
  FIXED: "FIXED",
  VERIFIED: "VERIFIED",
  DISPUTED: "DISPUTED",
  RESOLVED: "RESOLVED",
  ACCEPTED_RISK: "ACCEPTED_RISK",
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
} as const;
export type ReviewFindingLifecycle =
  (typeof ReviewFindingLifecycle)[keyof typeof ReviewFindingLifecycle];
export const reviewFindingLifecycleSchema = z.enum([
  "OPEN",
  "ACCEPTED",
  "FIXED",
  "VERIFIED",
  "DISPUTED",
  "RESOLVED",
  "ACCEPTED_RISK",
  "OUT_OF_SCOPE",
]);

/** Allowed finding lifecycle transitions (§40.7). Terminal states are absorbing. */
export const REVIEW_FINDING_TRANSITIONS: Readonly<
  Record<ReviewFindingLifecycle, readonly ReviewFindingLifecycle[]>
> = {
  OPEN: ["ACCEPTED", "DISPUTED", "OUT_OF_SCOPE", "ACCEPTED_RISK"],
  ACCEPTED: ["FIXED", "DISPUTED", "ACCEPTED_RISK", "OUT_OF_SCOPE"],
  FIXED: ["VERIFIED", "DISPUTED", "OPEN"],
  VERIFIED: ["RESOLVED"],
  DISPUTED: ["OPEN", "ACCEPTED", "ACCEPTED_RISK", "OUT_OF_SCOPE", "RESOLVED"],
  RESOLVED: [],
  ACCEPTED_RISK: [],
  OUT_OF_SCOPE: [],
} as const;

export const ReviewFindingTerminal: ReadonlySet<ReviewFindingLifecycle> = new Set([
  "RESOLVED",
  "ACCEPTED_RISK",
  "OUT_OF_SCOPE",
]);

export function isReviewFindingTransitionAllowed(
  from: ReviewFindingLifecycle,
  to: ReviewFindingLifecycle,
): boolean {
  return REVIEW_FINDING_TRANSITIONS[from].includes(to);
}

/** Findings that still block completion. */
export function findingBlocksCompletion(lifecycle: ReviewFindingLifecycle): boolean {
  return lifecycle === "OPEN" || lifecycle === "ACCEPTED" || lifecycle === "FIXED" || lifecycle === "DISPUTED";
}

export const DelegationRole = {
  SCOUT: "scout",
  IMPLEMENTER: "implementer",
  REVIEWER: "reviewer",
  SPECIALIST: "specialist",
} as const;
export type DelegationRole = (typeof DelegationRole)[keyof typeof DelegationRole];
export const delegationRoleSchema = z.enum(["scout", "implementer", "reviewer", "specialist"]);

export const DelegationResultStatus = {
  COMPLETED: "completed",
  BLOCKED: "blocked",
  FAILED: "failed",
  BUDGET_EXHAUSTED: "budget_exhausted",
  POLICY_DENIED: "policy_denied",
} as const;
export type DelegationResultStatus =
  (typeof DelegationResultStatus)[keyof typeof DelegationResultStatus];
export const delegationResultStatusSchema = z.enum([
  "completed",
  "blocked",
  "failed",
  "budget_exhausted",
  "policy_denied",
]);

export const OutputProfile = {
  TERSE: "terse",
  EXPLANATORY: "explanatory",
  TEACHING: "teaching",
  STRUCTURED: "structured",
} as const;
export type OutputProfile = (typeof OutputProfile)[keyof typeof OutputProfile];
export const outputProfileSchema = z.enum(["terse", "explanatory", "teaching", "structured"]);

export const ApprovalDecision = {
  ALLOW_ONCE: "allow_once",
  ALLOW_FOR_ACTION: "allow_for_action",
  ALLOW_FOR_TASK: "allow_for_task",
  DENY_ONCE: "deny_once",
  DENY_AND_ADD_TASK_RULE: "deny_and_add_task_rule",
  STOP_TASK: "stop_task",
} as const;
export type ApprovalDecision = (typeof ApprovalDecision)[keyof typeof ApprovalDecision];
export const approvalDecisionSchema = z.enum([
  "allow_once",
  "allow_for_action",
  "allow_for_task",
  "deny_once",
  "deny_and_add_task_rule",
  "stop_task",
]);

/** Returns true if a status is terminal (no outgoing transitions). */
export function isTaskTerminal(status: TaskStatus): boolean {
  return TaskTerminalStatus.has(status);
}

/** Returns true if the transition is allowed by the state machine. */
export function isTaskTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** Returns true if the turn transition is allowed by the state machine. */
export function isTurnTransitionAllowed(from: TurnState, to: TurnState): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}

/** Assert all values of a string union are handled; use in exhaustive switches. */
export function assertNever(x: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(x)}`);
}
