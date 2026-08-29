/**
 * Terminus Desktop — TaskSearch.
 *
 * The sidebar's magnifying glass. It used to unfold a filter field inside the
 * rail that narrowed the tree in place — the results moved under the cursor,
 * the field competed with the list for the column's width, and closing it
 * left the rail in whatever state the filter had scrolled it to.
 *
 * This is the Codex shape instead: a centered surface over the workspace
 * that lists the most recent tasks across every project, narrows as you type,
 * and opens the chosen one on Enter. The rail underneath never moves. Quick
 * actions ride along at the bottom so the same field reaches "new task",
 * "open project", and the command catalog without a second shortcut.
 *
 * Matching is by word, not by subsequence: the palette's fuzzy matcher is
 * right for a catalogue of forty commands, but over task titles it finds
 * "needle" inside "Unrelated cleanup", and a search that returns everything
 * is a list.
 */
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Columns3, FolderOpen, Search, SquarePen, Terminal } from "lucide-react";
import { cn } from "../lib/cn";
import { isComposingKeyboardEvent, useDialogFocus } from "../hooks/use-dialog-focus";
import { useTerminusStore } from "../hooks/use-terminus";
import type { Task } from "../types";
import { taskTitle } from "../lib/task-lifecycle";
import { FIXED_SHORTCUTS, shortcutDisplay } from "../lib/shortcuts";
import { DialogSurface } from "../ui/Dialog";
import { Kbd } from "../ui/Kbd";

export interface TaskSearchProps {
  open: boolean;
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
  onNewTask: () => void;
  onOpenProject: () => void;
  onOpenBoard: () => void;
  onOpenCommands: () => void;
}

/** The nine ⌘-digit slots map onto the current project's task order. */
const SLOT_COUNT = 9;
/** With nothing typed, the list is a recency view, not a catalogue. */
const IDLE_ROWS = 9;
const QUERY_ROWS = 40;

interface Match {
  matched: boolean;
  score: number;
}

/**
 * Every whitespace-separated term must appear in one of the fields.
 * Scores prefer a term at the start of the title, then at the start of a
 * word, then anywhere; the first field is the title and outranks the rest.
 */
export function matchTerms(query: string, fields: readonly string[]): Match {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { matched: true, score: 0 };
  const lowered = fields.map((field) => field.toLowerCase());
  let score = 0;
  for (const term of terms) {
    let best = 0;
    lowered.forEach((field, fieldIndex) => {
      const at = field.indexOf(term);
      if (at < 0) return;
      const weight = fieldIndex === 0 ? 3 : 1;
      const position = at === 0 ? 3 : /[\s\-_/.]/.test(field.charAt(at - 1)) ? 2 : 1;
      best = Math.max(best, weight * position);
    });
    if (best === 0) return { matched: false, score: 0 };
    score += best;
  }
  return { matched: true, score };
}

type Row =
  | { kind: "task"; id: string; task: Task; project: string; slot: number | null; score: number }
  | { kind: "action"; id: string; label: string; icon: JSX.Element; hint?: string; run: () => void }
  | { kind: "load"; id: string; label: string; run: () => void };

interface Section {
  title: string;
  rows: Row[];
}

function TaskSearchImpl({
  open,
  onClose,
  onSelectTask,
  onNewTask,
  onOpenProject,
  onOpenBoard,
  onOpenCommands,
}: TaskSearchProps): JSX.Element {
  const sessions = useTerminusStore((s) => s.sessions);
  const tasksBySession = useTerminusStore((s) => s.tasksBySession);
  const taskPagesBySession = useTerminusStore((s) => s.taskPagesBySession);
  const taskListFreshnessBySession = useTerminusStore((s) => s.taskListFreshnessBySession);
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const loadMoreTasks = useTerminusStore((s) => s.loadMoreTasks);
  const refreshTasks = useTerminusStore((s) => s.refreshTasks);

  const dialogRef = useDialogFocus<HTMLDivElement>(open, onClose);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);

  const projectNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const session of sessions) names.set(session.id, session.title);
    return names;
  }, [sessions]);

  // Ranking runs against the deferred value so a fast typist never waits on
  // the list to catch up; the input itself always paints the keystroke first.
  const trimmed = useDeferredValue(query.trim());

  const taskRows = useMemo<Row[]>(() => {
    const currentTasks = selectedSessionId ? tasksBySession[selectedSessionId] ?? [] : [];
    const slotByTask = new Map<string, number>();
    currentTasks.slice(0, SLOT_COUNT).forEach((task, index) => slotByTask.set(task.id, index + 1));

    const rows: Row[] = [];
    for (const task of Object.values(tasksBySession).flat()) {
      const project = projectNameById.get(task.session_id) ?? "";
      const match = matchTerms(trimmed, [taskTitle(task), project, task.id]);
      if (!match.matched) continue;
      rows.push({
        kind: "task",
        id: `task:${task.id}`,
        task,
        project,
        slot: slotByTask.get(task.id) ?? null,
        score: match.score,
      });
    }
    const stamp = (task: Task): number => Date.parse(task.updated_at || task.created_at) || 0;
    rows.sort((a, b) => {
      if (a.kind !== "task" || b.kind !== "task") return 0;
      if (trimmed && a.score !== b.score) return b.score - a.score;
      return stamp(b.task) - stamp(a.task);
    });
    return rows.slice(0, trimmed ? QUERY_ROWS : IDLE_ROWS);
  }, [projectNameById, selectedSessionId, tasksBySession, trimmed]);

  // A miss in what is loaded is not a miss. Any project with another page,
  // or one whose list has not been fetched, gets a row that fetches it.
  const loadRows = useMemo<Row[]>(() => {
    if (!trimmed) return [];
    const rows: Row[] = [];
    for (const session of sessions) {
      const page = taskPagesBySession[session.id];
      const freshness = taskListFreshnessBySession[session.id];
      if (page?.nextCursor) {
        rows.push({
          kind: "load",
          id: `load:${session.id}`,
          label: `Load more tasks in ${session.title}`,
          run: () => { void loadMoreTasks(session.id); },
        });
      } else if (freshness?.status !== "ready") {
        const verb = freshness?.status === "error" || freshness?.status === "stale" ? "Retry" : "Load";
        rows.push({
          kind: "load",
          id: `load:${session.id}`,
          label: `${verb} tasks in ${session.title}`,
          run: () => { void refreshTasks(session.id); },
        });
      }
    }
    return rows;
  }, [loadMoreTasks, refreshTasks, sessions, taskListFreshnessBySession, taskPagesBySession, trimmed]);

  const actionRows = useMemo<Row[]>(() => {
    const all: Row[] = [
      { kind: "action", id: "action:new", label: "New task", icon: <SquarePen size={15} strokeWidth={1.6} aria-hidden />, hint: shortcutDisplay(FIXED_SHORTCUTS.newTask), run: onNewTask },
      { kind: "action", id: "action:open", label: "Open project", icon: <FolderOpen size={15} strokeWidth={1.6} aria-hidden />, hint: shortcutDisplay(FIXED_SHORTCUTS.openProject), run: onOpenProject },
      { kind: "action", id: "action:board", label: "Kanban", icon: <Columns3 size={15} strokeWidth={1.6} aria-hidden />, run: onOpenBoard },
      { kind: "action", id: "action:commands", label: "Commands", icon: <Terminal size={15} strokeWidth={1.6} aria-hidden />, hint: shortcutDisplay(FIXED_SHORTCUTS.commandPalette), run: onOpenCommands },
    ];
    if (!trimmed) return all;
    return all.filter((row) => row.kind === "action" && matchTerms(trimmed, [row.label]).matched);
  }, [onNewTask, onOpenBoard, onOpenCommands, onOpenProject, trimmed]);

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    if (taskRows.length > 0) out.push({ title: trimmed ? "Tasks" : "Recent", rows: taskRows });
    if (loadRows.length > 0) out.push({ title: "More", rows: loadRows });
    if (actionRows.length > 0) out.push({ title: "Quick actions", rows: actionRows });
    return out;
  }, [actionRows, loadRows, taskRows, trimmed]);
  const flat = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

  useEffect(() => { setSelectedIndex(0); }, [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-ts-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const activate = useCallback((row: Row | undefined): void => {
    if (!row) return;
    // Loading a page keeps the search open: the point is to see the result.
    if (row.kind === "load") {
      row.run();
      return;
    }
    onClose();
    window.setTimeout(() => {
      if (row.kind === "task") onSelectTask(row.task.id);
      else row.run();
    }, 0);
  }, [onClose, onSelectTask]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (!dialogRef.current?.contains(document.activeElement)) return;
      if (isComposingKeyboardEvent(event)) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((index) => Math.min(flat.length - 1, index + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(0, index - 1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        activate(flat[selectedIndex]);
      } else if (event.key === "Home") {
        event.preventDefault();
        setSelectedIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setSelectedIndex(Math.max(0, flat.length - 1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activate, dialogRef, flat, open, selectedIndex]);

  if (!open) return <></>;

  let flatIndex = -1;

  return (
    <DialogSurface
      ref={dialogRef}
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      onEscapeKeyDown={(event) => { if (isComposingKeyboardEvent(event)) event.preventDefault(); }}
      accessibleTitle="Search tasks"
      tabIndex={-1}
      overlayClassName="task-search-overlay bg-black/20"
      className="task-search fixed left-1/2 top-[16vh] flex max-h-[62vh] w-full -translate-x-1/2 flex-col overflow-hidden rounded-[14px] text-primary"
      style={{ width: "min(620px, calc(100vw - 48px))" }}
    >
      <div className="task-search-field flex h-[50px] flex-none items-center gap-3 px-4">
        <Search size={18} strokeWidth={1.8} className="flex-none text-tertiary" aria-hidden />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tasks"
          role="combobox"
          aria-label="Search tasks"
          aria-controls="task-search-results"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-activedescendant={flat[selectedIndex] ? `task-search-option-${selectedIndex}` : undefined}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-primary outline-none placeholder:text-tertiary"
          style={{ fontSize: "17px", lineHeight: 1.4, fontWeight: 400, letterSpacing: "-0.005em" }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div
        id="task-search-results"
        ref={listRef}
        role="listbox"
        aria-label="Tasks and actions"
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-1.5 pt-1"
      >
        {flat.length === 0 ? (
          <div className="ui-body px-3 py-8 text-center text-tertiary">
            No tasks match “{trimmed}”.
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.title} className="pb-1">
              <div className="select-none px-3 pb-0.5 pt-2 text-[11px] font-medium text-tertiary">{section.title}</div>
              {section.rows.map((row) => {
                flatIndex++;
                const index = flatIndex;
                return (
                  <SearchRow
                    key={row.id}
                    row={row}
                    index={index}
                    selected={index === selectedIndex}
                    onHover={setSelectedIndex}
                    onActivate={activate}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="task-search-footer flex h-8 flex-none items-center gap-4 px-4 text-tertiary">
        <span className="flex items-center gap-1.5 text-xs"><Kbd>↵</Kbd> Open</span>
        <span className="flex items-center gap-1.5 text-xs"><Kbd>↑↓</Kbd> Navigate</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs"><Kbd>esc</Kbd> Close</span>
      </div>
    </DialogSurface>
  );
}

/**
 * One row, memoized: forty rows re-rendering because the selection moved by
 * one is the difference between arrow keys that feel attached to the hand
 * and ones that lag it.
 */
const SearchRow = memo(function SearchRow({
  row,
  index,
  selected,
  onHover,
  onActivate,
}: {
  row: Row;
  index: number;
  selected: boolean;
  onHover: (index: number) => void;
  onActivate: (row: Row) => void;
}): JSX.Element {
  return (
    <div
      id={`task-search-option-${index}`}
      role="option"
      aria-selected={selected}
      data-ts-index={index}
      onMouseMove={() => { if (!selected) onHover(index); }}
      onClick={() => onActivate(row)}
      className={cn(
        "task-search-row flex h-[34px] cursor-default items-center gap-2.5 rounded-[9px] px-3 text-base",
        "bg-transparent",
      )}
    >
      {row.kind === "action" ? (
        <span className="flex w-5 flex-none items-center justify-center text-secondary" aria-hidden>
          {row.icon}
        </span>
      ) : (
        <span className="w-2 flex-none" aria-hidden />
      )}
      <span className={cn("min-w-0 flex-1 truncate", row.kind === "load" ? "text-secondary" : "text-primary")}>
        {row.kind === "task" ? taskTitle(row.task) : row.label}
      </span>
      {row.kind === "task" && row.project ? (
        <span className="max-w-[38%] flex-none truncate text-sm text-tertiary">{row.project}</span>
      ) : null}
      {row.kind === "task" && row.slot !== null ? (
        <Kbd className="w-7 flex-none justify-end text-[11px]">⌘{row.slot}</Kbd>
      ) : null}
      {row.kind === "action" && row.hint ? <Kbd className="w-7 flex-none justify-end">{row.hint}</Kbd> : null}
    </div>
  );
});

export const TaskSearch = memo(TaskSearchImpl);
