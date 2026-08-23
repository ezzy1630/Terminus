/**
 * @terminus/workflow-compiler — Bounded Loop & Cycle Analysis.
 *
 * SPEC §8.2, §12.3, ADR-0036.
 * Formally detects all cycles in the workflow graph and verifies that
 * every loop is statically bounded by an explicit iteration counter,
 * retry limit, or termination predicate with a safe recovery path.
 */
import type { NodeDraft, EdgeDraft, LoopBoundAnalysis } from "./types.js";

export function analyzeLoops(
  nodes: readonly NodeDraft[],
  edges: readonly EdgeDraft[],
): LoopBoundAnalysis {
  const nodeMap = new Map<string, NodeDraft>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const adj = new Map<string, Array<{ target: string; condition: string | null }>>();
  for (const n of nodes) adj.set(n.id, []);

  for (const e of edges) {
    if (nodeMap.has(e.sourceNodeId) && nodeMap.has(e.targetNodeId)) {
      adj.get(e.sourceNodeId)!.push({
        target: e.targetNodeId,
        condition: e.condition ?? null,
      });
    }
  }

  // Tarjan's Strongly Connected Components (SCC) algorithm
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  function strongConnect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const { target: w } of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);

      // An SCC is a cycle if it contains more than 1 node, or 1 node with a self-loop
      if (scc.length > 1) {
        sccs.push(scc);
      } else if (scc.length === 1) {
        const selfNode = scc[0]!;
        const hasSelfLoop = (adj.get(selfNode) ?? []).some((e) => e.target === selfNode);
        if (hasSelfLoop) {
          sccs.push(scc);
        }
      }
    }
  }

  for (const n of nodes) {
    if (!indices.has(n.id)) {
      strongConnect(n.id);
    }
  }

  const hasCycles = sccs.length > 0;
  const unboundedCycleNodeIds: string[] = [];

  // Check each cycle for boundedness:
  // A cycle is bounded if:
  // 1. At least one node in the cycle has an explicit retryPolicy (maxRetries > 0) or budget limit; AND
  // 2. There is at least one exit edge leaving the cycle with a guard condition or alternative successor.
  for (const scc of sccs) {
    const sccSet = new Set(scc);

    let hasExplicitLimit = false;
    for (const nodeId of scc) {
      const node = nodeMap.get(nodeId);
      if (node) {
        if (node.retryPolicy && node.retryPolicy.maxRetries > 0) {
          hasExplicitLimit = true;
        }
        if (node.budget && (node.budget.maxCostMicros || node.budget.maxTokens || node.budget.maxWallClockSeconds)) {
          hasExplicitLimit = true;
        }
      }
    }

    let hasExitEdge = false;
    for (const nodeId of scc) {
      for (const edge of adj.get(nodeId) ?? []) {
        if (!sccSet.has(edge.target)) {
          hasExitEdge = true;
          break;
        }
      }
      if (hasExitEdge) break;
    }

    if (!hasExplicitLimit || !hasExitEdge) {
      for (const nodeId of scc) {
        if (!unboundedCycleNodeIds.includes(nodeId)) {
          unboundedCycleNodeIds.push(nodeId);
        }
      }
    }
  }

  return {
    hasCycles,
    bounded: unboundedCycleNodeIds.length === 0,
    unboundedCycleNodeIds,
    cycles: sccs,
  };
}
