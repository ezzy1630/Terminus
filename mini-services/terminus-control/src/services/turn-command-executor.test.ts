import { describe, expect, test } from "bun:test";
import {
  createTurnAttemptLedger,
  TurnCommandExecutor,
  planProviderContinuation,
} from "./turn-coordinator.js";

describe("turn command executor", () => {
  test("provider-continuation plan re-arms only from RESPONSE_VALIDATING", () => {
    const plan = planProviderContinuation({ turnId: "t1", taskId: "task1" });
    expect(plan.expectedStates).toEqual(["RESPONSE_VALIDATING"]);
    expect(plan.nextState).toBe("CONTEXT_COMPILING");
    expect(plan.payload).toEqual({ phase: "context_compiling", reason: "provider_continuation" });
    expect(plan.conflictError).toBe("turn t1 changed before provider continuation");
  });

  test("rearmForProviderContinuation emits the re-arm event inside its mutation and fails closed on a CAS miss", async () => {
    const emitted: { eventType: string; payload: unknown }[] = [];
    let casResult = 1;
    const executor = new TurnCommandExecutor({
      mutate: (op) => Promise.resolve(op()),
      emit: async (input, mutation) => {
        emitted.push({ eventType: input.eventType, payload: input.payload });
        // The real bus publishes the event atomically with its mutation.
        if (mutation !== undefined) await mutation({});
        return input;
      },
      rearmProviderContinuation: () => {
        if (casResult !== 1) return Promise.reject(new Error("turn t1 changed before provider continuation"));
        return Promise.resolve(casResult);
      },
    });

    await executor.rearmForProviderContinuation({ turnId: "t1", taskId: "task1" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.eventType).toBe("turn.context_compiling");
    expect(emitted[0]!.payload).toEqual({ phase: "context_compiling", reason: "provider_continuation" });

    // A re-delivered continuation when the turn moved on must throw the
    // original CAS error, not silently recompile a second generation.
    casResult = 0;
    await expect(
      executor.rearmForProviderContinuation({ turnId: "t1", taskId: "task1" }),
    ).rejects.toThrow("turn t1 changed before provider continuation");
  });

  test("the attempt ledger starts empty per turn and records exactly-once tool-settlement entry", () => {
    const ledger = createTurnAttemptLedger();
    expect(ledger.declaredToolSchemasByAttempt.size).toBe(0);
    expect(ledger.settlementByProviderCallId.size).toBe(0);
    expect(ledger.toolSettlementEnteredFor.has("a1")).toBe(false);
    ledger.toolSettlementEnteredFor.add("a1");
    expect(ledger.toolSettlementEnteredFor.has("a1")).toBe(true);
    // A second ledger instance never sees another turn's entries.
    expect(createTurnAttemptLedger().toolSettlementEnteredFor.has("a1")).toBe(false);
  });

  test("executor instances do not share attempt state", () => {
    const first = new TurnCommandExecutor({
      mutate: (op) => Promise.resolve(op()),
      emit: (input) => Promise.resolve(input),
      rearmProviderContinuation: () => Promise.resolve(1),
    });
    const second = new TurnCommandExecutor({
      mutate: (op) => Promise.resolve(op()),
      emit: (input) => Promise.resolve(input),
      rearmProviderContinuation: () => Promise.resolve(1),
    });
    first.ledger.predictedCacheByAttempt.set("a1", 100n);
    expect(second.ledger.predictedCacheByAttempt.has("a1")).toBe(false);
  });
});
