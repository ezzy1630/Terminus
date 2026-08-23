import { describe, expect, it } from "bun:test";
import { classifyOwner } from "../src/owner_test.js";

describe("SPEC §12.4 Owner Test", () => {
  it("classifies mechanically derivable operations as deterministic code", () => {
    const linterNode = { id: "lint_code", title: "Run linter and formatting check" };
    const classification = classifyOwner(linterNode);

    expect(classification.kind).toBe("deterministic");
    expect(classification.isDerivable).toBe(true);
    expect(classification.requiresModelJudgment).toBe(false);
    expect(classification.owner).toBe("kernel_process_service");
  });

  it("classifies test assertions and invariant checks as verifiers", () => {
    const verifierNode = { id: "check_tests", title: "Verify test suite passes and regression test output" };
    const classification = classifyOwner(verifierNode);

    expect(classification.kind).toBe("verifier");
    expect(classification.isDerivable).toBe(true);
    expect(classification.requiresModelJudgment).toBe(false);
  });

  it("classifies open-world code synthesis and reasoning as model judgment", () => {
    const synthesisNode = { id: "synthesize_patch", title: "Design and implement architectural fix for bug" };
    const classification = classifyOwner(synthesisNode);

    expect(classification.kind).toBe("model_judgment");
    expect(classification.isDerivable).toBe(false);
    expect(classification.requiresModelJudgment).toBe(true);
  });

  it("classifies human authorizations and sign-offs as human", () => {
    const approvalNode = { id: "approve_deploy", title: "Manual review and human signoff before production rollout" };
    const classification = classifyOwner(approvalNode);

    expect(classification.kind).toBe("human");
    expect(classification.requiresHumanApproval).toBe(true);
    expect(classification.isDerivable).toBe(false);
  });

  it("classifies mutating side-effects as effect", () => {
    const effectNode = { id: "push_to_git", title: "Deploy and publish release artifacts" };
    const classification = classifyOwner(effectNode);

    expect(classification.kind).toBe("effect");
    expect(classification.owner).toBe("kernel_effect_service");
  });
});
