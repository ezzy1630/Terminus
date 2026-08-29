/**
 * The model the picker shows is the model the turn runs on.
 *
 * Before this the picker wrote a global gateway configuration row and
 * `POST /v1/turns` carried no model at all: every run went to whatever the
 * control plane happened to default to, and choosing a model for one project
 * silently changed it for all of them. The choice now belongs to the session
 * and travels with the turn.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Composer, describeTurnFailure } from "../src/components/Composer";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { api, TerminusApiError } from "../src/lib/api";
import { EMPTY_INVENTORY, useModelSelection } from "../src/lib/models";
import type { ModelInventory, ModelOption, Provider } from "../src/lib/models";
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

function account(overrides: Partial<Provider> = {}): Provider {
  return { id: "anthropic", label: "Anthropic", mark: "AN", available: true, ...overrides };
}

function inventory(models: readonly ModelOption[], providers: readonly Provider[] = []): ModelInventory {
  return { ...EMPTY_INVENTORY, models, providers, status: "ready" };
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

    // One pick, one routing decision: the model and the depth it will actually
    // run at. No account is named because this inventory reported none.
    expect(persist).toHaveBeenCalledWith("session-1", {
      default_model: "claude-haiku-4-6",
      default_reasoning_effort: "medium",
    });
    await waitFor(() => expect(result.current.selected?.id).toBe("haiku"));
    expect(result.current.persistError).toBeNull();
  });

  /**
   * A model id is not a route.
   *
   * Two connected accounts can offer the same model through different
   * credentials and different bills, so the account travels with the choice —
   * into the session default, and onto the turn.
   */
  test("names the account the chosen model belongs to", () => {
    const persist = vi.fn(async () => undefined);
    const accounts = [
      account({ id: "acct-sub", label: "ChatGPT", billing: "subscription", isDefault: true }),
      account({ id: "acct-key", label: "Baseten" }),
    ];
    const models = [
      model({ id: "shared", provider: "acct-sub", slug: "shared-model" }),
      model({ id: "shared-2", provider: "acct-key", slug: "shared-model" }),
    ];
    const { result } = renderHook(() => useModelSelection(
      inventory(models, accounts),
      { id: "session-1" },
      persist,
    ));

    act(() => result.current.select("shared-2"));

    expect(persist).toHaveBeenCalledWith("session-1", {
      default_model: "shared-model",
      default_provider_account_id: "acct-key",
      default_reasoning_effort: "medium",
    });
    expect(result.current.account?.label).toBe("Baseten");
  });

  test("resolves an ambiguous stored model id against the stored account", () => {
    const accounts = [account({ id: "acct-a", label: "Account A" }), account({ id: "acct-b", label: "Account B" })];
    const models = [
      model({ id: "a", provider: "acct-a", slug: "shared-model" }),
      model({ id: "b", provider: "acct-b", slug: "shared-model" }),
    ];
    const { result } = renderHook(() => useModelSelection(
      inventory(models, accounts),
      { id: "session-1", default_model: "shared-model", default_provider_account_id: "acct-b" },
    ));

    expect(result.current.selected?.id).toBe("b");
    expect(result.current.account?.id).toBe("acct-b");
  });

  test("offers only the depths the model reported, and clamps a deeper preference down", () => {
    const shallow = model({ id: "shallow", efforts: ["low", "medium"] });
    const { result } = renderHook(() => useModelSelection(
      inventory([shallow]),
      { id: "session-1", default_reasoning_effort: "max" },
    ));

    // Sending Max to a model whose deepest level is Medium is a value the
    // provider would reject or silently reinterpret.
    expect(result.current.effort).toBe("medium");
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

    // The account is written with the model: the composer showed one, so the
    // session must not be left naming a model without saying whose it is.
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith(
      "session-1",
      { default_model: "claude-haiku-4-6", default_provider_account_id: "anthropic" },
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
    const pill = await screen.findByRole("button", { name: /^Change model and effort · Haiku on Anthropic$/ });
    await user.click(pill);
    const panel = screen.getByRole("dialog", { name: "Turn settings" });
    expect(within(panel).queryByRole("button", { name: /^Effort: / })).not.toBeInTheDocument();
  });
});

/**
 * A popover that outlives the surface it sits on.
 *
 * Clicking a control that opens a modal used to leave this popover drawn,
 * undimmed, on top of the modal's scrim: the dismissal listener was one
 * bubble-phase pointerdown, and the control that opened the modal got there
 * first. Dismissal now happens on anything that means "this is no longer the
 * surface in use".
 */
describe("dismissing the turn-routing popover", () => {
  function installOpenPicker(): void {
    useTerminusStore.setState({
      sessions: [session({ default_model: "claude-sonnet-4-6" })],
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

  async function open(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByRole("button", { name: /^Change model and effort/ }));
    expect(screen.getByRole("dialog", { name: "Turn settings" })).toBeInTheDocument();
  }

  test("closes on a pointerdown anywhere outside it", async () => {
    installOpenPicker();
    const user = userEvent.setup();
    render(<><div data-testid="elsewhere">elsewhere</div><Composer /></>);
    await open(user);

    fireEvent.pointerDown(screen.getByTestId("elsewhere"));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn settings" })).not.toBeInTheDocument());
  });

  test("closes even when the control that was clicked stops the event", async () => {
    installOpenPicker();
    const user = userEvent.setup();
    render(<><div data-testid="elsewhere">elsewhere</div><Composer /></>);
    await open(user);

    // A control that opens a modal typically stops propagation on its own
    // pointer event; the capture-phase listener still sees it.
    const greedy = screen.getByTestId("elsewhere");
    greedy.addEventListener("pointerdown", (event) => event.stopPropagation());
    fireEvent.pointerDown(greedy);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn settings" })).not.toBeInTheDocument());
  });

  test("closes when an overlay opens over it", async () => {
    installOpenPicker();
    const user = userEvent.setup();
    render(<Composer />);
    await open(user);

    window.dispatchEvent(new CustomEvent("terminus:open-settings", { detail: { category: "agents" } }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn settings" })).not.toBeInTheDocument());
  });

  test("closes when the window loses focus", async () => {
    installOpenPicker();
    const user = userEvent.setup();
    render(<Composer />);
    await open(user);

    fireEvent.blur(window);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn settings" })).not.toBeInTheDocument());
  });

  test("Escape backs out one pane, then closes, wherever focus is", async () => {
    installOpenPicker();
    const user = userEvent.setup();
    render(<Composer />);
    await open(user);
    const panel = screen.getByRole("dialog", { name: "Turn settings" });
    await user.click(within(panel).getByRole("button", { name: /^Model: / }));
    expect(within(panel).getByRole("textbox", { name: "Search models" })).toBeInTheDocument();

    // Focus deliberately outside the popover: a pointer-driven open never
    // moved it there in the first place.
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(
      within(screen.getByRole("dialog", { name: "Turn settings" })).queryByRole("textbox", { name: "Search models" }),
    ).not.toBeInTheDocument());

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn settings" })).not.toBeInTheDocument());
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
 * One group per connected account.
 *
 * Credentials, not vendors, are what a turn routes to: the same vendor can be
 * reachable through a subscription and through a metered key, and those are
 * two different bills. The list therefore states, per group, how its turns are
 * paid for and whether it is the account everything falls back to — and lists
 * accounts Terminus *cannot* reach with the reason rather than hiding them.
 */
describe("the model list is grouped by connected account", () => {
  const MULTI_ACCOUNT: { providers: unknown; models: unknown; error: unknown } = {
    error: null,
    providers: [
      { id: "acct-chatgpt", label: "ChatGPT", source: "codex-chatgpt", billing: "subscription", is_default: true, available: true },
      { id: "acct-baseten", label: "Baseten", source: "opencode:baseten", billing: "paid", available: true },
      {
        id: "acct-cloudflare",
        label: "Cloudflare Workers AI",
        source: "opencode:cloudflare-workers-ai",
        billing: "unknown",
        available: false,
        unavailable_reason: "This build has no transport for that provider's SDK yet.",
      },
    ],
    models: [
      {
        id: "sol", provider: "acct-chatgpt", label: "GPT-Sol", slug: "gpt-sol", reasoning: true,
        context_tokens: 400_000, reasoning_efforts: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "medium",
      },
      {
        id: "sol-mini", provider: "acct-chatgpt", label: "GPT-Sol Mini", slug: "gpt-sol-mini", reasoning: true,
        context_tokens: 272_000, reasoning_efforts: ["minimal", "low", "medium"], default_reasoning_effort: "low",
      },
      { id: "heron", provider: "acct-baseten", label: "Heron 70B", slug: "heron-70b", reasoning: false, context_tokens: 128_000, input_cost_micros: 3_000_000 },
      { id: "edge", provider: "acct-cloudflare", label: "Edge Small", slug: "edge-small", reasoning: false, context_tokens: 32_768 },
    ],
  };

  function installMultiAccount(overrides: Partial<Session> = {}): void {
    vi.mocked(api.listProviderModels).mockResolvedValueOnce(MULTI_ACCOUNT);
    useTerminusStore.setState({
      sessions: [session({ default_model: "gpt-sol", default_provider_account_id: "acct-chatgpt", ...overrides })],
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

  async function openModelPane(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(await screen.findByRole("button", { name: /^Change model and effort/ }));
    const panel = screen.getByRole("dialog", { name: "Turn settings" });
    await user.click(within(panel).getByRole("button", { name: /^Model: / }));
    return panel;
  }

  test("labels each account with how its turns are paid for", async () => {
    installMultiAccount();
    const user = userEvent.setup();
    render(<Composer />);

    const panel = await openModelPane(user);
    const subscription = await within(panel).findByRole("region", { name: "ChatGPT" });
    expect(subscription).toHaveTextContent("Subscription");
    // Exactly one account is the fallback, and it says so.
    expect(subscription).toHaveTextContent("Default");
    // A metered account prices per model, so the group carries no figure that
    // would have to be invented for a list of differently-priced models.
    const metered = within(panel).getByRole("region", { name: "Baseten" });
    expect(metered).not.toHaveTextContent("Subscription");
    expect(metered).toHaveTextContent("$3/M");
  });

  test("lists an account Terminus cannot reach, with the reason, and will not pick from it", async () => {
    installMultiAccount();
    const user = userEvent.setup();
    render(<Composer />);

    const panel = await openModelPane(user);
    const unreachable = await within(panel).findByRole("region", { name: "Cloudflare Workers AI" });
    expect(unreachable).toHaveTextContent("This build has no transport for that provider's SDK yet.");
    expect(within(unreachable).getByRole("button", { name: /^Edge Small/ })).toBeDisabled();
  });

  test("offers only the reasoning depths the chosen model reported", async () => {
    installMultiAccount({ default_model: "gpt-sol-mini" });
    const user = userEvent.setup();
    render(<Composer />);

    await user.click(await screen.findByRole("button", { name: /^Change model and effort/ }));
    const panel = screen.getByRole("dialog", { name: "Turn settings" });
    await user.click(within(panel).getByRole("button", { name: /^Effort: / }));

    // `minimal` and `low` are the same depth in this vocabulary, so the pane
    // shows Low once and stops at the deepest level the model named.
    expect(await within(panel).findByRole("button", { name: /^Low/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /^Medium/ })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^High/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Max/ })).not.toBeInTheDocument();
  });

  test("the turn names the account, not just the model", async () => {
    installMultiAccount();
    const user = userEvent.setup();
    render(<Composer />);

    await user.type(await screen.findByRole("textbox", { name: "Message composer" }), "go");
    await user.click(screen.getByRole("button", { name: /^Send/ }));

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-sol",
        provider_account_id: "acct-chatgpt",
        reasoning_effort: "medium",
      }),
      expect.anything(),
    ));
  });

  test("choosing from another account rewrites all three session defaults", async () => {
    installMultiAccount();
    const user = userEvent.setup();
    render(<Composer />);

    const panel = await openModelPane(user);
    await user.click(await within(panel).findByRole("button", { name: "Heron 70B, Baseten" }));

    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith(
      "session-1",
      // Heron does not reason, so no depth is claimed for it — but the account
      // moves with the model, which is the whole point of the write.
      { default_model: "heron-70b", default_provider_account_id: "acct-baseten" },
      expect.anything(),
    ));
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
