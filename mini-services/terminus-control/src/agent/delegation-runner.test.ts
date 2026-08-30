import { describe, expect, test } from "bun:test";
import {
  InMemoryDelegationStepAccountant,
  SCOUT_TOOL_NAMES,
  runBoundedDelegation,
  type DelegationAuthority,
} from "./delegation-runner.js";

const authority: DelegationAuthority = {
  allowedTools: SCOUT_TOOL_NAMES,
  allowedReadPaths: ["src/**"],
  allowedWritePaths: [],
  deniedEffects: ["write", "execute"],
};

function identity(attemptIdForStep: (step: number) => string = (step) => `attempt-${step}`) {
  return { parentTaskId: "task-1", delegationId: "delegation-1", attemptIdForStep };
}

function providerSequence() {
  let step = 0;
  return async () => {
    const current = step;
    step += 1;
    return {
      projectedText: `step-${current}`,
      toolCalls: current === 0 ? [{ toolName: "read", argumentsJson: "{}" }] : [],
      usage: { inputTokens: 10n, outputTokens: 2n, costMicros: 3n },
    };
  };
}

describe("bounded delegation runner", () => {
  test("aggregates usage across provider steps and settles each attempt", async () => {
    const accountant = new InMemoryDelegationStepAccountant();
    const toolIdentities: string[] = [];
    const result = await runBoundedDelegation({
      identity: identity(),
      authority,
      budget: { maxSteps: 4, maxTokens: 100n, maxCostMicros: 100n },
      accountant,
      callProvider: providerSequence(),
      executeTool: async ({ attemptId, callIndex }) => {
        toolIdentities.push(`${attemptId}:tool:${callIndex}`);
        return { ok: true, resultText: "read output" };
      },
    });
    expect(result.status).toBe("completed");
    expect(result.usage.inputTokens).toBe(20n);
    expect(result.usage.outputTokens).toBe(4n);
    expect(result.usage.costMicros).toBe(6n);
    expect(accountant.starts.map((entry) => entry.attemptId)).toEqual(["attempt-0", "attempt-1"]);
    expect(accountant.settlements.every((entry) => entry.status === "settled")).toBe(true);
    expect(toolIdentities).toEqual(["attempt-0:tool:0"]);
  });

  test("stops before another provider call when aggregate token budget is exhausted", async () => {
    let calls = 0;
    const accountant = new InMemoryDelegationStepAccountant();
    const result = await runBoundedDelegation({
      identity: identity(),
      authority,
      budget: { maxSteps: 4, maxTokens: 11n, maxCostMicros: null },
      accountant,
      callProvider: async () => {
        calls += 1;
        return { projectedText: "tool", toolCalls: [{ toolName: "read", argumentsJson: "{}" }], usage: { inputTokens: 10n, outputTokens: 2n } };
      },
      executeTool: async () => ({ ok: true, resultText: "read output" }),
    });
    expect(result.status).toBe("budget_exhausted");
    expect(calls).toBe(1);
    expect(result.stepReceipts[0]?.status).toBe("failed");
  });

  test("fails closed for a provider-requested unsafe tool", async () => {
    const accountant = new InMemoryDelegationStepAccountant();
    const result = await runBoundedDelegation({
      identity: identity(),
      authority,
      budget: { maxSteps: 2, maxTokens: null, maxCostMicros: null },
      accountant,
      callProvider: async () => ({ projectedText: "patch", toolCalls: [{ toolName: "patch", argumentsJson: "{}" }] }),
      executeTool: async () => ({ ok: true, resultText: "must not run" }),
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("not available");
    expect(accountant.settlements[0]?.status).toBe("failed");
  });

  test("propagates cancellation and settles the in-flight provider attempt", async () => {
    const controller = new AbortController();
    const accountant = new InMemoryDelegationStepAccountant();
    const resultPromise = runBoundedDelegation({
      identity: identity(),
      authority,
      budget: { maxSteps: 2, maxTokens: null, maxCostMicros: null },
      accountant,
      signal: controller.signal,
      callProvider: async ({ signal }) => new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("provider observed cancellation")), { once: true });
        setTimeout(() => resolve({ projectedText: "late", toolCalls: [] }), 30);
      }),
      executeTool: async () => ({ ok: true, resultText: "unused" }),
    });
    controller.abort();
    const result = await resultPromise;
    expect(result.status).toBe("cancelled");
    expect(accountant.settlements[0]?.status).toBe("cancelled");
  });

  test("rejects duplicate deterministic attempt ids", async () => {
    const accountant = new InMemoryDelegationStepAccountant();
    const result = await runBoundedDelegation({
      identity: identity(() => "same-attempt"),
      authority,
      budget: { maxSteps: 2, maxTokens: null, maxCostMicros: null },
      accountant,
      callProvider: async () => ({ projectedText: "tool", toolCalls: [{ toolName: "read", argumentsJson: "{}" }] }),
      executeTool: async () => ({ ok: true, resultText: "read output" }),
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("duplicate");
  });
});
