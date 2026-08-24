import { describe, expect, test } from "vitest";
import {
  deriveComputerUseActivity,
  derivePendingApprovals,
  deriveSubagentActivity,
  deriveVerificationActivity,
  extractUnifiedDiffs,
} from "../src/lib/task-surface";
import { decodeFeed } from "../src/components/Conversation";
import {
  MAX_PRESENTATION_EVENT_CHARS,
  PRESENTATION_REJECTION_KEY,
  boundPresentationEvent,
} from "../src/hooks/use-terminus";
import type { TerminusSseEvent } from "../src/types";

function event(id: string, type: string, payload: Record<string, unknown>): TerminusSseEvent {
  return { id, event: type, data: JSON.stringify(payload) };
}

describe("task surface event projections", () => {
  test("computer use remains absent until runtime events start a session", () => {
    expect(deriveComputerUseActivity([])).toEqual({ active: false, paused: false });
    expect(deriveComputerUseActivity([
      event("1", "computer_use.started", { session_id: "cu-1" }),
      event("2", "computer_use.paused", { session_id: "cu-1" }),
    ])).toEqual({ active: true, paused: true });
    expect(deriveComputerUseActivity([
      event("1", "computer_use.started", { session_id: "cu-1" }),
      event("2", "computer_use.stopped", { session_id: "cu-1" }),
    ])).toEqual({ active: false, paused: false });
  });

  test("shows only unresolved approvals", () => {
    const events = [
      event("1", "approval.requested", { approvalId: "approval-a", operationSummary: "Run migration", risk: "high", reversibility: "reversible" }),
      event("2", "approval.requested", { approvalId: "approval-b", operationSummary: "Push branch", risk: "normal" }),
      event("3", "approval.resolved", { approvalId: "approval-a", decision: "deny_once" }),
    ];
    expect(derivePendingApprovals(events)).toEqual([
      expect.objectContaining({ id: "approval-b", action: "Push branch", risk: "normal", canPersist: false, authorizationReady: false }),
    ]);
  });

  test("preserves exact approval context for the inline decision", () => {
    const approvals = derivePendingApprovals([
      event("1", "approval.requested", {
        approval_id: "approval-a",
        operation_summary: "Run database migration",
        command: "bun run migrate:production",
        reason: "This can modify production data.",
        risk: "critical",
        scope: ["database:production"],
        affected_environment: "production",
        requested_at: "2026-07-12T00:00:00Z",
        can_persist: false,
      }),
    ]);
    expect(approvals[0]).toEqual(expect.objectContaining({
      operation: "bun run migrate:production",
      reason: "This can modify production data.",
      scope: ["database:production"],
      environment: "production",
      requestedAt: "2026-07-12T00:00:00Z",
      canPersist: false,
    }));
  });

  test("tracks subagents through completion without turning identity into primary UI", () => {
    const events = [
      event("1", "agent.spawned", { agentId: "agent-a", role: "Review proposed fix", worktreeId: "worktree-a" }),
      event("2", "agent.spawned", { agentId: "agent-b", role: "Run browser verification", worktreeId: null }),
      event("3", "agent.completed", { agentId: "agent-a", status: "COMPLETED" }),
      event("4", "agent.completed", { agentId: "agent-b", status: "FAILED" }),
    ];
    expect(deriveSubagentActivity(events)).toEqual([
      { id: "agent-a", role: "Review proposed fix", state: "done", worktreeId: "worktree-a" },
      { id: "agent-b", role: "Run browser verification", state: "failed", worktreeId: undefined },
    ]);
  });

  test("projects verification success and failure into concise task evidence", () => {
    const events = [
      event("1", "verification.node_passed", { nodeId: "desktop-unit", planId: "plan-1", resultId: "result-1", sourceRevision: "abc" }),
      event("2", "verification.node_failed", { nodeId: "desktop-e2e", planId: "plan-1", resultId: "result-2", failureCode: "ASSERTION", reason: "composer lost focus" }),
    ];
    expect(deriveVerificationActivity(events)).toEqual([
      { id: "1", state: "passed", detail: "desktop-unit" },
      { id: "2", state: "failed", detail: "desktop-e2e: composer lost focus" },
    ]);
  });

  test("supports the control plane's snake-case event payloads", () => {
    const events = [
      event("1", "approval.requested", { approval_id: "approval-a", operation_summary: "Apply migration", risk: "critical" }),
      event("2", "agent.spawned", { agent_id: "agent-a", role: "Review the patch", worktree_id: "review-worktree" }),
      event("3", "agent.completed", { agent_id: "agent-a", status: "COMPLETED" }),
      event("4", "verification.node_passed", { node_id: "desktop-unit" }),
      event("5", "verification.plan_completed", { status: "all_passed" }),
    ];

    expect(derivePendingApprovals(events)).toEqual([
      expect.objectContaining({ id: "approval-a", action: "Apply migration", risk: "critical", canPersist: false, authorizationReady: false }),
    ]);
    expect(deriveSubagentActivity(events)).toEqual([
      { id: "agent-a", role: "Review the patch", state: "done", worktreeId: "review-worktree" },
    ]);
    expect(deriveVerificationActivity(events)).toEqual([
      { id: "4", state: "passed", detail: "desktop-unit" },
      { id: "5", state: "passed", detail: "Verification plan passed" },
    ]);
  });

  test("accepts only explicit unified diff evidence from patch tool events", () => {
    const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";
    const events = [
      event("1", "tool.proposed", { tool: "patch", args: { patch: diff } }),
      event("2", "tool.settled", { tool: "patch", result: { patch: diff } }),
      event("3", "tool.settled", { tool: "read", result: { output: "not a diff" } }),
    ];
    expect(extractUnifiedDiffs(events)).toEqual([diff]);
  });

  test("renders the control-plane completion summary when no stream delta is available", () => {
    const feed = decodeFeed([
      event("1", "turn.started", { user_input: "Check the UI", started_at: "2026-07-12T00:00:00.000Z" }),
      event("2", "turn.provider_running", { provider: "fixture" }),
      event("3", "turn.response_validating", { status: "completed" }),
      event("4", "tool.settled", { tool: "read", status: "success", summary: "Read 1 file (412 lines)." }),
      event("5", "turn.completed", { summary: "Acknowledged: Check the UI" }),
    ], "2026-07-12T00:00:00.000Z");

    expect(feed.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Check the UI" }),
      expect.objectContaining({ role: "agent", content: "Acknowledged: Check the UI", streaming: false }),
    ]);
    expect(feed.blocks).toEqual([
      expect.objectContaining({ title: "Explored codebase", status: "done", metric: "1 file" }),
    ]);
  });

  test("rejects oversized SSE payloads before parsing or retaining presentation data", () => {
    const original: TerminusSseEvent = {
      id: "oversized-1",
      event: "tool.settled",
      data: "sensitive".repeat(MAX_PRESENTATION_EVENT_CHARS),
    };
    const bounded = boundPresentationEvent(original);
    expect(bounded.id).toBe(original.id);
    expect(bounded.event).toBe(original.event);
    expect(bounded.data.length).toBeLessThan(MAX_PRESENTATION_EVENT_CHARS);
    expect(JSON.parse(bounded.data)).toEqual({
      [PRESENTATION_REJECTION_KEY]: expect.objectContaining({
        reason: "event_payload_too_large",
        source_event: "tool.settled",
        character_count: original.data.length,
      }),
    });

    const feed = decodeFeed([original], "2026-07-12T00:00:00.000Z");
    expect(feed.blocks).toEqual([
      expect.objectContaining({
        title: "Event omitted from presentation",
        metric: "Payload rejected",
        status: "failed",
      }),
    ]);
    expect(feed.blocks[0]?.entries[0]?.detail).not.toContain("sensitive");
  });

  test("does not stringify structured tool results into the activity surface", () => {
    const feed = decodeFeed([
      event("1", "turn.started", { user_input: "Inspect it" }),
      event("2", "tool.settled", {
        tool: "read",
        status: "success",
        result: { private_payload: "must-not-render", artifact_ref: "artifact-sha256:abc" },
      }),
      event("3", "turn.completed", { summary: "Done" }),
    ], "2026-07-12T00:00:00.000Z");

    const detail = feed.blocks[0]?.entries[0]?.detail;
    expect(detail).toContain("artifact-sha256:abc");
    expect(detail).not.toContain("must-not-render");
  });

  test("explicitly rejects streaming content beyond the presentation budget", () => {
    const deltas = Array.from({ length: 270 }, (_, index) =>
      event(`delta-${index}`, "turn.provider_running", {
        delta: index === 269 ? "FINAL_PRIVATE_TAIL" : "x".repeat(1_000),
      }));
    const feed = decodeFeed([
      event("start", "turn.started", { user_input: "Stream" }),
      ...deltas,
      event("complete", "turn.completed", { summary: "Done" }),
    ], "2026-07-12T00:00:00.000Z");
    const response = feed.messages.find((message) => message.role === "agent")?.content ?? "";

    expect(response).toContain("Streaming response rejected");
    expect(response).not.toContain("FINAL_PRIVATE_TAIL");
    expect(response.length).toBeLessThan(270_000);
  });
});
