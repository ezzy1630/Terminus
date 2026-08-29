/**
 * Terminus Desktop — Sidebar.
 *
 * Per SPEC §7:
 *   New task        ← primary action
 *   Search          ← tasks and command palette
 *   Board           ← permanent task overview
 *   Needs attention ← only when actionable work exists
 *   Pinned          ← important tasks
 *     - task
 *     - task
 *   Projects        ← sessions from the control plane
 *     - Project A
 *       - Active task
 *       - Previous task
 *       - Show more
 *     - Project B
 *   Projects / Agents
 *   Settings + runtime status
 *
 * Per SPEC §7.1: "Projects contain nested tasks. Do not expose worktrees
 * or branches as another permanent hierarchy level."
 *
 * Per SPEC §7.2: selected state visible without bright saturated bg.
 *
 * The icons-only rail this file once carried was never mounted — `compact` had
 * no caller and no breakpoint — so it has been removed rather than left as a
 * second, silently diverging copy of the tree below.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BellRing,
  ChevronDown,
  ChevronRight,
  Columns3,
  FolderOpen,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/cn";
import { useRunActivityByTask, useTerminusStore, usePinnedTasks } from "../hooks/use-terminus";
import { lifecycleNeedsAttention, taskTitle, type TaskLifecycle } from "../lib/task-lifecycle";
import { displayLifecycleWith } from "../lib/turn-activity";
import type { TurnActivity } from "../lib/turn-activity";
import { useThemeStore } from "../hooks/use-theme";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Skeleton, StatusDot } from "../ui/Status";
import { SidebarItem } from "./SidebarItem";
import { ProjectMenu, projectSubtitle } from "./ProjectMenu";
import type { Session, Task } from "../types";

interface SidebarProps {
  activeDestination?: SidebarDestination;
  onNavigate?: (destination: SidebarDestination) => void;
  onOpenAttentionCenter?: () => void;
  onOpenProject?: () => void;
  taskActionsEnabled?: boolean;
}

export type SidebarDestination =
  | "new_task"
  | "chat"
  | "board"
  | "agents"
  | "task_details";

function SidebarImpl({
  activeDestination = "new_task",
  onNavigate,
  onOpenAttentionCenter,
  onOpenProject,
  taskActionsEnabled = false,
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

  const selectSession = useTerminusStore((s) => s.selectSession);
  const selectTask = useTerminusStore((s) => s.selectTask);
  const togglePin = useTerminusStore((s) => s.togglePin);
  const refreshSessions = useTerminusStore((s) => s.refreshSessions);
  const refreshAll = useTerminusStore((s) => s.refreshAll);
  const refreshTasks = useTerminusStore((s) => s.refreshTasks);
  const loadMoreSessions = useTerminusStore((s) => s.loadMoreSessions);
  const loadMoreTasks = useTerminusStore((s) => s.loadMoreTasks);
  const refreshTask = useTerminusStore((s) => s.refreshTask);

  const currentSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const pinnedTasks = usePinnedTasks();
  // Every status glyph in this tree is derived from this map, not from the
  // stored status: ACTIVE is the steady state, so reading it literally put a
  // spinner on every task in the sidebar and left it there.
  const runActivityByTask = useRunActivityByTask();
  const rowLifecycle = useCallback(
    (task: Task): TaskLifecycle => displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown"),
    [runActivityByTask],
  );

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(new Set());
  const [expandedTaskLists, setExpandedTaskLists] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const focusProjectSearch = (): void => {
      setSearchOpen(true);
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("terminus:focus-project-search", focusProjectSearch);
    return () => window.removeEventListener("terminus:focus-project-search", focusProjectSearch);
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredSessions = useMemo<Array<{ session: Session; tasks: Task[]; searchIncomplete: boolean }>>(() => sessions.flatMap((session) => {
    const tasks = tasksBySession[session.id] ?? [];
    if (!normalizedQuery || session.title.toLowerCase().includes(normalizedQuery)) {
      return [{ session, tasks, searchIncomplete: false }];
    }
    const matchingTasks = tasks.filter((task) =>
      taskTitle(task).toLowerCase().includes(normalizedQuery) || task.id.toLowerCase().includes(normalizedQuery));
    const freshness = taskListFreshnessBySession[session.id];
    const searchIncomplete = freshness?.status !== "ready"
      || Boolean(taskPagesBySession[session.id]?.nextCursor);
    if (matchingTasks.length === 0 && !searchIncomplete) return [];
    const selectedTask = tasks.find((task) => task.id === selectedTaskId);
    return [{
      session,
      tasks: selectedTask && !matchingTasks.some((task) => task.id === selectedTask.id)
        ? [...matchingTasks, selectedTask]
        : matchingTasks,
      searchIncomplete,
    }];
  }), [normalizedQuery, selectedTaskId, sessions, taskListFreshnessBySession, taskPagesBySession, tasksBySession]);
  const visiblePinnedTasks = useMemo(() => !normalizedQuery
    ? pinnedTasks
    : pinnedTasks.filter((task) =>
        taskTitle(task).toLowerCase().includes(normalizedQuery) || task.id.toLowerCase().includes(normalizedQuery)),
  [normalizedQuery, pinnedTasks]);
  const unresolvedPinnedTaskIds = useMemo(() => [...pinnedTaskIds].filter((taskId) => {
    if (taskById[taskId]) return false;
    return !normalizedQuery || taskId.toLowerCase().includes(normalizedQuery);
  }), [normalizedQuery, pinnedTaskIds, taskById]);
  const attentionCount = useMemo(() => Object.values(tasksBySession)
    .flat()
    .filter((task) => lifecycleNeedsAttention(displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown")))
    .length, [runActivityByTask, tasksBySession]);

  const toggleCollapsed = (sessionId: string): void => {
    setCollapsedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const onNewTask = (): void => {
    // New Task screen is shown when selectedTaskId === null. Clearing the
    // selection routes the main surface to <NewTaskScreen />.
    onNavigate?.("new_task");
    selectTask(null);
  };

  const onSelectTask = (taskId: string): void => {
    onNavigate?.("chat");
    selectTask(taskId);
  };

  const onDestination = (destination: SidebarDestination): void => {
    onNavigate?.(destination);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col px-3 pb-2 pt-3">
        <Button
          type="button"
          onClick={onNewTask}
          aria-current={activeDestination === "new_task" ? "page" : undefined}
          className={cn(
            "sidebar-primary-action flex h-8 w-full items-center justify-start gap-2 rounded-md border border-default bg-elevated px-2.5 text-left text-sm font-medium text-primary hover:bg-hover",
            activeDestination === "new_task" && "bg-selected shadow-sm",
          )}
        >
          <Plus size={15} strokeWidth={2} />
          <span>New session</span>
          <span className="ml-auto text-xs text-tertiary" aria-hidden>⌘N</span>
        </Button>

        <nav className="mt-2 flex flex-col gap-0.5" aria-label="Workspace navigation">
          <Button
            type="button"
            onClick={() => onDestination("board")}
            aria-current={activeDestination === "board" ? "page" : undefined}
            className={cn("sidebar-nav-item w-full justify-start text-left", activeDestination === "board" && "is-active font-medium bg-selected text-primary")}
          >
            <Columns3 size={15} strokeWidth={1.7} aria-hidden className="shrink-0" />
            <span className="truncate text-left">Kanban</span>
          </Button>
          <Button
            type="button"
            onClick={() => window.dispatchEvent(new Event("terminus:open-command-palette"))}
            aria-label="Search tasks and commands"
            className="sidebar-nav-item w-full justify-start text-left"
          >
            <Search size={15} strokeWidth={1.7} className="shrink-0" />
            <span className="truncate text-left">Search</span>
            <span className="ml-auto text-xs text-tertiary">⌘K</span>
          </Button>
          {/* The count is the signal; a fully amber row read as a permanent
              alarm in an otherwise quiet source list. */}
          {attentionCount > 0 ? (
            <Button type="button" onClick={onOpenAttentionCenter} className="sidebar-nav-item w-full justify-start text-left">
              <BellRing size={15} strokeWidth={1.7} className="shrink-0 text-warning" />
              <span className="truncate text-left">Needs attention</span>
              <span className="ml-auto min-w-4 rounded-full bg-warning/12 px-1.5 text-right text-xs tabular-nums text-warning">{attentionCount}</span>
            </Button>
          ) : null}
        </nav>

      </div>

      {/* Scrollable spaces/sessions list. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
        {/* Pinned section. */}
        {visiblePinnedTasks.length > 0 || unresolvedPinnedTaskIds.length > 0 || pinPersistenceError ? (
          <SidebarSection title="Pinned">
            {visiblePinnedTasks.map((t) => (
              <SidebarItem
                key={`pin-${t.id}`}
                title={taskTitle(t)}
                status={rowLifecycle(t)}
                updatedAt={t.updated_at}
                selected={t.id === selectedTaskId}
                pinned
                depth={0}
                onClick={() => onSelectTask(t.id)}
                onTogglePin={() => togglePin(t.id)}
              />
            ))}
            {unresolvedPinnedTaskIds.map((taskId) => {
              const freshness = taskFreshnessById[taskId];
              const loading = freshness?.status === "loading";
              const title = loading
                ? `Loading pinned task ${taskId}`
                : `Pinned task ${taskId} — unavailable`;
              return (
                <div key={`unresolved-pin-${taskId}`} className="flex flex-col">
                  <SidebarItem
                    title={title}
                    selected={false}
                    pinned
                    depth={0}
                    onClick={() => void refreshTask(taskId)}
                    onTogglePin={() => togglePin(taskId)}
                  />
                  {freshness?.error ? (
                    <span role="status" className="ml-8 break-words px-2 pb-1 text-warning text-xs" >
                      This task is unavailable. Select the pinned row to retry.
                    </span>
                  ) : null}
                </div>
              );
            })}
            {pinPersistenceError ? (
              <span role="alert" className="px-2 py-1 text-warning text-xs" >
                {pinPersistenceError}
              </span>
            ) : null}
          </SidebarSection>
        ) : null}

        {/* Projects section. The header is the switcher: the current project is
            named, and every other one is one click away. */}
        <SidebarSection
          title={(
            <ProjectMenu
              onProjectSelected={() => {
                onNavigate?.("new_task");
                selectTask(null);
              }}
              {...(onOpenProject ? { onOpenProject } : {})}
              trigger={(
                <Button
                  type="button"
                  aria-label="Switch project"
                  className="-ml-1 flex min-w-0 max-w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {currentSession?.title ?? "Projects"}
                  </span>
                  <ChevronDown size={11} strokeWidth={2} className="shrink-0 text-tertiary" aria-hidden />
                </Button>
              )}
            />
          )}
          action={(
            <div className="flex items-center gap-0.5 text-tertiary">
              <IconButton
                label={searchOpen ? "Close task filter" : "Filter recent tasks"}
                icon={<Search size={12} strokeWidth={1.7} aria-hidden />}
                size="sm"
                onClick={() => {
                  if (searchOpen) {
                    setSearchOpen(false);
                    setQuery("");
                    return;
                  }
                  setSearchOpen(true);
                  window.requestAnimationFrame(() => searchInputRef.current?.focus());
                }}
                aria-pressed={searchOpen}
                className={cn("h-5 w-5 rounded text-tertiary hover:bg-hover hover:text-primary", searchOpen && "bg-selected text-primary")}
              />
              {/* Always present. Hiding "add a project" until a project exists
                  is exactly backwards. */}
              <ProjectMenu
                align="end"
                label="Add or switch project"
                onProjectSelected={() => {
                  onNavigate?.("new_task");
                  selectTask(null);
                }}
                {...(onOpenProject ? { onOpenProject } : {})}
                trigger={(
                  <IconButton
                    label="Add or switch project"
                    icon={<Plus size={12} strokeWidth={1.7} aria-hidden />}
                    size="sm"
                    className="h-5 w-5 rounded text-tertiary hover:bg-hover hover:text-primary"
                  />
                )}
              />
            </div>
          )}
        >
          {searchOpen ? <div className="relative px-1 pb-1">
            <Search
              size={12}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-[calc(50%+2px)] text-tertiary"
              aria-hidden
            />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter tasks"
              className="ui-input h-8 w-full rounded-md border border-subtle bg-card pl-7 pr-2 text-xs text-primary placeholder:text-tertiary"
              aria-label="Search tasks"
              autoFocus
            />
          </div> : null}
          {(loadingSessions || sessionsFreshness.status === "loading") && sessions.length === 0 ? (
            <div className="grid gap-2 px-2 py-2" role="status" aria-label="Loading projects">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-4/5" />
            </div>
          ) : null}
          {sessions.length === 0 && sessionsFreshness.status === "error" && healthStatus !== "offline" ? (
            <div className="flex flex-col items-start gap-2 px-2 py-3 text-error text-xs" role="alert" >
              <span>Projects could not be loaded.</span>
              <Button size="sm" onClick={() => void refreshSessions()}>
                Retry projects
              </Button>
            </div>
          ) : null}
          {filteredSessions.length === 0 && !loadingSessions && sessionsFreshness.status !== "error" ? (
            <div className="flex flex-col items-start gap-2 px-2 py-3 text-tertiary text-xs" >
              <span>{query
                ? sessionsPage.nextCursor
                  ? "No matches in loaded projects. More projects are available."
                  : "No matches in loaded projects."
                : sessionsFreshness.status === "ready"
                  ? "No projects yet."
                  : "Projects have not loaded yet."}</span>
              {!query && onOpenProject ? (
                <Button
                  size="sm"
                  onClick={() => onOpenProject()}
                >
                  <FolderOpen size={12} />
                  Open project
                </Button>
              ) : null}
            </div>
          ) : null}
          {filteredSessions.map(({ session, tasks, searchIncomplete }) => {
            const collapsed = collapsedSessions.has(session.id);
            const containsSelectedTask = tasks.some((task) => task.id === selectedTaskId);
            const taskPage = taskPagesBySession[session.id];
            const taskListFreshness = taskListFreshnessBySession[session.id];
            const taskListExpanded = expandedTaskLists.has(session.id) || query.trim().length > 0;
            const selectedTaskIndex = tasks.findIndex((task) => task.id === selectedTaskId);
            const visibleCount = sidebarVisibleTaskCount(
              tasks.length,
              selectedTaskIndex,
              taskListExpanded,
            );
            const visibleTasks = collapsed ? [] : tasks.slice(0, visibleCount);
            const hiddenTaskCount = Math.max(0, tasks.length - visibleTasks.length);
            return (
              <div
                key={session.id}
                className="flex flex-col mb-1"
              >
                {/* Space row. */}
                <div
                  className={cn(
                    "group flex items-center gap-1.5 rounded-lg text-left transition-colors",
                    session.id === selectedSessionId && activeDestination !== "new_task" && !containsSelectedTask
                      ? "bg-selected text-primary font-medium shadow-xs"
                      : "text-secondary hover:bg-hover hover:text-primary",
                  )}
                  style={{ height: "var(--row-height)", paddingLeft: 8, paddingRight: 6 }}
                >
                  {tasks.length > 0 ? (
                    <IconButton
                      onClick={() => toggleCollapsed(session.id)}
                      className="h-5 w-5 flex-shrink-0 rounded-sm text-tertiary hover:bg-hover hover:text-primary"
                      label={`${collapsed ? "Expand" : "Collapse"} ${session.title}`}
                      icon={collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      size="sm"
                      aria-expanded={!collapsed}
                      aria-controls={`session-tasks-${session.id}`}
                    />
                  ) : (
                    <span className="w-5 flex-shrink-0" />
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
                    className="flex min-w-0 flex-1 items-center justify-start gap-1.5 text-xs"
                    // Two projects can share a name; only the root tells them
                    // apart, so it is on the row rather than three clicks away.
                    data-tooltip={projectSubtitle(session) ?? session.title}
                    title={projectSubtitle(session) ?? undefined}
                    aria-current={session.id === selectedSessionId ? "page" : undefined}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-left">
                      {session.title}
                    </span>
                    {tasks.length > 0 ? (
                      <span
                        className="flex-shrink-0 rounded bg-subtle px-1.5 py-0.5 font-mono text-tertiary text-xs tabular-nums"
                        aria-label={taskPage?.total === null || taskPage?.total === undefined
                          ? `${tasks.length} loaded tasks`
                          : `${tasks.length} loaded of ${taskPage.total} tasks`}
                      >
                        {taskPage?.total !== null && taskPage?.total !== undefined && taskPage.total !== tasks.length
                          ? `${tasks.length}/${taskPage.total}`
                          : tasks.length}
                      </span>
                    ) : null}
                  </Button>
                </div>
                {searchIncomplete && tasks.length === 0 ? (
                  <p className="ml-[34px] px-2 py-1 text-tertiary text-xs" >
                    {taskPage?.nextCursor
                      ? "No match in loaded tasks. Search the next page below."
                      : taskListFreshness?.status === "loading"
                        ? "Loading this project's tasks before completing the search."
                        : taskListFreshness?.status === "error" || taskListFreshness?.status === "stale"
                          ? "This project's task search is incomplete. Retry below."
                          : "Load this project's tasks to complete the search."}
                  </p>
                ) : null}
                {/* Tasks under this session. */}
                {!collapsed && visibleTasks.length > 0 ? (
                  <>
                    <SessionTaskList
                      id={`session-tasks-${session.id}`}
                      tasks={visibleTasks}
                      selectedTaskId={selectedTaskId}
                      pinnedTaskIds={pinnedTaskIds}
                      runActivityByTask={runActivityByTask}
                      onSelectTask={onSelectTask}
                      onTogglePin={togglePin}
                    />
                    {hiddenTaskCount > 0 ? (
                      <Button
                        type="button"
                        onClick={() => setExpandedTaskLists((previous) => {
                          const next = new Set(previous);
                          next.add(session.id);
                          return next;
                        })}
                        className="sidebar-show-more ml-[34px] flex h-7 items-center rounded-md px-2 text-left text-tertiary hover:bg-hover hover:text-secondary text-sm"

                        aria-label={`Show ${hiddenTaskCount} more tasks in ${session.title}`}
                      >
                        Show more
                        <span className="ml-1.5 font-mono opacity-70">{hiddenTaskCount}</span>
                      </Button>
                    ) : taskListExpanded && tasks.length > COLLAPSED_TASK_LIMIT && !query.trim() ? (
                      <Button
                        type="button"
                        onClick={() => setExpandedTaskLists((previous) => {
                          const next = new Set(previous);
                          next.delete(session.id);
                          return next;
                        })}
                        className="sidebar-show-more ml-[34px] flex h-7 items-center rounded-md px-2 text-left text-tertiary hover:bg-hover hover:text-secondary text-sm"

                        aria-label={`Show fewer tasks in ${session.title}`}
                      >
                        Show less
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {!collapsed && taskPage?.nextCursor ? (
                  <div className="ml-[34px] flex flex-col items-start">
                    <Button
                      type="button"
                      onClick={() => void loadMoreTasks(session.id)}
                      disabled={taskPage.loadingMore}
                      className="sidebar-show-more flex h-7 items-center rounded-md px-2 text-left text-tertiary hover:bg-hover hover:text-secondary disabled:cursor-not-allowed disabled:opacity-45 text-sm"

                      aria-label={`Load more tasks in ${session.title}`}
                    >
                      {taskPage.loadingMore ? "Loading more…" : taskPage.error ? "Retry loading tasks" : "Load more tasks"}
                    </Button>
                    {taskPage.error ? <span role="alert" className="px-2 text-error text-xs" >More tasks could not be loaded.</span> : null}
                  </div>
                ) : null}
                {!collapsed
                && normalizedQuery
                && searchIncomplete
                && !taskPage?.nextCursor
                && taskListFreshness?.status !== "ready" ? (
                  <div className="ml-[34px] flex flex-col items-start">
                    <Button
                      type="button"
                      onClick={() => void refreshTasks(session.id)}
                      disabled={taskListFreshness?.status === "loading"}
                      className="sidebar-show-more flex h-7 items-center rounded-md px-2 text-left text-tertiary hover:bg-hover hover:text-secondary disabled:cursor-not-allowed disabled:opacity-45 text-sm"

                      aria-label={`${taskListFreshness?.status === "error" || taskListFreshness?.status === "stale" ? "Retry" : "Load"} tasks in ${session.title} to complete search`}
                    >
                      {taskListFreshness?.status === "loading"
                        ? "Loading tasks…"
                        : taskListFreshness?.status === "error" || taskListFreshness?.status === "stale"
                          ? "Retry task search"
                          : "Load tasks to search"}
                    </Button>
                    {taskListFreshness?.error ? (
                      <span role="alert" className="px-2 text-error text-xs" >
                        This project's tasks could not be loaded.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {sessionsPage.nextCursor ? (
            <div className="flex flex-col items-start px-2 pt-1">
              <Button
                type="button"
                onClick={() => void loadMoreSessions()}
                disabled={sessionsPage.loadingMore}
                className="flex h-7 items-center rounded-md px-2 text-secondary hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-45 text-sm"

              >
                {sessionsPage.loadingMore ? "Loading more…" : sessionsPage.error ? "Retry loading projects" : "Load more projects"}
              </Button>
              {sessionsPage.error ? <span role="alert" className="px-2 text-error text-xs" >More projects could not be loaded.</span> : null}
            </div>
          ) : null}
        </SidebarSection>

      </div>

      {/* Destinations and status are chrome, not list content, so they stay
          docked. Runtime status shares the Settings row: as its own line it
          was a second 28px row carrying one word, and its dot sat 2px off the
          nav icon column. */}
      <div className="sidebar-dock flex flex-col gap-0.5 px-3 pb-2 pt-2">
        {/* "Agents" is not shipped. It routed to a view built from a directory
            of departments and operators that no control-plane route serves, so
            the destination advertised a feature the app does not have. The
            surface stays in the tree behind `activeDestination === "agents"`
            until it has real data; nothing navigates to it. */}
        <Button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("terminus:open-settings", { detail: { category: "appearance" } }))}
          aria-label="Settings"
          className="sidebar-nav-item w-full justify-start text-left"
        >
          <Settings size={15} strokeWidth={1.7} className="shrink-0" />
          <span className="truncate text-left">Settings</span>
          {healthReady ? (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-tertiary">
              <StatusDot tone="success" label="Ready" />
              <span>Ready</span>
            </span>
          ) : (
            <span
              className={cn("ml-auto flex items-center gap-1.5 text-xs", healthStatus === "offline" ? "text-error" : "text-warning")}
              role="status"
              aria-label={healthStatus === "offline" ? "Terminus is offline" : "Terminus is starting"}
            >
              <StatusDot tone={healthStatus === "offline" ? "danger" : "warning"} label={healthStatus === "offline" ? "Offline" : "Starting"} />
              <span>{healthStatus === "offline" ? "Offline" : "Starting"}</span>
            </span>
          )}
        </Button>
        {!healthReady && healthStatus === "offline" ? (
          <Button size="sm" onClick={() => void refreshAll()} className="ml-1 self-start text-xs">
            Retry connection
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SidebarSection({
  title,
  action,
  children,
}: {
  /** A node, not just a string: the projects header is itself a control. */
  title: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="ui-section-label flex min-h-6 items-center px-2"
      >
        {typeof title === "string" ? <span>{title}</span> : title}
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {children}
    </div>
  );
}

// ────────────────────────── Virtualized task list ───────────────────────────

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

/**
 * Renders the tasks belonging to a single session.
 *
 * Per SPEC §25.1: virtualize long lists. We only switch on the
 * virtualizer when a section has more than {@link VIRTUALIZATION_THRESHOLD}
 * items — small lists render inline so they can use the parent's
 * natural flow (and we avoid the absolute-positioning overhead).
 *
 * Row heights: 36px spacious / 28px compact (per design spec).
 */
function SessionTaskList({
  id,
  tasks,
  selectedTaskId,
  pinnedTaskIds,
  runActivityByTask,
  onSelectTask,
  onTogglePin,
}: {
  id: string;
  tasks: Task[];
  selectedTaskId: string | null;
  pinnedTaskIds: Set<string>;
  runActivityByTask: Record<string, TurnActivity>;
  onSelectTask: (taskId: string) => void;
  onTogglePin: (taskId: string) => void;
}): JSX.Element {
  const density = useThemeStore((s) => s.density);
  const rowHeight = density === "compact" ? 28 : 36;
  // Long expanded sections get their own bounded scroll root. Sharing the
  // sidebar's outer root across independent virtualizers makes every list
  // interpret offsets as though it began at the top of the sidebar.
  const parentRef = useRef<HTMLDivElement | null>(null);

  // Virtualize when >threshold items; otherwise render inline.
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
    if (tasks.length === 0) return;
    const nextIndex = Math.max(0, Math.min(index, tasks.length - 1));
    setActiveIndex(nextIndex);
    pendingFocusIndexRef.current = nextIndex;
    if (shouldVirtualize) virtualizer.scrollToIndex(nextIndex, { align: "auto" });
    const mounted = taskButtonRefs.current[nextIndex];
    if (mounted) {
      pendingFocusIndexRef.current = null;
      mounted.focus({ preventScroll: true });
    }
  }, [shouldVirtualize, tasks.length, virtualizer]);

  const onTaskKeyDown = useCallback((index: number, event: React.KeyboardEvent<HTMLButtonElement>): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = index + 1;
    else if (event.key === "ArrowUp") nextIndex = index - 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tasks.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    focusTaskAt(nextIndex);
  }, [focusTaskAt, tasks.length]);

  useEffect(() => {
    if (shouldVirtualize) virtualizer.scrollToIndex(effectiveActiveIndex, { align: "auto" });
  }, [effectiveActiveIndex, shouldVirtualize, virtualizer]);

  useEffect(() => {
    return () => {
      if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    };
  }, []);

  if (!shouldVirtualize) {
    return (
      <div id={id} className="flex flex-col" ref={parentRef} role="list" aria-label="Tasks">
        {tasks.map((task, index) => (
          <div
            key={task.id}
            role="listitem"
            aria-posinset={index + 1}
            aria-setsize={tasks.length}
          >
            <SidebarItem
              title={taskTitle(task)}
              status={displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown")}
              updatedAt={task.updated_at}
              selected={task.id === selectedTaskId}
              pinned={pinnedTaskIds.has(task.id)}
              depth={1}
              onClick={() => {
                setActiveIndex(index);
                onSelectTask(task.id);
              }}
              onTogglePin={() => onTogglePin(task.id)}
              primaryButtonRef={(element) => registerTaskButton(index, element)}
              primaryTabIndex={index === effectiveActiveIndex ? 0 : -1}
              onPrimaryKeyDown={(event) => onTaskKeyDown(index, event)}
            />
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
        <SidebarItem
          title={taskTitle(task)}
          status={displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown")}
          updatedAt={task.updated_at}
          selected={task.id === selectedTaskId}
          pinned={pinnedTaskIds.has(task.id)}
          depth={1}
          onClick={() => {
            setActiveIndex(index);
            onSelectTask(task.id);
          }}
          onTogglePin={() => onTogglePin(task.id)}
          primaryButtonRef={(element) => registerTaskButton(index, element)}
          primaryTabIndex={index === effectiveActiveIndex ? 0 : -1}
          onPrimaryKeyDown={(event) => onTaskKeyDown(index, event)}
        />
      </div>
    );
  };

  // Virtualized render. The outer div sets the total height; each
  // virtual row is absolutely positioned inside it.
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
