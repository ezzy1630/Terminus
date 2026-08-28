import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Conversation, decodeFeed } from "../src/components/Conversation";
import { ReasoningTrace } from "../src/components/ReasoningTrace";
import { useTerminusStore } from "../src/hooks/use-terminus";
import type { Task, TerminusSseEvent } from "../src/types";

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
      event: "turn.provider_running",
      data: JSON.stringify({ at: "2026-08-24T01:00:01.000Z" }),
    },
    // A repeat of the current phase is not a new step.
    {
      id: "turn-0-running-2",
      event: "turn.provider_running",
      data: JSON.stringify({ at: "2026-08-24T01:00:02.000Z" }),
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
      summary: "Outside the task contract scope",
      outcome: "failed",
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
      toolEvent("p1", "turn.provider_running", {}),
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
