/**
 * The accent colour.
 *
 * Terminus drew its accent as #79a6f6 — a pastel of the macOS system blue,
 * lighter than anything the platform paints. Against the charcoal base every
 * accented control read as washed out and slightly foreign. The accent is now
 * Apple's system blue, with hover, pressed and selection derived from it so a
 * future change carries to all of them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const THEME = readFileSync(resolve(process.cwd(), "src/styles/theme.css"), "utf8");

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

function contrast(left: string, right: string): number {
  const [a, b] = [luminance(left), luminance(right)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

describe("the accent token", () => {
  test("is Apple system blue in both schemes", () => {
    expect(THEME).toContain("--accent: #0A84FF;");
    expect(THEME).toContain("--accent: #007AFF;");
    expect(THEME).not.toContain("#79a6f6;\n  --accent-dim");
  });

  test("derives hover, pressed and selection rather than hard-coding them", () => {
    for (const token of ["--accent-hover", "--accent-pressed", "--accent-selection"]) {
      const declarations = THEME.split("\n").filter((line) => line.includes(`${token}:`));
      expect(declarations.length).toBeGreaterThan(0);
      for (const line of declarations) expect(line).toContain("var(--accent)");
    }
  });

  test("focus follows the accent instead of keeping the retired blue", () => {
    expect(THEME).not.toContain("--focus-color: #79a6f6");
    expect(THEME).not.toContain("--focus-color: #356fd6");
  });
});

describe("contrast on the charcoal base", () => {
  // Accent-coloured text and glyphs sit on these three surfaces.
  test("clears WCAG AA for body text on canvas, elevated and sidebar", () => {
    expect(contrast("#0A84FF", "#131417")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#0A84FF", "#1a1c20")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#0A84FF", "#0d0e10")).toBeGreaterThanOrEqual(4.5);
  });

  test("clears the 3:1 UI-component threshold for a filled control in light mode", () => {
    expect(contrast("#007AFF", "#ffffff")).toBeGreaterThanOrEqual(3);
  });
});
