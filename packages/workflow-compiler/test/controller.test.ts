import { describe, expect, it } from "bun:test";
import { DeterministicWorkflowController } from "../src/controller.js";
import { compileWorkflowDraft } from "../src/compiler.js";
import type { NodeExecutor, ExecutionContext } from "../src/types.js";

describe("Deterministic Workflow Controller", () => {
  const dummyContext: ExecutionContext = {
    workflow: {} as any,
    taskScope: { taskId: "task-1", authorityCeiling: ["read", "patch", "exec"] },
    environment: {},
  };

  it("traverses workflow deterministically and executes nodes in order", async () => {
    const { workflow } = compileWorkflowDraft({
      id: "wf-test-seq",
      nodes: [
        { id: "node_1", kind: "deterministic" },
        { id: "node_2", kind: "deterministic" },
      ],
      edges: [{ sourceNodeId: "node_1", targetNodeId: "node_2" }],
    });

    const executionLog: string[] = [];
    const executor: NodeExecutor = async (node, inputs) => {
      executionLog.push(node.id);
      return { status: "COMPLETED", outputs: { [`${node.id}_done`]: true } };
    };

    const controller = new DeterministicWorkflowController(workflow, dummyContext);
    const summary = await controller.execute(executor);

    expect(summary.status).toBe("COMPLETED");
    expect(executionLog).toEqual(["node_1", "node_2"]);
    expect(summary.completedNodeIds).toEqual(["node_1", "node_2"]);
    expect(summary.finalOutputs["node_1_done"]).toBe(true);
    expect(summary.finalOutputs["node_2_done"]).toBe(true);
  });

  it("evaluates guarded edge branching correctly", async () => {
    const { workflow } = compileWorkflowDraft({
      id: "wf-test-branch",
      nodes: [
        { id: "eval_step", kind: "deterministic" },
        { id: "success_branch", kind: "deterministic" },
        { id: "failure_branch", kind: "deterministic" },
      ],
      edges: [
        { sourceNodeId: "eval_step", targetNodeId: "success_branch", condition: "test_status == 'passed'" },
        { sourceNodeId: "eval_step", targetNodeId: "failure_branch", condition: "test_status == 'failed'" },
      ],
    });

    const executed: string[] = [];
    const executor: NodeExecutor = async (node) => {
      executed.push(node.id);
      if (node.id === "eval_step") {
        return { status: "COMPLETED", outputs: { test_status: "passed" } };
      }
      return { status: "COMPLETED", outputs: {} };
    };

    const controller = new DeterministicWorkflowController(workflow, dummyContext);
    const summary = await controller.execute(executor);

    expect(summary.status).toBe("COMPLETED");
    expect(executed).toEqual(["eval_step", "success_branch"]);
    expect(summary.completedNodeIds).toContain("success_branch");
    expect(summary.completedNodeIds).not.toContain("failure_branch");
  });

  it("enforces verify-repair-commit loop with postcondition verification", async () => {
    const { workflow } = compileWorkflowDraft({
      id: "wf-test-postcondition",
      nodes: [
        {
          id: "step_verify",
          kind: "verifier",
          postconditions: [{ expression: "verified == true", dialect: "deterministic", deterministic: true }],
        },
      ],
      edges: [],
    });

    const executor: NodeExecutor = async () => {
      // Intentionally return failing output
      return { status: "COMPLETED", outputs: { verified: false } };
    };

    const controller = new DeterministicWorkflowController(workflow, dummyContext);
    const summary = await controller.execute(executor);

    expect(summary.status).toBe("FAILED");
    expect(summary.failedNodeIds).toContain("step_verify");
    expect(summary.error).toContain("Postcondition verification failed");
  });

  it("executes compensation node when an action fails", async () => {
    const { workflow } = compileWorkflowDraft({
      id: "wf-test-compensation",
      nodes: [
        {
          id: "apply_patch",
          kind: "effect",
          effectClass: "reversible_external",
          compensationNodeId: "revert_patch",
        },
        {
          id: "revert_patch",
          kind: "deterministic",
        },
      ],
      edges: [],
    });

    let compensationExecuted = false;
    const executor: NodeExecutor = async (node) => {
      if (node.id === "apply_patch") {
        return { status: "FAILED", error: "Kernel patch rejected" };
      }
      if (node.id === "revert_patch") {
        compensationExecuted = true;
        return { status: "COMPLETED", outputs: { reverted: true } };
      }
      return { status: "COMPLETED" };
    };

    const controller = new DeterministicWorkflowController(workflow, dummyContext);
    const summary = await controller.execute(executor);

    expect(summary.status).toBe("FAILED");
    expect(compensationExecuted).toBe(true);
    expect(summary.compensatedNodeIds).toContain("revert_patch");
  });
});
