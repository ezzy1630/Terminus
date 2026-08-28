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

const MAX_MESSAGE_CHARS = 512;
const MAX_CAUSE_DEPTH = 5;

function boundedMessage(value: string): string {
  return value.length <= MAX_MESSAGE_CHARS ? value : `${value.slice(0, MAX_MESSAGE_CHARS)}…`;
}

/**
 * Bounded string that says so when it is bounded. Silent truncation in an
 * error detail is how a root cause disappears.
 */
function boundedDetail(value: string): { readonly text: string; readonly truncated: boolean } {
  return value.length <= MAX_MESSAGE_CHARS
    ? { text: value, truncated: false }
    : { text: value.slice(0, MAX_MESSAGE_CHARS), truncated: true };
}

/**
 * grpc-js reports failures with a numeric `code` and no `name`, so the string
 * guards below classified every kernel fault as INTERNAL with `details: {}`.
 * This is the canonical grpc status mapping for the codes the kernel raises.
 */
const GRPC_STATUS: Readonly<Record<number, {
  readonly name: string;
  readonly category: string;
  readonly kind: LoopErrorKind;
  readonly retryable: boolean;
}>> = {
  1: { name: "CANCELLED", category: "cancelled", kind: "cancelled", retryable: false },
  2: { name: "UNKNOWN", category: "internal", kind: "unknown", retryable: false },
  3: { name: "INVALID_ARGUMENT", category: "validation", kind: "unknown", retryable: false },
  4: { name: "DEADLINE_EXCEEDED", category: "timeout", kind: "provider", retryable: true },
  5: { name: "NOT_FOUND", category: "not_found", kind: "unknown", retryable: false },
  6: { name: "ALREADY_EXISTS", category: "conflict", kind: "unknown", retryable: false },
  7: { name: "PERMISSION_DENIED", category: "policy_denied", kind: "policy_denied", retryable: false },
  8: { name: "RESOURCE_EXHAUSTED", category: "budget_exhausted", kind: "budget_exhausted", retryable: false },
  9: { name: "FAILED_PRECONDITION", category: "conflict", kind: "unknown", retryable: false },
  10: { name: "ABORTED", category: "conflict", kind: "unknown", retryable: true },
  11: { name: "OUT_OF_RANGE", category: "validation", kind: "unknown", retryable: false },
  12: { name: "UNIMPLEMENTED", category: "unsupported", kind: "unknown", retryable: false },
  13: { name: "INTERNAL", category: "internal", kind: "unknown", retryable: false },
  14: { name: "UNAVAILABLE", category: "transport", kind: "provider", retryable: true },
  15: { name: "DATA_LOSS", category: "internal", kind: "unknown", retryable: false },
  16: { name: "UNAUTHENTICATED", category: "policy_denied", kind: "policy_denied", retryable: false },
};

interface CauseLink {
  readonly name: string | null;
  readonly message: string;
  readonly code?: string | number | undefined;
  readonly truncated?: true | undefined;
}

/**
 * Walk the `cause` chain into a bounded, JSON-safe list. Losing the chain is
 * what turned seven distinct failures into one `details: {}`.
 */
function causeChain(error: unknown): readonly CauseLink[] {
  const chain: CauseLink[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);
    const record = isRecord(current) ? current : null;
    const message = current instanceof Error
      ? current.message
      : typeof current === "string"
        ? current
        : record === null
          ? String(current)
          : JSON.stringify(record);
    const bounded = boundedDetail(message);
    chain.push({
      name: typeof record?.name === "string" ? record.name : null,
      message: bounded.text,
      ...(bounded.truncated ? { truncated: true as const } : {}),
      ...(typeof record?.code === "string" || typeof record?.code === "number"
        ? { code: record.code }
        : {}),
    });
    current = record?.cause;
  }
  return chain;
}

/**
 * The durable `details` for a non-ForgeError. Carries the originating error's
 * identity and its cause chain; truncation is announced, never silent.
 */
function untypedErrorDetails(error: unknown): Readonly<Record<string, unknown>> {
  const record = isRecord(error) ? error : null;
  const chain = causeChain(error);
  const grpcCode = typeof record?.code === "number" ? record.code : null;
  const grpcDetails = typeof record?.details === "string" ? boundedDetail(record.details) : null;
  return {
    error_name: typeof record?.name === "string" ? record.name : null,
    error_code: typeof record?.code === "string" || typeof record?.code === "number" ? record.code : null,
    ...(grpcCode !== null && GRPC_STATUS[grpcCode] !== undefined
      ? { grpc_status: GRPC_STATUS[grpcCode]?.name }
      : {}),
    ...(grpcDetails === null
      ? {}
      : {
          transport_details: grpcDetails.text,
          ...(grpcDetails.truncated ? { transport_details_truncated: true } : {}),
        }),
    cause_chain: chain,
    ...(chain.length === MAX_CAUSE_DEPTH ? { cause_chain_truncated: true } : {}),
  };
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
    // A ForgeError already carries structured detail, but not its cause: the
    // chain is what identifies which kernel or transport fault produced it.
    const chain = causeChain(error.cause);
    return {
      kind,
      envelope: {
        code: error.code,
        category: error.category,
        message: boundedMessage(error.message),
        retryable: error.retryable,
        suggestedAction: error.suggestedAction,
        details: chain.length === 0
          ? error.details
          : {
              ...error.details,
              cause_chain: chain,
              ...(chain.length === MAX_CAUSE_DEPTH ? { cause_chain_truncated: true } : {}),
            },
      },
    };
  }
  const record = isRecord(error) ? error : null;
  const name = typeof record?.name === "string" ? record.name : null;
  const code = typeof record?.code === "string" ? record.code : null;
  // grpc-js failures carry a numeric status and no name; without this they all
  // classified as INTERNAL/unknown and lost their category.
  const grpc = typeof record?.code === "number" ? GRPC_STATUS[record.code] ?? null : null;
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
          : grpc !== null
            ? grpc.kind
            : "unknown";
  const message = error instanceof Error
    ? error.message
    : typeof error === "string" && error.length > 0
      ? error
      : "Loop operation failed with an untyped error";
  const category = kind === "policy_denied"
    ? "policy_denied"
    : kind === "budget_exhausted"
      ? "budget_exhausted"
      : kind === "cancelled"
        ? "cancelled"
        : grpc !== null
          ? grpc.category
          : kind === "provider"
            ? "provider"
            : "internal";
  return {
    kind,
    envelope: {
      code: code ?? grpc?.name ?? "INTERNAL",
      category,
      message: boundedMessage(message),
      retryable: grpc?.retryable ?? (kind === "provider"),
      suggestedAction: kind === "policy_denied"
        ? "request a policy exception or change the operation"
        : kind === "needs_user_input"
          ? "surface the pending decision to the user"
          : kind === "budget_exhausted"
            ? "reduce scope or increase the bounded budget"
            : kind === "provider"
              ? "retry with the same request only when the provider marks it retryable"
              : null,
      details: untypedErrorDetails(error),
    },
  };
}

export function operationErrorCode(error: unknown): string | null {
  return classifyLoopError(error).envelope.code;
}
