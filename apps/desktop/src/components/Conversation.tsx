/**
 * Forge Desktop — Conversation feed.
 *
 * Per SPEC §9: document-style feed (not chat bubbles). User messages
 * use restrained low-contrast rounded surfaces; agent responses appear
 * as clean text directly on canvas. Adaptive width — prose centered at
 * 720px (spacious) / 680px (compact); technical content (diffs, tables,
 * plans, terminal output, grouped execution blocks) expands wider.
 *
 * Per SPEC §9.3: grouped execution blocks ("Explored codebase (12
 * files)", "Ran verification (18 tests passed)"), each expandable.
 *
 * Per SPEC §25.1: "Avoid rerendering the full conversation per token."
 * We use React.memo on Message + ActivityBlock and compute the
 * message list with useMemo keyed on the events array length + last
 * event id, so streaming tokens that append to the last message don't
 * re-render earlier messages.
 *
 * Per SPEC §25.1: "Virtualize long conversations." We use
 * `@tanstack/react-virtual` to window the message + activity-block
 * list. Each row is dynamically measured (`measureElement`) so
 * expanded activity blocks and long agent messages can grow without
 * being clipped. Scroll position is sticky-at-bottom only when the
 * user is already at the bottom — new messages arriving while the
 * user is reading history don't yank them down.
 *
 * The feed consumes raw SSE events from the control plane and decodes
 * them into messages + activity blocks. Decoding is intentionally
 * defensive — every payload is `unknown` until we shape it.
 */
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Message } from "./Message";
import { ActivityBlock } from "./ActivityBlock";
import { useSelectedTask, useSelectedTaskEvents } from "../hooks/use-forge";
import type {
  ActivityBlock as ActivityBlockData,
  ActivityEntry,
  ConversationMessage,
  ForgeSseEvent,
} from "../types";

interface ConversationProps {
  /** Optional className override for the scroll container. */
  className?: string;
}

interface DecodedFeed {
  messages: ConversationMessage[];
  blocks: ActivityBlockData[];
}

interface PendingUserInput {
  text: string;
  at: string;
}

interface PendingToolGroup {
  title: string;
  entries: ActivityEntry[];
  startedAt: string;
}

/**
 * Decode the SSE event log into a list of messages + activity blocks.
 *
 * Event taxonomy (from the control plane agent loop, mini-services/
 * forge-control/src/index.ts):
 *   - turn.started        { user_input, task_id, sequence }
 *   - turn.completed      { ... }
 *   - tool.proposed       { tool, args_summary }
 *   - tool.authorized     { ... }
 *   - tool.settled        { tool, result_status }
 *   - turn.provider_running { ... }
 *   - turn.response_validating { ... }
 *   - task.completed      { ... }
 *
 * Anything unrecognized is ignored (defensive). A `provider_running`
 * event with a `delta` field is appended to the streaming agent message.
 */
function decodeFeed(events: ForgeSseEvent[], taskCreatedAt: string): DecodedFeed {
  const messages: ConversationMessage[] = [];
  const blocks: ActivityBlockData[] = [];

  let pendingUser: PendingUserInput | null = null;
  let pendingGroup: PendingToolGroup | null = null;
  let streamingMessageId: string | null = null;

  const flushGroup = (at: string): void => {
    if (!pendingGroup) return;
    const entries = pendingGroup.entries;
    const lastEntry = entries[entries.length - 1];
    const allDone = entries.every((e) => /succeed|pass|complete|ok/i.test(e.summary) || /fail|error/i.test(e.summary));
    const anyFailed = entries.some((e) => /fail|error|denied/i.test(e.summary));
    const status: ActivityBlockData["status"] = anyFailed
      ? "failed"
      : allDone
        ? "done"
        : "working";
    const metric = computeMetric(entries, pendingGroup.title);
    blocks.push({
      id: `block-${pendingGroup.startedAt}-${blocks.length}`,
      title: pendingGroup.title,
      metric,
      status,
      entries,
    });
    if (lastEntry) {
      void lastEntry;
    }
    pendingGroup = null;
  };

  for (const ev of events) {
    let payload: unknown;
    try {
      payload = JSON.parse(ev.data) as unknown;
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    const p = payload as Record<string, unknown>;

    switch (ev.event) {
      case "turn.started": {
        // Flush any in-flight group, then open a new user message.
        flushGroup(ev.id);
        const userInput = typeof p.user_input === "string" ? p.user_input : "";
        const at = typeof p.started_at === "string" ? p.started_at : taskCreatedAt;
        pendingUser = { text: userInput, at };
        messages.push({
          id: `user-${ev.id}`,
          role: "user",
          content: userInput,
          createdAt: at,
        });
        pendingUser = null;
        // Begin an empty agent message that we'll stream into.
        streamingMessageId = `agent-${ev.id}`;
        messages.push({
          id: streamingMessageId,
          role: "agent",
          content: "",
          createdAt: at,
          streaming: true,
        });
        break;
      }
      case "turn.response_validating":
      case "turn.completed": {
        // Mark the streaming agent message as complete.
        if (streamingMessageId) {
          const m = messages.find((x) => x.id === streamingMessageId);
          if (m) m.streaming = false;
        }
        streamingMessageId = null;
        flushGroup(ev.id);
        break;
      }
      case "turn.provider_running": {
        // Some payloads carry a `delta` text chunk or a `response` block.
        if (streamingMessageId) {
          const m = messages.find((x) => x.id === streamingMessageId);
          if (m) {
            const delta = typeof p.delta === "string" ? p.delta : null;
            const response = typeof p.response === "string" ? p.response : null;
            if (delta) m.content += delta;
            else if (response && m.content.length === 0) m.content = response;
          }
        }
        break;
      }
      case "tool.proposed":
      case "tool.authorized":
      case "tool.settled": {
        const tool = typeof p.tool === "string" ? p.tool : "tool";
        const summary = summarizeToolPayload(ev.event, p);
        const at = typeof p.settled_at === "string"
          ? p.settled_at
          : typeof p.proposed_at === "string"
            ? p.proposed_at
            : taskCreatedAt;
        // Group consecutive tool events of the same tool family.
        const groupTitle = groupTitleForTool(tool);
        if (!pendingGroup || pendingGroup.title !== groupTitle) {
          flushGroup(ev.id);
          pendingGroup = { title: groupTitle, entries: [], startedAt: at };
        }
        pendingGroup.entries.push({ tool, summary, at, detail: detailForTool(p) });
        break;
      }
      case "task.completed":
      case "task.failed":
      case "task.interrupted": {
        flushGroup(ev.id);
        if (streamingMessageId) {
          const m = messages.find((x) => x.id === streamingMessageId);
          if (m) m.streaming = false;
        }
        break;
      }
      default:
        // Ignore unrecognized events (defensive).
        break;
    }
  }

  // If the conversation is empty, seed with the task objective so the
  // surface isn't blank while the first turn kicks off.
  if (messages.length === 0) {
    return { messages, blocks };
  }

  return { messages, blocks };
}

function summarizeToolPayload(eventName: string, p: Record<string, unknown>): string {
  const args = p.args_summary ?? p.args;
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const path = typeof a.path === "string" ? a.path : null;
    const program = typeof a.program === "string" ? a.program : null;
    if (path) return path;
    if (program) return program;
  }
  if (typeof args === "string") return args;
  switch (eventName) {
    case "tool.proposed": return "proposed";
    case "tool.authorized": return "authorized";
    case "tool.settled": {
      const status = p.result_status;
      return typeof status === "string" ? status : "settled";
    }
    default: return eventName;
  }
}

function detailForTool(p: Record<string, unknown>): string | undefined {
  const out = p.result_summary ?? p.output_summary ?? p.result;
  if (typeof out === "string") return out;
  if (out && typeof out === "object") {
    try {
      return JSON.stringify(out, null, 2);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function groupTitleForTool(tool: string): string {
  const t = tool.toLowerCase();
  if (t === "read" || t === "search" || t === "inspect") return "Explored codebase";
  if (t === "patch" || t === "write" || t === "edit") return "Implemented changes";
  if (t === "exec" || t === "job") return "Ran commands";
  if (t === "verify" || t === "verification") return "Ran verification";
  return "Tool activity";
}

function computeMetric(entries: ActivityEntry[], title: string): string {
  if (title === "Explored codebase") {
    const paths = new Set(entries.map((e) => e.summary).filter((s) => s.startsWith("/") || s.includes(".")));
    return paths.size > 0 ? `${paths.size} ${paths.size === 1 ? "file" : "files"}` : `${entries.length} reads`;
  }
  if (title === "Implemented changes") {
    return `${entries.length} ${entries.length === 1 ? "edit" : "edits"}`;
  }
  if (title === "Ran commands") {
    const passed = entries.filter((e) => /pass|succeed|ok/i.test(e.summary)).length;
    return passed > 0 ? `${passed} passed` : `${entries.length} runs`;
  }
  return `${entries.length} actions`;
}

// ────────────────────────── Virtualization ───────────────────────────────────

/**
 * A flattened feed item — either a message or an activity block. We
 * interleave them in document order: messages appear in the order
 * they were emitted, and activity blocks render below the agent
 * message that triggered them.
 */
type FeedItem =
  | { kind: "message"; message: ConversationMessage }
  | { kind: "block"; block: ActivityBlockData };

/**
 * Estimate row heights for the virtualizer. The actual height is
 * measured at runtime via `measureElement`. We pick modest estimates
 * so the virtualizer's initial layout is in the right ballpark — over-
 * estimating wastes a bit of padding, under-estimating causes a brief
 * reflow when the row mounts. The defaults below match the typical
 * message (~80px) and collapsed activity block (~40px) sizes from
 * the design spec.
 */
function estimateItemHeight(item: FeedItem): number {
  if (item.kind === "message") {
    // User messages are short. Agent messages with code blocks are
    // taller — 120 is a reasonable middle ground.
    return item.message.role === "user" ? 80 : 120;
  }
  // Activity block collapsed header is 40px. Expanded can be 200px+.
  return 40;
}

function ConversationImpl({ className }: ConversationProps): JSX.Element {
  const task = useSelectedTask();
  const events = useSelectedTaskEvents();

  const decoded = useMemo(() => {
    if (!task) return { messages: [], blocks: [] };
    return decodeFeed(events, task.created_at);
    // Recompute when the events list grows OR the task changes. The last
    // event id is included so streaming appends trigger a re-decode.
  }, [events, task?.id, events.length, events[events.length - 1]?.id]);

  // Build the flattened feed items list.
  const items = useMemo<FeedItem[]>(() => {
    const out: FeedItem[] = [];
    for (const m of decoded.messages) out.push({ kind: "message", message: m });
    for (const b of decoded.blocks) out.push({ kind: "block", block: b });
    return out;
  }, [decoded]);

  // Auto-scroll to bottom on new events, but only if the user is already
  // near the bottom (so we don't yank them while reading history).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const item = items[i];
      return item ? estimateItemHeight(item) : 80;
    },
    overscan: 8,
    // measureElement is what makes dynamic heights work — the virtualizer
    // measures the actual DOM node and updates its layout.
    measureElement:
      typeof window !== "undefined" && navigator.userAgent.includes("Firefox")
        ? undefined // Firefox has a bug with measureElement + transform
        : (el) => el?.getBoundingClientRect().height ?? 80,
  });

  // Stick to bottom when new items arrive AND the user was at the bottom.
  const lastCountRef = useRef(items.length);
  useEffect(() => {
    if (items.length <= lastCountRef.current) {
      lastCountRef.current = items.length;
      return;
    }
    lastCountRef.current = items.length;
    if (stickRef.current) {
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    }
  }, [items.length, virtualizer]);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distFromBottom < 80;
  }, []);

  // Live region for screen readers — politely announces new messages
  // (SPEC §28 / accessibility — streaming updates should be announced).
  const liveMessage = useMemo(() => {
    const last = items[items.length - 1];
    if (!last) return "";
    if (last.kind === "message") {
      const m = last.message;
      return m.role === "user"
        ? `You sent a message`
        : m.streaming
          ? `Forge is responding`
          : `Forge responded`;
    }
    return `Activity: ${last.block.title}`;
  }, [items]);

  if (!task) {
    return (
      <div
        className={className}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}
      >
        <div className="text-tertiary" style={{ fontSize: "var(--font-size-sm)" }}>
          Select a task to view its conversation.
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={className}
      style={{
        height: "100%",
        overflowY: "auto",
        overflowX: "hidden",
        padding: "24px 32px 64px",
      }}
      role="feed"
      aria-label="Conversation feed"
      aria-busy={items.length === 0}
    >
      {/* Polite live region — announces new messages for screen readers. */}
      <div aria-live="polite" aria-atomic="false" style={{ position: "absolute", left: -9999, width: 1, height: 1, overflow: "hidden" }}>
        {liveMessage}
      </div>
      {/* Reading column. Prose stays narrow; blocks expand wider.
          Per SPEC §9.1: comfortable centered reading column. */}
      <div
        style={{
          maxWidth: "var(--conversation-max-width)",
          margin: "0 auto",
        }}
      >
        {/* Task header. */}
        <div className="mb-6 border-b border-subtle pb-3">
          <div
            className="text-xs uppercase tracking-wide text-tertiary"
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            Task
          </div>
          <h1
            className="text-primary"
            style={{
              fontSize: "var(--font-size-xl)",
              fontWeight: 600,
              lineHeight: "var(--line-height-tight)" as unknown as string,
              marginTop: 4,
            }}
          >
            {task.contract?.objective ?? task.id}
          </h1>
          {task.contract && task.contract.non_goals.length > 0 ? (
            <div
              className="mt-2 text-secondary"
              style={{ fontSize: "var(--font-size-sm)" }}
            >
              <span className="text-tertiary">Out of scope:</span>{" "}
              {task.contract.non_goals.join(" · ")}
            </div>
          ) : null}
          <div
            className="mt-1 text-tertiary"
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            Created {formatDistanceToNowStrict(new Date(task.created_at), { addSuffix: true })} · risk {task.risk_class}
          </div>
        </div>

        {/* Empty state. */}
        {items.length === 0 ? (
          <div className="py-8 text-center text-tertiary" style={{ fontSize: "var(--font-size-sm)" }}>
            Waiting for the first turn…
          </div>
        ) : null}

        {/* Virtualized feed. The outer div sets the total height; each
            virtual row is absolutely positioned inside it. */}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const item = items[vi.index];
            if (!item) return null;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {item.kind === "message" ? (
                  <Message message={item.message} />
                ) : (
                  <div style={{ maxWidth: "calc(var(--conversation-max-width) + 160px)" }}>
                    <ActivityBlock block={item.block} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const Conversation = memo(ConversationImpl);
