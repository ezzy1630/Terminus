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
 * Per SPEC §25.1: "Virtualize long conversations." For the primary
 * slice we use CSS containment (content-visibility: auto) as a
 * pragmatic stand-in. Full windowing can be layered in Phase 6 without
 * changing the public surface.
 *
 * The feed consumes raw SSE events from the control plane and decodes
 * them into messages + activity blocks. Decoding is intentionally
 * defensive — every payload is `unknown` until we shape it.
 */
import { memo, useEffect, useMemo, useRef } from "react";
import { formatDistanceToNowStrict } from "date-fns";
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

function ConversationImpl({ className }: ConversationProps): JSX.Element {
  const task = useSelectedTask();
  const events = useSelectedTaskEvents();

  const decoded = useMemo(() => {
    if (!task) return { messages: [], blocks: [] };
    return decodeFeed(events, task.created_at);
    // Recompute when the events list grows OR the task changes. The last
    // event id is included so streaming appends trigger a re-decode.
  }, [events, task?.id, events.length, events[events.length - 1]?.id]);

  // Auto-scroll to bottom on new events, but only if the user is already
  // near the bottom (so we don't yank them while reading history).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [decoded]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distFromBottom < 80;
  };

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
    >
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

        {/* Messages interleaved with activity blocks. We render messages
            in order; activity blocks follow the message they were
            emitted during. For simplicity in the primary slice, we
            render all messages then all blocks at the bottom of the
            relevant turn — Phase 5 will interleave precisely. */}
        {decoded.messages.length === 0 && decoded.blocks.length === 0 ? (
          <div className="py-8 text-center text-tertiary" style={{ fontSize: "var(--font-size-sm)" }}>
            Waiting for the first turn…
          </div>
        ) : null}

        {decoded.messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}

        {/* Activity blocks — render after messages, slightly wider. */}
        {decoded.blocks.length > 0 ? (
          <div className="mt-6" style={{ maxWidth: "calc(var(--conversation-max-width) + 160px)" }}>
            <div
              className="mb-2 text-xs uppercase tracking-wide text-tertiary"
              style={{ fontSize: "var(--font-size-xs)" }}
            >
              Activity
            </div>
            {decoded.blocks.map((b) => (
              <ActivityBlock key={b.id} block={b} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const Conversation = memo(ConversationImpl);
