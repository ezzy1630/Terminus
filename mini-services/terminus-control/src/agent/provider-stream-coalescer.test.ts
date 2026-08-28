import { describe, expect, test } from "bun:test";
import type { ProviderResponseChunk, TokenCount, UsageRecord } from "@terminus/provider-core";
import {
  createTextDeltaCoalescer,
  PROVIDER_DELTA_FLUSH_CHARS,
  withMeasuredUsage,
} from "./provider-stream-coalescer.js";

function text(value: string): ProviderResponseChunk {
  return { kind: "text", text: value };
}

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    inputTokens: 100n as TokenCount,
    cachedInputTokens: 0n as TokenCount,
    cacheWriteTokens: 0n as TokenCount,
    outputTokens: 20n as TokenCount,
    reasoningTokens: 0n as TokenCount,
    toolSchemaTokens: 0n as TokenCount,
    latencyMs: 0,
    timeToFirstTokenMs: null,
    ...overrides,
  };
}

/** A controllable timer so the 50 ms rule is asserted, not slept through. */
function manualTimers(): {
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly pending: () => number;
  readonly fire: () => void;
} {
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  return {
    setTimer: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { fn, ms });
      return id;
    },
    clearTimer: (handle) => { scheduled.delete(handle as number); },
    pending: () => scheduled.size,
    fire: () => {
      const entries = [...scheduled.entries()];
      scheduled.clear();
      for (const [, entry] of entries) entry.fn();
    },
  };
}

describe("H9 provider text deltas are coalesced by size or age", () => {
  test("short text is flushed by the timer rather than held until settlement", async () => {
    const timers = manualTimers();
    const written: string[] = [];
    const coalescer = createTextDeltaCoalescer(
      async (value) => { written.push(value); },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer, flushMs: 50 },
    );

    await coalescer.onChunk(text("Hi."));
    expect(written).toEqual([]);
    expect(timers.pending()).toBe(1);

    timers.fire();
    await coalescer.flush();
    expect(written).toEqual(["Hi."]);
  });

  test("the size rule fires at 64 characters, not 512", async () => {
    const timers = manualTimers();
    const written: string[] = [];
    const coalescer = createTextDeltaCoalescer(
      async (value) => { written.push(value); },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    );

    expect(PROVIDER_DELTA_FLUSH_CHARS).toBe(64);
    for (let index = 0; index < 8; index += 1) await coalescer.onChunk(text("abcdefgh"));
    expect(written).toEqual(["abcdefgh".repeat(8)]);
    // A size flush cancels the pending timer instead of writing an empty delta.
    expect(timers.pending()).toBe(0);
  });

  test("a size flush and a timer flush never reorder the transcript", async () => {
    const timers = manualTimers();
    const written: string[] = [];
    let first = true;
    const coalescer = createTextDeltaCoalescer(
      async (value) => {
        // The first write is slow, so an unserialized timer flush would
        // overtake it and publish the tail before the body.
        if (first) {
          first = false;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        written.push(value);
      },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    );

    const sizeFlush = coalescer.onChunk(text("a".repeat(70)));
    await Promise.resolve();
    await Promise.resolve();
    await coalescer.onChunk(text("tail"));
    timers.fire();
    await sizeFlush;
    await coalescer.flush();

    expect(written).toEqual(["a".repeat(70), "tail"]);
  });

  test("a timer flush failure surfaces on the next call instead of vanishing", async () => {
    const timers = manualTimers();
    const coalescer = createTextDeltaCoalescer(
      async () => { throw new Error("event store rejected the delta"); },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    );

    await coalescer.onChunk(text("short"));
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    await expect(coalescer.flush()).rejects.toThrow("event store rejected the delta");
  });

  test("non-text chunks neither buffer nor schedule a write", async () => {
    const timers = manualTimers();
    const written: string[] = [];
    const coalescer = createTextDeltaCoalescer(
      async (value) => { written.push(value); },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    );
    await coalescer.onChunk({ kind: "done", usage: usage() });
    expect(timers.pending()).toBe(0);
    await coalescer.flush();
    expect(written).toEqual([]);
  });
});

describe("H9 measured latency reaches the usage the engine reads", () => {
  test("wall time and time-to-first-token land on the terminal done chunk", () => {
    const chunks: readonly ProviderResponseChunk[] = [
      text("hello"),
      { kind: "done", usage: usage() },
    ];
    const stamped = withMeasuredUsage(chunks, { wallMs: 4_200, timeToFirstTokenMs: 310 });
    expect(stamped[1]?.usage?.latencyMs).toBe(4_200);
    expect(stamped[1]?.usage?.timeToFirstTokenMs).toBe(310);
    // Token counts are never rewritten.
    expect(stamped[1]?.usage?.inputTokens).toBe(100n as TokenCount);
    expect(stamped[0]).toBe(chunks[0]!);
  });

  test("a vendor runtime's own usage replaces the chunk without double-counting", () => {
    const chunks: readonly ProviderResponseChunk[] = [{ kind: "done", usage: usage({ latencyMs: 0 }) }];
    const stamped = withMeasuredUsage(
      chunks,
      { wallMs: 9_000, timeToFirstTokenMs: 120 },
      usage({ latencyMs: 3_500, outputTokens: 77n as TokenCount }),
    );
    expect(stamped[0]?.usage?.latencyMs).toBe(3_500);
    expect(stamped[0]?.usage?.outputTokens).toBe(77n as TokenCount);
    expect(stamped[0]?.usage?.timeToFirstTokenMs).toBe(120);
  });

  test("a response with no usage frame is left exactly as it arrived", () => {
    const chunks: readonly ProviderResponseChunk[] = [text("hello"), { kind: "done" }];
    expect(withMeasuredUsage(chunks, { wallMs: 500, timeToFirstTokenMs: 10 })).toBe(chunks);
  });

  test("an observed time-to-first-token of null keeps the provider's own value", () => {
    const chunks: readonly ProviderResponseChunk[] = [
      { kind: "done", usage: usage({ timeToFirstTokenMs: 42 }) },
    ];
    const stamped = withMeasuredUsage(chunks, { wallMs: 100, timeToFirstTokenMs: null });
    expect(stamped[0]?.usage?.timeToFirstTokenMs).toBe(42);
    expect(stamped[0]?.usage?.latencyMs).toBe(100);
  });
});
