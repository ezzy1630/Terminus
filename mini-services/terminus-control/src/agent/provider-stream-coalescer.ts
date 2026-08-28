/**
 * Provider stream shaping for the live turn loop (H9).
 *
 * Two concerns that both sit between the provider byte stream and the durable
 * turn record live here so they can be tested without booting the control
 * plane:
 *
 *   - `createTextDeltaCoalescer` decides when accumulated text becomes a
 *     `turn.provider_text_delta` event;
 *   - `withMeasuredUsage` writes the latency the control plane measured back
 *     onto the chunk the engine reads usage from.
 */
import type { ProviderResponseChunk, UsageRecord } from "@terminus/provider-core";

/**
 * Flush thresholds. Text is written out at the first of the two.
 *
 * The previous rule was size-only at 512 characters, which made a slow or
 * terse model look frozen: a short answer produced no delta at all until the
 * attempt settled, and a 20 tok/s model produced roughly one delta every 25
 * seconds. 64 characters or 50 ms keeps the event count bounded while making
 * the first delta arrive within a frame of the first tokens.
 */
export const PROVIDER_DELTA_FLUSH_CHARS = 64;
export const PROVIDER_DELTA_FLUSH_MS = 50;

export interface TextDeltaCoalescer {
  /** Accumulates a provider chunk; may write a delta. */
  readonly onChunk: (chunk: ProviderResponseChunk) => Promise<void>;
  /** Writes whatever is buffered. The caller invokes this when the attempt settles. */
  readonly flush: () => Promise<void>;
}

export interface TextDeltaCoalescerOptions {
  readonly flushChars?: number;
  readonly flushMs?: number;
  /** Injectable for tests; defaults to the global timer. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Coalesces provider text deltas into durable, SSE-deliverable events.
 *
 * The size-driven and timer-driven flushes are serialized against each other
 * so deltas can never be written out of order. A timer flush has no awaiting
 * caller, so its failure is retained and re-thrown from the next
 * `onChunk`/`flush` rather than being dropped.
 */
export function createTextDeltaCoalescer(
  sink: (text: string) => Promise<void>,
  options: TextDeltaCoalescerOptions = {},
): TextDeltaCoalescer {
  const flushChars = options.flushChars ?? PROVIDER_DELTA_FLUSH_CHARS;
  const flushMs = options.flushMs ?? PROVIDER_DELTA_FLUSH_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); });

  let buffer = "";
  let timer: unknown = null;
  let tail: Promise<void> = Promise.resolve();
  let deferredFailure: unknown = null;

  const raiseDeferredFailure = (): void => {
    if (deferredFailure === null) return;
    const failure = deferredFailure;
    deferredFailure = null;
    throw failure;
  };

  const writeBuffered = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const text = buffer;
    buffer = "";
    await sink(text);
  };

  const flushNow = (): Promise<void> => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const next = tail.then(writeBuffered);
    tail = next.then(
      () => undefined,
      (error: unknown) => {
        if (deferredFailure === null) deferredFailure = error;
      },
    );
    return next;
  };

  const scheduleFlush = (): void => {
    if (timer !== null || buffer.length === 0) return;
    timer = setTimer(() => {
      timer = null;
      // The rejection is recorded in `deferredFailure` by `flushNow`, which
      // re-throws it from the next awaited call.
      void flushNow().catch(() => undefined);
    }, flushMs);
  };

  return {
    onChunk: async (chunk) => {
      raiseDeferredFailure();
      if (chunk.kind !== "text" || chunk.text === undefined) return;
      buffer += chunk.text;
      if (buffer.length >= flushChars) {
        await flushNow();
        return;
      }
      scheduleFlush();
    },
    flush: async () => {
      await flushNow();
      raiseDeferredFailure();
    },
  };
}

export interface MeasuredLatency {
  /** Wall time from dispatch to settlement, in milliseconds. */
  readonly wallMs: number;
  /** Wall time to the first text or tool-call chunk, or null if none arrived. */
  readonly timeToFirstTokenMs: number | null;
}

/**
 * Stamp the latency the control plane measured onto the usage the loop reads.
 *
 * `ProviderRenderer.extractUsage` walks the response chunks and returns the
 * last one carrying usage, so a figure computed beside the stream is invisible
 * unless it is written back into that chunk. Providers report neither number:
 * `latencyMs` arrived as 0 and `timeToFirstTokenMs` as null on every turn.
 *
 * `overrideUsage` is the vendor runtime's own record, which already includes
 * its measured wall time; when it is supplied `wallMs` is not added again. A
 * response with no usage frame is returned untouched — inventing token counts
 * would be a fabrication.
 */
export function withMeasuredUsage(
  chunks: readonly ProviderResponseChunk[],
  measured: MeasuredLatency,
  overrideUsage?: UsageRecord | null,
): readonly ProviderResponseChunk[] {
  let target = -1;
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (chunks[index]?.kind === "done") {
      target = index;
      break;
    }
  }
  const done = target === -1 ? undefined : chunks[target];
  const base = overrideUsage ?? done?.usage;
  if (done === undefined || base === undefined || base === null) return chunks;
  const usage: UsageRecord = {
    ...base,
    latencyMs: base.latencyMs + (overrideUsage === undefined || overrideUsage === null ? measured.wallMs : 0),
    timeToFirstTokenMs: measured.timeToFirstTokenMs ?? base.timeToFirstTokenMs,
  };
  return chunks.map((chunk, index) => (index === target ? { ...chunk, usage } : chunk));
}
