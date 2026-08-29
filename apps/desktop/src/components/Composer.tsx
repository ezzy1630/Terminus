/**
 * Terminus Desktop — Composer.
 *
 * Per SPEC §10: "The composer is one intelligent input surface. It
 * remains fully available while work is running."
 *
 * The shape is Codex's: a context strip stating where this work happens, a
 * soft rounded input box overlapping it, and one control row inside the box —
 * what may be added on the left, what it will run as on the right.
 *
 * Always-visible controls:
 *   - Effective access level
 *   - Model and reasoning effort
 *   - Send / steer, and Stop while a run is in flight
 *
 * Per SPEC §10: "Expand vertically within sensible limits" — max
 * 280px spacious / 224px compact (from theme.css).
 *
 * There is still no attachment control, because there is still no attachment
 * API: `DraftAttachments` is a type with nothing behind it. The `+` button
 * offers only the two things this app can actually do to a message — read the
 * clipboard into it, and put a real directory path into it — and does not
 * render at all when the host supports neither.
 *
 * Drafts and keyboard shortcuts remain available. The composer clearly
 * distinguishes send and steer, and keeps Stop as its own control: steering a
 * run and killing it must never be the same click. It remains stable during
 * streaming and never jumps because metadata appeared or disappeared. It
 * matches the reading-column width.
 *
 * Keyboard shortcuts:
 *   Cmd+Enter          → send (or steer if work is running)
 *
 * Per SPEC §25.1: "Composer input must never lag during streaming."
 * The textarea updates local state synchronously. Draft persistence is
 * deferred and generation-guarded so streaming renders cannot revert input.
 * Every control beside it either takes no store subscription (the model
 * popover reads a prop) or is memoized behind stable callbacks, so a keystroke
 * re-renders the textarea and nothing else of consequence.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Clock3,
  FolderOpen,
  Plus,
  RefreshCw,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";
import { cn } from "../lib/cn";
import { api, createIdempotencyKey, TerminusApiError } from "../lib/api";
import {
  draftByteLength,
  MAX_DRAFT_BYTES,
  useTerminusStore,
  useSelectedTask,
  useSelectedTaskEvents,
} from "../hooks/use-terminus";
import { useThemeStore } from "../hooks/use-theme";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../hooks/use-logical-mutation";
import { lifecycleIsTerminal, type TaskLifecycle } from "../lib/task-lifecycle";
import { budgetMetrics, primaryBudgetMetric } from "../lib/task-budget";
import { displayLifecycle, taskRunIsActive } from "../lib/turn-activity";
import type { ComposerSendMode, PermissionProfileId, ReasoningEffort, Task } from "../types";
import { FIXED_SHORTCUTS, matchesShortcut } from "../lib/shortcuts";
import { sessionLatency } from "../lib/session-latency";
import { Button } from "../ui/Button";
import { Menu, type MenuItem } from "../ui/Menu";
import {
  DEFAULT_PERMISSION_PROFILE,
  PERMISSION_PROFILES,
  isKnownPermissionProfile,
  permissionProfileIsCaution,
  permissionProfileLabel,
  resolvePermissionProfile,
} from "../lib/permission-profiles";
import { ModelPicker } from "./ModelPicker";
import { ProjectMenu } from "./ProjectMenu";
import { useModelSelection, type ModelSelectionWriter } from "../lib/models";
import { useModelInventory } from "../hooks/use-model-inventory";

/**
 * How long a queued message may wait before this client stops believing its own
 * view of the run and says so.
 */
export const STALLED_STEER_MS = 30_000;

/** How many discovered model ids to name before the list stops helping. */
const MAX_LISTED_MODELS = 8;

/**
 * Say why a turn was refused, in enough detail to act on.
 *
 * `MODEL_NOT_ADMITTED` is the one worth expanding: the control plane already
 * knows which models *are* admitted and returns them, and "model not admitted"
 * on its own leaves the operator guessing at a list the server is holding.
 */
export function describeTurnFailure(error: unknown): string {
  if (!(error instanceof TerminusApiError)) {
    return error instanceof Error ? error.message : "Couldn't send the request.";
  }
  const envelope = error.envelope;
  if (envelope?.code !== "MODEL_NOT_ADMITTED") return error.message;
  const details = envelope.details ?? {};
  const requested = typeof details.requested_model === "string" ? details.requested_model : null;
  const deployment = typeof details.deployment === "string" ? details.deployment : null;
  const discovered = Array.isArray(details.discovered_models)
    ? details.discovered_models.filter((entry): entry is string => typeof entry === "string")
    : [];
  const head = requested
    ? `${requested} is not admitted${deployment ? ` on ${deployment}` : ""}.`
    : envelope.message;
  if (discovered.length === 0) {
    return `${head} No model has been admitted for this deployment.`;
  }
  const listed = discovered.slice(0, MAX_LISTED_MODELS).join(", ");
  const overflow = discovered.length > MAX_LISTED_MODELS
    ? `, and ${discovered.length - MAX_LISTED_MODELS} more`
    : "";
  return `${head} Available: ${listed}${overflow}.`;
}

interface ComposerProps {
  className?: string;
  onChangeProject?: () => void;
  /**
   * The start surface supplies this so the same composer can turn a fresh
   * objective into a real task.  A selected task continues to use the turn
   * APIs below; there is no second, look-alike input implementation.
   */
  onCreateTask?: (objective: string, routing: TurnRouting) => Promise<void>;
}

/**
 * How a turn should be routed. Carried explicitly rather than re-derived by
 * each caller, so the model the composer *shows* is the model the turn *uses*.
 */
export interface TurnRouting {
  model?: string;
  reasoning_effort?: ReasoningEffort;
  /**
   * The connected account the turn authenticates and bills as. Sent with the
   * model because a bare model id is not a route: two accounts can offer the
   * same one, and the control plane must not choose between them silently.
   */
  provider_account_id?: string;
}

/**
 * Send, or steer?
 *
 * Keyed on the *display* lifecycle, not the stored status. `ACTIVE` is the
 * control plane's steady state, so reading it literally made the button say
 * "Steer" for every task that had ever existed — including one sitting idle
 * with nothing to steer. Only work actually in flight takes a steer.
 */
export function computeSendMode(
  lifecycle: TaskLifecycle | null,
): Extract<ComposerSendMode, "send" | "steer"> {
  if (lifecycle === null) return "send";
  switch (lifecycle) {
    // Alive but doing nothing, never started, or over. All of these open a new
    // exchange rather than redirecting one.
    case "idle":
    case "queued":
    case "unknown":
      return "send";
    default:
      return lifecycleIsTerminal(lifecycle) ? "send" : "steer";
  }
}

/**
 * The `+` menu.
 *
 * Memoized and given only stable callbacks, so the composer's most frequent
 * re-render — a keystroke — does not walk this subtree. It is rendered by the
 * caller only when it has at least one real action to offer.
 */
const ComposerAddMenu = memo(function ComposerAddMenu({ items }: { items: readonly MenuItem[] }): JSX.Element {
  return (
    <Menu
      label="Add to this message"
      items={items}
      side="top"
      align="start"
      trigger={(
        <Button
          type="button"
          variant="bare"
          aria-label="Add to this message"
          data-tooltip="Add to this message"
          className="composer-control flex h-7 w-7 items-center justify-center rounded-full text-tertiary hover:bg-hover hover:text-secondary"
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden />
        </Button>
      )}
    />
  );
});

/**
 * The access level, as a control rather than a readout.
 *
 * It was a static chip: the app showed what a project would let an agent do
 * and gave no way to change it short of the control plane's API. Since the
 * level is the single most consequential thing about a run, it belongs where
 * the run is started.
 *
 * The caution colour is spent only on full access. Auto and Ask are working as
 * asked and are drawn as ordinary chrome; colouring all three would make the
 * one state worth noticing indistinguishable from the two that are not.
 */
const PermissionProfilePicker = memo(function PermissionProfilePicker({
  profile,
  raw,
  onSelect,
}: {
  profile: PermissionProfileId;
  /** Exactly what the session stored, for the tooltip. */
  raw: string;
  onSelect: (next: PermissionProfileId) => void;
}): JSX.Element {
  const label = permissionProfileLabel(profile);
  const caution = permissionProfileIsCaution(profile);
  return (
    <Menu
      label="Change the access level"
      side="top"
      align="start"
      items={PERMISSION_PROFILES.map((entry) => ({
        id: `permission-${entry.id}`,
        label: entry.label,
        detail: entry.description,
        selected: entry.id === profile,
        onSelect: () => onSelect(entry.id),
      }))}
      trigger={(
        <Button
          type="button"
          variant="bare"
          aria-label={`Access level: ${label}. Change the access level`}
          data-tooltip={raw.length > 0
            ? `Access level · ${raw}`
            : `Access level · not set, running as ${profile}`}
          className={cn(
            "composer-control flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-hover",
            caution ? "text-warning" : "text-secondary hover:text-primary",
          )}
        >
          <ShieldAlert size={13} strokeWidth={1.8} aria-hidden className="shrink-0" />
          <span className="truncate">{label}</span>
        </Button>
      )}
    />
  );
});

function ComposerImpl({ className, onCreateTask, onChangeProject }: ComposerProps): JSX.Element {
  const task = useSelectedTask();
  const events = useSelectedTaskEvents();
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const sessions = useTerminusStore((s) => s.sessions);
  const patchSessionDefaults = useTerminusStore((s) => s.patchSessionDefaults);
  const density = useThemeStore((s) => s.density);
  const draftsByTask = useTerminusStore((s) => s.draftsByTask);
  const sessionDraftsByTask = useTerminusStore((s) => s.sessionDraftsByTask);
  const draftPersistenceByTask = useTerminusStore((s) => s.draftPersistenceByTask);
  const draftStorageError = useTerminusStore((s) => s.draftStorageError);
  const setDraft = useTerminusStore((s) => s.setDraft);
  const clearDraft = useTerminusStore((s) => s.clearDraft);
  const retryDraftHydration = useTerminusStore((s) => s.retryDraftHydration);
  const resetDraftStorage = useTerminusStore((s) => s.resetDraftStorage);
  const taskId = task?.id ?? "__new__";
  const refreshTasks = useTerminusStore((s) => s.refreshTasks);
  const refreshTask = useTerminusStore((s) => s.refreshTask);
  const recordStartedTurn = useTerminusStore((s) => s.recordStartedTurn);
  const stopTask = useTerminusStore((s) => s.stopTask);
  const queueSteer = useTerminusStore((s) => s.queueSteer);
  const clearQueuedSteer = useTerminusStore((s) => s.clearQueuedSteer);

  const storedDraft = sessionDraftsByTask[taskId] ?? draftsByTask[taskId] ?? "";

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftWriteVersionRef = useRef(new Map<string, number>());
  const pendingDraftWriteRef = useRef<{ taskId: string; text: string; version: number } | null>(null);
  const draftWriteHandleRef = useRef<{ kind: "idle" | "timeout"; id: number } | null>(null);
  const [localDraft, setLocalDraft] = useState<{ taskId: string; text: string }>(() => ({
    taskId,
    text: storedDraft,
  }));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftInputError, setDraftInputError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const turnMutation = useLogicalMutation(`composer-turn.${taskId}`);
  const stopMutation = useLogicalMutation(`composer-stop.${taskId}`);
  const [stopping, setStopping] = useState(false);
  const draft = localDraft.taskId === taskId ? localDraft.text : storedDraft;
  const draftPersistence = draftPersistenceByTask[taskId];
  // Read by the `+` menu's actions, which must stay stable across keystrokes:
  // closing over `draft` itself would rebuild the menu on every character.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const cancelScheduledDraftWrite = useCallback((): void => {
    const handle = draftWriteHandleRef.current;
    if (!handle) return;
    if (handle.kind === "idle") {
      const idleWindow = window as Window & { cancelIdleCallback?: (id: number) => void };
      idleWindow.cancelIdleCallback?.(handle.id);
    } else {
      window.clearTimeout(handle.id);
    }
    draftWriteHandleRef.current = null;
  }, []);

  const flushPendingDraft = useCallback((): void => {
    cancelScheduledDraftWrite();
    const pending = pendingDraftWriteRef.current;
    pendingDraftWriteRef.current = null;
    if (!pending || draftWriteVersionRef.current.get(pending.taskId) !== pending.version) return;
    setDraft(pending.taskId, pending.text, "composer");
  }, [cancelScheduledDraftWrite, setDraft]);

  const discardPendingDraft = useCallback((): void => {
    cancelScheduledDraftWrite();
    pendingDraftWriteRef.current = null;
  }, [cancelScheduledDraftWrite]);

  // Coalesce bursts into one bounded idle write. Flush synchronously when the
  // task changes, the component unmounts, or the window begins unloading.
  const writeDraft = useCallback((text: string): void => {
    cancelScheduledDraftWrite();
    const version = (draftWriteVersionRef.current.get(taskId) ?? 0) + 1;
    draftWriteVersionRef.current.set(taskId, version);
    pendingDraftWriteRef.current = { taskId, text, version };
    const run = (): void => {
      draftWriteHandleRef.current = null;
      flushPendingDraft();
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    if (idleWindow.requestIdleCallback) {
      draftWriteHandleRef.current = {
        kind: "idle",
        id: idleWindow.requestIdleCallback(run, { timeout: 500 }),
      };
    } else {
      draftWriteHandleRef.current = { kind: "timeout", id: window.setTimeout(run, 120) };
    }
  }, [cancelScheduledDraftWrite, flushPendingDraft, taskId]);

  const taskStatusKind = task ? displayLifecycle(task, events) : null;
  const sendMode = computeSendMode(taskStatusKind);
  const taskTerminal = taskStatusKind !== null && lifecycleIsTerminal(taskStatusKind);
  // Authoritative "is work in flight" — the live event tail where it has said
  // anything, the task snapshot otherwise. Three things read it: Stop, the
  // steer queue, and the send button's wording.
  const runIsActive = taskRunIsActive(task, events);
  const queuedSteer = useTerminusStore((s) => (task ? s.queuedSteerByTask[task.id] ?? null : null));
  const queuedSteerAt = useTerminusStore((s) => (task ? s.queuedSteerAtByTask[task.id] ?? null : null));
  const flushingQueueRef = useRef(false);
  /** The queue has been holding this message longer than anyone should wait. */
  const [queueStalled, setQueueStalled] = useState(false);
  const budgetMetric = useMemo(() => primaryBudgetMetric(task?.budget_ledger), [task?.budget_ledger]);
  const budgetDetail = useMemo(
    () => budgetMetrics(task?.budget_ledger)
      .map((metric) => `${metric.label} ${metric.value}${metric.detail ? ` (${metric.detail})` : ""}`)
      .join(" · "),
    [task?.budget_ledger],
  );
  const isStartSurface = !task && Boolean(onCreateTask);
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === (task?.session_id ?? selectedSessionId)),
    [selectedSessionId, sessions, task?.session_id],
  );
  const modelInventory = useModelInventory();
  // A model choice belongs to the project, not to a global gateway row. The
  // picker seeds from the session's stored default and writes back to it.
  const persistSessionDefaults = useCallback<ModelSelectionWriter>(
    (sessionId, patch) => patchSessionDefaults(sessionId, patch),
    [patchSessionDefaults],
  );
  const modelSelection = useModelSelection(
    modelInventory,
    activeSession ?? null,
    persistSessionDefaults,
  );
  /** What this composer's next turn routes to. */
  const turnRouting: TurnRouting = useMemo(() => ({
    ...(modelSelection.selected ? { model: modelSelection.selected.slug } : {}),
    ...(modelSelection.effort ? { reasoning_effort: modelSelection.effort } : {}),
    // Omitted against a control plane that reported no accounts, which then
    // routes by its own defaults exactly as it did before they existed.
    ...(modelSelection.account ? { provider_account_id: modelSelection.account.id } : {}),
  }), [modelSelection.account, modelSelection.effort, modelSelection.selected]);
  // Effects that send later (a queued steer flushing, a Retry click) must use
  // the choice as it stands at that moment, not the one captured when they were
  // registered.
  const turnRoutingRef = useRef<TurnRouting>(turnRouting);
  turnRoutingRef.current = turnRouting;
  // Auto-resize the textarea up to the max height from the density token.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--composer-max-height") || "280",
      10,
    );
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [draft, density]);

  // Focus the composer when the task changes (SPEC §8: "Opening a new
  // task should focus the composer immediately").
  useEffect(() => {
    setDraftInputError(null);
    setCopyStatus(null);
    textareaRef.current?.focus();
  }, [taskId]);

  useEffect(() => {
    const focusComposer = (): void => textareaRef.current?.focus();
    const replaceDraft = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as unknown;
      if (!detail || typeof detail !== "object" || Array.isArray(detail)) return;
      const replacement = detail as { taskId?: unknown; text?: unknown };
      if (typeof replacement.taskId !== "string" || typeof replacement.text !== "string") return;
      if (replacement.taskId !== taskId) return;
      discardPendingDraft();
      draftWriteVersionRef.current.set(
        replacement.taskId,
        (draftWriteVersionRef.current.get(replacement.taskId) ?? 0) + 1,
      );
      setDraftInputError(null);
      setCopyStatus(null);
      setLocalDraft({ taskId, text: replacement.text });
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener("terminus:focus-composer", focusComposer);
    window.addEventListener("terminus:replace-draft", replaceDraft);
    return () => {
      window.removeEventListener("terminus:focus-composer", focusComposer);
      window.removeEventListener("terminus:replace-draft", replaceDraft);
    };
  }, [discardPendingDraft, taskId]);

  useEffect(() => () => flushPendingDraft(), [flushPendingDraft, taskId]);

  useEffect(() => {
    window.addEventListener("beforeunload", flushPendingDraft);
    return () => window.removeEventListener("beforeunload", flushPendingDraft);
  }, [flushPendingDraft]);

  const onTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const text = e.target.value;
    const bytes = draftByteLength(text);
    if (bytes > MAX_DRAFT_BYTES) {
      setDraftInputError(`Draft limit reached. The latest input was not added because local drafts are limited to ${MAX_DRAFT_BYTES} bytes.`);
      return;
    }
    setDraftInputError(null);
    setCopyStatus(null);
    setLocalDraft({ taskId, text });
    writeDraft(text);
  };

  /**
   * Put text into the draft from somewhere other than the keyboard.
   *
   * Appends rather than replaces — the message being written is the user's,
   * and a menu item is not permission to discard it. Goes through the same
   * byte ceiling as typing, so no path into the draft can exceed what storage
   * will hold.
   */
  const appendToDraft = useCallback((addition: string): void => {
    const trimmed = addition.trim();
    if (trimmed.length === 0) return;
    const current = draftRef.current;
    const next = current.trim().length === 0 ? trimmed : `${current.replace(/\s+$/, "")}\n${trimmed}`;
    if (draftByteLength(next) > MAX_DRAFT_BYTES) {
      setDraftInputError(`Draft limit reached. That was not added because local drafts are limited to ${MAX_DRAFT_BYTES} bytes.`);
      return;
    }
    setDraftInputError(null);
    setCopyStatus(null);
    setLocalDraft({ taskId, text: next });
    writeDraft(next);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [taskId, writeDraft]);

  const pasteFromClipboard = useCallback((): void => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.readText) return;
    void clipboard.readText()
      .then((text) => appendToDraft(text))
      .catch(() => setDraftInputError("Terminus could not read the clipboard. Paste with ⌘V instead."));
  }, [appendToDraft]);

  /**
   * The closest thing to an attachment this app can honestly offer: a real
   * path, chosen from the real filesystem, put into the message as text the
   * agent can then read. It claims nothing about upload, because nothing is
   * uploaded.
   */
  const insertDirectoryPath = useCallback((): void => {
    const pick = window.terminusDesktop?.pickDirectory;
    if (!pick) return;
    void pick()
      .then((path) => { if (path) appendToDraft(path); })
      .catch(() => setDraftInputError("The directory picker could not be opened."));
  }, [appendToDraft]);

  // Capability-gated, so the `+` never offers something the host cannot do —
  // and never renders at all when the host can do neither.
  const addMenuItems: MenuItem[] = useMemo(() => {
    const items: MenuItem[] = [];
    if (typeof navigator.clipboard?.readText === "function") {
      items.push({ id: "composer-add-clipboard", label: "Paste from clipboard", onSelect: pasteFromClipboard });
    }
    if (typeof window.terminusDesktop?.pickDirectory === "function") {
      items.push({ id: "composer-add-path", label: "Insert a folder path…", onSelect: insertDirectoryPath });
    }
    return items;
  }, [insertDirectoryPath, pasteFromClipboard]);

  /**
   * Change the project's access level.
   *
   * `patchSessionDefaults` already applies the new value optimistically and
   * puts the old one back if the control plane refuses, so the chip can never
   * be left claiming a level the server did not accept. All this adds is
   * saying why, through the composer's existing error line.
   */
  const changePermissionProfile = useCallback((next: PermissionProfileId): void => {
    const sessionId = activeSession?.id;
    if (sessionId === undefined) return;
    setError(null);
    void patchSessionDefaults(sessionId, { default_permission_profile: next })
      .catch((err: unknown) => setError(err instanceof Error
        ? `The access level could not be changed: ${err.message}`
        : "The access level could not be changed."));
  }, [activeSession?.id, patchSessionDefaults]);

  const clearCurrentDraft = (): void => {
    discardPendingDraft();
    draftWriteVersionRef.current.set(taskId, (draftWriteVersionRef.current.get(taskId) ?? 0) + 1);
    setLocalDraft({ taskId, text: "" });
    setDraftInputError(null);
    setCopyStatus(null);
    clearDraft(taskId);
  };

  const retryDraftSave = (): void => {
    setDraft(taskId, draft, "composer");
  };

  const copyDraft = async (): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(draft);
      setCopyStatus("Draft copied.");
    } catch {
      setCopyStatus("Draft could not be copied automatically. Select the text and copy it manually.");
    }
  };

  /**
   * Stop the run. `api.cancelTask` is deliberate: it is the only client method
   * that reaches the control plane's `abortActiveTurn`. The v2
   * `transitionTask(..., "CANCELLED")` path used by the board only writes the
   * snapshot and projects the v1 status — the in-flight loop is never signalled
   * and keeps running.
   */
  const onStop = async (): Promise<void> => {
    if (!task || stopping) return;
    setError(null);
    let idempotencyKey: string;
    try {
      idempotencyKey = stopMutation.acquire(JSON.stringify({ taskId: task.id, action: "stop" })).key;
    } catch (admissionError: unknown) {
      setError(admissionError instanceof Error ? admissionError.message : "Could not admit the stop request.");
      return;
    }
    setStopping(true);
    try {
      const failure = await stopTask(task.id);
      if (failure === null) stopMutation.settle(idempotencyKey);
      else {
        stopMutation.abandon(idempotencyKey);
        setError(failure);
      }
    } finally {
      setStopping(false);
    }
  };

  /**
   * Create a turn.
   *
   * The only place that happens, so a queued flush and a direct send cannot
   * drift apart. `retryable` distinguishes losing a race against a turn that
   * started between the activity check and the request — which should stay
   * queued — from a real failure, which should be shown.
   */
  const submitTurn = useCallback(async (
    target: Task,
    text: string,
    routing: TurnRouting,
  ): Promise<{ ok: true } | { ok: false; message: string; retryable: boolean }> => {
    let operationKey: string | null = null;
    let hasDurableStep = false;
    try {
      const admission = turnMutation.acquire(JSON.stringify({ taskId: target.id, text }));
      operationKey = admission.key;
      hasDurableStep = admission.completedSteps.task_started !== undefined;
      // For the very first send on a DRAFT task, start the task.
      // For subsequent sends, this is a steer — the control plane's
      // /v1/turns endpoint creates a new turn in the existing thread.
      if (target.status === "DRAFT" && !hasDurableStep) {
        const started = await api.startTask(target.id, { idempotencyKey: `${operationKey}:start-task` });
        turnMutation.checkpoint(
          operationKey,
          "task_started",
          JSON.stringify({ eventCursor: started.event_cursor }),
        );
        hasDurableStep = true;
      }
      const startedTurn = await api.startTurn({
        thread_id: target.thread_id,
        task_id: target.id,
        user_input: text,
        ...routing,
      }, { idempotencyKey: `${operationKey}:turn` });
      // The successful admission is already authoritative. Publish it to the
      // shared task projection now so Priority updates on this frame instead
      // of waiting for an SSE reconnect or a list response that omits the
      // active turn.
      recordStartedTurn(target.id, startedTurn);
      // R12: open a TTFT sample; the first streamed event for this task
      // closes it (see lib/session-view SessionLatencyTracker).
      sessionLatency.markTurnSubmitted(target.id);
      turnMutation.settle(operationKey);
      void refreshTasks(target.session_id);
      return { ok: true };
    } catch (err) {
      if (operationKey && isDefinitiveMutationFailure(err)) {
        try {
          if (hasDurableStep) {
            await refreshTasks(target.session_id);
            turnMutation.completePartial(operationKey);
          } else {
            turnMutation.abandon(operationKey);
          }
        } catch (recoveryError) {
          return {
            ok: false,
            retryable: false,
            message: recoveryError instanceof Error ? recoveryError.message : "Couldn't recover the saved request.",
          };
        }
      }
      const alreadyActive = err instanceof TerminusApiError
        && err.envelope?.code === "TASK_TURN_ALREADY_ACTIVE";
      return {
        ok: false,
        retryable: alreadyActive,
        message: describeTurnFailure(err),
      };
    }
  }, [recordStartedTurn, refreshTasks, turnMutation]);

  /**
   * Hand a correction to a turn that is already running.
   *
   * A 409 means the turn settled between the render and the click. That is the
   * only case the local queue still exists for: the text is kept and goes out
   * as a fresh turn the moment the task is idle. Every other failure is the
   * user's to see.
   */
  const deliverSteer = useCallback(async (
    target: Task,
    turnId: string,
    text: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      await api.steerTurn(turnId, { message: text }, {
        idempotencyKey: createIdempotencyKey(`steer:${turnId}:${text.length}`),
      });
      void refreshTask(target.id);
      return { ok: true };
    } catch (err: unknown) {
      const settled = err instanceof TerminusApiError && err.status === 409;
      if (settled) {
        queueSteer(target.id, text);
        void refreshTask(target.id);
        return { ok: true };
      }
      return { ok: false, message: describeTurnFailure(err) };
    }
  }, [queueSteer, refreshTask]);

  const onSubmit = async (mode: Extract<ComposerSendMode, "send" | "steer" | "queue">): Promise<void> => {
    setError(null);

    const text = draft.trim();
    if (text.length === 0) return;
    if (taskTerminal) {
      setError("This task is finished. Create a new task to continue working.");
      return;
    }
    try {
      setSending(true);
      if (!task) {
        if (!onCreateTask) {
          setError("Select or create a project before sending.");
          return;
        }
        try {
          await onCreateTask(text, turnRouting);
        } catch (err) {
          // The click handler's promise is not a place to leave a rejection.
          // The draft stays put, so the objective is not lost with it.
          setError(err instanceof Error ? err.message : "Couldn't create the task.");
          return;
        }
        clearCurrentDraft();
        return;
      }
      // During a live run, ordinary Return queues a follow-up. Cmd/Ctrl+Return
      // explicitly steers the active turn. The distinction is user intent,
      // not timing: a task becoming active between keydown and this branch
      // must not silently turn a queued follow-up into an interruption.
      const activeTurn = task.active_turn ?? null;
      if (runIsActive && mode === "queue") {
        queueSteer(task.id, text);
        clearCurrentDraft();
        return;
      }
      if (activeTurn && runIsActive) {
        const outcome = await deliverSteer(task, activeTurn.id, text);
        if (!outcome.ok) {
          setError(outcome.message);
          return;
        }
        clearCurrentDraft();
        return;
      }
      // A run this client can see but whose turn id it does not have — the
      // events arrived before the task detail did. Hold the text rather than
      // open a second turn the control plane would refuse.
      if (runIsActive) {
        queueSteer(task.id, text);
        clearCurrentDraft();
        return;
      }
      const outcome = await submitTurn(task, text, turnRouting);
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      clearCurrentDraft();
    } finally {
      setSending(false);
    }
  };

  /**
   * Send the queued message as soon as the run settles.
   *
   * A message that cannot be sent is never discarded: if the task ended
   * instead of continuing, the banner keeps the text and offers to put it
   * back, rather than an effect silently rewriting what is in the composer.
   */
  useEffect(() => {
    if (queuedSteer === null || !task || taskTerminal || runIsActive) return;
    if (flushingQueueRef.current) return;
    flushingQueueRef.current = true;
    const target = task;
    void (async () => {
      const outcome = await submitTurn(target, queuedSteer, turnRoutingRef.current);
      flushingQueueRef.current = false;
      if (outcome.ok || !outcome.retryable) clearQueuedSteer(target.id);
      if (!outcome.ok && !outcome.retryable) setError(outcome.message);
    })();
  }, [clearQueuedSteer, queuedSteer, runIsActive, submitTurn, task, taskTerminal]);

  /*
   * A queue that stopped draining.
   *
   * The queue only fills when the control plane said the turn had already
   * settled, so it should empty on the next event. If it has not after 30
   * seconds this client's idea of the run is stale: re-read the task, and if
   * that still does not release it, offer to send the message anyway rather
   * than leave the user staring at "Queued".
   */
  useEffect(() => {
    if (queuedSteer === null || queuedSteerAt === null || taskTerminal || !task) {
      setQueueStalled(false);
      return;
    }
    // Keyed on the id, not the task object: `refreshTask` replaces the object
    // on every response, and depending on it would make this effect its own
    // trigger.
    const stalledTaskId = task.id;
    const waited = Date.now() - queuedSteerAt;
    const declareStalled = (): void => {
      setQueueStalled(true);
      void refreshTask(stalledTaskId);
    };
    if (waited >= STALLED_STEER_MS) {
      declareStalled();
      return;
    }
    setQueueStalled(false);
    const timer = window.setTimeout(declareStalled, STALLED_STEER_MS - waited);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedSteer, queuedSteerAt, refreshTask, task?.id, taskTerminal]);

  /** Send a stalled queued message as its own turn, on the user's say-so. */
  const sendQueuedNow = useCallback((): void => {
    if (!task || queuedSteer === null) return;
    const target = task;
    const text = queuedSteer;
    setError(null);
    setSending(true);
    void submitTurn(target, text, turnRoutingRef.current)
      .then((outcome) => {
        if (outcome.ok) clearQueuedSteer(target.id);
        else setError(outcome.message);
      })
      .finally(() => setSending(false));
  }, [clearQueuedSteer, queuedSteer, submitTurn, task]);

  /*
   * Resend a failed turn's prompt, from the Retry button in the transcript.
   *
   * The conversation asks; the composer sends. There is exactly one
   * `POST /v1/turns` call site in this app and this keeps it that way, so a
   * retry gets the same idempotency ledger and the same failure reporting as
   * anything the user types.
   */
  useEffect(() => {
    const onRetryTurn = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as unknown;
      if (!detail || typeof detail !== "object" || Array.isArray(detail)) return;
      const request = detail as { taskId?: unknown; text?: unknown };
      if (typeof request.taskId !== "string" || typeof request.text !== "string") return;
      const target = useTerminusStore.getState().taskById[request.taskId];
      if (!target || request.taskId !== taskId) return;
      const text = request.text.trim();
      if (text.length === 0) return;
      setError(null);
      setSending(true);
      void submitTurn(target, text, turnRoutingRef.current)
        .then((outcome) => {
          if (!outcome.ok) setError(outcome.message);
        })
        .finally(() => setSending(false));
    };
    window.addEventListener("terminus:retry-turn", onRetryTurn);
    return () => window.removeEventListener("terminus:retry-turn", onRetryTurn);
  }, [submitTurn, taskId]);

  /*
   * Composer keys.
   *
   *   ↵          send, or queue behind a running turn
   *   ⇧↵         newline
   *   ⌘↵ / ⌃↵    steer the running turn (send when idle)
   *
   * The IME guard comes first and covers both spellings. While a Japanese,
   * Chinese or Korean input method has an active composition, Return commits
   * the candidate: `isComposing` reports that, and Safari/WebKit reports the
   * legacy `keyCode === 229` instead. Calling `preventDefault` in either case
   * would eat the commit and send a half-typed word.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (matchesShortcut(e, FIXED_SHORTCUTS.sendPlain)) {
      e.preventDefault();
      void onSubmit(runIsActive ? "queue" : "send");
      return;
    }
    if (matchesShortcut(e, FIXED_SHORTCUTS.send)) {
      e.preventDefault();
      void onSubmit(runIsActive ? "steer" : "send");
    }
  };

  // Send button content varies by mode. While a run is in flight the button
  // says what will actually happen — the message reaches the running turn when
  // this client knows which turn that is, and is held when it does not.
  const sendButtonContent: { icon: JSX.Element; label: string; mode: Extract<ComposerSendMode, "send" | "steer" | "queue"> } = (() => {
    if (!task && onCreateTask) {
      return { icon: <ArrowUp size={15} strokeWidth={2} />, label: "Create task", mode: "send" };
    }
    if (runIsActive) {
      return { icon: <Clock3 size={14} strokeWidth={2} />, label: "Queue for the current run", mode: "queue" };
    }
    switch (sendMode) {
      case "steer":
        return { icon: <ArrowUp size={15} strokeWidth={2} />, label: "Steer", mode: "steer" };
      case "send":
      default:
        return { icon: <ArrowUp size={15} strokeWidth={2} />, label: "Send", mode: "send" };
    }
  })();

  // Stop is offered only while there is a run to stop. It is a separate
  // control rather than a mode of the send button, so steering and stopping
  // are never the same click — Codex can merge them because Codex has nothing
  // to steer into. `hasStartedTurn` was the old test and it stayed true
  // forever once any turn had ever started, so the button outlived the work it
  // claimed to stop.
  const canStop = Boolean(task) && !taskTerminal && runIsActive;

  // The access level belongs to the project, so it is shown and changed on
  // both surfaces. A legacy id (`secure-local-default`) or anything this
  // client does not recognise resolves to the level the control plane would
  // itself apply, and the tooltip keeps the raw value so the label can always
  // be checked against what is actually stored.
  const storedPermission = activeSession?.default_permission_profile?.trim() ?? "";
  const permissionProfileId = resolvePermissionProfile(storedPermission);
  // With no project selected there is nothing to read a level from and nothing
  // to write one to, so the chip stays away rather than claiming a level on
  // behalf of a session that does not exist.
  const showPermission = activeSession !== undefined;

  // The start surface always offers the switcher, even with nothing selected —
  // with no project there is no task to create, so "Choose project" is the
  // most useful thing the strip can say. A task's project is fixed and already
  // named in the chrome above the transcript, so the strip is start-only and
  // the chat view's Environment panel states where that work runs.
  const projectName = activeSession?.title ?? null;
  // Send is not gated on the health probe. `/v1/system/health` reports writer
  // state and stops answering while a turn holds the writer lease, so gating on
  // it disabled the composer during exactly the runs the user most wants to
  // steer — and it made this client, not the control plane, the one refusing.
  // The request goes out; if it fails, the real HTTP error is what is shown.
  // Discovery can be stale while the stored route is still healthy. Keep the
  // exact selected slug on the request and let the control plane report the
  // real routing result instead of silently choosing a replacement here.
  const sendDisabled = sending || draft.trim().length === 0 || taskTerminal;
  // Filled while a send is in flight as well as while one is possible, so the
  // circle does not blink from accent to ghost for the duration of the request.
  const sendLooksReady = !taskTerminal && (sending || draft.trim().length > 0);
  const sendTitle = taskTerminal
    ? "Task is terminal; create a new task to continue"
    : runIsActive
      ? "Queue after this run · ↵ · Steer now with ⌘↵"
      : `${sendButtonContent.label} · ↵`;

  return (
    <div className={cn("relative", className)}>
      {/* Reading-column-width container — matches Conversation. */}
      <div className={isStartSurface ? "start-column" : "content-column"}>
        {/* Context strip. An attached tab the input box overlaps, stating
            where this work happens before stating what it is. Only facts this
            client actually holds appear here: there is no branch chip because
            no route, event or preload call reports the workspace's branch, and
            a chip that always said "main" would be decoration, not data. */}
        {isStartSurface ? (
          <div className="flex h-8 items-center gap-3 rounded-t-xl bg-elevated pb-1.5 pl-3 pr-3 text-xs text-secondary">
            {/* The same switcher as the sidebar header and the title bar. */}
            <ProjectMenu
              label="Change project"
              side="top"
              {...(onChangeProject ? { onOpenProject: onChangeProject } : {})}
              trigger={(
                <Button
                  type="button"
                  variant="bare"
                  className="composer-control -mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1 hover:text-primary"
                  aria-label="Change project"
                >
                  <FolderOpen size={13} strokeWidth={1.7} aria-hidden className="shrink-0 text-tertiary" />
                  <span className="max-w-40 truncate">{projectName ?? "Choose project"}</span>
                </Button>
              )}
            />
          </div>
        ) : null}

        <div
          /* The border lives in .composer-surface, not in a utility: Tailwind's
             utilities layer outranks the components layer, so a `border-default`
             class here silently won over the focus rule and the composer's
             focused state showed no border change at all.

             The 16px radius is the one soft corner in the app. Everything else
             is ≤12px; this is the surface you type into and it is allowed to
             read as a physical field. `-mt-1.5` laps it over the context tab. */
          className="composer-surface relative z-[1] -mt-1.5 flex flex-col rounded-2xl bg-composer"
        >
          {/* Textarea. */}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={onTextareaChange}
            onBlur={flushPendingDraft}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={task ? "Reply or steer…" : isStartSurface ? "Do anything" : "Describe what you want to build…"}
            aria-label="Message composer"
            role="textbox"
            aria-multiline="true"
            spellCheck={false}
            data-gramm="false"
            data-gramm_editor="false"
            className={cn(
              "selectable ui-prose min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 text-primary placeholder:text-tertiary",
              "font-sans focus:outline-none",
            )}
            style={{ maxHeight: "var(--composer-max-height)", caretColor: "var(--text-primary)" }}
          />

          {/* No model, no turn. The picker used to hide itself when the
              inventory was empty, so the composer looked ready and the send
              failed at the control plane instead. */}
          {modelInventory.status !== "loading" && !modelSelection.selectedAvailable ? (
            <div
              role="status"
              aria-live="polite"
              className="mx-3 mb-1 flex min-h-7 items-center gap-2 border-t border-subtle pt-1.5 text-xs text-secondary"
            >
              <span className="min-w-0 flex-1 truncate">
                {modelSelection.selected
                  ? `${modelSelection.selected.label} is unavailable`
                  : "No model available"}
              </span>
              <Button
                type="button"
                variant="bare"
                className="h-6 shrink-0 rounded-md px-1.5 text-secondary hover:bg-hover hover:text-primary"
                onClick={() => window.dispatchEvent(
                  new CustomEvent("terminus:open-settings", { detail: { category: "agents" } }),
                )}
              >
                Set up models
              </Button>
              <Button
                type="button"
                variant="bare"
                aria-label="Check models again"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
                onClick={() => modelInventory.refresh()}
              >
                <RefreshCw size={12} aria-hidden />
              </Button>
            </div>
          ) : null}

          {/* Control row — always visible. Reserved height so metadata
              appearing/disappearing never causes layout shift (SPEC §10). */}
          <div className="composer-controls flex min-h-9 items-center gap-1 px-2 pb-2">
            {addMenuItems.length > 0 ? <ComposerAddMenu items={addMenuItems} /> : null}

            {showPermission ? (
              <PermissionProfilePicker
                profile={permissionProfileId}
                raw={storedPermission}
                onSelect={changePermissionProfile}
              />
            ) : null}

            {/* Right side — what this turn runs as, then what to do with it.
                Spend moved into the model popover's footer: it is a figure to
                consult, and the control row is for things that get clicked. */}
            <div className="ml-auto flex items-center gap-1.5">
              <ModelPicker
                selection={modelSelection}
                {...(budgetMetric ? { meta: `${budgetMetric.label} ${budgetMetric.value}` } : {})}
                {...(budgetDetail ? { metaDetail: budgetDetail } : {})}
              />

              {canStop ? (
                <Button
                  type="button"
                  onClick={() => void onStop()}
                  disabled={stopping}
                  aria-label="Stop"
                  data-tooltip={stopping ? "Stopping…" : "Stop this run · ⌘."}
                  variant="secondary"
                  className="stop-control flex h-7 w-7 items-center justify-center rounded-full px-0"
                >
                  <Square size={10} strokeWidth={2.5} fill="currentColor" aria-hidden />
                  <span className="sr-only">Stop</span>
                </Button>
              ) : null}

              <Button
                type="button"
                onClick={() => void onSubmit(sendButtonContent.mode)}
                disabled={sendDisabled}
                aria-label={sendButtonContent.label}
                data-tooltip={sendTitle}
                variant={sendLooksReady ? "primary" : "ghost"}
                className="send-control flex h-7 w-7 items-center justify-center rounded-full px-0"
              >
                {sending
                  ? <span className="spinner border-current/30 border-t-current" aria-hidden />
                  : sendButtonContent.icon}
                <span className="sr-only">{sendButtonContent.label}</span>
              </Button>
            </div>
          </div>
        </div>

        {/* Send failures wrap in full.

            This used to be a 12rem truncating span wedged between the budget
            meter and the send button, so "Terminus could not reach the
            provider: connect ECONNREFUSED 127.0.0.1:4317" rendered as
            "Terminus could not rea…" and the actual cause was only in a
            tooltip. Errors here are the reason the message did not send; they
            get the width. */}
        {error ? (
          <div
            key={error}
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            className="mt-2 flex items-start gap-2 px-1 text-xs text-error"
          >
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</span>
            <Button
              type="button"
              onClick={() => setError(null)}
              aria-label="Dismiss the error"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
            >
              <X size={12} aria-hidden />
            </Button>
          </div>
        ) : null}

        {queuedSteer !== null && task ? (
          <div
            role="status"
            className={cn(
              "mt-2 flex flex-wrap items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs",
              taskTerminal ? "border-warning/45 text-warning" : "border-subtle text-secondary",
            )}
          >
            <Clock3 size={12} strokeWidth={1.8} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-primary">
                {taskTerminal
                  ? "Not sent — the task finished first."
                  : queueStalled ? "Still waiting." : "Queued."}
              </span>{" "}
              {taskTerminal
                ? "Put it back in the composer to send it somewhere else."
                : queueStalled
                  ? "The run has not released it. Send it as its own turn, or put it back."
                  : "The run had already ended, so this goes as a new turn."}
              <span className="mt-0.5 block truncate text-tertiary">{queuedSteer}</span>
            </span>
            {!taskTerminal && queueStalled ? (
              <Button
                type="button"
                onClick={sendQueuedNow}
                disabled={sending}
                className="font-medium text-primary hover:underline disabled:opacity-50"
              >
                Send now
              </Button>
            ) : null}
            {taskTerminal || queueStalled ? (
              <Button
                type="button"
                onClick={() => {
                  discardPendingDraft();
                  setLocalDraft({ taskId, text: queuedSteer });
                  setDraft(taskId, queuedSteer, "composer");
                  clearQueuedSteer(task.id);
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                className="font-medium text-primary hover:underline"
              >
                Put back
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => clearQueuedSteer(task.id)}
              aria-label="Discard the queued message"
              className="flex h-5 w-5 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
            >
              <X size={12} aria-hidden />
            </Button>
          </div>
        ) : null}

        {draftInputError ? (
          <div role="alert" className="mt-2 px-1 text-xs text-warning">
            {draftInputError}
          </div>
        ) : null}
        {draftPersistence?.status === "session_only" || draftPersistence?.status === "rejected" ? (
          <div
            role="status"
            className="mt-2 flex flex-wrap items-center gap-2 px-1 text-xs text-secondary"
          >
            <span className="min-w-0 flex-1">
              Draft not saved locally. {draftPersistence.error ?? draftStorageError ?? "It is available only in this window."}
            </span>
            <Button type="button" onClick={retryDraftSave} className="font-medium text-primary hover:underline">
              Retry
            </Button>
            <Button type="button" onClick={() => void copyDraft()} className="font-medium text-primary hover:underline">
              Copy draft
            </Button>
            {copyStatus ? <span aria-live="polite">{copyStatus}</span> : null}
          </div>
        ) : null}
        {draftStorageError && !draftPersistence ? (
          <div
            role="alert"
            className="mt-2 flex flex-wrap items-center gap-2 px-1 text-xs text-secondary"
          >
            <span className="min-w-0 flex-1">
              Saved draft recovery is unavailable. {draftStorageError}
            </span>
            <Button type="button" onClick={() => retryDraftHydration()} className="font-medium text-primary hover:underline">
              Retry recovery
            </Button>
            {draft ? (
              <Button type="button" onClick={() => void copyDraft()} className="font-medium text-primary hover:underline">
                Copy current draft
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => resetDraftStorage()}
              className="font-medium text-primary hover:underline"
              data-tooltip="Replace unreadable saved-draft data with the drafts currently available in this window"
            >
              Reset local draft storage
            </Button>
            {copyStatus ? <span aria-live="polite">{copyStatus}</span> : null}
          </div>
        ) : null}

        {/* Only a task the control plane will actually refuse a turn for.
            A failed *turn* leaves the task ACTIVE and steerable, and telling
            someone to start over at that point threw away the thread. */}
        {taskTerminal ? (
          <p className="mt-2 px-1 text-xs text-tertiary">
            {taskStatusKind === "failed"
              ? "This task ended in failure · create a new task to continue"
              : "Task finished · create a new task to continue"}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export const Composer = memo(ComposerImpl);
