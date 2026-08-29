/**
 * Terminus Desktop — Model inventory and per-turn selection.
 *
 * This module holds no model list. What a provider offers — which models,
 * which reasoning depths, which context windows — is the provider's to report,
 * and it changes without Terminus shipping a release. A literal list here
 * would go stale silently and, worse, would let the composer offer a model the
 * runtime cannot route to.
 *
 * The inventory therefore arrives from {@link useModelInventory}, and every
 * consumer is written for the empty case: when no provider reports models, the
 * composer shows no picker rather than a plausible-looking one.
 *
 * `ProviderId` is an open string for the same reason — providers are
 * discovered, not enumerated at build time.
 */
import { useCallback, useMemo, useState } from "react";

/**
 * A provider entry's id.
 *
 * Once credentials became first-class this stopped being a vendor id and
 * became a *connected account* id: the same vendor can be reachable through
 * two accounts (a personal key and a work subscription) that bill to different
 * places, so the account is what a turn routes to.
 */
export type ProviderId = string;

export interface Provider {
  id: ProviderId;
  /** Shown in the picker's provider filter and beside each model. */
  label: string;
  /** Two-letter mark. Providers ship no licensed artwork with the app. */
  mark: string;
  /** Whether Terminus can currently route a turn to this provider. */
  available: boolean;
  /** Why it is unavailable, shown in place of the model list. */
  unavailableReason?: string;
  /**
   * Where the credential came from — `opencode:<id>`, `codex-chatgpt`, `zen`.
   * Used only to phrase the source in words an operator recognises.
   */
  source?: string;
  /** How turns on this account are paid for, when the control plane says. */
  billing?: ProviderBilling;
  /** The account every turn falls back to. At most one is true. */
  isDefault?: boolean;
}

export type ProviderBilling = "subscription" | "free" | "paid" | "unknown";

/** The badge a group header carries, or null when billing says nothing useful. */
export function billingBadge(provider: Provider): string | null {
  switch (provider.billing) {
    case "subscription": return "Subscription";
    case "free": return "Free";
    // `paid` is priced per model, not per account: a badge here would have to
    // invent one figure for a list of models that each cost something else.
    default: return null;
  }
}

/**
 * Reasoning depth. Effort and speed are one axis, not two: every step up buys
 * depth by spending time. Exposing them as separate controls would let an
 * operator ask for "max depth, fastest" and get neither.
 */
export const EFFORTS = ["low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const EFFORT_LABELS: Record<Effort, { label: string; note: string }> = {
  low: { label: "Low", note: "Fastest — mechanical edits and lookups" },
  medium: { label: "Medium", note: "Balanced — the usual default" },
  high: { label: "High", note: "Slower — multi-file reasoning and design" },
  max: { label: "Max", note: "Slowest — hard debugging, wide search" },
};

export interface ModelOption {
  id: string;
  provider: ProviderId;
  label: string;
  /** The identifier the adapter receives. */
  slug: string;
  /** One short clause on what this model is for. Never marketing copy. */
  note?: string;
  /** Marks a model that costs nothing to run, which changes how it is picked. */
  free?: boolean;
  /**
   * Whether the model reasons at all. Providers report the capability, not a
   * set of budgets, so depth is offered only where it means something and is
   * never presented as a list of levels the provider did not name.
   */
  reasoning: boolean;
  /** The model's context window in tokens. One value — models have one. */
  contextTokens: number;
  toolCalling?: boolean;
  /**
   * The reasoning depths this model actually accepts, in Terminus's own
   * vocabulary. Empty means the provider named none, and the picker then
   * offers all four rather than pretending to know better.
   *
   * Provider spellings are folded here rather than shown raw: `minimal` and
   * `low` are both Low, `xhigh`/`ultra`/`max` are all Max. Two rows that mean
   * the same depth are a choice the operator cannot make correctly.
   */
  efforts?: readonly Effort[];
  /** What the provider runs this model at when nobody says. */
  defaultEffort?: Effort;
  /**
   * Price in USD micros per million input/output tokens — 3_000_000 is $3/M.
   * Absent means the provider did not price it, and no figure is shown.
   */
  inputCostMicros?: number;
  outputCostMicros?: number;
}

/**
 * Provider effort spellings → the four Terminus offers.
 *
 * The control plane clamps the value back to the provider's own set when it
 * renders the request, so this mapping only has to be honest in one direction:
 * every level offered here must correspond to something the model accepts.
 */
const EFFORT_ALIASES: Readonly<Record<string, Effort>> = {
  minimal: "low",
  none: "low",
  low: "low",
  medium: "medium",
  default: "medium",
  high: "high",
  xhigh: "max",
  ultra: "max",
  max: "max",
};

export function normalizeEffort(value: string): Effort | null {
  return EFFORT_ALIASES[value.trim().toLowerCase()] ?? null;
}

/** The depths a model offers, in Terminus's fixed order. Never empty. */
export function effortsFor(model: ModelOption): readonly Effort[] {
  const offered = model.efforts ?? [];
  const kept = EFFORTS.filter((level) => offered.includes(level));
  return kept.length > 0 ? kept : EFFORTS;
}

/** `3_000_000` → `$3/M`. Null when the provider named no price. */
export function formatPricePerMillion(micros: number | undefined): string | null {
  if (typeof micros !== "number" || !Number.isFinite(micros) || micros <= 0) return null;
  const dollars = micros / 1_000_000;
  if (dollars >= 10) return `$${Math.round(dollars)}/M`;
  if (dollars >= 1) return `$${dollars.toFixed(dollars % 1 === 0 ? 0 : 1)}/M`;
  return `$${dollars.toFixed(2)}/M`;
}

/** What a provider reported at a point in time. Empty until one does. */
export interface ModelInventory {
  providers: readonly Provider[];
  models: readonly ModelOption[];
  status: "loading" | "ready" | "unavailable";
  /** Why nothing is listed, shown verbatim in the picker's empty state. */
  error: string | null;
  refresh: () => void;
}

export const EMPTY_INVENTORY: ModelInventory = {
  providers: [],
  models: [],
  status: "unavailable",
  error: null,
  refresh: () => undefined,
};

const FAVOURITES_KEY = "terminus-desktop.model.favourites.v1";
/** Bounded so a stuck star cannot grow the stored list without limit. */
const MAX_FAVOURITES = 12;

function readString(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeString(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch {}
}

function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

/**
 * Depth applies only where the provider says the model reasons, and only at a
 * level it accepts. A preference of Max carried onto a model whose deepest
 * level is High resolves *down* to High rather than being sent as a value the
 * provider would reject or silently reinterpret.
 */
export function effortFor(model: ModelOption, preferred: Effort): Effort | null {
  if (!model.reasoning) return null;
  const offered = effortsFor(model);
  if (offered.includes(preferred)) return preferred;
  const wanted = EFFORTS.indexOf(preferred);
  let nearest = offered[0] ?? preferred;
  for (const level of offered) {
    if (Math.abs(EFFORTS.indexOf(level) - wanted) < Math.abs(EFFORTS.indexOf(nearest) - wanted)) {
      nearest = level;
    }
  }
  return nearest;
}

/** `128000` → `128K`, `1000000` → `1M`. Zero means the provider did not say. */
export function formatContext(tokens: number): string | null {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export interface ModelSelection {
  /** Null whenever the inventory reports nothing. Callers must handle it. */
  selected: ModelOption | null;
  /**
   * The connected account the selected model belongs to, when the inventory
   * reported one. The composer states it on the chip and sends it with the
   * turn: a bare model id does not name a route.
   */
  account: Provider | null;
  select: (id: string) => void;
  favourites: readonly ModelOption[];
  isFavourite: (id: string) => boolean;
  toggleFavourite: (id: string) => void;
  favouriteRank: (id: string) => number;
  /** Null when the selected model does not reason, or none is selected. */
  effort: Effort | null;
  setEffort: (effort: Effort) => void;
  /** The selected model's context window, formatted. Read-only — models have one. */
  context: string | null;
  inventory: ModelInventory;
  /** Why the choice could not be saved as the project's default, if it could not. */
  persistError: string | null;
  /** A write to the session default is in flight. */
  persisting: boolean;
}

/**
 * Where a model choice is stored, and who is told about it.
 *
 * The picker used to write the global gateway provider configuration row on
 * every choice: one row, no session, no provider field. Choosing a model for
 * one project changed it for every project and every run already in flight.
 * The choice belongs to the session, so that is where it goes.
 */
export interface ModelSelectionSession {
  readonly id: string;
  readonly default_model?: string | null;
  readonly default_reasoning_effort?: Effort | null;
  /** Which connected account the stored model belongs to, when one is pinned. */
  readonly default_provider_account_id?: string | null;
}

export type ModelSelectionWriter = (
  sessionId: string,
  patch: {
    default_model?: string;
    default_reasoning_effort?: Effort;
    default_provider_account_id?: string;
  },
) => Promise<unknown>;

/**
 * Per-turn model choice, resolved against whatever the inventory currently
 * reports.
 *
 * Resolution order: what the operator picked in this window for this session,
 * then the session's stored default, then the first model the inventory
 * reports. Nothing here is remembered in localStorage — a stored id survives
 * the provider dropping the model, and the composer would then point at
 * something no adapter can route to. The session is the durable store.
 */
export function useModelSelection(
  inventory: ModelInventory,
  session: ModelSelectionSession | null = null,
  persist: ModelSelectionWriter | null = null,
): ModelSelection {
  const { models } = inventory;
  /** What the operator picked in this window, before any server round trip. */
  const [pending, setPending] = useState<{ sessionId: string | null; modelId: string | null; effort: Effort | null }>(
    { sessionId: session?.id ?? null, modelId: null, effort: null },
  );
  const [persistError, setPersistError] = useState<string | null>(null);
  const [persisting, setPersisting] = useState(false);
  const [favouriteIds, setFavouriteIds] = useState<readonly string[]>(() => {
    try {
      const parsed: unknown = JSON.parse(readString(FAVOURITES_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  });

  const sessionId = session?.id ?? null;
  const byId = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const accountById = useMemo(
    () => new Map(inventory.providers.map((provider) => [provider.id, provider])),
    [inventory.providers],
  );
  const sessionAccountId = session?.default_provider_account_id?.trim() ?? "";
  // The server's default is a bare model id, which may be either spelling.
  // Two accounts can offer the same id, so the stored account decides between
  // them; without one the first match stands, which is what a control plane
  // that predates accounts will produce.
  const sessionModel = useMemo(() => {
    const wanted = session?.default_model?.trim();
    if (!wanted) return null;
    const named = models.filter((model) => model.id === wanted || model.slug === wanted);
    return named.find((model) => model.provider === sessionAccountId) ?? named[0] ?? null;
  }, [models, session?.default_model, sessionAccountId]);

  // A pick belongs to the session it was made in. Switching projects must not
  // carry one project's choice into another's turns.
  const activePending = pending.sessionId === sessionId ? pending : null;

  const selected = (activePending?.modelId ? byId.get(activePending.modelId) : undefined)
    ?? sessionModel
    ?? models[0]
    ?? null;

  // A model that names its own default depth is preferred over the session's
  // carried-over preference *only* when the session never stated one; an
  // operator who chose High meant it for the next model too.
  const preferredEffort: Effort = activePending?.effort
    ?? (isEffort(session?.default_reasoning_effort)
      ? session.default_reasoning_effort
      : selected?.defaultEffort ?? "medium");

  const write = useCallback((patch: {
    default_model?: string;
    default_reasoning_effort?: Effort;
    default_provider_account_id?: string;
  }): void => {
    if (!persist || sessionId === null) return;
    setPersisting(true);
    setPersistError(null);
    void persist(sessionId, patch)
      .then(() => setPersistError(null))
      .catch((error: unknown) => {
        // The local choice stands — the turn will still be routed with it —
        // but the operator is told it did not become the project's default.
        setPersistError(error instanceof Error
          ? `Saved for this window only: ${error.message}`
          : "The project default could not be saved.");
      })
      .finally(() => setPersisting(false));
  }, [persist, sessionId]);

  /**
   * One pick is one routing decision, so it is stored as one: the account the
   * turn authenticates as, the model within it, and the depth that model will
   * actually run at. Writing only the model id left the session pointing at a
   * name two accounts could both answer to.
   */
  const select = useCallback((id: string): void => {
    setPending((previous) => ({
      sessionId,
      modelId: id,
      effort: previous.sessionId === sessionId ? previous.effort : null,
    }));
    const model = byId.get(id);
    if (!model) return;
    const account = accountById.get(model.provider);
    const depth = effortFor(model, preferredEffort);
    write({
      default_model: model.slug,
      // Omitted rather than guessed when the inventory reported no account —
      // a control plane that predates accounts must keep working.
      ...(account ? { default_provider_account_id: account.id } : {}),
      ...(depth ? { default_reasoning_effort: depth } : {}),
    });
  }, [accountById, byId, preferredEffort, sessionId, write]);

  const setEffort = useCallback((effort: Effort): void => {
    setPending((previous) => ({
      sessionId,
      modelId: previous.sessionId === sessionId ? previous.modelId : null,
      effort,
    }));
    write({ default_reasoning_effort: effort });
  }, [sessionId, write]);

  const toggleFavourite = useCallback((id: string): void => {
    setFavouriteIds((previous) => {
      const next = previous.includes(id)
        ? previous.filter((entry) => entry !== id)
        : [...previous, id].slice(0, MAX_FAVOURITES);
      writeString(FAVOURITES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Favourite order is insertion order, which is what the 1…9 slots bind to:
  // starring a model gives it a stable key instead of reshuffling the rest.
  const favourites = useMemo(
    () => favouriteIds.map((id) => byId.get(id)).filter((model): model is ModelOption => model !== undefined),
    [byId, favouriteIds],
  );

  return {
    selected,
    account: selected ? accountById.get(selected.provider) ?? null : null,
    select,
    favourites,
    isFavourite: useCallback((id: string) => favouriteIds.includes(id), [favouriteIds]),
    toggleFavourite,
    favouriteRank: useCallback((id: string) => favourites.findIndex((model) => model.id === id) + 1, [favourites]),
    effort: selected ? effortFor(selected, preferredEffort) : null,
    setEffort,
    context: selected ? formatContext(selected.contextTokens) : null,
    inventory,
    persistError,
    persisting,
  };
}
