import { describe, expect, test } from "bun:test";
import {
  appendProjectedEvent,
  boundPresentationEvent,
  eventByteLength,
  fixtureEvent,
  normalizeTaskStatus,
  projectCursorExpiredEvent,
  projectEvent,
  projectTaskEvent,
  PUBLIC_CLIENT_EVENT_FIXTURES,
  retainEventWindow,
} from "./index.js";

describe("public-client projections", () => {
  test("projects the shared event fixtures deterministically", () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    expect(projectEvent(PUBLIC_CLIENT_EVENT_FIXTURES[0]!, now)).toMatchObject({
      id: "turn-1",
      kind: "turn.started",
      summary: "Inspect the runtime",
      presentation: "user",
      time: now.toISOString(),
    });
    expect(projectEvent(PUBLIC_CLIENT_EVENT_FIXTURES[2]!, now)).toMatchObject({
      kind: "tool.settled",
      summary: "shell · just check",
      presentation: "tool",
    });
  });

  test("keeps the newest unique events under the UTF-8 window", () => {
    const first = fixtureEvent("1", "message", "é".repeat(12));
    const second = fixtureEvent("2", "message", "tail");
    const state = retainEventWindow(
      { events: [], eventBytes: 0, seenEventIds: new Set(), cursor: null, boundary: null },
      [first, second, first],
      { maxEvents: 2, maxBytes: eventByteLength(second) + 1, snapshotUrl: "/v1/tasks/task" },
    );
    expect(state.accepted).toBe(true);
    expect(state.events).toEqual([second]);
    expect(state.eventBytes).toBe(eventByteLength(second));
    expect(state.cursor).toBe("2");
    expect(state.boundary).toMatchObject({
      reason: "bounded_window",
      omittedCount: 1,
      droppedThroughCursor: "1",
      continuationCursor: "2",
    });
  });

  test("bounds presentation payloads without changing event identity", () => {
    const source = fixtureEvent("large", "tool.settled", "private".repeat(200));
    const bounded = boundPresentationEvent(source, 32);
    expect(bounded.id).toBe(source.id);
    expect(bounded.event).toBe(source.event);
    expect(JSON.parse(bounded.data)).toMatchObject({
      terminus_presentation_rejection: {
        source_event: "tool.settled",
        character_count: source.data.length,
        limit: 32,
      },
    });
  });

  test("projects cursor expiry and rejects an untrusted snapshot URL", () => {
    const expired = projectCursorExpiredEvent(PUBLIC_CLIENT_EVENT_FIXTURES[6]!, "task-1", "fallback");
    expect(expired).toMatchObject({
      requestedCursor: "old-cursor",
      oldestRetainedEventId: "new-cursor",
      resumeCursor: "new-cursor",
      snapshotUrl: "/v1/tasks/task-1",
      boundary: { reason: "cursor_expired", reconciliation: "pending" },
    });
    const untrusted = projectCursorExpiredEvent(
      fixtureEvent("cursor-2", "cursor_expired", { snapshot_url: "https://evil.invalid/task" }),
      "task-1",
    );
    expect(untrusted?.snapshotUrl).toBeNull();
  });

  test("normalizes task transitions and enforces stream scope", () => {
    expect(normalizeTaskStatus("PROVIDER_RUNNING")).toBe("working");
    expect(normalizeTaskStatus("ABORTED")).toBe("interrupted");
    expect(projectTaskEvent(PUBLIC_CLIENT_EVENT_FIXTURES[3]!, "task-1")).toMatchObject({
      taskId: "task-1",
      status: "COMPLETED",
    });
    expect(projectTaskEvent(PUBLIC_CLIENT_EVENT_FIXTURES[3]!, "other-task")).toBeNull();
  });

  test("uses the same bounded projection path as timeline consumers", () => {
    const state = { items: [], seenEventIds: new Set<string>(), cursor: null };
    const first = appendProjectedEvent(state, PUBLIC_CLIENT_EVENT_FIXTURES[0]!, { now: new Date("2026-08-28T12:00:00Z") });
    const duplicate = appendProjectedEvent(first, PUBLIC_CLIENT_EVENT_FIXTURES[0]!, { now: new Date("2026-08-28T12:01:00Z") });
    expect(first.items[0]).toEqual(projectEvent(PUBLIC_CLIENT_EVENT_FIXTURES[0]!, new Date("2026-08-28T12:00:00Z")));
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.items).toHaveLength(1);
  });
});
