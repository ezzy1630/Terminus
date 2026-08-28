/**
 * Preferences as a real window.
 *
 * On macOS ⌘, opens a Preferences *window*, not a modal that blankets the
 * app. Terminus now does the same — which introduces a second renderer over
 * the same localStorage. Appearance is previewed live, so a theme picked in
 * the Preferences window has to reach the main window immediately; otherwise
 * the split looks broken in a way the old overlay never could.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SettingsWindow } from "../src/components/SettingsWindow";
import { useSettingsStore } from "../src/components/Settings";
import { useThemeStore } from "../src/hooks/use-theme";

const THEME_KEY = "terminus-desktop.theme.v2";
const SETTINGS_KEY = "terminus-desktop.settings.v1";

/** A write performed by the *other* window: storage is already updated. */
function remoteWrite(key: string, value: unknown): void {
  const newValue = JSON.stringify(value);
  window.localStorage.setItem(key, newValue);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete (window as { terminusDesktop?: unknown }).terminusDesktop;
});

describe("appearance changes cross the window boundary", () => {
  test("a theme chosen in the other window repaints this one", () => {
    useThemeStore.getState().setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    remoteWrite(THEME_KEY, { theme: "dark", density: "compact" });

    expect(useThemeStore.getState().theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  test("density too", () => {
    useThemeStore.getState().setDensity("compact");

    remoteWrite(THEME_KEY, { theme: "dark", density: "spacious" });

    expect(useThemeStore.getState().density).toBe("spacious");
    expect(document.documentElement.dataset.density).toBe("spacious");
  });

  test("ignores writes to keys this app does not own", () => {
    useThemeStore.getState().setTheme("light");

    remoteWrite("some-other-app", { theme: "dark", density: "spacious" });

    expect(useThemeStore.getState().theme).toBe("light");
  });

  test("survives a corrupt payload rather than throwing across the listener", () => {
    useThemeStore.getState().setTheme("light");

    window.localStorage.setItem(THEME_KEY, "{not json");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "{not json" }));

    expect(useThemeStore.getState().theme).toBe("light");
  });
});

describe("preference changes cross the window boundary", () => {
  test("a preference saved in the other window takes effect here", () => {
    useSettingsStore.getState().set("appearance.reduce-motion", false);

    remoteWrite(SETTINGS_KEY, { "appearance.reduce-motion": true });

    expect(useSettingsStore.getState().get("appearance.reduce-motion")).toBe(true);
    // Not just stored — the live side effect runs, so motion actually stops.
    expect(document.documentElement.dataset.reduceMotion).toBe("true");
  });

  test("a preference the remote window reset falls back to its default", () => {
    useSettingsStore.getState().set("appearance.reduce-motion", true);

    remoteWrite(SETTINGS_KEY, {});

    expect(useSettingsStore.getState().get("appearance.reduce-motion")).toBe(false);
    expect(document.documentElement.dataset.reduceMotion).toBe("false");
  });
});

describe("the Preferences window", () => {
  test("shows settings with no surrounding app chrome", () => {
    render(<SettingsWindow />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  test("closing it closes the window, not just the dialog", async () => {
    const windowClose = vi.fn(async () => undefined);
    (window as { terminusDesktop?: unknown }).terminusDesktop = { windowClose };
    const user = userEvent.setup();
    render(<SettingsWindow />);

    await user.click(screen.getByRole("button", { name: "Close settings" }));

    expect(windowClose).toHaveBeenCalledOnce();
  });

  test("jumps to the category the main window asked for", () => {
    let deliver: ((category: string) => void) | undefined;
    (window as { terminusDesktop?: unknown }).terminusDesktop = {
      onSettingsCategory: (callback: (category: string) => void) => {
        deliver = callback;
        return () => undefined;
      },
    };
    render(<SettingsWindow />);

    act(() => deliver?.("shortcuts"));

    expect(screen.getByRole("button", { name: /Keyboard Shortcuts/ })).toHaveAttribute("aria-current", "true");
  });

  test("ignores a category name that is not one of ours", () => {
    let deliver: ((category: string) => void) | undefined;
    (window as { terminusDesktop?: unknown }).terminusDesktop = {
      onSettingsCategory: (callback: (category: string) => void) => {
        deliver = callback;
        return () => undefined;
      },
    };
    render(<SettingsWindow />);

    act(() => deliver?.("../../etc/passwd"));

    expect(screen.getByRole("button", { name: /Appearance/ })).toHaveAttribute("aria-current", "true");
  });
});
