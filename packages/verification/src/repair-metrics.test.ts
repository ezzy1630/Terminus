import { describe, expect, test } from "bun:test";
import { deriveRepairMetrics } from "./repair-metrics.js";

describe("deriveRepairMetrics", () => {
  test("distinguishes a first-proposal verified success", () => {
    const metrics = deriveRepairMetrics({
      taskStatus: "COMPLETED",
      terminalReason: null,
      completionAdmissionCommitted: true,
      finalRequiredPredicatesPassed: true,
      repairAttempts: [],
      repairProviderAttempts: [],
      repairTurns: [],
    });
    expect(metrics.firstProposalVerifiedSuccess).toBe(true);
    expect(metrics.repairSuccess).toBe(false);
    expect(metrics.outcomeClass).toBe("first_proposal_success");
    expect(metrics.falsePositiveCompletion).toBe(false);
    expect(metrics.usage).toEqual({
      additionalInputTokens: "0",
      additionalOutputTokens: "0",
      additionalCostMicros: "0",
      additionalDurationMs: 0,
    });
  });

  test("sums repair usage and flags repeated failure without losing exact values", () => {
    const metrics = deriveRepairMetrics({
      taskStatus: "COMPLETED",
      terminalReason: null,
      completionAdmissionCommitted: true,
      finalRequiredPredicatesPassed: true,
      repairAttempts: [
        { attemptNumber: 1, state: "SUCCEEDED", failureSignatures: ["sig-a"], terminalReason: null },
        { attemptNumber: 2, state: "SUCCEEDED", failureSignatures: ["sig-a"], terminalReason: null },
      ],
      repairProviderAttempts: [
        { inputTokens: "9007199254740993", outputTokens: "12", costMicros: "100" },
        { inputTokens: "7", outputTokens: "8", costMicros: "250" },
      ],
      repairTurns: [
        { startedAtMs: 10, completedAtMs: 35 },
        { startedAtMs: 40, completedAtMs: 60 },
      ],
    });
    expect(metrics.firstProposalVerifiedSuccess).toBe(false);
    expect(metrics.repairSuccess).toBe(true);
    expect(metrics.outcomeClass).toBe("repair_success");
    expect(metrics.repeatedFailure).toBe(true);
    expect(metrics.repeatedFailureCount).toBe(1);
    expect(metrics.usage).toEqual({
      additionalInputTokens: "9007199254741000",
      additionalOutputTokens: "20",
      additionalCostMicros: "350",
      additionalDurationMs: 45,
    });
  });

  test("keeps unavailable repair cost and usage explicit", () => {
    const metrics = deriveRepairMetrics({
      taskStatus: "FAILED_VERIFICATION",
      terminalReason: "no_progress_repeated_failure",
      completionAdmissionCommitted: false,
      finalRequiredPredicatesPassed: false,
      repairAttempts: [
        { attemptNumber: 1, state: "FAILED", failureSignatures: ["sig-a"], terminalReason: null },
      ],
      repairProviderAttempts: [
        { inputTokens: null, outputTokens: "4", costMicros: null },
      ],
      repairTurns: [
        { startedAtMs: 10, completedAtMs: null },
      ],
      expectedOutcomeClass: "blocked",
    });
    expect(metrics.outcomeClass).toBe("failed_verification");
    expect(metrics.stopReason).toBe("no_progress_repeated_failure");
    expect(metrics.classificationCorrect).toBe(false);
    expect(metrics.repeatedFailure).toBe(true);
    expect(metrics.usage.additionalInputTokens).toBeNull();
    expect(metrics.usage.additionalCostMicros).toBeNull();
    expect(metrics.usage.additionalDurationMs).toBeNull();
  });

  test("flags an impossible completion admission as a false positive", () => {
    const metrics = deriveRepairMetrics({
      taskStatus: "COMPLETED",
      terminalReason: null,
      completionAdmissionCommitted: true,
      finalRequiredPredicatesPassed: false,
      repairAttempts: [],
      repairProviderAttempts: [],
      repairTurns: [],
    });
    expect(metrics.outcomeClass).toBe("unknown");
    expect(metrics.falsePositiveCompletion).toBe(true);
    expect(metrics.firstProposalVerifiedSuccess).toBe(false);
  });
});
