/**
 * Terminus Desktop — ARP v2 canonical client adapter (SPEC §32).
 *
 * Speaks ONLY the canonical `/v2/*` surface against the control plane:
 * tasks (proof-carrying contracts + optimistic concurrency), transactional
 * effects (proposal and authoritative ledger inspection),
 * claims/evidence, and resumable SSE envelopes from `/v2/events`.
 *
 * This is the same protocol surface the CLI's `*-v2` commands use, so a
 * task created by either client is visible to both (Phase 1 exit gate:
 * "CLI and one graphical client use ARP v2 for the same task").
 *
 * Reuses the v1 client's base-URL/token resolution and error envelope so
 * both surfaces behave identically offline/misconfigured.
 */
import { createSseDecoder, IDEMPOTENCY_HEADER, requireIdempotency } from "@terminus/public-api";
import { api, networkUnavailableError, readBoundedResponseText, TerminusApiError } from "./api";
import type { MutationRequestOptions } from "./api";
import type {
  AgentRoomSnapshot,
  ArpV2EventEnvelope,
  AttentionAssessmentSnapshot,
  CapabilityDirectoryEntrySnapshot,
  ClaimSnapshot,
  CounterfactualExperimentSnapshot,
  CounterfactualVariationType,
  CausalReplayTraceSnapshot,
  DepartmentSnapshot,
  EffectSnapshot,
  InterventionApplicationResult,
  MaterialQuestionResolution,
  MaterialQuestionSnapshot,
  MobileActionResult,
  MobileQuickAction,
  MobileSupervisionSessionSnapshot,
  OperatorAgentSnapshot,
  OrganizationSnapshot,
  StructuredInterventionSnapshot,
  StructuredInterventionVerb,
  TaskBudgetSnapshot,
  TaskContractV2,
  TaskV2Snapshot,
  TaskV2Status,
} from "../types/v2";
import {
  ATTENTION_URGENCIES,
  CAPABILITY_DIRECTORY_STATUSES,
  CLAIM_STATUSES,
  COUNTERFACTUAL_VARIATION_TYPES,
  EFFECT_STATES,
  MATERIALITY_TRIGGERS,
  MATERIAL_QUESTION_STATUSES,
  MOBILE_QUICK_ACTIONS,
  STRUCTURED_INTERVENTION_STATUSES,
  STRUCTURED_INTERVENTION_VERBS,
  TASK_V2_STATUSES,
} from "../types/v2";

// ────────────────────────── Boundary decoding ──────────────────────────────

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TerminusApiError(502, `${what} response was not an object`, null);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TerminusApiError(502, `${what} was not a non-empty string`, null);
  }
  return value;
}

function nullableString(value: unknown, what: string): string | null {
  if (value === null) return null;
  return requiredString(value, what);
}

function optionalString(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, what);
}

function requiredBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    throw new TerminusApiError(502, `${what} was not a boolean`, null);
  }
  return value;
}

function requiredNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TerminusApiError(502, `${what} was not a finite number`, null);
  }
  return value;
}

function requiredInteger(value: unknown, what: string): number {
  const number = requiredNumber(value, what);
  if (!Number.isInteger(number)) {
    throw new TerminusApiError(502, `${what} was not an integer`, null);
  }
  return number;
}

function requiredNonNegativeInteger(value: unknown, what: string): number {
  const number = requiredInteger(value, what);
  if (number < 0) {
    throw new TerminusApiError(502, `${what} was negative`, null);
  }
  return number;
}

function requiredTimestamp(value: unknown, what: string): string {
  const timestamp = requiredString(value, what);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new TerminusApiError(502, `${what} was not a valid timestamp`, null);
  }
  return timestamp;
}

function requiredStringArray(value: unknown, what: string): string[] {
  const values = requiredArray(value, what);
  const strings: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") {
      throw new TerminusApiError(502, `${what} was not a string array`, null);
    }
    strings.push(item);
  }
  return strings;
}

export const MAX_ARP_COLLECTION_ITEMS = 500;

function requiredArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TerminusApiError(502, `${what} was not an array`, null);
  }
  if (value.length > MAX_ARP_COLLECTION_ITEMS) {
    throw new TerminusApiError(
      502,
      `${what} exceeded the ${MAX_ARP_COLLECTION_ITEMS}-item renderer admission limit`,
      null,
    );
  }
  return value;
}

function requiredRecord(value: unknown, what: string): Record<string, unknown> {
  return asObject(value, what);
}

function requiredStringRecord(value: unknown, what: string): Record<string, string> {
  const record = asObject(value, what);
  const strings: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new TerminusApiError(502, `${what} contained a non-string value`, null);
    }
    strings[key] = item;
  }
  return strings;
}

function isEnumValue<T extends string>(value: string, values: readonly T[]): value is T {
  return values.some((candidate) => candidate === value);
}

function requiredEnum<const T extends readonly string[]>(value: unknown, values: T, what: string): T[number] {
  if (typeof value !== "string" || !isEnumValue(value, values)) {
    throw new TerminusApiError(502, `${what} contained unsupported value '${String(value)}'`, null);
  }
  return value;
}

function requiredArrayField(value: unknown, field: string, what: string): unknown[] {
  const record = asObject(value, what);
  const fieldValue = record[field];
  return requiredArray(fieldValue, `${what}.${field}`);
}

const MAX_DECIMAL_DIGITS = 78;

function decimalString(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new TerminusApiError(502, `${what} was not a decimal string`, null);
  }
  const digitCount = value.startsWith("-") ? value.length - 1 : value.length;
  if (digitCount > MAX_DECIMAL_DIGITS) {
    throw new TerminusApiError(502, `${what} exceeded ${MAX_DECIMAL_DIGITS} decimal digits`, null);
  }
  return value;
}

function nonNegativeDecimalString(value: unknown, what: string): string {
  const decimal = decimalString(value, what);
  if (decimal.startsWith("-")) {
    throw new TerminusApiError(502, `${what} was negative`, null);
  }
  return decimal;
}

function requiredNonNegativeNumber(value: unknown, what: string): number {
  const number = requiredNumber(value, what);
  if (number < 0) {
    throw new TerminusApiError(502, `${what} was negative`, null);
  }
  return number;
}

function assertTaskScope<T extends { taskId: string }>(value: T, expectedTaskId: string, resource: string): T {
  if (value.taskId !== expectedTaskId) {
    throw new TerminusApiError(
      502,
      `${resource} response crossed the requested task scope: expected ${expectedTaskId}, received ${value.taskId}`,
      null,
    );
  }
  return value;
}

function assertOptionalTaskScope<T extends { taskId: string }>(
  values: readonly T[],
  expectedTaskId: string | undefined,
  resource: string,
): T[] {
  return expectedTaskId === undefined
    ? [...values]
    : values.map((value) => assertTaskScope(value, expectedTaskId, resource));
}

function assertTaskIdentity<T extends { id: string }>(value: T, expectedTaskId: string, resource: string): T {
  if (value.id !== expectedTaskId) {
    throw new TerminusApiError(
      502,
      `${resource} response crossed the requested task scope: expected ${expectedTaskId}, received ${value.id}`,
      null,
    );
  }
  return value;
}

/** Decode an untrusted canonical event envelope before it enters renderer state. */
export function decodeArpV2EventEnvelope(value: unknown): ArpV2EventEnvelope {
  const envelope = asObject(value, "v2 event envelope");
  const schemaVersion = requiredInteger(envelope.schemaVersion, "v2 event envelope.schemaVersion");
  if (schemaVersion !== 2) {
    throw new TerminusApiError(502, `v2 event envelope.schemaVersion was ${schemaVersion}, expected 2`, null);
  }
  const actor = asObject(envelope.actor, "v2 event envelope.actor");
  return {
    eventId: requiredString(envelope.eventId, "v2 event envelope.eventId"),
    eventType: requiredString(envelope.eventType, "v2 event envelope.eventType"),
    schemaVersion: 2,
    aggregateType: requiredString(envelope.aggregateType, "v2 event envelope.aggregateType"),
    aggregateId: requiredString(envelope.aggregateId, "v2 event envelope.aggregateId"),
    aggregateSequence: requiredNonNegativeInteger(envelope.aggregateSequence, "v2 event envelope.aggregateSequence"),
    occurredAt: requiredTimestamp(envelope.occurredAt, "v2 event envelope.occurredAt"),
    actor: {
      kind: requiredString(actor.kind, "v2 event envelope.actor.kind"),
      id: requiredString(actor.id, "v2 event envelope.actor.id"),
    },
    correlationId: nullableString(envelope.correlationId, "v2 event envelope.correlationId"),
    causationId: nullableString(envelope.causationId, "v2 event envelope.causationId"),
    idempotencyKey: nullableString(envelope.idempotencyKey, "v2 event envelope.idempotencyKey"),
    payload: requiredRecord(envelope.payload, "v2 event envelope.payload"),
    artifactRefs: requiredArray(envelope.artifactRefs, "v2 event envelope.artifactRefs"),
    traceId: nullableString(envelope.traceId, "v2 event envelope.traceId"),
  };
}

/** Decode an unknown payload into a TaskV2Snapshot, rejecting malformed data. */
export function decodeTaskV2(value: unknown): TaskV2Snapshot {
  const task = asObject(value, "v2 task");
  const contract = asObject(task.contract, "v2 task contract");
  const constraints = asObject(contract.constraints, "v2 task constraints");
  const scope = asObject(contract.scope, "v2 task scope");
  const context = task.conversationContext == null
    ? null
    : asObject(task.conversationContext, "v2 task conversation context");
  return {
    id: requiredString(task.id, "v2 task.id"),
    missionId: nullableString(task.missionId, "v2 task.missionId"),
    organizationId: requiredString(task.organizationId, "v2 task.organizationId"),
    departmentId: requiredString(task.departmentId, "v2 task.departmentId"),
    createdBy: requiredString(task.createdBy, "v2 task.createdBy"),
    conversationContext: context === null ? null : {
      sessionId: requiredString(context.sessionId, "v2 task conversation context.sessionId"),
      threadId: requiredString(context.threadId, "v2 task conversation context.threadId"),
      attachedAt: requiredString(context.attachedAt, "v2 task conversation context.attachedAt"),
    },
    status: requiredEnum(task.status, TASK_V2_STATUSES, "v2 task.status"),
    version: requiredInteger(task.version, "v2 task.version"),
    createdAt: requiredString(task.createdAt, "v2 task.createdAt"),
    updatedAt: requiredString(task.updatedAt, "v2 task.updatedAt"),
    completedAt: nullableString(task.completedAt, "v2 task.completedAt"),
    contract: {
      version: requiredInteger(contract.version, "v2 task contract.version"),
      mission: requiredString(contract.mission, "v2 task contract.mission"),
      scope: {
        resources: requiredArray(scope.resources, "v2 task scope.resources"),
        allowedEffectClasses: requiredStringArray(scope.allowedEffectClasses, "v2 task scope.allowedEffectClasses"),
        excludedPathsOrSystems: requiredStringArray(scope.excludedPathsOrSystems, "v2 task scope.excludedPathsOrSystems"),
      },
      acceptance: requiredArray(contract.acceptance, "v2 task contract.acceptance").map((raw) => {
        const criterion = asObject(raw, "v2 task acceptance criterion");
        return {
          claimId: requiredString(criterion.claimId, "v2 task acceptance criterion.claimId"),
          statement: requiredString(criterion.statement, "v2 task acceptance criterion.statement"),
          evidenceRequirement: requiredString(criterion.evidenceRequirement, "v2 task acceptance criterion.evidenceRequirement"),
        };
      }),
      constraints: {
        security: requiredStringArray(constraints.security, "v2 task constraints.security"),
        costMicros: nonNegativeDecimalString(constraints.costMicros, "v2 task constraints.costMicros"),
        timeoutSeconds: requiredInteger(constraints.timeoutSeconds, "v2 task constraints.timeoutSeconds"),
      },
      authorityCeiling: requiredStringArray(contract.authorityCeiling, "v2 task contract.authorityCeiling"),
      mode: requiredString(contract.mode, "v2 task contract.mode"),
    },
  };
}

function decodeEffect(value: unknown): EffectSnapshot {
  const effect = asObject(value, "v2 effect");
  return {
    id: requiredString(effect.id, "v2 effect.id"),
    taskId: requiredString(effect.taskId, "v2 effect.taskId"),
    attemptId: requiredString(effect.attemptId, "v2 effect.attemptId"),
    principal: requiredString(effect.principal, "v2 effect.principal"),
    connectorOrWorker: requiredString(effect.connectorOrWorker, "v2 effect.connectorOrWorker"),
    intentType: requiredString(effect.intentType, "v2 effect.intentType"),
    canonicalParameters: requiredRecord(effect.canonicalParameters, "v2 effect.canonicalParameters"),
    resourceHandles: requiredArray(effect.resourceHandles, "v2 effect.resourceHandles"),
    effectClass: requiredString(effect.effectClass, "v2 effect.effectClass"),
    semanticIdempotencyKey: requiredString(effect.semanticIdempotencyKey, "v2 effect.semanticIdempotencyKey"),
    authorizationId: nullableString(effect.authorizationId, "v2 effect.authorizationId"),
    policyDecisionId: nullableString(effect.policyDecisionId, "v2 effect.policyDecisionId"),
    state: requiredEnum(effect.state, EFFECT_STATES, "v2 effect.state"),
    uncertaintyReason: nullableString(effect.uncertaintyReason, "v2 effect.uncertaintyReason"),
    compensationRef: nullableString(effect.compensationRef, "v2 effect.compensationRef"),
    version: requiredInteger(effect.version, "v2 effect.version"),
    createdAt: requiredString(effect.createdAt, "v2 effect.createdAt"),
    settledAt: nullableString(effect.settledAt, "v2 effect.settledAt"),
  };
}

function decodeClaim(value: unknown): ClaimSnapshot {
  const claim = asObject(value, "v2 claim");
  return {
    id: requiredString(claim.id, "v2 claim.id"),
    taskId: requiredString(claim.taskId, "v2 claim.taskId"),
    statement: requiredString(claim.statement, "v2 claim.statement"),
    requiredEvidenceKind: requiredString(claim.requiredEvidenceKind, "v2 claim.requiredEvidenceKind"),
    status: requiredEnum(claim.status, CLAIM_STATUSES, "v2 claim.status"),
    evidenceIds: requiredStringArray(claim.evidenceIds, "v2 claim.evidenceIds"),
    waivedRationale: nullableString(claim.waivedRationale, "v2 claim.waivedRationale"),
    createdAt: requiredString(claim.createdAt, "v2 claim.createdAt"),
    updatedAt: requiredString(claim.updatedAt, "v2 claim.updatedAt"),
  };
}

export function decodeOrganization(value: unknown): OrganizationSnapshot {
  const object = asObject(value, "organization");
  return {
    id: requiredString(object.id, "organization.id"),
    displayName: requiredString(object.displayName, "organization.displayName"),
    rootPolicyProfile: requiredString(object.rootPolicyProfile, "organization.rootPolicyProfile"),
    createdAt: requiredString(object.createdAt, "organization.createdAt"),
  };
}

export function decodeDepartment(value: unknown): DepartmentSnapshot {
  const object = asObject(value, "department");
  return {
    id: requiredString(object.id, "department.id"),
    organizationId: requiredString(object.organizationId, "department.organizationId"),
    displayName: requiredString(object.displayName, "department.displayName"),
    policyProfile: requiredString(object.policyProfile, "department.policyProfile"),
    defaultOperatorId: nullableString(object.defaultOperatorId, "department.defaultOperatorId"),
    createdAt: requiredString(object.createdAt, "department.createdAt"),
  };
}

export function decodeOperatorAgent(value: unknown): OperatorAgentSnapshot {
  const object = asObject(value, "operator agent");
  return {
    id: requiredString(object.id, "operator.id"),
    departmentId: requiredString(object.departmentId, "operator.departmentId"),
    displayName: requiredString(object.displayName, "operator.displayName"),
    capabilityScope: requiredStringArray(object.capabilityScope, "operator.capabilityScope"),
    modelProfile: requiredString(object.modelProfile, "operator.modelProfile"),
    active: requiredBoolean(object.active, "operator.active"),
  };
}

export function decodeAgentRoom(value: unknown): AgentRoomSnapshot {
  const object = asObject(value, "agent room");
  return {
    id: requiredString(object.id, "agentRoom.id"),
    departmentId: requiredString(object.departmentId, "agentRoom.departmentId"),
    name: requiredString(object.name, "agentRoom.name"),
    operatorId: requiredString(object.operatorId, "agentRoom.operatorId"),
    activeWorkerIds: requiredStringArray(object.activeWorkerIds, "agentRoom.activeWorkerIds"),
    specialistIds: requiredStringArray(object.specialistIds, "agentRoom.specialistIds"),
    reviewerIds: requiredStringArray(object.reviewerIds, "agentRoom.reviewerIds"),
    supervisorId: nullableString(object.supervisorId, "agentRoom.supervisorId"),
    createdAt: requiredString(object.createdAt, "agentRoom.createdAt"),
  };
}

export function decodeCapabilityDirectoryEntry(value: unknown): CapabilityDirectoryEntrySnapshot {
  const object = asObject(value, "capability directory entry");
  return {
    id: requiredString(object.id, "capability.id"),
    capabilityId: requiredString(object.capabilityId, "capability.capabilityId"),
    category: requiredString(object.category, "capability.category"),
    providerOperatorId: requiredString(object.providerOperatorId, "capability.providerOperatorId"),
    resourceDomain: requiredString(object.resourceDomain, "capability.resourceDomain"),
    authorityRequirement: requiredStringArray(object.authorityRequirement, "capability.authorityRequirement"),
    status: requiredEnum(object.status, CAPABILITY_DIRECTORY_STATUSES, "capability.status"),
  };
}

export function decodeMaterialQuestion(value: unknown): MaterialQuestionSnapshot {
  const object = asObject(value, "material question");
  const consequenceMatrix = requiredStringRecord(object.consequenceMatrix, "materialQuestion.consequenceMatrix");
  const options = requiredStringArray(object.options, "materialQuestion.options");
  if (options.some((option) => !Object.prototype.hasOwnProperty.call(consequenceMatrix, option))) {
    throw new TerminusApiError(502, "materialQuestion.consequenceMatrix did not cover every option", null);
  }
  return {
    id: requiredString(object.id, "materialQuestion.id"),
    taskId: requiredString(object.taskId, "materialQuestion.taskId"),
    trigger: requiredEnum(object.trigger, MATERIALITY_TRIGGERS, "materialQuestion.trigger"),
    questionText: requiredString(object.questionText, "materialQuestion.questionText"),
    consequenceMatrix,
    options,
    status: requiredEnum(object.status, MATERIAL_QUESTION_STATUSES, "materialQuestion.status"),
    suggestedOption: nullableString(object.suggestedOption, "materialQuestion.suggestedOption"),
    selectedOption: nullableString(object.selectedOption, "materialQuestion.selectedOption"),
    createdAt: requiredString(object.createdAt, "materialQuestion.createdAt"),
    resolvedAt: nullableString(object.resolvedAt, "materialQuestion.resolvedAt"),
  };
}

export function decodeAttentionAssessment(value: unknown): AttentionAssessmentSnapshot {
  const object = asObject(value, "attention assessment");
  const pendingQuestions = requiredArray(object.pendingQuestions, "attentionAssessment.pendingQuestions");
  return {
    taskId: requiredString(object.taskId, "attentionAssessment.taskId"),
    requiresAttention: requiredBoolean(object.requiresAttention, "attentionAssessment.requiresAttention"),
    urgency: requiredEnum(object.urgency, ATTENTION_URGENCIES, "attentionAssessment.urgency"),
    pendingQuestions: pendingQuestions.map(decodeMaterialQuestion),
    reason: requiredString(object.reason, "attentionAssessment.reason"),
    timestamp: requiredString(object.timestamp, "attentionAssessment.timestamp"),
  };
}

export function decodeStructuredIntervention(value: unknown): StructuredInterventionSnapshot {
  const object = asObject(value, "structured intervention");
  return {
    id: requiredString(object.id, "intervention.id"),
    taskId: requiredString(object.taskId, "intervention.taskId"),
    attemptId: nullableString(object.attemptId, "intervention.attemptId"),
    actorPrincipal: requiredString(object.actorPrincipal, "intervention.actorPrincipal"),
    verb: requiredEnum(object.verb, STRUCTURED_INTERVENTION_VERBS, "intervention.verb"),
    targetEntityId: nullableString(object.targetEntityId, "intervention.targetEntityId"),
    payload: requiredRecord(object.payload, "intervention.payload"),
    rationale: requiredString(object.rationale, "intervention.rationale"),
    status: requiredEnum(object.status, STRUCTURED_INTERVENTION_STATUSES, "intervention.status"),
    timestamp: requiredString(object.timestamp, "intervention.timestamp"),
  };
}

export function decodeInterventionApplication(value: unknown): InterventionApplicationResult {
  const object = asObject(value, "intervention application");
  return {
    success: requiredBoolean(object.success, "interventionApplication.success"),
    intervention: decodeStructuredIntervention(object.intervention),
    appliedChanges: requiredRecord(object.appliedChanges, "interventionApplication.appliedChanges"),
    error: optionalString(object.error, "interventionApplication.error"),
  };
}

function decodeMaterialQuestionResolution(value: unknown): MaterialQuestionResolution {
  const object = asObject(value, "material question resolution");
  return {
    success: requiredBoolean(object.success, "materialQuestionResolution.success"),
    question: object.question === null ? null : decodeMaterialQuestion(object.question),
    error: optionalString(object.error, "materialQuestionResolution.error"),
  };
}

function decodeCausalStep(value: unknown): CausalReplayTraceSnapshot["steps"][number] {
  const object = asObject(value, "causal step");
  return {
    stepIndex: requiredInteger(object.stepIndex, "causalStep.stepIndex"),
    component: requiredString(object.component, "causalStep.component"),
    inputManifestHash: requiredString(object.inputManifestHash, "causalStep.inputManifestHash"),
    modelOutputHash: nullableString(object.modelOutputHash, "causalStep.modelOutputHash"),
    effectId: nullableString(object.effectId, "causalStep.effectId"),
    verifierResult: nullableString(object.verifierResult, "causalStep.verifierResult"),
    durationMs: requiredNumber(object.durationMs, "causalStep.durationMs"),
    counterfactualAlternative: nullableString(object.counterfactualAlternative, "causalStep.counterfactualAlternative"),
  };
}

export function decodeCausalReplayTrace(value: unknown): CausalReplayTraceSnapshot {
  const object = asObject(value, "causal replay trace");
  const steps = requiredArray(object.steps, "causalTrace.steps");
  const omissionDiagnostics = requiredArray(object.omissionDiagnostics, "causalTrace.omissionDiagnostics");
  return {
    id: requiredString(object.id, "causalTrace.id"),
    taskId: requiredString(object.taskId, "causalTrace.taskId"),
    attemptId: requiredString(object.attemptId, "causalTrace.attemptId"),
    pinnedInputsHash: requiredString(object.pinnedInputsHash, "causalTrace.pinnedInputsHash"),
    steps: steps.map(decodeCausalStep),
    divergencePoints: requiredStringArray(object.divergencePoints, "causalTrace.divergencePoints"),
    omissionDiagnostics: omissionDiagnostics.map((raw) => {
      const diagnostic = asObject(raw, "omission diagnostic");
      const score = requiredNumber(diagnostic.causalRelevanceScore, "omissionDiagnostic.causalRelevanceScore");
      if (score < 0 || score > 1) {
        throw new TerminusApiError(502, "omissionDiagnostic.causalRelevanceScore was outside 0..1", null);
      }
      const evidenceRefs = requiredStringArray(diagnostic.evidenceRefs, "omissionDiagnostic.evidenceRefs");
      if (evidenceRefs.length === 0) {
        throw new TerminusApiError(502, "omissionDiagnostic.evidenceRefs was empty", null);
      }
      return {
        blockId: requiredString(diagnostic.blockId, "omissionDiagnostic.blockId"),
        sourcePath: requiredString(diagnostic.sourcePath, "omissionDiagnostic.sourcePath"),
        omittedReason: requiredString(diagnostic.omittedReason, "omissionDiagnostic.omittedReason"),
        causalRelevanceScore: score,
        evaluatorId: requiredString(diagnostic.evaluatorId, "omissionDiagnostic.evaluatorId"),
        evidenceRefs,
      };
    }),
    createdAt: requiredString(object.createdAt, "causalTrace.createdAt"),
  };
}

export function decodeCounterfactualExperiment(value: unknown): CounterfactualExperimentSnapshot {
  const object = asObject(value, "counterfactual experiment");
  return {
    id: requiredString(object.id, "counterfactual.id"),
    sourceTaskId: requiredString(object.sourceTaskId, "counterfactual.sourceTaskId"),
    variationType: requiredEnum(object.variationType, COUNTERFACTUAL_VARIATION_TYPES, "counterfactual.variationType"),
    variationDetails: requiredRecord(object.variationDetails, "counterfactual.variationDetails"),
    executionStatus: requiredEnum(object.executionStatus, ["planned", "completed"] as const, "counterfactual.executionStatus"),
    predictedOutcome: requiredString(object.predictedOutcome, "counterfactual.predictedOutcome"),
    actualOutcome: nullableString(object.actualOutcome, "counterfactual.actualOutcome"),
    deltaSuccess: object.deltaSuccess === null ? null : requiredBoolean(object.deltaSuccess, "counterfactual.deltaSuccess"),
    deltaCostMicros: object.deltaCostMicros === null ? null : decimalString(object.deltaCostMicros, "counterfactual.deltaCostMicros"),
    deltaLatencyMs: object.deltaLatencyMs === null ? null : requiredNumber(object.deltaLatencyMs, "counterfactual.deltaLatencyMs"),
  };
}

export function decodeTaskBudget(value: unknown): TaskBudgetSnapshot {
  const object = asObject(value, "task budget");
  return {
    taskId: requiredString(object.taskId, "taskBudget.taskId"),
    consumedCostMicros: nonNegativeDecimalString(object.consumedCostMicros, "taskBudget.consumedCostMicros"),
    consumedComputeSeconds: requiredNonNegativeNumber(object.consumedComputeSeconds, "taskBudget.consumedComputeSeconds"),
    consumedInputTokens: nonNegativeDecimalString(object.consumedInputTokens, "taskBudget.consumedInputTokens"),
    consumedOutputTokens: nonNegativeDecimalString(object.consumedOutputTokens, "taskBudget.consumedOutputTokens"),
    consumedApprovals: requiredNonNegativeInteger(object.consumedApprovals, "taskBudget.consumedApprovals"),
    lastUpdatedAt: requiredTimestamp(object.lastUpdatedAt, "taskBudget.lastUpdatedAt"),
  };
}

function decodeMobileSession(value: unknown): MobileSupervisionSessionSnapshot {
  const object = asObject(value, "mobile supervision session");
  const quickActions = requiredStringArray(object.quickActions, "mobileSession.quickActions")
    .map((action) => requiredEnum(action, MOBILE_QUICK_ACTIONS, "mobileSession.quickAction"));
  return {
    id: requiredString(object.id, "mobileSession.id"),
    taskId: requiredString(object.taskId, "mobileSession.taskId"),
    operatorPrincipal: requiredString(object.operatorPrincipal, "mobileSession.operatorPrincipal"),
    devicePlatform: requiredEnum(object.devicePlatform, ["ios", "android", "web"] as const, "mobileSession.devicePlatform"),
    connectionState: requiredEnum(object.connectionState, ["CONNECTED", "SUSPENDED", "DISCONNECTED"] as const, "mobileSession.connectionState"),
    quickActions,
    lastSeenAt: requiredString(object.lastSeenAt, "mobileSession.lastSeenAt"),
  };
}

function decodeMobileAction(value: unknown): MobileActionResult {
  const object = asObject(value, "mobile action");
  return {
    success: requiredBoolean(object.success, "mobileAction.success"),
    action: requiredEnum(object.action, MOBILE_QUICK_ACTIONS, "mobileAction.action"),
    timestamp: requiredString(object.timestamp, "mobileAction.timestamp"),
  };
}

// ────────────────────────── Client ─────────────────────────────────────────

/** Endpoint binding override. Defaults resolve like the v1 client (Electron bridge → Vite env → documented loopback). */
export interface ArpV2ClientConfig {
  baseUrl?: string;
  token?: string;
}

function buildUrl(base: string, path: string, query?: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v != null) q.set(k, v);
  }
  const qs = q.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

function buildHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export class TerminusArpV2Client {
  private readonly resolveUrl: (path: string, query?: Record<string, string | null | undefined>) => string;
  private readonly buildAuthHeaders: (extra?: Record<string, string>) => Record<string, string>;

  /**
   * @param config omit to share the v1 client's base URL/token resolution;
   *   provide `baseUrl`/`token` to bind this adapter to a specific control
   *   plane (used by the live ARP v2 E2E to exercise the exact graphical
   * -client code path against the harness daemon).
   */
  constructor(config: ArpV2ClientConfig = {}) {
    if (config.baseUrl !== undefined || config.token !== undefined) {
      const base = (config.baseUrl ?? "").replace(/\/+$/, "");
      const token = config.token ?? "";
      this.resolveUrl = (path, query) => buildUrl(base, path, query);
      this.buildAuthHeaders = (extra) => buildHeaders(token, extra);
    } else {
      this.resolveUrl = (path, query) => api.url(path, query);
      this.buildAuthHeaders = (extra) => api.buildHeaders(extra);
    }
  }

  /**
   * Fetch a JSON endpoint on the /v2 surface. `notFoundOk` returns null on
   * 404 instead of throwing (used when probing whether a task exists).
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: {
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal | null;
      notFoundOk?: boolean;
    } = {},
  ): Promise<T | null> {
    const headers = this.buildAuthHeaders();
    if (requireIdempotency(method)) {
      const key = opts.idempotencyKey;
      if (typeof key !== "string" || key.trim().length === 0) {
        throw new TypeError(`${IDEMPOTENCY_HEADER} must be a non-empty string for ${method}`);
      }
      headers[IDEMPOTENCY_HEADER] = key;
    }
    try {
      const res = await fetch(this.resolveUrl(path), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal ?? undefined,
      });
      if (res.status === 404 && opts.notFoundOk) return null;
      if (!res.ok) {
        const text = await readBoundedResponseText(res).catch((error: unknown) => {
          if (error instanceof TerminusApiError) throw error;
          return "";
        });
        throw new TerminusApiError(res.status, text.slice(0, 500) || `HTTP ${res.status}`, null);
      }
      const text = await readBoundedResponseText(res);
      if (text.length === 0) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new TerminusApiError(502, "control plane returned invalid JSON", null);
      }
    } catch (err) {
      if (err instanceof TerminusApiError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw networkUnavailableError(msg);
    }
  }

  health(signal?: AbortSignal | null): Promise<{ status: string; protocolVersion: number; ready: boolean }> {
    return this.request("GET", "/v2/system/health", { signal }) as Promise<{ status: string; protocolVersion: number; ready: boolean }>;
  }

  schemaRegistry(signal?: AbortSignal | null): Promise<{ protocolVersion: number; supportedEventTypes: string[]; schemas: Record<string, unknown> }> {
    return this.request("GET", "/v2/system/schema-registry", { signal }) as Promise<{ protocolVersion: number; supportedEventTypes: string[]; schemas: Record<string, unknown> }>;
  }

  /** Returns null when the id has no canonical v2 counterpart. */
  async getTask(taskId: string, signal?: AbortSignal | null): Promise<TaskV2Snapshot | null> {
    const raw = await this.request("GET", `/v2/tasks/${encodeURIComponent(taskId)}`, { signal, notFoundOk: true });
    return raw === null ? null : assertTaskIdentity(decodeTaskV2(raw), taskId, "v2 task detail");
  }

  listTasks(signal?: AbortSignal | null): Promise<TaskV2Snapshot[]> {
    return (async () => {
      const raw = await this.request<unknown>("GET", "/v2/tasks", { signal });
      return requiredArrayField(raw, "tasks", "v2 task list").map(decodeTaskV2);
    })();
  }

  createTask(
    input: { objective: string; mode?: string; context?: { sessionId: string; threadId: string } | null },
    options: MutationRequestOptions,
  ): Promise<TaskV2Snapshot> {
    // Canonical proof-carrying contract mirroring CompatibilityGateway.
    const contract: TaskContractV2 = {
      version: 1,
      mission: input.objective,
      scope: { resources: [], allowedEffectClasses: ["LOCAL_FS_WRITE", "LOCAL_PROCESS_SPAWN"], excludedPathsOrSystems: [] },
      acceptance: [{ claimId: "claim-1", statement: input.objective, evidenceRequirement: "DETERMINISTIC_TEST" }],
      constraints: { security: ["NO_AMBIENT_SECRETS"], costMicros: "10000000", timeoutSeconds: 3600 },
      authorityCeiling: ["FS_WRITE", "PROCESS_SPAWN"],
      mode: input.mode ?? "interactive",
    };
    return (async () => {
      const raw = await this.request("POST", "/v2/tasks", {
        body: {
          missionId: null,
          organizationId: "default-org",
          departmentId: "default-dept",
          v1Context: input.context ?? null,
          contract,
        },
        ...options,
      });
      return decodeTaskV2(raw);
    })();
  }

  async getTaskConversationContext(
    taskId: string,
    signal?: AbortSignal | null,
  ): Promise<TaskV2Snapshot["conversationContext"]> {
    const raw = await this.request<unknown>(
      "GET",
      `/v2/tasks/${encodeURIComponent(taskId)}/conversation-context`,
      { signal },
    );
    if (raw === null) return null;
    const context = asObject(raw, "v2 task conversation context");
    return {
      sessionId: requiredString(context.sessionId, "v2 task conversation context.sessionId"),
      threadId: requiredString(context.threadId, "v2 task conversation context.threadId"),
      attachedAt: requiredString(context.attachedAt, "v2 task conversation context.attachedAt"),
    };
  }

  async attachTaskConversationContext(
    taskId: string,
    context: { sessionId: string; threadId: string },
    options: MutationRequestOptions,
    expectedVersion?: number | null,
  ): Promise<TaskV2Snapshot> {
    const raw = await this.request<unknown>(
      "POST",
      `/v2/tasks/${encodeURIComponent(taskId)}/conversation-context`,
      { body: { ...context, expectedVersion: expectedVersion ?? null }, ...options },
    );
    return assertTaskIdentity(decodeTaskV2(raw), taskId, "v2 task context attachment");
  }

  async transitionTask(
    taskId: string,
    targetStatus: TaskV2Status,
    options: MutationRequestOptions,
    expectedVersion?: number | null,
  ): Promise<TaskV2Snapshot> {
    const raw = await this.request("POST", `/v2/tasks/${encodeURIComponent(taskId)}/transition`, {
      body: { targetStatus, expectedVersion: expectedVersion ?? null },
      ...options,
    });
    return assertTaskIdentity(decodeTaskV2(raw), taskId, "v2 task transition");
  }

  async listEffects(taskId: string, signal?: AbortSignal | null): Promise<EffectSnapshot[]> {
    const raw = await this.request<unknown>("GET", `/v2/effects?taskId=${encodeURIComponent(taskId)}`, { signal });
    return requiredArrayField(raw, "effects", "v2 effect list")
      .map(decodeEffect)
      .map((effect) => assertTaskScope(effect, taskId, "v2 effect list"));
  }

  proposeEffect(input: {
    taskId: string;
    intentType: string;
    effectClass: string;
    canonicalParameters?: Record<string, unknown>;
  }, options: MutationRequestOptions): Promise<EffectSnapshot> {
    return (async () => {
      const raw = await this.request("POST", "/v2/effects", {
        body: {
          taskId: input.taskId,
          attemptId: `desktop-${options.idempotencyKey}`,
          connectorOrWorker: "terminus-desktop",
          intentType: input.intentType,
          canonicalParameters: input.canonicalParameters ?? {},
          resourceHandles: [],
          effectClass: input.effectClass,
          semanticIdempotencyKey: options.idempotencyKey,
        },
        ...options,
      });
      return assertTaskScope(decodeEffect(raw), input.taskId, "v2 effect proposal");
    })();
  }

  submitClaim(
    taskId: string,
    statement: string,
    options: MutationRequestOptions,
    requiredEvidenceKind = "DETERMINISTIC_TEST",
  ): Promise<ClaimSnapshot> {
    return (async () => {
      const raw = await this.request("POST", "/v2/claims", {
        body: { taskId, statement, requiredEvidenceKind },
        ...options,
      });
      return assertTaskScope(decodeClaim(raw), taskId, "v2 claim submission");
    })();
  }

  // ────────────────────────── Phase 9: Cockpit, Attention & Interventions ──────

  async listOrganizations(signal?: AbortSignal | null): Promise<OrganizationSnapshot[]> {
    const raw = await this.request<unknown>("GET", "/v2/organizations", { signal });
    return requiredArrayField(raw, "organizations", "organization list").map(decodeOrganization);
  }

  async listDepartments(orgId?: string, signal?: AbortSignal | null): Promise<DepartmentSnapshot[]> {
    const raw = await this.request<unknown>("GET", `/v2/departments${orgId ? `?organizationId=${encodeURIComponent(orgId)}` : ""}`, { signal });
    return requiredArrayField(raw, "departments", "department list").map(decodeDepartment);
  }

  async listOperators(deptId?: string, signal?: AbortSignal | null): Promise<OperatorAgentSnapshot[]> {
    const raw = await this.request<unknown>("GET", `/v2/operators${deptId ? `?departmentId=${encodeURIComponent(deptId)}` : ""}`, { signal });
    return requiredArrayField(raw, "operators", "operator list").map(decodeOperatorAgent);
  }

  async listAgentRooms(deptId?: string, signal?: AbortSignal | null): Promise<AgentRoomSnapshot[]> {
    const raw = await this.request<unknown>("GET", `/v2/agent-rooms${deptId ? `?departmentId=${encodeURIComponent(deptId)}` : ""}`, { signal });
    return requiredArrayField(raw, "rooms", "agent room list").map(decodeAgentRoom);
  }

  async listCapabilityDirectory(signal?: AbortSignal | null): Promise<CapabilityDirectoryEntrySnapshot[]> {
    const raw = await this.request<unknown>("GET", "/v2/capabilities/directory", { signal });
    return requiredArrayField(raw, "capabilities", "capability directory").map(decodeCapabilityDirectoryEntry);
  }

  async assessTaskAttention(taskId: string, signal?: AbortSignal | null): Promise<AttentionAssessmentSnapshot> {
    const raw = await this.request<unknown>("GET", `/v2/attention/assess/${encodeURIComponent(taskId)}`, { signal });
    const assessment = assertTaskScope(decodeAttentionAssessment(raw), taskId, "v2 attention assessment");
    assessment.pendingQuestions = assessment.pendingQuestions.map((question) =>
      assertTaskScope(question, taskId, "v2 attention assessment pending question"),
    );
    return assessment;
  }

  async listMaterialQuestions(taskId?: string, signal?: AbortSignal | null): Promise<MaterialQuestionSnapshot[]> {
    const raw = await this.request<unknown>("GET", `/v2/attention/questions${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""}`, { signal });
    return assertOptionalTaskScope(
      requiredArrayField(raw, "questions", "material question list").map(decodeMaterialQuestion),
      taskId,
      "v2 material question list",
    );
  }

  async resolveMaterialQuestion(
    questionId: string,
    selectedOption: string,
    options: MutationRequestOptions,
  ): Promise<MaterialQuestionResolution> {
    const raw = await this.request<unknown>("POST", `/v2/attention/questions/${encodeURIComponent(questionId)}/resolve`, {
      body: { selectedOption },
      ...options,
    });
    const resolution = decodeMaterialQuestionResolution(raw);
    if (resolution.question !== null) {
      assertTaskIdentity(resolution.question, questionId, "v2 material question resolution");
    }
    return resolution;
  }

  async proposeIntervention(input: {
    taskId: string;
    attemptId?: string | null;
    verb: StructuredInterventionVerb;
    targetEntityId?: string | null;
    payload?: Record<string, unknown>;
    rationale: string;
  }, options: MutationRequestOptions): Promise<StructuredInterventionSnapshot> {
    const raw = await this.request<unknown>("POST", "/v2/interventions", { body: input, ...options });
    return assertTaskScope(decodeStructuredIntervention(raw), input.taskId, "v2 intervention proposal");
  }

  async applyIntervention(interventionId: string, options: MutationRequestOptions): Promise<InterventionApplicationResult> {
    const raw = await this.request<unknown>("POST", `/v2/interventions/${encodeURIComponent(interventionId)}/apply`, {
      body: { id: interventionId },
      ...options,
    });
    const application = decodeInterventionApplication(raw);
    assertTaskIdentity(application.intervention, interventionId, "v2 intervention application");
    return application;
  }

  async listInterventions(taskId?: string, signal?: AbortSignal | null): Promise<StructuredInterventionSnapshot[]> {
    const raw = await this.request<unknown>("GET", `/v2/interventions${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""}`, { signal });
    return assertOptionalTaskScope(
      requiredArrayField(raw, "interventions", "intervention list").map(decodeStructuredIntervention),
      taskId,
      "v2 intervention list",
    );
  }

  async getCausalTrace(taskId: string, signal?: AbortSignal | null): Promise<CausalReplayTraceSnapshot | null> {
    const raw = await this.request<unknown>("GET", `/v2/replay/traces/${encodeURIComponent(taskId)}`, { signal });
    return raw === null ? null : assertTaskScope(decodeCausalReplayTrace(raw), taskId, "v2 causal replay trace");
  }

  async runCounterfactual(input: {
    sourceTaskId: string;
    variationType: CounterfactualVariationType;
    variationDetails: Record<string, unknown>;
  }, options: MutationRequestOptions): Promise<CounterfactualExperimentSnapshot> {
    const raw = await this.request<unknown>("POST", "/v2/replay/counterfactual", { body: input, ...options });
    const experiment = decodeCounterfactualExperiment(raw);
    if (experiment.sourceTaskId !== input.sourceTaskId) {
      throw new TerminusApiError(
        502,
        `v2 counterfactual response crossed the requested task scope: expected ${input.sourceTaskId}, received ${experiment.sourceTaskId}`,
        null,
      );
    }
    return experiment;
  }

  async getTaskBudget(taskId: string, signal?: AbortSignal | null): Promise<TaskBudgetSnapshot> {
    const raw = await this.request<unknown>("GET", `/v2/tasks/${encodeURIComponent(taskId)}/budget`, { signal });
    return assertTaskScope(decodeTaskBudget(raw), taskId, "v2 task budget");
  }

  async getMobileSession(taskId: string, signal?: AbortSignal | null): Promise<MobileSupervisionSessionSnapshot> {
    const raw = await this.request<unknown>("GET", `/v2/mobile/sessions/${encodeURIComponent(taskId)}`, { signal });
    return assertTaskScope(decodeMobileSession(raw), taskId, "v2 mobile supervision session");
  }

  async executeMobileAction(
    taskId: string,
    action: MobileQuickAction,
    options: MutationRequestOptions,
  ): Promise<MobileActionResult> {
    const raw = await this.request<unknown>("POST", `/v2/mobile/sessions/${encodeURIComponent(taskId)}/action`, {
      body: { action },
      ...options,
    });
    const result = decodeMobileAction(raw);
    if (result.action !== action) {
      throw new TerminusApiError(
        502,
        `v2 mobile action response crossed the requested action scope: expected ${action}, received ${result.action}`,
        null,
      );
    }
    return result;
  }
}

export const arpV2 = new TerminusArpV2Client();

// ────────────────────────── /v2/events (SSE) ───────────────────────────────

export interface ArpV2EventStreamHandler { (envelope: ArpV2EventEnvelope): void }

export interface ArpV2EventStream {
  readonly readyState: 0 | 1 | 2 | 3;
  addEventListener(type: "message" | "open" | "error", handler: ArpV2EventStreamHandler | (() => void)): () => void;
  close(): void;
  lastEventId: string | null;
}

/**
 * Subscribe to canonical v2 event envelopes. Cursor replay uses the SSE
 * `id:` line (durable, monotonic) exactly like the v1 stream.
 */
export function subscribeEventsV2(opts: { taskId?: string | null; cursor?: string | null; signal?: AbortSignal | null } & ArpV2ClientConfig = {}): ArpV2EventStream {
  const listeners = new Map<string, Set<ArpV2EventStreamHandler | (() => void)>>();
  const abort = new AbortController();
  const bound = opts.baseUrl !== undefined || opts.token !== undefined;
  const base = (opts.baseUrl ?? "").replace(/\/+$/, "");
  const token = opts.token ?? "";
  const resolveUrl = bound
    ? (path: string, query?: Record<string, string | null | undefined>): string => buildUrl(base, path, query)
    : (path: string, query?: Record<string, string | null | undefined>): string => api.url(path, query);
  const buildAuthHeaders = bound
    ? (extra?: Record<string, string>): Record<string, string> => buildHeaders(token, extra)
    : (extra?: Record<string, string>): Record<string, string> => api.buildHeaders(extra);
  let readyState: 0 | 1 | 2 | 3 = 0;
  let lastEventId: string | null = null;
  let closed = false;
  let errorEmitted = false;

  const emit = (type: "message" | "open" | "error", ev?: ArpV2EventEnvelope): void => {
    const set = listeners.get(type);
    if (!set) return;
    for (const h of set) {
      try {
        if (type === "message") (h as ArpV2EventStreamHandler)(ev as ArpV2EventEnvelope);
        else (h as () => void)();
      } catch {
        // Listener errors must not break the stream.
      }
    }
  };

  const fail = (): void => {
    if (closed || errorEmitted) return;
    errorEmitted = true;
    readyState = 3;
    emit("error");
  };

  const closeStream = (): void => {
    if (closed) return;
    closed = true;
    readyState = 2;
    abort.abort();
  };

  if (opts.signal) opts.signal.addEventListener("abort", closeStream, { once: true });

  void (async (): Promise<void> => {
    const url = resolveUrl("/v2/events", { taskId: opts.taskId ?? null, cursor: opts.cursor ?? null });
    let res: Response;
    try {
      res = await fetch(url, {
        headers: buildAuthHeaders({ accept: "text/event-stream" }),
        signal: abort.signal,
      });
    } catch {
      if (closed) return;
      fail();
      return;
    }
    if (!res.ok || !res.body) {
      fail();
      return;
    }
    readyState = 1;
    emit("open");
    const reader = res.body.getReader();
    const decoder = createSseDecoder();
    const textDecoder = new TextDecoder();
    const dispatchEvents = (events: ReturnType<typeof decoder.feed>): void => {
      for (const sse of events) {
        let payload: unknown;
        try {
          payload = JSON.parse(sse.data) as unknown;
        } catch {
          continue;
        }
        let envelope: ArpV2EventEnvelope;
        try {
          envelope = decodeArpV2EventEnvelope(payload);
        } catch {
          continue;
        }
        // The durable SSE cursor and the JSON envelope describe one event.
        // Reject either mismatch before advancing replay state.
        if (!sse.id || sse.id !== envelope.eventId || sse.event !== envelope.eventType) continue;
        lastEventId = sse.id;
        emit("message", envelope);
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        dispatchEvents(decoder.feed(textDecoder.decode(value, { stream: true })));
      }
      dispatchEvents(decoder.feed(textDecoder.decode()));
      decoder.finish();
      fail();
    } catch {
      fail();
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      if (!closed && !errorEmitted) fail();
    }
  })();

  return {
    get readyState() {
      return readyState;
    },
    get lastEventId() {
      return lastEventId;
    },
    addEventListener(type, handler) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    close() {
      closeStream();
    },
  };
}
