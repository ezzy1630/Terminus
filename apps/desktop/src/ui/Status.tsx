import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }): JSX.Element {
  return <span className={cn("spinner inline-block", className)} role="status" aria-label={label} />;
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn("skeleton", className)} aria-hidden {...props} />;
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const badgeTone: Record<BadgeTone, string> = {
  neutral: "border-default bg-subtle text-secondary",
  success: "border-success/35 bg-success/10 text-success",
  warning: "border-warning/35 bg-warning/10 text-warning",
  danger: "border-error/35 bg-error/10 text-error",
  info: "border-info/35 bg-info/10 text-info",
};

export function Badge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }): JSX.Element {
  return <span className={cn("inline-flex h-5 items-center rounded border px-1.5 text-xs font-medium", badgeTone[tone], className)} {...props} />;
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
