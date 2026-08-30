import { describe, expect, test } from "vitest";
import { formatElapsedTime, presentTask } from "../src/lib/task-presentation";
import type { Task, TerminusSseEvent } from "../src/types";

const startedAt = "2026-08-30T10:00:00.000Z";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    session_id: "session-1",
    thread_id: "thread-1",
    status: "ACTIVE",
    phase: "EXECUTE",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    terminal_reason: null,
    contract: {
      version: 1,
      objective: "Fix the refresh-token race",
      non_goals: [],
      allowed_scope: { read_paths: [], write_paths: [], external_systems: [] },
    },
    active_turn: { id: "turn-1", state: "PROVIDER_RUNNING", started_at: startedAt },
    ...overrides,
  };
}

function event(id: string, type: string, payload: Record<string, unknown> = {}): TerminusSseEvent {
  return { id, event: type, data: JSON.stringify(payload) };
}

describe("presentTask", () => {
  test("derives one header model from lifecycle, activity, diffs, verification, and subagents", () => {
    const diff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+test",
    ].join("\n");
    const events = [
      event("1", "turn.started", { started_at: startedAt }),
      event("2", "agent.spawned", { agent_id: "a-1", role: "Tests" }),
      event("3", "agent.spawned", { agent_id: "a-2", role: "Review" }),
      event("4", "verification.node_passed", { node_id: "focused-tests" }),
      event("5", "verification.node_failed", { node_id: "integration", reason: "Docker unavailable" }),
      event("6", "tool.proposed", { tool: "patch", diff }),
      event("7", "turn.verifying"),
    ];

    const result = presentTask({
      task: task(),
      events,
      now: new Date("2026-08-30T10:02:14.000Z"),
    });

    expect(result).toMatchObject({
      objective: "Fix the refresh-token race",
      lifecycle: "working",
      stateLabel: "Working",
      currentDetail: "Running verification",
      elapsedSeconds: 134,
      runActive: true,
      needsAttention: false,
      changes: { files: 1, additions: 2, deletions: 1, source: "proposed" },
      verification: { passed: 1, failed: 1, skipped: 0, running: 0, total: 2 },
      activeSubagents: 2,
      totalSubagents: 2,
    });
  });

  test("prefers an authoritative workspace diff and raises permission attention", () => {
    const result = presentTask({
      task: task(),
      events: [event("1", "turn.started")],
      workspaceDiff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b",
      pendingApprovalCount: 1,
    });

    expect(result.currentDetail).toBe("Permission required");
    expect(result.needsAttention).toBe(true);
    expect(result.changes).toEqual({ files: 1, additions: 1, deletions: 1, source: "workspace" });
  });

  test("does not claim elapsed time after the run settles", () => {
    const result = presentTask({
      task: task({ active_turn: null }),
      events: [event("1", "turn.started"), event("2", "turn.completed")],
      now: new Date("2026-08-30T10:02:14.000Z"),
    });

    expect(result.lifecycle).toBe("idle");
    expect(result.elapsedSeconds).toBeNull();
    expect(result.currentDetail).toBeNull();
  });

  test("does not reuse a stale active phase after the run settles", () => {
    const result = presentTask({
      task: task({ active_turn: null }),
      events: [
        event("1", "turn.started"),
        event("2", "turn.finalizing"),
        event("3", "turn.completed"),
      ],
    });

    expect(result.stateLabel).toBe("Ready");
    expect(result.currentDetail).toBeNull();
  });

  test("presents unavailable verification for review without claiming a failed check", () => {
    const result = presentTask({
      task: task({ phase: "REVIEW", active_turn: null }),
      events: [
        event("1", "verification.plan_completed", { status: "no_runnable_checks" }),
        event("2", "verification.no_runnable_checks", { detail: "No runner matched." }),
        event("3", "turn.completed"),
      ],
    });

    expect(result).toMatchObject({
      lifecycle: "review",
      stateLabel: "Ready for review",
      currentDetail: "Changes are ready to review",
      runActive: false,
      needsAttention: true,
      verification: { passed: 0, failed: 0, skipped: 1, running: 0, total: 1 },
    });
  });
});

describe("formatElapsedTime", () => {
  test("keeps short run durations compact", () => {
    expect(formatElapsedTime(32)).toBe("32s");
    expect(formatElapsedTime(134)).toBe("2m 14s");
    expect(formatElapsedTime(3_661)).toBe("1h 01m");
  });
});
