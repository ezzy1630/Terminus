/**
 * Connected provider accounts.
 *
 * Terminus imports the credentials the operator's own tools already hold, with
 * no prompt. That is a defensible default only if the app is completely open
 * about it afterwards, so these tests pin the properties that make it so:
 *
 *   - every discovered account is *listed*, including the ones Terminus cannot
 *     route to, with the reason it cannot;
 *   - Disconnect asks first and then deletes with the revision the row was
 *     drawn from, so a concurrent re-import cannot be clobbered silently;
 *   - Set default moves the marker and re-reads the server's list;
 *   - the hints name only what discovery actually reported about the machine;
 *   - the first-launch notice states the import once, per set of accounts.
 *
 * No credential material appears anywhere in this file, and every id is
 * obviously fake.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ProviderAccountSettings } from "../src/components/ProviderAccountSettings";
import {
  ProviderAccountsNotice,
  describeImport,
  noticeKeyFor,
} from "../src/components/ProviderAccountsNotice";
import { discoveryHints } from "../src/hooks/use-provider-accounts";
import { api, TerminusApiError } from "../src/lib/api";
import type { ProviderAccount, ProviderAccountDiscovery, ProviderAccountsResponse } from "../src/types";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      listProviderAccounts: vi.fn(),
      discoverProviderAccounts: vi.fn(),
      disconnectProviderAccount: vi.fn(async () => undefined),
      setDefaultProviderAccount: vi.fn(async () => undefined),
    },
  };
});

const now = new Date().toISOString();

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "mock-account-baseten",
    source: "opencode:baseten",
    display_name: "Baseten",
    vendor_id: "baseten",
    auth_kind: "api",
    status: "connected",
    status_detail: "",
    billing: "paid",
    host: "inference.baseten.co",
    protocol: "chat_completions",
    is_default: false,
    model_count: 12,
    metadata: {},
    discovered_at: now,
    last_verified_at: now,
    expires_at: null,
    revision: 3,
    ...overrides,
  };
}

function discovery(overrides: Partial<ProviderAccountDiscovery> = {}): ProviderAccountDiscovery {
  return { last_run_at: now, installed_tools: ["codex", "opencode"], warnings: [], ...overrides };
}

function response(
  accounts: readonly ProviderAccount[],
  overrides: Partial<ProviderAccountsResponse> = {},
): ProviderAccountsResponse {
  return { accounts: [...accounts], discovery: discovery(), supported: true, ...overrides };
}

function installList(...pages: ProviderAccountsResponse[]): void {
  const mock = vi.mocked(api.listProviderAccounts);
  mock.mockReset();
  for (const page of pages) mock.mockResolvedValueOnce(page);
  mock.mockResolvedValue(pages[pages.length - 1] ?? response([]));
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  window.localStorage.clear();
  delete window.__terminusProviderAccounts;
});

afterEach(cleanup);

describe("the connected accounts section", () => {
  test("states where each credential came from, its status, and what it reaches", async () => {
    installList(response([
      account({
        id: "mock-account-chatgpt",
        source: "codex-chatgpt",
        display_name: "ChatGPT",
        auth_kind: "chatgpt",
        billing: "subscription",
        is_default: true,
        model_count: 4,
        expires_at: "2026-09-07T00:00:00Z",
      }),
      account(),
    ]));
    render(<ProviderAccountSettings />);

    const chatgpt = await screen.findByTestId("provider-account-mock-account-chatgpt");
    expect(chatgpt).toHaveTextContent("ChatGPT");
    expect(chatgpt).toHaveTextContent("Codex CLI login");
    expect(chatgpt).toHaveTextContent("Connected");
    expect(chatgpt).toHaveTextContent("Default");
    expect(chatgpt).toHaveTextContent("4 models");
    // Rendered in the reader's own locale and zone, so the assertion is on the
    // clause rather than on one spelling of the date.
    expect(chatgpt).toHaveTextContent(/Expires \w+ ?\d/);

    const baseten = screen.getByTestId("provider-account-mock-account-baseten");
    expect(baseten).toHaveTextContent("OpenCode auth store");
    // The default marker belongs to exactly one row.
    expect(within(baseten).queryByText("Default")).not.toBeInTheDocument();
  });

  test("lists an account Terminus cannot route to, with the reason", async () => {
    installList(response([
      account({
        id: "mock-account-cloudflare",
        source: "opencode:cloudflare-workers-ai",
        display_name: "Cloudflare Workers AI",
        status: "unsupported",
        status_detail: "This build has no transport for that provider's SDK yet.",
      }),
    ]));
    render(<ProviderAccountSettings />);

    const row = await screen.findByTestId("provider-account-mock-account-cloudflare");
    expect(row).toHaveTextContent("Unsupported");
    expect(row).toHaveTextContent("This build has no transport for that provider's SDK yet.");
    // Making an unroutable account the default is a button whose only possible
    // outcome is a 409, so it is not offered.
    expect(within(row).queryByRole("button", { name: /^Set /})).not.toBeInTheDocument();
  });

  test("says plainly when the control plane does not report accounts at all", async () => {
    installList(response([], { supported: false }));
    render(<ProviderAccountSettings />);

    expect(await screen.findByText(/does not report connected accounts/)).toBeInTheDocument();
  });
});

describe("disconnecting an account", () => {
  test("asks first, then deletes with the revision the row was drawn from", async () => {
    installList(response([account()]), response([]));
    const user = userEvent.setup();
    render(<ProviderAccountSettings />);

    const row = await screen.findByTestId("provider-account-mock-account-baseten");
    await user.click(within(row).getByRole("button", { name: "Disconnect Baseten" }));
    // The credential is deleted from the keyring and this app cannot undo it,
    // so the first click only arms the action.
    expect(api.disconnectProviderAccount).not.toHaveBeenCalled();
    expect(within(row).getByText("Delete this credential?")).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "Confirm disconnect Baseten" }));

    await waitFor(() => expect(api.disconnectProviderAccount).toHaveBeenCalledWith(
      "mock-account-baseten",
      3,
      expect.objectContaining({ idempotencyKey: expect.stringContaining("provider-account-disconnect") }),
    ));
    await waitFor(() => expect(screen.queryByTestId("provider-account-mock-account-baseten")).not.toBeInTheDocument());
  });

  test("cancelling disarms without calling the control plane", async () => {
    installList(response([account()]));
    const user = userEvent.setup();
    render(<ProviderAccountSettings />);

    const row = await screen.findByTestId("provider-account-mock-account-baseten");
    await user.click(within(row).getByRole("button", { name: "Disconnect Baseten" }));
    await user.click(within(row).getByRole("button", { name: "Cancel" }));

    expect(api.disconnectProviderAccount).not.toHaveBeenCalled();
    expect(within(row).getByRole("button", { name: "Disconnect Baseten" })).toBeInTheDocument();
  });

  test("puts the row back and says why when the revision no longer matches", async () => {
    installList(response([account()]));
    vi.mocked(api.disconnectProviderAccount).mockRejectedValueOnce(new TerminusApiError(
      409,
      "That account changed while this window was open.",
      null,
    ));
    const user = userEvent.setup();
    render(<ProviderAccountSettings />);

    const row = await screen.findByTestId("provider-account-mock-account-baseten");
    await user.click(within(row).getByRole("button", { name: "Disconnect Baseten" }));
    await user.click(within(row).getByRole("button", { name: "Confirm disconnect Baseten" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That account changed while this window was open.");
    // An optimistic removal that stuck would leave the settings pane claiming
    // a credential is gone when the control plane still holds it.
    expect(screen.getByTestId("provider-account-mock-account-baseten")).toBeInTheDocument();
  });
});

describe("choosing the default account", () => {
  test("sends the revision and re-reads the server's list", async () => {
    installList(
      response([account(), account({ id: "mock-account-zen", source: "zen", display_name: "OpenCode Zen", revision: 5 })]),
      response([
        account({ is_default: true }),
        account({ id: "mock-account-zen", source: "zen", display_name: "OpenCode Zen", revision: 5 }),
      ]),
    );
    const user = userEvent.setup();
    render(<ProviderAccountSettings />);

    const row = await screen.findByTestId("provider-account-mock-account-baseten");
    await user.click(within(row).getByRole("button", { name: "Set Baseten as the default account" }));

    await waitFor(() => expect(api.setDefaultProviderAccount).toHaveBeenCalledWith(
      "mock-account-baseten",
      3,
      expect.objectContaining({ idempotencyKey: expect.stringContaining("provider-account-default") }),
    ));
    await waitFor(() => expect(
      screen.getByTestId("provider-account-mock-account-baseten"),
    ).toHaveTextContent("Default"));
    // Set default is gone from the row that now holds it.
    expect(screen.queryByRole("button", { name: "Set Baseten as the default account" })).not.toBeInTheDocument();
  });
});

describe("detecting again", () => {
  test("sweeps the credential stores and shows what came back", async () => {
    installList(response([]));
    vi.mocked(api.discoverProviderAccounts).mockResolvedValueOnce({
      ...response([account({ id: "mock-account-cerebras", source: "opencode:cerebras", display_name: "Cerebras" })]),
      imported: ["mock-account-cerebras"],
    });
    const user = userEvent.setup();
    render(<ProviderAccountSettings />);

    await screen.findByText(/No credentials were found/);
    await user.click(screen.getByRole("button", { name: /Detect again/ }));

    await waitFor(() => expect(api.discoverProviderAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: expect.stringContaining("provider-accounts-discover") }),
    ));
    expect(await screen.findByTestId("provider-account-mock-account-cerebras")).toHaveTextContent("Cerebras");
  });

  test("reports a sweep that failed without emptying the list", async () => {
    installList(response([account()]));
    vi.mocked(api.discoverProviderAccounts).mockRejectedValueOnce(new Error("the auth store is unreadable"));
    const user = userEvent.setup();
    render(<ProviderAccountSettings />);

    await screen.findByTestId("provider-account-mock-account-baseten");
    await user.click(screen.getByRole("button", { name: /Detect again/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("the auth store is unreadable");
    expect(screen.getByTestId("provider-account-mock-account-baseten")).toBeInTheDocument();
  });

  test("shows a store-level warning verbatim", async () => {
    installList(response([], {
      discovery: discovery({ warnings: ["auth.json is readable by other users; it was skipped"] }),
    }));
    render(<ProviderAccountSettings />);

    expect(await screen.findByText("auth.json is readable by other users; it was skipped")).toBeInTheDocument();
  });
});

/**
 * Hints answer one question — "why do I have fewer accounts than I expected?"
 * — and answer it only from what discovery reported. Nothing here guesses at
 * what is installed.
 */
describe("install and sign-in hints", () => {
  test("names a missing CLI rather than a missing account", () => {
    expect(discoveryHints(discovery({ installed_tools: [] }), []))
      .toEqual([
        "Codex CLI not installed — no ChatGPT login was found to import.",
        "OpenCode not installed — no API keys were found to import.",
      ]);
  });

  test("tells an operator with the CLI installed how to sign in", () => {
    expect(discoveryHints(discovery(), [])).toEqual([
      "Codex CLI is installed but not signed in — run `codex` to sign in.",
      "OpenCode is installed but its auth store holds no usable key — run `opencode auth login`.",
    ]);
  });

  test("says nothing once both stores have produced an account", () => {
    expect(discoveryHints(discovery(), [
      account({ id: "a", source: "codex-chatgpt" }),
      account({ id: "b", source: "opencode:baseten" }),
    ])).toEqual([]);
  });

  test("renders the hints in the section", async () => {
    installList(response([], { discovery: discovery({ installed_tools: ["opencode"] }) }));
    render(<ProviderAccountSettings />);

    expect(await screen.findByText(/Codex CLI not installed/)).toBeInTheDocument();
  });
});

describe("the first-launch notice", () => {
  test("gives the total, then what each store contributed", () => {
    expect(describeImport([
      account({ id: "a", source: "opencode:baseten" }),
      account({ id: "b", source: "opencode:cerebras" }),
      account({ id: "c", source: "codex-chatgpt" }),
    ])).toBe("Connected 3 providers — 2 from OpenCode and your ChatGPT login.");
  });

  /**
   * The shape the owner's machine actually produces. Written as "Connected 8
   * providers from OpenCode, …" the total attached itself to the first store
   * named, so six keys plus two logins read as eight keys.
   */
  test("does not let the total attach itself to the first store named", () => {
    expect(describeImport([
      ...Array.from({ length: 6 }, (_, index) => account({ id: `key-${index}`, source: `opencode:vendor-${index}` })),
      account({ id: "chatgpt", source: "codex-chatgpt" }),
      account({ id: "zen", source: "zen" }),
      // An unsupported credential is listed in Settings but was not connected.
      account({ id: "unsupported", source: "opencode:vendor-x", status: "unsupported" }),
    ])).toBe("Connected 8 providers — 6 from OpenCode, your ChatGPT login and OpenCode Zen.");
  });

  test("does not repeat the figure when one store accounts for everything", () => {
    expect(describeImport([
      account({ id: "a", source: "opencode:baseten" }),
      account({ id: "b", source: "opencode:cerebras" }),
    ])).toBe("Connected 2 providers from OpenCode.");
  });

  test("does not count a credential that cannot take a turn", () => {
    expect(describeImport([
      account({ id: "a", source: "opencode:baseten" }),
      account({ id: "b", source: "codex-chatgpt", status: "expired" }),
    ])).toBe("Connected 1 provider from OpenCode.");
  });

  test("says nothing at all when nothing is connected", () => {
    expect(describeImport([account({ status: "unsupported" })])).toBeNull();
  });

  test("is keyed on the set of accounts, not their order", () => {
    expect(noticeKeyFor([account({ id: "b" }), account({ id: "a" })]))
      .toBe(noticeKeyFor([account({ id: "a" }), account({ id: "b" })]));
  });

  test("states the import once and stays dismissed for that set", async () => {
    installList(response([
      account({ id: "mock-a", source: "opencode:baseten" }),
      account({ id: "mock-b", source: "codex-chatgpt" }),
    ]));
    const user = userEvent.setup();
    const view = render(<ProviderAccountsNotice />);

    expect(await screen.findByTestId("provider-accounts-notice"))
      .toHaveTextContent("Connected 2 providers — 1 from OpenCode and your ChatGPT login.");

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("provider-accounts-notice")).not.toBeInTheDocument();

    // A second launch with the same accounts says nothing.
    view.unmount();
    render(<ProviderAccountsNotice />);
    await waitFor(() => expect(api.listProviderAccounts).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("provider-accounts-notice")).not.toBeInTheDocument();
  });

  test("speaks up again when a new account appears", async () => {
    installList(response([account({ id: "mock-a", source: "opencode:baseten" })]));
    const user = userEvent.setup();
    const view = render(<ProviderAccountsNotice />);

    await screen.findByTestId("provider-accounts-notice");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    view.unmount();

    installList(response([
      account({ id: "mock-a", source: "opencode:baseten" }),
      account({ id: "mock-b", source: "codex-chatgpt" }),
    ]));
    render(<ProviderAccountsNotice />);

    // A dismissal is not a permanent silence: signing in to something new is a
    // new fact, and it says itself once.
    expect(await screen.findByTestId("provider-accounts-notice"))
      .toHaveTextContent("Connected 2 providers");
  });

  test("opens the accounts settings and stops announcing", async () => {
    installList(response([account({ id: "mock-a", source: "opencode:baseten" })]));
    const opened = vi.fn();
    const listener = (event: Event): void => {
      opened((event as CustomEvent<{ category?: string }>).detail?.category);
    };
    window.addEventListener("terminus:open-settings", listener);
    const user = userEvent.setup();
    render(<ProviderAccountsNotice />);

    await screen.findByTestId("provider-accounts-notice");
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    window.removeEventListener("terminus:open-settings", listener);

    expect(opened).toHaveBeenCalledWith("agents");
    expect(screen.queryByTestId("provider-accounts-notice")).not.toBeInTheDocument();
  });

  test("renders nothing while the list is still being read", () => {
    vi.mocked(api.listProviderAccounts).mockReset();
    vi.mocked(api.listProviderAccounts).mockReturnValue(new Promise(() => undefined));
    render(<ProviderAccountsNotice />);

    expect(screen.queryByTestId("provider-accounts-notice")).not.toBeInTheDocument();
  });
});
