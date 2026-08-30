/**
 * The three live shelves at the top of the thread sidebar.
 *
 * Task state stays canonical in task-lifecycle.ts and attention.ts. This file
 * only projects those states into the order a person needs while working:
 * obligations first, unattended work second, reviewable outcomes third.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../lib/cn";
import { useTerminusStore } from "../hooks/use-terminus";
import { useTaskReadStore } from "../hooks/use-task-read";
import {
  attentionReason,
  spansMultipleProjects,
  taskIsUnread,
  taskShelf,
} from "../lib/attention";
import { taskTitle, type TaskLifecycle } from "../lib/task-lifecycle";
import { displayLifecycleWith } from "../lib/turn-activity";
import { readCollapsedStripSections, writeCollapsedStripSections } from "../lib/sidebar-prefs";
import { Button } from "../ui/Button";
import { TaskRow, type TaskRowEmphasis } from "./TaskRow";

/** Focuses the first live row. Dispatched by Command-Shift-A and the palette. */
export const FOCUS_QUEUE_EVENT = "terminus:focus-queue";

type LiveShelf = "needs_you" | "running" | "ready_to_review";

interface QueueRow {
  readonly id: string;
  readonly title: string;
  readonly sessionId: string;
  readonly project: string | null;
  readonly lifecycle: TaskLifecycle;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly unread: boolean;
  readonly needsYou: boolean;
  readonly reason: string | null;
  readonly rank: number;
}

const PREVIEW_ROWS = 5;

const SHELVES: ReadonlyArray<{
  readonly id: LiveShelf;
  readonly label: string;
  readonly emphasis: TaskRowEmphasis;
}> = [
  { id: "needs_you", label: "Needs you", emphasis: "queue" },
  { id: "running", label: "Running", emphasis: "active" },
  { id: "ready_to_review", label: "Ready to review", emphasis: "normal" },
];

interface TaskQueueProps {
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  /** A project id filters the shelves. Null shows every loaded project. */
  sessionId?: string | null;
}

function liveShelfFor(
  lifecycle: TaskLifecycle,
  reason: ReturnType<typeof attentionReason>,
  unread: boolean,
): LiveShelf | null {
  if (lifecycle === "review") return "ready_to_review";
  const shelf = taskShelf(lifecycle, reason, unread);
  if (shelf === "needs_you") return "needs_you";
  if (shelf === "working") return "running";
  return null;
}

function TaskQueueImpl({
  selectedTaskId,
  onSelectTask,
  sessionId = null,
}: TaskQueueProps): JSX.Element | null {
  const sessions = useTerminusStore((s) => s.sessions);
  const tasksBySession = useTerminusStore((s) => s.tasksBySession);
  const runActivityByTask = useTerminusStore((s) => s.runActivityByTask);
  const seenAtByTask = useTaskReadStore((s) => s.seenAtByTask);
  const markRead = useTaskReadStore((s) => s.markRead);

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
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const grouped: Record<LiveShelf, QueueRow[]> = {
      needs_you: [],
      running: [],
      ready_to_review: [],
    };
    const taskLists = sessionId === null
      ? Object.values(tasksBySession)
      : [tasksBySession[sessionId] ?? []];

    for (const tasks of taskLists) {
      for (const task of tasks) {
        const lifecycle = displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown");
        const updatedAt = task.updated_at || task.created_at;
        const unread = taskIsUnread(updatedAt, seenAtByTask[task.id]);
        const reason = attentionReason({ lifecycle, domainTask: task });
        const shelf = liveShelfFor(lifecycle, reason, unread);
        if (shelf === null) continue;
        grouped[shelf].push({
          id: task.id,
          title: taskTitle(task),
          sessionId: task.session_id,
          project: sessionsById.get(task.session_id)?.title ?? null,
          lifecycle,
          startedAt: task.active_turn?.started_at ?? null,
          updatedAt,
          unread,
          needsYou: reason !== null,
          reason: reason?.label ?? null,
          rank: reason?.rank ?? Number.MAX_SAFE_INTEGER,
        });
      }
    }

    grouped.needs_you.sort((left, right) =>
      left.rank - right.rank
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id));
    grouped.running.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    grouped.ready_to_review.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    return grouped;
  }, [runActivityByTask, seenAtByTask, sessionId, sessions, tasksBySession]);

  const visibleRows = useMemo(() => {
    const rows: Array<{ row: QueueRow; shelf: LiveShelf }> = [];
    for (const shelf of SHELVES) {
      if (collapsed.has(shelf.id)) continue;
      const all = shelves[shelf.id];
      const shown = expanded.has(shelf.id) ? all : all.slice(0, PREVIEW_ROWS);
      for (const row of shown) rows.push({ row, shelf: shelf.id });
    }
    return rows;
  }, [collapsed, expanded, shelves]);

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

  if (SHELVES.every((shelf) => shelves[shelf.id].length === 0)) return null;

  return (
    <div className="flex flex-col gap-1" aria-label="Active threads">
      {SHELVES.map((shelf) => {
        const rows = shelves[shelf.id];
        if (rows.length === 0) return null;
        const showProjectMeta = sessionId === null
          && spansMultipleProjects(rows.map((row) => row.sessionId));
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
  id: LiveShelf;
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
  return (
    <div className="group/shelf flex flex-col">
      <div className="flex h-7 items-center px-2">
        <Button
          variant="bare"
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}, ${rows.length}`}
          className={cn(
            "ui-section-label flex min-w-0 flex-1 items-center gap-1.5 text-left",
            id === "needs_you" ? "text-warning" : "hover:text-secondary",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="shrink-0 tabular-nums">{rows.length}</span>
        </Button>
      </div>
      {collapsed ? null : visible.map((row) => (
        <QueueRowItem
          key={`${id}-${row.id}`}
          row={row}
          shelf={id}
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
          className="sidebar-show-more ui-body flex h-7 w-full items-center rounded-md px-2 text-left text-tertiary hover:bg-hover hover:text-secondary"
        >
          {hidden > 0 ? "Show more" : "Show less"}
        </Button>
      ) : null}
    </div>
  );
}

const QueueRowItem = memo(function QueueRowItem({
  row,
  shelf,
  emphasis,
  showProjectMeta,
  selected,
  tabbable,
  onSelectTask,
  onMarkRead,
  registerRow,
  onRowKeyDown,
}: {
  row: QueueRow;
  shelf: LiveShelf;
  emphasis: TaskRowEmphasis;
  showProjectMeta: boolean;
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
      layout="inline"
      depth={0}
      {...(showProjectMeta && row.project ? { meta: row.project } : {})}
      {...(row.reason ? { reason: row.reason } : {})}
      {...(shelf === "needs_you" ? { onMarkRead: handleMarkRead } : {})}
      onClick={handleClick}
      primaryButtonRef={handleRef}
      primaryTabIndex={tabbable ? 0 : -1}
      onPrimaryKeyDown={handleKeyDown}
    />
  );
});

export const TaskQueue = memo(TaskQueueImpl);
