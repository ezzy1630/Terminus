/**
 * Forge Desktop — Sidebar.
 *
 * Per SPEC §7:
 *   Application name
 *   New task        ← primary action button
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
import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Search, Settings, User } from "lucide-react";
import { cn } from "../lib/cn";
import { useForgeStore, usePinnedTasks, normalizeTaskStatus } from "../hooks/use-forge";
import { useThemeStore } from "../hooks/use-theme";
import { SidebarItem } from "./SidebarItem";
import type { Session, Task } from "../types";

interface SidebarProps {
  compact?: boolean;
}

function SidebarImpl({ compact: compactProp }: SidebarProps): JSX.Element {
  const density = useThemeStore((s) => s.density);
  const compact = compactProp ?? density === "compact";

  const sessions = useForgeStore((s) => s.sessions);
  const tasksBySession = useForgeStore((s) => s.tasksBySession);
  const selectedSessionId = useForgeStore((s) => s.selectedSessionId);
  const selectedTaskId = useForgeStore((s) => s.selectedTaskId);
  const pinnedTaskIds = useForgeStore((s) => s.pinnedTaskIds);
  const loadingSessions = useForgeStore((s) => s.loadingSessions);

  const selectSession = useForgeStore((s) => s.selectSession);
  const selectTask = useForgeStore((s) => s.selectTask);
  const togglePin = useForgeStore((s) => s.togglePin);

  const pinnedTasks = usePinnedTasks();

  const [query, setQuery] = useState("");
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(new Set());

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
    selectTask(null);
  };

  if (compact) {
    // Rail mode — icons only, no labels.
    return (
      <div className="flex h-full flex-col items-center gap-2 py-3">
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md text-primary"
          aria-label="Forge"
          title="Forge"
        >
          <span className="text-sm font-semibold" style={{ fontSize: "var(--font-size-md)" }}>F</span>
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
      {/* Application name + new task. */}
      <div className="flex flex-col gap-2 px-3 pb-2 pt-3">
        <div className="flex items-center justify-between">
          <span
            className="font-semibold tracking-tight text-primary"
            style={{ fontSize: "var(--font-size-md)" }}
          >
            Forge
          </span>
          <button
            type="button"
            onClick={onNewTask}
            className="flex h-6 items-center gap-1 rounded-md px-2 text-xs text-secondary hover:bg-hover hover:text-primary"
            style={{ fontSize: "var(--font-size-xs)" }}
            aria-label="New task"
          >
            <Plus size={12} />
            <span>New task</span>
          </button>
        </div>

        {/* Search. */}
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-tertiary"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks"
            className={cn(
              "w-full rounded-md border border-subtle bg-canvas pl-7 pr-2 text-secondary placeholder:text-tertiary",
              "focus:border-default focus:outline-none",
            )}
            style={{
              height: 26,
              fontSize: "var(--font-size-xs)",
              background: "var(--bg-canvas)",
            }}
            aria-label="Search tasks"
          />
        </div>
      </div>

      {/* Scrollable projects/tasks list. */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
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
                onClick={() => selectTask(t.id)}
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
            const visibleTasks = collapsed ? tasks.slice(0, 0) : tasks.slice(0, 8);
            const hasMore = tasks.length > 8;
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
                </button>
                {/* Tasks under this session. */}
                {!collapsed && visibleTasks.length > 0 ? (
                  <div className="flex flex-col">
                    {visibleTasks.map((task) => (
                      <SidebarItem
                        key={task.id}
                        title={taskTitle(task)}
                        status={normalizeTaskStatus(task.status)}
                        updatedAt={task.updated_at}
                        selected={task.id === selectedTaskId}
                        pinned={pinnedTaskIds.has(task.id)}
                        depth={1}
                        onClick={() => selectTask(task.id)}
                        onTogglePin={() => togglePin(task.id)}
                      />
                    ))}
                    {hasMore ? (
                      <button
                        type="button"
                        onClick={() => selectSession(session.id)}
                        className="ml-7 mt-0.5 self-start rounded px-2 py-0.5 text-xs text-tertiary hover:bg-hover hover:text-secondary"
                        style={{ fontSize: "var(--font-size-xs)" }}
                      >
                        Show {tasks.length - 8} more
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </SidebarSection>
      </div>

      {/* User profile at bottom. */}
      <div
        className="flex items-center gap-2 border-t border-subtle px-3 py-2"
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
            Developer
          </div>
          <div
            className="truncate text-tertiary"
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            Local · forge-control-dev-token
          </div>
        </div>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-secondary"
        >
          <Settings size={14} />
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
    <div className="flex flex-col gap-0.5">
      <div
        className="px-2 py-1 text-tertiary uppercase tracking-wide"
        style={{ fontSize: "var(--font-size-xs)", fontWeight: 500 }}
      >
        {title}
      </div>
      {children}
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
