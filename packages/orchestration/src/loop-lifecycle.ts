/**
 * Connect loop detection interventions to live task terminal states.
 * Per SPEC §37.14–§37.15.
 */
import type { TaskStatus } from "@terminus/domain";

export interface LoopInterventionRef {
  readonly kind:
    | "warn"
    | "force_checkpoint"
    | "classify_failure"
    | "narrow_or_replan"
    | "change_strategy"
    | "spawn_scout"
    | "request_user_decision"
    | "terminate";
  readonly reason: string;
  readonly signals: readonly string[];
}

export interface InterventionEffect {
  readonly taskStatus: TaskStatus | null;
  readonly spawnScout: boolean;
  readonly forceCheckpoint: boolean;
  readonly requestUserDecision: boolean;
  readonly terminate: boolean;
  readonly message: string;
}

/**
 * Map a loop intervention onto concrete lifecycle effects. Terminal states
 * are preferred over token burn (orchestration AGENTS.md).
 */
export function applyLoopIntervention(intervention: LoopInterventionRef): InterventionEffect {
  switch (intervention.kind) {
    case "warn":
      return {
        taskStatus: null,
        spawnScout: false,
        forceCheckpoint: false,
        requestUserDecision: false,
        terminate: false,
        message: intervention.reason,
      };
    case "force_checkpoint":
      return {
        taskStatus: null,
        spawnScout: false,
        forceCheckpoint: true,
        requestUserDecision: false,
        terminate: false,
        message: intervention.reason,
      };
    case "classify_failure":
    case "narrow_or_replan":
    case "change_strategy":
      return {
        taskStatus: null,
        spawnScout: false,
        forceCheckpoint: false,
        requestUserDecision: false,
        terminate: false,
        message: intervention.reason,
      };
    case "spawn_scout":
      return {
        taskStatus: null,
        spawnScout: true,
        forceCheckpoint: false,
        requestUserDecision: false,
        terminate: false,
        message: intervention.reason,
      };
    case "request_user_decision":
      return {
        taskStatus: "NEEDS_USER_DECISION",
        spawnScout: false,
        forceCheckpoint: false,
        requestUserDecision: true,
        terminate: false,
        message: intervention.reason,
      };
    case "terminate":
      return {
        taskStatus: "ABORTED",
        spawnScout: false,
        forceCheckpoint: false,
        requestUserDecision: false,
        terminate: true,
        message: intervention.reason,
      };
    default: {
      const _e: never = intervention.kind;
      void _e;
      return {
        taskStatus: "FAILED",
        spawnScout: false,
        forceCheckpoint: false,
        requestUserDecision: false,
        terminate: true,
        message: "unknown intervention",
      };
    }
  }
}
