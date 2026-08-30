import { describe, expect, test } from "bun:test";
import { CodexLaneEventBuffer, CODEX_EVENT_RING_LIMIT } from "./codex-lane-events.js";

describe("Codex external event projection", () => {
  test("keeps a bounded monotonic replay window and signals expiry", () => {
    const buffer = new CodexLaneEventBuffer();
    for (let sequence = 1; sequence <= CODEX_EVENT_RING_LIMIT + 4; sequence += 1) {
      buffer.append({ method: "item/agentMessage/delta", params: { delta: `chunk-${sequence}`, reasoning: "do not retain" } });
    }

    const expired = buffer.read("1");
    expect(expired.cursor_expired).toBe(true);
    expect(expired.events).toHaveLength(CODEX_EVENT_RING_LIMIT);
    expect(expired.events[0]).toMatchObject({ cursor: "5", sequence: 5, text: "chunk-5" });
    expect(expired.events.at(-1)).toMatchObject({ cursor: "260", sequence: 260, text: "chunk-260" });
    expect(expired.events[0]).not.toHaveProperty("reasoning");

    const resumed = buffer.read(expired.next_cursor);
    expect(resumed).toEqual({ events: [], next_cursor: "260", cursor_expired: false });
  });

  test("ignores non-user-facing notifications and sanitizes errors", () => {
    const buffer = new CodexLaneEventBuffer();
    buffer.append({ method: "item/reasoning/delta", params: { delta: "private reasoning" } });
    buffer.append({ method: "error", params: { message: "provider secret", accessToken: "never" } });
    buffer.append({ method: "turn/completed", params: { output: "raw protocol" } });
    expect(buffer.read(null).events).toEqual([
      { cursor: "1", sequence: 1, kind: "error", text: "Codex reported an error" },
      { cursor: "2", sequence: 2, kind: "turn/completed", text: "Turn completed" },
    ]);
  });
});
