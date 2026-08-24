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

function readPersisted(): PersistedTheme {
  if (typeof window === "undefined") return { theme: "system", density: "compact" };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { theme: "system", density: "compact" };
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const p = parsed as Partial<PersistedTheme>;
      const theme: Theme =
        p.theme === "light" || p.theme === "dark" || p.theme === "system" ? p.theme : "system";
      const density: Density = p.density === "spacious" ? "spacious" : "compact";
      return { theme, density };
    }
  } catch {
    // ignore
  }
  return { theme: "system", density: "compact" };
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

const initial = readPersisted();
const initialResolved = resolveTheme(initial.theme);
// Apply once at module load so first paint is correct.
applyAppearance(initialResolved, initial.density);
applyNativeTheme(initial.theme);

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
