/**
 * @terminus/workflow-compiler — Static Validation Suite.
 *
 * SPEC §8.2, §12.3, ADR-0036.
 * Comprehensive static safety validator orchestrating:
 * - Graph topology & schema checks
 * - Reachability & dead-end analysis
 * - Bounded loop & cycle invariant checks
 * - Taint flow across trust boundaries
 * - Temporal sequence & effect ordering
 * - Mandatory-step coverage & witness paths
 * - Capability attenuation against task ceiling
 * - Verifier independence & separation of duties
 * - Compensation and irreversibility declaration
 */
import type {
  NodeDraft,
  EdgeDraft,
  WorkflowDraft,
  StaticValidationError,
  StaticValidationWarning,
  StaticValidationReport,
  CompileOptions,
} from "./types.js";
import { analyzeReachability } from "./reachability.js";
import { analyzeLoops } from "./loops.js";
import { analyzeTaintFlow } from "./taint.js";
import { analyzeTemporalSafety } from "./temporal.js";
import { analyzeMandatorySteps } from "./mandatory_steps.js";
import { analyzeAttenuation } from "./attenuation.js";
import { analyzeVerifierIndependence } from "./verifier_independence.js";

export function validateWorkflow(
  workflow: WorkflowDraft,
  options: CompileOptions = {},
): StaticValidationReport {
  const errors: StaticValidationError[] = [];
  const warnings: StaticValidationWarning[] = [];

  const nodes = workflow.nodes;
  const edges = workflow.edges;

  // 1. Basic Structure & ID uniqueness
  if (nodes.length === 0) {
    errors.push({
      code: "EMPTY_WORKFLOW",
      message: "Workflow must contain at least one node",
    });
  }

  const nodeIds = new Set<string>();
  for (const n of nodes) {
    if (!n.id || n.id.trim() === "") {
      errors.push({
        code: "INVALID_NODE_ID",
        message: "Node id cannot be empty",
        sourceSpan: n.sourceSpan ?? undefined,
      });
      continue;
    }
    if (nodeIds.has(n.id)) {
      errors.push({
        code: "DUPLICATE_NODE_ID",
        message: `Duplicate node id "${n.id}" found in workflow`,
        nodeId: n.id,
        sourceSpan: n.sourceSpan ?? undefined,
      });
    }
    nodeIds.add(n.id);

    // Warn on unresolved ambiguity if in strict mode
    if (n.ambiguityStatus?.isAmbiguous && options.strictMode && !options.allowAmbiguity) {
      warnings.push({
        code: "AMBIGUOUS_REQUIREMENT",
        message: `Node "${n.id}" contains ambiguous instruction: ${n.ambiguityStatus.reason}`,
        nodeId: n.id,
        sourceSpan: n.sourceSpan ?? undefined,
      });
    }

    // Effect nodes must have compensation or declared irreversibility
    if (n.kind === "effect" && !n.compensationNodeId && n.effectClass !== "irreversible" && n.effectClass !== "read_only") {
      warnings.push({
        code: "MISSING_COMPENSATION",
        message: `Mutating effect node "${n.id}" has no declared compensationNodeId and is not marked irreversible.`,
        nodeId: n.id,
        sourceSpan: n.sourceSpan ?? undefined,
      });
    }
  }

  // 2. Edge reference validation
  for (const e of edges) {
    if (!nodeIds.has(e.sourceNodeId)) {
      errors.push({
        code: "INVALID_EDGE_SOURCE",
        message: `Edge references non-existent source node "${e.sourceNodeId}"`,
        edge: { sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId },
        sourceSpan: e.sourceSpan ?? undefined,
      });
    }
    if (!nodeIds.has(e.targetNodeId)) {
      errors.push({
        code: "INVALID_EDGE_TARGET",
        message: `Edge references non-existent target node "${e.targetNodeId}"`,
        edge: { sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId },
        sourceSpan: e.sourceSpan ?? undefined,
      });
    }
  }

  // 3. Reachability Analysis
  const reachability = analyzeReachability(nodes, edges);
  for (const unreachableId of reachability.unreachableNodeIds) {
    errors.push({
      code: "UNREACHABLE_NODE",
      message: `Node "${unreachableId}" is unreachable from workflow entry points`,
      nodeId: unreachableId,
    });
  }
  for (const deadEndId of reachability.deadEndNodeIds) {
    errors.push({
      code: "DEAD_END_NODE",
      message: `Node "${deadEndId}" cannot reach any valid terminal state`,
      nodeId: deadEndId,
    });
  }

  // 4. Bounded Loop Analysis
  const loopBounds = analyzeLoops(nodes, edges);
  for (const unboundedId of loopBounds.unboundedCycleNodeIds) {
    errors.push({
      code: "UNBOUNDED_LOOP",
      message: `Node "${unboundedId}" is part of an unbounded cycle with no exit limit or termination invariant`,
      nodeId: unboundedId,
    });
  }

  // 5. Taint Flow Analysis
  const taintFlow = analyzeTaintFlow(nodes, edges);
  for (const violation of taintFlow.violations) {
    errors.push({
      code: "TAINT_SINK_VIOLATION",
      message: violation,
    });
  }

  // 6. Temporal Safety Analysis
  const temporal = analyzeTemporalSafety(nodes, edges);
  for (const violation of temporal.violations) {
    errors.push({
      code: "TEMPORAL_SEQUENCE_VIOLATION",
      message: violation,
    });
  }

  // 7. Mandatory Step Coverage & Witness Paths
  const mandatory = analyzeMandatorySteps(nodes, edges, options.mandatorySteps ?? workflow.mandatorySteps);
  for (const violation of mandatory.violations) {
    errors.push({
      code: "MANDATORY_STEP_BYPASS",
      message: violation,
    });
  }

  // 8. Capability Attenuation Analysis
  const attenuation = analyzeAttenuation(nodes, options.authorityCeiling ?? workflow.authorityCeiling);
  for (const violation of attenuation.violations) {
    errors.push({
      code: "CAPABILITY_ESCALATION",
      message: violation,
    });
  }

  // 9. Verifier Independence
  const independence = analyzeVerifierIndependence(nodes, edges);
  for (const violation of independence.violations) {
    errors.push({
      code: "VERIFIER_NOT_INDEPENDENT",
      message: violation,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    reachability: {
      allReachable: reachability.allReachable,
      unreachableNodeIds: reachability.unreachableNodeIds,
      deadEndNodeIds: reachability.deadEndNodeIds,
    },
    loopBounds: {
      hasCycles: loopBounds.hasCycles,
      bounded: loopBounds.bounded,
      unboundedCycleNodeIds: loopBounds.unboundedCycleNodeIds,
    },
    taintFlow: {
      safe: taintFlow.safe,
      violations: taintFlow.violations,
    },
    witnessPaths: mandatory.witnessPaths,
  };
}
