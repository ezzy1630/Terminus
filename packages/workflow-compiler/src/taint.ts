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

const SENSITIVE_EFFECT_CLASSES = new Set([
  "reversible_external",
  "compensable_external",
  "irreversible",
  "unknown",
]);

const UNTRUSTED_PATTERNS = ["untrusted", "web_fetch", "external_pull", "user_input"];

// skipcq: JS-0067
function isNodeUntrustedSource(n: NodeDraft): boolean {
  const text = `${n.title ?? ""} ${n.description ?? ""} ${n.id}`.toLowerCase();
  const hasUntrustedInput = n.trustInputs?.some((t) => {
    const lvl = t.minTrustLevel.toLowerCase();
    return lvl.includes("untrusted") || lvl.includes("web") || lvl.includes("repo");
  });
  return Boolean(hasUntrustedInput || UNTRUSTED_PATTERNS.some((p) => text.includes(p)));
}

// skipcq: JS-0067
function findInitialTaintSources(nodes: readonly NodeDraft[]): Set<string> {
  const sources = new Set<string>();
  for (const n of nodes) {
    if (isNodeUntrustedSource(n)) sources.add(n.id);
  }
  return sources;
}

function isNodeSanitized(node: NodeDraft | undefined): boolean {
  return node?.kind === "verifier" || Boolean(node?.taintPolicy?.sanitizeWith);
}

function expandTaintedNeighbors(
  currentId: string,
  tainted: Set<string>,
  adj: Map<string, string[]>,
  queue: string[],
): void {
  for (const neighborId of adj.get(currentId) ?? []) {
    if (!tainted.has(neighborId)) {
      tainted.add(neighborId);
      queue.push(neighborId);
    }
  }
}

// skipcq: JS-0067
function propagateTaint(
  tainted: Set<string>,
  nodeMap: Map<string, NodeDraft>,
  adj: Map<string, string[]>,
): void {
  const queue = Array.from(tainted);
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (isNodeSanitized(nodeMap.get(currentId))) continue;
    expandTaintedNeighbors(currentId, tainted, adj, queue);
  }
}

// skipcq: JS-0067
function isNodeSensitiveSink(node: NodeDraft): boolean {
  if (node.kind === "effect" || node.kind === "connector") return true;
  if (typeof node.effectClass === "string" && SENSITIVE_EFFECT_CLASSES.has(node.effectClass)) return true;
  return node.requiredCapabilities?.includes("secrets") === true;
}

function isUnsanitizedSink(node: NodeDraft): boolean {
  return isNodeSensitiveSink(node) && !node.taintPolicy?.allowTaintedInputs && !node.taintPolicy?.sanitizeWith;
}

// skipcq: JS-0067
function findTaintViolations(taintedNodes: Set<string>, nodeMap: Map<string, NodeDraft>): string[] {
  const violations: string[] = [];
  for (const taintedId of taintedNodes) {
    const node = nodeMap.get(taintedId);
    if (node && isUnsanitizedSink(node)) {
      violations.push(
        `Node "${node.id}" (${node.kind}) is a sensitive sink receiving unsanitized tainted data from an untrusted source.`,
      );
    }
  }
  return violations;
}

// skipcq: JS-0067
export function analyzeTaintFlow(
  nodes: readonly NodeDraft[],
  edges: readonly EdgeDraft[],
): TaintFlowAnalysis {
  const nodeMap = new Map<string, NodeDraft>(nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (nodeMap.has(e.sourceNodeId) && nodeMap.has(e.targetNodeId)) {
      adj.get(e.sourceNodeId)!.push(e.targetNodeId);
    }
  }

  const taintedNodes = findInitialTaintSources(nodes);
  propagateTaint(taintedNodes, nodeMap, adj);
  const violations = findTaintViolations(taintedNodes, nodeMap);

  return {
    safe: violations.length === 0,
    violations,
    taintedNodeIds: Array.from(taintedNodes),
  };
}
