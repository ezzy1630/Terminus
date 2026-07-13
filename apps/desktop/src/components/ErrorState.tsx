/**
 * Terminus Desktop — ErrorState.
 *
 * Per SPEC §27: required error states include "failed task", "offline
 * runtime", "reconnecting", "missing model", "missing editor", "missing
 * Git", "permission denied", "agent blocked", "terminal disconnected",
 * "merge conflict", "rate limit", "context limit", "renderer recovery".
 *
 * Per SPEC §27: "Every state must provide a clear recovery action when
 * recovery is possible."
 *
 * Per SPEC §23: copy should be "precise, direct, calm, human, concise,
 * technically credible." Avoid "magic" language and emoji.
 *
 * Per design constraints: color is reserved for meaning. Errors use
 * `--color-error` for the icon glyph and a subtle warning-tinted
 * background only when the error is recoverable / blocking.
 */
import { memo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "../lib/cn";

export interface ErrorStateAction {
  label: string;
  onClick: () => void;
  /** Optional shortcut hint shown as a kbd. */
  shortcutHint?: string;
  /** Defaults to "primary". */
  variant?: "primary" | "secondary";
}

export interface ErrorStateProps {
  /** Lucide icon node. Defaults to a generic alert glyph if omitted. */
  icon?: ReactNode;
  /** Headline, e.g. "Failed to load task". */
  title: string;
  /** Calm, technically credible explanation. */
  description?: string;
  /**
   * Optional secondary detail — a short error code, trace id, or
   * "Last tried 4 seconds ago." Rendered in monospace tertiary text
   * so it stays unobtrusive but copyable.
   */
  detail?: string;
  /** Primary recovery action. Per SPEC §27, every error must offer one. */
  action?: ErrorStateAction;
  /** Optional secondary action (e.g. "Open diagnostics"). */
  secondaryAction?: ErrorStateAction;
  /**
   * Visual severity. "error" (default) shows a red glyph.
   * "warning" shows the warning glyph color, used for soft-failures
   * like "missing editor" where the app still works.
   */
  severity?: "error" | "warning";
  /** Optional className override on the root container. */
  className?: string;
  /** Compact vertical padding. */
  compact?: boolean;
}

function ErrorStateImpl({
  icon,
  title,
  description,
  detail,
  action,
  secondaryAction,
  severity = "error",
  className,
  compact = false,
}: ErrorStateProps): JSX.Element {
  const glyphColor = severity === "warning" ? "var(--color-warning)" : "var(--color-error)";
  const resolvedIcon = icon ?? <TriangleAlert size={15} strokeWidth={1.8} />;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "error-state flex w-full flex-col",
        compact ? "py-4" : "py-10",
        className,
      )}
      style={{ gap: compact ? 8 : 12, padding: compact ? "0 16px" : "0 24px" }}
    >
      <div className="flex items-start gap-3">
        {resolvedIcon ? (
          <div
            aria-hidden
            className="flex flex-shrink-0 items-center justify-center"
            style={{
              width: 28,
              height: 28,
              borderRadius: "var(--radius-md)",
              background: "color-mix(in srgb, " + glyphColor + " 12%, transparent)",
              color: glyphColor,
            }}
          >
            {resolvedIcon}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 4 }}>
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
              }}
            >
              {description}
            </p>
          ) : null}
          {detail ? (
            <p
              className="selectable font-mono text-tertiary"
              style={{ fontSize: "var(--font-size-xs)", marginTop: 2 }}
            >
              {detail}
            </p>
          ) : null}
        </div>
      </div>
      {(action || secondaryAction) ? (
        <div
          className="flex flex-wrap items-center"
          style={{ gap: 12, marginTop: 4, paddingLeft: resolvedIcon ? 40 : 0 }}
        >
          {action ? (
            <button
              type="button"
              onClick={action.onClick}
              className="inline-flex items-center gap-2 rounded-md"
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
                  className="font-mono"
                  style={{
                    fontSize: "var(--font-size-xs)",
                    opacity: action.variant === "secondary" ? 0.7 : 0.85,
                  }}
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

export const ErrorState = memo(ErrorStateImpl);

/**
 * Curated error-state presets for the SPEC §27 catalog. Each preset
 * returns props ready to spread onto <ErrorState />. Callers can
 * override any field (especially `action`) when context demands a
 * different recovery.
 */
export interface ErrorPreset {
  title: string;
  description: string;
  detail?: string;
  severity: "error" | "warning";
}

const PRESETS: Record<string, ErrorPreset> = {
  failedTask: {
    title: "Task failed",
    description:
      "The agent encountered an error and could not complete the task. Review the activity log for the failing step.",
    severity: "error",
  },
  offlineRuntime: {
    title: "Control plane offline",
    description:
      "Terminus cannot reach the control plane at the configured address. Make sure the local service is running.",
    severity: "warning",
  },
  reconnecting: {
    title: "Reconnecting",
    description: "The live stream dropped. Terminus is reconnecting and will resume from the last event.",
    severity: "warning",
  },
  missingModel: {
    title: "Model not available",
    description:
      "The configured model could not be loaded. Switch to a different model in Settings → Agents and Models.",
    severity: "warning",
  },
  missingEditor: {
    title: "No external editor detected",
    description:
      "Cursor or VS Code was not found. Install one, or set the path manually in Settings → Integrations.",
    severity: "warning",
  },
  missingGit: {
    title: "Git not found",
    description:
      "Git is required for branch, diff, and commit actions. Install Git or add it to your PATH.",
    severity: "warning",
  },
  permissionDenied: {
    title: "Permission denied",
    description:
      "The selected access level does not allow this operation. Raise the access level or approve the request inline.",
    severity: "error",
  },
  agentBlocked: {
    title: "Agent blocked",
    description:
      "The agent stopped because an operation was denied. Review the approval and adjust scope, then resume.",
    severity: "warning",
  },
  terminalDisconnected: {
    title: "Terminal disconnected",
    description: "The terminal session ended unexpectedly. Open a new terminal to continue.",
    severity: "warning",
  },
  mergeConflict: {
    title: "Merge conflict",
    description: "Conflicts were detected while applying changes. Resolve them in your editor before continuing.",
    severity: "warning",
  },
  rateLimit: {
    title: "Rate limit reached",
    description: "Too many requests were sent. Wait a moment before retrying.",
    severity: "warning",
  },
  contextLimit: {
    title: "Context limit reached",
    description:
      "The conversation exceeded the model context window. Start a new task or summarize and continue.",
    severity: "warning",
  },
  unsupportedFile: {
    title: "Unsupported file",
    description: "This file type cannot be previewed. Open it in your external editor instead.",
    severity: "warning",
  },
  rendererRecovery: {
    title: "Renderer recovered",
    description:
      "The interface restarted after an error. Your work was preserved. Reload the window if anything looks off.",
    severity: "warning",
  },
};

export function errorPreset(key: keyof typeof PRESETS): ErrorPreset {
  return PRESETS[key] ?? PRESETS.failedTask!;
}
