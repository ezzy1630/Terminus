/**
 * The model the picker shows is the model the turn runs on.
 *
 * Before this the picker wrote a global gateway configuration row and
 * `POST /v1/turns` carried no model at all: every run went to whatever the
 * control plane happened to default to, and choosing a model for one project
 * silently changed it for all of them. The choice now belongs to the session
 * and travels with the turn.
 */
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Composer, describeTurnFailure } from "../src/components/Composer";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { api, TerminusApiError } from "../src/lib/api";
import { EMPTY_INVENTORY, useModelSelection } from "../src/lib/models";
import type { ModelInventory, ModelOption } from "../src/lib/models";
import type { Session, Task } from "../src/types";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      startTask: vi.fn(async () => ({ task_id: "task-1", status: "ACTIVE", event_cursor: "cursor-1", links: { events: "", task: "" } })),
      startTurn: vi.fn(async () => ({})),
      listTasks: vi.fn(async () => []),
      // The store writes the response back over the session it patched, so a
      // mock that resolves to nothing would blank the project out from under
      // the picker.
      updateSession: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
        id,
        workspace_id: "ws-1",
        active_thread_id: "thread-1",
        title: "Terminus",
        status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...patch,
      })),
      listProviderModels: vi.fn(async () => ({
        providers: [{ id: "anthropic", label: "Anthropic", available: true }],
        models: [
          { id: "sonnet", provider: "anthropic", label: "Sonnet", slug: "claude-sonnet-4-6", reasoning: true, context_tokens: 200000 },
          { id: "haiku", provider: "anthropic", label: "Haiku", slug: "claude-haiku-4-6", reasoning: false, context_tokens: 200000 },
        ],
      })),
    },
  };
});

const now = new Date().toISOString();

function model(overrides: Partial<ModelOption> = {}): ModelOption {
  return { id: "sonnet", provider: "anthropic", label: "Sonnet", slug: "claude-sonnet-4-6", reasoning: true, contextTokens: 200_000, ...overrides };
}

function inventory(models: readonly ModelOption[]): ModelInventory {
  return { ...EMPTY_INVENTORY, models, providers: [], status: "ready" };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    workspace_id: "ws-1",
    active_thread_id: "thread-1",
    title: "Terminus",
    created_at: now,
    updated_at: now,
    ...overrides,
  } as Session;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    session_id: "session-1",
    thread_id: "thread-1",
    status: "DRAFT",
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

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  window.localStorage.clear();
});

afterEach(cleanup);

describe("useModelSelection resolution", () => {
  test("prefers the session default over the inventory's first model", () => {
    const models = [model({ id: "haiku", slug: "claude-haiku-4-6" }), model()];
    const { result } = renderHook(() => useModelSelection(
      inventory(models),
      { id: "session-1", default_model: "claude-sonnet-4-6", default_reasoning_effort: "high" },
    ));

    expect(result.current.selected?.id).toBe("sonnet");
    expect(result.current.effort).toBe("high");
  });

  test("falls back to the first available model when the project has no default", () => {
    const { result } = renderHook(() => useModelSelection(
      inventory([model({ id: "haiku", slug: "claude-haiku-4-6" }), model()]),
      { id: "session-1", default_model: null },
    ));

    expect(result.current.selected?.id).toBe("haiku");
  });

  test("reports nothing selected when no provider reported a model", () => {
    const { result } = renderHook(() => useModelSelection(EMPTY_INVENTORY, { id: "session-1" }));
    expect(result.current.selected).toBeNull();
  });

  test("writes the project default when a model is picked", async () => {
    const persist = vi.fn(async () => undefined);
    const { result } = renderHook(() => useModelSelection(
      inventory([model(), model({ id: "haiku", slug: "claude-haiku-4-6" })]),
      { id: "session-1" },
      persist,
    ));

    act(() => result.current.select("haiku"));

    expect(persist).toHaveBeenCalledWith("session-1", { default_model: "claude-haiku-4-6" });
    await waitFor(() => expect(result.current.selected?.id).toBe("haiku"));
    expect(result.current.persistError).toBeNull();
  });

  test("keeps the local choice and says so when the default cannot be stored", async () => {
    const persist = vi.fn(async () => { throw new Error("session is read-only"); });
    const { result } = renderHook(() => useModelSelection(
      inventory([model(), model({ id: "haiku", slug: "claude-haiku-4-6" })]),
      { id: "session-1" },
      persist,
    ));

    act(() => result.current.select("haiku"));

    await waitFor(() => expect(result.current.persistError).toContain("session is read-only"));
    // The turn still routes to what the operator picked.
    expect(result.current.selected?.id).toBe("haiku");
  });

  test("a choice made in one project does not follow the operator into another", () => {
    const models = [model(), model({ id: "haiku", slug: "claude-haiku-4-6" })];
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useModelSelection(inventory(models), { id }),
      { initialProps: { id: "session-1" } },
    );

    act(() => result.current.select("haiku"));
    expect(result.current.selected?.id).toBe("haiku");

    rerender({ id: "session-2" });
    expect(result.current.selected?.id).toBe("sonnet");
  });
});

/**
 * The composer states its routing in one pill and changes it in one popover.
 *
 * Model and effort used to be two separate chips in the control row, each with
 * its own menu, sitting beside a third chip for the context window and a
 * fourth for spend. They are one decision — what this turn runs as — so they
 * are now one control: `<model> <effort>`, opening a settings popover whose
 * root states the current values and whose rows open the lists.
 */
describe("the turn-routing pill", () => {
  function installStartOfWork(overrides: Partial<Session> = {}): void {
    useTerminusStore.setState({
      sessions: [session(overrides)],
      selectedSessionId: "session-1",
      selectedTaskId: "task-1",
      taskById: { "task-1": task() },
      tasksBySession: { "session-1": [task()] },
      eventsByTask: {},
      queuedSteerByTask: {},
      draftsByTask: {},
      sessionDraftsByTask: {},
      healthReady: true,
      healthStatus: "ready",
    });
  }

  async function openPopover(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(await screen.findByRole("button", { name: /^Change model and effort/ }));
    return screen.getByRole("dialog", { name: "Turn settings" });
  }

  test("states both values without being opened", async () => {
    installStartOfWork({ default_model: "claude-sonnet-4-6", default_reasoning_effort: "high" });
    render(<Composer />);

    const pill = await screen.findByRole("button", { name: /^Change model and effort/ });
    expect(pill).toHaveTextContent("Sonnet");
    expect(pill).toHaveTextContent("High");
  });

  test("the root pane states the current model and effort, and nothing else", async () => {
    installStartOfWork({ default_model: "claude-sonnet-4-6", default_reasoning_effort: "high" });
    const user = userEvent.setup();
    render(<Composer />);

    const panel = await openPopover(user);
    expect(within(panel).getByRole("button", { name: "Model: Sonnet. Change model" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Effort: High. Change effort" })).toBeInTheDocument();
    // Terminus has no speed dial distinct from effort, so it does not draw a
    // row for one, and no "Reset to default" either: every pick already writes
    // the project default, so there is nothing a reset could restore.
    expect(within(panel).queryByText("Speed")).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Reset to default/)).not.toBeInTheDocument();
  });

  test("the Model row opens the list, and the pick becomes the project default", async () => {
    installStartOfWork({ default_model: "claude-sonnet-4-6" });
    const user = userEvent.setup();
    render(<Composer />);

    const panel = await openPopover(user);
    await user.click(within(panel).getByRole("button", { name: "Model: Sonnet. Change model" }));
    await user.click(await within(panel).findByRole("button", { name: "Haiku, Anthropic" }));

    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith(
      "session-1",
      { default_model: "claude-haiku-4-6" },
      expect.anything(),
    ));
    // Choosing closes the popover: the decision is made in one click, not two.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn settings" })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: /^Change model and effort · Haiku/ })).toBeInTheDocument();
  });

  test("the Effort row opens the list and returns to the root", async () => {
    installStartOfWork({ default_model: "claude-sonnet-4-6", default_reasoning_effort: "medium" });
    const user = userEvent.setup();
    render(<Composer />);

    const panel = await openPopover(user);
    await user.click(within(panel).getByRole("button", { name: "Effort: Medium. Change effort" }));
    await user.click(await within(panel).findByRole("button", { name: /^Max/ }));

    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith(
      "session-1",
      { default_reasoning_effort: "max" },
      expect.anything(),
    ));
    expect(within(panel).getByRole("button", { name: "Effort: Max. Change effort" })).toBeInTheDocument();
  });

  test("offers no effort row for a model the provider says does not reason", async () => {
    installStartOfWork({ default_model: "claude-haiku-4-6" });
    const user = userEvent.setup();
    render(<Composer />);

    // An inert depth control on a non-reasoning model is a promise the runtime
    // cannot keep, so the row is absent rather than disabled.
    const pill = await screen.findByRole("button", { name: /^Change model and effort · Haiku$/ });
    await user.click(pill);
    const panel = screen.getByRole("dialog", { name: "Turn settings" });
    expect(within(panel).queryByRole("button", { name: /^Effort: / })).not.toBeInTheDocument();
  });
});

describe("the turn carries the selection", () => {
  test("POST /v1/turns names the model and depth the composer showed", async () => {
    useTerminusStore.setState({
      sessions: [session({ default_model: "claude-haiku-4-6", default_reasoning_effort: "low" })],
      selectedSessionId: "session-1",
      selectedTaskId: "task-1",
      taskById: { "task-1": task() },
      tasksBySession: { "session-1": [task()] },
      eventsByTask: {},
      queuedSteerByTask: {},
      draftsByTask: {},
      healthReady: true,
      healthStatus: "ready",
    });
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "go");
    await user.click(screen.getByRole("button", { name: /^Send/ }));

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "task-1", user_input: "go", model: "claude-haiku-4-6" }),
      expect.anything(),
    ));
    // Haiku does not reason, so no depth is claimed for it.
    expect(vi.mocked(api.startTurn).mock.calls[0]![0]).not.toHaveProperty("reasoning_effort");
  });
});

/**
 * A model the deployment will not run.
 *
 * The control plane answers 409 `MODEL_NOT_ADMITTED` and *includes the list it
 * would accept*. Showing only "model not admitted" leaves the operator
 * guessing at a set the server is already holding.
 */
describe("a rejected model", () => {
  function rejection(details: Record<string, unknown>): TerminusApiError {
    return new TerminusApiError(409, "model not admitted", {
      code: "MODEL_NOT_ADMITTED",
      message: "model not admitted",
      retryable: false,
      category: "conflict",
      details,
    });
  }

  test("names what was asked for and what is available", () => {
    const message = describeTurnFailure(rejection({
      requested_model: "gpt-9",
      deployment: "local",
      discovered_models: ["claude-sonnet-4-6", "claude-haiku-4-6"],
    }));

    expect(message).toContain("gpt-9 is not admitted on local.");
    expect(message).toContain("claude-sonnet-4-6, claude-haiku-4-6");
  });

  test("says so plainly when the deployment admits nothing at all", () => {
    expect(describeTurnFailure(rejection({ requested_model: "gpt-9", discovered_models: [] })))
      .toContain("No model has been admitted for this deployment.");
  });

  test("bounds a long list rather than pasting a hundred ids into the composer", () => {
    const message = describeTurnFailure(rejection({
      requested_model: "gpt-9",
      discovered_models: Array.from({ length: 20 }, (_, index) => `model-${index}`),
    }));

    expect(message).toContain("model-7");
    expect(message).not.toContain("model-8");
    expect(message).toContain("and 12 more");
  });

  test("leaves every other failure in the words the control plane used", () => {
    expect(describeTurnFailure(new Error("provider unavailable"))).toBe("provider unavailable");
  });

  test("reaches the composer as the visible error", async () => {
    useTerminusStore.setState({
      sessions: [session()],
      selectedSessionId: "session-1",
      selectedTaskId: "task-1",
      taskById: { "task-1": task({ status: "ACTIVE" }) },
      tasksBySession: { "session-1": [task({ status: "ACTIVE" })] },
      eventsByTask: {},
      queuedSteerByTask: {},
      draftsByTask: {},
      sessionDraftsByTask: {},
      healthReady: true,
      healthStatus: "ready",
    });
    vi.mocked(api.startTurn).mockRejectedValueOnce(rejection({
      requested_model: "gpt-9",
      discovered_models: ["claude-sonnet-4-6"],
    }));
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(screen.getByRole("textbox", { name: "Message composer" }), "go");
    await user.click(screen.getByRole("button", { name: /^Send/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("claude-sonnet-4-6");
  });
});
