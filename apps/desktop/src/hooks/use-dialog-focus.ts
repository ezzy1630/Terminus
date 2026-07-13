import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Keeps keyboard focus inside a modal and restores the launching control. */
export function useDialogFocus<T extends HTMLElement>(
  active: boolean,
  onEscape: () => void,
): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initialFocusFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(document.activeElement)) return;
      dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(initialFocusFrame);
      window.removeEventListener("keydown", onKeyDown, true);
      window.requestAnimationFrame(() => previousFocus?.focus());
    };
  }, [active]);

  return dialogRef;
}
