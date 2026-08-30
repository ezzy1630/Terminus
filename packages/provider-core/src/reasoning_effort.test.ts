import { describe, expect, test } from "bun:test";

import { parseReasoningEffort, REASONING_EFFORTS } from "./index.js";

describe("reasoning effort", () => {
  test("preserves xhigh as a distinct provider-neutral depth", () => {
    expect(REASONING_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(parseReasoningEffort("xhigh")).toBe("xhigh");
    expect(parseReasoningEffort("ultra")).toBe("ultra");
  });
});
