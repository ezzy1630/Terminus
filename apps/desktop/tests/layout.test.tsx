/**
 * Terminus Desktop — Layout tests (SPEC §29 — required test scenarios).
 *
 * Coverage:
 *   1. Layout renders sidebar, main, and inspector.
 *   2. Sidebar and inspector stay docked at every supported desktop width.
 *   3. Both dock separators support keyboard resizing.
 *   4. Review mode responds to its measured container width.
 *
 * The native window enforces a 900px minimum width, so the renderer keeps a
 * stable desktop column model instead of switching to a phone/rail layout.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
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

function titlebarSidebarWidth(): string {
  const shell = document.querySelector(".titlebar-shell")?.parentElement;
  if (!(shell instanceof HTMLElement)) throw new Error("layout shell not found");
  return shell.style.getPropertyValue("--titlebar-sidebar-width");
}

// ────────────────────────── Setup / teardown ────────────────────────────────

beforeEach(() => {
  window.localStorage.clear();
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

  test("does not expose inert history controls", () => {
    renderLayout();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forward" })).not.toBeInTheDocument();
  });

  test("keeps the titlebar center in the native drag region", () => {
    render(<Layout sidebar={<div />} main={<div />} inspector={<div />} center={<span>Task title</span>} />);
    const center = screen.getByTestId("titlebar-center");
    expect(center).not.toHaveClass("titlebar-no-drag");
    expect(center).toHaveTextContent("Task title");
  });

});

// ────────────────────────── 2. Sidebar collapses at narrow widths ───────────

describe("Layout — sidebar responsive collapse", () => {
  test("can hide the sidebar without removing the main working surface", () => {
    render(
      <Layout
        sidebar={<div data-testid="hidden-sidebar">Sidebar</div>}
        sidebarVisible={false}
        main={<div data-testid="visible-main">Main</div>}
        inspector={<div>Inspector</div>}
      />,
    );
    expect(screen.queryByTestId("hidden-sidebar")).toBeNull();
    expect(screen.getByTestId("visible-main")).toBeInTheDocument();
    expect(titlebarSidebarWidth()).toBe("0px");
  });

  test("sidebar is a resizable dock at every supported width", () => {
    setViewport(900, 900);
    renderLayout();
    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside!.getAttribute("style") ?? "").toContain("width: 256px");
    expect(screen.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute("aria-valuenow", "256");
    expect(titlebarSidebarWidth()).toBe("256px");
  });

  test("sidebar does not become a rail at a narrow desktop width", () => {
    setViewport(900, 900);
    renderLayout();
    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside!.getAttribute("style") ?? "").toContain("width: 256px");
    expect(titlebarSidebarWidth()).toBe("256px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize sidebar" }), { key: "ArrowRight" });
    expect(screen.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute("aria-valuenow", "264");
  });
});

// ────────────────────────── 3. Inspector dock ───────────────────────────────

describe("Layout — docked inspector", () => {
  test("inspector is docked at the right edge", () => {
    setViewport(1200, 900);
    renderLayout();
    expect(screen.getByTestId("inspector-dock")).toHaveAttribute("data-layout", "docked");
    expect(screen.getByTestId("inspector-dock")).toHaveStyle({ width: "320px" });
    expect(screen.getByRole("separator", { name: "Resize inspector" })).toHaveAttribute("aria-valuenow", "320");
  });

  test("inspector supports keyboard resizing without an overlay", () => {
    setViewport(1200, 900);
    renderLayout();
    const separator = screen.getByRole("separator", { name: "Resize inspector" });
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "328");
    expect(screen.getByTestId("inspector-dock")).toHaveAttribute("data-layout", "docked");
  });

  test("reserves the main working surface when both stored docks are maximal", () => {
    window.localStorage.setItem("terminus-desktop.sidebar-width.v2", "320");
    window.localStorage.setItem("terminus-desktop.inspector-width.v1", "520");
    setViewport(900, 900);
    renderLayout();

    const sidebarWidth = Number(screen.getByRole("separator", { name: "Resize sidebar" }).getAttribute("aria-valuenow"));
    const inspectorWidth = Number(screen.getByRole("separator", { name: "Resize inspector" }).getAttribute("aria-valuenow"));
    expect(sidebarWidth + inspectorWidth).toBeLessThanOrEqual(572);
    expect(screen.getByTestId("main-content")).toBeInTheDocument();
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

  test("preserves review state and focus across the compact threshold", () => {
    setViewport(1099, 900);
    render(
      <ResizableReviewLayout
        conversation={<textarea aria-label="Conversation draft" defaultValue="conversation" />}
        review={<textarea aria-label="Inline review draft" />}
      />,
    );
    expect(screen.getByTestId("review-tabs")).toBeInTheDocument();
    const reviewDraft = screen.getByRole("textbox", { name: "Inline review draft" });
    fireEvent.change(reviewDraft, { target: { value: "Keep this unsent note" } });
    reviewDraft.focus();

    act(() => setViewport(1101, 900));
    expect(screen.getByTestId("review-split")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Inline review draft" })).toHaveValue("Keep this unsent note");
    expect(document.activeElement).toBe(reviewDraft);

    act(() => setViewport(1099, 900));
    expect(screen.getByTestId("review-tabs")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Inline review draft" })).toBe(reviewDraft);
    expect(reviewDraft).toHaveValue("Keep this unsent note");
    expect(document.activeElement).toBe(reviewDraft);
  });
});
