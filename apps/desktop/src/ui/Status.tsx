import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }): JSX.Element {
  return <span className={cn("spinner inline-block", className)} role="status" aria-label={label} />;
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn("skeleton", className)} aria-hidden {...props} />;
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

/**
 * Colour carries the meaning; the fill does not.
 *
 * Every tone used to paint a tinted box with a coloured border, so a pane with
 * three status badges read as three coloured chips competing with the content.
 * A hairline and coloured text says the same thing at a fraction of the weight.
 */
const badgeTone: Record<BadgeTone, string> = {
  neutral: "text-secondary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-error",
  info: "text-info",
};

export function Badge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex h-[17px] items-center rounded-sm border border-subtle px-1.5 text-xs font-medium",
        badgeTone[tone],
        className,
      )}
      {...props}
    />
  );
}

export function StatusDot({ tone = "neutral", label, className }: { tone?: BadgeTone; label: string; className?: string }): JSX.Element {
  const colors: Record<BadgeTone, string> = {
    neutral: "bg-neutral-status",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-error",
    info: "bg-info",
  };
  return <span className={cn("inline-block h-1.5 w-1.5 rounded-full", colors[tone], className)} role="img" aria-label={label} />;
}
