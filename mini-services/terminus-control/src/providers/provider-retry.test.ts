import { describe, expect, test } from "bun:test";
import {
  abortableSleep,
  backoffDelayMs,
  isRetryableProviderError,
  providerCodeFromError,
  ProviderTransportError,
  RetryAbortedError,
  RetryBudgetExhaustedError,
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
      { sleep: async (ms) => { sleeps.push(ms); } },
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

describe("H2 structured transport errors", () => {
  // The exact string recorded in .terminus-dev/control.db for the failed turn.
  const RECORDED = "server_error: Streaming response failed: [502] Upstream error from Nvidia";

  test("the recorded gateway failure is classified retryable with a 502", () => {
    const structured = ProviderTransportError.fromProviderErrorChunk({
      errorCode: "server_error",
      errorMessage: "Streaming response failed: [502] Upstream error from Nvidia",
      fallbackMessage: "gateway provider failed",
    });
    expect(structured.message).toBe(RECORDED);
    expect(structured.status).toBe(502);
    expect(structured.providerCode).toBe("server_error");
    expect(statusFromProviderError(structured)).toBe(502);
    expect(isRetryableProviderError(structured)).toBe(true);
  });

  test("the same failure is still retryable when only the prose survives", () => {
    const plain = new Error(RECORDED);
    expect(statusFromProviderError(plain)).toBe(502);
    expect(providerCodeFromError(plain)).toBe("server_error");
    expect(isRetryableProviderError(plain)).toBe(true);
  });

  test("provider codes without a status are classified", () => {
    expect(isRetryableProviderError(
      new ProviderTransportError("overloaded_error: model is overloaded", { providerCode: "overloaded_error" }),
    )).toBe(true);
    expect(isRetryableProviderError(
      new ProviderTransportError("invalid_request_error: bad tool schema", { providerCode: "invalid_request_error" }),
    )).toBe(false);
  });

  test("4xx stays terminal even when the code looks transient", () => {
    const structured = new ProviderTransportError("server_error: nope", { status: 400, providerCode: "server_error" });
    expect(isRetryableProviderError(structured)).toBe(false);
  });

  test("structured retry-after wins over the message text", () => {
    const structured = new ProviderTransportError("rate limited retry-after 30s", {
      status: 429,
      retryAfterMs: 2_000,
      providerCode: "rate_limit_error",
    });
    expect(retryAfterMsFromError(structured)).toBe(2_000);
    expect(retryAfterMsFromError(new Error("rate limited; retry-after: 3s"))).toBe(3_000);
    expect(retryAfterMsFromError(new Error("rate limited; retry-after 5"))).toBe(5_000);
  });

  test("the recorded failure now consumes the whole retry budget", async () => {
    let attempts = 0;
    const delays: number[] = [];
    await expect(withProviderRetry(
      async () => {
        attempts += 1;
        throw ProviderTransportError.fromProviderErrorChunk({
          errorCode: "server_error",
          errorMessage: "Streaming response failed: [502] Upstream error from Nvidia",
          fallbackMessage: "gateway provider failed",
        });
      },
      { maxAttempts: 3, jitter: () => 0, sleep: async (ms) => { delays.push(ms); } },
    )).rejects.toBeInstanceOf(RetryBudgetExhaustedError);
    expect(attempts).toBe(3);
    expect(delays.length).toBe(2);
  });

  test("retry budget exhaustion preserves the original error as cause", async () => {
    const original = new ProviderTransportError("server_error: boom", { status: 503 });
    const failure = await withProviderRetry(
      async () => { throw original; },
      { maxAttempts: 2, jitter: () => 0, sleep: async () => {} },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RetryBudgetExhaustedError);
    expect((failure as RetryBudgetExhaustedError).cause).toBe(original);
    expect((failure as RetryBudgetExhaustedError).lastError).toBe(original);
  });

  test("an aborted turn stops the retry loop instead of sleeping out the backoff", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const failure = await withProviderRetry(
      async () => {
        attempts += 1;
        controller.abort();
        throw new ProviderTransportError("server_error: boom", { status: 503 });
      },
      { maxAttempts: 5, signal: controller.signal, jitter: () => 0 },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RetryAbortedError);
    expect(attempts).toBe(1);
  });

  test("abortableSleep settles immediately once the signal fires", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
