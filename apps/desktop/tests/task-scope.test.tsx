/**
 * Every task the desktop creates must be allowed to touch its own workspace.
 *
 * `POST /v1/tasks` defaults `allowed_scope` to `{}` when the caller omits it,
 * and the desktop omitted it. The resulting contract grants no read, write, or
 * exec paths at all, and `changePolicy.mayExpandScope` is false — so the task
 * can never widen it either. Verified against a live control plane on
 * 2026-08-28: both `POST /v1/tools/exec` and `GET /v1/tasks/:id/diff` failed
 * with "task <id> contract grants no workspace paths for the requested
 * operation" for a task this app had created. Every tool call the agent makes
 * is denied at the capability boundary.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NewTaskScreen } from "../src/components/NewTaskScreen";
import { WORKSPACE_TASK_SCOPE } from "../src/lib/task-scope";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { api } from "../src/lib/api";
import type { Session, Task } from "../src/types";

const now = "2026-08-28T00:00:00.000Z";

const session: Session = {
  id: "session-1",
  workspace_id: "workspace-1",
  title: "tiny-repo",
  status: "active",
  active_thread_id: "thread-1",
  created_at: now,
  updated_at: now,
};

const created: Task = {
  id: "task-1",
  session_id: "session-1",
  thread_id: "thread-1",
  status: "DRAFT",
  phase: "INTAKE",
  active_contract_version: 1,
  risk_class: "normal",
  created_at: now,
  updated_at: now,
  completed_at: null,
  terminal_reason: null,
  contract: null,
};

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  useTerminusStore.setState({
    sessions: [session],
    selectedSessionId: session.id,
    healthReady: true,
    healthStatus: "ready",
    draftsByTask: {},
    sessionDraftsByTask: {},
    refreshTasks: vi.fn(async () => undefined),
    selectTask: vi.fn(),
  });
  vi.spyOn(api, "createTask").mockResolvedValue(created);
  vi.spyOn(api, "startTask").mockResolvedValue({
    task_id: "task-1", status: "ACTIVE", event_cursor: "c1", links: { events: "", task: "" },
  });
  vi.spyOn(api, "startTurn").mockResolvedValue({} as never);
  vi.spyOn(api, "listProviderModels").mockResolvedValue({ providers: [], models: [], error: null } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("task creation scope", () => {
  test("asks for the whole workspace, not for nothing", async () => {
    const user = userEvent.setup();
    render(<NewTaskScreen />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "Explain a.ts");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(api.createTask).toHaveBeenCalled());
    expect(vi.mocked(api.createTask).mock.calls[0]?.[0]).toMatchObject({
      allowed_scope: WORKSPACE_TASK_SCOPE,
    });
  });
});

describe("WORKSPACE_TASK_SCOPE", () => {
  test("covers the workspace root, which is what a diff or an exec asks for", () => {
    // `GET /v1/tasks/:id/diff` requests the path "." and the control plane
    // checks it against these patterns with a glob matcher.
    expect(WORKSPACE_TASK_SCOPE.read_paths.some((pattern) => pattern === "**")).toBe(true);
    expect(WORKSPACE_TASK_SCOPE.write_paths.some((pattern) => pattern === "**")).toBe(true);
  });

  test("grants no external systems by default", () => {
    // Network and third-party effects stay off unless something asks.
    expect(WORKSPACE_TASK_SCOPE.external_systems).toEqual([]);
  });
});
