import { describe, expect, test } from "bun:test";
import {
  MAX_ROLLOUT_ITEM_BYTES,
  planForkPrefix,
  projectStoredEvents,
  resumeCursor,
  rolloutFromJsonl,
  rolloutToJsonl,
  decodeRolloutLine,
  type StoredEventRow,
} from "./index.js";

function row(
  eventId: string,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  sequence: number,
  occurredAt: string,
  payload: unknown = {},
): StoredEventRow {
  return {
    eventId,
    eventType,
    aggregateType,
    aggregateId,
    aggregateSequence: sequence,
    occurredAt,
    payloadJson: JSON.stringify(payload),
  };
}

const SESSION = { session: "s-1", thread: "t-1", turn: "u-1" };

describe("projectStoredEvents", () => {
  test("orders by (occurredAt, aggregateSequence, eventId) and assigns dense ordinals", () => {
    const lines = projectStoredEvents([
      row("e3", "turn.tool_settled", "turn", SESSION.turn, 2, "2026-08-26T00:00:02.000Z"),
      row("e1", "session.created", "session", SESSION.session, 1, "2026-08-26T00:00:01.000Z"),
      row("e2", "turn.started", "turn", SESSION.turn, 1, "2026-08-26T00:00:02.000Z"),
    ]);
    expect(lines.map((line) => line.item.event_id)).toEqual(["e1", "e2", "e3"]);
    expect(lines.map((line) => line.ordinal)).toEqual([0, 1, 2]);
  });

  test("classifies well-known event types into specialized kinds", () => {
    const lines = projectStoredEvents([
      row("e1_msg", "turn.message.appended", "thread", SESSION.thread, 1, "2026-08-26T00:00:01.000Z"),
      row("e2_call", "turn.tool_called", "turn", SESSION.turn, 2, "2026-08-26T00:00:01.000Z"),
      row("e3_gate", "verification.gate.evaluated", "task", "task-1", 3, "2026-08-26T00:00:01.000Z"),
    ]);
    expect(lines[0]!.item.kind).toBe("message");
    expect(lines[1]!.item.kind).toBe("tool_call");
    expect(lines[2]!.item.kind).toBe("gate_verdict");
  });

  test("unknown event types decode as generic event items (fail-open classification, closed decoding)", () => {
    const lines = projectStoredEvents([
      row("x1", "totally.unknown.kind", "session", SESSION.session, 9, "2026-08-26T00:00:00.000Z"),
    ]);
    expect(lines[0]!.item.kind).toBe("event");
    expect(() => decodeRolloutLine(lines[0]!)).not.toThrow();
  });

  test("oversized payloads are rejected, never truncated", () => {
    const big = "x".repeat(MAX_ROLLOUT_ITEM_BYTES);
    expect(() =>
      projectStoredEvents([
        row("big", "turn.message.appended", "thread", SESSION.thread, 1, "2026-08-26T00:00:00.000Z", {
          text: big,
        }),
      ]),
    ).toThrow(RangeError);
  });

  test("corrupt payload JSON degrades to an explicit marker instead of failing the page", () => {
    const line = projectStoredEvents([
      {
        ...row("bad", "session.created", "session", SESSION.session, 1, "2026-08-26T00:00:00.000Z"),
        payloadJson: "{not json",
      },
    ])[0]!;
    expect(line.item.payload).toEqual({ undecodable_payload: true });
  });
});

describe("jsonl roundtrip", () => {
  test("encodes and decodes losslessly", () => {
    const lines = projectStoredEvents([
      row("e1", "session.created", "session", SESSION.session, 1, "2026-08-26T00:00:01.000Z", {
        workspace_id: "w-1",
      }),
      row("e2", "turn.completed", "turn", SESSION.turn, 5, "2026-08-26T00:00:09.000Z"),
    ]);
    const jsonl = rolloutToJsonl(lines);
    expect(jsonl.endsWith("\n")).toBe(true);
    const decoded = rolloutFromJsonl(jsonl);
    expect(decoded).toEqual(lines);
  });

  test("empty input encodes to empty output", () => {
    expect(rolloutToJsonl([])).toBe("");
    expect(rolloutFromJsonl("")).toEqual([]);
  });
});

describe("resume + fork", () => {
  test("resumeCursor returns the last projected event id", () => {
    const lines = projectStoredEvents([
      row("e1", "session.created", "session", SESSION.session, 1, "2026-08-26T00:00:01.000Z"),
      row("e2", "turn.started", "turn", SESSION.turn, 1, "2026-08-26T00:00:02.000Z"),
    ]);
    expect(resumeCursor(lines)).toBe("e2");
    expect(resumeCursor([])).toBeNull();
  });

  test("planForkPrefix copies the requested prefix with original provenance", () => {
    const lines = projectStoredEvents([
      row("e1", "session.created", "session", SESSION.session, 1, "2026-08-26T00:00:01.000Z"),
      row("e2", "turn.started", "turn", SESSION.turn, 1, "2026-08-26T00:00:02.000Z"),
      row("e3", "turn.completed", "turn", SESSION.turn, 2, "2026-08-26T00:00:03.000Z"),
    ]);
    const prefix = planForkPrefix(lines, 1);
    expect(prefix.map((line) => line.item.event_id)).toEqual(["e1", "e2"]);
    expect(prefix[0]!.item.aggregate).toEqual({ type: "session", id: SESSION.session });
  });
});
