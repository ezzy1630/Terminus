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
import { useCallback, useEffect, useMemo, useState } from "react";

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

const SELECTED_KEY = "terminus-desktop.model.selected.v1";
const FAVOURITES_KEY = "terminus-desktop.model.favourites.v1";
const EFFORT_KEY = "terminus-desktop.model.effort.v1";
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
}

/**
 * Per-turn model choice, resolved against whatever the inventory currently
 * reports.
 *
 * Preferences are stored by id, never as resolved objects: a provider can drop
 * a model between launches, and a stored object would keep the composer
 * pointing at something no adapter can route to. Anything the inventory no
 * longer lists is dropped on read.
 */
export function useModelSelection(inventory: ModelInventory): ModelSelection {
  const { models } = inventory;
  const [selectedId, setSelectedId] = useState<string | null>(() => readString(SELECTED_KEY));
  const [favouriteIds, setFavouriteIds] = useState<readonly string[]>(() => {
    try {
      const parsed: unknown = JSON.parse(readString(FAVOURITES_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  });
  // The *preferred* depth, not the effective one. Storing the preference and
  // clamping on read means switching to a shallower model and back restores
  // what was asked for instead of leaving turns permanently downgraded.
  const [preferredEffort, setPreferredEffort] = useState<Effort>(() => {
    const raw = readString(EFFORT_KEY);
    return isEffort(raw) ? raw : "medium";
  });

  const byId = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);

  // Falls back to the first reported model so a fresh install, or one whose
  // stored model has disappeared, still has something to send with.
  const selected = (selectedId ? byId.get(selectedId) : undefined) ?? models[0] ?? null;

  const select = useCallback((id: string): void => {
    setSelectedId(id);
    writeString(SELECTED_KEY, id);
  }, []);

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

  useEffect(() => { writeString(EFFORT_KEY, preferredEffort); }, [preferredEffort]);

  return {
    selected,
    select,
    favourites,
    isFavourite: useCallback((id: string) => favouriteIds.includes(id), [favouriteIds]),
    toggleFavourite,
    favouriteRank: useCallback((id: string) => favourites.findIndex((model) => model.id === id) + 1, [favourites]),
    effort: selected ? effortFor(selected, preferredEffort) : null,
    setEffort: setPreferredEffort,
    context: selected ? formatContext(selected.contextTokens) : null,
    inventory,
  };
}
