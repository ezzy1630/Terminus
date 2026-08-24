import { describe, expect, test } from "vitest";

import { FIXED_SHORTCUTS, matchesShortcut, shortcutDisplay } from "../src/lib/shortcuts";

function keyEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">>,
): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...modifiers });
}

describe("platform keyboard shortcuts", () => {
  test("preserves macOS Control editing chords while Command activates global actions", () => {
    const shortcuts = [
      FIXED_SHORTCUTS.commandPalette,
      FIXED_SHORTCUTS.newTask,
      FIXED_SHORTCUTS.showChanges,
      FIXED_SHORTCUTS.openProject,
    ];
    for (const shortcut of shortcuts) {
      expect(matchesShortcut(keyEvent(shortcut.key, { ctrlKey: true }), shortcut, "mac")).toBe(false);
      expect(matchesShortcut(keyEvent(shortcut.key, { metaKey: true }), shortcut, "mac")).toBe(true);
    }
  });

  test("uses Control outside macOS and rejects Meta-only chords", () => {
    expect(matchesShortcut(keyEvent("k", { metaKey: true }), FIXED_SHORTCUTS.commandPalette, "other")).toBe(false);
    expect(matchesShortcut(keyEvent("k", { ctrlKey: true }), FIXED_SHORTCUTS.commandPalette, "other")).toBe(true);
    expect(shortcutDisplay(FIXED_SHORTCUTS.commandPalette, "other")).toBe("Ctrl+K");
  });

  test("rejects every modifier for unmodified diff navigation", () => {
    expect(matchesShortcut(keyEvent("j", { ctrlKey: true }), FIXED_SHORTCUTS.diffNextChange, "mac")).toBe(false);
    expect(matchesShortcut(keyEvent("j", { metaKey: true }), FIXED_SHORTCUTS.diffNextChange, "other")).toBe(false);
    expect(matchesShortcut(keyEvent("j", {}), FIXED_SHORTCUTS.diffNextChange, "other")).toBe(true);
  });
});
