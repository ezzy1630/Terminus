import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../src/App";
import { useTerminusStore } from "../src/hooks/use-terminus";
import type { Task } from "../src/types";

const originalActions = (() => {
  const state = useTerminusStore.getState();
  return {
    refreshAll: state.refreshAll,
    refreshPinnedTasks: state.refreshPinnedTasks,
    refreshSessions: state.refreshSessions,
    refreshTasks: state.refreshTasks,
    refreshTask: state.refreshTask,
    refreshApprovals: state.refreshApprovals,
  };
})();

function task(id: string, sessionId = "session-pins"): Task {
  const now = new Date().toISOString();
  return {
    id,
    session_id: sessionId,
    thread_id: `thread-${id}`,
    status: "ACTIVE",
    phase: "EXECUTING",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: now,
    updated_at: now,
    completed_at: null,
    terminal_reason: null,
    contract: null,
  };
}

function resetStore(): void {
  useTerminusStore.setState({
    ...originalActions,
    sessions: [],
    tasksBySession: {},
    taskById: {},
    selectedSessionId: null,
    selectedTaskId: null,
    pinnedTaskIds: new Set(),
    taskFreshnessById: {},
    approvalsByTask: {},
    approvalFreshnessByTask: {},
    approvalPagesByTask: {},
  });
}

describe("pinned task freshness", () => {
  beforeEach(() => {
    resetStore();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    resetStore();
    window.localStorage.clear();
  });

  test("refreshes cached and cold non-selected pins while skipping the selected pin", async () => {
    const selected = task("pin-selected");
    const cached = task("pin-cached");
    const refreshTask = vi.fn(async (_taskId: string) => undefined);
    useTerminusStore.setState({
      selectedSessionId: selected.session_id,
      selectedTaskId: selected.id,
      pinnedTaskIds: new Set([selected.id, cached.id, "pin-cold"]),
      taskById: { [selected.id]: selected, [cached.id]: cached },
      tasksBySession: { [selected.session_id]: [selected, cached] },
      refreshTask,
    });

    await useTerminusStore.getState().refreshPinnedTasks();

    expect(refreshTask).toHaveBeenCalledTimes(2);
    expect(refreshTask).toHaveBeenCalledWith(cached.id);
    expect(refreshTask).toHaveBeenCalledWith("pin-cold");
    expect(refreshTask).not.toHaveBeenCalledWith(selected.id);
  });

  test("refreshAll reconciles the selected task once and every other pin", async () => {
    const selected = task("pin-selected");
    const other = task("pin-other");
    const refreshSessions = vi.fn(async () => undefined);
    const refreshTasks = vi.fn(async (_sessionId: string) => undefined);
    const refreshTask = vi.fn(async (_taskId: string) => undefined);
    const refreshApprovals = vi.fn(async (_taskId: string) => undefined);
    useTerminusStore.setState({
      refreshAll: originalActions.refreshAll,
      refreshPinnedTasks: originalActions.refreshPinnedTasks,
      refreshSessions,
      refreshTasks,
      refreshTask,
      refreshApprovals,
      selectedSessionId: selected.session_id,
      selectedTaskId: selected.id,
      pinnedTaskIds: new Set([selected.id, other.id]),
      taskById: { [selected.id]: selected, [other.id]: other },
      tasksBySession: { [selected.session_id]: [selected, other] },
    });

    await useTerminusStore.getState().refreshAll();

    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(refreshTasks).toHaveBeenCalledOnce();
    expect(refreshTask).toHaveBeenCalledTimes(2);
    expect(refreshTask).toHaveBeenCalledWith(other.id);
    expect(refreshTask).toHaveBeenCalledWith(selected.id);
    expect(refreshTask.mock.calls.filter(([taskId]) => taskId === selected.id)).toHaveLength(1);
    expect(refreshApprovals).toHaveBeenCalledOnce();
    expect(refreshApprovals).toHaveBeenCalledWith(selected.id);
  });

  test("window focus refreshes projects and non-selected pins without rerunning refreshAll", async () => {
    const refreshAll = vi.fn(async () => undefined);
    const refreshSessions = vi.fn(async () => undefined);
    const refreshPinnedTasks = vi.fn(async () => undefined);
    useTerminusStore.setState({ refreshAll, refreshSessions, refreshPinnedTasks });
    window.localStorage.setItem("terminus-desktop.onboarding.completed.v1", "true");

    render(<App />);
    await waitFor(() => expect(refreshAll).toHaveBeenCalledOnce());

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(refreshSessions).toHaveBeenCalledOnce();
      expect(refreshPinnedTasks).toHaveBeenCalledOnce();
    });
    expect(refreshAll).toHaveBeenCalledOnce();
  });
});
