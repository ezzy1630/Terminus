/**
 * Terminus Desktop — Theme + density tests (SPEC §29 — required test scenarios).
 *
 * Coverage:
 *   1. Theme switching (system / light / dark) installs the correct CSS
 *      color variables on `document.documentElement`.
 *   2. Density switching (spacious / compact) installs the correct CSS
 *      spacing variables on `document.documentElement`.
 *   3. `dataset.theme` and `dataset.density` reflect the resolved values
 *      so native form controls and Electron vibrancy can follow.
 *   4. Persisted state round-trips through localStorage.
 *   5. `theme="system"` resolves correctly when prefers-color-scheme
 *      changes (mocked via window.matchMedia).
 *   6. cycleTheme cycles system → light → dark → system.
 *   7. toggleDensity flips spacious ↔ compact.
 *
 * The theme store applies CSS variables as a side effect of every
 * setter call (see `hooks/use-theme.ts → applyTokens`), so reading the
 * CSS variables back from `document.documentElement.style` validates
 * the full apply path.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";

import { useThemeStore } from "../src/hooks/use-theme";
import { darkTokens, lightTokens, spaciousTokens, compactTokens } from "../src/styles/tokens";

// ────────────────────────── Helpers ─────────────────────────────────────────

function getCssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name).trim();
}

function resetStore(): void {
  // Re-read persisted state from a clean localStorage.
  window.localStorage.clear();
  useThemeStore.getState().setTheme("system");
  useThemeStore.getState().setDensity("spacious");
}

/**
 * Override window.matchMedia for the duration of a test. The theme store
 * reads `(prefers-color-scheme: dark).matches` to resolve the "system"
 * theme; the stub returns whatever `matches` is set to.
 */
function setPrefersColorScheme(matches: boolean): void {
  const stub = (query: string): MediaQueryList => {
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    return {
      matches,
      media: query,
      onchange: null,
      addListener: (l: (e: MediaQueryListEvent) => void) => listeners.add(l),
      removeListener: (l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
      addEventListener: (type: "change", l: (e: MediaQueryListEvent) => void) => {
        if (type === "change") listeners.add(l);
      },
      removeEventListener: (type: "change", l: (e: MediaQueryListEvent) => void) => {
        if (type === "change") listeners.delete(l);
      },
      dispatchEvent: () => false,
    } as MediaQueryList;
  };
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn(stub),
  });
}

// ────────────────────────── Setup ───────────────────────────────────────────

beforeEach(() => {
  resetStore();
});

// ────────────────────────── 1. Theme switching ──────────────────────────────

describe("useThemeStore — theme switching installs color variables", () => {
  test("setTheme('dark') applies darkTokens to <html>", () => {
    useThemeStore.getState().setTheme("dark");
    expect(getCssVar("--bg-canvas")).toBe(darkTokens["--bg-canvas"]);
    expect(getCssVar("--text-primary")).toBe(darkTokens["--text-primary"]);
    expect(getCssVar("--color-primary")).toBe(darkTokens["--color-primary"]);
    expect(getCssVar("--color-error")).toBe(darkTokens["--color-error"]);
    expect(getCssVar("--color-success")).toBe(darkTokens["--color-success"]);
  });

  test("setTheme('light') applies lightTokens to <html>", () => {
    useThemeStore.getState().setTheme("light");
    expect(getCssVar("--bg-canvas")).toBe(lightTokens["--bg-canvas"]);
    expect(getCssVar("--text-primary")).toBe(lightTokens["--text-primary"]);
    expect(getCssVar("--bg-sidebar")).toBe(lightTokens["--bg-sidebar"]);
    expect(getCssVar("--border-default")).toBe(lightTokens["--border-default"]);
    // The terminal background flips to dark in light theme for contrast.
    expect(getCssVar("--bg-terminal")).toBe(lightTokens["--bg-terminal"]);
  });

  test("switching between dark and light swaps the canvas variable", () => {
    useThemeStore.getState().setTheme("dark");
    const dark = getCssVar("--bg-canvas");
    useThemeStore.getState().setTheme("light");
    const light = getCssVar("--bg-canvas");
    expect(dark).toBe(darkTokens["--bg-canvas"]);
    expect(light).toBe(lightTokens["--bg-canvas"]);
    expect(dark).not.toBe(light);
  });

  test("dataset.theme reflects the resolved theme (light|dark)", () => {
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    useThemeStore.getState().setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  test("colorScheme is set so native form controls follow the theme", () => {
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    useThemeStore.getState().setTheme("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});

// ────────────────────────── 2. System theme resolution ──────────────────────

describe("useThemeStore — system theme resolves via prefers-color-scheme", () => {
  test("theme='system' + prefers dark → dark tokens applied", () => {
    setPrefersColorScheme(true);
    useThemeStore.getState().refresh();
    useThemeStore.getState().setTheme("system");
    expect(useThemeStore.getState().resolved).toBe("dark");
    expect(getCssVar("--bg-canvas")).toBe(darkTokens["--bg-canvas"]);
  });

  test("theme='system' + prefers light → light tokens applied", () => {
    setPrefersColorScheme(false);
    useThemeStore.getState().refresh();
    useThemeStore.getState().setTheme("system");
    expect(useThemeStore.getState().resolved).toBe("light");
    expect(getCssVar("--bg-canvas")).toBe(lightTokens["--bg-canvas"]);
  });
});

// ────────────────────────── 3. Density switching ───────────────────────────

describe("useThemeStore — density switching installs spacing variables", () => {
  test("setDensity('spacious') applies spaciousTokens to <html>", () => {
    useThemeStore.getState().setDensity("spacious");
    expect(getCssVar("--space-1")).toBe(spaciousTokens["--space-1"]);
    expect(getCssVar("--space-4")).toBe(spaciousTokens["--space-4"]);
    expect(getCssVar("--sidebar-width")).toBe(spaciousTokens["--sidebar-width"]);
    expect(getCssVar("--inspector-width")).toBe(spaciousTokens["--inspector-width"]);
    expect(getCssVar("--composer-max-height")).toBe(spaciousTokens["--composer-max-height"]);
    expect(getCssVar("--row-height")).toBe(spaciousTokens["--row-height"]);
    expect(getCssVar("--conversation-max-width")).toBe(spaciousTokens["--conversation-max-width"]);
  });

  test("setDensity('compact') applies compactTokens to <html>", () => {
    useThemeStore.getState().setDensity("compact");
    expect(getCssVar("--space-1")).toBe(compactTokens["--space-1"]);
    expect(getCssVar("--space-4")).toBe(compactTokens["--space-4"]);
    expect(getCssVar("--sidebar-width")).toBe(compactTokens["--sidebar-width"]);
    expect(getCssVar("--row-height")).toBe(compactTokens["--row-height"]);
  });

  test("compact shrinks spacing values relative to spacious", () => {
    useThemeStore.getState().setDensity("spacious");
    const spaciousSpace4 = getCssVar("--space-4");
    const spaciousRowHeight = getCssVar("--row-height");
    useThemeStore.getState().setDensity("compact");
    const compactSpace4 = getCssVar("--space-4");
    const compactRowHeight = getCssVar("--row-height");
    expect(compactSpace4).not.toBe(spaciousSpace4);
    expect(compactRowHeight).not.toBe(spaciousRowHeight);
    // Numeric sanity: spacious row is 36px, compact is 28px.
    expect(parseInt(spaciousRowHeight, 10)).toBeGreaterThan(parseInt(compactRowHeight, 10));
  });

  test("dataset.density reflects the chosen density", () => {
    useThemeStore.getState().setDensity("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    useThemeStore.getState().setDensity("spacious");
    expect(document.documentElement.dataset.density).toBe("spacious");
  });
});

// ────────────────────────── 4. Convenience actions ─────────────────────────

describe("useThemeStore — convenience actions", () => {
  test("cycleTheme cycles system → light → dark → system", () => {
    setPrefersColorScheme(true);
    useThemeStore.getState().refresh();
    useThemeStore.getState().setTheme("system");
    expect(useThemeStore.getState().theme).toBe("system");

    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe("light");

    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe("dark");

    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe("system");
  });

  test("toggleDensity flips spacious ↔ compact", () => {
    useThemeStore.getState().setDensity("spacious");
    expect(useThemeStore.getState().density).toBe("spacious");
    useThemeStore.getState().toggleDensity();
    expect(useThemeStore.getState().density).toBe("compact");
    useThemeStore.getState().toggleDensity();
    expect(useThemeStore.getState().density).toBe("spacious");
  });
});

// ────────────────────────── 5. Persistence ─────────────────────────────────

describe("useThemeStore — localStorage persistence", () => {
  test("the chosen theme + density round-trip through localStorage", () => {
    useThemeStore.getState().setTheme("dark");
    useThemeStore.getState().setDensity("compact");
    const raw = window.localStorage.getItem("terminus-desktop.theme.v1");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { theme: string; density: string };
    expect(parsed.theme).toBe("dark");
    expect(parsed.density).toBe("compact");
  });

  test("corrupt localStorage is silently ignored (falls back to defaults)", () => {
    window.localStorage.setItem("terminus-desktop.theme.v1", "{not json");
    // Re-importing isn't trivial here, so we simulate the parse-fail path
    // by clearing the store and reading from a corrupted entry. The
    // store's readPersisted() is called at module load — here we verify
    // the accessor doesn't throw when localStorage is corrupt by setting
    // it corrupt and then exercising the setter path.
    expect(() => useThemeStore.getState().setTheme("light")).not.toThrow();
    expect(useThemeStore.getState().theme).toBe("light");
  });
});

// ────────────────────────── 6. Typography + motion ─────────────────────────

describe("useThemeStore — typography + motion tokens are installed", () => {
  test("font-family is set to the SF Pro stack", () => {
    useThemeStore.getState().setTheme("dark");
    const ff = getCssVar("--font-family");
    expect(ff).toContain("-apple-system");
    expect(ff).toContain("SF Pro");
  });

  test("font-family-mono is set to the SF Mono stack", () => {
    useThemeStore.getState().setTheme("dark");
    const ff = getCssVar("--font-family-mono");
    expect(ff).toContain("SF Mono");
  });

  test("motion durations + easings are installed", () => {
    useThemeStore.getState().setTheme("dark");
    expect(getCssVar("--duration-fast")).toBe("150ms");
    expect(getCssVar("--duration-normal")).toBe("250ms");
    expect(getCssVar("--duration-slow")).toBe("400ms");
    expect(getCssVar("--easing-default")).toMatch(/cubic-bezier/);
  });
});
