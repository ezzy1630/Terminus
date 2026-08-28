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

/** Depth applies only where the provider says the model reasons. */
export function effortFor(model: ModelOption, preferred: Effort): Effort | null {
  return model.reasoning ? preferred : null;
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
}

export type ModelSelectionWriter = (
  sessionId: string,
  patch: { default_model?: string; default_reasoning_effort?: Effort },
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
  // The server's default is a bare model id, which may be either spelling.
  const sessionModel = useMemo(() => {
    const wanted = session?.default_model?.trim();
    if (!wanted) return null;
    return models.find((model) => model.id === wanted || model.slug === wanted) ?? null;
  }, [models, session?.default_model]);

  // A pick belongs to the session it was made in. Switching projects must not
  // carry one project's choice into another's turns.
  const activePending = pending.sessionId === sessionId ? pending : null;

  const selected = (activePending?.modelId ? byId.get(activePending.modelId) : undefined)
    ?? sessionModel
    ?? models[0]
    ?? null;

  const preferredEffort: Effort = activePending?.effort
    ?? (isEffort(session?.default_reasoning_effort) ? session.default_reasoning_effort : "medium");

  const write = useCallback((patch: { default_model?: string; default_reasoning_effort?: Effort }): void => {
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

  const select = useCallback((id: string): void => {
    setPending((previous) => ({
      sessionId,
      modelId: id,
      effort: previous.sessionId === sessionId ? previous.effort : null,
    }));
    const model = byId.get(id);
    if (model) write({ default_model: model.slug });
  }, [byId, sessionId, write]);

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
