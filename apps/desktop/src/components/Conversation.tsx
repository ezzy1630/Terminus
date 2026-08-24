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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Message } from "./Message";
import { ActivityBlock } from "./ActivityBlock";
import { ReasoningTrace } from "./ReasoningTrace";
import { ApprovalCard } from "./ApprovalCard";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState, errorPreset } from "./ErrorState";
import { StatusIndicator } from "./StatusIndicator";
import { ArrowDown, ShieldAlert, MessageCircle } from "lucide-react";
import { cn } from "../lib/cn";
import {
  MAX_PRESENTATION_EVENT_CHARS,
  PRESENTATION_REJECTION_KEY,
  normalizeTaskStatus,
  useSelectedTask,
  useSelectedTaskApprovals,
  useSelectedTaskEventHistory,
  useSelectedTaskEvents,
  useTerminusStore,
} from "../hooks/use-terminus";
import type { PendingApproval } from "../lib/task-surface";
import type {
  ActivityBlock as ActivityBlockData,
  ActivityEntry,
  ConversationMessage,
  ReasoningBlock,
  ReasoningPhaseKind,
  TerminusSseEvent,
} from "../types";
import { Button } from "../ui/Button";

interface ConversationProps {
  /** Optional className override for the scroll container. */
  className?: string;
  /**
   * Optional explicit event log. Defaults to the selected task's events
   * from the store; tests and hosts can pass their own.
   */
  events?: TerminusSseEvent[];
  /** Route terminal failures to a fresh task contract. */
  onNewTask?: () => void;
}

interface DecodedFeed {
  messages: ConversationMessage[];
  blocks: ActivityBlockData[];
  reasoning: ReasoningBlock[];
  order: Array<{ kind: "message" | "block" | "reasoning"; id: string }>;
}

interface PendingToolGroup {
  title: string;
  entries: ActivityEntry[];
  startedAt: string;
}

const MAX_ACTIVITY_SUMMARY_CHARS = 512;
export const MAX_ACTIVITY_DETAIL_CHARS = 16_000;
const MAX_ACTIVITY_ENTRIES_PER_GROUP = 200;
const MAX_MESSAGE_FIELD_CHARS = 32_768;
const MAX_STREAMED_RESPONSE_CHARS = 256 * 1024;

interface PresentationRejection {
  reason: string;
  sourceEvent: string;
  characterCount: number;
  limit: number;
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: string, label: string, limit: number): string {
  if (value.length <= limit) return value;
  return `[${label} rejected: ${value.length} characters exceeds the ${limit}-character presentation limit. Inspect the immutable artifact or continuation reference.]`;
}

function presentationRejection(payload: Record<string, unknown>): PresentationRejection | null {
  const rejection = recordFrom(payload[PRESENTATION_REJECTION_KEY]);
  if (!rejection) return null;
  const reason = typeof rejection.reason === "string" ? rejection.reason : "presentation_rejected";
  const sourceEvent = typeof rejection.source_event === "string" ? rejection.source_event : "unknown";
  const characterCount = typeof rejection.character_count === "number" ? rejection.character_count : 0;
  const limit = typeof rejection.limit === "number" ? rejection.limit : MAX_PRESENTATION_EVENT_CHARS;
  return { reason, sourceEvent, characterCount, limit };
}

function artifactReference(p: Record<string, unknown>): string | null {
  const candidates = [p, recordFrom(p.result), recordFrom(p.output)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const key of ["artifact_ref", "artifact_id", "continuation", "continuation_token"] as const) {
      const value = candidate[key];
      if (typeof value === "string" && value.length > 0 && value.length <= MAX_ACTIVITY_SUMMARY_CHARS) {
        return value;
      }
    }
  }
  return null;
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
/** Prefer the payload's own timestamp; fall back to the event, then the task. */
function eventTimestamp(
  payload: Record<string, unknown>,
  event: TerminusSseEvent,
  fallback: string,
): string {
  for (const key of ["at", "started_at", "occurred_at", "timestamp"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const eventAt = (event as { at?: unknown }).at;
  return typeof eventAt === "string" && eventAt.length > 0 ? eventAt : fallback;
}

export function decodeFeed(events: TerminusSseEvent[], taskCreatedAt: string): DecodedFeed {
  const messages: ConversationMessage[] = [];
  const messageById = new Map<string, ConversationMessage>();
  const blocks: ActivityBlockData[] = [];
  const reasoning: ReasoningBlock[] = [];
  const order: DecodedFeed["order"] = [];

  let openReasoning: ReasoningBlock | null = null;
  let pendingGroup: PendingToolGroup | null = null;
  let streamingMessageId: string | null = null;
  const rejectedStreamingMessages = new Set<string>();

  const addMessage = (message: ConversationMessage): void => {
    messages.push(message);
    messageById.set(message.id, message);
    order.push({ kind: "message", id: message.id });
  };

  /** Record a turn phase. Repeats of the current phase are not new steps. */
  const notePhase = (kind: ReasoningPhaseKind, at: string): void => {
    if (!openReasoning) return;
    const last = openReasoning.phases[openReasoning.phases.length - 1];
    if (last?.kind === kind) return;
    openReasoning.phases.push({ kind, at });
  };

  const closeReasoning = (at: string): void => {
    if (!openReasoning) return;
    openReasoning.endedAt = at;
    openReasoning = null;
  };

  const flushGroup = (at: string): void => {
    if (!pendingGroup) return;
    const entries = pendingGroup.entries;
    const operations = new Map<string, ActivityEntry>();
    entries.forEach((entry, index) => {
      operations.set(entry.operationId ?? `uncorrelated:${index}`, entry);
    });
    const states = Array.from(operations.values());
    const anyFailed = states.some((entry) => entry.phase === "settled" && entry.outcome === "failed");
    const allSettled = states.length > 0 && states.every((entry) => entry.phase === "settled");
    const allSucceeded = allSettled && states.every((entry) => entry.outcome === "succeeded");
    const status: ActivityBlockData["status"] = anyFailed
      ? "failed"
      : allSucceeded
        ? "done"
        : allSettled
          ? "unknown"
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
    pendingGroup = null;
  };

  const addPresentationRejection = (ev: TerminusSseEvent, rejection: PresentationRejection): void => {
    flushGroup(ev.id);
    const block: ActivityBlockData = {
      id: `block-presentation-rejection-${ev.id}`,
      title: "Event omitted from presentation",
      metric: "Payload rejected",
      status: "failed",
      entries: [{
        tool: "presentation",
        summary: `Oversized ${rejection.sourceEvent} event rejected`,
        detail: `${rejection.characterCount} characters exceeded the ${rejection.limit}-character presentation limit (${rejection.reason}). Use the immutable task snapshot or artifact reference to inspect the source payload.`,
        at: taskCreatedAt,
        phase: "settled",
        outcome: "failed",
      }],
    };
    blocks.push(block);
    order.push({ kind: "block", id: block.id });
  };

  const appendStreamContent = (message: ConversationMessage, value: string): void => {
    if (rejectedStreamingMessages.has(message.id)) return;
    if (message.content.length + value.length <= MAX_STREAMED_RESPONSE_CHARS) {
      message.content += value;
      return;
    }
    message.content += `\n\n[Streaming response rejected after ${message.content.length} characters because the next ${value.length}-character chunk exceeded the ${MAX_STREAMED_RESPONSE_CHARS}-character presentation limit. Inspect the immutable response artifact or continuation reference.]`;
    rejectedStreamingMessages.add(message.id);
  };

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const rawData = typeof ev.data === "string"
      ? ev.data
      : typeof (ev as unknown as { payload?: unknown }).payload === "object" && (ev as unknown as { payload?: unknown }).payload !== null
        ? JSON.stringify((ev as unknown as { payload?: unknown }).payload)
        : "";
    if (rawData.length > MAX_PRESENTATION_EVENT_CHARS) {
      addPresentationRejection(ev, {
        reason: "event_payload_too_large",
        sourceEvent: ev.event || "unknown",
        characterCount: rawData.length,
        limit: MAX_PRESENTATION_EVENT_CHARS,
      });
      continue;
    }
    let payload: unknown;
    try {
      payload = typeof (ev as unknown as { payload?: unknown }).payload === "object" && (ev as unknown as { payload?: unknown }).payload !== null
        ? (ev as unknown as { payload?: unknown }).payload
        : rawData.length > 0 ? JSON.parse(rawData) as unknown : null;
    } catch {
      continue;
    }
    const p = recordFrom(payload);
    if (!p) continue;
    const rejection = presentationRejection(p);
    if (rejection) {
      addPresentationRejection(ev, rejection);
      continue;
    }

    switch (ev.event) {
      case "turn.started": {
        // Flush any in-flight group, then open a new user message.
        flushGroup(ev.id);
        const userInput = typeof p.user_input === "string"
          ? boundedText(p.user_input, "User input", MAX_MESSAGE_FIELD_CHARS)
          : "";
        const at = typeof p.started_at === "string" ? p.started_at : taskCreatedAt;
        const userMessage: ConversationMessage = {
          id: `user-${ev.id}`,
          role: "user",
          content: userInput,
          createdAt: at,
        };
        addMessage(userMessage);
        // The trace sits between the prompt and the reply, which is where the
        // wait actually happens.
        closeReasoning(at);
        openReasoning = { id: `reasoning-${ev.id}`, phases: [], startedAt: at, endedAt: null };
        reasoning.push(openReasoning);
        order.push({ kind: "reasoning", id: openReasoning.id });
        // Begin an empty agent message that we'll stream into.
        streamingMessageId = `agent-${ev.id}`;
        const agentMessage: ConversationMessage = {
          id: streamingMessageId,
          role: "agent",
          content: "",
          createdAt: at,
          streaming: true,
        };
        addMessage(agentMessage);
        break;
      }
      case "turn.completed": {
        // The control plane's current adapter returns its concise final
        // response on turn.completed rather than streaming deltas. Preserve
        // streamed content when present, but never leave a completed turn
        // with an empty assistant message.
        if (streamingMessageId) {
          const m = messageById.get(streamingMessageId);
          const summary = typeof p.summary === "string"
            ? boundedText(p.summary, "Completion summary", MAX_MESSAGE_FIELD_CHARS)
            : null;
          if (m) {
            if (m.content.length === 0 && summary) m.content = summary;
            m.streaming = false;
          }
        }
        streamingMessageId = null;
        closeReasoning(eventTimestamp(p, ev, taskCreatedAt));
        flushGroup(ev.id);
        break;
      }
      case "turn.context_compiling": {
        notePhase("context_compiling", eventTimestamp(p, ev, taskCreatedAt));
        break;
      }
      case "turn.finalizing": {
        notePhase("finalizing", eventTimestamp(p, ev, taskCreatedAt));
        break;
      }
      case "turn.response_validating": {
        notePhase("response_validating", eventTimestamp(p, ev, taskCreatedAt));
        // Keep the response live through tool settlement. The final summary
        // is emitted with turn.completed by the existing control-plane
        // contract.
        break;
      }
      case "turn.provider_running": {
        notePhase("provider_running", eventTimestamp(p, ev, taskCreatedAt));
        // Some payloads carry a `delta` text chunk or a `response` block.
        if (streamingMessageId) {
          const m = messageById.get(streamingMessageId);
          if (m) {
            const delta = typeof p.delta === "string" ? p.delta : null;
            const response = typeof p.response === "string" ? p.response : null;
            if (delta) appendStreamContent(m, delta);
            else if (response && m.content.length === 0) appendStreamContent(m, response);
          }
        }
        break;
      }
      case "tool.proposed":
      case "tool.authorized":
      case "tool.settled":
      case "tool.failed": {
        const tool = typeof p.tool === "string"
          ? p.tool
          : typeof p.toolId === "string"
            ? p.toolId
            : typeof p.tool_id === "string"
              ? p.tool_id
              : "tool";
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
        const phase: ActivityEntry["phase"] = ev.event === "tool.proposed"
          ? "proposed"
          : ev.event === "tool.authorized"
            ? "authorized"
            : "settled";
        const operationId = [p.toolCallId, p.tool_call_id, p.effect_id]
          .find((value): value is string => typeof value === "string" && value.length > 0);
        const entry: ActivityEntry = {
          tool,
          summary,
          at,
          detail: detailForTool(p),
          phase,
          ...(phase === "settled" ? { outcome: ev.event === "tool.failed" ? "failed" : settlementOutcome(p) } : {}),
          ...(operationId ? { operationId } : {}),
        };
        if (pendingGroup.entries.length < MAX_ACTIVITY_ENTRIES_PER_GROUP) {
          pendingGroup.entries.push(entry);
        } else if (pendingGroup.entries.length === MAX_ACTIVITY_ENTRIES_PER_GROUP) {
          pendingGroup.entries.push({
            tool: "presentation",
            summary: "Additional activity entries rejected from this group",
            detail: `The group exceeded the ${MAX_ACTIVITY_ENTRIES_PER_GROUP}-entry presentation limit. Inspect the immutable task event artifact or continue from its event cursor.`,
            at,
            phase: "settled",
            outcome: "unknown",
          });
        }
        break;
      }
      case "task.completed":
      case "task.failed":
      case "task.interrupted": {
        closeReasoning(eventTimestamp(p, ev, taskCreatedAt));
        flushGroup(ev.id);
        if (streamingMessageId) {
          const m = messageById.get(streamingMessageId);
          if (m) {
            if (m.content.length === 0 && ev.event === "task.failed") {
              m.content = "The task stopped before Terminus could respond. Start a new task to try again.";
            } else if (m.content.length === 0 && ev.event === "task.interrupted") {
              m.content = "The task was stopped before Terminus could respond.";
            }
            m.streaming = false;
          }
        }
        break;
      }
      case "task.blocked": {
        flushGroup(ev.id);
        if (streamingMessageId) {
          const message = messageById.get(streamingMessageId);
          if (message) message.streaming = false;
        }
        const reason = typeof p.reason === "string" ? p.reason : "runtime_blocked";
        const error = typeof p.error === "string"
          ? boundedText(p.error, "Runtime error detail", MAX_ACTIVITY_DETAIL_CHARS)
          : "The runtime could not continue this task.";
        const providerUnavailable = reason === "provider_transport_unavailable";
        const block: ActivityBlockData = {
          id: `block-${ev.id}`,
          title: providerUnavailable ? "Provider transport unavailable" : "Runtime blocked",
          metric: "Action required",
          status: "failed",
          entries: [{
            tool: providerUnavailable ? "provider" : "runtime",
            summary: providerUnavailable
              ? "Configure provider transport, then send a follow-up to retry."
              : "Resolve the runtime blocker before retrying.",
            detail: error,
            at: taskCreatedAt,
            phase: "settled",
            outcome: "failed",
          }],
        };
        blocks.push(block);
        order.push({ kind: "block", id: block.id });
        streamingMessageId = null;
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
    return { messages, blocks, reasoning, order };
  }

  return { messages, blocks, reasoning, order };
}

function summarizeToolPayload(eventName: string, p: Record<string, unknown>): string {
  const args = p.args_summary ?? p.args;
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const path = typeof a.path === "string" ? a.path : null;
    const program = typeof a.program === "string" ? a.program : null;
    if (path) return boundedText(path, "Tool path", MAX_ACTIVITY_SUMMARY_CHARS);
    if (program) return boundedText(program, "Tool program", MAX_ACTIVITY_SUMMARY_CHARS);
  }
  if (typeof args === "string") return boundedText(args, "Tool arguments", MAX_ACTIVITY_SUMMARY_CHARS);
  switch (eventName) {
    case "tool.proposed": return "proposed";
    case "tool.authorized": return "authorized";
    case "tool.settled": {
      const summary = p.summary;
      const status = p.result_status ?? p.status;
      if (typeof summary === "string" && typeof status === "string") {
        return boundedText(`${status}: ${summary}`, "Tool summary", MAX_ACTIVITY_SUMMARY_CHARS);
      }
      if (typeof summary === "string") return boundedText(summary, "Tool summary", MAX_ACTIVITY_SUMMARY_CHARS);
      return typeof status === "string"
        ? boundedText(status, "Tool status", MAX_ACTIVITY_SUMMARY_CHARS)
        : "settled";
    }
    default: return eventName;
  }
}

function settlementOutcome(p: Record<string, unknown>): ActivityEntry["outcome"] {
  const raw = [p.result_status, p.resultStatus, p.status]
    .find((value): value is string => typeof value === "string")
    ?.trim()
    .toLowerCase();
  if (!raw) return "unknown";
  if (["success", "succeeded", "settled", "completed", "passed", "ok"].includes(raw)) return "succeeded";
  if (["failed", "error", "denied", "rejected", "cancelled", "canceled", "interrupted"].includes(raw)) return "failed";
  return "unknown";
}

function detailForTool(p: Record<string, unknown>): string | undefined {
  const out = p.result_summary ?? p.output_summary ?? p.result;
  if (typeof out === "string") return boundedText(out, "Tool detail", MAX_ACTIVITY_DETAIL_CHARS);
  if (out && typeof out === "object") {
    const reference = artifactReference(p);
    return reference
      ? `Structured tool result omitted from the presentation. Inspect immutable artifact or continuation reference: ${reference}`
      : "Structured tool result omitted from the presentation. No immutable artifact or continuation reference was supplied.";
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
    const passed = entries.filter((entry) => entry.phase === "settled" && entry.outcome === "succeeded").length;
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
  | { kind: "block"; block: ActivityBlockData }
  | { kind: "reasoning"; reasoning: ReasoningBlock };

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
  // One quiet line collapsed, a short list expanded.
  if (item.kind === "reasoning") return 26;
  if (item.kind === "message") {
    // User messages are short. Agent messages with code blocks are
    // taller — 120 is a reasonable middle ground.
    return item.message.role === "user" ? 80 : 120;
  }
  // Activity block collapsed header is 40px. Expanded can be 200px+.
  return 40;
}

function lastItemGrowthKey(items: readonly FeedItem[]): string {
  const item = items[items.length - 1];
  if (!item) return "empty";
  if (item.kind === "reasoning") {
    return `${item.reasoning.id}:${item.reasoning.phases.length}:${item.reasoning.endedAt ?? "running"}`;
  }
  if (item.kind === "message") {
    return `${item.message.id}:${item.message.content.length}:${item.message.streaming ? "streaming" : "settled"}`;
  }
  const detailSize = item.block.entries.reduce(
    (total, entry) => total + entry.summary.length + (entry.detail?.length ?? 0),
    0,
  );
  return `${item.block.id}:${item.block.status}:${item.block.entries.length}:${detailSize}`;
}

function feedItemKey(item: FeedItem): string {
  if (item.kind === "message") return `message:${item.message.id}`;
  if (item.kind === "reasoning") return `reasoning:${item.reasoning.id}`;
  return `block:${item.block.id}`;
}

function FeedItemView({ item }: { item: FeedItem }): JSX.Element {
  if (item.kind === "reasoning") return <ReasoningTrace block={item.reasoning} />;
  return item.kind === "message" ? (
    <Message message={item.message} />
  ) : (
    <div style={{ maxWidth: "calc(var(--conversation-max-width) + 40px)" }}>
      <ActivityBlock block={item.block} />
    </div>
  );
}

const ACCESSIBLE_TRANSCRIPT_PAGE_SIZE = 100;

function ConversationImpl({ className, events: eventsProp, onNewTask }: ConversationProps): JSX.Element {
  const task = useSelectedTask();
  const storeEvents = useSelectedTaskEvents();
  const events = eventsProp ?? storeEvents;
  const streamState = useTerminusStore((state) => state.streamState);
  const healthStatus = useTerminusStore((state) => state.healthStatus);
  const acknowledgeApprovalResolution = useTerminusStore((state) => state.acknowledgeApprovalResolution);
  const loadMoreApprovals = useTerminusStore((state) => state.loadMoreApprovals);
  const lastEventId = events[events.length - 1]?.id;

  const decoded = useMemo(() => {
    if (!task) return { messages: [], blocks: [], reasoning: [], order: [] } satisfies DecodedFeed;
    return decodeFeed(events, task.created_at);
    // Recompute when the events list grows OR the task changes. The last
    // event id is included so streaming appends trigger a re-decode.
  }, [events, task?.id, events.length, lastEventId]);
  const approvalResource = useSelectedTaskApprovals();
  const eventHistory = useSelectedTaskEventHistory();
  const approvals = approvalResource.approvals;

  // Build the flattened feed items list.
  const items = useMemo<FeedItem[]>(() => {
    const messages = new Map(decoded.messages.map((message) => [message.id, message]));
    const blocks = new Map(decoded.blocks.map((block) => [block.id, block]));
    const traces = new Map(decoded.reasoning.map((trace) => [trace.id, trace]));
    const out: FeedItem[] = [];
    for (const entry of decoded.order) {
      if (entry.kind === "message") {
        const message = messages.get(entry.id);
        if (message) out.push({ kind: "message", message });
      } else if (entry.kind === "reasoning") {
        const trace = traces.get(entry.id);
        // A settled turn that reported no phases has nothing to show. Keeping
        // the row would contribute an empty listitem to the collection counts
        // and to aria-setsize while rendering nothing.
        if (trace && (trace.endedAt === null || trace.phases.length > 0)) {
          out.push({ kind: "reasoning", reasoning: trace });
        }
      } else {
        const block = blocks.get(entry.id);
        if (block) out.push({ kind: "block", block });
      }
    }
    return out;
  }, [decoded]);
  const growthKey = useMemo(() => lastItemGrowthKey(items), [items]);

  // Auto-scroll to bottom on new events, but only if the user is already
  // near the bottom (so we don't yank them while reading history).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const [hasUnseenUpdates, setHasUnseenUpdates] = useState(false);
  const [fullTranscript, setFullTranscript] = useState(false);
  const [transcriptPage, setTranscriptPage] = useState(0);
  const transcriptPageCount = Math.max(1, Math.ceil(items.length / ACCESSIBLE_TRANSCRIPT_PAGE_SIZE));
  const transcriptStart = Math.min(
    transcriptPage * ACCESSIBLE_TRANSCRIPT_PAGE_SIZE,
    Math.max(0, items.length - 1),
  );
  const transcriptEnd = Math.min(items.length, transcriptStart + ACCESSIBLE_TRANSCRIPT_PAGE_SIZE);
  const transcriptItems = fullTranscript ? items.slice(transcriptStart, transcriptEnd) : [];

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

  // Stick to bottom when the feed grows AND the user was at the bottom.
  // Content length is part of the key because streaming deltas mutate the
  // current message without adding a new row.
  const lastGrowthKeyRef = useRef(growthKey);
  useEffect(() => {
    setFullTranscript(false);
    setTranscriptPage(0);
    stickRef.current = true;
    setHasUnseenUpdates(false);
    lastGrowthKeyRef.current = growthKey;
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    else if (scrollRef.current) scrollRef.current.scrollTop = 0;
    // This reset is intentionally keyed only to task identity. New events
    // must preserve a reader's current stick/scroll decision.
  }, [task?.id]);

  useEffect(() => {
    setTranscriptPage((current) => Math.min(current, transcriptPageCount - 1));
  }, [transcriptPageCount]);

  useEffect(() => {
    if (growthKey === lastGrowthKeyRef.current) return;
    lastGrowthKeyRef.current = growthKey;
    if (!stickRef.current || items.length === 0) {
      if (items.length > 0) setHasUnseenUpdates(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (fullTranscript) {
        const element = scrollRef.current;
        if (element) element.scrollTop = element.scrollHeight;
      } else {
        virtualizer.measure();
        virtualizer.scrollToIndex(items.length - 1, { align: "end" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fullTranscript, growthKey, items.length, virtualizer]);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distFromBottom < 80;
    if (stickRef.current) setHasUnseenUpdates(false);
  }, []);

  const jumpToLatest = useCallback((): void => {
    stickRef.current = true;
    setHasUnseenUpdates(false);
    if (fullTranscript) {
      const element = scrollRef.current;
      if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
      return;
    }
    virtualizer.measure();
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end", behavior: "smooth" });
  }, [fullTranscript, items.length, virtualizer]);

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
    if (last.kind === "reasoning") {
      return last.reasoning.endedAt === null ? "Terminus is thinking" : "Terminus finished thinking";
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

  const normalizedStatus = normalizeTaskStatus(task.status);
  const blockedByProvider = task.status === "BLOCKED"
    && task.terminal_reason?.reason === "provider_transport_unavailable";
  const emptyState = (() => {
    switch (normalizedStatus) {
      case "queued": return { title: "Queued", description: "Work will begin when the runtime is ready." };
      case "waiting": return blockedByProvider
        ? {
            title: "Provider transport unavailable",
            description: "Configure provider transport in the control plane, then send a follow-up to retry this task.",
          }
        : { title: "Waiting for input", description: "The task will continue as soon as the required input is available." };
      case "needs_approval": return { title: "Approval required", description: "Review the pending approval before the task can continue." };
      case "needs_review": return { title: "Review required", description: "Review the pending changes before the task can continue." };
      case "done": return { title: "Task complete", description: "The task completed without conversation items in this bounded view." };
      case "interrupted": return { title: "Task stopped", description: "The task was aborted before producing conversation items." };
      case "unknown": return { title: "Status unavailable", description: "Refresh the task snapshot before relying on this empty view." };
      case "failed": return null;
      case "working": return { title: "Preparing the first turn", description: "The conversation will appear here as the agent starts working." };
    }
  })();

  return (
    <div className={cn("relative h-full", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scrollable conversation-scroll h-full overflow-x-hidden overflow-y-auto"
        style={{ padding: "16px 24px 48px" }}
      >
      {/* Polite live region — announces new messages for screen readers. */}
      <div aria-live="polite" aria-atomic="false" style={{ position: "absolute", left: -9999, width: 1, height: 1, overflow: "hidden" }}>
        {liveMessage}
      </div>
      {/* Reading column. Prose stays narrow; blocks expand wider.
          Per SPEC §9.1: comfortable centered reading column. */}
      <div
        className="feed-column"
        style={{
          maxWidth: "var(--content-width)",
          margin: "0 auto",
        }}
      >
        {items.length > ACCESSIBLE_TRANSCRIPT_PAGE_SIZE || eventHistory ? (
          <div className="mb-4 flex justify-end">
            <Button
              type="button"
              onClick={() => {
                setTranscriptPage(0);
                setFullTranscript((current) => !current);
              }}
              aria-pressed={fullTranscript}
              className="rounded-md px-2 py-1 text-xs text-tertiary hover:bg-hover hover:text-primary"
              data-tooltip={fullTranscript
                ? "Return to the high-performance windowed conversation"
                : "Render every loaded conversation item for sequential assistive-technology navigation"}
            >
              {fullTranscript ? "Use windowed feed" : "Read all loaded items"}
            </Button>
          </div>
        ) : null}

        {eventHistory ? (
          <div
            className="mb-4 border-l-2 border-warning/55 px-3 py-1.5 text-xs text-secondary"
            role="status"
          >
            <div className="flex items-start gap-2">
              <ShieldAlert size={13} className="mt-0.5 flex-none text-warning" aria-hidden />
              <div className="min-w-0">
                <p className="font-medium text-primary">
                  {eventHistory.reason === "cursor_expired"
                    ? "Live history has a retention gap"
                    : eventHistory.reason === "global_lru"
                      ? `${eventHistory.globalEvictedCount ?? eventHistory.omittedCount ?? "Earlier"} events evicted by the global presentation budget`
                      : `${eventHistory.omittedCount ?? "Earlier"} events omitted from this bounded view`}
                </p>
                <p className="mt-0.5">
                  {eventHistory.reconciliation === "pending"
                    ? "Reconciling the task and approval snapshots before treating current state as authoritative."
                    : eventHistory.reconciliation === "error"
                      ? `Snapshot reconciliation failed: ${eventHistory.error ?? "unknown error"}`
                      : "Current task and approval state is snapshot-backed; the earlier presentation history remains omitted."}
                </p>
                {eventHistory.continuationCursor ? (
                  <p className="mt-1 break-all font-mono text-tertiary">
                    Earliest retained cursor: {eventHistory.continuationCursor}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {/* Empty state.

            Suppressed while the control plane is offline. Both states were
            rendering at once, and "reconnecting, will resume from the last
            event" is not true when the service itself is down — the offline
            banner is the authority in that case. */}
        {streamState === "reconnecting" && healthStatus !== "offline" ? (
          <ErrorState
            {...errorPreset("reconnecting")}
            compact
            className="mb-4 rounded-md border border-subtle bg-elevated"
          />
        ) : null}
        {items.length === 0 && blockedByProvider ? (
          <div className="mb-4 flex items-start gap-3 border-b border-subtle py-4" role="status">
            <StatusIndicator status="waiting" size={10} />
            <div>
              <p className="text-sm font-medium text-primary">Provider transport unavailable</p>
              <p className="mt-1 text-sm text-secondary">Configure provider transport in the control plane, then send a follow-up to retry this task.</p>
            </div>
          </div>
        ) : items.length === 0 && normalizedStatus === "failed" ? (
          <ErrorState
            {...errorPreset("failedTask")}
            action={onNewTask ? { label: "New task", onClick: onNewTask } : undefined}
            compact
            className="conversation-terminal-state"
          />
        ) : items.length === 0 && emptyState ? (
          <div className="grid min-h-40 place-items-center text-center">
            <div className="max-w-sm">
              <h2 className="ui-page-title text-primary">
                {normalizedStatus === "working" ? "Ready when you are" : emptyState.title}
              </h2>
              <p className="ui-body mt-1 text-tertiary">
                {normalizedStatus === "working" ? "Send a message to start this task." : emptyState.description}
              </p>
            </div>
          </div>
        ) : null}

        {fullTranscript ? (
          <div>
            <div className="mb-3 flex items-center justify-between gap-3 text-xs text-secondary" aria-label="Loaded conversation page controls">
              <Button
                type="button"
                onClick={() => setTranscriptPage((page) => Math.max(0, page - 1))}
                disabled={transcriptPage === 0}
                className="rounded-md border border-subtle px-2 py-1 hover:bg-hover disabled:opacity-40"
              >
                Previous loaded items
              </Button>
              <span className="font-mono text-tertiary">
                {items.length === 0 ? "0 items" : `${transcriptStart + 1}-${transcriptEnd} of ${items.length} loaded items`}
              </span>
              <Button
                type="button"
                onClick={() => setTranscriptPage((page) => Math.min(transcriptPageCount - 1, page + 1))}
                disabled={transcriptPage >= transcriptPageCount - 1}
                className="rounded-md border border-subtle px-2 py-1 hover:bg-hover disabled:opacity-40"
              >
                Next loaded items
              </Button>
            </div>
            <div
              role="list"
              aria-label={`All loaded conversation items (${transcriptStart + 1}-${transcriptEnd} of ${items.length})`}
              aria-describedby={eventHistory ? "conversation-history-boundary" : undefined}
              aria-busy={streamState === "connecting" || streamState === "reconnecting"}
            >
              {transcriptItems.map((item, index) => (
                <div
                  key={feedItemKey(item)}
                  role="listitem"
                  aria-posinset={transcriptStart + index + 1}
                  aria-setsize={items.length}
                >
                  <FeedItemView item={item} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Windowed feed. Collection metadata preserves a row's position;
             the full-transcript control above exposes all loaded rows to AT. */
          <div
            role="list"
            aria-label={`Conversation feed (${items.length} loaded items)`}
            aria-busy={streamState === "connecting" || streamState === "reconnecting"}
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
                  key={feedItemKey(item)}
                  role="listitem"
                  aria-posinset={vi.index + 1}
                  aria-setsize={items.length}
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
                  <FeedItemView item={item} />
                </div>
              );
            })}
          </div>
        )}

        {approvals.length > 0 ? (
          <PendingApprovalsBlock
            approvals={approvals}
            freshness={approvalResource.status}
            error={approvalResource.error}
            page={approvalResource.page}
            onLoadMore={() => void loadMoreApprovals(task.id)}
            onResolved={(approvalId) => {
              if (task) acknowledgeApprovalResolution(task.id, approvalId);
            }}
            onExpired={() => void useTerminusStore.getState().refreshApprovals(task.id)}
          />
        ) : approvalResource.status !== "ready" ? (
          <ApprovalReconciliationState
            status={approvalResource.status}
            error={approvalResource.error}
            onRetry={() => {
              if (task) void useTerminusStore.getState().refreshApprovals(task.id);
            }}
          />
        ) : null}
      </div>
      </div>
      {hasUnseenUpdates ? (
        <Button
          type="button"
          onClick={jumpToLatest}
          variant="secondary"
          size="sm"
          leading={<ArrowDown size={12} aria-hidden />}
          className="surface-enter absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
          aria-label="Jump to latest conversation update"
        >
          Latest
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Pinned approval interrupt surface (SPEC §17).
 *
 * Approvals are inline — never a modal — but they must not be missable:
 * the block is `position: sticky` at the bottom of the feed so it stays
 * on screen regardless of scroll position, and an assertive live region
 * announces that the task is blocked on a decision. The block clears as
 * soon as each approval is resolved.
 */
function PendingApprovalsBlock({
  approvals,
  freshness,
  error,
  page,
  onLoadMore,
  onResolved,
  onExpired,
}: {
  approvals: PendingApproval[];
  freshness: "loading" | "ready" | "stale" | "error";
  error: string | null;
  page: { nextCursor: string | null; total: number | null; loadingMore: boolean; error: string | null };
  onLoadMore: () => void;
  onResolved: (approvalId: string) => void;
  onExpired: () => void;
}): JSX.Element {
  const count = approvals.length;
  const total = Math.max(count, page.total ?? count);
  const countLabel = count < total
    ? `${count} of ${total} approvals loaded`
    : count === 1
      ? "Approval required"
      : `${count} approvals required`;
  return (
    <div
      className="mt-4 flex flex-col gap-3"
      style={{ position: "sticky", bottom: 0, paddingTop: 8 }}
      data-testid="pending-approvals"
    >
      <div
        aria-live="assertive"
        role="alert"
        style={{ position: "absolute", left: -9999, width: 1, height: 1, overflow: "hidden" }}
      >
        {count < total
          ? `${total} approvals required before the task can continue; ${count} loaded`
          : count === 1
          ? `Approval required: ${approvals[0]?.action ?? ""}`
          : `${count} approvals required before the task can continue`}
      </div>
      <div
        className="flex items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 text-xs"
        style={{ borderColor: "color-mix(in srgb, var(--color-warning) 45%, var(--border-default))", background: "color-mix(in srgb, var(--color-warning) 9%, var(--bg-elevated))" }}
      >
        <ShieldAlert size={12} style={{ color: "var(--color-warning)" }} aria-hidden />
        <span className="font-medium text-secondary" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {countLabel}
        </span>
        <span className="ml-auto font-mono text-tertiary">awaiting decision</span>
      </div>
      {freshness !== "ready" ? (
        <p className="border-x border-default bg-elevated px-3 py-2 text-xs text-warning" role="status">
          {freshness === "loading"
            ? "Reconciling approval state. Decisions are disabled until the control plane confirms this snapshot."
            : freshness === "stale"
              ? `Last-confirmed approval snapshot is stale. Decisions are disabled${error ? `: ${error}` : "."}`
              : `Approval state could not be confirmed. Event-derived requests may be incomplete and decisions are disabled${error ? `: ${error}` : "."}`}
        </p>
      ) : null}
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          id={approval.id}
          action={approval.action}
          operationHash={approval.operationHash ?? ""}
          operation={approval.operation}
          reason={approval.reason ?? "The task needs your permission before this effect can continue."}
          risk={approval.risk}
          scope={approval.scope}
          affectedEnvironment={approval.environment}
          requestedAt={approval.requestedAt}
          expiresAt={approval.expiresAt}
          canPersist={approval.canPersist}
          supportedDecisions={approval.supportedDecisions}
          authorizationReady={approval.authorizationReady}
          decisionsEnabled={freshness === "ready" && Boolean(approval.operationHash)}
          onResolved={() => onResolved(approval.id)}
          onExpired={onExpired}
        />
      ))}
      {page.nextCursor ? (
        <div className="rounded-b-md border border-default bg-elevated px-3 py-2">
          <Button
            type="button"
            onClick={onLoadMore}
            disabled={page.loadingMore || freshness !== "ready"}
            className="rounded-md px-2 py-1 text-xs font-medium text-secondary hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-45"
          >
            {page.loadingMore ? "Loading more approvals…" : page.error ? "Retry loading approvals" : `Load more approvals${page.total === null ? "" : ` (${approvals.length} of ${page.total})`}`}
          </Button>
          {page.error ? <p role="alert" className="mt-1 text-xs text-error">{page.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function ApprovalReconciliationState({
  status,
  error,
  onRetry,
}: {
  status: "loading" | "stale" | "error";
  error: string | null;
  onRetry: () => void;
}): JSX.Element | null {
  if (status !== "loading") {
    return (
      <div
        role="alert"
        data-testid="approval-reconciliation-state"
        className="mt-4 flex items-center gap-2 rounded-md bg-warning/7 px-3 py-2 text-xs text-secondary"
      >
        <ShieldAlert size={13} className="flex-none text-warning" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{error ?? "Approval state could not be refreshed."}</span>
        <Button type="button" size="sm" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  return (
    <div
      role="status"
      data-testid="approval-reconciliation-state"
      className="mt-4 flex items-center gap-2 px-3 py-2 text-xs text-secondary"
    >
      <ShieldAlert size={13} className="text-tertiary" aria-hidden />
      <span className="min-w-0 flex-1">Checking the control plane for pending approvals.</span>
    </div>
  );
}

export const Conversation = memo(ConversationImpl);
