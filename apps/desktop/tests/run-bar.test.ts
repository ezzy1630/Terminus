import { describe, expect, test } from "vitest";
import { summarizeVerification } from "../src/components/RunBar";

describe("run bar verification summary", () => {
  test("keeps passed, failed, running, and total counts distinct", () => {
    expect(summarizeVerification([
      { state: "passed" },
      { state: "failed" },
      { state: "running" },
      { state: "passed" },
    ])).toEqual({ passed: 2, failed: 1, total: 4 });
  });

  test("does not invent checks for an empty event projection", () => {
    expect(summarizeVerification([])).toEqual({ passed: 0, failed: 0, total: 0 });
  });
});
