/**
 * @terminus/domain — canonical error classes.
 *
 * Per SPEC §30.4 and §44.5: errors include stable code, category, retryability,
 * suggested action, trace ID, structured details.
 */
import { z } from "zod";
import type { TraceId } from "./ids.js";

export const ErrorCategory = {
  VALIDATION: "validation",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  PERMISSION: "permission",
  POLICY_DENIED: "policy_denied",
  APPROVAL_REQUIRED: "approval_required",
  SANDBOX_UNAVAILABLE: "sandbox_unavailable",
  RESOURCE_EXHAUSTED: "resource_exhausted",
  BUDGET_EXHAUSTED: "budget_exhausted",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
  PROVIDER: "provider",
  EXTERNAL_DEPENDENCY: "external_dependency",
  INTEGRITY: "integrity",
  INTERNAL: "internal",
  UNKNOWN_SETTLEMENT: "unknown_settlement",
} as const;
export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];
export const errorCategorySchema = z.enum([
  "validation",
  "not_found",
  "conflict",
  "permission",
  "policy_denied",
  "approval_required",
  "sandbox_unavailable",
  "resource_exhausted",
  "budget_exhausted",
  "timeout",
  "cancelled",
  "provider",
  "external_dependency",
  "integrity",
  "internal",
  "unknown_settlement",
]);

export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  STALE_SOURCE_VERSION: "STALE_SOURCE_VERSION",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  POLICY_DENIED: "POLICY_DENIED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  SANDBOX_UNAVAILABLE: "SANDBOX_UNAVAILABLE",
  RESOURCE_EXHAUSTED: "RESOURCE_EXHAUSTED",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_RESPONSE_INVALID: "PROVIDER_RESPONSE_INVALID",
  EXTERNAL_DEPENDENCY_FAILED: "EXTERNAL_DEPENDENCY_FAILED",
  INTEGRITY_VIOLATION: "INTEGRITY_VIOLATION",
  IDEMPOTENCY_KEY_CONFLICT: "IDEMPOTENCY_KEY_CONFLICT",
  CURSOR_EXPIRED: "CURSOR_EXPIRED",
  UNKNOWN_SETTLEMENT: "UNKNOWN_SETTLEMENT",
  STATE_TRANSITION_INVALID: "STATE_TRANSITION_INVALID",
  SCOPE_VIOLATION: "SCOPE_VIOLATION",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
export const errorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "STALE_SOURCE_VERSION",
  "PERMISSION_DENIED",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "SANDBOX_UNAVAILABLE",
  "RESOURCE_EXHAUSTED",
  "BUDGET_EXHAUSTED",
  "TIMEOUT",
  "CANCELLED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_RESPONSE_INVALID",
  "EXTERNAL_DEPENDENCY_FAILED",
  "INTEGRITY_VIOLATION",
  "IDEMPOTENCY_KEY_CONFLICT",
  "CURSOR_EXPIRED",
  "UNKNOWN_SETTLEMENT",
  "STATE_TRANSITION_INVALID",
  "SCOPE_VIOLATION",
  "INTERNAL",
]);

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    category: errorCategorySchema,
    details: z.record(z.string(), z.unknown()).default({}),
    suggested_action: z.string().nullable().default(null),
    trace_id: z.string().nullable().default(null),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** Mapping of error codes to their categories. */
export const CODE_CATEGORY: Readonly<Record<ErrorCode, ErrorCategory>> = {
  VALIDATION_FAILED: "validation",
  NOT_FOUND: "not_found",
  ALREADY_EXISTS: "conflict",
  STALE_SOURCE_VERSION: "conflict",
  PERMISSION_DENIED: "permission",
  POLICY_DENIED: "policy_denied",
  APPROVAL_REQUIRED: "approval_required",
  SANDBOX_UNAVAILABLE: "sandbox_unavailable",
  RESOURCE_EXHAUSTED: "resource_exhausted",
  BUDGET_EXHAUSTED: "budget_exhausted",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
  PROVIDER_UNAVAILABLE: "provider",
  PROVIDER_RATE_LIMITED: "provider",
  PROVIDER_RESPONSE_INVALID: "provider",
  EXTERNAL_DEPENDENCY_FAILED: "external_dependency",
  INTEGRITY_VIOLATION: "integrity",
  IDEMPOTENCY_KEY_CONFLICT: "conflict",
  CURSOR_EXPIRED: "conflict",
  UNKNOWN_SETTLEMENT: "unknown_settlement",
  STATE_TRANSITION_INVALID: "validation",
  SCOPE_VIOLATION: "policy_denied",
  INTERNAL: "internal",
} as const;

/** Retryable categories by default. */
export const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "EXTERNAL_DEPENDENCY_FAILED",
  "SANDBOX_UNAVAILABLE",
  "RESOURCE_EXHAUSTED",
]);

/**
 * Base class for all Terminus domain errors. Carries a stable code, category,
 * retryability, structured details, a suggested recovery action, and a trace id.
 */
export class ForgeError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  readonly suggestedAction: string | null;
  readonly traceId: TraceId | null;
  override readonly cause: unknown;

  constructor(params: {
    code: ErrorCode;
    message: string;
    retryable?: boolean | undefined;
    details?: Record<string, unknown> | undefined;
    suggestedAction?: string | null | undefined;
    traceId?: TraceId | null | undefined;
    cause?: unknown | undefined;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "ForgeError";
    this.code = params.code;
    this.category = CODE_CATEGORY[params.code];
    this.retryable = params.retryable ?? RETRYABLE_BY_DEFAULT.has(params.code);
    this.details = Object.freeze({ ...(params.details ?? {}) });
    this.suggestedAction = params.suggestedAction ?? null;
    this.traceId = params.traceId ?? null;
    this.cause = params.cause;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        category: this.category,
        details: { ...this.details },
        suggested_action: this.suggestedAction,
        trace_id: this.traceId,
      },
    };
  }
}

export class ValidationError extends ForgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "VALIDATION_FAILED", message, details });
    this.name = "ValidationError";
  }
}

export class NotFoundError extends ForgeError {
  constructor(resource: string, id: string) {
    super({
      code: "NOT_FOUND",
      message: `${resource} not found: ${id}`,
      details: { resource, id },
      suggestedAction: "Check the identifier and try again.",
    });
    this.name = "NotFoundError";
  }
}

export class ConflictError extends ForgeError {
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super({ code, message, details });
    this.name = "ConflictError";
  }
}

export class StaleSourceVersionError extends ForgeError {
  constructor(path: string, expected: string, actual: string) {
    super({
      code: "STALE_SOURCE_VERSION",
      message: `${path} changed after it was observed.`,
      retryable: true,
      details: { path, expected, actual },
      suggestedAction: "Re-read the affected symbol and retry the patch.",
    });
    this.name = "StaleSourceVersionError";
  }
}

export class PermissionError extends ForgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "PERMISSION_DENIED", message, details });
    this.name = "PermissionError";
  }
}

export class PolicyDeniedError extends ForgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "POLICY_DENIED",
      message,
      details,
      suggestedAction: "Request a policy exception or change the operation.",
    });
    this.name = "PolicyDeniedError";
  }
}

export class ApprovalRequiredError extends ForgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "APPROVAL_REQUIRED",
      message,
      details,
      suggestedAction: "Surface the approval request to the user.",
    });
    this.name = "ApprovalRequiredError";
  }
}

export class SandboxUnavailableError extends ForgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "SANDBOX_UNAVAILABLE", message, details });
    this.name = "SandboxUnavailableError";
  }
}

export class ResourceExhaustedError extends ForgeError {
  constructor(resource: string, details?: Record<string, unknown>) {
    super({
      code: "RESOURCE_EXHAUSTED",
      message: `${resource} exhausted`,
      details,
    });
    this.name = "ResourceExhaustedError";
  }
}

export class BudgetExhaustedError extends ForgeError {
  constructor(scope: string, details?: Record<string, unknown>) {
    super({
      code: "BUDGET_EXHAUSTED",
      message: `${scope} budget exhausted`,
      details,
    });
    this.name = "BudgetExhaustedError";
  }
}

export class TimeoutError extends ForgeError {
  constructor(operation: string, timeoutMs: number) {
    super({
      code: "TIMEOUT",
      message: `${operation} timed out after ${timeoutMs} ms`,
      details: { operation, timeoutMs },
    });
    this.name = "TimeoutError";
  }
}

export class CancelledError extends ForgeError {
  constructor(operation: string) {
    super({ code: "CANCELLED", message: `${operation} cancelled` });
    this.name = "CancelledError";
  }
}

export class ProviderError extends ForgeError {
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super({ code, message, details });
    this.name = "ProviderError";
  }
}

export class ExternalDependencyError extends ForgeError {
  constructor(dependency: string, message: string, details?: Record<string, unknown>) {
    super({
      code: "EXTERNAL_DEPENDENCY_FAILED",
      message: `${dependency}: ${message}`,
      details: { dependency, ...details },
    });
    this.name = "ExternalDependencyError";
  }
}

export class IntegrityError extends ForgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "INTEGRITY_VIOLATION",
      message,
      details,
      suggestedAction: "Investigate data corruption or tampering.",
    });
    this.name = "IntegrityError";
  }
}

export class IdempotencyConflictError extends ForgeError {
  constructor(key: string) {
    super({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      message: `Idempotency key reused with a different request: ${key}`,
      details: { key },
    });
    this.name = "IdempotencyConflictError";
  }
}

export class CursorExpiredError extends ForgeError {
  constructor(cursor: string) {
    super({
      code: "CURSOR_EXPIRED",
      message: `Event cursor expired: ${cursor}`,
      details: { cursor },
      suggestedAction: "Resynchronize from the resource snapshot endpoint.",
    });
    this.name = "CursorExpiredError";
  }
}

export class UnknownSettlementError extends ForgeError {
  constructor(operation: string, details?: Record<string, unknown>) {
    super({
      code: "UNKNOWN_SETTLEMENT",
      message: `Operation settlement is unknown: ${operation}`,
      details,
      suggestedAction: "Run reconciliation before retrying.",
    });
    this.name = "UnknownSettlementError";
  }
}

export class StateTransitionError extends ForgeError {
  constructor(aggregate: string, from: string, to: string) {
    super({
      code: "STATE_TRANSITION_INVALID",
      message: `Invalid ${aggregate} transition: ${from} -> ${to}`,
      details: { aggregate, from, to },
    });
    this.name = "StateTransitionError";
  }
}

export class ScopeViolationError extends ForgeError {
  constructor(path: string, scope: string) {
    super({
      code: "SCOPE_VIOLATION",
      message: `Effect outside allowed scope: ${path} (scope: ${scope})`,
      details: { path, scope },
    });
    this.name = "ScopeViolationError";
  }
}

export class InternalError extends ForgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "INTERNAL", message, details });
    this.name = "InternalError";
  }
}

/**
 * Narrows an unknown caught value into a ForgeError if possible. Useful with
 * `useUnknownInCatchVariables`.
 */
export function asForgeError(err: unknown): ForgeError {
  if (err instanceof ForgeError) return err;
  if (err instanceof Error) {
    return new InternalError(err.message, { cause: err });
  }
  return new InternalError(String(err));
}
