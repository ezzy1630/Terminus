/**
 * @terminus/workflow-compiler — Standard Organizational Workflows.
 *
 * SPEC §8, §12.1, ADR-0036.
 * Reusable, statically validated organizational workflows for:
 * - Software Patching (Read -> Propose -> Isolated Transaction -> Verify -> Review -> Commit)
 * - Database Migration (Inspect -> Compatibility -> Dry Run -> Rollback Verify -> Human Signoff -> Apply)
 * - Security Review (Static Scan -> Dependency Audit -> Clean Review -> Evidence Verification)
 * - Release Preparation (Codegen -> Test Matrix -> Evidence -> System Card)
 */
import type { Workflow } from "./types.js";
import { compileWorkflowDraft } from "./compiler.js";

export function createSoftwarePatchWorkflow(taskId = "task-patch-standard"): Workflow {
  const { workflow } = compileWorkflowDraft(
    {
      id: "wf-software-patch-v1",
      name: "Standard Software Patch Workflow",
      description: "Isolated patch transaction with static verification, independent review, and rollback compensation",
      taskId,
      mandatorySteps: ["verify_tests_and_lint", "independent_review"],
      authorityCeiling: ["read", "patch", "exec", "git"],
      nodes: [
        {
          id: "read_and_diagnose",
          title: "Read Source and Diagnose Issue",
          kind: "deterministic",
          owner: "kernel_process_service",
          requiredCapabilities: ["read"],
          effectClass: "read_only",
          timeoutSeconds: 60,
        },
        {
          id: "propose_patch",
          title: "Synthesize Patch Proposal",
          kind: "model_judgment",
          owner: "planner_model",
          requiredCapabilities: ["patch"],
          effectClass: "read_only",
          timeoutSeconds: 180,
        },
        {
          id: "apply_isolated_patch",
          title: "Apply Patch in Isolated Transaction",
          kind: "deterministic",
          owner: "kernel_patch_service",
          requiredCapabilities: ["patch"],
          effectClass: "bufferable_local",
          compensationNodeId: "rollback_patch",
          timeoutSeconds: 60,
        },
        {
          id: "verify_tests_and_lint",
          title: "Run Linters and Targeted Tests",
          kind: "verifier",
          owner: "test_verifier",
          requiredCapabilities: ["exec"],
          effectClass: "read_only",
          timeoutSeconds: 120,
        },
        {
          id: "independent_review",
          title: "Independent Clean-Context Code Review",
          kind: "verifier",
          owner: "clean_reviewer",
          requiredCapabilities: ["read"],
          effectClass: "read_only",
          timeoutSeconds: 120,
        },
        {
          id: "commit_patch",
          title: "Commit and Admit Patch into Workspace",
          kind: "effect",
          owner: "kernel_effect_service",
          requiredCapabilities: ["git"],
          effectClass: "reversible_external",
          compensationNodeId: "rollback_patch",
          timeoutSeconds: 60,
        },
        {
          id: "rollback_patch",
          title: "Rollback Candidate Patch",
          kind: "deterministic",
          owner: "kernel_patch_service",
          requiredCapabilities: ["patch"],
          effectClass: "bufferable_local",
          timeoutSeconds: 30,
        },
      ],
      edges: [
        { sourceNodeId: "read_and_diagnose", targetNodeId: "propose_patch", condition: null },
        { sourceNodeId: "propose_patch", targetNodeId: "apply_isolated_patch", condition: null },
        { sourceNodeId: "apply_isolated_patch", targetNodeId: "verify_tests_and_lint", condition: null },
        { sourceNodeId: "verify_tests_and_lint", targetNodeId: "independent_review", condition: "test_passed == true" },
        { sourceNodeId: "independent_review", targetNodeId: "commit_patch", condition: "approved == true" },
      ],
      sourceProvenance: {
        sourceKind: "yaml_workflow",
        sourcePath: "standard/software-patch.yaml",
        compilerVersion: "0.1.0",
      },
    },
    { taskId, strictMode: false },
  );

  return workflow;
}

export function createDatabaseMigrationWorkflow(taskId = "task-db-migration"): Workflow {
  const { workflow } = compileWorkflowDraft(
    {
      id: "wf-database-migration-v1",
      name: "Database Migration Workflow",
      description: "Backward-compatible schema migration with dry-run, rollback validation, and human signoff",
      taskId,
      mandatorySteps: ["compatibility_check", "verify_rollback_plan", "human_signoff"],
      authorityCeiling: ["read", "exec", "database"],
      nodes: [
        {
          id: "inspect_schema",
          title: "Inspect Current Database Schema",
          kind: "deterministic",
          owner: "kernel_process_service",
          requiredCapabilities: ["read"],
          effectClass: "read_only",
        },
        {
          id: "compatibility_check",
          title: "Verify Backward-Compatibility Invariants",
          kind: "verifier",
          owner: "schema_verifier",
          requiredCapabilities: ["read"],
          effectClass: "read_only",
        },
        {
          id: "dry_run_migration",
          title: "Execute Migration in Dry-Run Transaction",
          kind: "deterministic",
          owner: "database_connector",
          requiredCapabilities: ["exec"],
          effectClass: "bufferable_local",
        },
        {
          id: "verify_rollback_plan",
          title: "Validate Down-Migration and Rollback SQL",
          kind: "verifier",
          owner: "rollback_verifier",
          requiredCapabilities: ["read"],
          effectClass: "read_only",
        },
        {
          id: "human_signoff",
          title: "Human Operator Approval for Production Migration",
          kind: "human",
          owner: "database_admin",
          requiredCapabilities: [],
          effectClass: "read_only",
        },
        {
          id: "apply_migration",
          title: "Apply Production Schema Migration",
          kind: "effect",
          owner: "kernel_effect_service",
          requiredCapabilities: ["database"],
          effectClass: "compensable_external",
          compensationNodeId: "rollback_migration",
        },
        {
          id: "rollback_migration",
          title: "Execute Down-Migration Script",
          kind: "deterministic",
          owner: "database_connector",
          requiredCapabilities: ["database"],
          effectClass: "compensable_external",
        },
      ],
      edges: [
        { sourceNodeId: "inspect_schema", targetNodeId: "compatibility_check", condition: null },
        { sourceNodeId: "compatibility_check", targetNodeId: "dry_run_migration", condition: "compatible == true" },
        { sourceNodeId: "dry_run_migration", targetNodeId: "verify_rollback_plan", condition: null },
        { sourceNodeId: "verify_rollback_plan", targetNodeId: "human_signoff", condition: "rollback_valid == true" },
        { sourceNodeId: "human_signoff", targetNodeId: "apply_migration", condition: "approved == true" },
      ],
      sourceProvenance: {
        sourceKind: "yaml_workflow",
        sourcePath: "standard/database-migration.yaml",
        compilerVersion: "0.1.0",
      },
    },
    { taskId, strictMode: false },
  );

  return workflow;
}

export function createSecurityReviewWorkflow(taskId = "task-security-review"): Workflow {
  const { workflow } = compileWorkflowDraft(
    {
      id: "wf-security-review-v1",
      name: "Security Review Workflow",
      description: "Static code scan, dependency audit, and clean-context claim verification",
      taskId,
      mandatorySteps: ["static_code_scan", "dependency_audit", "clean_context_review"],
      authorityCeiling: ["read", "exec"],
      nodes: [
        {
          id: "static_code_scan",
          title: "Run SAST and Secret Leak Scanners",
          kind: "deterministic",
          owner: "security_scanner",
          requiredCapabilities: ["read", "exec"],
          effectClass: "read_only",
        },
        {
          id: "dependency_audit",
          title: "Audit Dependencies for Vulnerabilities",
          kind: "deterministic",
          owner: "dependency_auditor",
          requiredCapabilities: ["exec"],
          effectClass: "read_only",
        },
        {
          id: "clean_context_review",
          title: "Clean Context Independent Security Review",
          kind: "verifier",
          owner: "clean_security_reviewer",
          requiredCapabilities: ["read"],
          effectClass: "read_only",
        },
        {
          id: "claim_evidence_verification",
          title: "Admit Security Verification Claims",
          kind: "verifier",
          owner: "admission_verifier",
          requiredCapabilities: ["read"],
          effectClass: "read_only",
        },
      ],
      edges: [
        { sourceNodeId: "static_code_scan", targetNodeId: "dependency_audit", condition: null },
        { sourceNodeId: "dependency_audit", targetNodeId: "clean_context_review", condition: "audit_passed == true" },
        { sourceNodeId: "clean_context_review", targetNodeId: "claim_evidence_verification", condition: "findings_resolved == true" },
      ],
      sourceProvenance: {
        sourceKind: "yaml_workflow",
        sourcePath: "standard/security-review.yaml",
        compilerVersion: "0.1.0",
      },
    },
    { taskId, strictMode: false },
  );

  return workflow;
}
