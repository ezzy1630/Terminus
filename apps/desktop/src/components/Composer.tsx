/**
 * Terminus Desktop — Composer.
 *
 * Per SPEC §10: "The composer is one intelligent input surface. It
 * remains fully available while work is running."
 *
 * Always-visible controls:
 *   - Attachment (paperclip)
 *   - Agent / model selector
 *   - Access level
 *   - Send / steer / queue / stop
 *
 * Contextual controls (compact dropdown):
 *   - Branch / worktree
 *   - Computer use
 *   - Image context
 *   - Queue behavior
 *   - Current environment
 *
 * Per SPEC §10: "Expand vertically within sensible limits" — max
 * 280px spacious / 220px compact (from tokens.ts).
 *
 * Per SPEC §10: "Support drag-and-drop. Support paste of images and
 * files. Preserve drafts per task. Support keyboard shortcuts.
 * Clearly distinguish send, queue, steer, and stop states. Remain
 * stable during streaming. Never jump because metadata appears or
 * disappears. Match the reading-column width."
 *
 * Keyboard shortcuts:
 *   Cmd+Enter          → send (or steer if work is running)
 *   Shift+Cmd+Enter    → queue follow-up
 *   Esc                → interrupt
 *
 * Per SPEC §25.1: "Composer input must never lag during streaming."
 * The textarea is uncontrolled-with-debounce for typing; we write
 * drafts to the store via requestIdleCallback so streaming renders
 * don't block keystrokes.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  CircleSlash,
  FolderGit2,
  GitBranch,
  Hash,
  ListPlus,
  Monitor,
  Paperclip,
  Plus,
  ShieldCheck,
  Square,
} from "lucide-react";
import { cn } from "../lib/cn";
import { api, TerminusApiError } from "../lib/api";
import { useTerminusStore, useSelectedTask } from "../hooks/use-terminus";
import { useThemeStore } from "../hooks/use-theme";
import { normalizeTaskStatus } from "../hooks/use-terminus";
import type { ComposerSendMode } from "../types";

interface ComposerProps {
  className?: string;
  /**
   * The start surface supplies this so the same composer can turn a fresh
   * objective into a real task.  A selected task continues to use the turn
   * APIs below; there is no second, look-alike input implementation.
   */
  onCreateTask?: (objective: string) => Promise<void>;
}

function computeSendMode(taskStatus: string | undefined): ComposerSendMode {
  if (!taskStatus) return "send";
  const kind = normalizeTaskStatus(taskStatus);
  if (kind === "working" || kind === "waiting" || kind === "needs_approval" || kind === "needs_review") {
    return "steer";
  }
  if (kind === "queued") return "stop";
  return "send";
}

function ComposerImpl({ className, onCreateTask }: ComposerProps): JSX.Element {
  const task = useSelectedTask();
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const sessions = useTerminusStore((s) => s.sessions);
  const density = useThemeStore((s) => s.density);
  const draftsByTask = useTerminusStore((s) => s.draftsByTask);
  const setDraft = useTerminusStore((s) => s.setDraft);
  const clearDraft = useTerminusStore((s) => s.clearDraft);
  const refreshTasks = useTerminusStore((s) => s.refreshTasks);

  const taskId = task?.id ?? "__new__";
  const draft = draftsByTask[taskId] ?? "";

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentUrlsRef = useRef<Set<string>>(new Set());
  const [agentOpen, setAgentOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [agentId, setAgentId] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMode = computeSendMode(task?.status);
  const isStartSurface = !task && Boolean(onCreateTask);
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === (task?.session_id ?? selectedSessionId)),
    [selectedSessionId, sessions, task?.session_id],
  );
  const agentOptions = useMemo(() => Array.from(new Set(
    sessions.flatMap((candidate) => candidate.default_model_profile?.trim() ? [candidate.default_model_profile.trim()] : []),
  )).map((profile) => ({ id: profile, label: profile })), [sessions]);

  // A project can nominate a default profile. Keep the selector aligned on
  // the new-task surface while leaving an active task's explicit choice alone.
  useEffect(() => {
    if (!task && activeSession?.default_model_profile) {
      setAgentId(activeSession.default_model_profile.trim());
    }
  }, [activeSession?.default_model_profile, task]);

  useEffect(() => () => {
    for (const url of attachmentUrlsRef.current) URL.revokeObjectURL(url);
    attachmentUrlsRef.current.clear();
  }, []);

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
    textareaRef.current?.focus();
  }, [taskId]);

  useEffect(() => {
    const focusComposer = (): void => textareaRef.current?.focus();
    window.addEventListener("terminus:focus-composer", focusComposer);
    return () => window.removeEventListener("terminus:focus-composer", focusComposer);
  }, []);

  // Persist draft on idle so streaming renders never block keystrokes.
  const writeDraft = useCallback(
    (text: string) => {
      const run = (): void => setDraft(taskId, text);
      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(run);
      } else {
        setTimeout(run, 0);
      }
    },
    [setDraft, taskId],
  );

  const onTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    writeDraft(e.target.value);
  };

  // Send / steer / queue / stop logic.
  const onSubmit = async (mode: ComposerSendMode): Promise<void> => {
    setError(null);

    if (mode === "stop") {
      if (!task) return;
      try {
        setSending(true);
        await api.cancelTask(task.id, "user_stopped");
      } catch (err) {
        setError(err instanceof TerminusApiError ? err.message : "Failed to stop task");
      } finally {
        setSending(false);
      }
      return;
    }

    const text = draft.trim();
    if (text.length === 0) return;
    try {
      setSending(true);
      if (!task) {
        if (!onCreateTask) {
          setError("Select or create a project before sending.");
          return;
        }
        await onCreateTask(text);
        clearDraft(taskId);
        return;
      }
      if (mode === "send" || mode === "steer") {
        // For the very first send on a PENDING task, start the task.
        // For subsequent sends, this is a steer — the control plane's
        // /v1/turns endpoint creates a new turn in the existing thread.
        if (task.status === "PENDING") {
          await api.startTask(task.id);
        }
        await api.startTurn({
          thread_id: task.thread_id,
          task_id: task.id,
          user_input: text,
        });
        clearDraft(taskId);
        void refreshTasks(task.session_id);
      } else if (mode === "queue") {
        // Queue behavior: send the input as a turn but mark it as queued
        // via metadata in the user_input. The control plane doesn't yet
        // expose a dedicated queue endpoint, so we prefix with a marker
        // the agent loop will recognize. (Phase 5 will add a real queue.)
        await api.startTurn({
          thread_id: task.thread_id,
          task_id: task.id,
          user_input: `[queued] ${text}`,
        });
        clearDraft(taskId);
      }
    } catch (err) {
      setError(err instanceof TerminusApiError || err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSending(false);
    }
  };

  // Keyboard shortcuts.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Esc → interrupt running turn.
    if (e.key === "Escape") {
      e.preventDefault();
      void onSubmit("stop");
      return;
    }
    // Cmd/Ctrl + Enter → send (or steer).
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        void onSubmit("queue");
      } else {
        void onSubmit(sendMode === "steer" ? "steer" : "send");
      }
    }
  };

  // Drag-and-drop + paste of images.
  const addImageFiles = (files: Iterable<File>): void => {
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        const url = URL.createObjectURL(file);
        attachmentUrlsRef.current.add(url);
        setAttachments((prev) => [...prev, url]);
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    addImageFiles(files);
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;
    addImageFiles(Array.from(files));
  };

  const onDragOver = (e: React.DragEvent): void => {
    e.preventDefault();
  };

  // Send button content varies by mode.
  const sendButtonContent: { icon: JSX.Element; label: string; mode: ComposerSendMode } = (() => {
    if (!task && onCreateTask) {
      return { icon: <ArrowUp size={15} strokeWidth={2} />, label: "Create task", mode: "send" };
    }
    switch (sendMode) {
      case "steer":
        return { icon: <ArrowUp size={14} />, label: "Steer", mode: "steer" };
      case "stop":
        return { icon: <Square size={12} fill="currentColor" />, label: "Stop", mode: "stop" };
      case "queue":
        return { icon: <ListPlus size={14} />, label: "Queue", mode: "queue" };
      case "send":
      default:
        return { icon: <ArrowUp size={14} />, label: "Send", mode: "send" };
    }
  })();

  const selectedAgent = agentOptions.find((option) => option.id === agentId)
    ?? (activeSession?.default_model_profile?.trim() ? { id: activeSession.default_model_profile.trim(), label: activeSession.default_model_profile.trim() } : null);
  const permissionProfile = activeSession?.default_permission_profile?.trim() || "Workspace policy";
  const sendDisabled = sending || (sendButtonContent.mode !== "stop" && draft.trim().length === 0);

  return (
    <div className={cn("relative", className)}>
      {/* Reading-column-width container — matches Conversation. */}
      <div style={{ maxWidth: "var(--conversation-max-width)", margin: "0 auto" }}>
        {activeSession && !isStartSurface ? (
          <div
            className="mb-2 flex min-w-0 items-center gap-4 px-2 text-secondary"
            style={{ fontSize: "var(--font-size-xs)" }}
            aria-label="Task environment"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <FolderGit2 size={14} className="flex-shrink-0 text-tertiary" strokeWidth={1.7} />
              <span className="truncate">{activeSession.title}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Monitor size={14} className="text-tertiary" strokeWidth={1.7} />
              <span>{activeSession.default_permission_profile === "secure-local-default" ? "Local" : activeSession.default_permission_profile ?? "Local"}</span>
            </span>
            {task ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <Hash size={14} className="flex-shrink-0 text-tertiary" strokeWidth={1.7} />
                <span className="truncate font-mono">{task.thread_id.slice(0, 8)}</span>
              </span>
            ) : null}
          </div>
        ) : null}
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          className={cn(
            "composer-surface flex flex-col border border-default bg-composer shadow-md",
            isStartSurface ? "rounded-[22px]" : "rounded-xl",
            "focus-within:border-strong focus-within:shadow-lg",
          )}
          style={{ background: "var(--bg-composer)" }}
        >
          {/* Attachment previews. */}
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((url, i) => (
                <div
                  key={i}
                  className="relative h-16 w-16 overflow-hidden rounded-md border border-subtle"
                >
                  <img
                    src={url}
                    alt={`Attachment ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      URL.revokeObjectURL(url);
                      attachmentUrlsRef.current.delete(url);
                      setAttachments((prev) => prev.filter((_, idx) => idx !== i));
                    }}
                    aria-label={`Remove attachment ${i + 1}`}
                    className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-bl-md bg-terminal/80 text-primary"
                  >
                    <CircleSlash size={11} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(event) => {
              if (event.target.files) addImageFiles(Array.from(event.target.files));
              event.target.value = "";
            }}
            aria-label="Choose image attachments"
          />

          {/* Textarea. */}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={onTextareaChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={task ? "Send a message, steer work, or queue a follow-up…" : isStartSurface ? "Do anything" : "Describe what you want to build…"}
            aria-label="Message composer"
            role="textbox"
            aria-multiline="true"
            spellCheck={false}
            data-gramm="false"
            data-gramm_editor="false"
            className={cn(
              "selectable w-full resize-none bg-transparent px-4 pt-3 text-primary placeholder:text-tertiary",
              "focus:outline-none",
            )}
            style={{
              fontSize: "var(--font-size-md)",
              lineHeight: "var(--line-height-relaxed)" as unknown as string,
              minHeight: task ? 44 : isStartSurface ? 52 : 64,
              maxHeight: "var(--composer-max-height)",
              fontFamily: "var(--font-family)",
            }}
          />

          {/* Control row — always visible. Reserved height so metadata
              appearing/disappearing never causes layout shift (SPEC §10). */}
          <div
            className="flex items-center gap-0.5 px-3 pb-3 pt-1"
            style={{ minHeight: isStartSurface ? 42 : 40 }}
          >
            {/* Attachment. */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach file"
              title="Attach file"
              className="composer-control flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-hover hover:text-primary"
              style={{ order: 1 }}
            >
              {isStartSurface ? <Plus size={17} /> : <Paperclip size={14} />}
            </button>

            {/* Agent / model selector. */}
            <div className="relative" style={{ order: isStartSurface ? 4 : 2, marginLeft: isStartSurface ? "auto" : undefined }}>
              <button
                type="button"
                onClick={() => { setAgentOpen((o) => !o); setMoreOpen(false); }}
                className="composer-control flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-secondary hover:bg-hover hover:text-primary"
                style={{ fontSize: "var(--font-size-xs)" }}
                aria-haspopup="menu"
                aria-expanded={agentOpen}
              >
                <span>{selectedAgent?.label ?? "Connect provider"}</span>
                <ChevronDown size={11} />
              </button>
              {agentOpen ? (
                <Dropdown onClose={() => setAgentOpen(false)}>
                  {agentOptions.map((a) => (
                    <DropdownItem
                      key={a.id}
                      selected={a.id === agentId}
                      onClick={() => { setAgentId(a.id); setAgentOpen(false); }}
                    >
                      {a.label}
                    </DropdownItem>
                  ))}
                  <DropdownItem
                    onClick={() => { setAgentOpen(false); window.dispatchEvent(new Event("terminus:open-settings")); }}
                    hint={agentOptions.length === 0 ? "No configured model profiles were reported" : "Manage provider and model profiles"}
                  >
                    {agentOptions.length === 0 ? "Connect provider" : "Manage connections"}
                  </DropdownItem>
                </Dropdown>
              ) : null}
            </div>

            {/* Permission profile — sourced from the selected session. */}
            <div className="relative" style={{ order: isStartSurface ? 2 : 3 }}>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event("terminus:open-settings"))}
                className="composer-control flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-secondary hover:bg-hover hover:text-primary"
                style={{ fontSize: "var(--font-size-xs)" }}
                aria-label={`Permission profile: ${permissionProfile}`}
                title="Manage permission policy"
              >
                <ShieldCheck size={13} strokeWidth={1.8} />
                <span>{permissionProfile}</span>
              </button>
            </div>

            {/* Compact "more" menu for contextual controls. */}
            <div className="relative" style={{ order: 3 }}>
              <button
                type="button"
                onClick={() => { setMoreOpen((o) => !o); setAgentOpen(false); }}
                aria-label="More options"
                title="Branch, worktree, computer use, queue behavior"
                className="composer-control flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-hover hover:text-primary"
              >
                <ChevronDown size={14} />
              </button>
              {moreOpen ? (
                <Dropdown onClose={() => setMoreOpen(false)} minWidth={220}>
                  <DropdownInfo icon={<GitBranch size={12} />} label="Branch / worktree" value={task ? "Task environment" : "Choose a project"} />
                  <DropdownInfo icon={<Monitor size={12} />} label="Computer use" value={task ? "Appears when active" : "Not active"} />
                  <DropdownItem
                    onClick={() => { void onSubmit("queue"); setMoreOpen(false); }}
                    icon={<ListPlus size={12} />}
                    disabled={!task || draft.trim().length === 0 || sending}
                    hint={!task ? "Available during a task" : draft.trim().length === 0 ? "Write a follow-up first" : "Send this draft after current work"}
                  >
                    Queue follow-up
                  </DropdownItem>
                </Dropdown>
              ) : null}
            </div>

            {/* Right side — mode pill + send button. */}
            <div className="ml-auto flex items-center gap-2" style={{ order: 5 }}>
              {sendMode === "steer" ? (
                <span
                  className="rounded px-1.5 py-0.5 text-tertiary"
                  style={{
                    fontSize: "var(--font-size-xs)",
                    background: "var(--bg-hover)",
                  }}
                >
                  Steer
                </span>
              ) : sendMode === "queue" ? (
                <span
                  className="rounded px-1.5 py-0.5 text-tertiary"
                  style={{
                    fontSize: "var(--font-size-xs)",
                    background: "var(--bg-hover)",
                  }}
                >
                  Queued
                </span>
              ) : null}
              {error ? (
                <span
                  className="truncate text-error"
                  style={{ fontSize: "var(--font-size-xs)", maxWidth: 200 }}
                  title={error}
                >
                  {error}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void onSubmit(sendButtonContent.mode)}
                disabled={sendDisabled}
                aria-label={sendButtonContent.label}
                title={sendButtonContent.label}
                className={cn(
                  "send-control flex h-9 w-9 items-center justify-center rounded-full text-xs font-medium",
                  sendButtonContent.mode === "stop"
                    ? "bg-hover text-error"
                    : "text-primary",
                  sendDisabled
                    ? "opacity-50"
                    : "hover:opacity-90",
                )}
                style={{
                  fontSize: "var(--font-size-xs)",
                  background: sendButtonContent.mode === "stop"
                    ? "var(--bg-hover)"
                    : sendDisabled
                      ? "var(--bg-hover)"
                      : "var(--color-primary)",
                  color: sendButtonContent.mode === "stop"
                    ? "var(--color-error)"
                    : sendDisabled
                      ? "var(--text-tertiary)"
                      : "var(--text-inverse)",
                }}
              >
                {sendButtonContent.icon}
                <span className="sr-only">{sendButtonContent.label}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Keyboard shortcut hint. */}
        <div
          className="mt-2 flex items-center justify-between px-1 text-tertiary"
          style={{ fontSize: "var(--font-size-xs)" }}
        >
          <span>{task ? <><kbd className="font-mono">⌘↵</kbd> send · <kbd className="font-mono">⇧⌘↵</kbd> queue · <kbd className="font-mono">esc</kbd> interrupt</> : isStartSurface ? "" : "Drop files or paste images to add context"}</span>
          {task ? (
            <span className="truncate" style={{ maxWidth: 200 }}>
              {task.thread_id.slice(0, 8)} · {task.risk_class} risk
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────── Dropdown primitives ────────────────────────────
// Small headless dropdown. Closes on outside click + Escape.

function Dropdown({
  children,
  onClose,
  minWidth = 160,
}: {
  children: React.ReactNode;
  onClose: () => void;
  minWidth?: number;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="absolute bottom-full left-0 mb-1 rounded-md border border-default bg-inspector shadow-md"
      style={{ minWidth, zIndex: 50, padding: 4 }}
    >
      {children}
    </div>
  );
}

function DropdownItem({
  children,
  selected,
  onClick,
  hint,
  icon,
  disabled = false,
}: {
  children: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
  hint?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="menuitemradio"
      aria-checked={selected}
      className={cn(
        "flex min-h-9 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-secondary hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-secondary",
        selected && "text-primary",
      )}
      style={{ fontSize: "var(--font-size-xs)" }}
    >
      {icon ? <span className="flex-shrink-0 text-tertiary">{icon}</span> : null}
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="truncate">{children}</span>
        {hint ? (
          <span className="text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>
            {hint}
          </span>
        ) : null}
      </span>
      {selected ? (
        <span
          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ background: "var(--color-primary)" }}
          aria-hidden
        />
      ) : null}
    </button>
  );
}

function DropdownInfo({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }): JSX.Element {
  return (
    <div role="menuitem" aria-disabled="true" className="flex min-h-9 w-full items-center gap-2 rounded px-2 py-1.5 text-secondary">
      <span className="flex-shrink-0 text-tertiary">{icon}</span>
      <span className="min-w-0 flex-1 truncate" style={{ fontSize: "var(--font-size-xs)" }}>{label}</span>
      <span className="flex-shrink-0 text-tertiary" style={{ fontSize: 10 }}>{value}</span>
    </div>
  );
}

export const Composer = memo(ComposerImpl);
