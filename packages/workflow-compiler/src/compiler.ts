/**
 * @terminus/workflow-compiler — Workflow and Skill Compiler.
 *
 * SPEC §8, §12, ADR-0036.
 * Compiles natural language skills, prose specifications, and structured workflow
 * graphs into statically validated, typed Workflow IR with exact source-span provenance.
 */
import { createHash } from "node:crypto";
import { nowTimestamp } from "@terminus/domain";
import type {
  Workflow,
  WorkflowNode,
  GuardedEdge,
  WorkflowDraft,
  CompileOptions,
  StaticValidationReport,
} from "./types.js";
import { parseSkillMarkdown, parseWorkflowJson } from "./parser.js";
import { classifyOwner } from "./owner_test.js";
import { validateWorkflow } from "./validator.js";

export class CompilationError extends Error {
  constructor(
    message: string,
    public readonly report: StaticValidationReport,
  ) {
    super(message);
    this.name = "CompilationError";
  }
}

export function compileWorkflowDraft(
  draft: WorkflowDraft,
  options: CompileOptions = {},
): { workflow: Workflow; report: StaticValidationReport } {
  // 1. Run owner test on each node draft to classify kind and owner
  const classifiedNodes: WorkflowNode[] = draft.nodes.map((n) => {
    const classification = classifyOwner(n);
    return {
      id: n.id,
      kind: classification.kind,
      owner: classification.owner,
      inputs: n.inputs ?? {},
      outputs: n.outputs ?? {},
      requiredCapabilities: n.requiredCapabilities ?? [],
      trustInputs: n.trustInputs,
      preconditions: n.preconditions,
      postconditions: n.postconditions,
      effectClass: n.effectClass ?? null,
      evidenceRequirements: n.evidenceRequirements,
      retryPolicy: n.retryPolicy,
      timeoutSeconds: n.timeoutSeconds ?? 60,
      budget: n.budget,
      compensationNodeId: n.compensationNodeId ?? null,
      sourceSpan: n.sourceSpan ?? null,
      ambiguityStatus: n.ambiguityStatus ?? null,
      taintPolicy: n.taintPolicy,
    };
  });

  const compiledEdges: GuardedEdge[] = draft.edges.map((e) => ({
    sourceNodeId: e.sourceNodeId,
    targetNodeId: e.targetNodeId,
    condition: e.condition ?? null,
    conditionType: e.conditionType ?? "deterministic",
    sourceSpan: e.sourceSpan ?? null,
  }));

  const updatedDraft: WorkflowDraft = {
    ...draft,
    nodes: classifiedNodes,
    edges: compiledEdges,
  };

  // 2. Run static validation suite
  const report = validateWorkflow(updatedDraft, options);

  if (options.strictMode && !report.valid) {
    const errorDetails = report.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    throw new CompilationError(`Workflow failed static validation: ${errorDetails}`, report);
  }

  const id = draft.id ?? `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const taskId = options.taskId ?? draft.taskId ?? `task-${Date.now().toString(36)}`;
  const now = nowTimestamp();

  const workflow: Workflow = {
    id,
    version: 1,
    taskId,
    name: draft.name ?? id,
    description: draft.description ?? "",
    nodes: classifiedNodes,
    edges: compiledEdges,
    sourceProvenance: draft.sourceProvenance ?? {
      sourceKind: "prose_spec",
      sourcePath: options.sourcePath,
      compilerVersion: "0.1.0",
    },
    staticAnalysis: report,
    createdAt: now,
  };

  return { workflow, report };
}

export function compileSkill(
  skillMarkdown: string,
  options: CompileOptions = {},
): { workflow: Workflow; report: StaticValidationReport } {
  const sourcePath = options.sourcePath ?? "SKILL.md";
  const sourceHash = `sha256:${createHash("sha256").update(skillMarkdown).digest("hex")}`;
  const draft = parseSkillMarkdown(skillMarkdown, sourcePath);

  const draftWithProvenance: WorkflowDraft = {
    ...draft,
    sourceProvenance: {
      sourceKind: "skill_markdown",
      sourcePath,
      sourceHash,
      compilerVersion: "0.1.0",
    },
  };

  return compileWorkflowDraft(draftWithProvenance, options);
}

export function compileWorkflowJson(
  jsonString: string,
  options: CompileOptions = {},
): { workflow: Workflow; report: StaticValidationReport } {
  const sourcePath = options.sourcePath ?? "workflow.json";
  const sourceHash = `sha256:${createHash("sha256").update(jsonString).digest("hex")}`;
  const draft = parseWorkflowJson(jsonString, sourcePath);

  const draftWithProvenance: WorkflowDraft = {
    ...draft,
    sourceProvenance: {
      sourceKind: "json_ir",
      sourcePath,
      sourceHash,
      compilerVersion: "0.1.0",
    },
  };

  return compileWorkflowDraft(draftWithProvenance, options);
}
