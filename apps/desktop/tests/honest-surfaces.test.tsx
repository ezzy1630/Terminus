/**
 * Surfaces that stated things the app could not know.
 *
 * Each of these was observed in the 2026-08-28 run: a board filter whose ids
 * matched no column and therefore emptied the board, a "Display" button that
 * did nothing, a branch chip and a "PR ready" chip drawn from task status
 * alone, an inspector reporting a transport and an access level it never
 * measured, a composer chip that renamed `secure-local-default` to "Full
 * access", and a settings search that could not find the provider category.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { settingsCategoryFor } from "../src/App";
import { Composer } from "../src/components/Composer";
import { Inspector } from "../src/components/Inspector";
import { Settings } from "../src/components/Settings";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { BOARD_COLUMNS } from "../src/lib/task-lifecycle";
import type { Session, Task } from "../src/types";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      listProviderModels: vi.fn(async () => ({ providers: [], models: [] })),
      listTaskArtifacts: vi.fn(async () => ({ task_id: "task-1", artifacts: [], total: 0, next_cursor: null })),
      getSandboxReport: vi.fn(async () => { throw new Error("no sandbox report"); }),
      // The inspector asks for a working-tree diff and swallows the failure;
      // these tests are about the environment read-out, not the diff.
      getTaskDiff: vi.fn(async () => { throw new Error("no task diff"); }),
      startTurn: vi.fn(async () => ({})),
      getGatewayProviderConfiguration: vi.fn(async () => ({ configuration: null })),
    },
  };
});

const now = "2026-08-28T00:00:00.000Z";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    session_id: "session-1",
    thread_id: "thread-1",
    status: "ACTIVE",
    phase: "EXECUTE",
    active_contract_version: 3,
    risk_class: "normal",
    created_at: now,
    updated_at: now,
    completed_at: null,
    terminal_reason: null,
    contract: null,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    workspace_id: "ws-1",
    title: "Terminus",
    status: "active",
    active_thread_id: "thread-1",
    created_at: now,
    updated_at: now,
    ...overrides,
  } as Session;
}

function install(overrides: Partial<Parameters<typeof useTerminusStore.setState>[0]> = {}): void {
  useTerminusStore.setState({
    sessions: [session()],
    selectedSessionId: "session-1",
    selectedTaskId: "task-1",
    taskById: { "task-1": task() },
    tasksBySession: { "session-1": [task()] },
    eventsByTask: {},
    approvalsByTask: {},
    queuedSteerByTask: {},
    draftsByTask: {},
    sessionDraftsByTask: {},
    healthReady: true,
    healthStatus: "ready",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  window.localStorage.clear();
});

afterEach(cleanup);

describe("the board's status filter", () => {
  test("offers exactly the columns the board has", () => {
    // The menu offered "running", "waiting_for_review" and "done"; the filter
    // compares against board column ids, so two of the three matched nothing
    // and silently emptied the board.
    expect(BOARD_COLUMNS.map((column) => column.id))
      .toEqual(["queued", "working", "needs_you", "review", "done"]);
  });
});

describe("the inspector's environment section", () => {
  test("reports the session's own permission profile and nothing invented", async () => {
    install({ sessions: [session({ default_permission_profile: "secure-local-default" })] });
    render(<Inspector />);

    expect(await screen.findByTitle("secure-local-default")).toBeInTheDocument();
    expect(screen.queryByText("Local UDS")).not.toBeInTheDocument();
    expect(screen.getByText("Full access")).toBeInTheDocument();
    // The contract version is the task's, not a default of 1.
    expect(screen.getByText("v3")).toBeInTheDocument();
  });

  test("shows the task's own risk class rather than a default of Standard", () => {
    install({
      taskById: { "task-1": task({ risk_class: "critical" }) },
      tasksBySession: { "session-1": [task({ risk_class: "critical" })] },
    });
    render(<Inspector />);

    expect(screen.getByText("critical")).toBeInTheDocument();
    expect(screen.queryByText("Standard")).not.toBeInTheDocument();
  });

  test("omits the permission profile entirely when the session reports none", () => {
    install({ sessions: [session()] });
    render(<Inspector />);

    expect(screen.queryByText("Permission profile")).not.toBeInTheDocument();
    expect(screen.queryByText("Full access")).not.toBeInTheDocument();
  });
});

describe("the composer with no models", () => {
  test("keeps the selected model visible with one quiet recovery row", async () => {
    install({ sessions: [session({ default_model: "opencode/zen-free" })] });
    render(<Composer />);

    expect(await screen.findByText("opencode/zen-free is unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Change model and effort.*opencode\/zen-free/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up models" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check models again" })).toBeInTheDocument();
  });
});

describe("settings routing", () => {
  test("a request for providers or models opens the category that holds them", () => {
    expect(settingsCategoryFor("providers")).toBe("agents");
    expect(settingsCategoryFor("models")).toBe("agents");
    expect(settingsCategoryFor("agents")).toBe("agents");
    expect(settingsCategoryFor("shortcuts")).toBe("shortcuts");
    // An unknown id must not silently land on the theme picker without reason.
    expect(settingsCategoryFor(undefined)).toBe("appearance");
  });

  test("searching for a provider finds the category that configures one", async () => {
    const user = userEvent.setup();
    render(<Settings open onClose={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: /search/i }), "provider");

    // The category holds no `settings` rows — its controls are bespoke — and
    // the old filter dropped any category whose rows list came back empty.
    expect(screen.queryByRole("heading", { name: "No matching settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Agents/ })).toBeInTheDocument();
  });

  test("searching for an api key finds it too", async () => {
    const user = userEvent.setup();
    render(<Settings open onClose={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: /search/i }), "api key");

    expect(screen.queryByRole("heading", { name: "No matching settings" })).not.toBeInTheDocument();
  });
});
