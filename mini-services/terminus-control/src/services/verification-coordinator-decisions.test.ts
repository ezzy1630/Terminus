import { describe, expect, test } from "bun:test";
import {
  completionGateRepairInputs,
  verificationEvaluationPassed,
  restoredPlanMatchesContract,
  stalePlanBindingReason,
} from "./verification-coordinator.js";

describe("verification coordinator plan-binding decisions", () => {
  test("a plan bound to a changed world is stale, with the exact original reasons", () => {
    const plan = { sourceRevision: "rev1", environmentDigest: "env1" };
    expect(stalePlanBindingReason({ existingPlan: null, sourceRevision: "rev2", environmentDigest: "env2" })).toBeNull();
    expect(stalePlanBindingReason({ existingPlan: { ...plan, environmentDigest: null }, sourceRevision: "rev1", environmentDigest: "env1" })).toBe("missing_environment_digest");
    expect(stalePlanBindingReason({ existingPlan: plan, sourceRevision: "rev1", environmentDigest: "env2" })).toBe("environment_changed");
    expect(stalePlanBindingReason({ existingPlan: plan, sourceRevision: "rev2", environmentDigest: "env1" })).toBe("source_revision_changed");
    expect(stalePlanBindingReason({ existingPlan: plan, sourceRevision: "rev1", environmentDigest: "env1" })).toBeNull();
  });

  test("a restored plan resumes only against the contract still in force", () => {
    expect(restoredPlanMatchesContract({
      restoredPlan: { taskContractId: "task1", taskContractVersion: 3 },
      taskId: "task1",
      activeContractVersion: 3,
    })).toBe(true);
    expect(restoredPlanMatchesContract({
      restoredPlan: { taskContractId: "task1", taskContractVersion: 2 },
      taskId: "task1",
      activeContractVersion: 3,
    })).toBe(false);
    expect(restoredPlanMatchesContract({
      restoredPlan: { taskContractId: "other", taskContractVersion: 3 },
      taskId: "task1",
      activeContractVersion: 3,
    })).toBe(false);
    expect(restoredPlanMatchesContract({ restoredPlan: null, taskId: "task1", activeContractVersion: 3 })).toBe(false);
  });

  test("completion requires both the required predicates and the completion expression", () => {
    expect(verificationEvaluationPassed({ allRequiredPassed: true, completionExpressionSatisfied: true })).toBe(true);
    expect(verificationEvaluationPassed({ allRequiredPassed: true, completionExpressionSatisfied: false })).toBe(false);
    expect(verificationEvaluationPassed({ allRequiredPassed: false, completionExpressionSatisfied: true })).toBe(false);
  });

  test("a denied gate repairs the missing required claims, or the gate itself when none are missing", () => {
    const missing = completionGateRepairInputs({
      requiredClaimIds: ["claim:t:c1", "claim:t:c2"],
      admissibleClaimIds: ["claim:t:c1", "claim:t:extra"],
    });
    expect(missing).toEqual({ missingClaimIds: ["claim:t:c2"], failureNodeIds: ["claim:t:c2"] });

    const gateOnly = completionGateRepairInputs({
      requiredClaimIds: ["claim:t:c1"],
      admissibleClaimIds: ["claim:t:c1"],
    });
    expect(gateOnly).toEqual({ missingClaimIds: [], failureNodeIds: ["completion-gate"] });

    const allMissing = completionGateRepairInputs({
      requiredClaimIds: ["claim:t:c1", "claim:t:c2"],
      admissibleClaimIds: [],
    });
    expect(allMissing.missingClaimIds).toEqual(["claim:t:c1", "claim:t:c2"]);
    expect(allMissing.failureNodeIds).toEqual(["claim:t:c1", "claim:t:c2"]);
  });
});
