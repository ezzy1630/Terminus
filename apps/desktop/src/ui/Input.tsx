import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid = false, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "ui-input h-8 w-full rounded-md border border-default bg-canvas px-2.5 text-sm text-primary placeholder:text-tertiary",
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
          "ui-input w-full resize-none rounded-md border border-default bg-canvas px-2.5 py-2 text-sm text-primary placeholder:text-tertiary",
          className,
        )}
        {...props}
      />
    );
  },
);
