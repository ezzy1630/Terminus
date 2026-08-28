import { describe, expect, test } from "bun:test";
import { repairToolArgumentsJson } from "./tool-args-repair.js";

describe("repairToolArgumentsJson", () => {
  test("passes valid JSON through unchanged", () => {
    expect(repairToolArgumentsJson(`{"path":"a.ts","limit":10}`)).toEqual({ path: "a.ts", limit: 10 });
  });

  test("repairs a trailing comma before a closer", () => {
    expect(repairToolArgumentsJson(`{"path":"a.ts","limit":10,}`)).toEqual({ path: "a.ts", limit: 10 });
  });

  test("repairs an unbalanced object (truncated call)", () => {
    expect(repairToolArgumentsJson(`{"path":"src/app.ts"`)).toEqual({ path: "src/app.ts" });
  });

  test("repairs a nested unbalanced structure with trailing comma", () => {
    expect(repairToolArgumentsJson(`{"patch":[{"old":"a","new":"b",}`)).toEqual({
      patch: [{ old: "a", new: "b" }],
    });
  });

  test("repairs a truncated string value", () => {
    expect(repairToolArgumentsJson(`{"path":"src/ma`)).toEqual({ path: "src/ma" });
  });

  test("leaves commas inside string literals untouched", () => {
    expect(repairToolArgumentsJson(`{"text":"a, } and [ unbalanced"}`)).toEqual({
      text: "a, } and [ unbalanced",
    });
  });

  test("leaves a trailing comma inside a string untouched while repairing structural one", () => {
    expect(repairToolArgumentsJson(`{"text":"x,}","n":1,}`)).toEqual({ text: "x,}", n: 1 });
  });

  test("returns null for empty input", () => {
    expect(repairToolArgumentsJson("")).toBeNull();
    expect(repairToolArgumentsJson("   ")).toBeNull();
  });

  test("returns null for unrecoverable garbage", () => {
    expect(repairToolArgumentsJson("not json at all")).toBeNull();
    expect(repairToolArgumentsJson(`{"a": `)).toBeNull();
  });

  test("returns null when JSON parses to a non-object", () => {
    expect(repairToolArgumentsJson("[1,2,3]")).toBeNull();
    expect(repairToolArgumentsJson(`"string"`)).toBeNull();
  });

  test("handles escaped quotes inside strings during repair", () => {
    expect(repairToolArgumentsJson(`{"text":"say \\"hi\\""`)).toEqual({ text: `say "hi"` });
  });
});
