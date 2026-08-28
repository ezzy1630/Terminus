/**
 * Deciding whether a run is in flight.
 *
 * Three controls depend on this answer: Stop is offered only while work is
 * running, the composer queues instead of sending while it is (the control
 * plane rejects a second concurrent turn with `TASK_TURN_ALREADY_ACTIVE`), and
 * the activity indicator claims work is happening. Getting it wrong strands a
 * queued message forever or offers a Stop that can only 409.
 */
import { describe, expect, it } from "vitest";
import { displayLifecycle, taskRunIsActive, turnActivityFromEvents } from "../src/lib/turn-activity";
import {
  lifecycleFromDomainStatus,
  lifecycleFromTask,
  lifecycleIsActive,
  lifecycleIsTerminal,
  lifecycleLabel,
  lifecycleNeedsAttention,
  lifecycleTone,
} from "../src/lib/task-lifecycle";
import type { Task, TerminusSseEvent } from "../src/types";

function event(type: string, id = type): TerminusSseEvent {
  return { id, event: type, data: "{}" };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    session_id: "session-1",
    thread_id: "thread-1",
    status: "ACTIVE",
    phase: "EXECUTE",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    completed_at: null,
    terminal_reason: null,
    contract: null,
    ...overrides,
  };
}

const runningTurn = { id: "turn-1", sequence: 1, state: "PROVIDER_RUNNING", started_at: null };

describe("turnActivityFromEvents", () => {
  it("is unknown before anything has happened", () => {
    expect(turnActivityFromEvents([])).toBe("unknown");
    expect(turnActivityFromEvents([event("task.created")])).toBe("unknown");
  });

  it("reads the most recent turn boundary, not the first", () => {
    expect(turnActivityFromEvents([
      event("turn.started", "1"),
      event("turn.completed", "2"),
      event("turn.started", "3"),
    ])).toBe("running");
    expect(turnActivityFromEvents([
      event("turn.started", "1"),
      event("turn.completed", "2"),
    ])).toBe("settled");
  });

  it("ignores events that say nothing about turn state", () => {
    expect(turnActivityFromEvents([
      event("turn.started", "1"),
      event("provider.delta", "2"),
      event("tool.call", "3"),
    ])).toBe("running");
  });

  it("treats mid-turn progress as still running", () => {
    for (const type of ["turn.context_compiling", "turn.tool_settlement", "turn.verifying", "turn.repairing"]) {
      expect(turnActivityFromEvents([event("turn.started", "1"), event(type, "2")])).toBe("running");
    }
  });

  it("treats waiting on the user as settled, not running", () => {
    // The agent is not working. A Stop button lit through this is a lie, and
    // queueing the reply the agent is waiting for would deadlock the task.
    for (const type of ["turn.blocked", "turn.needs_user_input"]) {
      expect(turnActivityFromEvents([event("turn.started", "1"), event(type, "2")])).toBe("settled");
    }
  });

  it("treats every terminal turn outcome as settled", () => {
    for (const type of [
      "turn.completed",
      "turn.aborted",
      "turn.failed",
      "turn.interrupted",
      "turn.superseded",
      "turn.budget_exhausted",
      "turn.policy_denied",
    ]) {
      expect(turnActivityFromEvents([event("turn.started", "1"), event(type, "2")])).toBe("settled");
    }
  });

  it("lets a task-level ending override a stranded turn.started", () => {
    // Cancellation aborts the turn too, but that event can fall outside the
    // bounded presentation window. The task event still settles it.
    expect(turnActivityFromEvents([
      event("turn.started", "1"),
      event("task.cancelled", "2"),
    ])).toBe("settled");
  });
});

describe("taskRunIsActive", () => {
  it("falls back to the snapshot when the stream has said nothing", () => {
    expect(taskRunIsActive(task({ active_turn: runningTurn }), [])).toBe(true);
    expect(taskRunIsActive(task({ active_turn: null }), [])).toBe(false);
  });

  it("treats an unreported active_turn as not running", () => {
    // A list response omits the field. Guessing "running" from silence would
    // put a Stop button on every task in the sidebar.
    expect(taskRunIsActive(task(), [])).toBe(false);
  });

  it("prefers the live stream over a stale snapshot", () => {
    // The snapshot was read before the turn finished.
    expect(taskRunIsActive(task({ active_turn: runningTurn }), [
      event("turn.started", "1"),
      event("turn.completed", "2"),
    ])).toBe(false);
    // …and before it started.
    expect(taskRunIsActive(task({ active_turn: null }), [event("turn.started", "1")])).toBe(true);
  });

  it("is false without a task", () => {
    expect(taskRunIsActive(null, [event("turn.started")])).toBe(false);
    expect(taskRunIsActive(undefined, [])).toBe(false);
  });
});

// ────────────────────────── Display lifecycle ────────────────────────────────
// `ACTIVE` is the control plane's steady state: a task sits in it for as long
// as it exists, and it accepts new turns there. Rendering it as "Working" put
// a spinner on every task in the sidebar, the title bar, the board and the
// Dock badge, and left it there forever.

describe("displayLifecycle", () => {
  it("calls an ACTIVE task with no run in flight ready, not working", () => {
    expect(lifecycleFromTask(task())).toBe("working");
    expect(displayLifecycle(task(), [])).toBe("idle");
  });

  it("keeps working while a turn is actually running", () => {
    expect(displayLifecycle(task(), [event("turn.started")])).toBe("working");
    expect(displayLifecycle(task({ active_turn: runningTurn }), [])).toBe("working");
  });

  it("returns to ready as soon as the run settles", () => {
    expect(displayLifecycle(task({ active_turn: runningTurn }), [
      event("turn.started", "1"),
      event("turn.completed", "2"),
    ])).toBe("idle");
  });

  it("downgrades planning the same way", () => {
    const planning = task({ phase: "PLAN" });
    expect(lifecycleFromTask(planning)).toBe("planning");
    expect(displayLifecycle(planning, [])).toBe("idle");
    expect(displayLifecycle(planning, [event("turn.started")])).toBe("planning");
  });

  it("leaves every claim about the task itself alone", () => {
    // These are statements about the task, not about a turn: they are true
    // whether or not something is running.
    for (const [status, expected] of [
      ["NEEDS_USER_DECISION", "needs_you"],
      ["FAILED", "failed"],
      ["COMPLETED", "done"],
      ["ABORTED", "cancelled"],
      ["DRAFT", "queued"],
    ] as const) {
      expect(displayLifecycle(task({ status }), [])).toBe(expected);
    }
  });

  it("reports nothing for no task", () => {
    expect(displayLifecycle(null, [])).toBe("unknown");
  });
});

describe("the idle lifecycle", () => {
  it("reads as Ready, is quiet, and is not a reason to interrupt anyone", () => {
    expect(lifecycleLabel("idle")).toBe("Ready");
    expect(lifecycleTone("idle")).toBe("neutral");
    expect(lifecycleIsActive("idle")).toBe(false);
    expect(lifecycleIsTerminal("idle")).toBe(false);
    expect(lifecycleNeedsAttention("idle")).toBe(false);
  });

  it("is never produced by the stored status alone", () => {
    for (const status of ["DRAFT", "ACTIVE", "BLOCKED", "VERIFYING", "COMPLETED", "FAILED", "ABORTED"]) {
      expect(lifecycleFromDomainStatus(status)).not.toBe("idle");
    }
  });
});

describe("provider streaming keeps a run alive", () => {
  it("treats a text delta as evidence that the turn is running", () => {
    expect(turnActivityFromEvents([event("turn.provider_text_delta")])).toBe("running");
  });
});
