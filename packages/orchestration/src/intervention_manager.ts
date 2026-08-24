/**
 * @terminus/orchestration — Structured Intervention Manager (SPEC §16.3).
 *
 * Implements the 14 canonical structured intervention verbs:
 *  - focus: narrows task attention to a specific entity or subsystem
 *  - ignore: marks a diagnostic or file path to be bypassed
 *  - elaborate: adds human intent, requirements, or constraints
 *  - change_constraint: adjusts budget, timeout, or security policy
 *  - edit_plan: modifies workflow nodes or edges
 *  - approve_exact_effect: generates single-use authorization for effect ID
 *  - deny_narrow: denies an effect and tightens authority ceiling
 *  - pause: pauses execution to WAITING_USER or PAUSED state
 *  - resume: restarts execution from PAUSED state
 *  - takeover: transfers control from model to human operator
 *  - fork: creates a new attempt/lineage with current state
 *  - rewind: rolls back candidate modifications to a previous checkpoint
 *  - terminate: aborts task execution with documented rationale
 *  - request_independent_review: triggers a detached clean-context reviewer
 */
import type {
  StructuredIntervention,
  StructuredInterventionVerb,
} from "@terminus/domain";
import {
  INTERVENTION_PAYLOAD_SCHEMAS,
  NotFoundError,
  ValidationError,
  generateUuid7,
  nowTimestamp,
  structuredInterventionSchema,
} from "@terminus/domain";

export { INTERVENTION_PAYLOAD_SCHEMAS } from "@terminus/domain";

export type InterventionTaskState =
  | "PENDING"
  | "DRAFT"
  | "READY"
  | "RUNNING"
  | "WAITING_USER"
  | "WAITING_AUTH"
  | "WAITING_RESOURCE"
  | "PAUSED"
  | "VERIFYING"
  | "SUCCEEDED"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED"
  | "BLOCKED";

/** States in which each verb is valid. The executor must re-check this at apply time. */
export const INTERVENTION_STATE_PRECONDITIONS: Readonly<Record<StructuredInterventionVerb, readonly InterventionTaskState[]>> = {
  focus: ["RUNNING", "WAITING_USER", "PAUSED"],
  ignore: ["RUNNING", "WAITING_USER", "PAUSED"],
  elaborate: ["RUNNING", "WAITING_USER", "PAUSED"],
  change_constraint: ["RUNNING", "WAITING_USER", "PAUSED"],
  edit_plan: ["RUNNING", "WAITING_USER", "PAUSED"],
  approve_exact_effect: ["RUNNING", "WAITING_USER", "PAUSED"],
  deny_narrow: ["RUNNING", "WAITING_USER", "PAUSED"],
  pause: ["RUNNING", "WAITING_USER"],
  resume: ["PAUSED", "WAITING_USER"],
  takeover: ["RUNNING", "WAITING_USER", "PAUSED"],
  fork: ["RUNNING", "WAITING_USER", "PAUSED"],
  rewind: ["PAUSED", "WAITING_USER"],
  terminate: ["DRAFT", "READY", "PENDING", "RUNNING", "WAITING_USER", "WAITING_AUTH", "WAITING_RESOURCE", "PAUSED", "VERIFYING", "BLOCKED"],
  request_independent_review: ["RUNNING", "WAITING_USER", "PAUSED", "BLOCKED", "FAILED"],
};

const taskTargetVerbs = new Set<StructuredInterventionVerb>([
  "elaborate",
  "change_constraint",
  "pause",
  "resume",
  "takeover",
  "fork",
  "terminate",
  "request_independent_review",
]);

const entityTargetVerbs = new Set<StructuredInterventionVerb>([
  "focus",
  "ignore",
  "edit_plan",
  "approve_exact_effect",
  "deny_narrow",
  "rewind",
]);

export interface ProposeInterventionParams {
  readonly taskId: string;
  readonly attemptId?: string | null;
  readonly actorPrincipal: string;
  readonly verb: StructuredInterventionVerb;
  readonly targetEntityId?: string | null;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly rationale: string;
}

export interface InterventionApplicationResult {
  readonly success: boolean;
  readonly intervention: StructuredIntervention;
  readonly appliedChanges: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface InterventionExecutor {
  /** Reads the current task state from the authoritative task store. */
  readonly getTaskState?: (taskId: string) => InterventionTaskState;
  readonly apply: (
    intervention: StructuredIntervention,
  ) => { readonly appliedChanges: Readonly<Record<string, unknown>> };
}

export class InterventionManager {
  private readonly interventions = new Map<string, StructuredIntervention>();
  private readonly taskInterventions = new Map<string, string[]>();

  public proposeIntervention(params: ProposeInterventionParams): StructuredIntervention {
    const payload = this.validatePayload(params.verb, params.payload ?? {});
    const targetEntityId = this.validateAndResolveTarget(params, payload);
    const intervention: StructuredIntervention = {
      id: generateUuid7(),
      taskId: params.taskId,
      attemptId: params.attemptId ?? null,
      actorPrincipal: params.actorPrincipal,
      verb: params.verb,
      targetEntityId,
      payload,
      rationale: params.rationale,
      status: "PROPOSED",
      timestamp: nowTimestamp(),
    };
    structuredInterventionSchema.parse(intervention);

    this.interventions.set(intervention.id, intervention);
    const existing = this.taskInterventions.get(params.taskId) ?? [];
    existing.push(intervention.id);
    this.taskInterventions.set(params.taskId, existing);

    return this.copyIntervention(intervention);
  }

  /**
   * Applies an intervention against the task and effect state.
   */
  public applyIntervention(
    interventionId: string,
    executor: InterventionExecutor | null,
  ): InterventionApplicationResult {
    const intv = this.interventions.get(interventionId);
    if (!intv) {
      throw new NotFoundError("structured intervention", interventionId);
    }

    if (intv.status !== "PROPOSED") {
      return {
        success: false,
        intervention: this.copyIntervention(intv),
        appliedChanges: {},
        error: `Intervention ${interventionId} is already ${intv.status}`,
      };
    }

    if (executor === null) {
      return {
        success: false,
        intervention: this.copyIntervention(intv),
        appliedChanges: {},
        error: "No intervention executor is configured; the coordinator did not mutate task, effect, or workspace state",
      };
    }
    const taskState = executor.getTaskState?.(intv.taskId);
    if (taskState === undefined) {
      return {
        success: false,
        intervention: this.copyIntervention(intv),
        appliedChanges: {},
        error: "No authoritative task state is configured; intervention preconditions could not be checked",
      };
    }
    const allowedStates = INTERVENTION_STATE_PRECONDITIONS[intv.verb];
    if (!allowedStates.includes(taskState)) {
      return {
        success: false,
        intervention: this.copyIntervention(intv),
        appliedChanges: {},
        error: `Intervention '${intv.verb}' requires task state ${allowedStates.join(", ")}; current state is ${taskState}`,
      };
    }
    const { appliedChanges } = executor.apply(this.copyIntervention(intv));

    const updated: StructuredIntervention = {
      ...intv,
      status: "APPLIED",
      timestamp: nowTimestamp(),
    };

    this.interventions.set(interventionId, updated);

    return {
      success: true,
      intervention: this.copyIntervention(updated),
      appliedChanges: { ...appliedChanges },
    };
  }

  public rejectIntervention(interventionId: string, reason: string): StructuredIntervention {
    const intv = this.interventions.get(interventionId);
    if (!intv) throw new NotFoundError("structured intervention", interventionId);
    const updated: StructuredIntervention = {
      ...intv,
      status: "REJECTED",
      rationale: `${intv.rationale} [REJECTED: ${reason}]`,
      timestamp: nowTimestamp(),
    };
    this.interventions.set(interventionId, updated);
    return this.copyIntervention(updated);
  }

  public getIntervention(id: string): StructuredIntervention | null {
    const intervention = this.interventions.get(id);
    return intervention === undefined ? null : this.copyIntervention(intervention);
  }

  public listInterventions(taskId?: string): readonly StructuredIntervention[] {
    const all = Array.from(this.interventions.values());
    if (taskId) {
      return all.filter((i) => i.taskId === taskId).map((intervention) => this.copyIntervention(intervention));
    }
    return all.map((intervention) => this.copyIntervention(intervention));
  }

  private copyIntervention(intervention: StructuredIntervention): StructuredIntervention {
    const payload = Object.fromEntries(
      Object.entries(intervention.payload).map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value] : value,
      ]),
    );
    return { ...intervention, payload };
  }

  private validatePayload(
    verb: StructuredInterventionVerb,
    payload: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    const parsed = INTERVENTION_PAYLOAD_SCHEMAS[verb].safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError(
        `Invalid payload for intervention '${verb}': ${parsed.error.message}`,
        { verb },
      );
    }
    return parsed.data;
  }

  private validateAndResolveTarget(
    params: ProposeInterventionParams,
    payload: Readonly<Record<string, unknown>>,
  ): string {
    const suppliedTarget = params.targetEntityId ?? null;
    if (suppliedTarget !== null && suppliedTarget.trim().length === 0) {
      throw new ValidationError("Intervention targetEntityId must not be blank", {
        verb: params.verb,
      });
    }

    if (taskTargetVerbs.has(params.verb)) {
      if (suppliedTarget !== null && suppliedTarget !== params.taskId) {
        throw new ValidationError(
          `Intervention '${params.verb}' must target task '${params.taskId}'`,
          { verb: params.verb, taskId: params.taskId, targetEntityId: suppliedTarget },
        );
      }
      return params.taskId;
    }

    if (entityTargetVerbs.has(params.verb) && suppliedTarget === null) {
      throw new ValidationError(`Intervention '${params.verb}' requires a non-empty targetEntityId`);
    }
    if (suppliedTarget === null) {
      throw new ValidationError(`Intervention '${params.verb}' has no target binding`);
    }

    if (params.verb === "approve_exact_effect" || params.verb === "deny_narrow") {
      const effectId = payload.effectId;
      if (typeof effectId !== "string" || effectId !== suppliedTarget) {
        throw new ValidationError(
          `Intervention '${params.verb}' targetEntityId must exactly match payload.effectId`,
          { verb: params.verb, targetEntityId: suppliedTarget },
        );
      }
    }
    if (params.verb === "rewind") {
      const checkpointHash = payload.checkpointHash;
      if (typeof checkpointHash !== "string" || checkpointHash !== suppliedTarget) {
        throw new ValidationError(
          "Intervention 'rewind' targetEntityId must exactly match payload.checkpointHash",
          { verb: params.verb, targetEntityId: suppliedTarget },
        );
      }
    }
    return suppliedTarget;
  }
}
