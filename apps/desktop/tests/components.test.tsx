/**
 * Terminus Desktop — Component tests (SPEC §29 — required test scenarios).
 *
 * Coverage:
 *   1. StatusIndicator renders the correct glyph + aria-label for each
 *      TaskStatusKind (working, queued, waiting, needs_approval,
 *      needs_review, failed, interrupted, done).
 *   2. EmptyState renders icon, title, description, and action.
 *   3. ErrorState renders the correct preset for each entry in the
 *      SPEC §27 error catalog.
 *   4. ApprovalCard renders three buttons (Allow once / Allow for this
 *      task / Deny), hides "Allow for this task" when canPersist=false,
 *      and calls api.resolveApproval(id, decision) on click.
 *   5. CommandPalette opens, filters results by query, navigates with
 *      arrow keys, invokes the highlighted command on Enter, and closes
 *      on Esc.
 *   6. Composer send-button mode switches (send / steer / stop) based on
 *      the selected task's status.
 *   7. SidebarItem truncates long titles and exposes the full text via
 *      the `title` attribute (native tooltip).
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { StatusIndicator } from "../src/components/StatusIndicator";
import { EmptyState } from "../src/components/EmptyState";
import { ErrorState, errorPreset } from "../src/components/ErrorState";
import { ApprovalCard } from "../src/components/ApprovalCard";
import { CommandPalette, type Command } from "../src/components/CommandPalette";
import { Composer } from "../src/components/Composer";
import { NewTaskScreen } from "../src/components/NewTaskScreen";
import { Sidebar } from "../src/components/Sidebar";
import { SidebarItem } from "../src/components/SidebarItem";
import { Message } from "../src/components/Message";
import { ActivityBlock } from "../src/components/ActivityBlock";
import { sidebarVisibleTaskCount } from "../src/components/Sidebar";
import { deriveRuntimeModelProfiles, useSettingsStore } from "../src/components/Settings";

import { useTerminusStore } from "../src/hooks/use-terminus";
import { useThemeStore } from "../src/hooks/use-theme";

// ────────────────────────── 1. StatusIndicator ──────────────────────────────

describe("StatusIndicator", () => {
  const STATUSES = [
    "working",
    "queued",
    "waiting",
    "needs_approval",
    "needs_review",
    "failed",
    "interrupted",
    "done",
  ] as const;

  for (const status of STATUSES) {
    test(`renders an element with aria-label="${expectedAriaLabel(status)}" for status=${status}`, () => {
      render(<StatusIndicator status={status} />);
      const el = document.querySelector(`[aria-label="${expectedAriaLabel(status)}"]`);
      expect(el).not.toBeNull();
    });
  }

  test("renders the label as muted secondary text when provided", () => {
    render(<StatusIndicator status="done" label="Done" />);
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  test("falls back to a hollow ring for unknown status", () => {
    render(<StatusIndicator status="unknown" />);
    expect(document.querySelector('[aria-label="unknown"]')).not.toBeNull();
  });
});

function expectedAriaLabel(status: string): string {
  switch (status) {
    case "working": return "working";
    case "queued": return "queued";
    case "waiting": return "waiting";
    case "needs_approval": return "needs approval";
    case "needs_review": return "needs review";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    case "done": return "done";
    default: return "unknown";
  }
}

// ────────────────────────── 2. EmptyState ───────────────────────────────────

describe("EmptyState", () => {
  test("renders icon, title, description, and primary action", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={<span data-testid="icon">ICN</span>}
        title="No changes yet"
        description="Start a task to see file changes."
        action={{ label: "Start a task", onClick, shortcutHint: "⌘N" }}
      />,
    );
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No changes yet" })).toBeInTheDocument();
    expect(screen.getByText("Start a task to see file changes.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /Start a task/ });
    expect(button).toBeInTheDocument();
    expect(screen.getByText("⌘N")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("renders a secondary action alongside the primary", () => {
    render(
      <EmptyState
        title="No projects"
        action={{ label: "Open project", onClick: vi.fn() }}
        secondaryAction={{ label: "Browse docs", onClick: vi.fn() }}
      />,
    );
    expect(screen.getByRole("button", { name: /Open project/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Browse docs/ })).toBeInTheDocument();
  });

  test("marks itself as a polite live region for screen readers", () => {
    render(<EmptyState title="Empty" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
  });
});

describe("ActivityBlock", () => {
  test("keeps the outcome scannable while collapsed and reveals exact evidence on demand", async () => {
    render(
      <ActivityBlock
        block={{
          id: "verify-1",
          title: "Ran verification",
          metric: "18 tests passed",
          status: "done",
          entries: [{
            tool: "test",
            summary: "Desktop component suite",
            detail: "18 passed, 0 failed",
            at: "2026-07-13T00:00:00.000Z",
          }],
        }}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Ran verification, 18 tests passed" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("18 tests passed")).toBeInTheDocument();
    expect(screen.queryByText("18 passed, 0 failed")).not.toBeInTheDocument();

    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("18 passed, 0 failed")).toBeInTheDocument();
  });
});

// ────────────────────────── 3. ErrorState presets ───────────────────────────

describe("ErrorState presets (SPEC §27 catalog)", () => {
  const PRESET_KEYS = [
    "failedTask",
    "offlineRuntime",
    "reconnecting",
    "missingModel",
    "missingEditor",
    "missingGit",
    "permissionDenied",
    "agentBlocked",
    "terminalDisconnected",
    "mergeConflict",
    "rateLimit",
    "contextLimit",
    "unsupportedFile",
    "hugeOutput",
    "deletedProjectPath",
    "updateAvailable",
    "applicationError",
    "rendererRecovery",
  ] as const;

  for (const key of PRESET_KEYS) {
    test(`errorPreset("${key}") returns a usable preset that renders title + description`, () => {
      const preset = errorPreset(key);
      expect(preset.title.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(["error", "warning"]).toContain(preset.severity);
      const onClick = vi.fn();
      render(
        <ErrorState
          {...preset}
          action={{ label: "Retry", onClick }}
        />,
      );
      expect(screen.getByRole("heading", { name: preset.title })).toBeInTheDocument();
      expect(screen.getByText(preset.description)).toBeInTheDocument();
    });
  }

  test("errorPreset returns the failedTask preset for unknown keys", () => {
    const preset = errorPreset("not-a-real-key" as never);
    expect(preset.title).toBe("Task failed");
  });

  test("renders the detail string as monospace copyable text", () => {
    render(
      <ErrorState
        title="Failed"
        description="Could not connect."
        detail="trace-id: abc-123"
        action={{ label: "Retry", onClick: vi.fn() }}
      />,
    );
    expect(screen.getByText("trace-id: abc-123")).toBeInTheDocument();
  });

  test("exposes an assertive live region for screen readers", () => {
    render(<ErrorState title="Fail" action={{ label: "Retry", onClick: vi.fn() }} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});

// ────────────────────────── 4. ApprovalCard ─────────────────────────────────

// Mock the API singleton so we can assert on resolveApproval calls without
// hitting the network. We import the typed class so other tests in this
// file (none in this suite, but kept for forward-compat) still typecheck.
vi.mock("../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...actual,
    api: {
      resolveApproval: vi.fn(),
      startTask: vi.fn(async () => ({ task_id: "task-1", status: "ACTIVE", event_cursor: "cursor-1" })),
      startTurn: vi.fn(async () => ({ id: "turn-1" })),
      createTask: vi.fn(async () => ({
        id: "task-new",
        session_id: "session-1",
        thread_id: "thread-1",
        status: "DRAFT",
        phase: "INTAKE",
        active_contract_version: 1,
        risk_class: "normal",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
      })),
      getTask: vi.fn(async () => ({
        id: "task-new",
        session_id: "session-1",
        thread_id: "thread-1",
        status: "ACTIVE",
        phase: "DISCOVER",
        active_contract_version: 1,
        risk_class: "normal",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
        contract: null,
      })),
      cancelTask: vi.fn(async () => ({ task_id: "task-1", status: "CANCELLED" })),
      listTasks: vi.fn(async () => ({ tasks: [] })),
    },
  };
});

// Import the mocked api AFTER vi.mock so the mock is in effect.
// The dynamic import above is hoisted by vitest, so the static import
// below resolves to the mocked module.
import { api, TerminusApiError } from "../src/lib/api";

describe("ApprovalCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders three buttons (Allow once, Allow for this task, Deny) by default", () => {
    render(
      <ApprovalCard
        id="approval-1"
        action="Run database migration"
        operation="npm run migrate:production"
        reason="This may modify the production database."
        risk="high"
        scope={["workspace://db"]}
        affectedEnvironment="production"
        canPersist
      />,
    );
    expect(screen.getByRole("button", { name: /Allow once/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Allow for this task/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Deny/ })).toBeInTheDocument();
  });

  test("hides 'Allow for this task' when canPersist=false", () => {
    render(
      <ApprovalCard
        id="approval-2"
        action="Read a file"
        risk="low"
        canPersist={false}
      />,
    );
    expect(screen.getByRole("button", { name: /Allow once/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Allow for this task/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Deny/ })).toBeInTheDocument();
  });

  test("clicking 'Allow once' calls api.resolveApproval(id, 'allow_once')", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    vi.mocked(api.resolveApproval).mockResolvedValueOnce({
      id: "approval-3",
      task_id: "task-x",
      operation_hash: "h",
      status: "allowed",
      risk: "normal",
      requested_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      rationale: null,
    });

    render(
      <ApprovalCard
        id="approval-3"
        action="Run a script"
        risk="normal"
        canPersist
        onResolved={onResolved}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Allow once/ }));

    expect(api.resolveApproval).toHaveBeenCalledWith("approval-3", "allow_once");
    expect(onResolved).toHaveBeenCalledWith("allow_once");
  });

  test("clicking 'Allow for this task' calls api.resolveApproval(id, 'allow_for_task')", async () => {
    const user = userEvent.setup();
    vi.mocked(api.resolveApproval).mockResolvedValueOnce({
      id: "approval-4",
      task_id: "task-x",
      operation_hash: "h",
      status: "allowed",
      risk: "normal",
      requested_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      rationale: null,
    });

    render(
      <ApprovalCard
        id="approval-4"
        action="Run a script"
        risk="normal"
        canPersist
      />,
    );

    await user.click(screen.getByRole("button", { name: /Allow for this task/ }));

    expect(api.resolveApproval).toHaveBeenCalledWith("approval-4", "allow_for_task");
  });

  test("clicking 'Deny' calls api.resolveApproval(id, 'deny_once')", async () => {
    const user = userEvent.setup();
    vi.mocked(api.resolveApproval).mockResolvedValueOnce({
      id: "approval-5",
      task_id: "task-x",
      operation_hash: "h",
      status: "denied",
      risk: "normal",
      requested_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      rationale: null,
    });

    render(
      <ApprovalCard
        id="approval-5"
        action="Run a script"
        risk="normal"
        canPersist
      />,
    );

    await user.click(screen.getByRole("button", { name: /^Deny/ }));

    expect(api.resolveApproval).toHaveBeenCalledWith("approval-5", "deny_once");
  });

  test("after a successful resolve, the card collapses to a one-line summary", async () => {
    const user = userEvent.setup();
    vi.mocked(api.resolveApproval).mockResolvedValueOnce({
      id: "approval-6",
      task_id: "task-x",
      operation_hash: "h",
      status: "allowed",
      risk: "normal",
      requested_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      rationale: null,
    });

    render(
      <ApprovalCard
        id="approval-6"
        action="Run migration"
        operation="npm run migrate"
        risk="normal"
        canPersist
      />,
    );

    await user.click(screen.getByRole("button", { name: /Allow once/ }));

    // Buttons should be gone; the resolved summary should be visible.
    expect(screen.queryByRole("button", { name: /Allow once/ })).toBeNull();
    expect(screen.getByText(/Allowed once/)).toBeInTheDocument();
  });

  test("renders an error message if the API call rejects", async () => {
    const user = userEvent.setup();
    vi.mocked(api.resolveApproval).mockRejectedValueOnce(
      new TerminusApiError(409, "approval already resolved", {
        code: "APPROVAL_ALREADY_RESOLVED",
        message: "approval already resolved",
        retryable: false,
        category: "conflict",
      }),
    );

    render(
      <ApprovalCard
        id="approval-7"
        action="Run migration"
        risk="normal"
        canPersist
      />,
    );

    await user.click(screen.getByRole("button", { name: /Allow once/ }));

    // The card stays open and surfaces the error.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Allow once/ })).toBeInTheDocument();
  });
});

// ────────────────────────── 5. CommandPalette ───────────────────────────────

describe("CommandPalette", () => {
  function makeCommands(actions: Partial<Record<string, () => void>> = {}): Command[] {
    return [
      {
        id: "task.new",
        label: "New task",
        group: "Task",
        hint: "⌘N",
        keywords: ["create task"],
        action: actions.newTask ?? vi.fn(),
      },
      {
        id: "appearance.switch-theme",
        label: "Switch theme",
        group: "Appearance",
        keywords: ["light dark system"],
        action: actions.switchTheme ?? vi.fn(),
      },
      {
        id: "appearance.switch-density",
        label: "Switch density",
        group: "Appearance",
        keywords: ["compact spacious"],
        action: actions.switchDensity ?? vi.fn(),
      },
      {
        id: "help.open-settings",
        label: "Open settings",
        group: "Help",
        hint: "⌘,",
        keywords: ["preferences config"],
        action: actions.openSettings ?? vi.fn(),
      },
    ];
  }

  test("renders nothing when open=false", () => {
    const onClose = vi.fn();
    const { container } = render(
      <CommandPalette open={false} onClose={onClose} commands={makeCommands()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders the search input + commands when open=true", () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} onClose={onClose} commands={makeCommands()} />);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search commands")).toBeInTheDocument();
    expect(screen.getByText("New task")).toBeInTheDocument();
    expect(screen.getByText("Switch theme")).toBeInTheDocument();
    expect(screen.getByText("Open settings")).toBeInTheDocument();
  });

  test("filters results by query (matches label)", async () => {
    const user = userEvent.setup();
    render(<CommandPalette open={true} onClose={vi.fn()} commands={makeCommands()} />);
    const input = screen.getByLabelText("Search commands");
    await user.type(input, "theme");
    expect(screen.getByText("Switch theme")).toBeInTheDocument();
    expect(screen.queryByText("New task")).toBeNull();
    expect(screen.queryByText("Open settings")).toBeNull();
  });

  test("filters results by keyword (matches 'preferences' → Open settings)", async () => {
    const user = userEvent.setup();
    render(<CommandPalette open={true} onClose={vi.fn()} commands={makeCommands()} />);
    const input = screen.getByLabelText("Search commands");
    await user.type(input, "preferences");
    expect(screen.getByText("Open settings")).toBeInTheDocument();
    expect(screen.queryByText("New task")).toBeNull();
  });

  test("Enter invokes the highlighted (first) command and closes the palette", async () => {
    const user = userEvent.setup();
    const newTask = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        open={true}
        onClose={onClose}
        commands={makeCommands({ newTask })}
      />,
    );
    const input = screen.getByLabelText("Search commands");
    await user.type(input, "task");
    // First result should be "New task".
    expect(screen.getByText("New task")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    // The action is deferred via setTimeout(0) so the palette closes first.
    await new Promise((r) => setTimeout(r, 10));
    expect(newTask).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  test("ArrowDown then Enter invokes the second result", async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    const commands: Command[] = [
      {
        id: "first",
        label: "Alpha first",
        group: "Navigation",
        action: first,
      },
      {
        id: "second",
        label: "Beta second",
        group: "Navigation",
        action: second,
      },
    ];
    render(<CommandPalette open={true} onClose={vi.fn()} commands={commands} />);
    const input = screen.getByLabelText("Search commands");
    await user.type(input, "a"); // matches both Alpha and Beta
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 10));
    // The first result (Alpha) was highlighted at start; after ArrowDown
    // the second result (Beta) should be highlighted. So `second` is
    // invoked, not `first`.
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  test("Esc closes the palette via the onClose callback", () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} onClose={onClose} commands={makeCommands()} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("backdrop click closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} onClose={onClose} commands={makeCommands()} />);
    // The dialog itself is the backdrop (fixed inset-0 with the dark
    // background). Clicking directly on it (target === currentTarget)
    // should trigger onClose.
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    fireEvent.mouseDown(dialog);
    expect(onClose).toHaveBeenCalled();
  });

  test("shows an empty-state message when no commands match", async () => {
    const user = userEvent.setup();
    render(<CommandPalette open={true} onClose={vi.fn()} commands={makeCommands()} />);
    await user.type(screen.getByLabelText("Search commands"), "zzzzz");
    expect(screen.getByText(/No commands match/)).toBeInTheDocument();
  });
});

// ────────────────────────── 6. Composer mode switching ──────────────────────

describe("Composer — send-button mode switches based on task status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset both stores between tests so state doesn't bleed.
    useTerminusStore.setState({
      sessions: [],
      tasksBySession: {},
      taskById: {},
      selectedSessionId: null,
      selectedTaskId: null,
      pinnedTaskIds: new Set(),
      draftsByTask: {},
      queuedInstructionsByTask: {},
      eventsByTask: {},
    });
    useThemeStore.getState().setDensity("spacious");
    useThemeStore.getState().setTheme("system");
    cleanup();
  });

  function makeTask(status: string): void {
    useTerminusStore.setState({
      selectedTaskId: "task-1",
      taskById: {
        "task-1": {
          id: "task-1",
          session_id: "session-1",
          thread_id: "thread-1",
          status,
          phase: "INTAKE",
          active_contract_version: 1,
          risk_class: "low",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null,
          contract: null,
        },
      },
    });
  }

  test("task.status=ACTIVE → button label is 'Steer'", () => {
    makeTask("ACTIVE");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /Steer/ })).toBeInTheDocument();
  });

  test("task.status=PENDING → button label is 'Send' so the first turn can start", () => {
    makeTask("PENDING");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /^Send/ })).toBeInTheDocument();
  });

  test("task.status=QUEUED → button label is 'Stop'", () => {
    makeTask("QUEUED");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
  });

  test("submitting a pending task starts it before creating the first turn", async () => {
    makeTask("PENDING");
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "Begin the task");
    await user.click(screen.getByRole("button", { name: /^Send/ }));

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledTimes(1));
    expect(api.startTask).toHaveBeenCalledWith("task-1");
    expect(vi.mocked(api.startTask).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.startTurn).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(api.startTurn).toHaveBeenCalledWith({
      thread_id: "thread-1",
      task_id: "task-1",
      user_input: "Begin the task",
    });
  });

  test("queues a follow-up without starting a concurrent turn", async () => {
    makeTask("ACTIVE");
    const user = userEvent.setup();
    render(<Composer />);

    const composer = screen.getByRole("textbox", { name: "Message composer" });
    await user.type(composer, "Run the visual checks after implementation");
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true, shiftKey: true });

    await waitFor(() => expect(useTerminusStore.getState().queuedInstructionsByTask["task-1"]).toHaveLength(1));
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(screen.getByText("1 queued")).toBeInTheDocument();
  });

  test("preserves composer text and focus while streaming task state updates", async () => {
    makeTask("ACTIVE");
    const user = userEvent.setup();
    render(<Composer />);

    const composer = screen.getByRole("textbox", { name: "Message composer" });
    await user.type(composer, "Keep this draft while the agent streams");
    expect(composer).toHaveFocus();

    act(() => {
      useTerminusStore.getState()._updateTaskFromEvent({
        id: "event-streaming",
        event: "task.updated",
        data: JSON.stringify({ task_id: "task-1", status: "ACTIVE", phase: "EXECUTING" }),
      }, "task-1");
    });

    expect(composer).toHaveValue("Keep this draft while the agent streams");
    expect(composer).toHaveFocus();
  });

  test("drains the next queued follow-up only after task completion", async () => {
    makeTask("ACTIVE");
    useTerminusStore.getState().queueInstruction("task-1", "Now verify the finished work");

    useTerminusStore.getState()._updateTaskFromEvent({
      id: "event-complete",
      event: "task.completed",
      data: JSON.stringify({ phase: "COMPLETE" }),
    }, "task-1");

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledWith({
      thread_id: "thread-1",
      task_id: "task-1",
      user_input: "Now verify the finished work",
    }));
    expect(api.startTask).toHaveBeenCalledWith("task-1");
    expect(useTerminusStore.getState().queuedInstructionsByTask["task-1"]).toHaveLength(0);
  });

  test("task.status=WAITING → button label is 'Steer'", () => {
    makeTask("WAITING");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /Steer/ })).toBeInTheDocument();
  });

  test("task.status=COMPLETED → button label is 'Send'", () => {
    makeTask("COMPLETED");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /^Send/ })).toBeInTheDocument();
  });

  test("a completion event updates both task detail and the sidebar task list", () => {
    makeTask("ACTIVE");
    const task = useTerminusStore.getState().taskById["task-1"];
    expect(task).toBeDefined();
    useTerminusStore.setState({ tasksBySession: { "session-1": task ? [task] : [] } });

    useTerminusStore.getState()._updateTaskFromEvent({
      id: "event-1",
      event: "task.completed",
      data: JSON.stringify({ phase: "COMPLETE" }),
    }, "task-1");

    expect(useTerminusStore.getState().taskById["task-1"]?.status).toBe("COMPLETED");
    expect(useTerminusStore.getState().tasksBySession["session-1"]?.[0]?.status).toBe("COMPLETED");
  });

  test("task.status=FAILED → button label is 'Send' (re-send a follow-up)", () => {
    makeTask("FAILED");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /^Send/ })).toBeInTheDocument();
  });

  test("task.status=INTERRUPTED → button label is 'Send'", () => {
    makeTask("INTERRUPTED");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /^Send/ })).toBeInTheDocument();
  });

  test("task.status=NEEDS_APPROVAL → button label is 'Steer'", () => {
    makeTask("NEEDS_APPROVAL");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /Steer/ })).toBeInTheDocument();
  });

  test("no task selected → button label is 'Send' (default)", () => {
    useTerminusStore.setState({ selectedTaskId: null });
    render(<Composer />);
    expect(screen.getByRole("button", { name: /^Send/ })).toBeInTheDocument();
  });

  test("does not invent a model or access level when no session profile exists", () => {
    useTerminusStore.setState({ selectedTaskId: null });
    render(<Composer />);
    expect(screen.getByRole("button", { name: "Connect provider" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permission profile: Workspace policy" })).toBeInTheDocument();
  });

  test("opens connection management from an empty runtime model inventory", async () => {
    const openSettings = vi.fn();
    window.addEventListener("terminus:open-settings", openSettings, { once: true });
    render(<Composer onCreateTask={vi.fn(async () => undefined)} />);

    const provider = screen.getByRole("button", { name: "Connect provider" });
    await userEvent.setup().click(provider);
    await userEvent.setup().click(screen.getByRole("menuitemradio", { name: /Connect provider/ }));

    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  test("opens permission management and exposes contextual options", async () => {
    const openSettings = vi.fn();
    window.addEventListener("terminus:open-settings", openSettings, { once: true });
    render(<Composer onCreateTask={vi.fn(async () => undefined)} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Permission profile: Workspace policy" }));
    expect(openSettings).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getByText("Branch / worktree")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Queue follow-up/ })).toBeDisabled();
  });

  test("opts the native composer out of browser writing-assistant injection", () => {
    render(<Composer onCreateTask={vi.fn(async () => undefined)} />);
    const textbox = screen.getByRole("textbox", { name: "Message composer" });
    expect(textbox).toHaveAttribute("spellcheck", "false");
    expect(textbox).toHaveAttribute("data-gramm", "false");
    expect(textbox).toHaveAttribute("data-gramm_editor", "false");
  });

  test("the start-surface composer delegates a fresh objective to task creation", async () => {
    const user = userEvent.setup();
    const createTask = vi.fn(async () => undefined);
    render(<Composer onCreateTask={createTask} />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "Map this project");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(createTask).toHaveBeenCalledWith("Map this project");
  });
});

describe("NewTaskScreen — first turn lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminusStore.setState({
      sessions: [{
        id: "session-1",
        workspace_id: "workspace-1",
        title: "Terminus",
        status: "active",
        active_thread_id: "thread-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
      tasksBySession: { "session-1": [] },
      taskById: {},
      selectedSessionId: "session-1",
      selectedTaskId: null,
      draftsByTask: {},
      eventsByTask: {},
    });
  });

  test("starts the task and submits the objective as its first turn", async () => {
    const user = userEvent.setup();
    render(<NewTaskScreen />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "Build the live task surface");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledTimes(1));
    expect(api.startTask).toHaveBeenCalledWith("task-new");
    expect(api.startTurn).toHaveBeenCalledWith({
      thread_id: "thread-1",
      task_id: "task-new",
      user_input: "Build the live task surface",
    });
    expect(vi.mocked(api.startTask).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.startTurn).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(useTerminusStore.getState().selectedTaskId).toBe("task-new");
  });

  test("keeps starter actions compact while preserving their explanatory tooltips", () => {
    render(<NewTaskScreen />);

    const starter = screen.getByRole("button", { name: "Explore and understand code" });
    expect(starter).toHaveAttribute("title", "Map the system before making a change");
    expect(screen.queryByText("Map the system before making a change")).not.toBeInTheDocument();
  });
});

describe("Sidebar — navigation destinations", () => {
  test("surfaces the Codex-style destination hierarchy", async () => {
    const onNavigate = vi.fn();
    render(<Sidebar onNavigate={onNavigate} />);

    for (const label of ["New task", "Scheduled", "Plugins", "Pull requests", "Chat"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Sites" })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Plugins" }));
    expect(onNavigate).toHaveBeenCalledWith("plugins");
  });

  test("routes Settings and Help to distinct settings categories", async () => {
    const details: unknown[] = [];
    const listener = (event: Event): void => {
      details.push(event instanceof CustomEvent ? event.detail : null);
    };
    window.addEventListener("terminus:open-settings", listener);
    render(<Sidebar />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Help" }));

    expect(details).toEqual([{ category: "general" }, { category: "shortcuts" }]);
    window.removeEventListener("terminus:open-settings", listener);
  });
});

// ────────────────────────── 7. SidebarItem ──────────────────────────────────

describe("SidebarItem — truncation + tooltip", () => {
  const LONG_TITLE =
    "This is a very long task title that should be truncated because it goes well beyond the available sidebar width";

  test("renders the truncate CSS class on the title span", () => {
    render(
      <SidebarItem
        title={LONG_TITLE}
        selected={false}
      />,
    );
    const titleSpan = screen.getByText(LONG_TITLE);
    expect(titleSpan).toHaveClass("truncate");
  });

  test("exposes the full title via the title attribute on the row", () => {
    render(
      <SidebarItem
        title={LONG_TITLE}
        selected={false}
      />,
    );
    // The role="button" row carries the title attribute.
    const row = screen.getByRole("button");
    expect(row).toHaveAttribute("title", LONG_TITLE);
  });

  test("renders in compact mode (rail icon-only) and still exposes the title", () => {
    render(
      <SidebarItem
        title={LONG_TITLE}
        selected
        compact
      />,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("title", LONG_TITLE);
    expect(button).toHaveAttribute("aria-label", LONG_TITLE);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  test("shows the pin/unpin button only on hover (and when pinned)", () => {
    const onTogglePin = vi.fn();
    const { rerender } = render(
      <SidebarItem
        title="Short title"
        selected={false}
        onTogglePin={onTogglePin}
      />,
    );
    // When not pinned and not hovered, the pin button is invisible
    // (CSS class `invisible`). The aria-label includes the task title
    // for screen readers ("Pin task <title>").
    const pinButton = screen.getByLabelText("Pin task Short title");
    expect(pinButton).toHaveClass("invisible");

    // When pinned, the pin button is visible regardless of hover.
    rerender(
      <SidebarItem
        title="Short title"
        selected={false}
        pinned
        onTogglePin={onTogglePin}
      />,
    );
    const unpinButton = screen.getByLabelText("Unpin task Short title");
    expect(unpinButton).not.toHaveClass("invisible");
  });
});

describe("Message — code interactions", () => {
  test("labels fenced code and copies the exact code payload", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <Message
        message={{
          id: "message-code",
          role: "agent",
          content: "Result:\n\n```ts\nconst ready = true;\n```",
          createdAt: "2026-07-12T18:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("ts")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("const ready = true;");
    expect(screen.getByRole("button", { name: "Copied code" })).toBeInTheDocument();
  });
});

describe("Sidebar — progressive task disclosure", () => {
  test("shows five tasks initially and all tasks after expansion", () => {
    expect(sidebarVisibleTaskCount(12, -1, false)).toBe(5);
    expect(sidebarVisibleTaskCount(12, -1, true)).toBe(12);
  });

  test("keeps the selected task visible beyond the initial five", () => {
    expect(sidebarVisibleTaskCount(12, 8, false)).toBe(9);
  });

  test("never claims more rows than the project contains", () => {
    expect(sidebarVisibleTaskCount(3, -1, false)).toBe(3);
  });
});

describe("Settings — runtime model profiles", () => {
  test("lists only profiles reported by sessions and groups duplicate use", () => {
    const session = (id: string, profile?: string) => ({
      id,
      workspace_id: `workspace-${id}`,
      title: id,
      status: "active" as const,
      active_thread_id: null,
      created_at: "2026-07-12T00:00:00.000Z",
      updated_at: "2026-07-12T00:00:00.000Z",
      ...(profile === undefined ? {} : { default_model_profile: profile }),
    });

    expect(deriveRuntimeModelProfiles([
      session("one", "provider/model-a"),
      session("two", "provider/model-a"),
      session("three", "provider/model-b"),
      session("four"),
    ])).toEqual([
      { id: "provider/model-a", projectCount: 2 },
      { id: "provider/model-b", projectCount: 1 },
    ]);
  });

  test("does not create fallback models when the registry is empty", () => {
    expect(deriveRuntimeModelProfiles([])).toEqual([]);
  });

  test("applies reduced motion and transparency to the live document", () => {
    const settings = useSettingsStore.getState();
    settings.set("appearance.reduce-motion", true);
    settings.set("appearance.reduce-transparency", true);
    expect(document.documentElement.dataset.reduceMotion).toBe("true");
    expect(document.documentElement.dataset.reduceTransparency).toBe("true");

    settings.set("appearance.reduce-motion", false);
    settings.set("appearance.reduce-transparency", false);
    expect(document.documentElement.dataset.reduceMotion).toBe("false");
    expect(document.documentElement.dataset.reduceTransparency).toBe("false");
  });

  test("normalizes malformed persisted-style select and numeric values", () => {
    const settings = useSettingsStore.getState();
    settings.set("appearance.theme", "Light");
    settings.set("appearance.density", "dense");
    settings.set("performance.max-events-per-task", 50000);

    expect(settings.get("appearance.theme")).toBe("system");
    expect(settings.get("appearance.density")).toBe("spacious");
    expect(settings.get("performance.max-events-per-task")).toBe(10000);
    expect(useThemeStore.getState().theme).toBe("system");
    expect(useThemeStore.getState().density).toBe("spacious");
  });
});
