import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useThemeStore } from "../src/hooks/use-theme";

const themeCss = readFileSync(resolve(process.cwd(), "src/styles/theme.css"), "utf8");
const globalsCss = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");

function cssBlock(marker: string): string {
  const start = themeCss.indexOf(marker);
  if (start < 0) throw new Error(`Missing CSS block: ${marker}`);
  const bodyStart = start + marker.length;
  const end = themeCss.indexOf("\n}", bodyStart);
  if (end < 0) throw new Error(`Unterminated CSS block: ${marker}`);
  return themeCss.slice(bodyStart, end);
}

function hexToken(block: string, token: string): string {
  const match = block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`Missing hex token: ${token}`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(left: string, right: string): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (Math.max(leftLuminance, rightLuminance) + 0.05)
    / (Math.min(leftLuminance, rightLuminance) + 0.05);
}

function resetStore(): void {
  window.localStorage.clear();
  useThemeStore.getState().setTheme("system");
  useThemeStore.getState().setDensity("spacious");
}

function setPrefersColorScheme(matches: boolean): void {
  const stub = (query: string): MediaQueryList => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn(stub),
  });
}

beforeEach(resetStore);

describe("CSS-first theme", () => {
  test("defines complete default tokens without renderer JavaScript", () => {
    expect(themeCss).toContain(":root {");
    expect(themeCss).toContain("--bg-canvas: #0d0d0f");
    expect(themeCss).toContain("--text-primary: #ededee");
    expect(themeCss).toContain("--font-size-base: 13px");
    expect(themeCss).toContain("--duration-normal: 180ms");
  });

  test("defines explicit light, dark, system, and compact selectors", () => {
    expect(themeCss).toContain("@media (prefers-color-scheme: light)");
    expect(themeCss).toContain('[data-theme="light"]');
    expect(themeCss).toContain('[data-theme="dark"]');
    expect(themeCss).toContain('[data-density="compact"]');
  });

  test("publishes semantic Tailwind v4 theme mappings", () => {
    expect(themeCss).toContain("@theme inline");
    expect(themeCss).toContain("--color-warning: var(--semantic-warning)");
    expect(themeCss).toContain("--color-diff: var(--bg-diff)");
    expect(themeCss).toContain("--color-on-accent: var(--text-on-accent)");
    expect(themeCss).toContain("--color-action-primary: var(--action-primary)");
    // Every floating surface relies on these. Without them `z-popover` compiled
    // to nothing and menus rendered behind the composer.
    for (const layer of ["popover", "tooltip", "dialog", "select"]) {
      expect(themeCss).toContain(`--z-index-${layer}: var(--z-${layer})`);
    }
  });

  test("keeps code text legible on the dark terminal surface in both themes", () => {
    expect(themeCss).toContain("--bg-terminal: #1b1b19");
    expect(themeCss).toContain("--text-code: #eaeaec");
    expect(themeCss.match(/--text-code: #ececea/g)).toHaveLength(2);
  });

  test("locks the type, control, radius, and motion scales", () => {
    for (const token of [
      "--font-size-xs: 11px",
      "--font-size-sm: 12px",
      "--font-size-base: 13px",
      "--font-size-md: 14px",
      "--font-size-body: 14px",
      "--font-size-title: 15px",
      "--font-size-display: 20px",
      "--font-size-display-large: 22px",
      "--control-sm: 24px",
      "--control-md: 28px",
      "--control-lg: 32px",
      "--radius-sm: 6px",
      "--radius-md: 8px",
      "--radius-lg: 10px",
      "--radius-xl: 12px",
      "--duration-fast: 120ms",
      "--duration-normal: 180ms",
      "--duration-slow: 260ms",
    ]) {
      expect(themeCss).toContain(token);
    }
  });

  test("keeps tertiary and placeholder text at WCAG AA contrast on supported surfaces", () => {
    const themes = [cssBlock(":root {"), cssBlock('[data-theme="light"] {')];
    for (const theme of themes) {
      const foregrounds = [hexToken(theme, "--text-tertiary"), hexToken(theme, "--text-placeholder")];
      const backgrounds = [
        hexToken(theme, "--bg-canvas"),
        hexToken(theme, "--bg-elevated"),
        hexToken(theme, "--bg-sidebar"),
        hexToken(theme, "--bg-card"),
        hexToken(theme, "--bg-hover"),
        hexToken(theme, "--bg-selected"),
      ];
      for (const foreground of foregrounds) {
        for (const background of backgrounds) {
          expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test("does not keep the renderer repainting continuous CSS animation", () => {
    // Narrowed from a blanket ban. A spinner that does not spin is not a
    // bounded transition, it is a broken affordance — .spinner set
    // border-top-color with no keyframes and rendered as a frozen ring, and
    // .skeleton carried overflow:hidden for a sweep that had no source.
    // Continuous animation is allowed only for marks that report ongoing
    // indeterminate work, and every one stays under the Reduce Motion gate.
    const continuous = new Set(
      [...globalsCss.matchAll(/animation:\s*([a-z-]+)[^;]*\binfinite\b/g)].map((match) => match[1]),
    );
    expect(continuous).toEqual(new Set());
    expect(globalsCss).toContain('html[data-reduce-motion="true"] *');
  });
});

describe("useThemeStore", () => {
  test("only selects theme and density attributes", () => {
    useThemeStore.getState().setTheme("dark");
    useThemeStore.getState().setDensity("compact");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.style.getPropertyValue("--bg-canvas")).toBe("");
  });

  test("sets colorScheme for native controls", () => {
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    useThemeStore.getState().setTheme("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  test("resolves the system appearance", () => {
    setPrefersColorScheme(true);
    useThemeStore.getState().setTheme("system");
    expect(useThemeStore.getState().resolved).toBe("dark");
    setPrefersColorScheme(false);
    useThemeStore.getState().refresh();
    expect(useThemeStore.getState().resolved).toBe("light");
  });

  test("cycles theme and density", () => {
    useThemeStore.getState().setTheme("system");
    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe("light");
    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe("dark");
    useThemeStore.getState().setDensity("spacious");
    useThemeStore.getState().toggleDensity();
    expect(useThemeStore.getState().density).toBe("compact");
  });

  test("persists theme and density", () => {
    useThemeStore.getState().setTheme("dark");
    useThemeStore.getState().setDensity("compact");
    expect(window.localStorage.getItem("terminus-desktop.theme.v3")).toBe(
      JSON.stringify({ theme: "dark", density: "compact" }),
    );
  });

  test("survives unavailable or corrupt storage", () => {
    window.localStorage.setItem("terminus-desktop.theme.v3", "{bad json");
    expect(() => useThemeStore.getState().setTheme("light")).not.toThrow();
  });
});
