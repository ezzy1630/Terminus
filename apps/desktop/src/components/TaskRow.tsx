/**
 * Terminus Desktop — one task, one row, everywhere it appears.
 *
 * There used to be four of these: `SidebarItem` for the tree, `InboxRow` for
 * the day groups, a wrapper around `SidebarItem` for the queue, and a fourth
 * hand-written row in the board's list mode. They disagreed about truncation,
 * about which controls appear on hover, about where the status mark sits, and
 * — because two of them wrote their own dot markup — about what colour a
 * failed task is. Four implementations of one object is exactly how a window
 * stops reading as though one person designed it.
 *
 * The row is a title. Everything else has to earn its width:
 *
 *   - **The unread dot**, leading, in the accent colour. Read-state is not a
 *     status and must not be dressed as one: "nobody has looked at this" is
 *     orthogonal to "this is blocked", and a task can easily be both. It reads
 *     the way every mail client has taught it — a blue dot in a reserved
 *     gutter, so titles stay aligned whether or not a row is marked.
 *   - **The status mark**, trailing. Only when the agent is moving or a human
 *     is wanted. A dot on every row is decoration, and thirty of them is an
 *     alarm panel.
 *   - **The project.** Only when the row's position does not already say. A
 *     list whose rows all come from one repository does not need that word
 *     thirty times, and in a 256px rail it costs ~40% of the line.
 *   - **The action.** Pin, or mark-unread, in one 14px slot that is always
 *     present so the title column cannot shift under the cursor.
 *
 * Emphasis, not variants. A queue row and a history row are the same object at
 * two volumes, so they share every metric except weight and where the mark
 * sits — which is what lets the eye read the column as one list.
 */
import { memo, type KeyboardEventHandler, type ReactNode } from "react";
import { Check, Dot, Pin } from "lucide-react";
import { cn } from "../lib/cn";
import { lifecycleIsActive, lifecycleShortLabel, type TaskLifecycle } from "../lib/task-lifecycle";
import { StatusIndicator } from "./StatusIndicator";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

/**
 * How loudly the row reads.
 *
 * `queue` is for work blocked on a human. Those rows were metrically identical
 * to the twenty rows of finished work underneath them, so a column with nine
 * decisions waiting and twenty things already dealt with gave both the same
 * voice and the twenty won on sheer mass.
 *
 * `active` is the same shape for work the agent is advancing on its own: it
 * belongs above the history, but it is not asking for anything yet, so it does
 * not get the weight a blocked task gets. Running work being *quieter* than
 * blocked work is a deliberate inversion of the usual task list.
 *
 * There is deliberately no "unread" emphasis. Unread is a mark, not a shelf —
 * see the leading dot above.
 */
export type TaskRowEmphasis = "queue" | "active" | "normal";

export interface TaskRowProps {
  /** Scroll anchor. The rail finds the row by this id when a shelf moves it. */
  taskId?: string;
  title: string;
  /** Lifecycle. Rows that are not tasks (a bare project) omit it. */
  status?: TaskLifecycle;
  selected: boolean;
  emphasis?: TaskRowEmphasis;
  /**
   * The task is blocked on a human. Passed in rather than derived, so
   * `lib/attention.ts` stays the only thing that decides what that means.
   */
  needsYou?: boolean;
  /** The task has changed since it was last opened. */
  unread?: boolean;
  /**
   * Recessive trailing label — the project this row belongs to. Set it only on
   * rows whose position does not already answer that question.
   */
  meta?: string;
  /**
   * Why the task wants a human, when it does. Never rendered: at rail width
   * there is no room for a title, a project and a reason. It rides in the
   * tooltip and the spoken label, where it costs nothing and still means the
   * rail can answer "why?" without opening the task.
   */
  reason?: string;
  /** Indentation depth (0 = top-level, 1 = nested under a project). */
  depth?: number;
  pinned?: boolean;
  onClick?: () => void;
  /** Toggle pin. Omitted for rows that cannot be pinned. */
  onTogglePin?: () => void;
  /**
   * Clear an outcome without opening it. The one action the queue can complete
   * in place, and the reason the Unread shelf is a list you can empty rather
   * than a number that only ever grows.
   */
  onMarkRead?: () => void;
  /**
   * Put a read outcome back in the queue. Reading settles a row on its own, so
   * a task glanced at by accident needs a way back; without one the automatic
   * transition is a silent, un-undoable loss.
   */
  onMarkUnread?: () => void;
  /** Roving-focus plumbing for virtualized task sections. */
  primaryButtonRef?: (element: HTMLButtonElement | null) => void;
  primaryTabIndex?: number;
  onPrimaryKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
}

/**
 * The mark, or nothing.
 *
 * Motion means the agent is advancing the task with no one waiting on it. A
 * dot means the row wants something or is news, and its colour says which —
 * amber blocked, red failed, green ready to read, muted done. All of these
 * were one amber dot until the queue started listing them side by side, at
 * which point ten identical dots stopped distinguishing the thing that is on
 * fire from the thing that merely finished.
 *
 * `StatusIndicator` draws it, here and on the board, so the two surfaces
 * cannot drift into two colour maps for one vocabulary.
 */
function RowGlyph({ status }: { status: TaskLifecycle }): JSX.Element {
  return <StatusIndicator status={status} size={8} />;
}

/**
 * Nobody has looked at this yet.
 *
 * Accent blue, and only ever this — it is the one mark in the rail that is not
 * about what the agent is doing, so it must not be confusable with the amber,
 * red and green that are. The gutter is reserved on every row so a list does
 * not re-align itself as things are read.
 */
function UnreadDot(): JSX.Element {
  return (
    <span className="block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
  );
}

function TaskRowImpl({
  taskId,
  title,
  status,
  selected,
  emphasis = "normal",
  needsYou = false,
  unread = false,
  meta,
  reason,
  depth = 0,
  pinned = false,
  onClick,
  onTogglePin,
  onMarkRead,
  onMarkUnread,
  primaryButtonRef,
  primaryTabIndex,
  onPrimaryKeyDown,
}: TaskRowProps): JSX.Element {
  // A mark is earned, not default: the agent is moving, or a human is wanted.
  // Being unread is not a status and gets its own mark, in its own gutter.
  const showGlyph = status !== undefined && (lifecycleIsActive(status) || needsYou);
  const glyph = showGlyph && status ? <RowGlyph status={status} /> : null;

  // Shelved rows stand a row taller than the history below; only the blocked
  // one is set at full strength. Geometry is otherwise identical everywhere,
  // which is what lets the eye read the whole column as one list.
  const shelved = emphasis !== "normal";
  const loud = emphasis === "queue";

  const trailingAction: ReactNode = onTogglePin ? (
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
      <Pin size={12} className={pinned ? "fill-current" : undefined} aria-hidden />
    </Button>
  ) : onMarkRead && unread ? (
    <IconButton
      label={`Mark ${title} as read`}
      icon={<Check size={12} strokeWidth={2} aria-hidden />}
      size="sm"
      onClick={onMarkRead}
      data-tooltip="Mark read  E"
      className="absolute inset-0 flex items-center justify-center rounded-sm text-tertiary opacity-0 transition-opacity hover:text-primary group-hover:opacity-100 group-focus-within:opacity-100"
    />
  ) : onMarkUnread && !unread ? (
    <IconButton
      label={`Mark ${title} unread`}
      icon={<Dot size={12} strokeWidth={1.7} aria-hidden />}
      size="sm"
      onClick={onMarkUnread}
      data-tooltip="Mark unread"
      className="absolute inset-0 flex items-center justify-center rounded-sm text-tertiary opacity-0 transition-opacity hover:text-primary group-hover:opacity-100 group-focus-within:opacity-100"
    />
  ) : null;

  const tooltip = [title, meta, reason].filter(Boolean).join(" — ");

  return (
    <div
      data-selected={selected}
      {...(taskId ? { "data-task-row": taskId } : {})}
      className={cn(
        "sidebar-task-row group relative flex cursor-default items-center rounded-md transition-colors",
        shelved ? "gap-1" : "gap-1.5",
        selected ? "bg-selected text-primary" : "text-secondary hover:bg-hover hover:text-primary",
        loud && !selected && "text-primary",
      )}
      style={{
        // Always a couple of pixels above the history underneath it, whatever
        // the density: the difference has to survive both scales, and reusing
        // the nav row's height made these rows *shorter* than task rows in the
        // spacious one.
        height: shelved ? "calc(var(--row-height) + 2px)" : "var(--row-height)",
        // Nested tasks hang from the same text column as their project row.
        paddingLeft: depth > 0 ? 20 : 6,
        paddingRight: 6,
      }}
    >
      {/* The unread gutter. Reserved on every row, in every list, so reading
          one thing does not shift the thirty titles underneath it sideways. */}
      <span className="flex h-1.5 w-1.5 shrink-0 items-center justify-center">
        {unread ? <UnreadDot /> : null}
      </span>
      <Button
        ref={primaryButtonRef}
        variant="bare"
        type="button"
        onClick={onClick}
        onKeyDown={onPrimaryKeyDown}
        tabIndex={primaryTabIndex}
        aria-pressed={selected}
        data-tooltip={tooltip}
        // The spoken label uses the human wording, not the lifecycle id: a
        // screen reader announced "status needs_you" and now says "status
        // Needs you", which is what the glyph beside it means.
        aria-label={[
          title,
          meta ? `in ${meta}` : null,
          reason ?? (status ? `status ${lifecycleShortLabel(status)}` : null),
          unread ? "unread" : null,
          selected ? "selected" : null,
          pinned ? "pinned" : null,
        ].filter(Boolean).join(", ")}
        className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left leading-none"
      >
        <span
          className={cn(
            // `flex-auto`, not `flex-1`. `flex-1` is basis 0, which means the
            // title never claims any width of its own — the project label took
            // its content width first and the title lived on the remainder, so
            // a long title and a long project name both came out truncated.
            // With basis auto the two compete honestly, and the shrink factor
            // below decides who gives.
            "min-w-0 flex-auto truncate ui-body",
            loud && "font-medium",
          )}
        >
          {title}
        </span>
        {/* The title always wins.
            `max-w` alone was not enough: flexbox shrinks both children in
            proportion to their content, so a long title and a long project
            name both ended up truncated — "Hyperparameter…" beside
            "Learning …", two halves of nothing. An outsized `flex-shrink`
            makes this label absorb effectively all of the shortfall, so it
            gives up its own width, down to none at all, before the title
            loses a character. */}
        {meta ? (
          <span
            className="ui-meta min-w-0 max-w-[45%] truncate"
            style={{ flexShrink: 500 }}
          >
            {meta}
          </span>
        ) : null}
      </Button>

      {/* One 14px trailing slot, always present when the row has anything to
          put in it, so the title column cannot shift under the cursor. It
          shows the status mark at rest and the action while the row is hovered
          or focused; a pinned row keeps its pin visible, because that filled
          pin is the only way to unpin. */}
      {glyph || trailingAction ? (
        <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {glyph ? (
            <span
              className={cn(
                "flex items-center justify-center",
                trailingAction && !pinned && "group-hover:invisible group-focus-within:invisible",
              )}
            >
              {glyph}
            </span>
          ) : null}
          {trailingAction}
        </span>
      ) : null}
    </div>
  );
}

export const TaskRow = memo(TaskRowImpl);
