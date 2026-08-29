/**
 * Terminus Desktop — focus rings only for the keyboard.
 *
 * Chromium's `:focus-visible` matches every focused text field, and any
 * control that was focused by script — which after a click is most of them,
 * because Radix restores focus when a menu or dialog closes. So a click on a
 * button, a row, or the search field drew the accent ring around it, which is
 * not what a Mac does: AppKit draws a focus ring while you are tabbing and
 * never for the mouse.
 *
 * This marks the document while the last interaction was a key that moves
 * focus and clears the mark at the next pointer press. The stylesheet only
 * paints the ring under `[data-keyboard-nav]`.
 */
const NAV_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Escape", "Enter", " "]);

export function installKeyboardFocus(): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  const onKey = (event: KeyboardEvent): void => {
    if (NAV_KEYS.has(event.key)) root.setAttribute("data-keyboard-nav", "");
  };
  const onPointer = (): void => { root.removeAttribute("data-keyboard-nav"); };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
    root.removeAttribute("data-keyboard-nav");
  };
}
