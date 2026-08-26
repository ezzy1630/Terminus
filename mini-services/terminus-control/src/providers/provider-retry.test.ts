import { describe, expect, test } from "bun:test";
import {
  backoffDelayMs,
  isRetryableProviderError,
  retryAfterMsFromError,
  statusFromProviderError,
  withProviderRetry,
} from "./provider-retry.js";

describe("R6 provider retry classification", () => {
  test("status extraction from direct-transport messages", () => {
    expect(statusFromProviderError(new Error("direct provider returned HTTP 429: rate limited"))).toBe(429);
    expect(statusFromProviderError(new Error("direct provider returned HTTP 503"))).toBe(503);
    expect(statusFromProviderError(new Error("direct provider returned HTTP 401: bad key"))).toBe(401);
    expect(statusFromProviderError(new Error("socket hang up"))).toBeNull();
  });

  test("retryable: transient statuses, network faults, grant expiry; not auth/validation", () => {
    for (const good of [
      new Error("direct provider returned HTTP 429"),
      new Error("direct provider returned HTTP 500"),
      new Error("direct provider returned HTTP 502"),
      new Error("direct provider returned HTTP 529"),
      new Error("connect ECONNRESET"),
      new Error("dispatch timed out"),
      new Error("kernel returned an empty connector grant"),
    ]) {
      expect(isRetryableProviderError(good)).toBe(true);
    }
    for (const bad of [
      new Error("direct provider returned HTTP 400: invalid_request_error"),
      new Error("direct provider returned HTTP 401: authentication_error"),
      new Error("ANTHROPIC_API_KEY is not set"),
      "not an error",
    ]) {
      expect(isRetryableProviderError(bad)).toBe(false);
    }
  });

  test("retry-after hints parse and cap", () => {
    expect(retryAfterMsFromError(new Error("HTTP 429 (retry-after 12s)"))).toBe(12_000);
    expect(retryAfterMsFromError(new Error("HTTP 429"))).toBeNull();
  });

  test("backoff grows exponentially with jitter inside half-to-full band", () => {
    let call = 0;
    const delay = backoffDelayMs(3, { baseDelayMs: 100, maxDelayMs: 10_000, jitter: () => (call += 1, 0.5) });
    // attempt 3 → exponential 400ms; jitter 0.5 → midpoint 300ms.
    expect(delay).toBeGreaterThanOrEqual(200);
    expect(delay).toBeLessThanOrEqual(400);
  });
});

describe("R6 withProviderRetry", () => {
  test("retries transient faults and succeeds within budget", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await withProviderRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("direct provider returned HTTP 503");
        return "ok";
      },
      { sleep: async (ms) => sleeps.push(ms) },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleeps.length).toBe(2);
  });

  test("non-retryable faults fail fast without burning attempts", async () => {
    let attempts = 0;
    await expect(
      withProviderRetry(
        async () => {
          attempts += 1;
          throw new Error("direct provider returned HTTP 401: authentication_error");
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow(/after 1 attempt/);
    expect(attempts).toBe(1);
  });

  test("exhausting the budget wraps the last error", async () => {
    let attempts = 0;
    await expect(
      withProviderRetry(
        async () => {
          attempts += 1;
          throw new Error("direct provider returned HTTP 429");
        },
        { maxAttempts: 3, sleep: async () => undefined },
      ),
    ).rejects.toThrow(/after 3 attempt/);
    expect(attempts).toBe(3);
  });
});
