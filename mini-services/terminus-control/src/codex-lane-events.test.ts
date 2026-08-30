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
    expect(expired.events[0]).toMatchObject({ sequence: 5, text: "chunk-5" });
    expect(expired.events[0]?.cursor).toMatch(/^[0-9a-f-]+:5$/);
    expect(expired.events.at(-1)).toMatchObject({ sequence: 260, text: "chunk-260" });
    expect(expired.events[0]).not.toHaveProperty("reasoning");

    const resumed = buffer.read(expired.next_cursor);
    expect(resumed).toEqual({ events: [], next_cursor: expired.next_cursor, cursor_expired: false, resync_cursor: null });
  });

  test("ignores non-user-facing notifications and sanitizes errors", () => {
    const buffer = new CodexLaneEventBuffer();
    buffer.append({ method: "item/reasoning/delta", params: { delta: "private reasoning" } });
    buffer.append({ method: "item/completed", params: { item: { type: "reasoning", text: "private reasoning" } } });
    buffer.append({ method: "error", params: { message: "provider secret", accessToken: "never" } });
    buffer.append({ method: "turn/completed", params: { turn: { status: "failed", error: { message: "raw protocol" } } } });
    expect(buffer.read(null).events).toEqual([
      expect.objectContaining({ sequence: 1, kind: "error", text: "Codex reported an error" }),
      expect.objectContaining({ sequence: 2, kind: "turn/completed", text: "Turn failed" }),
    ]);
  });

  test("projects documented v2 item lifecycle without command, diff, or reasoning payloads", () => {
    const buffer = new CodexLaneEventBuffer();
    buffer.append({ method: "item/started", params: { item: { type: "commandExecution", command: "print-secret" } } });
    buffer.append({ method: "item/completed", params: { item: { type: "fileChange", changes: ["private.patch"] } } });
    buffer.append({ method: "turn/plan/updated", params: { plan: [{ step: "private plan" }] } });
    buffer.append({ method: "turn/diff/updated", params: { diff: "private diff" } });
    buffer.append({ method: "thread/tokenUsage/updated", params: { tokenUsage: { totalTokens: 42 } } });

    expect(buffer.read(null).events.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "item/started", text: "Command started" },
      { kind: "item/completed", text: "File changes completed" },
      { kind: "turn/plan/updated", text: "Plan updated" },
      { kind: "turn/diff/updated", text: "Changes updated" },
      { kind: "thread/tokenUsage/updated", text: "Usage updated" },
    ]);
    expect(JSON.stringify(buffer.read(null))).not.toContain("private");
  });

  test("treats a previous process epoch and legacy numeric cursor as expired", () => {
    const previous = new CodexLaneEventBuffer();
    previous.append({ method: "turn/started", params: {} });
    const oldCursor = previous.read(null).next_cursor;

    const restarted = new CodexLaneEventBuffer();
    restarted.append({ method: "turn/started", params: {} });
    const oldEpoch = restarted.read(oldCursor);
    expect(oldEpoch.cursor_expired).toBe(true);
    expect(oldEpoch.resync_cursor).toBe(oldEpoch.next_cursor);

    const legacy = restarted.read("1");
    expect(legacy.cursor_expired).toBe(true);
    expect(legacy.resync_cursor).toBe(legacy.next_cursor);
  });
});
