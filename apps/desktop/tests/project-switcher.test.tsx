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
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ProjectMenu } from "../src/components/ProjectMenu";
import { Sidebar, groupSettledTasks, inboxDateLabel } from "../src/components/Sidebar";
import type { Task } from "../src/types";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { useTaskReadStore } from "../src/hooks/use-task-read";
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

/**
 * The rail groups by day. A case about the project tree therefore has to ask
 * for it — seeded through the stored preference rather than by opening the
 * grouping menu, so the setup stays out of the assertions. The stored value
 * predates the rename and is still honoured.
 */
function openOnProjectsTree(): void {
  window.localStorage.setItem("terminus-desktop.sidebar-view.v1", "projects");
}

function openOnActivity(): void {
  window.localStorage.setItem("terminus-desktop.sidebar-view.v1", "recent");
}

describe("the sidebar thread view", () => {
  test("does not repeat project context in the thread view", () => {
    openOnActivity();
    install([], null);
    render(<Sidebar onOpenProject={() => undefined} />);

    expect(screen.queryByRole("button", { name: "Switch project" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open project" })).toBeInTheDocument();
  });
});

// ────────────────────────── Inbox ───────────────────────────────────────────

function task(id: string, objective: string, updatedAt: string, sessionId = "a"): Task {
  return {
    id,
    session_id: sessionId,
    thread_id: `thread-${id}`,
    status: "ACTIVE",
    phase: "EXECUTE",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: updatedAt,
    updated_at: updatedAt,
    completed_at: null,
    terminal_reason: null,
    contract: { objective },
  } as unknown as Task;
}

/**
 * Grouping is calendar-local by definition — "Today" means the operator's
 * today — so these fixtures are built in local time. Fixed UTC strings put
 * an early-morning task on the previous day in any western timezone, which
 * is a property of the test, not of the code.
 */
function localAt(day: number, hour: number): string {
  return new Date(2026, 7, day, hour, 0, 0).toISOString();
}

describe("inbox grouping", () => {
  const now = new Date(2026, 7, 28, 12, 0, 0);

  test("names the recent days and dates the rest", () => {
    expect(inboxDateLabel(localAt(28, 9), now)).toBe("Today");
    expect(inboxDateLabel(localAt(27, 23), now)).toBe("Yesterday");
    expect(inboxDateLabel("not a date", now)).toBe("Earlier");
    // Anything older gets a real date rather than a vaguer word.
    expect(inboxDateLabel(localAt(20, 9), now)).toMatch(/Aug/);
  });

  // Unsettled work is the attention strip's, and the strip renders above this
  // list in both views. Repeating it here would print the row twice in one
  // column, which reads as a duplicate rather than as emphasis.
  test("leaves unsettled work out of the timeline entirely", () => {
    const wants = task("t-wants", "Approve the migration", localAt(20, 9));
    const today = task("t-today", "Clean git", localAt(28, 9));

    const groups = groupSettledTasks([today, wants], (t: Task) => t.id !== "t-wants", now);

    expect(groups.map((group) => group.label)).toEqual(["Today"]);
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(["t-today"]);
  });

  test("a task appears once, and days run newest first", () => {
    const groups = groupSettledTasks(
      [
        task("t-old", "Older", localAt(20, 9)),
        task("t-today", "Today", localAt(28, 9)),
        task("t-yesterday", "Yesterday", localAt(27, 9)),
        task("t-needs", "Needs you", localAt(28, 10)),
      ],
      (t: Task) => t.id !== "t-needs",
      now,
    );

    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", expect.stringMatching(/Aug/)]);
    const seen = groups.flatMap((group) => group.tasks.map((t) => t.id));
    expect(new Set(seen).size).toBe(seen.length);
    // The unsettled task is not repeated under its own date either.
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(["t-today"]);
  });

  test("orders within a day by most recent activity", () => {
    const groups = groupSettledTasks(
      [
        task("t-early", "Early", localAt(28, 2)),
        task("t-late", "Late", localAt(28, 11)),
      ],
      () => true,
      now,
    );
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(["t-late", "t-early"]);
  });
});

describe("the sidebar inbox", () => {
  test("shows one project-filtered thread list with both sidebar views in the Terminus menu", async () => {
    install([session("a", "Terminus")], "a");
    useTerminusStore.setState({
      tasksBySession: { a: [task("t-today", "Clean git and rebuild", localAt(28, 9))] },
    });
    render(<Sidebar onOpenProject={() => undefined} />);

    expect(screen.getByText("Clean git and rebuild")).toBeInTheDocument();
    expect(screen.queryByText("Project: Terminus")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New thread" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Threads" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Projects" })).toHaveAttribute("aria-selected", "false");
  });

  test("switches between thread priority and the project tree", async () => {
    openOnActivity();
    install([session("a", "Terminus"), session("b", "Site")], "a");
    const user = userEvent.setup();
    render(<Sidebar onOpenProject={() => undefined} />);

    expect(screen.queryByRole("button", { name: "Switch project" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Projects" }));

    expect(screen.getByRole("region", { name: "Projects" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch project" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Threads" }));
    expect(screen.queryByRole("button", { name: "Switch project" })).not.toBeInTheDocument();
  });

  test("keeps long project trees compact until the operator expands them", async () => {
    openOnProjectsTree();
    install([session("a", "Terminus")], "a");
    useTerminusStore.setState({
      tasksBySession: {
        a: Array.from({ length: 8 }, (_, index) => task(
          `t-${index + 1}`,
          `Thread ${index + 1}`,
          localAt(28, index + 1),
        )),
      },
    });
    const user = userEvent.setup();
    render(<Sidebar onOpenProject={() => undefined} />);

    expect(screen.getByText("Thread 6")).toBeInTheDocument();
    expect(screen.queryByText("Thread 7")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show 2 more threads in Terminus" }));

    expect(screen.getByText("Thread 7")).toBeInTheDocument();
    expect(screen.getByText("Thread 8")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show fewer threads in Terminus" })).toBeInTheDocument();
  });

  test("selecting an inbox row opens that task", async () => {
    openOnActivity();
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    install([session("a", "Terminus")], "a");
    useTerminusStore.setState({
      tasksBySession: { a: [task("t-today", "Clean git and rebuild", localAt(28, 9))] },
    });
    render(<Sidebar onNavigate={onNavigate} onOpenProject={() => undefined} />);

    // Anchored: the row sits beside a "Mark … as read" control that names the
    // same task, and an unanchored match hits both. The row's own name carries
    // "unread" after the title, so it cannot be matched exactly either.
    await user.click(screen.getByRole("button", { name: /^Clean git and rebuild/ }));

    expect(onNavigate).toHaveBeenCalledWith("chat");
    expect(useTerminusStore.getState().selectedTaskId).toBe("t-today");
  });

  // The example that started this: a finished task sat in the attention queue
  // for good. It is not queue work at all — it is a report, so it lives under
  // the day it finished wearing an unread mark. Reading clears the mark; the
  // control beside it puts the mark back, because an automatic transition with
  // no undo is a trap. Crucially, the row does not move either way: only
  // *finishing* files a task, and only *state* decides which shelf it is on.
  test("a finished task is marked unread in its day rather than hoisted into the queue", async () => {
    openOnActivity();
    const user = userEvent.setup();
    install([session("a", "Terminus")], "a");
    const finished = { ...task("t-done", "Ship the release", localAt(28, 9)), status: "COMPLETED" as const };
    useTerminusStore.setState({
      tasksBySession: { a: [finished] },
      taskById: { "t-done": finished },
    });
    useTaskReadStore.setState({ seenAtByTask: {} });
    render(<Sidebar onOpenProject={() => undefined} />);

    // Not in the queue: a task that succeeded is not blocked on anyone.
    expect(screen.queryByRole("button", { name: /Collapse Needs you/ })).not.toBeInTheDocument();
    const row = () => screen.getByRole("button", { name: /^Ship the release/ });
    expect(row()).toHaveAccessibleName(expect.stringContaining("unread"));

    act(() => { useTaskReadStore.getState().markRead("t-done", finished.updated_at); });
    expect(row()).toHaveAccessibleName(expect.not.stringContaining("unread"));

    await user.click(screen.getByRole("button", { name: /Mark Ship the release unread/ }));
    expect(row()).toHaveAccessibleName(expect.stringContaining("unread"));
  });

  test("a read terminal failure leaves Priority and settles into recency", () => {
    openOnActivity();
    install([session("a", "Terminus")], "a");
    const failed = {
      ...task("t-failed", "Old failed request", localAt(28, 9)),
      status: "BUDGET_EXHAUSTED" as const,
    };
    useTerminusStore.setState({
      tasksBySession: { a: [failed] },
      taskById: { "t-failed": failed },
    });
    useTaskReadStore.setState({ seenAtByTask: {} });
    render(<Sidebar onOpenProject={() => undefined} />);

    expect(screen.getByRole("button", { name: /Collapse Needs you/ })).toBeInTheDocument();
    act(() => { useTaskReadStore.getState().markRead("t-failed", failed.updated_at); });

    expect(screen.queryByRole("button", { name: /Collapse Needs you/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Old failed request/ })).toBeInTheDocument();
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
