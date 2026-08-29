/**
 * Terminus Desktop — one row in the sidebar tree.
 *
 * This used to be a two-line card: title, then a "Failed · 2h ago" meta line,
 * with a status dot in the left gutter. Three pieces of chrome per row, in a
 * column of thirty rows, none of which answered the question the sidebar is
 * for — *which task is this*. Codex's rail is a list of titles, and it reads
 * far faster because of it.
 *
 * So: one line, one type size, no subtitle, no leading dot. Status earns a
 * mark only when it is asking for something — a spinner while the agent is
 * moving on its own, a small warning dot when the task wants a human. A done
 * task is simply a title, which is exactly how much attention it deserves.
 */
import { memo, type KeyboardEventHandler } from "react";
import { Pin } from "lucide-react";
import { cn } from "../lib/cn";
import {
  lifecycleIsActive,
  lifecycleNeedsAttention,
  lifecycleShortLabel,
  type TaskLifecycle,
} from "../lib/task-lifecycle";
import { Button } from "../ui/Button";

interface SidebarItemProps {
  /** Title to display. */
  title: string;
  /** Task lifecycle. Rows that are not tasks (a bare project) omit it. */
  status?: TaskLifecycle;
  /** Whether this row is currently selected. */
  selected: boolean;
  /** Whether this row is pinned. */
  pinned?: boolean;
  /**
   * Icon-only rail row. Nothing in the app mounts this: the compact rail was
   * removed from the sidebar when it turned out to have no caller and no
   * breakpoint. It survives here only because `tests/components.test.tsx`
   * still exercises it, and that file is shared. Drop the prop and that test
   * together.
   */
  compact?: boolean;
  /** Indentation depth (0 = top-level, 1 = nested under a project). */
  depth?: number;
  /** Click handler. */
  onClick?: () => void;
  /** Toggle pin. Omitted for rows that cannot be pinned. */
  onTogglePin?: () => void;
  /** Roving-focus plumbing for virtualized task sections. */
  primaryButtonRef?: (element: HTMLButtonElement | null) => void;
  primaryTabIndex?: number;
  onPrimaryKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
}

/**
 * The trailing mark, or nothing.
 *
 * Two states earn a glyph. Motion means the agent is advancing the task with
 * no one waiting on it; the warning dot means the row is one of the ones
 * counted by "Needs attention", which is `lifecycleNeedsAttention` — a failed
 * task is as much a request for a human as an approval prompt is, and dropping
 * its mark to match a literal reading of "needs you" would have hidden
 * failures entirely now that the meta line is gone.
 */
function StatusGlyph({ status }: { status: TaskLifecycle }): JSX.Element | null {
  if (lifecycleIsActive(status)) {
    return <span className="spinner-sm" role="img" aria-label={lifecycleShortLabel(status)} />;
  }
  if (lifecycleNeedsAttention(status)) {
    return (
      <span
        className="block h-1.5 w-1.5 rounded-full bg-warning"
        role="img"
        aria-label={lifecycleShortLabel(status)}
      />
    );
  }
  return null;
}

function SidebarItemImpl({
  title,
  status,
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
  const glyph = status ? <StatusGlyph status={status} /> : null;

  if (compact) {
    return (
      <Button
        ref={primaryButtonRef}
        type="button"
        variant="bare"
        onClick={onClick}
        onKeyDown={onPrimaryKeyDown}
        tabIndex={primaryTabIndex}
        aria-label={title}
        aria-pressed={selected}
        data-tooltip={title}
        className={cn(
          "flex w-full items-center justify-center rounded-md hover:bg-hover",
          selected && "bg-selected",
        )}
        style={{ height: "var(--row-height)" }}
      >
        {glyph ?? <span className="block h-1.5 w-1.5 rounded-full bg-neutral-status" aria-hidden />}
      </Button>
    );
  }

  return (
    <div
      data-selected={selected}
      className={cn(
        "sidebar-task-row group relative flex cursor-default items-center gap-1.5 rounded-md transition-colors",
        selected ? "text-primary" : "text-secondary hover:bg-hover hover:text-primary",
      )}
      style={{
        height: "var(--row-height)",
        // Nested tasks hang from the same text column as their project row.
        paddingLeft: depth > 0 ? 26 : 8,
        paddingRight: 6,
      }}
    >
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
        className="min-w-0 flex-1 truncate text-left text-base leading-none"
      >
        {title}
      </Button>

      {/* One 14px trailing slot, always present so the title column cannot
          shift under the cursor. It shows the status mark at rest and the pin
          toggle while the row is hovered or focused; a pinned row keeps its
          pin visible, because that filled pin is the only way to unpin. */}
      <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {glyph ? (
          <span
            className={cn(
              "flex items-center justify-center",
              onTogglePin && !pinned && "group-hover:invisible group-focus-within:invisible",
            )}
          >
            {glyph}
          </span>
        ) : null}
        {onTogglePin ? (
          <Button
            variant="bare"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin();
            }}
            aria-label={`${pinned ? "Unpin" : "Pin"} task ${title}`}
            aria-pressed={pinned}
            className={cn(
              "absolute inset-0 flex items-center justify-center rounded-sm text-tertiary hover:text-primary",
              pinned
                ? "text-primary"
                : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
            )}
          >
            <Pin size={11} className={pinned ? "fill-current" : undefined} aria-hidden />
          </Button>
        ) : null}
      </span>
    </div>
  );
}

export const SidebarItem = memo(SidebarItemImpl);
