/** Shared scheduler config types — no runtime deps on the Scheduler class. */

export interface SchedulerConfig {
  readonly spawnThreshold: number;
  readonly requirePositiveExpectedValue: boolean;
  readonly maxParallel: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  spawnThreshold: 0.1,
  requirePositiveExpectedValue: true,
  maxParallel: 2,
};
