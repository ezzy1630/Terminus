/**
 * Switching projects.
 *
 * The observed build had no switcher at all: the sidebar's "SPACES" header was
 * a label, the `+` beside it hid itself whenever the project list was empty
 * (i.e. exactly when it was needed), the composer's project chip opened the
 * *task* filter, and the palette could only open a new project, never move to
 * one already open. Launching always dropped into `sessions[0]` regardless of
 * where the operator had been.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ProjectMenu } from "../src/components/ProjectMenu";
import { Sidebar } from "../src/components/Sidebar";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { api, TerminusApiError } from "../src/lib/api";
import { buildDefaultCommands } from "../src/lib/command-catalog";
import { noteRecentProject, projectUriToPath, readRecentProjects, sameProjectRoot } from "../src/lib/projects";
import type { Session } from "../src/types";
import { Button } from "../src/ui/Button";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      openWorkspace: vi.fn(),
      createSession: vi.fn(),
      listSessions: vi.fn(async () => ({ sessions: [], total: 0, next_cursor: null, truncation: { occurred: false, continuation: null } })),
      listTasks: vi.fn(async () => []),
      health: vi.fn(async () => ({ status: "ok", ready: true, kernel: null })),
    },
  };
});

const now = "2026-08-28T00:00:00.000Z";

function session(id: string, title: string, rootUri?: string): Session {
  return {
    id,
    workspace_id: `ws-${id}`,
    title,
    status: "active",
    active_thread_id: `thread-${id}`,
    created_at: now,
    updated_at: now,
    ...(rootUri ? { workspace_root_uri: rootUri } : {}),
  } as Session;
}

function install(sessions: readonly Session[], selectedSessionId: string | null): void {
  useTerminusStore.setState({
    sessions: [...sessions],
    selectedSessionId,
    selectedTaskId: null,
    tasksBySession: {},
    taskById: {},
    taskPagesBySession: {},
    taskListFreshnessBySession: {},
    sessionsFreshness: { status: "ready", error: null },
    loadingSessions: false,
    healthReady: true,
    healthStatus: "ready",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  window.localStorage.clear();
  delete (window as { terminusDesktop?: unknown }).terminusDesktop;
});

afterEach(() => {
  cleanup();
  delete (window as { terminusDesktop?: unknown }).terminusDesktop;
});

describe("project identity", () => {
  test("a root URI reads back as the path a human typed", () => {
    expect(projectUriToPath("file:///Volumes/Workspace/Terminus")).toBe("/Volumes/Workspace/Terminus");
    expect(projectUriToPath("file:///Users/x/my%20repo")).toBe("/Users/x/my repo");
    // A non-file workspace is shown as it is rather than mangled.
    expect(projectUriToPath("ssh://host/srv/repo")).toBe("ssh://host/srv/repo");
  });

  test("a trailing slash does not make a second project", () => {
    expect(sameProjectRoot("file:///a/b", "file:///a/b/")).toBe(true);
    expect(sameProjectRoot("file:///a/b", "file:///a/c")).toBe(false);
    expect(sameProjectRoot(null, "file:///a/b")).toBe(false);
  });

  test("recents are most-recent-first and bounded", async () => {
    for (let i = 0; i < 12; i += 1) await noteRecentProject(`/repo/${i}`);
    const recents = readRecentProjects();
    expect(recents[0]).toBe("/repo/11");
    expect(recents).toHaveLength(10);

    await noteRecentProject("/repo/5");
    expect(readRecentProjects()[0]).toBe("/repo/5");
    // Re-opening moves it rather than duplicating it.
    expect(readRecentProjects().filter((entry) => entry === "/repo/5")).toHaveLength(1);
  });

  test("defers to the shell's list when the bridge keeps one", async () => {
    const noteInShell = vi.fn(async () => ["/from/shell", "/older"]);
    (window as { terminusDesktop?: unknown }).terminusDesktop = { noteRecentProject: noteInShell };

    const result = await noteRecentProject("/from/shell");

    expect(noteInShell).toHaveBeenCalledWith("/from/shell");
    expect(result).toEqual(["/from/shell", "/older"]);
    expect(readRecentProjects()).toEqual(["/from/shell", "/older"]);
  });
});

describe("the switcher menu", () => {
  test("lists every project with its path and marks the current one", async () => {
    install([session("a", "Terminus", "file:///Volumes/Workspace/Terminus"), session("b", "Site")], "a");
    const user = userEvent.setup();
    render(<ProjectMenu trigger={<Button type="button">Terminus</Button>} />);

    await user.click(screen.getByRole("button", { name: "Switch project" }));

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "✓Terminus/Volumes/Workspace/Terminus",
      "Site",
      "Add repository…",
    ]);
  });

  test("switching selects the project", async () => {
    install([session("a", "Terminus"), session("b", "Site")], "a");
    const onProjectSelected = vi.fn();
    const user = userEvent.setup();
    render(<ProjectMenu trigger={<Button type="button">Open</Button>} onProjectSelected={onProjectSelected} />);

    await user.click(screen.getByRole("button", { name: "Switch project" }));
    await user.click(await screen.findByRole("menuitem", { name: /Site/ }));

    await waitFor(() => expect(useTerminusStore.getState().selectedSessionId).toBe("b"));
    expect(onProjectSelected).toHaveBeenCalledWith("b");
  });

  test("offers a recent directory that is not open yet", async () => {
    await noteRecentProject("/repo/closed");
    install([session("a", "Terminus", "file:///Volumes/Workspace/Terminus")], "a");
    const user = userEvent.setup();
    render(<ProjectMenu trigger={<Button type="button">Open</Button>} />);

    await user.click(screen.getByRole("button", { name: "Switch project" }));

    expect(await screen.findByRole("menuitem", { name: /\/repo\/closed/ })).toBeInTheDocument();
  });

  test("falls back to the onboarding overlay when there is no native picker", async () => {
    install([], null);
    const onOpenProject = vi.fn();
    const user = userEvent.setup();
    render(<ProjectMenu trigger={<Button type="button">Open</Button>} onOpenProject={onOpenProject} />);

    await user.click(screen.getByRole("button", { name: "Switch project" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add repository…" }));

    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });
});

describe("the sidebar header", () => {
  test("names the current project and keeps the add control visible with no projects", async () => {
    install([], null);
    render(<Sidebar onOpenProject={() => undefined} />);

    // The old build hid `+` until a project existed, which is exactly backwards.
    expect(screen.getByRole("button", { name: "Add or switch project" })).toBeInTheDocument();

    cleanup();
    install([session("a", "Terminus", "file:///Volumes/Workspace/Terminus")], "a");
    render(<Sidebar onOpenProject={() => undefined} />);
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Terminus");
  });
});

describe("opening a directory", () => {
  test("selects the project already open on that path instead of duplicating it", async () => {
    install([session("a", "Terminus", "file:///Volumes/Workspace/Terminus")], "b");

    const id = await useTerminusStore.getState().openProjectPath("/Volumes/Workspace/Terminus");

    expect(id).toBe("a");
    expect(api.openWorkspace).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(useTerminusStore.getState().selectedSessionId).toBe("a");
  });

  test("opens a repository as local_git when the shell says it is one", async () => {
    install([], null);
    (window as { terminusDesktop?: unknown }).terminusDesktop = {
      validateDirectory: vi.fn(async () => ({ ok: true, isGit: true, canonicalPath: "/repo" })),
    };
    vi.mocked(api.openWorkspace).mockResolvedValue({ id: "ws-new", root_uri: "file:///repo", kind: "local_git", trust: "untrusted" } as never);
    vi.mocked(api.createSession).mockResolvedValue(session("new", "repo", "file:///repo"));

    await useTerminusStore.getState().openProjectPath("/repo");

    expect(api.openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ root_uri: "file:///repo", kind: "local_git" }),
      expect.anything(),
    );
  });

  test("retries with the other kind when the control plane says the identity conflicts", async () => {
    install([], null);
    vi.mocked(api.openWorkspace)
      .mockRejectedValueOnce(new TerminusApiError(409, "workspace identity conflict", {
        code: "WORKSPACE_IDENTITY_CONFLICT",
        message: "workspace identity conflict",
        retryable: false,
        category: "conflict",
      }))
      .mockResolvedValue({ id: "ws-new", root_uri: "file:///plain", kind: "local_directory", trust: "untrusted" } as never);
    vi.mocked(api.createSession).mockResolvedValue(session("new", "plain", "file:///plain"));

    await useTerminusStore.getState().openProjectPath("/plain");

    expect(vi.mocked(api.openWorkspace).mock.calls.map(([input]) => input.kind)).toEqual(["local_git", "local_directory"]);
  });

  test("reuses the session already bound to a workspace opened twice", async () => {
    install([], null);
    vi.mocked(api.openWorkspace).mockResolvedValue({ id: "ws-a", root_uri: "file:///repo", kind: "local_git", trust: "untrusted" } as never);
    // The refresh that follows `openWorkspace` reveals the existing session.
    vi.mocked(api.listSessions).mockResolvedValue({
      sessions: [{ ...session("a", "repo", "file:///elsewhere"), workspace_id: "ws-a" }],
      total: 1,
      next_cursor: null,
      truncation: { occurred: false, continuation: null },
    });

    const id = await useTerminusStore.getState().openProjectPath("/repo");

    expect(id).toBe("a");
    expect(api.createSession).not.toHaveBeenCalled();
  });

  test("rejects a relative path rather than sending it to the control plane", async () => {
    install([], null);
    await expect(useTerminusStore.getState().openProjectPath("relative/path"))
      .rejects.toThrow(/absolute/);
    expect(api.openWorkspace).not.toHaveBeenCalled();
  });
});

describe("the command palette", () => {
  test("can switch to any project but not to the current one", () => {
    const selectProject = vi.fn();
    const commands = buildDefaultCommands({
      selectProject,
      projects: [
        { id: "a", title: "Terminus", path: "/Volumes/Workspace/Terminus", current: true },
        { id: "b", title: "Site", path: "/srv/site", current: false },
      ],
    });

    const switchCommands = commands.filter((command) => command.id.startsWith("project.switch."));
    expect(switchCommands.map((command) => command.id)).toEqual(["project.switch.b"]);
    expect(switchCommands[0]!.group).toBe("Navigation");
    // The path is searchable: one project per repo means the name is often the
    // same word three times over.
    expect(switchCommands[0]!.keywords).toContain("/srv/site");
    switchCommands[0]!.action();
    expect(selectProject).toHaveBeenCalledWith("b");
  });
});

describe("restoring the last project", () => {
  test("a refresh returns to where the operator was, not to the most recent row", async () => {
    install([session("a", "First"), session("b", "Second")], "b");
    // Selecting is what records it.
    useTerminusStore.getState().selectSession("b");
    useTerminusStore.setState({ selectedSessionId: null, sessions: [] });
    vi.mocked(api.listSessions).mockResolvedValue({
      sessions: [session("a", "First"), session("b", "Second")],
      total: 2,
      next_cursor: null,
      truncation: { occurred: false, continuation: null },
    });

    await useTerminusStore.getState().refreshSessions();

    expect(useTerminusStore.getState().selectedSessionId).toBe("b");
  });
});
