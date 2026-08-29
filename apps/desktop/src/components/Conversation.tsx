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
 * The message + activity-block list renders in normal document flow.
 * Absolute-positioned virtual rows raced their runtime height
 * measurements against streaming and self-expanding rows and painted
 * on top of one another; a conversation is a bounded sequential read,
 * so flow layout is both correct and simpler. Scroll position is
 * sticky-at-bottom only when the user is already at the bottom — new
 * messages arriving while the user reads history don't yank them down.
 *
 * The feed consumes raw SSE events from the control plane and decodes
 * them into messages + activity blocks. Decoding is intentionally
 * defensive — every payload is `unknown` until we shape it.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Message } from "./Message";
import { ActivityBlock } from "./ActivityBlock";
import { ReasoningTrace } from "./ReasoningTrace";
import { ApprovalCard } from "./ApprovalCard";
import { ErrorState, errorPreset } from "./ErrorState";
import { ArrowDown, ShieldAlert } from "lucide-react";
import { cn } from "../lib/cn";
import { turnInputPlaceholder, type TurnInputMap } from "../lib/turn-input";
import { useTurnInputs } from "../hooks/use-turn-inputs";
import { displayLifecycle } from "../lib/turn-activity";
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
  /*
   * A turn failed; the task did not.
   *
   * The control plane emits this at task level precisely to say the task is
   * still ACTIVE and steerable. It carries the same failure payload as
   * `turn.failed`, so it renders the same block — with Retry, and with the
   * composer left alone.
   */
  "task.turn_failed": {
    title: "Turn failed",
    metric: "Failed",
    message: "This turn failed. The task is still open — send another message or retry.",
    tone: "failed",
  },
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


/** An event's payload, shaped once and remembered. */
interface DecodedEventPayload {
  /** The payload as a record, or null when it is not one (or would not parse). */
  readonly record: Record<string, unknown> | null;
  /** Size of the raw payload, for the oversize presentation guard. */
  readonly characterCount: number;
}

/**
 * Decoded payloads, keyed on the event object the store is holding.
 *
 * `decodeFeed` is a fold over the *entire* retained event log, and it re-runs
 * every time a streamed delta lands — several times a second on a live turn.
 * Every one of those runs used to `JSON.parse` every event in the log again, so
 * the cost of rendering one new token scaled with the length of the whole
 * conversation. The store appends to its array without rewriting the events
 * already in it, so an event's parse result stays valid for as long as that
 * object is reachable: a WeakMap keeps the cache exactly as long as the log
 * itself and never needs invalidating. Entries are only ever read, never
 * mutated, so sharing one parse across renders is safe.
 */
const payloadCache = new WeakMap<TerminusSseEvent, DecodedEventPayload>();

function readEventPayload(ev: TerminusSseEvent): DecodedEventPayload {
  const embedded = (ev as unknown as { payload?: unknown }).payload;
  const hasEmbedded = typeof embedded === "object" && embedded !== null;
  const rawData = typeof ev.data === "string"
    ? ev.data
    : hasEmbedded ? JSON.stringify(embedded) : "";
  if (rawData.length > MAX_PRESENTATION_EVENT_CHARS) {
    return { record: null, characterCount: rawData.length };
  }
  let payload: unknown;
  try {
    payload = hasEmbedded
      ? embedded
      : rawData.length > 0 ? JSON.parse(rawData) as unknown : null;
  } catch {
    // Unparseable payloads are dropped, exactly as before — but the failed
    // parse is remembered so it is not attempted again on the next delta.
    return { record: null, characterCount: rawData.length };
  }
  return { record: recordFrom(payload), characterCount: rawData.length };
}

function decodeEventPayload(ev: TerminusSseEvent): DecodedEventPayload {
  const cached = payloadCache.get(ev);
  if (cached !== undefined) return cached;
  const decoded = readEventPayload(ev);
  payloadCache.set(ev, decoded);
  return decoded;
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
 *   - turn.provider_text_delta { text }
 *   - turn.response_validating { ... }
 *   - task.completed      { ... }
 *
 * Anything unrecognized is ignored (defensive). `turn.provider_text_delta`
 * carries a coalesced chunk of the provider's reply in `text`; the chunks are
 * concatenated into the streaming agent message.
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
  /** The model the runtime reported for the turn in flight, if it reported one. */
  let pendingTurnModel: string | null = null;
  /**
   * The exact prompt of the turn in flight, when this client holds it in full.
   * A failed turn offers to resend it; nothing else reads it.
   */
  let lastUserInput: string | null = null;

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
      ...(pendingTurnModel ? { model: pendingTurnModel } : {}),
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
    const decoded = decodeEventPayload(ev);
    if (decoded.characterCount > MAX_PRESENTATION_EVENT_CHARS) {
      addPresentationRejection(ev, {
        reason: "event_payload_too_large",
        sourceEvent: ev.event || "unknown",
        characterCount: decoded.characterCount,
        limit: MAX_PRESENTATION_EVENT_CHARS,
      });
      continue;
    }
    const p = decoded.record;
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
        // The agent's message is *not* opened here. An empty message opened at
        // turn start sat in the feed as a blank bubble with a blinking caret
        // until the first delta arrived — and a turn that spends its first
        // minute compiling context and running tools has no text for a long
        // time. It is materialised at first content instead, which also puts
        // it after the tool calls that produced it rather than above them.
        lastUserInput = resolvedInput?.status === "ready" && !resolvedInput.truncated
          ? resolvedInput.text
          : null;
        pendingAgentMessage = { id: `agent-${ev.id}`, at };
        // The runtime states what it routed to. `turn.profile_selected` may
        // refine it later; until this landed the composer's choice and the
        // model that actually ran were unrelated facts.
        const startedModel = typeof p.model === "string" && p.model.length > 0 ? p.model : null;
        const startedEffort = typeof p.reasoning_effort === "string" && p.reasoning_effort.length > 0
          ? p.reasoning_effort
          : null;
        pendingTurnModel = startedModel === null
          ? null
          : boundedText(
              startedEffort ? `${startedModel} · ${startedEffort}` : startedModel,
              "Model",
              MAX_ACTIVITY_SUMMARY_CHARS,
            );
        streamingMessageId = null;
        break;
      }
      case "turn.completed": {
        // Streamed deltas have already built the reply; the settled summary is
        // the fallback for a turn whose stream was never seen (a replayed
        // transcript, an evicted window). Never leave a completed turn with an
        // empty assistant message.
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
      case "task.turn_failed":
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
        /*
         * Every non-completing end gets a row carrying what the control plane
         * actually said.
         *
         * The payload is `{ code, category, message, reason, retryable,
         * details }`. `message` is the human sentence; the client read only
         * `reason` and `error`, so a failed turn rendered the single token
         * `agent_loop_error` and sent the reader to a log file.
         */
        const failureCode = typeof p.code === "string" && p.code.length > 0 ? p.code : null;
        const failureMessage = typeof p.message === "string" && p.message.length > 0
          ? p.message
          : typeof p.error === "string" && p.error.length > 0
            ? p.error
            : null;
        const reason = typeof p.reason === "string" && p.reason.length > 0 ? p.reason : null;
        const knownReason = reason === null ? undefined : TERMINAL_REASON_TEXT[reason];
        /*
         * The transcript leads with a human sentence, not the wire envelope.
         * A mapped reason wins; otherwise the provider's message is softened
         * into something a person can act on ("the model is rate limited");
         * only when there is no message at all do we fall back to the raw
         * code. The header already says the turn failed, so an ALL-CAPS code
         * as the first line is noise. The structured `details` (cause chains,
         * gRPC codes) belong in logs and the inspector, not the conversation.
         */
        const humanLead = knownReason
          ?? (failureMessage ? humanizeProviderFailure(failureMessage) : null)
          ?? failureCode
          ?? outcome.message;
        const summary = boundedText(humanLead, "Turn outcome", MAX_ACTIVITY_SUMMARY_CHARS);
        const retryable = p.retryable === true ? "yes" : p.retryable === false ? "no" : null;
        const detail = [
          // Keep the provider's own words underneath when the lead differs
          // from them (a mapped reason or a softened sentence).
          failureMessage && failureMessage !== summary ? failureMessage : null,
          // With neither a human sentence nor a mapped reason, the raw reason
          // token is the only extra signal the reader has.
          failureMessage === null && knownReason === undefined && reason ? `Reason: ${reason}` : null,
          retryable === "no" ? "This error is not retryable." : null,
        ]
          .filter((value): value is string => value !== null && value.length > 0)
          .join("\n");
        const block: ActivityBlockData = {
          id: `block-${ev.id}`,
          title: outcome.title,
          metric: outcome.metric,
          status: outcome.tone === "failed" ? "failed" : "interrupted",
          entries: [{
            tool: "turn",
            summary,
            ...(detail ? { detail: boundedText(detail, "Turn outcome detail", MAX_ACTIVITY_DETAIL_CHARS) } : {}),
            at,
            phase: "settled",
            outcome: outcome.tone === "failed" ? "failed" : "unknown",
          }],
          // Offered only where retrying is the obvious next move and the exact
          // prompt is in hand. A stopped or superseded turn ended because the
          // user decided it should.
          ...(outcome.tone === "failed" && lastUserInput !== null
            ? { retryInput: lastUserInput }
            : {}),
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
      /*
       * Which model actually ran this turn.
       *
       * The composer offers a choice; this is the only place the runtime says
       * what it did with it. Reported on the reply rather than beside the
       * picker so a transcript read a week later still says what produced it.
       */
      case "turn.profile_selected": {
        const model = typeof p.model_key === "string" && p.model_key.length > 0 ? p.model_key : null;
        if (model === null) break;
        pendingTurnModel = boundedText(model, "Model", MAX_ACTIVITY_SUMMARY_CHARS);
        if (streamingMessageId) {
          const message = messageById.get(streamingMessageId);
          if (message) message.model = pendingTurnModel;
        }
        break;
      }
      /*
       * A steer accepted into the running turn.
       *
       * `POST /v1/turns/:id/steer` produces no new `turn.started`, so without
       * this the steered instruction vanished from the transcript entirely and
       * the reply that followed it had no visible cause. The payload carries
       * the length, not the text — the text is a content-addressed artifact.
       */
      case "turn.steering_queued": {
        const at = eventTimestamp(p, ev, taskCreatedAt);
        flushGroup();
        const chars = typeof p.chars === "number" && Number.isFinite(p.chars) ? p.chars : null;
        const block: ActivityBlockData = {
          id: `block-${ev.id}`,
          title: "Steering delivered",
          metric: chars === null ? "Queued" : plural(chars, "character", "characters"),
          status: "done",
          entries: [{
            tool: "steer",
            summary: "Your message was delivered into the running turn.",
            at,
            phase: "settled",
            outcome: "succeeded",
          }],
        };
        blocks.push(block);
        order.push({ kind: "block", id: block.id });
        break;
      }
      /*
       * The provider's reply, streamed.
       *
       * This is the event the control plane actually emits
       * (`createProviderTextDeltaEmitter`): text coalesced into chunks of at
       * least 512 characters, each one a fragment of the same reply. The
       * renderer used to listen for `turn.provider_running`, which nothing has
       * ever published, so every streamed reply was discarded and the answer
       * appeared in one lump at `turn.completed` — or not at all.
       */
      case "turn.provider_text_delta": {
        const at = eventTimestamp(p, ev, taskCreatedAt);
        notePhase("provider_running", at);
        const text = typeof p.text === "string" ? p.text : null;
        if (text === null || text.length === 0) break;
        // A stream attached mid-turn has no `turn.started` in its window. The
        // text still belongs to a reply, so open one rather than drop it.
        if (streamingMessageId === null && pendingAgentMessage === null) {
          pendingAgentMessage = { id: `agent-${ev.id}`, at };
        }
        const m = openAgentMessage();
        if (m) appendStreamContent(m, text);
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
          : ev.event === "tool.denied"
            ? "denied"
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
    const anyFailed = states.some((entry) => entry.phase === "settled"
      && (entry.outcome === "failed" || entry.outcome === "denied"));
    const allSettled = states.length > 0 && states.every((entry) => entry.phase === "settled");
    const allSucceeded = allSettled && states.every((entry) => entry.outcome === "succeeded");
    const allDenied = allSettled && states.every((entry) => entry.outcome === "denied");
    block.status = anyFailed
      ? "failed"
      : allSucceeded
        ? "done"
        : allSettled
          ? "unknown"
          : "working";
    // A group in which nothing ran did not explore anything. Retitle it so the
    // collapsed row says what happened instead of what was attempted.
    if (allDenied) {
      block.title = "Denied by policy";
      block.metric = plural(states.length, "denial", "denials");
      continue;
    }
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
  // A denial leads with the word. Falling through to the generic path rendered
  // the bare policy reason with no indication that anything had been refused,
  // under a group still titled "Explored codebase".
  if (eventName === "tool.denied") {
    const why = [p.reason, p.explanation, p.summary, p.error]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    return boundedText(
      `Denied: ${why ?? proposed ?? "policy refused this tool call"}`,
      "Tool denial",
      MAX_ACTIVITY_SUMMARY_CHARS,
    );
  }
  const summary = p.summary ?? p.explanation ?? p.reason ?? p.error;
  if (typeof summary === "string" && summary.length > 0) {
    return boundedText(summary, "Tool summary", MAX_ACTIVITY_SUMMARY_CHARS);
  }
  switch (eventName) {
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
export type FeedItem =
  | { kind: "message"; message: ConversationMessage }
  | { kind: "block"; block: ActivityBlockData }
  | { kind: "reasoning"; reasoning: ReasoningBlock };

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

// ────────────────────── Identity stability (streaming) ───────────────────────
//
// `decodeFeed` is a pure fold, so it hands back brand-new objects for every
// message, block and trace on every run — and it runs on every streamed delta.
// That made `React.memo` on the row components inert: their props were never
// referentially equal twice, so appending one token to the last reply
// re-rendered every settled turn above it, re-parsed their markdown, and
// re-created their DOM elements.
//
// The comparisons below let the feed carry the previous render's object forward
// whenever nothing about an item actually changed, which restores the memo
// bail-out and reduces a delta to exactly one re-rendered row.

function sameMessage(a: ConversationMessage, b: ConversationMessage): boolean {
  return a.role === b.role
    && a.streaming === b.streaming
    && a.model === b.model
    && a.createdAt === b.createdAt
    && a.content === b.content;
}

function sameReasoning(a: ReasoningBlock, b: ReasoningBlock): boolean {
  if (a.startedAt !== b.startedAt || a.endedAt !== b.endedAt || a.text !== b.text) return false;
  if (a.phases.length !== b.phases.length) return false;
  return a.phases.every((phase, index) => {
    const other = b.phases[index];
    return other !== undefined && phase.kind === other.kind && phase.at === other.at;
  });
}

function sameActivityBlock(a: ActivityBlockData, b: ActivityBlockData): boolean {
  if (a.title !== b.title
    || a.metric !== b.metric
    || a.status !== b.status
    || a.retryInput !== b.retryInput
    || a.entries.length !== b.entries.length) return false;
  return a.entries.every((entry, index) => {
    const other = b.entries[index];
    return other !== undefined
      && entry.tool === other.tool
      && entry.phase === other.phase
      && entry.outcome === other.outcome
      && entry.at === other.at
      && entry.summary === other.summary
      && entry.detail === other.detail;
  });
}

/**
 * Identity is already established by the feed key, so ids are not compared.
 *
 * Exported for the same reason `decodeFeed` is: this is the load-bearing half
 * of the streaming path. If it reports a changed row as unchanged the reader
 * sees a stale turn; if it reports an unchanged row as changed every memo in
 * the transcript is defeated and the whole feed re-renders per token.
 */
export function sameFeedItem(a: FeedItem, b: FeedItem): boolean {
  if (a === b) return true;
  if (a.kind === "message" && b.kind === "message") return sameMessage(a.message, b.message);
  if (a.kind === "reasoning" && b.kind === "reasoning") return sameReasoning(a.reasoning, b.reasoning);
  if (a.kind === "block" && b.kind === "block") return sameActivityBlock(a.block, b.block);
  return false;
}

/**
 * Is this item still being written?
 *
 * Only a live tail changes between deltas, so it is the only row that has to
 * re-render while a reply streams.
 */
function isLiveFeedItem(item: FeedItem): boolean {
  if (item.kind === "message") return item.message.streaming === true;
  if (item.kind === "reasoning") return item.reasoning.endedAt === null;
  return false;
}

const EMPTY_FEED_ITEMS: readonly FeedItem[] = [];

interface StableFeed {
  /** Every item, at identities carried forward wherever nothing changed. */
  readonly items: readonly FeedItem[];
  /** Everything above the live tail, held at a stable array identity. */
  readonly settled: readonly FeedItem[];
  /** The row still being written, when the feed has one. */
  readonly tail: FeedItem | null;
}

function useStableFeed(items: readonly FeedItem[]): StableFeed {
  const identities = useRef(new Map<string, FeedItem>());
  const settledRef = useRef<readonly FeedItem[]>(EMPTY_FEED_ITEMS);

  return useMemo<StableFeed>(() => {
    const next = new Map<string, FeedItem>();
    const stable = items.map((item) => {
      const key = feedItemKey(item);
      const previous = identities.current.get(key);
      const kept = previous !== undefined && sameFeedItem(previous, item) ? previous : item;
      next.set(key, kept);
      return kept;
    });
    identities.current = next;

    const last = stable.length > 0 ? stable[stable.length - 1] : undefined;
    const tail = last !== undefined && isLiveFeedItem(last) ? last : null;
    const settledCount = tail === null ? stable.length : stable.length - 1;

    // The settled prefix keeps its array identity too. Slicing a fresh array on
    // every delta would defeat the memo on the settled subtree, which is the
    // entire reason for splitting the tail off in the first place.
    const previousSettled = settledRef.current;
    let settled: readonly FeedItem[] = previousSettled;
    if (previousSettled.length !== settledCount) {
      settled = stable.slice(0, settledCount);
    } else {
      for (let index = 0; index < settledCount; index += 1) {
        if (previousSettled[index] !== stable[index]) {
          settled = stable.slice(0, settledCount);
          break;
        }
      }
    }
    settledRef.current = settled;

    return { items: stable, settled, tail };
    // Re-deriving on every decode is the point: the work here is what makes the
    // *rendering* below cheap.
  }, [items]);
}

function FeedItemView({
  item,
  onRetry,
  isLast = false,
  joinsAbove = false,
  joinsBelow = false,
}: {
  item: FeedItem;
  onRetry?: (input: string) => void;
  isLast?: boolean;
  joinsAbove?: boolean;
  joinsBelow?: boolean;
}): JSX.Element {
  if (item.kind === "reasoning") return <ReasoningTrace block={item.reasoning} />;
  if (item.kind === "message") return <Message message={item.message} isLast={isLast} />;
  return (
    /* A failure opens itself. Collapsed-by-default meant the one row that
       explained why a turn stopped hid the explanation behind a click. */
    <ActivityBlock
      block={item.block}
      defaultExpanded={item.block.status === "failed"}
      onRetry={onRetry}
      joinsAbove={joinsAbove}
      joinsBelow={joinsBelow}
    />
  );
}

/**
 * Every turn above the live tail.
 *
 * Memoized on the stable identities above, so a streamed delta — which by
 * construction changes only the tail — never re-enters this subtree. Without
 * it React still walked and rebuilt one element per row for every token, which
 * on a long transcript is the difference between a smooth stream and a
 * stuttering one.
 */
const SettledFeed = memo(function SettledFeed({
  items,
  totalCount,
  startIndex,
  lastItemKey,
  onRetry,
}: {
  items: readonly FeedItem[];
  totalCount: number;
  startIndex: number;
  lastItemKey: string | null;
  onRetry: (input: string) => void;
}): JSX.Element {
  return (
    <>
      {items.map((item, index) => {
        const key = feedItemKey(item);
        return (
          <div
            key={key}
            role="listitem"
            aria-posinset={startIndex + index + 1}
            aria-setsize={totalCount}
          >
            <FeedItemView
              item={item}
              onRetry={onRetry}
              isLast={key === lastItemKey}
              // A run of tool calls shares one rail; the rows either side of it
              // tell each block whether it has a neighbour to join.
              joinsAbove={items[index - 1]?.kind === "block"}
              joinsBelow={items[index + 1]?.kind === "block"}
            />
          </div>
        );
      })}
    </>
  );
});

const ACCESSIBLE_TRANSCRIPT_PAGE_SIZE = 100;

/**
 * The human sentence a task's `terminal_reason` carries.
 *
 * The control plane writes the same `{ code, message, reason }` shape it puts
 * on a terminal turn event. `message` is the sentence; `reason` is the machine
 * token that was previously the only thing shown anywhere.
 */
/**
 * Reasons the control plane reports as codes, in the words a person needs.
 *
 * `control_plane_restarted` is the one that matters: the turn did not fail on
 * its own terms, Terminus went away underneath it. "agent_loop_error" tells
 * the reader to go and read a log; this tells them to press Retry.
 */
const TERMINAL_REASON_TEXT: Readonly<Record<string, string>> = {
  control_plane_restarted: "Terminus restarted while this turn was running.",
};

/**
 * Soften a raw provider transport failure into a sentence a person can act
 * on. The verbatim provider text is still kept as secondary detail; this is
 * only the lead line. Unrecognised messages pass through unchanged.
 */
function humanizeProviderFailure(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("429") || m.includes("rate limit")) {
    return "The model is rate limited right now — the provider kept refusing after several tries. Wait a moment or switch models.";
  }
  if (m.includes("model is unavailable") || m.includes("service unavailable") || m.includes(" 503")) {
    return "The model is unavailable right now. Try again shortly or switch models.";
  }
  if (m.includes("overloaded")) {
    return "The model is overloaded right now. Try again shortly or switch models.";
  }
  if (m.includes("context length") || m.includes("context_length") || m.includes("too many tokens")) {
    return "This turn outgrew the model's context window.";
  }
  return message;
}

export function terminalReasonText(reason: Record<string, unknown> | null): string | undefined {
  if (!reason) return undefined;
  const read = (key: string): string | null => {
    const value = reason[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };
  const known = TERMINAL_REASON_TEXT[read("reason") ?? ""];
  if (known) return known;
  const text = [read("code"), read("message") ?? read("reason") ?? read("error")]
    .filter((value): value is string => value !== null)
    .join(": ");
  return text.length > 0 ? boundedText(text, "Terminal reason", MAX_ACTIVITY_SUMMARY_CHARS) : undefined;
}

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
  const decodedItems = useMemo<FeedItem[]>(() => {
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
  // Carry unchanged rows forward by identity and split the row still being
  // written off the settled transcript above it. Everything downstream reads
  // `items` from here, never the raw decode.
  const feed = useStableFeed(decodedItems);
  const items = feed.items;
  const lastItemKey = useMemo(() => {
    const last = items[items.length - 1];
    return last ? feedItemKey(last) : null;
  }, [items]);
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
  // Sticky-at-bottom scrolling for the flow feed. `scrollToBottom` is the
  // single anchor the growth/reset effects and the "Latest" affordance share.
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto"): void => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior });
    else el.scrollTop = el.scrollHeight;
  }, []);

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
    if (items.length === 0) {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      return;
    }
    // Cancelled on unmount and on a second task switch, so a frame queued for
    // the task the reader just left cannot scroll the one they landed on.
    const frame = window.requestAnimationFrame(() => scrollToBottom());
    return () => window.cancelAnimationFrame(frame);
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
    const frame = window.requestAnimationFrame(() => scrollToBottom());
    return () => window.cancelAnimationFrame(frame);
  }, [fullTranscript, growthKey, items.length, scrollToBottom]);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distFromBottom < 80;
    if (stickRef.current) setHasUnseenUpdates(false);
  }, []);

  /*
   * Resend a failed turn's prompt.
   *
   * Routed through the composer rather than posting a turn from here: the
   * composer owns the only `POST /v1/turns` call site, with its idempotency
   * ledger and its steer/queue rules. A second send path would drift from it.
   */
  const retryTurn = useCallback((input: string): void => {
    if (!task) return;
    window.dispatchEvent(new CustomEvent("terminus:retry-turn", {
      detail: { taskId: task.id, text: input },
    }));
  }, [task]);

  const jumpToLatest = useCallback((): void => {
    stickRef.current = true;
    setHasUnseenUpdates(false);
    scrollToBottom("smooth");
  }, [scrollToBottom]);

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
    // Same treatment as an empty conversation: one line, centred, quiet. An
    // icon and a heading here competed with the sidebar the sentence is
    // pointing at.
    return (
      <div className={cn("grid h-full place-items-center", className)}>
        <p className="ui-body px-6 text-center text-tertiary">
          Choose a task from the sidebar to read its conversation.
        </p>
      </div>
    );
  }

  // What the task is *doing*, not what its row says. An ACTIVE task with no
  // turn in flight is ready, not working — see lib/turn-activity.
  const normalizedStatus = displayLifecycle(task, events);
  const blockedByProvider = task.status === "BLOCKED"
    && task.terminal_reason?.reason === "provider_transport_unavailable";
  const terminalReasonDetail = terminalReasonText(task.terminal_reason);
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
      case "idle": return { title: "Ready when you are", description: "Send a message to start this task." };
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
              className="rounded-md px-2 py-1 text-xs text-tertiary hover:bg-hover hover:text-secondary"
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
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-xs text-secondary" role="status">
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
            /* The transcript's `aria-describedby` has always pointed here, but
               nothing carried the id — so assistive technology was told to read
               a description that did not exist. */
            id="conversation-history-boundary"
            className="mb-4 rounded-lg border border-subtle px-3 py-2 text-xs text-secondary"
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
        {/* Empty conversation.

            One quiet centred line, and nothing else. A task that simply has not
            said anything yet is not a state worth a headline, an illustration
            and a paragraph — that treatment made "Ready when you are" the
            loudest thing on the screen. The composer below is already the
            obvious next move. */}
        {items.length === 0 && blockedByProvider ? (
          <p className="ui-body px-6 text-center text-tertiary" role="status">
            Provider transport is unavailable. Configure it in the control plane, then send a follow-up to retry this task.
          </p>
        ) : items.length === 0 && transcript?.status === "loading" ? (
          <p className="ui-body px-6 text-center text-tertiary" role="status">
            Loading the conversation…
          </p>
        ) : items.length === 0 && emptyState ? (
          <p className="ui-body px-6 text-center text-tertiary">
            {emptyState.description}
          </p>
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
              {/* The sequential reading mode renders whatever page is open
                  verbatim; it is an assistive-technology escape hatch, not the
                  streaming path, so it does not split a tail off. */}
              <SettledFeed
                items={transcriptItems}
                totalCount={items.length}
                startIndex={transcriptStart}
                lastItemKey={lastItemKey}
                onRetry={retryTurn}
              />
            </div>
          </div>
        ) : (
          /* Feed in normal document flow. A transcript is a bounded, mostly
             sequential read; windowing it with absolute-positioned, runtime-
             measured rows raced the measurements against streaming/growing
             rows and painted them on top of each other. Flow layout is the
             correct model for a conversation and cannot overlap. */
          <div
            role="list"
            aria-label={`Conversation feed (${items.length} loaded items)`}
            aria-busy={streamState === "connecting" || streamState === "reconnecting"}
            className="flex flex-col"
          >
            <SettledFeed
              items={feed.settled}
              totalCount={items.length}
              startIndex={0}
              /* The newest *settled* turn keeps its action row on screen. While
                 something is still streaming the tail owns that, not this. */
              lastItemKey={feed.tail === null ? lastItemKey : null}
              onRetry={retryTurn}
            />
            {feed.tail !== null ? (
              <div role="listitem" aria-posinset={items.length} aria-setsize={items.length}>
                <FeedItemView item={feed.tail} onRetry={retryTurn} isLast />
              </div>
            ) : null}
          </div>
        )}

        {/* A failed task says so whether or not it produced a transcript.

            This used to be gated on `items.length === 0`, so the one surface
            that named the failure and offered a way forward was unreachable for
            every task that had said anything at all — which is every task that
            actually ran. */}
        {normalizedStatus === "failed" ? (
          <ErrorState
            {...errorPreset("failedTask")}
            {...(terminalReasonDetail ? { detail: terminalReasonDetail } : {})}
            action={onNewTask ? { label: "New task", onClick: onNewTask } : undefined}
            compact
            className="conversation-terminal-state mt-4"
          />
        ) : null}

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
      {/* A label for the group, not a second alert around the cards. The
          approval cards below already say what they are; a tinted bar with an
          uppercase heading on top of them said it twice, louder. */}
      <div className="flex items-center gap-2 px-0.5">
        <ShieldAlert size={12} className="flex-none text-warning" aria-hidden />
        <span className="ui-section-label">{countLabel}</span>
        <span className="ui-meta ml-auto">Awaiting decision</span>
      </div>
      {freshness !== "ready" ? (
        <p className="ui-meta px-0.5 text-warning" role="status">
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
        <div className="px-0.5">
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
        className="mt-4 flex items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-xs text-secondary"
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
