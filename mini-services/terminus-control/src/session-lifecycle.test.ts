import { describe, expect, test } from "bun:test";
import { canResumeSession, SESSION_STATUSES } from "./session-lifecycle.js";

describe("session lifecycle", () => {
  test("only paused sessions can resume", () => {
    for (const status of SESSION_STATUSES) {
      expect(canResumeSession(status)).toBe(status === "paused");
    }
  });
});
