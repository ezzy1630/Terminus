/**
 * Path-disjoint worktree delegation plans.
 *
 * This package can describe and validate a writer plan, but it does not own a
 * kernel worktree executor. Every returned plan is therefore non-executable
 * until the `terminus.kernel.v1` boundary accepts it.
 */
import { delegationContractV2Schema, ValidationError } from "@terminus/domain";
import type { DelegationContractV2 } from "@terminus/domain";

export interface ActiveWorktreePathLease {
  readonly id: string;
  readonly ownedPathPrefixes: readonly string[];
  readonly status?: "active" | "merging" | "merged" | "abandoned" | "conflict";
}

export interface PathConflict {
  readonly requestedPath: string;
  readonly existingLeaseId: string;
  readonly existingPath: string;
}

export interface PathDisjointValidation {
  readonly valid: boolean;
  readonly normalizedRequestedPaths: readonly string[];
  readonly conflicts: readonly PathConflict[];
  readonly errors: readonly string[];
}

export interface PathDisjointWorktreeRequest {
  readonly baseRevision: string;
  readonly requestedPathPrefixes: readonly string[];
  readonly activeLeases: readonly ActiveWorktreePathLease[];
}

export interface PathDisjointWorktreeMetadata {
  readonly isolation: "path_disjoint_worktree";
  readonly baseRevision: string;
  readonly requestedPathPrefixes: readonly string[];
  readonly conflictingLeaseIds: readonly string[];
  readonly disjoint: boolean;
  readonly worktreePath: null;
  readonly executorBoundary: "terminus.kernel.v1";
  readonly executorAvailable: false;
}

export interface WorktreeDelegationPlan {
  readonly delegationId: string;
  readonly parentTaskId: string;
  readonly contract: DelegationContractV2;
  readonly metadata: PathDisjointWorktreeMetadata;
  readonly validation: PathDisjointValidation;
  readonly status: "blocked_validation" | "blocked_executor_unavailable";
  readonly canExecute: false;
  readonly blockedReason:
    | "path_disjointness_validation_failed"
    | "kernel_worktree_executor_unavailable";
}

/** True when two normalized path prefixes can address the same path. */
export function pathPrefixesOverlap(left: string, right: string): boolean {
  if (left === "" || right === "") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Validate path leases without touching Git. The validation is deliberately
 * stricter than a glob check: a writer must have non-empty, relative,
 * non-overlapping prefixes and no active writer may own an overlapping path.
 */
export function validatePathDisjointWorktree(
  input: PathDisjointWorktreeRequest,
): PathDisjointValidation {
  const errors: string[] = [];
  const conflicts: PathConflict[] = [];
  const normalizedRequestedPaths: string[] = [];

  if (input.baseRevision.trim().length === 0) {
    errors.push("exact base revision is required");
  }
  if (input.requestedPathPrefixes.length === 0) {
    errors.push("at least one owned path prefix is required");
  }

  for (const rawPath of input.requestedPathPrefixes) {
    const normalized = normalizePathPrefix(rawPath);
    if (normalized === null || normalized === "") {
      errors.push(`invalid writer path prefix '${rawPath}'`);
      continue;
    }
    normalizedRequestedPaths.push(normalized);
  }

  const uniquePaths = [...new Set(normalizedRequestedPaths)];
  if (uniquePaths.length !== normalizedRequestedPaths.length) {
    errors.push("writer path prefixes must be unique");
  }
  for (let i = 0; i < uniquePaths.length; i += 1) {
    for (let j = i + 1; j < uniquePaths.length; j += 1) {
      if (pathPrefixesOverlap(uniquePaths[i]!, uniquePaths[j]!)) {
        errors.push(
          `writer path prefixes overlap: '${uniquePaths[i]}' and '${uniquePaths[j]}'`,
        );
      }
    }
  }

  for (const lease of input.activeLeases) {
    if (lease.id.trim().length === 0) {
      errors.push("active worktree lease id must not be blank");
      continue;
    }
    if (lease.status !== undefined && lease.status !== "active" && lease.status !== "merging") {
      continue;
    }
    for (const requestedPath of uniquePaths) {
      for (const rawExistingPath of lease.ownedPathPrefixes) {
        const existingPath = normalizePathPrefix(rawExistingPath);
        if (existingPath === null) {
          errors.push(`invalid existing lease path prefix '${rawExistingPath}'`);
          continue;
        }
        if (pathPrefixesOverlap(requestedPath, existingPath)) {
          conflicts.push({
            requestedPath,
            existingLeaseId: lease.id,
            existingPath,
          });
        }
      }
    }
  }

  if (conflicts.length > 0) {
    errors.push("requested writer paths overlap an active worktree lease");
  }

  return {
    valid: errors.length === 0,
    normalizedRequestedPaths: uniquePaths,
    conflicts,
    errors,
  };
}

/** Throwing form for callers that cannot continue after a path violation. */
export function assertPathDisjointWorktree(
  input: PathDisjointWorktreeRequest,
): void {
  const validation = validatePathDisjointWorktree(input);
  if (!validation.valid) {
    throw new ValidationError("path-disjoint worktree validation failed", {
      errors: validation.errors,
      conflicts: validation.conflicts,
    });
  }
}

/**
 * Build a typed writer plan. The plan records all metadata needed by the
 * kernel, but deliberately has no execution method and always fails closed.
 */
export function planWorktreeDelegation(input: {
  readonly contract: DelegationContractV2;
  readonly worktree: PathDisjointWorktreeRequest;
}): WorktreeDelegationPlan {
  const validation = validatePathDisjointWorktree(input.worktree);
  const errors = [...validation.errors];
  const parsedContract = delegationContractV2Schema.safeParse(input.contract);
  if (!parsedContract.success) {
    errors.push("delegation contract failed schema validation");
  }
  if (input.contract.writeIsolation !== "worktree") {
    errors.push("writer plan requires worktree write isolation");
  }
  if (input.contract.role !== "implementer" && input.contract.role !== "specialist") {
    errors.push("writer plan requires an implementer or specialist role");
  }
  for (const requestedPath of validation.normalizedRequestedPaths) {
    if (!contractAllowsPath(input.contract.authorityCeiling.allowedPaths, requestedPath)) {
      errors.push(`contract does not authorize writer path '${requestedPath}'`);
    }
  }

  const finalValidation: PathDisjointValidation = {
    ...validation,
    valid: errors.length === 0,
    errors,
  };
  const blockedByValidation = !finalValidation.valid;
  return {
    delegationId: input.contract.id,
    parentTaskId: input.contract.parentTaskId,
    contract: input.contract,
    metadata: {
      isolation: "path_disjoint_worktree",
      baseRevision: input.worktree.baseRevision,
      requestedPathPrefixes: finalValidation.normalizedRequestedPaths,
      conflictingLeaseIds: [...new Set(finalValidation.conflicts.map((conflict) => conflict.existingLeaseId))],
      disjoint: validation.valid,
      worktreePath: null,
      executorBoundary: "terminus.kernel.v1",
      executorAvailable: false,
    },
    validation: finalValidation,
    status: blockedByValidation ? "blocked_validation" : "blocked_executor_unavailable",
    canExecute: false,
    blockedReason: blockedByValidation
      ? "path_disjointness_validation_failed"
      : "kernel_worktree_executor_unavailable",
  };
}

function normalizePathPrefix(rawPath: string): string | null {
  const raw = rawPath.trim().replaceAll("\\", "/");
  if (raw.length === 0 || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return null;
  const withoutGlob = raw.endsWith("/**") ? raw.slice(0, -3) : raw;
  if (withoutGlob.includes("*") || withoutGlob.includes("?")) return null;
  const segments = withoutGlob.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === ".." || segment.includes("\0"))) return null;
  return segments.join("/");
}

function contractAllowsPath(allowedPaths: readonly string[], requestedPath: string): boolean {
  return allowedPaths.some((rawAllowedPath) => {
    const allowedPath = normalizePathPrefix(rawAllowedPath);
    return allowedPath !== null && (allowedPath === "" || requestedPath === allowedPath || requestedPath.startsWith(`${allowedPath}/`));
  });
}
