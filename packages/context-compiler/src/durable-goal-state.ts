/**
 * @terminus/context-compiler — Durable Goal/Progress State.
 *
 * Replaces mutable Markdown "scratchpad" authority files with durable,
 * contract-driven state that is always recoverable from checkpoints,
 * manifests, and evidence records.
 *
 * The five pillars of durable state:
 *  1. TaskContract — the immutable objective, acceptance criteria, scope, budget.
 *  2. Checkpoints — structured continuation state at defined triggers.
 *  3. ContextManifests — exact record of what every provider attempt received.
 *  4. EvidenceRecords — verification results, tool outputs, test runs.
 *  5. ScopeLedger — auditable record of all scope expansions and path access.
 *
 * No mutable Markdown file is the authority. The authority is the event
 * stream (task.created → turn. started → context.manifest_persisted →
 * tool.settled → checkpoint.created → task.completed).
 */

import type {
  Uuid7,
  ContentHash,
  Rfc3339Timestamp,
  ArtifactRef,
} from "@terminus/domain";
import type {
  TaskContract,
  Checkpoint,
  ContextManifest,
  VerificationResult,
  ScopeLedgerEntry,
  CompletionRecord,
} from "@terminus/domain";
import type { CheckpointContent } from "./checkpoint.js";

// ──────────────────────── Goal state snapshot ────────────────────────────────

/**
 * A point-in-time snapshot of all durable state for a task.
 * Reconstructible from the event stream at any point.
 *
 * This is the "how did we get here and what remains" view that
 * replaces the old mutable Markdown scratchpad.
 */
export interface GoalState {
  readonly taskId: Uuid7;
  readonly contract: TaskContract;
  readonly contractVersion: number;
  /** The latest checkpoint content. */
  readonly latestCheckpoint: CheckpointContent | null;
  /** The latest checkpoint aggregate (metadata, hash). */
  readonly latestCheckpointAggregate: Checkpoint | null;
  /** Sequence of checkpoints (oldest first). */
  readonly checkpointHistory: ReadonlyArray<{
    readonly aggregate: Checkpoint;
    readonly content: CheckpointContent;
  }>;
  /** Number of completed turns. */
  readonly completedTurns: number;
  /** Completed provider attempts with their manifest references. */
  readonly providerAttempts: ReadonlyArray<{
    readonly attemptId: Uuid7;
    readonly manifestId: Uuid7;
    readonly model: string;
    readonly status: string;
    readonly costMicros: bigint | null;
  }>;
  /** Active verification results. */
  readonly verificationResults: ReadonlyArray<{
    readonly nodeId: string;
    readonly status: string;
    readonly completedAt: Rfc3339Timestamp | null;
  }>;
  /** Scope ledger entries. */
  readonly scopeLedger: ReadonlyArray<{
    readonly kind: string;
    readonly path: string | null;
    readonly approvedBy: string | null;
  }>;
  /** Budget consumption. */
  readonly budgetConsumed: {
    readonly modelMicros: bigint;
    readonly computeSeconds: number;
    readonly wallClockSeconds: number;
    readonly approvalsUsed: number;
  };
  /** Remaining budget. */
  readonly budgetRemaining: {
    readonly modelMicros: bigint;
    readonly computeSeconds: number;
    readonly wallClockSeconds: number;
    readonly approvalsUsed: number;
  };
  /** Completion record, if task is completed. */
  readonly completion: CompletionRecord | null;
  /** Whether all required acceptance criteria are satisfied. */
  readonly allCriteriaSatisfied: boolean;
  /** Unresolved failures. */
  readonly unresolvedFailures: ReadonlyArray<{
    readonly description: string;
    readonly artifactHash: ContentHash | null;
  }>;
  /** Open questions. */
  readonly openQuestions: readonly string[];
}

// ──────────────────────── Reconstruct from events ────────────────────────────

export interface GoalStateReconstructionInput {
  readonly taskId: Uuid7;
  readonly contract: TaskContract;
  readonly checkpoints: ReadonlyArray<{
    readonly aggregate: Checkpoint;
    readonly content: CheckpointContent;
  }>;
  readonly manifestRefs: ReadonlyArray<{
    readonly attemptId: Uuid7;
    readonly manifestId: Uuid7;
    readonly model: string;
    readonly status: string;
    readonly costMicros: bigint | null;
  }>;
  readonly verificationResults: ReadonlyArray<{
    readonly nodeId: string;
    readonly status: string;
    readonly completedAt: Rfc3339Timestamp | null;
  }>;
  readonly scopeLedger: ReadonlyArray<{
    readonly kind: string;
    readonly path: string | null;
    readonly approvedBy: string | null;
  }>;
  readonly budgetConsumed: {
    readonly modelMicros: bigint;
    readonly computeSeconds: number;
    readonly wallClockSeconds: number;
    readonly approvalsUsed: number;
  };
  readonly completion: CompletionRecord | null;
  readonly completedTurns: number;
}

/**
 * Reconstruct the current goal state from the event stream.
 *
 * Pure function — the caller is responsible for reading the event stream
 * and passing in the reconstructed data.
 */
export function reconstructGoalState(
  input: GoalStateReconstructionInput,
): GoalState {
  const checkpoints = [...input.checkpoints];
  const latest = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1]! : null;

  const contract = input.contract;
  const budget = contract.budget;

  const budgetRemaining = {
    modelMicros: budget.modelMicros - input.budgetConsumed.modelMicros,
    computeSeconds: budget.computeSeconds - input.budgetConsumed.computeSeconds,
    wallClockSeconds: budget.wallClockSeconds - input.budgetConsumed.wallClockSeconds,
    approvalsUsed: budget.humanApprovals - input.budgetConsumed.approvalsUsed,
  };

  const allCriteriaSatisfied =
    latest !== null &&
    latest.content.requirements.every((r) => r.status === "satisfied");

  const unresolvedFailures =
    latest !== null
      ? latest.content.failures
          .filter((f) => !f.resolved)
          .map((f) => ({
            description: f.description,
            artifactHash: f.artifactHash,
          }))
      : [];

  const openQuestions = latest !== null ? [...latest.content.openQuestions] : [];

  return {
    taskId: input.taskId,
    contract,
    contractVersion: contract.version,
    latestCheckpoint: latest?.content ?? null,
    latestCheckpointAggregate: latest?.aggregate ?? null,
    checkpointHistory: checkpoints,
    completedTurns: input.completedTurns,
    providerAttempts: input.manifestRefs,
    verificationResults: input.verificationResults,
    scopeLedger: input.scopeLedger,
    budgetConsumed: input.budgetConsumed,
    budgetRemaining,
    completion: input.completion,
    allCriteriaSatisfied,
    unresolvedFailures,
    openQuestions,
  };
}

// ──────────────────────── Progress summary ───────────────────────────────────

/**
 * Generate a Markdown-format progress summary from the goal state.
 * This is suitable for display in a UI or CLI, but it is NOT the
 * authority — it is derived from the authoritative goal state.
 */
export function formatProgressSummary(state: GoalState): string {
  const lines: string[] = [];

  lines.push(`# Task Progress: ${state.contract.objective}`);
  lines.push("");
  lines.push("## Status");
  lines.push(`- Completed turns: ${state.completedTurns}`);
  lines.push(`- Provider attempts: ${state.providerAttempts.length}`);
  lines.push(`- Checkpoints: ${state.checkpointHistory.length}`);
  lines.push(`- All criteria satisfied: ${state.allCriteriaSatisfied ? "yes" : "no"}`);
  lines.push("");

  if (state.latestCheckpoint !== null) {
    const cp = state.latestCheckpoint;
    lines.push("## Latest Checkpoint");
    lines.push(`- Completed steps: ${cp.completedSteps.length}`);
    lines.push(`- Pending steps: ${cp.pendingSteps.length}`);
    lines.push(`- Requirements: ${cp.requirements.length} (${cp.requirements.filter((r) => r.status === "satisfied").length} satisfied)`);
    lines.push(`- Open questions: ${cp.openQuestions.length}`);
    lines.push(`- Unresolved failures: ${state.unresolvedFailures.length}`);
    lines.push("");
  }

  lines.push("## Budget");
  lines.push(`- Model micros: ${state.budgetConsumed.modelMicros} / ${state.contract.budget.modelMicros} (${state.budgetRemaining.modelMicros} remaining)`);
  lines.push(`- Compute seconds: ${state.budgetConsumed.computeSeconds} / ${state.contract.budget.computeSeconds}`);
  lines.push(`- Wall clock seconds: ${state.budgetConsumed.wallClockSeconds} / ${state.contract.budget.wallClockSeconds}`);
  lines.push(`- Approvals: ${state.budgetConsumed.approvalsUsed} / ${state.contract.budget.humanApprovals}`);
  lines.push("");

  if (state.latestCheckpoint !== null && state.latestCheckpoint.completedSteps.length > 0) {
    lines.push("## Completed Steps");
    for (const step of state.latestCheckpoint.completedSteps) {
      lines.push(`- ${step.description}`);
    }
    lines.push("");
  }

  if (state.latestCheckpoint !== null && state.latestCheckpoint.pendingSteps.length > 0) {
    lines.push("## Pending");
    for (const step of state.latestCheckpoint.pendingSteps) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }

  if (state.openQuestions.length > 0) {
    lines.push("## Open Questions");
    for (const q of state.openQuestions) {
      lines.push(`- ${q}`);
    }
    lines.push("");
  }

  if (state.unresolvedFailures.length > 0) {
    lines.push("## Unresolved Failures");
    for (const f of state.unresolvedFailures) {
      lines.push(`- ${f.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ──────────────────────── Goal state diff ────────────────────────────────────

export interface GoalStateDiff {
  readonly completedStepsAdded: readonly string[];
  readonly pendingStepsRemoved: readonly string[];
  readonly pendingStepsAdded: readonly string[];
  readonly requirementsChanged: ReadonlyArray<{
    readonly id: string;
    readonly before: string;
    readonly after: string;
  }>;
  readonly newFailures: readonly string[];
  readonly resolvedFailures: readonly string[];
  readonly newQuestions: readonly string[];
  readonly answeredQuestions: readonly string[];
  readonly budgetDelta: {
    readonly modelMicros: bigint;
    readonly computeSeconds: number;
    readonly wallClockSeconds: number;
    readonly approvalsUsed: number;
  };
}

/**
 * Compute a diff between two goal states (before → after).
 * Useful for showing progress between turns or checkpoints.
 */
export function diffGoalStates(
  before: GoalState,
  after: GoalState,
): GoalStateDiff {
  const beforeCp = before.latestCheckpoint;
  const afterCp = after.latestCheckpoint;

  const beforeCompleted = new Set(
    beforeCp?.completedSteps.map((s) => s.description) ?? [],
  );
  const afterCompleted = new Set(
    afterCp?.completedSteps.map((s) => s.description) ?? [],
  );

  const beforePending = new Set(beforeCp?.pendingSteps ?? []);
  const afterPending = new Set(afterCp?.pendingSteps ?? []);

  const beforeReqs = new Map(
    beforeCp?.requirements.map((r) => [r.id, r.status]) ?? [],
  );
  const afterReqs = new Map(
    afterCp?.requirements.map((r) => [r.id, r.status]) ?? [],
  );

  const beforeFailures = new Set(
    beforeCp?.failures.filter((f) => !f.resolved).map((f) => f.description) ?? [],
  );
  const afterFailures = new Set(
    afterCp?.failures.filter((f) => !f.resolved).map((f) => f.description) ?? [],
  );

  const beforeQuestions = new Set(beforeCp?.openQuestions ?? []);
  const afterQuestions = new Set(afterCp?.openQuestions ?? []);

  const requirementsChanged: Array<{ readonly id: string; readonly before: string; readonly after: string }> = [];
  for (const [id, afterStatus] of afterReqs) {
    const beforeStatus = beforeReqs.get(id);
    if (beforeStatus !== undefined && beforeStatus !== afterStatus) {
      requirementsChanged[requirementsChanged.length] = {
        id,
        before: beforeStatus,
        after: afterStatus,
      };
    }
  }

  return {
    completedStepsAdded: [...afterCompleted].filter((s) => !beforeCompleted.has(s)),
    pendingStepsRemoved: [...beforePending].filter((s) => !afterPending.has(s)),
    pendingStepsAdded: [...afterPending].filter((s) => !beforePending.has(s)),
    requirementsChanged,
    newFailures: [...afterFailures].filter((f) => !beforeFailures.has(f)),
    resolvedFailures: [...beforeFailures].filter((f) => !afterFailures.has(f)),
    newQuestions: [...afterQuestions].filter((q) => !beforeQuestions.has(q)),
    answeredQuestions: [...beforeQuestions].filter((q) => !afterQuestions.has(q)),
    budgetDelta: {
      modelMicros:
        after.budgetConsumed.modelMicros - before.budgetConsumed.modelMicros,
      computeSeconds:
        after.budgetConsumed.computeSeconds - before.budgetConsumed.computeSeconds,
      wallClockSeconds:
        after.budgetConsumed.wallClockSeconds -
        before.budgetConsumed.wallClockSeconds,
      approvalsUsed:
        after.budgetConsumed.approvalsUsed - before.budgetConsumed.approvalsUsed,
    },
  };
}
