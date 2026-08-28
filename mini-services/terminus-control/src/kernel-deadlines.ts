/**
 * Deadlines for kernel RPCs and for the commands the kernel runs (H10).
 *
 * Two independent hangs were possible before this module existed:
 *
 *   1. `POST /v1/tools/exec` and `POST /v1/tools/job` sent `timeout: undefined`
 *      in the kernel `Command`, so a runaway child process had no bound at all;
 *   2. every gRPC call in `kernel-uds.ts` / `kernel-mtls.ts` was issued with no
 *      deadline, so a kernel that accepted a connection and then stopped
 *      answering left the turn waiting forever with no event and no error.
 *
 * Both bounds are declared here so the numbers are reviewable in one place and
 * testable without a kernel.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Default wall bound for a directly invoked `POST /v1/tools/exec` command. */
export const DIRECT_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
/** Default wall bound for a durable `POST /v1/tools/job` command. */
export const DIRECT_JOB_DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** Ceiling for any caller-supplied command timeout. */
export const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;

/** Deadline for a kernel RPC that answers from local state. */
export const UNARY_KERNEL_DEADLINE_MS = 30_000;
/** Ceiling for a streaming or provider-dispatching kernel RPC. */
export const MAX_STREAMING_KERNEL_DEADLINE_MS = 30 * 60_000;
/**
 * Floor for a streaming deadline. A turn that is already over its wall-clock
 * budget still needs a positive deadline so the call fails with
 * DEADLINE_EXCEEDED instead of being rejected as malformed.
 */
export const MIN_STREAMING_KERNEL_DEADLINE_MS = 1_000;

/**
 * Unary RPCs that legitimately run as long as the turn allows.
 *
 * `ConnectorService.Execute` performs the buffered provider dispatch that the
 * gateway and direct paths fall back to when the kernel has no `ExecuteStream`;
 * a 30-second bound there would abort every long generation.
 * `CodeIntelligenceService.Map` walks the whole repository, which on a large
 * checkout legitimately exceeds the unary bound.
 */
export const LONG_RUNNING_UNARY_METHODS: ReadonlySet<string> = new Set([
  "terminus.kernel.v1.ConnectorService/Execute",
  "terminus.kernel.v1.CodeIntelligenceService/Map",
]);

interface TurnDeadline {
  /** `Date.now()` value at which the current turn's wall-clock budget expires. */
  readonly expiresAtMs: number;
}

const turnDeadlines = new AsyncLocalStorage<TurnDeadline>();

/**
 * Runs `fn` with the current turn's wall-clock budget in scope, so every kernel
 * RPC issued underneath it inherits a deadline no later than the turn's own.
 * `AsyncLocalStorage` keeps concurrent turns independent.
 */
export function withTurnDeadline<T>(remainingMs: number, fn: () => T): T {
  return turnDeadlines.run({ expiresAtMs: Date.now() + Math.max(0, remainingMs) }, fn);
}

/** Milliseconds left in the enclosing turn, or null outside a turn. */
export function turnRemainingMs(now: () => number = Date.now): number | null {
  const scope = turnDeadlines.getStore();
  if (scope === undefined) return null;
  return scope.expiresAtMs - now();
}

/**
 * Deadline for one kernel RPC, in milliseconds from now.
 *
 * Streaming and long-running unary calls track the remaining turn budget so a
 * stuck kernel cannot outlive the turn it belongs to; both are capped at
 * `MAX_STREAMING_KERNEL_DEADLINE_MS`.
 */
export function kernelDeadlineMs(input: {
  readonly qualifiedMethod: string;
  readonly streaming: boolean;
  readonly remainingMs?: number | null;
}): number {
  const longRunning = input.streaming || LONG_RUNNING_UNARY_METHODS.has(input.qualifiedMethod);
  if (!longRunning) return UNARY_KERNEL_DEADLINE_MS;
  const remaining = input.remainingMs ?? turnRemainingMs();
  if (remaining === null) return MAX_STREAMING_KERNEL_DEADLINE_MS;
  return Math.min(
    MAX_STREAMING_KERNEL_DEADLINE_MS,
    Math.max(MIN_STREAMING_KERNEL_DEADLINE_MS, Math.floor(remaining)),
  );
}

/** The absolute deadline grpc-js expects in `CallOptions.deadline`. */
export function kernelDeadline(input: {
  readonly qualifiedMethod: string;
  readonly streaming: boolean;
  readonly remainingMs?: number | null;
  readonly now?: () => number;
}): Date {
  const now = input.now ?? Date.now;
  return new Date(now() + kernelDeadlineMs(input));
}

export type CommandTimeoutResolution =
  | { readonly ok: true; readonly timeoutMs: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate a caller-supplied command timeout.
 *
 * An out-of-range value is rejected rather than clamped: silently running a
 * command for less time than the caller asked for is exactly the kind of
 * invisible truncation that makes a timeout look like a crash.
 */
export function resolveCommandTimeoutMs(
  raw: unknown,
  defaultMs: number,
  maxMs: number = MAX_COMMAND_TIMEOUT_MS,
): CommandTimeoutResolution {
  if (raw === undefined || raw === null) return { ok: true, timeoutMs: defaultMs };
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return { ok: false, reason: "timeout_ms must be an integer number of milliseconds" };
  }
  if (raw <= 0) return { ok: false, reason: "timeout_ms must be greater than zero" };
  if (raw > maxMs) {
    return { ok: false, reason: `timeout_ms must not exceed ${maxMs} ms (30 minutes)` };
  }
  return { ok: true, timeoutMs: raw };
}
