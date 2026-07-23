/**
 * One-agent / scout / writer / reviewer ablations (§41.10, §48.11 task 15).
 * Pure experiment definitions for the eval harness.
 */
export type AblationDimension =
  | "one_agent"
  | "scout"
  | "writer"
  | "reviewer"
  | "parallel_writers";

export interface OrchestrationAblation {
  readonly ablationId: string;
  readonly dimension: AblationDimension;
  readonly description: string;
  readonly baseline: string;
  readonly candidate: string;
  readonly targetCohort: string;
  /** +1 help, -1 should not help, 0 neutral. */
  readonly predictedDirection: -1 | 0 | 1;
}

export const ORCHESTRATION_ABLATIONS: readonly OrchestrationAblation[] = Object.freeze([
  {
    ablationId: "orch_one_vs_scout",
    dimension: "scout",
    description: "One agent vs read-only scout",
    baseline: "one_agent",
    candidate: "scout+coordinator",
    targetCohort: "unfamiliar_repository",
    predictedDirection: 1,
  },
  {
    ablationId: "orch_one_vs_writer",
    dimension: "writer",
    description: "One agent vs managed writer worktree",
    baseline: "one_agent",
    candidate: "writer_worktree",
    targetCohort: "parallelizable",
    predictedDirection: 1,
  },
  {
    ablationId: "orch_one_vs_reviewer",
    dimension: "reviewer",
    description: "One agent vs detached reviewer triggers",
    baseline: "one_agent",
    candidate: "detached_reviewer",
    targetCohort: "security_sensitive",
    predictedDirection: 1,
  },
  {
    ablationId: "orch_one_vs_parallel_writers",
    dimension: "parallel_writers",
    description: "One agent vs parallel writers on separable tasks",
    baseline: "one_agent",
    candidate: "parallel_writers",
    targetCohort: "parallelizable",
    predictedDirection: 1,
  },
  {
    ablationId: "orch_parallel_on_tight_coupling",
    dimension: "parallel_writers",
    description: "Parallel writers on tightly-coupled work (should not help)",
    baseline: "one_agent",
    candidate: "parallel_writers",
    targetCohort: "tightly_coupled",
    predictedDirection: -1,
  },
]);

export function ablationById(id: string): OrchestrationAblation | null {
  return ORCHESTRATION_ABLATIONS.find((a) => a.ablationId === id) ?? null;
}

export function ablationsForDimension(
  dimension: AblationDimension,
): readonly OrchestrationAblation[] {
  return ORCHESTRATION_ABLATIONS.filter((a) => a.dimension === dimension);
}
