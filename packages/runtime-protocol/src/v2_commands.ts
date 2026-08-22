/**
 * @terminus/runtime-protocol — Agent Runtime Protocol (ARP) v2 Command Schemas.
 *
 * Per SPEC §5, §6, §7, §8, §14, §16, §28, §29:
 * ARP v2 typed command envelopes, parameters, expected-version concurrency,
 * and idempotency semantics.
 */
import { z } from "zod";
import type {
  Uuid7,
  PrincipalId,
  Rfc3339Timestamp,
  TraceId,
  TaskContractV2,
  WorkflowNode,
  GuardedEdge,
  ResourceHandle,
  ApprovalDecision,
} from "@terminus/domain";
import {
  taskContractV2Schema,
  workflowNodeSchema,
  guardedEdgeSchema,
  resourceHandleSchema,
  approvalDecisionSchema,
} from "@terminus/domain";

// ────────────────────────── Command Envelope ─────────────────────────────────

export interface CommandEnvelope<TPayload = Readonly<Record<string, unknown>>> {
  readonly commandId: Uuid7;
  readonly commandType: string;
  readonly schemaVersion: 2;
  readonly idempotencyKey: string;
  readonly expectedVersion: number | null;
  readonly principal: PrincipalId;
  readonly payload: TPayload;
  readonly timestamp: Rfc3339Timestamp;
  readonly traceId: TraceId | null;
}

export const commandEnvelopeSchema = z.object({
  commandId: z.string(),
  commandType: z.string(),
  schemaVersion: z.literal(2),
  idempotencyKey: z.string().min(1),
  expectedVersion: z.number().int().nonnegative().nullable(),
  principal: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  timestamp: z.string(),
  traceId: z.string().nullable().default(null),
});

// ────────────────────────── Command Types ────────────────────────────────────

export const ARP_V2_COMMAND_TYPES = [
  // Task Commands
  "task.create",
  "task.start",
  "task.pause",
  "task.resume",
  "task.cancel",
  "task.update_contract",

  // Workflow Commands
  "workflow.create",
  "workflow.execute_node",
  "workflow.complete_node",
  "workflow.fail_node",
  "workflow.pause",
  "workflow.resume",
  "workflow.cancel",

  // Worker Lease Commands
  "lease.acquire",
  "lease.renew",
  "lease.release",

  // Claim & Evidence Commands
  "claim.submit",
  "claim.waive",
  "evidence.record",
  "evidence.verify",

  // Effect Commands
  "effect.propose",
  "effect.authorize",
  "effect.prepare",
  "effect.dispatch",
  "effect.commit",
  "effect.reconcile",
  "effect.compensate",

  // Approval Commands
  "approval.request",
  "approval.resolve",

  // Question & Decision Commands
  "question.ask",
  "question.answer",
  "question.dismiss",
  "decision.record",

  // Risk & Budget Commands
  "risk.record",
  "risk.mitigate",
  "budget.consume",

  // Capability Commands
  "capability.register",
  "capability.revoke",
] as const;

export type ArpV2CommandType = (typeof ARP_V2_COMMAND_TYPES)[number];

// ────────────────────────── Command Payloads ─────────────────────────────────

// Task Commands
export const createTaskCommandPayloadSchema = z.object({
  missionId: z.string().nullable().default(null),
  organizationId: z.string(),
  departmentId: z.string(),
  contract: taskContractV2Schema,
});
export type CreateTaskCommandPayload = z.infer<typeof createTaskCommandPayloadSchema>;

export const startTaskCommandPayloadSchema = z.object({
  taskId: z.string(),
});
export type StartTaskCommandPayload = z.infer<typeof startTaskCommandPayloadSchema>;

export const cancelTaskCommandPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string().nullable().default(null),
});
export type CancelTaskCommandPayload = z.infer<typeof cancelTaskCommandPayloadSchema>;

// Workflow Commands
export const createWorkflowCommandPayloadSchema = z.object({
  taskId: z.string(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(guardedEdgeSchema),
});
export type CreateWorkflowCommandPayload = z.infer<typeof createWorkflowCommandPayloadSchema>;

export const executeNodeCommandPayloadSchema = z.object({
  workflowId: z.string(),
  nodeId: z.string(),
  attemptId: z.string(),
  inputs: z.record(z.string(), z.unknown()),
});
export type ExecuteNodeCommandPayload = z.infer<typeof executeNodeCommandPayloadSchema>;

// Claim & Evidence Commands
export const submitClaimCommandPayloadSchema = z.object({
  taskId: z.string(),
  statement: z.string(),
  requiredEvidenceKind: z.string(),
});
export type SubmitClaimCommandPayload = z.infer<typeof submitClaimCommandPayloadSchema>;

export const waiveClaimCommandPayloadSchema = z.object({
  claimId: z.string(),
  rationale: z.string(),
});
export type WaiveClaimCommandPayload = z.infer<typeof waiveClaimCommandPayloadSchema>;

export const recordEvidenceCommandPayloadSchema = z.object({
  claimId: z.string(),
  kind: z.string(),
  summary: z.string(),
  verifierResult: z.string(),
  sourceRevision: z.string().nullable().default(null),
  environmentHash: z.string().nullable().default(null),
  artifactRef: z
    .object({
      hash: z.string(),
      uri: z.string(),
      mediaType: z.string(),
      bytes: z.bigint(),
    })
    .nullable()
    .default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RecordEvidenceCommandPayload = z.infer<typeof recordEvidenceCommandPayloadSchema>;

// Effect Commands
export const proposeEffectCommandPayloadSchema = z.object({
  taskId: z.string(),
  attemptId: z.string(),
  connectorOrWorker: z.string(),
  intentType: z.string(),
  canonicalParameters: z.record(z.string(), z.unknown()),
  resourceHandles: z.array(resourceHandleSchema).default([]),
  effectClass: z.string(),
});
export type ProposeEffectCommandPayload = z.infer<typeof proposeEffectCommandPayloadSchema>;

export const authorizeEffectCommandPayloadSchema = z.object({
  effectId: z.string(),
  authorizationId: z.string(),
});
export type AuthorizeEffectCommandPayload = z.infer<typeof authorizeEffectCommandPayloadSchema>;

export const commitEffectCommandPayloadSchema = z.object({
  effectId: z.string(),
});
export type CommitEffectCommandPayload = z.infer<typeof commitEffectCommandPayloadSchema>;

export const reconcileEffectCommandPayloadSchema = z.object({
  effectId: z.string(),
  observedOutcome: z.string(),
  evidenceArtifactHash: z.string().nullable().default(null),
});
export type ReconcileEffectCommandPayload = z.infer<typeof reconcileEffectCommandPayloadSchema>;

// Approval Commands
export const resolveApprovalCommandPayloadSchema = z.object({
  approvalId: z.string(),
  decision: approvalDecisionSchema,
  rationale: z.string().nullable().default(null),
});
export type ResolveApprovalCommandPayload = z.infer<typeof resolveApprovalCommandPayloadSchema>;

// Question Commands
export const askQuestionCommandPayloadSchema = z.object({
  taskId: z.string(),
  prompt: z.string(),
  options: z.array(z.string()).default([]),
});
export type AskQuestionCommandPayload = z.infer<typeof askQuestionCommandPayloadSchema>;

export const answerQuestionCommandPayloadSchema = z.object({
  questionId: z.string(),
  selectedOption: z.string(),
  rationale: z.string().nullable().default(null),
});
export type AnswerQuestionCommandPayload = z.infer<typeof answerQuestionCommandPayloadSchema>;

export const recordDecisionCommandPayloadSchema = z.object({
  taskId: z.string(),
  questionId: z.string().nullable().default(null),
  statement: z.string().min(1),
  alternativesConsidered: z.array(z.string()).default([]),
  rationale: z.string().min(1),
  provenance: z.string().min(1),
});
export type RecordDecisionCommandPayload = z.infer<typeof recordDecisionCommandPayloadSchema>;

// Lease Commands
export const acquireLeaseCommandPayloadSchema = z.object({
  taskId: z.string(),
  workerId: z.string(),
  durationSeconds: z.number().int().positive().default(30),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AcquireLeaseCommandPayload = z.infer<typeof acquireLeaseCommandPayloadSchema>;

export const renewLeaseCommandPayloadSchema = z.object({
  leaseId: z.string(),
  fencingToken: z.number().int().positive(),
  durationSeconds: z.number().int().positive().default(30),
});
export type RenewLeaseCommandPayload = z.infer<typeof renewLeaseCommandPayloadSchema>;

export const releaseLeaseCommandPayloadSchema = z.object({
  leaseId: z.string(),
  fencingToken: z.number().int().positive(),
});
export type ReleaseLeaseCommandPayload = z.infer<typeof releaseLeaseCommandPayloadSchema>;

// Risk & Budget Commands
export const recordRiskCommandPayloadSchema = z.object({
  taskId: z.string(),
  riskClass: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]),
  statement: z.string().min(1),
  mitigation: z.string().nullable().default(null),
});
export type RecordRiskCommandPayload = z.infer<typeof recordRiskCommandPayloadSchema>;

export const mitigateRiskCommandPayloadSchema = z.object({
  riskId: z.string(),
  mitigation: z.string().min(1),
});
export type MitigateRiskCommandPayload = z.infer<typeof mitigateRiskCommandPayloadSchema>;

export const consumeBudgetCommandPayloadSchema = z.object({
  taskId: z.string(),
  costMicros: z.bigint().nonnegative().default(0n),
  computeSeconds: z.number().int().nonnegative().default(0),
  inputTokens: z.bigint().nonnegative().default(0n),
  outputTokens: z.bigint().nonnegative().default(0n),
  approvals: z.number().int().nonnegative().default(0),
});
export type ConsumeBudgetCommandPayload = z.infer<typeof consumeBudgetCommandPayloadSchema>;

// ────────────────────────── Command Payload Map ──────────────────────────────

export interface ArpV2CommandPayloadMap {
  "task.create": CreateTaskCommandPayload;
  "task.start": StartTaskCommandPayload;
  "task.pause": { readonly taskId: string };
  "task.resume": { readonly taskId: string };
  "task.cancel": CancelTaskCommandPayload;
  "task.update_contract": { readonly taskId: string; readonly contract: TaskContractV2 };

  "workflow.create": CreateWorkflowCommandPayload;
  "workflow.execute_node": ExecuteNodeCommandPayload;
  "workflow.complete_node": { readonly nodeRunId: string; readonly outputs: Record<string, unknown> };
  "workflow.fail_node": { readonly nodeRunId: string; readonly error: string };
  "workflow.pause": { readonly workflowId: string };
  "workflow.resume": { readonly workflowId: string };
  "workflow.cancel": { readonly workflowId: string; readonly reason?: string | undefined };

  "lease.acquire": AcquireLeaseCommandPayload;
  "lease.renew": RenewLeaseCommandPayload;
  "lease.release": ReleaseLeaseCommandPayload;

  "claim.submit": SubmitClaimCommandPayload;
  "claim.waive": WaiveClaimCommandPayload;
  "evidence.record": RecordEvidenceCommandPayload;
  "evidence.verify": { readonly evidenceId: string; readonly result: string };

  "effect.propose": ProposeEffectCommandPayload;
  "effect.authorize": AuthorizeEffectCommandPayload;
  "effect.prepare": { readonly effectId: string };
  "effect.dispatch": { readonly effectId: string };
  "effect.commit": CommitEffectCommandPayload;
  "effect.reconcile": ReconcileEffectCommandPayload;
  "effect.compensate": { readonly effectId: string; readonly reason: string };

  "approval.request": { readonly effectId: string; readonly riskClass: string };
  "approval.resolve": ResolveApprovalCommandPayload;

  "question.ask": AskQuestionCommandPayload;
  "question.answer": AnswerQuestionCommandPayload;
  "question.dismiss": { readonly questionId: string };
  "decision.record": RecordDecisionCommandPayload;

  "risk.record": RecordRiskCommandPayload;
  "risk.mitigate": MitigateRiskCommandPayload;
  "budget.consume": ConsumeBudgetCommandPayload;

  "capability.register": { readonly capabilityId: string; readonly descriptor: Record<string, unknown> };
  "capability.revoke": { readonly capabilityId: string; readonly reason: string };
}

// ────────────────────────── Command Results ──────────────────────────────────

export interface CommandResult<TResult = unknown> {
  readonly success: boolean;
  readonly commandId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly result: TResult;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}
