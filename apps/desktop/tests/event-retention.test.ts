import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MAX_EVENT_BYTES_GLOBAL,
  MAX_EVENT_BYTES_PER_TASK,
  MAX_PRESENTATION_EVENT_CHARS,
  presentationEventByteLength,
  useTerminusStore,
} from "../src/hooks/use-terminus";
import type { TerminusSseEvent } from "../src/types";

function event(id: string, data = "{}", name = "tool.settled"): TerminusSseEvent {
  return { id, event: name, data };
}

function flushEvents(): void {
  vi.advanceTimersByTime(50);
}

function resetRetentionState(): void {
  useTerminusStore.setState({
    selectedTaskId: null,
    eventsByTask: {},
    eventBytesByTask: {},
    eventLruTickByTask: {},
    eventLruClock: 0,
    resumeCursorByTask: {},
    eventHistoryByTask: {},
  });
}

describe("desktop SSE event retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRetentionState();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("uses UTF-8 bytes for the per-task window and exposes the omitted boundary", () => {
    const taskId = "utf8-byte-task";
    const payload = "é".repeat(MAX_PRESENTATION_EVENT_CHARS);

    for (let index = 0; index < 17; index += 1) {
      useTerminusStore.getState()._appendEvent(taskId, event(`utf-${String(index).padStart(2, "0")}`, payload));
      // Keep the pending aggregate below its separate 2 MiB guard so this
      // test isolates the retained per-task UTF-8 budget.
      if (index === 5 || index === 11) flushEvents();
    }
    flushEvents();

    const state = useTerminusStore.getState();
    const retained = state.eventsByTask[taskId] ?? [];
    const boundary = state.eventHistoryByTask[taskId];
    expect(retained).not.toHaveLength(17);
    expect(state.eventBytesByTask[taskId]).toBe(
      retained.reduce((total, retainedEvent) => total + presentationEventByteLength(retainedEvent), 0),
    );
    expect(state.eventBytesByTask[taskId]).toBeLessThanOrEqual(MAX_EVENT_BYTES_PER_TASK);
    expect(boundary).toMatchObject({
      reason: "bounded_window",
      omittedCount: 2,
      droppedThroughCursor: "utf-01",
      continuationCursor: "utf-02",
      snapshotUrl: `/v1/tasks/${taskId}`,
      reconciliation: "ready",
      error: null,
    });
  });

  test("evicts the least-recent inactive task globally while preserving the selected task and its cursor", () => {
    const selectedTaskId = "selected-task";
    const firstEvent = event("event-0", "");
    const fullPayload = "x".repeat(MAX_EVENT_BYTES_PER_TASK - presentationEventByteLength(firstEvent));
    const retainedWindow = event("event-0", fullPayload);
    expect(presentationEventByteLength(retainedWindow)).toBe(MAX_EVENT_BYTES_PER_TASK);

    const eventsByTask: Record<string, TerminusSseEvent[]> = {};
    const eventBytesByTask: Record<string, number> = {};
    const eventLruTickByTask: Record<string, number> = {};
    const resumeCursorByTask: Record<string, string> = {};
    for (let index = 0; index < 8; index += 1) {
      const taskId = `inactive-${index}`;
      eventsByTask[taskId] = [event(`event-${index}`, fullPayload)];
      eventBytesByTask[taskId] = MAX_EVENT_BYTES_PER_TASK;
      eventLruTickByTask[taskId] = index + 1;
      resumeCursorByTask[taskId] = `event-${index}`;
    }
    useTerminusStore.setState({
      selectedTaskId,
      eventsByTask,
      eventBytesByTask,
      eventLruTickByTask,
      eventLruClock: 8,
      resumeCursorByTask,
    });

    useTerminusStore.getState()._appendEvent(selectedTaskId, event("selected-newest"));
    flushEvents();

    const state = useTerminusStore.getState();
    expect(state.eventsByTask[selectedTaskId]).toEqual([event("selected-newest")]);
    expect(state.eventsByTask["inactive-0"]).toEqual([]);
    expect(state.eventBytesByTask["inactive-0"]).toBe(0);
    expect(state.resumeCursorByTask["inactive-0"]).toBe("event-0");
    expect(state.eventHistoryByTask["inactive-0"]).toMatchObject({
      reason: "global_lru",
      omittedCount: 1,
      droppedThroughCursor: "event-0",
      continuationCursor: null,
      globalEvictedCount: 1,
    });
    expect(Object.values(state.eventBytesByTask).reduce((sum, bytes) => sum + bytes, 0))
      .toBeLessThanOrEqual(MAX_EVENT_BYTES_GLOBAL);
  });

  test("does not double-account duplicate events or rewind the newest accepted resume cursor", () => {
    const taskId = "dedup-task";
    const first = event("cursor-1", "first");
    const newest = event("cursor-2", "newest");

    expect(useTerminusStore.getState()._appendEvent(taskId, first)).toBe(true);
    expect(useTerminusStore.getState()._appendEvent(taskId, newest)).toBe(true);
    flushEvents();
    expect(useTerminusStore.getState()._appendEvent(taskId, first)).toBe(false);
    flushEvents();

    const state = useTerminusStore.getState();
    expect(state.eventsByTask[taskId]).toEqual([first, newest]);
    expect(state.eventBytesByTask[taskId]).toBe(
      presentationEventByteLength(first) + presentationEventByteLength(newest),
    );
    expect(state.resumeCursorByTask[taskId]).toBe("cursor-2");
  });
});
