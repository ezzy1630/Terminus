/**
 * Terminus Desktop — Sidebar item (single project/session row).
 *
 * Upgraded hybrid design blending T3 Code, Codex, and reference screenshot:
 *   - 2-line session card with high scanability.
 *   - Line 1: Title + right-aligned blue activity dot for active/running tasks.
 *   - Line 2: Status phase (e.g. Working..., PR is ready) + relative time + branch/PR glyphs.
 *   - Selected state visible with clean macOS elevation.
 *   - Compact rail mode support.
 */
import { memo, type KeyboardEventHandler } from "react";
import { GitBranch, GitPullRequest, Pin } from "lucide-react";
import { cn } from "../lib/cn";
import { StatusIndicator } from "./StatusIndicator";
import { lifecycleShortLabel, type TaskLifecycle } from "../lib/task-lifecycle";
import { IconButton } from "../ui/IconButton";
import { Button } from "../ui/Button";

interface SidebarItemProps {
  /** Title to display. */
  title: string;
  /** Status kind for tasks. Projects/spaces omit this. */
  status?: TaskLifecycle;
  /** ISO timestamp for relative time display. */
  updatedAt?: string;
  /** Branch name if associated with a worktree/branch. */
  branch?: string;
  /** Pull request status or number if available. */
  pullRequest?: string;
  /** Whether this row is currently selected. */
  selected: boolean;
  /** Whether this row is pinned. */
  pinned?: boolean;
  /** Compact mode: icons only. */
  compact?: boolean;
  /** Indentation depth (0 = top-level, 1 = nested session). */
  depth?: number;
  /** Click handler. */
  onClick?: () => void;
  /** Toggle pin. */
  onTogglePin?: () => void;
  /** Roving-focus plumbing for virtualized task sections. */
  primaryButtonRef?: (element: HTMLButtonElement | null) => void;
  primaryTabIndex?: number;
  onPrimaryKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
}

/**
 * A finished task needs no word beside a row that has stopped moving, so
 * `done` and `unknown` contribute nothing and the row falls back to the
 * timestamp alone.
 */
function statusPhrase(status?: TaskLifecycle): string | null {
  if (status === undefined || status === "done" || status === "unknown") return null;
  return lifecycleShortLabel(status);
}

/**
 * One meta line: what the task is doing, then when it last moved. A finished
 * task only needs the time — repeating "Done" beside a row with no activity
 * mark is a word that carries nothing.
 */
function metaLine(status?: TaskLifecycle, updatedAt?: string): string {
  const phrase = statusPhrase(status);
  const when = updatedAt ? relativeTimeAgo(updatedAt) : "";
  if (phrase && when) return `${phrase} · ${when}`;
  return phrase ?? when;
}

function relativeTimeAgo(isoTimestamp: string): string {
  try {
    const diffMs = Date.now() - new Date(isoTimestamp).getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return "";
  }
}

function SidebarItemImpl({
  title,
  status,
  updatedAt,
  branch,
  pullRequest,
  selected,
  pinned = false,
  compact = false,
  depth = 0,
  onClick,
  onTogglePin,
  primaryButtonRef,
  primaryTabIndex,
  onPrimaryKeyDown,
}: SidebarItemProps): JSX.Element {
  const subtitle = metaLine(status, updatedAt);

  if (compact) {
    // Rail mode: icon-only.
    return (
      <Button
        ref={primaryButtonRef}
        type="button"
        onClick={onClick}
        onKeyDown={onPrimaryKeyDown}
        tabIndex={primaryTabIndex}
        aria-label={title}
        aria-pressed={selected}
        data-tooltip={title}
        className={cn(
          "flex w-full items-center justify-center hover:bg-hover",
          selected && "bg-selected",
        )}
        style={{ height: "var(--row-height)" }}
      >
        {status ? (
          <StatusIndicator status={status} size={12} />
        ) : (
          <span className="block h-2 w-2 rounded-sm bg-neutral-status" aria-hidden />
        )}
      </Button>
    );
  }

  const isTwoLine = Boolean(status || subtitle);

  return (
    <div
      data-selected={selected}
      className={cn(
        "sidebar-task-row group relative flex cursor-default items-center rounded-lg text-sm transition-colors",
        selected ? "bg-selected text-primary font-medium shadow-xs" : "text-secondary hover:bg-hover hover:text-primary",
      )}
      style={{
        minHeight: isTwoLine ? 38 : "var(--row-height)",
        // Nested tasks hang from the same label column as their space row.
        paddingLeft: depth > 0 ? 34 : 8,
        paddingRight: 6,
        paddingTop: isTwoLine ? 4 : 0,
        paddingBottom: isTwoLine ? 4 : 0,
      }}
    >
      {status ? (
        <span className="pointer-events-none absolute left-3 top-2.5 flex w-4 justify-center" aria-hidden>
          <StatusIndicator status={status} size={10} />
        </span>
      ) : null}

      <Button
        ref={primaryButtonRef}
        variant="bare"
        type="button"
        onClick={onClick}
        onKeyDown={onPrimaryKeyDown}
        tabIndex={primaryTabIndex}
        aria-pressed={selected}
        data-tooltip={title}
        // The spoken label uses the human wording, not the lifecycle id: a
        // screen reader announced "status needs_you" and now says "status
        // Needs you", which is what the glyph beside it means.
        aria-label={
          status
            ? `${title}, status ${lifecycleShortLabel(status)}${selected ? ", selected" : ""}${pinned ? ", pinned" : ""}`
            : `${title}${selected ? ", selected" : ""}${pinned ? ", pinned" : ""}`
        }
        className="flex w-full min-w-0 flex-1 flex-col items-start justify-center gap-0.5"
      >
        {/* One line. Titles are objectives, so the second clamped line was
            almost always another half-sentence: it doubled the row height
            without making adjacent tasks distinguishable any faster than the
            first six words already do. */}
        <span className="w-full min-w-0 truncate text-left text-base font-medium leading-snug text-primary">
          {title}
        </span>

        {isTwoLine ? (
          <span className="flex w-full min-w-0 items-center gap-1 text-left text-xs leading-tight text-tertiary">
            <span className="truncate">{subtitle}</span>
            {branch ? (
              <span className="inline-flex shrink-0 items-center gap-0.5" data-tooltip={branch}>
                <GitBranch size={10} aria-hidden />
              </span>
            ) : null}
            {pullRequest ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-success" data-tooltip={pullRequest}>
                <GitPullRequest size={10} aria-hidden />
              </span>
            ) : null}
          </span>
        ) : null}
      </Button>

      {/* Right side pin button */}
      <span
        className="flex flex-shrink-0 items-center justify-end"
        style={{ width: 20 }}
      >
        {onTogglePin ? (
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            label={`${pinned ? "Unpin" : "Pin"} task ${title}`}
            icon={<Pin size={11} className={pinned ? "fill-current" : undefined} />}
            size="sm"
            className={cn(
              pinned && "text-primary",
              !pinned && "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
            )}
          />
        ) : null}
      </span>
    </div>
  );
}

export const SidebarItem = memo(SidebarItemImpl);
