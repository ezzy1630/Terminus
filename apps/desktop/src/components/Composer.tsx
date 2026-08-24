/**
 * Terminus Desktop — Composer.
 *
 * Per SPEC §10: "The composer is one intelligent input surface. It
 * remains fully available while work is running."
 *
 * Always-visible controls:
 *   - Effective access level
 *   - Send / steer
 *
 * Contextual controls (compact dropdown):
 *   - Branch / worktree
 *   - Computer use
 *   - Current environment
 *
 * Per SPEC §10: "Expand vertically within sensible limits" — max
 * 280px spacious / 224px compact (from theme.css).
 *
 * Attachment and routing controls remain absent until their selections can be
 * persisted in authoritative task contracts. Drafts and keyboard shortcuts
 * remain available. The composer clearly distinguishes send and steer. It remains
 * stable during streaming. Never jump because metadata appears or
 * disappears. Match the reading-column width."
 *
 * Keyboard shortcuts:
 *   Cmd+Enter          → send (or steer if work is running)
 *
 * Per SPEC §25.1: "Composer input must never lag during streaming."
 * The textarea updates local state synchronously. Draft persistence is
 * deferred and generation-guarded so streaming renders cannot revert input.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  FolderGit2,
  ShieldCheck,
} from "lucide-react";
import { cn } from "../lib/cn";
import { api, TerminusApiError } from "../lib/api";
import {
  draftByteLength,
  MAX_DRAFT_BYTES,
  useTerminusStore,
  useSelectedTask,
  useSelectedTaskEvents,
} from "../hooks/use-terminus";
import { useThemeStore } from "../hooks/use-theme";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../hooks/use-logical-mutation";
import { normalizeTaskStatus } from "../hooks/use-terminus";
import type { ComposerSendMode } from "../types";
import { FIXED_SHORTCUTS, matchesShortcut } from "../lib/shortcuts";
import { Button } from "../ui/Button";
import { ModelPicker } from "./ModelPicker";
import { TurnSettings } from "./TurnSettings";
import { useModelSelection } from "../lib/models";
import { useModelInventory } from "../hooks/use-model-inventory";
import { useModelRouting } from "../hooks/use-model-routing";

interface ComposerProps {
  className?: string;
  onChangeProject?: () => void;
  /**
   * The start surface supplies this so the same composer can turn a fresh
   * objective into a real task.  A selected task continues to use the turn
   * APIs below; there is no second, look-alike input implementation.
   */
  onCreateTask?: (objective: string) => Promise<void>;
}

function computeSendMode(taskStatus: string | undefined, _hasStartedTurn: boolean): Extract<ComposerSendMode, "send" | "steer"> {
  if (!taskStatus) return "send";
  // A DRAFT task has been created but has not started its first turn yet.
  // Keep Send available so onSubmit can call startTask before startTurn.
  if (taskStatus === "DRAFT") return "send";
  const kind = normalizeTaskStatus(taskStatus);
  if (kind === "working" || kind === "waiting" || kind === "needs_approval" || kind === "needs_review") {
    return "steer";
  }
  if (kind === "queued") return "steer";
  return "send";
}

function ComposerImpl({ className, onCreateTask, onChangeProject }: ComposerProps): JSX.Element {
  const task = useSelectedTask();
  const events = useSelectedTaskEvents();
  const modelInventory = useModelInventory();
  const modelSelection = useModelSelection(modelInventory);
  const modelRouting = useModelRouting();
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const sessions = useTerminusStore((s) => s.sessions);
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
  const healthReady = useTerminusStore((s) => s.healthReady);

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
  const draft = localDraft.taskId === taskId ? localDraft.text : storedDraft;
  const draftPersistence = draftPersistenceByTask[taskId];

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

  const hasStartedTurn = events.some((event) => event.event === "turn.started");
  const sendMode = computeSendMode(task?.status, hasStartedTurn);
  const taskStatusKind = task ? normalizeTaskStatus(task.status) : null;
  const taskTerminal = taskStatusKind === "done" || taskStatusKind === "failed" || taskStatusKind === "interrupted";
  const isStartSurface = !task && Boolean(onCreateTask);
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === (task?.session_id ?? selectedSessionId)),
    [selectedSessionId, sessions, task?.session_id],
  );
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

  // Send / steer logic. Task-wide cancellation and local-only queuing are not
  // inferred from editor keys; both require authoritative control contracts.
  const onSubmit = async (mode: Extract<ComposerSendMode, "send" | "steer">): Promise<void> => {
    setError(null);

    const text = draft.trim();
    if (text.length === 0) return;
    if (!healthReady) {
      setError("Terminus is still starting up. Try again in a moment.");
      return;
    }
    if (taskTerminal) {
      setError("This task is finished. Create a new task to continue working.");
      return;
    }
    let operationKey: string | null = null;
    let hasDurableStep = false;
    try {
      setSending(true);
      if (!task) {
        if (!onCreateTask) {
          setError("Select or create a project before sending.");
          return;
        }
        await onCreateTask(text);
        clearCurrentDraft();
        return;
      }
      const admission = turnMutation.acquire(JSON.stringify({ taskId: task.id, text }));
      operationKey = admission.key;
      hasDurableStep = admission.completedSteps.task_started !== undefined;
      // For the very first send on a DRAFT task, start the task.
      // For subsequent sends, this is a steer — the control plane's
      // /v1/turns endpoint creates a new turn in the existing thread.
      if (task.status === "DRAFT" && !hasDurableStep) {
        const started = await api.startTask(task.id, { idempotencyKey: `${operationKey}:start-task` });
        turnMutation.checkpoint(
          operationKey,
          "task_started",
          JSON.stringify({ eventCursor: started.event_cursor }),
        );
        hasDurableStep = true;
      }
      await api.startTurn({
        thread_id: task.thread_id,
        task_id: task.id,
        user_input: text,
      }, { idempotencyKey: `${operationKey}:turn` });
      turnMutation.settle(operationKey);
      clearCurrentDraft();
      void refreshTasks(task.session_id);
    } catch (err) {
      if (operationKey && isDefinitiveMutationFailure(err)) {
        try {
          if (hasDurableStep) {
            if (task) await refreshTasks(task.session_id);
            turnMutation.completePartial(operationKey);
          } else {
            turnMutation.abandon(operationKey);
          }
        } catch (recoveryError) {
          setError(recoveryError instanceof Error ? recoveryError.message : "Couldn't recover the saved request.");
          return;
        }
      }
      setError(err instanceof TerminusApiError || err instanceof Error ? err.message : "Couldn't send the request.");
    } finally {
      setSending(false);
    }
  };

  // Keyboard shortcuts.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Cmd/Ctrl + Enter → send (or steer).
    if (matchesShortcut(e, FIXED_SHORTCUTS.send)) {
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      void onSubmit(sendMode === "steer" ? "steer" : "send");
    }
  };

  // Send button content varies by mode.
  const sendButtonContent: { icon: JSX.Element; label: string; mode: Extract<ComposerSendMode, "send" | "steer"> } = (() => {
    if (!task && onCreateTask) {
      return { icon: <ArrowUp size={15} strokeWidth={2} />, label: "Create task", mode: "send" };
    }
    switch (sendMode) {
      case "steer":
        return { icon: <ArrowUp size={14} />, label: "Steer", mode: "steer" };
      case "send":
      default:
        return { icon: <ArrowUp size={14} />, label: "Send", mode: "send" };
    }
  })();

  const permissionProfile = activeSession?.default_permission_profile?.trim() || "Workspace policy";
  const permissionLabel = permissionProfile === "secure-local-default" ? "Full access" : permissionProfile;
  const sendDisabled = sending || draft.trim().length === 0 || !healthReady || taskTerminal;
  const sendTitle = taskTerminal
    ? "Task is terminal; create a new task to continue"
    : healthReady ? `${sendButtonContent.label} · ⌘↵` : "Kernel not ready";

  return (
    <div className={cn("relative", className)}>
      {/* Reading-column-width container — matches Conversation. */}
      <div className={isStartSurface ? "start-column" : "content-column"}>
        <div
          className={cn(
            "composer-surface flex flex-col rounded-xl border border-default bg-composer",
          )}
        >
          {/* Textarea. */}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={onTextareaChange}
            onBlur={flushPendingDraft}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={task ? "Send a message or steer the current work…" : isStartSurface ? "Describe a task or ask a question" : "Describe what you want to build…"}
            aria-label="Message composer"
            role="textbox"
            aria-multiline="true"
            spellCheck={false}
            data-gramm="false"
            data-gramm_editor="false"
            className={cn(
              "selectable w-full resize-none bg-transparent px-3 pt-2.5 text-primary placeholder:text-tertiary",
              "font-sans text-base leading-5 focus:outline-none",
              task ? "min-h-9" : isStartSurface ? "min-h-[52px]" : "min-h-12",
            )}
            style={{ maxHeight: "var(--composer-max-height)", caretColor: "var(--text-primary)" }}
          />

          {/* Control row — always visible. Reserved height so metadata
              appearing/disappearing never causes layout shift (SPEC §10). */}
          <div
            className="composer-controls flex min-h-8 items-center gap-0.5 px-2.5 pb-2"
          >
            {/* Left cluster — what this turn will run as. Project only on the
                start surface, where it is still changeable; once a task exists
                its project is fixed and repeating it is noise. */}
            {isStartSurface ? (
              <Button
                type="button"
                onClick={onChangeProject}
                className="composer-control mr-1 flex h-7 min-w-0 items-center justify-start gap-1.5 rounded-md border border-subtle bg-subtle px-2 text-xs text-secondary"
                aria-label="Change project"
                disabled={!onChangeProject}
              >
                <FolderGit2 size={13} strokeWidth={1.7} />
                <span className="max-w-32 truncate">{activeSession?.title ?? "Choose project"}</span>
              </Button>
            ) : null}

            <ModelPicker selection={modelSelection} routing={modelRouting} className="mr-1" />
            <TurnSettings selection={modelSelection} className="mr-1" />

            {/* Access is task context, not a start-surface choice: before a
                task exists there is no effective profile to report. */}
            {isStartSurface ? null : (
              <span
                className="flex h-7 items-center gap-1.5 px-1 text-xs text-tertiary"
                aria-label={`Permission profile: ${permissionProfile}`}
                data-tooltip="Permission profile reported by the selected session"
              >
                <ShieldCheck size={12} strokeWidth={1.8} aria-hidden />
                <span className="max-w-40 truncate">{permissionLabel}</span>
              </span>
            )}

            {/* Right side — mode pill + send button. */}
            <div className="ml-auto flex items-center gap-2">
              {error ? (
                <span
                  key={error}
                  role="alert"
                  aria-live="assertive"
                  aria-atomic="true"
                  className="max-w-48 truncate text-xs text-error"
                  data-tooltip={error}
                >
                  {error}
                </span>
              ) : null}
              <Button
                type="button"
                onClick={() => void onSubmit(sendButtonContent.mode)}
                disabled={sendDisabled}
                aria-label={sendButtonContent.label}
                data-tooltip={sendTitle}
                variant={sendDisabled ? "ghost" : "primary"}
                className="send-control flex h-8 w-8 items-center justify-center rounded-lg px-0 text-xs font-medium"
              >
                {sendButtonContent.icon}
                <span className="sr-only">{sendButtonContent.label}</span>
              </Button>
            </div>
          </div>
        </div>

        {draftInputError ? (
          <div role="alert" className="mt-2 border-l-2 border-warning/55 px-2.5 py-1.5 text-xs text-warning" >
            {draftInputError}
          </div>
        ) : null}
        {draftPersistence?.status === "session_only" || draftPersistence?.status === "rejected" ? (
          <div
            role="status"
            className="mt-2 flex flex-wrap items-center gap-2 border-l-2 border-warning/55 px-2.5 py-1.5 text-xs text-secondary"

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
            className="mt-2 flex flex-wrap items-center gap-2 border-l-2 border-warning/55 px-2.5 py-1.5 text-xs text-secondary"

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

        {taskTerminal ? (
          <p className="mt-2 px-1 text-xs text-tertiary">Task finished · create a new task to continue</p>
        ) : null}
      </div>
    </div>
  );
}

export const Composer = memo(ComposerImpl);
