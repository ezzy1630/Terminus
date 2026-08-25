/**
 * @terminus/task-runtime — Workflow & Node State Machine Engine.
 *
 * Per SPEC §8, §8.1:
 * Drives workflow compilation, validation, execution, and node lifecycle
 * with guarded edges, retry policies, and compensation paths.
 */
import type {
  Workflow,
  WorkflowNode,
  GuardedEdge,
  NodeRun,
  WorkflowStatus,
  NodeRunStatus,
  Rfc3339Timestamp,
} from "@terminus/domain";
import {
  isWorkflowTransitionAllowed,
  isWorkflowTerminal,
  isNodeRunTransitionAllowed,
  isNodeRunTerminal,
  nowTimestamp,
} from "@terminus/domain";
import type { DurableTaskRepository } from "./types.js";
import { TransactionalOutbox } from "./outbox.js";
import { validateWorkflow } from "@terminus/workflow-compiler";

export class WorkflowError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkflowError";
  }
}

export class WorkflowEngine {
  constructor(
    private readonly repo: DurableTaskRepository,
    private readonly outbox: TransactionalOutbox,
    private readonly idSource: () => string = () => `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly runIdSource: () => string = () => `noderun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly clock: () => Rfc3339Timestamp = () => nowTimestamp(),
  ) {}

  private validateDag(nodes: readonly WorkflowNode[], edges: readonly GuardedEdge[]): void {
    const report = validateWorkflow({ nodes, edges });
    if (!report.valid) {
      const hasCycles = report.errors.some((e: { code: string }) => e.code === "UNBOUNDED_LOOP");
      const errorMsg = report.errors.map((e: { code: string; message: string }) => `[${e.code}] ${e.message}`).join("; ");
      const prefix = hasCycles ? "Workflow graph contains cycles; " : "Workflow graph failed static validation: ";
      throw new WorkflowError(`${prefix}${errorMsg}`, { report });
    }
  }

  async createWorkflow(
    taskId: string,
    nodes: readonly WorkflowNode[],
    edges: readonly GuardedEdge[],
  ): Promise<Workflow> {
    const report = validateWorkflow({ nodes, edges });
    if (!report.valid) {
      const hasCycles = report.errors.some((e: { code: string }) => e.code === "UNBOUNDED_LOOP");
      const errorMsg = report.errors.map((e: { code: string; message: string }) => `[${e.code}] ${e.message}`).join("; ");
      const prefix = hasCycles ? "Workflow graph contains cycles; " : "Workflow graph failed static validation: ";
      throw new WorkflowError(`${prefix}${errorMsg}`, { report });
    }

    const now = this.clock();
    const workflow: Workflow = {
      id: this.idSource(),
      version: 1,
      taskId,
      nodes,
      edges,
      staticAnalysis: report,
      createdAt: now,
    };

    const outboxMsg = this.outbox.createMessage(
      "workflow",
      workflow.id,
      1,
      "workflow.created",
      {
        workflowId: workflow.id,
        taskId,
        version: 1,
        nodeCount: nodes.length,
        nodes,
        edges,
        staticAnalysis: report,
      },
    );

    return this.repo.createWorkflow(workflow, outboxMsg);
  }

  async executeNode(
    workflowId: string,
    nodeId: string,
    attemptId: string,
    inputs: Record<string, unknown> = {},
  ): Promise<NodeRun> {
    const workflow = await this.repo.getWorkflow(workflowId);
    if (!workflow) {
      throw new WorkflowError(`Workflow ${workflowId} not found`);
    }

    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new WorkflowError(`Node ${nodeId} not found in workflow ${workflowId}`);
    }

    const now = this.clock();
    const nodeRun: NodeRun = {
      id: this.runIdSource(),
      workflowId,
      nodeId,
      attemptId,
      status: "RUNNING",
      inputs: { ...node.inputs, ...inputs },
      outputs: null,
      error: null,
      startedAt: now,
      settledAt: null,
    };

    const outboxMsg = this.outbox.createMessage(
      "node_run",
      nodeRun.id,
      1,
      "workflow.node_started",
      {
        workflowId,
        nodeId,
        nodeRunId: nodeRun.id,
        nodeKind: node.kind,
        attemptId,
      },
    );

    return this.repo.createNodeRun(nodeRun, outboxMsg);
  }

  async completeNode(
    nodeRunId: string,
    outputs: Record<string, unknown>,
  ): Promise<NodeRun> {
    const run = await this.repo.getNodeRun(nodeRunId);
    if (!run) {
      throw new WorkflowError(`NodeRun ${nodeRunId} not found`);
    }

    if (!isNodeRunTransitionAllowed(run.status, "COMPLETED")) {
      throw new WorkflowError(`Illegal transition from ${run.status} to COMPLETED for NodeRun ${nodeRunId}`);
    }

    const now = this.clock();
    const updated: NodeRun = {
      ...run,
      status: "COMPLETED",
      outputs,
      settledAt: now,
    };

    const outboxMsg = this.outbox.createMessage(
      "node_run",
      updated.id,
      2,
      "workflow.node_completed",
      {
        workflowId: updated.workflowId,
        nodeId: updated.nodeId,
        nodeRunId: updated.id,
        outputs,
      },
    );

    return this.repo.updateNodeRun(updated, outboxMsg);
  }

  async failNode(
    nodeRunId: string,
    error: string,
    recoverable = false,
  ): Promise<NodeRun> {
    const run = await this.repo.getNodeRun(nodeRunId);
    if (!run) {
      throw new WorkflowError(`NodeRun ${nodeRunId} not found`);
    }

    if (!isNodeRunTransitionAllowed(run.status, "FAILED")) {
      throw new WorkflowError(`Illegal transition from ${run.status} to FAILED for NodeRun ${nodeRunId}`);
    }

    const now = this.clock();
    const updated: NodeRun = {
      ...run,
      status: "FAILED",
      error,
      settledAt: now,
    };

    const outboxMsg = this.outbox.createMessage(
      "node_run",
      updated.id,
      2,
      "workflow.node_failed",
      {
        workflowId: updated.workflowId,
        nodeId: updated.nodeId,
        nodeRunId: updated.id,
        error,
        recoverable,
      },
    );

    return this.repo.updateNodeRun(updated, outboxMsg);
  }
}
