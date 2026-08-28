/**
 * Terminus Desktop — StatusIndicator.
 *
 * Minimal semantic status representation, keyed on the one task vocabulary in
 * lib/task-lifecycle.ts. No large colorful badges:
 *
 *   planning / working / verifying → tiny spinner (the agent is moving)
 *   queued / cancelled / done      → muted dot
 *   needs_you                      → warning dot
 *   review                         → success dot
 *   failed                         → error dot
 *
 * A task the agent is advancing on its own gets motion; a task that stopped
 * gets a still dot. That distinction is the whole point of the glyph, so it is
 * driven by `lifecycleIsActive()` rather than re-listed here.
 *
 * Per design constraints: "No emojis. Use lucide-react for icons."
 */
import { memo } from "react";
import { cn } from "../lib/cn";
import {
  lifecycleIsActive,
  lifecycleLabel,
  type TaskLifecycle,
} from "../lib/task-lifecycle";

interface StatusIndicatorProps {
  status: TaskLifecycle;
  /** Override size in px. Defaults to 12px. */
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
  status: TaskLifecycle;
  size: number;
}): JSX.Element {
  // Anything the agent is advancing unattended reads as motion, so planning
  // and verifying are not silently downgraded to a still dot.
  if (lifecycleIsActive(status)) {
    return (
      <span
        className="spinner"
        role="img"
        aria-label={lifecycleLabel(status).toLowerCase()}
        style={{ width: size, height: size }}
      />
    );
  }
  switch (status) {
    case "queued":
    case "cancelled":
      return <StatusDot size={size} color="var(--color-agent-queued)" label={status} />;
    case "needs_you":
      return <StatusDot size={size} color="var(--color-agent-waiting)" label="needs you" />;
    case "review":
      return <StatusDot size={size} color="var(--color-success)" label="ready for review" />;
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
        <span className="text-xs text-secondary text-xs" >
          {label}
        </span>
      ) : null}
    </span>
  );
}

export const StatusIndicator = memo(StatusIndicatorImpl);

/**
 * Single always-visible status for the active task. The title bar is the one
 * authority for "what is this task doing"; surfaces below it no longer each
 * announce their own version of the same state.
 */
export const TaskStatusPill = memo(function TaskStatusPill(
  { status }: { status: TaskLifecycle },
): JSX.Element {
  return (
    <span
      className="ui-meta inline-flex shrink-0 items-center gap-1.5 rounded-md border border-subtle bg-subtle px-2 py-0.5 text-secondary"
      aria-label={`Task status: ${statusLabel(status)}`}
    >
      <StatusGlyph status={status} size={9} />
      {statusLabel(status)}
    </span>
  );
});

/**
 * Re-exported so callers that already import from this module keep one import.
 * The vocabulary itself lives in lib/task-lifecycle.ts.
 */
export const statusLabel = lifecycleLabel;
