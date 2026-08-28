/**
 * Work started outside the open space has to be visible.
 *
 * `refreshAll` used to load tasks only for `selectedSessionId`, so a task
 * created in another project produced no sidebar row, no count, and no
 * attention badge until the user happened to click that project. These tests
 * pin the hydration, and pin that it stays bounded.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useTerminusStore } from "../src/hooks/use-terminus";
import type { Session, Task } from "../src/types";

function session(id: string, updatedAt: string): Session {
  return {
    id,
    workspace_id: `workspace-${id}`,
    owner_principal: "operator",
    title: `Space ${id}`,
    status: "active",
    default_model_profile: "implementer",
    default_permission_profile: "secure-local-default",
    active_thread_id: `thread-${id}`,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: updatedAt,
  };
}

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

describe("refreshVisibleSessionTasks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useTerminusStore.setState({ sessions: [], selectedSessionId: null, tasksBySession: {} });
  });

  test("loads tasks for spaces the user has not opened", async () => {
    const sessions = [session("a", "2026-08-03T00:00:00.000Z"), session("b", "2026-08-02T00:00:00.000Z")];
    useTerminusStore.setState({ sessions, selectedSessionId: "a" });
    const refreshTasks = vi.fn(async (sessionId: string) => {
      useTerminusStore.setState((state) => ({
        tasksBySession: { ...state.tasksBySession, [sessionId]: [task(`task-${sessionId}`, sessionId)] },
      }));
    });
    useTerminusStore.setState({ refreshTasks });

    await useTerminusStore.getState().refreshVisibleSessionTasks();

    expect(refreshTasks).toHaveBeenCalledWith("b");
    expect(useTerminusStore.getState().tasksBySession.b).toHaveLength(1);
  });

  test("does not re-request the space that is already open", async () => {
    useTerminusStore.setState({
      sessions: [session("a", "2026-08-03T00:00:00.000Z"), session("b", "2026-08-02T00:00:00.000Z")],
      selectedSessionId: "a",
    });
    const refreshTasks = vi.fn(async () => {});
    useTerminusStore.setState({ refreshTasks });

    await useTerminusStore.getState().refreshVisibleSessionTasks();

    expect(refreshTasks).toHaveBeenCalledTimes(1);
    expect(refreshTasks).not.toHaveBeenCalledWith("a");
  });

  test("stays bounded, taking the most recently touched spaces first", async () => {
    // 30 spaces, ascending recency, so the newest ids sort to the front.
    const sessions = Array.from({ length: 30 }, (_, index) =>
      session(`s${String(index).padStart(2, "0")}`, `2026-08-01T00:${String(index).padStart(2, "0")}:00.000Z`));
    useTerminusStore.setState({ sessions, selectedSessionId: null });
    const requested: string[] = [];
    const refreshTasks = vi.fn(async (sessionId: string) => { requested.push(sessionId); });
    useTerminusStore.setState({ refreshTasks });

    await useTerminusStore.getState().refreshVisibleSessionTasks();

    expect(requested).toHaveLength(12);
    expect(requested).toContain("s29");
    expect(requested).not.toContain("s00");
  });

  test("does nothing when there are no other spaces", async () => {
    useTerminusStore.setState({ sessions: [], selectedSessionId: null });
    const refreshTasks = vi.fn(async () => {});
    useTerminusStore.setState({ refreshTasks });

    await expect(useTerminusStore.getState().refreshVisibleSessionTasks()).resolves.toBeUndefined();
    expect(refreshTasks).not.toHaveBeenCalled();
  });
});
