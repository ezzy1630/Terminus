/**
 * Terminus Desktop — Theme + density store.
 *
 * Per SPEC §24: "Support System theme, Light theme, Dark theme, Spacious
 * density, Compact density." The task-centered desktop defaults to compact. Theme and
 * density changes should not require restart."
 *
 * Per SPEC §22: "Respect Reduce Motion."
 *
 * CSS owns every token. This store only resolves the user's preference,
 * updates document attributes, and persists the selection.
 */
import { create } from "zustand";
import type { Density, Theme } from "../types";

const STORAGE_KEY = "terminus-desktop.theme.v2";

interface PersistedTheme {
  theme: Theme;
  density: Density;
}

const DEFAULT_APPEARANCE: PersistedTheme = { theme: "system", density: "compact" };

/** null when the payload is missing or unreadable, so callers can tell the two apart. */
function parsePersisted(raw: string | null): PersistedTheme | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Partial<PersistedTheme>;
    const theme: Theme =
      p.theme === "light" || p.theme === "dark" || p.theme === "system" ? p.theme : "system";
    const density: Density = p.density === "spacious" ? "spacious" : "compact";
    return { theme, density };
  } catch {
    return null;
  }
}

/** null when nothing is stored, so the native shell can be asked instead. */
function readPersisted(): PersistedTheme | null {
  if (typeof window === "undefined") return null;
  return parsePersisted(window.localStorage.getItem(STORAGE_KEY));
}

function writePersisted(state: PersistedTheme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

/** Resolve "system" theme to a concrete light/dark using prefers-color-scheme. */
function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyAppearance(resolved: "light" | "dark", density: Density): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.density = density;
  root.style.colorScheme = resolved;
}

function applyNativeTheme(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    void window.terminusDesktop?.setTheme(theme).catch(() => undefined);
  } catch {
    // Renderer tokens remain authoritative when the native bridge is absent.
  }
}

// ────────────────────────── Store ──────────────────────────────────────────

interface ThemeState {
  theme: Theme;
  density: Density;
  /** Resolved (concrete) theme — "light" | "dark", never "system". */
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
  toggleDensity: () => void;
  cycleTheme: () => void;
  /** Re-apply tokens (called on system color-scheme change). */
  refresh: () => void;
}

const persistedAppearance = readPersisted();
const initial = persistedAppearance ?? DEFAULT_APPEARANCE;
const initialResolved = resolveTheme(initial.theme);
// Apply once at module load so first paint is correct.
applyAppearance(initialResolved, initial.density);
// With a stored choice the renderer is authoritative and pushes it down. With
// none, the shell already restored the user's choice from its own mirror and
// painted the window background with it before this document existed, so it
// is read rather than overwritten with "system" (see `adoptNativeTheme`).
if (persistedAppearance !== null) applyNativeTheme(initial.theme);

/**
 * Appearance is now edited in a separate Preferences window, so the store
 * that owns it lives in two renderers at once. localStorage broadcasts a
 * `storage` event to every other same-origin document when one of them
 * writes, which is exactly the signal needed: adopt the new appearance
 * without writing it back, so the two windows cannot ping-pong.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    // A payload we cannot read is not an instruction to reset the user's
    // appearance; keep what is already applied.
    const remote = parsePersisted(event.newValue);
    if (remote === null) return;
    const resolved = resolveTheme(remote.theme);
    applyAppearance(resolved, remote.density);
    useThemeStore.setState({ theme: remote.theme, density: remote.density, resolved });
  });
}

// Listen for system color-scheme changes when theme === "system".
if (typeof window !== "undefined" && window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", () => {
    const s = useThemeStore.getState();
    if (s.theme === "system") {
      const r = resolveTheme("system");
      applyAppearance(r, s.density);
      useThemeStore.setState({ resolved: r });
    }
  });
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initial.theme,
  density: initial.density,
  resolved: initialResolved,
  setTheme: (t) => {
    const r = resolveTheme(t);
    applyAppearance(r, get().density);
    set({ theme: t, resolved: r });
    writePersisted({ theme: t, density: get().density });
    applyNativeTheme(t);
  },
  setDensity: (d) => {
    applyAppearance(get().resolved, d);
    set({ density: d });
    writePersisted({ theme: get().theme, density: d });
  },
  toggleDensity: () => {
    const d: Density = get().density === "spacious" ? "compact" : "spacious";
    applyAppearance(get().resolved, d);
    set({ density: d });
    writePersisted({ theme: get().theme, density: d });
  },
  cycleTheme: () => {
    const order: Theme[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(get().theme) + 1) % order.length] ?? "system";
    get().setTheme(next);
  },
  refresh: () => {
    const r = resolveTheme(get().theme);
    applyAppearance(r, get().density);
    set({ resolved: r });
  },
}));

/**
 * Read the native shell's theme at launch when this renderer has no stored
 * appearance of its own. Runs after the store exists so the adopted value can
 * be applied through the normal setter.
 */
function adoptNativeTheme(): void {
  const getTheme = typeof window === "undefined" ? undefined : window.terminusDesktop?.getTheme;
  if (!getTheme) return;
  void getTheme()
    .then((theme) => {
      if (theme === useThemeStore.getState().theme) return;
      useThemeStore.getState().setTheme(theme);
    })
    .catch(() => undefined);
}

if (persistedAppearance === null) adoptNativeTheme();

/**
 * Follow the shell when the system appearance changes.
 *
 * `prefers-color-scheme` alone misses the case that matters most on macOS: the
 * user choosing Light or Dark for *this app* from the menu. The shell reports
 * both its `themeSource` and the resolved value, so the two windows and the
 * native chrome cannot disagree.
 */
if (typeof window !== "undefined") {
  window.terminusDesktop?.onNativeThemeChange?.((state) => {
    const store = useThemeStore.getState();
    if (state.themeSource !== store.theme) {
      store.setTheme(state.themeSource);
      return;
    }
    // Same source, different resolution: the system flipped under "system".
    const resolved = state.shouldUseDarkColors ? "dark" : "light";
    if (resolved === store.resolved) return;
    applyAppearance(resolved, store.density);
    useThemeStore.setState({ resolved });
  });
}

/** Convenience selector hook. */
export function useTheme(): {
  theme: Theme;
  density: Density;
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
  toggleDensity: () => void;
  cycleTheme: () => void;
} {
  return useThemeStore();
}
