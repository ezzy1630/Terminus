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
  workflowNodeSchema,
  guardedEdgeSchema,
  nodeRunSchema,
  claimSchema,
  evidenceSchema,
  artifactRefSchema,
  effectRecordSchema,
  authorizationInstanceSchema,
  questionSchema,
  decisionSchema,
  riskSchema,
  workerLeaseSchema,
  taskAttemptSchema,
  budgetConsumptionSchema,
  resourceHandleSchema,
  approvalDecisionSchema,
  taskStatusV2Schema,
  workflowStatusSchema,
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
  uiObservationSchema,
  computerUseActionSchema,
  semanticTargetVerificationSchema,
  uiEvidenceRecordSchema,
  browserDesktopPoolSchema,
  poolLeaseSchema,
  humanTakeoverSessionSchema,
  dataTransferAuditSchema,
  externalConnectorSpecSchema,
  connectorCallIntentSchema,
  connectorCallResultSchema,
  ambiguousSubmitReconciliationSchema,
  incidentExecutionRecordSchema,
  researchProvenanceRecordSchema,
  contentHashSchema,
  modelProfileSchema,
  routeDecisionV2Schema,
  modelCohortPosteriorSchema,
  stagnationReportSchema,
  INTERVENTION_PAYLOAD_SCHEMAS,
} from "@terminus/domain";

/** JSON boundary representation for non-negative bigint-backed quantities. */
export const DecimalCountWire = z.string().regex(/^(0|[1-9]\d*)$/);
export const ByteCountWire = DecimalCountWire;
export const MicrosWire = DecimalCountWire;

export const ArtifactRefWire = artifactRefSchema
  .omit({ bytes: true })
  .extend({ bytes: ByteCountWire });

export const TaskContractV2Wire = taskContractV2Schema
  .omit({ constraints: true })
  .extend({
    constraints: taskContractV2Schema.shape.constraints
      .omit({ costMicros: true })
      .extend({ costMicros: MicrosWire }),
  });

export const TaskV2Wire = taskV2Schema
  .omit({ contract: true })
  .extend({ contract: TaskContractV2Wire });

export const EvidenceWire = evidenceSchema
  .omit({ artifactRef: true })
  .extend({ artifactRef: ArtifactRefWire.nullable() });

export const BudgetConsumptionWire = budgetConsumptionSchema
  .omit({ consumedCostMicros: true, consumedInputTokens: true, consumedOutputTokens: true })
  .extend({
    consumedCostMicros: MicrosWire,
    consumedInputTokens: DecimalCountWire,
    consumedOutputTokens: DecimalCountWire,
  });

export const ModelProfileWire = modelProfileSchema
  .omit({ economics: true })
  .extend({
    economics: modelProfileSchema.shape.economics
      .omit({ inputMicrosPerMillion: true, cachedInputMicrosPerMillion: true, outputMicrosPerMillion: true })
      .extend({
        inputMicrosPerMillion: MicrosWire,
        cachedInputMicrosPerMillion: MicrosWire,
        outputMicrosPerMillion: MicrosWire,
      }),
  });

export const RouteDecisionV2Wire = routeDecisionV2Schema
  .omit({ expectedCostMicros: true })
  .extend({ expectedCostMicros: MicrosWire });

export const ModelCohortPosteriorWire = modelCohortPosteriorSchema
  .omit({ observedCostMicros: true })
  .extend({ observedCostMicros: MicrosWire });

export const CounterfactualExperimentWire = counterfactualExperimentSchema
  .omit({ deltaCostMicros: true })
  .extend({ deltaCostMicros: MicrosWire.nullable() });

export const DataTransferAuditWire = dataTransferAuditSchema
  .omit({ bytesCount: true })
  .extend({ bytesCount: ByteCountWire });

export const DataFlowCheckResultWire = z.object({
  allowed: z.boolean(),
  reason: z.string().min(1),
  audit: DataTransferAuditWire,
});

/**
 * Immutable receipt references accepted at trust boundaries. The referenced
 * receipt is still verified by a kernel/trusted-adapter verifier before the
 * subject can be admitted; possession of these strings is not proof.
 */
export const TrustedReceiptReferenceWire = z.object({
  sourceAdapterRef: z.string().min(1),
  subjectArtifactRef: ArtifactRefWire,
  receiptArtifactRef: ArtifactRefWire,
  bindingHash: contentHashSchema,
}).strict();

// ────────────────────────── Snapshot Schemas ─────────────────────────────────

export const TaskV2Snapshot = TaskV2Wire;
export type TaskV2Snapshot = z.infer<typeof TaskV2Snapshot>;

export const WorkflowSnapshot = workflowSchema;
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshot>;

export const NodeRunSnapshot = nodeRunSchema;
export type NodeRunSnapshot = z.infer<typeof NodeRunSnapshot>;

export const ClaimSnapshot = claimSchema;
export type ClaimSnapshot = z.infer<typeof ClaimSnapshot>;

export const EvidenceSnapshot = EvidenceWire;
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

export const BudgetConsumptionSnapshot = BudgetConsumptionWire;
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
    v1Context: z.object({
      sessionId: z.string().min(1),
      threadId: z.string().min(1),
    }).nullable().default(null),
    contract: TaskContractV2Wire,
  }),
  response: TaskV2Snapshot,
};

export const GetTaskV2 = {
  method: "GET" as const,
  path: "/v2/tasks/{id}",
  request: z.object({ id: z.string() }),
  response: TaskV2Snapshot,
};

export const GetTaskConversationContextV2 = {
  method: "GET" as const,
  path: "/v2/tasks/{id}/conversation-context",
  request: z.object({ id: z.string() }),
  response: taskV2Schema.shape.conversationContext,
};

export const AttachTaskConversationContextV2 = {
  method: "POST" as const,
  path: "/v2/tasks/{id}/conversation-context",
  request: z.object({
    id: z.string(),
    sessionId: z.string().min(1),
    threadId: z.string().min(1),
    expectedVersion: z.number().int().nonnegative().nullable().default(null),
  }),
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
    contract: TaskContractV2Wire,
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
    nodes: z.array(workflowNodeSchema),
    edges: z.array(guardedEdgeSchema),
  }),
  response: WorkflowSnapshot,
};

export const CompileWorkflowV2 = {
  method: "POST" as const,
  path: "/v2/workflows/compile",
  request: z.object({
    source: z.string(),
    sourceKind: z.enum(["skill_markdown", "json_ir", "prose_spec"]).default("skill_markdown"),
    sourcePath: z.string().optional(),
    taskId: z.string().optional(),
    authorityCeiling: z.array(z.string()).optional(),
    mandatorySteps: z.array(z.string()).optional(),
    strictMode: z.boolean().default(false),
  }),
  response: z.object({
    workflow: WorkflowSnapshot,
    report: z.record(z.string(), z.unknown()),
  }),
};

export const ValidateWorkflowV2 = {
  method: "POST" as const,
  path: "/v2/workflows/validate",
  request: z.object({
    nodes: z.array(workflowNodeSchema),
    edges: z.array(guardedEdgeSchema),
    authorityCeiling: z.array(z.string()).optional(),
    mandatorySteps: z.array(z.string()).optional(),
    strictMode: z.boolean().default(false),
  }),
  response: z.record(z.string(), z.unknown()),
};

export const GetWorkflowDagV2 = {
  method: "GET" as const,
  path: "/v2/workflows/{id}/dag",
  request: z.object({ id: z.string() }),
  response: z.object({
    workflowId: z.string(),
    nodes: z.array(z.object({
      id: z.string(),
      kind: z.string(),
      owner: z.string(),
      effectClass: z.string().nullable(),
    })),
    edges: z.array(z.object({
      sourceNodeId: z.string(),
      targetNodeId: z.string(),
      condition: z.string().nullable(),
    })),
  }),
};

export const GetWorkflowWitnessPathsV2 = {
  method: "GET" as const,
  path: "/v2/workflows/{id}/witness-paths",
  request: z.object({ id: z.string() }),
  response: z.object({
    workflowId: z.string(),
    witnessPaths: z.array(z.object({
      pathId: z.string(),
      nodeIds: z.array(z.string()),
      coversMandatorySteps: z.array(z.string()),
    })),
  }),
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
export const ListClaimsV2 = {
  method: "GET" as const,
  path: "/v2/claims",
  request: z.object({ taskId: z.string().min(1).optional() }).strict(),
  response: z.object({ claims: z.array(ClaimSnapshot) }).strict(),
};

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
    claimId: z.string().min(1),
    verifierId: z.string().min(1),
    verifierVersion: z.string().min(1),
    receipt: TrustedReceiptReferenceWire,
  }).strict(),
  response: EvidenceSnapshot,
};

export const ListEvidenceV2 = {
  method: "GET" as const,
  path: "/v2/evidence",
  request: z.object({ taskId: z.string().min(1).optional() }).strict(),
  response: z.object({ evidence: z.array(EvidenceSnapshot) }).strict(),
};

// /v2/effects
export const ProposeEffectV2 = {
  method: "POST" as const,
  path: "/v2/effects",
  request: z.object({
    taskId: z.string().min(1),
    attemptId: z.string().min(1),
    connectorOrWorker: z.string().min(1),
    intentType: z.string().min(1),
    canonicalParameters: z.record(z.string(), z.unknown()),
    resourceHandles: z.array(resourceHandleSchema).default([]),
    effectClass: z.string().min(1),
    semanticIdempotencyKey: z.string().min(1),
  }).strict(),
  response: EffectSnapshot,
};

export const AuthorizeEffectV2 = {
  method: "POST" as const,
  path: "/v2/effects/{id}/authorize",
  request: z.object({
    id: z.string().min(1),
    authorizationId: z.string().min(1),
  }).strict(),
  response: EffectSnapshot,
};

export const CommitEffectV2 = {
  method: "POST" as const,
  path: "/v2/effects/{id}/commit",
  request: z.object({
    id: z.string(),
    expectedVersion: z.number().int().nonnegative().nullable().default(null),
    validationReceiptArtifactRef: ArtifactRefWire,
  }).strict(),
  response: EffectSnapshot,
};

export const ReconcileEffectV2 = {
  method: "POST" as const,
  path: "/v2/effects/{id}/reconcile",
  request: z.object({
    id: z.string().min(1),
    reconciliationReceipt: TrustedReceiptReferenceWire,
  }).strict(),
  response: EffectSnapshot,
};

// /v2/approvals
export const ResolveApprovalV2 = {
  method: "POST" as const,
  path: "/v2/approvals/{id}/resolve",
  request: z.object({
    id: z.string(),
    operationHash: z.string().min(1),
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
    costMicros: MicrosWire.default("0"),
    computeSeconds: z.number().int().nonnegative().default(0),
    inputTokens: DecimalCountWire.default("0"),
    outputTokens: DecimalCountWire.default("0"),
    approvals: z.number().int().nonnegative().default(0),
  }),
  response: BudgetConsumptionSnapshot,
};

export const GetTaskBudgetV2 = {
  method: "GET" as const,
  path: "/v2/tasks/{id}/budget",
  request: z.object({ id: z.string().min(1) }),
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

// /v2/models
export const ListModelProfilesV2 = {
  method: "GET" as const,
  path: "/v2/models/profiles",
  request: z.object({
    adapterRef: z.string().optional(),
    confidentiality: z.enum(["public", "workspace", "secret_adjacent", "secret"]).optional(),
  }).optional(),
  response: z.object({
    profiles: z.array(ModelProfileWire),
  }),
};

export const GetModelProfileV2 = {
  method: "GET" as const,
  path: "/v2/models/profiles/:id",
  request: z.void(),
  response: ModelProfileWire,
};

export const RouteModelStageV2 = {
  method: "POST" as const,
  path: "/v2/models/route",
  request: z.object({
    stage: z.enum(["classifier", "implementer", "reviewer", "specialist", "vision", "local_safe"]),
    confidentiality: z.enum(["public", "workspace", "secret_adjacent", "secret"]).default("workspace"),
    allowedAdapterRefs: z.array(z.string()).optional(),
    implementerModelFamilyRef: z.string().nullable().optional(),
    requireOffline: z.boolean().default(false),
  }).strict(),
  response: RouteDecisionV2Wire,
};

export const UpdateModelPosteriorV2 = {
  method: "POST" as const,
  path: "/v2/models/posterior/update",
  request: z.object({
    modelKey: z.string().min(1),
    toolCallsSucceeded: z.number().int().nonnegative(),
    toolCallsFailed: z.number().int().nonnegative(),
    structuredOutputSucceeded: z.boolean(),
    editCohortSucceeded: z.boolean(),
    latencyMs: z.number().nonnegative(),
    costMicros: MicrosWire,
    cacheHitRate: z.number().min(0).max(1),
  }),
  response: ModelCohortPosteriorWire,
};

export const GetModelPosteriorV2 = {
  method: "GET" as const,
  path: "/v2/models/posterior/:modelKey",
  request: z.void(),
  response: ModelCohortPosteriorWire,
};

// /v2/orchestration
export const ScheduleEVWorkerV2 = {
  method: "POST" as const,
  path: "/v2/orchestration/ev-schedule",
  request: z.object({
    parentTaskId: z.string().min(1),
    candidateObjective: z.string().min(1),
    separability: z.number().min(0).max(1),
    likelyFileOverlap: z.number().min(0).max(1),
    isWriteWork: z.boolean(),
    currentUncertainty: z.number().min(0).max(1),
    contextPressure: z.number().min(0).max(1),
    riskClass: z.enum(["low", "medium", "high", "critical"]),
    budgetRemainingRatio: z.number().min(0).max(1),
    activeWorkerCount: z.number().int().nonnegative(),
  }),
  response: z.unknown(),
};

export const CheckStagnationV2 = {
  method: "POST" as const,
  path: "/v2/orchestration/stagnation/check",
  request: z.object({
    taskId: z.string().min(1),
    observations: z.array(z.unknown()).default([]),
  }),
  response: stagnationReportSchema,
};

export const ReviewFindingWire = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  severity: z.enum(["critical", "high", "medium", "low", "suggestion"]),
  title: z.string().min(1),
  description: z.string().min(1),
  proposedRemediation: z.string().optional(),
}).strict();

export const EvaluateCleanReviewV2 = {
  method: "POST" as const,
  path: "/v2/orchestration/review/clean",
  request: z.object({
    taskId: z.string().min(1),
    reviewerModelFamilyRef: z.string().min(1),
    implementerModelFamilyRef: z.string().min(1),
    findings: z.array(ReviewFindingWire).default([]),
  }).strict(),
  response: z.object({
    taskId: z.string().min(1),
    reviewerModelFamilyRef: z.string().min(1),
    isDiverseFamily: z.boolean(),
    passed: z.boolean(),
    findings: z.array(ReviewFindingWire),
    summary: z.string().min(1),
    timestamp: z.string().min(1),
  }).strict(),
};

// ────────────────────────── Phase 9: Cockpit, Attention & Interventions ──────

// /v2/organization & topology
export const ListOrganizationsV2 = {
  method: "GET" as const,
  path: "/v2/organizations",
  request: z.void(),
  response: z.object({
    organizations: z.array(organizationSchema),
  }),
};

export const ListDepartmentsV2 = {
  method: "GET" as const,
  path: "/v2/departments",
  request: z.object({ organizationId: z.string().optional() }).optional(),
  response: z.object({
    departments: z.array(departmentSchema),
  }),
};

export const ListOperatorsV2 = {
  method: "GET" as const,
  path: "/v2/operators",
  request: z.object({ departmentId: z.string().optional() }).optional(),
  response: z.object({
    operators: z.array(operatorAgentSchema),
  }),
};

export const ListAgentRoomsV2 = {
  method: "GET" as const,
  path: "/v2/agent-rooms",
  request: z.object({ departmentId: z.string().optional() }).optional(),
  response: z.object({
    rooms: z.array(agentRoomSchema),
  }),
};

export const ListCapabilityDirectoryV2 = {
  method: "GET" as const,
  path: "/v2/capabilities/directory",
  request: z.void(),
  response: z.object({
    capabilities: z.array(capabilityDirectoryEntrySchema),
  }),
};

export const ResolveCapabilityV2 = {
  method: "POST" as const,
  path: "/v2/capabilities/resolve",
  request: z.object({
    capabilityId: z.string().min(1),
    category: z.string().optional(),
    resourceDomain: z.string().optional(),
    requiredAuthority: z.array(z.string()).optional(),
  }),
  response: z.object({
    matched: z.boolean(),
    entry: capabilityDirectoryEntrySchema.nullable(),
    operator: operatorAgentSchema.nullable(),
    department: departmentSchema.nullable(),
    reason: z.string(),
  }),
};

// /v2/attention
export const AssessTaskAttentionV2 = {
  method: "GET" as const,
  path: "/v2/attention/assess/:taskId",
  request: z.void(),
  response: attentionAssessmentSchema,
};

export const ListMaterialQuestionsV2 = {
  method: "GET" as const,
  path: "/v2/attention/questions",
  request: z.object({ taskId: z.string().optional() }).optional(),
  response: z.object({
    questions: z.array(materialQuestionSchema),
  }),
};

export const AskMaterialQuestionV2 = {
  method: "POST" as const,
  path: "/v2/attention/questions",
  request: z.object({
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
    options: z.array(z.string()),
    consequenceMatrix: z.record(z.string(), z.string()),
    suggestedOption: z.string().nullable().optional(),
  }).strict(),
  response: z.object({
    accepted: z.boolean(),
    question: materialQuestionSchema.nullable(),
    reason: z.string(),
  }),
};

export const ResolveMaterialQuestionV2 = {
  method: "POST" as const,
  path: "/v2/attention/questions/:id/resolve",
  request: z.object({
    id: z.string().min(1),
    selectedOption: z.string().min(1),
  }),
  response: z.object({
    success: z.boolean(),
    question: materialQuestionSchema.nullable(),
    error: z.string().optional(),
  }),
};

// /v2/interventions
const interventionRequestBase = {
  taskId: z.string().min(1),
  attemptId: z.string().nullable().optional(),
  rationale: z.string().min(1),
} as const;
const taskInterventionTarget = z.string().min(1).nullable().optional();
const entityInterventionTarget = z.string().min(1);

export const ProposeInterventionRequestV2 = z.discriminatedUnion("verb", [
  z.object({ ...interventionRequestBase, verb: z.literal("focus"), targetEntityId: entityInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.focus }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("ignore"), targetEntityId: entityInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.ignore }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("elaborate"), targetEntityId: taskInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.elaborate }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("change_constraint"), targetEntityId: taskInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.change_constraint }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("edit_plan"), targetEntityId: entityInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.edit_plan }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("approve_exact_effect"), targetEntityId: entityInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.approve_exact_effect }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("deny_narrow"), targetEntityId: entityInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.deny_narrow }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("pause"), targetEntityId: taskInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.pause }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("resume"), targetEntityId: taskInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.resume }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("takeover"), targetEntityId: taskInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.takeover }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("fork"), targetEntityId: taskInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.fork }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("rewind"), targetEntityId: entityInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.rewind }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("terminate"), targetEntityId: taskInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.terminate }).strict(),
  z.object({ ...interventionRequestBase, verb: z.literal("request_independent_review"), targetEntityId: taskInterventionTarget, payload: INTERVENTION_PAYLOAD_SCHEMAS.request_independent_review }).strict(),
]).superRefine((request, context) => {
  const taskTargetVerbs = [
    "elaborate",
    "change_constraint",
    "pause",
    "resume",
    "takeover",
    "fork",
    "terminate",
    "request_independent_review",
  ] as const;
  if (
    taskTargetVerbs.includes(request.verb as (typeof taskTargetVerbs)[number])
    && request.targetEntityId !== undefined
    && request.targetEntityId !== null
    && request.targetEntityId !== request.taskId
  ) {
    context.addIssue({
      code: "custom",
      path: ["targetEntityId"],
      message: "task intervention target must equal taskId",
    });
  }
  if (
    (request.verb === "approve_exact_effect" || request.verb === "deny_narrow")
    && request.targetEntityId !== request.payload.effectId
  ) {
    context.addIssue({
      code: "custom",
      path: ["targetEntityId"],
      message: "effect intervention target must equal payload.effectId",
    });
  }
  if (request.verb === "rewind" && request.targetEntityId !== request.payload.checkpointHash) {
    context.addIssue({
      code: "custom",
      path: ["targetEntityId"],
      message: "rewind target must equal payload.checkpointHash",
    });
  }
});

export const ProposeInterventionV2 = {
  method: "POST" as const,
  path: "/v2/interventions",
  request: ProposeInterventionRequestV2,
  response: structuredInterventionSchema,
};

export const ApplyInterventionV2 = {
  method: "POST" as const,
  path: "/v2/interventions/:id/apply",
  request: z.object({
    id: z.string().min(1),
  }),
  response: z.object({
    success: z.boolean(),
    intervention: structuredInterventionSchema,
    appliedChanges: z.record(z.string(), z.unknown()),
    error: z.string().optional(),
  }),
};

export const ListInterventionsV2 = {
  method: "GET" as const,
  path: "/v2/interventions",
  request: z.object({ taskId: z.string().optional() }).optional(),
  response: z.object({
    interventions: z.array(structuredInterventionSchema),
  }),
};

// /v2/replay & counterfactual
export const CreateCausalTraceV2 = {
  method: "POST" as const,
  path: "/v2/replay/traces",
  request: z.object({
    taskId: z.string().min(1),
    attemptId: z.string().min(1),
    pinnedInputsHash: contentHashSchema,
  }).strict(),
  response: causalReplayTraceSchema,
};

export const GetCausalTraceV2 = {
  method: "GET" as const,
  path: "/v2/replay/traces/:taskId",
  request: z.void(),
  response: causalReplayTraceSchema.nullable(),
};

export const RecordCausalStepV2 = {
  method: "POST" as const,
  path: "/v2/replay/steps",
  request: z.object({
    traceId: z.string().min(1),
    step: causalStepSchema,
  }),
  response: causalReplayTraceSchema,
};

export const DiagnoseCausalOmissionsV2 = {
  method: "POST" as const,
  path: "/v2/replay/traces/:traceId/diagnose",
  request: z.object({
    traceId: z.string().min(1),
    failureStepIndex: z.number().int().nonnegative(),
    omittedCandidates: z.array(z.object({
      blockId: z.string().trim().min(1),
      sourcePath: z.string().trim().min(1),
      omittedReason: z.string().trim().min(1),
      tokenEstimate: z.number().int().nonnegative(),
    }).strict()),
  }).strict(),
  response: causalReplayTraceSchema,
};

export const RunCounterfactualV2 = {
  method: "POST" as const,
  path: "/v2/replay/counterfactual",
  request: z.object({
    sourceTaskId: z.string().min(1),
    variationType: z.enum(["profile", "prompt", "retrieval", "intervention"]),
    variationDetails: z.record(z.string(), z.unknown()),
  }),
  response: CounterfactualExperimentWire,
};

// /v2/mobile & /v2/ide
export const GetMobileSessionV2 = {
  method: "GET" as const,
  path: "/v2/mobile/sessions/:taskId",
  request: z.void(),
  response: mobileSupervisionSessionSchema,
};

export const ExecuteMobileActionV2 = {
  method: "POST" as const,
  path: "/v2/mobile/sessions/:taskId/action",
  request: z.object({
    taskId: z.string().min(1),
    action: z.enum(["pause", "resume", "approve_effect", "terminate", "request_review"]),
    effectId: z.string().optional(),
    rationale: z.string().optional(),
  }),
  response: z.object({
    success: z.boolean(),
    action: z.string(),
    timestamp: z.string(),
  }),
};

export const SyncAcpContextV2 = {
  method: "POST" as const,
  path: "/v2/ide/context-sync",
  request: acpContextInjectionSchema,
  response: z.object({
    synced: z.boolean(),
    contextHash: contentHashSchema,
    receivedDiagnostics: z.number().int().nonnegative(),
    durability: z.literal("process_local"),
  }),
};

// ────────────────────────── Phase 10: Computer Use & Agency ───────────────────

// /v2/computer/observe & observations
export const CreateUiObservationV2 = {
  method: "POST" as const,
  path: "/v2/computer/observe",
  request: z.object({
    taskId: z.string().min(1),
    receipt: TrustedReceiptReferenceWire,
  }).strict(),
  response: uiObservationSchema,
};

export const GetUiObservationV2 = {
  method: "GET" as const,
  path: "/v2/computer/observations/:id",
  request: z.object({ id: z.string().min(1) }),
  response: uiObservationSchema,
};

export const VerifyUiTargetV2 = {
  method: "POST" as const,
  path: "/v2/computer/verify-target",
  request: z.object({
    observationId: z.string().min(1),
    action: computerUseActionSchema,
  }),
  response: semanticTargetVerificationSchema,
};

export const DispatchComputerActionV2 = {
  method: "POST" as const,
  path: "/v2/computer/action",
  request: z.object({
    action: computerUseActionSchema,
    observationId: z.string().min(1),
  }),
  response: z.object({
    actionId: z.string().min(1),
    status: z.enum(["dispatched", "rejected"]),
    backendSupport: z.enum(["coordinator_only", "kernel_backed"]),
    verification: semanticTargetVerificationSchema.nullable(),
    dispatchedAt: z.string().nullable(),
    reason: z.string().min(1),
  }),
};

export const RecordUiEvidenceV2 = {
  method: "POST" as const,
  path: "/v2/computer/evidence",
  request: z.object({
    taskId: z.string().min(1),
    actionId: z.string().min(1),
    observationId: z.string().min(1),
    receipt: TrustedReceiptReferenceWire,
  }).strict(),
  response: uiEvidenceRecordSchema,
};

// /v2/computer/pools
export const ListComputerPoolsV2 = {
  method: "GET" as const,
  path: "/v2/computer/pools",
  request: z.object({}),
  response: z.array(browserDesktopPoolSchema),
};

export const AcquirePoolLeaseV2 = {
  method: "POST" as const,
  path: "/v2/computer/pools/:poolId/lease",
  request: z.object({
    poolId: z.string().min(1),
    taskId: z.string().min(1),
    workerId: z.string().min(1),
    ttlMs: z.number().int().positive().default(300000),
  }),
  response: poolLeaseSchema,
};

export const ReleasePoolLeaseV2 = {
  method: "POST" as const,
  path: "/v2/computer/pools/:poolId/leases/:leaseId/release",
  request: z.object({
    poolId: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  response: poolLeaseSchema,
};

// /v2/computer/takeover
export const InitiateHumanTakeoverV2 = {
  method: "POST" as const,
  path: "/v2/computer/takeover",
  request: z.object({
    taskId: z.string().min(1),
    poolId: z.string().min(1),
    surface: z.enum(["browser", "desktop"]),
    reason: z.string().min(1),
    currentObservationId: z.string().min(1),
  }),
  response: humanTakeoverSessionSchema,
};

export const ResumeFromTakeoverV2 = {
  method: "POST" as const,
  path: "/v2/computer/takeover/:takeoverId/resume",
  request: z.object({
    takeoverId: z.string().min(1),
    newObservationId: z.string().min(1),
  }),
  response: humanTakeoverSessionSchema,
};

// /v2/data-flow
export const EvaluateDataFlowV2 = {
  method: "POST" as const,
  path: "/v2/data-flow/evaluate",
  request: z.object({
    taskId: z.string().min(1),
    policyId: z.string().min(1),
    direction: z.enum(["upload", "download", "clipboard_read", "clipboard_write"]),
    payloadHandle: resourceHandleSchema,
    dlpReceiptArtifactRef: ArtifactRefWire,
    destination: z.string().nullable().default(null),
    destinationEvidenceArtifactRef: ArtifactRefWire.nullable().default(null),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
    bytesCount: ByteCountWire.optional(),
  }).strict(),
  response: DataFlowCheckResultWire,
};

export const QuarantineDownloadV2 = {
  method: "POST" as const,
  path: "/v2/data-flow/quarantine",
  request: z.object({
    taskId: z.string().min(1),
    policyId: z.string().min(1),
    downloadHandle: resourceHandleSchema,
    fileName: z.string().min(1),
    mimeType: z.string().min(1),
    bytesCount: ByteCountWire,
    quarantineReceiptArtifactRef: ArtifactRefWire,
    scanReceiptArtifactRef: ArtifactRefWire,
  }).strict(),
  response: DataTransferAuditWire,
};

// /v2/computer/reconcile-submit
export const ReconcileSubmitV2 = {
  method: "POST" as const,
  path: "/v2/computer/reconcile-submit",
  request: z.object({
    effectId: z.string().min(1),
    taskId: z.string().min(1),
    semanticIdempotencyKey: z.string().min(1),
    previousObservationId: z.string().min(1),
    postTimeoutObservationId: z.string().min(1),
    settlementProbeReceiptArtifactRef: ArtifactRefWire,
  }).strict(),
  response: ambiguousSubmitReconciliationSchema,
};

// /v2/connectors
export const ListConnectorsV2 = {
  method: "GET" as const,
  path: "/v2/connectors",
  request: z.object({}),
  response: z.array(externalConnectorSpecSchema),
};

export const ExecuteConnectorCallV2 = {
  method: "POST" as const,
  path: "/v2/connectors/:connectorId/call",
  request: connectorCallIntentSchema,
  response: connectorCallResultSchema,
};

// /v2/profiles/incident & research
export const StartIncidentTaskV2 = {
  method: "POST" as const,
  path: "/v2/profiles/incident/start",
  request: z.object({
    profileId: z.string(),
    taskId: z.string(),
    initialDiagnostics: z.array(z.string()),
  }),
  response: incidentExecutionRecordSchema,
};

export const StartResearchTaskV2 = {
  method: "POST" as const,
  path: "/v2/profiles/research/start",
  request: z.object({
    profileId: z.string(),
    taskId: z.string(),
  }),
  response: researchProvenanceRecordSchema,
};

// ────────────────────────── V2 Endpoint Registry ─────────────────────────────

export const V2_ENDPOINTS = {
  GetSystemHealthV2,
  GetSchemaRegistryV2,
  CreateTaskV2,
  GetTaskV2,
  GetTaskConversationContextV2,
  AttachTaskConversationContextV2,
  TransitionTaskV2,
  UpdateTaskContractV2,
  CreateWorkflowV2,
  CompileWorkflowV2,
  ValidateWorkflowV2,
  GetWorkflowDagV2,
  GetWorkflowWitnessPathsV2,
  ExecuteWorkflowNodeV2,
  TransitionWorkflowV2,
  SubmitClaimV2,
  WaiveClaimV2,
  RecordEvidenceV2,
  ListClaimsV2,
  ListEvidenceV2,
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
  GetTaskBudgetV2,
  ListModelProfilesV2,
  GetModelProfileV2,
  RouteModelStageV2,
  UpdateModelPosteriorV2,
  GetModelPosteriorV2,
  ScheduleEVWorkerV2,
  CheckStagnationV2,
  EvaluateCleanReviewV2,
  ListOrganizationsV2,
  ListDepartmentsV2,
  ListOperatorsV2,
  ListAgentRoomsV2,
  ListCapabilityDirectoryV2,
  ResolveCapabilityV2,
  AssessTaskAttentionV2,
  ListMaterialQuestionsV2,
  AskMaterialQuestionV2,
  ResolveMaterialQuestionV2,
  ProposeInterventionV2,
  ApplyInterventionV2,
  ListInterventionsV2,
  CreateCausalTraceV2,
  GetCausalTraceV2,
  RecordCausalStepV2,
  DiagnoseCausalOmissionsV2,
  RunCounterfactualV2,
  GetMobileSessionV2,
  ExecuteMobileActionV2,
  SyncAcpContextV2,
  CreateUiObservationV2,
  GetUiObservationV2,
  VerifyUiTargetV2,
  DispatchComputerActionV2,
  RecordUiEvidenceV2,
  ListComputerPoolsV2,
  AcquirePoolLeaseV2,
  ReleasePoolLeaseV2,
  InitiateHumanTakeoverV2,
  ResumeFromTakeoverV2,
  EvaluateDataFlowV2,
  QuarantineDownloadV2,
  ReconcileSubmitV2,
  ListConnectorsV2,
  ExecuteConnectorCallV2,
  StartIncidentTaskV2,
  StartResearchTaskV2,
  SubscribeEventsV2,
} as const;

export type V2EndpointName = keyof typeof V2_ENDPOINTS;
