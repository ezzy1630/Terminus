import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Tooltip } from "./Tooltip";

/**
 * `bare` is for buttons that are layout containers rather than controls — a
 * sidebar row, a card header. It contributes only a reset, so the caller owns
 * sizing and flow. Without it the shared styling (fixed height, nowrap,
 * shrink-0, centred inline-flex) fights multi-line and full-width rows, which
 * is why those sites kept reaching for a raw <button>.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "bare";
export type ControlSize = "sm" | "md" | "lg";

const variantClasses: Record<Exclude<ButtonVariant, "bare">, string> = {
  // Background, hover and pressed all live in CSS (.ui-button-primary): a
  // brightness filter is not a state, and utilities outrank the components
  // layer where a hover rule would otherwise go.
  primary: "ui-button-primary border-transparent font-medium text-on-accent",
  secondary: "border-default bg-elevated font-medium text-primary hover:border-strong hover:bg-hover",
  ghost: "border-transparent bg-transparent font-normal text-secondary hover:bg-hover hover:text-primary",
  danger: "border-transparent bg-error font-medium text-white hover:brightness-105",
};

const sizeClasses: Record<ControlSize, string> = {
  sm: "h-6 gap-1.5 rounded-sm px-2 text-xs",
  md: "h-7 gap-2 rounded-md px-2.5 text-sm",
  lg: "h-8 gap-2 rounded-md px-3 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  "data-tooltip"?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "ghost", size = "md", leading, trailing, children, type = "button", "data-tooltip": tooltip, ...props },
  ref,
) {
  const control = (
    <button
      ref={ref}
      type={type}
      data-tooltip={tooltip}
      data-tooltip-radix={tooltip ? "" : undefined}
      className={cn(
        variant === "bare"
          ? "appearance-none border-0 bg-transparent p-0 text-left disabled:cursor-not-allowed disabled:opacity-45"
          : cn(
            "ui-button inline-flex shrink-0 items-center justify-center whitespace-nowrap border transition-[background,color,border-color,transform,filter] disabled:cursor-not-allowed disabled:opacity-45",
            variantClasses[variant],
            sizeClasses[size],
          ),
        className,
      )}
      {...props}
    >
      {leading}
      {children}
      {trailing}
    </button>
  );
  return typeof tooltip === "string" && tooltip.trim().length > 0
    ? <Tooltip content={tooltip}>{control}</Tooltip>
    : control;
});
