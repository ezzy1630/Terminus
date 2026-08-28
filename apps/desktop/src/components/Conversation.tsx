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
import { turnInputPlaceholder, type TurnInputMap } from "../lib/turn-input";
import { useTurnInputs } from "../hooks/use-turn-inputs";
import { lifecycleFromTask } from "../lib/task-lifecycle";
import {
  MAX_PRESENTATION_EVENT_CHARS,
  PRESENTATION_REJECTION_KEY,
  useSelectedTask,
  useSelectedTaskApprovals,
  useSelectedTaskEventHistory,
  useSelectedTaskTranscript,
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

/**
 * How a terminal turn event reads in the feed.
 *
 * `tone` separates a failure from an expected end. A run the user stopped, or
 * one superseded by their own next message, is the result of something they
 * just did — reporting it in red as an incident is wrong.
 */
interface TurnOutcome {
  readonly title: string;
  readonly metric: string;
  readonly message: string;
  readonly tone: "failed" | "neutral";
}

const TURN_OUTCOME_FALLBACK: TurnOutcome = {
  title: "Turn ended",
  metric: "Ended",
  message: "This turn ended before Terminus could respond.",
  tone: "failed",
};

const TURN_OUTCOMES: Record<string, TurnOutcome> = {
  "turn.failed": {
    title: "Turn failed",
    metric: "Failed",
    message: "This turn failed before Terminus could respond.",
    tone: "failed",
  },
  "turn.aborted": {
    title: "Turn stopped",
    metric: "Stopped",
    message: "You stopped this turn.",
    tone: "neutral",
  },
  "turn.interrupted": {
    title: "Turn interrupted",
    metric: "Interrupted",
    message: "This turn was interrupted before Terminus could respond.",
    tone: "neutral",
  },
  "turn.superseded": {
    title: "Turn superseded",
    metric: "Superseded",
    message: "A newer message replaced this turn.",
    tone: "neutral",
  },
  "turn.blocked": {
    title: "Turn blocked",
    metric: "Action required",
    message: "This turn is blocked and cannot continue on its own.",
    tone: "failed",
  },
  "turn.needs_user_input": {
    title: "Waiting for you",
    metric: "Needs input",
    message: "Terminus needs something from you before it can continue.",
    tone: "failed",
  },
  "turn.budget_exhausted": {
    title: "Budget exhausted",
    metric: "Out of budget",
    message: "This turn ran out of its step, token or cost budget.",
    tone: "failed",
  },
  "turn.policy_denied": {
    title: "Policy denied this turn",
    metric: "Denied",
    message: "Policy denied this turn before it could finish.",
    tone: "failed",
  },
  "turn.recovery_failed": {
    title: "Recovery failed",
    metric: "Failed",
    message: "Terminus could not recover this turn after an interruption.",
    tone: "failed",
  },
  "turn.recovery_interrupted": {
    title: "Recovery interrupted",
    metric: "Interrupted",
    message: "Recovery of this turn was interrupted.",
    tone: "neutral",
  },
};

/** The tool a payload names, across the snake_case and camelCase spellings. */
function toolIdentity(p: Record<string, unknown>): string | null {
  for (const key of ["tool_id", "toolId", "tool"] as const) {
    const value = p[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * The identity that every phase of one tool call shares. `provider_call_id` is
 * the one the control plane puts on both the proposal and the settlement.
 */
function toolCallIdentity(p: Record<string, unknown>): string | null {
  for (const key of ["provider_call_id", "providerCallId", "tool_call_id", "toolCallId"] as const) {
    const value = p[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Push an entry, or the one-time notice that the group hit its cap. */
function appendToolEntry(group: PendingToolGroup, entry: ActivityEntry, at: string): boolean {
  if (group.entries.length < MAX_ACTIVITY_ENTRIES_PER_GROUP) {
    group.entries.push(entry);
    return true;
  }
  if (group.entries.length === MAX_ACTIVITY_ENTRIES_PER_GROUP) {
    group.entries.push({
      tool: "presentation",
      summary: "Additional activity entries rejected from this group",
      detail: `The group exceeded the ${MAX_ACTIVITY_ENTRIES_PER_GROUP}-entry presentation limit. Inspect the immutable task event artifact or continue from its event cursor.`,
      at,
      phase: "settled",
      outcome: "unknown",
    });
  }
  return false;
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
/**
 * When an event happened.
 *
 * Most control-plane payloads carry no timestamp at all, so this used to fall
 * all the way through to the task's creation time — every step of a turn that
 * ran for ten minutes was stamped with the moment the task was created, and
 * the activity list read as if everything had happened at once. The SSE event
 * id is `<16-digit-ms>-<8-digit-seq>` (see the control plane's `nextEventId`),
 * so the wall-clock time is on the wire for every event; it just was not being
 * read.
 */
function eventTimestamp(
  payload: Record<string, unknown>,
  event: TerminusSseEvent,
  fallback: string,
): string {
  for (const key of ["at", "started_at", "settled_at", "proposed_at", "occurred_at", "timestamp"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const eventAt = (event as { at?: unknown }).at;
  if (typeof eventAt === "string" && eventAt.length > 0) return eventAt;
  return timestampFromEventId(event.id) ?? fallback;
}

/** The millisecond prefix of a monotonic event id, as an ISO timestamp. */
function timestampFromEventId(id: string | undefined): string | null {
  if (typeof id !== "string") return null;
  const separator = id.indexOf("-");
  if (separator !== 16) return null;
  const millis = Number(id.slice(0, 16));
  if (!Number.isSafeInteger(millis) || millis <= 0) return null;
  const at = new Date(millis);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export function decodeFeed(
  events: TerminusSseEvent[],
  taskCreatedAt: string,
  turnInputs: TurnInputMap = new Map(),
): DecodedFeed {
  const messages: ConversationMessage[] = [];
  const messageById = new Map<string, ConversationMessage>();
  const blocks: ActivityBlockData[] = [];
  const reasoning: ReasoningBlock[] = [];
  const order: DecodedFeed["order"] = [];

  let openReasoning: ReasoningBlock | null = null;
  let pendingGroup: PendingToolGroup | null = null;
  let streamingMessageId: string | null = null;
  const rejectedStreamingMessages = new Set<string>();
  /** Blocks built from tool groups, whose status/metric are derived at the end. */
  const toolGroupBlocks: ActivityBlockData[] = [];
  /**
   * Open tool calls, keyed by the provider call id that every phase of a call
   * carries. The control plane reports one tool call as `tool.proposed` (which
   * names the tool) and later `tool.settled`/`tool.failed`/`tool.denied` (which
   * carry the outcome and the human summary but *not* the tool id). Without
   * this join the two halves landed as two rows named "tool" in two separate
   * groups, which is why the transcript never showed a legible tool call.
   */
  const toolEntryByCallId = new Map<string, ActivityEntry>();
  /** The reply this turn will produce, held until it has something to say. */
  let pendingAgentMessage: { id: string; at: string } | null = null;

  const addMessage = (message: ConversationMessage): void => {
    messages.push(message);
    messageById.set(message.id, message);
    order.push({ kind: "message", id: message.id });
  };

  /**
   * Open the current turn's reply at the point it first has content, closing
   * any open tool group first so the reply reads below the work it describes.
   */
  const openAgentMessage = (): ConversationMessage | null => {
    if (streamingMessageId) return messageById.get(streamingMessageId) ?? null;
    if (!pendingAgentMessage) return null;
    flushGroup();
    const message: ConversationMessage = {
      id: pendingAgentMessage.id,
      role: "agent",
      content: "",
      createdAt: pendingAgentMessage.at,
      streaming: true,
    };
    streamingMessageId = message.id;
    pendingAgentMessage = null;
    addMessage(message);
    return message;
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

  /**
   * Close the open tool group into a block.
   *
   * Status and metric are *not* computed here. A tool call is reported across
   * several events, and settlement can land after the group has already been
   * closed by an intervening turn event — computing at flush time froze every
   * such block on "working" forever. The entries array is shared by reference
   * with the block, so a late settlement still reaches it; `finalizeToolGroups`
   * derives status and metric from the final entry states instead.
   */
  const flushGroup = (): void => {
    if (!pendingGroup) return;
    const block: ActivityBlockData = {
      id: `block-${pendingGroup.startedAt}-${blocks.length}`,
      title: pendingGroup.title,
      metric: "",
      status: "working",
      entries: pendingGroup.entries,
    };
    blocks.push(block);
    toolGroupBlocks.push(block);
    order.push({ kind: "block", id: block.id });
    pendingGroup = null;
  };

  const addPresentationRejection = (ev: TerminusSseEvent, rejection: PresentationRejection): void => {
    flushGroup();
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
        flushGroup();
        const resolvedInput = turnInputs.get(ev.id);
        const userInput = resolvedInput?.status === "ready"
          ? boundedText(
              resolvedInput.truncated
                ? `${resolvedInput.text}\n\n[Prompt truncated. Inspect the immutable artifact for the full text.]`
                : resolvedInput.text,
              "User input",
              MAX_MESSAGE_FIELD_CHARS,
            )
          : turnInputPlaceholder(resolvedInput);
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
        // The agent's message is *not* opened here. The control plane does not
        // stream provider deltas, so an empty message opened at turn start sat
        // in the feed as a blank bubble with a blinking caret for the whole
        // turn — the single loudest signal that the chat was broken. It is
        // materialised at first content instead, which also puts it after the
        // tool calls that produced it rather than above them.
        pendingAgentMessage = { id: `agent-${ev.id}`, at };
        streamingMessageId = null;
        break;
      }
      case "turn.completed": {
        // The control plane does not stream provider deltas; it publishes the
        // settled response on turn.completed. Preserve streamed content when
        // some arrives, but never leave a completed turn with an empty
        // assistant message.
        const at = eventTimestamp(p, ev, taskCreatedAt);
        const summary = typeof p.summary === "string"
          ? boundedText(p.summary, "Completion summary", MAX_MESSAGE_FIELD_CHARS)
          : null;
        const m = openAgentMessage();
        if (m) {
          if (m.content.length === 0 && summary) m.content = summary;
          if (m.content.length === 0) {
            // A turn that completed with nothing to say still happened. Say so
            // rather than leave an empty bubble with a live caret.
            m.content = "Terminus finished this turn without a written response.";
          }
          if (p.summary_truncated === true && typeof p.continuation === "string") {
            m.content += `\n\n_Response truncated for display. Full text: ${p.continuation}_`;
          }
          m.streaming = false;
        }
        streamingMessageId = null;
        // The provider's own reasoning, when it returned any. Attached to the
        // trace that was already timing this turn rather than to a second row.
        if (openReasoning && typeof p.reasoning === "string" && p.reasoning.trim().length > 0) {
          openReasoning.text = boundedText(p.reasoning, "Reasoning", MAX_MESSAGE_FIELD_CHARS);
        }
        closeReasoning(at);
        flushGroup();
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
      case "turn.tool_settlement": {
        notePhase("tool_settlement", eventTimestamp(p, ev, taskCreatedAt));
        break;
      }
      case "turn.verifying": {
        notePhase("verifying", eventTimestamp(p, ev, taskCreatedAt));
        break;
      }
      case "turn.repairing":
      case "turn.repair_pending": {
        notePhase("repairing", eventTimestamp(p, ev, taskCreatedAt));
        break;
      }
      /*
       * Every way a turn can end other than completing.
       *
       * These were all unhandled, which is the single biggest reason the feed
       * looked broken: a turn that failed, was stopped, ran out of budget, was
       * denied by policy or was waiting on the user left its assistant message
       * pinned in the streaming state forever — a blinking caret under an empty
       * response, with no indication that anything had happened.
       */
      case "turn.failed":
      case "turn.aborted":
      case "turn.interrupted":
      case "turn.superseded":
      case "turn.blocked":
      case "turn.needs_user_input":
      case "turn.budget_exhausted":
      case "turn.policy_denied":
      case "turn.recovery_failed":
      case "turn.recovery_interrupted": {
        const at = eventTimestamp(p, ev, taskCreatedAt);
        closeReasoning(at);
        flushGroup();
        const outcome = TURN_OUTCOMES[ev.event] ?? TURN_OUTCOME_FALLBACK;
        // Whatever the turn had already said stands; it just stops streaming.
        if (streamingMessageId) {
          const message = messageById.get(streamingMessageId);
          if (message) message.streaming = false;
          streamingMessageId = null;
        }
        pendingAgentMessage = null;
        // Every non-completing end gets a row, carrying whatever reason the
        // control plane gave — "it stopped" with no reason is what sends
        // someone to a log file.
        const reason = typeof p.reason === "string" ? p.reason : null;
        const detail = [reason, typeof p.error === "string" ? p.error : null]
          .filter((value): value is string => value !== null && value.length > 0)
          .join(" — ");
        const block: ActivityBlockData = {
          id: `block-${ev.id}`,
          title: outcome.title,
          metric: outcome.metric,
          status: outcome.tone === "failed" ? "failed" : "interrupted",
          entries: [{
            tool: "turn",
            summary: outcome.message,
            ...(detail ? { detail: boundedText(detail, "Turn outcome detail", MAX_ACTIVITY_DETAIL_CHARS) } : {}),
            at,
            phase: "settled",
            outcome: outcome.tone === "failed" ? "failed" : "unknown",
          }],
        };
        blocks.push(block);
        order.push({ kind: "block", id: block.id });
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
        {
          const delta = typeof p.delta === "string" ? p.delta : null;
          const response = typeof p.response === "string" ? p.response : null;
          if (delta || response) {
            const m = openAgentMessage();
            if (m) {
              if (delta) appendStreamContent(m, delta);
              else if (response && m.content.length === 0) appendStreamContent(m, response);
            }
          }
        }
        break;
      }
      // `tool.authorized` and `tool.started` are policy bookkeeping: they name
      // no tool and report no result, so as rows they said "tool / authorized"
      // and nothing else. The proposal and the settlement are the two events
      // that carry meaning, and they are joined into one row below.
      case "tool.authorized":
      case "tool.started":
        break;
      case "tool.proposed":
      case "tool.settled":
      case "tool.failed":
      case "tool.denied":
      case "tool.cancelled":
      case "tool.settlement_unknown": {
        const at = eventTimestamp(p, ev, taskCreatedAt);
        const callId = toolCallIdentity(p);
        const existing = callId === null ? undefined : toolEntryByCallId.get(callId);

        if (ev.event === "tool.proposed") {
          const tool = toolIdentity(p) ?? "tool";
          const groupTitle = groupTitleForTool(tool);
          if (!pendingGroup || pendingGroup.title !== groupTitle) {
            flushGroup();
            pendingGroup = { title: groupTitle, entries: [], startedAt: at };
          }
          const entry: ActivityEntry = {
            tool,
            summary: proposedToolSummary(p, tool),
            at,
            phase: "proposed",
            ...(callId ? { operationId: callId } : {}),
          };
          if (appendToolEntry(pendingGroup, entry, at) && callId) {
            toolEntryByCallId.set(callId, entry);
          }
          break;
        }

        // A settlement. Fold it into the row its proposal already opened so a
        // tool call reads as one line that resolves, not as two unrelated rows.
        const outcome: ActivityEntry["outcome"] = ev.event === "tool.settled"
          ? settlementOutcome(p)
          : ev.event === "tool.settlement_unknown"
            ? "unknown"
            : "failed";
        const summary = settledToolSummary(ev.event, p, existing?.summary);
        const detail = detailForTool(p);
        if (existing) {
          existing.phase = "settled";
          existing.outcome = outcome;
          existing.summary = summary;
          if (detail) existing.detail = detail;
          break;
        }
        // No proposal in this window — the settlement stands on its own.
        const tool = toolIdentity(p) ?? "tool";
        const groupTitle = groupTitleForTool(tool);
        if (!pendingGroup || pendingGroup.title !== groupTitle) {
          flushGroup();
          pendingGroup = { title: groupTitle, entries: [], startedAt: at };
        }
        appendToolEntry(pendingGroup, {
          tool,
          summary,
          at,
          phase: "settled",
          outcome,
          ...(detail ? { detail } : {}),
          ...(callId ? { operationId: callId } : {}),
        }, at);
        break;
      }
      case "task.completed":
      case "task.failed":
      case "task.interrupted":
      case "task.aborted":
      case "task.cancelled": {
        closeReasoning(eventTimestamp(p, ev, taskCreatedAt));
        flushGroup();
        if (streamingMessageId) {
          const m = messageById.get(streamingMessageId);
          if (m) {
            if (m.content.length === 0 && ev.event === "task.failed") {
              m.content = "The task stopped before Terminus could respond. Start a new task to try again.";
            } else if (m.content.length === 0 && ev.event !== "task.completed") {
              m.content = "The task was stopped before Terminus could respond.";
            }
            m.streaming = false;
          }
          streamingMessageId = null;
        }
        pendingAgentMessage = null;
        break;
      }
      case "task.blocked": {
        flushGroup();
        if (streamingMessageId) {
          const message = messageById.get(streamingMessageId);
          if (message) message.streaming = false;
        }
        pendingAgentMessage = null;
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

  // Close whatever is still open. Nothing flushed the trailing group before,
  // so a task with tool calls in flight showed no activity at all until its
  // turn ended — the work was decoded and then dropped on the floor, which is
  // the state a running task spends most of its time in.
  flushGroup();

  // Status and metric are derived once, from the final state of every entry,
  // so a settlement that arrived after its group closed is still reflected.
  for (const block of toolGroupBlocks) {
    const operations = new Map<string, ActivityEntry>();
    block.entries.forEach((entry, index) => {
      operations.set(entry.operationId ?? `uncorrelated:${index}`, entry);
    });
    const states = Array.from(operations.values());
    const anyFailed = states.some((entry) => entry.phase === "settled" && entry.outcome === "failed");
    const allSettled = states.length > 0 && states.every((entry) => entry.phase === "settled");
    const allSucceeded = allSettled && states.every((entry) => entry.outcome === "succeeded");
    block.status = anyFailed
      ? "failed"
      : allSucceeded
        ? "done"
        : allSettled
          ? "unknown"
          : "working";
    block.metric = computeMetric(block.entries, block.title);
  }

  return { messages, blocks, reasoning, order };
}

/**
 * What a proposed tool call is about to do.
 *
 * Prefers whatever operand the control plane put on the wire — a path, a
 * command, a URL. Falls back to the tool's own name, because "read" is still
 * more use than the literal string "proposed", which is what this row used to
 * say for every tool call in the transcript.
 */
function proposedToolSummary(p: Record<string, unknown>, tool: string): string {
  const args = p.arguments_excerpt ?? p.args_summary ?? p.args;
  if (typeof args === "string" && args.length > 0) {
    return boundedText(args, "Tool arguments", MAX_ACTIVITY_SUMMARY_CHARS);
  }
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const key of ["path", "command", "program", "url", "pattern", "query"] as const) {
      const value = a[key];
      if (typeof value === "string" && value.length > 0) {
        return boundedText(value, "Tool argument", MAX_ACTIVITY_SUMMARY_CHARS);
      }
    }
  }
  const resource = p.resource_uri;
  if (typeof resource === "string" && resource.length > 0) {
    return boundedText(resource, "Tool resource", MAX_ACTIVITY_SUMMARY_CHARS);
  }
  return `${tool}…`;
}

/**
 * What a settled tool call did. The status is already carried by the row's
 * glyph, so it is not repeated in the text — this used to read
 * "success: Read 42 lines", which said the same thing twice.
 */
function settledToolSummary(
  eventName: string,
  p: Record<string, unknown>,
  proposed: string | undefined,
): string {
  const summary = p.summary ?? p.explanation ?? p.reason ?? p.error;
  if (typeof summary === "string" && summary.length > 0) {
    return boundedText(summary, "Tool summary", MAX_ACTIVITY_SUMMARY_CHARS);
  }
  switch (eventName) {
    case "tool.denied": return proposed ? `${proposed} — denied by policy` : "Denied by policy";
    case "tool.cancelled": return proposed ? `${proposed} — cancelled` : "Cancelled before dispatch";
    case "tool.settlement_unknown":
      return proposed ? `${proposed} — outcome unknown` : "Outcome unknown; needs reconciliation";
    default: return proposed ?? "Settled";
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

/**
 * Which group a tool belongs to.
 *
 * The standalone tool set is `read`, `patch`, `exec`, `exec_poll`, `web_fetch`,
 * `grep` and `glob` (see the control plane's `parseStandaloneToolCall`). Four of
 * those were unlisted and fell through to "Tool activity", which also broke
 * grouping: a `glob` and the `read` that followed it landed in two separate
 * blocks because their titles differed.
 */
function groupTitleForTool(tool: string): string {
  const t = tool.toLowerCase();
  if (t === "read" || t === "search" || t === "inspect" || t === "grep" || t === "glob") {
    return "Explored codebase";
  }
  if (t === "patch" || t === "write" || t === "edit") return "Implemented changes";
  if (t === "exec" || t === "exec_poll" || t === "job") return "Ran commands";
  if (t === "verify" || t === "verification") return "Ran verification";
  if (t === "web_fetch" || t === "fetch") return "Read the web";
  return "Tool activity";
}

function plural(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The one number a collapsed group is worth showing.
 *
 * Counts come from the entries themselves. The file count used to be inferred
 * by looking for a dot or a leading slash in the row's display text — which
 * stopped being a path the moment the row settled and its text became the
 * tool's result summary, so a settled group silently changed what it counted.
 */
function computeMetric(entries: ActivityEntry[], title: string): string {
  const count = entries.length;
  switch (title) {
    case "Explored codebase": return plural(count, "file", "files");
    case "Implemented changes": return plural(count, "edit", "edits");
    case "Read the web": return plural(count, "page", "pages");
    case "Ran commands":
    case "Ran verification": {
      const passed = entries.filter((entry) => entry.phase === "settled" && entry.outcome === "succeeded").length;
      return passed === count ? `${plural(count, "run", "runs")} passed` : plural(count, "run", "runs");
    }
    default: return plural(count, "action", "actions");
  }
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
  const turnInputs = useTurnInputs(events, task?.id ?? null);

  const decoded = useMemo(() => {
    if (!task) return { messages: [], blocks: [], reasoning: [], order: [] } satisfies DecodedFeed;
    return decodeFeed(events, task.created_at, turnInputs);
    // Recompute when the events list grows OR the task changes. The last
    // event id is included so streaming appends trigger a re-decode, and
    // turnInputs so a prompt re-renders once its artifact resolves.
  }, [events, task?.id, events.length, lastEventId, turnInputs]);
  const approvalResource = useSelectedTaskApprovals();
  const eventHistory = useSelectedTaskEventHistory();
  const transcript = useSelectedTaskTranscript();
  const loadEarlierTranscript = useTerminusStore((s) => s.loadEarlierTranscript);
  const hydrateTranscript = useTerminusStore((s) => s.hydrateTranscript);
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

  const normalizedStatus = lifecycleFromTask(task);
  const blockedByProvider = task.status === "BLOCKED"
    && task.terminal_reason?.reason === "provider_transport_unavailable";
  const emptyState = (() => {
    switch (normalizedStatus) {
      case "queued": return { title: "Queued", description: "Work will begin when the runtime is ready." };
      case "planning": return { title: "Planning", description: "The agent is reading the codebase and deciding how to proceed." };
      case "verifying": return { title: "Verifying", description: "Running the acceptance checks for this task." };
      case "review": return { title: "Ready for review", description: "The changes are ready to read." };
      case "needs_you": return blockedByProvider
        ? {
            title: "Provider transport unavailable",
            description: "Configure provider transport in the control plane, then send a follow-up to retry this task.",
          }
        : { title: "Waiting for input", description: "The task will continue as soon as the required input is available." };
      case "done": return { title: "Task complete", description: "The task completed without conversation items in this bounded view." };
      case "cancelled": return { title: "Task stopped", description: "The task was aborted before producing conversation items." };
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
        style={{ padding: "20px 24px 24px" }}
      >
      {/* Polite live region — announces new messages for screen readers. */}
      <div aria-live="polite" aria-atomic="false" style={{ position: "absolute", left: -9999, width: 1, height: 1, overflow: "hidden" }}>
        {liveMessage}
      </div>
      {/* Reading column. Prose stays narrow; blocks expand wider.
          Per SPEC §9.1: comfortable centered reading column. */}
      <div
        className={cn("feed-column", items.length === 0 && "is-empty")}
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

        {/* Earlier history.

            The conversation opens on its tail — where a reader starts — and
            walks backwards on request. Before this, reopening a task that had
            already run showed nothing at all: the SSE stream is a live tail,
            so without a cursor it delivers only what happens next, and every
            stored event went unread. */}
        {task && transcript?.status === "error" ? (
          <div className="mb-4 flex flex-wrap items-center gap-2 border-l-2 border-warning/55 px-3 py-1.5 text-xs text-secondary" role="status">
            <span className="min-w-0 flex-1">
              Earlier messages could not be loaded. {transcript.error} Live updates are still connected.
            </span>
            <Button
              type="button"
              onClick={() => void hydrateTranscript(task.id)}
              className="font-medium text-primary hover:underline"
            >
              Retry
            </Button>
          </div>
        ) : null}
        {task && transcript?.earlierCursor !== null && transcript !== null ? (
          <div className="mb-3 flex items-center justify-center gap-2 text-xs">
            <Button
              type="button"
              onClick={() => void loadEarlierTranscript(task.id)}
              disabled={transcript.loadingEarlier}
              className="rounded-md border border-subtle px-2.5 py-1 text-secondary hover:bg-hover hover:text-primary disabled:opacity-45"
            >
              {transcript.loadingEarlier ? "Loading earlier messages…" : "Load earlier messages"}
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
            <StatusIndicator status="needs_you" size={10} />
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
        ) : items.length === 0 && transcript?.status === "loading" ? (
          <div className="grid min-h-40 place-items-center text-center" role="status">
            <p className="ui-body text-tertiary">Loading the conversation…</p>
          </div>
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
