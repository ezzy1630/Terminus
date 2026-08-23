/**
 * @terminus/workflow-compiler — Owner-Test Classifier.
 *
 * SPEC §8.1, §12.4, ADR-0036.
 * Formally implements the Owner Test:
 * - If a decision or transformation is mechanically derivable from typed inputs
 *   (linters, compilers, tests, diffs, AST analyzers, hash checks), code owns it
 *   (kind = "deterministic" or "verifier").
 * - If it requires taste, ambiguity resolution, code synthesis, or open-world judgment,
 *   a model owns a typed slot (kind = "model_judgment").
 * - If it requires human authorization, policy override, or subjective sign-off,
 *   a human owns it (kind = "human").
 * - If it interacts with external state/APIs, it is an "effect" or "connector".
 */
import type { NodeDraft, OwnerClassification, WorkflowNodeKind } from "./types.js";

const DETERMINISTIC_KEYWORDS = [
  "lint",
  "format",
  "typecheck",
  "compile",
  "build",
  "cargo_build",
  "diff",
  "hash",
  "ast",
  "tree-sitter",
  "schema_parse",
  "parse",
  "compute",
  "read_file",
];

const VERIFIER_KEYWORDS = [
  "verify",
  "validate",
  "assert",
  "test",
  "pytest",
  "check_build",
  "check_coverage",
  "smoke_test",
  "regression_test",
  "audit",
];

const HUMAN_KEYWORDS = [
  "human",
  "approve",
  "approval",
  "signoff",
  "sign_off",
  "sign-off",
  "manual_review",
  "manual review",
  "confirm_deploy",
  "policy_override",
  "ask_user",
  "user_confirmation",
];

const CONNECTOR_KEYWORDS = [
  "github",
  "gitlab",
  "jira",
  "slack",
  "s3",
  "database_query",
  "http_request",
  "fetch_api",
];

const EFFECT_KEYWORDS = [
  "git_push",
  "git push",
  "deploy",
  "publish",
  "delete_file",
  "drop_table",
  "restart_service",
];

export function classifyOwner(draft: NodeDraft): OwnerClassification {
  // If explicitly declared, respect it after validation
  if (draft.kind) {
    const owner = draft.owner ?? defaultOwnerForKind(draft.kind);
    return {
      kind: draft.kind,
      owner,
      rationale: `Explicitly specified in node draft as kind: ${draft.kind}`,
      isDerivable: draft.kind === "deterministic" || draft.kind === "verifier",
      requiresModelJudgment: draft.kind === "model_judgment",
      requiresHumanApproval: draft.kind === "human",
    };
  }

  const text = `${draft.title ?? ""} ${draft.description ?? ""} ${draft.id}`.toLowerCase();

  // 1. Check for Human approval
  if (HUMAN_KEYWORDS.some((kw) => text.includes(kw))) {
    return {
      kind: "human",
      owner: draft.owner ?? "human_operator",
      rationale: "Requires human authorization, policy override, or subjective approval",
      isDerivable: false,
      requiresModelJudgment: false,
      requiresHumanApproval: true,
    };
  }

  // 2. Check for Verifier
  if (VERIFIER_KEYWORDS.some((kw) => text.includes(kw))) {
    return {
      kind: "verifier",
      owner: draft.owner ?? "independent_verifier",
      rationale: "Mechanically verifies acceptance criteria, test results, or postconditions",
      isDerivable: true,
      requiresModelJudgment: false,
      requiresHumanApproval: false,
    };
  }

  // 3. Check for External Effect / Mutating Action
  if (EFFECT_KEYWORDS.some((kw) => text.includes(kw))) {
    return {
      kind: "effect",
      owner: draft.owner ?? "kernel_effect_service",
      rationale: "Performs external or non-bufferable side-effects via trusted Effect Ledger",
      isDerivable: true,
      requiresModelJudgment: false,
      requiresHumanApproval: false,
    };
  }

  // 4. Check for Connector
  if (CONNECTOR_KEYWORDS.some((kw) => text.includes(kw))) {
    return {
      kind: "connector",
      owner: draft.owner ?? "connector_broker",
      rationale: "Performs external API or L7 connector operations with brokered credentials",
      isDerivable: true,
      requiresModelJudgment: false,
      requiresHumanApproval: false,
    };
  }

  // 5. Check for Deterministic execution
  if (DETERMINISTIC_KEYWORDS.some((kw) => text.includes(kw))) {
    return {
      kind: "deterministic",
      owner: draft.owner ?? "kernel_process_service",
      rationale: "Mechanically derivable computation, tool execution, or deterministic transformation",
      isDerivable: true,
      requiresModelJudgment: false,
      requiresHumanApproval: false,
    };
  }

  // 6. Default to Model Judgment (synthesis, reasoning, ambiguity resolution)
  return {
    kind: "model_judgment",
    owner: draft.owner ?? "planner_model",
    rationale: "Requires code synthesis, architectural reasoning, or open-world judgment",
    isDerivable: false,
    requiresModelJudgment: true,
    requiresHumanApproval: false,
  };
}

function defaultOwnerForKind(kind: WorkflowNodeKind): string {
  switch (kind) {
    case "deterministic":
      return "kernel_process_service";
    case "verifier":
      return "independent_verifier";
    case "human":
      return "human_operator";
    case "connector":
      return "connector_broker";
    case "effect":
      return "kernel_effect_service";
    case "subworkflow":
      return "subworkflow_executor";
    case "model_judgment":
    default:
      return "planner_model";
  }
}
