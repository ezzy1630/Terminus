/**
 * Terminus Desktop — Connected provider accounts.
 *
 * Terminus does not ask an operator to paste a key. The credentials it can use
 * are the ones their own tools already hold — the OpenCode auth store. The
 * separate Codex subscription lane is shown below this account list and is
 * never imported into native routing. This hook reads the resulting list and
 * offers explicit Connect for a disconnected OpenCode API account, plus make
 * default and disconnect for an already connected credential.
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
  CodexLaneAccountResponse,
  CodexLaneEvent,
  CodexLaneIdentity,
  CodexLaneModelsResponse,
  CodexLaneStatus,
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
  "A ChatGPT/Codex subscription login was detected. Use the separate external Codex lane; it is not Terminus-native routing.";

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
  connect: (account: ProviderAccount) => Promise<void>;
  setDefault: (account: ProviderAccount) => Promise<void>;
  disconnect: (account: ProviderAccount) => Promise<void>;
}

export interface CodexLaneState {
  status: "loading" | "ready" | "unavailable" | "unconfigured";
  detail: string | null;
  lane: CodexLaneStatus | null;
  account: CodexLaneAccountResponse["account"] | null;
  models: CodexLaneModelsResponse["models"];
  threadId: string | null;
  turnId: string | null;
  events: readonly CodexLaneEvent[];
  cursorExpired: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  openThread: () => Promise<void>;
  sendTurn: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  stop: () => Promise<void>;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * A Codex CLI login is an observed local credential, not a native Terminus
 * model route. Keep it visible so the operator understands what was found;
 * subscription use is handled by the separate external lane.
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

  const connect = useCallback(async (account: ProviderAccount): Promise<void> => {
    if (!account.source.startsWith("opencode:") || account.status !== "disconnected") {
      setState((current) => ({ ...current, error: "Only disconnected OpenCode API accounts can be connected here." }));
      return;
    }
    if (!account.credential_fingerprint) {
      setState((current) => ({ ...current, error: "This account has no credential fingerprint; run discovery again before connecting." }));
      return;
    }
    setBusyId(account.id);
    setState((current) => ({ ...current, error: null }));
    try {
      const response = await api.connectProviderAccount(
        account.id,
        account.revision,
        account.credential_fingerprint,
        { idempotencyKey: createIdempotencyKey(`provider-account-connect:${account.id}`) },
      );
      if (!mounted.current) return;
      setState({
        accounts: normalizeAccounts(response.accounts),
        discovery: response.discovery,
        status: response.supported ? "ready" : "unavailable",
        error: null,
        supported: response.supported,
      });
    } catch (error) {
      if (mounted.current) setState((current) => ({ ...current, error: messageFor(error, "That OpenCode account could not be connected.") }));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }, []);

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
    connect,
    setDefault,
    disconnect,
  }), [busyId, connect, detect, detecting, disconnect, lastSweep, setDefault, state]);
}

/**
 * Read-only UI state for the separate subscription lane. It takes a concrete
 * session identity because the control plane keys external jobs by both
 * workspace and session; there is no process-wide Codex singleton to guess at.
 */
export function useCodexLane(identity: CodexLaneIdentity | null): CodexLaneState {
  type CodexLaneSnapshot = Omit<CodexLaneState, "refresh" | "stop" | "openThread" | "sendTurn" | "interrupt">;
  const [state, setState] = useState<CodexLaneSnapshot>({
    status: identity === null ? "unconfigured" : "loading",
    detail: identity === null ? "Open a project to connect a Codex subscription." : null,
    lane: null,
    account: null,
    models: [],
    threadId: null,
    turnId: null,
    events: [],
    cursorExpired: false,
    refreshing: false,
  });
  const mounted = useRef(true);
  const eventCursor = useRef<string | null>(null);

  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    eventCursor.current = null;
    setState((current) => ({
      ...current,
      status: identity === null ? "unconfigured" : "loading",
      detail: identity === null ? "Open a project to connect a Codex subscription." : null,
      lane: null,
      account: null,
      models: [],
      threadId: null,
      turnId: null,
      events: [],
      cursorExpired: false,
    }));
  }, [identity]);

  const readEvents = useCallback(async (): Promise<void> => {
    if (identity === null) return;
    try {
      const response = await api.getCodexLaneEvents(identity, eventCursor.current);
      if (!mounted.current) return;
      eventCursor.current = response.next_cursor;
      setState((current) => ({
        ...current,
        events: response.cursor_expired
          ? response.events
          : [...current.events, ...response.events].slice(-80),
        cursorExpired: response.cursor_expired,
      }));
    } catch (error) {
      if (mounted.current) setState((current) => ({ ...current, detail: messageFor(error, "Codex external events could not be read.") }));
    }
  }, [identity]);

  const refresh = useCallback(async (): Promise<void> => {
    if (identity === null) {
      setState((current) => ({ ...current, status: "unconfigured", detail: "Open a project to connect a Codex subscription." }));
      return;
    }
    setState((current) => ({ ...current, refreshing: true, detail: null }));
    try {
      const lane = await api.getCodexLaneStatus(identity);
      if (!lane.available) {
        if (mounted.current) setState((current) => ({ ...current, status: "unavailable", lane, detail: lane.reason ?? "Codex CLI is unavailable.", refreshing: false, threadId: lane.persisted_thread_id ?? current.threadId }));
        return;
      }
      // A fresh control-plane process can report a ready App Server while the
      // durable Codex thread still lives in session metadata. Reattach it
      // before presenting the lane as connected; otherwise "connected" would
      // mean only that a new empty process started.
      if (lane.state === "ready" && lane.persisted_thread_id !== null) {
        await api.resumeCodexLaneThread({
          ...identity,
          thread_id: lane.persisted_thread_id,
        }, { idempotencyKey: createIdempotencyKey("codex-lane-resume") });
      }
      const [account, models] = await Promise.all([
        api.getCodexLaneAccount(identity),
        api.getCodexLaneModels(identity),
      ]);
      if (!mounted.current) return;
      setState((current) => ({ status: "ready", detail: null, lane, account: account.account, models: models.models, refreshing: false, threadId: lane.persisted_thread_id, turnId: current.turnId, events: current.events, cursorExpired: current.cursorExpired }));
      await readEvents();
    } catch (error) {
      if (!mounted.current) return;
      setState((current) => ({
        ...current,
        status: "unavailable",
        detail: messageFor(error, "Codex subscription status could not be read."),
        refreshing: false,
      }));
    }
  }, [identity, readEvents]);

  useEffect(() => {
    if (identity === null) return;
    void refresh();
  }, [identity, refresh]);

  useEffect(() => {
    if (identity === null || state.status !== "ready") return;
    const timer = setInterval(() => { void readEvents(); }, 1_200);
    return () => clearInterval(timer);
  }, [identity, readEvents, state.status]);

  const openThread = useCallback(async (): Promise<void> => {
    if (identity === null) return;
    setState((current) => ({ ...current, refreshing: true, detail: null }));
    try {
      const thread = state.threadId === null
        ? await api.startCodexLaneThread(identity, { idempotencyKey: createIdempotencyKey("codex-lane-thread") })
        : await api.resumeCodexLaneThread({ ...identity, thread_id: state.threadId }, { idempotencyKey: createIdempotencyKey("codex-lane-thread-resume") });
      if (mounted.current) setState((current) => ({ ...current, threadId: thread.thread_id, refreshing: false }));
      await readEvents();
    } catch (error) {
      if (mounted.current) setState((current) => ({ ...current, detail: messageFor(error, "Codex thread could not be opened."), refreshing: false }));
    }
  }, [identity, readEvents, state.threadId]);

  const sendTurn = useCallback(async (text: string): Promise<void> => {
    if (identity === null || state.threadId === null || text.trim().length === 0) return;
    setState((current) => ({ ...current, refreshing: true, detail: null }));
    try {
      const turn = await api.startCodexLaneTurn({ ...identity, thread_id: state.threadId, text }, { idempotencyKey: createIdempotencyKey("codex-lane-turn") });
      if (mounted.current) setState((current) => ({ ...current, turnId: turn.turn_id, refreshing: false }));
      await readEvents();
    } catch (error) {
      if (mounted.current) setState((current) => ({ ...current, detail: messageFor(error, "Codex turn could not be started."), refreshing: false }));
    }
  }, [identity, readEvents, state.threadId]);

  const interrupt = useCallback(async (): Promise<void> => {
    if (identity === null || state.threadId === null || state.turnId === null) return;
    try {
      await api.interruptCodexLaneTurn({ ...identity, thread_id: state.threadId, turn_id: state.turnId }, { idempotencyKey: createIdempotencyKey("codex-lane-interrupt") });
      if (mounted.current) setState((current) => ({ ...current, turnId: null }));
      await readEvents();
    } catch (error) {
      if (mounted.current) setState((current) => ({ ...current, detail: messageFor(error, "Codex turn could not be interrupted.") }));
    }
  }, [identity, readEvents, state.threadId, state.turnId]);

  const stop = useCallback(async (): Promise<void> => {
    if (identity === null) return;
    setState((current) => ({ ...current, refreshing: true, detail: null }));
    try {
      await api.stopCodexLane(identity, { idempotencyKey: createIdempotencyKey("codex-lane-stop") });
      if (mounted.current) setState((current) => ({ ...current, status: "unavailable", detail: "Codex lane stopped.", refreshing: false, turnId: null, lane: current.lane ? { ...current.lane, available: false, state: "stopped", job_id: null } : null }));
    } catch (error) {
      if (mounted.current) setState((current) => ({ ...current, detail: messageFor(error, "Codex lane could not be stopped."), refreshing: false }));
    }
  }, [identity]);

  return useMemo(() => ({ ...state, refresh, openThread, sendTurn, interrupt, stop }), [interrupt, openThread, refresh, sendTurn, state, stop]);
}

// ────────────────────────── Presentation helpers ────────────────────────────

/**
 * Where the credential came from, in the operator's words.
 *
 * The `source` id is the control plane's (`opencode:baseten`); a row that
 * showed it raw would be asking the reader to know the naming scheme.
 */
export function accountSourceLabel(source: string): string {
  if (source === "codex-chatgpt") return "Codex CLI login (external lane)";
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
