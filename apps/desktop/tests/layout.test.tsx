/**
 * Terminus Desktop — Layout tests (SPEC §29 — required test scenarios).
 *
 * Coverage:
 *   1. Layout renders sidebar, main, inspector, and terminal drawer.
 *   2. Sidebar collapses (rail mode at < 700px; narrow token at < 1100px).
 *   3. Inspector is a floating card and becomes a wider overlay at < 900px.
 *   4. ⌘` toggles the terminal drawer.
 *
 * The breakpoints live in `hooks/use-viewport.ts` (1100 / 900 / 700).
 * We resize `window.innerWidth` and dispatch a `resize` event to flip
 * between layouts.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";

import { Layout } from "../src/components/Layout";
import { ResizableReviewLayout } from "../src/components/ResizableReviewLayout";

// ────────────────────────── Helpers ─────────────────────────────────────────

function setViewport(width: number, height: number = 800): void {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    writable: true,
    configurable: true,
    value: height,
  });
  window.dispatchEvent(new Event("resize"));
}

function renderLayout(): {
  unmount: () => void;
} {
  const sidebar: ReactNode = (
    <div data-testid="sidebar-content" style={{ height: "100%" }}>
      Sidebar
    </div>
  );
  const main: ReactNode = <div data-testid="main-content">Main</div>;
  const inspector: ReactNode = <div data-testid="inspector-content">Inspector</div>;

  const { unmount } = render(
    <Layout sidebar={sidebar} main={main} inspector={inspector} />,
  );
  return { unmount };
}

// ────────────────────────── Setup / teardown ────────────────────────────────

beforeEach(() => {
  // Default to a comfortable wide viewport for each test.
  setViewport(1400, 900);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// ────────────────────────── 1. Three-region render ──────────────────────────

describe("Layout — three-region render", () => {
  test("renders sidebar, main, and inspector content", () => {
    renderLayout();
    expect(screen.getByTestId("sidebar-content")).toBeInTheDocument();
    expect(screen.getByTestId("main-content")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-content")).toBeInTheDocument();
  });

  test("renders a native title bar with the application name in the center", () => {
    renderLayout();
    // The default center slot shows the "Terminus" product name.
    expect(screen.getByText("Terminus")).toBeInTheDocument();
  });

  test("renders a terminal toggle button in the title bar", () => {
    renderLayout();
    const toggle = screen.getByRole("button", { name: /Show terminal/i });
    expect(toggle).toBeInTheDocument();
  });

  test("terminal drawer is hidden by default", () => {
    renderLayout();
    // No terminal region is rendered until the drawer is opened.
    expect(screen.queryByRole("region", { name: "Terminal drawer" })).toBeNull();
  });

  test("clicking the terminal toggle opens the drawer", () => {
    renderLayout();
    const toggle = screen.getByRole("button", { name: /Show terminal/i });
    fireEvent.click(toggle);
    // After opening, the toggle's accessible name flips to "Hide terminal"
    // and the drawer region appears.
    expect(screen.getByRole("button", { name: /Hide terminal/i })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Terminal drawer" })).toBeInTheDocument();
  });
});

// ────────────────────────── 2. Sidebar collapses at narrow widths ───────────

describe("Layout — sidebar responsive collapse", () => {
  test("at width ≥ 1100px, the sidebar uses the full sidebar-width token", () => {
    setViewport(1400, 900);
    renderLayout();
    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside!.getAttribute("style") ?? "").toContain("var(--sidebar-width)");
  });

  test("at width < 1100px, the sidebar uses the compact-width token", () => {
    setViewport(1000, 900);
    renderLayout();
    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
    const style = aside!.getAttribute("style") ?? "";
    expect(style).toContain("var(--sidebar-width-compact)");
    expect(style).not.toContain("var(--sidebar-width)");
  });

  test("at width < 700px, the sidebar collapses to a 56px rail", () => {
    setViewport(600, 900);
    renderLayout();
    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
    const style = aside!.getAttribute("style") ?? "";
    // The rail is a numeric 56px width (not a CSS variable).
    expect(style).toMatch(/width:\s*56px/);
  });
});

// ────────────────────────── 3. Inspector becomes overlay ────────────────────

describe("Layout — floating inspector", () => {
  test("at width ≥ 900px, the inspector floats while reserving conversation width", () => {
    setViewport(1200, 900);
    renderLayout();
    expect(screen.getByTestId("inspector-float")).toHaveAttribute("data-layout", "floating");
    expect(screen.getByTestId("main-content").parentElement?.parentElement).toHaveStyle({
      paddingRight: "calc(var(--inspector-width) + 32px)",
    });
  });

  test("at width < 900px, the inspector becomes an absolutely-positioned overlay", () => {
    setViewport(800, 900);
    renderLayout();
    expect(screen.getByTestId("inspector-float")).toHaveAttribute("data-layout", "overlay");
    expect(screen.getByTestId("main-content").parentElement?.parentElement).not.toHaveStyle({
      paddingRight: "calc(var(--inspector-width) + 32px)",
    });
  });
});

// ────────────────────────── 4. ⌘` toggles terminal ──────────────────────────

describe("Layout — ⌘` keyboard shortcut", () => {
  test("pressing ⌘` opens the terminal drawer", () => {
    renderLayout();
    expect(screen.queryByRole("region", { name: "Terminal drawer" })).toBeNull();
    fireEvent.keyDown(window, { key: "`", metaKey: true });
    expect(screen.queryByRole("region", { name: "Terminal drawer" })).toBeInTheDocument();
  });

  test("pressing ⌘` again closes the drawer", () => {
    renderLayout();
    fireEvent.keyDown(window, { key: "`", metaKey: true });
    expect(screen.queryByRole("region", { name: "Terminal drawer" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "`", metaKey: true });
    expect(screen.queryByRole("region", { name: "Terminal drawer" })).toBeNull();
  });

  test("ctrl+` also toggles the drawer (cross-platform)", () => {
    renderLayout();
    fireEvent.keyDown(window, { key: "`", ctrlKey: true });
    expect(screen.queryByRole("region", { name: "Terminal drawer" })).toBeInTheDocument();
  });

  test("a plain ` (without modifier) does NOT open the drawer", () => {
    renderLayout();
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.queryByRole("region", { name: "Terminal drawer" })).toBeNull();
  });
});

describe("Layout — terminal expansion", () => {
  test("expands into the working area and collapses without losing the drawer", () => {
    renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Show terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Terminal drawer" })).toHaveStyle({ height: "856px" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
  });
});

describe("ResizableReviewLayout", () => {
  test("supports keyboard resizing and persists the preferred split", () => {
    render(
      <ResizableReviewLayout
        conversation={<div>Conversation</div>}
        review={<div>Review</div>}
      />,
    );
    const separator = screen.getByRole("separator", { name: "Resize conversation and review panes" });
    expect(separator).toHaveAttribute("aria-valuenow", "47");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "49");
    expect(window.localStorage.getItem("terminus-desktop.review-split.v1")).toBe("49");
  });

  test("clamps keyboard resizing so both panes remain usable", () => {
    window.localStorage.setItem("terminus-desktop.review-split.v1", "68");
    render(
      <ResizableReviewLayout
        conversation={<div>Conversation</div>}
        review={<div>Review</div>}
      />,
    );
    const separator = screen.getByRole("separator", { name: "Resize conversation and review panes" });
    fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });
    expect(separator).toHaveAttribute("aria-valuenow", "68");
  });
});
