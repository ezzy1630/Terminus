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
