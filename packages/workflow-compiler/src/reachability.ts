/**
 * @terminus/workflow-compiler — Reachability & Dead-End Analysis.
 *
 * SPEC §8.2, §12.3, ADR-0036.
 * Checks that all nodes in the workflow graph are reachable from the root(s)
 * and that all forward execution paths can reach a valid terminal node.
 */
import type { NodeDraft, EdgeDraft, ReachabilityAnalysis } from "./types.js";

export function analyzeReachability(
  nodes: readonly NodeDraft[],
  edges: readonly EdgeDraft[],
): ReachabilityAnalysis {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  const reverseAdj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  for (const n of nodes) {
    adj.set(n.id, []);
    reverseAdj.set(n.id, []);
    inDegree.set(n.id, 0);
    outDegree.set(n.id, 0);
  }

  for (const e of edges) {
    if (nodeIds.has(e.sourceNodeId) && nodeIds.has(e.targetNodeId)) {
      adj.get(e.sourceNodeId)!.push(e.targetNodeId);
      reverseAdj.get(e.targetNodeId)!.push(e.sourceNodeId);
      inDegree.set(e.targetNodeId, (inDegree.get(e.targetNodeId) ?? 0) + 1);
      outDegree.set(e.sourceNodeId, (outDegree.get(e.sourceNodeId) ?? 0) + 1);
    }
  }

  // 1. Identify Root nodes:
  // If multiple nodes exist, a root must have outDegree > 0 (or be nodes[0]).
  // Isolated nodes with inDegree === 0 and outDegree === 0 are disconnected.
  const rootNodeIds: string[] = [];
  if (nodes.length > 0 && nodes[0]) {
    rootNodeIds.push(nodes[0].id);
  }
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0 && (outDegree.get(id) ?? 0) > 0 && !rootNodeIds.includes(id)) {
      rootNodeIds.push(id);
    }
  }

  // 2. Identify Terminal nodes (outDegree === 0 and inDegree > 0)
  const terminalNodeIds: string[] = [];
  for (const [id, deg] of outDegree.entries()) {
    if (deg === 0 && (inDegree.get(id) ?? 0) > 0) {
      terminalNodeIds.push(id);
    }
  }

  // If there's only 1 node, it's both root and terminal
  if (nodes.length === 1 && nodes[0]) {
    return {
      allReachable: true,
      unreachableNodeIds: [],
      deadEndNodeIds: [],
      rootNodeIds: [nodes[0].id],
      terminalNodeIds: [nodes[0].id],
    };
  }

  // 3. Forward Reachability from connected roots
  const forwardVisited = new Set<string>();
  const queue: string[] = [...rootNodeIds];
  for (const r of queue) forwardVisited.add(r);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of adj.get(current) ?? []) {
      if (!forwardVisited.has(neighbor)) {
        forwardVisited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  const unreachableNodeIds: string[] = [];
  for (const n of nodes) {
    if (!forwardVisited.has(n.id)) {
      unreachableNodeIds.push(n.id);
    }
  }

  // 4. Backward Reachability from all terminal nodes (can this node reach a terminal state?)
  const backwardVisited = new Set<string>();
  const reverseQueue: string[] = [...terminalNodeIds];
  for (const t of reverseQueue) backwardVisited.add(t);

  while (reverseQueue.length > 0) {
    const current = reverseQueue.shift()!;
    for (const predecessor of reverseAdj.get(current) ?? []) {
      if (!backwardVisited.has(predecessor)) {
        backwardVisited.add(predecessor);
        reverseQueue.push(predecessor);
      }
    }
  }

  const deadEndNodeIds: string[] = [];
  for (const n of nodes) {
    // If it is reachable from root but cannot reach any terminal node, it's a dead end
    if (forwardVisited.has(n.id) && !backwardVisited.has(n.id)) {
      deadEndNodeIds.push(n.id);
    }
  }

  const allReachable = unreachableNodeIds.length === 0 && deadEndNodeIds.length === 0;

  return {
    allReachable,
    unreachableNodeIds,
    deadEndNodeIds,
    rootNodeIds,
    terminalNodeIds,
  };
}
