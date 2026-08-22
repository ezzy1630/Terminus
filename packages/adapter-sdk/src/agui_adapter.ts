/**
 * @terminus/adapter-sdk — Agent-GUI (AG-UI) Boundary Adapter.
 *
 * Per SPEC §9.3, §29.2:
 * Projects canonical task state, workflow graphs, effect ledgers,
 * claim/evidence trees, and attention signals into reactive UI view models.
 */
import type { TaskV2, Workflow, EffectRecord, Claim, Evidence } from "@terminus/domain";

export interface AgUiCockpitViewModel {
  readonly task: {
    readonly id: string;
    readonly objective: string;
    readonly status: string;
    readonly version: number;
  };
  readonly workflowGraph: {
    readonly nodes: readonly { readonly id: string; readonly label: string; readonly kind: string }[];
    readonly edges: readonly { readonly from: string; readonly to: string }[];
  } | null;
  readonly effectQueue: readonly {
    readonly id: string;
    readonly effectClass: string;
    readonly state: string;
    readonly summary: string;
  }[];
  readonly evidenceTree: readonly {
    readonly claimId: string;
    readonly statement: string;
    readonly status: string;
    readonly evidenceCount: number;
  }[];
  readonly attentionRequired: boolean;
}

export class AgUiBoundaryAdapter {
  /**
   * Projects domain aggregates into a consolidated cockpit view model.
   */
  static projectCockpit(params: {
    task: TaskV2;
    workflow?: Workflow | null;
    effects?: readonly EffectRecord[];
    claims?: readonly Claim[];
    evidences?: readonly Evidence[];
    hasPendingApprovalOrQuestion?: boolean;
  }): AgUiCockpitViewModel {
    const { task, workflow, effects = [], claims = [], hasPendingApprovalOrQuestion = false } = params;

    return {
      task: {
        id: task.id,
        objective: task.contract.mission,
        status: task.status,
        version: task.version,
      },
      workflowGraph: workflow
        ? {
            nodes: workflow.nodes.map((n) => ({ id: n.id, label: n.id, kind: n.kind })),
            edges: workflow.edges.map((e) => ({ from: e.sourceNodeId, to: e.targetNodeId })),
          }
        : null,
      effectQueue: effects.map((eff) => ({
        id: eff.id,
        effectClass: eff.effectClass,
        state: eff.state,
        summary: `${eff.intentType} on ${eff.connectorOrWorker}`,
      })),
      evidenceTree: claims.map((c) => ({
        claimId: c.id,
        statement: c.statement,
        status: c.status,
        evidenceCount: c.evidenceIds.length,
      })),
      attentionRequired:
        hasPendingApprovalOrQuestion ||
        task.status === "WAITING_USER" ||
        task.status === "WAITING_AUTH" ||
        effects.some((e) => e.state === "UNCERTAIN" || e.state === "MANUAL_RECONCILE"),
    };
  }
}
