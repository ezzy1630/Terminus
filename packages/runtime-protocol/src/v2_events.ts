/**
 * @terminus/runtime-protocol — Agent Runtime Protocol (ARP) v2 Event Catalog.
 *
 * Per SPEC §5, §6, §7, §8, §14, §16, §28, §29:
 * ARP v2 semantic event envelopes, typed payloads, and schemas.
 */
import { z } from "zod";
import type {
  Uuid7,
  Rfc3339Timestamp,
  TraceId,
  ArtifactRef,
  ActorKind,
  EffectState,
  ClaimStatus,
  TaskStatusV2,
  WorkflowNodeKind,
} from "@terminus/domain";
import {
  artifactRefSchema,
  actorKindSchema,
  effectStateSchema,
  claimStatusSchema,
  taskV2Schema,
  taskStatusV2Schema,
  resourceHandleSchema,
} from "@terminus/domain";
import type { TaskV2 } from "@terminus/domain";

// ────────────────────────── Envelope v2 schemas ──────────────────────────────

export const semanticEventActorV2Schema = z.object({
  kind: actorKindSchema,
  id: z.string().min(1),
});

export type SemanticEventActorV2 = z.infer<typeof semanticEventActorV2Schema>;

export interface EventEnvelopeV2<TPayload = Readonly<Record<string, unknown>>> {
  readonly eventId: Uuid7;
  readonly eventType: string;
  readonly schemaVersion: 2;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly occurredAt: Rfc3339Timestamp;
  readonly actor: SemanticEventActorV2;
  readonly correlationId: Uuid7 | null;
  readonly causationId: Uuid7 | null;
  readonly idempotencyKey: string | null;
  readonly payload: TPayload;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly traceId: TraceId | null;
}

export const eventEnvelopeV2Schema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  schemaVersion: z.literal(2),
  aggregateType: z.string(),
  aggregateId: z.string(),
  aggregateSequence: z.number().int().nonnegative(),
  occurredAt: z.string(),
  actor: semanticEventActorV2Schema,
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  artifactRefs: z.array(artifactRefSchema).default([]),
  traceId: z.string().nullable().default(null),
});

// ────────────────────────── ARP v2 Event Types ───────────────────────────────

export const ARP_V2_EVENT_TYPES = [
  // Task lifecycle
  "task.created",
  "task.ready",
  "task.running",
  "task.waiting_user",
  "task.waiting_auth",
  "task.waiting_resource",
  "task.paused",
  "task.verifying",
  "task.completed",
  "task.partial",
  "task.blocked",
  "task.cancelled",
  "task.failed",
  "task.contract_updated",
  "task.scope_updated",
  "task.conversation_context_attached",

  // Workflow lifecycle
  "workflow.created",
  "workflow.node_started",
  "workflow.node_completed",
  "workflow.node_failed",
  "workflow.completed",
  "workflow.paused",
  "workflow.resumed",
  "workflow.cancelled",

  // Worker Lease lifecycle
  "lease.acquired",
  "lease.renewed",
  "lease.released",
  "lease.fenced",

  // Task Attempt lifecycle
  "attempt.started",
  "attempt.recovering",
  "attempt.completed",
  "attempt.failed",

  // Claim lifecycle
  "claim.proposed",
  "claim.satisfied",
  "claim.disputed",
  "claim.waived",

  // Evidence
  "evidence.recorded",
  "evidence.verified",

  // Effect Ledger (17 states)
  "effect.proposed",
  "effect.policy_checked",
  "effect.authorization_required",
  "effect.authorized",
  "effect.prepared",
  "effect.dispatched",
  "effect.observed",
  "effect.validated",
  "effect.committed",
  "effect.denied",
  "effect.cancelled",
  "effect.uncertain",
  "effect.reconciling",
  "effect.compensating",
  "effect.compensated",
  "effect.residue",
  "effect.manual_reconcile",

  // Authorization & Approvals
  "authorization.created",
  "authorization.consumed",
  "authorization.revoked",
  "authorization.expired",
  "approval.requested",
  "approval.resolved",

  // Questions, Decisions, Risks & Attention
  "question.asked",
  "question.answered",
  "question.dismissed",
  "decision.recorded",
  "risk.detected",
  "risk.recorded",
  "risk.mitigated",
  "attention.signaled",

  // Budget
  "budget.consumed",
  "budget.exhausted",

  // Organization & Operator
  "operator.registered",
  "operator.message_sent",
  "operator.message_received",

  // Capabilities
  "capability.registered",
  "capability.revoked",
] as const;

export type ArpV2EventType = (typeof ARP_V2_EVENT_TYPES)[number];

// ────────────────────────── Payload Schemas ──────────────────────────────────

// Task Payloads
export const taskCreatedV2PayloadSchema = z.object({
  taskId: z.string(),
  missionId: z.string().nullable().default(null),
  organizationId: z.string(),
  departmentId: z.string(),
  objective: z.string(),
  contractVersion: z.number().int().positive(),
  mode: z.string(),
});
export type TaskCreatedV2Payload = z.infer<typeof taskCreatedV2PayloadSchema>;

export const taskTransitionV2PayloadSchema = z.object({
  taskId: z.string(),
  fromStatus: taskStatusV2Schema,
  toStatus: taskStatusV2Schema,
  version: z.number().int().nonnegative(),
  reason: z.string().nullable().default(null),
});
export type TaskTransitionV2Payload = z.infer<typeof taskTransitionV2PayloadSchema>;

// Control-plane task events carry the aggregate post-state so replay can
// rebuild the task map without consulting a second projection. The former
// flat payload shape did not match that wire contract.
export const taskConversationContextAttachedV2PayloadSchema = taskV2Schema;
export type TaskConversationContextAttachedV2Payload = TaskV2;

// Workflow Payloads
export const workflowCreatedPayloadSchema = z.object({
  workflowId: z.string(),
  taskId: z.string(),
  version: z.number().int().positive(),
  nodeCount: z.number().int().nonnegative(),
});
export type WorkflowCreatedPayload = z.infer<typeof workflowCreatedPayloadSchema>;

export const workflowNodeStartedPayloadSchema = z.object({
  workflowId: z.string(),
  nodeId: z.string(),
  nodeRunId: z.string(),
  nodeKind: z.string(),
  attemptId: z.string(),
});
export type WorkflowNodeStartedPayload = z.infer<typeof workflowNodeStartedPayloadSchema>;

export const workflowNodeCompletedPayloadSchema = z.object({
  workflowId: z.string(),
  nodeId: z.string(),
  nodeRunId: z.string(),
  outputs: z.record(z.string(), z.unknown()),
});
export type WorkflowNodeCompletedPayload = z.infer<typeof workflowNodeCompletedPayloadSchema>;

export const workflowNodeFailedPayloadSchema = z.object({
  workflowId: z.string(),
  nodeId: z.string(),
  nodeRunId: z.string(),
  error: z.string(),
  recoverable: z.boolean().default(false),
});
export type WorkflowNodeFailedPayload = z.infer<typeof workflowNodeFailedPayloadSchema>;

// Claim & Evidence Payloads
export const claimProposedPayloadSchema = z.object({
  claimId: z.string(),
  taskId: z.string(),
  statement: z.string(),
  requiredEvidenceKind: z.string(),
});
export type ClaimProposedPayload = z.infer<typeof claimProposedPayloadSchema>;

export const claimStatusChangedPayloadSchema = z.object({
  claimId: z.string(),
  taskId: z.string(),
  status: claimStatusSchema,
  rationale: z.string().nullable().default(null),
});
export type ClaimStatusChangedPayload = z.infer<typeof claimStatusChangedPayloadSchema>;

export const evidenceRecordedPayloadSchema = z.object({
  evidenceId: z.string(),
  claimId: z.string(),
  kind: z.string(),
  summary: z.string(),
  verifierResult: z.string(),
  sourceRevision: z.string().nullable().default(null),
});
export type EvidenceRecordedPayload = z.infer<typeof evidenceRecordedPayloadSchema>;

// Effect Payloads
export const effectProposedV2PayloadSchema = z.object({
  effectId: z.string(),
  taskId: z.string(),
  attemptId: z.string(),
  principal: z.string(),
  effectClass: z.string(),
  intentType: z.string(),
  semanticIdempotencyKey: z.string(),
  resourceHandles: z.array(resourceHandleSchema).default([]),
});
export type EffectProposedV2Payload = z.infer<typeof effectProposedV2PayloadSchema>;


export const effectTransitionPayloadSchema = z.object({
  effectId: z.string(),
  taskId: z.string(),
  fromState: effectStateSchema,
  toState: effectStateSchema,
  version: z.number().int().nonnegative(),
  reason: z.string().nullable().default(null),
  uncertaintyReason: z.string().nullable().default(null),
  compensationRef: z.string().nullable().default(null),
});
export type EffectTransitionPayload = z.infer<typeof effectTransitionPayloadSchema>;

// Authorization Payloads
export const authorizationCreatedPayloadSchema = z.object({
  authorizationId: z.string(),
  principal: z.string(),
  taskId: z.string(),
  effectClass: z.string(),
  maxScope: z.array(z.string()),
  useLimit: z.number().int().positive(),
  expiry: z.string(),
});
export type AuthorizationCreatedPayload = z.infer<typeof authorizationCreatedPayloadSchema>;

export const authorizationConsumedPayloadSchema = z.object({
  authorizationId: z.string(),
  effectId: z.string(),
  consumedCount: z.number().int().positive(),
  remainingUses: z.number().int().nonnegative(),
});
export type AuthorizationConsumedPayload = z.infer<typeof authorizationConsumedPayloadSchema>;

// Questions & Decisions Payloads
export const questionAskedPayloadSchema = z.object({
  questionId: z.string(),
  taskId: z.string(),
  prompt: z.string(),
  options: z.array(z.string()),
});
export type QuestionAskedPayload = z.infer<typeof questionAskedPayloadSchema>;

export const questionAnsweredPayloadSchema = z.object({
  questionId: z.string(),
  taskId: z.string(),
  selectedOption: z.string(),
  rationale: z.string().nullable().default(null),
});
export type QuestionAnsweredPayload = z.infer<typeof questionAnsweredPayloadSchema>;

export const decisionRecordedPayloadSchema = z.object({
  decisionId: z.string(),
  taskId: z.string(),
  questionId: z.string().nullable().default(null),
  statement: z.string(),
  rationale: z.string(),
  provenance: z.string(),
});
export type DecisionRecordedPayload = z.infer<typeof decisionRecordedPayloadSchema>;

export const attentionSignaledPayloadSchema = z.object({
  signalId: z.string(),
  taskId: z.string(),
  kind: z.string(),
  message: z.string(),
  requiresUserAction: z.boolean(),
});
export type AttentionSignaledPayload = z.infer<typeof attentionSignaledPayloadSchema>;

// Lease Payloads
export const leaseAcquiredPayloadSchema = z.object({
  leaseId: z.string(),
  taskId: z.string(),
  workerId: z.string(),
  fencingToken: z.number().int().positive(),
  expiresAt: z.string(),
});
export type LeaseAcquiredPayload = z.infer<typeof leaseAcquiredPayloadSchema>;

export const leaseRenewedPayloadSchema = z.object({
  leaseId: z.string(),
  taskId: z.string(),
  workerId: z.string(),
  fencingToken: z.number().int().positive(),
  expiresAt: z.string(),
});
export type LeaseRenewedPayload = z.infer<typeof leaseRenewedPayloadSchema>;

export const leaseReleasedPayloadSchema = z.object({
  leaseId: z.string(),
  taskId: z.string(),
  workerId: z.string(),
  fencingToken: z.number().int().positive(),
});
export type LeaseReleasedPayload = z.infer<typeof leaseReleasedPayloadSchema>;

export const leaseFencedPayloadSchema = z.object({
  leaseId: z.string(),
  taskId: z.string(),
  supersededByToken: z.number().int().positive(),
});
export type LeaseFencedPayload = z.infer<typeof leaseFencedPayloadSchema>;

// Attempt Payloads
export const attemptStartedPayloadSchema = z.object({
  attemptId: z.string(),
  taskId: z.string(),
  attemptNumber: z.number().int().positive(),
  workerId: z.string(),
  fencingToken: z.number().int().positive(),
});
export type AttemptStartedPayload = z.infer<typeof attemptStartedPayloadSchema>;

export const attemptRecoveringPayloadSchema = z.object({
  attemptId: z.string(),
  taskId: z.string(),
  reason: z.string(),
});
export type AttemptRecoveringPayload = z.infer<typeof attemptRecoveringPayloadSchema>;

export const attemptCompletedPayloadSchema = z.object({
  attemptId: z.string(),
  taskId: z.string(),
  attemptNumber: z.number().int().positive(),
});
export type AttemptCompletedPayload = z.infer<typeof attemptCompletedPayloadSchema>;

export const attemptFailedPayloadSchema = z.object({
  attemptId: z.string(),
  taskId: z.string(),
  attemptNumber: z.number().int().positive(),
  error: z.string(),
});
export type AttemptFailedPayload = z.infer<typeof attemptFailedPayloadSchema>;

// Risk & Budget Payloads
export const riskRecordedPayloadSchema = z.object({
  riskId: z.string(),
  taskId: z.string(),
  riskClass: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]),
  statement: z.string(),
  mitigation: z.string().nullable().default(null),
});
export type RiskRecordedPayload = z.infer<typeof riskRecordedPayloadSchema>;

export const riskMitigatedPayloadSchema = z.object({
  riskId: z.string(),
  taskId: z.string(),
  mitigation: z.string(),
});
export type RiskMitigatedPayload = z.infer<typeof riskMitigatedPayloadSchema>;

export const budgetConsumedPayloadSchema = z.object({
  taskId: z.string(),
  consumedCostMicros: z.bigint(),
  consumedComputeSeconds: z.number(),
  consumedInputTokens: z.bigint(),
  consumedOutputTokens: z.bigint(),
  consumedApprovals: z.number(),
});
export type BudgetConsumedPayload = z.infer<typeof budgetConsumedPayloadSchema>;

export const budgetExhaustedPayloadSchema = z.object({
  taskId: z.string(),
  limitKind: z.string(),
  consumed: z.string(),
  limit: z.string(),
});
export type BudgetExhaustedPayload = z.infer<typeof budgetExhaustedPayloadSchema>;

// ────────────────────────── Event Payload Map ────────────────────────────────

export interface ArpV2PayloadMap {
  "task.created": TaskCreatedV2Payload;
  "task.ready": TaskTransitionV2Payload;
  "task.running": TaskTransitionV2Payload;
  "task.waiting_user": TaskTransitionV2Payload;
  "task.waiting_auth": TaskTransitionV2Payload;
  "task.waiting_resource": TaskTransitionV2Payload;
  "task.paused": TaskTransitionV2Payload;
  "task.verifying": TaskTransitionV2Payload;
  "task.completed": TaskTransitionV2Payload;
  "task.partial": TaskTransitionV2Payload;
  "task.blocked": TaskTransitionV2Payload;
  "task.cancelled": TaskTransitionV2Payload;
  "task.failed": TaskTransitionV2Payload;
  "task.contract_updated": Readonly<Record<string, unknown>>;
  "task.scope_updated": Readonly<Record<string, unknown>>;
  "task.conversation_context_attached": TaskConversationContextAttachedV2Payload;

  "workflow.created": WorkflowCreatedPayload;
  "workflow.node_started": WorkflowNodeStartedPayload;
  "workflow.node_completed": WorkflowNodeCompletedPayload;
  "workflow.node_failed": WorkflowNodeFailedPayload;
  "workflow.completed": Readonly<Record<string, unknown>>;
  "workflow.paused": { readonly workflowId: string };
  "workflow.resumed": { readonly workflowId: string };
  "workflow.cancelled": { readonly workflowId: string; readonly reason?: string | undefined };

  "lease.acquired": LeaseAcquiredPayload;
  "lease.renewed": LeaseRenewedPayload;
  "lease.released": LeaseReleasedPayload;
  "lease.fenced": LeaseFencedPayload;

  "attempt.started": AttemptStartedPayload;
  "attempt.recovering": AttemptRecoveringPayload;
  "attempt.completed": AttemptCompletedPayload;
  "attempt.failed": AttemptFailedPayload;

  "claim.proposed": ClaimProposedPayload;
  "claim.satisfied": ClaimStatusChangedPayload;
  "claim.disputed": ClaimStatusChangedPayload;
  "claim.waived": ClaimStatusChangedPayload;

  "evidence.recorded": EvidenceRecordedPayload;
  "evidence.verified": EvidenceRecordedPayload;

  "effect.proposed": EffectProposedV2Payload;
  "effect.policy_checked": EffectTransitionPayload;

  "effect.authorization_required": EffectTransitionPayload;
  "effect.authorized": EffectTransitionPayload;
  "effect.prepared": EffectTransitionPayload;
  "effect.dispatched": EffectTransitionPayload;
  "effect.observed": EffectTransitionPayload;
  "effect.validated": EffectTransitionPayload;
  "effect.committed": EffectTransitionPayload;
  "effect.denied": EffectTransitionPayload;
  "effect.cancelled": EffectTransitionPayload;
  "effect.uncertain": EffectTransitionPayload;
  "effect.reconciling": EffectTransitionPayload;
  "effect.compensating": EffectTransitionPayload;
  "effect.compensated": EffectTransitionPayload;
  "effect.residue": EffectTransitionPayload;
  "effect.manual_reconcile": EffectTransitionPayload;

  "authorization.created": AuthorizationCreatedPayload;
  "authorization.consumed": AuthorizationConsumedPayload;
  "authorization.revoked": Readonly<Record<string, unknown>>;
  "authorization.expired": Readonly<Record<string, unknown>>;
  "approval.requested": Readonly<Record<string, unknown>>;
  "approval.resolved": Readonly<Record<string, unknown>>;

  "question.asked": QuestionAskedPayload;
  "question.answered": QuestionAnsweredPayload;
  "question.dismissed": Readonly<Record<string, unknown>>;
  "decision.recorded": DecisionRecordedPayload;
  "risk.detected": Readonly<Record<string, unknown>>;
  "risk.recorded": RiskRecordedPayload;
  "risk.mitigated": RiskMitigatedPayload;
  "attention.signaled": AttentionSignaledPayload;

  "budget.consumed": BudgetConsumedPayload;
  "budget.exhausted": BudgetExhaustedPayload;

  "operator.registered": Readonly<Record<string, unknown>>;
  "operator.message_sent": Readonly<Record<string, unknown>>;
  "operator.message_received": Readonly<Record<string, unknown>>;

  "capability.registered": Readonly<Record<string, unknown>>;
  "capability.revoked": Readonly<Record<string, unknown>>;
}

export type TypedEventV2<T extends ArpV2EventType> = EventEnvelopeV2<ArpV2PayloadMap[T]>;
export type AnyTypedEventV2 = {
  [K in ArpV2EventType]: TypedEventV2<K>;
}[ArpV2EventType];

// ────────────────────────── Event Sink & Observer V2 ─────────────────────────

export interface EventSinkV2 {
  emit<T extends ArpV2EventType>(
    type: T,
    payload: ArpV2PayloadMap[T],
    options: {
      aggregateId: string;
      aggregateSequence: number;
      actor: SemanticEventActorV2;
      occurredAt?: Rfc3339Timestamp | undefined;
      correlationId?: Uuid7 | null | undefined;
      causationId?: Uuid7 | null | undefined;
      idempotencyKey?: string | null | undefined;
      artifactRefs?: readonly ArtifactRef[] | undefined;
      traceId?: TraceId | null | undefined;
    },
  ): Promise<TypedEventV2<T>>;
}

export interface EventObserverV2 {
  onEvent(event: AnyTypedEventV2): Promise<void> | void;
}
