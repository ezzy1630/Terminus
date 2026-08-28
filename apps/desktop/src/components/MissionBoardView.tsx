import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Columns3,
  List,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../hooks/use-logical-mutation";
import { useTerminusStore } from "../hooks/use-terminus";
import { useDialogFocus } from "../hooks/use-dialog-focus";
import { arpV2, subscribeEventsV2 } from "../lib/api-v2";
import { cn } from "../lib/cn";
import {
  MISSION_BOARD_COLUMNS,
  boardColumnForStatus,
  boardColumnForTaskLifecycle,
  boardLifecycle,
  boardTransitionForDrop,
  directTaskActions,
  taskNeedsAttention,
  taskStatusLabel,
  type MissionBoardColumnId,
} from "../lib/mission-board";
import { lifecycleIsActive, lifecycleLabel, lifecycleTone, type TaskLifecycle } from "../lib/task-lifecycle";
import { relativeTimestamp } from "../lib/time";
import { Button } from "../ui/Button";
import { DialogSurface } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Menu, type MenuItem } from "../ui/Menu";
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
  onInspectTask: (taskId: string) => void;
}

type BoardViewMode = "board" | "list";
type StreamState = "connecting" | "live" | "reconnecting";

const BOARD_CURSOR_KEY = "terminus-desktop.v2-board-cursor.v1";
const STREAM_REFRESH_DELAY_MS = 120;
const STREAM_RECONNECT_BASE_MS = 500;
const STREAM_RECONNECT_MAX_MS = 8_000;

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

function questionForTask(
  taskId: string,
  questions: readonly MaterialQuestionSnapshot[],
): MaterialQuestionSnapshot | null {
  return questions.find((question) => question.taskId === taskId && question.status === "PENDING") ?? null;
}

function CardStatus({ lifecycle, needsAttention }: { lifecycle: TaskLifecycle; needsAttention: boolean }): JSX.Element {
  const tone = lifecycleTone(lifecycle);
  return (
    <span
      className={cn(
        "inline-flex h-4 items-center gap-1 text-xs font-medium",
        tone === "success" && "text-success",
        tone === "error" && "text-error",
        tone === "warning" && "text-warning",
        tone === "info" && "text-info",
        tone === "neutral" && "text-secondary",
      )}
    >
      {needsAttention ? <CircleDot size={10} aria-hidden /> : lifecycle === "done" ? <Check size={10} aria-hidden /> : null}
      {lifecycleLabel(lifecycle)}
    </span>
  );
}

function columnIcon(id: MissionBoardColumnId): JSX.Element {
  switch (id) {
    case "queued":
      return <CircleDashed size={13} className="text-tertiary" aria-hidden />;
    case "working":
      return <Play size={12} className="fill-info text-info" aria-hidden />;
    case "needs_you":
      return <AlertTriangle size={13} className="text-warning" aria-hidden />;
    case "review":
      return <CircleDot size={13} className="text-success" aria-hidden />;
    case "done":
      return <Check size={13} className="text-success" aria-hidden />;
  }
}

function MissionBoardCard({
  task,
  lifecycle,
  spaceName,
  questions,
  selected,
  pending,
  onSelect,
  onOpen,
  onInspect,
  onDragStart,
  onDragEnd,
  onTransition,
}: {
  task: TaskV2Snapshot;
  lifecycle: TaskLifecycle;
  spaceName: string;
  questions: readonly MaterialQuestionSnapshot[];
  selected: boolean;
  pending: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onInspect: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onTransition: (targetStatus: TaskV2Status, destructive: boolean) => void;
}): JSX.Element {
  const attention = taskNeedsAttention(task, questions);
  const pendingQuestion = questionForTask(task.id, questions);
  const actions = directTaskActions(task);
  // "Running" means a turn is in flight, not that the task exists. The v2
  // status says RUNNING for the whole life of a task.
  const isRunning = lifecycleIsActive(lifecycle);
  const isWaitingReview = lifecycle === "review" || lifecycle === "needs_you";
  const hasActiveDot = isRunning || isWaitingReview || attention;

  const menuItems: MenuItem[] = [
    { id: "open", label: "Open conversation", onSelect: onOpen },
    { id: "preview", label: "Quick preview", onSelect },
    { id: "details", label: "View details", onSelect: onInspect },
    ...actions.map((action) => ({
      id: `transition-${action.targetStatus.toLowerCase()}`,
      label: action.label,
      danger: action.destructive === true,
      disabled: pending,
      onSelect: () => onTransition(action.targetStatus, action.destructive === true),
    })),
  ];

  return (
    <article
      draggable={actions.length > 0}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      data-testid={`mission-board-card-${task.id}`}
      className={cn(
        "group relative flex min-h-[104px] w-full flex-col gap-2 rounded-xl border border-default/75 bg-card/75 p-3 shadow-xs transition-all hover:border-strong hover:bg-card hover:shadow-md",
        selected && "border-default ring-1 ring-default bg-selected/40",
        pending && "opacity-60",
      )}
    >
      {/* Top row: Space badge + Blue active indicator dot + Menu */}
      <div className="flex h-5 items-center justify-between gap-1.5">
        <span className="ui-code max-w-[70%] truncate text-tertiary">
          {spaceName}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {hasActiveDot && (
            <span
              className="relative flex h-2 w-2"
              data-tooltip={attention ? "Needs attention" : isRunning ? "Running" : "Waiting for review"}
              aria-label={attention ? "Needs attention" : isRunning ? "Running" : "Waiting for review"}
            >
              <span className={cn(
                "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                attention ? "bg-warning" : "bg-info",
              )} />
              <span className={cn(
                "relative inline-flex rounded-full h-2 w-2",
                attention ? "bg-warning" : "bg-info",
              )} />
            </span>
          )}
          <Menu
            label={`Actions for ${task.contract.mission}`}
            align="end"
            items={menuItems}
            trigger={(
              <IconButton
                label={`Actions for ${task.contract.mission}`}
                icon={<MoreHorizontal size={13} aria-hidden />}
                size="sm"
                disabled={pending}
                className="h-5 w-5 rounded text-tertiary opacity-0 hover:bg-hover hover:text-primary focus:opacity-100 group-hover:opacity-100"
              />
            )}
          />
        </div>
      </div>

      {/* Middle row: Task title with fixed height container */}
      <Button
        variant="bare"
        onClick={onOpen}
        aria-label={`Open ${task.contract.mission}`}
        className="flex min-w-0 items-start"
      >
        <span className="ui-body block line-clamp-2 font-medium text-xs leading-snug text-primary transition-colors group-hover:text-accent">
          {task.contract.mission}
        </span>
      </Button>

      {/* Bottom row: Status phrase, timing, and git/PR indicators */}
      <div className="mt-auto flex h-5 items-center justify-between gap-1.5 border-t border-subtle/40 pt-1.5 text-xs">
        <div className="flex min-w-0 items-center gap-1.5 text-secondary truncate">
          {isRunning ? (
            <span className="flex items-center gap-1 text-info font-medium text-xs">
              <Play size={10} className="fill-info" aria-hidden />
              <span>Working...</span>
            </span>
          ) : pendingQuestion ? (
            <span className="flex items-center gap-1 text-warning font-medium text-xs">
              <CircleDot size={10} aria-hidden />
              <span>Needs input</span>
            </span>
          ) : (
            <span className="text-tertiary text-xs">
              {relativeTimestamp(task.updatedAt)}
            </span>
          )}
        </div>
        {/* No branch or pull-request chips. Terminus opens neither, and the
            previous ones were drawn from the task status alone: every card
            claimed a branch, and "PR ready" meant "verifying". */}
      </div>
    </article>
  );
}

function BoardColumn({
  id,
  label,
  description,
  tasks,
  questions,
  selectedTaskId,
  pendingTaskId,
  draggingTask,
  projectNameForTask,
  lifecycleFor,
  onSelectTask,
  onOpenTask,
  onInspectTask,
  onTransition,
  onDragStart,
  onDragEnd,
  onDropTask,
}: {
  id: MissionBoardColumnId;
  label: string;
  description: string;
  tasks: TaskV2Snapshot[];
  questions: readonly MaterialQuestionSnapshot[];
  selectedTaskId: string | null;
  pendingTaskId: string | null;
  draggingTask: TaskV2Snapshot | null;
  projectNameForTask: (task: TaskV2Snapshot) => string;
  lifecycleFor: (task: TaskV2Snapshot) => TaskLifecycle;
  onSelectTask: (taskId: string) => void;
  onOpenTask: (task: TaskV2Snapshot) => void;
  onInspectTask: (taskId: string) => void;
  onTransition: (task: TaskV2Snapshot, targetStatus: TaskV2Status, destructive: boolean) => void;
  onDragStart: (task: TaskV2Snapshot, event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDropTask: (task: TaskV2Snapshot, destination: MissionBoardColumnId) => void;
}): JSX.Element {
  const acceptsDrop = draggingTask !== null && boardTransitionForDrop(draggingTask.status, id) !== null;

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
        acceptsDrop && "rounded-lg bg-info/5",
      )}
    >
      <header className="mb-2 flex h-8 items-center justify-between">
        <div className="flex items-center gap-1.5">
          {columnIcon(id)}
          <h2 id={`mission-board-column-title-${id}`} className="ui-label font-medium text-primary">
            {label}
          </h2>
          <p className="sr-only">{description}</p>
          <span className="ui-meta ml-1 font-mono text-tertiary tabular-nums">
            {tasks.length}
          </span>
        </div>
      </header>

      <div className="flex min-h-10 flex-col gap-2.5">
        {tasks.length === 0 ? (
          // An empty column is empty. It used to render a 96px dashed box with
          // nothing in it, so a board with three quiet columns showed three
          // large placeholders competing with the work. The drop target only
          // appears while a card that this column can accept is being dragged.
          acceptsDrop ? (
            <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-info bg-info/5 px-3 text-center text-xs text-info">
              Move to {label}
            </div>
          ) : (
            <p className="px-0.5 py-1 text-xs text-tertiary/70">{description}</p>
          )
        ) : tasks.map((task) => (
          <MissionBoardCard
            key={task.id}
            task={task}
            lifecycle={lifecycleFor(task)}
            spaceName={projectNameForTask(task)}
            questions={questions}
            selected={selectedTaskId === task.id}
            pending={pendingTaskId === task.id}
            onSelect={() => onSelectTask(task.id)}
            onOpen={() => onOpenTask(task)}
            onInspect={() => onInspectTask(task.id)}
            onDragStart={(event) => onDragStart(task, event)}
            onDragEnd={onDragEnd}
            onTransition={(targetStatus, destructive) => onTransition(task, targetStatus, destructive)}
          />
        ))}
      </div>
    </section>
  );
}

function TaskQuickView({
  task,
  lifecycle,
  questions,
  pending,
  onClose,
  onOpenTask,
  onInspectTask,
  onTransition,
}: {
  task: TaskV2Snapshot;
  lifecycle: TaskLifecycle;
  questions: readonly MaterialQuestionSnapshot[];
  pending: boolean;
  onClose: () => void;
  onOpenTask: () => void;
  onInspectTask: () => void;
  onTransition: (targetStatus: TaskV2Status, destructive: boolean) => void;
}): JSX.Element {
  const pendingQuestions = questions.filter((question) => question.taskId === task.id && question.status === "PENDING");
  const actions = directTaskActions(task);

  return (
    <aside aria-label="Task quick view" className="panel-enter flex h-full w-[300px] flex-shrink-0 flex-col border-l border-subtle bg-inspector">
      <header className="flex items-start gap-3 px-3 py-3">
        <div className="min-w-0 flex-1">
          <CardStatus lifecycle={lifecycle} needsAttention={taskNeedsAttention(task, questions)} />
          <h2 className="ui-page-title mt-1.5 text-primary">{task.contract.mission}</h2>
        </div>
        <IconButton
          label="Close task quick view"
          icon={<X size={14} aria-hidden />}
          onClick={onClose}
          className="rounded-md text-tertiary hover:bg-hover hover:text-primary"
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {pendingQuestions.length > 0 ? (
          <section className="border-l-2 border-warning/55 py-1 pl-2.5" aria-labelledby="quick-view-attention-title">
            <h3 id="quick-view-attention-title" className="ui-section-title flex items-center gap-1.5 text-warning">
              <CircleDot size={12} aria-hidden /> Needs you
            </h3>
            {pendingQuestions.map((question) => (
              <p key={question.id} className="ui-body mt-1 text-primary">{question.questionText}</p>
            ))}
          </section>
        ) : null}

        {task.contract.acceptance.length > 0 ? (
          <section className="mt-3 border-t border-subtle pt-3">
            <h3 className="ui-section-title text-secondary">Acceptance</h3>
            <div className="mt-1 divide-y divide-[var(--border-subtle)]">
              {task.contract.acceptance.map((criterion) => (
                <div key={criterion.claimId} className="py-2">
                  <p className="ui-body text-primary">{criterion.statement}</p>
                  <p className="ui-meta mt-0.5">{criterion.evidenceRequirement}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <p aria-label="Task context" className="ui-meta mt-3 grid gap-0.5 border-t border-subtle pt-3">
          <span className="truncate">{missionLabel(task.missionId)}</span>
          <span className="capitalize">{task.contract.mode}</span>
          <span>Updated {relativeTimestamp(task.updatedAt)}</span>
        </p>
      </div>

      <footer className="border-t border-subtle p-2.5">
        {actions.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {actions.map((action) => (
              <Button
                key={action.targetStatus}
                type="button"
                disabled={pending}
                onClick={() => onTransition(action.targetStatus, action.destructive === true)}
                variant={action.destructive ? "ghost" : "secondary"}
                size="sm"
                className={cn(action.destructive && "text-error hover:text-error")}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="flex gap-1.5">
          <Button type="button" variant="primary" size="md" onClick={onOpenTask} className="flex-1">Open task</Button>
          <Button type="button" variant="ghost" size="md" onClick={onInspectTask}>Task details</Button>
        </div>
      </footer>
    </aside>
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
        <AlertTriangle size={17} className="text-error" aria-hidden />
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

  const [viewMode, setViewMode] = useState<BoardViewMode>("board");
  const [query, setQuery] = useState("");
  const [spaceFilter, setSpaceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [taskPendingCancel, setTaskPendingCancel] = useState<TaskV2Snapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("connecting");

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

  const tasks = resource.data?.tasks ?? [];
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

  const normalizedQuery = query.trim().toLowerCase();
  const visibleTasks = useMemo(() => tasks
    .filter((task) => spaceFilter === "all"
      || (task.conversationContext?.sessionId ?? "general") === spaceFilter)
    .filter((task) => {
      if (statusFilter === "all") return true;
      return boardColumnForTaskLifecycle(lifecycleFor(task)) === statusFilter;
    })
    .filter((task) => !attentionOnly || taskNeedsAttention(task, questions))
    .filter((task) => normalizedQuery.length === 0
      || task.contract.mission.toLowerCase().includes(normalizedQuery)
      || task.id.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      const attentionDifference = Number(taskNeedsAttention(right, questions)) - Number(taskNeedsAttention(left, questions));
      if (attentionDifference !== 0) return attentionDifference;
      return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
    }), [attentionOnly, lifecycleFor, normalizedQuery, questions, spaceFilter, statusFilter, tasks]);

  const attentionCount = tasks.filter((task) => taskNeedsAttention(task, questions)).length;
  const selectedTask = visibleTasks.find((task) => task.id === selectedTaskId) ?? null;
  const draggingTask = tasks.find((task) => task.id === draggingTaskId) ?? null;

  const hasActiveFilters = spaceFilter !== "all" || statusFilter !== "all" || attentionOnly || query.length > 0;

  const clearAllFilters = useCallback(() => {
    setQuery("");
    setSpaceFilter("all");
    setStatusFilter("all");
    setAttentionOnly(false);
  }, []);

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
        setSelectedTaskId((current) => current === task.id ? null : current);
        setTaskPendingCancel(null);
      }
      resource.retry();
    } catch (error: unknown) {
      if (isDefinitiveMutationFailure(error)) mutation.abandon(idempotencyKey);
      const detail = error instanceof Error ? error.message : "Task transition failed";
      setMessage(`Could not update ${task.contract.mission}. ${detail}`);
      resource.retry();
    } finally {
      setPendingTaskId(null);
    }
  }, [cancelTask, mutation, resource]);

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
          <div className="flex items-center gap-2 shrink-0 pr-2 border-r border-subtle">
            <h1 id="mission-board-title" aria-label="Kanban" className="ui-page-title text-primary">
              Kanban
            </h1>
            <span
              className={cn("h-2 w-2 flex-shrink-0 rounded-full", streamState === "live" ? "bg-success" : "bg-warning")}
              role="status"
              aria-label={streamState === "live" ? "Board updates live" : streamState === "connecting" ? "Board connecting" : "Board reconnecting"}
              data-tooltip={streamState === "live" ? "Live" : streamState === "connecting" ? "Connecting" : "Reconnecting"}
            />
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
                    "flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-normal transition-colors",
                    statusFilter !== "all" ? "border-info/40 bg-info/10 text-info" : "border-default bg-card text-secondary hover:bg-hover hover:text-primary",
                  )}
                >
                  <span>
                    Status
                    {statusFilter !== "all"
                      ? `: ${MISSION_BOARD_COLUMNS.find((column) => column.id === statusFilter)?.label ?? statusFilter}`
                      : ""}
                  </span>
                  <ChevronDown size={10} aria-hidden />
                </Button>
              )}
            />

            {/* Space Filter Chip */}
            <Menu
              label="Space filter"
              items={[
                { id: "all", label: "All spaces", onSelect: () => setSpaceFilter("all") },
                ...spaceOptions.map((opt) => ({
                  id: opt.value,
                  label: opt.label,
                  onSelect: () => setSpaceFilter(opt.value),
                })),
              ]}
              trigger={(
                <Button
                  variant="bare"
                  className={cn(
                    "flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-normal transition-colors",
                    spaceFilter !== "all" ? "border-info/40 bg-info/10 text-info" : "border-default bg-card text-secondary hover:bg-hover hover:text-primary",
                  )}
                >
                  <span>Space</span>
                  <ChevronDown size={10} aria-hidden />
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
                className="h-6 px-1.5 text-xs text-tertiary hover:text-primary"
              >
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Right: Search, [ Board | List ] View Toggle, Display, Attention, Refresh */}
        <div className="flex items-center gap-2 shrink-0">
          <label className="relative w-44 sm:w-52">
            <Search size={13} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary" />
            <span className="sr-only">Search mission board</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions..."
              className="ui-input h-7 w-full rounded-md border border-default bg-card pl-8 pr-6 text-xs text-primary placeholder:text-tertiary focus:border-default transition-colors"
            />
            {query.length > 0 && (
              <Button
                variant="bare"
                onClick={() => setQuery("")}
                aria-label="Clear search query"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-tertiary hover:text-primary text-xs"
              >
                ✕
              </Button>
            )}
          </label>

          {/* Segmented View Switcher [Board | List] */}
          <div className="flex rounded-md bg-subtle p-0.5 border border-default" role="group" aria-label="Mission board view">
            <Button
              type="button"
              onClick={() => setViewMode("board")}
              aria-label="Board view"
              aria-pressed={viewMode === "board"}
              className={cn("flex h-6 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors", viewMode === "board" ? "bg-card text-primary shadow-xs" : "text-secondary hover:text-primary")}
            >
              <Columns3 size={12} aria-hidden />
              <span>Board</span>
            </Button>
            <Button
              type="button"
              onClick={() => setViewMode("list")}
              aria-label="List view"
              aria-pressed={viewMode === "list"}
              className={cn("flex h-6 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors", viewMode === "list" ? "bg-card text-primary shadow-xs" : "text-secondary hover:text-primary")}
            >
              <List size={12} aria-hidden />
              <span>List</span>
            </Button>
          </div>

          {attentionCount > 0 ? (
            <Button
              type="button"
              onClick={() => setAttentionOnly((value) => !value)}
              aria-label={`${attentionCount} tasks need attention`}
              aria-pressed={attentionOnly}
              className={cn("flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium tabular-nums", attentionOnly ? "bg-warning/15 text-warning border border-warning/30" : "border border-default bg-card text-secondary hover:bg-hover hover:text-primary")}
            >
              <CircleDot size={11} aria-hidden />
              <span>{attentionCount}</span>
            </Button>
          ) : null}

          <IconButton label="Refresh mission board" icon={<RefreshCw size={12} aria-hidden />} onClick={resource.retry} disabled={resource.refreshing} size="md" className="h-7 w-7 rounded-md border border-default bg-card text-tertiary hover:bg-hover hover:text-primary disabled:opacity-50" />
        </div>
      </header>

      {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}

      <div className="flex min-h-0 flex-1">
        <div className="mission-board-scroll min-w-0 flex-1 overflow-auto p-4">
          {visibleTasks.length === 0 ? (
            <div className="flex min-h-full items-center justify-center">
              <div className="max-w-sm text-center" role="status">
                <Columns3 size={20} className="mx-auto text-tertiary" aria-hidden />
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
              >
                {MISSION_BOARD_COLUMNS.map((column) => (
                  <BoardColumn
                    key={column.id}
                    {...column}
                    tasks={visibleTasks.filter((task) => boardColumnForTaskLifecycle(lifecycleFor(task)) === column.id)}
                    questions={questions}
                    lifecycleFor={lifecycleFor}
                    selectedTaskId={selectedTaskId}
                    pendingTaskId={pendingTaskId}
                    draggingTask={draggingTask}
                    projectNameForTask={projectNameForTask}
                    onSelectTask={setSelectedTaskId}
                    onOpenTask={onOpenTask}
                    onInspectTask={onInspectTask}
                    onTransition={chooseTransition}
                    onDragStart={beginDrag}
                    onDragEnd={() => setDraggingTaskId(null)}
                    onDropTask={dropIntoColumn}
                  />
                ))}
              </div>

              {draggingTask?.status === "RUNNING" ? (
                <div className="sticky bottom-2 z-10 mx-auto mt-4 flex w-fit items-center gap-1 rounded-lg border border-default bg-elevated p-1 shadow-lg" aria-label="Active task actions">
                  <div
                    onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }}
                    onDrop={(event) => { event.preventDefault(); setDraggingTaskId(null); void requestTransition(draggingTask, "PAUSED"); }}
                    className="flex h-7 min-w-20 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-warning"
                  >
                    <Pause size={13} aria-hidden /> Pause
                  </div>
                  <div
                    onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }}
                    onDrop={(event) => { event.preventDefault(); setDraggingTaskId(null); setTaskPendingCancel(draggingTask); }}
                    className="flex h-7 min-w-20 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-error"
                  >
                    <Archive size={13} aria-hidden /> Cancel
                  </div>
                </div>
              ) : null}

            </>
          ) : (
            <div role="table" aria-label="Mission board tasks" className="overflow-hidden rounded-lg border border-default bg-card">
              <div role="row" className="mission-board-list-row grid gap-3 bg-subtle/50 px-4 py-2 text-xs font-medium text-tertiary border-b border-subtle">
                <span role="columnheader">Session / Task</span><span role="columnheader">State</span><span role="columnheader" className="mission-board-list-secondary">Space</span><span role="columnheader" className="mission-board-list-secondary">Updated</span>
              </div>
              <div role="rowgroup" className="divide-y divide-subtle">
                {visibleTasks.map((task) => (
                  <div key={task.id} role="row" aria-selected={selectedTaskId === task.id} className={cn("mission-board-list-row grid min-h-10 w-full items-center gap-3 px-4 text-left text-xs hover:bg-hover transition-colors", selectedTaskId === task.id && "bg-selected")}>
                    <span role="cell" className="min-w-0"><Button type="button" onClick={() => onOpenTask(task)} className="max-w-full justify-start truncate px-0 text-xs font-medium text-primary hover:text-accent hover:bg-transparent">{task.contract.mission}</Button></span>
                    <span role="cell"><CardStatus lifecycle={lifecycleFor(task)} needsAttention={taskNeedsAttention(task, questions)} /></span>
                    <span role="cell" className="mission-board-list-secondary truncate text-secondary">{projectNameForTask(task)}</span>
                    <span role="cell" className="mission-board-list-secondary text-tertiary">{relativeTimestamp(task.updatedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {selectedTask ? (
          <TaskQuickView
            task={selectedTask}
            lifecycle={lifecycleFor(selectedTask)}
            questions={questions}
            pending={pendingTaskId === selectedTask.id}
            onClose={() => setSelectedTaskId(null)}
            onOpenTask={() => onOpenTask(selectedTask)}
            onInspectTask={() => onInspectTask(selectedTask.id)}
            onTransition={(targetStatus, destructive) => chooseTransition(selectedTask, targetStatus, destructive)}
          />
        ) : null}
      </div>

      {message ? (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md border border-default bg-elevated px-3 py-1.5 text-xs text-primary shadow-md" role="status" aria-live="polite">
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
