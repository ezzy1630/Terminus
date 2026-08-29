import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { createContext, useContext, type ReactElement, type ReactNode, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

const HOVER_DELAY_MS = 450;
/** How long after a tip closes its neighbours still open instantly. */
const SKIP_DELAY_MS = 300;

/** Set by the app-level provider so a `Tooltip` can tell it is already inside one. */
const TooltipScope = createContext(false);

export function TooltipProvider({ children }: { children: ReactNode }): JSX.Element {
  return (
    <TooltipScope.Provider value>
      <TooltipPrimitive.Provider delayDuration={HOVER_DELAY_MS} skipDelayDuration={SKIP_DELAY_MS}>
        {children}
      </TooltipPrimitive.Provider>
    </TooltipScope.Provider>
  );
}

/**
 * One provider for the window is the point of the primitive: it is what makes
 * a toolbar behave the way AppKit does, where the first tip costs a delay and
 * sliding along the neighbouring buttons shows theirs at once. Each `Tooltip`
 * used to mount a provider of its own, so every button was its own scope —
 * every hover paid the full delay again and two tips could sit on screen
 * together, because neither knew the other existed. The local provider now
 * appears only when there is no surrounding one, which is the case in unit
 * tests that render a single control.
 */
export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
}): JSX.Element {
  const withinProvider = useContext(TooltipScope);
  const tooltip = (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="ui-popover z-tooltip max-w-72 rounded-md border border-subtle px-2 py-[3px] text-xs text-secondary shadow-md"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return withinProvider ? tooltip : (
    <TooltipPrimitive.Provider delayDuration={HOVER_DELAY_MS} skipDelayDuration={SKIP_DELAY_MS}>
      {tooltip}
    </TooltipPrimitive.Provider>
  );
}

interface TooltipState {
  element: HTMLElement;
  text: string;
  left: number;
  top: number;
}

function tooltipElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>("[data-tooltip]:not([data-tooltip-radix])")
    : null;
}

function tooltipText(element: HTMLElement): string | null {
  return element.dataset.tooltip?.trim() || null;
}

function addDescription(element: HTMLElement, descriptionId: string): void {
  const ids = new Set((element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
  ids.add(descriptionId);
  element.setAttribute("aria-describedby", [...ids].join(" "));
}

function removeDescription(element: HTMLElement, descriptionId: string): void {
  const ids = (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((id) => id && id !== descriptionId);
  if (ids.length > 0) element.setAttribute("aria-describedby", ids.join(" "));
  else element.removeAttribute("aria-describedby");
}

/** Non-interactive truncation targets use this delegated layer; controls use the Radix primitive above. */
export function TooltipLayer(): JSX.Element | null {
  const descriptionId = useId();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    const show = (event: Event): void => {
      const element = tooltipElement(event.target);
      if (!element) return;
      const text = tooltipText(element);
      if (!text) return;
      const rect = element.getBoundingClientRect();
      addDescription(element, descriptionId);
      setTooltip((current) => {
        if (current && current.element !== element) removeDescription(current.element, descriptionId);
        return {
          element,
          text,
          left: Math.min(window.innerWidth - 152, Math.max(152, rect.left + rect.width / 2)),
          top: Math.max(8, rect.top - 8),
        };
      });
    };
    const hide = (event: Event): void => {
      const element = tooltipElement(event.target);
      const relatedTarget = event instanceof FocusEvent || event instanceof MouseEvent ? event.relatedTarget : null;
      if (element && relatedTarget instanceof Node && element.contains(relatedTarget)) return;
      setTooltip((current) => {
        if (!current || (element && current.element !== element)) return current;
        removeDescription(current.element, descriptionId);
        return null;
      });
    };
    const dismiss = (): void => {
      setTooltip((current) => {
        if (current) removeDescription(current.element, descriptionId);
        return null;
      });
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss();
    };

    document.addEventListener("pointerover", show, true);
    document.addEventListener("pointerout", hide, true);
    document.addEventListener("focusin", show, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      dismiss();
      document.removeEventListener("pointerover", show, true);
      document.removeEventListener("pointerout", hide, true);
      document.removeEventListener("focusin", show, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [descriptionId]);

  if (!tooltip) return null;
  return createPortal(
    <div
      id={descriptionId}
      role="tooltip"
      className="surface-enter z-tooltip pointer-events-none fixed max-w-72 -translate-x-1/2 -translate-y-full rounded-md border border-subtle bg-[var(--bg-popover)] px-2 py-[3px] text-xs text-secondary shadow-md"
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}
