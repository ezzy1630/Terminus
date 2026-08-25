import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GOVERNANCE_VIEWS_KEY,
  SessionLatencyTracker,
  parseTaskWorkspaceTab,
  readGovernanceViewsEnabled,
  taskWorkspaceTabs,
  writeGovernanceViewsEnabled,
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

  test("governance views default off and persist via storage", () => {
    expect(readGovernanceViewsEnabled(null)).toBe(false);
    const storage = fakeStorage();
    expect(readGovernanceViewsEnabled(storage)).toBe(false);
    writeGovernanceViewsEnabled(storage, true);
    expect(storage.getItem(GOVERNANCE_VIEWS_KEY)).toBe("true");
    expect(readGovernanceViewsEnabled(storage)).toBe(true);
    // Unreadable storage degrades to off.
    const throwing = { getItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(readGovernanceViewsEnabled(throwing)).toBe(false);
  });

  test("tabs are session-first; governance tabs append only when enabled", () => {
    const disabled = taskWorkspaceTabs(false).map((t) => t.value);
    expect(disabled).toEqual(["session", "changes"]);
    const enabled = taskWorkspaceTabs(true).map((t) => t.value);
    expect(enabled[0]).toBe("session");
    expect(enabled).toContain("overview");
    expect(enabled).toContain("evidence");
    expect(new Set(enabled).size).toBe(enabled.length);
  });

  test("tab parsing accepts every value and rejects unknown ones", () => {
    for (const value of ["session", "changes", "overview", "activity", "replay", "usage", "evidence"]) {
      expect(parseTaskWorkspaceTab(value)).toBe(value);
    }
    expect(parseTaskWorkspaceTab("ledger")).toBeNull();
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
