/**
 * Terminus Desktop — Reasoning depth for the next turn.
 *
 * Scoped by the model, because the provider reports whether a model reasons at
 * all. A model that does not gets no depth control — an inert menu on a
 * non-reasoning model is a promise the runtime cannot keep.
 *
 * Depth doubles as the speed control. They are the same axis read from
 * opposite ends, so each level states its cost in time rather than pretending
 * to be a separate dial.
 *
 * The context window sits here too, but as a figure rather than a choice: a
 * model has exactly one, and the earlier version of this control offered it as
 * a picker, which implied a knob that does not exist.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Gauge } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "../ui/Button";
import { EFFORTS, EFFORT_LABELS, type ModelSelection } from "../lib/models";

interface TurnSettingsProps {
  selection: ModelSelection;
  className?: string;
  disabled?: boolean;
}

function TurnSettingsImpl({ selection, className, disabled = false }: TurnSettingsProps): JSX.Element {
  const { selected, effort, setEffort, context } = selection;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  if (selected === null) return <></>;

  // A non-reasoning model still has a context window worth stating, so the
  // control degrades to a label rather than disappearing.
  if (effort === null) {
    return context === null ? <></> : (
      <span
        className={cn("flex h-7 items-center gap-1.5 px-1 text-xs text-tertiary", className)}
        aria-label={`Context window: ${context} tokens`}
        data-tooltip="Context window reported by the provider"
      >
        <span>{context} context</span>
      </span>
    );
  }

  const summary = context ? `${EFFORT_LABELS[effort].label} · ${context}` : EFFORT_LABELS[effort].label;

  return (
    <div
      ref={rootRef}
      className={cn("relative", className)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
      }}
    >
      <Button
        type="button"
        variant="bare"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Reasoning depth: ${EFFORT_LABELS[effort].label}. Change depth`}
        data-tooltip="Reasoning depth for this turn"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "composer-control flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-secondary",
          "hover:text-primary disabled:cursor-not-allowed disabled:opacity-45",
          open && "bg-subtle text-primary",
        )}
      >
        <Gauge size={12} strokeWidth={1.8} aria-hidden className="text-tertiary" />
        <span className="truncate">{summary}</span>
        <ChevronDown size={11} strokeWidth={2} aria-hidden className="shrink-0 text-tertiary" />
      </Button>

      {open ? (
        <div
          role="dialog"
          aria-label="Reasoning depth"
          className="ui-popover surface-enter absolute left-0 top-[calc(100%+6px)] z-popover w-64 overflow-hidden rounded-xl border border-default p-1 shadow-lg"
        >
          <h3 className="ui-section-label px-2 pb-1 pt-2">Reasoning depth</h3>
          {EFFORTS.map((level) => (
            <Button
              key={level}
              type="button"
              variant="bare"
              onClick={() => { setEffort(level); close(); }}
              aria-pressed={level === effort}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left",
                level === effort ? "bg-hover" : "hover:bg-hover",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-primary">{EFFORT_LABELS[level].label}</span>
                <span className="mt-0.5 block text-xs leading-snug text-tertiary">{EFFORT_LABELS[level].note}</span>
              </span>
              {level === effort ? <Check size={13} aria-hidden className="mt-0.5 shrink-0 text-accent" /> : null}
            </Button>
          ))}

          {context ? (
            <p className="mt-1 border-t border-subtle px-2 py-2 text-xs text-tertiary">
              {selected.label} has a {context}-token context window.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const TurnSettings = memo(TurnSettingsImpl);
