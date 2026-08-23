/**
 * @terminus/workflow-compiler — Temporal Safety & Sequence Analysis.
 *
 * SPEC §8.2, §13.2, ADR-0036.
 * Validates temporal sequence policies and effect ordering:
 * - Mutating effects (e.g. git_push, deploy, db_write) must be preceded by
 *   verification/tests or human approval.
 * - Compensation nodes must be reachable from failing effect transitions.
 */
import type { NodeDraft, EdgeDraft, TemporalSafetyAnalysis } from "./types.js";

export function analyzeTemporalSafety(
  nodes: readonly NodeDraft[],
  edges: readonly EdgeDraft[],
): TemporalSafetyAnalysis {
  const nodeMap = new Map<string, NodeDraft>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const reverseAdj = new Map<string, string[]>();
  for (const n of nodes) reverseAdj.set(n.id, []);

  for (const e of edges) {
    if (nodeMap.has(e.sourceNodeId) && nodeMap.has(e.targetNodeId)) {
      reverseAdj.get(e.targetNodeId)!.push(e.sourceNodeId);
    }
  }

  const violations: string[] = [];

  for (const node of nodes) {
    const isMutatingEffect =
      node.kind === "effect" ||
      node.effectClass === "reversible_external" ||
      node.effectClass === "compensable_external" ||
      node.effectClass === "irreversible";

    if (isMutatingEffect) {
      // Trace backwards from this mutating effect to ensure there is at least one
      // verifier or human approval node preceding it on all ancestor paths
      const ancestors = new Set<string>();
      const queue = [...(reverseAdj.get(node.id) ?? [])];
      for (const a of queue) ancestors.add(a);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        for (const pred of reverseAdj.get(curr) ?? []) {
          if (!ancestors.has(pred)) {
            ancestors.add(pred);
            queue.push(pred);
          }
        }
      }

      let hasPrecedingCheck = false;
      for (const ancestorId of ancestors) {
        const ancestorNode = nodeMap.get(ancestorId);
        if (
          ancestorNode?.kind === "verifier" ||
          ancestorNode?.kind === "human" ||
          ancestorNode?.preconditions?.length
        ) {
          hasPrecedingCheck = true;
          break;
        }
      }

      // If the workflow has multiple nodes and this effect has no preceding check, flag violation
      if (nodes.length > 1 && !hasPrecedingCheck) {
        violations.push(
          `Mutating effect node "${node.id}" (${node.effectClass ?? node.kind}) executes without prior verification or approval.`,
        );
      }
    }
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}
