/**
 * Terminus Desktop thread sidebar.
 *
 * The default view is a project-filtered thread queue. Native window controls
 * keep their own compact row, while Threads and Projects share one dedicated
 * switch below it. Board is a first-class navigation destination alongside
 * the thread actions.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Columns3, Folder, FolderOpen, PanelLeft, Search, Settings, SquarePen } from "lucide-react";
import { cn } from "../lib/cn";
import { useTerminusStore, usePinnedTasks } from "../hooks/use-terminus";
import { useTaskReadStore } from "../hooks/use-task-read";
import { attentionReason, spansMultipleProjects, taskIsUnread, taskShelf } from "../lib/attention";
import { taskTitle } from "../lib/task-lifecycle";
import { displayLifecycleWith } from "../lib/turn-activity";
import {
  readCollapsedProjects,
  readExpandedProjects,
  readSidebarGrouping,
  writeCollapsedProjects,
  writeExpandedProjects,
  writeSidebarGrouping,
  type SidebarGrouping,
} from "../lib/sidebar-prefs";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Skeleton } from "../ui/Status";
import { TaskQueue } from "./TaskQueue";
import { TaskRow } from "./TaskRow";
import type { Session, Task } from "../types";

interface SidebarProps {
  activeDestination?: SidebarDestination;
  onNavigate?: (destination: SidebarDestination) => void;
  onOpenProject?: () => void;
  /** Opens the app's task/command search. */
  onSearch?: () => void;
  /** Collapses the visible sidebar. The hidden state owns its reopen control. */
  onToggleSidebar?: () => void;
  /** Returns from the Settings destination to the previous app surface. */
  onBackFromSettings?: () => void;
}

export type SidebarDestination = "new_task" | "chat" | "board" | "settings";

/** Opens the thread-priority view without creating or selecting work. */
export const SHOW_ACTIVITY_EVENT = "terminus:show-activity";

function useKeepTaskInView(taskId: string | null, shelf: string | null): void {
  useEffect(() => {
    if (!taskId) return;
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
  onSearch,
  onToggleSidebar,
  onBackFromSettings,
}: SidebarProps): JSX.Element {
  const sessions = useTerminusStore((s) => s.sessions);
  const tasksBySession = useTerminusStore((s) => s.tasksBySession);
  const taskById = useTerminusStore((s) => s.taskById);
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const selectedTaskId = useTerminusStore((s) => s.selectedTaskId);
  const pinnedTaskIds = useTerminusStore((s) => s.pinnedTaskIds);
  const sessionsPage = useTerminusStore((s) => s.sessionsPage);
  const sessionsFreshness = useTerminusStore((s) => s.sessionsFreshness);
  const taskPagesBySession = useTerminusStore((s) => s.taskPagesBySession);
  const taskFreshnessById = useTerminusStore((s) => s.taskFreshnessById);
  const loadingSessions = useTerminusStore((s) => s.loadingSessions);
  const healthStatus = useTerminusStore((s) => s.healthStatus);
  const pinPersistenceError = useTerminusStore((s) => s.pinPersistenceError);
  const runActivityByTask = useTerminusStore((s) => s.runActivityByTask);

  const selectTask = useTerminusStore((s) => s.selectTask);
  const selectSession = useTerminusStore((s) => s.selectSession);
  const togglePin = useTerminusStore((s) => s.togglePin);
  const refreshSessions = useTerminusStore((s) => s.refreshSessions);
  const loadMoreSessions = useTerminusStore((s) => s.loadMoreSessions);
  const loadMoreTasks = useTerminusStore((s) => s.loadMoreTasks);
  const refreshTask = useTerminusStore((s) => s.refreshTask);

  const seenAtByTask = useTaskReadStore((s) => s.seenAtByTask);
  const pinnedTasks = usePinnedTasks();
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const [sidebarGrouping, setSidebarGrouping] = useState<SidebarGrouping>(readSidebarGrouping);

  useEffect(() => { writeSidebarGrouping(sidebarGrouping); }, [sidebarGrouping]);
  useEffect(() => {
    const showThreads = (): void => setSidebarGrouping("recent");
    window.addEventListener(SHOW_ACTIVITY_EVENT, showThreads);
    return () => window.removeEventListener(SHOW_ACTIVITY_EVENT, showThreads);
  }, []);

  const onNavigateRef = useRef(onNavigate);
  useEffect(() => { onNavigateRef.current = onNavigate; }, [onNavigate]);

  const onNewThread = useCallback((): void => {
    onNavigateRef.current?.("new_task");
    selectTask(null);
  }, [selectTask]);

  const onSelectTask = useCallback((taskId: string): void => {
    onNavigateRef.current?.("chat");
    selectTask(taskId);
  }, [selectTask]);

  const onSelectProject = useCallback((sessionId: string): void => {
    selectSession(sessionId);
    // selectSession preserves the current task when the session is already
    // selected, so clear it explicitly before opening the new-thread surface.
    selectTask(null);
    onNavigateRef.current?.("new_task");
  }, [selectSession, selectTask]);

  const onOpenSearch = useCallback((): void => {
    if (onSearch) onSearch();
    else window.dispatchEvent(new Event("terminus:open-command-palette"));
  }, [onSearch]);

  const selectedSession = selectedSessionId
    ? sessions.find((session) => session.id === selectedSessionId) ?? null
    : null;
  const projectLabel = selectedSession?.title ?? (sessions.length > 0 ? "All projects" : "Open project");

  const visiblePinnedTasks = useMemo(
    () => pinnedTasks.filter((task) => sidebarGrouping === "project" || selectedSessionId === null || task.session_id === selectedSessionId),
    [pinnedTasks, selectedSessionId, sidebarGrouping],
  );
  const unresolvedPinnedTaskIds = useMemo(
    () => selectedSessionId === null || sidebarGrouping === "project"
      ? [...pinnedTaskIds].filter((taskId) => !taskById[taskId])
      : [],
    [pinnedTaskIds, selectedSessionId, sidebarGrouping, taskById],
  );
  const projectNameById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );
  const showPinnedProject = sidebarGrouping === "project"
    ? sessions.length > 1
    : selectedSessionId === null && spansMultipleProjects(visiblePinnedTasks.map((task) => task.session_id));

  const selectedTask = selectedTaskId ? taskById[selectedTaskId] : undefined;
  const selectedShelf = selectedTask
    ? (() => {
        const lifecycle = displayLifecycleWith(selectedTask, runActivityByTask[selectedTask.id] ?? "unknown");
        if (lifecycle === "review") return "ready_to_review";
        return taskShelf(
          lifecycle,
          attentionReason({ lifecycle, domainTask: selectedTask }),
          taskIsUnread(selectedTask.updated_at || selectedTask.created_at, seenAtByTask[selectedTask.id]),
        );
      })()
    : null;
  useKeepTaskInView(selectedTaskId, selectedShelf);

  const taskPage = selectedSessionId ? taskPagesBySession[selectedSessionId] : undefined;
  const filteredTaskCount = selectedSessionId === null
    ? Object.values(tasksBySession).reduce((count, tasks) => count + tasks.length, 0)
    : (tasksBySession[selectedSessionId]?.length ?? 0);

  const hasPins = visiblePinnedTasks.length > 0
    || unresolvedPinnedTaskIds.length > 0
    || pinPersistenceError !== null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-1.5 px-2 pb-2">
        <div className="titlebar-drag pointer-events-none relative z-40 flex h-9 translate-y-1.5 items-center justify-end">
          {onToggleSidebar ? (
            <IconButton
              label="Hide sidebar"
              data-tooltip="Hide sidebar"
              icon={<PanelLeft size={14} strokeWidth={1.7} aria-hidden />}
              size="sm"
              onClick={onToggleSidebar}
              className="titlebar-no-drag pointer-events-auto h-7 w-7 rounded-md text-tertiary hover:bg-hover hover:text-primary"
            />
          ) : null}
        </div>

        <div
          className="grid h-8 min-w-0 grid-cols-2 rounded-lg bg-subtle p-0.5"
          role="group"
          aria-label="Sidebar view"
        >
          <Button
            type="button"
            variant="bare"
            aria-pressed={sidebarGrouping === "recent"}
            onClick={() => setSidebarGrouping("recent")}
            className={cn(
              "ui-body flex h-7 items-center justify-center rounded-md px-2 transition-colors",
              sidebarGrouping === "recent" ? "bg-selected font-medium text-primary" : "text-tertiary hover:text-secondary",
            )}
          >
            Threads
          </Button>
          <Button
            type="button"
            variant="bare"
            aria-pressed={sidebarGrouping === "project"}
            onClick={() => setSidebarGrouping("project")}
            className={cn(
              "ui-body flex h-7 items-center justify-center rounded-md px-2 transition-colors",
              sidebarGrouping === "project" ? "bg-selected font-medium text-primary" : "text-tertiary hover:text-secondary",
            )}
          >
            Projects
          </Button>
        </div>

        <nav className="flex flex-col" aria-label="Thread navigation">
          <NavRow
            icon={<SquarePen size={14} strokeWidth={1.7} aria-hidden />}
            label="New thread"
            active={activeDestination === "new_task"}
            onClick={onNewThread}
          />
          <NavRow
            icon={<Columns3 size={14} strokeWidth={1.7} aria-hidden />}
            label="Board"
            active={activeDestination === "board"}
            onClick={() => onNavigateRef.current?.("board")}
          />
          <NavRow
            icon={<Search size={14} strokeWidth={1.7} aria-hidden />}
            label="Search"
            onClick={onOpenSearch}
          />
        </nav>

        {sessionsPage.nextCursor ? (
          <QuietRow
            onClick={() => void loadMoreSessions()}
            disabled={sessionsPage.loadingMore}
            label="Load more projects"
          >
            {sessionsPage.loadingMore ? "Loading projects..." : sessionsPage.error ? "Retry projects" : "Load more projects"}
          </QuietRow>
        ) : null}
      </div>

      <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {(loadingSessions || sessionsFreshness.status === "loading") && sessions.length === 0 ? (
          <div className="grid gap-2 px-2 py-2" role="status" aria-label="Loading projects">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-4/5" />
          </div>
        ) : null}

        {sessions.length === 0 && sessionsFreshness.status === "error" && healthStatus !== "offline" ? (
          <div className="ui-meta flex flex-col items-start gap-2 px-2 py-3 text-error" role="alert">
            <span>Projects could not be loaded.</span>
            <Button size="sm" onClick={() => void refreshSessions()}>Retry projects</Button>
          </div>
        ) : null}

        {sessions.length > 0 && sessionsFreshness.status === "error" && healthStatus !== "offline" ? (
          <div className="ui-meta flex items-center gap-1.5 px-2" role="status">
            <span className="min-w-0 flex-1 truncate">Project list is not up to date.</span>
            <Button
              variant="bare"
              type="button"
              onClick={() => void refreshSessions()}
              className="shrink-0 rounded-sm underline-offset-2 hover:text-primary hover:underline"
            >
              Retry
            </Button>
          </div>
        ) : null}

        {sessions.length === 0 && !loadingSessions && sessionsFreshness.status !== "error" ? (
          <div className="ui-meta flex flex-col items-start gap-2 px-2 py-3">
            <span>{sessionsFreshness.status === "ready" ? "No projects yet." : "Projects have not loaded yet."}</span>
            {onOpenProject ? (
              <Button
                type="button"
                variant="bare"
                onClick={onOpenProject}
                className="h-7 rounded-md px-0 text-secondary hover:text-primary"
              >
                Open project
              </Button>
            ) : null}
          </div>
        ) : null}

        {hasPins ? (
          <SidebarSection
            label="Pinned"
            count={visiblePinnedTasks.length + unresolvedPinnedTaskIds.length}
            collapsed={!pinnedExpanded}
            onToggle={() => setPinnedExpanded((expanded) => !expanded)}
          >
            {visiblePinnedTasks.map((task) => (
              <PinnedTaskRow
                key={`pin-${task.id}`}
                task={task}
                selected={task.id === selectedTaskId}
                {...(showPinnedProject
                  ? { project: projectNameById.get(task.session_id) ?? undefined }
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
                    title={loading ? `Loading pinned thread ${taskId}` : `Pinned thread ${taskId} - unavailable`}
                    selected={false}
                    pinned
                    onClick={() => void refreshTask(taskId)}
                    onTogglePin={() => togglePin(taskId)}
                  />
                  {freshness?.error ? (
                    <span role="status" className="ui-meta break-words px-2 pb-1 text-warning">
                      This thread is unavailable. Select it to retry.
                    </span>
                  ) : null}
                </div>
              );
            })}
            {pinPersistenceError ? (
              <span role="alert" className="ui-meta px-2 py-1 text-warning">{pinPersistenceError}</span>
            ) : null}
          </SidebarSection>
        ) : null}

        {sidebarGrouping === "recent" ? (
          <>
            <TaskQueue
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
              sessionId={selectedSessionId}
            />

            {sessions.length > 0 ? (
              <RecentList
                sessionId={selectedSessionId}
                selectedTaskId={selectedTaskId}
                onSelectTask={onSelectTask}
              />
            ) : null}
          </>
        ) : (
          <ProjectTree
            sessions={sessions}
            tasksBySession={tasksBySession}
            selectedSessionId={selectedSessionId}
            selectedTaskId={selectedTaskId}
            onSelectProject={onSelectProject}
            onSelectTask={onSelectTask}
          />
        )}

        {sidebarGrouping === "recent" && selectedSessionId && taskPage?.nextCursor ? (
          <div className="flex flex-col items-start">
            <QuietRow
              onClick={() => void loadMoreTasks(selectedSessionId)}
              disabled={taskPage.loadingMore}
              label={`Load more threads in ${projectLabel}`}
            >
              {taskPage.loadingMore ? "Loading threads..." : taskPage.error ? "Retry threads" : "Load more threads"}
            </QuietRow>
            {taskPage.error ? (
              <span role="alert" className="ui-meta px-2 text-error">More threads could not be loaded.</span>
            ) : null}
          </div>
        ) : null}

        {sidebarGrouping === "recent" && sessions.length > 0 && filteredTaskCount === 0 ? (
          <p className="ui-meta px-2 py-1">No threads in this project yet.</p>
        ) : null}
      </div>

      <div className="sidebar-dock flex h-11 items-center px-2">
        <Button
          type="button"
          variant="bare"
          onClick={() => {
            if (activeDestination === "settings") {
              onBackFromSettings?.();
              return;
            }
            window.dispatchEvent(new CustomEvent("terminus:open-settings", { detail: { category: "appearance" } }));
          }}
          data-tooltip={activeDestination === "settings" ? "Back to app" : "Settings  Command-,"}
          className="ui-body flex h-8 w-full min-w-0 items-center justify-start gap-2 rounded-md px-2 text-secondary hover:bg-hover hover:text-primary"
        >
          {activeDestination === "settings"
            ? <ArrowLeft size={14} strokeWidth={1.7} aria-hidden />
            : <Settings size={14} strokeWidth={1.7} aria-hidden />}
          <span className="truncate">{activeDestination === "settings" ? "Back to app" : "Settings"}</span>
        </Button>
      </div>
    </div>
  );
}

function NavRow({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="bare"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "ui-body flex w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
        active ? "bg-selected font-medium text-primary" : "text-secondary hover:bg-hover hover:text-primary",
      )}
      style={{ height: "var(--nav-row-height)" }}
    >
      <span className={cn("flex shrink-0 items-center", active ? "text-secondary" : "text-tertiary")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </Button>
  );
}

function SidebarSection({
  label,
  count,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const labelContent = (
    <>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined ? null : <span className="shrink-0 tabular-nums">{count}</span>}
    </>
  );
  return (
    <section className="flex flex-col" aria-label={label}>
      <div className="flex h-7 items-center px-2">
        {onToggle ? (
          <Button
            type="button"
            variant="bare"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}${count === undefined ? "" : `, ${count}`}`}
            className="ui-section-label flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-secondary"
          >
            {collapsed
              ? <ChevronRight size={11} strokeWidth={1.8} aria-hidden />
              : <ChevronDown size={11} strokeWidth={1.8} aria-hidden />}
            {labelContent}
          </Button>
        ) : <div className="ui-section-label flex min-w-0 flex-1 items-center gap-1.5">{labelContent}</div>}
      </div>
      {collapsed ? null : children}
    </section>
  );
}

function QuietRow({
  children,
  label,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
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
      className="sidebar-show-more ui-body flex h-7 w-full items-center rounded-md px-2 text-left text-tertiary hover:bg-hover hover:text-secondary disabled:opacity-45"
    >
      {children}
    </Button>
  );
}

function ProjectTree({
  sessions,
  tasksBySession,
  selectedSessionId,
  selectedTaskId,
  onSelectProject,
  onSelectTask,
}: {
  sessions: readonly Session[];
  tasksBySession: Readonly<Record<string, readonly Task[]>>;
  selectedSessionId: string | null;
  selectedTaskId: string | null;
  onSelectProject: (sessionId: string) => void;
  onSelectTask: (taskId: string) => void;
}): JSX.Element | null {
  const runActivityByTask = useTerminusStore((s) => s.runActivityByTask);
  const taskPagesBySession = useTerminusStore((s) => s.taskPagesBySession);
  const loadMoreTasks = useTerminusStore((s) => s.loadMoreTasks);
  const seenAtByTask = useTaskReadStore((s) => s.seenAtByTask);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedProjects);
  const [expanded, setExpanded] = useState<Set<string>>(readExpandedProjects);

  useEffect(() => { writeCollapsedProjects(collapsed); }, [collapsed]);
  useEffect(() => { writeExpandedProjects(expanded); }, [expanded]);

  if (sessions.length === 0) return null;

  const toggleProject = (sessionId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const toggleAllTasks = (sessionId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  return (
    <SidebarSection label="Projects" count={sessions.length}>
      {sessions.map((session) => {
        const projectCollapsed = collapsed.has(session.id);
        const tasks = tasksBySession[session.id] ?? [];
        const page = taskPagesBySession[session.id];
        const projectExpanded = expanded.has(session.id);
        const visibleTasks = projectExpanded ? tasks : tasks.slice(0, 6);
        const hiddenTaskCount = tasks.length - visibleTasks.length;
        return (
          <div key={session.id} className="flex flex-col">
            <div
              className={cn(
                "flex h-8 w-full min-w-0 items-center rounded-md",
                selectedSessionId === session.id ? "bg-selected text-primary" : "text-secondary",
              )}
            >
              <Button
                type="button"
                variant="bare"
                onClick={() => onSelectProject(session.id)}
                aria-current={selectedSessionId === session.id ? "page" : undefined}
                className="ui-body flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 text-left hover:bg-hover hover:text-primary"
              >
                {projectCollapsed
                  ? <Folder size={14} strokeWidth={1.7} className="shrink-0 text-tertiary" aria-hidden />
                  : <FolderOpen size={14} strokeWidth={1.7} className="shrink-0 text-tertiary" aria-hidden />}
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
              </Button>
              <IconButton
                type="button"
                variant="bare"
                size="sm"
                label={`${projectCollapsed ? "Expand" : "Collapse"} ${session.title}`}
                aria-expanded={!projectCollapsed}
                data-tooltip={`${projectCollapsed ? "Expand" : "Collapse"} ${session.title}`}
                onClick={() => toggleProject(session.id)}
                className="mr-0.5 h-7 w-7 shrink-0 rounded-md text-tertiary hover:bg-hover hover:text-primary"
                icon={
                  <ChevronRight
                    size={11}
                    strokeWidth={1.8}
                    className={cn("transition-transform", !projectCollapsed && "rotate-90")}
                    aria-hidden
                  />
                }
              />
            </div>

            {projectCollapsed ? null : tasks.length === 0 ? (
              <p className="ui-meta py-1 pl-8 pr-2">No threads yet.</p>
            ) : (
              <div className="flex flex-col">
                {visibleTasks.map((task) => {
                  const lifecycle = displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown");
                  const reason = attentionReason({ lifecycle, domainTask: task });
                  const updatedAt = task.updated_at || task.created_at;
                  const selected = task.id === selectedTaskId;
                  return (
                    <TaskRow
                      key={task.id}
                      taskId={task.id}
                      title={taskTitle(task)}
                      status={lifecycle}
                      selected={selected}
                      needsYou={reason !== null}
                      unread={taskIsUnread(updatedAt, seenAtByTask[task.id])}
                      depth={1}
                      {...(reason ? { reason: reason.label } : {})}
                      onClick={() => onSelectTask(task.id)}
                    />
                  );
                })}
                {tasks.length > 6 ? (
                  <Button
                    type="button"
                    variant="bare"
                    onClick={() => toggleAllTasks(session.id)}
                    aria-label={projectExpanded ? `Show fewer threads in ${session.title}` : `Show ${hiddenTaskCount} more threads in ${session.title}`}
                    className="sidebar-show-more ui-body flex h-7 items-center rounded-md pl-8 pr-2 text-left text-tertiary hover:bg-hover hover:text-secondary"
                  >
                    {projectExpanded ? "Show fewer" : `Show ${hiddenTaskCount} more`}
                  </Button>
                ) : null}
                {page?.nextCursor && (projectExpanded || hiddenTaskCount === 0) ? (
                  <Button
                    type="button"
                    variant="bare"
                    disabled={page.loadingMore}
                    onClick={() => void loadMoreTasks(session.id)}
                    className="sidebar-show-more ui-body flex h-7 items-center rounded-md pl-8 pr-2 text-left text-tertiary hover:bg-hover hover:text-secondary"
                  >
                    {page.loadingMore ? "Loading threads…" : page.error ? "Retry threads" : "Show more"}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </SidebarSection>
  );
}

const PinnedTaskRow = memo(function PinnedTaskRow({
  task,
  selected,
  project,
  onSelect,
  onTogglePin,
}: {
  task: Task;
  selected: boolean;
  project?: string;
  onSelect: (taskId: string) => void;
  onTogglePin: (taskId: string) => void;
}): JSX.Element {
  const lifecycle = useTerminusStore((s) => displayLifecycleWith(task, s.runActivityByTask[task.id] ?? "unknown"));
  const seenAt = useTaskReadStore((s) => s.seenAtByTask[task.id]);
  const reason = attentionReason({ lifecycle, domainTask: task });
  return (
    <TaskRow
      taskId={task.id}
      title={taskTitle(task)}
      status={lifecycle}
      selected={selected}
      needsYou={reason !== null}
      unread={taskIsUnread(task.updated_at || task.created_at, seenAt)}
      pinned
      {...(project ? { meta: project } : {})}
      {...(reason ? { reason: reason.label } : {})}
      onClick={() => onSelect(task.id)}
      onTogglePin={() => onTogglePin(task.id)}
    />
  );
});

/** When the task last moved. */
function taskActivityIso(task: Task): string {
  return task.updated_at || task.created_at;
}

function startOfDayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function inboxDateLabel(iso: string, now: Date): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "Earlier";
  const day = startOfDayMs(when);
  const today = startOfDayMs(now);
  if (day === today) return "Today";
  if (day === startOfDayMs(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "Yesterday";
  return when.toLocaleDateString(undefined, when.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

export interface InboxGroup {
  readonly id: string;
  readonly label: string;
  readonly tasks: readonly Task[];
}

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
  return [...byDay.entries()]
    .sort((left, right) => right[0] - left[0])
    .flatMap(([key, dayTasks]) => {
      const first = dayTasks[0];
      return first ? [{ id: `day-${key}`, label: inboxDateLabel(taskActivityIso(first), now), tasks: dayTasks }] : [];
    });
}

function RecentList({
  sessionId,
  selectedTaskId,
  onSelectTask,
}: {
  sessionId: string | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}): JSX.Element | null {
  const sessions = useTerminusStore((s) => s.sessions);
  const tasksBySession = useTerminusStore((s) => s.tasksBySession);
  const runActivityByTask = useTerminusStore((s) => s.runActivityByTask);
  const seenAtByTask = useTaskReadStore((s) => s.seenAtByTask);
  const markRead = useTaskReadStore((s) => s.markRead);
  const markUnread = useTaskReadStore((s) => s.markUnread);
  const [expanded, setExpanded] = useState(false);

  const projectNameById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );
  const rows = useMemo(() => {
    const taskLists = sessionId === null
      ? Object.values(tasksBySession)
      : [tasksBySession[sessionId] ?? []];
    return taskLists.flat().filter((task) => {
      const lifecycle = displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown");
      if (lifecycle === "review") return false;
      const reason = attentionReason({ lifecycle, domainTask: task });
      return taskShelf(
        lifecycle,
        reason,
        taskIsUnread(task.updated_at || task.created_at, seenAtByTask[task.id]),
      ) === "settled";
    }).sort((left, right) => taskActivityIso(right).localeCompare(taskActivityIso(left)));
  }, [runActivityByTask, seenAtByTask, sessionId, tasksBySession]);

  if (rows.length === 0) return null;
  const selectedIndex = rows.findIndex((task) => task.id === selectedTaskId);
  const visibleCount = sidebarVisibleTaskCount(rows.length, selectedIndex, expanded);
  const visible = rows.slice(0, Math.max(8, visibleCount));
  const hidden = rows.length - visible.length;
  const showProject = sessionId === null && spansMultipleProjects(rows.map((task) => task.session_id));

  return (
    <SidebarSection label="Recent">
      {visible.map((task) => {
        const updatedAt = task.updated_at || task.created_at;
        const unread = taskIsUnread(updatedAt, seenAtByTask[task.id]);
        const lifecycle = displayLifecycleWith(task, runActivityByTask[task.id] ?? "unknown");
        return (
          <TaskRow
            key={task.id}
            taskId={task.id}
            title={taskTitle(task)}
            status={lifecycle}
            selected={task.id === selectedTaskId}
            unread={unread}
            {...(showProject ? { meta: projectNameById.get(task.session_id) ?? undefined } : {})}
            onClick={() => onSelectTask(task.id)}
            {...(unread
              ? { onMarkRead: () => markRead(task.id, updatedAt) }
              : { onMarkUnread: () => markUnread(task.id) })}
          />
        );
      })}
      {hidden > 0 || expanded ? (
        <QuietRow
          onClick={() => setExpanded((value) => !value)}
          label={hidden > 0 ? `Show ${hidden} more recent threads` : "Show fewer recent threads"}
        >
          {hidden > 0 ? "Show more" : "Show less"}
        </QuietRow>
      ) : null}
    </SidebarSection>
  );
}

const COLLAPSED_TASK_LIMIT = 3;

/** Retained for callers that preview long task lists. */
export function sidebarVisibleTaskCount(
  taskCount: number,
  selectedTaskIndex: number,
  expanded: boolean,
): number {
  if (expanded) return taskCount;
  return Math.min(taskCount, Math.max(COLLAPSED_TASK_LIMIT, selectedTaskIndex + 1));
}

export const Sidebar = memo(SidebarImpl);
