import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  CircleDot,
  Columns3,
  Ellipsis,
  List,
  Pause,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent,
} from "react";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../hooks/use-logical-mutation";
import { useTerminusStore } from "../hooks/use-terminus";
import { useThemeStore } from "../hooks/use-theme";
import { useDialogFocus } from "../hooks/use-dialog-focus";
import { arpV2, subscribeEventsV2 } from "../lib/api-v2";
import { cn } from "../lib/cn";
import {
  MISSION_BOARD_COLUMNS,
  attentionReason,
  attentionTone,
  boardColumnForStatus,
  boardColumnForTaskPlacement,
  boardLifecycle,
  boardTransitionForDrop,
  directTaskActions,
  pendingQuestionFor,
  taskEvidence,
  taskStatusLabel,
  type AttentionReason,
  type MissionBoardColumnId,
} from "../lib/mission-board";
import {
  readMissionBoardPreferences,
  writeMissionBoardPreferences,
  type MissionBoardPreferences,
  type MissionBoardStatusFilter,
} from "../lib/mission-board-prefs";
import type { BudgetTone } from "../lib/task-budget";
import { lifecycleIsActive, lifecycleLabel, lifecycleTone, type TaskLifecycle } from "../lib/task-lifecycle";
import { relativeTimestamp } from "../lib/time";
import { Button } from "../ui/Button";
import { DialogSurface } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { ContextMenu, Menu, type MenuItem } from "../ui/Menu";
import { StatusIndicator } from "./StatusIndicator";
import type {
  MaterialQuestionSnapshot,
  TaskV2Snapshot,
  TaskV2Status,
} from "../types/v2";
import {
  CockpitErrorState,
  CockpitLoadingState,
  StaleDataBanner,
  useCockpitResource,
} from "./Cockpit/CockpitPrimitives";

interface MissionBoardData {
  tasks: TaskV2Snapshot[];
  questions: MaterialQuestionSnapshot[];
}
interface MissionBoardViewProps {
  onOpenTask: (task: TaskV2Snapshot) => void;
  onInspectTask: (task: TaskV2Snapshot) => void;
}

type StreamState = "connecting" | "live" | "reconnecting";

const BOARD_CURSOR_KEY = "terminus-desktop.v2-board-cursor.v1";
const STREAM_REFRESH_DELAY_MS = 120;
const STREAM_RECONNECT_BASE_MS = 500;
const STREAM_RECONNECT_MAX_MS = 8_000;
/**
 * How often the elapsed-time readout on running cards is recomputed. Only
 * armed while something is actually running, so a quiet board holds no timer.
 */
const ELAPSED_TICK_MS = 30_000;
/**
 * Done is the one column that only ever grows. Work finished within the last
 * day is what a person is still deciding about; everything older is history,
 * and history left on the board is the "board overload" that makes the whole
 * surface stop being scannable. It folds rather than disappears.
 */
const DONE_RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;

function readBoardCursor(): string | null {
  try {
    return window.localStorage.getItem(BOARD_CURSOR_KEY);
  } catch {
    return null;
  }
}

function writeBoardCursor(cursor: string): void {
  try {
    window.localStorage.setItem(BOARD_CURSOR_KEY, cursor);
  } catch {
    // Cursor persistence improves replay but does not gate the read-only view.
  }
}

function missionLabel(missionId: string | null): string {
  if (missionId === null) return "General";
  const readable = missionId.replace(/^mission[-_:]?/i, "").replace(/[-_]+/g, " ").trim();
  return readable.length > 0 ? readable.replace(/^\w/, (letter) => letter.toUpperCase()) : missionId;
}

function transitionOutcomeLabel(status: TaskV2Status): string {
  const placement = boardColumnForStatus(status);
  return MISSION_BOARD_COLUMNS.find((column) => column.id === placement)?.label ?? taskStatusLabel(status);
}

/**
 * Hold task snapshot identity steady across refreshes.
 *
 * `arpV2.listTasks()` decodes fresh objects on every poll, so without this
 * every card's `task` prop is a new reference and `memo` never bails out —
 * one SSE frame repaints the whole board. Two snapshots that agree on id,
 * version, status and updatedAt describe the same card, so the earlier object
 * is reused and only genuinely changed cards re-render. Same technique as
 * `useStableList` in hooks/use-terminus.ts, keyed on the fields a card reads.
 */
function useStableTasks(next: readonly TaskV2Snapshot[]): TaskV2Snapshot[] {
  const held = useRef<TaskV2Snapshot[]>([]);
  const heldById = useRef<Map<string, TaskV2Snapshot>>(new Map());
  const merged = next.map((task) => {
    const previous = heldById.current.get(task.id);
    return previous
      && previous.version === task.version
      && previous.status === task.status
      && previous.updatedAt === task.updatedAt
      ? previous
      : task;
  });
  const unchanged = merged.length === held.current.length
    && merged.every((task, index) => held.current[index] === task);
  if (!unchanged) {
    held.current = merged;
    heldById.current = new Map(merged.map((task) => [task.id, task]));
  }
  return held.current;
}

/**
 * The actions a task offers, in the one order they appear everywhere.
 *
 * Shared by the card's overflow trigger, the card's context menu and the list
 * row's context menu, so right-clicking a task cannot offer a different set of
 * things to do than clicking its ⋯ — which is exactly the sort of drift a
 * second hand-written copy produces.
 */
function taskMenuItems({
  task,
  pending,
  onOpen,
  onInspect,
  onTransition,
}: {
  task: TaskV2Snapshot;
  pending: boolean;
  onOpen: (task: TaskV2Snapshot) => void;
  onInspect: (task: TaskV2Snapshot) => void;
  onTransition: (task: TaskV2Snapshot, targetStatus: TaskV2Status, destructive: boolean) => void;
}): MenuItem[] {
  return [
    { id: "open", label: "Open conversation", onSelect: () => onOpen(task) },
    { id: "context", label: "Show context", onSelect: () => onInspect(task) },
    ...directTaskActions(task).map((action) => ({
      id: `transition-${action.targetStatus.toLowerCase()}`,
      label: action.label,
      danger: action.destructive === true,
      disabled: pending,
      onSelect: () => onTransition(task, action.targetStatus, action.destructive === true),
    })),
  ];
}

/**
 * `label` overrides the lifecycle name where something more specific is known
 * — "Policy denied" rather than a second row reading "Needs you" like the
 * eleven above it.
 */
function CardStatus({ lifecycle, needsAttention, label }: { lifecycle: TaskLifecycle; needsAttention: boolean; label?: string }): JSX.Element {
  const tone = lifecycleTone(lifecycle);
  return (
    <span
      className={cn(
        "ui-meta inline-flex h-4 items-center gap-1 font-medium",
        tone === "success" && "text-success",
        tone === "error" && "text-error",
        tone === "warning" && "text-warning",
        // "info" blue is the interaction accent; a task merely being in
        // flight has not earned it. It reads as ordinary secondary text.
        tone === "info" && "text-secondary",
        tone === "neutral" && "text-secondary",
      )}
    >
      {needsAttention ? <CircleDot size={12} aria-hidden /> : lifecycle === "done" ? <Check size={12} aria-hidden /> : null}
      {label ?? lifecycleLabel(lifecycle)}
    </span>
  );
}

/**
 * One board card.
 *
 * Memoised, and given only primitives plus stable callbacks, so a change to
 * one task does not repaint the board. The task snapshots keep their identity
 * across refreshes (see `useStableTasks`), which is what makes the memo bite:
 * an SSE frame that touches one task now re-renders one card instead of all
 * of them.
 *
 * Codex density: hairline border, flat card surface, the mission clamped to
 * three lines, and a single meta line underneath. No badges, no gradients,
 * and no per-card status sentence — the glyph says it in 10px.
 *
 * Both input methods reach everything, and they agree with each other:
 *
 *   click / Space         preview in the side panel
 *   double click / Enter  open the task
 *   right click / ⋯       the same actions menu
 *   drag                  the transitions the state machine admits
 *
 * A click also moves keyboard focus onto the card, so the two never diverge
 * into separate notions of "the current card".
 */
const MissionBoardCard = memo(function MissionBoardCard({
  task,
  lifecycle,
  spaceName,
  attentionLabel,
  attentionDetail,
  attentionSeverity,
  elapsed,
  budgetValue,
  budgetTone,
  selected,
  focused,
  pending,
  onSelect,
  onOpen,
  onInspect,
  onFocusCard,
  registerRef,
  onDragStart,
  onDragEnd,
  onTransition,
}: {
  task: TaskV2Snapshot;
  lifecycle: TaskLifecycle;
  spaceName: string;
  /**
   * The attention reason, flattened to primitives by the parent. Passing the
   * `AttentionReason` object itself would hand every card a fresh prop on each
   * refresh — the reasons are rebuilt from a newly decoded questions array —
   * and defeat the memo the same way an unstable `task` used to.
   */
  attentionLabel: string | null;
  attentionDetail: string | null;
  attentionSeverity: "error" | "warning" | null;
  /** How long the in-flight run has been going, when a run is in flight. */
  elapsed: string | null;
  budgetValue: string | null;
  budgetTone: BudgetTone | null;
  selected: boolean;
  /** The board is one composite widget; exactly one card is tabbable at a time. */
  focused: boolean;
  pending: boolean;
  onSelect: (taskId: string) => void;
  onOpen: (task: TaskV2Snapshot) => void;
  onInspect: (taskId: string) => void;
  onFocusCard: (taskId: string) => void;
  registerRef: (taskId: string, element: HTMLElement | null) => void;
  onDragStart: (task: TaskV2Snapshot, event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onTransition: (task: TaskV2Snapshot, targetStatus: TaskV2Status, destructive: boolean) => void;
}): JSX.Element {
  const actions = directTaskActions(task);
  // Built here rather than inline on the element: React 19 passes `ref` as an
  // ordinary prop, so an inline arrow would be a fresh prop on every parent
  // render and would defeat the memo this whole component is arranged around.
  const setCardRef = useCallback(
    (element: HTMLElement | null) => registerRef(task.id, element),
    [registerRef, task.id],
  );
  // "Running" means a turn is in flight, not that the task exists. The v2
  // status says RUNNING for the whole life of a task.
  const isRunning = lifecycleIsActive(lifecycle);
  const needsAttention = attentionLabel !== null;

  /**
   * A click that landed on one of the card's own controls is that control's,
   * not the card's. Checked by hit-testing the target rather than stopping
   * propagation on each button, because the overflow trigger is a Radix
   * component and swallowing its events breaks the menu it opens.
   */
  const clickedOwnControl = (event: ReactMouseEvent<HTMLElement>): boolean =>
    (event.target as HTMLElement | null)?.closest("button") !== null;

  const handleCardClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (clickedOwnControl(event)) return;
    // Clicking a card is also how the keyboard arrives at it: without this the
    // arrow keys would be dead until the user had tabbed in separately.
    event.currentTarget.focus();
    onSelect(task.id);
  };

  const handleCardDoubleClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (clickedOwnControl(event)) return;
    onOpen(task);
  };
  // One glyph, and only when the card is moving or asking for something. A
  // dot on every card is decoration, and a column of them reads as an alarm
  // panel rather than a board.
  const showGlyph = isRunning || needsAttention;

  const menuItems = taskMenuItems({ task, pending, onOpen, onInspect, onTransition });

  return (
    <ContextMenu items={menuItems}>
      <article
        ref={setCardRef}
        onClick={handleCardClick}
        onDoubleClick={handleCardDoubleClick}
        // Roving tabindex: Tab reaches the board once, arrows move within it.
        // Without this the only keyboard route across a five-column board was to
        // Tab through every title and every overflow trigger in order.
        tabIndex={focused ? 0 : -1}
        onFocus={() => onFocusCard(task.id)}
        draggable={actions.length > 0}
        onDragStart={(event) => onDragStart(task, event)}
        onDragEnd={onDragEnd}
        data-testid={`mission-board-card-${task.id}`}
        data-board-card={task.id}
        className={cn(
          // `board-card` carries the padding so density reaches this surface;
          // the board used to ignore the setting entirely, so compact mode
          // shrank the rail beside it and left the cards alone.
          "board-card group relative flex w-full select-none flex-col gap-2 rounded-md border border-subtle bg-card transition-colors hover:border-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-strong)]",
          // Selection is a neutral fill, never a blue wash.
          selected && "border-default bg-selected",
          pending && "opacity-60",
          // The one place the board spends colour on an edge. A card that owes
          // the human something is findable without reading it.
          attentionSeverity === "error" && "border-l-2 border-l-error",
          attentionSeverity === "warning" && "border-l-2 border-l-warning",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <Button
            variant="bare"
            onClick={() => onOpen(task)}
            aria-label={`Open ${task.contract.mission}`}
            // Reachable by mouse and by name, but not a second tab stop inside a
            // card that is already focusable and already opens on Enter.
            tabIndex={-1}
            className="min-w-0 flex-1"
          >
            <span className="ui-body line-clamp-3 text-primary">{task.contract.mission}</span>
          </Button>
          <div className="flex shrink-0 items-center gap-1">
            {showGlyph ? (
              <StatusIndicator
                status={lifecycle}
                size={10}
                className="mt-0.5"
              />
            ) : null}
            <Menu
              label={`Actions for ${task.contract.mission}`}
              align="end"
              items={menuItems}
              trigger={(
                <IconButton
                  label={`Actions for ${task.contract.mission}`}
                  icon={<Ellipsis size={12} strokeWidth={1.7} aria-hidden />}
                  size="sm"
                  disabled={pending}
                  tabIndex={focused ? 0 : -1}
                  className="h-5 w-5 rounded-sm text-tertiary opacity-0 hover:bg-hover hover:text-primary focus:opacity-100 group-hover:opacity-100"
                />
              )}
            />
          </div>
        </div>

        {/* What the card wants from a human, in its own words. A column of
            identical dots cannot be triaged without opening every card; a
            question, a denied policy and an exhausted budget are three
            different instructions and now read as three different things. */}
        {attentionLabel !== null ? (
          <p className="ui-meta min-w-0">
            <span className={cn("font-medium", attentionSeverity === "error" ? "text-error" : "text-warning")}>
              {attentionLabel}
            </span>
            {attentionDetail !== null ? (
              <span className="text-secondary"> — {attentionDetail}</span>
            ) : null}
          </p>
        ) : null}

        {/* Project, then either how long the run has been going or when the task
            last moved — "5 hours ago" on something that is running right now
            answers a question nobody asked. No branch or pull-request chips:
            Terminus opens neither, and the previous ones were drawn from the
            task status alone, so every card claimed a branch. */}
        <div className="ui-meta flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate">{spaceName}</span>
          <span aria-hidden>&middot;</span>
          <span className="shrink-0">
            {elapsed !== null ? `Running ${elapsed}` : relativeTimestamp(task.updatedAt)}
          </span>
          {budgetValue !== null ? (
            <>
              <span aria-hidden>&middot;</span>
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  budgetTone === "critical" && "text-error",
                  budgetTone === "warning" && "text-warning",
                )}
              >
                {budgetValue}
              </span>
            </>
          ) : null}
        </div>
      </article>
    </ContextMenu>
  );
});

function BoardColumn({
  id,
  label,
  description,
  tasks,
  reasons,
  evidence,
  selectedTaskId,
  focusedTaskId,
  pendingTaskId,
  draggingTask,
  footer,
  projectNameForTask,
  lifecycleFor,
  onSelectTask,
  onOpenTask,
  onInspectTask,
  onFocusCard,
  registerCardRef,
  onTransition,
  onDragStart,
  onDragEnd,
  onDropTask,
}: {
  id: MissionBoardColumnId;
  label: string;
  description: string;
  tasks: TaskV2Snapshot[];
  /** What each task owes a human, resolved once by the parent. */
  reasons: ReadonlyMap<string, AttentionReason>;
  evidence: ReadonlyMap<string, { elapsed: string | null; budgetValue: string | null; budgetTone: BudgetTone | null }>;
  selectedTaskId: string | null;
  focusedTaskId: string | null;
  pendingTaskId: string | null;
  draggingTask: TaskV2Snapshot | null;
  /** Rendered under the cards. Done uses it to unfold finished work. */
  footer?: JSX.Element | null;
  projectNameForTask: (task: TaskV2Snapshot) => string;
  lifecycleFor: (task: TaskV2Snapshot) => TaskLifecycle;
  onSelectTask: (taskId: string) => void;
  onOpenTask: (task: TaskV2Snapshot) => void;
  onInspectTask: (task: TaskV2Snapshot) => void;
  onFocusCard: (taskId: string) => void;
  registerCardRef: (taskId: string, element: HTMLElement | null) => void;
  onTransition: (task: TaskV2Snapshot, targetStatus: TaskV2Status, destructive: boolean) => void;
  onDragStart: (task: TaskV2Snapshot, event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDropTask: (task: TaskV2Snapshot, destination: MissionBoardColumnId) => void;
}): JSX.Element {
  const acceptsDrop = draggingTask !== null && boardTransitionForDrop(draggingTask.status, id) !== null;
  // Human attention is the one resource the board cannot manufacture more of,
  // so the column that spends it is the only one whose count is coloured.
  const isAttentionColumn = id === "needs_you" && tasks.length > 0;

  return (
    <section
      data-testid={`mission-board-column-${id}`}
      aria-labelledby={`mission-board-column-title-${id}`}
      onDragOver={(event) => {
        if (!acceptsDrop) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (draggingTask) onDropTask(draggingTask, id);
      }}
      className={cn(
        "flex min-h-0 flex-col transition-colors",
        acceptsDrop && "rounded-md bg-hover",
      )}
    >
      {/* Name and count, nothing else. The icons and coloured dots that used
          to sit here restated the column label in a second alphabet. */}
      <header className="mb-2 flex h-7 items-center gap-2">
        <h2
          id={`mission-board-column-title-${id}`}
          className={cn("ui-label", isAttentionColumn ? "text-warning" : "text-primary")}
        >
          {label}
        </h2>
        <span className={cn("ui-meta tabular-nums", isAttentionColumn && "font-medium text-warning")}>
          {tasks.length}
        </span>
        <p className="sr-only">{description}</p>
      </header>

      <div className="flex min-h-10 flex-col gap-2.5">
        {tasks.length === 0 ? (
          // An empty column is empty. It used to print its own description as
          // if that were content, so a board with three quiet columns showed
          // three sentences about columns competing with the actual work. The
          // description survives in the header for screen readers. The drop
          // target only appears while a card this column can accept is in
          // flight.
          acceptsDrop ? (
            <div className="ui-meta flex min-h-20 items-center justify-center rounded-md border border-dashed border-strong px-3 text-center">
              Move to {label}
            </div>
          ) : null
        ) : tasks.map((task) => {
          const reason = reasons.get(task.id) ?? null;
          const facts = evidence.get(task.id);
          return (
            <MissionBoardCard
              key={task.id}
              task={task}
              lifecycle={lifecycleFor(task)}
              spaceName={projectNameForTask(task)}
              attentionLabel={reason?.label ?? null}
              attentionDetail={reason?.detail ?? null}
              attentionSeverity={reason === null ? null : attentionTone(reason.kind)}
              elapsed={facts?.elapsed ?? null}
              budgetValue={facts?.budgetValue ?? null}
              budgetTone={facts?.budgetTone ?? null}
              selected={selectedTaskId === task.id}
              focused={focusedTaskId === task.id}
              pending={pendingTaskId === task.id}
              // Passed through unbound: an inline arrow here would give every
              // card a fresh prop each render and defeat the memo above.
              onSelect={onSelectTask}
              onOpen={onOpenTask}
              onInspect={onInspectTask}
              onFocusCard={onFocusCard}
              registerRef={registerCardRef}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onTransition={onTransition}
            />
          );
        })}
        {footer}
      </div>
    </section>
  );
}

function CancelTaskDialog({ task, pending, onCancel, onConfirm }: {
  task: TaskV2Snapshot;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onCancel);
  return (
    <DialogSurface
      ref={dialogRef}
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      accessibleTitle="Cancel this task?"
      tabIndex={-1}
      className="dialog-panel fixed left-1/2 top-1/2 w-[min(360px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-default bg-elevated p-4 shadow-lg"
    >
        <AlertTriangle size={16} className="text-error" aria-hidden />
        <h2 id="cancel-task-title" className="ui-page-title mt-3 text-primary">Cancel this task?</h2>
        <p className="ui-body mt-1.5 text-secondary">Terminus will stop new scheduling for "{task.contract.mission}". Its evidence and history stay available.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>Keep task</Button>
          <Button type="button" variant="danger" onClick={onConfirm} disabled={pending} aria-busy={pending || undefined}>{pending ? "Cancelling…" : "Cancel task"}</Button>
        </div>
    </DialogSurface>
  );
}

export function MissionBoardView({ onOpenTask, onInspectTask }: MissionBoardViewProps): JSX.Element {
  const sessions = useTerminusStore((state) => state.sessions);
  const cancelTask = useTerminusStore((state) => state.cancelTask);
  const density = useThemeStore((state) => state.density);
  /**
   * One selection for the window.
   *
   * The board kept its own `useState`, so clicking a card highlighted nothing
   * in the rail and opening a task from the rail left the board showing no
   * selection at all — two panes listing the same tasks with two different
   * ideas of which one you were looking at. Selecting here is now the same act
   * as selecting there, which is also what lets the shared inspector open.
   */
  const selectedTaskId = useTerminusStore((state) => state.selectedTaskId);
  const selectedSessionId = useTerminusStore((state) => state.selectedSessionId);
  const selectTask = useTerminusStore((state) => state.selectTask);
  // The v2 snapshot cannot say whether a run is in flight; the v1 record and
  // its event tail can.
  const taskById = useTerminusStore((state) => state.taskById);
  const runActivityByTask = useTerminusStore((state) => state.runActivityByTask);
  const load = useCallback(async (signal: AbortSignal): Promise<MissionBoardData> => {
    const [tasks, questions] = await Promise.all([
      arpV2.listTasks(signal),
      arpV2.listMaterialQuestions(undefined, signal),
    ]);
    return { tasks, questions };
  }, []);
  const resource = useCockpitResource(load, "mission-board");
  const mutation = useLogicalMutation("mission-board-transition");
  const streamRef = useRef<ReturnType<typeof subscribeEventsV2> | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  const [initialPreferences] = useState(() => readMissionBoardPreferences(selectedSessionId));
  const [viewMode, setViewMode] = useState(initialPreferences.viewMode);
  const [query, setQuery] = useState(initialPreferences.query);
  /**
   * The board opens on the project the rail is pointing at.
   *
   * It used to open on every task in the workspace while the sidebar beside it
   * was scoped to one repository, so the two panes disagreed about what "your
   * work" meant the moment a second project was open. "All spaces" is still
   * one click away in the chip; it is just no longer the thing you get without
   * asking.
   */
  const [spaceFilter, setSpaceFilter] = useState(initialPreferences.spaceFilter);
  const [statusFilter, setStatusFilter] = useState<MissionBoardStatusFilter>(initialPreferences.statusFilter);
  const [attentionOnly, setAttentionOnly] = useState(initialPreferences.attentionOnly);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(initialPreferences.doneExpanded);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  /**
   * Where a dropped card should sit before the server has said so.
   *
   * Dropping used to leave the card exactly where it was for a network round
   * trip *plus* a refetch — well past the ~100ms at which a direct
   * manipulation stops feeling direct, and the one gesture on this surface
   * most likely to be read as "nothing happened". The card moves on release
   * and reconciles when the real snapshot arrives; `fromVersion` is what tells
   * us it has arrived.
   */
  const [optimisticPlacement, setOptimisticPlacement] = useState<
    Record<string, { status: TaskV2Status; fromVersion: number }>
  >({});
  const [taskPendingCancel, setTaskPendingCancel] = useState<TaskV2Snapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const scrollPositionRef = useRef({
    left: initialPreferences.scrollLeft,
    top: initialPreferences.scrollTop,
  });
  const scrollRestoredRef = useRef(false);
  const preferencesRef = useRef<MissionBoardPreferences>(initialPreferences);
  const registerScrollRoot = useCallback((element: HTMLDivElement | null): void => {
    scrollRootRef.current = element;
    if (element === null || scrollRestoredRef.current) return;
    element.scrollLeft = initialPreferences.scrollLeft;
    element.scrollTop = initialPreferences.scrollTop;
    scrollRestoredRef.current = true;
  }, [initialPreferences.scrollLeft, initialPreferences.scrollTop]);
  const rememberScrollPosition = useCallback((event: ReactUIEvent<HTMLDivElement>): void => {
    scrollPositionRef.current = {
      left: event.currentTarget.scrollLeft,
      top: event.currentTarget.scrollTop,
    };
  }, []);
  const registerCardRef = useCallback((taskId: string, element: HTMLElement | null): void => {
    if (element === null) cardRefs.current.delete(taskId);
    else cardRefs.current.set(taskId, element);
  }, []);

  useEffect(() => {
    const preferences: MissionBoardPreferences = {
      viewMode,
      query,
      spaceFilter,
      statusFilter,
      attentionOnly,
      doneExpanded,
      scrollLeft: scrollPositionRef.current.left,
      scrollTop: scrollPositionRef.current.top,
      selectedSessionId,
    };
    preferencesRef.current = preferences;
    writeMissionBoardPreferences(preferences);
  }, [attentionOnly, doneExpanded, query, selectedSessionId, spaceFilter, statusFilter, viewMode]);

  useEffect(() => () => {
    const root = scrollRootRef.current;
    writeMissionBoardPreferences({
      ...preferencesRef.current,
      scrollLeft: root?.scrollLeft ?? scrollPositionRef.current.left,
      scrollTop: root?.scrollTop ?? scrollPositionRef.current.top,
    });
  }, []);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let reconnectAttempts = 0;

    const scheduleRefresh = (): void => {
      if (refreshTimerRef.current !== null) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        resource.retry();
      }, STREAM_REFRESH_DELAY_MS);
    };

    const connect = (): void => {
      if (generation !== generationRef.current) return;
      const stream = subscribeEventsV2({ cursor: readBoardCursor() });
      streamRef.current = stream;
      stream.addEventListener("open", () => {
        if (generation !== generationRef.current) return;
        reconnectAttempts = 0;
        setStreamState("live");
      });
      stream.addEventListener("message", (event) => {
        if (generation !== generationRef.current) return;
        writeBoardCursor(event.eventId);
        if (event.aggregateType === "task" || event.eventType.startsWith("question.")) {
          scheduleRefresh();
        }
      });
      stream.addEventListener("error", () => {
        if (generation !== generationRef.current || reconnectTimerRef.current !== null) return;
        setStreamState("reconnecting");
        stream.close();
        reconnectAttempts += 1;
        const delay = Math.min(STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempts - 1, 4));
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      });
    };

    connect();
    return () => {
      generationRef.current += 1;
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      refreshTimerRef.current = null;
      reconnectTimerRef.current = null;
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [resource.retry]);

  const tasks = useStableTasks(resource.data?.tasks ?? []);
  const questions = resource.data?.questions ?? [];
  const projectNameForTask = useCallback((task: TaskV2Snapshot): string => {
    const sessionId = task.conversationContext?.sessionId;
    if (!sessionId) return missionLabel(task.missionId);
    return sessions.find((session) => session.id === sessionId)?.title ?? missionLabel(task.missionId);
  }, [sessions]);

  const lifecycleFor = useCallback(
    (task: TaskV2Snapshot): TaskLifecycle =>
      boardLifecycle(task, taskById[task.id], runActivityByTask[task.id] ?? "unknown"),
    [runActivityByTask, taskById],
  );

  const spaceOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const task of tasks) {
      const sessionId = task.conversationContext?.sessionId;
      options.set(sessionId ?? "general", projectNameForTask(task));
    }
    return [...options.entries()]
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([value, label]) => ({ value, label }));
  }, [projectNameForTask, tasks]);

  /**
   * Why each task wants a human, resolved once per data change.
   *
   * This is also the board's own definition of "needs you": a task has a
   * reason exactly when its card belongs in the Needs you column, so the
   * header count, the filter and the column can no longer disagree the way a
   * separate attention predicate let them.
   */
  const reasons = useMemo(() => {
    const resolved = new Map<string, AttentionReason>();
    for (const task of tasks) {
      const reason = attentionReason({
        lifecycle: lifecycleFor(task),
        domainTask: taskById[task.id],
        v2Status: task.status,
        question: pendingQuestionFor(task.id, questions),
      });
      if (reason !== null) resolved.set(task.id, reason);
    }
    return resolved;
  }, [lifecycleFor, questions, taskById, tasks]);
  const attentionCount = reasons.size;

  // A guess is only worth keeping until the truth lands. Any new version of
  // the task — the accepted transition, or a rejection that left it where it
  // was — retires it, so a failed move cannot strand a card in a column the
  // control plane never put it in.
  useEffect(() => {
    setOptimisticPlacement((current) => {
      const ids = Object.keys(current);
      if (ids.length === 0) return current;
      let changed = false;
      const next = { ...current };
      for (const id of ids) {
        const task = tasks.find((candidate) => candidate.id === id);
        if (task === undefined || task.version !== current[id]!.fromVersion) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [tasks]);

  const placementFor = useCallback(
    (task: TaskV2Snapshot): MissionBoardColumnId => {
      const guess = optimisticPlacement[task.id];
      if (guess !== undefined) return boardColumnForStatus(guess.status);
      return boardColumnForTaskPlacement(lifecycleFor(task), reasons.has(task.id));
    },
    [lifecycleFor, optimisticPlacement, reasons],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const visibleTasks = useMemo(() => tasks
    .filter((task) => spaceFilter === "all"
      || (task.conversationContext?.sessionId ?? "general") === spaceFilter)
    .filter((task) => statusFilter === "all" || placementFor(task) === statusFilter)
    .filter((task) => !attentionOnly || reasons.has(task.id))
    .filter((task) => normalizedQuery.length === 0
      || task.contract.mission.toLowerCase().includes(normalizedQuery)
      || task.id.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      // Inside Needs you, cheapest-to-discharge first: a question is one
      // click, a failure is a read. Recency is the wrong order for a column
      // whose whole purpose is to be worked from the top down.
      const leftReason = reasons.get(left.id);
      const rightReason = reasons.get(right.id);
      if (leftReason && rightReason && leftReason.rank !== rightReason.rank) {
        return leftReason.rank - rightReason.rank;
      }
      if (Boolean(leftReason) !== Boolean(rightReason)) return leftReason ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
    }), [attentionOnly, normalizedQuery, placementFor, reasons, spaceFilter, statusFilter, tasks]);

  /**
   * Elapsed time and spend, flattened to primitives for the memoised cards.
   *
   * Rebuilt on every tick, but the values it holds are strings — a card whose
   * elapsed reading has not changed still gets identical props and still bails
   * out of rendering.
   */
  const evidence = useMemo(() => {
    const resolved = new Map<string, { elapsed: string | null; budgetValue: string | null; budgetTone: BudgetTone | null }>();
    for (const task of tasks) {
      const facts = taskEvidence(taskById[task.id], lifecycleFor(task), nowMs);
      resolved.set(task.id, {
        elapsed: facts.elapsed,
        budgetValue: facts.budget?.value ?? null,
        budgetTone: facts.budget?.tone ?? null,
      });
    }
    return resolved;
  }, [lifecycleFor, nowMs, taskById, tasks]);

  // Armed only while a run is actually in flight, so a board full of finished
  // work holds no timer and repaints nothing.
  const hasTimedRun = useMemo(
    () => tasks.some((task) => lifecycleIsActive(lifecycleFor(task))
      && (taskById[task.id]?.active_turn?.started_at ?? null) !== null),
    [lifecycleFor, taskById, tasks],
  );
  useEffect(() => {
    if (!hasTimedRun) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(timer);
  }, [hasTimedRun]);

  const columnTasks = useMemo(() => {
    const grouped = new Map<MissionBoardColumnId, TaskV2Snapshot[]>(
      MISSION_BOARD_COLUMNS.map((column) => [column.id, [] as TaskV2Snapshot[]]),
    );
    for (const task of visibleTasks) grouped.get(placementFor(task))?.push(task);
    return grouped;
  }, [placementFor, visibleTasks]);

  const doneTasks = columnTasks.get("done") ?? [];
  const doneRecent = useMemo(() => doneTasks.filter((task) => {
    const finishedAt = Date.parse(task.completedAt ?? task.updatedAt);
    // An unparseable timestamp is not evidence that the work is old.
    return !Number.isFinite(finishedAt) || nowMs - finishedAt < DONE_RECENT_WINDOW_MS;
  }), [doneTasks, nowMs]);
  const foldedDoneCount = doneTasks.length - doneRecent.length;

  /** Exactly what is on screen, which is also what the arrow keys traverse. */
  const renderedTasks = useMemo(() => {
    const rendered = new Map(columnTasks);
    rendered.set("done", doneExpanded ? doneTasks : doneRecent);
    return rendered;
  }, [columnTasks, doneExpanded, doneRecent, doneTasks]);

  // One tab stop for the whole board. Falls back to the first card so Tab can
  // reach a board the user has not clicked into yet.
  const tabbableTaskId = useMemo(() => {
    const columnIds = MISSION_BOARD_COLUMNS.map((column) => column.id);
    if (focusedTaskId !== null
      && columnIds.some((id) => (renderedTasks.get(id) ?? []).some((task) => task.id === focusedTaskId))) {
      return focusedTaskId;
    }
    for (const id of columnIds) {
      const first = (renderedTasks.get(id) ?? [])[0];
      if (first) return first.id;
    }
    return null;
  }, [focusedTaskId, renderedTasks]);

  /** Stable so the memoised cards keep their props between renders. */
  const selectBoardTask = useCallback((taskId: string): void => selectTask(taskId), [selectTask]);

  const focusCard = useCallback((taskId: string): void => {
    setFocusedTaskId(taskId);
    cardRefs.current.get(taskId)?.focus();
  }, []);

  /**
   * The board as one composite widget: arrows move between cards, Enter opens
   * the task, Space previews it. Only keys landing on a card are handled, so
   * the overflow menu keeps its own Enter and Space.
   */
  const handleBoardKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null;
    if (target === null || !target.hasAttribute("data-board-card")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "Escape") {
      selectTask(null);
      return;
    }

    const columnIds = MISSION_BOARD_COLUMNS.map((column) => column.id);
    const focusedId = target.getAttribute("data-board-card");
    let columnIndex = -1;
    let rowIndex = -1;
    for (let index = 0; index < columnIds.length && columnIndex === -1; index += 1) {
      const row = (renderedTasks.get(columnIds[index]!) ?? []).findIndex((task) => task.id === focusedId);
      if (row !== -1) {
        columnIndex = index;
        rowIndex = row;
      }
    }
    if (columnIndex === -1) return;
    const column = renderedTasks.get(columnIds[columnIndex]!) ?? [];
    const task = column[rowIndex];
    if (task === undefined) return;

    if (event.key === "Enter") {
      event.preventDefault();
      onOpenTask(task);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      selectTask(selectedTaskId === task.id ? null : task.id);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = column[Math.min(column.length - 1, Math.max(0, rowIndex + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) focusCard(next.id);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    // Empty columns are skipped rather than swallowing the keypress: a board
    // with nothing in Working must not make Queued and Needs you unreachable
    // from one another.
    for (let index = columnIndex + step; index >= 0 && index < columnIds.length; index += step) {
      const candidates = renderedTasks.get(columnIds[index]!) ?? [];
      const next = candidates[Math.min(rowIndex, candidates.length - 1)];
      if (next) {
        focusCard(next.id);
        return;
      }
    }
  }, [focusCard, onOpenTask, renderedTasks, selectTask, selectedTaskId]);

  const draggingTask = tasks.find((task) => task.id === draggingTaskId) ?? null;

  const hasActiveFilters = spaceFilter !== "all" || statusFilter !== "all" || attentionOnly || query.length > 0;

  const clearAllFilters = useCallback(() => {
    setQuery("");
    setSpaceFilter("all");
    setStatusFilter("all");
    setAttentionOnly(false);
  }, []);

  const previousSelectedSessionIdRef = useRef(selectedSessionId);
  useEffect(() => {
    if (previousSelectedSessionIdRef.current === selectedSessionId) return;
    previousSelectedSessionIdRef.current = selectedSessionId;
    if (selectedSessionId !== null) setSpaceFilter(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    if (message === null) return;
    const timer = window.setTimeout(() => setMessage(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const requestTransition = useCallback(async (task: TaskV2Snapshot, targetStatus: TaskV2Status): Promise<void> => {
    const signature = JSON.stringify({ taskId: task.id, targetStatus, expectedVersion: task.version });
    let idempotencyKey: string;
    try {
      idempotencyKey = mutation.acquire(signature).key;
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Could not admit the task transition.");
      return;
    }

    setPendingTaskId(task.id);
    setOptimisticPlacement((current) => ({
      ...current,
      [task.id]: { status: targetStatus, fromVersion: task.version },
    }));
    try {
      const updated = await arpV2.transitionTask(task.id, targetStatus, { idempotencyKey }, task.version);
      mutation.settle(idempotencyKey);
      if (targetStatus === "CANCELLED") {
        // transitionTask writes the snapshot and projects the v1 status, but
        // never signals the running loop — without this the agent keeps working
        // on a task the board has already marked cancelled. `cancelTask`, not
        // `stopTask`: stopping interrupts the turn and leaves the task
        // steerable, which is the opposite of what Cancel means here.
        await cancelTask(task.id);
      }
      setMessage(`Moved ${task.contract.mission} to ${transitionOutcomeLabel(updated.status)}.`);
      if (targetStatus === "CANCELLED") {
        if (selectedTaskId === task.id) selectTask(null);
        setTaskPendingCancel(null);
      }
      resource.retry();
    } catch (error: unknown) {
      if (isDefinitiveMutationFailure(error)) mutation.abandon(idempotencyKey);
      // The move did not happen, so the card goes back rather than waiting for
      // a version bump that is never coming.
      setOptimisticPlacement((current) => {
        if (current[task.id] === undefined) return current;
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      const detail = error instanceof Error ? error.message : "Task transition failed";
      setMessage(`Could not update ${task.contract.mission}. ${detail}`);
      resource.retry();
    } finally {
      setPendingTaskId(null);
    }
  }, [cancelTask, mutation, resource, selectTask, selectedTaskId]);

  const chooseTransition = useCallback((task: TaskV2Snapshot, targetStatus: TaskV2Status, destructive: boolean): void => {
    if (destructive) {
      setTaskPendingCancel(task);
      return;
    }
    void requestTransition(task, targetStatus);
  }, [requestTransition]);

  const dropIntoColumn = useCallback((task: TaskV2Snapshot, destination: MissionBoardColumnId): void => {
    setDraggingTaskId(null);
    const targetStatus = boardTransitionForDrop(task.status, destination);
    if (targetStatus === null) {
      setMessage(`${task.contract.mission} cannot move to ${MISSION_BOARD_COLUMNS.find((column) => column.id === destination)?.label ?? destination} from ${taskStatusLabel(task.status)}.`);
      return;
    }
    void requestTransition(task, targetStatus);
  }, [requestTransition]);

  // Stable so the memoised cards keep their props between renders.
  const endDrag = useCallback((): void => setDraggingTaskId(null), []);

  const beginDrag = useCallback((task: TaskV2Snapshot, event: DragEvent<HTMLElement>): void => {
    setDraggingTaskId(task.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", task.id);
    }
  }, []);

  if (resource.status === "loading" && resource.data === null) {
    return <div className="flex h-full items-center justify-center bg-canvas"><CockpitLoadingState label="mission board" /></div>;
  }
  if (resource.status === "error" && resource.error) {
    return <div className="flex h-full items-center justify-center bg-canvas p-6"><CockpitErrorState error={resource.error} retry={resource.retry} /></div>;
  }

  return (
    <section className="flex h-full min-w-0 flex-col overflow-hidden bg-canvas text-primary" aria-labelledby="mission-board-title">
      {/* Top Header: Unified Breadcrumbs, Title, Filters & Primary Controls */}
      <header className="ui-view-header justify-between">
        {/* Left: History Navigation, Title & Filter Pills */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1 overflow-x-auto py-1">
          {/* A green dot that is green whenever nothing is wrong is
              decoration: it spent a permanent pixel telling the user the
              normal case. The stream only speaks up when it has degraded. */}
          <div className="flex items-center gap-2 shrink-0 pr-2 border-r border-subtle">
            <h1 id="mission-board-title" className="ui-page-title text-primary">
              Board
            </h1>
            {streamState !== "live" ? (
              <span className="ui-meta text-warning" role="status">
                {streamState === "connecting" ? "Connecting" : "Reconnecting"}
              </span>
            ) : null}
          </div>

          {/* Filter Pills */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Status Filter Chip */}
            <Menu
              label="Status filter"
              // The ids must be the board's own column ids: the filter compares
              // against `boardColumnForTaskLifecycle`, so "running" and
              // "waiting_for_review" matched nothing and emptied the board.
              items={[
                { id: "all", label: "All statuses", selected: statusFilter === "all", onSelect: () => setStatusFilter("all") },
                ...MISSION_BOARD_COLUMNS.map((column) => ({
                  id: column.id,
                  label: column.label,
                  selected: statusFilter === column.id,
                  onSelect: () => setStatusFilter(column.id),
                })),
              ]}
              trigger={(
                <Button
                  variant="bare"
                  className={cn(
                    "ui-meta flex h-7 items-center gap-1 rounded-md border px-2 transition-colors",
                    statusFilter !== "all"
                      ? "border-default bg-selected text-primary"
                      : "border-subtle text-secondary hover:bg-hover hover:text-primary",
                  )}
                >
                  <span>
                    Status
                    {statusFilter !== "all"
                      ? `: ${MISSION_BOARD_COLUMNS.find((column) => column.id === statusFilter)?.label ?? statusFilter}`
                      : ""}
                  </span>
                  <ChevronDown size={12} aria-hidden />
                </Button>
              )}
            />

            {/* Space Filter Chip */}
            <Menu
              label="Space filter"
              items={[
                { id: "all", label: "All spaces", selected: spaceFilter === "all", onSelect: () => setSpaceFilter("all") },
                ...spaceOptions.map((opt) => ({
                  id: opt.value,
                  label: opt.label,
                  selected: spaceFilter === opt.value,
                  onSelect: () => setSpaceFilter(opt.value),
                })),
              ]}
              trigger={(
                <Button
                  variant="bare"
                  className={cn(
                    "ui-meta flex h-7 items-center gap-1 rounded-md border px-2 transition-colors",
                    spaceFilter !== "all"
                      ? "border-default bg-selected text-primary"
                      : "border-subtle text-secondary hover:bg-hover hover:text-primary",
                  )}
                >
                  {/* The chip names the active space, so a filtered board
                      never leaves the user guessing which one is on. */}
                  <span>
                    Space
                    {spaceFilter !== "all"
                      ? `: ${spaceOptions.find((option) => option.value === spaceFilter)?.label ?? spaceFilter}`
                      : ""}
                  </span>
                  <ChevronDown size={12} aria-hidden />
                </Button>
              )}
            />

            {/* Clear Filters */}
            {hasActiveFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearAllFilters}
                className="ui-meta h-7 px-1.5 hover:text-primary"
              >
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Right: Search, [ Board | List ] View Toggle, Display, Attention, Refresh */}
        <div className="flex items-center gap-2 shrink-0">
          <label className="relative w-44 sm:w-52">
            <Search size={12} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary" />
            <span className="sr-only">Search mission board</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tasks"
              className="ui-input ui-body h-7 w-full rounded-md border border-subtle bg-card pl-8 pr-6 text-primary placeholder:text-tertiary transition-colors"
            />
            {query.length > 0 && (
              <Button
                variant="bare"
                onClick={() => setQuery("")}
                aria-label="Clear search query"
                className="absolute right-2 top-1/2 flex -translate-y-1/2 text-tertiary hover:text-primary"
              >
                <X size={12} aria-hidden />
              </Button>
            )}
          </label>

          {/* Segmented View Switcher [Board | List] */}
          <div className="flex rounded-md border border-subtle bg-elevated p-0.5" role="group" aria-label="Mission board view">
            <Button
              type="button"
              onClick={() => setViewMode("board")}
              aria-label="Board view"
              aria-pressed={viewMode === "board"}
              className={cn("ui-meta flex h-6 items-center gap-1.5 rounded-sm px-2 font-medium transition-colors", viewMode === "board" ? "bg-selected text-primary" : "text-secondary hover:text-primary")}
            >
              <Columns3 size={12} aria-hidden />
              <span>Board</span>
            </Button>
            <Button
              type="button"
              onClick={() => setViewMode("list")}
              aria-label="List view"
              aria-pressed={viewMode === "list"}
              className={cn("ui-meta flex h-6 items-center gap-1.5 rounded-sm px-2 font-medium transition-colors", viewMode === "list" ? "bg-selected text-primary" : "text-secondary hover:text-primary")}
            >
              <List size={12} aria-hidden />
              <span>List</span>
            </Button>
          </div>

          {/* A bare number next to Refresh reads as a diagnostic counter. The
              scarcest thing on this screen is the operator, so the control
              that isolates what is waiting on them says what it is. */}
          {attentionCount > 0 ? (
            <Button
              type="button"
              onClick={() => setAttentionOnly((value) => !value)}
              aria-label={attentionOnly ? "Show all tasks" : `Show only the ${attentionCount} tasks that need you`}
              aria-pressed={attentionOnly}
              className={cn("ui-meta flex h-7 items-center gap-1.5 rounded-md border px-2 font-medium transition-colors", attentionOnly ? "border-warning/30 bg-warning/15 text-warning" : "border-warning/25 text-warning hover:bg-warning/10")}
            >
              <CircleDot size={12} aria-hidden />
              <span>Needs you</span>
              <span className="tabular-nums">{attentionCount}</span>
            </Button>
          ) : null}

          <IconButton label="Refresh board" icon={<RefreshCw size={14} strokeWidth={1.7} aria-hidden />} onClick={resource.retry} disabled={resource.refreshing} size="md" className="h-7 w-7 rounded-md border border-subtle text-tertiary hover:bg-hover hover:text-primary disabled:opacity-50" />
        </div>
      </header>

      {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}

      <div className="flex min-h-0 flex-1">
        <div
          ref={registerScrollRoot}
          onScroll={rememberScrollPosition}
          className="mission-board-scroll min-w-0 flex-1 overflow-auto p-4"
        >
          {visibleTasks.length === 0 ? (
            <div className="flex min-h-full items-center justify-center">
              <div className="max-w-sm text-center" role="status">
                <Columns3 size={18} strokeWidth={1.7} className="mx-auto text-tertiary" aria-hidden />
                <h2 className="ui-section-title mt-3 text-primary">{tasks.length > 0 ? "No matching tasks" : "No tasks yet"}</h2>
                <p className="ui-body mt-1.5 text-secondary">
                  {tasks.length > 0
                    ? "Clear the search, space, or status filter to see more work."
                    : "Tasks you start in Terminus appear here."}
                </p>
                {tasks.length > 0 ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="mt-4"
                    onClick={clearAllFilters}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </div>
            </div>
          ) : viewMode === "board" ? (
            <>
              <div
                data-testid="mission-board-grid"
                // A lane that wraps onto a second row stops being a lane, so the
                // board always lays out one column per stage and lets the
                // container scroll horizontally when they no longer fit.
                className="mission-board-grid grid gap-4 w-full max-w-[1600px]"
                style={{ gridTemplateColumns: `repeat(${MISSION_BOARD_COLUMNS.length}, minmax(200px, 1fr))` }}
                onKeyDown={handleBoardKeyDown}
                aria-label="Task board. Arrow keys move between cards, Enter opens a task, Space previews it."
              >
                {MISSION_BOARD_COLUMNS.map((column) => (
                  <BoardColumn
                    key={column.id}
                    {...column}
                    tasks={renderedTasks.get(column.id) ?? []}
                    reasons={reasons}
                    evidence={evidence}
                    lifecycleFor={lifecycleFor}
                    selectedTaskId={selectedTaskId}
                    focusedTaskId={tabbableTaskId}
                    pendingTaskId={pendingTaskId}
                    draggingTask={draggingTask}
                    footer={column.id === "done" && foldedDoneCount > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDoneExpanded((expanded) => !expanded)}
                        className="ui-meta justify-start px-1 hover:text-primary"
                      >
                        {doneExpanded ? "Hide earlier work" : `${foldedDoneCount} earlier`}
                      </Button>
                    ) : null}
                    projectNameForTask={projectNameForTask}
                    onSelectTask={selectBoardTask}
                    onOpenTask={onOpenTask}
                    onInspectTask={onInspectTask}
                    onFocusCard={setFocusedTaskId}
                    registerCardRef={registerCardRef}
                    onTransition={chooseTransition}
                    onDragStart={beginDrag}
                    onDragEnd={endDrag}
                    onDropTask={dropIntoColumn}
                  />
                ))}
              </div>

              {draggingTask?.status === "RUNNING" ? (
                // These are drop targets, not buttons: they only appear
                // while a running card is in flight, and they answer to
                // `onDrop` alone. They used to be styled as solid buttons,
                // which promised a click that never did anything — the dashed
                // edge says "drop here" instead. The keyboard route to the
                // same two transitions is the card's actions menu.
                <div className="sticky bottom-2 z-10 mx-auto mt-4 flex w-fit items-center gap-1 rounded-lg border border-default bg-elevated p-1 shadow-lg" aria-label="Drop targets for the task being dragged">
                  <div
                    onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }}
                    onDrop={(event) => { event.preventDefault(); setDraggingTaskId(null); void requestTransition(draggingTask, "PAUSED"); }}
                    className="ui-meta flex h-7 min-w-20 items-center justify-center gap-1.5 rounded-md border border-dashed border-warning/40 px-2 font-medium text-warning"
                  >
                    <Pause size={12} aria-hidden /> Pause
                  </div>
                  <div
                    onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }}
                    onDrop={(event) => { event.preventDefault(); setDraggingTaskId(null); setTaskPendingCancel(draggingTask); }}
                    className="ui-meta flex h-7 min-w-20 items-center justify-center gap-1.5 rounded-md border border-dashed border-error/40 px-2 font-medium text-error"
                  >
                    <Archive size={12} aria-hidden /> Cancel
                  </div>
                </div>
              ) : null}

            </>
          ) : (
            <div role="table" aria-label="Board tasks" className="overflow-hidden rounded-md border border-subtle bg-card">
              <div role="row" className="ui-meta mission-board-list-row grid gap-3 border-b border-subtle px-4 py-2">
                <span role="columnheader">Session / Task</span><span role="columnheader">State</span><span role="columnheader" className="mission-board-list-secondary">Space</span><span role="columnheader" className="mission-board-list-secondary">Updated</span>
              </div>
              <div role="rowgroup" className="divide-y divide-subtle">
                {visibleTasks.map((task) => (
                  // Same gestures as a board card: click previews, double click
                  // opens, right click offers the identical actions.
                  <ContextMenu
                    key={task.id}
                    items={taskMenuItems({
                      task,
                      pending: pendingTaskId === task.id,
                      onOpen: onOpenTask,
                      onInspect: onInspectTask,
                      onTransition: chooseTransition,
                    })}
                  >
                    <div
                      role="row"
                      aria-selected={selectedTaskId === task.id}
                      // The row claimed a selected state that nothing could set:
                      // in list mode the quick view was unreachable because only
                      // board cards called onSelectTask.
                      onClick={() => selectBoardTask(task.id)}
                      onDoubleClick={() => onOpenTask(task)}
                      className={cn("ui-body mission-board-list-row grid min-h-10 w-full cursor-default select-none items-center gap-3 px-4 text-left transition-colors hover:bg-hover", selectedTaskId === task.id && "bg-selected")}
                    >
                      <span role="cell" className="min-w-0"><Button type="button" onClick={() => onOpenTask(task)} className="ui-body max-w-full justify-start truncate px-0 text-primary hover:bg-transparent">{task.contract.mission}</Button></span>
                      <span role="cell">
                        <CardStatus
                          lifecycle={lifecycleFor(task)}
                          needsAttention={reasons.has(task.id)}
                          {...(reasons.get(task.id) ? { label: reasons.get(task.id)!.label } : {})}
                        />
                      </span>
                      <span role="cell" className="ui-meta mission-board-list-secondary truncate">{projectNameForTask(task)}</span>
                      <span role="cell" className="ui-meta mission-board-list-secondary">{relativeTimestamp(task.updatedAt)}</span>
                    </div>
                  </ContextMenu>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {message ? (
        <div className="ui-body pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md border border-default bg-elevated px-3 py-1.5 text-primary shadow-md" role="status" aria-live="polite">
          {message}
        </div>
      ) : null}

      {taskPendingCancel ? (
        <CancelTaskDialog
          task={taskPendingCancel}
          pending={pendingTaskId === taskPendingCancel.id}
          onCancel={() => setTaskPendingCancel(null)}
          onConfirm={() => void requestTransition(taskPendingCancel, "CANCELLED")}
        />
      ) : null}
    </section>
  );
}

export default MissionBoardView;
