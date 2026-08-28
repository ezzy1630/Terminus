/**
 * Steering while the agent is working, and the spend readout.
 *
 * `POST /v1/turns` refuses a second concurrent turn with
 * `TASK_TURN_ALREADY_ACTIVE`, so typing during a run used to fail with a raw
 * conflict error. The composer now holds the message and sends it the moment
 * the turn settles.
 *
 * The same surface gained a cost/context readout. Both numbers were already on
 * the wire in `budget_ledger`; the app displayed neither.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Composer } from "../src/components/Composer";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { api, TerminusApiError } from "../src/lib/api";
import type { Task, TaskBudgetLedger, TerminusSseEvent } from "../src/types";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      startTask: vi.fn(async () => ({ task_id: "task-1", status: "ACTIVE", event_cursor: "cursor-1", links: { events: "", task: "" } })),
      startTurn: vi.fn(async () => ({})),
      listProviderModels: vi.fn(async () => ({ models: [], default_model: null })),
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
  useTerminusStore.setState({ queuedSteerByTask: {} });
});

describe("steering while a run is in flight", () => {
  test("holds the message instead of sending a request that can only conflict", async () => {
    install(task({ active_turn: { id: "turn-1", sequence: 1, state: "PROVIDER_RUNNING", started_at: null } }));
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "actually use fetch");
    await user.click(screen.getByRole("button", { name: /Queue for the current run/ }));

    await waitFor(() => {
      expect(useTerminusStore.getState().queuedSteerByTask["task-1"]).toBe("actually use fetch");
    });
    expect(api.startTurn).not.toHaveBeenCalled();
  });

  test("says the message is held rather than delivered", async () => {
    install(task(), [event("turn.started")]);
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "prefer the smaller change");
    await user.click(screen.getByRole("button", { name: /Queue for the current run/ }));

    await waitFor(() => expect(screen.getByText("Queued.")).toBeInTheDocument());
    expect(screen.getByText(/goes as soon as the current run finishes/)).toBeInTheDocument();
    expect(screen.getByText("prefer the smaller change")).toBeInTheDocument();
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

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledWith(
      { thread_id: "thread-1", task_id: "task-1", user_input: "now do the other thing" },
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

    await waitFor(() => expect(screen.getByText("Not sent — the task finished first.")).toBeInTheDocument());
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

  test("shows what the task has cost", () => {
    install(task({ budget_ledger: ledger }));
    render(<Composer />);
    expect(screen.getByRole("status", { name: "Cost $1.42" })).toBeInTheDocument();
  });

  test("switches to context once the window is the pressing constraint", () => {
    install(task({ budget_ledger: { ...ledger, context_headroom_tokens: "10000" } }));
    render(<Composer />);
    expect(screen.getByRole("status", { name: /^Context 95%/ })).toBeInTheDocument();
  });

  test("shows nothing at all rather than zeroes when there is no ledger", () => {
    install(task());
    render(<Composer />);
    expect(screen.queryByRole("status", { name: /^Cost/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /^Context/ })).not.toBeInTheDocument();
  });
});
