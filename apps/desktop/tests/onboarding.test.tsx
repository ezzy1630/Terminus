import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Onboarding, type OnboardingResult } from "../src/components/Onboarding";
import { api } from "../src/lib/api";
import { useTerminusStore } from "../src/hooks/use-terminus";
import type { Session, Task } from "../src/types";

const session: Session = {
  id: "session-1",
  workspace_id: "workspace-1",
  title: "Terminus",
  status: "active",
  active_thread_id: "thread-1",
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
};

const task: Task = {
  id: "task-1",
  session_id: session.id,
  thread_id: "thread-1",
  status: "ACTIVE",
  phase: "EXECUTING",
  active_contract_version: 1,
  risk_class: "normal",
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
  completed_at: null,
};

describe("Onboarding production flow", () => {
  beforeEach(() => {
    useTerminusStore.setState({
      sessions: [],
      tasksBySession: {},
      taskById: {},
      selectedSessionId: null,
      selectedTaskId: null,
      lastError: null,
    });
    vi.spyOn(api, "openWorkspace").mockResolvedValue({ id: "workspace-1" } as never);
    vi.spyOn(api, "createSession").mockResolvedValue(session);
    vi.spyOn(api, "health").mockResolvedValue({ ready: true } as never);
    vi.spyOn(api, "listSessions").mockResolvedValue({ sessions: [session] });
    vi.spyOn(api, "createTask").mockResolvedValue(task);
    vi.spyOn(api, "startTask").mockResolvedValue({
      task_id: task.id,
      status: "ACTIVE",
      event_cursor: "event-1",
      links: { events: "/v1/events", task: `/v1/tasks/${task.id}` },
    });
    vi.spyOn(api, "listTasks").mockResolvedValue({ tasks: [task] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTerminusStore.getState()._attachStream(null);
  });

  test("new user chooses a project and starts the first task", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn<(result: OnboardingResult) => void>();
    const pickDirectory = vi.fn(async () => "/Volumes/Neural/Terminus");
    render(<Onboarding onComplete={onComplete} pickDirectory={pickDirectory} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect(await screen.findByDisplayValue("/Volumes/Neural/Terminus")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Confirm detected tools" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await user.type(screen.getByRole("textbox", { name: "First task prompt" }), "Audit the desktop UI.");
    await user.click(screen.getByRole("button", { name: "Open workspace" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(api.openWorkspace).toHaveBeenCalledWith({
      root_uri: "file:///Volumes/Neural/Terminus",
      kind: "local_directory",
      trust: "trusted",
    });
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      session_id: session.id,
      thread_id: "thread-1",
      objective: "Audit the desktop UI.",
    }));
    expect(api.startTask).toHaveBeenCalledWith(task.id);
    expect(useTerminusStore.getState().selectedTaskId).toBe(task.id);
  });
});
