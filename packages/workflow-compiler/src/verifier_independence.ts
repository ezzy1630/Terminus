/**
 * @terminus/workflow-compiler — Verifier Independence & Separation of Duties.
 *
 * SPEC §8.2, §27.4, §28.4, ADR-0036.
 * Verifies that verifier nodes are owned by an independent principal or
 * verification service distinct from the actor/model that produced the artifact.
 */
import type { NodeDraft, EdgeDraft, VerifierIndependenceAnalysis } from "./types.js";

export function analyzeVerifierIndependence(
  nodes: readonly NodeDraft[],
  edges: readonly EdgeDraft[],
): VerifierIndependenceAnalysis {
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
    if (node.kind === "verifier") {
      const verifierOwner = node.owner ?? "independent_verifier";

      // Check immediate predecessors that produce outputs/artifacts
      for (const predId of reverseAdj.get(node.id) ?? []) {
        const pred = nodeMap.get(predId);
        if (pred && (pred.kind === "model_judgment" || pred.kind === "effect")) {
          const actorOwner = pred.owner ?? "planner_model";
          if (verifierOwner === actorOwner && verifierOwner !== "independent_verifier") {
            violations.push(
              `Verifier node "${node.id}" has the same owner ("${verifierOwner}") as its predecessor actor node "${pred.id}". Verifier must be independent.`,
            );
          }
        }
      }
    }
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}
