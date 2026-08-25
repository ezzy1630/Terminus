/**
 * Provider resilience: bounded retry with exponential backoff and jitter
 * (R6, harness critical path).
 *
 * The live loop previously had no retry policy at all — one transient 429 or
 * reset socket killed a whole turn. Retries belong at the recovery layer
 * above the native runtime (which deliberately never retries silently):
 * this wrapper is that layer.
 *
 * Retryable classes: HTTP 408/429/5xx, network resets/timeouts, and grant
 * expiry. NOT retryable: 4xx validation/auth errors and provider-side
 * content-filter rejections — retrying those only burns tokens.
 */

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Deterministic jitter source for tests. */
  readonly jitter?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 250;
export const DEFAULT_MAX_DELAY_MS = 8_000;

/** Extract the HTTP status from the direct-transport error message. */
export function statusFromProviderError(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = /HTTP (\d{3})/.exec(error.message);
  if (match !== null) return Number.parseInt(match[1]!, 10);
  return null;
}

export function isRetryableProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  // Grant expiry: the connector mint path re-runs per attempt, so a retry
  // with a fresh grant legitimately recovers.
  if (message.includes("grant")) return true;
  if (
    message.includes("econnreset")
    || message.includes("socket")
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("network")
    || message.includes("fetch failed")
  ) {
    return true;
  }
  const status = statusFromProviderError(error);
  if (status === null) return false;
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Honor a Retry-After hint embedded in the error message when present. */
export function retryAfterMsFromError(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = /retry-after (\d+(?:\.\d+)?)s/i.exec(error.message);
  if (match !== null) return Math.ceil(Number.parseFloat(match[1]!) * 1_000);
  return null;
}

export function backoffDelayMs(
  attempt: number,
  options: RetryOptions = {},
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const ceiling = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = options.jitter ?? Math.random;
  const exponential = Math.min(ceiling, base * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + jitter() * (exponential / 2));
}

export class RetryBudgetExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(`provider dispatch failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    this.name = "RetryBudgetExhaustedError";
  }
}

/** True when a fault class should be retried (exported for telemetry). */

export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      if (!isRetryableProviderError(error)) break;
      const hinted = retryAfterMsFromError(error);
      const delay = hinted !== null
        ? Math.min(hinted, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS)
        : backoffDelayMs(attempt, options);
      await sleep(delay);
    }
  }
  throw new RetryBudgetExhaustedError(attemptsUsed, lastError);
}
