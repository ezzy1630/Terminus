/**
 * Cohort-tuned scheduler thresholds (§37.5, §48.11 task 16).
 * Deterministic: same cohort + signals → same decision.
 */
import type { RiskClass } from "@terminus/domain";
import type { SchedulerConfig } from "./scheduler-types.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./scheduler-types.js";

export type TaskCohort =
  | "tiny_bugfix"
  | "parallelizable"
  | "tightly_coupled"
  | "unfamiliar_repository"
  | "security_sensitive"
  | "refactor"
  | "default";

export const COHORT_SCHEDULER_CONFIG: Readonly<Record<TaskCohort, SchedulerConfig>> = {
  tiny_bugfix: {
    spawnThreshold: 0.35,
    requirePositiveExpectedValue: true,
    maxParallel: 1,
  },
  parallelizable: {
    spawnThreshold: 0.05,
    requirePositiveExpectedValue: true,
    maxParallel: 4,
  },
  tightly_coupled: {
    spawnThreshold: 0.5,
    requirePositiveExpectedValue: true,
    maxParallel: 1,
  },
  unfamiliar_repository: {
    spawnThreshold: 0.08,
    requirePositiveExpectedValue: true,
    maxParallel: 2,
  },
  security_sensitive: {
    spawnThreshold: 0.4,
    requirePositiveExpectedValue: true,
    maxParallel: 1,
  },
  refactor: {
    spawnThreshold: 0.12,
    requirePositiveExpectedValue: true,
    maxParallel: 2,
  },
  default: DEFAULT_SCHEDULER_CONFIG,
};

/**
 * Infer cohort from coarse signals when the caller has not labeled the task.
 */
export function inferCohort(signals: {
  readonly separability: number;
  readonly likelyFileOverlap: number;
  readonly riskClass: RiskClass;
  readonly unfamiliarRepo: boolean;
}): TaskCohort {
  if (signals.riskClass === "high" || signals.riskClass === "critical") {
    return "security_sensitive";
  }
  if (signals.unfamiliarRepo) return "unfamiliar_repository";
  if (signals.separability >= 0.7 && signals.likelyFileOverlap <= 0.25) {
    return "parallelizable";
  }
  if (signals.separability <= 0.3 || signals.likelyFileOverlap >= 0.7) {
    return "tightly_coupled";
  }
  return "default";
}

export function expectsParallelism(cohort: TaskCohort): boolean {
  return cohort === "parallelizable" || cohort === "unfamiliar_repository";
}

export function expectsSingleAgent(cohort: TaskCohort): boolean {
  return (
    cohort === "tightly_coupled" ||
    cohort === "tiny_bugfix" ||
    cohort === "security_sensitive"
  );
}
