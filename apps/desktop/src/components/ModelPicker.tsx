/**
 * Terminus Desktop — the composer's turn-routing control.
 *
 * One pill on the right of the composer names the exact model and its selected
 * effort. Both come from live provider discovery; opaque project profiles do
 * not replace the routing choice the operator is actually making.
 *
 * The popover is a pane stack rather than nested menus. The root states the
 * current values and nothing else; a row opens the list behind it. A flyout
 * would have to open leftward off a control already pinned to the right edge
 * of the window, and it gives keyboard users two focus surfaces to track
 * instead of one.
 *
 * Everything listed is reported by a provider at runtime — Terminus ships no
 * model list. When discovery is empty, a project with no stored choice has no
 * pill. A stored choice remains visible as unavailable until the operator
 * retries discovery or explicitly changes it.
 *
 * Two departures from the usual provider-switcher shape, both kept from the
 * previous design:
 *
 *   - The provider filter is a labelled chip row, not an icon rail. An
 *     icon-only rail asks the reader to recognise provider marks before they
 *     can filter, and it gives keyboard users nothing to read.
 *   - Providers Terminus cannot currently reach are listed with the reason
 *     rather than hidden. A model missing from the list looks like a Terminus
 *     bug; a model listed as "connect an adapter" is an instruction.
 *
 * Favourites are the fast path: starred models are pinned to the top and bound
 * to 1…9 while the model pane is open. The digits are unmodified on purpose —
 * ⌘1–9 already opens tasks 1 through 9 (see FIXED_SHORTCUTS.taskSlot).
 *
 * There is no "Reset to default" row. Nothing in this client holds a default
 * distinct from the project's own stored one, and every pick writes that
 * stored default immediately, so the row would have had nothing to restore.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, Star } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "../ui/Button";
import {
  EFFORT_LABELS,
  billingBadge,
  effortsFor,
  formatContext,
  formatPricePerMillion,
  type ModelOption,
  type ModelSelection,
  type Provider,
  type ProviderId,
} from "../lib/models";

type Filter = "all" | "favourites" | ProviderId;

/** Which list the popover is showing. The root states values; panes change them. */
type Pane = "root" | "model" | "effort";

/** Header + list + footer, used to decide whether the popover fits below. */
const PANEL_MAX_HEIGHT = 420;

interface ModelPickerProps {
  selection: ModelSelection;
  className?: string;
  disabled?: boolean;
  /**
   * Quiet meta for the footer — what this task has spent. It lives here rather
   * than as its own composer chip because it is a figure to consult, not a
   * control, and the control row is for things that are clicked.
   */
  meta?: string;
  /** The long form of {@link meta}, for its tooltip. */
  metaDetail?: string;
}

/** The provider mark. Terminus ships no third-party logos, so this is type. */
function ProviderMark({ mark, dimmed }: { mark: string; dimmed?: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-subtle bg-subtle text-xs font-semibold tracking-tight",
        dimmed ? "text-tertiary" : "text-secondary",
      )}
    >
      {mark}
    </span>
  );
}

function matches(model: ModelOption, providerLabel: string, query: string): boolean {
  if (query.length === 0) return true;
  return `${model.label} ${model.slug} ${providerLabel} ${model.note ?? ""}`.toLowerCase().includes(query);
}

/**
 * A root row: a label on the left, the current value and a chevron on the
 * right. Reads as a statement of the current setting first and a control
 * second, which is the whole point of the root pane.
 */
function SettingRow({
  label,
  value,
  onOpen,
}: {
  label: string;
  value: string;
  onOpen: () => void;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="bare"
      onClick={onOpen}
      aria-label={`${label}: ${value}. Change ${label.toLowerCase()}`}
      className="ui-menu-item flex h-8 w-full items-center gap-3 rounded-md px-2.5 text-left hover:bg-hover"
    >
      <span className="ui-body shrink-0 text-primary">{label}</span>
      <span className="ui-body ml-auto min-w-0 truncate text-secondary">{value}</span>
      <ChevronRight size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-tertiary" />
    </Button>
  );
}

/** The back affordance at the top of a second pane. */
function PaneHeader({ title, onBack }: { title: string; onBack: () => void }): JSX.Element {
  return (
    <div className="flex items-center gap-1 border-b border-subtle px-1.5 py-1.5">
      <Button
        type="button"
        variant="bare"
        onClick={onBack}
        aria-label="Back"
        className="flex h-6 w-6 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
      >
        <ChevronLeft size={14} strokeWidth={1.9} aria-hidden />
      </Button>
      <span className="ui-body font-medium text-primary">{title}</span>
    </div>
  );
}

function ModelPickerImpl({
  selection,
  className,
  disabled = false,
  meta,
  metaDetail,
}: ModelPickerProps): JSX.Element {
  const {
    selected,
    selectedAvailable,
    account: selectedAccount,
    select,
    effort,
    setEffort,
    context,
    favourites,
    favouriteRank,
    isFavourite,
    toggleFavourite,
    inventory,
    persistError,
    persisting,
  } = selection;
  const { models, providers } = inventory;
  const providerById = useCallback(
    (id: ProviderId): Provider => providers.find((provider) => provider.id === id)
      ?? { id, label: id, mark: id.slice(0, 2).toUpperCase(), available: false },
    [providers],
  );
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("root");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState<"down" | "up">("up");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const normalizedQuery = query.trim().toLowerCase();

  /**
   * One flat, ordered list drives both rendering and keyboard navigation.
   * Deriving arrow-key targets from a separate structure than the one on
   * screen is how these menus end up highlighting the wrong row.
   */
  const groups = useMemo(() => {
    const visible = models.filter((model) => matches(model, providerById(model.provider).label, normalizedQuery));
    const result: Array<{
      id: string;
      title: string;
      note?: string;
      /** Subscription / Free — how turns on this account are paid for. */
      badge?: string;
      /** The account every turn falls back to when nothing else applies. */
      isDefault?: boolean;
      models: ModelOption[];
    }> = [];

    if (filter === "favourites" || filter === "all") {
      const starred = favourites.filter((model) => visible.includes(model));
      if (starred.length > 0) result.push({ id: "favourites", title: "Favourites", models: starred });
    }
    if (filter === "favourites") return result;

    // One group per connected account, in the order the control plane listed
    // them. Two accounts on the same vendor are two groups, because they are
    // two different bills and two different credentials.
    for (const provider of providers) {
      if (filter !== "all" && filter !== provider.id) continue;
      const grouped = visible.filter((model) => model.provider === provider.id);
      if (grouped.length === 0) continue;
      const badge = billingBadge(provider);
      result.push({
        id: provider.id,
        title: provider.label,
        ...(provider.available ? {} : { note: provider.unavailableReason ?? "This provider is not reachable right now." }),
        ...(badge ? { badge } : {}),
        ...(provider.isDefault ? { isDefault: true } : {}),
        models: grouped,
      });
    }
    return result;
  }, [favourites, filter, models, normalizedQuery, providerById, providers]);

  // Rows are addressed by (group, model) because a favourited model appears in
  // both its Favourites row and its provider row, and the two must not share a
  // highlight.
  const rows = useMemo(
    () => groups.flatMap((group) => group.models.map((model) => ({ key: `${group.id}:${model.id}`, model }))),
    [groups],
  );

  const close = useCallback((): void => {
    setOpen(false);
    setPane("root");
    setQuery("");
    setFilter("all");
    setActiveIndex(0);
  }, []);

  const choose = useCallback((model: ModelOption): void => {
    if (!providerById(model.provider).available) return;
    // The choice takes effect for the next turn immediately; saving it as the
    // project's default is a separate, slower thing whose failure is reported
    // in the footer rather than silently reverting the row just clicked.
    select(model.id);
    close();
  }, [close, providerById, select]);

  /**
   * Everything that means "this popover is no longer the surface in use".
   *
   * The listener used to be one bubble-phase `pointerdown` on `window`, which
   * a control that opens something else can outrun: clicking a button that
   * mounts a modal left this popover drawn, undimmed, over the modal's scrim.
   * So: capture phase (nothing can stop it reaching us), both pointer and
   * mouse events (an environment that synthesises only one still closes it),
   * the window losing focus, and the app's own overlay-open events — a
   * command palette or a settings dialog opening is the same statement as a
   * click elsewhere.
   */
  useEffect(() => {
    if (!open) return;
    const closeIfOutside = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      close();
    };
    const overlayEvents = [
      "terminus:open-settings",
      "terminus:open-command-palette",
      "terminus:open-onboarding",
    ] as const;
    document.addEventListener("pointerdown", closeIfOutside, true);
    document.addEventListener("mousedown", closeIfOutside, true);
    window.addEventListener("blur", close);
    for (const name of overlayEvents) window.addEventListener(name, close);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside, true);
      document.removeEventListener("mousedown", closeIfOutside, true);
      window.removeEventListener("blur", close);
      for (const name of overlayEvents) window.removeEventListener(name, close);
    };
  }, [close, open]);

  /**
   * Escape, wherever focus happens to be.
   *
   * Handled on the document in the capture phase rather than on this subtree,
   * because focus can legitimately sit outside the popover while it is open
   * (the trigger is a tooltip target, and a pointer-driven open never moves
   * focus at all) — and Escape then reached an enclosing dialog first and
   * closed *that* instead. Propagation stops here so the topmost surface is
   * the one that closes.
   */
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      // Escape backs out one pane at a time, so a mis-click into the model
      // list does not also throw away the popover.
      if (pane === "root") close();
      else setPane("root");
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [close, open, pane]);

  // Search takes focus when the model pane opens, and only then — the root
  // pane has no field, and stealing focus from it would strand arrow keys.
  useEffect(() => {
    if (!open || pane !== "model") return;
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, pane]);

  // Measure against the trigger at the moment the popover opens. The composer
  // is docked at the bottom of the window on both surfaces, so upward is the
  // normal answer; the measurement is what makes the exception work rather
  // than synchronously updating state from an effect after every render.
  const openPopover = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const { bottom, top } = event.currentTarget.getBoundingClientRect();
    const below = window.innerHeight - bottom;
    setPlacement(below >= PANEL_MAX_HEIGHT || below >= top ? "down" : "up");
    setOpen(true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Escape is handled on the document, so that it works with focus anywhere.
    if (pane !== "model") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + delta + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      const row = rows[activeIndex];
      if (!row) return;
      event.preventDefault();
      choose(row.model);
      return;
    }
    // Digits pick a favourite by slot. Guarded on the modifiers so typing a
    // digit into the search field still searches.
    if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && event.target !== searchRef.current) {
      const model = favourites[Number(event.key) - 1];
      if (!model) return;
      event.preventDefault();
      choose(model);
    }
  };

  // With neither a stored model nor an inventory model there is no truthful
  // choice to show. A stored but unavailable model remains selected above.
  if (!selected) return <></>;

  const filters: Array<{ id: Filter; label: string }> = [
    { id: "all", label: "All" },
    ...(favourites.length > 0 ? [{ id: "favourites" as Filter, label: "Favourites" }] : []),
    // Only providers that actually reported something get a filter chip.
    ...providers.filter((provider) => models.some((model) => model.provider === provider.id))
      .map((provider) => ({ id: provider.id as Filter, label: provider.label })),
  ];

  const effortLabel = effort === null ? null : EFFORT_LABELS[effort].label;
  // The footer is the popover's quiet meta line: what this task has already
  // spent, then the window the chosen model has to spend it in. The live
  // figure leads because it is the one that changes. It never becomes a
  // control — it is here rather than in the composer's control row precisely
  // because it is a figure to consult, not a thing to click.
  const footer = persistError
    ? persistError
    : persisting
      ? "Saving as the project default…"
      : [meta, context ? `${context} context window` : null].filter(Boolean).join(" · ");

  return (
    <div ref={rootRef} className={cn("relative", className)} onKeyDown={onKeyDown}>
      <Button
        type="button"
        variant="bare"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        /* Leads with the action, then the values. It must not begin "Model:",
           which is how the root pane's own Model row names itself — two
           controls whose accessible names share a prefix make either of them
           unaddressable from the keyboard and from a test. */
        aria-label={`Change model and effort · ${selected.label}${selectedAccount ? ` on ${selectedAccount.label}` : ""}${effortLabel ? `, ${effortLabel}` : ""}${selectedAvailable ? "" : ", unavailable"}`}
        data-tooltip="Model and reasoning effort for this turn"
        onClick={(event) => {
          if (open) close();
          else openPopover(event);
        }}
        className={cn(
          "composer-control flex h-7 min-w-0 max-w-56 items-center gap-1.5 rounded-full px-2.5 text-xs",
          "hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45",
          open && "bg-hover",
        )}
      >
        {/* The account mark leads: with several accounts connected, the model
            name alone does not say which credential the turn uses. */}
        {selectedAvailable && selectedAccount ? <ProviderMark mark={selectedAccount.mark} /> : null}
        <span className="truncate font-medium text-primary">{selected.label}</span>
        {effortLabel ? (
          <>
            <span aria-hidden className="shrink-0 text-tertiary">·</span>
            <span className="shrink-0 text-secondary">{effortLabel}</span>
          </>
        ) : null}
        <ChevronDown size={12} strokeWidth={1.9} aria-hidden className="shrink-0 text-tertiary" />
      </Button>

      {open ? (
        <div
          role="dialog"
          aria-label="Turn settings"
          className={cn(
            "ui-popover surface-enter absolute right-0 z-popover flex w-[320px] flex-col overflow-hidden rounded-xl border border-default shadow-lg",
            placement === "down" ? "top-[calc(100%+6px)]" : "bottom-[calc(100%+6px)]",
          )}
        >
          {pane === "root" ? (
            <div className="p-1">
              <SettingRow
                label="Model"
                value={selectedAvailable ? selected.label : `${selected.label} (Unavailable)`}
                onOpen={() => setPane("model")}
              />
              {/* Depth is offered only where the provider says the model
                  reasons. An inert row on a non-reasoning model is a promise
                  the runtime cannot keep. */}
              {effortLabel ? (
                <SettingRow label="Effort" value={effortLabel} onOpen={() => setPane("effort")} />
              ) : null}
              <p className="mx-2.5 border-t border-subtle py-2 text-xs leading-relaxed text-tertiary">
                {[
                  effortsFor(selected).length > 0
                    ? `Effort: ${effortsFor(selected).map((level) => EFFORT_LABELS[level].label).join(", ")}`
                    : null,
                  formatContext(selected.contextTokens) ? `${formatContext(selected.contextTokens)} context` : null,
                  formatContext(selected.outputTokens ?? 0) ? `${formatContext(selected.outputTokens ?? 0)} max output` : null,
                  selected.toolCalling ? "Tools" : null,
                  selected.structuredOutput ? "Structured output" : null,
                  selected.imageInput ? "Image input" : null,
                  selected.parallelToolCalls ? "Parallel tools" : null,
                ].filter(Boolean).join(" · ") || "No additional capabilities were reported for this model."}
              </p>
            </div>
          ) : null}

          {pane === "effort" && effort !== null ? (
            <>
              <PaneHeader title="Effort" onBack={() => setPane("root")} />
              <div className="p-1">
                {/* Exactly the depths this model accepts. Offering four when
                    the provider named two is how an operator ends up asking
                    for a level the request will be clamped out of anyway. */}
                {effortsFor(selected).map((level) => (
                  <Button
                    key={level}
                    type="button"
                    variant="bare"
                    onClick={() => { setEffort(level); setPane("root"); }}
                    aria-pressed={level === effort}
                    className="ui-menu-item flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="ui-body block text-primary">{EFFORT_LABELS[level].label}</span>
                      <span className="mt-0.5 block text-xs leading-snug text-tertiary">{EFFORT_LABELS[level].note}</span>
                    </span>
                    {level === effort ? (
                      <Check size={13} strokeWidth={2} aria-label="Selected" className="mt-0.5 shrink-0 text-primary" />
                    ) : null}
                  </Button>
                ))}
              </div>
            </>
          ) : null}

          {pane === "model" ? (
            <>
              <PaneHeader title="Model" onBack={() => setPane("root")} />
              <div className="relative border-b border-subtle p-2">
                <Search size={13} aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-tertiary" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  placeholder="Search models"
                  aria-label="Search models"
                  spellCheck={false}
                  className="ui-input h-7 w-full rounded-md border border-subtle bg-card pl-7 pr-2 text-xs text-primary placeholder:text-tertiary"
                />
              </div>

              {filters.length > 1 ? (
                <div className="flex flex-wrap gap-1 border-b border-subtle px-2 py-1.5" role="group" aria-label="Filter models">
                  {filters.map((entry) => (
                    <Button
                      key={entry.id}
                      type="button"
                      variant="bare"
                      aria-pressed={filter === entry.id}
                      onClick={() => {
                        setFilter(entry.id);
                        setActiveIndex(0);
                      }}
                      className={cn(
                        "flex h-6 items-center gap-1 rounded-md px-2 text-xs transition-colors",
                        filter === entry.id
                          ? "bg-selected font-medium text-primary"
                          : "text-tertiary hover:bg-hover hover:text-secondary",
                      )}
                    >
                      {entry.id === "favourites" ? <Star size={10} aria-hidden className="fill-current" /> : null}
                      {entry.label}
                    </Button>
                  ))}
                </div>
              ) : null}

              <div className="scrollable max-h-64 min-h-24 overflow-y-auto p-1">
                {rows.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-tertiary">
                    {query.trim().length > 0
                      ? `No model matches “${query.trim()}”.`
                      : "No models are currently available."}
                  </p>
                ) : groups.map((group) => (
                  <section key={group.id} aria-label={group.title}>
                    {/* The account header carries what distinguishes one
                        account from another: how its turns are paid for, and
                        whether it is the one every project falls back to. */}
                    <h3 className="flex items-center gap-1.5 px-2.5 pb-1 pt-2">
                      <span className="ui-section-label min-w-0 truncate">{group.title}</span>
                      {group.badge ? (
                        <span className="ui-meta shrink-0 rounded border border-subtle px-1 text-tertiary">{group.badge}</span>
                      ) : null}
                      {group.isDefault ? (
                        <span className="ui-meta shrink-0 text-tertiary">Default</span>
                      ) : null}
                    </h3>
                    {group.note ? (
                      <p className="px-2.5 pb-1.5 text-xs leading-snug text-tertiary">{group.note}</p>
                    ) : null}
                    {group.models.map((model) => {
                      const rowKey = `${group.id}:${model.id}`;
                      const index = rows.findIndex((row) => row.key === rowKey);
                      const available = providerById(model.provider).available;
                      const starred = isFavourite(model.id);
                      const slot = group.id === "favourites" ? favouriteRank(model.id) : 0;
                      return (
                        <div
                          key={rowKey}
                          className={cn(
                            "group/row flex items-center gap-2 rounded-md px-2.5 py-1.5",
                            index === activeIndex && "bg-hover",
                            !available && "opacity-50",
                          )}
                          onPointerEnter={() => setActiveIndex(index)}
                        >
                          <Button
                            type="button"
                            variant="bare"
                            disabled={!available}
                            onClick={() => choose(model)}
                            aria-label={`${model.label}, ${providerById(model.provider).label}`}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
                          >
                            <ProviderMark mark={providerById(model.provider).mark} dimmed={!available} />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-medium text-primary">{model.label}</span>
                                {model.free ? (
                                  <span className="shrink-0 rounded bg-success/12 px-1 text-xs font-medium text-success">Free</span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-tertiary">
                                {[
                                  model.note ?? providerById(model.provider).label,
                                  effortsFor(model).length > 0
                                    ? effortsFor(model).map((level) => EFFORT_LABELS[level].label).join("/")
                                    : null,
                                  formatContext(model.contextTokens) ? `${formatContext(model.contextTokens)} context` : null,
                                  // Price is a fact the provider stated, per
                                  // million input tokens. Absent when it
                                  // stated none — never estimated here.
                                  model.free ? null : formatPricePerMillion(model.inputCostMicros),
                                ].filter(Boolean).join(" · ")}
                              </span>
                            </span>
                          </Button>

                          {/* Identity is (account, model): the same model id
                              under two accounts is two different routes, and
                              matching on the id alone ticked both. */}
                          {model.id === selected.id && model.provider === selected.provider ? (
                            <Check size={13} strokeWidth={2} aria-label="Selected" className="shrink-0 text-primary" />
                          ) : slot >= 1 && slot <= 9 ? (
                            <span
                              aria-hidden
                              className="shrink-0 rounded border border-subtle px-1 font-mono text-xs text-tertiary"
                            >
                              {slot}
                            </span>
                          ) : null}

                          <Button
                            type="button"
                            variant="bare"
                            onClick={() => toggleFavourite(model.id)}
                            aria-pressed={starred}
                            aria-label={`${starred ? "Remove" : "Add"} ${model.label} ${starred ? "from" : "to"} favourites`}
                            className={cn(
                              "shrink-0 rounded p-0.5 transition-opacity",
                              starred
                                ? "text-warning"
                                : "text-tertiary opacity-0 hover:text-secondary focus-visible:opacity-100 group-hover/row:opacity-100",
                            )}
                          >
                            <Star size={13} className={starred ? "fill-current" : undefined} />
                          </Button>
                        </div>
                      );
                    })}
                  </section>
                ))}
              </div>
            </>
          ) : null}

          {/* Reserved height: the footer is the one line here whose content
              arrives late (a ledger refresh, a failed default write), and the
              popover must not resize under the pointer when it does. */}
          {footer.length > 0 || persistError ? (
            <p
              className={cn(
                "flex min-h-7 items-center border-t border-subtle px-2.5 text-xs",
                persistError ? "text-error" : "text-tertiary",
              )}
              role={persistError ? "alert" : undefined}
              {...(metaDetail && !persistError ? { "data-tooltip": metaDetail } : {})}
            >
              {footer}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const ModelPicker = memo(ModelPickerImpl);
