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
 *   7. TaskRow truncates long titles and exposes the full text through
 *      the shared accessible tooltip layer.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { StatusIndicator } from "../src/components/StatusIndicator";
import { EmptyState } from "../src/ui/EmptyState";
import { ErrorState, errorPreset } from "../src/components/ErrorState";
import { ApprovalCard } from "../src/components/ApprovalCard";
import { CommandPalette, type Command } from "../src/components/CommandPalette";
import { Composer } from "../src/components/Composer";
import { NewTaskScreen } from "../src/components/NewTaskScreen";
import { Sidebar } from "../src/components/Sidebar";
import { TaskSearch } from "../src/components/TaskSearch";
import { TaskRow } from "../src/components/TaskRow";
import { Message } from "../src/components/Message";
import { ActivityBlock } from "../src/components/ActivityBlock";
import { ConnectionBanner } from "../src/components/ConnectionBanner";
import { sidebarVisibleTaskCount } from "../src/components/Sidebar";
import { readSidebarVisible, writeSidebarVisible } from "../src/lib/sidebar-prefs";
import { deriveRuntimeModelProfiles, useSettingsStore } from "../src/components/Settings";

import { useTerminusStore } from "../src/hooks/use-terminus";
import { useThemeStore } from "../src/hooks/use-theme";
import {
  restoreAppDialogFocusOrigin,
  setAppDialogFocusOrigin,
  useDialogFocus,
} from "../src/hooks/use-dialog-focus";
import type { Approval, ApprovalSummary, Task, TaskDomainStatus, TaskListResponse } from "../src/types";

// ────────────────────────── 1. StatusIndicator ──────────────────────────────

describe("StatusIndicator", () => {
  const STATUSES = [
    "planning",
    "working",
    "verifying",
    "queued",
    "needs_you",
    "review",
    "failed",
    "cancelled",
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
    // The three states the agent advances on its own share the spinner, whose
    // label is the lifecycle label lowercased.
    case "planning": return "planning";
    case "working": return "working";
    case "verifying": return "verifying";
    case "queued": return "queued";
    case "needs_you": return "needs you";
    case "review": return "ready for review";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
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
            phase: "settled",
            outcome: "succeeded",
          }],
        }}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Ran verification, status done, 18 tests passed" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("18 tests passed")).toBeInTheDocument();
    expect(screen.queryByText("18 passed, 0 failed")).not.toBeInTheDocument();

    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("18 passed, 0 failed")).toBeInTheDocument();
  });

  // A failure that hides its cause behind a disclosure triangle is a failure
  // with no cause, as far as the reader is concerned.
  test("opens a failed block and announces it", () => {
    render(
      <ActivityBlock
        defaultExpanded
        block={{
          id: "fail-1",
          title: "Turn failed",
          metric: "Failed",
          status: "failed",
          entries: [{
            tool: "turn",
            summary: "PROVIDER_TRANSPORT_FAILED: the gateway refused the request",
            detail: "Reason: agent_loop_error",
            at: "2026-08-28T00:00:00.000Z",
            phase: "settled",
            outcome: "failed",
          }],
        }}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Turn failed/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reason: agent_loop_error")).toBeInTheDocument();
  });

  test("leaves a succeeding block silent and collapsed", () => {
    render(
      <ActivityBlock
        block={{
          id: "ok-1",
          title: "Explored codebase",
          metric: "2 files",
          status: "done",
          entries: [{ tool: "read", summary: "a.ts", at: "2026-08-28T00:00:00.000Z", phase: "settled", outcome: "succeeded" }],
        }}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
      health: vi.fn(async () => ({
        status: "ok",
        ready: true,
        version: "test",
        kernel: { ready: true, status: "ready" },
      })),
      listSessions: vi.fn(async () => ({
        sessions: [],
        total: 0,
        next_cursor: null,
        truncation: { occurred: false as const, continuation: null },
      })),
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
        terminal_reason: null,
        contract: null,
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
      getSession: vi.fn(async (sessionId: string) => ({
        id: sessionId,
        workspace_id: "workspace-1",
        title: "Hydrated project",
        status: "active" as const,
        active_thread_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })),
      cancelTask: vi.fn(async () => ({
        id: "task-1", session_id: "session-1", thread_id: "thread-1",
        status: "ABORTED" as const, phase: "INTAKE", active_contract_version: 1,
        risk_class: "normal" as const, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), completed_at: new Date().toISOString(), contract: null,
      })),
      listTasks: vi.fn(async () => ({
        tasks: [],
        total: 0,
        next_cursor: null,
        truncation: { occurred: false as const, continuation: null },
      })),
      listApprovals: vi.fn(async () => ({
        approvals: [],
        total: 0,
        next_cursor: null,
        truncation: { occurred: false as const, continuation: null },
      })),
    },
  };
});

// Import the mocked api AFTER vi.mock so the mock is in effect.
// The dynamic import above is hoisted by vitest, so the static import
// below resolves to the mocked module.
import { api, TerminusApiError } from "../src/lib/api";

const BASIC_APPROVAL_DECISIONS = ["allow_once", "allow_for_action", "allow_for_task", "deny_once"] as const;

function resolvedApproval(id: string, status: "allowed" | "denied"): Approval {
  const now = new Date().toISOString();
  return {
    id,
    task_id: "task-x",
    operation_hash: `hash-${id}`,
    binding: null,
    display: null,
    status,
    decision: status === "allowed" ? "allow_once" : "deny_once",
    supported_decisions: [...BASIC_APPROVAL_DECISIONS],
    risk: "normal",
    scope: ["workspace://project"],
    use_limit: 1,
    use_count: status === "allowed" ? 1 : 0,
    expires_at: null,
    requested_at: now,
    resolved_at: now,
    rationale: null,
  };
}

describe("ApprovalCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.resolveApproval).mockReset();
  });

  test("prioritizes the recommended decision and reveals advanced choices on demand", async () => {
    const user = userEvent.setup();
    render(
      <ApprovalCard
        id="approval-1"
        operationHash="hash-approval-1"
        action="Run database migration"
        operation="npm run migrate:production"
        reason="This may modify the production database."
        risk="high"
        scope={["workspace://db"]}
        affectedEnvironment="production"
        canPersist
        authorizationReady
        supportedDecisions={[...BASIC_APPROVAL_DECISIONS]}
      />,
    );
    expect(screen.getByRole("button", { name: "Allow once — Run database migration" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Deny once — Run database migration" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Allow exact action — Run database migration" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Allow exact action — Run database migration" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Allow for this task — Run database migration" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Deny and add task rule/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop task/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByRole("note")).toHaveTextContent("Allow once, Allow exact action, Allow for this task, Deny once");
  });

  test("disables decisions when a bound approval expires without a refresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const onExpired = vi.fn();
    try {
      render(
        <ApprovalCard
          id="approval-expiring"
          operationHash="hash-approval-expiring"
          action="Run a bounded effect"
          risk="normal"
          canPersist={false}
          authorizationReady
          supportedDecisions={["allow_once", "deny_once"]}
          expiresAt="2026-08-23T12:00:01.000Z"
          onExpired={onExpired}
        />,
      );
      const allow = screen.getByRole("button", { name: "Allow once — Run a bounded effect" });
      expect(allow).toBeEnabled();

      act(() => vi.advanceTimersByTime(1_001));

      expect(allow).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("This approval expired");
      expect(onExpired).toHaveBeenCalledTimes(1);
      fireEvent.click(allow);
      expect(api.resolveApproval).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps task-scoped approval available in more choices but disabled when persistence is forbidden", async () => {
    const user = userEvent.setup();
    render(
      <ApprovalCard
        id="approval-2"
        operationHash="hash-approval-2"
        action="Read a file"
        operation="read workspace://README.md"
        risk="low"
        scope={["workspace://README.md"]}
        canPersist={false}
        authorizationReady
        supportedDecisions={[...BASIC_APPROVAL_DECISIONS]}
      />,
    );
    expect(screen.getByRole("button", { name: "Allow once — Read a file" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: /Allow for this task \(unavailable\)/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny once — Read a file" })).toBeEnabled();
  });

  test("clicking 'Allow once' calls api.resolveApproval(id, 'allow_once')", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    vi.mocked(api.resolveApproval).mockResolvedValueOnce(resolvedApproval("approval-3", "allowed"));

    render(
      <ApprovalCard
        id="approval-3"
        operationHash="hash-approval-3"
        action="Run a script"
        operation="bun run check"
        risk="normal"
        scope={["workspace://project"]}
        canPersist
        authorizationReady
        supportedDecisions={[...BASIC_APPROVAL_DECISIONS]}
        onResolved={onResolved}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Allow once/ }));

    expect(api.resolveApproval).toHaveBeenCalledWith(
      "approval-3",
      "hash-approval-3",
      "allow_once",
      { idempotencyKey: expect.stringMatching(/^approval\.approval-3:/) },
    );
    expect(onResolved).toHaveBeenCalledWith("allow_once");
  });

  test("clicking 'Allow for this task' calls api.resolveApproval(id, 'allow_for_task')", async () => {
    const user = userEvent.setup();
    vi.mocked(api.resolveApproval).mockResolvedValueOnce(resolvedApproval("approval-4", "allowed"));

    render(
      <ApprovalCard
        id="approval-4"
        operationHash="hash-approval-4"
        action="Run a script"
        operation="bun run check"
        risk="normal"
        scope={["workspace://project"]}
        canPersist
        authorizationReady
        supportedDecisions={[...BASIC_APPROVAL_DECISIONS]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: /Allow for this task/ }));

    expect(api.resolveApproval).toHaveBeenCalledWith(
      "approval-4",
      "hash-approval-4",
      "allow_for_task",
      { idempotencyKey: expect.stringMatching(/^approval\.approval-4:/) },
    );
  });

  test("clicking 'Deny' calls api.resolveApproval(id, 'deny_once')", async () => {
    const user = userEvent.setup();
    vi.mocked(api.resolveApproval).mockResolvedValueOnce(resolvedApproval("approval-5", "denied"));

    render(
      <ApprovalCard
        id="approval-5"
        operationHash="hash-approval-5"
        action="Run a script"
        risk="normal"
        canPersist
        supportedDecisions={[...BASIC_APPROVAL_DECISIONS]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Persistence").nextElementSibling).toHaveTextContent("Task-scoped decisions may be available");

    await user.click(screen.getByRole("button", { name: "Deny once — Run a script" }));

    expect(api.resolveApproval).toHaveBeenCalledWith(
      "approval-5",
      "hash-approval-5",
      "deny_once",
      { idempotencyKey: expect.stringMatching(/^approval\.approval-5:/) },
    );
  });

  test("after a successful resolve, the card collapses to a one-line summary", async () => {
    const user = userEvent.setup();
    vi.mocked(api.resolveApproval).mockResolvedValueOnce(resolvedApproval("approval-6", "allowed"));

    render(
      <ApprovalCard
        id="approval-6"
        operationHash="hash-approval-6"
        action="Run migration"
        operation="npm run migrate"
        risk="normal"
        scope={["workspace://db"]}
        canPersist
        authorizationReady
        supportedDecisions={[...BASIC_APPROVAL_DECISIONS]}
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
        operationHash="hash-approval-7"
        action="Run migration"
        operation="npm run migrate"
        risk="normal"
        scope={["workspace://db"]}
        canPersist
        authorizationReady
        supportedDecisions={[...BASIC_APPROVAL_DECISIONS]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Allow once/ }));

    // The card stays open and surfaces the error.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Allow once/ })).toBeInTheDocument();
  });

  test("disables allow actions when exact authorization context is incomplete", () => {
    render(
      <ApprovalCard
        id="approval-incomplete"
        operationHash="hash-approval-incomplete"
        action="Approval details unavailable"
        risk="unknown"
        canPersist
      />,
    );

    expect(screen.queryByRole("button", { name: /^Allow/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny once — Approval details unavailable" })).toBeEnabled();
    expect(screen.getByText(/Allow actions are disabled/)).toBeInTheDocument();
  });
});

describe("Approval reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminusStore.setState({
      healthReady: true,
      healthStatus: "ready",
      healthDetail: null,
      lastError: null,
      selectedTaskId: "task-cold-approval",
      approvalsByTask: {},
      approvalFreshnessByTask: {},
      sessionsFreshness: { status: "ready", error: null },
      taskListFreshnessBySession: {},
      taskFreshnessById: { "task-cold-approval": { status: "ready", error: null } },
    });
  });

  test("surfaces a cold approval-list failure even when no approval row is retained", async () => {
    vi.mocked(api.listApprovals).mockRejectedValueOnce(new Error("approval coordinator unavailable"));

    await act(async () => {
      await useTerminusStore.getState().refreshApprovals("task-cold-approval");
    });

    expect(useTerminusStore.getState().approvalFreshnessByTask["task-cold-approval"]).toEqual({
      status: "error",
      error: "approval coordinator unavailable",
    });
    render(<ConnectionBanner />);
    const banner = screen.getByRole("alert", { name: "Navigation data is stale" });
    expect(banner).toHaveTextContent("Approvals data is temporarily unavailable");
    expect(banner).toHaveTextContent("approval coordinator unavailable");
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

  test("leaves navigation, submission, and Escape with an active IME composition", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const onClose = vi.fn();
    const commands: Command[] = [
      { id: "ime-first", label: "Alpha", group: "Navigation", action: first },
      { id: "ime-second", label: "Beta", group: "Navigation", action: second },
    ];
    render(<CommandPalette open={true} onClose={onClose} commands={commands} />);
    const input = screen.getByLabelText("Search commands");
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Esc closes the palette via the onClose callback", () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} onClose={onClose} commands={makeCommands()} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("backdrop click closes the palette", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette open={true} onClose={onClose} commands={makeCommands()} />);
    await user.click(screen.getByTestId("dialog-overlay"));
    expect(onClose).toHaveBeenCalled();
  });

  test("shows an empty-state message when no commands match", async () => {
    const user = userEvent.setup();
    render(<CommandPalette open={true} onClose={vi.fn()} commands={makeCommands()} />);
    await user.type(screen.getByLabelText("Search commands"), "zzzzz");
    expect(screen.getByText(/No commands match/)).toBeInTheDocument();
  });
});

function TestFocusDialog({ label }: { label: string }): JSX.Element {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, () => undefined);
  return (
    <div ref={dialogRef} role="dialog" aria-label={label} tabIndex={-1}>
      <button type="button">{label} control</button>
    </div>
  );
}

describe("lazy dialog focus lifecycle", () => {
  test("retains the launcher across a loading fallback and resolved dialog", async () => {
    const view = render(<button type="button">Open dialog</button>);
    const launcher = screen.getByRole("button", { name: "Open dialog" });
    launcher.focus();
    setAppDialogFocusOrigin(launcher);

    view.rerender(
      <>
        <button type="button">Open dialog</button>
        <TestFocusDialog key="loading" label="Loading dialog" />
      </>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Loading dialog control" })).toHaveFocus());

    view.rerender(
      <>
        <button type="button">Open dialog</button>
        <TestFocusDialog key="resolved" label="Resolved dialog" />
      </>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolved dialog control" })).toHaveFocus());

    view.rerender(<button type="button">Open dialog</button>);
    restoreAppDialogFocusOrigin();
    await waitFor(() => expect(screen.getByRole("button", { name: "Open dialog" })).toHaveFocus());
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
      healthReady: true,
      healthStatus: "ready",
      pinnedTaskIds: new Set(),
      pinPersistenceError: null,
      draftsByTask: {},
      sessionDraftsByTask: {},
      draftPersistenceByTask: {},
      draftStorageError: null,
      eventsByTask: {},
    });
    useThemeStore.getState().setDensity("spacious");
    useThemeStore.getState().setTheme("system");
    cleanup();
  });

  function makeTask(status: TaskDomainStatus): void {
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
          terminal_reason: null,
          contract: null,
        },
      },
    });
  }

  // ACTIVE is the control plane's steady state, not "a turn is running". A
  // task sitting idle in it has nothing to steer, and offering to steer it is
  // what made every task in the app look busy forever.
  test("task.status=ACTIVE with no run in flight → button label is 'Send'", () => {
    makeTask("ACTIVE");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /^Send/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Steer/ })).not.toBeInTheDocument();
  });

  test("task.status=ACTIVE with a running turn → the button steers", () => {
    makeTask("ACTIVE");
    useTerminusStore.setState({
      eventsByTask: { "task-1": [{ id: "1", event: "turn.started", data: "{}" }] },
    });
    render(<Composer />);
    expect(screen.getByRole("button", { name: /Queue for the current run|Steer/ })).toBeInTheDocument();
  });

  test("task.status=DRAFT → button label is 'Send' so the first turn can start", () => {
    makeTask("DRAFT");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /^Send/ })).toBeInTheDocument();
  });

  // needs_you is a claim about the task, not about a turn: it stands whether or
  // not one is running, and answering it is a steer.
  test("task.status=NEEDS_USER_DECISION → button label is 'Steer'", () => {
    makeTask("NEEDS_USER_DECISION");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /Steer/ })).toBeInTheDocument();
  });

  test("submitting a pending task starts it before creating the first turn", async () => {
    makeTask("DRAFT");
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "Begin the task");
    await user.click(screen.getByRole("button", { name: /^Send/ }));

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledTimes(1));
    expect(api.startTask).toHaveBeenCalledWith("task-1", {
      idempotencyKey: expect.stringMatching(/^composer-turn\.task-1:/),
    });
    expect(vi.mocked(api.startTask).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.startTurn).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(api.startTurn).toHaveBeenCalledWith({
      thread_id: "thread-1",
      task_id: "task-1",
      user_input: "Begin the task",
    }, {
      idempotencyKey: expect.stringMatching(/^composer-turn\.task-1:/),
    });
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

  test("applies an external draft replacement and cancels the pending local write", async () => {
    makeTask("ACTIVE");
    const user = userEvent.setup();
    render(<Composer />);

    const composer = screen.getByRole("textbox", { name: "Message composer" });
    await user.type(composer, "Local draft that has not persisted yet");
    act(() => {
      useTerminusStore.getState().setDraft("task-1", "Review this hunk and propose a safer revision");
    });

    await waitFor(() => expect(composer).toHaveValue("Review this hunk and propose a safer revision"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useTerminusStore.getState().draftsByTask["task-1"]).toBe(
      "Review this hunk and propose a safer revision",
    );
  });

  test("does not cancel this task's pending write for another task's replacement", () => {
    makeTask("ACTIVE");
    render(<Composer />);
    const composer = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(composer, { target: { value: "current task edit" } });

    act(() => {
      useTerminusStore.getState().setDraft("task-other", "other task replacement");
    });
    fireEvent.blur(composer);

    expect(useTerminusStore.getState().draftsByTask["task-1"]).toBe("current task edit");
    expect(useTerminusStore.getState().draftsByTask["task-other"]).toBe("other task replacement");
  });

  test("coalesces a burst into one idle draft write", () => {
    makeTask("ACTIVE");
    const requestDescriptor = Object.getOwnPropertyDescriptor(window, "requestIdleCallback");
    const cancelDescriptor = Object.getOwnPropertyDescriptor(window, "cancelIdleCallback");
    const callbacks = new Map<number, () => void>();
    let nextHandle = 1;
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      }),
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      value: vi.fn((handle: number) => callbacks.delete(handle)),
    });

    try {
      render(<Composer />);
      const composer = screen.getByRole("textbox", { name: "Message composer" });
      fireEvent.change(composer, { target: { value: "a" } });
      fireEvent.change(composer, { target: { value: "ab" } });
      fireEvent.change(composer, { target: { value: "abc" } });

      expect(callbacks.size).toBe(1);
      expect(useTerminusStore.getState().draftsByTask["task-1"]).toBeUndefined();
      const callback = [...callbacks.values()][0];
      if (!callback) throw new Error("Expected one scheduled draft write");
      act(callback);
      expect(useTerminusStore.getState().draftsByTask["task-1"]).toBe("abc");
    } finally {
      cleanup();
      if (requestDescriptor) Object.defineProperty(window, "requestIdleCallback", requestDescriptor);
      else Reflect.deleteProperty(window, "requestIdleCallback");
      if (cancelDescriptor) Object.defineProperty(window, "cancelIdleCallback", cancelDescriptor);
      else Reflect.deleteProperty(window, "cancelIdleCallback");
    }
  });

  test("flushes the latest draft when the composer unmounts before idle time", () => {
    makeTask("ACTIVE");
    const requestDescriptor = Object.getOwnPropertyDescriptor(window, "requestIdleCallback");
    const cancelDescriptor = Object.getOwnPropertyDescriptor(window, "cancelIdleCallback");
    const callbacks = new Map<number, () => void>();
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        callbacks.set(1, callback);
        return 1;
      }),
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      value: vi.fn((handle: number) => callbacks.delete(handle)),
    });

    try {
      const view = render(<Composer />);
      fireEvent.change(screen.getByRole("textbox", { name: "Message composer" }), {
        target: { value: "survives navigation" },
      });
      expect(callbacks.size).toBe(1);
      view.unmount();
      expect(callbacks.size).toBe(0);
      expect(useTerminusStore.getState().draftsByTask["task-1"]).toBe("survives navigation");
    } finally {
      cleanup();
      if (requestDescriptor) Object.defineProperty(window, "requestIdleCallback", requestDescriptor);
      else Reflect.deleteProperty(window, "requestIdleCallback");
      if (cancelDescriptor) Object.defineProperty(window, "cancelIdleCallback", cancelDescriptor);
      else Reflect.deleteProperty(window, "cancelIdleCallback");
    }
  });

  test("flushes the pending draft before the window unloads", () => {
    makeTask("ACTIVE");
    render(<Composer />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message composer" }), {
      target: { value: "survives window close" },
    });

    fireEvent(window, new Event("beforeunload"));

    expect(useTerminusStore.getState().draftsByTask["task-1"]).toBe("survives window close");
  });

  test("surfaces quota failures as session-only drafts with recovery actions", () => {
    makeTask("ACTIVE");
    const storage = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      render(<Composer />);
      const composer = screen.getByRole("textbox", { name: "Message composer" });
      fireEvent.change(composer, { target: { value: "keep this in memory" } });
      fireEvent.blur(composer);

      expect(useTerminusStore.getState().draftsByTask["task-1"]).toBe("keep this in memory");
      expect(useTerminusStore.getState().draftPersistenceByTask["task-1"]).toEqual({
        status: "session_only",
        error: "Local draft storage is full.",
      });
      expect(screen.getByText(/Draft not saved locally\. Local draft storage is full\./))
        .toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy draft" })).toBeInTheDocument();
    } finally {
      storage.mockRestore();
    }
  });

  test("retains collection-cap fallbacks per task while switching composers", () => {
    const fullDraftCollection = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`saved-${index}`, `Saved draft ${index}`]),
    );
    useTerminusStore.setState({ draftsByTask: fullDraftCollection, sessionDraftsByTask: {} });
    makeTask("ACTIVE");
    const firstTask = useTerminusStore.getState().taskById["task-1"]!;
    useTerminusStore.setState((state) => ({
      taskById: {
        ...state.taskById,
        "task-2": { ...firstTask, id: "task-2", thread_id: "thread-2" },
      },
    }));
    render(<Composer />);
    const composer = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(composer, { target: { value: "First session-only draft" } });
    fireEvent.blur(composer);
    expect(useTerminusStore.getState().sessionDraftsByTask["task-1"]).toBe("First session-only draft");

    act(() => useTerminusStore.setState({ selectedTaskId: "task-2" }));
    expect(composer).toHaveValue("");
    fireEvent.change(composer, { target: { value: "Second session-only draft" } });
    fireEvent.blur(composer);
    expect(useTerminusStore.getState().sessionDraftsByTask["task-2"]).toBe("Second session-only draft");

    act(() => useTerminusStore.setState({ selectedTaskId: "task-1" }));
    expect(composer).toHaveValue("First session-only draft");
    expect(screen.getByText(/retained per task until this window closes/)).toBeInTheDocument();
  });

  test("rejects a multibyte draft above the byte limit without silent truncation", () => {
    makeTask("ACTIVE");
    render(<Composer />);
    const composer = screen.getByRole("textbox", { name: "Message composer" });
    const oversized = "é".repeat(9_000);

    fireEvent.change(composer, { target: { value: oversized } });

    expect(composer).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("Draft limit reached");
    expect(useTerminusStore.getState().draftsByTask["task-1"]).toBeUndefined();
  });

  test("surfaces unreadable cold draft storage and resets it only on request", async () => {
    makeTask("ACTIVE");
    window.localStorage.setItem("terminus-desktop.drafts.v1", "{not-json");
    useTerminusStore.setState({
      draftsByTask: {},
      sessionDraftsByTask: {},
      draftPersistenceByTask: {},
      draftStorageError: null,
    });

    useTerminusStore.getState().retryDraftHydration();
    render(<Composer />);

    expect(screen.getByRole("alert")).toHaveTextContent("Saved draft recovery is unavailable");
    expect(window.localStorage.getItem("terminus-desktop.drafts.v1")).toBe("{not-json");
    await userEvent.click(screen.getByRole("button", { name: "Reset local draft storage" }));
    expect(window.localStorage.getItem("terminus-desktop.drafts.v1")).toBe("{}");
    expect(screen.queryByText(/Saved draft recovery is unavailable/)).not.toBeInTheDocument();
  });

  test("task.status=BLOCKED → button label is 'Steer'", () => {
    makeTask("BLOCKED");
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

  test("task.status=ABORTED → button label is 'Send'", () => {
    makeTask("ABORTED");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /^Send/ })).toBeInTheDocument();
  });

  test("task.status=NEEDS_USER_DECISION → button label is 'Steer'", () => {
    makeTask("NEEDS_USER_DECISION");
    render(<Composer />);
    expect(screen.getByRole("button", { name: /Steer/ })).toBeInTheDocument();
  });

  test("no task selected → button label is 'Send' (default)", () => {
    useTerminusStore.setState({ selectedTaskId: null });
    render(<Composer />);
    expect(screen.getByRole("button", { name: /^Send/ })).toBeInTheDocument();
  });

  test("keeps the start composer focused on the project and prompt", () => {
    useTerminusStore.setState({ selectedTaskId: null });
    render(<Composer onCreateTask={vi.fn(async () => undefined)} onChangeProject={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Change project" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Environment: Local")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Model profile: Default model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Permission profile: Workspace policy")).not.toBeInTheDocument();
    expect(screen.queryByText(/Claude|GPT|Gemini/)).not.toBeInTheDocument();
  });

  test("does not expose a fake provider selector when runtime model inventory is empty", () => {
    render(<Composer onCreateTask={vi.fn(async () => undefined)} />);
    expect(screen.queryByRole("button", { name: /provider/i })).not.toBeInTheDocument();
  });

  test("shows no access-level control until a project is selected", () => {
    render(<Composer />);

    // The access level is a session setting, so with no session there is
    // nothing to change and nothing to claim: no chip, no invented "Full
    // access", and no environment menu with nowhere to go.
    expect(screen.queryByRole("button", { name: /^Access level:/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Full access")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Environment details" })).not.toBeInTheDocument();
  });

  test("announces a submit failure without discarding the composer draft", async () => {
    makeTask("ACTIVE");
    vi.mocked(api.startTurn).mockRejectedValueOnce(new Error("provider unavailable"));
    const user = userEvent.setup();
    render(<Composer />);

    const composer = screen.getByRole("textbox", { name: "Message composer" });
    await user.type(composer, "Keep this exact retry");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("provider unavailable");
    expect(composer).toHaveValue("Keep this exact retry");
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

    // The routing the composer showed travels with the objective.
    expect(createTask).toHaveBeenCalledWith("Map this project", expect.any(Object));
  });
});

describe("NewTaskScreen — first turn lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
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
      healthReady: true,
      healthStatus: "ready",
      draftsByTask: {},
      eventsByTask: {},
    });
  });

  // Four generic prompt chips sat under the composer on every launch. Nobody
  // wanted to run "Find a bug" against an unspecified file, and they were the
  // only thing between the heading and the fold.
  test("offers no canned starter prompts", () => {
    render(<NewTaskScreen />);
    for (const label of ["Explain this codebase", "Find a bug", "Add a test", "Review recent changes"]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });

  test("starts the task and submits the objective as its first turn", async () => {
    const user = userEvent.setup();
    render(<NewTaskScreen />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "Build the live task surface");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledTimes(1));
    expect(api.startTask).toHaveBeenCalledWith("task-new", {
      idempotencyKey: expect.stringMatching(/^new-task\.session-1:/),
    });
    expect(api.startTurn).toHaveBeenCalledWith({
      thread_id: "thread-1",
      task_id: "task-new",
      user_input: "Build the live task surface",
    }, { idempotencyKey: expect.stringMatching(/^new-task\.session-1:/) });
    expect(vi.mocked(api.startTask).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.startTurn).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(useTerminusStore.getState().selectedTaskId).toBe("task-new");
  });

  test("resumes from the created-task checkpoint after an ambiguous start failure", async () => {
    const user = userEvent.setup();
    vi.mocked(api.startTask).mockRejectedValueOnce(new TerminusApiError(0, "connection lost", null));
    const first = render(<NewTaskScreen />);
    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "Resume this task");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect((await screen.findAllByText("connection lost")).length).toBeGreaterThan(0);
    const firstStartKey = vi.mocked(api.startTask).mock.calls[0]?.[1].idempotencyKey;
    first.unmount();

    render(<NewTaskScreen />);
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(api.startTurn).toHaveBeenCalledTimes(1));

    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(api.getTask).toHaveBeenCalledWith("task-new");
    expect(api.startTask).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.startTask).mock.calls[1]?.[1].idempotencyKey).toBe(firstStartKey);
  });

  test("keeps the start surface focused on project context and one composer", () => {
    render(<NewTaskScreen />);

    expect(screen.getByRole("heading", { name: "What should we build in Terminus?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change project" })).toHaveTextContent("Terminus");
    expect(screen.getAllByRole("textbox", { name: "Message composer" })).toHaveLength(1);
    expect(screen.queryByText("Map the codebase")).not.toBeInTheDocument();
  });

  test("leaves connection status to the sidebar rather than repeating it", async () => {
    // The sidebar is always on screen and owns runtime status and recovery.
    // A second offline banner here meant the same state shouted twice on the
    // one surface where the user is trying to start work.
    const originalRefreshAll = useTerminusStore.getState().refreshAll;
    const refreshAll = vi.fn(async () => undefined);
    useTerminusStore.setState({ healthReady: false, healthStatus: "offline", refreshAll });

    render(<NewTaskScreen />);
    expect(screen.queryByText(/Terminus is offline|Starting Terminus/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    act(() => useTerminusStore.setState({
      refreshAll: originalRefreshAll,
      healthReady: true,
      healthStatus: "ready",
    }));
  });
});

/**
 * The rail opens on the inbox. Cases about the project tree ask for it through
 * the stored view, so the setup stays out of the assertions.
 */
/** The rail groups by project. The stored value predates the rename and is
 *  still honoured, which is the point of reading it here. */
function openOnProjectsTree(): void {
  window.localStorage.setItem("terminus-desktop.sidebar-view.v1", "projects");
}

describe("Sidebar — navigation destinations", () => {
  beforeEach(() => {
    openOnProjectsTree();
  });

  test("keeps primary destinations available without showing empty attention chrome", async () => {
    const onNavigate = vi.fn();
    render(<Sidebar onNavigate={onNavigate} />);

    expect(screen.getByRole("button", { name: /^New (session|task)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^(Board|Kanban|Sessions)/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Needs you/ })).not.toBeInTheDocument();
    // "Agents" joins this list: it rendered a directory of departments,
    // operators and rooms that no route supplies.
    for (const unsupported of ["Agents", "Scheduled", "Plugins", "Pull requests", "Sites"]) {
      expect(screen.queryByRole("button", { name: unsupported })).not.toBeInTheDocument();
    }

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^(Board|Kanban|Sessions)/ }));
    expect(onNavigate).toHaveBeenCalledWith("board");
  });

  test("routes Settings without adding a second Help destination", async () => {
    const details: unknown[] = [];
    const listener = (event: Event): void => {
      details.push(event instanceof CustomEvent ? event.detail : null);
    };
    window.addEventListener("terminus:open-settings", listener);
    render(<Sidebar />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(details).toEqual([{ category: "appearance" }]);
    expect(screen.queryByRole("button", { name: "Help" })).not.toBeInTheDocument();
    window.removeEventListener("terminus:open-settings", listener);
  });

  // The magnifying glass used to unfold a filter field inside the rail that
  // narrowed the tree in place. It now raises the task search over the
  // workspace, and the rail underneath does not move.
  test("the search control raises the task search instead of filtering in place", async () => {
    const openSearch = vi.fn();
    window.addEventListener("terminus:open-task-search", openSearch);
    render(<Sidebar />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Search tasks" }));
    expect(openSearch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "Search tasks" })).not.toBeInTheDocument();
    window.removeEventListener("terminus:open-task-search", openSearch);
  });

  test("shows task matches without flooding results with every task in the project", async () => {
    const now = new Date().toISOString();
    const task = (id: string, objective: string): Task => ({
      id,
      session_id: "session-search",
      thread_id: `thread-${id}`,
      status: "ACTIVE",
      phase: "EXECUTING",
      active_contract_version: 1,
      risk_class: "normal",
      created_at: now,
      updated_at: now,
      completed_at: null,
      terminal_reason: null,
      contract: {
        version: 1,
        objective,
        non_goals: [],
        allowed_scope: { read_paths: [], write_paths: [], external_systems: [] },
      },
    });
    const matching = task("task-needle", "Needle migration");
    const unrelated = task("task-unrelated", "Unrelated cleanup");
    const selected = task("task-selected", "Selected context");
    useTerminusStore.setState({
      sessions: [{
        id: "session-search",
        workspace_id: "workspace-search",
        title: "Search project",
        status: "active",
        active_thread_id: selected.thread_id,
        created_at: now,
        updated_at: now,
      }],
      tasksBySession: { "session-search": [matching, unrelated, selected] },
      taskById: { [matching.id]: matching, [unrelated.id]: unrelated, [selected.id]: selected },
      selectedSessionId: "session-search",
      selectedTaskId: selected.id,
      pinnedTaskIds: new Set(),
    });
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    render(<TaskSearch open onClose={() => {}} onSelectTask={onSelectTask} onNewTask={() => {}} onOpenProject={() => {}} onOpenBoard={() => {}} onOpenCommands={() => {}} />);

    // Idle, the list is a recency view of everything, with the current
    // project's slots labelled the way ⌘1–9 will open them.
    expect(screen.getByText("Needle migration")).toBeInTheDocument();
    expect(screen.getByText("⌘1")).toBeInTheDocument();

    await user.type(screen.getByRole("combobox", { name: "Search tasks" }), "needle");
    await waitFor(() => expect(screen.queryByText("Unrelated cleanup")).not.toBeInTheDocument());
    expect(screen.getByText("Needle migration")).toBeInTheDocument();
    expect(screen.queryByText("Selected context")).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(onSelectTask).toHaveBeenCalledWith("task-needle"));
  });

  test("loads the next project page only when requested", async () => {
    const now = new Date().toISOString();
    const firstSession = {
      id: "session-page-1",
      workspace_id: "workspace-page",
      title: "First project",
      status: "active" as const,
      active_thread_id: "thread-page-1",
      created_at: now,
      updated_at: now,
    };
    const secondSession = { ...firstSession, id: "session-page-2", title: "Second project" };
    useTerminusStore.setState({
      sessions: [firstSession],
      tasksBySession: {},
      taskById: {},
      selectedSessionId: firstSession.id,
      selectedTaskId: null,
      sessionsPage: { nextCursor: "cursor-projects", total: 2, loadingMore: false, error: null },
    });
    vi.mocked(api.listSessions).mockResolvedValueOnce({
      sessions: [secondSession],
      total: 2,
      next_cursor: null,
      truncation: { occurred: false, continuation: null },
    });
    render(<Sidebar />);

    await userEvent.click(screen.getByRole("button", { name: "Load more projects" }));

    await waitFor(() => expect(screen.getByText("Second project")).toBeInTheDocument());
    expect(api.listSessions).toHaveBeenCalledWith({ cursor: "cursor-projects" });
    expect(useTerminusStore.getState().sessionsPage.nextCursor).toBeNull();
  });

  test("shows a cold project-list failure instead of an authoritative empty state", async () => {
    const originalRefreshSessions = useTerminusStore.getState().refreshSessions;
    const refreshSessions = vi.fn(async () => undefined);
    useTerminusStore.setState({
      sessions: [],
      sessionsFreshness: { status: "error", error: "project catalog unavailable" },
      loadingSessions: false,
      healthReady: true,
      healthStatus: "ready",
      refreshSessions,
    });
    render(<Sidebar />);

    expect(screen.getByRole("alert")).toHaveTextContent("Projects could not be loaded.");
    expect(screen.queryByText("project catalog unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("No projects yet.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry projects" }));
    expect(refreshSessions).toHaveBeenCalledTimes(1);
    act(() => useTerminusStore.setState({ refreshSessions: originalRefreshSessions }));
  });

  test("keeps offline recovery reachable without duplicating project errors", async () => {
    const originalRefreshAll = useTerminusStore.getState().refreshAll;
    const refreshAll = vi.fn(async () => undefined);
    useTerminusStore.setState({
      sessions: [],
      sessionsFreshness: { status: "error", error: "network error: Failed to fetch" },
      loadingSessions: false,
      healthReady: false,
      healthStatus: "offline",
      refreshAll,
    });

    render(<Sidebar />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry projects" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(refreshAll).toHaveBeenCalledTimes(1);
    act(() => useTerminusStore.setState({
      refreshAll: originalRefreshAll,
      healthReady: true,
      healthStatus: "ready",
    }));
  });

  test("keeps task continuation reachable while searching loaded rows", async () => {
    const now = new Date().toISOString();
    const session = {
      id: "session-search-continuation",
      workspace_id: "workspace-search-continuation",
      title: "Continuation project",
      status: "active" as const,
      active_thread_id: null,
      created_at: now,
      updated_at: now,
    };
    const unrelated: Task = {
      id: "task-loaded-unrelated",
      session_id: session.id,
      thread_id: "thread-loaded-unrelated",
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
    useTerminusStore.setState({
      sessions: [session],
      sessionsFreshness: { status: "ready", error: null },
      tasksBySession: { [session.id]: [unrelated] },
      taskById: { [unrelated.id]: unrelated },
      selectedSessionId: session.id,
      selectedTaskId: null,
      taskPagesBySession: {
        [session.id]: { nextCursor: "next-search-page", total: 2, loadingMore: false, error: null },
      },
    });
    render(<TaskSearch open onClose={() => {}} onSelectTask={() => {}} onNewTask={() => {}} onOpenProject={() => {}} onOpenBoard={() => {}} onOpenCommands={() => {}} />);

    await userEvent.type(screen.getByRole("combobox", { name: "Search tasks" }), "needle");

    // A miss in what is loaded offers the next page rather than "no match".
    expect(await screen.findByRole("option", { name: `Load more tasks in ${session.title}` })).toBeInTheDocument();
    expect(screen.queryByText(/No tasks match/)).not.toBeInTheDocument();
  });

  test("keeps an unrequested project's task catalog reachable during search", async () => {
    const now = new Date().toISOString();
    const selectedSession = {
      id: "session-loaded-search",
      workspace_id: "workspace-loaded-search",
      title: "Loaded project",
      status: "active" as const,
      active_thread_id: null,
      created_at: now,
      updated_at: now,
    };
    const coldSession = {
      ...selectedSession,
      id: "session-cold-search",
      workspace_id: "workspace-cold-search",
      title: "Cold project",
    };
    const originalRefreshTasks = useTerminusStore.getState().refreshTasks;
    const refreshTasks = vi.fn(async () => undefined);
    useTerminusStore.setState({
      sessions: [selectedSession, coldSession],
      sessionsFreshness: { status: "ready", error: null },
      tasksBySession: { [selectedSession.id]: [] },
      taskListFreshnessBySession: {
        [selectedSession.id]: { status: "ready", error: null },
      },
      taskPagesBySession: {
        [selectedSession.id]: { nextCursor: null, total: 0, loadingMore: false, error: null },
      },
      selectedSessionId: selectedSession.id,
      selectedTaskId: null,
      refreshTasks,
    });
    try {
      render(<TaskSearch open onClose={() => {}} onSelectTask={() => {}} onNewTask={() => {}} onOpenProject={() => {}} onOpenBoard={() => {}} onOpenCommands={() => {}} />);
      await userEvent.type(screen.getByRole("combobox", { name: "Search tasks" }), "needle");

      await userEvent.click(await screen.findByRole("option", { name: "Load tasks in Cold project" }));
      expect(refreshTasks).toHaveBeenCalledWith(coldSession.id);
      expect(screen.queryByText(/No tasks match/)).not.toBeInTheDocument();
    } finally {
      act(() => useTerminusStore.setState({ refreshTasks: originalRefreshTasks }));
    }
  });

  test("appends and de-duplicates an explicit next task page", async () => {
    const now = new Date().toISOString();
    const task = (id: string, objective: string): Task => ({
      id,
      session_id: "session-task-pages",
      thread_id: `thread-${id}`,
      status: "ACTIVE",
      phase: "EXECUTING",
      active_contract_version: 1,
      risk_class: "normal",
      created_at: now,
      updated_at: now,
      completed_at: null,
      terminal_reason: null,
      contract: {
        version: 1,
        objective,
        non_goals: [],
        allowed_scope: { read_paths: [], write_paths: [], external_systems: [] },
      },
    });
    const first = task("task-page-1", "First task");
    const second = task("task-page-2", "Second task");
    useTerminusStore.setState({
      tasksBySession: { "session-task-pages": [first] },
      taskById: { [first.id]: first },
      taskPagesBySession: {
        "session-task-pages": { nextCursor: "cursor-tasks", total: 2, loadingMore: false, error: null },
      },
    });
    vi.mocked(api.listTasks).mockResolvedValueOnce({
      tasks: [first, second],
      total: 2,
      next_cursor: null,
      truncation: { occurred: false, continuation: null },
    });

    await useTerminusStore.getState().loadMoreTasks("session-task-pages");

    expect(api.listTasks).toHaveBeenCalledWith("session-task-pages", { cursor: "cursor-tasks" });
    expect(useTerminusStore.getState().tasksBySession["session-task-pages"]?.map((candidate) => candidate.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  test("a first-page refresh invalidates an in-flight task continuation and removes absent rows", async () => {
    const now = new Date().toISOString();
    const task = (id: string): Task => ({
      id,
      session_id: "session-race",
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
    });
    const retained = task("task-retained");
    const removed = task("task-removed");
    const staleContinuation = task("task-stale-continuation");
    useTerminusStore.setState({
      tasksBySession: { "session-race": [retained, removed] },
      taskById: { [retained.id]: retained, [removed.id]: removed },
      pinnedTaskIds: new Set([removed.id]),
      draftsByTask: { [removed.id]: "durable draft" },
      eventsByTask: { [removed.id]: [{ id: "old-event", event: "turn.completed", data: "{}" }] },
      eventHistoryByTask: {
        [removed.id]: {
          reason: "bounded_window",
          omittedCount: 1,
          droppedThroughCursor: "old-event",
          continuationCursor: null,
          snapshotUrl: `/v1/tasks/${removed.id}`,
          reconciliation: "ready",
          error: null,
        },
      },
      approvalsByTask: {
        [removed.id]: [{ id: "old-approval", action: "Old", risk: "normal", canPersist: false, supportedDecisions: ["deny_once"], authorizationReady: false }],
      },
      approvalFreshnessByTask: { [removed.id]: { status: "ready", error: null } },
      approvalPagesByTask: { [removed.id]: { nextCursor: null, total: 1, loadingMore: false, error: null } },
      taskFreshnessById: { [removed.id]: { status: "ready", error: null } },
      selectedTaskId: null,
      loadingTasksFor: null,
      taskListFreshnessBySession: { "session-race": { status: "ready", error: null } },
      taskPagesBySession: {
        "session-race": { nextCursor: "old-cursor", total: 3, loadingMore: false, error: null },
      },
    });
    let resolveContinuation!: (response: TaskListResponse) => void;
    const continuation = new Promise<TaskListResponse>((resolve) => {
      resolveContinuation = resolve;
    });
    vi.mocked(api.listTasks)
      .mockImplementationOnce(async () => continuation)
      .mockResolvedValueOnce({
        tasks: [retained],
        total: 1,
        next_cursor: null,
        truncation: { occurred: false, continuation: null },
      });

    const loadMore = useTerminusStore.getState().loadMoreTasks("session-race");
    const refresh = useTerminusStore.getState().refreshTasks("session-race");
    await refresh;
    resolveContinuation({
      tasks: [staleContinuation],
      total: 3,
      next_cursor: null,
      truncation: { occurred: false, continuation: null },
    });
    await loadMore;

    const state = useTerminusStore.getState();
    expect(state.tasksBySession["session-race"]?.map((candidate) => candidate.id)).toEqual([retained.id]);
    expect(state.taskById[removed.id]).toBeUndefined();
    expect(state.taskById[staleContinuation.id]).toBeUndefined();
    expect(state.eventsByTask[removed.id]).toBeUndefined();
    expect(state.eventHistoryByTask[removed.id]).toBeUndefined();
    expect(state.approvalsByTask[removed.id]).toBeUndefined();
    expect(state.approvalFreshnessByTask[removed.id]).toBeUndefined();
    expect(state.approvalPagesByTask[removed.id]).toBeUndefined();
    expect(state.taskFreshnessById[removed.id]).toBeUndefined();
    expect(state.draftsByTask[removed.id]).toBe("durable draft");
    expect(state.pinnedTaskIds.has(removed.id)).toBe(true);
    expect(state.loadingTasksFor).toBeNull();
    expect(state.taskListFreshnessBySession["session-race"]).toEqual({ status: "ready", error: null });

    vi.mocked(api.listTasks).mockResolvedValueOnce({
      tasks: [removed],
      total: 1,
      next_cursor: null,
      truncation: { occurred: false, continuation: null },
    });
    await useTerminusStore.getState().refreshTasks("session-race");
    expect(useTerminusStore.getState().taskById[removed.id]).toEqual(removed);
    expect(useTerminusStore.getState().eventsByTask[removed.id]).toBeUndefined();
  });

  test("a partial first-page refresh preserves selected and pinned continuation tasks", async () => {
    const now = new Date().toISOString();
    const task = (id: string): Task => ({
      id,
      session_id: "session-selected-page",
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
    });
    const firstPageTask = task("task-first-page");
    const selectedContinuationTask = task("task-selected-continuation");
    const pinnedContinuationTask = task("task-pinned-continuation");
    const staleContinuationTask = task("task-stale-continuation");
    useTerminusStore.setState({
      tasksBySession: {
        "session-selected-page": [firstPageTask, selectedContinuationTask, pinnedContinuationTask, staleContinuationTask],
      },
      taskById: {
        [firstPageTask.id]: firstPageTask,
        [selectedContinuationTask.id]: selectedContinuationTask,
        [pinnedContinuationTask.id]: pinnedContinuationTask,
        [staleContinuationTask.id]: staleContinuationTask,
      },
      pinnedTaskIds: new Set([pinnedContinuationTask.id]),
      selectedSessionId: "session-selected-page",
      selectedTaskId: selectedContinuationTask.id,
      taskPagesBySession: {
        "session-selected-page": { nextCursor: null, total: 3, loadingMore: false, error: null },
      },
    });
    vi.mocked(api.listTasks).mockResolvedValueOnce({
      tasks: [firstPageTask],
      total: 4,
      next_cursor: "next-task-page",
      truncation: { occurred: true, continuation: "next-task-page" },
    });

    await useTerminusStore.getState().refreshTasks("session-selected-page");

    const state = useTerminusStore.getState();
    expect(state.selectedTaskId).toBe(selectedContinuationTask.id);
    expect(state.taskById[selectedContinuationTask.id]).toEqual(selectedContinuationTask);
    expect(state.taskById[pinnedContinuationTask.id]).toEqual(pinnedContinuationTask);
    expect(state.taskById[staleContinuationTask.id]).toBeUndefined();
    expect(state.tasksBySession["session-selected-page"]?.map((candidate) => candidate.id)).toEqual([
      firstPageTask.id,
      pinnedContinuationTask.id,
      selectedContinuationTask.id,
    ]);
  });

  test("selecting a pinned task also selects its owning project", () => {
    const original = useTerminusStore.getState();
    const now = new Date().toISOString();
    const pinned: Task = {
      id: "task-cross-project-pin",
      session_id: "session-pin-owner",
      thread_id: "thread-cross-project-pin",
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
    const refreshTask = vi.fn(async () => undefined);
    const refreshApprovals = vi.fn(async () => undefined);
    const attachStream = vi.fn();
    useTerminusStore.setState({
      selectedSessionId: "session-other",
      selectedTaskId: null,
      taskById: { [pinned.id]: pinned },
      tasksBySession: { [pinned.session_id]: [pinned] },
      refreshTask,
      refreshApprovals,
      _attachStream: attachStream,
    });

    useTerminusStore.getState().selectTask(pinned.id);

    expect(useTerminusStore.getState().selectedSessionId).toBe(pinned.session_id);
    expect(useTerminusStore.getState().selectedTaskId).toBe(pinned.id);
    expect(refreshTask).toHaveBeenCalledWith(pinned.id);
    expect(refreshApprovals).toHaveBeenCalledWith(pinned.id);
    expect(attachStream).toHaveBeenCalledWith(pinned.id, null);
    useTerminusStore.setState({
      refreshTask: original.refreshTask,
      refreshApprovals: original.refreshApprovals,
      _attachStream: original._attachStream,
    });
  });

  test("hydrates cold pins with bounded concurrency and inserts their task rows", async () => {
    const now = new Date().toISOString();
    const sessionId = "session-pin-hydration";
    const ids = Array.from({ length: 6 }, (_, index) => `cold-pin-${index + 1}`);
    let active = 0;
    let maxActive = 0;
    vi.mocked(api.getTask).mockImplementation(async (id) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (id === "cold-pin-3") throw new Error("temporary pin lookup failure");
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
    });
    useTerminusStore.setState({
      sessions: [{
        id: sessionId,
        workspace_id: "workspace-pins",
        title: "Pinned project",
        status: "active",
        active_thread_id: null,
        created_at: now,
        updated_at: now,
      }],
      tasksBySession: { [sessionId]: [] },
      taskById: {},
      pinnedTaskIds: new Set(ids),
      taskFreshnessById: {},
    });

    await useTerminusStore.getState().refreshPinnedTasks();

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(api.getTask).toHaveBeenCalledTimes(6);
    expect(useTerminusStore.getState().tasksBySession[sessionId]).toHaveLength(5);
    expect(useTerminusStore.getState().taskFreshnessById["cold-pin-3"]).toMatchObject({ status: "error" });
    expect(useTerminusStore.getState().pinnedTaskIds.has("cold-pin-3")).toBe(true);
  });

  test("removes a confirmed missing pin but retains a retryable failed pin", async () => {
    const originalGetTask = vi.mocked(api.getTask).getMockImplementation();
    useTerminusStore.setState({
      pinnedTaskIds: new Set(["pin-gone", "pin-retry"]),
      taskById: {},
      tasksBySession: {},
      taskFreshnessById: {},
      pinPersistenceError: null,
    });
    vi.mocked(api.getTask).mockRejectedValueOnce(new TerminusApiError(404, "task not found", null));
    await useTerminusStore.getState().refreshTask("pin-gone");
    expect(useTerminusStore.getState().pinnedTaskIds.has("pin-gone")).toBe(false);

    vi.mocked(api.getTask).mockRejectedValueOnce(new TerminusApiError(503, "control plane unavailable", null));
    await useTerminusStore.getState().refreshTask("pin-retry");
    expect(useTerminusStore.getState().pinnedTaskIds.has("pin-retry")).toBe(true);
    render(<Sidebar />);
    expect(screen.getByText("Pinned task pin-retry — unavailable")).toBeInTheDocument();
    expect(screen.getByText(/This task is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/control plane unavailable/)).not.toBeInTheDocument();
    if (originalGetTask) vi.mocked(api.getTask).mockImplementation(originalGetTask);
  });

  test("upserts a task detail that was absent from its loaded session page", async () => {
    const now = new Date().toISOString();
    const task: Task = {
      id: "task-detail-upsert",
      session_id: "session-detail-upsert",
      thread_id: "thread-detail-upsert",
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
    useTerminusStore.setState({
      sessions: [{
        id: task.session_id,
        workspace_id: "workspace-detail-upsert",
        title: "Detail project",
        status: "active",
        active_thread_id: task.thread_id,
        created_at: now,
        updated_at: now,
      }],
      tasksBySession: { [task.session_id]: [] },
      taskById: {},
    });
    vi.mocked(api.getTask).mockResolvedValueOnce(task);

    await useTerminusStore.getState().refreshTask(task.id);

    expect(useTerminusStore.getState().tasksBySession[task.session_id]).toEqual([task]);
    expect(useTerminusStore.getState().taskById[task.id]).toEqual(task);
  });

  test("approval refresh removes a row resolved outside the renderer", async () => {
    const requestedAt = new Date().toISOString();
    const summary = (id: string): ApprovalSummary => ({
      id,
      task_id: "task-approval-pages",
      operation_hash: `hash-${id}`,
      binding: null,
      display: null,
      status: "pending",
      decision: null,
      supported_decisions: ["deny_once"],
      risk: "normal",
      scope: [],
      use_limit: 1,
      use_count: 0,
      expires_at: null,
      requested_at: requestedAt,
      resolved_at: null,
      rationale: null,
    });
    useTerminusStore.setState({
      approvalsByTask: {
        "task-approval-pages": [
          { id: "approval-retained", action: "Retained", risk: "normal", canPersist: false, supportedDecisions: ["deny_once"], authorizationReady: false },
          { id: "approval-resolved", action: "Resolved elsewhere", risk: "normal", canPersist: false, supportedDecisions: ["deny_once"], authorizationReady: false },
        ],
      },
      approvalFreshnessByTask: { "task-approval-pages": { status: "ready", error: null } },
      approvalPagesByTask: {
        "task-approval-pages": { nextCursor: "approval-cursor", total: 2, loadingMore: false, error: null },
      },
    });
    vi.mocked(api.listApprovals).mockResolvedValueOnce({
      approvals: [summary("approval-retained")],
      total: 1,
      next_cursor: null,
      truncation: { occurred: false, continuation: null },
    });

    await useTerminusStore.getState().refreshApprovals("task-approval-pages");

    expect(useTerminusStore.getState().approvalsByTask["task-approval-pages"]?.map((approval) => approval.id)).toEqual([
      "approval-retained",
    ]);
  });

  test("rejects a cross-task identity from a task-scoped event stream", () => {
    const now = new Date().toISOString();
    const task = (id: string): Task => ({
      id,
      session_id: "session-stream-scope",
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
    });
    const selected = task("task-stream-selected");
    const other = task("task-stream-other");
    useTerminusStore.setState({
      tasksBySession: { "session-stream-scope": [selected, other] },
      taskById: { [selected.id]: selected, [other.id]: other },
      selectedTaskId: selected.id,
    });

    useTerminusStore.getState()._updateTaskFromEvent({
      id: "poisoned-event",
      event: "task.completed",
      data: JSON.stringify({ task_id: other.id, status: "COMPLETED" }),
    }, selected.id);

    expect(useTerminusStore.getState().taskById[selected.id]?.status).toBe("ACTIVE");
    expect(useTerminusStore.getState().taskById[other.id]?.status).toBe("ACTIVE");
  });

  test("reaches virtualized tasks with End, Home, and arrow-key roving focus", async () => {
    const widthSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(280);
    const heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(432);
    const now = new Date().toISOString();
    const tasks = Array.from({ length: 60 }, (_, index): Task => ({
      id: `virtual-task-${String(index + 1).padStart(2, "0")}`,
      session_id: "session-virtual",
      thread_id: `thread-virtual-${index + 1}`,
      status: "ACTIVE",
      phase: "EXECUTING",
      active_contract_version: 1,
      risk_class: "normal",
      created_at: now,
      updated_at: now,
      completed_at: null,
      terminal_reason: null,
      contract: {
        version: 1,
        objective: `Virtual task ${index + 1}`,
        non_goals: [],
        allowed_scope: { read_paths: [], write_paths: [], external_systems: [] },
      },
    }));
    useTerminusStore.setState({
      sessions: [{
        id: "session-virtual",
        workspace_id: "workspace-virtual",
        title: "Virtual project",
        status: "active",
        active_thread_id: tasks[0]?.thread_id ?? null,
        created_at: now,
        updated_at: now,
      }],
      tasksBySession: { "session-virtual": tasks },
      taskById: Object.fromEntries(tasks.map((task) => [task.id, task])),
      selectedSessionId: "session-virtual",
      selectedTaskId: tasks[0]?.id ?? null,
      taskPagesBySession: {
        "session-virtual": { nextCursor: null, total: tasks.length, loadingMore: false, error: null },
      },
      taskListFreshnessBySession: {
        "session-virtual": { status: "ready", error: null },
      },
    });
    try {
      const user = userEvent.setup();
      render(<Sidebar />);
      await user.click(screen.getByRole("button", { name: /Show \d+ more tasks in Virtual project/ }));

      const first = screen.getByRole("button", { name: /Virtual task 1, status Ready/ });
      expect(first.closest("[role='listitem']")).toHaveAttribute("aria-posinset", "1");
      expect(first.closest("[role='listitem']")).toHaveAttribute("aria-setsize", "60");
      act(() => first.focus());
      fireEvent.keyDown(first, { key: "End" });
      await waitFor(() => expect(screen.getByRole("button", { name: /Virtual task 60, status Ready/ })).toHaveFocus());

      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
      await waitFor(() => expect(screen.getByRole("button", { name: /Virtual task 1, status Ready/ })).toHaveFocus());
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
      await waitFor(() => expect(screen.getByRole("button", { name: /Virtual task 2, status Ready/ })).toHaveFocus());
    } finally {
      heightSpy.mockRestore();
      widthSpy.mockRestore();
    }
  });
});

// ────────────────────────── 7. TaskRow ──────────────────────────────────────

describe("TaskRow — truncation + tooltip", () => {
  const LONG_TITLE =
    "This is a very long task title that should be truncated because it goes well beyond the available sidebar width";

  test("keeps the title to one line, with the full text still reachable", () => {
    render(
      <TaskRow
        title={LONG_TITLE}
        selected={false}
      />,
    );
    const titleSpan = screen.getByText(LONG_TITLE);
    // This previously clamped to two lines, on the reasoning that one line cut
    // titles at ~21 characters and made sibling tasks indistinguishable. The
    // sidebar has since widened (256px default, ~173px of title column) and the
    // row gained a status//time line beneath the title, so two clamped lines
    // plus meta made every row a three-line paragraph and the rail a wall of
    // text. One line plus meta stays scannable, and the cases where a title is
    // genuinely ambiguous are covered by the tooltip and the accessible name
    // asserted below.
    expect(titleSpan).toHaveClass("truncate");
    expect(titleSpan).not.toHaveClass("line-clamp-2");
  });

  test("exposes the full title through the accessible row name", () => {
    render(
      <TaskRow
        title={LONG_TITLE}
        selected={false}
      />,
    );
    const row = screen.getByRole("button");
    expect(row).toHaveAccessibleName(expect.stringContaining(LONG_TITLE));
  });

  test("names the queue row by what it wants, not by its lifecycle id", () => {
    // The rail has no width for a reason line, so the reason rides in the
    // accessible name and the tooltip. A screen reader that announced "status
    // needs_you" told the operator nothing they could act on.
    render(
      <TaskRow
        title="Fix the auth race"
        status="needs_you"
        emphasis="queue"
        needsYou
        reason="Approve or deny"
        meta="Terminus"
        selected={false}
      />,
    );
    const row = screen.getByRole("button");
    expect(row).toHaveAccessibleName(expect.stringContaining("Approve or deny"));
    expect(row).toHaveAccessibleName(expect.stringContaining("in Terminus"));
    expect(row).toHaveAttribute("data-tooltip", "Fix the auth race — Terminus — Approve or deny");
  });

  test("marks unread in its own colour, in its own gutter, not as a status", () => {
    // Read-state is orthogonal to what the agent is doing, so it gets the
    // accent dot and its own reserved slot rather than borrowing the amber,
    // red and green that mean something else.
    const { container, rerender } = render(
      <TaskRow title="Settled task" status="done" selected={false} />,
    );
    expect(container.querySelector(".bg-accent")).toBeNull();
    expect(screen.getByRole("button")).toHaveAccessibleName(expect.not.stringContaining("unread"));

    rerender(<TaskRow title="Settled task" status="done" selected={false} unread />);
    expect(container.querySelector(".bg-accent")).not.toBeNull();
    expect(screen.getByRole("button")).toHaveAccessibleName(expect.stringContaining("unread"));
  });

  test("shows the pin/unpin button only on hover (and when pinned)", () => {
    const onTogglePin = vi.fn();
    const { rerender } = render(
      <TaskRow
        title="Short title"
        selected={false}
        onTogglePin={onTogglePin}
      />,
    );
    // The action is visually hidden until pointer hover or keyboard focus.
    // Opacity preserves its focusability; focus-within reveals it before a
    // keyboard user acts.
    const pinButton = screen.getByLabelText("Pin task Short title");
    expect(pinButton).toHaveClass("opacity-0");
    expect(pinButton).toHaveClass("group-focus-within:opacity-100");

    // When pinned, the pin button is visible regardless of hover.
    rerender(
      <TaskRow
        title="Short title"
        selected={false}
        pinned
        onTogglePin={onTogglePin}
      />,
    );
    const unpinButton = screen.getByLabelText("Unpin task Short title");
    expect(unpinButton).not.toHaveClass("opacity-0");
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
  test("shows three tasks initially and all tasks after expansion", () => {
    expect(sidebarVisibleTaskCount(12, -1, false)).toBe(3);
    expect(sidebarVisibleTaskCount(12, -1, true)).toBe(12);
  });

  test("keeps the selected task visible beyond the initial three", () => {
    expect(sidebarVisibleTaskCount(12, 8, false)).toBe(9);
  });

  test("never claims more rows than the project contains", () => {
    expect(sidebarVisibleTaskCount(3, -1, false)).toBe(3);
  });
});

// Collapsing three projects and hiding the rail are deliberate acts, and both
// used to last exactly as long as the window did.
describe("Sidebar — remembered shape", () => {
  const now = new Date().toISOString();
  const seedTask = (id: string, sessionId: string, objective: string): Task => ({
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
    contract: {
      version: 1,
      objective,
      non_goals: [],
      allowed_scope: { read_paths: [], write_paths: [], external_systems: [] },
    },
  });
  const seedSession = (id: string, title: string) => ({
    id,
    workspace_id: `workspace-${id}`,
    title,
    status: "active" as const,
    active_thread_id: null,
    created_at: now,
    updated_at: now,
  });

  beforeEach(() => {
    window.localStorage.clear();
    const task = seedTask("task-a", "session-1", "Rebuild the index");
    useTerminusStore.setState({
      sessions: [seedSession("session-1", "Terminus")],
      tasksBySession: { "session-1": [task] },
      taskById: { [task.id]: task },
      selectedSessionId: "session-1",
      selectedTaskId: null,
      pinnedTaskIds: new Set(),
      healthReady: true,
      healthStatus: "ready",
    });
  });

  test("defaults to a visible rail and forgets nothing it was never told", () => {
    expect(readSidebarVisible()).toBe(true);
    writeSidebarVisible(false);
    expect(readSidebarVisible()).toBe(false);
  });

  test("restores collapsed projects across a remount", () => {
    openOnProjectsTree();
    window.localStorage.setItem(
      "terminus-desktop.sidebar-collapsed-projects.v1",
      JSON.stringify(["session-1"]),
    );
    render(<Sidebar />);

    expect(screen.getByRole("button", { name: "Expand Terminus" })).toBeInTheDocument();
    expect(screen.queryByText("Rebuild the index")).not.toBeInTheDocument();
  });

  test("records a collapse so the next launch honours it", async () => {
    const user = userEvent.setup();
    openOnProjectsTree();
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: "Collapse Terminus" }));

    expect(JSON.parse(
      window.localStorage.getItem("terminus-desktop.sidebar-collapsed-projects.v1") ?? "[]",
    )).toEqual(["session-1"]);
  });

  test("opens on projects and exposes activity as a temporary sidebar projection", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Add or switch project" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open activity" }));
    expect(screen.getByRole("button", { name: "Close activity" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Add or switch project" })).not.toBeInTheDocument();
  });

  // The question is what the *list* holds, not what the workspace holds. Six
  // open projects buy the label nothing when every pin is from one of them,
  // and in a compact rail it costs the titles about 40% of their width.
  test("labels pinned rows only once the pinned list spans two projects", () => {
    openOnProjectsTree();
    const race = seedTask("task-race", "session-2", "Fix the auth race");
    const index = seedTask("task-index", "session-1", "Rebuild the index");
    const setPins = (ids: readonly string[]) => useTerminusStore.setState({
      sessions: [seedSession("session-1", "Terminus"), seedSession("session-2", "Website")],
      tasksBySession: { "session-1": [index], "session-2": [race] },
      taskById: { [race.id]: race, [index.id]: index },
      pinnedTaskIds: new Set(ids),
    });

    setPins([race.id]);
    render(<Sidebar />);
    // One pin, so nothing to disambiguate: no project rides along, even though
    // a second project is open right there in the tree below.
    expect(screen.queryByRole("button", { name: /Fix the auth race, in Website/ })).not.toBeInTheDocument();

    cleanup();
    setPins([race.id, index.id]);
    render(<Sidebar />);

    // The row is one line; the project rides along as a recessive suffix, and
    // the spoken label says which repository the race is in.
    expect(screen.getByRole("button", { name: /Fix the auth race, in Website/ })).toBeInTheDocument();
  });

  test("leaves the project off a pinned row when there is only one project", () => {
    const pinned = seedTask("task-pinned", "session-1", "Fix the auth race");
    useTerminusStore.setState({
      tasksBySession: { "session-1": [pinned] },
      taskById: { [pinned.id]: pinned },
      pinnedTaskIds: new Set([pinned.id]),
    });
    render(<Sidebar />);

    expect(screen.queryByRole("button", { name: /in Terminus/ })).not.toBeInTheDocument();
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

  test("applies reduced motion to the live document", () => {
    const settings = useSettingsStore.getState();
    settings.set("appearance.reduce-motion", true);
    expect(document.documentElement.dataset.reduceMotion).toBe("true");

    settings.set("appearance.reduce-motion", false);
    expect(document.documentElement.dataset.reduceMotion).toBe("false");
  });

  test("normalizes malformed persisted-style select and numeric values", () => {
    const settings = useSettingsStore.getState();
    settings.set("appearance.theme", "Light");
    settings.set("appearance.density", "dense");

    expect(settings.get("appearance.theme")).toBe("system");
    expect(settings.get("appearance.density")).toBe("compact");
    expect(useThemeStore.getState().theme).toBe("system");
    expect(useThemeStore.getState().density).toBe("compact");
  });
});
