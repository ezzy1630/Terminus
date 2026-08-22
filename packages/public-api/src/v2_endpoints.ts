/**
 * @terminus/public-api — ARP v2 Public HTTP/SSE API Definitions.
 *
 * Per SPEC §30, §32:
 * Canonical v2 endpoints supporting missions, proof-carrying tasks,
 * workflows, claims, evidence, transactional effects, capabilities, and resumable streams.
 */
import { z } from "zod";
import {
  taskV2Schema,
  taskContractV2Schema,
  workflowSchema,
  nodeRunSchema,
  claimSchema,
  evidenceSchema,
  effectRecordSchema,
  authorizationInstanceSchema,
  questionSchema,
  decisionSchema,
  riskSchema,
  workerLeaseSchema,
  taskAttemptSchema,
  budgetConsumptionSchema,
  approvalDecisionSchema,
  taskStatusV2Schema,
  workflowStatusSchema,
} from "@terminus/domain";

// ────────────────────────── Snapshot Schemas ─────────────────────────────────

export const TaskV2Snapshot = taskV2Schema;
export type TaskV2Snapshot = z.infer<typeof TaskV2Snapshot>;

export const WorkflowSnapshot = workflowSchema;
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshot>;

export const NodeRunSnapshot = nodeRunSchema;
export type NodeRunSnapshot = z.infer<typeof NodeRunSnapshot>;

export const ClaimSnapshot = claimSchema;
export type ClaimSnapshot = z.infer<typeof ClaimSnapshot>;

export const EvidenceSnapshot = evidenceSchema;
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshot>;

export const EffectSnapshot = effectRecordSchema;
export type EffectSnapshot = z.infer<typeof EffectSnapshot>;

export const AuthorizationSnapshot = authorizationInstanceSchema;
export type AuthorizationSnapshot = z.infer<typeof AuthorizationSnapshot>;

export const QuestionSnapshot = questionSchema;
export type QuestionSnapshot = z.infer<typeof QuestionSnapshot>;

export const DecisionSnapshot = decisionSchema;
export type DecisionSnapshot = z.infer<typeof DecisionSnapshot>;

export const RiskSnapshot = riskSchema;
export type RiskSnapshot = z.infer<typeof RiskSnapshot>;

export const WorkerLeaseSnapshot = workerLeaseSchema;
export type WorkerLeaseSnapshot = z.infer<typeof WorkerLeaseSnapshot>;

export const TaskAttemptSnapshot = taskAttemptSchema;
export type TaskAttemptSnapshot = z.infer<typeof TaskAttemptSnapshot>;

export const BudgetConsumptionSnapshot = budgetConsumptionSchema;
export type BudgetConsumptionSnapshot = z.infer<typeof BudgetConsumptionSnapshot>;

// ────────────────────────── Endpoint Declarations ────────────────────────────

// /v2/system
export const GetSystemHealthV2 = {
  method: "GET" as const,
  path: "/v2/system/health",
  request: z.void(),
  response: z.object({
    status: z.enum(["ok", "degraded", "down"]),
    version: z.string(),
    protocolVersion: z.literal(2),
    uptimeSeconds: z.number().int().nonnegative(),
    ready: z.boolean(),
  }),
};

export const GetSchemaRegistryV2 = {
  method: "GET" as const,
  path: "/v2/system/schema-registry",
  request: z.void(),
  response: z.object({
    protocolVersion: z.literal(2),
    supportedEventTypes: z.array(z.string()),
    supportedCommandTypes: z.array(z.string()),
    schemas: z.record(z.string(), z.unknown()),
  }),
};

// /v2/tasks
export const CreateTaskV2 = {
  method: "POST" as const,
  path: "/v2/tasks",
  request: z.object({
    missionId: z.string().nullable().default(null),
    organizationId: z.string().default("default-org"),
    departmentId: z.string().default("default-dept"),
    contract: taskContractV2Schema,
  }),
  response: TaskV2Snapshot,
};

export const GetTaskV2 = {
  method: "GET" as const,
  path: "/v2/tasks/{id}",
  request: z.object({ id: z.string() }),
  response: TaskV2Snapshot,
};

export const TransitionTaskV2 = {
  method: "POST" as const,
  path: "/v2/tasks/{id}/transition",
  request: z.object({
    id: z.string(),
    targetStatus: taskStatusV2Schema,
    expectedVersion: z.number().int().nonnegative().nullable().default(null),
    reason: z.string().nullable().default(null),
  }),
  response: TaskV2Snapshot,
};

export const UpdateTaskContractV2 = {
  method: "POST" as const,
  path: "/v2/tasks/{id}/contract",
  request: z.object({
    id: z.string(),
    contract: taskContractV2Schema,
    expectedVersion: z.number().int().nonnegative().nullable().default(null),
  }),
  response: TaskV2Snapshot,
};

// /v2/workflows
export const CreateWorkflowV2 = {
  method: "POST" as const,
  path: "/v2/workflows",
  request: z.object({
    taskId: z.string(),
    nodes: z.array(z.any()),
    edges: z.array(z.any()),
  }),
  response: WorkflowSnapshot,
};

export const ExecuteWorkflowNodeV2 = {
  method: "POST" as const,
  path: "/v2/workflows/{id}/nodes/{nodeId}/execute",
  request: z.object({
    id: z.string(),
    nodeId: z.string(),
    attemptId: z.string(),
    inputs: z.record(z.string(), z.unknown()).default({}),
  }),
  response: NodeRunSnapshot,
};

// /v2/claims & /v2/evidence
export const SubmitClaimV2 = {
  method: "POST" as const,
  path: "/v2/claims",
  request: z.object({
    taskId: z.string(),
    statement: z.string(),
    requiredEvidenceKind: z.string(),
  }),
  response: ClaimSnapshot,
};

export const WaiveClaimV2 = {
  method: "POST" as const,
  path: "/v2/claims/{id}/waive",
  request: z.object({
    id: z.string(),
    rationale: z.string(),
  }),
  response: ClaimSnapshot,
};

export const RecordEvidenceV2 = {
  method: "POST" as const,
  path: "/v2/evidence",
  request: z.object({
    claimId: z.string(),
    kind: z.string(),
    summary: z.string(),
    verifierResult: z.string(),
    sourceRevision: z.string().nullable().default(null),
    environmentHash: z.string().nullable().default(null),
    metadata: z.record(z.string(), z.unknown()).default({}),
  }),
  response: EvidenceSnapshot,
};

// /v2/effects
export const ProposeEffectV2 = {
  method: "POST" as const,
  path: "/v2/effects",
  request: z.object({
    taskId: z.string(),
    attemptId: z.string(),
    connectorOrWorker: z.string(),
    intentType: z.string(),
    canonicalParameters: z.record(z.string(), z.unknown()),
    resourceHandles: z.array(z.any()).default([]),
    effectClass: z.string(),
    semanticIdempotencyKey: z.string(),
  }),
  response: EffectSnapshot,
};

export const AuthorizeEffectV2 = {
  method: "POST" as const,
  path: "/v2/effects/{id}/authorize",
  request: z.object({
    id: z.string(),
    authorizationId: z.string(),
  }),
  response: EffectSnapshot,
};

export const CommitEffectV2 = {
  method: "POST" as const,
  path: "/v2/effects/{id}/commit",
  request: z.object({
    id: z.string(),
    expectedVersion: z.number().int().nonnegative().nullable().default(null),
  }),
  response: EffectSnapshot,
};

export const ReconcileEffectV2 = {
  method: "POST" as const,
  path: "/v2/effects/{id}/reconcile",
  request: z.object({
    id: z.string(),
    observedOutcome: z.string(),
    evidenceArtifactHash: z.string().nullable().default(null),
  }),
  response: EffectSnapshot,
};

// /v2/approvals
export const ResolveApprovalV2 = {
  method: "POST" as const,
  path: "/v2/approvals/{id}/resolve",
  request: z.object({
    id: z.string(),
    decision: approvalDecisionSchema,
    rationale: z.string().nullable().default(null),
  }),
  response: z.object({
    approvalId: z.string(),
    status: z.string(),
    resolvedAt: z.string(),
  }),
};

// /v2/questions & /v2/decisions
export const AskQuestionV2 = {
  method: "POST" as const,
  path: "/v2/questions",
  request: z.object({
    taskId: z.string(),
    prompt: z.string(),
    options: z.array(z.string()).default([]),
  }),
  response: QuestionSnapshot,
};

export const AnswerQuestionV2 = {
  method: "POST" as const,
  path: "/v2/questions/{id}/answer",
  request: z.object({
    id: z.string(),
    selectedOption: z.string(),
    rationale: z.string().nullable().default(null),
  }),
  response: QuestionSnapshot,
};

export const RecordDecisionV2 = {
  method: "POST" as const,
  path: "/v2/decisions",
  request: z.object({
    taskId: z.string(),
    questionId: z.string().nullable().default(null),
    statement: z.string(),
    alternativesConsidered: z.array(z.string()).default([]),
    rationale: z.string(),
    provenance: z.string(),
  }),
  response: DecisionSnapshot,
};

// /v2/risks
export const RecordRiskV2 = {
  method: "POST" as const,
  path: "/v2/risks",
  request: z.object({
    taskId: z.string(),
    riskClass: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]),
    statement: z.string().min(1),
    mitigation: z.string().nullable().default(null),
  }),
  response: RiskSnapshot,
};

export const MitigateRiskV2 = {
  method: "POST" as const,
  path: "/v2/risks/{id}/mitigate",
  request: z.object({
    id: z.string(),
    mitigation: z.string().min(1),
  }),
  response: RiskSnapshot,
};

// /v2/leases
export const AcquireLeaseV2 = {
  method: "POST" as const,
  path: "/v2/leases/acquire",
  request: z.object({
    taskId: z.string(),
    workerId: z.string(),
    durationSeconds: z.number().int().positive().default(30),
    metadata: z.record(z.string(), z.unknown()).default({}),
  }),
  response: WorkerLeaseSnapshot,
};

export const RenewLeaseV2 = {
  method: "POST" as const,
  path: "/v2/leases/{id}/renew",
  request: z.object({
    id: z.string(),
    fencingToken: z.number().int().positive(),
    durationSeconds: z.number().int().positive().default(30),
  }),
  response: WorkerLeaseSnapshot,
};

export const ReleaseLeaseV2 = {
  method: "POST" as const,
  path: "/v2/leases/{id}/release",
  request: z.object({
    id: z.string(),
    fencingToken: z.number().int().positive(),
  }),
  response: WorkerLeaseSnapshot,
};

// /v2/workflows transitions
export const TransitionWorkflowV2 = {
  method: "POST" as const,
  path: "/v2/workflows/{id}/transition",
  request: z.object({
    id: z.string(),
    targetStatus: workflowStatusSchema,
    reason: z.string().nullable().default(null),
  }),
  response: WorkflowSnapshot,
};

// /v2/tasks/{id}/budget
export const ConsumeBudgetV2 = {
  method: "POST" as const,
  path: "/v2/tasks/{id}/budget/consume",
  request: z.object({
    id: z.string(),
    costMicros: z.bigint().nonnegative().default(0n),
    computeSeconds: z.number().int().nonnegative().default(0),
    inputTokens: z.bigint().nonnegative().default(0n),
    outputTokens: z.bigint().nonnegative().default(0n),
    approvals: z.number().int().nonnegative().default(0),
  }),
  response: BudgetConsumptionSnapshot,
};

// /v2/events (SSE)
export const SubscribeEventsV2 = {
  method: "GET" as const,
  path: "/v2/events",
  request: z.object({
    cursor: z.string().nullable().default(null),
    taskId: z.string().nullable().default(null),
    aggregateType: z.string().nullable().default(null),
  }),
  response: z.never(), // SSE stream
};

// ────────────────────────── V2 Endpoint Registry ─────────────────────────────

export const V2_ENDPOINTS = {
  GetSystemHealthV2,
  GetSchemaRegistryV2,
  CreateTaskV2,
  GetTaskV2,
  TransitionTaskV2,
  UpdateTaskContractV2,
  CreateWorkflowV2,
  ExecuteWorkflowNodeV2,
  TransitionWorkflowV2,
  SubmitClaimV2,
  WaiveClaimV2,
  RecordEvidenceV2,
  ProposeEffectV2,
  AuthorizeEffectV2,
  CommitEffectV2,
  ReconcileEffectV2,
  ResolveApprovalV2,
  AskQuestionV2,
  AnswerQuestionV2,
  RecordDecisionV2,
  RecordRiskV2,
  MitigateRiskV2,
  AcquireLeaseV2,
  RenewLeaseV2,
  ReleaseLeaseV2,
  ConsumeBudgetV2,
  SubscribeEventsV2,
} as const;

export type V2EndpointName = keyof typeof V2_ENDPOINTS;

