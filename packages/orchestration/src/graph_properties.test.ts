/**
 * Graph scheduling properties (SPEC §46.3).
 */
import { describe, expect, test } from "bun:test";
import {
  GraphExecutor,
  validateGraph,
  type GraphDefinition,
  type GraphNode,
  type GraphNodeHandler,
} from "./graph.js";

function node(id: string, dependsOn: string[] = [], required = true): GraphNode {
  return {
    id,
    kind: "worker",
    required,
    inputs: [],
    outputs: [{ name: "out", valueTag: "string" }],
    dependsOn,
    retryIdentity: id,
    fanOutKey: null,
    transform: null,
  };
}

function def(nodes: GraphNode[], maxSteps = 32): GraphDefinition {
  return {
    id: "prop-graph",
    nodes,
    edges: [],
    boundedConcurrency: 2,
    missingWorkerPolicy: "fail_required",
    convergence: {
      maxSteps,
      maxWallClockMs: 5_000,
      requiredOutputPorts: nodes.filter((n) => n.required).map((n) => `${n.id}:out`),
    },
  };
}

const okHandler: GraphNodeHandler = {
  async execute(n) {
    return {
      status: "ok",
      outputs: { out: { tag: "string", value: n.id } },
    };
  },
};

describe("graph scheduling properties", () => {
  test("validateGraph rejects cycles", () => {
    expect(() => validateGraph(def([node("a", ["b"]), node("b", ["a"])]))).toThrow(/cycle/);
  });

  test("acyclic graphs terminate under budget", async () => {
    const graph = def([node("a"), node("b", ["a"]), node("c", ["a", "b"])]);
    const executor = new GraphExecutor({
      handler: okHandler,
      transforms: new Map(),
      clock: () => Date.now(),
      seenWork: new Set(),
    });
    const result = await executor.run(graph, null);
    expect(["converged", "failed", "budget_exhausted"]).toContain(result.status);
    expect(result.steps).toBeLessThanOrEqual(graph.convergence.maxSteps);
  });

  test("maxSteps budget forces termination", async () => {
    const graph = def(
      Array.from({ length: 20 }, (_, i) => node(`n${i}`, i === 0 ? [] : [`n${i - 1}`])),
      3,
    );
    const executor = new GraphExecutor({
      handler: okHandler,
      transforms: new Map(),
      clock: () => 0,
      seenWork: new Set(),
    });
    const result = await executor.run(graph, null);
    expect(result.steps).toBeLessThanOrEqual(3);
    expect(["converged", "failed", "budget_exhausted"]).toContain(result.status);
  });
});
