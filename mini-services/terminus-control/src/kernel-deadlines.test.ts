import { describe, expect, test } from "bun:test";
import {
  DIRECT_EXEC_DEFAULT_TIMEOUT_MS,
  DIRECT_JOB_DEFAULT_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_STREAMING_KERNEL_DEADLINE_MS,
  MIN_STREAMING_KERNEL_DEADLINE_MS,
  UNARY_KERNEL_DEADLINE_MS,
  kernelDeadline,
  kernelDeadlineMs,
  resolveCommandTimeoutMs,
  turnRemainingMs,
  withTurnDeadline,
} from "./kernel-deadlines.js";

describe("H10 command timeouts are bounded and explicit", () => {
  test("the declared defaults are exec 120 s and job 30 min", () => {
    expect(DIRECT_EXEC_DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(DIRECT_JOB_DEFAULT_TIMEOUT_MS).toBe(1_800_000);
    expect(MAX_COMMAND_TIMEOUT_MS).toBe(1_800_000);
  });

  test("an absent timeout takes the route's default", () => {
    expect(resolveCommandTimeoutMs(undefined, DIRECT_EXEC_DEFAULT_TIMEOUT_MS))
      .toEqual({ ok: true, timeoutMs: 120_000 });
    expect(resolveCommandTimeoutMs(null, DIRECT_JOB_DEFAULT_TIMEOUT_MS))
      .toEqual({ ok: true, timeoutMs: 1_800_000 });
  });

  test("an in-range caller timeout is honoured exactly", () => {
    expect(resolveCommandTimeoutMs(5_000, DIRECT_EXEC_DEFAULT_TIMEOUT_MS))
      .toEqual({ ok: true, timeoutMs: 5_000 });
  });

  test("an over-range timeout is rejected, never silently clamped", () => {
    const resolved = resolveCommandTimeoutMs(MAX_COMMAND_TIMEOUT_MS + 1, DIRECT_EXEC_DEFAULT_TIMEOUT_MS);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false ? resolved.reason : "").toContain("1800000");
  });

  test("non-integer, zero, and negative timeouts are rejected with a reason", () => {
    for (const value of [0, -1, 1.5, "120000", {}]) {
      const resolved = resolveCommandTimeoutMs(value, DIRECT_EXEC_DEFAULT_TIMEOUT_MS);
      expect(`${JSON.stringify(value)}:${resolved.ok}`).toBe(`${JSON.stringify(value)}:false`);
      expect(resolved.ok === false ? resolved.reason.length > 0 : false).toBe(true);
    }
  });
});

describe("H10 kernel RPCs carry a deadline", () => {
  test("a state-reading unary RPC gets the 30 s bound", () => {
    expect(UNARY_KERNEL_DEADLINE_MS).toBe(30_000);
    expect(kernelDeadlineMs({
      qualifiedMethod: "terminus.kernel.v1.FileService/Read",
      streaming: false,
    })).toBe(30_000);
  });

  test("provider dispatch is not held to the unary bound", () => {
    expect(kernelDeadlineMs({
      qualifiedMethod: "terminus.kernel.v1.ConnectorService/Execute",
      streaming: false,
      remainingMs: 10 * 60_000,
    })).toBe(10 * 60_000);
  });

  test("a streaming RPC tracks the remaining turn budget", () => {
    expect(kernelDeadlineMs({
      qualifiedMethod: "terminus.kernel.v1.ProcessService/Start",
      streaming: true,
      remainingMs: 90_000,
    })).toBe(90_000);
  });

  test("the streaming deadline is capped at 30 minutes", () => {
    expect(kernelDeadlineMs({
      qualifiedMethod: "terminus.kernel.v1.ProcessService/Start",
      streaming: true,
      remainingMs: 6 * 60 * 60_000,
    })).toBe(MAX_STREAMING_KERNEL_DEADLINE_MS);
  });

  test("an exhausted turn budget still yields a positive deadline", () => {
    expect(kernelDeadlineMs({
      qualifiedMethod: "terminus.kernel.v1.JobService/Stream",
      streaming: true,
      remainingMs: -5_000,
    })).toBe(MIN_STREAMING_KERNEL_DEADLINE_MS);
  });

  test("outside a turn a streaming RPC falls back to the 30 minute ceiling", () => {
    expect(turnRemainingMs()).toBeNull();
    expect(kernelDeadlineMs({
      qualifiedMethod: "terminus.kernel.v1.JobService/Stream",
      streaming: true,
    })).toBe(MAX_STREAMING_KERNEL_DEADLINE_MS);
  });

  test("withTurnDeadline scopes the remaining budget to its callback", async () => {
    const observed = await withTurnDeadline(120_000, async () => {
      // Asynchronous work inside the turn still sees the deadline.
      await Promise.resolve();
      return kernelDeadlineMs({
        qualifiedMethod: "terminus.kernel.v1.JobService/Stream",
        streaming: true,
      });
    });
    expect(observed).toBeLessThanOrEqual(120_000);
    expect(observed).toBeGreaterThan(119_000);
    expect(turnRemainingMs()).toBeNull();
  });

  test("concurrent turns do not share a deadline", async () => {
    const [short, long] = await Promise.all([
      withTurnDeadline(60_000, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return kernelDeadlineMs({ qualifiedMethod: "x/Y", streaming: true });
      }),
      withTurnDeadline(600_000, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return kernelDeadlineMs({ qualifiedMethod: "x/Y", streaming: true });
      }),
    ]);
    expect(short).toBeLessThan(61_000);
    expect(long).toBeGreaterThan(590_000);
  });

  test("kernelDeadline returns an absolute grpc deadline", () => {
    const at = kernelDeadline({
      qualifiedMethod: "terminus.kernel.v1.FileService/Read",
      streaming: false,
      now: () => 1_000_000,
    });
    expect(at.getTime()).toBe(1_030_000);
  });
});
