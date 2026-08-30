import { describe, expect, test } from "bun:test";
import {
  HARD_MAX_STEPS,
  planToolExecution,
  TurnBudget,
  planToolBatches,
} from "./turn-budget.js";
import type { ProviderToolCallChunk } from "@terminus/provider-core";
import { buildOperationObservation } from "./loop-contracts.js";

function call(id: string, toolName: string): ProviderToolCallChunk {
  return { toolCallId: id, toolName, arguments: {} };
}

const isRead = (c: ProviderToolCallChunk) => c.toolName === "read";

function observation(input: {
  readonly toolId?: string;
  readonly arguments?: unknown;
  readonly status?: "success" | "error";
  readonly resultHash?: string | null;
  readonly errorClass?: string | null;
  readonly before?: string | null;
  readonly after?: string | null;
}) {
  return buildOperationObservation({
    attemptId: "attempt-1",
    attemptNumber: 1,
    providerCallId: "call-1",
    toolId: input.toolId ?? "patch",
    status: input.status ?? "success",
    resultHash: input.resultHash === undefined ? "sha256:result" : input.resultHash,
    errorClass: input.errorClass ?? null,
    mutatesWorkspace: true,
    workspaceRevisionBefore: input.before ?? "rev-a",
    workspaceRevisionAfter: input.after ?? "rev-a",
    arguments: input.arguments ?? { path: "src/a.ts" },
  });
}

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

  test("only same-snapshot pure reads share a parallel batch", () => {
    const metadata = (c: ProviderToolCallChunk) => ({
      sideEffectClass: c.toolName === "read" ? "read" : "external",
      workspaceSnapshot: c.toolName === "read" ? "rev-a" : null,
      externalNetwork: c.toolName !== "read",
      processAffinity: null,
      consistency: c.toolName === "read" ? "workspace_snapshot" as const : "live" as const,
      rateLimitGroup: c.toolName === "web_fetch" ? "web-fetch" : null,
      cacheable: c.toolName === "read",
      expectedLatencyMs: c.toolName === "read" ? 250 : 30_000,
      expectedOutputBytes: 32 * 1_024,
    });
    const batches = planToolExecution(
      [call("1", "read"), call("2", "read"), call("3", "web_fetch"), call("4", "read")],
      metadata,
    );
    expect(batches.map((batch) => ({ ids: batch.calls.map((c) => c.toolCallId), parallel: batch.parallel }))).toEqual([
      { ids: ["1", "2"], parallel: true },
      { ids: ["3"], parallel: false },
      { ids: ["4"], parallel: false },
    ]);
  });

  test("process-affined and live reads stay ordered", () => {
    const batches = planToolExecution(
      [call("1", "exec_poll"), call("2", "exec_poll")],
      () => ({
        sideEffectClass: "read",
        workspaceSnapshot: null,
        externalNetwork: false,
        processAffinity: "job-1",
        consistency: "live",
        rateLimitGroup: null,
        cacheable: false,
        expectedLatencyMs: 30_000,
        expectedOutputBytes: 32 * 1_024,
      }),
    );
    expect(batches.map((batch) => batch.calls.map((c) => c.toolCallId))).toEqual([["1"], ["2"]]);
    expect(batches.every((batch) => !batch.parallel && batch.reason === "effect_serial")).toBe(true);
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
    // 200 steps, not 24: the old ceiling silently clamped the configured
    // budget and killed real coding turns mid-edit with steps_exhausted.
    expect(HARD_MAX_STEPS).toBe(200);
    const budget = new TurnBudget({ maxSteps: HARD_MAX_STEPS + 500, hardMaxSteps: HARD_MAX_STEPS });
    expect(budget.canStartStep().allowed).toBe(true);
    let guard = 0;
    while (budget.canStartStep().allowed && guard < HARD_MAX_STEPS + 100) {
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

  test("typed observations detect no-op writes and reset on a real revision change", () => {
    const budget = new TurnBudget({ stagnationRepeatLimit: 2 });
    const first = budget.recordObservation(observation({}));
    const second = budget.recordObservation(observation({}));
    expect(first.progressed).toBe(true);
    expect(second).toMatchObject({
      progressed: false,
      noOp: true,
      reason: "no_op",
      recommendedRecovery: ["change_hypothesis", "inspect_evidence", "rollback", "stop"],
    });
    expect(budget.isStagnant()).toBe(false);
    const third = budget.recordObservation(observation({}));
    expect(third.progressed).toBe(false);
    expect(budget.isStagnant()).toBe(true);

    const changed = budget.recordObservation(observation({ before: "rev-a", after: "rev-b" }));
    expect(changed).toMatchObject({ progressed: true, reason: "workspace_changed" });
    expect(budget.isStagnant()).toBe(false);
  });

  test("typed observations detect a repeated failure class across different calls", () => {
    const budget = new TurnBudget({ stagnationRepeatLimit: 2 });
    budget.recordObservation(observation({
      toolId: "read",
      arguments: { path: "src/a.ts" },
      status: "error",
      resultHash: null,
      errorClass: "verification_failure",
    }));
    const analysis = budget.recordObservation(observation({
      toolId: "search",
      arguments: { query: "same symbol" },
      status: "error",
      resultHash: null,
      errorClass: "verification_failure",
    }));
    expect(analysis).toMatchObject({ progressed: false, repeatedFailure: true, reason: "repeated_failure" });
  });

  test("typed observations detect A-B-A-B oscillation", () => {
    const budget = new TurnBudget();
    const record = (toolId: string) => budget.recordObservation(observation({ toolId, arguments: { path: toolId } }));
    record("patch-a");
    record("patch-b");
    record("patch-a");
    const analysis = record("patch-b");
    expect(analysis).toMatchObject({ progressed: false, oscillating: true, reason: "oscillation" });
  });

  test("ledger accounts usage, context headroom, evidence, and final reserves", () => {
    const budget = new TurnBudget({
      maxSteps: 4,
      maxTokens: 100n,
      maxCostMicros: 50n,
      contextHeadroomTokens: 80n,
      finalVerificationReserveTokens: 20n,
      finalVerificationReserveCostMicros: 10n,
      minExpectedValue: 0.5,
    });
    budget.recordUsage({ inputTokens: 40n, outputTokens: 10n, costMicros: 15n });
    budget.recordContextUsage(65n);
    budget.recordEvidence({
      outstandingCriteria: 1,
      verificationFailures: 1,
      repairAttempts: 1,
      expectedValue: 0.8,
      reliability: 0.75,
      providerReliability: 0.9,
      toolReliability: 0.8,
    });
    expect(budget.ledger).toMatchObject({
      tokensUsed: 50n,
      costMicros: 15n,
      contextHeadroomTokens: 15n,
      finalVerificationReserveTokens: 20n,
      finalVerificationReserveCostMicros: 10n,
      evidence: {
        outstandingCriteria: 1,
        repairAttempts: 1,
        expectedValue: 0.8,
      },
    });
    expect(budget.canStartStep().allowed).toBe(false);
    expect(budget.canStartStep().reason).toBe("context_headroom_exhausted");
  });

  test("evidence expected value can stop an otherwise available attempt", () => {
    const budget = new TurnBudget({ maxSteps: 2, minExpectedValue: 0.6 });
    budget.recordEvidence({ outstandingCriteria: 1, expectedValue: 0.2 });
    expect(budget.canStartStep()).toEqual({ allowed: false, reason: "expected_value_too_low" });
  });
});
