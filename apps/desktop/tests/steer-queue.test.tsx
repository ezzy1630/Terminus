/**
 * Steering while the agent is working, queueing follow-ups, and spend.
 *
 * Typing during a run first failed with a raw `TASK_TURN_ALREADY_ACTIVE`, then
 * is now an explicit choice: Return/button queues a follow-up; Command+Return
 * uses `POST /v1/turns/:id/steer` to deliver a correction into the live turn.
 * A failed steer only falls back to the queue when the turn settled mid-send.
 *
 * The same surface gained a cost/context readout. Both numbers were already on
 * the wire in `budget_ledger`; the app displayed neither.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Composer } from "../src/components/Composer";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { api, TerminusApiError } from "../src/lib/api";
import { currentShortcutPlatform } from "../src/lib/shortcuts";
import type { Task, TaskBudgetLedger, TerminusSseEvent } from "../src/types";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      startTask: vi.fn(async () => ({ task_id: "task-1", status: "ACTIVE", event_cursor: "cursor-1", links: { events: "", task: "" } })),
      startTurn: vi.fn(async () => ({})),
      steerTurn: vi.fn(async () => ({ episode_id: "ep-1", sequence: 2, turn_id: "turn-1", turn_state: "PROVIDER_RUNNING" })),
      getTask: vi.fn(async () => task()),
      // A composer with no model at all is a degenerate case with its own
      // empty state (see honest-surfaces). Steering and spend are exercised
      // against a composer that can actually route a turn.
      listProviderModels: vi.fn(async () => ({
        providers: [{ id: "anthropic", label: "Anthropic", available: true }],
        models: [
          { id: "sonnet", provider: "anthropic", label: "Sonnet", slug: "claude-sonnet-4-6", reasoning: true, context_tokens: 200000, reasoning_efforts: ["low", "medium", "high", "max"], default_reasoning_effort: "medium" },
        ],
      })),
      getProviderConfig: vi.fn(async () => ({ configured: false, configuration: null })),
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

function event(type: string, id = type): TerminusSseEvent {
  return { id, event: type, data: "{}" };
}

function install(current: Task, events: TerminusSseEvent[] = []): void {
  useTerminusStore.setState({
    selectedTaskId: current.id,
    taskById: { [current.id]: current },
    tasksBySession: { [current.session_id]: [current] },
    eventsByTask: { [current.id]: events },
    queuedSteerByTask: {},
    queuedSteerAtByTask: {},
    draftsByTask: {},
    sessionDraftsByTask: {},
    draftPersistenceByTask: {},
    draftStorageError: null,
    healthReady: true,
    healthStatus: "ready",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

afterEach(() => {
  cleanup();
  useTerminusStore.setState({ queuedSteerByTask: {}, queuedSteerAtByTask: {} });
});

const RUNNING_TURN = { id: "turn-1", sequence: 1, state: "PROVIDER_RUNNING", started_at: null } as const;

function steerNow(): void {
  const primary = currentShortcutPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message composer" }), {
    key: "Enter",
    ...primary,
  });
}

describe("steering a live turn", () => {
  test("offers an explicit steer-now mode instead of relying on a shortcut", async () => {
    install(task({ active_turn: { ...RUNNING_TURN } }), [event("turn.started")]);
    const user = userEvent.setup();
    render(<Composer />);

    await user.click(screen.getByRole("button", { name: "Send mode: After current turn" }));
    await user.click(screen.getByRole("menuitem", { name: /Steer current turn now/ }));
    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "change direction now");
    await user.click(screen.getByRole("button", { name: "Steer current turn now" }));

    await waitFor(() => expect(api.steerTurn).toHaveBeenCalledWith(
      "turn-1",
      { message: "change direction now" },
      expect.anything(),
    ));
    expect(api.startTurn).not.toHaveBeenCalled();
  });

  test("delivers the correction into the run instead of queueing it", async () => {
    install(task({ active_turn: { ...RUNNING_TURN } }), [event("turn.started")]);
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "actually use fetch");
    steerNow();

    await waitFor(() => expect(api.steerTurn).toHaveBeenCalledWith(
      "turn-1",
      { message: "actually use fetch" },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    ));
    // Steering appends an episode to the running turn. Opening a second turn
    // is exactly what the control plane refuses.
    expect(api.startTurn).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message composer" })).toHaveValue(""));
    expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBeUndefined();
  });

  test("falls back to the queue only when the turn settled first", async () => {
    install(task({ active_turn: { ...RUNNING_TURN } }), [event("turn.started")]);
    vi.mocked(api.steerTurn).mockRejectedValueOnce(new TerminusApiError(409, "turn cannot be steered from COMPLETED", {
      code: "TURN_STEERING_STATE_CONFLICT",
      message: "turn cannot be steered from COMPLETED",
      retryable: false,
      category: "conflict",
    }));
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "too late");
    steerNow();

    await waitFor(() => expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBe("too late"));
  });

  test("surfaces a steer failure that is not a race, and does not hide it in the queue", async () => {
    install(task({ active_turn: { ...RUNNING_TURN } }), [event("turn.started")]);
    vi.mocked(api.steerTurn).mockRejectedValueOnce(new TerminusApiError(500, "kernel artifact ingest failed", {
      code: "INTERNAL",
      message: "kernel artifact ingest failed",
      retryable: true,
      category: "internal",
    }));
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "use the other adapter");
    steerNow();

    expect(await screen.findByRole("alert")).toHaveTextContent("kernel artifact ingest failed");
    expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBeUndefined();
    // The text stays put so it is not lost with the failure.
    expect(screen.getByRole("textbox", { name: "Message composer" })).toHaveValue("use the other adapter");
  });
});

describe("steering while a run is in flight", () => {
  test("holds the message when this client does not yet know the running turn", async () => {
    install(task(), [event("turn.started")]);
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "prefer the smaller change");
    await user.click(screen.getByRole("button", { name: /Queue for the current run/ }));

    await waitFor(() => expect(screen.getByText("Queued.")).toBeInTheDocument());
    expect(screen.getByText(/goes as a new turn/)).toBeInTheDocument();
    expect(screen.getByText("prefer the smaller change")).toBeInTheDocument();
    expect(api.steerTurn).not.toHaveBeenCalled();
  });

  test("clears the composer, so the text lives in exactly one place", async () => {
    install(task(), [event("turn.started")]);
    const user = userEvent.setup();
    render(<Composer />);

    const textarea = screen.getByRole("textbox", { name: "Message composer" });
    await user.type(textarea, "hold this");
    await user.click(screen.getByRole("button", { name: /Queue for the current run/ }));

    await waitFor(() => expect(textarea).toHaveValue(""));
  });

  test("draws the one real queued message above the composer and edits it in place", async () => {
    install(task(), [event("turn.started")]);
    const user = userEvent.setup();
    render(<Composer />);
    useTerminusStore.setState({ queuedSteerByTask: { "task-1": "add the regression test" } });

    const tray = await screen.findByRole("status", { name: "Queued follow-up" });
    const textarea = screen.getByRole("textbox", { name: "Message composer" });
    expect(tray.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(textarea).toHaveValue("add the regression test");
    expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBeUndefined();
  });

  test("does not overwrite the existing queued message", async () => {
    install(task(), [event("turn.started")]);
    const user = userEvent.setup();
    render(<Composer />);
    useTerminusStore.setState({ queuedSteerByTask: { "task-1": "first follow-up" } });

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "second follow-up");
    await user.click(screen.getByRole("button", { name: /Queue for the current run/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("One follow-up is already queued");
    expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBe("first follow-up");
    expect(screen.getByRole("textbox", { name: "Message composer" })).toHaveValue("second follow-up");
  });

  test("sends the moment the run settles", async () => {
    const running = task();
    install(running, [event("turn.started")]);
    render(<Composer />);
    useTerminusStore.setState({ queuedSteerByTask: { "task-1": "now do the other thing" } });

    // Nothing goes out while the turn is still in flight.
    await waitFor(() => expect(screen.getByText("Queued.")).toBeInTheDocument());
    expect(api.startTurn).not.toHaveBeenCalled();

    useTerminusStore.setState({
      eventsByTask: { "task-1": [event("turn.started", "1"), event("turn.completed", "2")] },
    });

    // A queued flush is a send like any other: it routes to the model the
    // composer is showing at the moment it goes out, not to whatever the
    // control plane would have defaulted to.
    await waitFor(() => expect(api.startTurn).toHaveBeenCalledWith(
      {
        thread_id: "thread-1",
        task_id: "task-1",
        user_input: "now do the other thing",
        model: "claude-sonnet-4-6",
        reasoning_effort: "medium",
        // The account travels with the model: a bare id does not name a route
        // once more than one credential can answer to it.
        provider_account_id: "anthropic",
      },
      { idempotencyKey: expect.stringMatching(/^composer-turn\.task-1:/) },
    ));
    await waitFor(() => expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBeUndefined());
  });

  test("keeps the message when it loses a race with a newly started turn", async () => {
    install(task(), [event("turn.started", "1"), event("turn.completed", "2")]);
    vi.mocked(api.startTurn).mockRejectedValueOnce(new TerminusApiError(409, "task already has a non-terminal turn", {
      code: "TASK_TURN_ALREADY_ACTIVE",
      message: "task already has a non-terminal turn",
      retryable: true,
      category: "conflict",
    }));
    render(<Composer />);
    useTerminusStore.setState({ queuedSteerByTask: { "task-1": "still want this" } });

    await waitFor(() => expect(api.startTurn).toHaveBeenCalled());
    // Discarding here would lose what the user typed to a transient conflict.
    expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBe("still want this");
  });

  test("does not queue forever against a task that ended", async () => {
    install(task({ status: "COMPLETED", completed_at: now }));
    render(<Composer />);
    useTerminusStore.setState({ queuedSteerByTask: { "task-1": "one more thing" } });

    await waitFor(() => expect(screen.getByText("Not sent.")).toBeInTheDocument());
    expect(screen.getByText("The task finished before this message could run.")).toBeInTheDocument();
    expect(api.startTurn).not.toHaveBeenCalled();
    // The text is still on screen, recoverable, rather than silently dropped.
    expect(screen.getByText("one more thing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Put back" })).toBeInTheDocument();
  });

  test("puts an unsendable message back in the composer on request", async () => {
    install(task({ status: "COMPLETED", completed_at: now }));
    const user = userEvent.setup();
    render(<Composer />);
    useTerminusStore.setState({ queuedSteerByTask: { "task-1": "one more thing" } });

    await user.click(await screen.findByRole("button", { name: "Put back" }));

    expect(screen.getByRole("textbox", { name: "Message composer" })).toHaveValue("one more thing");
    expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBeUndefined();
  });

  test("stops claiming to be waiting once the wait is unreasonable", async () => {
    install(task(), [event("turn.started")]);
    const user = userEvent.setup();
    render(<Composer />);
    // Queued 31 seconds ago and still held: this client's view of the run is
    // stale, and saying "queued" for another minute is a lie of omission.
    useTerminusStore.setState({
      queuedSteerByTask: { "task-1": "send it already" },
      queuedSteerAtByTask: { "task-1": Date.now() - 31_000 },
    });

    expect(await screen.findByText("Still waiting.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "task-1", user_input: "send it already" }),
      expect.anything(),
    ));
    await waitFor(() => expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBeUndefined());
  });

  test("can be discarded", async () => {
    install(task(), [event("turn.started")]);
    const user = userEvent.setup();
    render(<Composer />);
    useTerminusStore.setState({ queuedSteerByTask: { "task-1": "never mind" } });

    await user.click(await screen.findByRole("button", { name: "Discard the queued message" }));

    expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBeUndefined();
  });
});

describe("Stop availability", () => {
  test("is offered while a run is in flight", () => {
    install(task(), [event("turn.started")]);
    render(<Composer />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  test("disappears once the run settles", () => {
    // The old test was "has any turn ever started", which stayed true forever,
    // so the button outlived the work it claimed to stop.
    install(task(), [event("turn.started", "1"), event("turn.completed", "2")]);
    render(<Composer />);
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });
});

describe("model presentation", () => {
  test("shows the exact model instead of an opaque control-plane profile", async () => {
    install(task());
    useTerminusStore.setState({
      selectedSessionId: "session-1",
      sessions: [{
        id: "session-1",
        workspace_id: "workspace-1",
        title: "Terminus",
        status: "active",
        active_thread_id: "thread-1",
        created_at: now,
        updated_at: now,
        default_model_profile: "implementer",
      }],
    });
    const user = userEvent.setup();
    render(<Composer />);

    const trigger = await screen.findByRole("button", { name: /^Change model and effort/ });
    expect(trigger).toHaveTextContent("Sonnet");
    expect(trigger).not.toHaveTextContent("Implementer");

    await user.click(trigger);
    const settings = screen.getByRole("dialog", { name: "Turn settings" });
    expect(within(settings).queryByText("Run profile")).not.toBeInTheDocument();
    expect(within(settings).queryByText("Implementer")).not.toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: /Model: Sonnet/ })).toBeInTheDocument();
  });
});

describe("spend readout", () => {
  const ledger: TaskBudgetLedger = {
    steps_used: 4,
    max_steps: 40,
    tokens_used: "120000",
    input_tokens: "100000",
    output_tokens: "20000",
    reasoning_tokens: "0",
    cached_input_tokens: "0",
    max_tokens: "200000",
    cost_micros: "1420000",
    max_cost_micros: null,
    context_headroom_tokens: "150000",
  };

  /**
   * Spend moved out of the composer's control row and into the footer of the
   * model popover. The row is for things that get clicked; a running total is
   * a figure to consult, and as a permanent chip it competed for attention
   * with the send button on every single turn. Nothing about *what* is
   * reported changed — it is still read from `budget_ledger`, still omitted
   * entirely when the ledger cannot support it, and still never a zero
   * standing in for an unknown.
   */
  async function openTurnSettings(): Promise<HTMLElement> {
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Change model and effort/ }));
    return screen.getByRole("dialog", { name: "Turn settings" });
  }

  test("shows what the task has cost", async () => {
    install(task({ budget_ledger: ledger }));
    render(<Composer />);

    // Not in the control row.
    expect(screen.queryByText(/\$1\.42/)).not.toBeInTheDocument();
    expect(within(await openTurnSettings()).getByText(/Cost \$1\.42/)).toBeInTheDocument();
  });

  test("switches to context once the window is the pressing constraint", async () => {
    install(task({ budget_ledger: { ...ledger, context_headroom_tokens: "10000" } }));
    render(<Composer />);

    expect(within(await openTurnSettings()).getByText(/Context 95%/)).toBeInTheDocument();
  });

  test("shows nothing at all rather than zeroes when there is no ledger", async () => {
    install(task());
    render(<Composer />);

    const panel = await openTurnSettings();
    expect(within(panel).queryByText(/\$/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Context \d/)).not.toBeInTheDocument();
    // The model's own window is still stated — that is the provider's fact,
    // not the ledger's, and it does not depend on the task having spent
    // anything.
    expect(within(panel).getByText(/200K context window/)).toBeInTheDocument();
  });
});
