/**
 * @terminus/workflow-compiler — Deterministic Workflow Controller.
 *
 * SPEC §8.3, ADR-0036.
 * Drives workflow traversal deterministically:
 * - The controller owns traversal; models and subagents NEVER own privileged execution.
 * - Evaluates guarded edges against typed node outputs.
 * - Enforces loop bounds and iteration limits.
 * - Implements verify-repair-commit runtime semantics with automatic compensation on failure.
 */
import { nowTimestamp } from "@terminus/domain";
import type {
  Workflow,
  WorkflowNode,
  NodeRun,
  ExecutionContext,
  NodeExecutionResult,
  NodeExecutor,
} from "./types.js";

export class ControllerError extends Error {
  constructor(
    message: string,
    public readonly nodeId?: string,
    public readonly code: string = "CONTROLLER_ERROR",
  ) {
    super(message);
    this.name = "ControllerError";
  }
}

export interface WorkflowExecutionSummary {
  readonly workflowId: string;
  readonly status: "COMPLETED" | "FAILED" | "PAUSED";
  readonly completedNodeIds: readonly string[];
  readonly failedNodeIds: readonly string[];
  readonly compensatedNodeIds: readonly string[];
  readonly nodeRuns: readonly NodeRun[];
  readonly finalOutputs: Record<string, unknown>;
  readonly error?: string;
}

export class DeterministicWorkflowController {
  private readonly nodeRuns = new Map<string, NodeRun>();
  private readonly iterationCounts = new Map<string, number>();
  private readonly maxLoopIterations: number;

  constructor(
    private readonly workflow: Workflow,
    private readonly context: ExecutionContext,
    options: { readonly maxLoopIterations?: number } = {},
  ) {
    this.maxLoopIterations = options.maxLoopIterations ?? 10;
  }

  public evaluateCondition(
    condition: string | null,
    outputs: Record<string, unknown>,
  ): boolean {
    if (!condition || condition.trim() === "") {
      return true;
    }

    const trimmed = condition.trim();

    // Simple expressions: "key == val", "key != val", "key === true", "key"
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;

    // Check equality "outcome == 'success'" or "status == success"
    const eqMatch = /^([a-zA-Z0-9_.]+)\s*==\s*['"]?([a-zA-Z0-9_.-]+)['"]?$/.exec(trimmed);
    if (eqMatch) {
      const key = eqMatch[1]!;
      const expected = eqMatch[2]!;
      const actual = String(this.lookupPath(outputs, key) ?? "");
      return actual.toLowerCase() === expected.toLowerCase();
    }

    // Check inequality "outcome != 'failure'"
    const neqMatch = /^([a-zA-Z0-9_.]+)\s*!=\s*['"]?([a-zA-Z0-9_.-]+)['"]?$/.exec(trimmed);
    if (neqMatch) {
      const key = neqMatch[1]!;
      const expected = neqMatch[2]!;
      const actual = String(this.lookupPath(outputs, key) ?? "");
      return actual.toLowerCase() !== expected.toLowerCase();
    }

    // Truthy check for field presence
    const val = this.lookupPath(outputs, trimmed);
    return Boolean(val);
  }

  private lookupPath(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".");
    let curr: unknown = obj;
    for (const p of parts) {
      if (curr && typeof curr === "object" && p in (curr as Record<string, unknown>)) {
        curr = (curr as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return curr;
  }

  public getSuccessors(nodeId: string, outputs: Record<string, unknown>): WorkflowNode[] {
    const outgoing = this.workflow.edges.filter((e) => e.sourceNodeId === nodeId);
    const validTargetIds: string[] = [];

    for (const edge of outgoing) {
      if (this.evaluateCondition(edge.condition, outputs)) {
        validTargetIds.push(edge.targetNodeId);
      }
    }

    const nodeMap = new Map(this.workflow.nodes.map((n) => [n.id, n]));
    return validTargetIds.map((id) => nodeMap.get(id)!).filter(Boolean);
  }

  /**
   * Executes the workflow from root nodes to terminal nodes using verify-repair-commit cycles.
   */
  public async execute(executor: NodeExecutor): Promise<WorkflowExecutionSummary> {
    const nodeMap = new Map(this.workflow.nodes.map((n) => [n.id, n]));
    const targetSet = new Set(this.workflow.edges.map((e) => e.targetNodeId));
    const rootNodes = this.workflow.nodes.filter((n) => !targetSet.has(n.id));

    if (rootNodes.length === 0 && this.workflow.nodes.length > 0) {
      rootNodes.push(this.workflow.nodes[0]!);
    }

    const readyQueue: WorkflowNode[] = [...rootNodes];
    const completedNodeIds: string[] = [];
    const failedNodeIds: string[] = [];
    const compensatedNodeIds: string[] = [];
    const accumulatedOutputs: Record<string, unknown> = {};

    while (readyQueue.length > 0) {
      const node = readyQueue.shift()!;
      const count = (this.iterationCounts.get(node.id) ?? 0) + 1;
      this.iterationCounts.set(node.id, count);

      const nodeMaxRetries = node.retryPolicy?.maxRetries ?? 0;
      const maxAllowed = Math.max(nodeMaxRetries + 1, this.maxLoopIterations);

      if (count > maxAllowed) {
        // Loop bound exceeded — trigger compensation if present
        failedNodeIds.push(node.id);
        if (node.compensationNodeId) {
          const compNode = nodeMap.get(node.compensationNodeId);
          if (compNode) {
            await executor(compNode, accumulatedOutputs, this.context);
            compensatedNodeIds.push(compNode.id);
          }
        }
        return {
          workflowId: this.workflow.id,
          status: "FAILED",
          completedNodeIds,
          failedNodeIds,
          compensatedNodeIds,
          nodeRuns: Array.from(this.nodeRuns.values()),
          finalOutputs: accumulatedOutputs,
          error: `Loop bound exceeded for node "${node.id}" (iterations: ${count} > max ${maxAllowed})`,
        };
      }

      // 1. Verify Preconditions
      let preconditionsPassed = true;
      for (const pre of node.preconditions ?? []) {
        if (!this.evaluateCondition(pre.expression, accumulatedOutputs)) {
          preconditionsPassed = false;
          break;
        }
      }

      if (!preconditionsPassed) {
        failedNodeIds.push(node.id);
        return {
          workflowId: this.workflow.id,
          status: "FAILED",
          completedNodeIds,
          failedNodeIds,
          compensatedNodeIds,
          nodeRuns: Array.from(this.nodeRuns.values()),
          finalOutputs: accumulatedOutputs,
          error: `Precondition failed for node "${node.id}"`,
        };
      }

      // 2. Execute Node
      const runId = `noderun-${node.id}-${count}`;
      const startedAt = nowTimestamp();
      const nodeRun: NodeRun = {
        id: runId,
        workflowId: this.workflow.id,
        nodeId: node.id,
        attemptId: `attempt-${count}`,
        status: "RUNNING",
        inputs: { ...node.inputs, ...accumulatedOutputs },
        outputs: null,
        error: null,
        retryCount: count - 1,
        startedAt,
        settledAt: null,
      };
      this.nodeRuns.set(node.id, nodeRun);

      let result: NodeExecutionResult;
      try {
        result = await executor(node, { ...node.inputs, ...accumulatedOutputs }, this.context);
      } catch (err) {
        result = {
          status: "FAILED",
          error: String(err),
        };
      }

      // 3. Verify Postconditions
      let postconditionsPassed = result.status === "COMPLETED";
      if (postconditionsPassed && node.postconditions && node.postconditions.length > 0) {
        const combinedOutputs = { ...accumulatedOutputs, ...(result.outputs ?? {}) };
        for (const post of node.postconditions) {
          if (!this.evaluateCondition(post.expression, combinedOutputs)) {
            postconditionsPassed = false;
            result = {
              status: "FAILED",
              error: `Postcondition verification failed for node "${node.id}": ${post.expression}`,
            };
            break;
          }
        }
      }

      // 4. Commit or Compensate
      const settledAt = nowTimestamp();
      if (postconditionsPassed) {
        const updatedRun: NodeRun = {
          ...nodeRun,
          status: "COMPLETED",
          outputs: result.outputs ?? {},
          settledAt,
        };
        this.nodeRuns.set(node.id, updatedRun);
        completedNodeIds.push(node.id);
        Object.assign(accumulatedOutputs, result.outputs ?? {});

        // Add matching successors to queue
        const successors = this.getSuccessors(node.id, accumulatedOutputs);
        for (const s of successors) {
          if (!readyQueue.some((q) => q.id === s.id)) {
            readyQueue.push(s);
          }
        }
      } else {
        const updatedRun: NodeRun = {
          ...nodeRun,
          status: "FAILED",
          error: result.error ?? "Execution failed",
          settledAt,
        };
        this.nodeRuns.set(node.id, updatedRun);
        failedNodeIds.push(node.id);

        // Run compensation if available
        if (node.compensationNodeId) {
          const compNode = nodeMap.get(node.compensationNodeId);
          if (compNode) {
            try {
              await executor(compNode, accumulatedOutputs, this.context);
              compensatedNodeIds.push(compNode.id);
            } catch {
              // ignore compensation error
            }
          }
        }

        return {
          workflowId: this.workflow.id,
          status: "FAILED",
          completedNodeIds,
          failedNodeIds,
          compensatedNodeIds,
          nodeRuns: Array.from(this.nodeRuns.values()),
          finalOutputs: accumulatedOutputs,
          error: result.error ?? `Node "${node.id}" failed execution`,
        };
      }
    }

    return {
      workflowId: this.workflow.id,
      status: "COMPLETED",
      completedNodeIds,
      failedNodeIds,
      compensatedNodeIds,
      nodeRuns: Array.from(this.nodeRuns.values()),
      finalOutputs: accumulatedOutputs,
    };
  }
}
