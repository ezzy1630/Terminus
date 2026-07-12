/**
 * Terminus Desktop — Theme + density store.
 *
 * Per SPEC §24: "Support System theme, Light theme, Dark theme, Spacious
 * density, Compact density. Spacious mode is the default. Theme and
 * density changes should not require restart."
 *
 * Per SPEC §22: "Respect Reduce Motion."
 *
 * Applies CSS variables to `document.documentElement` and persists to
 * `localStorage`. The tokens themselves come from
 * `src/styles/tokens.ts` — we just install the right token map per
 * (theme × density) combo.
 */
import { create } from "zustand";
import {
  compactTokens,
  darkTokens,
  lightTokens,
  motion,
  spaciousTokens,
  typography,
} from "../styles/tokens";
import type { Density, Theme } from "../types";

const STORAGE_KEY = "terminus-desktop.theme.v1";

interface PersistedTheme {
  theme: Theme;
  density: Density;
}

function readPersisted(): PersistedTheme {
  if (typeof window === "undefined") return { theme: "system", density: "spacious" };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { theme: "system", density: "spacious" };
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const p = parsed as Partial<PersistedTheme>;
      const theme: Theme =
        p.theme === "light" || p.theme === "dark" || p.theme === "system" ? p.theme : "system";
      const density: Density = p.density === "compact" ? "compact" : "spacious";
      return { theme, density };
    }
  } catch {
    // ignore
  }
  return { theme: "system", density: "spacious" };
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

function applyTokens(resolved: "light" | "dark", density: Density): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const colorTokens = resolved === "dark" ? darkTokens : lightTokens;
  const densityTokens = density === "spacious" ? spaciousTokens : compactTokens;
  for (const [k, v] of Object.entries(colorTokens)) root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(densityTokens)) root.style.setProperty(k, v);
  // Typography + motion constants.
  root.style.setProperty("--font-family", typography.fontFamily);
  root.style.setProperty("--font-family-mono", typography.fontFamilyMono);
  root.style.setProperty("--font-size-xs", typography.fontSizeXs);
  root.style.setProperty("--font-size-sm", typography.fontSizeSm);
  root.style.setProperty("--font-size-base", typography.fontSizeBase);
  root.style.setProperty("--font-size-md", typography.fontSizeMd);
  root.style.setProperty("--font-size-lg", typography.fontSizeLg);
  root.style.setProperty("--font-size-xl", typography.fontSizeXl);
  root.style.setProperty("--font-size-2xl", typography.fontSize2xl);
  root.style.setProperty("--font-size-3xl", typography.fontSize3xl);
  root.style.setProperty("--line-height-tight", String(typography.lineHeightTight));
  root.style.setProperty("--line-height-normal", String(typography.lineHeightNormal));
  root.style.setProperty("--line-height-relaxed", String(typography.lineHeightRelaxed));
  root.style.setProperty("--duration-fast", motion.durationFast);
  root.style.setProperty("--duration-normal", motion.durationNormal);
  root.style.setProperty("--duration-slow", motion.durationSlow);
  root.style.setProperty("--easing-default", motion.easingDefault);
  root.style.setProperty("--easing-spring", motion.easingSpring);
  // Reflect theme for native form controls + Electron vibrancy.
  root.dataset.theme = resolved;
  root.dataset.density = density;
  root.style.colorScheme = resolved;
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
applyTokens(initialResolved, initial.density);

// Listen for system color-scheme changes when theme === "system".
if (typeof window !== "undefined" && window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", () => {
    const s = useThemeStore.getState();
    if (s.theme === "system") {
      const r = resolveTheme("system");
      applyTokens(r, s.density);
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
    applyTokens(r, get().density);
    set({ theme: t, resolved: r });
    writePersisted({ theme: t, density: get().density });
  },
  setDensity: (d) => {
    applyTokens(get().resolved, d);
    set({ density: d });
    writePersisted({ theme: get().theme, density: d });
  },
  toggleDensity: () => {
    const d: Density = get().density === "spacious" ? "compact" : "spacious";
    applyTokens(get().resolved, d);
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
    applyTokens(r, get().density);
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
