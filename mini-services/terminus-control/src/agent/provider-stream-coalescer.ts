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
 * Every flush is a durable event: `emit` writes a `turn.provider_text_delta`
 * row inside the agent-state mutation mutex, and the UI reads those rows back
 * over SSE. So the delta rate is a *database transaction rate*, not a render
 * rate. At 64 characters a 5,000 char/s response opened roughly 78
 * transactions per second under a process-global mutex, which is what made a
 * fast turn contend with its own tool calls.
 *
 * Because the UI is fed from those rows rather than from memory, the latency
 * bound has to come from the timer, not from the byte threshold: 250 ms is the
 * worst case a user waits for the next chunk of text, and 2 KiB caps the
 * transaction rate at roughly 2-4/s however fast the model streams. Both
 * numbers are an order of magnitude better than 64 characters and still well
 * inside the ~400 ms at which streaming stops reading as streaming.
 */
export const PROVIDER_DELTA_FLUSH_CHARS = 2_048;
export const PROVIDER_DELTA_FLUSH_MS = 250;

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

export interface ProviderDeltaSinks {
  readonly text: (value: string) => Promise<void>;
  readonly reasoning: (value: string) => Promise<void>;
}

/**
 * Preserve the provider's two human-readable streams independently.
 * Reasoning is never folded into answer text, and opaque replay items are
 * ignored because they are not user-visible model output.
 */
export function createProviderDeltaCoalescer(
  sinks: ProviderDeltaSinks,
  options: TextDeltaCoalescerOptions = {},
): TextDeltaCoalescer {
  const answer = createTextDeltaCoalescer(sinks.text, options);
  const reasoning = createTextDeltaCoalescer(sinks.reasoning, options);
  return {
    onChunk: async (chunk) => {
      if (chunk.kind === "text" && chunk.reasoning !== undefined) {
        await reasoning.onChunk({ kind: "text", text: chunk.reasoning });
      }
      await answer.onChunk(chunk);
    },
    flush: async () => {
      // The provider emits reasoning before the answer. Preserve that order
      // when both buffers are shorter than the timer/size thresholds.
      await reasoning.flush();
      await answer.flush();
    },
  };
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
