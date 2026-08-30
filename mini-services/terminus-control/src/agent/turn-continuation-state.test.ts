import { describe, expect, test } from "bun:test";
import { prepareTurnForProviderContinuation } from "./turn-continuation-state.js";

describe("prepareTurnForProviderContinuation", () => {
  test("atomically re-arms a response-validating turn", async () => {
    const calls: unknown[] = [];
    await prepareTurnForProviderContinuation({
      updateMany: async (input) => {
        calls.push(input);
        return { count: 1 };
      },
    }, "turn-1");

    expect(calls).toEqual([{
      where: { id: "turn-1", state: "RESPONSE_VALIDATING" },
      data: { state: "CONTEXT_COMPILING" },
    }]);
  });

  test("fails closed when another transition won the race", async () => {
    await expect(prepareTurnForProviderContinuation({
      updateMany: async () => ({ count: 0 }),
    }, "turn-raced")).rejects.toThrow(
      "turn turn-raced changed before provider continuation",
    );
  });
});
