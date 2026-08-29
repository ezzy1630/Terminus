/**
 * Composer keyboard behaviour.
 *
 * Enter did not send. `⌘↵` was the only binding, so a plain Return silently
 * inserted a newline into a finished message and the composer grew instead of
 * emptying. Shift is what makes a newline now, and an active input-method
 * composition still commits its candidate rather than sending a half-typed
 * word.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Composer } from "../src/components/Composer";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { api } from "../src/lib/api";
import { currentShortcutPlatform, FIXED_SHORTCUTS, matchesShortcut } from "../src/lib/shortcuts";
import type { Task, TerminusSseEvent } from "../src/types";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      startTask: vi.fn(async () => ({ task_id: "task-1", status: "ACTIVE", event_cursor: "cursor-1", links: { events: "", task: "" } })),
      startTurn: vi.fn(async () => ({})),
      steerTurn: vi.fn(async () => ({ episode_id: "ep-1", sequence: 1, turn_id: "turn-1", turn_state: "PROVIDER_RUNNING" })),
      updateSession: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
      listProviderModels: vi.fn(async () => ({ providers: [], models: [] })),
    },
  };
});

const now = new Date().toISOString();

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    session_id: "session-1",
    thread_id: "thread-1",
    status: "ACTIVE",
    phase: "EXECUTE",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: now,
    updated_at: now,
    completed_at: null,
    terminal_reason: null,
    contract: null,
    ...overrides,
  };
}

function install(current: Task, events: TerminusSseEvent[] = []): void {
  useTerminusStore.setState({
    selectedSessionId: current.session_id,
    selectedTaskId: current.id,
    taskById: { [current.id]: current },
    tasksBySession: { [current.session_id]: [current] },
    eventsByTask: { [current.id]: events },
    queuedSteerByTask: {},
    draftsByTask: {},
    sessionDraftsByTask: {},
    draftPersistenceByTask: {},
    draftStorageError: null,
    healthReady: true,
    healthStatus: "ready",
  });
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Message composer" }) as HTMLTextAreaElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

afterEach(() => {
  cleanup();
  useTerminusStore.setState({ queuedSteerByTask: {}, draftsByTask: {}, sessionDraftsByTask: {} });
});

describe("sendPlain binding", () => {
  test("is an unmodified Return in composer scope", () => {
    expect(FIXED_SHORTCUTS.sendPlain).toMatchObject({ key: "Enter", modifier: "none", scope: "composer" });
  });

  test("matches a bare Return and rejects every modified one", () => {
    const bare = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(matchesShortcut(bare, FIXED_SHORTCUTS.sendPlain, "mac")).toBe(true);
    expect(matchesShortcut({ ...bare, shiftKey: true }, FIXED_SHORTCUTS.sendPlain, "mac")).toBe(false);
    expect(matchesShortcut({ ...bare, metaKey: true }, FIXED_SHORTCUTS.sendPlain, "mac")).toBe(false);
    expect(matchesShortcut({ ...bare, altKey: true }, FIXED_SHORTCUTS.sendPlain, "mac")).toBe(false);
  });
});

describe("Composer key handling", () => {
  test("Enter sends the message", async () => {
    install(task({ status: "DRAFT" }));
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(composer(), "ship it");
    fireEvent.keyDown(composer(), { key: "Enter" });

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "task-1", user_input: "ship it" }),
      expect.anything(),
    ));
    await waitFor(() => expect(composer()).toHaveValue(""));
  });

  test("Shift+Enter inserts a newline and sends nothing", async () => {
    install(task({ status: "DRAFT" }));
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(composer(), "first line");
    await user.type(composer(), "{Shift>}{Enter}{/Shift}");
    await user.type(composer(), "second line");

    expect(composer().value).toBe("first line\nsecond line");
    expect(api.startTurn).not.toHaveBeenCalled();
  });

  test("the primary-modifier Return still sends", async () => {
    install(task({ status: "DRAFT" }));
    const user = userEvent.setup();
    render(<Composer />);
    // Command on macOS, Control everywhere else — the same rule the rest of the
    // fixed map follows.
    const primary = currentShortcutPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };

    await user.type(composer(), "muscle memory");
    fireEvent.keyDown(composer(), { key: "Enter", ...primary });

    await waitFor(() => expect(api.startTurn).toHaveBeenCalled());
  });

  // An IME commit reaches the textarea as Return. Sending on it would post a
  // half-typed word and swallow the candidate the user was choosing.
  test("an in-flight IME composition commits instead of sending", async () => {
    install(task({ status: "DRAFT" }));
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(composer(), "こんにち");
    fireEvent.keyDown(composer(), { key: "Enter", keyCode: 229 });
    expect(api.startTurn).not.toHaveBeenCalled();

    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true });
    expect(api.startTurn).not.toHaveBeenCalled();

    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(api.startTurn).toHaveBeenCalledTimes(1));
  });

  test("Enter during a run queues instead of interrupting or opening a second turn", async () => {
    install(
      task({ active_turn: { id: "turn-1", sequence: 1, state: "PROVIDER_RUNNING", started_at: null } }),
      [{ id: "1", event: "turn.started", data: "{}" }],
    );
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(composer(), "use fetch instead");
    fireEvent.keyDown(composer(), { key: "Enter" });

    await waitFor(() => expect(composer()).toHaveValue(""));
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(api.steerTurn).not.toHaveBeenCalled();
    expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBe("use fetch instead");
  });

  test("Command+Enter during a run steers immediately", async () => {
    install(
      task({ active_turn: { id: "turn-1", sequence: 1, state: "PROVIDER_RUNNING", started_at: null } }),
      [{ id: "1", event: "turn.started", data: "{}" }],
    );
    const user = userEvent.setup();
    render(<Composer />);
    const primary = currentShortcutPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };

    await user.type(composer(), "use fetch now");
    fireEvent.keyDown(composer(), { key: "Enter", ...primary });

    await waitFor(() => expect(api.steerTurn).toHaveBeenCalledWith(
      "turn-1",
      { message: "use fetch now" },
      expect.anything(),
    ));
    expect(api.startTurn).not.toHaveBeenCalled();
  });
});

// ────────────────────────── Retry after a failure ────────────────────────────
// A failed turn used to end the conversation: the task went terminal and the
// composer said "create a new task to continue". The control plane now leaves
// the task ACTIVE, so the same prompt can simply go again.

describe("retrying a failed turn", () => {
  test("resends the exact prompt as a new turn", async () => {
    install(task());
    render(<Composer />);

    window.dispatchEvent(new CustomEvent("terminus:retry-turn", {
      detail: { taskId: "task-1", text: "add the missing migration" },
    }));

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "task-1", user_input: "add the missing migration" }),
      expect.anything(),
    ));
  });

  test("ignores a retry aimed at a task this composer is not showing", async () => {
    install(task());
    render(<Composer />);

    window.dispatchEvent(new CustomEvent("terminus:retry-turn", {
      detail: { taskId: "task-elsewhere", text: "not mine" },
    }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.startTurn).not.toHaveBeenCalled();
  });

  test("surfaces the failure instead of swallowing it", async () => {
    install(task());
    vi.mocked(api.startTurn).mockRejectedValueOnce(new Error("provider unavailable"));
    render(<Composer />);

    window.dispatchEvent(new CustomEvent("terminus:retry-turn", {
      detail: { taskId: "task-1", text: "try again" },
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent("provider unavailable");
  });

  test("an ACTIVE task is never told to start over", async () => {
    install(task());
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(composer(), "keep going");

    expect(screen.queryByText(/create a new task to continue/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Send/ })).not.toBeDisabled();
  });
});
