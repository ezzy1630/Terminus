/**
 * @terminus/workflow-compiler — Type definitions.
 *
 * SPEC §8 (Workflow IR), §12 (Workflow and Skill Compiler), ADR-0036.
 */
import type {
  Workflow,
  WorkflowNode,
  GuardedEdge,
  SourceSpan,
  AmbiguityStatus,
  TrustRequirement,
  Predicate,
  EvidenceRequirement,
  RetryPolicy,
  ResourceBudget,
  TaintPolicy,
  WitnessPath,
  StaticValidationError,
  StaticValidationWarning,
  StaticValidationReport,
  WorkflowSourceProvenance,
  NodeRun,
} from "@terminus/domain";

export type {
  Workflow,
  WorkflowNode,
  GuardedEdge,
  SourceSpan,
  AmbiguityStatus,
  TrustRequirement,
  Predicate,
  EvidenceRequirement,
  RetryPolicy,
  ResourceBudget,
  TaintPolicy,
  WitnessPath,
  StaticValidationError,
  StaticValidationWarning,
  StaticValidationReport,
  WorkflowSourceProvenance,
  NodeRun,
};

export type WorkflowNodeKind =
  | "deterministic"
  | "model_judgment"
  | "human"
  | "connector"
  | "effect"
  | "verifier"
  | "subworkflow";

export interface NodeDraft {
  readonly id: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly kind?: WorkflowNodeKind | undefined;
  readonly owner?: string | undefined;
  readonly inputs?: Record<string, unknown> | undefined;
  readonly outputs?: Record<string, unknown> | undefined;
  readonly requiredCapabilities?: readonly string[] | undefined;
  readonly trustInputs?: readonly TrustRequirement[] | undefined;
  readonly preconditions?: readonly Predicate[] | undefined;
  readonly postconditions?: readonly Predicate[] | undefined;
  readonly effectClass?: string | null | undefined;
  readonly evidenceRequirements?: readonly EvidenceRequirement[] | undefined;
  readonly retryPolicy?: RetryPolicy | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly budget?: ResourceBudget | undefined;
  readonly compensationNodeId?: string | null | undefined;
  readonly sourceSpan?: SourceSpan | null | undefined;
  readonly ambiguityStatus?: AmbiguityStatus | null | undefined;
  readonly taintPolicy?: TaintPolicy | undefined;
}

export interface EdgeDraft {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly condition?: string | null | undefined;
  readonly conditionType?: "deterministic" | "model_predicate" | undefined;
  readonly sourceSpan?: SourceSpan | null | undefined;
}

export interface WorkflowDraft {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly taskId?: string | undefined;
  readonly nodes: readonly NodeDraft[];
  readonly edges: readonly EdgeDraft[];
  readonly authorityCeiling?: readonly string[] | undefined;
  readonly mandatorySteps?: readonly string[] | undefined;
  readonly sourceProvenance?: WorkflowSourceProvenance | undefined;
}

export interface CompileOptions {
  readonly taskId?: string | undefined;
  readonly authorityCeiling?: readonly string[] | undefined;
  readonly mandatorySteps?: readonly string[] | undefined;
  readonly sourcePath?: string | undefined;
  readonly strictMode?: boolean | undefined;
  readonly allowAmbiguity?: boolean | undefined;
}

export interface OwnerClassification {
  readonly kind: WorkflowNodeKind;
  readonly owner: string;
  readonly rationale: string;
  readonly isDerivable: boolean;
  readonly requiresModelJudgment: boolean;
  readonly requiresHumanApproval: boolean;
}

export interface LoopBoundAnalysis {
  readonly hasCycles: boolean;
  readonly bounded: boolean;
  readonly unboundedCycleNodeIds: readonly string[];
  readonly cycles: readonly (readonly string[])[];
}

export interface ReachabilityAnalysis {
  readonly allReachable: boolean;
  readonly unreachableNodeIds: readonly string[];
  readonly deadEndNodeIds: readonly string[];
  readonly rootNodeIds: readonly string[];
  readonly terminalNodeIds: readonly string[];
}

export interface TaintFlowAnalysis {
  readonly safe: boolean;
  readonly violations: readonly string[];
  readonly taintedNodeIds: readonly string[];
}

export interface TemporalSafetyAnalysis {
  readonly safe: boolean;
  readonly violations: readonly string[];
}

export interface AttenuationAnalysis {
  readonly safe: boolean;
  readonly violations: readonly string[];
}

export interface VerifierIndependenceAnalysis {
  readonly safe: boolean;
  readonly violations: readonly string[];
}

export interface ExecutionContext {
  readonly workflow: Workflow;
  readonly taskScope: {
    readonly taskId: string;
    readonly authorityCeiling: readonly string[];
  };
  readonly environment: Record<string, unknown>;
}

export interface NodeExecutionResult {
  readonly status: "COMPLETED" | "FAILED" | "WAITING_INPUT";
  readonly outputs?: Record<string, unknown> | undefined;
  readonly error?: string | undefined;
  readonly evidenceProduced?: readonly string[] | undefined;
}

export type NodeExecutor = (
  node: WorkflowNode,
  inputs: Record<string, unknown>,
  context: ExecutionContext,
) => Promise<NodeExecutionResult>;
