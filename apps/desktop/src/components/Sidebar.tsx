/**
 * Terminus Desktop — Sidebar.
 *
 * The rail, top to bottom:
 *
 *   Terminus ⌄                      ⌕  ☰   ← project switcher, search, grouping
 *   ✎ New task
 *   ▤ Board
 *   Needs you                          2   ← the queue: see TaskQueue
 *   • Fix the auth race        Website  !
 *     DB migration             Platform !
 *   Working                            1
 *   • Refactor cache layer    Terminus  ◌
 *   Today                                  ← the body: finished work, by day,
 *   • Rebuild the release bundle             or by project — one control, not
 *     Bump the kernel protocol               two modes
 *   Yesterday
 *     Clean git and rebuild app
 *   ─────────────────────────────────────
 *   ◍ Terminus                        ⚙ ·
 *
 * The blue dot is unread. It is a mark rather than a section, because "nobody
 * has looked at this" is orthogonal to "this is blocked" — a task that needs
 * you is usually also unread, and hoisting unread work into its own heading
 * next to the queue asked the reader to file such a task under one of two
 * headings that were both true. So it appears wherever the row appears, in the
 * queue and in the day groups alike, and reading a task clears it without
 * moving the row anywhere.
 *
 * There used to be an `[ Inbox | Projects ]` segmented control here, and it
 * swapped the entire body between two lists of the same tasks. That is a
 * *display setting* wearing the costume of a navigation mode: nothing about
 * the rail's job changes when you file the same rows by day instead of by
 * repository. It is now one list with a grouping menu in the header, which is
 * the shape every tool that has this problem converges on — and it gave the
 * column a whole horizontal band back.
 *
 * Per SPEC §7.1: "Projects contain nested tasks. Do not expose worktrees or
 * branches as another permanent hierarchy level."
 * Per SPEC §7.2: selected state is visible without a bright saturated bg.
 *
 * The rail is deliberately the quietest region in the window. Navigation is
 * there to be found, not read — so its icons sit at tertiary, its section
 * labels at 12px tertiary, and nothing in here competes with the transcript
 * for attention it has not earned.
 *
 * On re-render cost: task rows are memoized on primitive props and read their
 * own lifecycle out of the store by id. A streaming turn therefore re-renders
 * the one row it concerns, not the whole tree. The queue is a separate
 * component for the same reason — it genuinely needs every task's activity to
 * count what is running, and keeping that subscription inside it stops the
 * whole rail re-rendering on every token.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bell,
  ChevronDown,
  ChevronRight,
  Columns3,
  Folder,
  FolderOpen,
  Plus,
  Search,
  Settings,
  SquarePen,
  Terminal,
  UsersRound,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/cn";
import { useTerminusStore, usePinnedTasks } from "../hooks/use-terminus";
import { taskTitle } from "../lib/task-lifecycle";
import { displayLifecycleWith } from "../lib/turn-activity";
import type { TurnActivity } from "../lib/turn-activity";
import { useThemeStore } from "../hooks/use-theme";
import {
  readCollapsedProjects,
  readExpandedProjects,
  readSidebarGrouping,
  writeCollapsedProjects,
  writeExpandedProjects,
  writeSidebarGrouping,
} from "../lib/sidebar-prefs";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Menu, type MenuItem } from "../ui/Menu";
import { Skeleton } from "../ui/Status";
import { TaskRow } from "./TaskRow";
import { TaskQueue } from "./TaskQueue";
import { useTaskReadStore } from "../hooks/use-task-read";
import { attentionReason, spansMultipleProjects, taskIsUnread, taskShelf } from "../lib/attention";
import { ProjectMenu, projectSubtitle } from "./ProjectMenu";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { Session, Task } from "../types";

interface SidebarProps {
  activeDestination?: SidebarDestination;
  onNavigate?: (destination: SidebarDestination) => void;
  onOpenProject?: () => void;
}

export type SidebarDestination =
  | "new_task"
  | "chat"
  | "board"
  | "agents"
  | "task_details";

/** Opens the Activity projection without creating or selecting work. */
export const SHOW_ACTIVITY_EVENT = "terminus:show-activity";

/**
 * How many loaded tasks in a project want a human, for the rollup dot.
 *
 * A collapsed project that is hiding an approval prompt is the one case where
 * collapsing loses information rather than just space, so the row keeps a mark
 * even when its children are folded away. Counts blocked work only — a folded
 * project hiding three tasks that merely finished is not a warning.
 */
function sessionAttentionCount(
  tasks: readonly Task[],
  runActivityByTask: Record<string, TurnActivity>,
): number {
  let count = 0;
  for (const task of tasks) {
    const lifecycle = displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown");
    if (attentionReason({ lifecycle, domainTask: task }) !== null) count += 1;
  }
  return count;
}

/**
 * Keep a task's row on screen when the rail moves it.
 *
 * Reading a finished task settles it out of the queue and into its day, which
 * is correct and also means the row the operator was just looking at vanishes
 * from under the cursor and reappears somewhere below the fold. The rail
 * follows it: `block: "nearest"` scrolls the minimum distance that makes the
 * row visible, so a row already on screen does not move at all.
 *
 * Keyed on the *shelf*, not on every render — otherwise a task streaming
 * tokens would drag the sidebar around once per frame.
 */
function useKeepTaskInView(taskId: string | null, shelf: string | null): void {
  useEffect(() => {
    if (!taskId) return;
    // After the re-render that moved it, and only if it is really mounted.
    const frame = window.requestAnimationFrame(() => {
      const row = document.querySelector(`[data-task-row="${CSS.escape(taskId)}"]`);
      row?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [shelf, taskId]);
}

function SidebarImpl({
  activeDestination = "new_task",
  onNavigate,
  onOpenProject,
}: SidebarProps): JSX.Element {
  const sessions = useTerminusStore((s) => s.sessions);
  const tasksBySession = useTerminusStore((s) => s.tasksBySession);
  const taskById = useTerminusStore((s) => s.taskById);
  const sessionsPage = useTerminusStore((s) => s.sessionsPage);
  const sessionsFreshness = useTerminusStore((s) => s.sessionsFreshness);
  const taskListFreshnessBySession = useTerminusStore((s) => s.taskListFreshnessBySession);
  const taskPagesBySession = useTerminusStore((s) => s.taskPagesBySession);
  const taskFreshnessById = useTerminusStore((s) => s.taskFreshnessById);
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const selectedTaskId = useTerminusStore((s) => s.selectedTaskId);
  const pinnedTaskIds = useTerminusStore((s) => s.pinnedTaskIds);
  const loadingSessions = useTerminusStore((s) => s.loadingSessions);
  const healthReady = useTerminusStore((s) => s.healthReady);
  const healthStatus = useTerminusStore((s) => s.healthStatus);
  const pinPersistenceError = useTerminusStore((s) => s.pinPersistenceError);
  const runActivityByTask = useTerminusStore((s) => s.runActivityByTask);
  const seenAtByTask = useTaskReadStore((s) => s.seenAtByTask);
  const markManyRead = useTaskReadStore((s) => s.markManyRead);

  const selectSession = useTerminusStore((s) => s.selectSession);
  const selectTask = useTerminusStore((s) => s.selectTask);
  const togglePin = useTerminusStore((s) => s.togglePin);
  const refreshSessions = useTerminusStore((s) => s.refreshSessions);
  const refreshAll = useTerminusStore((s) => s.refreshAll);
  const loadMoreSessions = useTerminusStore((s) => s.loadMoreSessions);
  const loadMoreTasks = useTerminusStore((s) => s.loadMoreTasks);
  const refreshTask = useTerminusStore((s) => s.refreshTask);
  const refreshVisibleSessionTasks = useTerminusStore((s) => s.refreshVisibleSessionTasks);

  const pinnedTasks = usePinnedTasks();
  const projectNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const session of sessions) names.set(session.id, session.title);
    return names;
  }, [sessions]);
  // Activity is a projection over the same tasks, not a second navigation
  // column. It is the default because the rail opens to the work that changed,
  // while the project tree remains one explicit toggle away. The choice is
  // durable and changing it never creates or selects a task.
  const [activityVisible, setActivityVisible] = useState(
    () => readSidebarGrouping() === "recent",
  );
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(readCollapsedProjects);
  const [expandedTaskLists, setExpandedTaskLists] = useState<Set<string>>(readExpandedProjects);

  // Written on change rather than at every toggle site: the collapsed set is
  // moved from four places, and a persistence call at each is four chances to
  // add a fifth that forgets.
  useEffect(() => { writeCollapsedProjects(collapsedSessions); }, [collapsedSessions]);
  useEffect(() => { writeExpandedProjects(expandedTaskLists); }, [expandedTaskLists]);
  useEffect(() => {
    writeSidebarGrouping(activityVisible ? "recent" : "project");
  }, [activityVisible]);
  useEffect(() => {
    const showActivity = (): void => setActivityVisible(true);
    window.addEventListener(SHOW_ACTIVITY_EVENT, showActivity);
    return () => window.removeEventListener(SHOW_ACTIVITY_EVENT, showActivity);
  }, []);

  // A task can be opened from anywhere — the palette, a notification, the
  // queue — and landing on a rail whose only sign of the open task is a folded
  // project reads as the selection having failed.
  const selectedTaskSessionId = selectedTaskId ? taskById[selectedTaskId]?.session_id ?? null : null;
  const selectedTask = selectedTaskId ? taskById[selectedTaskId] : undefined;
  const selectedShelf = selectedTask
    ? (() => {
        const lifecycle = displayLifecycleWith(selectedTask, runActivityByTask[selectedTask.id] ?? "unknown");
        const updatedAt = selectedTask.updated_at || selectedTask.created_at;
        return taskShelf(
          lifecycle,
          attentionReason({ lifecycle, domainTask: selectedTask }),
          taskIsUnread(updatedAt, seenAtByTask[selectedTask.id]),
        );
      })()
    : null;
  useKeepTaskInView(selectedTaskId, selectedShelf);
  useEffect(() => {
    if (!selectedTaskSessionId) return;
    setCollapsedSessions((previous) => {
      if (!previous.has(selectedTaskSessionId)) return previous;
      const next = new Set(previous);
      next.delete(selectedTaskSessionId);
      return next;
    });
  }, [selectedTaskSessionId]);

  // The navigation callbacks below are handed to memoized rows, so they have to
  // keep a stable identity across the sidebar's own re-renders. `onNavigate` is
  // an inline arrow at the call site and changes on every parent render, so it
  // is read through a ref rather than closed over.
  const onNavigateRef = useRef(onNavigate);
  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  const projectRows = useMemo<Array<{ session: Session; tasks: Task[] }>>(
    () => sessions.map((session) => ({ session, tasks: tasksBySession[session.id] ?? [] })),
    [sessions, tasksBySession],
  );
  const visiblePinnedTasks = pinnedTasks;
  // Pins are the one list here that crosses projects — but only sometimes.
  // Asked of the workspace ("are there several projects?") this was true for
  // anyone with more than one repository open, so three pins from the same
  // project each gave 40% of their width to the same word.
  const showProjectMeta = useMemo(
    () => spansMultipleProjects(visiblePinnedTasks.map((task) => task.session_id)),
    [visiblePinnedTasks],
  );
  const unresolvedPinnedTaskIds = useMemo(
    () => [...pinnedTaskIds].filter((taskId) => !taskById[taskId]),
    [pinnedTaskIds, taskById],
  );

  const toggleCollapsed = (sessionId: string): void => {
    setCollapsedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const onNewTask = useCallback((): void => {
    // The New Task screen is shown when selectedTaskId === null. Clearing the
    // selection routes the main surface to <NewTaskScreen />.
    onNavigateRef.current?.("new_task");
    selectTask(null);
  }, [selectTask]);

  const onSelectTask = useCallback((taskId: string): void => {
    onNavigateRef.current?.("chat");
    selectTask(taskId);
  }, [selectTask]);

  /**
   * The rail's one search control.
   *
   * It used to unfold a filter field inside the column that narrowed the tree
   * in place. Search is now a surface over the workspace — recent tasks across
   * every project, narrowed as you type — so the rail never moves under it.
   * The palette keeps ⌘K and is reachable from inside the search.
   */
  const openTaskSearch = useCallback((): void => {
    window.dispatchEvent(new Event("terminus:open-task-search"));
  }, []);

  /**
   * How the body is filed, and the housekeeping that belongs to the body
   * rather than to any one group in it.
   *
   * Visible at rest as an icon in the header, not revealed on hover: the
   * project tree is a primary way to navigate, and burying the only route to
   * it behind a hover target is how the old unlabelled tab pair failed.
   */
  const unreadSettled = useMemo(() => {
    const rows: Array<{ id: string; updatedAt: string }> = [];
    for (const tasks of Object.values(tasksBySession)) {
      for (const task of tasks) {
        const updatedAt = task.updated_at || task.created_at;
        if (taskIsUnread(updatedAt, seenAtByTask[task.id])) rows.push({ id: task.id, updatedAt });
      }
    }
    return rows;
  }, [seenAtByTask, tasksBySession]);

  const activityMenuItems = useMemo<MenuItem[]>(() => [
    {
      id: "activity.mark-all-read",
      label: "Mark all as read",
      disabled: unreadSettled.length === 0,
      onSelect: () => markManyRead(unreadSettled),
    },
    {
      id: "activity.refresh",
      label: "Refresh activity",
      onSelect: () => { void refreshVisibleSessionTasks(); },
    },
  ], [markManyRead, refreshVisibleSessionTasks, unreadSettled]);

  return (
    <div className="flex h-full flex-col">
      {/* ── Header: which project, and the two global affordances ─────────── */}
      <div className="flex items-center gap-0.5 px-2 pb-1 pt-2">
        <ProjectMenu
          onProjectSelected={onNewTask}
          {...(onOpenProject ? { onOpenProject } : {})}
          trigger={(
            <Button
              type="button"
              variant="bare"
              aria-label="Switch project"
              data-tooltip="Switch project"
              className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left hover:bg-hover"
            >
              <span className="ui-page-title min-w-0 truncate text-primary">
                {sessions.find((session) => session.id === selectedSessionId)?.title ?? "Terminus"}
              </span>
              <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-tertiary" aria-hidden />
            </Button>
          )}
        />
        <IconButton
          label="Search tasks"
          icon={<Search size={14} strokeWidth={1.7} aria-hidden />}
          size="sm"
          onClick={openTaskSearch}
          data-tooltip="Search tasks  ⌘K"
          className="h-7 w-7 shrink-0 rounded-md text-tertiary hover:bg-hover hover:text-primary"
        />
        <IconButton
          label={activityVisible ? "Show projects" : "Show activity"}
          icon={activityVisible
            ? <Folder size={14} strokeWidth={1.7} aria-hidden />
            : <Bell size={14} strokeWidth={1.7} aria-hidden />}
          size="sm"
          aria-pressed={activityVisible}
          onClick={() => setActivityVisible((visible) => !visible)}
          data-tooltip={activityVisible ? "Show projects" : "Show activity"}
          className={cn(
            "h-7 w-7 shrink-0 rounded-md hover:bg-hover hover:text-primary",
            activityVisible ? "bg-selected text-accent" : "text-tertiary",
          )}
        />
      </div>

      {/* ── Destinations ──────────────────────────────────────────────────── */}
      <nav className="flex flex-col px-2 pb-1" aria-label="Workspace navigation">
        <NavRow
          icon={<SquarePen size={14} strokeWidth={1.7} aria-hidden />}
          label="New task"
          active={activeDestination === "new_task"}
          onClick={onNewTask}
          tooltip="New task  ⌘N"
        />
        <NavRow
          icon={<Columns3 size={14} strokeWidth={1.7} aria-hidden />}
          label="Board"
          active={activeDestination === "board"}
          onClick={() => onNavigateRef.current?.("board")}
          tooltip="Board — every task, by stage"
        />
        <NavRow
          icon={<Activity size={14} strokeWidth={1.7} aria-hidden />}
          label="Activity"
          active={activityVisible}
          onClick={() => setActivityVisible(true)}
          tooltip="Activity — recent and attention-needed work"
        />
        <NavRow
          icon={<UsersRound size={14} strokeWidth={1.7} aria-hidden />}
          label="Agents"
          active={activeDestination === "agents"}
          onClick={() => onNavigateRef.current?.("agents")}
          tooltip="Agent directory"
        />
      </nav>

      {/* ── The body ──────────────────────────────────────────────────────── */}
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 pt-1">
        {/* Activity and projects occupy the same column. Activity stays inside
            this scroll root so a busy day cannot displace the shell itself. */}
        {activityVisible ? (
          <>
            <TaskQueue
              presentation="priority"
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
              menuItems={activityMenuItems}
            />
            <RecentList selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} stacked />
          </>
        ) : (
          <>
            {visiblePinnedTasks.length > 0 || unresolvedPinnedTaskIds.length > 0 || pinPersistenceError ? (
              <SidebarSection label="Pinned">
            {visiblePinnedTasks.map((task) => (
              <SidebarTaskRow
                key={`pin-${task.id}`}
                taskId={task.id}
                title={taskTitle(task)}
                selected={task.id === selectedTaskId}
                pinned
                depth={0}
                // Pins are the one list here that crosses projects, so it is
                // the one list where a title alone cannot say which repository
                // it belongs to.
                {...(showProjectMeta
                  ? { meta: projectNameById.get(task.session_id) ?? undefined }
                  : {})}
                onSelect={onSelectTask}
                onTogglePin={togglePin}
              />
            ))}
            {unresolvedPinnedTaskIds.map((taskId) => {
              const freshness = taskFreshnessById[taskId];
              const loading = freshness?.status === "loading";
              return (
                <div key={`unresolved-pin-${taskId}`} className="flex flex-col">
                  <TaskRow
                    title={loading
                      ? `Loading pinned task ${taskId}`
                      : `Pinned task ${taskId} — unavailable`}
                    selected={false}
                    pinned
                    depth={0}
                    onClick={() => void refreshTask(taskId)}
                    onTogglePin={() => togglePin(taskId)}
                  />
                  {freshness?.error ? (
                    <span role="status" className="ui-meta break-words px-2 pb-1 pl-8 text-warning">
                      This task is unavailable. Select the pinned row to retry.
                    </span>
                  ) : null}
                </div>
              );
            })}
            {pinPersistenceError ? (
              <span role="alert" className="ui-meta px-2 py-1 text-warning">
                {pinPersistenceError}
              </span>
            ) : null}
              </SidebarSection>
            ) : null}

            <SidebarSection
              label="Projects"
              action={(
            /* Revealed on hover, except when there are no projects at all —
               hiding "add a project" precisely when the list is empty is
               exactly backwards, which is how it used to behave. */
            <span
              className={cn(
                "flex items-center gap-0.5 opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100",
                sessions.length === 0 && "opacity-100",
              )}
            >
              <ProjectMenu
                align="end"
                label="Add or switch project"
                onProjectSelected={onNewTask}
                {...(onOpenProject ? { onOpenProject } : {})}
                trigger={(
                  <IconButton
                    label="Add or switch project"
                    icon={<Plus size={12} strokeWidth={1.7} aria-hidden />}
                    size="sm"
                    className="h-5 w-5 rounded-sm text-tertiary hover:bg-hover hover:text-primary"
                  />
                )}
              />
            </span>
              )}
            >
          {(loadingSessions || sessionsFreshness.status === "loading") && sessions.length === 0 ? (
            <div className="grid gap-2 px-2 py-2" role="status" aria-label="Loading projects">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-4/5" />
            </div>
          ) : null}

          {sessions.length === 0 && sessionsFreshness.status === "error" && healthStatus !== "offline" ? (
            <div className="ui-meta flex flex-col items-start gap-2 px-2 py-3 text-error" role="alert">
              <span>Projects could not be loaded.</span>
              <Button size="sm" onClick={() => void refreshSessions()}>
                Retry projects
              </Button>
            </div>
          ) : null}

          {/* A failed refresh with rows still on screen is the opposite
              problem to a failed first load: nothing looks wrong, so the rail
              quietly claims to be current while the counts above it are from
              whenever the last good response arrived. One quiet line, no
              alarm — the rows below it are real, just old. */}
          {sessions.length > 0 && sessionsFreshness.status === "error" && healthStatus !== "offline" ? (
            <div className="ui-meta flex items-center gap-1.5 px-2 pb-1" role="status">
              <span className="min-w-0 truncate">Not up to date</span>
              <Button
                variant="bare"
                type="button"
                onClick={() => void refreshSessions()}
                aria-label="Retry loading projects"
                className="shrink-0 rounded-sm text-tertiary underline-offset-2 hover:text-primary hover:underline"
              >
                Retry
              </Button>
            </div>
          ) : null}

          {projectRows.length === 0 && !loadingSessions && sessionsFreshness.status !== "error" ? (
            <div className="ui-meta flex flex-col items-start gap-2 px-2 py-3">
              <span>{sessionsFreshness.status === "ready"
                ? "No projects yet."
                : "Projects have not loaded yet."}</span>
              {onOpenProject ? (
                <Button size="sm" onClick={() => onOpenProject()}>
                  <FolderOpen size={12} />
                  Open project
                </Button>
              ) : null}
            </div>
          ) : null}

          {projectRows.map(({ session, tasks }) => {
            const collapsed = collapsedSessions.has(session.id);
            // Only computed for a collapsed row: an expanded project already
            // shows its own marks, and a second one on the parent would just
            // be the same fact twice.
            const hiddenAttention = collapsed
              ? sessionAttentionCount(tasks, runActivityByTask)
              : 0;
            const taskPage = taskPagesBySession[session.id];
            const taskListFreshness = taskListFreshnessBySession[session.id];
            const taskListExpanded = expandedTaskLists.has(session.id);
            const selectedTaskIndex = tasks.findIndex((task) => task.id === selectedTaskId);
            const visibleCount = sidebarVisibleTaskCount(tasks.length, selectedTaskIndex, taskListExpanded);
            const visibleTasks = collapsed ? [] : tasks.slice(0, visibleCount);
            const hiddenTaskCount = Math.max(0, tasks.length - visibleTasks.length);
            // Codex marks the project you are working in. A task selection
            // marks its own row instead, so the two highlights never compete.
            const projectSelected = session.id === selectedSessionId && selectedTaskId === null;

            return (
              <div key={session.id} className="flex flex-col">
                <div
                  className={cn(
                    "group/project flex items-center gap-1.5 rounded-md transition-colors",
                    projectSelected ? "bg-selected text-primary" : "text-secondary hover:bg-hover hover:text-primary",
                  )}
                  style={{ height: "var(--row-height)", paddingLeft: 4, paddingRight: 6 }}
                >
                  {tasks.length > 0 ? (
                    <IconButton
                      onClick={() => toggleCollapsed(session.id)}
                      className="h-5 w-5 shrink-0 rounded-sm text-tertiary hover:bg-hover hover:text-primary"
                      label={`${collapsed ? "Expand" : "Collapse"} ${session.title}`}
                      size="sm"
                      aria-expanded={!collapsed}
                      aria-controls={`session-tasks-${session.id}`}
                      icon={(
                        /* A folder at rest, a disclosure chevron under the
                           cursor: one glyph slot, so the row never shifts. */
                        <span className="relative flex h-4 w-4 items-center justify-center">
                          <span className="flex group-hover/project:opacity-0">
                            {collapsed ? <Folder size={14} strokeWidth={1.7} /> : <FolderOpen size={14} strokeWidth={1.7} />}
                          </span>
                          <span className="absolute flex opacity-0 group-hover/project:opacity-100">
                            {collapsed ? <ChevronRight size={14} strokeWidth={1.7} /> : <ChevronDown size={14} strokeWidth={1.7} />}
                          </span>
                        </span>
                      )}
                    />
                  ) : (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-tertiary" aria-hidden>
                      <Folder size={14} strokeWidth={1.7} />
                    </span>
                  )}
                  <Button
                    variant="bare"
                    onClick={() => {
                      selectSession(session.id);
                      setCollapsedSessions((previous) => {
                        if (!previous.has(session.id)) return previous;
                        const next = new Set(previous);
                        next.delete(session.id);
                        return next;
                      });
                    }}
                    className="ui-body min-w-0 flex-1 truncate text-left leading-none"
                    // Two projects can share a name; only the root tells them
                    // apart, so it is on the row rather than three clicks away.
                    data-tooltip={projectSubtitle(session) ?? session.title}
                    aria-current={session.id === selectedSessionId ? "page" : undefined}
                  >
                    {session.title}
                  </Button>
                  {/* Collapsing a project should cost space, not information.
                      Without this, folding a project away also folds away the
                      only sign that something inside it is waiting. */}
                  {hiddenAttention > 0 ? (
                    <span
                      className="block h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                      role="img"
                      aria-label={`${hiddenAttention} needing you in ${session.title}`}
                    />
                  ) : null}
                </div>

                {!collapsed && visibleTasks.length > 0 ? (
                  <>
                    <SessionTaskList
                      id={`session-tasks-${session.id}`}
                      tasks={visibleTasks}
                      selectedTaskId={selectedTaskId}
                      pinnedTaskIds={pinnedTaskIds}
                      onSelectTask={onSelectTask}
                      onTogglePin={togglePin}
                    />
                    {hiddenTaskCount > 0 ? (
                      <QuietRow
                        onClick={() => setExpandedTaskLists((previous) => {
                          const next = new Set(previous);
                          next.add(session.id);
                          return next;
                        })}
                        label={`Show ${hiddenTaskCount} more tasks in ${session.title}`}
                      >
                        Show more
                      </QuietRow>
                    ) : taskListExpanded && tasks.length > COLLAPSED_TASK_LIMIT ? (
                      <QuietRow
                        onClick={() => setExpandedTaskLists((previous) => {
                          const next = new Set(previous);
                          next.delete(session.id);
                          return next;
                        })}
                        label={`Show fewer tasks in ${session.title}`}
                      >
                        Show less
                      </QuietRow>
                    ) : null}
                  </>
                ) : null}

                {!collapsed && taskListFreshness?.status === "error" && tasks.length === 0 ? (
                  <span role="alert" className="ui-meta px-2 pl-[26px] text-error">
                    Tasks could not be loaded.
                  </span>
                ) : null}

                {!collapsed && taskPage?.nextCursor ? (
                  <div className="flex flex-col items-start">
                    <QuietRow
                      onClick={() => void loadMoreTasks(session.id)}
                      disabled={taskPage.loadingMore}
                      label={`Load more tasks in ${session.title}`}
                    >
                      {taskPage.loadingMore ? "Loading…" : taskPage.error ? "Retry" : "Show more"}
                    </QuietRow>
                    {taskPage.error ? (
                      <span role="alert" className="ui-meta px-2 pl-[26px] text-error">More tasks could not be loaded.</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}

          {sessionsPage.nextCursor ? (
            <div className="flex flex-col items-start">
              <QuietRow
                onClick={() => void loadMoreSessions()}
                disabled={sessionsPage.loadingMore}
                label="Load more projects"
              >
                {sessionsPage.loadingMore ? "Loading…" : sessionsPage.error ? "Retry" : "Show more"}
              </QuietRow>
              {sessionsPage.error ? (
                <span role="alert" className="ui-meta px-2 text-error">More projects could not be loaded.</span>
              ) : null}
            </div>
          ) : null}
            </SidebarSection>
          </>
        )}
      </div>

      {/* ── Footer dock ───────────────────────────────────────────────────── */}
      <div className="sidebar-dock flex h-11 items-center gap-2 px-2">
        {/* There is no account here — Terminus has no sign-in — so this is the
            workspace mark, not a person. Inventing an avatar with initials
            would be claiming an identity the app does not have. */}
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-subtle bg-elevated text-tertiary"
          aria-hidden
        >
          <Terminal size={12} strokeWidth={1.8} />
        </span>
        <span className="ui-body min-w-0 flex-1 truncate text-secondary">
          {sessions.find((session) => session.id === selectedSessionId)?.title ?? "Terminus"}
        </span>
        <IconButton
          label="Settings"
          icon={<Settings size={14} strokeWidth={1.7} aria-hidden />}
          size="sm"
          onClick={() => window.dispatchEvent(new CustomEvent("terminus:open-settings", { detail: { category: "appearance" } }))}
          data-tooltip="Settings  ⌘,"
          className="h-6 w-6 shrink-0 rounded-md text-tertiary hover:bg-hover hover:text-primary"
        />
        {/* Keep health textual. A dot is easy to miss and cannot communicate
            the difference between a service that is starting and one that is
            offline. */}
        <Button
          variant="bare"
          type="button"
          onClick={() => void refreshAll()}
          aria-label={healthReady
            ? "Terminus is ready. Refresh"
            : healthStatus === "offline"
              ? "Retry connection"
              : "Terminus is starting. Refresh"}
          data-tooltip={healthReady ? "Ready" : healthStatus === "offline" ? "Offline — retry" : "Starting…"}
          className="ui-meta flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-secondary hover:bg-hover hover:text-primary"
        >
          <span
            className={cn(
              "block h-1.5 w-1.5 rounded-full",
              healthReady ? "bg-success" : healthStatus === "offline" ? "bg-error" : "bg-warning",
            )}
            aria-hidden
          />
          <span>{healthReady ? "Ready" : healthStatus === "offline" ? "Offline" : "Starting"}</span>
        </Button>
      </div>
    </div>
  );
}

// ────────────────────────────── Chrome pieces ───────────────────────────────

/**
 * A destination row. 30px tall, 13px text, 14px icon.
 *
 * The icon sits at tertiary rather than secondary. Navigation should be
 * findable, not read: the rail is the dimmest region in the window on purpose,
 * so the transcript beside it is what the eye lands on.
 *
 * Styled explicitly rather than through the global `.sidebar-nav-item`: that
 * rule lives in the components layer, so `Button`'s own `h-7`/`text-sm` size
 * utilities silently won against its height and type size. Height tracks
 * `--nav-row-height` so compact density still applies.
 */
function NavRow({
  icon,
  label,
  trailing,
  active = false,
  onClick,
  tooltip,
}: {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  tooltip?: string;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="bare"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      {...(tooltip ? { "data-tooltip": tooltip } : {})}
      className={cn(
        "ui-body flex w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
        active ? "bg-selected font-medium text-primary" : "text-secondary hover:bg-hover hover:text-primary",
      )}
      style={{ height: "var(--nav-row-height)" }}
    >
      <span className={cn("flex shrink-0 items-center", active ? "text-secondary" : "text-tertiary")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
    </Button>
  );
}

/**
 * "Show more" and friends: a row that continues a list rather than starting an
 * action, so it stays at `text-tertiary` and hangs from the task text column.
 */
function QuietRow({
  children,
  label,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  /** The accessible name — the visible word is only ever "Show more". */
  label: string;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="bare"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="sidebar-show-more ui-body flex h-7 w-full items-center rounded-md pl-[26px] pr-2 text-left text-tertiary hover:bg-hover hover:text-secondary disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </Button>
  );
}

/**
 * A group heading: 12px, tertiary, sentence case, 28px tall. One class, used
 * by every group in the rail and metrically identical to the board's column
 * headers — the two surfaces list the same tasks and should not disagree about
 * what "a section starts here" looks like.
 */
function SidebarSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="group/section flex flex-col">
      <div className="flex h-7 items-center px-2">
        <span className="ui-meta min-w-0 flex-1 truncate">{label}</span>
        {action ?? null}
      </div>
      {children}
    </div>
  );
}

// ────────────────────────── Recent ──────────────────────────────────────────

/** When the task last moved. `updated_at` is authoritative; creation is the
 *  fallback for a task the list route has not stamped yet. */
function taskActivityIso(task: Task): string {
  return task.updated_at || task.created_at;
}

function startOfDayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * "Today" / "Yesterday" / "Aug 26" for one timestamp.
 *
 * Yesterday is computed as a calendar day rather than `today - 24h`: on a DST
 * boundary a day is 23 or 25 hours long, and the subtraction quietly labels
 * one day a year wrongly.
 */
export function inboxDateLabel(iso: string, now: Date): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "Earlier";
  const day = startOfDayMs(when);
  const today = startOfDayMs(now);
  if (day === today) return "Today";
  if (day === startOfDayMs(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) {
    return "Yesterday";
  }
  return when.toLocaleDateString(undefined, when.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

export interface InboxGroup {
  readonly id: string;
  readonly label: string;
  readonly tasks: readonly Task[];
}

/**
 * The settled work, by day.
 *
 * This used to hoist a "Priority" group to the top of the same list. That
 * group now lives in the queue, which is visible in both groupings — so
 * keeping a copy here would print the same row twice in one column, which
 * reads as a duplicate rather than as emphasis. What is left is what this list
 * is actually for: a record of what happened and when.
 *
 * The predicate decides what has settled. Anything still blocked, still
 * running, or still unread is the queue's, and is skipped here.
 */
export function groupSettledTasks(
  tasks: readonly Task[],
  isSettled: (task: Task) => boolean,
  now: Date,
): InboxGroup[] {
  const newestFirst = [...tasks].sort(
    (a, b) => new Date(taskActivityIso(b)).getTime() - new Date(taskActivityIso(a)).getTime(),
  );
  const byDay = new Map<number, Task[]>();
  for (const task of newestFirst) {
    if (!isSettled(task)) continue;
    const when = new Date(taskActivityIso(task));
    const key = Number.isNaN(when.getTime()) ? Number.NEGATIVE_INFINITY : startOfDayMs(when);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(task);
    else byDay.set(key, [task]);
  }

  const groups: InboxGroup[] = [];
  for (const [key, dayTasks] of [...byDay.entries()].sort((a, b) => b[0] - a[0])) {
    const first = dayTasks[0];
    if (!first) continue;
    groups.push({
      id: `day-${key}`,
      label: inboxDateLabel(taskActivityIso(first), now),
      tasks: dayTasks,
    });
  }
  return groups;
}

/**
 * One finished row: the task, the project it belongs to, and whether anyone
 * has looked at it.
 *
 * Reading a task clears its mark on its own, so the row needs a way back —
 * without one, a task glanced at by accident loses its dot with no undo. The
 * trailing control is therefore a toggle: a tick while the row is unread, a
 * dot once it is not.
 */
const RecentRow = memo(function RecentRow({
  taskId,
  title,
  projectName,
  unread,
  updatedAt,
  selected,
  stacked,
  onSelect,
  onMarkRead,
  onMarkUnread,
}: {
  taskId: string;
  title: string;
  projectName: string | null;
  unread: boolean;
  updatedAt: string;
  selected: boolean;
  stacked: boolean;
  onSelect: (taskId: string) => void;
  onMarkRead: (taskId: string, updatedAt: string) => void;
  onMarkUnread: (taskId: string) => void;
}): JSX.Element {
  const handleClick = useCallback(() => onSelect(taskId), [onSelect, taskId]);
  const handleMarkRead = useCallback(() => onMarkRead(taskId, updatedAt), [onMarkRead, taskId, updatedAt]);
  const handleMarkUnread = useCallback(() => onMarkUnread(taskId), [onMarkUnread, taskId]);
  return (
    <TaskRow
      taskId={taskId}
      title={title}
      selected={selected}
      unread={unread}
      layout={stacked ? "stacked" : "inline"}
      depth={0}
      {...(projectName ? { meta: projectName } : {})}
      onClick={handleClick}
      onMarkRead={handleMarkRead}
      onMarkUnread={handleMarkUnread}
    />
  );
});

function RecentList({
  selectedTaskId,
  onSelectTask,
  stacked = false,
}: {
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  stacked?: boolean;
}): JSX.Element {
  const sessions = useTerminusStore((s) => s.sessions);
  const tasksBySession = useTerminusStore((s) => s.tasksBySession);
  const runActivityByTask = useTerminusStore((s) => s.runActivityByTask);
  const seenAtByTask = useTaskReadStore((s) => s.seenAtByTask);
  const markRead = useTaskReadStore((s) => s.markRead);
  const markUnread = useTaskReadStore((s) => s.markUnread);

  const projectNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const session of sessions) names.set(session.id, session.title);
    return names;
  }, [sessions]);

  const groups = useMemo(() => {
    const all = Object.values(tasksBySession).flat();
    // One `new Date()` for the whole pass: grouping against a clock that ticks
    // mid-loop can put two rows a millisecond apart on different days.
    const now = new Date();
    return groupSettledTasks(
      all,
      (task) => {
        const lifecycle = displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown");
        const updatedAt = task.updated_at || task.created_at;
        return taskShelf(
          lifecycle,
          attentionReason({ lifecycle, domainTask: task }),
          taskIsUnread(updatedAt, seenAtByTask[task.id]),
        ) === "settled";
      },
      now,
    );
  }, [runActivityByTask, seenAtByTask, tasksBySession]);

  if (groups.length === 0) {
    return (
      <p className="ui-meta px-2 py-3">
        Nothing here yet. Tasks appear as they are created and worked on.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" aria-label="Recent tasks">
      {groups.map((group) => {
        // Hoisted off the row map: computing it per row is the same answer n
        // times for a list whose whole point is that it can be long.
        const showProjectMeta = stacked || spansMultipleProjects(group.tasks.map((task) => task.session_id));
        return (
          <SidebarSection key={group.id} label={group.label}>
            {group.tasks.map((task) => {
              const updatedAt = task.updated_at || task.created_at;
              return (
                <RecentRow
                  key={`${group.id}-${task.id}`}
                  taskId={task.id}
                  title={taskTitle(task)}
                  // Per day, not per list: a Tuesday spent in one repository
                  // does not need that repository's name on every one of its
                  // rows.
                  projectName={showProjectMeta ? projectNameById.get(task.session_id) ?? null : null}
                  unread={taskIsUnread(updatedAt, seenAtByTask[task.id])}
                  updatedAt={updatedAt}
                  selected={task.id === selectedTaskId}
                  stacked={stacked}
                  onSelect={onSelectTask}
                  onMarkRead={markRead}
                  onMarkUnread={markUnread}
                />
              );
            })}
          </SidebarSection>
        );
      })}
    </div>
  );
}

// ────────────────────────── Task rows ───────────────────────────────────────

const VIRTUALIZATION_THRESHOLD = 50;
const COLLAPSED_TASK_LIMIT = 3;

export function sidebarVisibleTaskCount(
  taskCount: number,
  selectedTaskIndex: number,
  expanded: boolean,
): number {
  if (expanded) return taskCount;
  return Math.min(taskCount, Math.max(COLLAPSED_TASK_LIMIT, selectedTaskIndex + 1));
}

interface SidebarTaskRowProps {
  taskId: string;
  title: string;
  selected: boolean;
  pinned?: boolean;
  /** Project name, for rows whose position does not already say. */
  meta?: string;
  depth: number;
  onSelect: (taskId: string) => void;
  onTogglePin: (taskId: string) => void;
  /** Roving-focus plumbing. All three are stable across renders by contract. */
  index?: number;
  registerButton?: (index: number, element: HTMLButtonElement | null) => void;
  onRowKeyDown?: (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  focusable?: boolean;
}

/**
 * One task in the tree, memoized on primitives.
 *
 * The row reads its own lifecycle, read-state and attention out of the store
 * instead of receiving them, which is what keeps a streaming turn from
 * re-rendering the tree: the parent's props for every other row are unchanged,
 * so `memo` bails them out, and only the subscribed row here re-runs.
 */
const SidebarTaskRow = memo(function SidebarTaskRow({
  taskId,
  title,
  selected,
  pinned = false,
  meta,
  depth,
  onSelect,
  onTogglePin,
  index,
  registerButton,
  onRowKeyDown,
  focusable,
}: SidebarTaskRowProps): JSX.Element {
  const task = useTerminusStore((s) => s.taskById[taskId]);
  const activity = useTerminusStore((s) => s.runActivityByTask[taskId] ?? "unknown");
  const seenAt = useTaskReadStore((s) => s.seenAtByTask[taskId]);
  const status = displayLifecycleWith(task, activity);
  const reason = task ? attentionReason({ lifecycle: status, domainTask: task }) : null;
  const unread = task
    ? taskIsUnread(task.updated_at || task.created_at, seenAt)
    : false;

  const handleClick = useCallback(() => onSelect(taskId), [onSelect, taskId]);
  const handleTogglePin = useCallback(() => onTogglePin(taskId), [onTogglePin, taskId]);
  const handleRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (index !== undefined) registerButton?.(index, element);
    },
    [index, registerButton],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (index !== undefined) onRowKeyDown?.(index, event);
    },
    [index, onRowKeyDown],
  );

  return (
    <TaskRow
      taskId={taskId}
      title={title}
      status={status}
      selected={selected}
      needsYou={reason !== null}
      unread={unread}
      pinned={pinned}
      {...(meta ? { meta } : {})}
      {...(reason ? { reason: reason.label } : {})}
      depth={depth}
      onClick={handleClick}
      onTogglePin={handleTogglePin}
      {...(registerButton ? { primaryButtonRef: handleRef } : {})}
      {...(focusable === undefined ? {} : { primaryTabIndex: focusable ? 0 : -1 })}
      {...(onRowKeyDown ? { onPrimaryKeyDown: handleKeyDown } : {})}
    />
  );
});

/**
 * The tasks belonging to a single project.
 *
 * Per SPEC §25.1: virtualize long lists. The virtualizer only engages past
 * {@link VIRTUALIZATION_THRESHOLD} items — short lists render in the parent's
 * natural flow and skip the absolute-positioning overhead entirely.
 */
function SessionTaskList({
  id,
  tasks,
  selectedTaskId,
  pinnedTaskIds,
  onSelectTask,
  onTogglePin,
}: {
  id: string;
  tasks: Task[];
  selectedTaskId: string | null;
  pinnedTaskIds: Set<string>;
  onSelectTask: (taskId: string) => void;
  onTogglePin: (taskId: string) => void;
}): JSX.Element {
  const density = useThemeStore((s) => s.density);
  const rowHeight = density === "compact" ? 28 : 32;
  // Long expanded sections get their own bounded scroll root. Sharing the
  // sidebar's outer root across independent virtualizers makes every list
  // interpret offsets as though it began at the top of the sidebar.
  const parentRef = useRef<HTMLDivElement | null>(null);

  const shouldVirtualize = tasks.length > VIRTUALIZATION_THRESHOLD;

  // TanStack Virtual exposes imperative functions by design; compiler
  // memoization would risk stale task rows.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? tasks.length : 0,
    getScrollElement: () => parentRef.current,
    initialRect: { width: 280, height: rowHeight * 12 },
    estimateSize: () => rowHeight,
    overscan: 8,
    enabled: shouldVirtualize,
  });
  const selectedIndex = tasks.findIndex((task) => task.id === selectedTaskId);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, selectedIndex));
  const effectiveActiveIndex = tasks.length === 0 ? 0 : Math.min(activeIndex, tasks.length - 1);
  const taskButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const taskCountRef = useRef(tasks.length);
  taskCountRef.current = tasks.length;

  const registerTaskButton = useCallback((index: number, element: HTMLButtonElement | null): void => {
    taskButtonRefs.current[index] = element;
    if (!element || pendingFocusIndexRef.current !== index) return;
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (taskButtonRefs.current[index] !== element || pendingFocusIndexRef.current !== index) return;
      pendingFocusIndexRef.current = null;
      element.focus({ preventScroll: true });
    });
  }, []);

  const focusTaskAt = useCallback((index: number): void => {
    const count = taskCountRef.current;
    if (count === 0) return;
    const nextIndex = Math.max(0, Math.min(index, count - 1));
    setActiveIndex(nextIndex);
    pendingFocusIndexRef.current = nextIndex;
    if (shouldVirtualize) virtualizer.scrollToIndex(nextIndex, { align: "auto" });
    const mounted = taskButtonRefs.current[nextIndex];
    if (mounted) {
      pendingFocusIndexRef.current = null;
      mounted.focus({ preventScroll: true });
    }
  }, [shouldVirtualize, virtualizer]);

  const onTaskKeyDown = useCallback((index: number, event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = index + 1;
    else if (event.key === "ArrowUp") nextIndex = index - 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = taskCountRef.current - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    focusTaskAt(nextIndex);
  }, [focusTaskAt]);

  useEffect(() => {
    if (shouldVirtualize) virtualizer.scrollToIndex(effectiveActiveIndex, { align: "auto" });
  }, [effectiveActiveIndex, shouldVirtualize, virtualizer]);

  useEffect(() => {
    return () => {
      if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    };
  }, []);

  const renderRow = (task: Task, index: number): JSX.Element => (
    <SidebarTaskRow
      taskId={task.id}
      title={taskTitle(task)}
      selected={task.id === selectedTaskId}
      pinned={pinnedTaskIds.has(task.id)}
      depth={1}
      index={index}
      focusable={index === effectiveActiveIndex}
      onSelect={onSelectTask}
      onTogglePin={onTogglePin}
      registerButton={registerTaskButton}
      onRowKeyDown={onTaskKeyDown}
    />
  );

  if (!shouldVirtualize) {
    return (
      <div id={id} className="flex flex-col" ref={parentRef} role="list" aria-label="Tasks">
        {tasks.map((task, index) => (
          <div key={task.id} role="listitem" aria-posinset={index + 1} aria-setsize={tasks.length}>
            {renderRow(task, index)}
          </div>
        ))}
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const renderVirtualTask = (index: number, start: number): JSX.Element | null => {
    const task = tasks[index];
    if (!task) return null;
    return (
      <div
        key={task.id}
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={tasks.length}
        data-index={index}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          transform: `translateY(${start}px)`,
        }}
      >
        {renderRow(task, index)}
      </div>
    );
  };

  // Virtualized render. The outer div sets the total height; each virtual row
  // is absolutely positioned inside it.
  return (
    <div
      id={id}
      ref={parentRef}
      role="list"
      aria-label={`Tasks (${tasks.length})`}
      className="overflow-y-auto"
      style={{ maxHeight: rowHeight * 12 }}
    >
      <div style={{ position: "relative", height: virtualizer.getTotalSize() }}>
        {virtualItems.map((item) => renderVirtualTask(item.index, item.start))}
        {virtualItems.some((item) => item.index === effectiveActiveIndex)
          ? null
          : renderVirtualTask(effectiveActiveIndex, effectiveActiveIndex * rowHeight)}
      </div>
    </div>
  );
}

export const Sidebar = memo(SidebarImpl);
