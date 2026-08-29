import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  Conversation,
  decodeFeed,
  sameFeedItem,
  terminalReasonText,
  type FeedItem,
} from "../src/components/Conversation";
import { Message } from "../src/components/Message";
import { ReasoningTrace } from "../src/components/ReasoningTrace";
import { useTerminusStore } from "../src/hooks/use-terminus";
import type { ConversationMessage, Task, TerminusSseEvent } from "../src/types";

const TASK_ID = "task-accessible-transcript";

function task(): Task {
  const now = new Date().toISOString();
  return {
    id: TASK_ID,
    session_id: "session-accessible-transcript",
    thread_id: "thread-accessible-transcript",
    status: "ACTIVE",
    phase: "EXECUTING",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: now,
    updated_at: now,
    completed_at: null,
    terminal_reason: null,
    contract: null,
  };
}

function event(id: string, name: string, payload: Record<string, unknown>): TerminusSseEvent {
  return { id, event: name, data: JSON.stringify(payload) };
}

function transcriptEvents(turnCount: number): TerminusSseEvent[] {
  const events: TerminusSseEvent[] = [];
  for (let index = 0; index < turnCount; index += 1) {
    events.push({
      id: `turn-${index}-started`,
      event: "turn.started",
      data: JSON.stringify({ user_input: `Question ${index + 1}` }),
    });
    events.push({
      id: `turn-${index}-completed`,
      event: "turn.completed",
      data: JSON.stringify({ summary: `Answer ${index + 1}` }),
    });
  }
  return events;
}

describe("Conversation accessibility traversal", () => {
  beforeEach(() => {
    const selected = task();
    useTerminusStore.setState({
      taskById: { [selected.id]: selected },
      tasksBySession: { [selected.session_id]: [selected] },
      selectedSessionId: selected.session_id,
      selectedTaskId: selected.id,
      approvalsByTask: { [selected.id]: [] },
      approvalFreshnessByTask: { [selected.id]: { status: "ready", error: null } },
      eventHistoryByTask: {},
    });
  });

  afterEach(() => cleanup());

  test("pages every loaded item with global collection metadata on request", async () => {
    render(<Conversation events={transcriptEvents(60)} />);

    fireEvent.click(screen.getByRole("button", { name: "Read all loaded items" }));
    const transcript = await screen.findByRole("list", {
      name: "All loaded conversation items (1-100 of 120)",
    });
    const firstPage = transcript.querySelectorAll(":scope > [role='listitem']");
    expect(firstPage).toHaveLength(100);
    expect(firstPage[0]).toHaveAttribute("aria-posinset", "1");
    expect(firstPage[0]).toHaveAttribute("aria-setsize", "120");
    expect(firstPage[99]).toHaveAttribute("aria-posinset", "100");

    fireEvent.click(screen.getByRole("button", { name: "Next loaded items" }));
    const secondPage = await screen.findByRole("list", {
      name: "All loaded conversation items (101-120 of 120)",
    });
    const remaining = secondPage.querySelectorAll(":scope > [role='listitem']");
    expect(remaining).toHaveLength(20);
    expect(remaining[0]).toHaveAttribute("aria-posinset", "101");
    expect(remaining[19]).toHaveAttribute("aria-posinset", "120");
    expect(screen.getByRole("button", { name: "Use windowed feed" })).toHaveAttribute("aria-pressed", "true");
  });

  test("does not claim the loaded items are a complete transcript across a retention gap", async () => {
    useTerminusStore.setState({
      eventHistoryByTask: {
        [TASK_ID]: {
          reason: "cursor_expired",
          omittedCount: null,
          droppedThroughCursor: "event-old",
          continuationCursor: "event-retained",
          snapshotUrl: `/v1/tasks/${TASK_ID}`,
          reconciliation: "ready",
          error: null,
        },
      },
    });
    render(<Conversation events={transcriptEvents(1)} />);

    expect(screen.queryByRole("button", { name: /full transcript/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Read all loaded items" }));
    const loadedItems = await screen.findByRole("list", { name: "All loaded conversation items (1-2 of 2)" });
    expect(loadedItems).toHaveAttribute("aria-describedby", "conversation-history-boundary");
    expect(screen.getByText("Live history has a retention gap")).toBeInTheDocument();
  });
});

// ────────────────────────── Reasoning trace ──────────────────────────────────
// The control plane reports what a turn is doing between `turn.started` and
// `turn.completed`. The feed used to discard every one of those events, so the
// wait before the first token was indistinguishable from a hang.
//
// The decoder is exercised directly: the windowed feed is virtualized, and
// jsdom reports no layout, so rows do not mount in the component tree.

function reasoningEvents(settled: boolean): TerminusSseEvent[] {
  const events: TerminusSseEvent[] = [
    {
      id: "turn-0-started",
      event: "turn.started",
      data: JSON.stringify({ user_input: "Explain the kernel", started_at: "2026-08-24T01:00:00.000Z" }),
    },
    {
      id: "turn-0-compiling",
      event: "turn.context_compiling",
      data: JSON.stringify({ at: "2026-08-24T01:00:00.200Z" }),
    },
    {
      id: "turn-0-running",
      event: "turn.provider_text_delta",
      data: JSON.stringify({ text: "The kernel ", at: "2026-08-24T01:00:01.000Z" }),
    },
    // A repeat of the current phase is not a new step.
    {
      id: "turn-0-running-2",
      event: "turn.provider_text_delta",
      data: JSON.stringify({ text: "owns effects.", at: "2026-08-24T01:00:02.000Z" }),
    },
  ];
  if (settled) {
    events.push({
      id: "turn-0-completed",
      event: "turn.completed",
      data: JSON.stringify({ summary: "The kernel owns effects.", at: "2026-08-24T01:00:04.500Z" }),
    });
  }
  return events;
}

describe("reasoning trace decoding", () => {
  test("records each distinct turn phase once, in order", () => {
    const [trace] = decodeFeed(reasoningEvents(false), "2026-08-24T00:59:00.000Z").reasoning;
    expect(trace?.phases.map((phase) => phase.kind)).toEqual([
      "context_compiling",
      "provider_running",
    ]);
    expect(trace?.startedAt).toBe("2026-08-24T01:00:00.000Z");
  });

  test("leaves the trace open while the turn is still running", () => {
    const [trace] = decodeFeed(reasoningEvents(false), "2026-08-24T00:59:00.000Z").reasoning;
    expect(trace?.endedAt).toBeNull();
  });

  test("closes the trace when the turn completes", () => {
    const [trace] = decodeFeed(reasoningEvents(true), "2026-08-24T00:59:00.000Z").reasoning;
    expect(trace?.endedAt).toBe("2026-08-24T01:00:04.500Z");
  });

  test("orders the trace between the prompt and the reply", () => {
    const { order } = decodeFeed(reasoningEvents(true), "2026-08-24T00:59:00.000Z");
    expect(order.map((entry) => entry.kind)).toEqual(["message", "reasoning", "message"]);
  });

  test("a turn that reported no phases yields an empty trace", () => {
    const { reasoning } = decodeFeed(transcriptEvents(1), "2026-08-24T00:59:00.000Z");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.phases).toEqual([]);
  });
});

describe("ReasoningTrace", () => {
  afterEach(() => cleanup());

  test("names the phase the turn is in while it runs", () => {
    render(<ReasoningTrace block={{
      id: "r1",
      startedAt: new Date().toISOString(),
      endedAt: null,
      phases: [{ kind: "context_compiling", at: new Date().toISOString() }],
    }} />);
    expect(screen.getByText("Reading context")).toBeInTheDocument();
  });

  test("collapses to a duration and expands into the phases it went through", () => {
    render(<ReasoningTrace block={{
      id: "r2",
      startedAt: "2026-08-24T01:00:00.000Z",
      endedAt: "2026-08-24T01:00:04.500Z",
      phases: [
        { kind: "context_compiling", at: "2026-08-24T01:00:00.200Z" },
        { kind: "provider_running", at: "2026-08-24T01:00:01.000Z" },
      ],
    }} />);

    const summary = screen.getByRole("button", { name: /Thought for 4\.5s/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Reading context")).not.toBeInTheDocument();

    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reading context")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  test("renders nothing for a settled turn that reported no phases", () => {
    const { container } = render(<ReasoningTrace block={{
      id: "r3",
      startedAt: "2026-08-24T01:00:00.000Z",
      endedAt: "2026-08-24T01:00:01.000Z",
      phases: [],
    }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ────────────────────────── Tool activity ────────────────────────────────────
// A tool call is reported as `tool.proposed` — which names the tool and the
// operand — and later `tool.settled` / `tool.failed` / `tool.denied`, which
// carry the outcome but not the tool id. Only `provider_call_id` spans both.

function toolEvent(id: string, event: string, payload: Record<string, unknown>): TerminusSseEvent {
  return { id, event, data: JSON.stringify(payload) };
}

const TASK_CREATED_AT = "2026-08-24T00:59:00.000Z";

describe("tool activity decoding", () => {
  test("folds a proposal and its settlement into one activity entry", () => {
    const { blocks } = decodeFeed([
      toolEvent("t1", "tool.proposed", {
        provider_call_id: "call-1",
        tool_id: "read",
        arguments_excerpt: "src/App.tsx",
      }),
      toolEvent("t2", "tool.authorized", { policy_decision_id: "pd-1", side_effect_id: "se-1" }),
      toolEvent("t3", "tool.started", { side_effect_id: "se-1" }),
      toolEvent("t4", "tool.settled", {
        provider_call_id: "call-1",
        status: "success",
        summary: "Read 42 lines",
      }),
    ], TASK_CREATED_AT);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe("Explored codebase");
    expect(blocks[0]?.status).toBe("done");
    expect(blocks[0]?.entries).toHaveLength(1);
    expect(blocks[0]?.entries[0]).toMatchObject({
      tool: "read",
      summary: "Read 42 lines",
      phase: "settled",
      outcome: "succeeded",
    });
  });

  test("shows the operand a proposal names while it is still running", () => {
    const { blocks } = decodeFeed([
      toolEvent("t1", "tool.proposed", {
        provider_call_id: "call-1",
        tool_id: "exec",
        arguments_excerpt: "npm test",
      }),
    ], TASK_CREATED_AT);

    expect(blocks[0]?.status).toBe("working");
    expect(blocks[0]?.entries[0]).toMatchObject({ tool: "exec", summary: "npm test" });
  });

  test("marks a group failed when one of its calls is denied", () => {
    const { blocks } = decodeFeed([
      toolEvent("t1", "tool.proposed", { provider_call_id: "c1", tool_id: "patch", arguments_excerpt: "a.ts" }),
      toolEvent("t2", "tool.denied", { provider_call_id: "c1", explanation: "Outside the task contract scope" }),
    ], TASK_CREATED_AT);

    expect(blocks[0]?.status).toBe("failed");
    expect(blocks[0]?.entries[0]).toMatchObject({
      summary: "Denied: Outside the task contract scope",
      outcome: "denied",
    });
  });

  test("settles a group closed by an intervening turn event", () => {
    // The settlement lands after `turn.tool_settlement` has already closed the
    // group. Deriving status at flush time froze such blocks on "working".
    const { blocks } = decodeFeed([
      toolEvent("t1", "tool.proposed", { provider_call_id: "c1", tool_id: "read", arguments_excerpt: "a.ts" }),
      toolEvent("t2", "turn.tool_settlement", { tool_calls: 1 }),
      toolEvent("t3", "tool.settled", { provider_call_id: "c1", status: "success", summary: "Read a.ts" }),
    ], TASK_CREATED_AT);

    expect(blocks[0]?.status).toBe("done");
  });

  test("timestamps an entry from the event id when the payload carries none", () => {
    const { blocks } = decodeFeed([
      toolEvent(`${String(1_756_339_200_000).padStart(16, "0")}-00000001`, "tool.proposed", {
        provider_call_id: "c1",
        tool_id: "read",
        arguments_excerpt: "a.ts",
      }),
    ], TASK_CREATED_AT);

    expect(blocks[0]?.entries[0]?.at).toBe(new Date(1_756_339_200_000).toISOString());
  });
});

// ────────────────────────── Turn outcomes ────────────────────────────────────

describe("turn outcome decoding", () => {
  test("does not open a reply until the turn has something to say", () => {
    const { order, messages } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("p1", "turn.context_compiling", {}),
    ], TASK_CREATED_AT);

    expect(order.map((entry) => entry.kind)).toEqual(["message", "reasoning"]);
    expect(messages.every((message) => message.role === "user")).toBe(true);
  });

  test("places the reply after the tool calls that produced it", () => {
    const { order } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("t1", "tool.proposed", { provider_call_id: "c1", tool_id: "read", arguments_excerpt: "a.ts" }),
      toolEvent("t2", "tool.settled", { provider_call_id: "c1", status: "success", summary: "Read a.ts" }),
      toolEvent("c1", "turn.completed", { summary: "a.ts defines the shell." }),
    ], TASK_CREATED_AT);

    expect(order.map((entry) => entry.kind)).toEqual(["message", "reasoning", "block", "message"]);
  });

  test("reports a failed turn instead of streaming forever", () => {
    const { blocks, messages } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("f1", "turn.failed", { reason: "verification_failed" }),
    ], TASK_CREATED_AT);

    expect(messages.some((message) => message.streaming)).toBe(false);
    expect(blocks[0]).toMatchObject({ title: "Turn failed", status: "failed" });
    expect(blocks[0]?.entries[0]?.detail).toContain("verification_failed");
  });

  test("reports a stopped turn without calling it a failure", () => {
    const { blocks } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("a1", "turn.aborted", {}),
    ], TASK_CREATED_AT);

    expect(blocks[0]).toMatchObject({ title: "Turn stopped", status: "interrupted" });
  });

  test("attaches provider reasoning to the turn's trace", () => {
    const { reasoning } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("c1", "turn.completed", { summary: "Done.", reasoning: "Checked the shell first." }),
    ], TASK_CREATED_AT);

    expect(reasoning[0]?.text).toBe("Checked the shell first.");
  });

  test("never leaves a completed turn as an empty reply", () => {
    const { messages } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("c1", "turn.completed", {}),
    ], TASK_CREATED_AT);

    const reply = messages.find((message) => message.role === "agent");
    expect(reply?.streaming).toBe(false);
    expect(reply?.content).toBe("Terminus finished this turn without a written response.");
  });
});

// ────────────────────────── Provider streaming ───────────────────────────────
// `turn.provider_text_delta` is the only streaming event the control plane
// emits (see `createProviderTextDeltaEmitter`). The renderer listened for
// `turn.provider_running`, which nothing publishes, so every streamed reply was
// discarded and the answer arrived in one lump — or not at all.

describe("provider text streaming", () => {
  test("concatenates deltas into one streaming reply before the turn completes", () => {
    const { messages } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("d1", "turn.provider_text_delta", { text: "The kernel " }),
      toolEvent("d2", "turn.provider_text_delta", { text: "owns every " }),
      toolEvent("d3", "turn.provider_text_delta", { text: "effect." }),
    ], TASK_CREATED_AT);

    const replies = messages.filter((message) => message.role === "agent");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toBe("The kernel owns every effect.");
    expect(replies[0]?.streaming).toBe(true);
  });

  test("keeps the streamed text when the turn completes with its own summary", () => {
    const { messages } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("d1", "turn.provider_text_delta", { text: "Streamed answer." }),
      toolEvent("c1", "turn.completed", { summary: "Settled summary." }),
    ], TASK_CREATED_AT);

    const reply = messages.find((message) => message.role === "agent");
    expect(reply?.content).toBe("Streamed answer.");
    expect(reply?.streaming).toBe(false);
  });

  test("opens a reply for deltas that arrive without a turn.started in the window", () => {
    const { messages } = decodeFeed([
      toolEvent("d1", "turn.provider_text_delta", { text: "Mid-turn attach." }),
    ], TASK_CREATED_AT);

    expect(messages.map((message) => message.content)).toEqual(["Mid-turn attach."]);
  });

  test("reports the model the runtime selected on the reply it produced", () => {
    const { messages } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("p1", "turn.profile_selected", { provider_id: "open_code_zen", model_key: "ox-alpha" }),
      toolEvent("d1", "turn.provider_text_delta", { text: "Answer." }),
    ], TASK_CREATED_AT);

    expect(messages.find((message) => message.role === "agent")?.model).toBe("ox-alpha");
  });

  test("records a delivered steer so the instruction is not invisible", () => {
    const { blocks } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("q1", "turn.steering_queued", { episode_id: "e1", sequence: 2, chars: 24 }),
    ], TASK_CREATED_AT);

    expect(blocks[0]).toMatchObject({ title: "Steering delivered", metric: "24 characters", status: "done" });
  });
});

// ────────────────────────── Failure visibility ───────────────────────────────
// The control plane's terminal-turn payload is
// `{ code, category, message, reason, retryable, details }`. The client read
// `reason` and `error` only, so a failed turn rendered the single machine token
// `agent_loop_error` inside a collapsed row.

describe("turn failure reporting", () => {
  const failureEvents = [
    toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
    toolEvent("f1", "turn.failed", {
      code: "PROVIDER_TRANSPORT_FAILED",
      category: "provider",
      message: "The provider refused the request after 3 attempts.",
      reason: "agent_loop_error",
      retryable: true,
      details: { status: 502, endpoint: "https://gateway.invalid/v1/chat" },
    }),
  ];

  test("leads with the human message, not the ALL-CAPS wire code", () => {
    const { blocks } = decodeFeed(failureEvents, TASK_CREATED_AT);
    expect(blocks[0]?.entries[0]?.summary).toBe(
      "The provider refused the request after 3 attempts.",
    );
    expect(blocks[0]?.entries[0]?.summary).not.toContain("PROVIDER_TRANSPORT_FAILED");
  });

  test("softens a rate-limit failure and keeps the raw text as detail", () => {
    const { blocks } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("f1", "turn.failed", {
        code: "PROVIDER_EXECUTION_FAILED",
        message: "provider dispatch failed after 3 attempt(s): OpenCode gateway returned HTTP 429: Rate limit exceeded.",
        retryable: true,
      }),
    ], TASK_CREATED_AT);
    expect(blocks[0]?.entries[0]?.summary).toContain("rate limited");
    expect(blocks[0]?.entries[0]?.detail ?? "").toContain("HTTP 429");
  });

  test("keeps the wire envelope out of the reader's transcript", () => {
    // A retryable provider failure reads as one clear sentence. The
    // category, gRPC code, and structured details belong in logs and the
    // inspector — not dumped as JSON into the conversation.
    const detail = decodeFeed(failureEvents, TASK_CREATED_AT).blocks[0]?.entries[0]?.detail ?? "";
    expect(detail).not.toContain("Category:");
    expect(detail).not.toContain("\"status\": 502");
    expect(detail).not.toContain("gateway.invalid");
    expect(detail).not.toContain("Retryable:");
  });

  test("names a non-retryable failure as such", () => {
    const detail = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("f1", "turn.failed", {
        code: "PROVIDER_EXECUTION_FAILED",
        message: "The model is unavailable.",
        retryable: false,
      }),
    ], TASK_CREATED_AT).blocks[0]?.entries[0]?.detail ?? "";
    expect(detail).toContain("This error is not retryable.");
  });

  test("falls back to `error` when the payload carries no message", () => {
    const { blocks } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("f1", "turn.failed", { error: "socket hang up" }),
    ], TASK_CREATED_AT);
    expect(blocks[0]?.entries[0]?.summary).toBe("socket hang up");
  });

  test("never dumps an oversized details payload into the transcript", () => {
    const entry = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("f1", "turn.failed", { message: "It failed.", details: "y".repeat(20_000) }),
    ], TASK_CREATED_AT).blocks[0]?.entries[0];
    expect(entry?.summary).toBe("It failed.");
    expect(entry?.detail ?? "").not.toContain("yyyyyyyyyy");
  });

  test("renders a denied tool call as a denial, not as exploration", () => {
    const { blocks } = decodeFeed([
      toolEvent("t1", "tool.proposed", { provider_call_id: "c1", tool_id: "read", arguments_excerpt: "/etc/passwd" }),
      toolEvent("t2", "tool.denied", { provider_call_id: "c1", reason: "path outside the task's allowed scope" }),
    ], TASK_CREATED_AT);

    expect(blocks[0]?.title).toBe("Denied by policy");
    expect(blocks[0]?.metric).toBe("1 denial");
    expect(blocks[0]?.status).toBe("failed");
    expect(blocks[0]?.entries[0]?.summary).toBe("Denied: path outside the task's allowed scope");
  });
});

describe("terminalReasonText", () => {
  test("prefers the human message over the machine reason", () => {
    expect(terminalReasonText({ code: "BUDGET_EXHAUSTED", message: "Out of steps.", reason: "budget" }))
      .toBe("BUDGET_EXHAUSTED: Out of steps.");
  });

  test("falls back to the reason token when no message was written", () => {
    expect(terminalReasonText({ reason: "agent_loop_error" })).toBe("agent_loop_error");
  });

  test("reports nothing when the task carries no terminal reason", () => {
    expect(terminalReasonText(null)).toBeUndefined();
  });
});

describe("retry after a failed turn", () => {
  test("offers the exact prompt back on the failed block", () => {
    const { blocks } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("f1", "turn.failed", { message: "The provider timed out." }),
    ], TASK_CREATED_AT, new Map([["s1", { status: "ready", text: "add the missing migration", truncated: false } as const]]));

    expect(blocks[0]?.retryInput).toBe("add the missing migration");
  });

  test("offers nothing to retry when the turn was stopped on purpose", () => {
    const { blocks } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("a1", "turn.aborted", {}),
    ], TASK_CREATED_AT, new Map([["s1", { status: "ready", text: "do the thing", truncated: false } as const]]));

    expect(blocks[0]?.retryInput).toBeUndefined();
  });

  // Resending a paraphrase would be worse than offering nothing.
  test("offers nothing when the prompt was only available truncated", () => {
    const { blocks } = decodeFeed([
      toolEvent("s1", "turn.started", { started_at: TASK_CREATED_AT }),
      toolEvent("f1", "turn.failed", { message: "It failed." }),
    ], TASK_CREATED_AT, new Map([["s1", { status: "ready", text: "a very long prom", truncated: true } as const]]));

    expect(blocks[0]?.retryInput).toBeUndefined();
  });
});

/**
 * The final backend contract, as of the harness landing.
 *
 * A failed turn now leaves the task ACTIVE and steerable, and says so with a
 * task-level event; `turn.started` names the model it routed to; and a turn
 * orphaned by a control-plane restart reports that as its reason instead of a
 * generic loop error.
 */
describe("final turn contract", () => {
  test("a task-level turn failure renders a retryable block, not a dead task", () => {
    const feed = decodeFeed(
      [
        event("1", "turn.started", { started_at: "2026-08-28T00:00:00.000Z", user_input: "add the migration" }),
        event("2", "task.turn_failed", {
          code: "AGENT_LOOP_ERROR",
          category: "internal",
          message: "the provider returned an unparseable tool call",
          reason: "agent_loop_error",
          retryable: true,
        }),
      ],
      "2026-08-28T00:00:00.000Z",
      new Map([["1", { status: "ready" as const, text: "add the migration", truncated: false }]]),
    );

    const block = feed.blocks.at(-1);
    expect(block?.status).toBe("failed");
    expect(block?.entries[0]?.summary).toContain("the provider returned an unparseable tool call");
    // The exact prompt is in hand, so Retry is one turn rather than a new task.
    expect(block?.retryInput).toBe("add the migration");
  });

  // The control plane settles one failure as two events in one atomic batch.
  test("reports one failure once, not twice", () => {
    const feed = decodeFeed(
      [
        event("1", "turn.started", { started_at: "2026-08-28T00:00:00.000Z" }),
        event("2", "turn.failed", {
          code: "PROVIDER_EXECUTION_FAILED",
          category: "provider",
          message: "OpenCode gateway returned HTTP 429: Rate limit exceeded.",
          reason: "agent_loop_error",
          retryable: false,
        }),
        // Same stop, task aggregate: "the task is still ACTIVE and steerable".
        event("3", "task.turn_failed", {
          status: "ACTIVE",
          active_turn: null,
          code: "PROVIDER_EXECUTION_FAILED",
          message: "OpenCode gateway returned HTTP 429: Rate limit exceeded.",
          reason: "agent_loop_error",
        }),
      ],
      "2026-08-28T00:00:00.000Z",
      new Map([["1", { status: "ready" as const, text: "test", truncated: false }]]),
    );

    expect(feed.blocks).toHaveLength(1);
    // The surviving card is the turn-level one: only it carries `retryable`.
    expect(feed.blocks[0]?.entries[0]?.detail).toContain("This error is not retryable.");
    expect(feed.blocks[0]?.retryInput).toBe("test");
  });

  test("a blocked turn is reported by the turn, not again by the task", () => {
    const feed = decodeFeed(
      [
        event("1", "turn.started", { started_at: "2026-08-28T00:00:00.000Z" }),
        event("2", "turn.blocked", { code: "PROVIDER_BLOCKED", message: "The provider refused." }),
        event("3", "task.blocked", { status: "BLOCKED", active_turn: null, reason: "provider_blocked" }),
      ],
      "2026-08-28T00:00:00.000Z",
      new Map(),
    );

    expect(feed.blocks).toHaveLength(1);
    expect(feed.blocks[0]?.title).toBe("Turn blocked");
  });

  // Each turn reports its own end; the guard is per turn, not per transcript.
  test("de-duplication resets at the next turn", () => {
    const feed = decodeFeed(
      [
        event("1", "turn.started", { started_at: "2026-08-28T00:00:00.000Z" }),
        event("2", "turn.failed", { message: "first failure" }),
        event("3", "task.turn_failed", { status: "ACTIVE", message: "first failure" }),
        event("4", "turn.started", { started_at: "2026-08-28T00:01:00.000Z" }),
        event("5", "turn.failed", { message: "second failure" }),
        event("6", "task.turn_failed", { status: "ACTIVE", message: "second failure" }),
      ],
      "2026-08-28T00:00:00.000Z",
      new Map(),
    );

    expect(feed.blocks).toHaveLength(2);
  });

  test("names the model the runtime actually routed to", () => {
    const feed = decodeFeed(
      [
        event("1", "turn.started", {
          started_at: "2026-08-28T00:00:00.000Z",
          user_input: "go",
          model: "claude-sonnet-4-6",
          reasoning_effort: "high",
        }),
        event("2", "turn.provider_text_delta", { text: "Working on it." }),
        event("3", "turn.completed", {}),
      ],
      "2026-08-28T00:00:00.000Z",
      new Map(),
    );

    const reply = feed.messages.find((message) => message.role === "agent");
    expect(reply?.model).toBe("claude-sonnet-4-6 · high");
  });

  test("says Terminus restarted rather than reporting a loop error", () => {
    expect(terminalReasonText({
      code: "TURN_ORPHANED",
      message: "agent loop error",
      reason: "control_plane_restarted",
    })).toBe("Terminus restarted while this turn was running.");

    const feed = decodeFeed(
      [
        event("1", "turn.started", { started_at: "2026-08-28T00:00:00.000Z", user_input: "go" }),
        event("2", "turn.failed", {
          code: "TURN_ORPHANED",
          message: "agent loop error",
          reason: "control_plane_restarted",
        }),
      ],
      "2026-08-28T00:00:00.000Z",
      new Map(),
    );

    expect(feed.blocks.at(-1)?.entries[0]?.summary)
      .toContain("Terminus restarted while this turn was running.");
  });
});

// ────────────────────────── Transcript surface ───────────────────────────────
//
// The transcript speaks Codex's language: an assistant reply is plain prose on
// the canvas with a quiet action row underneath, and a user turn is a small
// right-aligned pill. These pin the parts of that which are behaviour rather
// than decoration — chiefly that every control in the row does something real.

function reply(content: string, overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "message-reply",
    role: "agent",
    content,
    createdAt: "2026-08-28T18:04:00.000Z",
    ...overrides,
  };
}

describe("assistant reply surface", () => {
  afterEach(() => cleanup());

  test("copies the exact reply source, not the rendered markup", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<Message message={reply("## Result\n\nThe kernel owns every effect.")} isLast />);

    await user.click(screen.getByRole("button", { name: "Copy reply" }));
    expect(writeText).toHaveBeenCalledWith("## Result\n\nThe kernel owns every effect.");
    expect(screen.getByRole("button", { name: "Reply copied" })).toBeInTheDocument();
  });

  /*
   * Codex's action row also carries 👍 / 👎 and a branch-from-here control.
   * Terminus's control plane exposes neither a feedback nor a fork endpoint
   * (`src/lib/api.ts` has no such method), so shipping those icons would mean
   * shipping three buttons where only one does anything.
   */
  test("offers no feedback or branch controls, because nothing is behind them", () => {
    render(<Message message={reply("Done.")} isLast />);

    const labels = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");
    expect(labels).toEqual(["Copy reply"]);
    expect(labels.some((label) => /thumb|feedback|helpful|branch|fork/i.test(label))).toBe(false);
  });

  test("offers nothing to copy while the reply is still streaming", () => {
    render(<Message message={reply("The kernel ", { streaming: true })} isLast />);

    expect(screen.queryByRole("button", { name: "Copy reply" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Response in progress")).toBeInTheDocument();
  });

  test("names the model the runtime reported, and says nothing when it did not", () => {
    const { rerender } = render(<Message message={reply("Done.", { model: "ox-alpha" })} />);
    expect(screen.getByTestId("message-model")).toHaveTextContent("ox-alpha");

    rerender(<Message message={reply("Done.")} />);
    expect(screen.queryByTestId("message-model")).not.toBeInTheDocument();
  });
});

describe("user turn surface", () => {
  afterEach(() => cleanup());

  test("keeps the send time in a tooltip rather than as a line of the transcript", () => {
    render(<Message message={{
      id: "message-user",
      role: "user",
      content: "add the missing migration",
      createdAt: "2026-08-28T18:04:00.000Z",
    }} />);

    const pill = screen.getByText("add the missing migration").parentElement;
    expect(pill).toHaveAttribute("data-tooltip");
    // Nothing in the turn renders a clock time as readable text.
    expect(screen.queryByText(/^\d{2}:\d{2}:\d{2}$/)).not.toBeInTheDocument();
  });
});

describe("empty conversation", () => {
  beforeEach(() => {
    const selected = task();
    useTerminusStore.setState({
      taskById: { [selected.id]: selected },
      tasksBySession: { [selected.session_id]: [selected] },
      selectedSessionId: selected.session_id,
      selectedTaskId: selected.id,
      approvalsByTask: { [selected.id]: [] },
      approvalFreshnessByTask: { [selected.id]: { status: "ready", error: null } },
      eventHistoryByTask: {},
    });
  });

  afterEach(() => cleanup());

  test("is one quiet line, not a headline with a paragraph under it", () => {
    render(<Conversation events={[]} />);

    expect(screen.getByText("Send a message to start this task.")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});

// ────────────────────────── Streaming stability ──────────────────────────────
//
// `decodeFeed` is a fold over the whole event log and re-runs on every streamed
// delta, so it returns new objects for turns that did not change. Without the
// comparison below, `React.memo` on every row is inert and appending one token
// re-renders and re-parses the entire transcript above it.

function messageItem(content: string, streaming = false): FeedItem {
  return { kind: "message", message: reply(content, { streaming }) };
}

describe("feed item stability", () => {
  test("treats a turn whose text is unchanged as the same item", () => {
    expect(sameFeedItem(messageItem("Answer."), messageItem("Answer."))).toBe(true);
  });

  test("sees an appended delta", () => {
    expect(sameFeedItem(messageItem("The kernel "), messageItem("The kernel owns"))).toBe(false);
  });

  test("sees a reply settling, even when the text is identical", () => {
    expect(sameFeedItem(messageItem("Answer.", true), messageItem("Answer.", false))).toBe(false);
  });

  test("sees an activity block settle underneath a stable title", () => {
    const proposed: FeedItem = {
      kind: "block",
      block: {
        id: "b1",
        title: "Explored codebase",
        metric: "1 file",
        status: "working",
        entries: [{ tool: "read", summary: "a.ts", at: TASK_CREATED_AT, phase: "proposed" }],
      },
    };
    const settled: FeedItem = {
      kind: "block",
      block: {
        ...proposed.kind === "block" ? proposed.block : {},
        id: "b1",
        title: "Explored codebase",
        metric: "1 file",
        status: "done",
        entries: [{ tool: "read", summary: "Read a.ts", at: TASK_CREATED_AT, phase: "settled", outcome: "succeeded" }],
      },
    };
    expect(sameFeedItem(proposed, settled)).toBe(false);
    expect(sameFeedItem(settled, settled)).toBe(true);
  });

  test("sees a reasoning trace close", () => {
    const running: FeedItem = {
      kind: "reasoning",
      reasoning: { id: "r1", phases: [], startedAt: TASK_CREATED_AT, endedAt: null },
    };
    const closed: FeedItem = {
      kind: "reasoning",
      reasoning: { id: "r1", phases: [], startedAt: TASK_CREATED_AT, endedAt: TASK_CREATED_AT },
    };
    expect(sameFeedItem(running, closed)).toBe(false);
  });
});
