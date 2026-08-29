/**
 * Recovering from a run whose ending never reached this client.
 *
 * `projectTaskEvent` ignores every `turn.*` event, so `active_turn` was carried
 * forward from one snapshot to the next forever. Combine that with the ordinary
 * ways a live tail loses events — the 32 MB presentation LRU, `cursor_expired`,
 * a transcript replay that timed out, a control-plane restart mid-turn — and a
 * finished run leaves a task pinned on "Working" with a spinner that never
 * stops and a composer that only ever offers to steer.
 *
 * Two mechanisms close that: a debounced task re-read on every terminal turn
 * event, and a watchdog that asks what a claimed-running turn is doing after a
 * minute of silence.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  STUCK_TURN_CHECK_MS,
  STUCK_TURN_SILENCE_MS,
  useTerminusStore,
  useTurnWatchdog,
} from "../src/hooks/use-terminus";
import { api, TerminusApiError } from "../src/lib/api";
import type { Task, Turn } from "../src/types";

const now = "2026-08-28T00:00:00.000Z";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    session_id: "session-1",
    thread_id: "thread-1",
    status: "ACTIVE",
    phase: "EXECUTE",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: now,
    updated_at: now,
    completed_at: null,
    terminal_reason: null,
    contract: null,
    ...overrides,
  };
}

function turn(state: string): Turn {
  return {
    id: "turn-1",
    thread_id: "thread-1",
    task_id: "task-1",
    sequence: 1,
    state,
    initiating_actor: "user",
    started_at: now,
    completed_at: null,
  };
}

const runningTurn = { id: "turn-1", sequence: 1, state: "PROVIDER_RUNNING", started_at: null };

function install(current: Task): void {
  useTerminusStore.setState({
    selectedSessionId: current.session_id,
    selectedTaskId: current.id,
    taskById: { [current.id]: current },
    tasksBySession: { [current.session_id]: [current] },
    eventsByTask: {},
    eventBytesByTask: {},
    runActivityByTask: {},
    taskFreshnessById: {},
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  install(task({ active_turn: runningTurn }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("terminal turn events re-read the task", () => {
  test("an admitted turn enters the shared running projection immediately", () => {
    install(task({ status: "ACTIVE", active_turn: null }));

    useTerminusStore.getState().recordStartedTurn("task-1", turn("PENDING"));

    const state = useTerminusStore.getState();
    expect(state.runActivityByTask["task-1"]).toBe("running");
    expect(state.taskById["task-1"]?.active_turn).toMatchObject({ id: "turn-1", state: "PENDING" });
    expect(state.tasksBySession["session-1"]?.[0]?.active_turn).toMatchObject({ id: "turn-1" });
  });

  test("an authoritative idle task detail clears stale running activity", async () => {
    useTerminusStore.setState({ runActivityByTask: { "task-1": "running" } });
    vi.spyOn(api, "getTask").mockResolvedValue(task({ active_turn: null }));

    await useTerminusStore.getState().refreshTask("task-1");

    expect(useTerminusStore.getState().runActivityByTask["task-1"]).toBe("settled");
  });

  test("an authoritative idle task list clears stale background activity", async () => {
    useTerminusStore.setState({ runActivityByTask: { "task-1": "running" } });
    vi.spyOn(api, "listTasks").mockResolvedValue({
      tasks: [task({ active_turn: null })],
      next_cursor: null,
      total: 1,
      truncation: { occurred: false, continuation: null },
    });

    await useTerminusStore.getState().refreshTasks("session-1");

    const state = useTerminusStore.getState();
    expect(state.taskById["task-1"]?.active_turn).toBeNull();
    expect(state.runActivityByTask["task-1"]).toBe("settled");
  });

  test("a settled turn schedules exactly one debounced refresh for its burst", async () => {
    vi.useFakeTimers();
    const refreshed = vi.spyOn(api, "getTask").mockResolvedValue(task({ active_turn: null }));
    const store = useTerminusStore.getState();

    // One run's ending is several events. They must not be several fetches.
    store._appendEvent("task-1", { id: "settled-1", event: "turn.completed", data: "{}" });
    store._appendEvent("task-1", { id: "settled-2", event: "task.completed", data: "{}" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(refreshed).toHaveBeenCalledWith("task-1");
  });

  test("a running turn is not re-read", async () => {
    vi.useFakeTimers();
    const refreshed = vi.spyOn(api, "getTask").mockResolvedValue(task());

    useTerminusStore.getState()._appendEvent("task-1", { id: "running-1", event: "turn.started", data: "{}" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(refreshed).not.toHaveBeenCalled();
  });

  test("the event tail's verdict is recorded once, not recomputed per render", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "getTask").mockResolvedValue(task({ active_turn: null }));

    useTerminusStore.getState()._appendEvent("task-1", { id: "verdict-1", event: "turn.started", data: "{}" });
    await vi.advanceTimersByTimeAsync(100);
    expect(useTerminusStore.getState().runActivityByTask["task-1"]).toBe("running");

    useTerminusStore.getState()._appendEvent("task-1", { id: "verdict-2", event: "turn.failed", data: "{}" });
    await vi.advanceTimersByTimeAsync(100);
    expect(useTerminusStore.getState().runActivityByTask["task-1"]).toBe("settled");
  });
});

describe("reconcileActiveTurn", () => {
  test("re-reads the task when the turn it points at has already finished", async () => {
    vi.spyOn(api, "getTurn").mockResolvedValue(turn("COMPLETED"));
    const refreshed = vi.spyOn(api, "getTask").mockResolvedValue(task({ active_turn: null }));

    await useTerminusStore.getState().reconcileActiveTurn("task-1");

    expect(api.getTurn).toHaveBeenCalledWith("turn-1");
    expect(refreshed).toHaveBeenCalledWith("task-1");
    expect(useTerminusStore.getState().taskById["task-1"]?.active_turn).toBeNull();
  });

  test("leaves a genuinely running turn alone", async () => {
    vi.spyOn(api, "getTurn").mockResolvedValue(turn("PROVIDER_RUNNING"));
    const refreshed = vi.spyOn(api, "getTask").mockResolvedValue(task());

    await useTerminusStore.getState().reconcileActiveTurn("task-1");

    expect(refreshed).not.toHaveBeenCalled();
  });

  test("treats a turn the control plane no longer has as finished", async () => {
    vi.spyOn(api, "getTurn").mockRejectedValue(new TerminusApiError(404, "turn not found", null));
    const refreshed = vi.spyOn(api, "getTask").mockResolvedValue(task({ active_turn: null }));

    await useTerminusStore.getState().reconcileActiveTurn("task-1");

    expect(refreshed).toHaveBeenCalledWith("task-1");
  });

  test("does nothing at all when the task claims no running turn", async () => {
    install(task({ active_turn: null }));
    vi.spyOn(api, "getTurn").mockResolvedValue(turn("COMPLETED"));

    await useTerminusStore.getState().reconcileActiveTurn("task-1");

    expect(api.getTurn).not.toHaveBeenCalled();
  });

});

describe("the stuck-run watchdog", () => {
  test("asks what a silent running turn is doing, then leaves it alone for a window", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "getTurn").mockResolvedValue(turn("PROVIDER_RUNNING"));
    vi.spyOn(api, "getTask").mockResolvedValue(task());
    const view = renderHook(() => useTurnWatchdog());

    // Nothing happens until the stream has genuinely gone quiet.
    await vi.advanceTimersByTimeAsync(STUCK_TURN_CHECK_MS + 1);
    expect(api.getTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STUCK_TURN_SILENCE_MS);
    expect(api.getTurn).toHaveBeenCalledTimes(1);

    // Having just asked, it does not ask again on the next tick.
    await vi.advanceTimersByTimeAsync(STUCK_TURN_CHECK_MS + 1);
    expect(api.getTurn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STUCK_TURN_SILENCE_MS);
    expect(api.getTurn).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  test("stays quiet for a task with no running turn", async () => {
    vi.useFakeTimers();
    install(task({ active_turn: null }));
    vi.spyOn(api, "getTurn").mockResolvedValue(turn("COMPLETED"));
    const view = renderHook(() => useTurnWatchdog());

    await vi.advanceTimersByTimeAsync(STUCK_TURN_SILENCE_MS * 2);

    expect(api.getTurn).not.toHaveBeenCalled();
    view.unmount();
  });

  test("stays quiet while events are still arriving", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "getTurn").mockResolvedValue(turn("PROVIDER_RUNNING"));
    vi.spyOn(api, "getTask").mockResolvedValue(task());
    const view = renderHook(() => useTurnWatchdog());

    for (let tick = 0; tick < 8; tick += 1) {
      useTerminusStore.getState()._appendEvent("task-1", {
        id: `chatty-${tick}`,
        event: "turn.provider_text_delta",
        data: JSON.stringify({ text: "…" }),
      });
      await vi.advanceTimersByTimeAsync(STUCK_TURN_CHECK_MS);
    }

    expect(api.getTurn).not.toHaveBeenCalled();
    view.unmount();
  });
});
