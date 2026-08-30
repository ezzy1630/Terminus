import { describe, expect, test } from "bun:test";
import {
  decideIntentOnlyRecovery,
  type IntentOnlyClaim,
  type IntentOnlyCriterion,
  type IntentOnlyRecoveryInput,
} from "./intent-only-recovery.js";

const requiredCriterion: IntentOnlyCriterion = {
  criterionId: "change-made",
  required: true,
  status: "pending",
};

const emptyClaims: readonly IntentOnlyClaim[] = [
  { criterionId: requiredCriterion.criterionId, evidenceRefs: [], changedArtifactRefs: [] },
];

function input(overrides: Partial<IntentOnlyRecoveryInput> = {}): IntentOnlyRecoveryInput {
  return {
    criteria: [requiredCriterion],
    claims: emptyClaims,
    workspaceMutationObserved: false,
    workspaceMutationAttempted: true,
    continuationAdmitted: false,
    ...overrides,
  };
}

describe("intent-only provider stop recovery", () => {
  test("admits one continuation for pending mutating work with empty evidence", () => {
    expect(decideIntentOnlyRecovery(input())).toEqual({
      kind: "continue",
      reason: "pending_required_criteria_without_workspace_mutation",
      pendingCriterionIds: ["change-made"],
    });
  });

  test("blocks explicitly when the bounded continuation repeats", () => {
    expect(decideIntentOnlyRecovery(input({ continuationAdmitted: true }))).toEqual({
      kind: "block",
      reason: "repeated_intent_only_stop",
      pendingCriterionIds: ["change-made"],
    });
  });

  test("does not recover after a successful workspace mutation", () => {
    expect(decideIntentOnlyRecovery(input({ workspaceMutationObserved: true }))).toEqual({
      kind: "ignore",
      reason: "workspace_mutation_observed",
    });
  });

  test("does not recover when required evidence is present", () => {
    expect(decideIntentOnlyRecovery(input({
      claims: [{
        criterionId: "change-made",
        evidenceRefs: ["artifact://sha256/evidence"],
        changedArtifactRefs: [],
      }],
    }))).toEqual({ kind: "ignore", reason: "evidence_present" });
  });

  test("preserves read-only and question turns even when the task may write", () => {
    expect(decideIntentOnlyRecovery(input({
      workspaceMutationAttempted: false,
    }))).toEqual({ kind: "ignore", reason: "read_only_turn" });
  });

  test("does not recover when no required criterion is pending", () => {
    expect(decideIntentOnlyRecovery(input({
      criteria: [{ ...requiredCriterion, status: "verified" }],
    }))).toEqual({ kind: "ignore", reason: "no_pending_required_criteria" });
  });

  test("still catches a denied mutation", () => {
    expect(decideIntentOnlyRecovery(input())).toEqual({
      kind: "continue",
      reason: "pending_required_criteria_without_workspace_mutation",
      pendingCriterionIds: ["change-made"],
    });
  });
});
