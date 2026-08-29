import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

/**
 * AppKit text field: 24px tall, 13px value, recessed against its pane.
 *
 * The 32px web-form height made every settings row taller than the row itself.
 * `bg-canvas` on an elevated pane is the recess macOS draws — the field reads
 * as cut into the surface rather than stacked on top of it.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid = false, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "ui-input ui-body h-6 w-full rounded-sm border border-default bg-canvas px-2 text-primary placeholder:text-tertiary",
        invalid && "border-error",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "ui-input ui-body w-full resize-none rounded-sm border border-default bg-canvas px-2 py-1.5 text-primary placeholder:text-tertiary",
          className,
        )}
        {...props}
      />
    );
  },
);
