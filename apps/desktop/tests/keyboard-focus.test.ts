import { afterEach, expect, test } from "vitest";
import { installKeyboardFocus } from "../src/lib/keyboard-focus";

let uninstall: (() => void) | null = null;
afterEach(() => { uninstall?.(); uninstall = null; });

// Focus rings belong to the keyboard. A click never marks the document; a
// Tab does; the next pointer press clears it again.
test("marks the document for keyboard navigation and clears it on pointer press", () => {
  uninstall = installKeyboardFocus();
  const root = document.documentElement;
  expect(root.hasAttribute("data-keyboard-nav")).toBe(false);

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  expect(root.hasAttribute("data-keyboard-nav")).toBe(false);

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
  expect(root.hasAttribute("data-keyboard-nav")).toBe(true);

  document.dispatchEvent(new Event("pointerdown"));
  expect(root.hasAttribute("data-keyboard-nav")).toBe(false);
});
