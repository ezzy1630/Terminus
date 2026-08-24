import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let appDialogFocusOrigin: HTMLElement | null = null;

/** Preserve one launcher across a Suspense fallback and its resolved dialog. */
export function setAppDialogFocusOrigin(origin: HTMLElement | null): void {
  appDialogFocusOrigin = origin;
}

export function restoreAppDialogFocusOrigin(): void {
  const origin = appDialogFocusOrigin;
  appDialogFocusOrigin = null;
  window.requestAnimationFrame(() => origin?.focus());
}

/** IME composition keys must remain owned by the text input method. */
export function isComposingKeyboardEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

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
    const previousFocus = appDialogFocusOrigin
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const initialFocusFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(document.activeElement)) return;
      dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isComposingKeyboardEvent(event)) return;
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
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(initialFocusFrame);
      window.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => previousFocus?.focus());
    };
  }, [active]);

  return dialogRef;
}
