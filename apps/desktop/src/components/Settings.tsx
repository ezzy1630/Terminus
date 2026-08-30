/**
 * Terminus Desktop — Settings.
 *
 * The language here is macOS System Settings: a category rail on the left, a
 * single scrolling pane on the right made of *groups* — a sentence-case title,
 * then rows closed top and bottom by hairlines. A row is a label on the left
 * and one control on the right. There are no boxed cards, because AppKit does
 * not draw them and a card grid is what made this surface read as a web
 * dashboard embedded in an app.
 *
 * The catalog used to describe twelve categories and roughly forty settings,
 * then discard nine of the categories one statement later — the shipping UI
 * was three categories and three editable rows, with ~430 lines of unreachable
 * descriptors, an unreachable shortcut recorder, and unreachable number/text
 * controls behind it. Everything that could never render is gone. What remains
 * is exactly what has somewhere to be written:
 *
 *   - Appearance  → theme + density (useThemeStore, localStorage + native IPC)
 *                   and reduce motion (useSettingsStore, localStorage).
 *   - Accounts    → connected accounts and the OpenCode gateway account.
 *   - Models      → model profiles current projects actually report.
 *   - Advanced    → local command-provider configuration.
 *   - Shortcuts   → a read-only reference. These are fixed in this build, so
 *                   they are rendered straight from the shortcut map and are
 *                   deliberately *not* settings-store entries: seeding
 *                   seventeen immutable values into a preferences store made
 *                   them look editable to every reader of that store.
 *
 * Appearance previews immediately. The store also listens for `storage`
 * events so a second Terminus window, if one is ever open, stays in step.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cpu, Keyboard, Palette, Search, SlidersHorizontal, Users, X, RotateCcw } from "lucide-react";
import { create } from "zustand";
import { cn } from "../lib/cn";
import { useThemeStore } from "../hooks/use-theme";
import { useModelInventory } from "../hooks/use-model-inventory";
import { EFFORT_LABELS, effortsFor, formatContext, formatPricePerMillion } from "../lib/models";
import { SETTINGS_SHORTCUTS, shortcutSettingValue } from "../lib/shortcuts";
import type { ShortcutScope } from "../lib/shortcuts";
import { api, createIdempotencyKey } from "../lib/api";
import type { Density, ProviderConfiguration, ProviderConfigurationResponse, Theme } from "../types";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Input, Textarea } from "../ui/Input";
import { Kbd } from "../ui/Kbd";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { DialogSurface } from "../ui/Dialog";
import { GatewayProviderSettings } from "./GatewayProviderSettings";
import { ProviderAccountSettings } from "./ProviderAccountSettings";

// ────────────────────────── Setting model ───────────────────────────────────

/**
 * Only the categories that exist.
 *
 * The union used to name twelve, nine of which no code path could ever
 * produce, so `settingsCategoryFor` in App.tsx could typecheck a request for a
 * page that was not in the build.
 */
import type { SettingCategoryId } from "../lib/settings-categories";
export type { SettingCategoryId };

export type SettingControl =
  | { kind: "toggle" }
  | { kind: "select"; options: Array<{ value: string; label: string }> };

export interface SettingDescriptor {
  id: string;
  /** Display label. */
  label: string;
  /** Longer description shown under the label. */
  description?: string;
  /** Control kind. */
  control: SettingControl;
  /** Default value (used by reset). */
  defaultValue: string | number | boolean;
  /**
   * Sentence-case group heading this row sits under, System Settings style.
   * Rows sharing a heading are drawn as one hairline-separated run.
   */
  group: string;
  /**
   * Side-effect hook called whenever the value changes. Use for appearance
   * preview, density, motion. A descriptor without one has nowhere to write,
   * which is why every surviving descriptor has one.
   */
  apply: (value: string | number | boolean) => void;
}

export interface SettingCategory {
  id: SettingCategoryId;
  label: string;
  description: string;
  icon: React.ReactNode;
  settings: SettingDescriptor[];
}

// ────────────────────────── Catalog ─────────────────────────────────────────

const CATEGORIES: SettingCategory[] = [
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme, density, and motion. Changes apply immediately.",
    icon: <Palette size={16} />,
    settings: [
      {
        id: "appearance.theme",
        label: "Theme",
        description: "System follows your macOS appearance.",
        group: "Theme",
        control: {
          kind: "select",
          options: [
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ],
        },
        defaultValue: "system",
        apply: (v) => useThemeStore.getState().setTheme(v as Theme),
      },
      {
        id: "appearance.density",
        label: "Density",
        description: "Spacious is the native default; Compact fits more rows.",
        group: "Theme",
        control: {
          kind: "select",
          options: [
            { value: "spacious", label: "Spacious" },
            { value: "compact", label: "Compact" },
          ],
        },
        defaultValue: "spacious",
        apply: (v) => useThemeStore.getState().setDensity(v as Density),
      },
      {
        id: "appearance.reduce-motion",
        label: "Reduce motion",
        description: "Disable non-essential animations.",
        group: "Accessibility",
        control: { kind: "toggle" },
        defaultValue: false,
        apply: (v) => {
          document.documentElement.dataset.reduceMotion = Boolean(v) ? "true" : "false";
        },
      },
    ],
  },
  {
    id: "accounts",
    label: "Accounts",
    description: "Connected provider accounts and their routing availability.",
    icon: <Users size={16} />,
    settings: [],
  },
  {
    id: "models",
    label: "Models",
    description: "Available models and the capabilities reported by each provider.",
    icon: <Cpu size={16} />,
    settings: [],
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "Local provider commands and low-level runtime configuration.",
    icon: <SlidersHorizontal size={16} />,
    settings: [],
  },
  {
    id: "shortcuts",
    label: "Keyboard Shortcuts",
    description: "Fixed in this build. Custom bindings are not available yet.",
    icon: <Keyboard size={16} />,
    settings: [],
  },
];

const SHORTCUT_GROUPS: ReadonlyArray<{ scope: ShortcutScope; title: string }> = [
  { scope: "global", title: "Anywhere in the app" },
  { scope: "composer", title: "While the composer is focused" },
  { scope: "diff", title: "While the diff viewer is focused" },
];

/**
 * Extra search terms per category.
 *
 * Operators look for "provider", "api key" or "model" — none of which is the
 * category's label ("Agents and Models") or its id. Shortcut labels are folded
 * in so searching "command palette" reaches the reference that lists it.
 */
const CATEGORY_KEYWORDS: Record<SettingCategoryId, string> = {
  accounts: "providers provider api key token gateway routing opencode zen connected accounts account chatgpt sign in disconnect default credentials",
  models: "model models reasoning effort context output tools images price inference",
  advanced: "local command provider program args arguments timeout tools raw gateway diagnostics",
  appearance: "theme dark light density spacing font motion animation accessibility",
  shortcuts: `keyboard keys bindings hotkeys ${SETTINGS_SHORTCUTS.map((s) => s.label).join(" ")}`.toLowerCase(),
};

// ────────────────────────── Settings store ──────────────────────────────────

const SETTINGS_KEY = "terminus-desktop.settings.v1";

type SettingValue = string | number | boolean;
type SettingValueMap = Record<string, SettingValue>;

/** null when the payload is missing or unreadable, so callers can tell the two apart. */
function parsePersisted(raw: string | null): SettingValueMap | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as SettingValueMap : null;
  } catch {
    return null;
  }
}

function readPersisted(): SettingValueMap {
  if (typeof window === "undefined") return {};
  return parsePersisted(window.localStorage.getItem(SETTINGS_KEY)) ?? {};
}

function writePersisted(values: SettingValueMap): void {
  if (typeof window === "undefined") return;
  try {
    // Theme and density have one owner: useThemeStore. Keeping a second
    // persisted copy here made lazily opening Settings restore stale values.
    const rendererOnly = Object.fromEntries(
      Object.entries(values).filter(([id]) => id !== "appearance.theme" && id !== "appearance.density"),
    );
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(rendererOnly));
  } catch {
    // ignore
  }
}

function defaultValues(): SettingValueMap {
  const out: SettingValueMap = {};
  for (const cat of CATEGORIES) {
    for (const s of cat.settings) {
      out[s.id] = s.defaultValue;
    }
  }
  return out;
}

function findDescriptor(id: string): SettingDescriptor | undefined {
  for (const cat of CATEGORIES) {
    const s = cat.settings.find((x) => x.id === id);
    if (s) return s;
  }
  return undefined;
}

function normalizeSettingValue(id: string, value: unknown): SettingValue {
  const descriptor = findDescriptor(id);
  if (!descriptor) return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "";
  const control = descriptor.control;
  if (control.kind === "toggle") return typeof value === "boolean" ? value : descriptor.defaultValue;
  return typeof value === "string" && control.options.some((option) => option.value === value)
    ? value
    : descriptor.defaultValue;
}

function normalizedPersistedValues(raw: SettingValueMap): SettingValueMap {
  const values: SettingValueMap = {};
  for (const [id, value] of Object.entries(raw)) {
    if (id === "appearance.theme" || id === "appearance.density") continue;
    if (findDescriptor(id)) values[id] = normalizeSettingValue(id, value);
  }
  return values;
}

interface SettingsState {
  values: SettingValueMap;
  get: (id: string) => SettingValue | undefined;
  set: (id: string, value: SettingValue) => void;
  reset: (id: string) => void;
  resetCategory: (categoryId: SettingCategoryId) => void;
}

const persisted = readPersisted();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  values: { ...defaultValues(), ...normalizedPersistedValues(persisted) },
  get: (id) => get().values[id],
  set: (id, value) => {
    const normalized = normalizeSettingValue(id, value);
    set((state) => {
      const next = { ...state.values, [id]: normalized };
      writePersisted(next);
      return { values: next };
    });
    // Apply side-effects (theme/density/motion live preview).
    findDescriptor(id)?.apply(normalized);
  },
  reset: (id) => {
    const descriptor = findDescriptor(id);
    if (!descriptor) return;
    get().set(id, descriptor.defaultValue);
  },
  resetCategory: (categoryId) => {
    const cat = CATEGORIES.find((c) => c.id === categoryId);
    if (!cat) return;
    for (const s of cat.settings) {
      get().set(s.id, s.defaultValue);
    }
  },
}));

/**
 * Settings are a sheet inside the document window, but localStorage is shared
 * by every renderer of this app. A `storage` event means another window
 * saved: re-read what it wrote and re-apply the live side effects, so a
 * change to motion takes hold here too. Adopting the written value without
 * writing it back keeps two windows from echoing.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== SETTINGS_KEY) return;
    // A payload we cannot read is not an instruction to reset every
    // preference; keep what is already in effect.
    const remote = parsePersisted(event.newValue);
    if (remote === null) return;
    const next = { ...defaultValues(), ...normalizedPersistedValues(remote) };
    const previous = useSettingsStore.getState().values;
    useSettingsStore.setState({ values: next });
    for (const [id, value] of Object.entries(next)) {
      if (previous[id] === value) continue;
      findDescriptor(id)?.apply(value);
    }
  });
}

// Install every live preference once at module load so a persisted motion
// choice is true before Settings is ever opened. Theme and density are owned
// by useThemeStore, which installs itself.
for (const category of CATEGORIES) {
  for (const descriptor of category.settings) {
    if (descriptor.id === "appearance.theme" || descriptor.id === "appearance.density") continue;
    descriptor.apply(useSettingsStore.getState().get(descriptor.id) ?? descriptor.defaultValue);
  }
}

// ────────────────────────── Layout primitives ───────────────────────────────

/**
 * A System Settings group: sentence-case title, then a hairline-closed run of
 * rows. Top and bottom rules give the run its edges without drawing a card.
 */
function SettingGroup({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="mb-1.5 text-sm text-tertiary">{title}</h2>
      <div className="divide-y divide-[var(--border-subtle)] border-y border-subtle">{children}</div>
    </section>
  );
}

/**
 * One row: label (and optional sub-label) left, one control right, 40px tall.
 * `htmlFor` is honoured because every control below accepts an `id` — the
 * labels used to point at nothing, so clicking one did nothing and screen
 * readers fell back to the control's own `aria-label`.
 */
function Row({
  controlId,
  label,
  description,
  children,
}: {
  controlId?: string;
  label: string;
  description?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-10 items-center gap-4 py-1.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {controlId ? (
          <label htmlFor={controlId} className="ui-body text-primary">{label}</label>
        ) : (
          <span className="ui-body text-primary">{label}</span>
        )}
        {description ? <p className="ui-meta">{description}</p> : null}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

// ────────────────────────── Component ───────────────────────────────────────

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
  /** Render as the app's main Settings destination instead of a modal sheet. */
  surface?: boolean;
  /** Optional initial category to focus. */
  initialCategoryId?: SettingCategoryId;
  /**
   * Bumped by the host on every request to open Settings. Two consecutive
   * requests for the same category are still two requests, and the second one
   * has to put the pane back on that category.
   */
  categoryRequest?: number;
  className?: string;
}

function SettingsImpl({ open, onClose, surface = false, initialCategoryId, categoryRequest, className }: SettingsProps): JSX.Element {
  const [activeCat, setActiveCat] = useState<SettingCategoryId>(initialCategoryId ?? "appearance");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const modelInventory = useModelInventory();
  const modelGroups = useMemo(() => modelInventory.providers.map((provider) => ({
    provider,
    models: modelInventory.models.filter((model) => model.provider === provider.id),
  })).filter((group) => group.models.length > 0), [modelInventory.models, modelInventory.providers]);
  const [providerConfiguration, setProviderConfiguration] = useState<ProviderConfigurationResponse | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderConfiguration | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerLoading, setProviderLoading] = useState(false);
  // Three things used to reach for focus as this sheet appeared: Radix's own
  // focus trap, `useDialogFocus`'s first-focusable pass on the next frame, and
  // a `setTimeout` aimed at the search field. They landed in an order nothing
  // guaranteed, so the caret hopped between controls while the panel was still
  // animating. Radix owns the trap, the Escape key and focus restoration; this
  // component says only where focus should *start*, in the one callback Radix
  // provides for it.
  const focusSearchOnOpen = useCallback((event: Event): void => {
    event.preventDefault();
    inputRef.current?.focus();
  }, []);

  // A later request for a category has to move the pane even when the sheet is
  // already open and the operator has clicked elsewhere in it — hence the
  // nonce, rather than watching the category, which may not have changed.
  useEffect(() => {
    if (!open) return;
    setActiveCat(initialCategoryId ?? "appearance");
  }, [categoryRequest, initialCategoryId, open]);

  useEffect(() => {
    if (!open || activeCat !== "advanced") return;
    const controller = new AbortController();
    setProviderLoading(true);
    setProviderError(null);
    void api.getProviderConfiguration(controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      setProviderConfiguration(response);
      setProviderDraft(response.configuration ?? {
        program: "",
        args: [],
        model: "",
        timeout_seconds: 300,
        tools_enabled: false,
        revision: 0,
        updated_by: "",
        created_at: "",
        updated_at: "",
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setProviderError(error instanceof Error ? error.message : "Provider configuration could not be loaded.");
    }).finally(() => {
      if (!controller.signal.aborted) setProviderLoading(false);
    });
    return () => controller.abort();
  }, [activeCat, open]);

  const saveProviderConfiguration = useCallback(async (): Promise<void> => {
    if (providerDraft === null) return;
    if (providerDraft.program.trim().length === 0 || providerDraft.model.trim().length === 0) {
      setProviderError("Program and model are required.");
      return;
    }
    if (!Number.isSafeInteger(providerDraft.timeout_seconds) || providerDraft.timeout_seconds < 1 || providerDraft.timeout_seconds > 3_600) {
      setProviderError("Timeout must be a whole number between 1 and 3600 seconds.");
      return;
    }
    if (providerDraft.args.some((argument) => argument.length === 0)) {
      setProviderError("Arguments cannot contain a blank argv entry.");
      return;
    }
    setProviderSaving(true);
    setProviderError(null);
    try {
      const response = await api.putProviderConfiguration({
        program: providerDraft.program,
        args: providerDraft.args,
        model: providerDraft.model,
        timeout_seconds: providerDraft.timeout_seconds,
        tools_enabled: providerDraft.tools_enabled,
        expected_revision: providerDraft.revision,
      }, { idempotencyKey: createIdempotencyKey("provider-config") });
      setProviderConfiguration(response);
      setProviderDraft(response.configuration);
    } catch (error: unknown) {
      setProviderError(error instanceof Error ? error.message : "Provider configuration could not be saved.");
    } finally {
      setProviderSaving(false);
    }
  }, [providerDraft]);

  /**
   * Search across categories, not only across rows.
   *
   * The provider category holds no `settings` descriptors — its controls are
   * rendered directly — and the old filter dropped every category whose
   * `settings` list came back empty. Searching "provider", "model" or "api
   * key" therefore found nothing, in the one place those are configured.
   */
  const filteredCategories = useMemo(() => {
    if (!query.trim()) return CATEGORIES;
    const q = query.toLowerCase();
    return CATEGORIES.map((cat) => {
      const categoryMatches = [cat.label, cat.description, cat.id, CATEGORY_KEYWORDS[cat.id]]
        .some((value) => value.toLowerCase().includes(q));
      const settings = categoryMatches
        ? cat.settings
        : cat.settings.filter(
            (s) =>
              s.label.toLowerCase().includes(q) ||
              (s.description?.toLowerCase().includes(q) ?? false) ||
              s.id.includes(q),
          );
      return { category: { ...cat, settings }, keep: categoryMatches || settings.length > 0 };
    }).filter((entry) => entry.keep).map((entry) => entry.category);
  }, [query]);

  // Deliberately no `if (!open) return`. Radix takes `open={false}` as the cue
  // to play the sheet's exit and remove the portal afterwards; returning
  // nothing here took the sheet off screen on a single frame instead, so
  // Settings arrived with a rise and a fade and left like a dropped window.
  const activeCategory = filteredCategories.find((c) => c.id === activeCat) ?? filteredCategories[0] ?? null;
  // Grouped in declaration order so a group's rows stay adjacent.
  const groupedSettings: Array<{ title: string; rows: SettingDescriptor[] }> = [];
  for (const descriptor of activeCategory?.settings ?? []) {
    const bucket = groupedSettings.find((g) => g.title === descriptor.group);
    if (bucket) bucket.rows.push(descriptor);
    else groupedSettings.push({ title: descriptor.group, rows: [descriptor] });
  }

  const content = (
    <>
      <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-subtle px-4">
        <span className="ui-body font-semibold text-primary">Settings</span>
        {!surface ? <div className="ml-auto flex items-center gap-2">
          <IconButton onClick={onClose} label="Close settings" icon={<X size={14} aria-hidden />} />
        </div> : null}
      </div>
      <div className="settings-body flex min-h-0 flex-1">
        {/* Category rail. */}
        {/* The raw token, not `bg-sidebar`: that resolves to --sidebar-material,
            which window vibrancy makes 62% transparent. A floating sheet has to
            be opaque or the dimmed app shows through its rail. */}
        <aside className="settings-sidebar flex h-full w-[204px] flex-shrink-0 flex-col border-r border-subtle bg-[var(--bg-sidebar)]">
          <div className="px-2 py-2">
            <div className="relative flex items-center">
              <Search size={13} className="pointer-events-none absolute left-2 text-tertiary" aria-hidden />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search settings"
                className={cn("pl-7", query && "pr-7")}
              />
              {query ? (
                <IconButton
                  onClick={() => setQuery("")}
                  label="Clear search"
                  icon={<X size={11} aria-hidden />}
                  size="sm"
                  className="absolute right-0.5"
                />
              ) : null}
            </div>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" aria-label="Settings categories">
            {filteredCategories.map((cat) => {
              const isSel = cat.id === activeCategory?.id;
              return (
                <Button
                  key={cat.id}
                  onClick={() => setActiveCat(cat.id)}
                  aria-current={isSel}
                  variant="ghost"
                  className={cn(
                    "h-7 w-full justify-start gap-2 rounded-md px-2 text-left text-base font-normal",
                    isSel ? "bg-selected text-primary" : "text-secondary",
                  )}
                >
                  <span className={cn("flex-shrink-0", isSel ? "text-secondary" : "text-tertiary")} aria-hidden>
                    {cat.icon}
                  </span>
                  <span className="flex-1 truncate">{cat.label}</span>
                </Button>
              );
            })}
            {filteredCategories.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-tertiary">No settings match “{query}”.</p>
            ) : null}
          </nav>
        </aside>
        {/* Detail pane. */}
        <main className="scrollable min-w-0 flex-1 overflow-y-auto">
          <div className="settings-content mx-auto w-full max-w-[560px] px-6 py-5">
            {activeCategory ? (
              <>
                <header className="mb-5">
                  <h1 className="ui-page-title text-primary">{activeCategory.label}</h1>
                  <p className="ui-meta mt-1">{activeCategory.description}</p>
                </header>

                {groupedSettings.map((group) => (
                  <SettingGroup key={group.title} title={group.title}>
                    {group.rows.map((s) => <SettingRow key={s.id} descriptor={s} />)}
                  </SettingGroup>
                ))}

                {activeCategory.id === "appearance" && groupedSettings.length > 0 ? (
                  <Button
                    onClick={() => useSettingsStore.getState().resetCategory("appearance")}
                    variant="ghost"
                    size="sm"
                    leading={<RotateCcw size={11} aria-hidden />}
                  >
                    Reset appearance to defaults
                  </Button>
                ) : null}

                {activeCategory.id === "accounts" ? (
                  <>
                    <ProviderAccountSettings />
                    <GatewayProviderSettings />
                  </>
                ) : null}

                {activeCategory.id === "advanced" ? (
                    <SettingGroup title="Local command provider">
                      <Row
                        label="Status"
                        description="A local program Terminus runs for model requests. Arguments are passed directly, without a shell."
                      >
                        <span
                          className={cn(
                            "ui-body",
                            providerConfiguration?.configured === true ? "text-primary" : "text-tertiary",
                          )}
                        >
                          {providerLoading
                            ? "Checking…"
                            : providerConfiguration?.configured === true
                              ? "Configured"
                              : "Not configured"}
                        </span>
                      </Row>
                      {providerDraft ? (
                        <>
                          <Row controlId="local-provider-program" label="Program">
                            <Input
                              id="local-provider-program"
                              aria-label="Local provider program"
                              value={providerDraft.program}
                              onChange={(event) => setProviderDraft({ ...providerDraft, program: event.target.value })}
                              className="w-56 font-mono"
                            />
                          </Row>
                          <Row controlId="local-provider-model" label="Model">
                            <Input
                              id="local-provider-model"
                              aria-label="Local provider model"
                              value={providerDraft.model}
                              onChange={(event) => setProviderDraft({ ...providerDraft, model: event.target.value })}
                              className="w-56 font-mono"
                            />
                          </Row>
                          <Row controlId="local-provider-timeout" label="Timeout" description="Seconds before a request is abandoned.">
                            <Input
                              id="local-provider-timeout"
                              aria-label="Local provider timeout"
                              type="number"
                              min={1}
                              max={3600}
                              step={1}
                              value={providerDraft.timeout_seconds}
                              onChange={(event) => setProviderDraft({ ...providerDraft, timeout_seconds: Number(event.target.value) })}
                              className="w-20 tabular-nums"
                            />
                          </Row>
                          <Row
                            controlId="local-provider-tools"
                            label="Allow standalone tools"
                            description="Expose read, exact patch, and bounded exec for this task."
                          >
                            <Switch
                              id="local-provider-tools"
                              checked={providerDraft.tools_enabled}
                              onCheckedChange={(checked) => setProviderDraft({ ...providerDraft, tools_enabled: checked })}
                              label="Allow standalone provider tools"
                            />
                          </Row>
                          <div className="flex flex-col gap-2 py-2.5">
                            <label htmlFor="local-provider-args" className="ui-body text-primary">
                              Arguments
                              <span className="ui-meta ml-1.5">one argv entry per line</span>
                            </label>
                            <Textarea
                              id="local-provider-args"
                              aria-label="Local provider arguments"
                              className="min-h-16 font-mono"
                              value={providerDraft.args.join("\n")}
                              onChange={(event) => setProviderDraft({
                                ...providerDraft,
                                args: event.target.value.length === 0 ? [] : event.target.value.split("\n"),
                              })}
                            />
                            {providerError ? <p className="text-xs text-error" role="alert">{providerError}</p> : null}
                            <div>
                              <Button
                                onClick={() => void saveProviderConfiguration()}
                                disabled={providerSaving || providerLoading}
                                variant="secondary"
                                size="sm"
                              >
                                {providerSaving ? "Saving…" : "Save"}
                              </Button>
                            </div>
                          </div>
                        </>
                      ) : (
                        <Row label="Status">
                          <span className="ui-body text-tertiary">
                            {providerError ?? "No local provider command is configured."}
                          </span>
                        </Row>
                      )}
                    </SettingGroup>
                ) : null}

                {activeCategory.id === "models" ? (
                  <>
                    {modelGroups.map(({ provider, models }) => (
                      <SettingGroup key={provider.id} title={provider.label}>
                        {models.map((model) => {
                          const capabilities = [
                            effortsFor(model).length > 0
                              ? effortsFor(model).map((level) => EFFORT_LABELS[level].label).join(", ")
                              : model.reasoning ? "Fixed provider reasoning" : null,
                            formatContext(model.contextTokens) ? `${formatContext(model.contextTokens)} context` : null,
                            formatContext(model.outputTokens ?? 0) ? `${formatContext(model.outputTokens ?? 0)} output` : null,
                            model.toolCalling ? "Tools" : null,
                            model.structuredOutput ? "Structured output" : null,
                            model.imageInput ? "Images" : null,
                            model.parallelToolCalls ? "Parallel tools" : null,
                            model.free ? "Free" : formatPricePerMillion(model.inputCostMicros),
                          ].filter(Boolean);
                          return (
                            <Row key={`${provider.id}:${model.id}`} label={model.label} description={model.slug}>
                              <span className="ui-meta max-w-64 text-right leading-relaxed">
                                {capabilities.join(" · ") || "No capabilities reported"}
                              </span>
                            </Row>
                          );
                        })}
                      </SettingGroup>
                    ))}
                    {modelGroups.length === 0 ? (
                      <SettingGroup title="Available models">
                        <div className="flex items-center gap-3 py-2.5">
                          <p className="ui-meta min-w-0 flex-1">
                            {modelInventory.status === "loading"
                              ? "Checking connected providers…"
                              : modelInventory.error ?? "No connected provider reported a model."}
                          </p>
                          <Button variant="secondary" size="sm" onClick={modelInventory.refresh}>Check again</Button>
                        </div>
                      </SettingGroup>
                    ) : null}
                  </>
                ) : null}

                {activeCategory.id === "shortcuts"
                  ? SHORTCUT_GROUPS.map(({ scope, title }) => {
                      const rows = SETTINGS_SHORTCUTS.filter((shortcut) => shortcut.scope === scope);
                      if (rows.length === 0) return null;
                      return (
                        <SettingGroup key={scope} title={title}>
                          {rows.map((shortcut) => (
                            <Row key={shortcut.id} label={shortcut.label}>
                              {/* `title` here was a *browser* tooltip: white,
                                  square, on the OS's own delay, in a window
                                  that draws its own. */}
                              <output
                                aria-label={`Shortcut for ${shortcut.label}`}
                                data-tooltip={shortcutSettingValue(shortcut)}
                              >
                                <Kbd>{shortcut.display}</Kbd>
                              </output>
                            </Row>
                          ))}
                        </SettingGroup>
                      );
                    })
                  : null}
              </>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center text-center">
                <Search size={18} className="text-tertiary" aria-hidden />
                <h1 className="ui-page-title mt-2 text-primary">No matching settings</h1>
                <p className="ui-body mt-1 max-w-xs text-secondary">
                  Nothing matches “{query}”. Try another search or clear it to browse every category.
                </p>
                <Button onClick={() => setQuery("")} className="mt-4" variant="secondary">
                  Clear search
                </Button>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );

  if (surface) {
    return (
      <section aria-label="Settings" className={cn("flex h-full min-w-0 flex-col overflow-hidden bg-canvas text-primary", className)}>
        {content}
      </section>
    );
  }

  return (
    <DialogSurface
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      onOpenAutoFocus={focusSearchOnOpen}
      accessibleTitle="Settings"
      overlayClassName="bg-black/40"
      className={cn(
        "settings-dialog dialog-panel fixed left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-subtle bg-elevated text-primary shadow-lg",
        className,
      )}
      style={{
        width: "min(760px, calc(100vw - 64px))",
        height: "min(560px, calc(100vh - 64px))",
      }}
    >
      {content}
    </DialogSurface>
  );
}

export const Settings = memo(SettingsImpl);

// ────────────────────────── Setting row ─────────────────────────────────────

function SettingRow({ descriptor }: { descriptor: SettingDescriptor }): JSX.Element {
  const value = useSettingsStore((s) => s.values[descriptor.id]);
  const set = useSettingsStore((s) => s.set);
  const reset = useSettingsStore((s) => s.reset);
  const theme = useThemeStore((state) => state.theme);
  const density = useThemeStore((state) => state.density);
  const setTheme = useThemeStore((state) => state.setTheme);
  const setDensity = useThemeStore((state) => state.setDensity);

  // Theme and density read from their canonical store, not from this one.
  const current: SettingValue = descriptor.id === "appearance.theme"
    ? theme
    : descriptor.id === "appearance.density"
      ? density
      : value ?? descriptor.defaultValue;
  const controlId = `setting-${descriptor.id}`;

  const commit = useCallback(
    (next: SettingValue): void => {
      if (descriptor.id === "appearance.theme") setTheme(next as Theme);
      else if (descriptor.id === "appearance.density") setDensity(next as Density);
      else set(descriptor.id, next);
    },
    [descriptor, set, setDensity, setTheme],
  );

  return (
    <Row controlId={controlId} label={descriptor.label} description={descriptor.description}>
      {descriptor.control.kind === "toggle" ? (
        <Switch
          id={controlId}
          checked={Boolean(current)}
          onCheckedChange={commit}
          label={descriptor.label}
        />
      ) : (
        <Select
          id={controlId}
          value={String(current)}
          onValueChange={commit}
          label={descriptor.label}
          options={descriptor.control.options}
        />
      )}
      {current !== descriptor.defaultValue ? (
        <IconButton
          onClick={() => {
            if (descriptor.id === "appearance.theme") setTheme(descriptor.defaultValue as Theme);
            else if (descriptor.id === "appearance.density") setDensity(descriptor.defaultValue as Density);
            else reset(descriptor.id);
          }}
          label={`Reset ${descriptor.label} to default`}
          icon={<RotateCcw size={12} aria-hidden />}
          size="sm"
        />
      ) : null}
    </Row>
  );
}

// Re-export catalog for tests / external validation.
export const SETTING_CATEGORIES = CATEGORIES;
export type { SettingValue };
