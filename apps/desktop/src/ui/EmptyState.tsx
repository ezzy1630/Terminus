import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Button } from "./Button";
import { Kbd } from "./Kbd";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  shortcutHint?: string;
  variant?: "primary" | "secondary";
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  children?: ReactNode;
  className?: string;
  align?: "center" | "start";
  compact?: boolean;
}

/**
 * A panel's "nothing here yet", kept quiet.
 *
 * This renders inside inspectors and side panes, so it is never the large
 * element on screen — that slot belongs to the start-screen hero. The title
 * sits at chrome size and the description at meta size, which keeps an empty
 * inspector from out-shouting the transcript beside it.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  children,
  className,
  align = "center",
  compact = false,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex w-full flex-col text-left",
        align === "center" ? "items-center justify-center text-center" : "items-start justify-start",
        compact ? "px-3 py-4" : "px-5 py-7",
        className,
      )}
    >
      {icon ? <div className="mb-2 flex h-5 w-5 items-center justify-center text-tertiary" aria-hidden>{icon}</div> : null}
      <h2 className="ui-body font-semibold text-primary">{title}</h2>
      {description ? <p className="ui-meta mt-1 max-w-[34ch] leading-relaxed">{description}</p> : null}
      {children ? <div className="mt-3 w-full">{children}</div> : null}
      {action || secondaryAction ? (
        <div className={cn("mt-3 flex flex-wrap gap-2", align === "center" && "justify-center")}>
          {action ? (
            <Button onClick={action.onClick} variant={action.variant === "secondary" ? "secondary" : "primary"}>
              {action.label}{action.shortcutHint ? <Kbd>{action.shortcutHint}</Kbd> : null}
            </Button>
          ) : null}
          {secondaryAction ? <Button onClick={secondaryAction.onClick}>{secondaryAction.label}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}
