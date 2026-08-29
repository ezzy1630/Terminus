/**
 * Guards for the store's hot path.
 *
 * These are behavioural assertions about *how much work* streaming causes, not
 * about what it renders. They exist because every one of them regressed at some
 * point into a full re-render of the app per SSE event, and none of the
 * rendering tests could see it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useTerminusStore } from "../src/hooks/use-terminus";
import { eventByteLength } from "@terminus/public-client";
import type { Task } from "../src/types";

function task(id: string, sessionId: string): Task {
  return {
    id,
    session_id: sessionId,
    thread_id: `thread-${sessionId}`,
    status: "ACTIVE",
    phase: "IMPLEMENT",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    completed_at: null,
    terminal_reason: null,
    contract: null,
  };
}

describe("store does not wake the app for events that change nothing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTerminusStore.setState({
      taskById: { "task-1": task("task-1", "session-1") },
      tasksBySession: { "session-1": [task("task-1", "session-1")] },
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("an event about a task we are not holding notifies nobody", () => {
    let notifications = 0;
    const unsubscribe = useTerminusStore.subscribe(() => { notifications += 1; });

    useTerminusStore.getState()._updateTaskFromEvent(
      { id: "e1", event: "task.completed", data: JSON.stringify({ task_id: "task-unknown" }) },
      "task-unknown",
    );

    expect(notifications).toBe(0);
    unsubscribe();
  });

  test("re-announcing the status a task already has notifies nobody", () => {
    let notifications = 0;
    const unsubscribe = useTerminusStore.subscribe(() => { notifications += 1; });

    // The task is already ACTIVE/IMPLEMENT; this says exactly that again.
    useTerminusStore.getState()._updateTaskFromEvent(
      {
        id: "e2",
        event: "task.updated",
        data: JSON.stringify({ task_id: "task-1", status: "ACTIVE", phase: "IMPLEMENT" }),
      },
      "task-1",
    );

    expect(notifications).toBe(0);
    unsubscribe();
  });

  test("a status that genuinely changed still propagates", () => {
    let notifications = 0;
    const unsubscribe = useTerminusStore.subscribe(() => { notifications += 1; });

    useTerminusStore.getState()._updateTaskFromEvent(
      { id: "e3", event: "task.completed", data: JSON.stringify({ task_id: "task-1" }) },
      "task-1",
    );

    expect(notifications).toBe(1);
    expect(useTerminusStore.getState().taskById["task-1"]?.status).toBe("COMPLETED");
    unsubscribe();
  });
});

describe("event byte accounting stays exact while cached", () => {
  const encoder = new TextEncoder();
  const reference = (e: { id: string; event: string; data: string }): number =>
    encoder.encode(e.id).byteLength
    + encoder.encode(e.event).byteLength
    + encoder.encode(e.data).byteLength;

  test("matches TextEncoder across ASCII, multibyte, astral and lone surrogates", () => {
    const samples = [
      "",
      "ascii-only",
      "é".repeat(40),
      "日本語",
      "\u{1F389}\u{1F680}",
      "\u{10FFFF}",
      "\uD800",
      "\uDFFF",
      "a\uD800b",
      "mixed é 日 \u{1F389} \uD800 tail",
      JSON.stringify({ delta: "x".repeat(120) }),
    ];
    for (const sample of samples) {
      const event = { id: "id", event: "provider_text_delta", data: sample };
      expect(eventByteLength(event), JSON.stringify(sample)).toBe(reference(event));
    }
  });

  test("a repeated measurement of the same envelope is stable", () => {
    const event = { id: "e", event: "provider_text_delta", data: "héllo \u{1F389}" };
    const first = eventByteLength(event);
    expect(eventByteLength(event)).toBe(first);
    expect(first).toBe(reference(event));
  });
});
