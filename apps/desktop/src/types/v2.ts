/**
 * Terminus Desktop — ARP v2 canonical wire types (SPEC §5–§16, §32).
 *
 * These mirror the canonical domain aggregates in `@terminus/domain`, but
 * encoded exactly as they cross the HTTP boundary:
 *   - `Micros` bigint values are decimal strings on the wire.
 *   - Timestamps are RFC 3339 strings.
 *
 * The desktop never imports provider or server internals; these are the
 * canonical protocol shapes only. All responses are treated as `unknown`
 * and validated at the call sites in lib/api-v2.ts.
 */

export const TASK_V2_STATUSES = [
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
] as const;
export type TaskV2Status = (typeof TASK_V2_STATUSES)[number];

export interface TaskContractScopeV2 {
  resources: unknown[];
  allowedEffectClasses: string[];
  excludedPathsOrSystems: string[];
}

export interface TaskAcceptanceCriterionV2 {
  claimId: string;
  statement: string;
  evidenceRequirement: string;
}

/** `costMicros` is a decimal-string-encoded bigint on the wire. */
export interface TaskConstraintsV2 {
  security: string[];
  costMicros: string;
  timeoutSeconds: number;
}

export interface TaskContractV2 {
  version: number;
  mission: string;
  scope: TaskContractScopeV2;
  acceptance: TaskAcceptanceCriterionV2[];
  constraints: TaskConstraintsV2;
  authorityCeiling: string[];
  mode: string;
}

export interface TaskV2Snapshot {
  id: string;
  missionId: string | null;
  organizationId: string;
  departmentId: string;
  createdBy: string;
  conversationContext: {
    sessionId: string;
    threadId: string;
    attachedAt: string;
  } | null;
  contract: TaskContractV2;
  status: TaskV2Status;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export const EFFECT_STATES = [
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
] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

export interface EffectSnapshot {
  id: string;
  taskId: string;
  attemptId: string;
  principal: string;
  connectorOrWorker: string;
  intentType: string;
  canonicalParameters: Record<string, unknown>;
  resourceHandles: unknown[];
  effectClass: string;
  semanticIdempotencyKey: string;
  authorizationId: string | null;
  policyDecisionId: string | null;
  state: EffectState;
  uncertaintyReason: string | null;
  compensationRef: string | null;
  version: number;
  createdAt: string;
  settledAt: string | null;
}

export const CLAIM_STATUSES = ["PROPOSED", "SATISFIED", "DISPUTED", "WAIVED"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export interface ClaimSnapshot {
  id: string;
  taskId: string;
  statement: string;
  requiredEvidenceKind: string;
  status: ClaimStatus;
  evidenceIds: string[];
  waivedRationale: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceArtifactRef {
  hash: string;
  uri: string;
  mediaType: string;
  bytes: string;
}

export interface EvidenceSnapshot {
  id: string;
  claimId: string;
  kind: string;
  summary: string;
  sourceRevision: string | null;
  environmentHash: string | null;
  verifierResult: string;
  artifactRef: EvidenceArtifactRef | null;
  metadata: Record<string, unknown>;
  observedAt: string;
}

// ────────────────────────── Phase 9 operator cockpit ──────────────────────

export interface OrganizationSnapshot {
  id: string;
  displayName: string;
  rootPolicyProfile: string;
  createdAt: string;
}

export interface DepartmentSnapshot {
  id: string;
  organizationId: string;
  displayName: string;
  policyProfile: string;
  defaultOperatorId: string | null;
  createdAt: string;
}

export interface OperatorAgentSnapshot {
  id: string;
  departmentId: string;
  displayName: string;
  capabilityScope: string[];
  modelProfile: string;
  active: boolean;
}

export interface AgentRoomSnapshot {
  id: string;
  departmentId: string;
  name: string;
  operatorId: string;
  activeWorkerIds: string[];
  specialistIds: string[];
  reviewerIds: string[];
  supervisorId: string | null;
  createdAt: string;
}

export const CAPABILITY_DIRECTORY_STATUSES = ["AVAILABLE", "RESTRICTED", "OFFLINE"] as const;
export type CapabilityDirectoryStatus = (typeof CAPABILITY_DIRECTORY_STATUSES)[number];

export interface CapabilityDirectoryEntrySnapshot {
  id: string;
  capabilityId: string;
  category: string;
  providerOperatorId: string;
  resourceDomain: string;
  authorityRequirement: string[];
  status: CapabilityDirectoryStatus;
}

export const MATERIALITY_TRIGGERS = [
  "interpretation_divergence",
  "authority_expansion",
  "irreversible_effect",
  "external_effect",
  "missing_grant",
  "human_taste",
  "confidence_collapse",
] as const;
export type MaterialityTrigger = (typeof MATERIALITY_TRIGGERS)[number];

export const MATERIAL_QUESTION_STATUSES = ["PENDING", "ANSWERED", "DISMISSED"] as const;
export type MaterialQuestionStatus = (typeof MATERIAL_QUESTION_STATUSES)[number];

export interface MaterialQuestionSnapshot {
  id: string;
  taskId: string;
  trigger: MaterialityTrigger;
  questionText: string;
  consequenceMatrix: Record<string, string>;
  options: string[];
  status: MaterialQuestionStatus;
  suggestedOption: string | null;
  selectedOption: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export const ATTENTION_URGENCIES = ["LOW", "NORMAL", "HIGH", "BLOCKING"] as const;
export type AttentionUrgency = (typeof ATTENTION_URGENCIES)[number];

export interface AttentionAssessmentSnapshot {
  taskId: string;
  requiresAttention: boolean;
  urgency: AttentionUrgency;
  pendingQuestions: MaterialQuestionSnapshot[];
  reason: string;
  timestamp: string;
}

export interface MaterialQuestionResolution {
  success: boolean;
  question: MaterialQuestionSnapshot | null;
  error: string | null;
}

export const STRUCTURED_INTERVENTION_VERBS = [
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
] as const;
export type StructuredInterventionVerb = (typeof STRUCTURED_INTERVENTION_VERBS)[number];

export const STRUCTURED_INTERVENTION_STATUSES = ["PROPOSED", "APPLIED", "REJECTED"] as const;
export type StructuredInterventionStatus = (typeof STRUCTURED_INTERVENTION_STATUSES)[number];

export interface StructuredInterventionSnapshot {
  id: string;
  taskId: string;
  attemptId: string | null;
  actorPrincipal: string;
  verb: StructuredInterventionVerb;
  targetEntityId: string | null;
  payload: Record<string, unknown>;
  rationale: string;
  status: StructuredInterventionStatus;
  timestamp: string;
}

export interface InterventionApplicationResult {
  success: boolean;
  intervention: StructuredInterventionSnapshot;
  appliedChanges: Record<string, unknown>;
  error: string | null;
}

export interface CausalStepSnapshot {
  stepIndex: number;
  component: string;
  inputManifestHash: string;
  modelOutputHash: string | null;
  effectId: string | null;
  verifierResult: string | null;
  durationMs: number;
  counterfactualAlternative: string | null;
}

export interface OmissionDiagnosticSnapshot {
  blockId: string;
  sourcePath: string;
  omittedReason: string;
  causalRelevanceScore: number;
  evaluatorId: string;
  evidenceRefs: string[];
}

export interface CausalReplayTraceSnapshot {
  id: string;
  taskId: string;
  attemptId: string;
  pinnedInputsHash: string;
  steps: CausalStepSnapshot[];
  divergencePoints: string[];
  omissionDiagnostics: OmissionDiagnosticSnapshot[];
  createdAt: string;
}

export const COUNTERFACTUAL_VARIATION_TYPES = ["profile", "prompt", "retrieval", "intervention"] as const;
export type CounterfactualVariationType = (typeof COUNTERFACTUAL_VARIATION_TYPES)[number];

export interface CounterfactualExperimentSnapshot {
  id: string;
  sourceTaskId: string;
  variationType: CounterfactualVariationType;
  variationDetails: Record<string, unknown>;
  executionStatus: "planned" | "completed";
  predictedOutcome: string;
  actualOutcome: string | null;
  deltaSuccess: boolean | null;
  /** bigint values are decimal strings at the JSON boundary. */
  deltaCostMicros: string | null;
  deltaLatencyMs: number | null;
}

export interface TaskBudgetSnapshot {
  taskId: string;
  consumedCostMicros: string;
  consumedComputeSeconds: number;
  consumedInputTokens: string;
  consumedOutputTokens: string;
  consumedApprovals: number;
  lastUpdatedAt: string;
}

export const MOBILE_QUICK_ACTIONS = ["pause", "resume", "approve_effect", "terminate", "request_review"] as const;
export type MobileQuickAction = (typeof MOBILE_QUICK_ACTIONS)[number];

export interface MobileSupervisionSessionSnapshot {
  id: string;
  taskId: string;
  operatorPrincipal: string;
  devicePlatform: "ios" | "android" | "web";
  connectionState: "CONNECTED" | "SUSPENDED" | "DISCONNECTED";
  quickActions: MobileQuickAction[];
  lastSeenAt: string;
}

export interface MobileActionResult {
  success: boolean;
  action: MobileQuickAction;
  timestamp: string;
}

/** Canonical v2 event envelope delivered over `GET /v2/events` (SSE). */
export interface ArpV2EventEnvelope<TPayload = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  schemaVersion: 2;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: number;
  occurredAt: string;
  actor: { kind: string; id: string };
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
  payload: TPayload;
  artifactRefs: unknown[];
  traceId: string | null;
}
