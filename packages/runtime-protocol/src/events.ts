/**
 * @terminus/runtime-protocol — Agent Runtime Protocol (ARP) event union.
 *
 * Per SPEC §28.9 every semantic audit event carries an envelope with:
 * event_id, event_type, schema_version, aggregate_type, aggregate_id,
 * aggregate_sequence, occurred_at, actor, correlation_id, causation_id,
 * idempotency_key, payload, artifact_refs, trace_id.
 */
import { z } from "zod";
import type {
  Uuid7,
  Rfc3339Timestamp,
  TraceId,
  ArtifactRef,
  PrincipalId,
  ActorKind,
  ModelKey,
  ContentHash,
} from "@terminus/domain";
import {
  artifactRefSchema,
  actorKindSchema,
} from "@terminus/domain";

// ────────────────────────── Envelope schemas ─────────────────────────────────

export const semanticEventActorSchema = z.object({
  kind: actorKindSchema,
  id: z.string(),
});

export type SemanticEventActor = z.infer<typeof semanticEventActorSchema>;

export interface EventEnvelope<TPayload = Readonly<Record<string, unknown>>> {
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
  readonly payload: TPayload;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly traceId: TraceId | null;
}

export const eventEnvelopeSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  aggregateSequence: z.number().int().nonnegative(),
  occurredAt: z.string(),
  actor: semanticEventActorSchema,
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  artifactRefs: z.array(artifactRefSchema),
  traceId: z.string().nullable(),
});

// ────────────────────────── Event type catalogue ─────────────────────────────

export const EVENT_TYPES = [
  "task.created",
  "task.activated",
  "task.completed",
  "task.failed",
  "task.aborted",
  "task.failed_verification",
  "task.budget_exhausted",
  "task.policy_denied",
  "task.contract_updated",
  "task.scope_entry_recorded",
  "turn.started",
  "turn.context_compiled",
  "turn.provider_running",
  "turn.tool_settled",
  "turn.completed",
  "tool.proposed",
  "tool.authorized",
  "tool.started",
  "tool.settled",
  "tool.failed",
  "policy.decision",
  "approval.requested",
  "approval.resolved",
  "effect.proposed",
  "effect.authorized",
  "effect.started",
  "effect.settled",
  "context.epoch_started",
  "context.epoch_sealed",
  "context.manifest_persisted",
  "checkpoint.created",
  "agent.spawned",
  "agent.completed",
  "verification.node_passed",
  "verification.node_failed",
  "verification.plan_completed",
  "memory.claim_created",
  "memory.claim_invalidated",
  "capability.activated",
  "capability.deactivated",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const eventTypeSchema = z.enum(EVENT_TYPES);

export const AGGREGATE_TYPES = [
  "task",
  "turn",
  "tool",
  "policy",
  "approval",
  "effect",
  "context",
  "checkpoint",
  "agent",
  "verification",
  "memory",
  "capability",
] as const;
export type AggregateType = (typeof AGGREGATE_TYPES)[number];
export const aggregateTypeSchema = z.enum(AGGREGATE_TYPES);

// ────────────────────────── Payload schemas ──────────────────────────────────

export const taskCreatedPayloadSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  threadId: z.string(),
  objective: z.string(),
  riskClass: z.string(),
});
export type TaskCreatedPayload = z.infer<typeof taskCreatedPayloadSchema>;

export const taskActivatedPayloadSchema = z.object({
  taskId: z.string(),
  contractVersion: z.number().int().nonnegative(),
});
export type TaskActivatedPayload = z.infer<typeof taskActivatedPayloadSchema>;

export const taskCompletedPayloadSchema = z.object({
  taskId: z.string(),
  finalRevision: z.string(),
  completionRecordHash: z.string(),
  costMicros: z.bigint(),
  durationSeconds: z.number(),
});
export type TaskCompletedPayload = z.infer<typeof taskCompletedPayloadSchema>;

export const taskFailedPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string(),
  failureCode: z.string(),
});
export type TaskFailedPayload = z.infer<typeof taskFailedPayloadSchema>;

export const taskAbortedPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string(),
});
export type TaskAbortedPayload = z.infer<typeof taskAbortedPayloadSchema>;

export const taskFailedVerificationPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string(),
});
export type TaskFailedVerificationPayload = z.infer<
  typeof taskFailedVerificationPayloadSchema
>;

export const taskBudgetExhaustedPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string(),
});
export type TaskBudgetExhaustedPayload = z.infer<
  typeof taskBudgetExhaustedPayloadSchema
>;

export const taskPolicyDeniedPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string(),
});
export type TaskPolicyDeniedPayload = z.infer<typeof taskPolicyDeniedPayloadSchema>;

export const taskContractUpdatedPayloadSchema = z.object({
  taskId: z.string(),
  previousVersion: z.number().int().nonnegative(),
  newVersion: z.number().int().nonnegative(),
  changeSummary: z.string(),
});
export type TaskContractUpdatedPayload = z.infer<typeof taskContractUpdatedPayloadSchema>;

export const taskScopeEntryRecordedPayloadSchema = z.object({
  taskId: z.string(),
  entryKind: z.string(),
  path: z.string().nullable(),
  externalSystem: z.string().nullable(),
  justification: z.string().nullable(),
});
export type TaskScopeEntryRecordedPayload = z.infer<
  typeof taskScopeEntryRecordedPayloadSchema
>;

export const turnStartedPayloadSchema = z.object({
  turnId: z.string(),
  threadId: z.string(),
  taskId: z.string().nullable(),
  initiatedBy: z.string(),
});
export type TurnStartedPayload = z.infer<typeof turnStartedPayloadSchema>;

export const turnContextCompiledPayloadSchema = z.object({
  turnId: z.string(),
  manifestId: z.string(),
  epochId: z.string(),
  estimatedInputTokens: z.number().int().nonnegative(),
  omittedFragmentCount: z.number().int().nonnegative(),
});
export type TurnContextCompiledPayload = z.infer<typeof turnContextCompiledPayloadSchema>;

export const turnProviderRunningPayloadSchema = z.object({
  turnId: z.string(),
  provider: z.string(),
  model: z.string(),
  attemptId: z.string(),
  attemptNumber: z.number().int().nonnegative(),
  continuationId: z.string().nullable(),
});
export type TurnProviderRunningPayload = z.infer<typeof turnProviderRunningPayloadSchema>;

export const turnToolSettledPayloadSchema = z.object({
  turnId: z.string(),
  toolCallId: z.string(),
  toolId: z.string(),
  resultStatus: z.string(),
});
export type TurnToolSettledPayload = z.infer<typeof turnToolSettledPayloadSchema>;

export const turnCompletedPayloadSchema = z.object({
  turnId: z.string(),
  finalizedAt: z.string(),
  outputArtifactHash: z.string().nullable(),
});
export type TurnCompletedPayload = z.infer<typeof turnCompletedPayloadSchema>;

export const toolProposedPayloadSchema = z.object({
  toolCallId: z.string(),
  turnId: z.string(),
  toolId: z.string(),
  toolVersion: z.string(),
  argumentsHash: z.string(),
});
export type ToolProposedPayload = z.infer<typeof toolProposedPayloadSchema>;

export const toolAuthorizedPayloadSchema = z.object({
  toolCallId: z.string(),
  policyDecisionId: z.string(),
  approvalId: z.string().nullable(),
});
export type ToolAuthorizedPayload = z.infer<typeof toolAuthorizedPayloadSchema>;

export const toolStartedPayloadSchema = z.object({
  toolCallId: z.string(),
  startedAt: z.string(),
});
export type ToolStartedPayload = z.infer<typeof toolStartedPayloadSchema>;

export const toolSettledPayloadSchema = z.object({
  toolCallId: z.string(),
  resultStatus: z.string(),
  resultArtifactHash: z.string().nullable(),
  settledAt: z.string(),
});
export type ToolSettledPayload = z.infer<typeof toolSettledPayloadSchema>;

export const toolFailedPayloadSchema = z.object({
  toolCallId: z.string(),
  failureCode: z.string(),
  reason: z.string(),
});
export type ToolFailedPayload = z.infer<typeof toolFailedPayloadSchema>;

export const policyDecisionPayloadSchema = z.object({
  policyDecisionId: z.string(),
  effectType: z.string(),
  decision: z.enum(["allow", "deny", "prompt"]),
  matchedRules: z.array(z.string()),
  reason: z.string(),
});
export type PolicyDecisionPayload = z.infer<typeof policyDecisionPayloadSchema>;

export const approvalRequestedPayloadSchema = z.object({
  approvalId: z.string(),
  taskId: z.string(),
  operationSummary: z.string(),
  risk: z.string(),
  reversibility: z.string(),
});
export type ApprovalRequestedPayload = z.infer<typeof approvalRequestedPayloadSchema>;

export const approvalResolvedPayloadSchema = z.object({
  approvalId: z.string(),
  decision: z.string(),
  decidedBy: z.string(),
});
export type ApprovalResolvedPayload = z.infer<typeof approvalResolvedPayloadSchema>;

export const effectProposedPayloadSchema = z.object({
  sideEffectId: z.string(),
  taskId: z.string(),
  kind: z.string(),
  idempotencyKey: z.string(),
});
export type EffectProposedPayload = z.infer<typeof effectProposedPayloadSchema>;

export const effectAuthorizedPayloadSchema = z.object({
  sideEffectId: z.string(),
  approvalId: z.string().nullable(),
});
export type EffectAuthorizedPayload = z.infer<typeof effectAuthorizedPayloadSchema>;

export const effectStartedPayloadSchema = z.object({
  sideEffectId: z.string(),
  startedAt: z.string(),
});
export type EffectStartedPayload = z.infer<typeof effectStartedPayloadSchema>;

export const effectSettledPayloadSchema = z.object({
  sideEffectId: z.string(),
  result: z.string(),
  settledAt: z.string(),
});
export type EffectSettledPayload = z.infer<typeof effectSettledPayloadSchema>;

export const contextEpochStartedPayloadSchema = z.object({
  epochId: z.string(),
  threadId: z.string(),
  baselineHash: z.string(),
  provider: z.string(),
  model: z.string(),
});
export type ContextEpochStartedPayload = z.infer<typeof contextEpochStartedPayloadSchema>;

export const contextEpochSealedPayloadSchema = z.object({
  epochId: z.string(),
  sealedAt: z.string(),
  supersededBy: z.string().nullable(),
});
export type ContextEpochSealedPayload = z.infer<typeof contextEpochSealedPayloadSchema>;

export const contextManifestPersistedPayloadSchema = z.object({
  manifestId: z.string(),
  epochId: z.string(),
  providerAttemptId: z.string().nullable(),
  artifactHash: z.string(),
  predictedCachedTokens: z.number().int().nonnegative(),
});
export type ContextManifestPersistedPayload = z.infer<
  typeof contextManifestPersistedPayloadSchema
>;

export const checkpointCreatedPayloadSchema = z.object({
  checkpointId: z.string(),
  threadId: z.string(),
  turnId: z.string().nullable(),
  artifactHash: z.string(),
  summary: z.string(),
});
export type CheckpointCreatedPayload = z.infer<typeof checkpointCreatedPayloadSchema>;

export const agentSpawnedPayloadSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  role: z.string(),
  parentAgentId: z.string().nullable(),
  worktreeId: z.string().nullable(),
});
export type AgentSpawnedPayload = z.infer<typeof agentSpawnedPayloadSchema>;

export const agentCompletedPayloadSchema = z.object({
  agentId: z.string(),
  status: z.string(),
  completedAt: z.string(),
});
export type AgentCompletedPayload = z.infer<typeof agentCompletedPayloadSchema>;

export const verificationNodePassedPayloadSchema = z.object({
  planId: z.string(),
  nodeId: z.string(),
  resultId: z.string(),
  sourceRevision: z.string(),
});
export type VerificationNodePassedPayload = z.infer<
  typeof verificationNodePassedPayloadSchema
>;

export const verificationNodeFailedPayloadSchema = z.object({
  planId: z.string(),
  nodeId: z.string(),
  resultId: z.string(),
  failureCode: z.string(),
  reason: z.string(),
});
export type VerificationNodeFailedPayload = z.infer<
  typeof verificationNodeFailedPayloadSchema
>;

export const verificationPlanCompletedPayloadSchema = z.object({
  planId: z.string(),
  taskId: z.string(),
  passed: z.boolean(),
  completionRecordHash: z.string().nullable(),
});
export type VerificationPlanCompletedPayload = z.infer<
  typeof verificationPlanCompletedPayloadSchema
>;

export const memoryClaimCreatedPayloadSchema = z.object({
  claimId: z.string(),
  kind: z.string(),
  statement: z.string(),
  confidencePpm: z.number().int().nonnegative(),
});
export type MemoryClaimCreatedPayload = z.infer<typeof memoryClaimCreatedPayloadSchema>;

export const memoryClaimInvalidatedPayloadSchema = z.object({
  claimId: z.string(),
  reason: z.string(),
});
export type MemoryClaimInvalidatedPayload = z.infer<
  typeof memoryClaimInvalidatedPayloadSchema
>;

export const capabilityActivatedPayloadSchema = z.object({
  activationId: z.string(),
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  sessionId: z.string(),
  taskId: z.string().nullable(),
});
export type CapabilityActivatedPayload = z.infer<typeof capabilityActivatedPayloadSchema>;

export const capabilityDeactivatedPayloadSchema = z.object({
  activationId: z.string(),
  reason: z.string(),
});
export type CapabilityDeactivatedPayload = z.infer<
  typeof capabilityDeactivatedPayloadSchema
>;

// ────────────────────────── Typed event map ──────────────────────────────────

export interface EventPayloadMap {
  "task.created": TaskCreatedPayload;
  "task.activated": TaskActivatedPayload;
  "task.completed": TaskCompletedPayload;
  "task.failed": TaskFailedPayload;
  "task.aborted": TaskAbortedPayload;
  "task.failed_verification": TaskFailedVerificationPayload;
  "task.budget_exhausted": TaskBudgetExhaustedPayload;
  "task.policy_denied": TaskPolicyDeniedPayload;
  "task.contract_updated": TaskContractUpdatedPayload;
  "task.scope_entry_recorded": TaskScopeEntryRecordedPayload;
  "turn.started": TurnStartedPayload;
  "turn.context_compiled": TurnContextCompiledPayload;
  "turn.provider_running": TurnProviderRunningPayload;
  "turn.tool_settled": TurnToolSettledPayload;
  "turn.completed": TurnCompletedPayload;
  "tool.proposed": ToolProposedPayload;
  "tool.authorized": ToolAuthorizedPayload;
  "tool.started": ToolStartedPayload;
  "tool.settled": ToolSettledPayload;
  "tool.failed": ToolFailedPayload;
  "policy.decision": PolicyDecisionPayload;
  "approval.requested": ApprovalRequestedPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "effect.proposed": EffectProposedPayload;
  "effect.authorized": EffectAuthorizedPayload;
  "effect.started": EffectStartedPayload;
  "effect.settled": EffectSettledPayload;
  "context.epoch_started": ContextEpochStartedPayload;
  "context.epoch_sealed": ContextEpochSealedPayload;
  "context.manifest_persisted": ContextManifestPersistedPayload;
  "checkpoint.created": CheckpointCreatedPayload;
  "agent.spawned": AgentSpawnedPayload;
  "agent.completed": AgentCompletedPayload;
  "verification.node_passed": VerificationNodePassedPayload;
  "verification.node_failed": VerificationNodeFailedPayload;
  "verification.plan_completed": VerificationPlanCompletedPayload;
  "memory.claim_created": MemoryClaimCreatedPayload;
  "memory.claim_invalidated": MemoryClaimInvalidatedPayload;
  "capability.activated": CapabilityActivatedPayload;
  "capability.deactivated": CapabilityDeactivatedPayload;
}

export type TypedEvent<T extends EventType = EventType> = Omit<
  EventEnvelope<EventPayloadMap[T]>,
  "eventType"
> & { readonly eventType: T };

export type AnyTypedEvent = {
  [K in EventType]: TypedEvent<K>;
}[EventType];

/** Maps an event type to its aggregate type. */
export function aggregateForEventType(t: EventType): AggregateType {
  const head = t.split(".")[0] as AggregateType;
  return head;
}

// ────────────────────────── Emitter / Observer ───────────────────────────────

export interface EventSink {
  emit<T extends EventType>(
    type: T,
    payload: EventPayloadMap[T],
    options: {
      aggregateId: string;
      aggregateSequence: number;
      actor: SemanticEventActor;
      occurredAt?: Rfc3339Timestamp;
      correlationId?: Uuid7 | null;
      causationId?: Uuid7 | null;
      idempotencyKey?: string | null;
      artifactRefs?: readonly ArtifactRef[];
      traceId?: TraceId | null;
    },
  ): Promise<TypedEvent<T>>;
}

export interface EventObserver {
  onEvent(event: AnyTypedEvent): void | Promise<void>;
}

export type EventFilter = {
  readonly aggregateType?: AggregateType;
  readonly aggregateId?: string;
  readonly eventTypes?: readonly EventType[];
  readonly since?: Rfc3339Timestamp;
};

// ────────────────────────── SSE encoder/decoder ──────────────────────────────

/** SSE-encode an event into a string suitable for `text/event-stream`. */
export function encodeSseEvent(event: AnyTypedEvent): string {
  const lines: string[] = [];
  lines.push(`id: ${event.eventId}`);
  lines.push(`event: ${event.eventType}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  return lines.join("\n") + "\n\n";
}

/** Parse one SSE event frame (separated by `\n\n`) into a typed envelope. */
export function decodeSseFrame(frame: string): AnyTypedEvent | null {
  const trimmed = frame.trim();
  if (trimmed === "") return null;
  let dataLines: string[] = [];
  let idLine: string | null = null;
  let eventLine: string | null = null;
  for (const line of trimmed.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") dataLines.push(value);
    else if (field === "id") idLine = value;
    else if (field === "event") eventLine = value;
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (idLine && typeof parsed.eventId !== "string") {
      parsed.eventId = idLine;
    }
    return eventEnvelopeSchema.parse(parsed) as unknown as AnyTypedEvent;
  } catch {
    return null;
  }
  void eventLine;
}

/** Split a raw SSE buffer into complete frames. Returns [frames, remainder]. */
export function splitSseStream(buffer: string): [string[], string] {
  const frames: string[] = [];
  let rest = buffer;
  const sep = "\n\n";
  let idx: number;
  while ((idx = rest.indexOf(sep)) >= 0) {
    frames.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  return [frames, rest];
}

// ────────────────────────── Helpers ──────────────────────────────────────────

/** Returns the zod payload schema for a given event type. */
export function payloadSchemaFor(type: EventType): z.ZodType<Readonly<Record<string, unknown>>> {
  const map: Record<EventType, z.ZodType> = {
    "task.created": taskCreatedPayloadSchema,
    "task.activated": taskActivatedPayloadSchema,
    "task.completed": taskCompletedPayloadSchema,
    "task.failed": taskFailedPayloadSchema,
    "task.aborted": taskAbortedPayloadSchema,
    "task.failed_verification": taskFailedVerificationPayloadSchema,
    "task.budget_exhausted": taskBudgetExhaustedPayloadSchema,
    "task.policy_denied": taskPolicyDeniedPayloadSchema,
    "task.contract_updated": taskContractUpdatedPayloadSchema,
    "task.scope_entry_recorded": taskScopeEntryRecordedPayloadSchema,
    "turn.started": turnStartedPayloadSchema,
    "turn.context_compiled": turnContextCompiledPayloadSchema,
    "turn.provider_running": turnProviderRunningPayloadSchema,
    "turn.tool_settled": turnToolSettledPayloadSchema,
    "turn.completed": turnCompletedPayloadSchema,
    "tool.proposed": toolProposedPayloadSchema,
    "tool.authorized": toolAuthorizedPayloadSchema,
    "tool.started": toolStartedPayloadSchema,
    "tool.settled": toolSettledPayloadSchema,
    "tool.failed": toolFailedPayloadSchema,
    "policy.decision": policyDecisionPayloadSchema,
    "approval.requested": approvalRequestedPayloadSchema,
    "approval.resolved": approvalResolvedPayloadSchema,
    "effect.proposed": effectProposedPayloadSchema,
    "effect.authorized": effectAuthorizedPayloadSchema,
    "effect.started": effectStartedPayloadSchema,
    "effect.settled": effectSettledPayloadSchema,
    "context.epoch_started": contextEpochStartedPayloadSchema,
    "context.epoch_sealed": contextEpochSealedPayloadSchema,
    "context.manifest_persisted": contextManifestPersistedPayloadSchema,
    "checkpoint.created": checkpointCreatedPayloadSchema,
    "agent.spawned": agentSpawnedPayloadSchema,
    "agent.completed": agentCompletedPayloadSchema,
    "verification.node_passed": verificationNodePassedPayloadSchema,
    "verification.node_failed": verificationNodeFailedPayloadSchema,
    "verification.plan_completed": verificationPlanCompletedPayloadSchema,
    "memory.claim_created": memoryClaimCreatedPayloadSchema,
    "memory.claim_invalidated": memoryClaimInvalidatedPayloadSchema,
    "capability.activated": capabilityActivatedPayloadSchema,
    "capability.deactivated": capabilityDeactivatedPayloadSchema,
  } as const;
  return map[type] as z.ZodType<Readonly<Record<string, unknown>>>;
}

/** Type guard: narrows an envelope to a typed event by event_type. */
export function isEventType<T extends EventType>(
  envelope: EventEnvelope,
  type: T,
): envelope is TypedEvent<T> {
  return envelope.eventType === type;
}

/** Built-in actor for system-emitted events. */
export function systemActor(id: string = "system"): SemanticEventActor {
  return { kind: "system", id };
}

/** Built-in actor for model-emitted events. */
export function modelActor(model: ModelKey, requestId: string): SemanticEventActor {
  return { kind: "model", id: `${model}:${requestId}` };
}

/** Built-in actor for user-emitted events. */
export function userActor(principal: PrincipalId): SemanticEventActor {
  return { kind: "user", id: principal };
}

/** Convenience: compute the artifact_ref hash for a payload (caller supplies). */
export function payloadArtifactHash(_payload: unknown): ContentHash | null {
  return null;
}

// ArtifactRef and ActorKind are re-exported from @terminus/domain.
export type { ArtifactRef, ActorKind } from "@terminus/domain";
