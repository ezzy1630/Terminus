/**
 * Terminus Desktop — Conversation feed.
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
import { ApprovalCard } from "./ApprovalCard";
import { EmptyState } from "./EmptyState";
import { ErrorState, errorPreset } from "./ErrorState";
import { StatusIndicator, statusLabel } from "./StatusIndicator";
import { MessageCircle } from "lucide-react";
import { normalizeTaskStatus, useSelectedTask, useSelectedTaskEvents, useTerminusStore } from "../hooks/use-terminus";
import { derivePendingApprovals } from "../lib/task-surface";
import type {
  ActivityBlock as ActivityBlockData,
  ActivityEntry,
  ConversationMessage,
  TerminusSseEvent,
} from "../types";

interface ConversationProps {
  /** Optional className override for the scroll container. */
  className?: string;
}

interface DecodedFeed {
  messages: ConversationMessage[];
  blocks: ActivityBlockData[];
  order: Array<{ kind: "message" | "block"; id: string }>;
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
 * terminus-control/src/index.ts):
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
export function decodeFeed(events: TerminusSseEvent[], taskCreatedAt: string): DecodedFeed {
  const messages: ConversationMessage[] = [];
  const blocks: ActivityBlockData[] = [];
  const order: DecodedFeed["order"] = [];

  let pendingUser: PendingUserInput | null = null;
  let pendingGroup: PendingToolGroup | null = null;
  let streamingMessageId: string | null = null;

  const flushGroup = (at: string): void => {
    if (!pendingGroup) return;
    const entries = pendingGroup.entries;
    const lastEntry = entries[entries.length - 1];
    const allDone = entries.every((e) => /success|succeed|pass|complete|ok/i.test(e.summary) || /fail|error/i.test(e.summary));
    const anyFailed = entries.some((e) => /fail|error|denied/i.test(e.summary));
    const status: ActivityBlockData["status"] = anyFailed
      ? "failed"
      : allDone
        ? "done"
        : "working";
    const metric = computeMetric(entries, pendingGroup.title);
    const block: ActivityBlockData = {
      id: `block-${pendingGroup.startedAt}-${blocks.length}`,
      title: pendingGroup.title,
      metric,
      status,
      entries,
    };
    blocks.push(block);
    order.push({ kind: "block", id: block.id });
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
        const userMessage: ConversationMessage = {
          id: `user-${ev.id}`,
          role: "user",
          content: userInput,
          createdAt: at,
        };
        messages.push(userMessage);
        order.push({ kind: "message", id: userMessage.id });
        pendingUser = null;
        // Begin an empty agent message that we'll stream into.
        streamingMessageId = `agent-${ev.id}`;
        const agentMessage: ConversationMessage = {
          id: streamingMessageId,
          role: "agent",
          content: "",
          createdAt: at,
          streaming: true,
        };
        messages.push(agentMessage);
        order.push({ kind: "message", id: agentMessage.id });
        break;
      }
      case "turn.completed": {
        // The control plane's current adapter returns its concise final
        // response on turn.completed rather than streaming deltas. Preserve
        // streamed content when present, but never leave a completed turn
        // with an empty assistant message.
        if (streamingMessageId) {
          const m = messages.find((x) => x.id === streamingMessageId);
          const summary = typeof p.summary === "string" ? p.summary : null;
          if (m) {
            if (m.content.length === 0 && summary) m.content = summary;
            m.streaming = false;
          }
        }
        streamingMessageId = null;
        flushGroup(ev.id);
        break;
      }
      case "turn.response_validating": {
        // Keep the response live through tool settlement. The final summary
        // is emitted with turn.completed by the existing control-plane
        // contract.
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
    return { messages, blocks, order };
  }

  return { messages, blocks, order };
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
      const summary = p.summary;
      const status = p.result_status ?? p.status;
      if (typeof summary === "string" && typeof status === "string") return `${status}: ${summary}`;
      if (typeof summary === "string") return summary;
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
  const streamState = useTerminusStore((state) => state.streamState);
  const lastEventId = events[events.length - 1]?.id;

  const decoded = useMemo(() => {
    if (!task) return { messages: [], blocks: [], order: [] };
    return decodeFeed(events, task.created_at);
    // Recompute when the events list grows OR the task changes. The last
    // event id is included so streaming appends trigger a re-decode.
  }, [events, task?.id, events.length, lastEventId]);
  const approvals = useMemo(() => derivePendingApprovals(events), [events]);

  // Build the flattened feed items list.
  const items = useMemo<FeedItem[]>(() => {
    const messages = new Map(decoded.messages.map((message) => [message.id, message]));
    const blocks = new Map(decoded.blocks.map((block) => [block.id, block]));
    const out: FeedItem[] = [];
    for (const entry of decoded.order) {
      if (entry.kind === "message") {
        const message = messages.get(entry.id);
        if (message) out.push({ kind: "message", message });
      } else {
        const block = blocks.get(entry.id);
        if (block) out.push({ kind: "block", block });
      }
    }
    return out;
  }, [decoded]);

  // Auto-scroll to bottom on new events, but only if the user is already
  // near the bottom (so we don't yank them while reading history).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  // TanStack Virtual exposes imperative functions by design; keep this
  // component outside React Compiler memoization rather than risking stale rows.
  // eslint-disable-next-line react-hooks/incompatible-library
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
          ? `Terminus is responding`
          : `Terminus responded`;
    }
    return `Activity: ${last.block.title}`;
  }, [items]);

  if (!task) {
    return (
      <div className={className} style={{ height: "100%" }}>
        <EmptyState
          icon={<MessageCircle size={17} strokeWidth={1.6} />}
          title="No task selected"
          description="Choose a task from the sidebar to review its conversation and activity."
          compact
        />
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
        <div className="task-header mb-5 border-b border-subtle pb-4">
          <div className="mb-2 flex items-center gap-2 text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>
            <StatusIndicator status={normalizeTaskStatus(task.status)} size={10} />
            <span className="uppercase tracking-wide">{statusLabel(normalizeTaskStatus(task.status))}</span>
          </div>
          <h1
            className="text-primary"
            style={{
              fontSize: "var(--font-size-lg)",
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
        {streamState === "reconnecting" ? (
          <ErrorState
            {...errorPreset("reconnecting")}
            compact
            className="mb-4 rounded-md border border-subtle bg-elevated"
          />
        ) : null}
        {items.length === 0 && normalizeTaskStatus(task.status) === "failed" ? (
          <ErrorState
            {...errorPreset("failedTask")}
            action={{
              label: "Send a follow-up",
              onClick: () => window.dispatchEvent(new Event("terminus:focus-composer")),
            }}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<MessageCircle size={17} strokeWidth={1.6} />}
            title={normalizeTaskStatus(task.status) === "queued" ? "Queued" : normalizeTaskStatus(task.status) === "waiting" ? "Waiting for input" : "Preparing the first turn"}
            description={normalizeTaskStatus(task.status) === "queued"
              ? "Work will begin when the runtime is ready."
              : normalizeTaskStatus(task.status) === "waiting"
                ? "The task will continue as soon as the required input is available."
                : "The conversation will appear here as the agent starts working."}
            compact
          />
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

        {approvals.length > 0 ? (
          <div className="mt-4 flex flex-col gap-3" aria-label="Pending approvals">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                id={approval.id}
                action={approval.action}
                operation={approval.operation}
                reason={approval.reason ?? "The task needs your permission before this effect can continue."}
                risk={approval.risk}
                scope={approval.scope}
                affectedEnvironment={approval.environment}
                requestedAt={approval.requestedAt}
                canPersist={approval.canPersist}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const Conversation = memo(ConversationImpl);
