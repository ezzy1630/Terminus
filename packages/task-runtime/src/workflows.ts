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
    const nodeIds = new Set(nodes.map((n) => n.id));
    if (nodeIds.size !== nodes.length) {
      throw new WorkflowError("Duplicate node IDs found in workflow definition");
    }

    const adj = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    for (const n of nodes) {
      adj.set(n.id, []);
      inDegree.set(n.id, 0);
    }

    for (const e of edges) {
      if (!nodeIds.has(e.sourceNodeId)) {
        throw new WorkflowError(`Edge source node ${e.sourceNodeId} not found in workflow`);
      }
      if (!nodeIds.has(e.targetNodeId)) {
        throw new WorkflowError(`Edge target node ${e.targetNodeId} not found in workflow`);
      }
      adj.get(e.sourceNodeId)!.push(e.targetNodeId);
      inDegree.set(e.targetNodeId, (inDegree.get(e.targetNodeId) ?? 0) + 1);
    }

    // Kahn's algorithm for cycle detection
    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    let visited = 0;
    while (queue.length > 0) {
      const u = queue.shift()!;
      visited++;
      for (const v of adj.get(u) ?? []) {
        const d = (inDegree.get(v) ?? 0) - 1;
        inDegree.set(v, d);
        if (d === 0) queue.push(v);
      }
    }

    if (visited !== nodes.length) {
      throw new WorkflowError("Workflow graph contains cycles; must be a directed acyclic graph (DAG)");
    }
  }

  async createWorkflow(
    taskId: string,
    nodes: readonly WorkflowNode[],
    edges: readonly GuardedEdge[],
  ): Promise<Workflow> {
    this.validateDag(nodes, edges);

    const now = this.clock();
    const workflow: Workflow = {
      id: this.idSource(),
      version: 1,
      taskId,
      nodes,
      edges,
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
