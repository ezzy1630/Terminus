import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SessionLatencyTracker,
  parseTaskWorkspaceTab,
  taskWorkspaceTabs,
} from "../src/lib/session-view";

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() { return map.size; },
  } as Storage;
}

describe("R12 session-first task workspace", () => {
  afterEach(() => vi.restoreAllMocks());

  test("offers only the session and changes tabs", () => {
    expect(taskWorkspaceTabs().map((t) => t.value)).toEqual(["session", "changes"]);
  });

  test("tab parsing accepts both values and rejects the retired governance tabs", () => {
    for (const value of ["session", "changes"]) {
      expect(parseTaskWorkspaceTab(value)).toBe(value);
    }
    for (const retired of ["overview", "activity", "replay", "usage", "evidence", "ledger"]) {
      expect(parseTaskWorkspaceTab(retired)).toBeNull();
    }
  });
});

describe("R12 TTFT tracker", () => {
  function trackerWithClock(ticks: number[]) {
    let i = 0;
    return new SessionLatencyTracker(50, () => ticks[Math.min(i++, ticks.length - 1)]!);
  }

  test("submit then first stream event closes a sample with non-negative ttft", () => {
    const t = trackerWithClock([1_000, 1_250]);
    t.markTurnSubmitted("task-a");
    const sample = t.observeStreamEvent("task-a", "turn.started");
    expect(sample?.ttftMs).toBe(250);
    expect(t.samplesSnapshot).toHaveLength(1);
    // Second event without pending submit records nothing.
    expect(t.observeStreamEvent("task-a", "tool")).toBeNull();
  });

  test("events without submits are ignored; cancel drops pending state", () => {
    const t = trackerWithClock([0, 10, 20]);
    expect(t.observeStreamEvent("idle", "x")).toBeNull();
    t.markTurnSubmitted("task-b");
    t.cancelPending("task-b");
    expect(t.observeStreamEvent("task-b", "y")).toBeNull();
    expect(t.p50TtftMs()).toBeNull();
  });

  test("percentiles over multiple samples", () => {
    const t = new SessionLatencyTracker(50, (() => { let n = 0; return () => (n += 100); })());
    for (const [taskId, tickCount] of [["a", 2], ["b", 5], ["c", 9], ["d", 21]] as const) {
      t.markTurnSubmitted(taskId);
      for (let k = 1; k < tickCount; k += 1) t.observeStreamEvent(`ignored-${k}`, "noise");
      t.observeStreamEvent(taskId, "first.real");
    }
    const values = t.samplesSnapshot.map((s) => s.ttftMs);
    expect(values.length).toBe(4);
    const p50 = t.p50TtftMs()!;
    const p95 = t.p95TtftMs()!;
    expect(p50).toBeGreaterThanOrEqual(values[0]!);
    expect(p95).toBeGreaterThanOrEqual(p50);
  });

  test("ring buffer caps retained samples", () => {
    const t = new SessionLatencyTracker(3, (() => { let n = 0; return () => (n += 1); })());
    for (let i = 0; i < 6; i += 1) {
      t.markTurnSubmitted(`task-${i}`);
      t.observeStreamEvent(`task-${i}`, "e");
    }
    expect(t.samplesSnapshot).toHaveLength(3);
  });
});
