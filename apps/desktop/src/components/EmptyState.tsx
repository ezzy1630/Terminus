/**
 * Forge Desktop — EmptyState.
 *
 * Per SPEC §27: required states include "no projects", "empty project",
 * "no changes", "no subagents", "no verification", "no terminal", etc.
 * Each must be calm, helpful, and not decorative.
 *
 * Per SPEC §23: "A small amount of personality may appear in empty
 * states." — copy may be quietly confident and human, but never
 * interfere with clarity.
 *
 * Per design constraints: lucide-react icons only, no emojis, no purple
 * gradients, no glowing effects. Restrained motion.
 *
 * The component is intentionally generic: callers pass icon, title,
 * description, and an optional action. This keeps every empty state in
 * the app visually consistent.
 */
import { memo, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface EmptyStateAction {
  /** Visible button label. */
  label: string;
  /** Click handler. */
  onClick: () => void;
  /**
   * Optional keyboard hint shown to the right of the label
   * (e.g. "⌘N"). Per SPEC §18: "Clear shortcut hints."
   */
  shortcutHint?: string;
  /** Visual emphasis. Default is "primary". */
  variant?: "primary" | "secondary";
}

export interface EmptyStateProps {
  /** Lucide icon node (already sized). */
  icon?: ReactNode;
  /** Headline, e.g. "No changes yet". */
  title: string;
  /** One or two sentences of calm, helpful copy. */
  description?: string;
  /** Optional primary action (e.g. "Start a task"). */
  action?: EmptyStateAction;
  /** Optional secondary action shown as a quieter link. */
  secondaryAction?: EmptyStateAction;
  /** Extra elements rendered below the actions (e.g. file picker). */
  children?: ReactNode;
  /** Optional className on the root container. */
  className?: string;
  /** Vertical alignment. Defaults to centered. */
  align?: "center" | "start";
  /** Compact mode reduces vertical padding for tight surfaces. */
  compact?: boolean;
}

function EmptyStateImpl({
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
        align === "center" ? "items-center justify-center text-center" : "items-start justify-start text-left",
        compact ? "py-6" : "py-12",
        className,
      )}
      style={{ gap: compact ? 8 : 12, padding: compact ? "0 16px" : "0 24px" }}
    >
      {icon ? (
        <div
          aria-hidden
          className="flex items-center justify-center text-tertiary"
          style={{
            width: 32,
            height: 32,
            borderRadius: "var(--radius-md)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          {icon}
        </div>
      ) : null}
      <h2
        className="text-primary"
        style={{ fontSize: "var(--font-size-md)", fontWeight: 600, lineHeight: 1.3 }}
      >
        {title}
      </h2>
      {description ? (
        <p
          className="text-secondary"
          style={{
            fontSize: "var(--font-size-sm)",
            lineHeight: "var(--line-height-relaxed)",
            maxWidth: 380,
          }}
        >
          {description}
        </p>
      ) : null}
      {children ? <div className="w-full">{children}</div> : null}
      {(action || secondaryAction) ? (
        <div
          className={cn("flex flex-wrap", align === "center" ? "justify-center" : "justify-start")}
          style={{ gap: 12, marginTop: 4 }}
        >
          {action ? (
            <button
              type="button"
              onClick={action.onClick}
              className={cn(
                "inline-flex items-center gap-2 rounded-md text-primary transition-colors",
                action.variant === "secondary" ? "hover:bg-hover" : "",
              )}
              style={{
                height: 30,
                padding: "0 12px",
                fontSize: "var(--font-size-sm)",
                fontWeight: 500,
                background: action.variant === "secondary" ? "transparent" : "var(--color-primary)",
                color: action.variant === "secondary" ? "var(--text-secondary)" : "var(--text-inverse)",
                border: action.variant === "secondary" ? "1px solid var(--border-default)" : "none",
                transition: "background var(--duration-fast) var(--easing-default)",
              }}
            >
              <span>{action.label}</span>
              {action.shortcutHint ? (
                <kbd
                  className="font-mono text-tertiary"
                  style={{ fontSize: "var(--font-size-xs)" }}
                >
                  {action.shortcutHint}
                </kbd>
              ) : null}
            </button>
          ) : null}
          {secondaryAction ? (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="inline-flex items-center rounded-md text-secondary hover:text-primary"
              style={{
                height: 30,
                padding: "0 8px",
                fontSize: "var(--font-size-sm)",
                transition: "color var(--duration-fast) var(--easing-default)",
              }}
            >
              {secondaryAction.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const EmptyState = memo(EmptyStateImpl);
