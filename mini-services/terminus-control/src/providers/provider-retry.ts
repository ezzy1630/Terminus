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
  /** Ceiling for an explicit provider hint. Defaults to {@link MAX_HINTED_DELAY_MS}. */
  readonly maxHintedDelayMs?: number;
  /** Deterministic jitter source for tests. */
  readonly jitter?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal | null | undefined) => Promise<void>;
  /** Turn cancellation: aborts the backoff sleep instead of stranding the turn. */
  readonly signal?: AbortSignal | null | undefined;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 250;
export const DEFAULT_MAX_DELAY_MS = 8_000;

/**
 * The ceiling for a delay the *provider* asked for, as opposed to one this
 * module invented.
 *
 * Blind backoff is guesswork and 8 s is a reasonable guess. An explicit
 * `Retry-After` is not a guess: it is the provider saying when the quota
 * window reopens, and clamping a 60-second hint to 8 s just spends two more
 * attempts being told the same thing and then fails the turn. Two minutes is
 * long enough for every rate-limit window either vendor publishes and short
 * enough that a turn cannot silently park for an afternoon.
 */
export const MAX_HINTED_DELAY_MS = 120_000;

/**
 * Provider fault codes that are transient by contract. The gateway reports
 * upstream saturation as `server_error`; Anthropic reports it as
 * `overloaded_error`. Both recover on retry.
 */
const RETRYABLE_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "server_error",
  "overloaded",
  "overloaded_error",
  "service_unavailable",
  "rate_limit_error",
  "rate_limit_exceeded",
  "api_error",
  // A stream that ended without its protocol terminal marker is an
  // incomplete transport, not a model answer. Reissuing the same immutable
  // request under the provider-attempt idempotency key is the recovery path.
  "truncated_stream",
]);

/**
 * Transport-level provider failure carrying the classification the message
 * text can only hint at. Both the gateway path and the direct path raise this
 * so {@link isRetryableProviderError} never has to guess from prose.
 */
export class ProviderTransportError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly providerCode: string | null;

  constructor(
    message: string,
    init: {
      readonly status?: number | null | undefined;
      readonly retryAfterMs?: number | null | undefined;
      readonly providerCode?: string | null | undefined;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ProviderTransportError";
    this.status = init.status ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.providerCode = init.providerCode ?? null;
  }

  /**
   * Build the error a provider `error` chunk represents. The status is taken
   * from the chunk when the decoder supplied one, otherwise from a `[502]`
   * style marker the upstream embedded in the message.
   */
  static fromProviderErrorChunk(input: {
    readonly errorCode?: string | undefined;
    readonly errorMessage?: string | undefined;
    readonly retryAfterMs?: number | undefined;
    readonly status?: number | null | undefined;
    readonly fallbackMessage: string;
  }): ProviderTransportError {
    const code = input.errorCode ?? "PROVIDER_ERROR";
    const message = input.errorMessage ?? input.fallbackMessage;
    return new ProviderTransportError(`${code}: ${message}`, {
      status: input.status ?? bracketStatusFromText(message),
      retryAfterMs: input.retryAfterMs ?? null,
      providerCode: input.errorCode ?? null,
    });
  }
}

/**
 * Upstreams frequently embed the origin status in the message body rather than
 * the transport status, e.g. `Streaming response failed: [502] Upstream error`.
 */
function bracketStatusFromText(text: string): number | null {
  const match = /\[(\d{3})\]/.exec(text);
  if (match === null) return null;
  const status = Number.parseInt(match[1]!, 10);
  return status >= 100 && status <= 599 ? status : null;
}

/**
 * Extract the HTTP status: structured first, then the direct-transport
 * `HTTP 502` text, then a `[502]` marker embedded by an upstream proxy.
 */
export function statusFromProviderError(error: unknown): number | null {
  if (error instanceof ProviderTransportError && error.status !== null) return error.status;
  if (!(error instanceof Error)) return null;
  const match = /HTTP (\d{3})/.exec(error.message);
  if (match !== null) return Number.parseInt(match[1]!, 10);
  return bracketStatusFromText(error.message);
}

/** The structured provider fault code, when the thrower carried one. */
export function providerCodeFromError(error: unknown): string | null {
  if (error instanceof ProviderTransportError) return error.providerCode;
  if (!(error instanceof Error)) return null;
  const match = /^([A-Za-z][A-Za-z0-9_]*): /.exec(error.message);
  return match === null ? null : match[1]!;
}

/**
 * Provider outcomes that are terminal by contract.
 *
 * A refusal is a safety decision, not a transient fault: it arrives as an
 * HTTP 200 with `stop_reason: "refusal"`, and on the rare path where it
 * surfaces as an error it must not be retried — the same request will be
 * refused again, at full input cost.
 */
const TERMINAL_PROVIDER_CODES: ReadonlySet<string> = new Set(["refusal"]);

export function isRetryableProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const terminalCode = providerCodeFromError(error);
  if (terminalCode !== null && TERMINAL_PROVIDER_CODES.has(terminalCode.toLowerCase())) return false;
  const status = statusFromProviderError(error);
  if (status !== null) {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
  const code = providerCodeFromError(error);
  if (code !== null && RETRYABLE_PROVIDER_CODES.has(code.toLowerCase())) return true;
  const message = error.message.toLowerCase();
  // Grant expiry: the connector mint path re-runs per attempt, so a retry
  // with a fresh grant legitimately recovers.
  if (message.includes("grant")) return true;
  return message.includes("econnreset")
    || message.includes("econnrefused")
    || message.includes("epipe")
    || message.includes("etimedout")
    || message.includes("socket")
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("network")
    || message.includes("fetch failed");
}

/** Honor a Retry-After hint: structured first, then embedded text. */
export function retryAfterMsFromError(error: unknown): number | null {
  if (error instanceof ProviderTransportError && error.retryAfterMs !== null) return error.retryAfterMs;
  if (!(error instanceof Error)) return null;
  const seconds = /retry-after:?\s*(\d+(?:\.\d+)?)\s*s/i.exec(error.message);
  if (seconds !== null) return Math.ceil(Number.parseFloat(seconds[1]!) * 1_000);
  const bare = /retry-after:?\s*(\d+(?:\.\d+)?)\b/i.exec(error.message);
  if (bare !== null) return Math.ceil(Number.parseFloat(bare[1]!) * 1_000);
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
    super(
      `provider dispatch failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastError === undefined ? undefined : { cause: lastError },
    );
    this.name = "RetryBudgetExhaustedError";
  }
}

/** Raised when the turn is cancelled while the retry backoff is pending. */
export class RetryAbortedError extends Error {
  constructor(readonly lastError: unknown) {
    super("provider retry was aborted before the next attempt");
    this.name = "RetryAbortedError";
  }
}

/**
 * Backoff sleep that settles early when the turn is cancelled. A plain
 * `setTimeout` here strands an interrupted turn for the full delay.
 */
export function abortableSleep(ms: number, signal?: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = options.sleep ?? abortableSleep;
  const signal = options.signal ?? null;
  // Read through a call so the compiler does not narrow `aborted` across the
  // await: the whole point is that it can flip while the backoff is pending.
  const aborted = (): boolean => signal?.aborted === true;
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
      if (aborted()) throw new RetryAbortedError(error);
      const hinted = retryAfterMsFromError(error);
      // An explicit hint is honoured up to two minutes; only the invented
      // backoff is held to the short ceiling.
      const delay = hinted !== null
        ? Math.min(hinted, options.maxHintedDelayMs ?? MAX_HINTED_DELAY_MS)
        : backoffDelayMs(attempt, options);
      await sleep(delay, signal);
      if (aborted()) throw new RetryAbortedError(error);
    }
  }
  throw new RetryBudgetExhaustedError(attemptsUsed, lastError);
}
