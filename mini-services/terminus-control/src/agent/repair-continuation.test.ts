import { describe, expect, test } from "bun:test";
import { remainingRepairBudget, repairPinMismatches } from "./repair-continuation.js";

describe("repair continuation budget", () => {
  test("carries only unused effective limits into the repair", () => {
    expect(remainingRepairBudget({
      stepsUsed: 5,
      maxSteps: 50,
      tokensUsed: 23_959n,
      maxTokens: 200_000n,
      costMicros: 120n,
      maxCostMicros: 5_000_000n,
    })).toEqual({
      kind: "available",
      budget: {
        maxSteps: 45,
        maxTokens: 176_041n,
        maxCostMicros: 4_999_880n,
      },
    });
  });

  test("preserves genuinely unbounded token and cost dimensions", () => {
    expect(remainingRepairBudget({
      stepsUsed: 1,
      maxSteps: 8,
      tokensUsed: 9n,
      maxTokens: null,
      costMicros: 10n,
      maxCostMicros: null,
    })).toEqual({
      kind: "available",
      budget: { maxSteps: 7, maxTokens: null, maxCostMicros: null },
    });
  });

  test("fails closed when any effective dimension is exhausted", () => {
    expect(remainingRepairBudget({
      stepsUsed: 8, maxSteps: 8, tokensUsed: 1n, maxTokens: 2n, costMicros: 0n, maxCostMicros: null,
    })).toEqual({ kind: "exhausted", dimension: "steps" });
    expect(remainingRepairBudget({
      stepsUsed: 1, maxSteps: 8, tokensUsed: 2n, maxTokens: 2n, costMicros: 0n, maxCostMicros: null,
    })).toEqual({ kind: "exhausted", dimension: "tokens" });
    expect(remainingRepairBudget({
      stepsUsed: 1, maxSteps: 8, tokensUsed: 1n, maxTokens: null, costMicros: 3n, maxCostMicros: 3n,
    })).toEqual({ kind: "exhausted", dimension: "cost" });
  });
});

describe("repair continuation pins", () => {
  const expected = {
    selectedModel: "hy3-free",
    selectedReasoningEffort: "high",
    selectedProviderAccountId: "zen-account",
    requestedBudgetJson: '{"max_steps":45}',
  } as const;

  test("accepts exact durable identity", () => {
    expect(repairPinMismatches(expected, { ...expected })).toEqual([]);
  });

  test("names every drifted field", () => {
    expect(repairPinMismatches(expected, {
      selectedModel: "other",
      selectedReasoningEffort: null,
      selectedProviderAccountId: "zen-account",
      requestedBudgetJson: null,
    })).toEqual(["selectedModel", "selectedReasoningEffort", "requestedBudgetJson"]);
  });
});
