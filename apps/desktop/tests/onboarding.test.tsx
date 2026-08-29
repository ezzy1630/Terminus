import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Onboarding, type OnboardingResult } from "../src/components/Onboarding";
import { api, TerminusApiError } from "../src/lib/api";
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
  terminal_reason: null,
  contract: null,
};

describe("Onboarding production flow", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useTerminusStore.setState({
      sessions: [],
      tasksBySession: {},
      taskById: {},
      selectedSessionId: null,
      selectedTaskId: null,
      healthReady: true,
      healthStatus: "ready",
      lastError: null,
    });
    vi.spyOn(api, "openWorkspace").mockResolvedValue({ id: "workspace-1" } as never);
    vi.spyOn(api, "createSession").mockResolvedValue(session);
    vi.spyOn(api, "getSession").mockResolvedValue(session);
    vi.spyOn(api, "health").mockResolvedValue({ ready: true } as never);
    vi.spyOn(api, "listSessions").mockResolvedValue({
      sessions: [session],
      total: 1,
      next_cursor: null,
      truncation: { occurred: false, continuation: null },
    });
    vi.spyOn(api, "createTask").mockResolvedValue(task);
    vi.spyOn(api, "startTask").mockResolvedValue({
      task_id: task.id,
      status: "ACTIVE",
      event_cursor: "event-1",
      links: { events: "/v1/events", task: `/v1/tasks/${task.id}` },
    });
    vi.spyOn(api, "listTasks").mockResolvedValue({
      tasks: [task],
      total: 1,
      next_cursor: null,
      truncation: { occurred: false, continuation: null },
    });
    vi.spyOn(api, "getTask").mockResolvedValue(task);
    vi.spyOn(api, "startTurn").mockResolvedValue({ id: "turn-1" } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTerminusStore.getState()._attachStream(null);
  });

  test("uses one explicit skip action and names the primary action", () => {
    render(<Onboarding onComplete={vi.fn()} pickDirectory={async () => null} />);

    expect(screen.getByRole("dialog", { name: "Open your first project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip onboarding" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open project" })).toBeInTheDocument();
  });

  test("uses Cancel as the only close action when opening another project", () => {
    render(<Onboarding mode="open-project" onComplete={vi.fn()} pickDirectory={async () => null} />);

    expect(screen.getByRole("dialog", { name: "Open project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel opening project" })).not.toBeInTheDocument();
  });

  // Opening a repository as `local_directory` throws away its git identity,
  // and opening a plain directory as `local_git` is refused outright. The shell
  // can tell them apart; when it cannot, the control plane's conflict does.
  test("opens a plain directory as local_directory when the shell says it is not a repo", async () => {
    (window as { terminusDesktop?: unknown }).terminusDesktop = {
      validateDirectory: vi.fn(async () => ({ ok: true, isGit: false, canonicalPath: "/tmp/plain" })),
    };
    const user = userEvent.setup();
    render(<Onboarding onComplete={vi.fn()} pickDirectory={async () => "/tmp/plain"} />);

    await user.click(screen.getByRole("button", { name: "Browse" }));
    await user.click(screen.getByRole("button", { name: "Open project" }));

    await waitFor(() => expect(api.openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "local_directory" }),
      expect.anything(),
    ));
    delete (window as { terminusDesktop?: unknown }).terminusDesktop;
  });

  test("retries with the other workspace kind when the identity conflicts", async () => {
    vi.mocked(api.openWorkspace)
      .mockRejectedValueOnce(new TerminusApiError(409, "workspace identity conflict", {
        code: "WORKSPACE_IDENTITY_CONFLICT",
        message: "workspace identity conflict",
        retryable: false,
        category: "conflict",
      }));
    const user = userEvent.setup();
    render(<Onboarding onComplete={vi.fn()} pickDirectory={async () => "/tmp/plain"} />);

    await user.click(screen.getByRole("button", { name: "Browse" }));
    await user.click(screen.getByRole("button", { name: "Open project" }));

    await waitFor(() => expect(api.openWorkspace).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.openWorkspace).mock.calls.map(([input]) => input.kind))
      .toEqual(["local_git", "local_directory"]);
  });

  test("new user chooses a project and starts the first task", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn<(result: OnboardingResult) => void>();
    const pickDirectory = vi.fn(async () => "/Volumes/Workspace/Terminus");
    render(<Onboarding onComplete={onComplete} pickDirectory={pickDirectory} />);

    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect(await screen.findByDisplayValue("/Volumes/Workspace/Terminus")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "First task prompt" }), "Audit the desktop UI.");
    await user.click(screen.getByRole("button", { name: "Open project" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(api.openWorkspace).toHaveBeenCalledWith({
      root_uri: "file:///Volumes/Workspace/Terminus",
      // Without a shell verdict the repository reading is tried first; a
      // `WORKSPACE_IDENTITY_CONFLICT` is what corrects it. Opening everything
      // as a plain directory stripped git identity from every repo.
      kind: "local_git",
      trust: "untrusted",
    }, { idempotencyKey: expect.stringMatching(/^onboarding:/) });
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      session_id: session.id,
      thread_id: "thread-1",
      objective: "Audit the desktop UI.",
    }), { idempotencyKey: expect.stringMatching(/^onboarding:/) });
    expect(api.startTask).toHaveBeenCalledWith(task.id, {
      idempotencyKey: expect.stringMatching(/^onboarding:/),
    });
    expect(api.startTurn).toHaveBeenCalledWith({
      thread_id: task.thread_id,
      task_id: task.id,
      user_input: "Audit the desktop UI.",
    }, { idempotencyKey: expect.stringMatching(/^onboarding:/) });
    expect(vi.mocked(api.startTask).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.startTurn).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(useTerminusStore.getState().selectedTaskId).toBe(task.id);
    expect(window.localStorage.getItem("terminus-desktop.onboarding-draft.v1.first-run")).toBeNull();
  });

  test("restores the exact workspace and objective after the renderer remounts", async () => {
    const user = userEvent.setup();
    const first = render(<Onboarding onComplete={() => {}} pickDirectory={async () => "/Volumes/Workspace/Terminus"} />);

    await user.click(screen.getByRole("button", { name: "Browse" }));
    await user.type(screen.getByRole("textbox", { name: "First task prompt" }), "Resume the exact operation.");
    first.unmount();

    render(<Onboarding onComplete={() => {}} pickDirectory={async () => null} />);
    expect(screen.getByRole("textbox", { name: "First task prompt" })).toHaveValue("Resume the exact operation.");
  });

  test("resumes after the last durable setup step instead of repeating earlier effects", async () => {
    const user = userEvent.setup();
    vi.mocked(api.startTurn).mockRejectedValueOnce(new TerminusApiError(0, "connection lost", null));
    const first = render(
      <Onboarding onComplete={() => {}} pickDirectory={async () => "/Volumes/Workspace/Terminus"} />,
    );

    await user.click(screen.getByRole("button", { name: "Browse" }));
    await user.type(screen.getByRole("textbox", { name: "First task prompt" }), "Resume the durable chain.");
    await user.click(screen.getByRole("button", { name: "Open project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("connection lost");
    const firstTurnKey = vi.mocked(api.startTurn).mock.calls[0]?.[1].idempotencyKey;
    first.unmount();

    const onComplete = vi.fn<(result: OnboardingResult) => void>();
    render(<Onboarding onComplete={onComplete} pickDirectory={async () => null} />);
    await user.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    expect(api.openWorkspace).toHaveBeenCalledTimes(1);
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(api.startTask).toHaveBeenCalledTimes(1);
    expect(api.getSession).toHaveBeenCalledWith(session.id);
    expect(api.getTask).toHaveBeenCalledWith(task.id);
    expect(api.startTurn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.startTurn).mock.calls[1]?.[1].idempotencyKey).toBe(firstTurnKey);
  });

  test("offers the created project after a definitive later rejection and preserves the prompt", async () => {
    const user = userEvent.setup();
    vi.mocked(api.startTurn).mockRejectedValueOnce(new TerminusApiError(422, "objective rejected", null));
    const onComplete = vi.fn<(result: OnboardingResult) => void>();
    render(
      <Onboarding onComplete={onComplete} pickDirectory={async () => "/Volumes/Workspace/Terminus"} />,
    );

    await user.click(screen.getByRole("button", { name: "Browse" }));
    await user.type(screen.getByRole("textbox", { name: "First task prompt" }), "Keep this correction draft.");
    await user.click(screen.getByRole("button", { name: "Open project" }));

    expect(await screen.findByText(/project opened, but the first task did not/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue with created project" }));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ session, skipped: false }));
    expect(useTerminusStore.getState().draftsByTask.__new__).toBe("Keep this correction draft.");
    expect(window.localStorage.getItem("terminus.pending-mutation.v1.onboarding")).toBeNull();
  });

  test.each([
    ["/tmp/space name", "file:///tmp/space%20name"],
    ["/tmp/hash#name", "file:///tmp/hash%23name"],
    ["/tmp/query?name", "file:///tmp/query%3Fname"],
    ["/tmp/percent%name", "file:///tmp/percent%25name"],
    ["/tmp/文档", "file:///tmp/%E6%96%87%E6%A1%A3"],
  ])("encodes the native project path %s without reinterpreting URL syntax", async (path, rootUri) => {
    const user = userEvent.setup();
    const onComplete = vi.fn<(result: OnboardingResult) => void>();
    render(<Onboarding mode="open-project" initialStep={2} onComplete={onComplete} pickDirectory={async () => path} />);

    await user.click(screen.getByRole("button", { name: "Browse" }));
    await user.click(screen.getByRole("button", { name: "Open project" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(api.openWorkspace).toHaveBeenCalledWith({
      root_uri: rootUri,
      // Without a shell verdict the repository reading is tried first; a
      // `WORKSPACE_IDENTITY_CONFLICT` is what corrects it. Opening everything
      // as a plain directory stripped git identity from every repo.
      kind: "local_git",
      trust: "untrusted",
    }, { idempotencyKey: expect.stringMatching(/^onboarding:/) });
  });
});
