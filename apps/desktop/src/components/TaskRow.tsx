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
 *   - **The outcome mark**, leading. Red means the thread needs attention.
 *     Blue means completed work has not been read. No lifecycle prose is
 *     repeated in the row.
 *   - **The progress ring**, trailing. Only while the agent is moving.
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
  /** Activity uses a title plus project line; project trees stay one-line. */
  layout?: "inline" | "stacked";
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
  /** Recessive status or timing beside the title in a stacked activity row. */
  detail?: string;
  /** Secondary context beside the project, currently the exact selected model. */
  context?: string;
  /**
   * Why the task wants a human, when it does. Stacked priority rows may also
   * expose its short label through `detail`; this field remains the semantic
   * source for the tooltip and spoken label.
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
function OutcomeDot({ kind }: { kind: "attention" | "unread-complete" }): JSX.Element {
  return (
    <span
      className={cn(
        "block h-1.5 w-1.5 rounded-full",
        kind === "attention" ? "bg-error" : "bg-accent",
      )}
      aria-hidden
    />
  );
}

function TaskRowImpl({
  taskId,
  title,
  status,
  layout = "inline",
  selected,
  emphasis = "normal",
  needsYou = false,
  unread = false,
  meta,
  detail,
  context,
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
  const active = status !== undefined && lifecycleIsActive(status);
  const attention = needsYou || status === "failed";
  const completedUnread = unread && (status === "done" || status === "review" || status === "cancelled");
  const outcome = attention ? "attention" : completedUnread ? "unread-complete" : null;
  const glyph = active ? <span className="spinner-sm" role="img" aria-label="working" /> : null;

  // Shelved rows stand a row taller than the history below; only the blocked
  // one is set at full strength. Geometry is otherwise identical everywhere,
  // which is what lets the eye read the whole column as one list.
  const shelved = emphasis !== "normal";
  const loud = emphasis === "queue";
  // A second line is reserved for real context such as a project name. Merely
  // selecting a row does not make lifecycle prose reappear beneath it.
  const stacked = layout === "stacked" || Boolean(meta || context || detail);
  const resolvedDetail = detail;

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

  const tooltip = [title, meta, context, resolvedDetail, reason]
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
    .join(" - ");

  return (
    <div
      data-selected={selected}
      {...(taskId ? { "data-task-row": taskId } : {})}
      className={cn(
        "sidebar-task-row group relative flex cursor-default items-center rounded-md transition-colors",
        stacked ? "gap-2" : shelved ? "gap-1" : "gap-1.5",
        selected ? "bg-selected text-primary" : "text-secondary hover:bg-hover hover:text-primary",
        loud && !selected && "text-primary",
      )}
      style={{
        // Always a couple of pixels above the history underneath it, whatever
        // the density: the difference has to survive both scales, and reusing
        // the nav row's height made these rows *shorter* than task rows in the
        // spacious one.
        height: stacked && selected && context
          ? 58
          : stacked
            ? 48
            : shelved
              ? "calc(var(--row-height) + 2px)"
              : "var(--row-height)",
        // Nested tasks hang from the same text column as their project row.
        paddingLeft: stacked ? 10 : depth > 0 ? 20 : 6,
        paddingRight: stacked ? 10 : 6,
      }}
    >
      <span className="flex h-1.5 w-1.5 shrink-0 items-center justify-center">
        {outcome ? <OutcomeDot kind={outcome} /> : null}
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
          context ? `using ${context}` : null,
          resolvedDetail && resolvedDetail !== reason ? resolvedDetail : null,
          reason ?? (status ? `status ${lifecycleShortLabel(status)}` : null),
          unread ? "unread" : null,
          selected ? "selected" : null,
          pinned ? "pinned" : null,
        ].filter(Boolean).join(", ")}
        className={cn(
          "min-w-0 flex-1 text-left",
          stacked
            ? "flex h-full flex-col items-start justify-center gap-0.5 leading-tight"
            : "flex items-baseline gap-1.5 leading-none",
        )}
      >
        {stacked ? (
          <>
            <span className={cn("ui-body w-full min-w-0 flex-none truncate text-primary", loud && "font-medium")}>
              {title}
            </span>
            {meta || resolvedDetail ? (
              <span className="flex w-full min-w-0 items-baseline gap-2">
                {meta ? <span className="ui-meta min-w-0 flex-1 truncate">{meta}</span> : <span className="flex-1" />}
                {resolvedDetail ? (
                  <span className="ui-meta max-w-[52%] shrink-0 truncate text-secondary">
                    {resolvedDetail}
                  </span>
                ) : null}
              </span>
            ) : null}
            {selected && context ? (
              <span className="ui-meta w-full min-w-0 flex-none truncate" data-tooltip={context}>
                {context}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span
              className={cn("ui-body min-w-0 flex-auto truncate", loud && "font-medium")}
            >
              {title}
            </span>
            {/* The title wins: this label absorbs shortfall before the title. */}
            {meta ? (
              <span
                className="ui-meta min-w-0 max-w-[45%] truncate"
                style={{ flexShrink: 500 }}
              >
                {meta}
              </span>
            ) : null}
          </>
        )}
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
