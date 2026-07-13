/**
 * Terminus Desktop — StatusIndicator.
 *
 * Per SPEC §7.2 "Task statuses": minimal semantic status representation.
 * No large colorful badges. The eight kinds are:
 *
 *   working         → tiny spinner
 *   queued          → muted dot
 *   waiting         → warning dot
 *   needs_approval  → warning dot
 *   needs_review    → info dot
 *   failed          → error dot
 *   interrupted     → muted dot
 *   done            → muted dot
 *
 * Per SPEC §7.2: "Selected active tasks may show a small live activity
 * indicator similar to Codex." — the working spinner serves this role.
 *
 * Per design constraints: "No emojis. Use lucide-react for icons."
 */
import { memo } from "react";
import { cn } from "../lib/cn";
import type { TaskStatusKind } from "../types";

interface StatusIndicatorProps {
  status: TaskStatusKind;
  /** Override size in px. Defaults to 12px (tiny per SPEC §7.2). */
  size?: number;
  /** Optional label rendered as muted secondary text. */
  label?: string;
  className?: string;
}

const SIZE_DEFAULT = 12;

function StatusDot({ size, color, label }: { size: number; color: string; label: string }): JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      style={{
        display: "inline-block",
        width: Math.max(6, size - 2),
        height: Math.max(6, size - 2),
        borderRadius: "50%",
        background: color,
      }}
    />
  );
}

function StatusGlyph({
  status,
  size,
}: {
  status: TaskStatusKind;
  size: number;
}): JSX.Element {
  switch (status) {
    case "working":
      // Tiny spinner — uses the `.spinner` class from globals.css.
      return (
        <span
          className="spinner"
          role="img"
          aria-label="working"
          style={{ width: size, height: size }}
        />
      );
    case "queued":
    case "interrupted":
      return <StatusDot size={size} color="var(--color-agent-queued)" label={status} />;
    case "waiting":
      return <StatusDot size={size} color="var(--color-agent-waiting)" label="waiting" />;
    case "needs_approval":
      return <StatusDot size={size} color="var(--color-approval-risk)" label="needs approval" />;
    case "needs_review":
      return <StatusDot size={size} color="var(--color-info)" label="needs review" />;
    case "failed":
      return <StatusDot size={size} color="var(--color-error)" label="failed" />;
    case "done":
      // Completed tasks stay quiet in navigation; the task detail surface
      // carries the stronger success treatment when it matters.
      return <StatusDot size={size} color="var(--text-tertiary)" label="done" />;
    case "unknown":
    default:
      return (
        <span
          aria-label="unknown"
          style={{
            display: "inline-block",
            width: size - 2,
            height: size - 2,
            borderRadius: "50%",
            border: "1px solid var(--border-strong)",
          }}
        />
      );
  }
}

function StatusIndicatorImpl({ status, size = SIZE_DEFAULT, label, className }: StatusIndicatorProps): JSX.Element {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      style={{ minWidth: size }}
    >
      <StatusGlyph status={status} size={size} />
      {label ? (
        <span className="text-xs text-secondary" style={{ fontSize: "var(--font-size-xs)" }}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

export const StatusIndicator = memo(StatusIndicatorImpl);

/** Map a domain status string to a UI-facing kind, then to a label. */
export function statusLabel(status: TaskStatusKind): string {
  switch (status) {
    case "working": return "Working";
    case "queued": return "Queued";
    case "waiting": return "Waiting";
    case "needs_approval": return "Needs approval";
    case "needs_review": return "Needs review";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    case "done": return "Done";
    case "unknown":
    default: return "Pending";
  }
}
