import { describe, expect, it } from "bun:test";
import { validateWorkflow } from "../src/validator.js";

describe("Workflow Static Validation Engine", () => {
  it("passes validation on valid forward DAG", () => {
    const report = validateWorkflow({
      nodes: [
        { id: "start", kind: "deterministic" },
        { id: "process", kind: "model_judgment" },
        { id: "verify", kind: "verifier", owner: "test_verifier" },
      ],
      edges: [
        { sourceNodeId: "start", targetNodeId: "process" },
        { sourceNodeId: "process", targetNodeId: "verify" },
      ],
    });

    expect(report.valid).toBe(true);
    expect(report.errors.length).toBe(0);
    expect(report.reachability.allReachable).toBe(true);
    expect(report.loopBounds.hasCycles).toBe(false);
  });

  it("detects unreachable nodes and dead-ends", () => {
    const report = validateWorkflow({
      nodes: [
        { id: "entry", kind: "deterministic" },
        { id: "success", kind: "verifier" },
        { id: "orphaned_node", kind: "deterministic" },
      ],
      edges: [
        { sourceNodeId: "entry", targetNodeId: "success" },
      ],
    });

    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "UNREACHABLE_NODE" && e.nodeId === "orphaned_node")).toBe(true);
  });

  it("detects unbounded cycles", () => {
    const report = validateWorkflow({
      nodes: [
        { id: "node_a", kind: "deterministic" },
        { id: "node_b", kind: "model_judgment" },
      ],
      edges: [
        { sourceNodeId: "node_a", targetNodeId: "node_b" },
        { sourceNodeId: "node_b", targetNodeId: "node_a" }, // cycle with no retry bounds or exit
      ],
    });

    expect(report.valid).toBe(false);
    expect(report.loopBounds.hasCycles).toBe(true);
    expect(report.loopBounds.bounded).toBe(false);
    expect(report.errors.some((e) => e.code === "UNBOUNDED_LOOP")).toBe(true);
  });

  it("permits bounded retry cycles with exit edges", () => {
    const report = validateWorkflow({
      nodes: [
        { id: "task_node", kind: "model_judgment", retryPolicy: { maxRetries: 3, backoffMs: 1000 } },
        { id: "verifier_node", kind: "verifier" },
        { id: "done_node", kind: "deterministic" },
      ],
      edges: [
        { sourceNodeId: "task_node", targetNodeId: "verifier_node" },
        { sourceNodeId: "verifier_node", targetNodeId: "task_node", condition: "test_passed == false" }, // back-edge
        { sourceNodeId: "verifier_node", targetNodeId: "done_node", condition: "test_passed == true" }, // exit edge
      ],
    });

    expect(report.loopBounds.hasCycles).toBe(true);
    expect(report.loopBounds.bounded).toBe(true);
  });

  it("detects taint reaching sensitive sinks without verification", () => {
    const report = validateWorkflow({
      nodes: [
        { id: "untrusted_web_fetch", kind: "deterministic", trustInputs: [{ minTrustLevel: "untrusted_web" }] },
        { id: "privileged_deploy", kind: "effect", effectClass: "reversible_external" },
      ],
      edges: [
        { sourceNodeId: "untrusted_web_fetch", targetNodeId: "privileged_deploy" },
      ],
    });

    expect(report.valid).toBe(false);
    expect(report.taintFlow.safe).toBe(false);
    expect(report.errors.some((e) => e.code === "TAINT_SINK_VIOLATION")).toBe(true);
  });

  it("verifies mandatory step coverage and emits witness paths", () => {
    const report = validateWorkflow(
      {
        nodes: [
          { id: "step_start", kind: "deterministic" },
          { id: "secret_scan", kind: "verifier" },
          { id: "step_finish", kind: "deterministic" },
        ],
        edges: [
          { sourceNodeId: "step_start", targetNodeId: "secret_scan" },
          { sourceNodeId: "secret_scan", targetNodeId: "step_finish" },
        ],
      },
      { mandatorySteps: ["secret_scan"] },
    );

    expect(report.valid).toBe(true);
    expect(report.witnessPaths.length).toBe(1);
    expect(report.witnessPaths[0]?.coversMandatorySteps).toContain("secret_scan");
  });

  it("rejects execution paths that bypass mandatory steps", () => {
    const report = validateWorkflow(
      {
        nodes: [
          { id: "step_start", kind: "deterministic" },
          { id: "bypass_branch", kind: "deterministic" },
          { id: "step_finish", kind: "deterministic" },
        ],
        edges: [
          { sourceNodeId: "step_start", targetNodeId: "bypass_branch" },
          { sourceNodeId: "bypass_branch", targetNodeId: "step_finish" },
        ],
      },
      { mandatorySteps: ["secret_scan"] },
    );

    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "MANDATORY_STEP_BYPASS")).toBe(true);
  });

  it("enforces capability attenuation against task authority ceiling", () => {
    const report = validateWorkflow(
      {
        nodes: [
          { id: "read_step", kind: "deterministic", requiredCapabilities: ["read"] },
          { id: "escalated_step", kind: "effect", requiredCapabilities: ["secrets", "deploy"] },
        ],
        edges: [{ sourceNodeId: "read_step", targetNodeId: "escalated_step" }],
      },
      { authorityCeiling: ["read", "patch"] },
    );

    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "CAPABILITY_ESCALATION")).toBe(true);
  });

  it("enforces verifier independence between author and reviewer", () => {
    const report = validateWorkflow({
      nodes: [
        { id: "synthesize_code", kind: "model_judgment", owner: "claude-3-5-sonnet" },
        { id: "review_code", kind: "verifier", owner: "claude-3-5-sonnet" }, // same owner
      ],
      edges: [{ sourceNodeId: "synthesize_code", targetNodeId: "review_code" }],
    });

    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "VERIFIER_NOT_INDEPENDENT")).toBe(true);
  });
});
