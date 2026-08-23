/**
 * @terminus/workflow-compiler — Taint Flow & Trust Boundary Analysis.
 *
 * SPEC §8.2, §12.3, ADR-0036.
 * Tracks taint propagation from untrusted sources (e.g. untrusted repository files,
 * untrusted web/MCP inputs) to sensitive sinks (e.g. mutating external effects,
 * secret brokers, shell execution) and ensures every path passes through an
 * explicit verifier or sanitizer.
 */
import type { NodeDraft, EdgeDraft, TaintFlowAnalysis } from "./types.js";

const SENSITIVE_EFFECT_CLASSES = [
  "reversible_external",
  "compensable_external",
  "irreversible",
  "unknown",
];

export function analyzeTaintFlow(
  nodes: readonly NodeDraft[],
  edges: readonly EdgeDraft[],
): TaintFlowAnalysis {
  const nodeMap = new Map<string, NodeDraft>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (nodeMap.has(e.sourceNodeId) && nodeMap.has(e.targetNodeId)) {
      adj.get(e.sourceNodeId)!.push(e.targetNodeId);
    }
  }

  // 1. Identify initial Taint Sources
  const taintedNodes = new Set<string>();
  for (const n of nodes) {
    const text = `${n.title ?? ""} ${n.description ?? ""} ${n.id}`.toLowerCase();
    const hasUntrustedInput = n.trustInputs?.some(
      (t) =>
        t.minTrustLevel.toLowerCase().includes("untrusted") ||
        t.minTrustLevel.toLowerCase().includes("web") ||
        t.minTrustLevel.toLowerCase().includes("repo"),
    );
    const mentionsUntrusted =
      text.includes("untrusted") ||
      text.includes("web_fetch") ||
      text.includes("external_pull") ||
      text.includes("user_input");

    if (hasUntrustedInput || mentionsUntrusted) {
      taintedNodes.add(n.id);
    }
  }

  // 2. Propagate Taint forward through the graph unless sanitized by a verifier
  const queue = Array.from(taintedNodes);
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentNode = nodeMap.get(currentId);

    // If current node is a verifier or explicitly sanitizes, it clears taint
    if (currentNode?.kind === "verifier" || currentNode?.taintPolicy?.sanitizeWith) {
      continue;
    }

    for (const neighborId of adj.get(currentId) ?? []) {
      if (!taintedNodes.has(neighborId)) {
        taintedNodes.add(neighborId);
        queue.push(neighborId);
      }
    }
  }

  // 3. Check for Sensitive Sinks that receive Taint without sanitization
  const violations: string[] = [];
  for (const taintedId of taintedNodes) {
    const node = nodeMap.get(taintedId);
    if (!node) continue;

    const isSensitiveSink =
      node.kind === "effect" ||
      node.kind === "connector" ||
      (node.effectClass && SENSITIVE_EFFECT_CLASSES.includes(node.effectClass)) ||
      (node.requiredCapabilities && node.requiredCapabilities.includes("secrets"));

    if (isSensitiveSink && !node.taintPolicy?.allowTaintedInputs && !node.taintPolicy?.sanitizeWith) {
      violations.push(
        `Node "${node.id}" (${node.kind}) is a sensitive sink receiving unsanitized tainted data from an untrusted source.`,
      );
    }
  }

  return {
    safe: violations.length === 0,
    violations,
    taintedNodeIds: Array.from(taintedNodes),
  };
}
