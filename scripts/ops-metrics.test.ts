import { describe, expect, test } from "bun:test";
import { aggregateRepairMetrics, type RepairMetricsAggregateInput } from "./ops-metrics.ts";

function record(
  overrides: Partial<RepairMetricsAggregateInput> = {},
): RepairMetricsAggregateInput {
  return {
    firstProposalVerifiedSuccess: null,
    repairSuccess: null,
    repairAttemptCount: 0,
    repeatedFailure: false,
    falsePositiveCompletion: false,
    outcomeClass: "unknown",
    classificationCorrect: null,
    usage: {
      additionalInputTokens: "0",
      additionalOutputTokens: "0",
      additionalCostMicros: "0",
      additionalDurationMs: 0,
    },
    ...overrides,
  };
}

describe("aggregateRepairMetrics", () => {
  test("returns an explicit empty aggregate without inventing usage", () => {
    const aggregate = aggregateRepairMetrics([]);

    expect(aggregate.tasksObserved).toBe(0);
    expect(aggregate.repairAttemptCount).toBe(0);
    expect(aggregate.usage).toEqual({
      additionalInputTokens: null,
      additionalOutputTokens: null,
      additionalCostMicros: null,
      additionalDurationMs: null,
    });
    expect(Object.values(aggregate.outcomeCounts).every((count) => count === 0)).toBe(true);
  });

  test("aggregates exact repair counts, outcomes, usage, and duration", () => {
    const aggregate = aggregateRepairMetrics([
      record({
        firstProposalVerifiedSuccess: true,
        outcomeClass: "first_proposal_success",
        classificationCorrect: true,
      }),
      record({
        repairSuccess: true,
        repairAttemptCount: 2,
        repeatedFailure: true,
        outcomeClass: "repair_success",
        classificationCorrect: true,
        usage: {
          additionalInputTokens: "12345678901234567890",
          additionalOutputTokens: "8",
          additionalCostMicros: "11",
          additionalDurationMs: 41,
        },
      }),
      record({
        repairAttemptCount: 1,
        repeatedFailure: true,
        falsePositiveCompletion: true,
        outcomeClass: "failed_verification",
        classificationCorrect: false,
        usage: {
          additionalInputTokens: "2",
          additionalOutputTokens: "3",
          additionalCostMicros: "5",
          additionalDurationMs: 7,
        },
      }),
    ]);

    expect(aggregate.tasksObserved).toBe(3);
    expect(aggregate.tasksWithRepairs).toBe(2);
    expect(aggregate.repairAttemptCount).toBe(3);
    expect(aggregate.firstProposalVerifiedSuccess).toBe(1);
    expect(aggregate.repairSuccess).toBe(1);
    expect(aggregate.repeatedFailure).toBe(2);
    expect(aggregate.falsePositiveCompletion).toBe(1);
    expect(aggregate.outcomeCounts.first_proposal_success).toBe(1);
    expect(aggregate.outcomeCounts.repair_success).toBe(1);
    expect(aggregate.outcomeCounts.failed_verification).toBe(1);
    expect(aggregate.classificationCorrect).toBe(2);
    expect(aggregate.classificationObserved).toBe(3);
    expect(aggregate.usage).toEqual({
      additionalInputTokens: "12345678901234567892",
      additionalOutputTokens: "11",
      additionalCostMicros: "16",
      additionalDurationMs: 48,
    });
    expect(aggregate.missingUsage).toEqual({
      inputTokenTasks: 0,
      outputTokenTasks: 0,
      costTasks: 0,
      durationTasks: 0,
    });
  });

  test("keeps each aggregate null when a repaired task lacks that measurement", () => {
    const aggregate = aggregateRepairMetrics([
      record({
        repairAttemptCount: 1,
        outcomeClass: "blocked",
        usage: {
          additionalInputTokens: null,
          additionalOutputTokens: "4",
          additionalCostMicros: null,
          additionalDurationMs: null,
        },
      }),
    ]);

    expect(aggregate.usage).toEqual({
      additionalInputTokens: null,
      additionalOutputTokens: "4",
      additionalCostMicros: null,
      additionalDurationMs: null,
    });
    expect(aggregate.missingUsage).toEqual({
      inputTokenTasks: 1,
      outputTokenTasks: 0,
      costTasks: 1,
      durationTasks: 1,
    });
  });
});
