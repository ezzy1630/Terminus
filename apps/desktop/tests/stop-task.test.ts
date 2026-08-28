/**
 * Stopping a run, and ending a task.
 *
 * Before this existed the app had no user-reachable stop control at all:
 * `ComposerSendMode` declared a `"stop"` member that every call site narrowed
 * away, `api.cancelTask` was called only from tests, and the board's Cancel
 * used `transitionTask(..., "CANCELLED")` — which writes the snapshot and
 * projects the v1 status but never signals the running loop, so the agent kept
 * working on a task the board had already marked cancelled.
 *
 * The first fix for that made Stop call `api.cancelTask`, which was still
 * wrong: cancelling drives the task to ABORTED, which is terminal, so the
 * composer then refuses further input. "Stop, that's not what I meant, do this
 * instead" is the most common thing to want after pressing stop, and it was
 * impossible. Stop now interrupts the active turn and leaves the task
 * steerable; Cancel is the separate, destructive action.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useTerminusStore } from "../src/hooks/use-terminus";
import { api, TerminusApiError } from "../src/lib/api";
import { buildDefaultCommands } from "../src/lib/command-catalog";
import { FIXED_SHORTCUTS, matchesShortcut, shortcutDisplay } from "../src/lib/shortcuts";
import type { Task } from "../src/types";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    session_id: "session-1",
    thread_id: "thread-1",
    status: "ACTIVE",
    phase: "EXECUTE",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    completed_at: null,
    terminal_reason: null,
    contract: null,
    active_turn: { id: "turn-9", sequence: 2, state: "PROVIDER_RUNNING", started_at: null },
    ...overrides,
  };
}

describe("stopTask", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useTerminusStore.setState({ lastError: null, taskById: {}, tasksBySession: {} });
  });

  test("interrupts the running turn instead of ending the task", () => {
    const interruptTurn = vi.spyOn(api, "interruptTurn").mockResolvedValue({} as never);
    const cancelTask = vi.spyOn(api, "cancelTask").mockResolvedValue({} as never);
    vi.spyOn(api, "getTask").mockResolvedValue(task());
    useTerminusStore.setState({ refreshTask: vi.fn(async () => {}) });

    return useTerminusStore.getState().stopTask("task-1").then((failure) => {
      expect(failure).toBeNull();
      expect(interruptTurn).toHaveBeenCalledWith(
        "turn-9",
        { idempotencyKey: expect.any(String) },
        "user_stopped",
      );
      // Cancelling would make the task terminal and unsteerable.
      expect(cancelTask).not.toHaveBeenCalled();
    });
  });

  test("reads the active turn from the snapshot, so it works after a reload", async () => {
    // The turn id is on no event payload; only GET /v1/tasks/:id carries it.
    const getTask = vi.spyOn(api, "getTask").mockResolvedValue(task());
    vi.spyOn(api, "interruptTurn").mockResolvedValue({} as never);
    useTerminusStore.setState({ refreshTask: vi.fn(async () => {}) });

    await useTerminusStore.getState().stopTask("task-1");

    expect(getTask).toHaveBeenCalledWith("task-1");
  });

  test("carries an idempotency key, which the control plane requires on mutations", async () => {
    const interruptTurn = vi.spyOn(api, "interruptTurn").mockResolvedValue({} as never);
    vi.spyOn(api, "getTask").mockResolvedValue(task());
    useTerminusStore.setState({ refreshTask: vi.fn(async () => {}) });

    await useTerminusStore.getState().stopTask("task-1");
    await useTerminusStore.getState().stopTask("task-1");

    const keys = interruptTurn.mock.calls.map(([, options]) => (options as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBeTruthy();
    // Two deliberate stops are two requests, not one replayed key.
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("does nothing but record the settled task when the run already finished", async () => {
    const settled = task({ active_turn: null, status: "COMPLETED" });
    vi.spyOn(api, "getTask").mockResolvedValue(settled);
    const interruptTurn = vi.spyOn(api, "interruptTurn").mockResolvedValue({} as never);

    const failure = await useTerminusStore.getState().stopTask("task-1");

    // Sending an interrupt here could only 409. Nothing went wrong.
    expect(failure).toBeNull();
    expect(interruptTurn).not.toHaveBeenCalled();
    expect(useTerminusStore.getState().taskById["task-1"]?.status).toBe("COMPLETED");
  });

  test("refreshes the task so the surface stops claiming it is running", async () => {
    vi.spyOn(api, "getTask").mockResolvedValue(task());
    vi.spyOn(api, "interruptTurn").mockResolvedValue({} as never);
    const refreshTask = vi.fn(async () => {});
    useTerminusStore.setState({ refreshTask });

    await useTerminusStore.getState().stopTask("task-1");

    expect(refreshTask).toHaveBeenCalledWith("task-1");
  });

  test("returns the failure instead of throwing, so the composer can show it", async () => {
    vi.spyOn(api, "getTask").mockResolvedValue(task());
    vi.spyOn(api, "interruptTurn").mockRejectedValue(
      new TerminusApiError(409, "turn cannot be interrupted from COMPLETED", null),
    );

    const failure = await useTerminusStore.getState().stopTask("task-1");

    expect(failure).toBe("turn cannot be interrupted from COMPLETED");
    expect(useTerminusStore.getState().lastError).toBe("turn cannot be interrupted from COMPLETED");
  });

  test("does not refresh after a failed stop", async () => {
    vi.spyOn(api, "getTask").mockResolvedValue(task());
    vi.spyOn(api, "interruptTurn").mockRejectedValue(new Error("network error"));
    const refreshTask = vi.fn(async () => {});
    useTerminusStore.setState({ refreshTask });

    await useTerminusStore.getState().stopTask("task-1");

    expect(refreshTask).not.toHaveBeenCalled();
  });
});

describe("cancelTask", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useTerminusStore.setState({ lastError: null });
  });

  test("uses the endpoint that both aborts every turn and ends the task", async () => {
    const cancelTask = vi.spyOn(api, "cancelTask").mockResolvedValue({} as never);
    useTerminusStore.setState({ refreshTask: vi.fn(async () => {}) });

    const failure = await useTerminusStore.getState().cancelTask("task-1");

    expect(failure).toBeNull();
    expect(cancelTask).toHaveBeenCalledWith(
      "task-1",
      { idempotencyKey: expect.any(String) },
      "user_cancelled",
    );
  });

  test("surfaces a refusal rather than throwing", async () => {
    vi.spyOn(api, "cancelTask").mockRejectedValue(new TerminusApiError(409, "task is already terminal", null));

    expect(await useTerminusStore.getState().cancelTask("task-1")).toBe("task is already terminal");
  });
});

describe("stop is reachable", () => {
  test("is bound to the macOS stop shortcut", () => {
    // Cmd-Period is the macOS convention for "stop what you are doing".
    expect(FIXED_SHORTCUTS.stopRun.display).toBe("⌘.");
    const cmdPeriod = { key: ".", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(matchesShortcut(cmdPeriod, FIXED_SHORTCUTS.stopRun, "mac")).toBe(true);
  });

  test("uses the control modifier off macOS", () => {
    const ctrlPeriod = { key: ".", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false };
    expect(matchesShortcut(ctrlPeriod, FIXED_SHORTCUTS.stopRun, "other")).toBe(true);
    expect(shortcutDisplay(FIXED_SHORTCUTS.stopRun, "other")).toBe("Ctrl+.");
  });

  test("does not fire on the period key alone", () => {
    const bare = { key: ".", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(matchesShortcut(bare, FIXED_SHORTCUTS.stopRun, "mac")).toBe(false);
    expect(matchesShortcut(bare, FIXED_SHORTCUTS.stopRun, "other")).toBe(false);
  });

  test("appears in the command palette when a task is selected", () => {
    const stopRun = vi.fn();
    const commands = buildDefaultCommands({ stopRun });
    const command = commands.find((entry) => entry.id === "task.stop");
    expect(command?.label).toBe("Stop this run");
    expect(command?.hint).toBe(shortcutDisplay(FIXED_SHORTCUTS.stopRun));
    command?.action();
    expect(stopRun).toHaveBeenCalledOnce();
  });

  test("is hidden when there is no task to stop", () => {
    const commands = buildDefaultCommands({});
    expect(commands.some((entry) => entry.id === "task.stop")).toBe(false);
  });
});
