/**
 * Terminus Desktop — the queue above the rail's body.
 *
 * Two questions get answered before anything else in this column, and they are
 * not the ones a chat history answers:
 *
 *   Needs you        2      ← blocked on a decision, or failed
 *     Fix auth race         Terminus  !
 *   • DB migration          Platform  !
 *   Working          1      ← moving on its own, nobody waiting
 *   • Refactor cache layer  Terminus  ◌
 *
 * Two shelves, because there are two states. Unread is not one of them: it is
 * a mark on the row (the blue dot above), and it appears here and in the day
 * groups below alike. An earlier draft of this file made it a third heading,
 * which asked the reader to file a task that was both blocked *and* unread
 * under one of two headings that were both true — and put routine news in the
 * one list that has to stay urgent to work at all.
 *
 * Two deliberate inversions from a conventional task list:
 *
 *   - Running work renders *quieter* than blocked work. Once an agent is
 *     safely moving it is not the operator's problem yet, and giving it the
 *     same weight as an approval prompt is how approval prompts get missed.
 *   - The queue scrolls with the body rather than being pinned above it.
 *     Eight blocked tasks must not squeeze the project tree out of the window.
 *
 * Headers are a name and a count and nothing else — the same header the board
 * columns draw. Icons and coloured dots beside a word that already says the
 * same thing are a restatement in a second alphabet, and the two surfaces
 * showing the same tasks should not disagree about that.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { Ellipsis } from "lucide-react";
import { useTerminusStore } from "../hooks/use-terminus";
import { useTaskReadStore } from "../hooks/use-task-read";
import {
  ATTENTION_LABEL,
  attentionReason,
  spansMultipleProjects,
  taskIsUnread,
  taskShelf,
  type TaskShelf,
} from "../lib/attention";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { taskTitle } from "../lib/task-lifecycle";
import { displayLifecycleWith } from "../lib/turn-activity";
import { readCollapsedStripSections, writeCollapsedStripSections } from "../lib/sidebar-prefs";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Menu, type MenuItem } from "../ui/Menu";
import { TaskRow, type TaskRowEmphasis } from "./TaskRow";
import type { TaskLifecycle } from "../lib/task-lifecycle";

/** Focuses the first row of the queue. Dispatched by ⌘⇧A and the palette. */
export const FOCUS_QUEUE_EVENT = "terminus:focus-queue";

interface QueueRow {
  readonly id: string;
  readonly title: string;
  readonly project: string | null;
  readonly lifecycle: TaskLifecycle;
  readonly updatedAt: string;
  readonly unread: boolean;
  readonly needsYou: boolean;
  /** Why it wants a human, for the tooltip and the spoken label. */
  readonly reason: string | null;
  readonly rank: number;
}

/**
 * How many rows a shelf shows before it offers the rest.
 *
 * Ten blocked tasks is a real Tuesday, and ten rows plus a day of finished
 * work is a rail you scroll to find the project tree. The cap keeps the queue
 * a summary; the count in the header is always the true total.
 */
const PREVIEW_ROWS = 5;
const PRIORITY_PREVIEW_ROWS = 8;

const SHELVES: ReadonlyArray<{
  readonly id: Exclude<TaskShelf, "settled">;
  readonly label: string;
  readonly emphasis: TaskRowEmphasis;
}> = [
  { id: "needs_you", label: ATTENTION_LABEL, emphasis: "queue" },
  { id: "working", label: "Working", emphasis: "active" },
];

interface TaskQueueProps {
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  /** Activity mode merges the two urgent shelves into Codex's one Priority list. */
  presentation?: "shelves" | "priority";
  /** List-level actions owned by the Activity header. */
  menuItems?: readonly MenuItem[];
}

function TaskQueueImpl({
  selectedTaskId,
  onSelectTask,
  presentation = "shelves",
  menuItems = [],
}: TaskQueueProps): JSX.Element | null {
  const sessions = useTerminusStore((s) => s.sessions);
  const tasksBySession = useTerminusStore((s) => s.tasksBySession);
  const runActivityByTask = useTerminusStore((s) => s.runActivityByTask);
  const seenAtByTask = useTaskReadStore((s) => s.seenAtByTask);
  const markRead = useTaskReadStore((s) => s.markRead);
  const markManyRead = useTaskReadStore((s) => s.markManyRead);

  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedStripSections);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => { writeCollapsedStripSections(collapsed); }, [collapsed]);

  const toggleExpanded = useCallback((id: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const shelves = useMemo(() => {
    const projectNames = new Map(sessions.map((session) => [session.id, session.title]));
    const grouped: Record<Exclude<TaskShelf, "settled">, QueueRow[]> = {
      needs_you: [],
      working: [],
    };
    for (const tasks of Object.values(tasksBySession)) {
      for (const task of tasks) {
        const lifecycle = displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown");
        const updatedAt = task.updated_at || task.created_at;
        const unread = taskIsUnread(updatedAt, seenAtByTask[task.id]);
        const reason = attentionReason({ lifecycle, domainTask: task });
        const shelf = taskShelf(lifecycle, reason);
        if (shelf === "settled") continue;
        grouped[shelf].push({
          id: task.id,
          title: taskTitle(task),
          project: projectNames.get(task.session_id) ?? null,
          lifecycle,
          updatedAt,
          unread,
          needsYou: reason !== null,
          reason: reason?.label ?? null,
          rank: reason?.rank ?? Number.MAX_SAFE_INTEGER,
        });
      }
    }
    // Inside the queue, cheapest-to-discharge first: a question is one click, a
    // failure is a read. Recency is the wrong order for a list whose whole
    // purpose is to be worked from the top down. Working is an observation, so
    // recency is exactly right for it.
    grouped.needs_you.sort((left, right) =>
      left.rank - right.rank
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id));
    grouped.working.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    return grouped;
  }, [runActivityByTask, seenAtByTask, sessions, tasksBySession]);

  /**
   * Every row on screen, in visual order. The arrow keys walk this, so a
   * shelf that is collapsed or folded to its preview is genuinely absent from
   * the traversal rather than silently focusable.
   */
  const visibleRows = useMemo(() => {
    const rows: Array<{ row: QueueRow; shelf: Exclude<TaskShelf, "settled"> }> = [];
    if (presentation === "priority") {
      for (const row of shelves.needs_you) rows.push({ row, shelf: "needs_you" });
      for (const row of shelves.working) rows.push({ row, shelf: "working" });
      return expanded.has("priority") ? rows : rows.slice(0, PRIORITY_PREVIEW_ROWS);
    }
    for (const shelf of SHELVES) {
      if (collapsed.has(shelf.id)) continue;
      const all = shelves[shelf.id];
      const shown = expanded.has(shelf.id) ? all : all.slice(0, PREVIEW_ROWS);
      for (const row of shown) rows.push({ row, shelf: shelf.id });
    }
    return rows;
  }, [collapsed, expanded, presentation, shelves]);

  // Roving focus. One tab stop for the whole queue; arrows move within it, so
  // Tab does not have to walk thirty rows to reach the body underneath.
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const registerRow = useCallback((taskId: string, element: HTMLButtonElement | null): void => {
    if (element === null) rowRefs.current.delete(taskId);
    else rowRefs.current.set(taskId, element);
  }, []);

  const tabbableTaskId = focusedTaskId !== null
    && visibleRows.some((entry) => entry.row.id === focusedTaskId)
    ? focusedTaskId
    : visibleRows[0]?.row.id ?? null;

  const focusRow = useCallback((taskId: string): void => {
    setFocusedTaskId(taskId);
    rowRefs.current.get(taskId)?.focus();
  }, []);

  // ⌘⇧A, and the command palette, land here. Linear's `G I`: the queue is the
  // one list worth a dedicated key, and it had no keyboard route at all.
  useEffect(() => {
    const onFocusQueue = (): void => {
      const first = visibleRows[0]?.row.id;
      if (first !== undefined) focusRow(first);
    };
    window.addEventListener(FOCUS_QUEUE_EVENT, onFocusQueue);
    return () => window.removeEventListener(FOCUS_QUEUE_EVENT, onFocusQueue);
  }, [focusRow, visibleRows]);

  const onRowKeyDown = useCallback((
    taskId: string,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const index = visibleRows.findIndex((entry) => entry.row.id === taskId);
    if (index === -1) return;

    // `e` clears the unread mark without opening the task. It does not clear
    // the row: a blocked task is still blocked once you have read the prompt,
    // and a key that emptied this list would be a button for hiding work.
    if (event.key === "e" || event.key === "E") {
      const entry = visibleRows[index];
      if (!entry || !entry.row.unread) return;
      event.preventDefault();
      markRead(entry.row.id, entry.row.updatedAt);
      return;
    }

    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j") nextIndex = index + 1;
    else if (event.key === "ArrowUp" || event.key === "k") nextIndex = index - 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = visibleRows.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const target = visibleRows[Math.max(0, Math.min(nextIndex, visibleRows.length - 1))];
    if (target) focusRow(target.row.id);
  }, [focusRow, markRead, visibleRows]);

  const toggleSection = useCallback((id: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Nothing blocked and nothing running is the good state, and it earns no
  // chrome. A permanent "Needs you 0" is an alarm that is always on, which is
  // an alarm nobody hears.
  if (shelves.needs_you.length + shelves.working.length === 0) return null;

  if (presentation === "priority") {
    const priorityCount = shelves.needs_you.length + shelves.working.length;
    const hiddenPriorityCount = priorityCount - visibleRows.length;
    return (
      <div className="group/priority flex flex-col" aria-label="Priority tasks">
        <div className="flex h-8 items-center px-2">
          <span className="sidebar-section-label min-w-0 flex-1 truncate">Priority</span>
          {menuItems.length > 0 ? (
            <Menu
              label="Activity actions"
              align="end"
              items={[...menuItems]}
              trigger={(
                <IconButton
                  label="Activity actions"
                  icon={<Ellipsis size={14} strokeWidth={1.7} aria-hidden />}
                  size="sm"
                  className="h-6 w-6 rounded-md text-tertiary hover:bg-hover hover:text-primary"
                />
              )}
            />
          ) : null}
        </div>
        {visibleRows.map(({ row, shelf }) => (
          <QueueRowItem
            key={`priority-${row.id}`}
            row={row}
            emphasis={shelf === "needs_you" ? "queue" : "active"}
            showProjectMeta
            stacked
            selected={row.id === selectedTaskId}
            tabbable={row.id === tabbableTaskId}
            onSelectTask={onSelectTask}
            onMarkRead={markRead}
            registerRow={registerRow}
            onRowKeyDown={onRowKeyDown}
          />
        ))}
        {hiddenPriorityCount > 0 || expanded.has("priority") ? (
          <Button
            type="button"
            variant="bare"
            onClick={() => toggleExpanded("priority")}
            aria-label={hiddenPriorityCount > 0
              ? `Show ${hiddenPriorityCount} more priority tasks`
              : "Show fewer priority tasks"}
            className="sidebar-show-more ui-body flex h-7 w-full items-center rounded-md pl-3 pr-2 text-left text-tertiary hover:bg-hover hover:text-secondary"
          >
            {hiddenPriorityCount > 0 ? "Show more" : "Show less"}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1" aria-label="Task queue">
      {SHELVES.map((shelf) => {
        const rows = shelves[shelf.id];
        if (rows.length === 0) return null;
        // Per shelf, not per workspace. "Needs you" holding two rows from the
        // same repository does not need a project column, even when four other
        // repositories are open — and in a 256px rail that column is 40% of
        // the row.
        const showProjectMeta = spansMultipleProjects(rows.map((row) => row.project ?? ""));
        return (
          <QueueShelf
            key={shelf.id}
            id={shelf.id}
            label={shelf.label}
            emphasis={shelf.emphasis}
            rows={rows}
            collapsed={collapsed.has(shelf.id)}
            expanded={expanded.has(shelf.id)}
            onToggle={toggleSection}
            onToggleExpanded={toggleExpanded}
            showProjectMeta={showProjectMeta}
            selectedTaskId={selectedTaskId}
            tabbableTaskId={tabbableTaskId}
            onSelectTask={onSelectTask}
            onMarkRead={markRead}
            registerRow={registerRow}
            onRowKeyDown={onRowKeyDown}
          />
        );
      })}
    </div>
  );
}

function QueueShelf({
  id,
  label,
  emphasis,
  rows,
  collapsed,
  expanded,
  onToggle,
  onToggleExpanded,
  showProjectMeta,
  selectedTaskId,
  tabbableTaskId,
  onSelectTask,
  onMarkRead,
  registerRow,
  onRowKeyDown,
}: {
  id: string;
  label: string;
  emphasis: TaskRowEmphasis;
  rows: readonly QueueRow[];
  collapsed: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
  onToggleExpanded: (id: string) => void;
  showProjectMeta: boolean;
  selectedTaskId: string | null;
  tabbableTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onMarkRead: (taskId: string, updatedAt: string) => void;
  registerRow: (taskId: string, element: HTMLButtonElement | null) => void;
  onRowKeyDown: (taskId: string, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  const visible = expanded ? rows : rows.slice(0, PREVIEW_ROWS);
  const hidden = rows.length - visible.length;
  const loud = emphasis === "queue";
  return (
    <div className="group/shelf flex flex-col">
      {/* Name and count. Same header the board columns draw, so the two
          surfaces showing the same tasks agree on what a section looks like. */}
      <div className="flex h-7 items-center gap-1.5 px-2">
        <Button
          variant="bare"
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}, ${rows.length}`}
          className={cn(
            "ui-meta flex min-w-0 flex-1 items-center gap-1.5 text-left",
            // Human attention is the one resource the app cannot manufacture
            // more of, so the shelf that spends it is the only coloured one.
            loud ? "font-medium text-warning" : "hover:text-secondary",
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <span className="shrink-0 tabular-nums">{rows.length}</span>
        </Button>
      </div>
      {collapsed ? null : visible.map((row) => (
        <QueueRowItem
          key={`${id}-${row.id}`}
          row={row}
          emphasis={emphasis}
          showProjectMeta={showProjectMeta}
          selected={row.id === selectedTaskId}
          tabbable={row.id === tabbableTaskId}
          onSelectTask={onSelectTask}
          onMarkRead={onMarkRead}
          registerRow={registerRow}
          onRowKeyDown={onRowKeyDown}
        />
      ))}
      {!collapsed && (hidden > 0 || expanded) ? (
        <Button
          type="button"
          variant="bare"
          onClick={() => onToggleExpanded(id)}
          aria-label={hidden > 0 ? `Show ${hidden} more in ${label}` : `Show fewer in ${label}`}
          className="sidebar-show-more ui-body flex h-7 w-full items-center rounded-md pl-[18px] pr-2 text-left text-tertiary hover:bg-hover hover:text-secondary"
        >
          {hidden > 0 ? "Show more" : "Show less"}
        </Button>
      ) : null}
    </div>
  );
}

const QueueRowItem = memo(function QueueRowItem({
  row,
  emphasis,
  showProjectMeta,
  stacked = false,
  selected,
  tabbable,
  onSelectTask,
  onMarkRead,
  registerRow,
  onRowKeyDown,
}: {
  row: QueueRow;
  emphasis: TaskRowEmphasis;
  showProjectMeta: boolean;
  stacked?: boolean;
  selected: boolean;
  tabbable: boolean;
  onSelectTask: (taskId: string) => void;
  onMarkRead: (taskId: string, updatedAt: string) => void;
  registerRow: (taskId: string, element: HTMLButtonElement | null) => void;
  onRowKeyDown: (taskId: string, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  const handleClick = useCallback(() => onSelectTask(row.id), [onSelectTask, row.id]);
  const handleRef = useCallback(
    (element: HTMLButtonElement | null) => registerRow(row.id, element),
    [registerRow, row.id],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => onRowKeyDown(row.id, event),
    [onRowKeyDown, row.id],
  );
  const handleMarkRead = useCallback(
    () => onMarkRead(row.id, row.updatedAt),
    [onMarkRead, row.id, row.updatedAt],
  );
  return (
    <TaskRow
      taskId={row.id}
      title={row.title}
      status={row.lifecycle}
      selected={selected}
      needsYou={row.needsYou}
      unread={row.unread}
      emphasis={emphasis}
      layout={stacked ? "stacked" : "inline"}
      // Flush, not nested. These rows were indented under their heading like
      // children of a project, which put the one list that must be read first
      // furthest from the eye's left-hand scan line.
      depth={0}
      {...(showProjectMeta && row.project ? { meta: row.project } : {})}
      {...(row.reason ? { reason: row.reason } : {})}
      // Clearing the mark is available wherever the mark is; `TaskRow` shows
      // the control only when there is something to clear.
      onMarkRead={handleMarkRead}
      onClick={handleClick}
      primaryButtonRef={handleRef}
      primaryTabIndex={tabbable ? 0 : -1}
      onPrimaryKeyDown={handleKeyDown}
    />
  );
});

export const TaskQueue = memo(TaskQueueImpl);
