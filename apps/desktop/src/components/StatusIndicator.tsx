/**
 * Terminus Desktop — StatusIndicator.
 *
 * Per SPEC §7.2 "Task statuses": minimal semantic status representation.
 * No large colorful badges. The eight kinds are:
 *
 *   working         → tiny spinner
 *   queued          → muted dot
 *   waiting         → small clock icon
 *   needs_approval  → warning dot
 *   needs_review    → info dot
 *   failed          → error dot
 *   interrupted     → muted dot
 *   done            → checkmark
 *
 * Per SPEC §7.2: "Selected active tasks may show a small live activity
 * indicator similar to Codex." — the working spinner serves this role.
 *
 * Per design constraints: "No emojis. Use lucide-react for icons."
 */
import { Check, Clock, Dot } from "lucide-react";
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
      // Muted dot.
      return (
        <Dot
          size={size + 4}
          aria-label={status}
          style={{ color: "var(--text-tertiary)", strokeWidth: 2 }}
        />
      );
    case "waiting":
      return (
        <Clock
          size={size}
          aria-label="waiting"
          style={{ color: "var(--color-agent-waiting)" }}
          strokeWidth={1.75}
        />
      );
    case "needs_approval":
      return (
        <span
          aria-label="needs approval"
          style={{
            display: "inline-block",
            width: size,
            height: size,
            borderRadius: "50%",
            background: "var(--color-approval-risk)",
          }}
        />
      );
    case "needs_review":
      return (
        <span
          aria-label="needs review"
          style={{
            display: "inline-block",
            width: size,
            height: size,
            borderRadius: "50%",
            background: "var(--color-info)",
          }}
        />
      );
    case "failed":
      return (
        <span
          aria-label="failed"
          style={{
            display: "inline-block",
            width: size,
            height: size,
            borderRadius: "50%",
            background: "var(--color-error)",
          }}
        />
      );
    case "done":
      return (
        <Check
          size={size}
          aria-label="done"
          style={{ color: "var(--color-success)" }}
          strokeWidth={2.25}
        />
      );
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
