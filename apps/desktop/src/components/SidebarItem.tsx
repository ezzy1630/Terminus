/**
 * Terminus Desktop — Sidebar item (single project/task row).
 *
 * Per SPEC §7.1:
 *   - Task rows must be easy to scan.
 *   - Selected state must be visible without a bright saturated background.
 *   - Hover actions should not cause layout shift.
 *   - Long names must truncate gracefully.
 *   - Show full names in tooltips.
 *
 * Per SPEC §7.2: minimal semantic status indicator (tiny spinner, dot,
 * checkmark, etc.). No large colorful badges.
 *
 * Compact mode (SPEC §24): icons only.
 */
import { memo, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { cn } from "../lib/cn";
import { StatusIndicator } from "./StatusIndicator";
import { normalizeTaskStatus } from "../hooks/use-terminus";
import type { TaskStatusKind } from "../types";

interface SidebarItemProps {
  /** Title to display. */
  title: string;
  /** Status kind for tasks. Projects omit this. */
  status?: TaskStatusKind;
  /** ISO timestamp for relative time display. */
  updatedAt?: string;
  /** Whether this row is currently selected. */
  selected: boolean;
  /** Whether this row is pinned. */
  pinned?: boolean;
  /** Compact mode: icons only. */
  compact?: boolean;
  /** Indentation depth (0 = top-level project, 1 = nested task). */
  depth?: number;
  /** Click handler. */
  onClick?: () => void;
  /** Toggle pin. */
  onTogglePin?: () => void;
}

function SidebarItemImpl({
  title,
  status,
  updatedAt: _updatedAt,
  selected,
  pinned = false,
  compact = false,
  depth = 0,
  onClick,
  onTogglePin,
}: SidebarItemProps): JSX.Element {
  const [hovered, setHovered] = useState(false);

  if (compact) {
    // Rail mode: icon-only.
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        aria-pressed={selected}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "flex w-full items-center justify-center",
          selected ? "bg-selected" : hovered ? "bg-hover" : "transparent",
        )}
        style={{ height: "var(--row-height)" }}
      >
        {status ? (
          <StatusIndicator status={status} size={12} />
        ) : (
          <span
            className="block rounded-sm"
            style={{ width: 8, height: 8, background: "var(--text-tertiary)" }}
            aria-hidden
          />
        )}
      </button>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-pressed={selected}
      aria-label={
        status
          ? `${title}, status ${status}${selected ? ", selected" : ""}${pinned ? ", pinned" : ""}`
          : `${title}${selected ? ", selected" : ""}${pinned ? ", pinned" : ""}`
      }
      title={title}
      className={cn(
        "sidebar-task-row group relative flex cursor-default items-center gap-2 rounded-md text-sm",
        selected ? "bg-selected text-primary" : hovered ? "bg-hover text-primary" : "text-secondary",
      )}
      style={{
        height: "var(--row-height)",
        paddingLeft: 8 + depth * 12,
        paddingRight: 6,
      }}
    >
      {/* Status indicator — pinned to the left of the title. */}
      <span className="flex w-4 flex-shrink-0 items-center justify-center">
        {status ? (
          <StatusIndicator status={status} size={12} />
        ) : (
          <span
            className="block rounded-sm"
            style={{ width: 6, height: 6, background: "var(--text-tertiary)" }}
            aria-hidden
          />
        )}
      </span>

      {/* Title — truncate with ellipsis. */}
      <span className="min-w-0 flex-1 truncate" style={{ fontSize: "var(--font-size-base)" }}>
        {title}
      </span>

      {/* Right side: reserve a compact action slot so hover affordances never
          move the task title. Recency is available in the inspector instead
          of adding a noisy second column to every navigation row. */}
      <span
        className="flex flex-shrink-0 items-center justify-end gap-1"
        style={{ width: 22 }}
      >
        {onTogglePin ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            aria-label={`${pinned ? "Unpin" : "Pin"} task ${title}`}
            title={pinned ? "Unpin" : "Pin"}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded text-tertiary hover:bg-hover",
              pinned && "text-primary",
              !hovered && !pinned && "invisible",
            )}
          >
            {pinned ? <Pin size={11} /> : <PinOff size={11} />}
          </button>
        ) : null}
      </span>
    </div>
  );
}

export const SidebarItem = memo(SidebarItemImpl);
