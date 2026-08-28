/**
 * The cost and context readouts.
 *
 * The app had neither, while `GET /v1/tasks/:id` was already returning a
 * `budget_ledger` carrying both. These tests pin the two things most likely to
 * go wrong in a meter built on that ledger: reading cumulative token usage as
 * context occupancy, and rounding a real cost to a free-looking "$0.00".
 */
import { describe, expect, it } from "vitest";
import {
  budgetMetrics,
  formatCostMicros,
  formatTokenCount,
  primaryBudgetMetric,
} from "../src/lib/task-budget";
import type { TaskBudgetLedger } from "../src/types";

function ledger(overrides: Partial<TaskBudgetLedger> = {}): TaskBudgetLedger {
  return {
    steps_used: 3,
    max_steps: 40,
    tokens_used: "120000",
    input_tokens: "100000",
    output_tokens: "20000",
    reasoning_tokens: "0",
    cached_input_tokens: "0",
    max_tokens: "200000",
    cost_micros: "420000",
    max_cost_micros: null,
    context_headroom_tokens: "64000",
    ...overrides,
  };
}

describe("formatCostMicros", () => {
  it("never rounds a real cost down to free", () => {
    // $0.0004 shown as "$0.00" reads as "this cost nothing".
    expect(formatCostMicros(400)).toBe("$0.0004");
    expect(formatCostMicros(1)).toBe("$0.0000");
    expect(formatCostMicros(0)).toBe("$0.00");
  });

  it("uses cents once the amount is worth counting in cents", () => {
    expect(formatCostMicros(420_000)).toBe("$0.420");
    expect(formatCostMicros(1_500_000)).toBe("$1.50");
    expect(formatCostMicros(12_345_678)).toBe("$12.35");
  });
});

describe("formatTokenCount", () => {
  it("keeps small counts exact and abbreviates large ones", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_500)).toBe("1.5k");
    expect(formatTokenCount(64_000)).toBe("64k");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
  });
});

describe("budgetMetrics", () => {
  it("reports context as window occupancy, not cumulative token spend", () => {
    // tokens_used sums every turn; the window holds only the next request.
    // Reading the first as the second shows impossible percentages.
    const metrics = budgetMetrics(ledger({ tokens_used: "980000", max_tokens: "200000" }));
    const context = metrics.find((metric) => metric.id === "context");
    expect(context?.value).toBe("68%");
    expect(context?.detail).toBe("64k left of 200k");
  });

  it("degrades to raw headroom when the window size is unknown", () => {
    const metrics = budgetMetrics(ledger({ max_tokens: null }));
    const context = metrics.find((metric) => metric.id === "context");
    expect(context?.value).toBe("64k left");
    expect(context?.fraction).toBeNull();
  });

  it("omits context entirely when the control plane reports no headroom", () => {
    const metrics = budgetMetrics(ledger({ context_headroom_tokens: null }));
    expect(metrics.some((metric) => metric.id === "context")).toBe(false);
  });

  it("escalates tone as a cap is approached", () => {
    const normal = budgetMetrics(ledger({ cost_micros: "100000", max_cost_micros: "1000000" }));
    const warning = budgetMetrics(ledger({ cost_micros: "800000", max_cost_micros: "1000000" }));
    const critical = budgetMetrics(ledger({ cost_micros: "950000", max_cost_micros: "1000000" }));
    expect(normal.find((metric) => metric.id === "cost")?.tone).toBe("normal");
    expect(warning.find((metric) => metric.id === "cost")?.tone).toBe("warning");
    expect(critical.find((metric) => metric.id === "cost")?.tone).toBe("critical");
  });

  it("treats a counter too large to represent exactly as unknown", () => {
    // Silently rounding a spend figure is worse than not showing one.
    const huge = "9".repeat(30);
    expect(budgetMetrics(ledger({ cost_micros: huge })).some((metric) => metric.id === "cost")).toBe(false);
  });

  it("rejects a non-decimal counter rather than rendering NaN", () => {
    expect(budgetMetrics(ledger({ tokens_used: "12.5" })).some((metric) => metric.id === "tokens")).toBe(false);
    expect(budgetMetrics(ledger({ tokens_used: "-4" })).some((metric) => metric.id === "tokens")).toBe(false);
  });

  it("returns nothing at all when there is no ledger", () => {
    expect(budgetMetrics(null)).toEqual([]);
    expect(budgetMetrics(undefined)).toEqual([]);
  });

  it("omits the step meter when no cap is configured", () => {
    expect(budgetMetrics(ledger({ max_steps: 0 })).some((metric) => metric.id === "steps")).toBe(false);
  });
});

describe("primaryBudgetMetric", () => {
  it("shows cost when nothing is pressing", () => {
    expect(primaryBudgetMetric(ledger())?.id).toBe("cost");
  });

  it("is displaced by a context window that is filling up", () => {
    const nearlyFull = ledger({ context_headroom_tokens: "8000", max_tokens: "200000" });
    const primary = primaryBudgetMetric(nearlyFull);
    expect(primary?.id).toBe("context");
    expect(primary?.tone).toBe("critical");
  });

  it("shows the loudest of several pressing metrics", () => {
    const both = ledger({
      cost_micros: "800000",
      max_cost_micros: "1000000",
      context_headroom_tokens: "4000",
      max_tokens: "200000",
    });
    expect(primaryBudgetMetric(both)?.id).toBe("context");
  });

  it("is null when there is no ledger", () => {
    expect(primaryBudgetMetric(null)).toBeNull();
  });
});
