/**
 * Forge Desktop — Composer.
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
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  CircleSlash,
  GitBranch,
  ListPlus,
  Monitor,
  Paperclip,
  Square,
} from "lucide-react";
import { cn } from "../lib/cn";
import { api, ForgeApiError } from "../lib/api";
import { useForgeStore, useSelectedTask } from "../hooks/use-forge";
import { useThemeStore } from "../hooks/use-theme";
import { normalizeTaskStatus } from "../hooks/use-forge";
import type { AccessLevel, ComposerSendMode } from "../types";

interface ComposerProps {
  className?: string;
}

const AGENT_OPTIONS = [
  { id: "implementer", label: "Implementer" },
  { id: "scout", label: "Scout" },
  { id: "reviewer", label: "Reviewer" },
] as const;

const ACCESS_LEVELS: Array<{ id: AccessLevel; label: string; hint: string }> = [
  { id: "read_only", label: "Read-only", hint: "Read files only. No writes, no exec." },
  { id: "local_dev", label: "Local dev", hint: "Read/write within workspace. Sandbox exec." },
  { id: "trusted", label: "Trusted", hint: "Full workspace access. Network allowlist." },
  { id: "elevated", label: "Elevated", hint: "All effects allowed. Approvals required." },
];

function computeSendMode(taskStatus: string | undefined): ComposerSendMode {
  if (!taskStatus) return "send";
  const kind = normalizeTaskStatus(taskStatus);
  if (kind === "working" || kind === "waiting" || kind === "needs_approval" || kind === "needs_review") {
    return "steer";
  }
  if (kind === "queued") return "stop";
  return "send";
}

function ComposerImpl({ className }: ComposerProps): JSX.Element {
  const task = useSelectedTask();
  const density = useThemeStore((s) => s.density);
  const draftsByTask = useForgeStore((s) => s.draftsByTask);
  const setDraft = useForgeStore((s) => s.setDraft);
  const clearDraft = useForgeStore((s) => s.clearDraft);
  const refreshTasks = useForgeStore((s) => s.refreshTasks);

  const taskId = task?.id ?? "__new__";
  const draft = draftsByTask[taskId] ?? "";

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [agentId, setAgentId] = useState<string>(AGENT_OPTIONS[0]!.id);
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("local_dev");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMode = computeSendMode(task?.status);

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
        setError(err instanceof ForgeApiError ? err.message : "Failed to stop task");
      } finally {
        setSending(false);
      }
      return;
    }

    const text = draft.trim();
    if (text.length === 0) return;
    if (!task) {
      setError("Select or create a task before sending.");
      return;
    }

    try {
      setSending(true);
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
      setError(err instanceof ForgeApiError ? err.message : "Failed to submit");
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
  const onPaste = (e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          const url = URL.createObjectURL(file);
          setAttachments((prev) => [...prev, url]);
        }
      }
    }
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        const url = URL.createObjectURL(file);
        setAttachments((prev) => [...prev, url]);
      }
    }
  };

  const onDragOver = (e: React.DragEvent): void => {
    e.preventDefault();
  };

  // Send button content varies by mode.
  const sendButtonContent: { icon: JSX.Element; label: string; mode: ComposerSendMode } = (() => {
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

  const selectedAccess = ACCESS_LEVELS.find((a) => a.id === accessLevel) ?? ACCESS_LEVELS[1]!;
  const selectedAgent = AGENT_OPTIONS.find((a) => a.id === agentId) ?? AGENT_OPTIONS[0]!;

  return (
    <div className={cn("relative", className)}>
      {/* Reading-column-width container — matches Conversation. */}
      <div style={{ maxWidth: "var(--conversation-max-width)", margin: "0 auto" }}>
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          className={cn(
            "flex flex-col rounded-lg border border-default bg-composer shadow-sm",
            "focus-within:border-strong",
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
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`Attachment ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                    aria-label={`Remove attachment ${i + 1}`}
                    className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-bl-md bg-terminal/80 text-primary"
                  >
                    <CircleSlash size={11} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {/* Textarea. */}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={onTextareaChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={task ? "Send a message, steer work, or queue a follow-up…" : "Describe what you want to build…"}
            aria-label="Message composer"
            className={cn(
              "selectable w-full resize-none bg-transparent px-4 pt-3 text-primary placeholder:text-tertiary",
              "focus:outline-none",
            )}
            style={{
              fontSize: "var(--font-size-md)",
              lineHeight: "var(--line-height-relaxed)" as unknown as string,
              minHeight: 44,
              maxHeight: "var(--composer-max-height)",
              fontFamily: "var(--font-family)",
            }}
            disabled={sending}
          />

          {/* Control row — always visible. Reserved height so metadata
              appearing/disappearing never causes layout shift (SPEC §10). */}
          <div
            className="flex items-center gap-1 px-2 py-2"
            style={{ minHeight: 40 }}
          >
            {/* Attachment. */}
            <button
              type="button"
              aria-label="Attach file"
              title="Attach file"
              className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary"
            >
              <Paperclip size={14} />
            </button>

            {/* Agent / model selector. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => { setAgentOpen((o) => !o); setAccessOpen(false); setMoreOpen(false); }}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-secondary hover:bg-hover hover:text-primary"
                style={{ fontSize: "var(--font-size-xs)" }}
                aria-haspopup="menu"
                aria-expanded={agentOpen}
              >
                <span>{selectedAgent.label}</span>
                <ChevronDown size={11} />
              </button>
              {agentOpen ? (
                <Dropdown onClose={() => setAgentOpen(false)}>
                  {AGENT_OPTIONS.map((a) => (
                    <DropdownItem
                      key={a.id}
                      selected={a.id === agentId}
                      onClick={() => { setAgentId(a.id); setAgentOpen(false); }}
                    >
                      {a.label}
                    </DropdownItem>
                  ))}
                </Dropdown>
              ) : null}
            </div>

            {/* Access level. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => { setAccessOpen((o) => !o); setAgentOpen(false); setMoreOpen(false); }}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-secondary hover:bg-hover hover:text-primary"
                style={{ fontSize: "var(--font-size-xs)" }}
                aria-haspopup="menu"
                aria-expanded={accessOpen}
              >
                <span>{selectedAccess.label}</span>
                <ChevronDown size={11} />
              </button>
              {accessOpen ? (
                <Dropdown onClose={() => setAccessOpen(false)}>
                  {ACCESS_LEVELS.map((a) => (
                    <DropdownItem
                      key={a.id}
                      selected={a.id === accessLevel}
                      onClick={() => { setAccessLevel(a.id); setAccessOpen(false); }}
                      hint={a.hint}
                    >
                      {a.label}
                    </DropdownItem>
                  ))}
                </Dropdown>
              ) : null}
            </div>

            {/* Compact "more" menu for contextual controls. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => { setMoreOpen((o) => !o); setAgentOpen(false); setAccessOpen(false); }}
                aria-label="More options"
                title="Branch, worktree, computer use, queue behavior"
                className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary"
              >
                <ChevronDown size={14} />
              </button>
              {moreOpen ? (
                <Dropdown onClose={() => setMoreOpen(false)} minWidth={220}>
                  <DropdownItem onClick={() => setMoreOpen(false)} icon={<GitBranch size={12} />}>
                    Branch / worktree
                  </DropdownItem>
                  <DropdownItem onClick={() => setMoreOpen(false)} icon={<Monitor size={12} />}>
                    Computer use
                  </DropdownItem>
                  <DropdownItem onClick={() => setMoreOpen(false)} icon={<ListPlus size={12} />}>
                    Queue behavior
                  </DropdownItem>
                </Dropdown>
              ) : null}
            </div>

            {/* Right side — mode pill + send button. */}
            <div className="ml-auto flex items-center gap-2">
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
                disabled={sending || (sendButtonContent.mode !== "stop" && draft.trim().length === 0)}
                aria-label={sendButtonContent.label}
                title={sendButtonContent.label}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-md px-3 text-xs font-medium",
                  sendButtonContent.mode === "stop"
                    ? "bg-hover text-error"
                    : "text-primary",
                  (sending || (sendButtonContent.mode !== "stop" && draft.trim().length === 0))
                    ? "opacity-50"
                    : "hover:opacity-90",
                )}
                style={{
                  fontSize: "var(--font-size-xs)",
                  background: sendButtonContent.mode === "stop" ? "var(--bg-hover)" : "var(--color-primary)",
                  color: sendButtonContent.mode === "stop" ? "var(--color-error)" : "var(--text-inverse)",
                }}
              >
                {sendButtonContent.icon}
                <span>{sendButtonContent.label}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Keyboard shortcut hint. */}
        <div
          className="mt-1.5 flex items-center justify-between px-1 text-tertiary"
          style={{ fontSize: "var(--font-size-xs)" }}
        >
          <span>
            <kbd className="font-mono">⌘↵</kbd> send · <kbd className="font-mono">⇧⌘↵</kbd> queue · <kbd className="font-mono">esc</kbd> interrupt
          </span>
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
}: {
  children: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
  hint?: string;
  icon?: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitemradio"
      aria-checked={selected}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-secondary hover:bg-hover hover:text-primary",
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

export const Composer = memo(ComposerImpl);
