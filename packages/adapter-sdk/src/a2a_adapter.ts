/**
 * @terminus/adapter-sdk — Agent-to-Agent (A2A) Boundary Adapter.
 *
 * Per SPEC §4.2, §9.3, §27.2:
 * Manages federated inter-agent collaboration, delegation contracts,
 * typed questions, and artifact handoffs between independent operators.
 */
import type { TaskContractV2 } from "@terminus/domain";

export interface A2ADelegationRequest {
  readonly delegationId: string;
  readonly fromOperatorId: string;
  readonly toOperatorId: string;
  readonly missionObjective: string;
  readonly scopePaths: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly budgetMicros: bigint;
  readonly deadlineSeconds: number;
}

export interface A2ADelegationResponse {
  readonly delegationId: string;
  readonly accepted: boolean;
  readonly assignedTaskId: string | null;
  readonly reason: string | null;
}

export class A2ABoundaryAdapter {
  /**
   * Converts an A2A delegation request into a canonical TaskContractV2.
   */
  static delegationToTaskContract(req: A2ADelegationRequest): TaskContractV2 {
    return {
      version: 1,
      mission: req.missionObjective,
      scope: {
        resources: [],
        allowedEffectClasses: ["LOCAL_FS_READ", "LOCAL_FS_WRITE"],
        excludedPathsOrSystems: [],
      },
      acceptance: req.acceptanceCriteria.map((ac, idx) => ({
        claimId: `claim-a2a-${idx + 1}`,
        statement: ac,
        evidenceRequirement: "DETERMINISTIC_TEST",
      })),
      constraints: {
        security: ["ATTENUATED_DELEGATION"],
        costMicros: req.budgetMicros,
        timeoutSeconds: req.deadlineSeconds,
      },
      authorityCeiling: ["FS_WRITE"],
      mode: "autonomous",
    };
  }

  /**
   * Formats a canonical task completion into an A2A result receipt.
   */
  static taskToA2AResult(
    delegationId: string,
    taskId: string,
    status: "completed" | "failed" | "partial",
    summary: string,
    artifactHashes: readonly string[],
  ) {
    return {
      delegationId,
      taskId,
      status,
      summary,
      artifacts: artifactHashes,
      settledAt: new Date().toISOString(),
    };
  }
}
