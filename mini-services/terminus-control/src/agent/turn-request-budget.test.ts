import { describe, expect, test } from "bun:test";
import {
  mergeTurnBudget,
  parsePersistedTurnBudget,
  parseTurnRequestBudget,
  serializeTurnRequestBudget,
  TurnBudgetInvalidError,
  TURN_REQUEST_FIELDS,
  turnRequestBudgetWire,
  unknownTurnRequestFields,
} from "./turn-request-budget.js";

describe("POST /v1/turns rejects what it cannot honour", () => {
  test("unknown top-level keys are named, not dropped", () => {
    // The regression: the handler cast the body, so a caller that sent a
    // budget got a 201 and no budget.
    expect(unknownTurnRequestFields({ thread_id: "t", budget: {} })).toEqual([]);
    expect(unknownTurnRequestFields({ thread_id: "t", max_steps: 5, temperature: 0.2 }))
      .toEqual(["max_steps", "temperature"]);
    expect(TURN_REQUEST_FIELDS).toContain("budget");
  });

  test("a non-object body has no fields to reject", () => {
    expect(unknownTurnRequestFields(null)).toEqual([]);
    expect(unknownTurnRequestFields([1, 2])).toEqual([]);
    expect(unknownTurnRequestFields("nope")).toEqual([]);
  });
});

describe("turn budget parsing", () => {
  test("absent means no budget, not an empty one", () => {
    expect(parseTurnRequestBudget(undefined)).toBeNull();
    expect(parseTurnRequestBudget(null)).toBeNull();
  });

  test("accepts numbers and the decimal strings this API uses for bigints", () => {
    expect(parseTurnRequestBudget({ max_steps: 40, max_tokens: "250000", max_cost_micros: 5_000_000 }))
      .toEqual({ maxSteps: 40, maxTokens: 250_000n, maxCostMicros: 5_000_000n });
    expect(parseTurnRequestBudget({ max_tokens: 1 }))
      .toEqual({ maxSteps: null, maxTokens: 1n, maxCostMicros: null });
  });

  test("a budget that bounds nothing is a mistake, not a no-op", () => {
    expect(() => parseTurnRequestBudget({})).toThrow(TurnBudgetInvalidError);
  });

  test("rejects shapes that cannot bound anything", () => {
    for (const bad of [
      { max_steps: 0 },
      { max_steps: -1 },
      { max_steps: 1.5 },
      { max_tokens: "0" },
      { max_tokens: "abc" },
      { max_tokens: true },
      { max_cost_micros: -5 },
    ]) {
      expect(() => parseTurnRequestBudget(bad)).toThrow(TurnBudgetInvalidError);
    }
    expect(() => parseTurnRequestBudget([])).toThrow(/must be an object/);
    expect(() => parseTurnRequestBudget({ max_step: 4 })).toThrow(/unknown fields: max_step/);
  });

  test("the error names the field so a caller can fix it", () => {
    try {
      parseTurnRequestBudget({ max_tokens: -1 });
      throw new Error("expected a rejection");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(TurnBudgetInvalidError);
      expect((error as TurnBudgetInvalidError).field).toBe("max_tokens");
    }
  });

  test("round trips through the persisted column", () => {
    const budget = parseTurnRequestBudget({ max_steps: 12, max_cost_micros: "900" });
    const json = serializeTurnRequestBudget(budget);
    expect(json).toBe('{"max_steps":12,"max_tokens":null,"max_cost_micros":"900"}');
    expect(parsePersistedTurnBudget(json)).toEqual(budget);
    expect(turnRequestBudgetWire(budget)).toEqual({
      max_steps: 12, max_tokens: null, max_cost_micros: "900",
    });
  });

  test("an unreadable column means no budget, never a failed turn", () => {
    expect(parsePersistedTurnBudget(null)).toBeNull();
    expect(parsePersistedTurnBudget("")).toBeNull();
    expect(parsePersistedTurnBudget("{not json")).toBeNull();
    expect(parsePersistedTurnBudget("{}")).toBeNull();
  });
});

describe("a per-turn budget tightens and never loosens", () => {
  test("the lower of the two limits wins", () => {
    expect(mergeTurnBudget(64, 40)).toBe(40);
    // A caller cannot raise the task contract's ceiling by asking for more.
    expect(mergeTurnBudget(64, 500)).toBe(64);
    expect(mergeTurnBudget(1_000n, 250n)).toBe(250n);
    expect(mergeTurnBudget(250n, 1_000n)).toBe(250n);
  });

  test("an absent limit on either side is not treated as zero", () => {
    expect(mergeTurnBudget(null, 40)).toBe(40);
    expect(mergeTurnBudget(64, null)).toBe(64);
    expect(mergeTurnBudget<number>(null, null)).toBeNull();
  });
});
