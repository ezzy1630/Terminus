import type { ContentHash } from "@terminus/domain";
import { ForgeError } from "@terminus/domain";
import { canonicalJson, computeContentHash } from "@terminus/context-ir";

/** Versioned identity for one settled operation observed by the loop. */
export const OPERATION_OBSERVATION_VERSION = "terminus.operation-observation.v1";

export type OperationStatus =
  | "success"
  | "partial"
  | "error"
  | "denied"
  | "timeout"
  | "cancelled"
  | "unknown";

export interface OperationObservation {
  readonly schemaVersion: typeof OPERATION_OBSERVATION_VERSION;
  readonly observationHash: ContentHash;
  /** Semantic identity excludes result text so equivalent retries compare. */
  readonly semanticFingerprint: ContentHash;
  readonly taskId: string | null;
  readonly contractVersion: number | null;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly providerCallId: string;
  readonly toolId: string;
  readonly toolVersion: string | null;
  readonly status: OperationStatus;
  readonly resultHash: ContentHash | null;
  readonly errorCode: string | null;
  readonly errorClass: string | null;
  readonly mutatesWorkspace: boolean;
  readonly workspaceRevisionBefore: string | null;
  readonly workspaceRevisionAfter: string | null;
  readonly verificationDelta: ContentHash | null;
  readonly hypothesisId: string | null;
  readonly criterionIds: readonly string[];
  readonly objectiveStep: string | null;
}

export interface OperationObservationInput {
  readonly taskId?: string | null | undefined;
  readonly contractVersion?: number | null | undefined;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly providerCallId: string;
  readonly toolId: string;
  readonly toolVersion?: string | null | undefined;
  readonly status: OperationStatus;
  readonly resultHash?: ContentHash | string | null | undefined;
  readonly errorCode?: string | null | undefined;
  readonly errorClass?: string | null | undefined;
  readonly mutatesWorkspace: boolean;
  readonly workspaceRevisionBefore?: string | null | undefined;
  readonly workspaceRevisionAfter?: string | null | undefined;
  readonly verificationDelta?: ContentHash | string | null | undefined;
  readonly hypothesisId?: string | null | undefined;
  readonly criterionIds?: readonly string[] | undefined;
  readonly objectiveStep?: string | null | undefined;
  /** Canonical tool arguments are hashed and never retained in the observation. */
  readonly arguments: unknown;
}

/**
 * Build an immutable, secret-safe operation identity. Arguments are input to
 * the hash only. The durable record contains no provider argument payload.
 */
export function buildOperationObservation(input: OperationObservationInput): OperationObservation {
  const criterionIds = [...new Set(input.criterionIds ?? [])].sort();
  const semanticFingerprint = computeContentHash(canonicalJson({
    schema_version: OPERATION_OBSERVATION_VERSION,
    task_id: input.taskId ?? null,
    contract_version: input.contractVersion ?? null,
    tool_id: input.toolId,
    tool_version: input.toolVersion ?? null,
    arguments: input.arguments,
    hypothesis_id: input.hypothesisId ?? null,
    criterion_ids: criterionIds,
    objective_step: input.objectiveStep ?? null,
  }));
  const observationHash = computeContentHash(canonicalJson({
    semantic_fingerprint: semanticFingerprint,
    attempt_id: input.attemptId,
    attempt_number: input.attemptNumber,
    provider_call_id: input.providerCallId,
    status: input.status,
    result_hash: input.resultHash ?? null,
    error_code: input.errorCode ?? null,
    error_class: input.errorClass ?? null,
    mutates_workspace: input.mutatesWorkspace,
    workspace_revision_before: input.workspaceRevisionBefore ?? null,
    workspace_revision_after: input.workspaceRevisionAfter ?? null,
    verification_delta: input.verificationDelta ?? null,
  }));
  return {
    schemaVersion: OPERATION_OBSERVATION_VERSION,
    observationHash,
    semanticFingerprint,
    taskId: input.taskId ?? null,
    contractVersion: input.contractVersion ?? null,
    attemptId: input.attemptId,
    attemptNumber: input.attemptNumber,
    providerCallId: input.providerCallId,
    toolId: input.toolId,
    toolVersion: input.toolVersion ?? null,
    status: input.status,
    resultHash: input.resultHash === null || input.resultHash === undefined
      ? null
      : input.resultHash as ContentHash,
    errorCode: input.errorCode ?? null,
    errorClass: input.errorClass ?? null,
    mutatesWorkspace: input.mutatesWorkspace,
    workspaceRevisionBefore: input.workspaceRevisionBefore ?? null,
    workspaceRevisionAfter: input.workspaceRevisionAfter ?? null,
    verificationDelta: input.verificationDelta === null || input.verificationDelta === undefined
      ? null
      : input.verificationDelta as ContentHash,
    hypothesisId: input.hypothesisId ?? null,
    criterionIds,
    objectiveStep: input.objectiveStep ?? null,
  };
}

export interface LoopErrorEnvelope {
  readonly code: string;
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly suggestedAction: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export type LoopErrorKind =
  | "policy_denied"
  | "budget_exhausted"
  | "needs_user_input"
  | "cancelled"
  | "provider"
  | "unknown";

export interface ClassifiedLoopError {
  readonly kind: LoopErrorKind;
  readonly envelope: LoopErrorEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function boundedMessage(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
}

/**
 * Classify errors by stable type/code. This intentionally does not inspect
 * human text, so a provider message containing "policy" cannot change control
 * flow.
 */
export function classifyLoopError(error: unknown): ClassifiedLoopError {
  if (error instanceof ForgeError) {
    const providerFailure = error.category === "provider"
      || error.category === "timeout"
      || error.category === "sandbox_unavailable"
      || error.category === "external_dependency";
    const kind: LoopErrorKind = error.code === "POLICY_DENIED" || error.code === "PERMISSION_DENIED"
      ? "policy_denied"
      : error.code === "APPROVAL_REQUIRED"
        ? "needs_user_input"
      : error.code === "BUDGET_EXHAUSTED" || error.code === "RESOURCE_EXHAUSTED"
        ? "budget_exhausted"
        : error.code === "CANCELLED"
          ? "cancelled"
          : providerFailure
            ? "provider"
            : "unknown";
    return {
      kind,
      envelope: {
        code: error.code,
        category: error.category,
        message: boundedMessage(error.message),
        retryable: error.retryable,
        suggestedAction: error.suggestedAction,
        details: error.details,
      },
    };
  }
  const record = isRecord(error) ? error : null;
  const name = typeof record?.name === "string" ? record.name : null;
  const code = typeof record?.code === "string" ? record.code : null;
  const kind: LoopErrorKind = name === "ToolPolicyDeniedError" || code === "POLICY_DENIED"
    ? "policy_denied"
    : name === "ApprovalRequiredError" || code === "APPROVAL_REQUIRED"
      ? "needs_user_input"
    : name === "ToolCycleBudgetExhaustedError" || code === "BUDGET_EXHAUSTED"
      ? "budget_exhausted"
      : name === "CancelledError" || code === "CANCELLED"
        ? "cancelled"
        : name === "ProviderExecutionUnavailableError" || code === "PROVIDER_UNAVAILABLE"
          ? "provider"
          : "unknown";
  const message = error instanceof Error
    ? error.message
    : "Loop operation failed with an untyped error";
  return {
    kind,
    envelope: {
      code: code ?? "INTERNAL",
      category: kind === "policy_denied"
        ? "policy_denied"
        : kind === "budget_exhausted"
          ? "budget_exhausted"
          : kind === "provider"
            ? "provider"
            : "internal",
      message: boundedMessage(message),
      retryable: kind === "provider",
      suggestedAction: kind === "policy_denied"
        ? "request a policy exception or change the operation"
        : kind === "needs_user_input"
          ? "surface the pending decision to the user"
          : kind === "budget_exhausted"
            ? "reduce scope or increase the bounded budget"
            : kind === "provider"
              ? "retry with the same request only when the provider marks it retryable"
              : null,
      details: {},
    },
  };
}

export function operationErrorCode(error: unknown): string | null {
  return classifyLoopError(error).envelope.code;
}
