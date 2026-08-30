/**
 * Terminus Desktop — Connected provider accounts.
 *
 * Terminus does not ask an operator to paste a key. The credentials it can use
 * are the ones their own tools already hold — the OpenCode auth store, the
 * Codex/ChatGPT login — and the control plane imports each usable one into the
 * OS keyring at startup. This hook reads the resulting list and offers the two
 * actions that exist for a discovered credential: make it the default, or
 * disconnect it.
 *
 * Three properties this file exists to hold:
 *
 *   - **Nothing is invented.** A control plane that does not implement the
 *     route reports `supported: false` and the UI says so, rather than
 *     rendering an empty list that reads as "you have no accounts".
 *   - **Mutations are guarded.** Discovery can re-import an account between a
 *     render and a click, so Set default and Disconnect both carry the
 *     revision they were drawn from and surface the 409 rather than retrying.
 *   - **The list is authoritative.** Every mutation applies optimistically for
 *     the click's own latency, then the server's list replaces it. Reverting
 *     on failure keeps the row honest about what the control plane holds.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, createIdempotencyKey } from "../lib/api";
import type {
  ProviderAccount,
  ProviderAccountDiscovery,
  ProviderAccountsResponse,
} from "../types";

const EMPTY_DISCOVERY: ProviderAccountDiscovery = {
  last_run_at: null,
  installed_tools: [],
  warnings: [],
};

const CODEX_SUBSCRIPTION_UNAVAILABLE =
  "A ChatGPT/Codex subscription login was detected, but Terminus-native routing is unavailable. Use an API provider or a future official Codex adapter.";

/** Set by the dev mock so design review has rows to look at. */
declare global {
  interface Window {
    __terminusProviderAccounts?: ProviderAccountsResponse;
  }
}

export interface ProviderAccountsState {
  accounts: readonly ProviderAccount[];
  discovery: ProviderAccountDiscovery;
  status: "loading" | "ready" | "unavailable";
  /** Why the list could not be read, or why a mutation did not take. */
  error: string | null;
  /** False when this control plane has no provider-accounts route at all. */
  supported: boolean;
  /** The account a mutation is in flight for, so its row can say so. */
  busyId: string | null;
  /** A credential-store sweep is running. */
  detecting: boolean;
  /**
   * What the last sweep *did*, or null if none has run in this window. A
   * Detect button that found nothing has to say so; otherwise it reads as a
   * control that does nothing.
   */
  lastSweep: { imported: readonly string[] } | null;
  detect: () => Promise<void>;
  setDefault: (account: ProviderAccount) => Promise<void>;
  disconnect: (account: ProviderAccount) => Promise<void>;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * A Codex CLI login is an observed local credential, not a supported
 * Terminus-native model route. Keep it visible so the operator understands
 * what was found, but do not present the current raw-token bridge as usable.
 */
function normalizeAccounts(accounts: readonly ProviderAccount[]): readonly ProviderAccount[] {
  return accounts.map((account) => {
    if (account.source !== "codex-chatgpt" || account.status !== "connected") return account;
    return {
      ...account,
      status: "unsupported",
      status_detail: CODEX_SUBSCRIPTION_UNAVAILABLE,
      is_default: false,
    };
  });
}

export function useProviderAccounts(): ProviderAccountsState {
  const [state, setState] = useState<{
    accounts: readonly ProviderAccount[];
    discovery: ProviderAccountDiscovery;
    status: ProviderAccountsState["status"];
    error: string | null;
    supported: boolean;
  }>({ accounts: [], discovery: EMPTY_DISCOVERY, status: "loading", error: null, supported: true });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [lastSweep, setLastSweep] = useState<{ imported: readonly string[] } | null>(null);
  // Mutations resolve after the component may have unmounted (Settings is a
  // dialog); writing state then is a React warning and a leak.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const response = window.__terminusProviderAccounts
          ?? await api.listProviderAccounts(controller.signal);
        if (controller.signal.aborted) return;
        setState({
          accounts: normalizeAccounts(response.accounts),
          discovery: response.discovery,
          status: response.supported ? "ready" : "unavailable",
          // Not an error: a control plane without the route has not failed at
          // anything. The section states the capability once, in its empty
          // text, rather than also raising an alert about it.
          error: null,
          supported: response.supported,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          accounts: [],
          discovery: EMPTY_DISCOVERY,
          status: "unavailable",
          error: messageFor(error, "Connected accounts could not be read."),
          supported: true,
        });
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  /** Replace the list with the server's own, after any mutation. */
  const reload = useCallback(async (): Promise<void> => {
    const response = await api.listProviderAccounts(null);
    if (!mounted.current) return;
    setState({
      accounts: normalizeAccounts(response.accounts),
      discovery: response.discovery,
      status: response.supported ? "ready" : "unavailable",
      error: null,
      supported: response.supported,
    });
  }, []);

  const detect = useCallback(async (): Promise<void> => {
    setDetecting(true);
    setState((previous) => ({ ...previous, error: null }));
    try {
      const response = await api.discoverProviderAccounts({
        idempotencyKey: createIdempotencyKey("provider-accounts-discover"),
      });
      if (!mounted.current) return;
      setLastSweep({ imported: response.imported });
      setState({
        accounts: normalizeAccounts(response.accounts),
        discovery: response.discovery,
        status: "ready",
        error: null,
        supported: true,
      });
    } catch (error) {
      if (!mounted.current) return;
      setState((previous) => ({
        ...previous,
        error: messageFor(error, "The credential stores could not be read."),
      }));
    } finally {
      if (mounted.current) setDetecting(false);
    }
  }, []);

  const setDefault = useCallback(async (account: ProviderAccount): Promise<void> => {
    setBusyId(account.id);
    const previous = state.accounts;
    // Exactly one account is the default, so the optimistic write has to clear
    // the old one as well — two rows claiming it is worse than a moment's lag.
    setState((current) => ({
      ...current,
      error: null,
      accounts: current.accounts.map((row) => ({ ...row, is_default: row.id === account.id })),
    }));
    try {
      await api.setDefaultProviderAccount(account.id, account.revision, {
        idempotencyKey: createIdempotencyKey(`provider-account-default:${account.id}`),
      });
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      setState((current) => ({
        ...current,
        accounts: previous,
        error: messageFor(error, "That account could not be made the default."),
      }));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }, [reload, state.accounts]);

  const disconnect = useCallback(async (account: ProviderAccount): Promise<void> => {
    setBusyId(account.id);
    const previous = state.accounts;
    setState((current) => ({
      ...current,
      error: null,
      accounts: current.accounts.filter((row) => row.id !== account.id),
    }));
    try {
      await api.disconnectProviderAccount(account.id, account.revision, {
        idempotencyKey: createIdempotencyKey(`provider-account-disconnect:${account.id}`),
      });
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      setState((current) => ({
        ...current,
        accounts: previous,
        error: messageFor(error, "That account could not be disconnected."),
      }));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }, [reload, state.accounts]);

  return useMemo(() => ({
    ...state,
    busyId,
    detecting,
    lastSweep,
    detect,
    setDefault,
    disconnect,
  }), [busyId, detect, detecting, disconnect, lastSweep, setDefault, state]);
}

// ────────────────────────── Presentation helpers ────────────────────────────

/**
 * Where the credential came from, in the operator's words.
 *
 * The `source` id is the control plane's (`opencode:baseten`); a row that
 * showed it raw would be asking the reader to know the naming scheme.
 */
export function accountSourceLabel(source: string): string {
  if (source === "codex-chatgpt") return "Codex CLI login (subscription routing unavailable)";
  if (source === "zen") return "OpenCode Zen";
  if (source.startsWith("opencode:")) return "OpenCode auth store";
  return source;
}

export const ACCOUNT_STATUS_LABELS: Readonly<Record<ProviderAccount["status"], string>> = {
  connected: "Connected",
  expired: "Expired",
  error: "Error",
  unsupported: "Unsupported",
  disconnected: "Disconnected",
};

/**
 * What to tell an operator who has fewer accounts than they expected.
 *
 * Only conditions the discovery report actually states are named. "Codex CLI
 * not installed" is a fact; "you should install Codex" is advice this app has
 * no standing to give, so the hint stops at the fact and the one command that
 * changes it.
 */
export function discoveryHints(
  discovery: ProviderAccountDiscovery,
  accounts: readonly ProviderAccount[],
): readonly string[] {
  const hints: string[] = [];
  const installed = (tool: string): boolean => discovery.installed_tools.includes(tool);
  const codexAccounts = accounts.filter((account) => account.source === "codex-chatgpt");
  const opencodeAccounts = accounts.filter((account) => account.source.startsWith("opencode:"));
  const hasCodex = codexAccounts.some((account) => account.status === "connected");
  const hasUnsupportedCodex = codexAccounts.some((account) => account.status === "unsupported");
  const hasVendorKeys = opencodeAccounts.some((account) => account.status === "connected");
  const hasZen = accounts.some((account) => account.source === "zen" && account.status === "connected");
  if (!installed("codex")) {
    hints.push("Codex CLI is not installed — install it, then run `codex` to connect ChatGPT.");
  } else if (!hasCodex) {
    const expired = codexAccounts.some((account) => account.status === "expired");
    hints.push(hasUnsupportedCodex
      ? CODEX_SUBSCRIPTION_UNAVAILABLE
      : expired
      ? "ChatGPT login is expired — run `codex` to sign in again."
      : "Codex CLI is installed but no usable ChatGPT login was found — run `codex` to sign in.");
  }
  if (!installed("opencode")) {
    hints.push("OpenCode is not installed — install it, then run `opencode auth login` to connect a provider.");
  } else if (!hasVendorKeys && !hasZen) {
    const errored = opencodeAccounts.find((account) => account.status === "error");
    const expired = opencodeAccounts.some((account) => account.status === "expired");
    if (errored !== undefined) {
      const detail = errored.status_detail.trim();
      hints.push(
        `OpenCode provider login is unavailable — ${detail || "the stored credential could not be used."} `
        + "Run `opencode auth login` to reconnect it.",
      );
    } else if (expired) {
      hints.push("OpenCode provider login is expired — run `opencode auth login` to sign in again.");
    } else {
      hints.push("OpenCode is installed but no usable provider login was found — run `opencode auth login`.");
    }
  }
  return hints;
}
