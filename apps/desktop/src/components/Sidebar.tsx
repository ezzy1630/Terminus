/**
 * Terminus Desktop — Sidebar.
 *
 * The rail, top to bottom, is Codex's:
 *
 *   Terminus ⌄                      🔍  🔔   ← project switcher + global search
 *   ✎ New task                          ⊕
 *   ▤ Kanban
 *   ◉ Needs attention                    2
 *   Pinned
 *     Complete release readiness
 *   Projects                            + 🔍
 *     ▸ CoOps
 *     ▾ Terminus
 *         Clean git and rebuild app
 *         Show more
 *   ─────────────────────────────────────
 *   ◍ Terminus                        ⚙ ·
 *
 * Two things changed the character of this column. The first is that a task
 * row is now a title and nothing else (see SidebarItem) — the "Failed · 2h ago"
 * meta line and the leading status dot are gone, so the eye scans titles
 * instead of parsing three columns of chrome thirty times. The second is that
 * the destinations moved out of a bordered "primary action" card and into
 * plain 30px rows, which is why the rail no longer reads like a web dashboard
 * nav.
 *
 * Per SPEC §7.1: "Projects contain nested tasks. Do not expose worktrees or
 * branches as another permanent hierarchy level."
 * Per SPEC §7.2: selected state is visible without a bright saturated bg.
 *
 * On re-render cost: task rows are memoized on primitive props and read their
 * own lifecycle out of the store by id. A streaming turn therefore re-renders
 * the one row it concerns, not the whole tree — which is the entire reason
 * `runActivityByTask` is not subscribed to at this level.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CirclePlus,
  Columns3,
  Ellipsis,
  Folder,
  FolderOpen,
  Plus,
  Search,
  Settings,
  SquarePen,
  Terminal,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/cn";
import { useTerminusStore, usePinnedTasks } from "../hooks/use-terminus";
import { lifecycleNeedsAttention, taskTitle } from "../lib/task-lifecycle";
import { displayLifecycleWith } from "../lib/turn-activity";
import type { TurnActivity } from "../lib/turn-activity";
import { useThemeStore } from "../hooks/use-theme";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Menu, type MenuItem } from "../ui/Menu";
import { Skeleton } from "../ui/Status";
import { SidebarItem } from "./SidebarItem";
import { ProjectMenu, projectSubtitle } from "./ProjectMenu";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { Session, Task } from "../types";

interface SidebarProps {
  activeDestination?: SidebarDestination;
  onNavigate?: (destination: SidebarDestination) => void;
  onOpenAttentionCenter?: () => void;
  onOpenProject?: () => void;
}

export type SidebarDestination =
  | "new_task"
  | "chat"
  | "board"
  | "agents"
  | "task_details";

/**
 * How many loaded tasks are asking for a human.
 *
 * Deliberately a selector returning a number rather than a `useMemo` over two
 * subscribed maps: the count is what the row renders, so the sidebar should
 * re-render when the *count* changes, not every time any task's activity does.
 */
function selectAttentionCount(state: {
  tasksBySession: Record<string, Task[]>;
  runActivityByTask: Record<string, TurnActivity>;
}): number {
  let count = 0;
  for (const tasks of Object.values(state.tasksBySession)) {
    for (const task of tasks) {
      const activity = state.runActivityByTask[task.id] ?? "unknown";
      if (lifecycleNeedsAttention(displayLifecycleWith(task, activity))) count += 1;
    }
  }
  return count;
}

function SidebarImpl({
  activeDestination = "new_task",
  onNavigate,
  onOpenAttentionCenter,
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
  const attentionCount = useTerminusStore(selectAttentionCount);

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

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // The rail has two bodies. The tree answers "what is in this project"; the
  // inbox answers "what happened, and what wants me" across all of them. The
  // destinations above stay put in both, so the bell is a lens on the same
  // column rather than a different screen.
  const [inboxOpen, setInboxOpen] = useState(false);
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(new Set());
  const [expandedTaskLists, setExpandedTaskLists] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // The navigation callbacks below are handed to memoized rows, so they have to
  // keep a stable identity across the sidebar's own re-renders. `onNavigate` is
  // an inline arrow at the call site and changes on every parent render, so it
  // is read through a ref rather than closed over.
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

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

  const openCommandPalette = useCallback((): void => {
    window.dispatchEvent(new Event("terminus:open-command-palette"));
  }, []);

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
              className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left hover:bg-hover"
            >
              {/* The size is an inline style, not `text-title`: tailwind-merge
                  reads any `text-*` whose suffix is not a known size as a
                  colour, so `text-title` and `text-primary` looked like two
                  colours and the size was silently dropped from the class. */}
              <span
                className="min-w-0 truncate font-semibold text-primary"
                style={{ fontSize: "var(--font-size-title)" }}
              >
                {currentSession?.title ?? "Terminus"}
              </span>
              <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-tertiary" aria-hidden />
            </Button>
          )}
        />
        <IconButton
          label="Search tasks and commands"
          icon={<Search size={16} strokeWidth={1.7} aria-hidden />}
          size="sm"
          onClick={openCommandPalette}
          data-tooltip="Search  ⌘K"
          className="h-7 w-7 shrink-0 rounded-md text-secondary hover:bg-hover hover:text-primary"
        />
        <span className="relative shrink-0">
          <IconButton
            label="Notifications"
            icon={<Bell size={16} strokeWidth={1.7} aria-hidden />}
            size="sm"
            onClick={() => setInboxOpen((open) => !open)}
            aria-pressed={inboxOpen}
            data-tooltip={inboxOpen
              ? "Back to projects"
              : attentionCount > 0 ? `Inbox — ${attentionCount} needing attention` : "Inbox"}
            // The one place the accent earns its keep in this column: a tinted
            // pill says the rail is showing something other than the tree.
            className={cn(
              "h-7 w-7 rounded-full",
              inboxOpen
                ? "bg-accent/15 text-accent hover:bg-accent/20"
                : "text-secondary hover:bg-hover hover:text-primary",
            )}
          />
          {/* A dot, not a number. The exact count already has a home on the
              "Needs attention" row; up here the only question is whether to
              look at all. It goes away once you are looking. */}
          {attentionCount > 0 && !inboxOpen ? (
            <span
              className="pointer-events-none absolute right-1 top-1 block h-1.5 w-1.5 rounded-full bg-warning ring-2 ring-[var(--bg-sidebar)]"
              aria-hidden
            />
          ) : null}
        </span>
      </div>

      {/* ── Destinations ──────────────────────────────────────────────────── */}
      <nav className="flex flex-col px-2 pb-1" aria-label="Workspace navigation">
        <NavRow
          icon={<SquarePen size={16} strokeWidth={1.6} aria-hidden />}
          label="New task"
          active={activeDestination === "new_task"}
          onClick={onNewTask}
          tooltip="New task  ⌘N"
          trailing={<CirclePlus size={15} strokeWidth={1.5} className="text-tertiary" aria-hidden />}
        />
        <NavRow
          icon={<Columns3 size={16} strokeWidth={1.6} aria-hidden />}
          label="Kanban"
          active={activeDestination === "board"}
          onClick={() => onNavigateRef.current?.("board")}
        />
        {/* Rendered only when there is something to attend to. A permanent row
            reading "Needs attention 0" is an alarm that is always on.
            It opens the inbox rather than a modal: the work is a list, and a
            list belongs in the column that already shows lists. The modal is
            still reachable from the Priority overflow and the palette. */}
        {attentionCount > 0 ? (
          <NavRow
            icon={<CircleAlert size={16} strokeWidth={1.6} aria-hidden />}
            label="Needs attention"
            active={inboxOpen}
            onClick={() => setInboxOpen(true)}
            trailing={<span className="text-sm tabular-nums text-tertiary">{attentionCount}</span>}
          />
        ) : null}
      </nav>

      {/* ── The tree ──────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 pt-1">
        {inboxOpen ? (
          <InboxList
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
            {...(onOpenAttentionCenter ? { onOpenAttentionCenter } : {})}
          />
        ) : (
        <>
        {visiblePinnedTasks.length > 0 || unresolvedPinnedTaskIds.length > 0 || pinPersistenceError ? (
          <SidebarSection label="Pinned">
            {visiblePinnedTasks.map((task) => (
              <TaskRow
                key={`pin-${task.id}`}
                taskId={task.id}
                title={taskTitle(task)}
                selected={task.id === selectedTaskId}
                pinned
                depth={0}
                onSelect={onSelectTask}
                onTogglePin={togglePin}
              />
            ))}
            {unresolvedPinnedTaskIds.map((taskId) => {
              const freshness = taskFreshnessById[taskId];
              const loading = freshness?.status === "loading";
              return (
                <div key={`unresolved-pin-${taskId}`} className="flex flex-col">
                  <SidebarItem
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
                    <span role="status" className="break-words px-2 pb-1 pl-8 text-sm text-warning">
                      This task is unavailable. Select the pinned row to retry.
                    </span>
                  ) : null}
                </div>
              );
            })}
            {pinPersistenceError ? (
              <span role="alert" className="px-2 py-1 text-sm text-warning">
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
              <IconButton
                label={searchOpen ? "Close task filter" : "Filter recent tasks"}
                icon={<Search size={13} strokeWidth={1.7} aria-hidden />}
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
                className={cn(
                  "h-5 w-5 rounded-sm text-tertiary hover:bg-hover hover:text-primary",
                  searchOpen && "bg-selected text-primary",
                )}
              />
              <ProjectMenu
                align="end"
                label="Add or switch project"
                onProjectSelected={onNewTask}
                {...(onOpenProject ? { onOpenProject } : {})}
                trigger={(
                  <IconButton
                    label="Add or switch project"
                    icon={<Plus size={13} strokeWidth={1.7} aria-hidden />}
                    size="sm"
                    className="h-5 w-5 rounded-sm text-tertiary hover:bg-hover hover:text-primary"
                  />
                )}
              />
            </span>
          )}
        >
          {searchOpen ? (
            <div className="relative px-1 pb-1">
              <Search
                size={12}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary"
                aria-hidden
              />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter tasks"
                className="ui-input h-7 w-full rounded-md border border-subtle bg-card pl-7 pr-2 text-base text-primary placeholder:text-tertiary"
                aria-label="Search tasks"
                autoFocus
              />
            </div>
          ) : null}

          {(loadingSessions || sessionsFreshness.status === "loading") && sessions.length === 0 ? (
            <div className="grid gap-2 px-2 py-2" role="status" aria-label="Loading projects">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-4/5" />
            </div>
          ) : null}

          {sessions.length === 0 && sessionsFreshness.status === "error" && healthStatus !== "offline" ? (
            <div className="flex flex-col items-start gap-2 px-2 py-3 text-sm text-error" role="alert">
              <span>Projects could not be loaded.</span>
              <Button size="sm" onClick={() => void refreshSessions()}>
                Retry projects
              </Button>
            </div>
          ) : null}

          {filteredSessions.length === 0 && !loadingSessions && sessionsFreshness.status !== "error" ? (
            <div className="flex flex-col items-start gap-2 px-2 py-3 text-sm text-tertiary">
              <span>{query
                ? sessionsPage.nextCursor
                  ? "No matches in loaded projects. More projects are available."
                  : "No matches in loaded projects."
                : sessionsFreshness.status === "ready"
                  ? "No projects yet."
                  : "Projects have not loaded yet."}</span>
              {!query && onOpenProject ? (
                <Button size="sm" onClick={() => onOpenProject()}>
                  <FolderOpen size={12} />
                  Open project
                </Button>
              ) : null}
            </div>
          ) : null}

          {filteredSessions.map(({ session, tasks, searchIncomplete }) => {
            const collapsed = collapsedSessions.has(session.id);
            const taskPage = taskPagesBySession[session.id];
            const taskListFreshness = taskListFreshnessBySession[session.id];
            const taskListExpanded = expandedTaskLists.has(session.id) || query.trim().length > 0;
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
                            {collapsed ? <Folder size={14} strokeWidth={1.6} /> : <FolderOpen size={14} strokeWidth={1.6} />}
                          </span>
                          <span className="absolute flex opacity-0 group-hover/project:opacity-100">
                            {collapsed ? <ChevronRight size={13} strokeWidth={2} /> : <ChevronDown size={13} strokeWidth={2} />}
                          </span>
                        </span>
                      )}
                    />
                  ) : (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-tertiary" aria-hidden>
                      <Folder size={14} strokeWidth={1.6} />
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
                    className="min-w-0 flex-1 truncate text-left text-base leading-none"
                    // Two projects can share a name; only the root tells them
                    // apart, so it is on the row rather than three clicks away.
                    data-tooltip={projectSubtitle(session) ?? session.title}
                    aria-current={session.id === selectedSessionId ? "page" : undefined}
                  >
                    {session.title}
                  </Button>
                </div>

                {searchIncomplete && tasks.length === 0 ? (
                  <p className="px-2 py-1 pl-[26px] text-sm text-tertiary">
                    {taskPage?.nextCursor
                      ? "No match in loaded tasks. Search the next page below."
                      : taskListFreshness?.status === "loading"
                        ? "Loading this project's tasks before completing the search."
                        : taskListFreshness?.status === "error" || taskListFreshness?.status === "stale"
                          ? "This project's task search is incomplete. Retry below."
                          : "Load this project's tasks to complete the search."}
                  </p>
                ) : null}

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
                    ) : taskListExpanded && tasks.length > COLLAPSED_TASK_LIMIT && !query.trim() ? (
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
                      <span role="alert" className="px-2 pl-[26px] text-sm text-error">More tasks could not be loaded.</span>
                    ) : null}
                  </div>
                ) : null}

                {!collapsed
                && normalizedQuery
                && searchIncomplete
                && !taskPage?.nextCursor
                && taskListFreshness?.status !== "ready" ? (
                  <div className="flex flex-col items-start">
                    <QuietRow
                      onClick={() => void refreshTasks(session.id)}
                      disabled={taskListFreshness?.status === "loading"}
                      label={`${taskListFreshness?.status === "error" || taskListFreshness?.status === "stale" ? "Retry" : "Load"} tasks in ${session.title} to complete search`}
                    >
                      {taskListFreshness?.status === "loading"
                        ? "Loading tasks…"
                        : taskListFreshness?.status === "error" || taskListFreshness?.status === "stale"
                          ? "Retry task search"
                          : "Load tasks to search"}
                    </QuietRow>
                    {taskListFreshness?.error ? (
                      <span role="alert" className="px-2 pl-[26px] text-sm text-error">
                        This project's tasks could not be loaded.
                      </span>
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
                <span role="alert" className="px-2 text-sm text-error">More projects could not be loaded.</span>
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
        <span className="min-w-0 flex-1 truncate text-base text-secondary">Terminus</span>
        <IconButton
          label="Settings"
          icon={<Settings size={15} strokeWidth={1.7} aria-hidden />}
          size="sm"
          onClick={() => window.dispatchEvent(new CustomEvent("terminus:open-settings", { detail: { category: "appearance" } }))}
          data-tooltip="Settings  ⌘,"
          className="h-6 w-6 shrink-0 rounded-md text-secondary hover:bg-hover hover:text-primary"
        />
        {/* One 6px dot instead of a word. It is a button in every state
            because a manual reconcile is useful whether or not the control
            plane is currently answering. */}
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
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md hover:bg-hover"
        >
          <span
            className={cn(
              "block h-1.5 w-1.5 rounded-full",
              healthReady ? "bg-success" : healthStatus === "offline" ? "bg-error" : "bg-warning",
            )}
            aria-hidden
          />
        </Button>
      </div>
    </div>
  );
}

// ────────────────────────────── Chrome pieces ───────────────────────────────

/**
 * A destination row. 30px tall, 13px text, 16px icon — Codex's metrics, and
 * the thing that stops this column reading like a web dashboard nav.
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
        "flex w-full items-center gap-2 rounded-md px-2 text-left text-base transition-colors",
        active ? "bg-selected font-medium text-primary" : "text-secondary hover:bg-hover hover:text-primary",
      )}
      style={{ height: "var(--nav-row-height)" }}
    >
      <span className="flex shrink-0 items-center text-secondary">{icon}</span>
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
      className="sidebar-show-more flex h-7 w-full items-center rounded-md pl-[26px] pr-2 text-left text-base text-tertiary hover:bg-hover hover:text-secondary disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </Button>
  );
}

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
      {/* Sentence case, tertiary, 12px. The uppercase micro-label this used to
          be shouted a word nobody needs to read twice. */}
      <div className="flex h-7 items-center px-2">
        <span className="min-w-0 flex-1 truncate text-sm text-tertiary">{label}</span>
        {action ?? null}
      </div>
      {children}
    </div>
  );
}

// ────────────────────────── Inbox ───────────────────────────────────────────

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
 * Flatten every loaded task into one time-ordered list.
 *
 * "Priority" is not a date — it is everything asking for a human, hoisted out
 * of the timeline so it cannot scroll away under a week of finished work. A
 * task appears in exactly one group: repeating a row under both Priority and
 * its date reads as a duplicate rather than as emphasis.
 */
export function groupInboxTasks(
  tasks: readonly Task[],
  isPriority: (task: Task) => boolean,
  now: Date,
): InboxGroup[] {
  const newestFirst = [...tasks].sort(
    (a, b) => new Date(taskActivityIso(b)).getTime() - new Date(taskActivityIso(a)).getTime(),
  );
  const priority: Task[] = [];
  const byDay = new Map<number, Task[]>();
  for (const task of newestFirst) {
    if (isPriority(task)) {
      priority.push(task);
      continue;
    }
    const when = new Date(taskActivityIso(task));
    const key = Number.isNaN(when.getTime()) ? Number.NEGATIVE_INFINITY : startOfDayMs(when);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(task);
    else byDay.set(key, [task]);
  }

  const groups: InboxGroup[] = [];
  if (priority.length > 0) groups.push({ id: "priority", label: "Priority", tasks: priority });
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
 * One inbox row: the task, and the project it belongs to.
 *
 * The project line is what makes this list readable across repositories — a
 * flat list of objectives with no home is a list of sentences.
 */
const InboxRow = memo(function InboxRow({
  taskId,
  title,
  projectName,
  selected,
  onSelect,
}: {
  taskId: string;
  title: string;
  projectName: string | null;
  selected: boolean;
  onSelect: (taskId: string) => void;
}): JSX.Element {
  const handleClick = useCallback(() => onSelect(taskId), [onSelect, taskId]);
  return (
    <Button
      variant="bare"
      type="button"
      onClick={handleClick}
      aria-pressed={selected}
      aria-label={projectName ? `${title}, in ${projectName}` : title}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
        selected ? "bg-selected" : "hover:bg-hover",
      )}
    >
      <span className="w-full min-w-0 truncate text-base text-primary">{title}</span>
      {projectName ? (
        <span className="flex w-full min-w-0 items-center gap-1 text-sm text-tertiary">
          <Folder size={11} strokeWidth={1.7} className="shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{projectName}</span>
        </span>
      ) : null}
    </Button>
  );
});

function InboxList({
  selectedTaskId,
  onSelectTask,
  onOpenAttentionCenter,
}: {
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onOpenAttentionCenter?: () => void;
}): JSX.Element {
  const sessions = useTerminusStore((s) => s.sessions);
  const tasksBySession = useTerminusStore((s) => s.tasksBySession);
  const runActivityByTask = useTerminusStore((s) => s.runActivityByTask);
  const refreshVisibleSessionTasks = useTerminusStore((s) => s.refreshVisibleSessionTasks);

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
    return groupInboxTasks(
      all,
      (task) => lifecycleNeedsAttention(displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown")),
      now,
    );
  }, [runActivityByTask, tasksBySession]);

  const priorityMenuItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [];
    if (onOpenAttentionCenter) {
      items.push({
        id: "inbox.attention-center",
        label: "Open attention center",
        onSelect: onOpenAttentionCenter,
      });
    }
    items.push({
      id: "inbox.refresh",
      label: "Refresh tasks",
      onSelect: () => { void refreshVisibleSessionTasks(); },
    });
    return items;
  }, [onOpenAttentionCenter, refreshVisibleSessionTasks]);

  if (groups.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-tertiary">
        Nothing here yet. Tasks appear as they are created and worked on.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" aria-label="Inbox">
      {groups.map((group) => (
        <div key={group.id} className="flex flex-col">
          <div className="flex h-7 items-center px-2">
            <span className="min-w-0 flex-1 truncate text-sm text-tertiary">{group.label}</span>
            {/* Only Priority carries actions: it is the only group that is a
                queue rather than a record of when things happened. */}
            {group.id === "priority" ? (
              <Menu
                label="Priority actions"
                align="end"
                items={priorityMenuItems}
                trigger={(
                  <IconButton
                    label="Priority actions"
                    icon={<Ellipsis size={13} strokeWidth={1.7} aria-hidden />}
                    size="sm"
                    className="h-5 w-5 rounded-sm text-tertiary hover:bg-hover hover:text-primary"
                  />
                )}
              />
            ) : null}
          </div>
          {group.tasks.map((task) => (
            <InboxRow
              key={`${group.id}-${task.id}`}
              taskId={task.id}
              title={taskTitle(task)}
              projectName={projectNameById.get(task.session_id) ?? null}
              selected={task.id === selectedTaskId}
              onSelect={onSelectTask}
            />
          ))}
        </div>
      ))}
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

interface TaskRowProps {
  taskId: string;
  title: string;
  selected: boolean;
  pinned?: boolean;
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
 * One task, memoized on primitives.
 *
 * The row reads its own lifecycle out of the store instead of receiving it,
 * which is what keeps a streaming turn from re-rendering the tree: the parent's
 * props for every other row are unchanged, so `memo` bails them out, and only
 * the subscribed row here re-runs.
 */
const TaskRow = memo(function TaskRow({
  taskId,
  title,
  selected,
  pinned = false,
  depth,
  onSelect,
  onTogglePin,
  index,
  registerButton,
  onRowKeyDown,
  focusable,
}: TaskRowProps): JSX.Element {
  const task = useTerminusStore((s) => s.taskById[taskId]);
  const activity = useTerminusStore((s) => s.runActivityByTask[taskId] ?? "unknown");
  const status = displayLifecycleWith(task, activity);

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
    <SidebarItem
      title={title}
      status={status}
      selected={selected}
      pinned={pinned}
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
    <TaskRow
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
