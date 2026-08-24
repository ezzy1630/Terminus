import { describe, expect, test } from "bun:test";
import { appendEvent, initialState, moveSelection, timelineItemFromEvent } from "../src/model.js";

describe("TUI state model", () => {
  test("deduplicates replayed SSE events and retains the cursor", () => {
    const event = {
      id: "cursor-17",
      event: "task.completed",
      data: JSON.stringify({ summary: "Focused checks passed" }),
    };
    const once = appendEvent(initialState(), event, new Date("2026-08-23T12:00:00Z"));
    const replayed = appendEvent(once, event, new Date("2026-08-23T12:00:01Z"));

    expect(replayed.timeline).toHaveLength(1);
    expect(replayed.lastCursor).toBe("cursor-17");
    expect(replayed.timeline[0]?.summary).toBe("Focused checks passed");
  });

  test("uses raw event data when the payload is not JSON", () => {
    const item = timelineItemFromEvent({ id: "1", event: "message", data: "plain output" });
    expect(item.summary).toBe("plain output");
    expect(item.detail).toBe("plain output");
    expect(item.presentation).toBe("system");
  });

  test("classifies conversation and tool events for transcript rendering", () => {
    const user = timelineItemFromEvent({ id: "1", event: "turn.started", data: JSON.stringify({ user_input: "Fix the TUI" }) });
    const agent = timelineItemFromEvent({ id: "2", event: "turn.completed", data: JSON.stringify({ summary: "The TUI is ready" }) });
    const tool = timelineItemFromEvent({ id: "3", event: "tool.settled", data: JSON.stringify({ tool: "shell", command: "just check" }) });

    expect(user).toMatchObject({ presentation: "user", summary: "Fix the TUI" });
    expect(agent).toMatchObject({ presentation: "agent", summary: "The TUI is ready" });
    expect(tool).toMatchObject({ presentation: "tool", summary: "shell · just check" });
  });

  test("bounds selection to available rows", () => {
    const state = { ...initialState(), focus: "timeline" as const, timeline: [
      timelineItemFromEvent({ id: "1", event: "one", data: "first" }),
      timelineItemFromEvent({ id: "2", event: "two", data: "second" }),
    ] };
    expect(moveSelection(state, 100).selectedTimeline).toBe(1);
    expect(moveSelection(state, -100).selectedTimeline).toBe(0);
  });
});
