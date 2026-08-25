import { describe, expect, test } from "bun:test";
import {
  HARD_MAX_STEPS,
  TurnBudget,
  planToolBatches,
} from "./turn-budget.js";
import type { ProviderToolCallChunk } from "@terminus/provider-core";

function call(id: string, toolName: string): ProviderToolCallChunk {
  return { kind: "tool_call", toolCallId: id, toolName, arguments: {} };
}

const isRead = (c: ProviderToolCallChunk) => c.toolName === "read";

describe("planToolBatches", () => {
  test("groups consecutive reads and preserves provider order", () => {
    const batches = planToolBatches(
      [call("1", "read"), call("2", "read"), call("3", "patch")],
      isRead,
    );
    expect(batches.map((batch) => batch.map((c) => c.toolCallId))).toEqual([
      ["1", "2"],
      ["3"],
    ]);
  });

  test("serializes overlapping writes in provider order", () => {
    const batches = planToolBatches(
      [call("1", "patch"), call("2", "exec"), call("3", "patch")],
      isRead,
    );
    expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1]);
    expect(batches[0]![0]!.toolCallId).toBe("1");
    expect(batches[2]![0]!.toolCallId).toBe("3");
  });

  test("a read after a write starts a new parallel group", () => {
    const batches = planToolBatches(
      [call("1", "read"), call("2", "patch"), call("3", "read")],
      isRead,
    );
    expect(batches.map((batch) => batch.map((c) => c.toolCallId))).toEqual([
      ["1"],
      ["2"],
      ["3"],
    ]);
  });

  test("empty response produces no batches", () => {
    expect(planToolBatches([], isRead)).toEqual([]);
  });
});

describe("TurnBudget", () => {
  test("allows steps up to the soft budget then stops", () => {
    const budget = new TurnBudget({ maxSteps: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(budget.canStartStep().allowed).toBe(true);
      budget.recordStep();
    }
    const decision = budget.canStartStep();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("steps_exhausted");
  });

  test("hard maximum caps a raised soft budget", () => {
    const budget = new TurnBudget({ maxSteps: 100, hardMaxSteps: HARD_MAX_STEPS });
    expect(budget.canStartStep().allowed).toBe(true);
    let guard = 0;
    while (budget.canStartStep().allowed && guard < 200) {
      budget.recordStep();
      guard += 1;
    }
    expect(guard).toBe(HARD_MAX_STEPS);
  });

  test("wall clock deadline stops the turn", () => {
    let nowMs = 1_000;
    const budget = new TurnBudget({ wallClockMs: 500, now: () => nowMs });
    expect(budget.canStartStep().allowed).toBe(true);
    nowMs = 1_600;
    const decision = budget.canStartStep();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("wall_clock_exceeded");
  });

  test("repeating the same read-only operation is stagnation", () => {
    const budget = new TurnBudget({ stagnationRepeatLimit: 2 });
    budget.recordOperation("op-a", false);
    expect(budget.isStagnant()).toBe(false);
    budget.recordOperation("op-a", false);
    expect(budget.isStagnant()).toBe(true);
  });

  test("a workspace mutation resets stagnation analysis", () => {
    const budget = new TurnBudget({ stagnationRepeatLimit: 2 });
    budget.recordOperation("op-a", false);
    budget.recordOperation("op-a", false);
    budget.recordOperation("write-1", true);
    expect(budget.isStagnant()).toBe(false);
    budget.recordOperation("op-a", false);
    expect(budget.isStagnant()).toBe(false);
  });

  test("cancel stops immediately with reason cancelled", () => {
    const budget = new TurnBudget();
    budget.cancel();
    const decision = budget.canStartStep();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("cancelled");
  });
});
