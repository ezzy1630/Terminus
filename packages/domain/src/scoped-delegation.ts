/**
 * Durable, provider-neutral state for a delegated worker execution.
 *
 * The record is deliberately a compact control-plane record. Worker output
 * is admitted only as trusted evidence references; the record never stores a
 * provider transcript or an unbounded report.
 */
import { z } from "zod";
import {
  contentHashSchema,
  rfc3339Schema,
} from "./ids.js";
import {
  artifactRefSchema,
  delegationContractV2Schema,
} from "./aggregates.js";

const nonEmptyString = z.string().trim().min(1);

export const scopedDelegationStateSchema = z.enum([
  "PENDING",
  "ADMITTED",
  "RUNNING",
  "INTERRUPTED",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
  "MANUAL_REVIEW",
]);

export type ScopedDelegationState = z.infer<typeof scopedDelegationStateSchema>;

export const scopedDelegationClaimSchema = z
  .object({
    claimId: nonEmptyString,
    status: z.enum(["satisfied", "unresolved"]),
    evidenceRefs: z.array(artifactRefSchema).max(32),
  })
  .strict();

export type ScopedDelegationClaim = z.infer<typeof scopedDelegationClaimSchema>;

export const scopedDelegationTestEvidenceSchema = z
  .object({
    testId: nonEmptyString,
    status: z.enum(["passed", "failed", "not_run"]),
    summary: nonEmptyString.max(1000),
    evidenceRef: artifactRefSchema.nullable(),
  })
  .strict();

export type ScopedDelegationTestEvidence = z.infer<typeof scopedDelegationTestEvidenceSchema>;

/**
 * A bounded result projection. `continuationToken` points to the durable
 * artifact containing additional evidence when `truncated` is true.
 */
export const scopedDelegationEvidenceReturnSchema = z
  .object({
    status: z.enum(["completed", "blocked", "failed", "budget_exhausted", "policy_denied"]),
    summary: nonEmptyString.max(4000),
    sourceRevision: nonEmptyString,
    environmentImageDigest: contentHashSchema,
    claims: z.array(scopedDelegationClaimSchema).max(64),
    artifacts: z.array(artifactRefSchema).max(64),
    changedFiles: z.array(nonEmptyString).max(256),
    tests: z.array(scopedDelegationTestEvidenceSchema).max(64),
    continuationToken: nonEmptyString.nullable(),
    truncated: z.boolean(),
    nextAction: z.enum(["none", "continue", "reconcile", "manual_review"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.truncated && value.continuationToken === null) {
      context.addIssue({
        code: "custom",
        path: ["continuationToken"],
        message: "truncated evidence must expose a continuation token",
      });
    }
    if (!value.truncated && value.continuationToken !== null) {
      context.addIssue({
        code: "custom",
        path: ["continuationToken"],
        message: "a continuation token requires truncated evidence",
      });
    }
  });

export type ScopedDelegationEvidenceReturn = z.infer<typeof scopedDelegationEvidenceReturnSchema>;

export const scopedDelegationRecoverySchema = z
  .object({
    restartCount: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    lastRecoveredAt: rfc3339Schema.nullable(),
    reason: nonEmptyString.nullable(),
    nextAction: z.enum(["resume", "reconcile", "manual_review"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.restartCount > value.maxAttempts) {
      context.addIssue({
        code: "custom",
        path: ["restartCount"],
        message: "restart count cannot exceed the bounded recovery attempts",
      });
    }
  });

export type ScopedDelegationRecovery = z.infer<typeof scopedDelegationRecoverySchema>;

export const scopedDelegationExecutionSchema = z
  .object({
    id: nonEmptyString,
    taskId: nonEmptyString,
    parentTurnId: nonEmptyString,
    contract: delegationContractV2Schema,
    contractHash: contentHashSchema,
    requestHash: contentHashSchema,
    idempotencyKey: nonEmptyString,
    workerId: nonEmptyString.nullable(),
    leaseId: nonEmptyString.nullable(),
    fencingToken: z.number().int().positive().nullable(),
    attempt: z.number().int().positive(),
    state: scopedDelegationStateSchema,
    result: scopedDelegationEvidenceReturnSchema.nullable(),
    lastReceiptArtifact: artifactRefSchema.nullable(),
    lastOperationHash: contentHashSchema.nullable(),
    recovery: scopedDelegationRecoverySchema,
    version: z.number().int().nonnegative(),
    createdAt: rfc3339Schema,
    updatedAt: rfc3339Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.contract.parentTaskId !== value.taskId) {
      context.addIssue({
        code: "custom",
        path: ["contract", "parentTaskId"],
        message: "delegation contract must bind to the execution task",
      });
    }

    const leaseFields = [value.workerId, value.leaseId, value.fencingToken];
    const hasLease = leaseFields.some((field) => field !== null);
    const hasCompleteLease = leaseFields.every((field) => field !== null);
    if (hasLease && !hasCompleteLease) {
      context.addIssue({
        code: "custom",
        path: ["fencingToken"],
        message: "worker, lease, and fencing token must be bound together",
      });
    }
    if (value.state === "RUNNING" && !hasCompleteLease) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "running execution requires a leased worker and fencing token",
      });
    }
  });

export type ScopedDelegationExecution = z.infer<typeof scopedDelegationExecutionSchema>;

export const SCOPED_DELEGATION_TRANSITIONS: Readonly<
  Record<ScopedDelegationState, readonly ScopedDelegationState[]>
> = {
  PENDING: ["ADMITTED", "BLOCKED", "CANCELLED", "MANUAL_REVIEW"],
  ADMITTED: ["RUNNING", "SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED", "MANUAL_REVIEW"],
  RUNNING: ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED", "MANUAL_REVIEW"],
  INTERRUPTED: ["ADMITTED", "RUNNING", "CANCELLED", "MANUAL_REVIEW"],
  SUCCEEDED: [],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: [],
  MANUAL_REVIEW: [],
};

export function isScopedDelegationTransitionAllowed(
  from: ScopedDelegationState,
  to: ScopedDelegationState,
): boolean {
  return SCOPED_DELEGATION_TRANSITIONS[from].includes(to);
}
