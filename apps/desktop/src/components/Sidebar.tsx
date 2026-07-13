/**
 * Terminus Desktop — Sidebar.
 *
 * Per SPEC §7:
 *   Application name
 *   New task        ← primary action button
 *   Scheduled / Plugins / Pull requests / Chat
 *   Search tasks    ← filtering input
 *   Pinned          ← important tasks
 *     - task
 *     - task
 *   Projects        ← sessions from the control plane
 *     - Project A
 *       - Active task
 *       - Previous task
 *       - Show more
 *     - Project B
 *   User profile    ← bottom
 *
 * Per SPEC §7.1: "Projects contain nested tasks. Do not expose worktrees
 * or branches as another permanent hierarchy level."
 *
 * Per SPEC §7.2: selected state visible without bright saturated bg.
 *
 * Per SPEC §24: compact mode = icons only.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  GitPullRequestArrow,
  HelpCircle,
  MessageCircle,
  Plus,
  Puzzle,
  Search,
  Settings,
  SquarePen,
  SquareTerminal,
  TriangleAlert,
  User,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/cn";
import { useTerminusStore, usePinnedTasks, normalizeTaskStatus } from "../hooks/use-terminus";
import { useThemeStore } from "../hooks/use-theme";
import { useViewport } from "../hooks/use-viewport";
import { SidebarItem } from "./SidebarItem";
import type { Session, Task } from "../types";

interface SidebarProps {
  compact?: boolean;
  activeDestination?: SidebarDestination;
  onNavigate?: (destination: SidebarDestination) => void;
}

export type SidebarDestination = "new_task" | "scheduled" | "plugins" | "pull_requests" | "chat";

const DESTINATION_NAV: Array<{
  id: Exclude<SidebarDestination, "new_task">;
  label: string;
  icon: typeof CalendarClock;
}> = [
  { id: "scheduled", label: "Scheduled", icon: CalendarClock },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "pull_requests", label: "Pull requests", icon: GitPullRequestArrow },
  { id: "chat", label: "Chat", icon: MessageCircle },
];

function SidebarImpl({ compact: compactProp, activeDestination = "new_task", onNavigate }: SidebarProps): JSX.Element {
  const viewport = useViewport();
  const compact = compactProp ?? viewport.sidebarRail;

  const sessions = useTerminusStore((s) => s.sessions);
  const tasksBySession = useTerminusStore((s) => s.tasksBySession);
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const selectedTaskId = useTerminusStore((s) => s.selectedTaskId);
  const pinnedTaskIds = useTerminusStore((s) => s.pinnedTaskIds);
  const loadingSessions = useTerminusStore((s) => s.loadingSessions);
  const healthReady = useTerminusStore((s) => s.healthReady);
  const lastError = useTerminusStore((s) => s.lastError);

  const selectSession = useTerminusStore((s) => s.selectSession);
  const selectTask = useTerminusStore((s) => s.selectTask);
  const togglePin = useTerminusStore((s) => s.togglePin);
  const refreshAll = useTerminusStore((s) => s.refreshAll);

  const pinnedTasks = usePinnedTasks();

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

  const filtered = useMemo(() => {
    if (!query.trim()) return sessions;
    const q = query.toLowerCase();
    return sessions.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      const tasks = tasksBySession[s.id] ?? [];
      return tasks.some((t) => t.contract?.objective.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
    });
  }, [query, sessions, tasksBySession]);

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
    selectTask(null);
  };

  if (compact) {
    // Rail mode — icons only, no labels.
    return (
      <div className="flex h-full flex-col items-center gap-2 py-3">
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md text-primary"
          aria-label="Terminus"
          title="Terminus"
        >
          <SquareTerminal size={16} strokeWidth={1.8} />
        </div>
        <button
          type="button"
          onClick={onNewTask}
          aria-label="New task"
          title="New task"
          className="flex h-8 w-8 items-center justify-center rounded-md bg-hover text-secondary hover:text-primary"
        >
          <Plus size={16} />
        </button>
        {DESTINATION_NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onDestination(id)}
            aria-label={label}
            title={label}
            aria-current={activeDestination === id ? "page" : undefined}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md",
              activeDestination === id ? "bg-selected text-primary" : "text-secondary hover:bg-hover",
            )}
          >
            <Icon size={15} strokeWidth={1.7} />
          </button>
        ))}
        <div className="my-1 h-px w-6 bg-subtle" style={{ background: "var(--border-subtle)" }} />
        <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto">
          {sessions.slice(0, 12).map((s) => (
            <CompactSessionButton
              key={s.id}
              session={s}
              selected={s.id === selectedSessionId}
              onClick={() => selectSession(s.id)}
            />
          ))}
        </div>
        <div className="flex h-8 w-8 items-center justify-center rounded-md text-tertiary">
          <User size={16} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Application name + global task navigation. */}
      <div className="flex flex-col px-4 pb-3 pt-4">
        <div className="mb-3 flex items-center">
          <div className="flex items-center gap-2">
            <span
              className="font-semibold tracking-tight text-primary"
              style={{ fontSize: "var(--font-size-lg)" }}
            >
              Terminus
            </span>
          </div>
          <button
            type="button"
            onClick={() => setSearchOpen((open) => !open)}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-hover hover:text-primary"
            aria-label="Search tasks"
            aria-expanded={searchOpen}
          >
            <Search size={16} strokeWidth={1.7} />
          </button>
        </div>

        <button
          type="button"
          onClick={onNewTask}
          aria-current={activeDestination === "new_task" ? "page" : undefined}
          className={cn(
            "sidebar-nav-item h-9 px-1.5",
            activeDestination === "new_task" && "is-active",
          )}
          style={{ fontSize: "var(--font-size-base)" }}
        >
          <SquarePen size={16} strokeWidth={1.7} />
          <span>New task</span>
        </button>

        <nav className="mt-2 flex flex-col gap-0.5" aria-label="Workspace navigation">
          {DESTINATION_NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onDestination(id)}
              aria-current={activeDestination === id ? "page" : undefined}
              className={cn("sidebar-nav-item", activeDestination === id && "is-active")}
            >
              <Icon size={15} strokeWidth={1.7} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        {/* Search. */}
        {searchOpen ? <div className="relative mt-2 animate-slide-down">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-tertiary"
          />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks"
            className={cn(
              "w-full rounded-md bg-transparent pl-7 pr-2 text-secondary placeholder:text-tertiary",
              "focus:bg-hover focus:outline-none",
            )}
            style={{
              height: 32,
              fontSize: "var(--font-size-sm)",
              background: "var(--bg-hover)",
            }}
            aria-label="Search tasks"
            autoFocus
          />
        </div> : null}

        {!healthReady && lastError ? (
          <button
            type="button"
            onClick={() => void refreshAll()}
            className="mt-1 flex min-h-7 items-center gap-2 rounded-md px-2 text-left text-tertiary hover:bg-hover hover:text-secondary"
            role="alert"
            title={lastError}
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            <TriangleAlert size={13} className="flex-shrink-0 text-warning" />
            <span className="min-w-0 flex-1 truncate">Offline</span>
            <span className="font-medium text-secondary">Retry</span>
          </button>
        ) : null}
      </div>

      {/* Scrollable projects/tasks list. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3">
        {/* Pinned section. */}
        {pinnedTasks.length > 0 ? (
          <SidebarSection title="Pinned">
            {pinnedTasks.map((t) => (
              <SidebarItem
                key={`pin-${t.id}`}
                title={taskTitle(t)}
                status={normalizeTaskStatus(t.status)}
                updatedAt={t.updated_at}
                selected={t.id === selectedTaskId}
                pinned
                depth={0}
                onClick={() => onSelectTask(t.id)}
                onTogglePin={() => togglePin(t.id)}
              />
            ))}
          </SidebarSection>
        ) : null}

        {/* Projects section. */}
        <SidebarSection title={loadingSessions && sessions.length === 0 ? "Loading…" : "Projects"}>
          {filtered.length === 0 && !loadingSessions ? (
            <div
              className="px-2 py-3 text-tertiary"
              style={{ fontSize: "var(--font-size-xs)" }}
            >
              {query ? "No matches." : "No projects yet."}
            </div>
          ) : null}
          {filtered.map((session) => {
            const collapsed = collapsedSessions.has(session.id);
            const tasks = tasksBySession[session.id] ?? [];
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
              <div key={session.id} className="flex flex-col">
                {/* Project row. */}
                <button
                  type="button"
                  onClick={() => {
                    selectSession(session.id);
                    toggleCollapsed(session.id);
                  }}
                  className={cn(
                    "group flex items-center gap-1 rounded-md text-left",
                    session.id === selectedSessionId ? "bg-selected text-primary" : "text-secondary hover:bg-hover",
                  )}
                  style={{ height: "var(--row-height)", paddingLeft: 4, paddingRight: 6 }}
                  title={session.title}
                  aria-expanded={!collapsed}
                  aria-controls={`session-tasks-${session.id}`}
                >
                  {tasks.length > 0 ? (
                    collapsed ? (
                      <ChevronRight size={12} className="flex-shrink-0 text-tertiary" />
                    ) : (
                      <ChevronDown size={12} className="flex-shrink-0 text-tertiary" />
                    )
                  ) : (
                    <span className="w-3 flex-shrink-0" />
                  )}
                  <span
                    className="min-w-0 flex-1 truncate"
                    style={{ fontSize: "var(--font-size-base)", fontWeight: 500 }}
                  >
                    {session.title}
                  </span>
                  {tasks.length > 0 ? (
                    <span
                      className="flex-shrink-0 font-mono text-tertiary"
                      style={{ fontSize: 10 }}
                      aria-label={`${tasks.length} tasks`}
                    >
                      {tasks.length}
                    </span>
                  ) : null}
                </button>
                {/* Tasks under this session. */}
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
                      <button
                        type="button"
                        onClick={() => setExpandedTaskLists((previous) => {
                          const next = new Set(previous);
                          next.add(session.id);
                          return next;
                        })}
                        className="sidebar-show-more ml-7 flex h-7 items-center rounded-md px-2 text-left text-tertiary hover:bg-hover hover:text-secondary"
                        style={{ fontSize: "var(--font-size-sm)" }}
                        aria-label={`Show ${hiddenTaskCount} more tasks in ${session.title}`}
                      >
                        Show more
                        <span className="ml-1.5 font-mono opacity-70">{hiddenTaskCount}</span>
                      </button>
                    ) : taskListExpanded && tasks.length > COLLAPSED_TASK_LIMIT && !query.trim() ? (
                      <button
                        type="button"
                        onClick={() => setExpandedTaskLists((previous) => {
                          const next = new Set(previous);
                          next.delete(session.id);
                          return next;
                        })}
                        className="sidebar-show-more ml-7 flex h-7 items-center rounded-md px-2 text-left text-tertiary hover:bg-hover hover:text-secondary"
                        style={{ fontSize: "var(--font-size-sm)" }}
                        aria-label={`Show fewer tasks in ${session.title}`}
                      >
                        Show less
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </SidebarSection>
      </div>

      {/* User profile at bottom. */}
      <div
        className="flex items-center gap-3 border-t border-subtle px-4 py-3"
        style={{ background: "var(--bg-sidebar)" }}
      >
        <div
          className="flex h-7 w-7 items-center justify-center rounded-full text-tertiary"
          style={{ background: "var(--bg-hover)" }}
          aria-hidden
        >
          <User size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-primary"
            style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}
          >
            Local workspace
          </div>
          <div
            className="truncate text-tertiary"
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            {healthReady ? "Control plane connected" : "Control plane offline"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("terminus:open-settings"))}
          aria-label="Settings"
          title="Settings"
          className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-secondary"
        >
          <Settings size={14} />
        </button>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("terminus:open-settings"))}
          aria-label="Help"
          title="Help and shortcuts"
          className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-secondary"
        >
          <HelpCircle size={14} />
        </button>
      </div>
    </div>
  );
}

function SidebarSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="px-2 py-1 text-tertiary"
        style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

// ────────────────────────── Virtualized task list ───────────────────────────

const VIRTUALIZATION_THRESHOLD = 50;
const COLLAPSED_TASK_LIMIT = 5;

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
  const rowHeight = density === "compact" ? 28 : 36;
  // The scroll element is the sidebar's outer scroll container. We
  // find it by walking up to the nearest scrollable ancestor — but
  // because we don't have a direct ref here, we use a local ref and
  // let the virtualizer attach to the parent's scroll. In practice
  // the closest scrollable ancestor IS the sidebar's task list.
  const parentRef = useRef<HTMLDivElement | null>(null);

  // Virtualize when >threshold items; otherwise render inline.
  const shouldVirtualize = tasks.length > VIRTUALIZATION_THRESHOLD;

  // TanStack Virtual exposes imperative functions by design; compiler
  // memoization would risk stale task rows.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? tasks.length : 0,
    getScrollElement: () => {
      // Walk up to find the scrollable ancestor. This is robust to
      // re-renders without requiring the parent to forward a ref.
      let el = parentRef.current?.parentElement ?? null;
      while (el) {
        const style = window.getComputedStyle(el);
        if (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight
        ) {
          return el;
        }
        el = el.parentElement;
      }
      return parentRef.current ?? null;
    },
    estimateSize: () => rowHeight,
    overscan: 8,
    enabled: shouldVirtualize,
  });

  if (!shouldVirtualize) {
    return (
      <div id={id} className="flex flex-col" ref={parentRef} role="list" aria-label="Tasks">
        {tasks.map((task) => (
          <SidebarItem
            key={task.id}
            title={taskTitle(task)}
            status={normalizeTaskStatus(task.status)}
            updatedAt={task.updated_at}
            selected={task.id === selectedTaskId}
            pinned={pinnedTaskIds.has(task.id)}
            depth={1}
            onClick={() => onSelectTask(task.id)}
            onTogglePin={() => onTogglePin(task.id)}
          />
        ))}
      </div>
    );
  }

  // Virtualized render. The outer div sets the total height; each
  // virtual row is absolutely positioned inside it.
  return (
    <div
      id={id}
      ref={parentRef}
      role="list"
      aria-label={`Tasks (${tasks.length})`}
      style={{ position: "relative", height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const task = tasks[vi.index];
        if (!task) return null;
        return (
          <div
            key={task.id}
            data-index={vi.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vi.start}px)`,
            }}
          >
            <SidebarItem
              title={taskTitle(task)}
              status={normalizeTaskStatus(task.status)}
              updatedAt={task.updated_at}
              selected={task.id === selectedTaskId}
              pinned={pinnedTaskIds.has(task.id)}
              depth={1}
              onClick={() => onSelectTask(task.id)}
              onTogglePin={() => onTogglePin(task.id)}
            />
          </div>
        );
      })}
    </div>
  );
}

function CompactSessionButton({
  session,
  selected,
  onClick,
}: {
  session: Session;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={session.title}
      aria-label={session.title}
      aria-pressed={selected}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md",
        selected ? "bg-selected text-primary" : "text-secondary hover:bg-hover",
      )}
    >
      <span
        className="font-medium"
        style={{ fontSize: "var(--font-size-xs)" }}
      >
        {session.title.slice(0, 1).toUpperCase()}
      </span>
    </button>
  );
}

/** Derive a short task title from the contract objective or fall back to id. */
export function taskTitle(task: Task): string {
  const obj = task.contract?.objective?.trim();
  if (obj && obj.length > 0) {
    // First line, trimmed.
    const firstLine = obj.split("\n")[0] ?? obj;
    return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  }
  return task.id.slice(0, 8);
}

export const Sidebar = memo(SidebarImpl);
