/**
 * @terminus/workflow-compiler — Capability Attenuation Analysis.
 *
 * SPEC §8.2, §14.1, ADR-0036.
 * Ensures each node's requested capabilities remain strictly attenuated
 * within the task's declared authority ceiling and cannot escalate.
 */
import type { NodeDraft, AttenuationAnalysis } from "./types.js";

export function analyzeAttenuation(
  nodes: readonly NodeDraft[],
  authorityCeiling: readonly string[] = [],
): AttenuationAnalysis {
  if (authorityCeiling.length === 0) {
    return { safe: true, violations: [] };
  }

  const allowedSet = new Set(authorityCeiling.map((c) => c.toLowerCase()));
  const violations: string[] = [];

  for (const node of nodes) {
    for (const cap of node.requiredCapabilities ?? []) {
      if (!allowedSet.has(cap.toLowerCase())) {
        violations.push(
          `Node "${node.id}" requests capability "${cap}" which exceeds task authority ceiling [${authorityCeiling.join(", ")}].`,
        );
      }
    }
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}
