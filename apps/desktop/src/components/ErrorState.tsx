/**
 * Terminus Desktop — ErrorState.
 *
 * Per SPEC §27: required error states include "failed task", "offline
 * runtime", "reconnecting", "missing model", "missing editor", "missing
 * Git", "permission denied", "agent blocked", "terminal disconnected",
 * "merge conflict", "rate limit", "context limit", "huge output",
 * "deleted project path", "update available", "application error", and
 * "renderer recovery".
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
import { Button } from "../ui/Button";
import { Kbd } from "../ui/Kbd";

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
  /**
   * How urgently a screen reader should announce this.
   *
   * "assertive" (the default) is right for something that just went wrong.
   * A standing condition — "no provider has reported a model" — is a status:
   * announcing it assertively interrupts, and every surface that renders one
   * alongside a real failure ends up with two competing alerts.
   */
  live?: "assertive" | "polite";
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
  live = "assertive",
}: ErrorStateProps): JSX.Element {
  const glyphColor = severity === "warning" ? "var(--color-warning)" : "var(--color-error)";
  const resolvedIcon = icon ?? <TriangleAlert size={15} strokeWidth={1.8} />;
  return (
    <div
      role={live === "polite" ? "status" : "alert"}
      aria-live={live}
      className={cn(
        "error-state flex w-full flex-col",
        compact ? "py-3" : "py-8",
        className,
      )}
      style={{ gap: compact ? 8 : 12, padding: compact ? "0 12px" : "0 20px" }}
    >
      <div className="flex items-start gap-3">
        {resolvedIcon ? (
          <div aria-hidden className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center" style={{ color: glyphColor }}>
            {resolvedIcon}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 4 }}>
          <h2
            className="text-primary text-md"
            style={{ fontWeight: 600, lineHeight: 1.3 }}
          >
            {title}
          </h2>
          {description ? (
            <p
              className="text-secondary text-sm"
              style={{ lineHeight: "var(--line-height-relaxed)" }}
            >
              {description}
            </p>
          ) : null}
          {detail ? (
            <p
              className="selectable font-mono text-tertiary text-xs"
              style={{ marginTop: 2 }}
            >
              {detail}
            </p>
          ) : null}
        </div>
      </div>
      {(action || secondaryAction) ? (
        <div
          className="flex flex-wrap items-center gap-2"
          style={{ marginTop: 2, paddingLeft: resolvedIcon ? 32 : 0 }}
        >
          {action ? (
            <Button
              type="button"
              onClick={action.onClick}
              variant={action.variant === "secondary" ? "secondary" : "primary"}
            >
              <span>{action.label}</span>
              {action.shortcutHint ? (
                <Kbd>{action.shortcutHint}</Kbd>
              ) : null}
            </Button>
          ) : null}
          {secondaryAction ? (
            <Button
              type="button"
              onClick={secondaryAction.onClick}
              variant="ghost"
            >
              {secondaryAction.label}
            </Button>
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
  hugeOutput: {
    title: "Output moved to an artifact",
    description:
      "The result is too large to render safely. Open the complete immutable artifact or continue from the reported cursor.",
    severity: "warning",
  },
  deletedProjectPath: {
    title: "Project folder is unavailable",
    description:
      "The saved folder was moved, renamed, or deleted. Locate it again or remove this project from the sidebar.",
    severity: "warning",
  },
  updateAvailable: {
    title: "Update ready to install",
    description:
      "A newer Terminus build is available. Finish active tasks before restarting to apply it.",
    severity: "warning",
  },
  applicationError: {
    title: "Terminus encountered an application error",
    description:
      "Your task data is preserved. Reload the interface, or open diagnostics if the problem returns.",
    severity: "error",
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
